import { Inject, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { activationReadiness } from '../access/activation-readiness.js';
import { InvitationRepository } from '../persistence/invitation.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SessionRepository } from '../persistence/session.repository.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { UserCredentialRepository } from '../persistence/user-credential.repository.js';
import { UserRepository } from '../persistence/user.repository.js';
import { generateUbossUniqueId } from '../persistence/uboss-unique-id.js';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import { createOneTimeToken, hashToken } from './one-time-token.js';
import { PasswordService } from './password.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';
import { SessionService, type SessionOrigin } from './session.service.js';

export interface IssuedInvitation {
  invitationId: string;
  /**
   * The activation token, returned **once**. Only a hash is stored, so it cannot be retrieved
   * afterwards — a lost invitation is resent (which rotates the token), never recovered.
   */
  token: string;
  expiresAt: Date;
  userId: string;
  email: string;
  resent: boolean;
}

export type InvitationPreview =
  | {
      outcome: 'valid';
      displayName: string;
      email: string;
      tenantName: string;
      /** True when this person already has a password from another company. */
      hasExistingPassword: boolean;
    }
  | { outcome: 'invalid' };

export type ActivationResult =
  | {
      outcome: 'activated';
      userId: string;
      ubossUniqueId: string;
      tenantId: string;
      sessionToken: string;
      absoluteExpiresAt: Date;
    }
  | { outcome: 'invalid' };

/**
 * Invitation issue / resend / cancel, and activation.
 *
 * **There is no public company signup.** Activation only ever enables an identity that has
 * already been invited by a company: it requires a token that a company issued, and it can
 * neither create a company nor add a membership that does not already exist.
 */
@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invitations: InvitationRepository,
    private readonly users: UserRepository,
    private readonly credentials: UserCredentialRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly securityEvents: SecurityEventPublisher,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /**
   * Invite someone into a company, creating their permanent platform identity if this is their
   * first UBoss company.
   *
   * Re-inviting a person who already has an outstanding invitation **rotates** that invitation's
   * token rather than creating a second one, so two working links can never exist in two
   * mailboxes at once.
   */
  async invite(input: {
    tenantId: string;
    email: string;
    displayName: string;
    invitedByUserId?: string | undefined;
  }): Promise<IssuedInvitation> {
    const email = input.email.trim().toLowerCase();
    const token = createOneTimeToken();
    const expiresAt = new Date(Date.now() + this.config.invitationExpiryHours * 60 * 60 * 1000);
    const scope = tenantScopeForPlatformOperation(input.tenantId);

    const result = await this.prisma.runAsPlatformOperation(async () => {
      // One permanent UBoss Unique ID per person, reused across companies.
      const existingUser = await this.users.findByEmailForPlatform(email);
      const user =
        existingUser ??
        (await this.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email,
          displayName: input.displayName,
        }));

      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: input.tenantId, userId: user.id },
        select: { id: true, accountState: true },
      });

      if (!membership) {
        throw new BadRequestException(
          'This person has no membership in that company. Add them to the company first — an ' +
            'invitation cannot create a membership, and there is no public signup.',
        );
      }

      if (membership.accountState === 'Active') {
        throw new BadRequestException('This person has already activated their account.');
      }
      if (membership.accountState === 'Offboarded') {
        throw new BadRequestException(
          'This person has been offboarded from the company and cannot be re-invited without ' +
            'being reinstated first.',
        );
      }

      const outstanding = await this.invitations.findOutstanding(scope, user.id);
      let invitationId: string;
      let resent = false;

      if (outstanding) {
        await this.invitations.rotateToken(scope, outstanding.id, token.hash, expiresAt);
        invitationId = outstanding.id;
        resent = true;
      } else {
        const created = await this.invitations.create(scope, {
          userId: user.id,
          tokenHash: token.hash,
          expiresAt,
          ...(input.invitedByUserId === undefined
            ? {}
            : { invitedByUserId: input.invitedByUserId }),
        });
        invitationId = created.id;
      }

      await this.prisma.client.tenantMembership.update({
        where: { id: membership.id },
        data: { accountState: 'InvitePending', version: { increment: 1 } },
      });

      return { invitationId, userId: user.id, resent, email };
    });

    await this.securityEvents.record({
      action: result.resent ? SECURITY_ACTIONS.invitationResent : SECURITY_ACTIONS.invitationIssued,
      ...(input.invitedByUserId === undefined ? {} : { actorUserId: input.invitedByUserId }),
      tenantId: input.tenantId,
      resourceType: 'invitation',
      resourceId: result.invitationId,
      summary: result.resent ? 'Invitation resent.' : 'Invitation issued.',
      metadata: { expiresAt: expiresAt.toISOString() },
    });

    return {
      invitationId: result.invitationId,
      token: token.plaintext,
      expiresAt,
      userId: result.userId,
      email: result.email,
      resent: result.resent,
    };
  }

  /** Cancel an outstanding invitation; its link stops working immediately. */
  async cancel(tenantId: string, invitationId: string, cancelledByUserId?: string): Promise<void> {
    const scope = tenantScopeForPlatformOperation(tenantId);

    const cancelled = await this.prisma.runAsPlatformOperation(async () => {
      const invitation = await this.invitations.findById(scope, invitationId);
      if (!invitation) {
        return 0;
      }
      const count = await this.invitations.cancel(scope, invitationId, new Date());
      if (count > 0) {
        // Back to NotInvited, so Users & Access shows the truth: they can be invited again.
        await this.prisma.client.tenantMembership.updateMany({
          where: { tenantId, userId: invitation.userId, accountState: 'InvitePending' },
          data: { accountState: 'NotInvited', version: { increment: 1 } },
        });
      }
      return count;
    });

    if (cancelled === 0) {
      throw new NotFoundException('No outstanding invitation was found.');
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.invitationCancelled,
      ...(cancelledByUserId === undefined ? {} : { actorUserId: cancelledByUserId }),
      tenantId,
      resourceType: 'invitation',
      resourceId: invitationId,
      summary: 'Invitation cancelled; its activation link no longer works.',
    });
  }

  /**
   * Describe an invitation to the activation screen, without activating it.
   *
   * Every failure returns `invalid` — expired, cancelled, already accepted and never-existed are
   * indistinguishable, so a token cannot be probed for information.
   */
  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.prisma.runAsPlatformOperation(() =>
      this.invitations.findLiveByTokenHashForPlatform(hashToken(token)),
    );

    if (!invitation || invitation.expiresAt <= new Date()) {
      return { outcome: 'invalid' };
    }

    const credential = await this.prisma.runAsPlatformOperation(() =>
      this.credentials.findByUserId(invitation.userId),
    );

    return {
      outcome: 'valid',
      displayName: invitation.user.displayName,
      email: invitation.user.email,
      tenantName: invitation.tenant.name,
      hasExistingPassword: credential !== null,
    };
  }

  /**
   * Activate an invitation: set the password (first company only), mark the membership Active,
   * consume the invitation and sign the person in.
   *
   * The whole thing is one transaction, so a half-activated account — password set but membership
   * still pending, or the reverse — cannot exist.
   */
  async activate(
    token: string,
    password: string | undefined,
    origin: SessionOrigin,
  ): Promise<ActivationResult> {
    const now = new Date();

    const activated = await this.prisma.runAsPlatformOperation(async () => {
      const invitation = await this.invitations.findLiveByTokenHashForPlatform(hashToken(token));

      if (!invitation || invitation.expiresAt <= now) {
        return null;
      }

      // Compare-and-set: two concurrent activations with the same link cannot both win.
      const accepted = await this.invitations.acceptForPlatform(invitation.id, now);
      if (accepted === 0) {
        return null;
      }

      // ---- The Prompt 13 activation gate ----
      //
      // The client's rule: **"New Internal Employee requires department + manager + role before
      // activation."** Checked here as well as at invitation time, because the window between
      // them is real: a role can be revoked or a department archived after the email goes out,
      // and an account that activates into a company where it has no department, no manager and
      // no permissions is one that can sign in and do nothing while looking like it works.
      //
      // Queried inline rather than through `AccessRepository` to keep `AuthModule` free of a
      // dependency on `AccessModule`, which depends on it. The decision itself is the shared
      // pure function, so the three callers cannot disagree.
      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: invitation.tenantId, userId: invitation.userId },
        select: { userType: true, accountState: true },
      });

      if (membership) {
        const [employment, roleCount, rootCount] = await Promise.all([
          this.prisma.client.employmentRecord.findFirst({
            where: { tenantId: invitation.tenantId, userId: invitation.userId },
            select: { departmentId: true, reportingManagerUserId: true },
          }),
          this.prisma.client.roleAssignment.count({
            where: {
              tenantId: invitation.tenantId,
              userId: invitation.userId,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
          }),
          this.prisma.client.employmentRecord.count({
            where: { tenantId: invitation.tenantId, reportingManagerUserId: null },
          }),
        ]);

        const readiness = activationReadiness({
          userType: membership.userType,
          accountState: membership.accountState,
          employment,
          roleCount,
          companyHasReportingRoot: rootCount > 0,
        });

        if (!readiness.ready) {
          throw new BadRequestException(
            `This account cannot be activated yet. ${readiness.summary} Ask your company ` +
              'administrator to complete the setup, then use this link again — it is still valid.',
          );
        }
      }

      const existingCredential = await this.credentials.findByUserId(invitation.userId);

      if (!existingCredential) {
        if (password === undefined) {
          throw new BadRequestException(
            'A password is required to activate this account for the first time.',
          );
        }
        const passwordHash = await this.passwords.hash(password);
        await this.credentials.setPassword(invitation.userId, passwordHash, now);
      } else if (password !== undefined) {
        // The person already has a UBoss password from another company. Silently replacing it
        // would let one company's invitation link reset the credential the person uses
        // everywhere — so it is refused rather than honoured.
        throw new BadRequestException(
          'You already have a UBoss password. Activate with your existing password, or use ' +
            'Access Help to reset it.',
        );
      }

      await this.prisma.client.tenantMembership.updateMany({
        where: { tenantId: invitation.tenantId, userId: invitation.userId },
        data: { accountState: 'Active', version: { increment: 1 } },
      });

      return {
        userId: invitation.userId,
        ubossUniqueId: invitation.user.ubossUniqueId,
        tenantId: invitation.tenantId,
        invitationId: invitation.id,
        setPassword: existingCredential === null,
      };
    });

    if (!activated) {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.invitationRejected,
        resourceType: 'invitation',
        summary: 'Activation rejected: the link is invalid, expired, cancelled or already used.',
      });
      return { outcome: 'invalid' };
    }

    const session = await this.sessions.establish(activated.userId, origin);

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.invitationAccepted,
      actorUserId: activated.userId,
      tenantId: activated.tenantId,
      resourceType: 'invitation',
      resourceId: activated.invitationId,
      summary: 'Invitation activated and account enabled.',
      metadata: { setPassword: activated.setPassword },
    });

    return {
      outcome: 'activated',
      userId: activated.userId,
      ubossUniqueId: activated.ubossUniqueId,
      tenantId: activated.tenantId,
      sessionToken: session.token,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  /** Outstanding and historical invitations for a company. */
  async listForTenant(tenantId: string) {
    const scope = tenantScopeForPlatformOperation(tenantId);
    return this.prisma.runAsPlatformOperation(() => this.invitations.listForTenant(scope));
  }
}
