import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  ALLOWED_SKILL_TRANSITIONS,
  isPlatformLayer,
  isSkillContentFrozen,
  mayTransitionSkill,
  SKILL_IMPACT_DOMAINS,
  SKILL_LAYER_LABELS,
  validateSkillContent,
  validateSkillGovernance,
  type SkillAutonomy,
  type SkillCategory,
  type SkillContent,
  type SkillCreationMode,
  type SkillLayer,
  type SkillStatus,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { Skill, SkillVersion } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

export interface SkillVersionView {
  id: string;
  versionNumber: number;
  status: SkillStatus;
  content: SkillContent;
  creationMode: SkillCreationMode;
  sourceReference: string | null;
  clonedFromVersionId: string | null;
  /** Frozen at `Approved`, not merely `Published`. See the class comment. */
  contentFrozen: boolean;
  reviewedByUserId: string | null;
  approvedByUserId: string | null;
  publishedByUserId: string | null;
  publishedAt: string | null;
  retirementReason: string | null;
  /** Which statuses this version may move to next. The closed table, on the wire. */
  nextStatuses: SkillStatus[];
}

export interface SkillView {
  id: string;
  layer: SkillLayer;
  layerLabel: string;
  key: string;
  name: string;
  industry: string | null;
  /** Null for a platform Skill, whose owner is UBoss. */
  ownerUserId: string | null;
  /** True when this company owns it and may therefore author it. */
  editableHere: boolean;
  clonedFromSkillId: string | null;
  publishedVersion: SkillVersionView | null;
  /** The one open draft, if there is one. */
  openDraft: SkillVersionView | null;
  versions: SkillVersionView[];
}

export interface ImpactAnalysis {
  skillId: string;
  fromVersion: number | null;
  toVersion: number;
  domains: {
    key: string;
    label: string;
    status: string;
    /** Null where the domain cannot be counted yet, which is different from zero. */
    count: number | null;
    detail: string;
  }[];
  /** True when at least one domain cannot be counted. The screen must say so. */
  incomplete: boolean;
  note: string;
}

/**
 * Skills: governed reusable capabilities.
 *
 * ## A Skill is not a Template
 *
 * The locked rule is that there is no Objective, Workflow or Agent Template and no Templates
 * Library. This service is the reason the distinction is real rather than a naming convention:
 * a Skill has a **lifecycle** (Draft → Test → Review → Approved → Published → Deprecated →
 * Archived), **immutable published content**, an **owner**, an **autonomy limit**, an **approval
 * trail** and **impact analysis before an upgrade**. A copy-me starting point would need none of
 * those, and would have no answer to "what is using this version".
 *
 * Cloning a platform Skill therefore does **not** produce a copy that stops mattering: it
 * produces a new `CompanyCustom` Skill with its own draft, its own approval and a recorded
 * provenance link, so the catalogue can still answer "who cloned this".
 *
 * ## Content freezes at `Approved`, which is stricter than the client asked
 *
 * The rule names publication. Freezing at approval is deliberate and stated: an approval is a
 * governance decision about **specific content**, so content that could change afterwards would
 * make the approval worthless — somebody could get "delete records" approved by having "read
 * records" reviewed. Enforced by a database trigger, because a service is one missed branch away
 * from losing it.
 *
 * ## Two planes, one catalogue
 *
 * A platform Skill has no tenant and is readable by every company; a custom Skill belongs to one.
 * The Row-Level Security policy is asymmetric — read a platform row, never write one — so a
 * company can use and clone a Verified Skill and can never author or approve one. That asymmetry
 * is the security property: a symmetric policy would let any company publish something every
 * other company reads as verified by UBoss.
 */
@Injectable()
export class SkillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  // -------------------------------------------------------------------------
  // Reading the catalogue
  // -------------------------------------------------------------------------

  /**
   * The catalogue as one company sees it: platform Skills plus its own.
   *
   * `settings:View`, because Skills & AI is a Settings category. Reading the catalogue is not a
   * privileged act — an employee needs to know what capabilities exist to understand what an
   * agent is doing — and only **authoring** is gated.
   */
  async catalogueFor(input: {
    scope: TenantScope;
    actorUserId: string;
    layer?: SkillLayer | undefined;
    category?: SkillCategory | undefined;
    /** Only what work may actually reference. */
    publishedOnly?: boolean | undefined;
  }): Promise<{ skills: SkillView[]; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    const mayAuthor = (
      await this.authorization.authorize(context, { module: 'settings', action: 'Administer' })
    ).allowed;

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      // RLS returns platform rows (`tenant_id IS NULL`) **and** this company's, which is exactly
      // what "a Verified Skill is available to every company" means. No `OR` is needed here; the
      // policy is the filter.
      const skills = await this.prisma.client.skill.findMany({
        where: {
          ...(input.layer === undefined ? {} : { layer: input.layer }),
        },
        orderBy: [{ layer: 'asc' }, { name: 'asc' }],
      });

      const versions = await this.prisma.client.skillVersion.findMany({
        where: {
          skillId: { in: skills.map((skill) => skill.id) },
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.publishedOnly ? { status: 'Published' } : {}),
        },
        orderBy: { versionNumber: 'desc' },
      });

      const views = skills
        .map((skill) =>
          this.viewOf(
            skill,
            versions.filter((row) => row.skillId === skill.id),
            input.scope.tenantId,
            mayAuthor,
          ),
        )
        // A category filter is applied to versions, so a Skill with no matching version drops
        // out rather than appearing empty.
        .filter((view) => input.category === undefined || view.versions.length > 0);

      return {
        skills: views,
        note:
          'Skills are governed capabilities, not templates. Work references a **published ' +
          'version**, that version cannot be edited, and an authorised change creates a new ' +
          'draft that must be approved before anything uses it. A UBoss Verified Skill or an ' +
          'Industry Pack can be used or cloned here, never edited.',
      };
    });
  }

  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    skillId: string;
  }): Promise<SkillView> {
    const catalogue = await this.catalogueFor({
      scope: input.scope,
      actorUserId: input.actorUserId,
    });
    const found = catalogue.skills.find((skill) => skill.id === input.skillId);
    if (!found) {
      throw new NotFoundException('There is no such Skill you can see.');
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------

  /**
   * Create a company custom Skill with its first draft.
   *
   * `settings:Administer`. A company may only ever author in the `CompanyCustom` layer — the
   * database refuses anything else, and so does this.
   */
  async createCompanySkill(input: {
    scope: TenantScope;
    actorUserId: string;
    key: string;
    name: string;
    content: SkillContent;
    creationMode: SkillCreationMode;
    /** Required for `FromDocument`: which SOP or document the draft was written from. */
    sourceReference?: string | undefined;
  }): Promise<SkillView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.creationMode === 'Clone') {
      throw new BadRequestException(
        'Use the clone route: a clone records which version it came from, and creating one here ' +
          'would lose that provenance.',
      );
    }

    this.assertContentIsValid(input.content);

    if (input.creationMode === 'FromDocument' && !input.sourceReference?.trim()) {
      throw new BadRequestException(
        'A Skill drafted from a document must say which document, so a reviewer can check the ' +
          'Skill against its source.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.skill.findFirst({
        where: { tenantId: input.scope.tenantId, key: input.key },
      });
      if (existing) {
        throw new ConflictException(
          `This company already has a Skill called "${input.key}". Edit it — which creates a new ` +
            'draft version — rather than adding a second one with the same handle.',
        );
      }

      const skill = await this.prisma.client.skill.create({
        data: {
          tenantId: input.scope.tenantId,
          layer: 'CompanyCustom',
          key: input.key,
          name: input.name.trim(),
          ownerUserId: input.actorUserId,
          createdByUserId: input.actorUserId,
        },
      });

      const version = await this.createVersionRow({
        tenantId: input.scope.tenantId,
        skillId: skill.id,
        versionNumber: 1,
        content: input.content,
        creationMode: input.creationMode,
        ...(input.sourceReference === undefined
          ? {}
          : { sourceReference: input.sourceReference.trim() }),
        createdByUserId: input.actorUserId,
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'skill.created',
        resourceType: 'skill',
        resourceId: skill.id,
        actorUserId: input.actorUserId,
        summary: `Created the company Skill "${skill.name}" as a draft.`,
        metadata: {
          key: skill.key,
          layer: 'CompanyCustom',
          creationMode: input.creationMode,
          autonomy: input.content.autonomy,
          requiresApproval: input.content.requiresApproval,
          // Stated in the trail: a Skill is not a template, and this one starts as a draft that
          // must be approved before anything can use it.
          startsAs: 'Draft',
        },
      });

      return this.viewOf(skill, [version], input.scope.tenantId, true);
    });
  }

  /**
   * Clone any Skill this company can see into its own layer.
   *
   * **This is what a company does instead of editing a platform Skill**, and it is the reason
   * cloning is not "copying a template": the result is a new Skill with its own draft, its own
   * approval trail and a recorded provenance link, so the catalogue can still answer "who cloned
   * this" — which is a question the impact analysis asks.
   */
  async cloneSkill(input: {
    scope: TenantScope;
    actorUserId: string;
    sourceSkillId: string;
    /** Which version to clone. Defaults to the published one. */
    sourceVersionId?: string | undefined;
    key: string;
    name: string;
  }): Promise<SkillView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const source = await this.prisma.client.skill.findFirst({
        where: { id: input.sourceSkillId },
      });
      if (!source) {
        throw new NotFoundException('There is no such Skill to clone.');
      }

      const sourceVersion = await this.prisma.client.skillVersion.findFirst({
        where: {
          skillId: source.id,
          ...(input.sourceVersionId === undefined
            ? { status: 'Published' }
            : { id: input.sourceVersionId }),
        },
      });
      if (!sourceVersion) {
        throw new BadRequestException(
          'That Skill has no published version to clone. Cloning an unapproved draft would ' +
            'copy content nobody has reviewed.',
        );
      }

      const existing = await this.prisma.client.skill.findFirst({
        where: { tenantId: input.scope.tenantId, key: input.key },
      });
      if (existing) {
        throw new ConflictException(`This company already has a Skill called "${input.key}".`);
      }

      const skill = await this.prisma.client.skill.create({
        data: {
          tenantId: input.scope.tenantId,
          layer: 'CompanyCustom',
          key: input.key,
          name: input.name.trim(),
          ownerUserId: input.actorUserId,
          clonedFromSkillId: source.id,
          createdByUserId: input.actorUserId,
        },
      });

      const version = await this.prisma.client.skillVersion.create({
        data: {
          tenantId: input.scope.tenantId,
          skillId: skill.id,
          versionNumber: 1,
          // A clone starts as a **draft**, whatever the source's status was. Inheriting
          // `Published` would mean this company's Skill was live without anybody here approving
          // it, which is precisely the governance the layer separation exists for.
          status: 'Draft',
          purpose: sourceVersion.purpose,
          category: sourceVersion.category,
          whenToUse: sourceVersion.whenToUse,
          whenNotToUse: sourceVersion.whenNotToUse,
          inputs: sourceVersion.inputs as never,
          rules: sourceVersion.rules as never,
          steps: sourceVersion.steps as never,
          allowedToolCategories: sourceVersion.allowedToolCategories,
          outputSchema: sourceVersion.outputSchema,
          validation: sourceVersion.validation,
          failureHandling: sourceVersion.failureHandling,
          requiresApproval: sourceVersion.requiresApproval,
          autonomy: sourceVersion.autonomy,
          evidenceRequirement: sourceVersion.evidenceRequirement,
          creationMode: 'Clone',
          clonedFromVersionId: sourceVersion.id,
          createdByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'skill.cloned',
        resourceType: 'skill',
        resourceId: skill.id,
        actorUserId: input.actorUserId,
        summary: `Cloned ${SKILL_LAYER_LABELS[source.layer]} "${source.name}" into this company.`,
        metadata: {
          sourceSkillId: source.id,
          sourceLayer: source.layer,
          sourceVersionNumber: sourceVersion.versionNumber,
          // Stated: the clone is not live. It is a draft under this company's own approval.
          startsAs: 'Draft',
        },
      });

      return this.viewOf(skill, [version], input.scope.tenantId, true);
    });
  }

  /**
   * Start a new draft version of an existing company Skill.
   *
   * **This is what "editing" means.** The published version is untouched; work carries on
   * referencing it until the new one is approved and published. The client's versioning rule, and
   * the reason `Published` has no transition back to `Draft`.
   */
  async startNewDraft(input: {
    scope: TenantScope;
    actorUserId: string;
    skillId: string;
    /** Omitted fields are carried from the version being superseded. */
    changes: Partial<SkillContent>;
  }): Promise<SkillVersionView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const skill = await this.requireCompanySkill(input.scope, input.skillId);

      const open = await this.prisma.client.skillVersion.findFirst({
        where: { skillId: skill.id, status: { in: ['Draft', 'Test', 'Review'] } },
      });
      if (open) {
        throw new ConflictException(
          `Version ${open.versionNumber} is still open. Finish or archive it before starting ` +
            'another — two drafts of the same Skill make "the draft" meaningless.',
        );
      }

      const latest = await this.prisma.client.skillVersion.findFirst({
        where: { skillId: skill.id },
        orderBy: { versionNumber: 'desc' },
      });
      if (!latest) {
        throw new BadRequestException('That Skill has no version to build on.');
      }

      const content = { ...this.contentOf(latest), ...input.changes };
      this.assertContentIsValid(content);

      const created = await this.createVersionRow({
        tenantId: input.scope.tenantId,
        skillId: skill.id,
        versionNumber: latest.versionNumber + 1,
        content,
        creationMode: 'Manual',
        createdByUserId: input.actorUserId,
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'skill.new_draft_started',
        resourceType: 'skill_version',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        summary: `Version ${created.versionNumber} of "${skill.name}" started as a draft.`,
        metadata: {
          skillId: skill.id,
          supersedesVersion: latest.versionNumber,
          // The whole point of the versioning rule, on the record.
          publishedVersionUnchanged: true,
        },
      });

      return this.versionViewOf(created);
    });
  }

  /** Edit an open draft in place. Refused once the content is frozen. */
  async updateDraft(input: {
    scope: TenantScope;
    actorUserId: string;
    versionId: string;
    changes: Partial<SkillContent>;
  }): Promise<SkillVersionView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const version = await this.requireCompanyVersion(input.scope, input.versionId);

      if (isSkillContentFrozen(version.status)) {
        throw new ConflictException(
          `Version ${version.versionNumber} is ${version.status} and its content cannot be ` +
            'changed. Start a new draft instead — an approval is a decision about specific ' +
            'content, so content that could change afterwards would make it worthless.',
        );
      }

      const content = { ...this.contentOf(version), ...input.changes };
      this.assertContentIsValid(content);

      const updated = await this.prisma.client.skillVersion.update({
        where: { id: version.id },
        data: { ...this.contentColumns(content), rowVersion: { increment: 1 } },
      });

      return this.versionViewOf(updated);
    });
  }

  // -------------------------------------------------------------------------
  // The lifecycle
  // -------------------------------------------------------------------------

  /**
   * Move a version through the lifecycle.
   *
   * One method with a closed transition table rather than a method per step, so the whole
   * lifecycle is auditable in one place — and so an unlisted move is impossible rather than
   * merely unimplemented.
   */
  async transition(input: {
    scope: TenantScope;
    actorUserId: string;
    versionId: string;
    to: SkillStatus;
    reason?: string | undefined;
  }): Promise<SkillVersionView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);

    /*
     * Read the row **inside a tenant transaction**, because the permission this call needs
     * depends on the row's current status — a guard cannot know it, and neither can this method
     * until it has loaded it. `this.prisma.client` outside a scope has no
     * `app.current_tenant_id`, so Row-Level Security returns nothing and every version looks
     * like it does not exist. That cost this suite nineteen failing tests, and it is the right
     * failure mode: fail closed rather than read across tenants.
     */
    const version = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.requireCompanyVersion(input.scope, input.versionId),
    );

    /*
     * **Approving and rejecting are the same permission.**
     *
     * `Approved` is obviously a reviewer's act. So is sending a version **back** to Draft — that
     * is what rejecting *is*, and a lifecycle where a reviewer can approve but not reject is one
     * that gets worked around by approving things and fixing them later. This prompt's own tests
     * caught it: the Approver role could approve and then could not send the next one back.
     *
     * Everything else — starting a draft, publishing an approved version, deprecating, archiving
     * — is `Administer`.
     */
    const isReviewerAct =
      input.to === 'Approved' || (input.to === 'Draft' && version.status !== 'Draft');

    await this.authorization.assertCan(context, {
      module: 'settings',
      action: isReviewerAct ? 'Approve' : 'Administer',
    });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      if (!mayTransitionSkill(version.status, input.to)) {
        throw new ConflictException(
          `A ${version.status} version cannot become ${input.to}. ` +
            (version.status === 'Published' && input.to === 'Draft'
              ? 'A published version is immutable — start a new draft instead.'
              : version.status === 'Archived'
                ? 'Archiving is final; a new version is how a capability comes back.'
                : 'The lifecycle is Draft → Test → Review → Approved → Published, with ' +
                  'Deprecated and Archived at the end.'),
        );
      }

      const rejecting =
        (input.to === 'Draft' && version.status !== 'Draft') ||
        input.to === 'Deprecated' ||
        input.to === 'Archived';

      if (rejecting && !input.reason?.trim()) {
        throw new BadRequestException(
          input.to === 'Draft'
            ? 'Sending a version back needs a reason: the author has to know what to change.'
            : `${input.to === 'Deprecated' ? 'Deprecating' : 'Archiving'} a capability other ` +
                'work may depend on needs a reason.',
        );
      }

      if (input.to === 'Approved') {
        // Re-validated at the approval boundary. This is the last moment the content can be
        // refused, and it is the moment it becomes frozen — so a governance rule that was
        // introduced after the draft was written still applies.
        this.assertContentIsValid(this.contentOf(version));
      }

      const at = new Date();

      /*
       * **The outgoing version is deprecated before the new one becomes live.**
       *
       * `one_published_version_per_skill` permits exactly one, so setting this version to
       * `Published` while the previous one still is fails on the index. The order is not a
       * preference — it is the only order the constraint allows, and the constraint is what makes
       * "which version does work reference" unambiguous.
       *
       * This prompt's own test caught it: the code used to publish first and deprecate after,
       * with a comment claiming the opposite.
       */
      if (input.to === 'Published') {
        await this.prisma.client.skillVersion.updateMany({
          where: { skillId: version.skillId, status: 'Published', id: { not: version.id } },
          data: {
            status: 'Deprecated',
            deprecatedAt: at,
            retirementReason: `Superseded by version ${version.versionNumber}.`,
          },
        });
      }

      const updated = await this.prisma.client.skillVersion.update({
        where: { id: version.id },
        data: {
          status: input.to,
          ...(input.to === 'Review' ? { reviewedAt: at, reviewedByUserId: input.actorUserId } : {}),
          ...(input.to === 'Approved'
            ? { approvedAt: at, approvedByUserId: input.actorUserId }
            : {}),
          ...(input.to === 'Published'
            ? { publishedAt: at, publishedByUserId: input.actorUserId }
            : {}),
          ...(input.to === 'Deprecated' ? { deprecatedAt: at } : {}),
          ...(rejecting && input.reason ? { retirementReason: input.reason.trim() } : {}),
          rowVersion: { increment: 1 },
        },
      });

      await this.prisma.client.skillTransition.create({
        data: {
          tenantId: input.scope.tenantId,
          skillVersionId: version.id,
          fromStatus: version.status,
          toStatus: input.to,
          ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
          actorUserId: input.actorUserId,
          occurredAt: at,
        },
      });

      if (input.to === 'Published') {
        await this.prisma.client.skill.update({
          where: { id: version.skillId },
          data: { publishedVersionId: version.id, version: { increment: 1 } },
        });
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: `skill.${input.to.toLowerCase()}`,
        resourceType: 'skill_version',
        resourceId: version.id,
        resourceVersion: version.versionNumber,
        actorUserId: input.actorUserId,
        summary: `Skill version ${version.versionNumber}: ${version.status} → ${input.to}.`,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        metadata: {
          skillId: version.skillId,
          from: version.status,
          to: input.to,
          contentFrozen: isSkillContentFrozen(input.to),
        },
      });

      return this.versionViewOf(updated);
    });
  }

  /**
   * What an upgrade would affect, before it happens.
   *
   * A **declared registry** rather than a set of queries, because three of the five domains
   * cannot be counted yet: Engine Agents, Objectives and runs all arrive at later prompts. The
   * difference between "no affected Objectives" and "we cannot count Objectives" is the entire
   * value of an impact analysis, so each domain reports `count: null` with the prompt that will
   * make it real, and `incomplete` says so at the top.
   *
   * Reporting four zeroes would be worse than useless: somebody would publish on the strength of
   * it.
   */
  async impactOf(input: {
    scope: TenantScope;
    actorUserId: string;
    versionId: string;
  }): Promise<ImpactAnalysis> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const version = await this.prisma.client.skillVersion.findFirst({
        where: { id: input.versionId },
      });
      if (!version) {
        throw new NotFoundException('There is no such Skill version you can see.');
      }

      const live = await this.prisma.client.skillVersion.findFirst({
        where: { skillId: version.skillId, status: 'Published' },
      });

      const clones = await this.prisma.client.skill.count({
        where: { clonedFromSkillId: version.skillId },
      });

      const domains = SKILL_IMPACT_DOMAINS.map((domain) => {
        if (domain.key === 'clones') {
          return {
            key: domain.key,
            label: domain.label,
            status: 'counted',
            count: clones,
            detail:
              clones === 0
                ? 'Nothing has been cloned from this Skill.'
                : `${clones} company Skill(s) were cloned from this one. They are independent — ` +
                  'each has its own approval — so they are not upgraded by this change.',
          };
        }

        if (domain.status === 'derived') {
          return {
            key: domain.key,
            label: domain.label,
            status: 'derived',
            count: null,
            detail: domain.note,
          };
        }

        return {
          key: domain.key,
          label: domain.label,
          status: 'not-implemented',
          count: null,
          detail:
            `Cannot be counted yet — ${domain.label.toLowerCase()} arrive with ` +
            `${domain.arrivesWith}. Reported as unknown rather than zero, because a zero here ` +
            'would be read as "nothing is affected".',
        };
      });

      return {
        skillId: version.skillId,
        fromVersion: live?.versionNumber ?? null,
        toVersion: version.versionNumber,
        domains,
        incomplete: domains.some((domain) => domain.count === null),
        note:
          'Three of these five cannot be counted until the modules that reference a Skill exist. ' +
          'They report unknown rather than zero: an impact analysis that under-reports is worse ' +
          'than one that admits what it cannot see, because somebody would publish on the ' +
          'strength of it.',
      };
    });
  }

  /** One version's governance trail, newest first. */
  async historyOf(input: { scope: TenantScope; actorUserId: string; versionId: string }): Promise<{
    transitions: {
      from: SkillStatus;
      to: SkillStatus;
      reason: string | null;
      actorUserId: string | null;
      occurredAt: string;
    }[];
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.skillTransition.findMany({
        where: { skillVersionId: input.versionId },
        orderBy: { occurredAt: 'desc' },
      });

      return {
        transitions: rows.map((row) => ({
          from: row.fromStatus,
          to: row.toStatus,
          reason: row.reason,
          actorUserId: row.actorUserId,
          occurredAt: row.occurredAt.toISOString(),
        })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // The platform plane
  // -------------------------------------------------------------------------

  /**
   * Create a platform Skill — Verified or an Industry Pack.
   *
   * Platform-plane, and the only way a `tenant_id IS NULL` row comes into existence. A company
   * cannot reach this: the RLS `WITH CHECK` refuses the write even if a route were somehow
   * reachable, which is the belt to this brace.
   */
  async createPlatformSkill(input: {
    actorUserId: string;
    layer: SkillLayer;
    key: string;
    name: string;
    industry?: string | undefined;
    content: SkillContent;
  }): Promise<{ skillId: string; versionId: string }> {
    if (!isPlatformLayer(input.layer)) {
      throw new BadRequestException(
        'Only a UBoss Verified Skill or an Industry Pack is published from the platform. A ' +
          'company custom Skill belongs to its company.',
      );
    }
    if (input.layer === 'IndustryPack' && !input.industry?.trim()) {
      throw new BadRequestException(
        'An Industry Pack must name its industry, or it is a Verified Skill by another name.',
      );
    }

    this.assertContentIsValid(input.content);

    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.prisma.client.skill.findFirst({
        where: { tenantId: null, key: input.key },
      });
      if (existing) {
        throw new ConflictException(`A platform Skill called "${input.key}" already exists.`);
      }

      const skill = await this.prisma.client.skill.create({
        data: {
          tenantId: null,
          layer: input.layer,
          key: input.key,
          name: input.name.trim(),
          ...(input.industry?.trim() ? { industry: input.industry.trim() } : {}),
          createdByUserId: input.actorUserId,
        },
      });

      const version = await this.createVersionRow({
        tenantId: null,
        skillId: skill.id,
        versionNumber: 1,
        content: input.content,
        creationMode: 'Manual',
        createdByUserId: input.actorUserId,
      });

      await this.auditEvents.appendWithinCurrentScope(null, {
        action: 'skill.platform_created',
        resourceType: 'skill',
        resourceId: skill.id,
        actorUserId: input.actorUserId,
        summary: `Created the ${SKILL_LAYER_LABELS[input.layer]} "${skill.name}" as a draft.`,
        metadata: {
          key: skill.key,
          layer: input.layer,
          industry: input.industry?.trim() ?? null,
          // Every company will be able to read this once published, which is why it is a
          // platform-plane act.
          visibleToEveryCompanyOncePublished: true,
        },
      });

      return { skillId: skill.id, versionId: version.id };
    });
  }

  /** Move a platform Skill version through the lifecycle. Platform-plane. */
  async transitionPlatformVersion(input: {
    actorUserId: string;
    versionId: string;
    to: SkillStatus;
    reason?: string | undefined;
  }): Promise<{ status: SkillStatus; versionNumber: number }> {
    return this.prisma.runAsPlatformOperation(async () => {
      const version = await this.prisma.client.skillVersion.findFirst({
        where: { id: input.versionId, tenantId: null },
      });
      if (!version) {
        throw new NotFoundException('There is no such platform Skill version.');
      }

      if (!mayTransitionSkill(version.status, input.to)) {
        throw new ConflictException(
          `A ${version.status} platform Skill version cannot become ${input.to}.`,
        );
      }

      const rejecting =
        (input.to === 'Draft' && version.status !== 'Draft') ||
        input.to === 'Deprecated' ||
        input.to === 'Archived';
      if (rejecting && !input.reason?.trim()) {
        throw new BadRequestException(
          'A platform Skill is readable by every company, so sending it back or retiring it ' +
            'needs a reason.',
        );
      }

      const at = new Date();

      // Same ordering as the company path, and for the same reason: one published version at a
      // time, enforced by the index rather than by remembering.
      if (input.to === 'Published') {
        await this.prisma.client.skillVersion.updateMany({
          where: { skillId: version.skillId, status: 'Published', id: { not: version.id } },
          data: {
            status: 'Deprecated',
            deprecatedAt: at,
            retirementReason: `Superseded by version ${version.versionNumber}.`,
          },
        });
      }

      const updated = await this.prisma.client.skillVersion.update({
        where: { id: version.id },
        data: {
          status: input.to,
          ...(input.to === 'Review' ? { reviewedAt: at, reviewedByUserId: input.actorUserId } : {}),
          ...(input.to === 'Approved'
            ? { approvedAt: at, approvedByUserId: input.actorUserId }
            : {}),
          ...(input.to === 'Published'
            ? { publishedAt: at, publishedByUserId: input.actorUserId }
            : {}),
          ...(input.to === 'Deprecated' ? { deprecatedAt: at } : {}),
          ...(rejecting && input.reason ? { retirementReason: input.reason.trim() } : {}),
          rowVersion: { increment: 1 },
        },
      });

      await this.prisma.client.skillTransition.create({
        data: {
          tenantId: null,
          skillVersionId: version.id,
          fromStatus: version.status,
          toStatus: input.to,
          ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
          actorUserId: input.actorUserId,
          occurredAt: at,
        },
      });

      if (input.to === 'Published') {
        await this.prisma.client.skill.update({
          where: { id: version.skillId },
          data: { publishedVersionId: version.id, version: { increment: 1 } },
        });
      }

      await this.auditEvents.appendWithinCurrentScope(null, {
        action: `skill.platform_${input.to.toLowerCase()}`,
        resourceType: 'skill_version',
        resourceId: version.id,
        actorUserId: input.actorUserId,
        summary: `Platform Skill version ${version.versionNumber}: ${version.status} → ${input.to}.`,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        metadata: { from: version.status, to: input.to, skillId: version.skillId },
      });

      return { status: updated.status, versionNumber: updated.versionNumber };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertContentIsValid(content: Partial<SkillContent>): void {
    const problems = [...validateSkillContent(content), ...validateSkillGovernance(content)];
    if (problems.length > 0) {
      /*
       * Every problem, not the first: this is a long form, and being told one mistake at a time
       * is how a review cycle takes four days.
       *
       * Joined into one message rather than passed as an array. `BadRequestException(string[])`
       * puts the array in the response body but leaves `error.message` as the generic "Bad
       * Request Exception" — so a caller logging the error, and a test asserting on it, both
       * lose the reason entirely. One sentence per problem is readable and keeps the reason
       * where anybody looking for it will find it.
       */
      throw new BadRequestException(problems.join(' '));
    }
  }

  private contentColumns(content: SkillContent) {
    return {
      purpose: content.purpose.trim(),
      category: content.category,
      whenToUse: content.whenToUse.trim(),
      whenNotToUse: content.whenNotToUse.trim(),
      inputs: content.inputs as never,
      rules: content.rules as never,
      steps: content.steps as never,
      allowedToolCategories: content.allowedToolCategories,
      outputSchema: content.outputSchema.trim(),
      validation: content.validation.trim(),
      failureHandling: content.failureHandling.trim(),
      requiresApproval: content.requiresApproval,
      autonomy: content.autonomy as SkillAutonomy,
      evidenceRequirement: content.evidenceRequirement.trim(),
    };
  }

  private async createVersionRow(input: {
    tenantId: string | null;
    skillId: string;
    versionNumber: number;
    content: SkillContent;
    creationMode: SkillCreationMode;
    sourceReference?: string | undefined;
    createdByUserId: string;
  }): Promise<SkillVersion> {
    return this.prisma.client.skillVersion.create({
      data: {
        tenantId: input.tenantId,
        skillId: input.skillId,
        versionNumber: input.versionNumber,
        status: 'Draft',
        ...this.contentColumns(input.content),
        creationMode: input.creationMode,
        ...(input.sourceReference === undefined ? {} : { sourceReference: input.sourceReference }),
        createdByUserId: input.createdByUserId,
      },
    });
  }

  private contentOf(version: SkillVersion): SkillContent {
    return {
      purpose: version.purpose,
      category: version.category as SkillCategory,
      whenToUse: version.whenToUse,
      whenNotToUse: version.whenNotToUse,
      inputs: version.inputs as never,
      rules: version.rules as never,
      steps: version.steps as never,
      allowedToolCategories: [...version.allowedToolCategories],
      outputSchema: version.outputSchema,
      validation: version.validation,
      failureHandling: version.failureHandling,
      requiresApproval: version.requiresApproval,
      autonomy: version.autonomy,
      evidenceRequirement: version.evidenceRequirement,
    };
  }

  private versionViewOf(version: SkillVersion): SkillVersionView {
    return {
      id: version.id,
      versionNumber: version.versionNumber,
      status: version.status,
      content: this.contentOf(version),
      creationMode: version.creationMode,
      sourceReference: version.sourceReference,
      clonedFromVersionId: version.clonedFromVersionId,
      contentFrozen: isSkillContentFrozen(version.status),
      reviewedByUserId: version.reviewedByUserId,
      approvedByUserId: version.approvedByUserId,
      publishedByUserId: version.publishedByUserId,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      retirementReason: version.retirementReason,
      // Straight from the shared table, so the screen offers exactly the moves the service
      // will accept. A second copy here is precisely the drift this file warns about.
      nextStatuses: [...ALLOWED_SKILL_TRANSITIONS[version.status]],
    };
  }

  private viewOf(
    skill: Skill,
    versions: SkillVersion[],
    tenantId: string,
    mayAuthor: boolean,
  ): SkillView {
    const views = versions.map((version) => this.versionViewOf(version));

    return {
      id: skill.id,
      layer: skill.layer,
      layerLabel: SKILL_LAYER_LABELS[skill.layer],
      key: skill.key,
      name: skill.name,
      industry: skill.industry,
      ownerUserId: skill.ownerUserId,
      // A company may author only its own. Both halves matter: the layer decides ownership, the
      // permission decides whether this person may act on it.
      editableHere: skill.tenantId === tenantId && mayAuthor,
      clonedFromSkillId: skill.clonedFromSkillId,
      publishedVersion: views.find((version) => version.status === 'Published') ?? null,
      openDraft:
        views.find((version) => ['Draft', 'Test', 'Review'].includes(version.status)) ?? null,
      versions: views,
    };
  }

  private async requireCompanySkill(scope: TenantScope, skillId: string): Promise<Skill> {
    const skill = await this.prisma.client.skill.findFirst({ where: { id: skillId } });
    if (!skill) {
      throw new NotFoundException('There is no such Skill.');
    }
    if (skill.tenantId !== scope.tenantId) {
      throw new ForbiddenException(
        `${SKILL_LAYER_LABELS[skill.layer]} "${skill.name}" is published by UBoss and cannot be ` +
          'edited here. Clone it to make a version of your own — the clone has its own approval ' +
          'trail, which is why it is not the same as copying a template.',
      );
    }
    return skill;
  }

  private async requireCompanyVersion(
    scope: TenantScope,
    versionId: string,
  ): Promise<SkillVersion> {
    const version = await this.prisma.client.skillVersion.findFirst({ where: { id: versionId } });
    if (!version) {
      throw new NotFoundException('There is no such Skill version.');
    }
    if (version.tenantId !== scope.tenantId) {
      throw new ForbiddenException(
        'That version belongs to a Skill published by UBoss. Clone the Skill to make a version ' +
          'of your own.',
      );
    }
    return version;
  }
}
