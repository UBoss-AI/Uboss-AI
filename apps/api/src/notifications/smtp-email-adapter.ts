import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

import {
  EmailAdapter,
  LoggingEmailAdapter,
  maskEmail,
  type EmailDeliveryResult,
  type OutboundEmail,
} from './email-adapter.js';

/** What an SMTP deployment has to supply. Absent means this adapter is not used at all. */
export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS on connect (465). Otherwise STARTTLS is required on the plain port. */
  secure: boolean;
  /**
   * Whether STARTTLS must succeed on a plain port.
   *
   * Explicit rather than derived inside the adapter, so that the decision is visible in the
   * configuration instead of buried in a constructor. `readSmtpConfig` — the only path a
   * deployment can take — always sets it true on a plain port, and a test asserts that. A test
   * that needs to speak to a loopback server builds a config object directly.
   */
  requireTls: boolean;
  username: string;
  password: string;
  /** The envelope and header From. A provider will usually refuse anything else. */
  fromEmail: string;
  fromName: string;
  /**
   * Domains this deployment is allowed to mail. Empty means no restriction.
   *
   * ## Why a transport needs this at all
   *
   * A non-production deployment's people are fixtures, and fixture addresses are at domains that
   * do not exist — `@aarohan.uboss.local`, `@uboss.example`. Point such a deployment at a real
   * provider and every queued notification is *accepted*, because acceptance happens before the
   * recipient domain is resolved. They then bounce, one per message, into the sending mailbox,
   * and a burst of bounces to non-existent domains is what gets a sending reputation flagged.
   *
   * Measured, on this product, the first time SMTP was configured in development: **65 messages
   * accepted by the provider in under three minutes**, every one of them to a fixture address,
   * from a backlog nobody had noticed because nothing had ever been able to send it.
   *
   * ## Why it is not a development-only flag
   *
   * A staging environment restored from a production dump has real customers' addresses in it,
   * and the failure there is worse than bounces: it mails real people about work that is not
   * happening. `NODE_ENV` would not catch that — staging is not development — so this is a
   * deliberate list rather than an inference from an environment name.
   *
   * Production leaves it empty and mails whoever the product says to mail.
   */
  allowedRecipientDomains: readonly string[];
}

/**
 * Reads the SMTP settings from the environment, or returns null.
 *
 * Null is a first-class answer: no mail provider is configured, and the module keeps the logging
 * adapter. **Partial configuration is treated as a configuration error rather than as absence** —
 * a host with no password is somebody halfway through setting this up, and quietly falling back to
 * "nothing is sent" is how that goes unnoticed until a customer asks where their invitation went.
 */
export function readSmtpConfig(
  env: Record<string, string | undefined> = process.env,
): SmtpConfig | null {
  const host = env['UBOSS_SMTP_HOST']?.trim();
  const username = env['UBOSS_SMTP_USERNAME']?.trim();
  const password = env['UBOSS_SMTP_PASSWORD'];
  const fromEmail = env['UBOSS_SMTP_FROM_EMAIL']?.trim() ?? username;

  const supplied = [host, username, password].filter(
    (value) => value !== undefined && value !== '',
  ).length;
  if (supplied === 0) return null;
  if (host === undefined || host === '' || username === undefined || username === '') {
    throw new Error(
      'SMTP is partly configured: UBOSS_SMTP_HOST and UBOSS_SMTP_USERNAME are both required. ' +
        'Set all of them, or none — a half-configured transport silently sends nothing.',
    );
  }
  if (password === undefined || password === '') {
    throw new Error('SMTP is partly configured: UBOSS_SMTP_PASSWORD is required.');
  }
  if (fromEmail === undefined || fromEmail === '') {
    throw new Error('SMTP is partly configured: UBOSS_SMTP_FROM_EMAIL is required.');
  }

  const port = Number(env['UBOSS_SMTP_PORT'] ?? '587');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`UBOSS_SMTP_PORT is not a port: ${String(env['UBOSS_SMTP_PORT'])}`);
  }

  return {
    host,
    port,
    // 465 is implicit TLS; everything else negotiates STARTTLS, which `requireTLS` below insists on.
    secure: env['UBOSS_SMTP_SECURE'] === 'true' || port === 465,
    // Not configurable. A deployment that cannot offer STARTTLS has a broken mail server, not a
    // preference, and the alternative is a password and an invitation crossing the network in
    // clear text.
    requireTls: !(env['UBOSS_SMTP_SECURE'] === 'true' || port === 465),
    username,
    password,
    fromEmail,
    fromName: env['UBOSS_SMTP_FROM_NAME']?.trim() ?? 'UBoss',
    allowedRecipientDomains: (env['UBOSS_SMTP_ALLOWED_RECIPIENT_DOMAINS'] ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain !== ''),
  };
}

/**
 * The SMTP transport.
 *
 * ## What this is and is not
 *
 * It is the transport the `EmailAdapter` docblock describes as "the work" — the plumbing above it
 * (outbox, at-least-once delivery, backoff, dead-lettering, channel recorded in the audit trail)
 * already existed and is untouched. It is selected only when the SMTP environment is complete;
 * otherwise `NotificationsModule` keeps the logging adapter, which reports
 * `deliversRealMail: false`.
 *
 * `describe()` returns `deliversRealMail: true`, and that is the one claim in this file that has
 * to be earned: it means a provider accepted the message, not that a person read it. A provider
 * accepting a message is the strongest thing any sender can honestly say.
 *
 * ## TLS is not optional
 *
 * `requireTls` comes from the config, and `readSmtpConfig` always sets it on a plain port. A
 * server that does not offer STARTTLS therefore causes a failure rather than a credential and an
 * invitation crossing the network in clear text. **No environment variable can turn it off** —
 * only a config object built in a test, which is how the protocol is exercised against a loopback
 * server without a certificate.
 *
 * ## What is never logged
 *
 * The recipient is masked and the body is never logged, which is the rule the logging adapter
 * already followed — a notification body can name a company's objectives.
 */
@Injectable()
export class SmtpEmailAdapter extends EmailAdapter {
  private readonly logger = new Logger('EmailAdapter');
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpConfig) {
    super();
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTls,
      // Only ever true for a loopback test server, because `readSmtpConfig` cannot produce it.
      ...(config.requireTls || config.secure ? {} : { ignoreTLS: true }),
      auth: { user: config.username, pass: config.password },
      // A hung provider must not hold an outbox worker for ever; the outbox retries.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(email: OutboundEmail): Promise<EmailDeliveryResult> {
    /*
     * Refused before the connection, not after.
     *
     * A provider accepts a message for a domain that does not exist and bounces it later, so a
     * check that relied on the provider saying no would let every one of these through and learn
     * about it from the bounces. This is the only point at which a deployment can decline to
     * mail somebody it has no business mailing.
     *
     * Thrown rather than skipped, so the outbox records the refusal and retries or dead-letters
     * it. Returning a success would mark the row `Delivered` for a message that was never sent,
     * which is the specific lie the whole `deliversRealMail` seam exists to prevent.
     */
    const allowed = this.config.allowedRecipientDomains;
    if (allowed.length > 0) {
      const domain = email.to.split('@').pop()?.toLowerCase() ?? '';
      if (!allowed.includes(domain)) {
        /*
         * The reason reaches a screen now, so it is written for the person reading it.
         *
         * It used to end with "Clear UBOSS_SMTP_ALLOWED_RECIPIENT_DOMAINS to mail anybody", which
         * was the right sentence when this was only ever a log line. Since the invitation roster
         * started showing why an activation email was refused, a company's administrator reads
         * it — and the name of a deployment environment variable is something they cannot act on
         * and should not be shown. The operator's half goes to the log instead.
         */
        this.logger.warn(
          `A message to ${maskEmail(email.to)} was refused by the recipient allow-list ` +
            `(${allowed.join(', ')}). Clear UBOSS_SMTP_ALLOWED_RECIPIENT_DOMAINS to mail anybody.`,
        );
        throw new Error(
          `This deployment may only send email to ${allowed.join(', ')}, and ` +
            `${maskEmail(email.to)} is not one of them. Ask your UBoss administrator to allow ` +
            'this domain.',
        );
      }
    }

    const info = await this.transporter.sendMail({
      /*
       * The name may be the sender's; the address is always this deployment's.
       *
       * See `OutboundEmail.fromName` for why that split is not a compromise but the only
       * arrangement that delivers: SPF and DKIM are checked against the address's domain, and
       * putting a customer's own address here would fail both.
       */
      from: {
        name: email.fromName ?? this.config.fromName,
        address: this.config.fromEmail,
      },
      ...(email.replyTo === undefined ? {} : { replyTo: email.replyTo }),
      to: email.to,
      subject: email.subject,
      text: email.text,
      ...(email.html === undefined ? {} : { html: email.html }),
      // Lets a bounce be traced back to the outbox row that produced it.
      headers: { 'X-UBoss-Reference': email.reference },
    });

    const rejected = info.rejected ?? [];
    if (rejected.length > 0) {
      // The provider took the connection and refused this recipient. Throwing hands it back to
      // the outbox, which is what decides whether to retry or dead-letter it.
      throw new Error(
        `SMTP rejected ${rejected.length} recipient(s) for ${email.reference}: ${String(
          info.response ?? 'no response',
        )}`,
      );
    }

    this.logger.log(
      `Email accepted by ${this.config.host}: "${email.subject}" to ${maskEmail(email.to)} ` +
        `[${email.reference}]`,
    );

    return { channel: 'smtp', providerMessageId: info.messageId ?? null };
  }

  describe(): { name: string; deliversRealMail: boolean; note: string } {
    return {
      name: `SMTP (${this.config.host}:${this.config.port})`,
      deliversRealMail: true,
      note:
        'Mail is handed to an SMTP provider over TLS. "Delivered" here means the provider ' +
        'accepted the message — not that it reached an inbox, which no sender can know. A ' +
        'rejected recipient is thrown back to the outbox to retry or dead-letter.',
    };
  }

  /** Closes the pool. Called on shutdown so a worker does not hold a socket open. */
  close(): void {
    this.transporter.close();
  }
}

/**
 * Which transport this deployment gets.
 *
 * Named and exported rather than inlined in the module's provider list, because "did we pick the
 * adapter that actually sends?" is the question somebody will ask during an incident, and the
 * answer should be a function with a test rather than an arrow in a providers array.
 *
 * A complete SMTP environment gives the SMTP transport. Nothing gives the logging adapter, which
 * reports `deliversRealMail: false`. A *partial* environment throws out of `readSmtpConfig` and
 * takes the process with it, which is deliberate: booting into "silently sends nothing" is the
 * failure this whole seam exists to make impossible.
 */
export function chooseEmailAdapter(
  env: Record<string, string | undefined> = process.env,
): EmailAdapter {
  const smtp = readSmtpConfig(env);
  return smtp === null ? new LoggingEmailAdapter() : new SmtpEmailAdapter(smtp);
}
