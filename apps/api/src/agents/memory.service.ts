import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AGENT_MEMORY_MODES,
  DEFAULT_MEMORY_POLICIES,
  decideMemoryWrite,
  memoryPolicyProblems,
  memoryReadable,
  offboardingOutcome,
  type AgentMemoryMode,
  type DataClassification,
  type MemoryPolicy,
  type MemoryVisibility,
} from '@uboss/types';

import { Prisma } from '../generated/prisma/client.js';
import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** A memory record as a governance screen shows it. */
export interface MemoryRecordView {
  id: string;
  mode: AgentMemoryMode;
  visibility: MemoryVisibility;
  classification: DataClassification;
  label: string;
  runId: string;
  objectiveId: string | null;
  engineAgentId: string;
  ownerUserId: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
  deletedReason: string | null;
  createdAt: string;
  /** Whether the content is still held. False once deleted or expired. */
  hasContent: boolean;
}

/**
 * Engine Agent memory — Prompt 33.
 *
 * ## Three layers, and what each one is for
 *
 * 1. **`packages/types/src/memory.ts`** decides. `decideMemoryWrite` and `memoryReadable` are
 *    pure functions over a policy and a record, so the rules are testable without a database and
 *    the same answer is given wherever they are asked.
 * 2. **This service** fetches, persists and audits. It never re-derives a rule.
 * 3. **The database** refuses anything that got past both. Fourteen check constraints, because a
 *    memory rule enforced only in TypeScript is one a future bug can walk around.
 *
 * The overlap is deliberate. Prompt 14 taught the lesson the hard way: a CHECK constraint whose
 * expression is NULL passes, so belt and braces means *both* are probed rather than one trusted.
 *
 * ## The rule that has no code
 *
 * "Never use unrestricted cross-tenant memory" appears nowhere in this file as a check, and that
 * is the point. Every read and write runs inside `runInTenantTransaction` against a table with
 * `FORCE ROW LEVEL SECURITY`, and `run_id` carries a composite foreign key including `tenant_id`
 * — so a record from another company is not something a query here could return. A visible
 * `if (record.tenantId !== scope.tenantId)` would imply such rows can arrive, which is the belief
 * that leads to the one query somebody forgets to scope.
 */
@Injectable()
export class MemoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  // -------------------------------------------------------------------------
  // The policy
  // -------------------------------------------------------------------------

  /**
   * This company's four policies, created from the documented defaults on first read.
   *
   * Written explicitly from `DEFAULT_MEMORY_POLICIES` rather than left to the column defaults,
   * for the reason Prompt 31 learned: a governance default declared in both the types package and
   * a migration is one that can drift with nothing to notice.
   */
  async policies(scope: TenantScope): Promise<MemoryPolicy[]> {
    const rows = await this.prisma.runInTenantTransaction(scope, async () => {
      const existing = await this.prisma.client.memoryPolicyRow.findMany({
        where: { tenantId: scope.tenantId },
      });

      const missing = AGENT_MEMORY_MODES.filter(
        (mode) => !existing.some((row) => row.mode === mode),
      );

      if (missing.length > 0) {
        await this.prisma.client.memoryPolicyRow.createMany({
          data: missing.map((mode) => {
            const defaults = DEFAULT_MEMORY_POLICIES[mode];
            return {
              tenantId: scope.tenantId,
              mode,
              retentionDays: defaults.retentionDays,
              visibility: defaults.visibility,
              maxClassification: defaults.maxClassification,
              allowCrossUser: defaults.allowCrossUser,
              allowCrossObjective: defaults.allowCrossObjective,
              offboardingBehaviour: defaults.offboardingBehaviour,
              requiresApproval: defaults.requiresApproval,
            };
          }),
        });

        return this.prisma.client.memoryPolicyRow.findMany({
          where: { tenantId: scope.tenantId },
        });
      }

      return existing;
    });

    // Returned in the modes' own order rather than the database's, so a settings screen always
    // reads ephemeral-to-permanent.
    return AGENT_MEMORY_MODES.map((mode) => {
      const row = rows.find((candidate) => candidate.mode === mode);
      if (row === undefined) throw new NotFoundException(`No memory policy for ${mode}.`);
      return MemoryService.toPolicy(row);
    });
  }

  async policy(scope: TenantScope, mode: AgentMemoryMode): Promise<MemoryPolicy> {
    const all = await this.policies(scope);
    const found = all.find((candidate) => candidate.mode === mode);
    if (found === undefined) throw new NotFoundException(`No memory policy for ${mode}.`);
    return found;
  }

  /**
   * Change one mode's policy.
   *
   * `settings:Administer`, because memory governance is a company-wide data decision rather than
   * an agent-level one: a Manager who owns an agent should not be able to widen what that agent
   * remembers, or the ceiling would be set by whoever wanted it loosest.
   */
  async setPolicy(input: {
    scope: TenantScope;
    actorUserId: string;
    policy: MemoryPolicy;
    reason: string;
  }): Promise<MemoryPolicy> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'Say why the memory policy is changing. It governs what the company keeps, and an ' +
          'unexplained change cannot be reviewed.',
      );
    }

    const problems = memoryPolicyProblems(input.policy);
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }

    const before = await this.policy(input.scope, input.policy.mode);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.memoryPolicyRow.update({
        where: { tenantId_mode: { tenantId: input.scope.tenantId, mode: input.policy.mode } },
        data: {
          retentionDays: input.policy.retentionDays,
          visibility: input.policy.visibility,
          maxClassification: input.policy.maxClassification,
          allowCrossUser: input.policy.allowCrossUser,
          allowCrossObjective: input.policy.allowCrossObjective,
          offboardingBehaviour: input.policy.offboardingBehaviour,
          requiresApproval: input.policy.requiresApproval,
          updatedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'memory.policy_changed',
        resourceType: 'memory-policy',
        resourceId: input.policy.mode,
        actorUserId: input.actorUserId,
        summary: `Memory policy for ${input.policy.mode} changed. ${input.reason}`,
        resourceVersion: row.version,
        metadata: {
          mode: input.policy.mode,
          reason: input.reason,
          // Both sides, because "what changed" is the question an access review asks and
          // reconstructing it from two audit events is work nobody does.
          beforeRetentionDays: before.retentionDays ?? 'never',
          afterRetentionDays: input.policy.retentionDays ?? 'never',
          beforeVisibility: before.visibility,
          afterVisibility: input.policy.visibility,
          beforeMaxClassification: before.maxClassification,
          afterMaxClassification: input.policy.maxClassification,
        },
      });

      return MemoryService.toPolicy(row);
    });
  }

  // -------------------------------------------------------------------------
  // Remembering
  // -------------------------------------------------------------------------

  /**
   * Remember something from a run.
   *
   * Called by the run engine rather than by a person, so there is no `actorUserId` and no
   * permission check: the *agent's* authority to remember is its configured mode, and the
   * company's policy is the ceiling on it. A person cannot write a memory record directly, which
   * is why no route does.
   *
   * The mode comes from the **run's own agent version**, not from the caller. An agent whose
   * published version declares `CurrentRunOnly` cannot be persuaded to write `AgentMemory` by a
   * parameter.
   */
  async remember(input: {
    scope: TenantScope;
    runId: string;
    label: string;
    content: Record<string, unknown>;
    classification: DataClassification;
    ownerUserId: string | null;
    approvalRequestId?: string | null;
    now?: Date;
  }): Promise<
    { remembered: true; record: MemoryRecordView } | { remembered: false; reason: string }
  > {
    const now = input.now ?? new Date();

    const run = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.agentRun.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.runId },
        select: {
          id: true,
          objectiveId: true,
          engineAgentId: true,
          agent: { select: { memoryMode: true } },
        },
      }),
    );

    if (run === null) {
      throw new NotFoundException('That run does not exist in this company.');
    }

    const mode = run.agent.memoryMode as AgentMemoryMode;
    const policy = await this.policy(input.scope, mode);

    const decision = decideMemoryWrite(
      {
        mode,
        classification: input.classification,
        runId: run.id,
        objectiveId: run.objectiveId,
        engineAgentId: run.engineAgentId,
        ownerUserId: input.ownerUserId,
        approvalRequestId: input.approvalRequestId ?? null,
      },
      policy,
      now,
    );

    if (!decision.persist) {
      // Audited even though nothing was written. "The agent tried to remember something it was
      // not allowed to" is a governance event, and a refusal that leaves no trace is one nobody
      // can act on.
      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'memory.write_refused',
          resourceType: 'agent-run',
          resourceId: run.id,
          summary: `Memory refused for ${input.label}: ${decision.reason}`,
          metadata: {
            mode,
            classification: input.classification,
            reason: decision.reason,
          },
        }),
      );
      return { remembered: false, reason: decision.reason };
    }

    const record = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const created = await this.prisma.client.memoryRecord.create({
        data: {
          tenantId: input.scope.tenantId,
          mode,
          // Copied from the policy at write time, never read back from it. A company narrowing a
          // mode later must not retroactively change what an existing record was written under.
          visibility: decision.visibility,
          runId: run.id,
          objectiveId: run.objectiveId,
          engineAgentId: run.engineAgentId,
          ownerUserId: input.ownerUserId,
          classification: input.classification,
          label: input.label,
          content: input.content as never,
          expiresAt: decision.expiresAt,
          ...(input.approvalRequestId == null
            ? {}
            : { approvalRequestId: input.approvalRequestId }),
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'memory.remembered',
        resourceType: 'memory-record',
        resourceId: created.id,
        summary: `${mode} record kept: ${input.label}`,
        metadata: {
          mode,
          visibility: decision.visibility,
          classification: input.classification,
          expiresAt: decision.expiresAt?.toISOString() ?? 'never',
        },
      });

      return created;
    });

    return { remembered: true, record: MemoryService.toView(record) };
  }

  // -------------------------------------------------------------------------
  // Recalling
  // -------------------------------------------------------------------------

  /**
   * What a run may read back.
   *
   * The scope filter is applied twice on purpose: once as a database predicate so a run does not
   * fetch a company's whole memory to discard it, and once through `memoryReadable` so the answer
   * is the pure function's rather than a query's. If those two ever disagree the function wins,
   * and a test exists for each case the predicate cannot express.
   */
  async recall(input: {
    scope: TenantScope;
    runId: string;
    onBehalfOfUserId?: string | null;
    limit?: number;
    now?: Date;
  }): Promise<MemoryRecordView[]> {
    const now = input.now ?? new Date();

    const run = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.agentRun.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.runId },
        select: {
          id: true,
          objectiveId: true,
          engineAgentId: true,
          agent: { select: { memoryMode: true } },
        },
      }),
    );

    if (run === null) {
      throw new NotFoundException('That run does not exist in this company.');
    }

    const mode = run.agent.memoryMode as AgentMemoryMode;
    const policy = await this.policy(input.scope, mode);

    const candidates = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.memoryRecord.findMany({
        where: {
          tenantId: input.scope.tenantId,
          deletedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          // The widest set the run could possibly be entitled to. `memoryReadable` then narrows
          // it to what it actually is.
          AND: [
            {
              OR: [
                { runId: run.id },
                { engineAgentId: run.engineAgentId },
                ...(run.objectiveId === null ? [] : [{ objectiveId: run.objectiveId }]),
                { visibility: 'CompanyWide' },
              ],
            },
          ],
        },
        orderBy: [{ createdAt: 'desc' }],
        take: Math.min(input.limit ?? 50, 200),
      }),
    );

    return candidates
      .filter((candidate) =>
        memoryReadable(
          {
            mode: candidate.mode as AgentMemoryMode,
            visibility: candidate.visibility as MemoryVisibility,
            runId: candidate.runId,
            objectiveId: candidate.objectiveId,
            engineAgentId: candidate.engineAgentId,
            ownerUserId: candidate.ownerUserId,
            expiresAt: candidate.expiresAt,
            deletedAt: candidate.deletedAt,
          },
          {
            runId: run.id,
            objectiveId: run.objectiveId,
            engineAgentId: run.engineAgentId,
            onBehalfOfUserId: input.onBehalfOfUserId ?? null,
            now,
          },
          policy,
        ),
      )
      .map((candidate) => MemoryService.toView(candidate));
  }

  /**
   * The governance list: what this company's agents are holding.
   *
   * `agents:View` — the same grant the registry uses, because this is "what does our agent know",
   * which is a question about the agent. Deleted and expired records are included: "what was
   * deleted, when and why" is the question a data review asks, and a list that hid them would
   * make a deletion unverifiable.
   */
  async list(input: {
    scope: TenantScope;
    actorUserId: string;
    engineAgentId?: string;
    mode?: AgentMemoryMode;
    includeDeleted?: boolean;
    limit?: number;
  }): Promise<MemoryRecordView[]> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'View' });

    const rows = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.memoryRecord.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.engineAgentId === undefined ? {} : { engineAgentId: input.engineAgentId }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.includeDeleted === true ? {} : { deletedAt: null }),
        },
        orderBy: [{ createdAt: 'desc' }],
        take: Math.min(input.limit ?? 100, 200),
      }),
    );

    return rows.map((row) => MemoryService.toView(row));
  }

  // -------------------------------------------------------------------------
  // Forgetting
  // -------------------------------------------------------------------------

  /**
   * Delete one record.
   *
   * `settings:Administer`, and the content is **nulled rather than the row removed**. A deletion
   * that left no trace would make "was our data deleted?" unanswerable; a row with no content,
   * a timestamp and a reason answers it. The database enforces the emptiness
   * (`deleted_memory_keeps_no_content`), so a deletion cannot be a tombstone with the data still
   * in it.
   */
  async forget(input: {
    scope: TenantScope;
    actorUserId: string;
    recordId: string;
    reason: string;
  }): Promise<MemoryRecordView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.reason.trim() === '') {
      throw new BadRequestException('Say why this record is being deleted.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.memoryRecord.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.recordId },
      });
      if (existing === null) {
        throw new NotFoundException('That memory record does not exist in this company.');
      }
      if (existing.deletedAt !== null) {
        throw new ForbiddenException('That record has already been deleted.');
      }

      const updated = await this.prisma.client.memoryRecord.update({
        where: { id: existing.id },
        data: {
          // SQL NULL, not JSON null: the check constraint asks for an absent value, and storing the
          // JSON literal `null` would leave the column non-null and the row refused.
          content: Prisma.DbNull,
          deletedAt: new Date(),
          deletedReason: input.reason,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'memory.deleted',
        resourceType: 'memory-record',
        resourceId: updated.id,
        actorUserId: input.actorUserId,
        summary: `Memory deleted: ${updated.label}. ${input.reason}`,
        resourceVersion: updated.version,
        metadata: { mode: updated.mode, label: updated.label, reason: input.reason },
      });

      return MemoryService.toView(updated);
    });
  }

  /**
   * The retention sweep: expire what has run out of time.
   *
   * Nothing schedules this yet — it belongs with the Prompt 26 business-cron scheduler, and
   * wiring a second scheduler here would have been a second scheduler. It is reachable through a
   * platform route and it is tested, which is the honest state.
   *
   * An expiry nulls the content exactly as a deletion does, because a record past its retention
   * window that still holds its content has not expired in any sense a customer would accept.
   */
  async sweepExpired(input: { scope: TenantScope; now?: Date }): Promise<{ expired: number }> {
    const now = input.now ?? new Date();

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const due = await this.prisma.client.memoryRecord.findMany({
        where: {
          tenantId: input.scope.tenantId,
          deletedAt: null,
          expiresAt: { not: null, lte: now },
        },
        select: { id: true, label: true, mode: true },
      });

      for (const record of due) {
        await this.prisma.client.memoryRecord.update({
          where: { id: record.id },
          data: {
            // SQL NULL, not JSON null: the check constraint asks for an absent value, and storing the
            // JSON literal `null` would leave the column non-null and the row refused.
            content: Prisma.DbNull,
            deletedAt: now,
            deletedReason: 'Retention window reached.',
            version: { increment: 1 },
          },
        });

        await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'memory.expired',
          resourceType: 'memory-record',
          resourceId: record.id,
          summary: `Memory expired: ${record.label}`,
          metadata: { mode: record.mode, label: record.label },
        });
      }

      return { expired: due.length };
    });
  }

  /**
   * What happens to a leaver's memory.
   *
   * Called by Prompt 13's offboarding rather than exposed as its own act, because "somebody left"
   * is one event and the memory consequence is part of it. Each record is handled under the policy
   * for **its own mode**, so a company can delete personal ephemeral context and keep anonymised
   * agent knowledge in the same offboarding.
   *
   * `TransferToSuccessor` with no successor deletes rather than leaving a record owned by somebody
   * who has left — access nobody reviews is worse than a deletion (see `offboardingOutcome`).
   */
  async applyOffboarding(input: {
    scope: TenantScope;
    subjectUserId: string;
    successorUserId: string | null;
    actorUserId: string;
    now?: Date;
  }): Promise<{ deleted: number; transferred: number; anonymised: number }> {
    const now = input.now ?? new Date();
    const policies = await this.policies(input.scope);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const records = await this.prisma.client.memoryRecord.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ownerUserId: input.subjectUserId,
          deletedAt: null,
        },
        select: { id: true, mode: true, label: true },
      });

      let deleted = 0;
      let transferred = 0;
      let anonymised = 0;

      for (const record of records) {
        const policy = policies.find((candidate) => candidate.mode === record.mode);
        if (policy === undefined) continue;

        const outcome = offboardingOutcome(policy, input.successorUserId);

        if (outcome.action === 'Delete') {
          await this.prisma.client.memoryRecord.update({
            where: { id: record.id },
            data: {
              // SQL NULL, not JSON null: the check constraint asks for an absent value, and storing the
              // JSON literal `null` would leave the column non-null and the row refused.
              content: Prisma.DbNull,
              deletedAt: now,
              deletedReason: 'Owner offboarded.',
              version: { increment: 1 },
            },
          });
          deleted += 1;
        } else if (outcome.action === 'Transfer') {
          await this.prisma.client.memoryRecord.update({
            where: { id: record.id },
            data: { ownerUserId: outcome.toUserId, version: { increment: 1 } },
          });
          transferred += 1;
        } else if (outcome.action === 'Anonymise') {
          await this.prisma.client.memoryRecord.update({
            where: { id: record.id },
            data: { ownerUserId: null, version: { increment: 1 } },
          });
          anonymised += 1;
        }
      }

      if (records.length > 0) {
        await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'memory.offboarding_applied',
          resourceType: 'user',
          resourceId: input.subjectUserId,
          actorUserId: input.actorUserId,
          summary:
            `Memory handled on offboarding: ${deleted} deleted, ${transferred} transferred, ` +
            `${anonymised} anonymised.`,
          metadata: {
            deleted,
            transferred,
            anonymised,
            successorUserId: input.successorUserId ?? 'none',
          },
        });
      }

      return { deleted, transferred, anonymised };
    });
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  private static toPolicy(row: {
    mode: string;
    retentionDays: number | null;
    visibility: string;
    maxClassification: string;
    allowCrossUser: boolean;
    allowCrossObjective: boolean;
    offboardingBehaviour: string;
    requiresApproval: boolean;
  }): MemoryPolicy {
    return {
      mode: row.mode as AgentMemoryMode,
      retentionDays: row.retentionDays,
      visibility: row.visibility as MemoryVisibility,
      maxClassification: row.maxClassification as DataClassification,
      allowCrossUser: row.allowCrossUser,
      allowCrossObjective: row.allowCrossObjective,
      offboardingBehaviour: row.offboardingBehaviour as MemoryPolicy['offboardingBehaviour'],
      requiresApproval: row.requiresApproval,
    };
  }

  private static toView(row: {
    id: string;
    mode: string;
    visibility: string;
    classification: string;
    label: string;
    runId: string;
    objectiveId: string | null;
    engineAgentId: string;
    ownerUserId: string | null;
    content: unknown;
    expiresAt: Date | null;
    deletedAt: Date | null;
    deletedReason: string | null;
    createdAt: Date;
  }): MemoryRecordView {
    return {
      id: row.id,
      mode: row.mode as AgentMemoryMode,
      visibility: row.visibility as MemoryVisibility,
      classification: row.classification as DataClassification,
      label: row.label,
      runId: row.runId,
      objectiveId: row.objectiveId,
      engineAgentId: row.engineAgentId,
      ownerUserId: row.ownerUserId,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      deletedReason: row.deletedReason,
      createdAt: row.createdAt.toISOString(),
      hasContent: row.content !== null,
    };
  }
}
