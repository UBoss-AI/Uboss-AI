import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { notificationDedupeKey } from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { InvitationService } from '../auth/invitation.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { SeatService } from '../commercial/seat.service.js';
import { AccessRepository } from '../persistence/access.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { generateUbossUniqueId } from '../persistence/uboss-unique-id.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { activationReadiness } from './activation-readiness.js';
import { MAX_GUEST_DAYS } from './user-access.service.js';

/** A synthesised address for somebody in the org chart with no work email yet. */
const PLACEHOLDER_EMAIL_DOMAIN = '@person.uboss.invalid';

export interface InvitationOutcome {
  userId: string;
  ubossUniqueId: string;
  /** True when an existing invitation was rotated rather than a new one created. */
  resent: boolean;
  /** The seat position after the invitation. An invitation consumes one under the default rule. */
  seats: { used: number; ceiling: number | null; available: number | null };
  /**
   * Deliberately absent: the activation token. It exists exactly once, inside the invitation
   * service, and is never returned to a caller or written to a payload — the Prompt 10 rule,
   * unchanged.
   */
  tokenReturned: false;
}

/**
 * Inviting, resending and cancelling, on top of the Prompt 5 invitation flow.
 *
 * ## Two things this adds that Prompt 5 could not
 *
 * **1. Inviting somebody who is already in the hierarchy.** The client's rule: *if employee
 * already exists in hierarchy, invitation links to same stable user identity; no duplicate.*
 * Prompt 5's `invite()` is keyed on **email**, and Prompt 12 creates people with a synthesised
 * `…@person.uboss.invalid` address because somebody in the org chart may have no work address
 * yet. Inviting them by email would therefore create a **second** UBoss identity for the same
 * human — the exact duplication the rule forbids. `inviteExistingPerson` is keyed on the
 * **userId** and sets their real address on the way through, which is the only shape that cannot
 * duplicate.
 *
 * **2. A seat claim.** Inviting moves a membership to `InvitePending`, which the default counting
 * rule counts — so this is the path that actually consumes a seat. It goes through
 * `SeatService.claimSeat` under the per-tenant advisory lock (ADR-060), closing the gap Prompt 11
 * recorded as limitation 5g: the enforcement existed and the path that needed it did not call it.
 *
 * ## And one thing it refuses to do
 *
 * Send an invitation to somebody who could not use it. The client's rule is that a new internal
 * employee needs a department, a manager and a role **before activation**; sending the email
 * first and discovering that at the click is a worse experience than being told now.
 */
@Injectable()
export class InvitationAccessService {
  private readonly logger = new Logger(InvitationAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessRepository,
    private readonly invitations: InvitationService,
    private readonly seats: SeatService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Invite somebody who already exists in this company's hierarchy.
   *
   * Keyed on `userId`, so one human keeps one UBoss Unique ID however many companies employ them
   * and whatever address each holds for them.
   */
  async inviteExistingPerson(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    /** Their real work address, when the placeholder is still in place. */
    workEmail?: string | undefined;
  }): Promise<InvitationOutcome> {
    await this.assertMayManageAccess(input.scope, input.actorUserId);

    const rows = await this.access.roster(input.scope);
    const person = rows.find((row) => row.userId === input.subjectUserId);
    if (!person) {
      throw new NotFoundException(
        'That person is not a member of this company. Add them to the hierarchy first — an ' +
          'invitation cannot create a membership, and there is no public signup.',
      );
    }

    if (person.accountState === 'Active') {
      throw new ConflictException('That person has already activated their account.');
    }
    if (person.accountState === 'Offboarded') {
      throw new ConflictException(
        'That person was offboarded. Reinstate them before inviting them again, so the ' +
          'decision to bring somebody back is explicit.',
      );
    }

    // The readiness gate, before the email rather than after the click.
    const hasRoot = await this.access.hasReportingRoot(input.scope);
    const readiness = activationReadiness({
      userType: person.userType as never,
      accountState: person.accountState as never,
      employment:
        person.employmentState === null
          ? null
          : {
              departmentId: person.departmentId,
              reportingManagerUserId: person.reportingManagerUserId,
            },
      roleCount: person.roleCount,
      companyHasReportingRoot: hasRoot,
    });

    if (!readiness.ready) {
      throw new BadRequestException(
        `${readiness.summary} Set those up first — an invitation sent now would activate an ` +
          'account that can sign in and reach nothing.',
      );
    }

    const placeholder = person.email.endsWith(PLACEHOLDER_EMAIL_DOMAIN);
    const email = input.workEmail?.trim().toLowerCase() ?? '';

    if (placeholder && email === '') {
      throw new BadRequestException(
        'This person has no work email address on record, so there is nowhere to send the ' +
          'invitation. Supply one — it becomes their sign-in address.',
      );
    }

    // Claim the seat and set the real address in one transaction, before the invitation is
    // issued. A seat claimed for an invitation that then failed would reserve capacity for
    // nothing.
    const seats = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const claimed = await this.seats.claimSeat({
        tenantId: input.scope.tenantId,
        targetState: 'InvitePending',
        // They already occupy a counted seat if the rule counts their current state.
        alreadyCounted: (await this.seats.positionFor(input.scope)).countedStates.includes(
          person.accountState as never,
        ),
      });

      if (placeholder || (email !== '' && email !== person.email)) {
        await this.prisma.client.user.update({
          where: { id: input.subjectUserId },
          data: { email, version: { increment: 1 } },
        });
      }

      return claimed;
    });

    const issued = await this.invitations.invite({
      tenantId: input.scope.tenantId,
      email: email === '' ? person.email : email,
      displayName: person.displayName,
      invitedByUserId: input.actorUserId,
    });

    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: issued.resent ? 'access.invitation_resent' : 'access.invitation_sent',
        resourceType: 'invitation',
        resourceId: issued.invitationId,
        actorUserId: input.actorUserId,
        summary: issued.resent
          ? 'Resent the activation invitation.'
          : 'Sent the activation invitation.',
        metadata: {
          subjectUserId: input.subjectUserId,
          // The identity was reused, not created. The client's no-duplicate rule, on the record.
          linkedExistingIdentity: true,
          seatsUsed: seats.used,
        },
      }),
    );

    /*
     * Tell the person they were invited.
     *
     * Its own transaction, deliberately **after** the invitation has committed, and its failure
     * swallowed. Raising it inside would look tidier, but the invitation is the deliverable: a
     * notification failure must never turn a successfully sent invitation into a 500 that leaves
     * the caller believing nothing happened. This is the Prompt 8 break-glass lesson and the
     * Prompt 11 self-decision lesson — both were a correct outcome turned into a server error by
     * a secondary write.
     */
    try {
      await this.notifications.raise({
        tenantId: input.scope.tenantId,
        recipientUserId: input.subjectUserId,
        kind: 'Invitation',
        severity: 'Info',
        title: issued.resent ? 'Your invitation was resent' : 'You have been invited',
        body:
          'Activate your account to reach this workspace. The activation link was emailed to ' +
          'you; it is single-use and it expires.',
        deepLink: '/login',
        resourceType: 'invitation',
        resourceId: issued.invitationId,
        // Assigned to them: activating is theirs to do, not something they are being told about.
        isAssignedToRecipient: true,
        // A resend is a **new** notification, so the key differs. The original dedupe key would
        // suppress it, and "we resent your invitation" with no notification is why somebody
        // calls support.
        dedupeKey: issued.resent
          ? `${notificationDedupeKey.invitationSent(issued.invitationId)}:resent`
          : notificationDedupeKey.invitationSent(issued.invitationId),
      });
    } catch (error) {
      this.logger.warn(
        'The invitation was sent but its notification could not be raised: ' +
          (error instanceof Error ? error.message : 'unknown error'),
      );
    }

    return {
      userId: input.subjectUserId,
      ubossUniqueId: person.ubossUniqueId,
      resent: issued.resent,
      seats: { used: seats.used, ceiling: seats.ceiling, available: seats.available },
      tokenReturned: false,
    };
  }

  /**
   * Invite an External Guest.
   *
   * ## Guests are a different shape, not a smaller employee
   *
   * The client's rule: *guests stay outside hierarchy and receive resource-specific,
   * expiry-capable access.* So a guest gets:
   *
   *   * a membership with `userType = ExternalGuest` and a **mandatory** access expiry — enforced
   *     by a check constraint in both directions, so "guest" and "has an end date" cannot drift
   *     apart;
   *   * **no employment record**, enforced by a database trigger from both sides;
   *   * a role assignment scoped to `SelectedResource` with the resources named and its own
   *     expiry.
   *
   * ## No new authority model
   *
   * A guest's ceiling is already absolute: `ExternalGuest` is forbidden Approve, Publish, Run,
   * Schedule, Pause, ManageAccess, Administer, Audit and Export by the Prompt 7 user-type
   * ceiling, whatever role they are given. So guest access needed no new tables and no second
   * permission path — which is the point. A parallel guest-permission system would be a second
   * answer to "what may this person do".
   */
  async inviteGuest(input: {
    scope: TenantScope;
    actorUserId: string;
    email: string;
    displayName: string;
    /** Opaque resource identifiers the guest may reach. At least one — see below. */
    resourceIds: readonly string[];
    /** Days until their access ends. Mandatory, and capped. */
    accessDays: number;
    reason: string;
  }): Promise<{ userId: string; ubossUniqueId: string; expiresAt: string }> {
    await this.assertMayManageAccess(input.scope, input.actorUserId);

    if (!input.reason.trim()) {
      throw new BadRequestException('Inviting a guest requires a reason.');
    }
    if (input.resourceIds.length === 0) {
      throw new BadRequestException(
        'A guest invitation has to name the resources they may reach. An empty list would mean ' +
          'company-wide access, and "whatever they need" is not a scope anybody can review.',
      );
    }
    if (!Number.isInteger(input.accessDays) || input.accessDays < 1) {
      throw new BadRequestException('Guest access needs a whole number of days, at least one.');
    }
    if (input.accessDays > MAX_GUEST_DAYS) {
      throw new BadRequestException(
        `Guest access is capped at ${MAX_GUEST_DAYS} days. A longer grant is indistinguishable ` +
          'from a standing one; extend it deliberately instead.',
      );
    }

    const expiresAt = new Date(Date.now() + input.accessDays * 86_400_000);
    const email = input.email.trim().toLowerCase();

    const created = await this.prisma.runAsPlatformOperation(async () => {
      // One permanent identity per human, guests included — the same rule as everybody else.
      const existing = await this.prisma.client.user.findUnique({ where: { email } });
      const user =
        existing ??
        (await this.prisma.client.user.create({
          data: {
            ubossUniqueId: generateUbossUniqueId(),
            email,
            displayName: input.displayName.trim(),
          },
        }));

      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: input.scope.tenantId, userId: user.id },
      });

      if (membership && membership.userType !== 'ExternalGuest') {
        throw new ConflictException(
          'That person is already an internal member of this company. An employee cannot also ' +
            'be a guest — end their employment first if that is really the intent.',
        );
      }

      // The seat claim runs for a guest too. Whether a guest consumes one is the counting rule's
      // decision, not this method's: a per-provisioned-person contract counts them, and a
      // per-active-user one does not.
      await this.seats.claimSeat({
        tenantId: input.scope.tenantId,
        targetState: 'InvitePending',
        alreadyCounted: membership !== null,
      });

      if (membership) {
        await this.prisma.client.tenantMembership.updateMany({
          where: { id: membership.id },
          data: { guestAccessExpiresAt: expiresAt, version: { increment: 1 } },
        });
      } else {
        await this.prisma.client.tenantMembership.create({
          data: {
            tenantId: input.scope.tenantId,
            userId: user.id,
            userType: 'ExternalGuest',
            accountState: 'NotInvited',
            guestAccessExpiresAt: expiresAt,
          },
        });
      }

      // The resource-scoped grant, expiring with the access.
      await this.prisma.client.roleAssignment.create({
        data: {
          tenantId: input.scope.tenantId,
          userId: user.id,
          roleKind: 'Employee',
          scopeKind: 'SelectedResource',
          selectedResourceIds: [...input.resourceIds],
          expiresAt,
          grantedByUserId: input.actorUserId,
          justification: `Guest access: ${input.reason.trim()}`,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'access.guest_invited',
        resourceType: 'tenant_membership',
        resourceId: user.id,
        resourceRef: user.ubossUniqueId,
        actorUserId: input.actorUserId,
        summary: `Invited ${input.displayName.trim()} as an External Guest.`,
        reason: input.reason.trim(),
        metadata: {
          subjectUserId: user.id,
          resourceCount: input.resourceIds.length,
          expiresAt: expiresAt.toISOString(),
          outsideHierarchy: true,
        },
      });

      await this.securityEvents.recordWithinCurrentScope({
        action: SECURITY_ACTIONS.guestAccessGranted,
        tenantId: input.scope.tenantId,
        actorUserId: input.actorUserId,
        subjectUserId: user.id,
        resourceType: 'tenant_membership',
        resourceId: user.id,
        summary: `Guest access granted until ${expiresAt.toISOString()}.`,
        metadata: { resourceCount: input.resourceIds.length },
      });

      return user;
    });

    await this.invitations.invite({
      tenantId: input.scope.tenantId,
      email,
      displayName: input.displayName.trim(),
      invitedByUserId: input.actorUserId,
    });

    return {
      userId: created.id,
      ubossUniqueId: created.ubossUniqueId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** Cancel an outstanding invitation. The membership and the person stay. */
  async cancelInvitation(input: {
    scope: TenantScope;
    actorUserId: string;
    invitationId: string;
  }): Promise<void> {
    await this.assertMayManageAccess(input.scope, input.actorUserId);
    await this.invitations.cancel(input.scope.tenantId, input.invitationId, input.actorUserId);
  }

  private async assertMayManageAccess(scope: TenantScope, actorUserId: string): Promise<void> {
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'ManageAccess' });
  }
}
