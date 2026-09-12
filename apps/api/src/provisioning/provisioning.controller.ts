import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { OutboxRepository } from '../persistence/outbox.repository.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly, TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { CompanyProvisioningService } from './company-provisioning.service.js';
import { CompanySetupService } from './company-setup.service.js';
import { ProvisionCompanyDto, UpdateSetupTaskDto } from './provisioning.dto.js';

/**
 * Company provisioning — the platform side of the Create Company wizard.
 *
 * ## The only way a company comes into existence
 *
 * `@PlatformOnly` plus `create-company:Create`, which only `PlatformOwner` and `PlatformAdmin`
 * hold. There is no public endpoint, no self-service signup and no other route in the product
 * that inserts a `tenants` row. The client's rule is absolute, and it is enforced by there being
 * no alternative rather than by a check somewhere that could be bypassed.
 *
 * ## One POST for ten steps
 *
 * See `ProvisionCompanyDto`: the wizard submits once because provisioning is one transaction. A
 * step-by-step API would leave a half-provisioned company behind every time somebody closed the
 * tab at step 4, and such a company cannot be recovered through the product.
 */
@Controller('platform/provisioning')
@PlatformOnly()
export class ProvisioningController {
  constructor(
    private readonly provisioning: CompanyProvisioningService,
    private readonly outbox: OutboxRepository,
  ) {}

  /**
   * Provision a company and queue its administrator's activation invitation.
   *
   * Returns the company, the administrator's permanent UBoss Unique ID, and the ids of the
   * bootstrap role grant and the queued message — **never the activation token**. The token
   * exists exactly once, inside the transaction, and is deliberately dropped: a provisioning
   * response containing it would put a credential in a platform operator's browser history.
   */
  @Post('companies')
  @RequirePermission({ module: 'create-company', action: 'Create' })
  async provisionCompany(@Body() body: ProvisionCompanyDto): Promise<unknown> {
    const result = await this.provisioning.provision({
      legalName: body.legalName,
      displayName: body.displayName,
      code: body.code,
      countryRegion: body.countryRegion,
      timezone: body.timezone,
      currency: body.currency,
      logo: body.logo,
      admin: {
        name: body.admin.name,
        workEmail: body.admin.workEmail,
        title: body.admin.title,
        contactNumber: body.admin.contactNumber,
      },
      planCode: body.planCode,
      seats: body.seats,
      startDate: new Date(body.startDate),
      renewalDate: new Date(body.renewalDate),
      billingCycle: body.billingCycle,
      commercialAllowanceMinor: body.commercialAllowanceMinor,
      extraModules: body.extraModules,
      removedModules: body.removedModules,
      aiMode: body.aiMode,
      modelProfilePolicy: body.modelProfilePolicy,
      providerCredentialHint: body.providerCredentialHint,
      customProviderEndpoint: body.customProviderEndpoint,
      universalPackEnabled: body.universalPackEnabled,
      industryPacks: body.industryPacks,
      customSkillCapability: body.customSkillCapability,
      budget: {
        monthlyAllowanceMinor: body.budget.monthlyAllowanceMinor,
        warningPercent: body.budget.warningPercent,
        approvalThresholdMinor: body.budget.approvalThresholdMinor,
        hardStopMinor: body.budget.hardStopMinor,
        departmentAllocations: body.budget.departmentAllocations,
      },
      security: {
        primaryDomain: body.security.primaryDomain,
        requireMfa: body.security.requireMfa,
        requireSso: body.security.requireSso,
        guestExpiryDays: body.security.guestExpiryDays,
        supportAccessAllowed: body.security.supportAccessAllowed,
        supportAccessRequiresCustomerApproval: body.security.supportAccessRequiresCustomerApproval,
      },
      actorUserId: this.currentUserId(),
      idempotencyKey: body.idempotencyKey,
    });

    return {
      tenantId: result.tenant.id,
      slug: result.tenant.slug,
      code: result.tenant.code,
      name: result.tenant.name,
      lifecycleState: result.tenant.lifecycleState,
      admin: {
        userId: result.adminUserId,
        ubossUniqueId: result.adminUbossUniqueId,
        // Stated explicitly in the response so a client cannot look for a token that is not
        // there and conclude something went wrong.
        activation: 'An activation invitation was queued. No password was created.',
      },
      bootstrapRoleAssignmentId: result.bootstrapRoleAssignmentId,
      outboxMessageId: result.outboxMessageId,
      setupTaskCount: result.setupTaskCount,
      replayed: result.replayed,
    };
  }

  /**
   * The outbox, for the Master Console to show.
   *
   * Worth exposing rather than hiding: **no dispatcher runs yet** (email is Prompt 28), so
   * activation invitations accumulate as `Pending`. A platform operator who provisioned a
   * company needs to be able to see that the invitation is queued and undelivered, rather than
   * assuming it was sent and wondering why the customer never activated.
   */
  @Get('outbox')
  @RequirePermission({ module: 'support', action: 'View' })
  async listOutbox(@Query('state') state?: string): Promise<unknown> {
    const [messages, counts] = await Promise.all([
      this.outbox.listForPlatform({
        state: state as never,
        take: 100,
      }),
      this.outbox.countsByState(),
    ]);

    return {
      counts,
      messages: messages.map((message) => ({
        id: message.id,
        topic: message.topic,
        tenantId: message.tenantId,
        state: message.state,
        attempts: message.attempts,
        lastError: message.lastError,
        availableAt: message.availableAt,
        deliveredAt: message.deliveredAt,
        createdAt: message.createdAt,
        // The payload is returned because it carries no secret by construction — an activation
        // payload holds the invitation's id, never its token.
        payload: message.payload,
      })),
      dispatcher: {
        running: false,
        note:
          'No dispatcher is implemented yet — email delivery is the notifications module. ' +
          'Messages accumulate as Pending, which is the honest state rather than a claim that ' +
          'mail is being sent.',
      },
    };
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException(
        'Provisioning a company must be attributed to a named platform actor.',
      );
    }
    return userId;
  }
}

/**
 * The company-side first-login setup checklist.
 *
 * `@TenantScoped`, not `@PlatformOnly` — this is the new administrator's own screen, and the
 * whole point is that they can complete their workspace setup without the platform doing it for
 * them.
 */
@Controller('tenants/:tenantId/setup')
@TenantScoped()
export class CompanySetupController {
  constructor(
    private readonly setup: CompanySetupService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The checklist and the next recommended action.
   *
   * `settings:View`, which every company role holds. The client's requirement is that a new
   * administrator does not land on an empty dashboard; gating this behind `Administer` would
   * mean the one person who needs it is the only one who can see it.
   */
  @Get('checklist')
  @RequirePermission({ module: 'settings', action: 'View' })
  async checklist(): Promise<unknown> {
    return this.setup.checklistFor(this.tenantContext.requireScope(), this.currentUserId());
  }

  @Put('checklist/:key')
  @RequirePermission({ module: 'settings', action: 'EditDraft' })
  async updateTask(@Param('key') key: string, @Body() body: UpdateSetupTaskDto): Promise<unknown> {
    return this.setup.updateTask({
      scope: this.tenantContext.requireScope(),
      userId: this.currentUserId(),
      key,
      state: body.state,
      skipReason: body.skipReason,
    });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('The setup checklist requires an identified user.');
    }
    return userId;
  }
}
