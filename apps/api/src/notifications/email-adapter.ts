import { Injectable, Logger } from '@nestjs/common';

/** One message to send. Plain text plus an optional HTML part, which is all any of these need. */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string | undefined;
  /** Correlates the mail with the outbox row and the notification that produced it. */
  reference: string;
}

export interface EmailDeliveryResult {
  /** What the transport called it, for the audit trail. `logged` for the default adapter. */
  channel: string;
  /** The provider's id where there is one. Null for an adapter that does not issue them. */
  providerMessageId: string | null;
}

/**
 * The email transport seam.
 *
 * An interface with a default implementation rather than a direct SMTP call, because the choice of
 * provider is a deployment decision and because a test must be able to assert what *would* have
 * been sent without a network.
 */
export abstract class EmailAdapter {
  abstract send(email: OutboundEmail): Promise<EmailDeliveryResult>;
  /** What this adapter is, for the operational view. Never a claim that mail was delivered. */
  abstract describe(): { name: string; deliversRealMail: boolean; note: string };
}

/**
 * The default adapter: **it logs, and does not send.**
 *
 * ## Why this is the default rather than SMTP
 *
 * There is no verified mail provider for this deployment. An adapter that quietly pointed at
 * localhost:25 would appear to work in development and fail silently in production, and one that
 * claimed delivery it had not performed would make every "did the customer get their invitation"
 * investigation start from a false premise.
 *
 * So this adapter is explicit about what it is. `describe()` reports `deliversRealMail: false`,
 * the operational view shows that, and `AUDIT`/outbox rows record `channel: 'logged'` — a
 * dispatched notification is therefore distinguishable from a delivered one at every layer.
 *
 * ## What a real deployment does
 *
 * Provide an `EmailAdapter` implementation in the module and everything above it is unchanged:
 * the outbox already gives at-least-once delivery with backoff and dead-lettering, and the
 * dispatcher already records the channel. The work is the transport, not the plumbing.
 */
@Injectable()
export class LoggingEmailAdapter extends EmailAdapter {
  private readonly logger = new Logger('EmailAdapter');

  /** Everything this adapter was asked to send, for tests and for the operational view. */
  readonly sent: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<EmailDeliveryResult> {
    this.sent.push(email);
    // Subject and recipient only. A notification body can name a resource, and the client's
    // rule is that logs do not carry company content.
    this.logger.log(
      `Email not sent (no provider configured): "${email.subject}" to ${maskEmail(email.to)} ` +
        `[${email.reference}]`,
    );
    return { channel: 'logged', providerMessageId: null };
  }

  describe(): { name: string; deliversRealMail: boolean; note: string } {
    return {
      name: 'Logging adapter',
      deliversRealMail: false,
      note:
        'No mail provider is configured, so nothing is delivered. The message is recorded and ' +
        'the outbox row is marked delivered to this channel, which is why the operational view ' +
        'reports the channel rather than only a count — "queued and dispatched" is not "the ' +
        'customer received it".',
    };
  }
}

/**
 * `p****v@example.com`. Enough to recognise an address in a log, not enough to harvest one.
 *
 * Exported because the dispatcher's audit metadata needs the same treatment, and two
 * implementations of a redaction rule is one implementation too many.
 */
export function maskEmail(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) {
    return '****';
  }
  const local = address.slice(0, at);
  const domain = address.slice(at);
  if (local.length <= 2) {
    return `${local.slice(0, 1)}****${domain}`;
  }
  return `${local.slice(0, 1)}****${local.slice(-1)}${domain}`;
}
