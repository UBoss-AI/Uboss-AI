import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { IdentityMailService } from '../auth/identity-mail.service.js';
import { PasswordResetService } from '../auth/password-reset.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ReportScopeService } from '../reports/report-scope.service.js';
import { SeatService } from '../commercial/seat.service.js';
import { AccessRepository, type AccessRow } from '../persistence/access.repository.js';
import { InvitationRepository } from '../persistence/invitation.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { activationReadiness, type ActivationReadiness } from './activation-readiness.js';

/** The maximum a guest's access may run for. Long enough for a project, short enough to notice. */
export const MAX_GUEST_DAYS = 365;

export interface AccessPerson {
  userId: string;
  ubossUniqueId: string;
  displayName: string;
  email: string;
  userType: string;
  accountState: string;
  employeeId: string | null;
  designation: string | null;
  departmentName: string | null;
  reportingManagerName: string | null;
  employmentState: string | null;
  roleCount: number;
  /**
   * Which roles this person holds.
   *
   * The screen showed the count — "1 role" — which made an administrator and an employee read
   * identically in a list whose whole purpose is telling them apart. With two roles in the model
   * the useful answer is the name.
   */
  roleKinds: string[];
  /** Guests only. */
  guestAccessExpiresAt: string | null;
  guestExpired: boolean;
  /**
   * The live invitation, and what became of the email that carried it.
   *
   * `mail` is the part that was missing. An invitation commits before its mail is attempted, so a
   * provider failure left a perfectly good invitation with no way for anybody to learn the link
   * never arrived — the administrator saw "Invited" either way. `Sent` means the provider accepted
   * it, which is not the same as it reaching an inbox, and nothing here claims otherwise.
   * `Unknown` is for invitations issued before this was recorded at all.
   */
  invitation: {
    id: string;
    sentAt: string;
    expiresAt: string;
    expired: boolean;
    mail: {
      state: 'Sent' | 'Failed' | 'Unknown';
      error: string | null;
      attemptedAt: string | null;
    };
  } | null;
  readiness: ActivationReadiness;
}

export interface AccessView {
  /** The client's three tabs, split server-side so the screen cannot disagree about who is what. */
  employees: AccessPerson[];
  guests: AccessPerson[];
  pendingInvitations: AccessPerson[];
  seats: { used: number; ceiling: number | null; available: number | null; atCeiling: boolean };
  counts: { employees: number; guests: number; pendingInvitations: number };
}

/**
 * Settings → Users & Access: the activation and account-lifecycle centre.
 *
 * ## Why this is separate from the hierarchy
 *
 * The client's rule, and the reference states it on the screen: *account lifecycle (invite,
 * suspend, offboard, transfer ownership) is managed here — separately from the hierarchy.* The
 * hierarchy answers "who reports to whom"; this answers "who can sign in". Somebody can exist in
 * one and not the other, and that is not an inconsistency — it is the normal state of a company
 * that builds its structure before onboarding, and of a contractor who never appears in the org
 * chart at all.
 *
 * ## Inviting somebody who is already in the hierarchy
 *
 * The client's rule: *if employee already exists in hierarchy, invitation links to same stable
 * user identity; no duplicate.* Prompt 12 creates people with a synthesised
 * `<uboss-id>@person.uboss.invalid` address, because a person in the org chart may have no work
 * email yet — so an email-keyed invitation would create a **second** identity for the same human.
 * `inviteExistingPerson` takes the **userId** and sets their real address on the way through,
 * which is the only shape that cannot duplicate.
 *
 * ## Seats are claimed here, not assumed
 *
 * Inviting somebody moves their membership to `InvitePending`, which the default counting rule
 * **counts**. So this is the path that actually consumes a seat, and it goes through
 * `SeatService.claimSeat` under its per-tenant advisory lock (ADR-060). Prompt 11 built that
 * enforcement and Prompt 12 called it where a seat is free; this closes the gap.
 */
@Injectable()
export class UserAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessRepository,
    private readonly invitations: InvitationRepository,
    private readonly seats: SeatService,
    private readonly authorization: AuthorizationService,
    private readonly reportScope: ReportScopeService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    /*
     * The two halves of a reset an administrator asks for on somebody else's behalf: the service
     * that mints the token, and the mail that carries it. Both come from the global `AuthModule`.
     */
    private readonly passwordResets: PasswordResetService,
    private readonly identityMail: IdentityMailService,
  ) {}

  /**
   * Send somebody in this company a password reset link.
   *
   * ## The administrator never learns the password, and never sees the token
   *
   * That is the whole shape of this. The link goes to the person; they choose their own password;
   * nothing here, in the response, or in the log carries the token. An administrator who could set
   * a colleague's password could sign in as them, and the audit trail would show the colleague
   * doing whatever followed — which is not a trail at all.
   *
   * ## Why this one answers, where the anonymous route refuses to
   *
   * `POST /auth/password-reset/request` deliberately returns the same 202 whether or not an
   * account exists: anything else makes it an oracle for which addresses are registered. Here the
   * caller already holds `users:ManageAccess` over this company and is naming somebody from its
   * own roster, so there is nothing left to disclose — and an operator who presses a button needs
   * to know whether it did anything.
   *
   * ## The case that made this a separate method rather than a button
   *
   * `PasswordResetService.request` returns empty for anybody with **no credential** — somebody who
   * has never activated has no password to reset, and needs their invitation instead. Every person
   * a spreadsheet import creates is in exactly that state. Left alone, the button would have
   * reported success to the operator and sent nothing at all, for most of a newly imported
   * company. So that case is a refusal with the next step named.
   */
  async sendPasswordReset(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
  }): Promise<{ sent: true; email: string }> {
    await this.assertMayManageAccess(input.scope, input.actorUserId);

    const roster = await this.access.roster(input.scope);
    const person = roster.find((row) => row.userId === input.subjectUserId);
    if (!person) {
      throw new NotFoundException('Nobody by that id is in this company.');
    }

    const email = person.email.trim().toLowerCase();
    // The address an import mints for somebody with none of their own. It cannot receive mail.
    if (email === '' || email.endsWith('@person.uboss.invalid')) {
      throw new BadRequestException(
        `${person.displayName} has no work address on file, so there is nowhere to send a link. ` +
          'Add one from their profile first.',
      );
    }

    const outcome = await this.passwordResets.request(email);
    if (outcome.token === undefined || outcome.email === undefined) {
      throw new ConflictException(
        `${person.displayName} has never set a password, so there is nothing to reset. Send them ` +
          'an invitation instead — that is the link that lets them set one.',
      );
    }

    // Lifted out of `outcome` so the narrowing survives into the audit closure below.
    const sentTo = outcome.email;

    /*
     * Awaited, not queued, for the same reason the anonymous route awaits it: the token expires
     * in under an hour, so a retry tomorrow delivers a dead link.
     */
    await this.identityMail.sendPasswordReset({ to: sentTo, token: outcome.token });

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'access.password_reset_sent',
        resourceType: 'user',
        resourceId: input.subjectUserId,
        actorUserId: input.actorUserId,
        summary: `Sent ${person.displayName} a password reset link.`,
        // The address, because an operator reviewing this needs to see where it went. Never the
        // token: an audit trail that carries a live credential is a credential store.
        metadata: { subjectUserId: input.subjectUserId, email: sentTo },
      });
    });

    return { sent: true, email: sentTo };
  }

  /** The whole screen: three tabs, the seat position, and why each invitation is or is not ready. */
  async viewFor(scope: TenantScope, actorUserId: string): Promise<AccessView> {
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'View' });

    const [rows, hasRoot, seats, reach] = await Promise.all([
      this.access.roster(scope),
      this.access.hasReportingRoot(scope),
      this.seats.positionFor(scope),
      this.reportScope.forPeopleList({ scope, actorUserId }),
    ]);

    /*
     * Only the people this caller's scope reaches.
     *
     * `userIds: null` means whole-company, which is what a Company Admin resolves to; a Manager
     * resolves to their reporting subtree and a Head to their departments. Without this the screen
     * listed everybody to anybody holding `users:View`, which is every role in the product.
     *
     * Filtered here rather than in the query because the resolver is the one place that knows how
     * a scope becomes a set of people, and duplicating that in SQL is how the two come to disagree.
     */
    const visible =
      reach.userIds === null
        ? rows
        : rows.filter((row) => reach.userIds !== null && reach.userIds.includes(row.userId));

    const people = visible.map((row) => UserAccessService.toPerson(row, hasRoot));

    // Split into the client's three tabs. A person appears in **Pending Invitations** as well as
    // their own tab, deliberately: the tab is a work queue ("who is waiting"), not a category,
    // and hiding a pending employee from the Employees list would make the roster incomplete.
    return {
      employees: people.filter((person) => person.userType === 'InternalUser'),
      guests: people.filter((person) => person.userType === 'ExternalGuest'),
      pendingInvitations: people.filter((person) => person.invitation !== null),
      seats: {
        used: seats.used,
        ceiling: seats.ceiling,
        available: seats.available,
        atCeiling: seats.atCeiling,
      },
      counts: {
        employees: people.filter((person) => person.userType === 'InternalUser').length,
        guests: people.filter((person) => person.userType === 'ExternalGuest').length,
        pendingInvitations: people.filter((person) => person.invitation !== null).length,
      },
    };
  }

  static toPerson(row: AccessRow, companyHasReportingRoot: boolean): AccessPerson {
    const now = Date.now();

    return {
      userId: row.userId,
      ubossUniqueId: row.ubossUniqueId,
      displayName: row.displayName,
      // A synthesised placeholder is shown as absent rather than as an address, because it is
      // not one — showing `ub-….@person.uboss.invalid` would invite somebody to email it.
      email: row.email.endsWith('@person.uboss.invalid') ? '' : row.email,
      userType: row.userType,
      accountState: row.accountState,
      employeeId: row.employeeId,
      designation: row.designation,
      departmentName: row.departmentName,
      reportingManagerName: row.reportingManagerName,
      employmentState: row.employmentState,
      roleCount: row.roleCount,
      roleKinds: row.roleKinds,
      guestAccessExpiresAt: row.guestAccessExpiresAt?.toISOString() ?? null,
      guestExpired: row.guestAccessExpiresAt !== null && row.guestAccessExpiresAt.getTime() <= now,
      invitation:
        row.invitationId === null
          ? null
          : {
              id: row.invitationId,
              sentAt: row.invitationSentAt?.toISOString() ?? '',
              expiresAt: row.invitationExpiresAt?.toISOString() ?? '',
              expired: row.invitationExpiresAt !== null && row.invitationExpiresAt.getTime() <= now,
              mail: {
                state:
                  row.invitationMailState === 'Sent'
                    ? 'Sent'
                    : row.invitationMailState === 'Failed'
                      ? 'Failed'
                      : 'Unknown',
                error: row.invitationMailError,
                attemptedAt: row.invitationMailAttemptedAt?.toISOString() ?? null,
              },
            },
      readiness: activationReadiness({
        userType: row.userType as never,
        accountState: row.accountState as never,
        employment:
          row.employmentState === null
            ? null
            : {
                departmentId: row.departmentId,
                reportingManagerUserId: row.reportingManagerUserId,
              },
        roleCount: row.roleCount,
        companyHasReportingRoot,
        // Passed at last. Left out, it defaulted to false and the founding administrator was told
        // on every page load that they needed an employment record they can never have.
        hasBootstrapRole: row.hasBootstrapRole,
      }),
    };
  }

  /**
   * Suspend somebody's access without touching anything else.
   *
   * Reversible and non-destructive: the membership, the employment record, every role assignment
   * and all of their history stay exactly as they were. Under a per-provisioned-person counting
   * rule a suspended person still holds their seat, which is deliberate — see
   * `COUNTED_ACCOUNT_STATES`.
   */
  async suspend(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    reason: string;
  }): Promise<void> {
    await this.assertMayManageAccess(input.scope, input.actorUserId);

    if (!input.reason.trim()) {
      throw new BadRequestException('Suspending somebody requires a reason.');
    }
    if (input.subjectUserId === input.actorUserId) {
      throw new BadRequestException(
        'You cannot suspend your own account. Somebody else has to do it, so a company cannot ' +
          'be locked out by one person acting alone.',
      );
    }

    await this.transition({
      ...input,
      to: 'Suspended',
      from: ['Active', 'InvitePending'],
      action: 'access.suspended',
      summary: 'Suspended this account.',
    });
  }

  /** Reinstate a suspended account. Needs a seat if the counting rule freed one. */
  async reinstate(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    reason: string;
  }): Promise<void> {
    await this.assertMayManageAccess(input.scope, input.actorUserId);

    if (!input.reason.trim()) {
      throw new BadRequestException('Reinstating somebody requires a reason.');
    }

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
      });
      if (!membership) {
        throw new NotFoundException('That person is not a member of this company.');
      }
      if (membership.accountState !== 'Suspended') {
        throw new ConflictException(
          `That account is "${membership.accountState}", not Suspended, so there is nothing to ` +
            'reinstate.',
        );
      }

      // Under `ActiveOnly` a suspended person freed their seat, so coming back needs one — and
      // the company may have filled it. `alreadyCounted` is passed when the rule counts them
      // while suspended, so reinstating cannot be blocked by a seat they never released.
      const position = await this.seats.positionFor(input.scope);
      await this.seats.claimSeat({
        tenantId: input.scope.tenantId,
        targetState: 'Active',
        alreadyCounted: position.countedStates.includes('Suspended'),
      });

      await this.prisma.client.tenantMembership.updateMany({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
        data: { accountState: 'Active', version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'access.reinstated',
        resourceType: 'tenant_membership',
        resourceId: membership.id,
        actorUserId: input.actorUserId,
        summary: 'Reinstated this account.',
        reason: input.reason.trim(),
        metadata: { subjectUserId: input.subjectUserId, from: 'Suspended', to: 'Active' },
      });
    });
  }

  /** One account-state change, audited, with the legal source states named. */
  private async transition(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    reason: string;
    to: 'Suspended' | 'Active' | 'Offboarded';
    from: readonly string[];
    action: string;
    summary: string;
  }): Promise<void> {
    await this.prisma.runInTenantTransaction(input.scope, async () => {
      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
      });
      if (!membership) {
        throw new NotFoundException('That person is not a member of this company.');
      }
      if (!input.from.includes(membership.accountState)) {
        throw new ConflictException(
          `That account is "${membership.accountState}". This change is only possible from: ` +
            `${input.from.join(', ')}.`,
        );
      }

      await this.prisma.client.tenantMembership.updateMany({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
        data: { accountState: input.to as never, version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: input.action,
        resourceType: 'tenant_membership',
        resourceId: membership.id,
        actorUserId: input.actorUserId,
        summary: input.summary,
        reason: input.reason.trim(),
        metadata: {
          subjectUserId: input.subjectUserId,
          from: membership.accountState,
          to: input.to,
          // The client's rule, on every record: nothing is removed by a state change.
          nothingDeleted: true,
        },
      });

      await this.securityEvents.recordWithinCurrentScope({
        action:
          input.to === 'Suspended'
            ? SECURITY_ACTIONS.accountSuspended
            : SECURITY_ACTIONS.accountReinstated,
        tenantId: input.scope.tenantId,
        actorUserId: input.actorUserId,
        subjectUserId: input.subjectUserId,
        resourceType: 'tenant_membership',
        resourceId: membership.id,
        summary: input.summary,
      });
    });
  }

  /**
   * `users:ManageAccess` — the permission that governs who can change somebody's access.
   *
   * Deliberately not `users:Administer`: managing access is its own action in the Prompt 7
   * vocabulary precisely so that "can edit a person's details" and "can let a person into the
   * company" are separable, and an External Guest is forbidden `ManageAccess` outright by the
   * user-type ceiling.
   */
  private async assertMayManageAccess(scope: TenantScope, actorUserId: string): Promise<void> {
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'ManageAccess' });
  }
}
