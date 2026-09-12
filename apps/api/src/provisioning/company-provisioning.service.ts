import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';

import { COMPANY_MODULES } from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { InvitationService } from '../auth/invitation.service.js';
import type {
  CompanyAiMode,
  Prisma,
  Tenant,
  TenantSubscription,
} from '../generated/prisma/client.js';
import { PlatformRepository } from '../persistence/platform.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TenantRepository } from '../persistence/tenant.repository.js';
import { TenantMembershipRepository } from '../persistence/tenant-membership.repository.js';
import { UserRepository } from '../persistence/user.repository.js';
import { generateUbossUniqueId } from '../persistence/uboss-unique-id.js';
import { OUTBOX_TOPICS, OutboxRepository } from '../persistence/outbox.repository.js';
import { COMPANY_SETUP_TASKS } from './company-setup-tasks.js';

/** Everything the wizard collects, as one payload. */
export interface ProvisionCompanyInput {
  // ---- Step 1: company identity ----
  legalName: string;
  displayName: string;
  code: string;
  countryRegion: string;
  timezone: string;
  currency: string;
  logo?: { fileName: string; mimeType: string; sizeBytes: number; storageKey: string } | undefined;

  // ---- Step 2: initial Company Super Admin ----
  admin: {
    name: string;
    workEmail: string;
    title?: string | undefined;
    contactNumber?: string | undefined;
  };

  // ---- Step 3: commercial plan ----
  planCode: string;
  seats: number;
  startDate: Date;
  renewalDate: Date;
  billingCycle: TenantSubscription['billingCycle'];
  commercialAllowanceMinor: number;

  // ---- Step 4: modules / entitlements ----
  /** Layered over the plan's own modules. Entitlement, **not** authorization — see the class doc. */
  extraModules?: readonly string[] | undefined;
  removedModules?: readonly string[] | undefined;

  // ---- Step 5: AI mode ----
  aiMode: CompanyAiMode;
  /** Logical model profiles and fallback order. A policy placeholder; see `TenantAiSettings`. */
  modelProfilePolicy?: Record<string, unknown> | undefined;
  /** A masked hint only, e.g. `sk-…4f2a`. **Never** a credential — see the class doc. */
  providerCredentialHint?: string | undefined;
  customProviderEndpoint?: string | undefined;

  // ---- Step 6: skill packs ----
  universalPackEnabled?: boolean | undefined;
  industryPacks?: readonly string[] | undefined;
  customSkillCapability?: boolean | undefined;

  // ---- Step 7: AI budget policy ----
  budget: {
    monthlyAllowanceMinor: number;
    warningPercent: number;
    approvalThresholdMinor: number;
    hardStopMinor: number;
    departmentAllocations?: Record<string, number> | undefined;
  };

  // ---- Step 8: security defaults ----
  security: {
    primaryDomain?: string | undefined;
    requireMfa: boolean;
    requireSso: boolean;
    guestExpiryDays: number;
    supportAccessAllowed: boolean;
    supportAccessRequiresCustomerApproval: boolean;
  };

  /** The platform actor performing the provisioning. Never taken from a request body. */
  actorUserId: string;
  /** Retry safety: the same key provisions once. See `provision`. */
  idempotencyKey: string;
}

export interface ProvisionCompanyResult {
  tenant: Tenant;
  adminUserId: string;
  adminUbossUniqueId: string;
  /** The invitation id. The **token is never returned** — see the class doc. */
  invitationId: string;
  outboxMessageId: string;
  bootstrapRoleAssignmentId: string;
  setupTaskCount: number;
  /** True when this call reused an earlier provisioning with the same idempotency key. */
  replayed: boolean;
}

/**
 * Company provisioning — the whole of the client's ten-step wizard, in one transaction.
 *
 * ## What "no public signup" means in code
 *
 * There is exactly one path into existence for a company, and it is this service called from a
 * `@PlatformOnly` route by a platform actor holding `create-company:Create`. There is no
 * self-service endpoint, no invite-a-company link, and nothing in the product that creates a
 * `tenants` row outside provisioning and the seed. That is the client's locked rule, and it is
 * enforced by the absence of an alternative rather than by a check.
 *
 * ## One transaction, and why that is not optional
 *
 * The tenant, its subscription, its AI settings, its budget policy, its security defaults, the
 * first administrator's identity and membership, the **bootstrap role grant** and the activation
 * invitation all commit together or not at all. A partial provisioning is the worst outcome
 * available here: a company that exists with no administrator cannot be recovered through the
 * product, and an administrator invited into a company with no plan would hit an entitlement
 * wall on their first click.
 *
 * ## The bootstrap authority rule
 *
 * The client is explicit: *do not require an already-existing Company Admin to grant the first
 * Company Admin role*. So provisioning grants it, and that grant is the one place in the product
 * where authority is created with no human grantor. Three things make it accountable rather than
 * a back door:
 *
 *   1. `RoleAssignment.bootstrap` is `true` and `grantedByUserId` is `null`, tied together by
 *      two check constraints so the flag and the absence cannot disagree.
 *   2. It writes a distinct `company.bootstrap_admin_granted` audit event into the **new
 *      company's own trail**, plus a `Critical` security event on the platform plane.
 *   3. It grants exactly `CompanyAdmin` at `WholeCompany` and nothing else. Provisioning cannot
 *      be used to mint an arbitrary role.
 *
 * ## Never a password, and never a token in the outbox
 *
 * The administrator receives a secure **activation invitation** — the Prompt 5 flow, a one-time
 * hashed token. No password is generated, displayed, emailed or stored, and this service never
 * returns the token to its caller. The outbox row carries the invitation's **id**; the dispatcher
 * reads the token through the service that owns it. An outbox row is long-lived working state,
 * and a token sitting in one would be a credential at rest in a queue.
 *
 * ## Entitlements are not authorization
 *
 * Step 4 decides which modules the company has *bought*. It says nothing about who inside the
 * company may use them — that is the Prompt 7 engine, and the two are deliberately separate
 * tables with separate APIs. A module the company is not entitled to is invisible to everyone;
 * a module it is entitled to is still governed by role, scope and allowed actions.
 */
@Injectable()
export class CompanyProvisioningService {
  private readonly logger = new Logger(CompanyProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantRepository,
    private readonly users: UserRepository,
    private readonly memberships: TenantMembershipRepository,
    private readonly platform: PlatformRepository,
    private readonly invitations: InvitationService,
    private readonly outbox: OutboxRepository,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * Provision a company.
   *
   * ## Idempotency
   *
   * A wizard's final "Provision" button is exactly the button somebody double-clicks, and a
   * provisioning that runs twice creates two companies and two invitations. The caller supplies
   * an `idempotencyKey`, and the **outbox's unique constraint on it** is what makes the retry
   * safe: the second attempt's insert collides, the transaction rolls back, and this method
   * returns the first result instead. The uniqueness lives on the outbox rather than in a
   * separate table because the outbox row is already written in the same transaction, so there
   * is nothing extra to keep in step.
   */
  async provision(input: ProvisionCompanyInput): Promise<ProvisionCompanyResult> {
    this.validate(input);

    // Check for a replay before opening the transaction, so the common case of an honest retry
    // gets a clean answer rather than a constraint violation in the log.
    const existing = await this.outbox.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      const replayed = existing.payload as {
        tenantId?: string;
        adminUserId?: string;
        invitationId?: string;
      };
      const tenant = replayed.tenantId
        ? await this.prisma.runAsPlatformOperation(() =>
            this.tenants.findByIdForPlatform(replayed.tenantId as string),
          )
        : null;

      if (tenant) {
        this.logger.warn(
          `Provisioning replay for idempotency key ${input.idempotencyKey}; returning the ` +
            `company created the first time (${tenant.slug}).`,
        );
        return {
          tenant,
          adminUserId: replayed.adminUserId ?? '',
          adminUbossUniqueId: '',
          invitationId: replayed.invitationId ?? '',
          outboxMessageId: existing.id,
          bootstrapRoleAssignmentId: '',
          setupTaskCount: COMPANY_SETUP_TASKS.length,
          replayed: true,
        };
      }
    }

    const plan = await this.platform.findPlanByCode(input.planCode);
    if (!plan) {
      throw new BadRequestException(`No plan with the code "${input.planCode}".`);
    }
    if (!plan.active) {
      throw new BadRequestException(
        `"${plan.name}" is retired and cannot be assigned to a new company.`,
      );
    }

    const slug = CompanyProvisioningService.slugFor(input.displayName, input.code);

    return this.prisma.runAsPlatformOperation(async () => {
      const slugClash = await this.tenants.findBySlugForPlatform(slug);
      if (slugClash) {
        throw new ConflictException(
          `A company already uses the workspace key "${slug}". Choose a different company code ` +
            'or display name.',
        );
      }

      // ---- Step 1: the company ----
      const tenant = await this.prisma.client.tenant.create({
        data: {
          slug,
          name: input.displayName,
          legalName: input.legalName,
          code: input.code,
          countryRegion: input.countryRegion,
          timezone: input.timezone,
          currency: input.currency,
          // The client's own state name for a provisioned-but-not-activated company.
          lifecycleState: 'Provisioning',
          ...(input.logo
            ? {
                logoFileName: input.logo.fileName,
                logoMimeType: input.logo.mimeType,
                logoSizeBytes: input.logo.sizeBytes,
                logoStorageKey: input.logo.storageKey,
              }
            : {}),
        },
      });

      // ---- Step 2: the initial Company Super Admin ----
      //
      // An existing person is reused rather than duplicated: one permanent UBoss Unique ID
      // follows somebody across every UBoss-participating company, so an administrator who
      // already exists elsewhere keeps their identity. This is the same rule Prompt 12's
      // person-match flow formalises.
      const existingPerson = await this.users.findByEmailForPlatform(input.admin.workEmail);
      const adminUser =
        existingPerson ??
        (await this.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email: input.admin.workEmail,
          displayName: input.admin.name,
        }));

      const membership = await this.prisma.client.tenantMembership.create({
        data: {
          tenantId: tenant.id,
          userId: adminUser.id,
          userType: 'InternalUser',
          // `NotInvited` is the default; the invitation below moves it to `InvitePending`.
        },
      });

      // ---- Step 3: the commercial plan ----
      // Created for its effect rather than its value: nothing downstream in this transaction
      // needs the row back, and the company's commercial position is read through the Master
      // Console's own aggregate afterwards.
      await this.prisma.client.tenantSubscription.create({
        data: {
          tenant: { connect: { id: tenant.id } },
          plan: { connect: { id: plan.id } },
          // `Pending` until the administrator activates. An `Active` subscription on a company
          // nobody has signed into yet would make every "active companies" figure wrong.
          state: 'Pending',
          billingState: 'Current',
          billingCycle: input.billingCycle,
          seatsLicensed: input.seats,
          startedAt: input.startDate,
          renewsAt: input.renewalDate,
          aiAllowanceMinor: input.commercialAllowanceMinor,
          aiConsumedMinor: 0,
          currency: input.currency,
          // ---- Step 4: modules / entitlements ----
          extraModules: [...(input.extraModules ?? [])],
          removedModules: [...(input.removedModules ?? [])],
          notes: `Provisioned through the Master Console wizard.`,
        },
      });

      // ---- Steps 5 and 6: AI mode and skill packs ----
      await this.prisma.client.tenantAiSettings.create({
        data: {
          tenant: { connect: { id: tenant.id } },
          mode: input.aiMode,
          ...(input.modelProfilePolicy === undefined
            ? {}
            : { modelProfilePolicy: input.modelProfilePolicy as Prisma.InputJsonValue }),
          // A hint, never a key. The BYOK credential itself is stored through the Prompt 6
          // secret box by a separate, explicitly-authorised call — provisioning does not accept
          // one, so a wizard payload can never carry a provider key.
          providerCredentialHint: input.providerCredentialHint ?? null,
          customProviderEndpoint: input.customProviderEndpoint ?? null,
          universalPackEnabled: input.universalPackEnabled ?? true,
          industryPacks: [...(input.industryPacks ?? [])],
          customSkillCapability: input.customSkillCapability ?? false,
          updatedByUserId: input.actorUserId,
        },
      });

      // ---- Step 7: AI budget policy ----
      await this.prisma.client.tenantAiBudgetPolicy.create({
        data: {
          tenant: { connect: { id: tenant.id } },
          monthlyAllowanceMinor: input.budget.monthlyAllowanceMinor,
          warningPercent: input.budget.warningPercent,
          approvalThresholdMinor: input.budget.approvalThresholdMinor,
          hardStopMinor: input.budget.hardStopMinor,
          ...(input.budget.departmentAllocations === undefined
            ? {}
            : {
                departmentAllocations: input.budget.departmentAllocations as Prisma.InputJsonValue,
              }),
          updatedByUserId: input.actorUserId,
        },
      });

      // ---- Step 8: security defaults ----
      await this.prisma.client.tenantAuthPolicy.create({
        data: {
          tenant: { connect: { id: tenant.id } },
          requireMfa: input.security.requireMfa,
          requireSso: input.security.requireSso,
          // Password sign-in stays available unless SSO is required, or the first administrator
          // could not activate at all — an SSO-required company with no connection configured
          // yet is a company nobody can enter.
          allowPasswordSignIn: !input.security.requireSso,
          guestExpiryDays: input.security.guestExpiryDays,
          supportAccessAllowed: input.security.supportAccessAllowed,
          supportAccessRequiresCustomerApproval:
            input.security.supportAccessRequiresCustomerApproval,
          updatedByUserId: input.actorUserId,
        },
      });

      if (input.security.primaryDomain) {
        // Claimed, **not** verified. The Prompt 6 rule stands: a domain grants nothing until its
        // DNS record is checked, and provisioning cannot check DNS inside a transaction.
        await this.prisma.client.domainVerification.create({
          data: {
            tenant: { connect: { id: tenant.id } },
            domain: input.security.primaryDomain.toLowerCase(),
            verificationToken: `uboss-verify-${crypto.randomUUID()}`,
            state: 'Pending',
            // A claim expires if nobody publishes the DNS record, so an abandoned claim does not
            // sit unverified forever holding a domain nobody can re-claim. 14 days matches the
            // Prompt 6 domain-verification window.
            expiresAt: new Date(Date.now() + 14 * 86_400_000),
          },
        });
      }

      // ---- The bootstrap authority grant ----
      const bootstrapRole = await this.prisma.client.roleAssignment.create({
        data: {
          tenantId: tenant.id,
          userId: adminUser.id,
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
          departmentIds: [],
          selectedResourceIds: [],
          // No human grantor: this is the one grant in the product created by provisioning
          // itself, because requiring an existing Company Admin to grant the first one is
          // impossible. Both fields are tied together by check constraints.
          grantedByUserId: null,
          bootstrap: true,
          justification:
            'Initial Company Super Admin, granted by company provisioning. There is no prior ' +
            'Company Admin who could grant it. Review at the first access review.',
        },
      });

      // ---- A starting department (Prompt 12) ----
      //
      // Every one of the six mandatory Add Employee fields must be satisfiable on the day a
      // company is provisioned, and Department is one of them. A company with no department
      // cannot use the Add Employee screen at all, so the second setup-checklist item
      // (`hierarchy`) would be a dead end.
      //
      // Named `General` and described as a starting point, matching what the Prompt 12 migration
      // gave existing companies — so a new company and a backfilled one are in the same state.
      await this.prisma.client.department.create({
        data: {
          tenantId: tenant.id,
          name: 'General',
          code: 'GEN',
          description:
            'A starting department so people can be added on day one. Rename it or build your ' +
            'own structure from the Hierarchy screen.',
        },
      });

      // ---- The setup checklist ----
      await this.prisma.client.companySetupTask.createMany({
        data: COMPANY_SETUP_TASKS.map((task) => ({
          tenantId: tenant.id,
          key: task.key,
          position: task.position,
          title: task.title,
          rationale: task.rationale,
          targetRoute: task.targetRoute,
        })),
      });

      // ---- Step 10: the secure activation invitation ----
      //
      // Issued through the Prompt 5 service so there is one invitation flow rather than a second
      // one for provisioning. It hashes the token and returns the plaintext exactly once, which
      // is why the token goes nowhere near the outbox payload or this method's return value.
      // The Prompt 5 `invite` flow, unchanged: it reuses the person if they already exist,
      // requires the membership provisioning just created, moves the account to
      // `InvitePending`, hashes the token and returns the plaintext exactly once. That token is
      // then deliberately dropped on the floor here — it goes into neither the outbox payload
      // nor this method's return value.
      //
      // Reusing it rather than writing a provisioning-specific issuer matters: two invitation
      // paths would be two places for the "never a plaintext password" rule to be got right.
      const invitation = await this.invitations.invite({
        tenantId: tenant.id,
        email: input.admin.workEmail,
        displayName: input.admin.name,
        invitedByUserId: input.actorUserId,
      });

      // The outbox row: written in this transaction, delivered afterwards.
      const outboxMessage = await this.outbox.enqueue({
        topic: OUTBOX_TOPICS.companyActivationInvitation,
        tenantId: tenant.id,
        idempotencyKey: input.idempotencyKey,
        payload: {
          tenantId: tenant.id,
          companyName: tenant.name,
          adminUserId: adminUser.id,
          adminEmail: input.admin.workEmail,
          adminName: input.admin.name,
          // The invitation's **id**, never its token. The dispatcher reads the token through the
          // service that owns it.
          invitationId: invitation.invitationId,
        },
      });

      // ---- The audit trail ----
      //
      // Into the **new company's own trail**, so the customer can see how their workspace came
      // to exist and on what terms. `…OrThrow` because a company provisioned with no record of
      // its own provisioning is not something to shrug at.
      await this.auditEvents.appendWithinCurrentScope(tenant.id, {
        action: 'company.provisioned',
        resourceType: 'tenant',
        resourceId: tenant.id,
        resourceRef: tenant.code ?? tenant.slug,
        actorUserId: input.actorUserId,
        summary: `${tenant.name} provisioned on the ${plan.name} plan with ${input.seats} seat(s).`,
        reason: 'Company provisioning through the Master Console. There is no public signup.',
        metadata: {
          planCode: plan.code,
          seats: input.seats,
          billingCycle: input.billingCycle,
          aiMode: input.aiMode,
          countryRegion: input.countryRegion,
          currency: input.currency,
          requireMfa: input.security.requireMfa,
          requireSso: input.security.requireSso,
          industryPacks: (input.industryPacks ?? []).join(','),
          setupTasks: COMPANY_SETUP_TASKS.length,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(tenant.id, {
        action: 'company.bootstrap_admin_granted',
        resourceType: 'role_assignment',
        resourceId: bootstrapRole.id,
        actorUserId: input.actorUserId,
        summary: `${adminUser.displayName} became the initial Company Super Admin.`,
        reason:
          'Granted by provisioning, with no prior Company Admin to grant it. This is the one ' +
          'authority in the product created without a human grantor.',
        metadata: {
          subjectUserId: adminUser.id,
          ubossUniqueId: adminUser.ubossUniqueId,
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
          bootstrap: true,
          reusedExistingPerson: existingPerson !== null,
          membershipId: membership.id,
        },
      });

      await this.securityEvents.recordWithinCurrentScope({
        action: SECURITY_ACTIONS.companyBootstrapAdminGranted,
        tenantId: tenant.id,
        actorUserId: input.actorUserId,
        resourceType: 'role_assignment',
        resourceId: bootstrapRole.id,
        summary: `Bootstrap Company Admin granted for ${tenant.name}.`,
        metadata: { subjectUserId: adminUser.id, bootstrap: true },
      });

      this.logger.log(
        `Provisioned ${tenant.name} (${tenant.slug}) on ${plan.code}; ` +
          `bootstrap admin ${adminUser.ubossUniqueId}; invitation queued.`,
      );

      return {
        tenant,
        adminUserId: adminUser.id,
        adminUbossUniqueId: adminUser.ubossUniqueId,
        invitationId: invitation.invitationId,
        outboxMessageId: outboxMessage.id,
        bootstrapRoleAssignmentId: bootstrapRole.id,
        setupTaskCount: COMPANY_SETUP_TASKS.length,
        replayed: false,
      };
    });
  }

  /**
   * Validate the whole payload before opening a transaction.
   *
   * Deliberately not left to the DTO alone: the DTO validates each field's shape, and these are
   * the *cross-field* rules a DTO cannot express — the renewal after the start, the budget
   * thresholds in order, the entitlement lists naming real company modules.
   */
  private validate(input: ProvisionCompanyInput): void {
    if (input.renewalDate.getTime() <= input.startDate.getTime()) {
      throw new BadRequestException(
        'The renewal date must be after the start date. A term that ends before it begins is ' +
          'not a term.',
      );
    }
    if (input.seats < 1) {
      throw new BadRequestException('A company needs at least one seat — its first administrator.');
    }
    if (input.budget.approvalThresholdMinor > input.budget.hardStopMinor) {
      throw new BadRequestException(
        'The approval threshold cannot be above the hard stop: the approval step would be ' +
          'unreachable, because the run would already be blocked. Guardrails go warn → approve ' +
          '→ stop.',
      );
    }
    if (input.budget.warningPercent < 1 || input.budget.warningPercent > 100) {
      throw new BadRequestException('The warning threshold is a percentage: 1 to 100.');
    }

    const modules = new Set<string>(COMPANY_MODULES);
    for (const [label, list] of [
      ['extraModules', input.extraModules ?? []],
      ['removedModules', input.removedModules ?? []],
    ] as const) {
      const invalid = list.filter((module) => !modules.has(module));
      if (invalid.length > 0) {
        throw new BadRequestException(
          `${label} names non-company modules: ${invalid.join(', ')}. A company is entitled to ` +
            'company modules only; the platform control plane is not sellable.',
        );
      }
    }

    if (input.aiMode === 'CustomEnterpriseProvider' && !input.customProviderEndpoint) {
      throw new BadRequestException(
        'A Custom Enterprise Provider needs its endpoint. Without one the company has an AI ' +
          'mode that cannot reach a model.',
      );
    }
  }

  /**
   * Derive the URL-safe workspace key.
   *
   * The slug is a technical key and the code is human-facing, so they are derived separately —
   * see the `Tenant.code` comment. The code is preferred as the slug source because it is
   * already short and stable; the display name is the fallback for a code that lowercases into
   * something unusable.
   */
  static slugFor(displayName: string, code: string): string {
    const fromCode = code
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (fromCode.length >= 3) {
      return fromCode.slice(0, 60);
    }
    return (
      displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'company'
    );
  }
}
