import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  decideKnowledgeRead,
  DEFAULT_KNOWLEDGE_ACCESS_SCOPE,
  fileIsUsable,
  mayMoveKnowledgeSource,
  strictestClassification,
  type DataClassification,
  type FileScanState,
  type KnowledgeAccessScope,
  type KnowledgeReadDecision,
  type KnowledgeSourceKind,
  type KnowledgeSourceState,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { FileService } from './file.service.js';

export interface KnowledgeSourceView {
  id: string;
  name: string;
  description: string;
  kind: KnowledgeSourceKind;
  state: KnowledgeSourceState;
  accessScope: KnowledgeAccessScope;
  departmentId: string | null;
  namedAgentIds: string[];
  classification: DataClassification;
  connectionId: string | null;
  fileCount: number;
  /** How many of its files nothing may read yet. The number a screen has to show. */
  unusableFileCount: number;
  approvedAt: string | null;
  approvedByUserId: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdByUserId: string;
  createdAt: string;
  version: number;
}

/**
 * Knowledge sources — Prompt 35.
 *
 * ## A source is approved, not assembled
 *
 * §Settings calls these *"approved knowledge sources"*, and that is a requirement rather than a
 * label: `decideKnowledgeRead` refuses a source that is not `Approved`, so a collection somebody
 * built and never had signed off is consulted by nothing. Editing an approved source sends it back
 * to `Draft` — the approval was of a particular scope and classification, so changing either has to
 * be approved again.
 *
 * ## Two grants, two people
 *
 * Authoring is `settings:EditDraft` (CompanyAdmin); approving is `settings:Approve` (Approver).
 * Those are different role templates, so by default the person who assembles a knowledge source is
 * **not** the person who approves it. That is deliberate and it is the only place in this module
 * where the separation is structural rather than configured.
 *
 * ## What this is not
 *
 * There is **no vector store, no embedding index and no semantic sharing** — §35: *"Do not build
 * unrestricted vector-memory sharing."* A source is a named list of files and a scope. A read is a
 * decision about that list. Nothing here computes, stores or shares an embedding, so there is no
 * path by which one company's content could surface in another's prompt.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly files: FileService,
  ) {}

  // -------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------

  async create(input: {
    scope: TenantScope;
    actorUserId: string;
    name: string;
    description?: string;
    kind: KnowledgeSourceKind;
    accessScope?: KnowledgeAccessScope;
    departmentId?: string | null;
    namedAgentIds?: string[];
    classification?: DataClassification;
    connectionId?: string | null;
  }): Promise<KnowledgeSourceView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'EditDraft' });

    const accessScope = input.accessScope ?? DEFAULT_KNOWLEDGE_ACCESS_SCOPE;
    this.assertScopeIsCoherent({
      accessScope,
      departmentId: input.departmentId ?? null,
      namedAgentIds: input.namedAgentIds ?? [],
      kind: input.kind,
      connectionId: input.connectionId ?? null,
    });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.knowledgeSource.findFirst({
        where: { tenantId: input.scope.tenantId, name: input.name },
        select: { id: true },
      });
      if (existing !== null) {
        throw new ConflictException(
          `This company already has a knowledge source called "${input.name}".`,
        );
      }

      const row = await this.prisma.client.knowledgeSource.create({
        data: {
          tenantId: input.scope.tenantId,
          name: input.name,
          description: input.description ?? '',
          kind: input.kind,
          state: 'Draft',
          accessScope,
          departmentId: input.departmentId ?? null,
          namedAgentIds: input.namedAgentIds ?? [],
          classification: input.classification ?? 'Internal',
          connectionId: input.connectionId ?? null,
          createdByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.source_created',
        resourceType: 'knowledge-source',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary: `Knowledge source "${row.name}" created as a draft.`,
        metadata: {
          kind: row.kind,
          accessScope: row.accessScope,
          classification: row.classification,
        },
      });

      return KnowledgeService.toView(row, 0, 0);
    });
  }

  /**
   * Change a source.
   *
   * **An approved source goes back to `Draft`.** Widening a scope or raising a classification on a
   * source that stayed approved would mean the approval covered something nobody agreed to, and
   * this is the one rule in the module that costs a company a second approval for a typo fix. That
   * is the right trade: the alternative is an approval that means nothing.
   */
  async update(input: {
    scope: TenantScope;
    actorUserId: string;
    sourceId: string;
    name?: string;
    description?: string;
    accessScope?: KnowledgeAccessScope;
    departmentId?: string | null;
    namedAgentIds?: string[];
    classification?: DataClassification;
  }): Promise<KnowledgeSourceView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const source = await this.requireSource(input.scope, input.sourceId);

      if (source.state === 'Retired') {
        throw new ConflictException(
          'That knowledge source has been retired. Create a new one rather than reviving it — ' +
            'the retirement is part of the record.',
        );
      }

      const accessScope = (input.accessScope ?? source.accessScope) as KnowledgeAccessScope;
      const departmentId =
        input.departmentId === undefined ? source.departmentId : input.departmentId;
      const namedAgentIds = input.namedAgentIds ?? source.namedAgentIds;

      this.assertScopeIsCoherent({
        accessScope,
        departmentId,
        namedAgentIds,
        kind: source.kind as KnowledgeSourceKind,
        connectionId: source.connectionId,
      });

      // Lowering a source's classification below what its files already hold would leave it
      // holding material its own ceiling refuses. The trigger guards new files; this guards the
      // ceiling moving underneath the files already there.
      const classification = input.classification ?? (source.classification as DataClassification);
      if (input.classification !== undefined) {
        const held = await this.prisma.client.knowledgeSourceFile.findMany({
          where: { tenantId: input.scope.tenantId, knowledgeSourceId: source.id },
          select: { file: { select: { classification: true } } },
        });
        const strictest = held.reduce<DataClassification>(
          (worst, row) =>
            strictestClassification(worst, row.file.classification as DataClassification),
          'Public',
        );
        if (strictestClassification(classification, strictest) !== classification) {
          throw new BadRequestException(
            `This source already holds ${strictest} material, so it cannot be reclassified as ` +
              `${classification}. Remove those files first.`,
          );
        }
      }

      const wasApproved = source.state === 'Approved';

      const row = await this.prisma.client.knowledgeSource.update({
        where: { id: source.id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          accessScope,
          departmentId,
          namedAgentIds,
          classification,
          // Back to draft, and the approval columns are cleared together: leaving
          // `approved_by_user_id` on a draft would show a name against a decision that no longer
          // stands. The constraint requires both or neither.
          ...(wasApproved ? { state: 'Draft', approvedAt: null, approvedByUserId: null } : {}),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.source_updated',
        resourceType: 'knowledge-source',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary: wasApproved
          ? `Knowledge source "${row.name}" changed, and returned to draft for re-approval.`
          : `Knowledge source "${row.name}" changed.`,
        resourceVersion: row.version,
        metadata: {
          returnedToDraft: wasApproved,
          accessScope: row.accessScope,
          classification: row.classification,
        },
      });

      const counts = await this.countFiles(input.scope, row.id);
      return KnowledgeService.toView(row, counts.total, counts.unusable);
    });
  }

  /**
   * Approve a source so agents may consult it.
   *
   * `settings:Approve` — the Approver template, and **not** the CompanyAdmin one that authored it.
   * The approver is told what they are approving: the scope, the classification and how many of
   * its files are not yet usable, because approving a source whose files have not been scanned is
   * approving something nobody has looked at.
   */
  async approve(input: {
    scope: TenantScope;
    actorUserId: string;
    sourceId: string;
    note?: string;
  }): Promise<KnowledgeSourceView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Approve' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const source = await this.requireSource(input.scope, input.sourceId);

      if (!mayMoveKnowledgeSource(source.state as KnowledgeSourceState, 'Approved')) {
        throw new ConflictException(
          source.state === 'Approved'
            ? 'That knowledge source is already approved.'
            : 'A retired knowledge source cannot be approved.',
        );
      }

      const row = await this.prisma.client.knowledgeSource.update({
        where: { id: source.id },
        data: {
          state: 'Approved',
          approvedAt: new Date(),
          approvedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      const counts = await this.countFiles(input.scope, row.id);

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.source_approved',
        resourceType: 'knowledge-source',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary: `Knowledge source "${row.name}" approved for ${row.accessScope}.`,
        resourceVersion: row.version,
        ...(input.note === undefined ? {} : { reason: input.note }),
        metadata: {
          accessScope: row.accessScope,
          classification: row.classification,
          fileCount: counts.total,
          // On the record, because approving a source whose files are unscanned is a decision
          // somebody may have to account for.
          unusableFileCount: counts.unusable,
        },
      });

      return KnowledgeService.toView(row, counts.total, counts.unusable);
    });
  }

  /** Retire a source. Terminal — nothing consults it again, and the record of it stays. */
  async retire(input: {
    scope: TenantScope;
    actorUserId: string;
    sourceId: string;
    reason: string;
  }): Promise<KnowledgeSourceView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.reason.trim() === '') {
      throw new BadRequestException('Say why this knowledge source is being retired.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const source = await this.requireSource(input.scope, input.sourceId);

      if (!mayMoveKnowledgeSource(source.state as KnowledgeSourceState, 'Retired')) {
        throw new ConflictException('That knowledge source is already retired.');
      }

      const row = await this.prisma.client.knowledgeSource.update({
        where: { id: source.id },
        data: {
          state: 'Retired',
          retiredAt: new Date(),
          retiredReason: input.reason,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.source_retired',
        resourceType: 'knowledge-source',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary: `Knowledge source "${row.name}" retired. ${input.reason}`,
        resourceVersion: row.version,
        reason: input.reason,
      });

      const counts = await this.countFiles(input.scope, row.id);
      return KnowledgeService.toView(row, counts.total, counts.unusable);
    });
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /**
   * Put a file in a source.
   *
   * Two refusals here that are not obvious: **an infected or unscanned file cannot be added**, and
   * a file more sensitive than the source cannot be either. The second is the database's trigger —
   * checked here first only so the caller gets a sentence rather than a constraint name.
   */
  async addFile(input: {
    scope: TenantScope;
    actorUserId: string;
    sourceId: string;
    fileId: string;
  }): Promise<{ added: true }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const source = await this.requireSource(input.scope, input.sourceId);
      if (source.state === 'Retired') {
        throw new ConflictException('A retired knowledge source does not take new files.');
      }

      const file = await this.prisma.client.storedFile.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.fileId },
      });
      if (file === null || file.deletedAt !== null) {
        throw new NotFoundException('That file does not exist in this company.');
      }

      if (!fileIsUsable(file.scanState as FileScanState)) {
        throw new ConflictException(
          `That file is ${file.scanState.toLowerCase()} and cannot be added to a knowledge ` +
            'source. Nothing enters company knowledge before it has been scanned clean.',
        );
      }

      const existing = await this.prisma.client.knowledgeSourceFile.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          knowledgeSourceId: source.id,
          fileId: file.id,
        },
        select: { id: true },
      });
      if (existing !== null) {
        throw new ConflictException('That file is already in this knowledge source.');
      }

      await this.prisma.client.knowledgeSourceFile.create({
        data: {
          tenantId: input.scope.tenantId,
          knowledgeSourceId: source.id,
          fileId: file.id,
          addedByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.file_added_to_source',
        resourceType: 'knowledge-source',
        resourceId: source.id,
        actorUserId: input.actorUserId,
        summary: `${file.filename} added to "${source.name}".`,
        metadata: { fileId: file.id, classification: file.classification },
      });

      return { added: true as const };
    });
  }

  async removeFile(input: {
    scope: TenantScope;
    actorUserId: string;
    sourceId: string;
    fileId: string;
  }): Promise<{ removed: true }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const membership = await this.prisma.client.knowledgeSourceFile.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          knowledgeSourceId: input.sourceId,
          fileId: input.fileId,
        },
        include: { file: { select: { filename: true } }, source: { select: { name: true } } },
      });
      if (membership === null) {
        throw new NotFoundException('That file is not in this knowledge source.');
      }

      await this.prisma.client.knowledgeSourceFile.delete({ where: { id: membership.id } });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'knowledge.file_removed_from_source',
        resourceType: 'knowledge-source',
        resourceId: input.sourceId,
        actorUserId: input.actorUserId,
        summary: `${membership.file.filename} removed from "${membership.source.name}".`,
        metadata: { fileId: input.fileId },
      });

      return { removed: true as const };
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(input: {
    scope: TenantScope;
    actorUserId: string;
    includeRetired?: boolean;
  }): Promise<KnowledgeSourceView[]> {
    // `FileService.assertMaySeeKnowledge` — administrators and approvers, not every Employee who
    // can open Settings. One rule, one place; see its comment for the argument.
    await this.files.assertMaySeeKnowledge(input.scope, input.actorUserId);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.knowledgeSource.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.includeRetired === true ? {} : { state: { not: 'Retired' } }),
        },
        orderBy: [{ name: 'asc' }],
        include: {
          files: { select: { file: { select: { scanState: true, deletedAt: true } } } },
        },
      });

      return rows.map((row) =>
        KnowledgeService.toView(
          row,
          row.files.length,
          row.files.filter(
            (link) =>
              link.file.deletedAt !== null || !fileIsUsable(link.file.scanState as FileScanState),
          ).length,
        ),
      );
    });
  }

  /**
   * Whether this agent or person may consult this source, and which of its files they would get.
   *
   * The decision itself is `decideKnowledgeRead` in the types package — §35's three conditions —
   * and this supplies the facts. Two of those facts are worth stating:
   *
   * **The classification ceiling for an agent is the company's export ceiling.** UBoss has no
   * per-agent classification ceiling: Prompt 16's tool grants are by *action category* — read,
   * write, delete — not by data class. Rather than pass `null` and skip the check entirely, an
   * agent is held to what the company permits to move internally, which by default excludes
   * `Restricted`. That is a documented default standing in for a field the approved documents have
   * not specified, and the extension point is the `agentClassificationCeiling` argument.
   *
   * **Unusable files are excluded from the result, not the decision.** A source whose files are
   * still being scanned is readable; what comes back is empty. Refusing the whole source would
   * make one pending scan look like a permission failure.
   */
  async canRead(input: {
    scope: TenantScope;
    sourceId: string;
    engineAgentId?: string | null;
    askingDepartmentId?: string | null;
    agentClassificationCeiling?: DataClassification | null;
  }): Promise<{
    decision: KnowledgeReadDecision;
    fileIds: string[];
    unusableFileCount: number;
  }> {
    const policy = await this.files.policy(input.scope);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const source = await this.requireSource(input.scope, input.sourceId);

      const engineAgentId = input.engineAgentId ?? null;
      const ceiling =
        input.agentClassificationCeiling !== undefined
          ? input.agentClassificationCeiling
          : engineAgentId === null
            ? null
            : policy.exportCeiling;

      const decision = decideKnowledgeRead({
        sourceState: source.state as KnowledgeSourceState,
        sourceScope: source.accessScope as KnowledgeAccessScope,
        namedAgentIds: source.namedAgentIds,
        sourceDepartmentId: source.departmentId,
        sourceClassification: source.classification as DataClassification,
        engineAgentId,
        askingDepartmentId: input.askingDepartmentId ?? null,
        agentClassificationCeiling: ceiling,
      });

      if (!decision.permitted) {
        return { decision, fileIds: [], unusableFileCount: 0 };
      }

      const links = await this.prisma.client.knowledgeSourceFile.findMany({
        where: { tenantId: input.scope.tenantId, knowledgeSourceId: source.id },
        select: { file: { select: { id: true, scanState: true, deletedAt: true } } },
      });

      const usable = links.filter(
        (link) =>
          link.file.deletedAt === null && fileIsUsable(link.file.scanState as FileScanState),
      );

      return {
        decision,
        fileIds: usable.map((link) => link.file.id),
        unusableFileCount: links.length - usable.length,
      };
    });
  }

  /**
   * The same question, asked by a person configuring the source rather than by the runtime.
   *
   * `canRead` takes no actor because its caller is an agent run, which has no user. This is the
   * screen's door onto it, and it applies the same rule as every other read here: administrators
   * and approvers, not every Employee who can open Settings. Without it, `/access` would answer
   * "which file ids does this source hold" to anybody with `settings:View`.
   */
  async accessPreview(input: {
    scope: TenantScope;
    actorUserId: string;
    sourceId: string;
    engineAgentId?: string | null;
    askingDepartmentId?: string | null;
  }): Promise<{
    decision: KnowledgeReadDecision;
    fileIds: string[];
    unusableFileCount: number;
  }> {
    await this.files.assertMaySeeKnowledge(input.scope, input.actorUserId);
    return this.canRead(input);
  }

  /**
   * Read a source's content on behalf of an agent.
   *
   * The path an Engine Agent run takes. It refuses rather than returning an empty list when the
   * decision says no, because a run that silently got nothing would report "no information found"
   * where the truth is "you were not allowed to look".
   */
  async readForAgent(input: {
    scope: TenantScope;
    sourceId: string;
    engineAgentId: string;
    askingDepartmentId?: string | null;
    agentClassificationCeiling?: DataClassification | null;
  }): Promise<{ sourceId: string; fileIds: string[]; unusableFileCount: number }> {
    const outcome = await this.canRead(input);
    if (!outcome.decision.permitted) {
      throw new ForbiddenException(outcome.decision.reason);
    }
    return {
      sourceId: input.sourceId,
      fileIds: outcome.fileIds,
      unusableFileCount: outcome.unusableFileCount,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The scope rules that a CHECK constraint also enforces.
   *
   * Duplicated on purpose: the constraint is the guarantee and this is the sentence. A caller who
   * gets `new row for relation "knowledge_sources" violates check constraint
   * "department_source_names_its_department"` has been told nothing useful.
   */
  private assertScopeIsCoherent(input: {
    accessScope: KnowledgeAccessScope;
    departmentId: string | null;
    namedAgentIds: readonly string[];
    kind: KnowledgeSourceKind;
    connectionId: string | null;
  }): void {
    if (input.accessScope === 'Department' && input.departmentId === null) {
      throw new BadRequestException(
        'A department-scoped knowledge source has to name its department. Without one it is ' +
          'visible to nobody.',
      );
    }
    if (input.accessScope === 'NamedAgentsOnly' && input.namedAgentIds.length === 0) {
      throw new BadRequestException(
        'A source restricted to named agents has to name at least one. As it stands nothing ' +
          'could ever read it.',
      );
    }
    if (input.kind === 'Connection' && input.connectionId === null) {
      throw new BadRequestException(
        'A connection-backed knowledge source has to say which connection it reads.',
      );
    }
  }

  private async requireSource(
    scope: TenantScope,
    sourceId: string,
  ): Promise<{
    id: string;
    name: string;
    description: string;
    kind: string;
    state: string;
    accessScope: string;
    departmentId: string | null;
    namedAgentIds: string[];
    classification: string;
    connectionId: string | null;
    approvedAt: Date | null;
    approvedByUserId: string | null;
    retiredAt: Date | null;
    retiredReason: string | null;
    createdByUserId: string;
    createdAt: Date;
    version: number;
  }> {
    const row = await this.prisma.client.knowledgeSource.findFirst({
      where: { tenantId: scope.tenantId, id: sourceId },
    });
    if (row === null) {
      throw new NotFoundException('That knowledge source does not exist in this company.');
    }
    return row;
  }

  private async countFiles(
    scope: TenantScope,
    sourceId: string,
  ): Promise<{ total: number; unusable: number }> {
    const links = await this.prisma.client.knowledgeSourceFile.findMany({
      where: { tenantId: scope.tenantId, knowledgeSourceId: sourceId },
      select: { file: { select: { scanState: true, deletedAt: true } } },
    });
    return {
      total: links.length,
      unusable: links.filter(
        (link) =>
          link.file.deletedAt !== null || !fileIsUsable(link.file.scanState as FileScanState),
      ).length,
    };
  }

  private static toView(
    row: {
      id: string;
      name: string;
      description: string;
      kind: string;
      state: string;
      accessScope: string;
      departmentId: string | null;
      namedAgentIds: string[];
      classification: string;
      connectionId: string | null;
      approvedAt: Date | null;
      approvedByUserId: string | null;
      retiredAt: Date | null;
      retiredReason: string | null;
      createdByUserId: string;
      createdAt: Date;
      version: number;
    },
    fileCount: number,
    unusableFileCount: number,
  ): KnowledgeSourceView {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      kind: row.kind as KnowledgeSourceKind,
      state: row.state as KnowledgeSourceState,
      accessScope: row.accessScope as KnowledgeAccessScope,
      departmentId: row.departmentId,
      namedAgentIds: row.namedAgentIds,
      classification: row.classification as DataClassification,
      connectionId: row.connectionId,
      fileCount,
      unusableFileCount,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      approvedByUserId: row.approvedByUserId,
      retiredAt: row.retiredAt?.toISOString() ?? null,
      retiredReason: row.retiredReason,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }
}
