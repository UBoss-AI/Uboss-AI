import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import {
  OrganizationRepository,
  type HierarchyRow,
} from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TenantRepository } from '../persistence/tenant.repository.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { FileService } from '../knowledge/file.service.js';
import { maskedAadhaar } from './aadhaar.js';
import { plainTextOf, sanitiseRichText } from './rich-text.js';

/** The hard ceiling the database trigger also enforces. See the migration. */
export const MAX_REPORTING_DEPTH = 64;

export interface HierarchyNode {
  kind: 'company' | 'department' | 'person';
  id: string;
  name: string;
  /** Person nodes only. */
  person?: {
    userId: string;
    ubossUniqueId: string;
    employeeId: string;
    designation: string;
    departmentName: string;
    reportingManagerName: string | null;
    employmentState: string;
    /** `NotInvited`, `InvitePending`, `Active`… or null when there is no membership yet. */
    accountState: string | null;
  };
  /** Department nodes only: how many people sit at or beneath it. */
  headcount?: number;
  children: HierarchyNode[];
}

export interface HierarchyView {
  company: { name: string; vision: string | null; mission: string | null };
  departments: {
    id: string;
    name: string;
    code: string | null;
    parentDepartmentId: string | null;
    description: string | null;
    headcount: number;
    archived: boolean;
  }[];
  /** Tree View — the default the client specified. Company → departments → reporting tree. */
  tree: HierarchyNode;
  /** List View — the secondary view, flat, exactly the reference's seven columns. */
  list: {
    userId: string;
    displayName: string;
    employeeId: string;
    designation: string;
    departmentName: string;
    reportingManagerName: string | null;
    ubossUniqueId: string;
    accountState: string | null;
    employmentState: string;
    /** Their last day, when a notice period is running. Null for everybody else. */
    lastDayOn: string | null;
    /**
     * Masked, and **present only when the caller may see it** — somebody who can administer the
     * hierarchy, or the person themselves. Omitted rather than nulled, so a screen cannot render
     * a withheld value as "no identifier on record". The number itself does not exist in the
     * database to be returned.
     */
    aadhaarMasked?: string | null;
  }[];
  /** Empty-state honesty: this company has departments but nobody recorded yet. */
  employeeCount: number;
  /** Whether this caller was given the masked identifier fragments. Stated, not inferred. */
  identifiersVisible: boolean;
  /**
   * Whether this caller may change the structure.
   *
   * Sent so a screen can hide controls it knows will be refused, and named for what it is
   * rather than reusing `identifiersVisible` — the two happen to coincide today and mean
   * different things, and a UI keyed on the wrong one would drift the moment they diverge.
   * The server remains authoritative: hiding a control is a courtesy, never the enforcement.
   */
  mayAdminister: boolean;

  /**
   * Whether this person may edit the company's Vision and Mission.
   *
   * A **different** permission from `mayAdminister`: the structure is `hierarchy:Administer` and
   * the company's stated purpose is `settings:Administer`. They are held by different roles — a
   * Head administers their department's structure and does not speak for the company — so keying
   * the edit control on the structure permission would offer it to somebody the server then
   * refuses.
   *
   * The server remains authoritative either way; this only decides whether the control is worth
   * showing.
   */
  mayEditIdentity: boolean;
}

/**
 * The organization hierarchy: the tree, the list, and the moves that are allowed.
 *
 * ## Two structures, deliberately not one
 *
 * A department hierarchy and a reporting hierarchy are different things, and the client's
 * requirement says so directly: "reporting manager relationship separate from department
 * membership". A person can report to somebody in another department — matrix teams and dotted
 * lines are the norm, not the exception — so collapsing the two would misrepresent most real
 * organisations. The tree this service builds groups people under their **department** and then
 * nests them by their **reporting manager within that department**, with anybody whose manager
 * sits elsewhere shown at the department's root. That is the reference UI's own layout, and it is
 * the only arrangement that can display both facts at once without lying about either.
 *
 * ## Practical unlimited depth, with a stated bound
 *
 * The client asked for "practical unlimited levels". There is no depth column and no fixed
 * nesting; the bound is {@link MAX_REPORTING_DEPTH}, which exists so a malformed tree cannot
 * hang a request rather than to limit an organisation. No real company approaches it.
 *
 * ## Move validation is where the interesting failures are
 *
 * Changing somebody's reporting manager can: close a loop (refused, in the service *and* by a
 * database trigger), point at a person who is not employed here (refused by a composite foreign
 * key, so it cannot be reached even by a raw query), or point at somebody in another company
 * (the same foreign key — this is the tenant-isolation case, and it is the one worth having a
 * database guarantee for).
 */
/**
 * How much Vision or Mission a person may write, counted in words rather than markup.
 *
 * A thousand was the old column width, and it was a storage limit wearing a product limit's
 * clothes. This is the product limit: long enough for a real statement of purpose, short enough
 * that the panel on the Hierarchy screen stays a panel.
 */
/** The mark that makes a stored file readable as part of the company's identity -- PRD 2.3. */
const IDENTITY_IMAGE_PURPOSE = 'CompanyIdentityImage';

/** What a Vision or Mission picture may be. The three a browser draws without a plugin. */
const IDENTITY_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/** Two megabytes, the same ceiling a profile photo has. A larger one is a camera file. */
const MAX_IDENTITY_IMAGE_BYTES = 2 * 1024 * 1024;

const IDENTITY_TEXT_LIMIT = 1500;

@Injectable()
export class HierarchyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organization: OrganizationRepository,
    private readonly tenants: TenantRepository,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    /*
     * Optional, and the two methods that need it say so loudly if it is absent.
     *
     * Only the company-identity picture uses this. Making it required put `FileService` --
     * and its storage adapter and its malware scanner -- into the provider list of every test
     * that builds a module around `HierarchyService`, including two that have nothing to do with
     * files, and they failed to construct at all.
     *
     * The risk of `@Optional()` is that a real misconfiguration goes unnoticed, so it does not go
     * unnoticed: `global-guard-order.spec.ts` asserts that the real `AppModule` graph supplies
     * this, and the methods below refuse rather than quietly doing nothing.
     */
    @Optional() private readonly files?: FileService,
  ) {}

  /**
   * The whole hierarchy screen in one call: Vision, Mission, departments, tree and list.
   *
   * One call because the screen shows all of it at once and the client's layout puts the Vision
   * and Mission *above* the tree — two requests would let the strip render before the structure
   * it introduces.
   */
  async viewFor(scope: TenantScope, userId: string): Promise<HierarchyView> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'View' });

    // **The scoped part of "scoped visibility".**
    //
    // The org chart itself is company-wide: an employee seeing the structure of the company they
    // work for is normal, and the client's reference renders every department to every role that
    // has the screen. What must *not* be company-wide is the entered identifier — an ordinary
    // employee has no business reading a colleague's masked Aadhaar, even four digits of it.
    //
    // So the structure is visible to `hierarchy:View` and the identifier fragment only to
    // somebody who can administer the hierarchy, plus each person for themselves. Withholding
    // the field is done by omitting it rather than by blanking it, so a screen cannot render an
    // empty value as though the person had no identifier on record.
    // The company's stated purpose is company settings, not company structure — see the note on
    // `mayEditIdentity`. Resolved here so the screen and the endpoint agree about who may.
    const mayEditIdentity = await this.authorization.authorize(context, {
      module: 'settings',
      action: 'Administer',
    });

    const maySeeIdentifiers = (
      await this.authorization.authorize(context, {
        module: 'hierarchy',
        action: 'Administer',
      })
    ).allowed;

    const tenant = await this.tenants.findByIdForPlatform(scope.tenantId);
    if (!tenant) {
      throw new NotFoundException('No such company.');
    }

    const [departments, rows, leaving] = await Promise.all([
      this.organization.listDepartments(scope, true),
      this.organization.listHierarchy(scope),
      /*
       * Who is serving notice, and when their last day is.
       *
       * Read here rather than derived from the employment record, because a person serving notice
       * is still `Active` — that is the whole point of a notice period. The chart draws them
       * differently, and somebody looking at it should be able to see who is about to leave
       * without opening every card.
       */
      this.prisma.runInTenantTransaction(scope, () =>
        this.prisma.client.offboarding.findMany({
          where: { tenantId: scope.tenantId, state: 'Requested' },
          select: { subjectUserId: true, effectiveAt: true },
        }),
      ),
    ]);

    const lastDayOf = new Map(leaving.map((row) => [row.subjectUserId, row.effectiveAt]));

    const headcount = new Map<string, number>();
    for (const row of rows) {
      if (row.state === 'Active') {
        headcount.set(row.departmentId, (headcount.get(row.departmentId) ?? 0) + 1);
      }
    }

    return {
      company: { name: tenant.name, vision: tenant.vision, mission: tenant.mission },
      departments: departments.map((department) => ({
        id: department.id,
        name: department.name,
        code: department.code,
        parentDepartmentId: department.parentDepartmentId,
        description: department.description,
        headcount: headcount.get(department.id) ?? 0,
        archived: department.archivedAt !== null,
      })),
      tree: HierarchyService.buildTree(tenant.name, departments, rows),
      list: rows.map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        employeeId: row.employeeId,
        designation: row.designation,
        departmentName: row.departmentName,
        reportingManagerName: row.reportingManagerName,
        ubossUniqueId: row.ubossUniqueId,
        accountState: row.accountState,
        employmentState: row.state,
        /**
         * Their last day, when one has been set.
         *
         * Null for everybody else, which is the ordinary case. A date here means they are working
         * their notice: still employed, still doing the work, and leaving on the day named.
         */
        lastDayOn: lastDayOf.get(row.userId)?.toISOString() ?? null,
        ...(maySeeIdentifiers || row.userId === userId
          ? { aadhaarMasked: maskedAadhaar(row.aadhaarLastFour) }
          : {}),
      })),
      employeeCount: rows.length,
      identifiersVisible: maySeeIdentifiers,
      mayAdminister: maySeeIdentifiers,
      mayEditIdentity: mayEditIdentity.allowed,
    };
  }

  /**
   * Company → departments → people, nested by reporting manager within each department.
   *
   * Pure and static so it is testable without a database, which matters: the placement rule for
   * "manager is in another department" is the part a reader would get wrong.
   */
  static buildTree(
    companyName: string,
    departments: { id: string; name: string; sortOrder: number; archivedAt: Date | null }[],
    rows: HierarchyRow[],
  ): HierarchyNode {
    const live = departments.filter((department) => department.archivedAt === null);

    const departmentNodes = live.map((department) => {
      const members = rows.filter((row) => row.departmentId === department.id);
      const memberIds = new Set(members.map((row) => row.userId));

      const build = (row: HierarchyRow, depth: number): HierarchyNode => ({
        kind: 'person',
        id: row.userId,
        name: row.displayName,
        person: {
          userId: row.userId,
          ubossUniqueId: row.ubossUniqueId,
          employeeId: row.employeeId,
          designation: row.designation,
          departmentName: row.departmentName,
          reportingManagerName: row.reportingManagerName,
          employmentState: row.state,
          accountState: row.accountState,
        },
        children:
          depth >= MAX_REPORTING_DEPTH
            ? []
            : members
                .filter((candidate) => candidate.reportingManagerUserId === row.userId)
                .map((child) => build(child, depth + 1)),
      });

      // A department's roots are the people whose manager is not in this department — including
      // those with no manager at all. That is what puts somebody reporting across a department
      // boundary at the top of their own department rather than hiding them.
      const roots = members.filter(
        (row) => row.reportingManagerUserId === null || !memberIds.has(row.reportingManagerUserId),
      );

      return {
        kind: 'department' as const,
        id: department.id,
        name: department.name,
        headcount: members.filter((row) => row.state === 'Active').length,
        children: roots.map((row) => build(row, 0)),
      };
    });

    return {
      kind: 'company',
      id: 'company',
      name: companyName,
      children: departmentNodes,
    };
  }

  /**
   * Set the company's Vision and Mission.
   *
   * `settings:Administer`, because this is company identity rather than structure — the same
   * permission that governs every other company-identity field. It lives on this service
   * because the hierarchy is the screen that displays it, and the client's requirement is that
   * the structure and the purpose it serves are read together.
   */
  /**
   * A picture for the company Vision or Mission -- PRD 2.3.
   *
   * ## Why this is not the ordinary file upload
   *
   * It stores the image in the same place every other file goes, through the same scan and the
   * same quota, because a second way to store a file is a second place for all of that to be
   * forgotten. What differs is the mark it leaves: `purpose = 'CompanyIdentityImage'`.
   *
   * That mark is what lets the picture be *read* by everybody. A knowledge document needs
   * `settings:Export`; a picture inside the Mission has to be readable by anybody who can open
   * the Hierarchy, because that is who the Mission is written for. Without the mark, the route
   * that serves it would serve any file in the company by its id to anybody with `hierarchy:View`
   * -- which is a way to read the documents.
   *
   * Writing it needs `settings:Administer`: the same grant as editing the Vision and Mission,
   * because that is what this is a part of.
   */
  async uploadIdentityImage(input: {
    scope: TenantScope;
    actorUserId: string;
    filename: string;
    contentType: string;
    contentBase64: string;
  }): Promise<{ fileId: string; path: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (!IDENTITY_IMAGE_TYPES.includes(input.contentType)) {
      throw new BadRequestException(
        `A picture must be one of: ${IDENTITY_IMAGE_TYPES.join(', ')}.`,
      );
    }

    if (this.files === undefined) {
      throw new InternalServerErrorException(
        'Company pictures are not available: this deployment was built without the file store. ' +
          'OrganizationModule must import KnowledgeModule.',
      );
    }

    const bytes = Buffer.from(input.contentBase64, 'base64');
    // Checked on the decoded length, not the base64 string, which is a third larger.
    if (bytes.byteLength > MAX_IDENTITY_IMAGE_BYTES) {
      throw new BadRequestException(
        `A picture must be ${Math.round(MAX_IDENTITY_IMAGE_BYTES / 1024)} KB or smaller. ` +
          'Resize it and try again.',
      );
    }

    const stored = await this.files.uploadAuthorizedElsewhere({
      scope: input.scope,
      actorUserId: input.actorUserId,
      filename: input.filename,
      contentType: input.contentType,
      bytes,
      // Internal, not Public: this is drawn on a screen only members of the company can open, and
      // a classification is a statement about the data rather than about which screen shows it.
      classification: 'Internal',
    });

    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.storedFile.update({
        where: { id: stored.id },
        data: { purpose: IDENTITY_IMAGE_PURPOSE },
      }),
    );

    /*
     * A relative path, and it goes through `/api`.
     *
     * An absolute one bakes in whichever host it was written on and breaks the moment the same
     * row is read from another -- and these rows outlive deployments. `/api` is what the web app
     * proxies to this API in every environment, development and production alike.
     */
    return {
      fileId: stored.id,
      path: `/api/tenants/${input.scope.tenantId}/organization/company-images/${stored.id}`,
    };
  }

  /**
   * The bytes of one of those pictures, for anybody who may open the Hierarchy.
   *
   * Four things are checked, and each one is a way this could otherwise become a file-reading
   * hole: the file belongs to this company, it carries the identity-image mark, it has not been
   * deleted, and its scan has cleared. A picture that fails any of them is a 404 rather than a
   * refusal, because the caller has no business learning that the id exists.
   */
  async identityImageContent(input: {
    scope: TenantScope;
    actorUserId: string;
    fileId: string;
  }): Promise<{ bytes: Buffer; contentType: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'View' });

    if (this.files === undefined) {
      throw new InternalServerErrorException(
        'Company pictures are not available: this deployment was built without the file store. ' +
          'OrganizationModule must import KnowledgeModule.',
      );
    }

    const file = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.storedFile.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          id: input.fileId,
          purpose: IDENTITY_IMAGE_PURPOSE,
          deletedAt: null,
        },
        select: { contentType: true, scanState: true },
      }),
    );

    if (file === null) {
      throw new NotFoundException('That picture does not exist in this company.');
    }
    if (file.scanState !== 'Clean') {
      // Unscanned or infected. Nothing serves it, and the reason is not the caller's business.
      throw new NotFoundException('That picture is not available.');
    }

    const bytes = await this.files.readAuthorizedElsewhere({
      scope: input.scope,
      fileId: input.fileId,
    });
    return { bytes, contentType: file.contentType };
  }

  async updateCompanyIdentity(input: {
    scope: TenantScope;
    actorUserId: string;
    vision?: string | undefined;
    mission?: string | undefined;
  }): Promise<{ vision: string | null; mission: string | null }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.vision === undefined && input.mission === undefined) {
      throw new BadRequestException('Nothing to change: send a vision, a mission, or both.');
    }

    const tenant = await this.tenants.findByIdForPlatform(input.scope.tenantId);
    if (!tenant) {
      throw new NotFoundException('No such company.');
    }

    /*
     * Stripped before it is stored, and measured on the words.
     *
     * Both of these are drawn on the Hierarchy screen, which is the first screen every employee
     * of the company opens. Markup written by one person and rendered in another's browser is
     * the oldest hole there is, so nothing reaches the column until `sanitiseRichText` has taken
     * out everything that is not formatting.
     *
     * The length is then checked on the text with the tags removed. A Vision of forty words is
     * forty words whether it is plain or set in three faces; counting the markup would refuse
     * the formatting rather than the length, which is the feature the client asked for.
     */
    const clean = (value: string | undefined, field: 'Vision' | 'Mission'): string | null => {
      if (value === undefined) return null;
      const html = sanitiseRichText(value);
      if (html === null) return null;
      const words = plainTextOf(html).trim();
      if (words.length > IDENTITY_TEXT_LIMIT) {
        throw new BadRequestException(
          `The ${field} is ${words.length} characters of text, and the limit is ` +
            `${IDENTITY_TEXT_LIMIT}. Formatting does not count towards it.`,
        );
      }
      return html;
    };

    const vision = clean(input.vision, 'Vision');
    const mission = clean(input.mission, 'Mission');

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.prisma.client.tenant.update({
        where: { id: input.scope.tenantId },
        data: {
          ...(input.vision === undefined ? {} : { vision }),
          ...(input.mission === undefined ? {} : { mission }),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'company.identity_updated',
        resourceType: 'tenant',
        resourceId: input.scope.tenantId,
        resourceRef: tenant.code ?? tenant.slug,
        resourceVersion: tenant.version,
        actorUserId: input.actorUserId,
        summary: 'Updated the company Vision and/or Mission.',
        metadata: {
          visionChanged: input.vision !== undefined,
          missionChanged: input.mission !== undefined,
        },
      });
    });

    const updated = await this.tenants.findByIdForPlatform(input.scope.tenantId);
    return { vision: updated?.vision ?? null, mission: updated?.mission ?? null };
  }

  /**
   * Change somebody's reporting manager, or clear it.
   *
   * `hierarchy:Administer` — moving a person in the org chart changes what a `TeamSubtree`-scoped
   * manager can reach, so it is an authority-adjacent act and not an editing convenience.
   */
  async changeReportingManager(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    /** Null detaches the person, making them a root of their department. */
    newManagerUserId: string | null;
    reason?: string | undefined;
  }): Promise<void> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'Administer' });

    if (input.newManagerUserId === input.subjectUserId) {
      throw new BadRequestException('Somebody cannot report to themselves.');
    }

    const subject = await this.organization.findEmployment(input.scope, input.subjectUserId);
    if (!subject) {
      throw new NotFoundException('That person has no employment record in this company.');
    }

    if (input.newManagerUserId !== null) {
      const manager = await this.organization.findEmployment(input.scope, input.newManagerUserId);
      if (!manager) {
        // Also guaranteed by the composite foreign key. Checked here so the message names the
        // cause instead of surfacing a constraint violation.
        throw new BadRequestException(
          'A reporting manager must be employed by this company. Add them as an employee first.',
        );
      }
      if (manager.state !== 'Active') {
        throw new ConflictException(
          'That person’s employment has ended, so they cannot be somebody’s reporting manager. ' +
            'Move their reports first, then end their employment.',
        );
      }

      // Would this close a loop? Refused before the database has to. The trigger is the
      // guarantee; this is the explanation.
      const wouldCycle = await this.organization.isInReportingSubtree({
        tenantId: input.scope.tenantId,
        managerUserId: input.subjectUserId,
        subjectUserId: input.newManagerUserId,
      });

      if (wouldCycle) {
        await this.refuseCycle(input);
        throw new ConflictException(
          'That move would make the reporting line circular: the person you chose already ' +
            'reports, directly or indirectly, to the person being moved. Move the manager out ' +
            'from under them first.',
        );
      }
    }

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      const changed = await this.organization.updateEmployment(input.scope, input.subjectUserId, {
        reportingManagerUserId: input.newManagerUserId,
      });
      if (changed !== 1) {
        throw new ConflictException('That employment record changed while you were editing it.');
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'hierarchy.reporting_manager_changed',
        resourceType: 'employment_record',
        resourceId: subject.id,
        resourceRef: subject.employeeId,
        resourceVersion: subject.version,
        actorUserId: input.actorUserId,
        summary:
          input.newManagerUserId === null
            ? 'Detached from their reporting manager.'
            : 'Reporting manager changed.',
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        metadata: {
          from: subject.reportingManagerUserId,
          to: input.newManagerUserId,
          subjectUserId: input.subjectUserId,
        },
      });
    });
  }

  /**
   * Record a refused cycle in its own transaction.
   *
   * Its own because the caller throws immediately afterwards, and a refusal recorded inside the
   * transaction the throw aborts leaves no trace. That mistake has now been made twice in this
   * codebase — break-glass at Prompt 8 and the commercial self-decision at Prompt 11 — so it is
   * written this way from the start here.
   */
  private async refuseCycle(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    newManagerUserId: string | null;
  }): Promise<void> {
    try {
      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.securityEvents.recordWithinCurrentScope({
          action: SECURITY_ACTIONS.reportingCycleBlocked,
          tenantId: input.scope.tenantId,
          actorUserId: input.actorUserId,
          subjectUserId: input.subjectUserId,
          resourceType: 'employment_record',
          resourceId: input.subjectUserId,
          summary: 'Refused a reporting-manager change that would have closed a loop.',
          metadata: { proposedManagerUserId: input.newManagerUserId },
        }),
      );
    } catch {
      // The refusal must stand even if the trail write fails; turning a correct 409 into a 500
      // would report a control as a bug.
    }
  }
}
