import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import { EmailAdapter } from '../notifications/email-adapter.js';

/**
 * The two emails that are not workspace notifications: a password reset and an invitation.
 *
 * ## Why these do not go through the notification engine
 *
 * `NotificationService` is tenant-scoped by design — a notification belongs to a company and to a
 * person's preferences inside it. Neither of these does. A password reset is identity, not work:
 * the person may belong to several companies or, at the moment they ask, be locked out of all of
 * them. And a preference screen that let somebody mute their own password resets would be a way
 * to lock yourself out permanently.
 *
 * ## Why they are not queued
 *
 * Both carry a token that expires in under an hour. An outbox retry tomorrow delivers a link that
 * is already dead, which is worse than a failure somebody can see — so these are sent directly
 * and the outcome is logged. The send is still the same `EmailAdapter` every other email uses, so
 * a deployment with no SMTP records them and sends nothing, exactly as it does everywhere else.
 *
 * ## What is never logged
 *
 * The token. It is the credential — a reset link in a log file is a password in a log file — and
 * the recipient is masked like everywhere else this product names an address.
 */
@Injectable()
export class IdentityMailService {
  private readonly logger = new Logger(IdentityMailService.name);

  constructor(
    private readonly email: EmailAdapter,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /**
   * Send an activation link.
   *
   * The invitation notification used to be the whole of it, and it was written for the in-app
   * bell: *"Activate your account to reach this workspace. The activation link was emailed to
   * you"* — in the email that was supposed to *be* that link — followed by `Open it: /login`, a
   * workspace-relative path that no mail client can open. Proven by sending one to a real inbox.
   *
   * So the invitation arrived and could not be acted on. The token was minted, hashed and stored,
   * and then discarded by everything downstream — the same shape as the password reset, found the
   * same way.
   *
   * The notification stays: the bell is the right place to say "you were invited". What it cannot
   * carry is the credential.
   */
  async sendInvitation(input: {
    to: string;
    token: string;
    displayName: string;
    companyName: string;
    resent: boolean;
  }): Promise<void> {
    const link = `${this.config.webBaseUrl}/activate?token=${encodeURIComponent(input.token)}`;

    try {
      await this.email.send({
        to: input.to,
        subject: input.resent
          ? `Your invitation to ${input.companyName} on UBoss`
          : `You have been invited to ${input.companyName} on UBoss`,
        text:
          `${input.displayName},\n\n` +
          `You have been invited to ${input.companyName} on UBoss.\n\n` +
          `Open this link to set a password and activate your account:\n${link}\n\n` +
          'The link can be used once, and it expires.\n\n' +
          'If you were not expecting this, you can ignore it — nothing has been created for you ' +
          'until you open the link.\n',
        reference: 'invitation',
      });
      this.logger.log(`An activation link was sent for ${input.companyName}.`);
    } catch (error) {
      /*
       * Logged, not thrown.
       *
       * The invitation is the deliverable and it has already committed. Turning a successfully
       * issued invitation into a 500 would leave the administrator believing nothing happened,
       * which is the Prompt 8 break-glass lesson that `InvitationAccessService` already records.
       */
      this.logger.error(
        `An invitation was issued and its activation link could not be sent: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Send a password reset link.
   *
   * Never throws. The endpoint above it answers the same way whether or not an account exists —
   * anything else is an oracle for which addresses are registered — so a mail failure must not
   * become a different HTTP response either.
   */
  /**
   * Prove the address somebody signed their own company up with.
   *
   * ## Why the link is the only way back to the signup
   *
   * There is no session and no company yet, so this token is the only thing that can reach the
   * registration. That is deliberate: it means an abandoned signup cannot be resumed by anybody
   * who did not receive the mail, and it is why nothing in the response to the form itself
   * carries a token.
   *
   * ## Why a failure here is logged and not thrown
   *
   * The same rule the reset above follows: the form must answer identically whether or not the
   * address exists and whether or not the mail went out. An error that reached the caller would
   * turn this endpoint into a way of asking "is this a real address at this company".
   */
  async sendRegistrationConfirmation(input: {
    to: string;
    token: string;
    registrationId: string;
    fullName: string;
    companyName: string;
  }): Promise<void> {
    const link =
      `${this.config.webBaseUrl}/register/confirm` +
      `?id=${encodeURIComponent(input.registrationId)}&token=${encodeURIComponent(input.token)}`;

    try {
      await this.email.send({
        to: input.to,
        subject: `Confirm your email to set up ${input.companyName} on UBoss`,
        text:
          `${input.fullName},\n\n` +
          `Somebody — we think you — started setting up ${input.companyName} on UBoss with this ` +
          'address.\n\n' +
          `Confirm it here:\n${link}\n\n` +
          'After that there is one more step: adding a DNS record to prove your company controls ' +
          'the domain. Nothing is created until both are done, so there is nothing to undo if you ' +
          'stop here.\n\n' +
          'If this was not you, ignore this message. No account and no company has been created, ' +
          'and none will be.\n',
        reference: 'registration-confirmation',
      });
      this.logger.log('A registration confirmation link was sent.');
    } catch (error) {
      // Logged, not thrown. The caller must answer identically either way.
      this.logger.error(
        'A registration was started and the confirmation email could not be sent: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sendPasswordReset(input: { to: string; token: string }): Promise<void> {
    const link = `${this.config.webBaseUrl}/login/reset?token=${encodeURIComponent(input.token)}`;

    try {
      await this.email.send({
        to: input.to,
        subject: 'Reset your UBoss password',
        text:
          'Somebody asked to reset the password for this UBoss account.\n\n' +
          `Open this link to choose a new one:\n${link}\n\n` +
          'The link expires shortly, and can be used once.\n\n' +
          'If this was not you, nothing has changed and you can ignore this message. ' +
          'Your password has not been altered.\n',
        reference: 'password-reset',
      });
      this.logger.log('A password reset link was sent.');
    } catch (error) {
      // Logged, not thrown. The caller must answer identically either way.
      this.logger.error(
        `A password reset was requested and the email could not be sent: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
