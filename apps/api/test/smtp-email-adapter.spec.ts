import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';

import {
  chooseEmailAdapter,
  readSmtpConfig,
  SmtpEmailAdapter,
} from '../src/notifications/smtp-email-adapter.js';

/**
 * The SMTP transport, against a real SMTP conversation.
 *
 * ## Why a server rather than a mock
 *
 * A mocked `sendMail` proves that a method was called. The things that actually break an email
 * transport are the protocol: whether AUTH is offered and accepted, whether the envelope carries
 * the right sender, whether the body survives, whether a refused recipient becomes an error the
 * outbox can retry. So this spins up a minimal SMTP server on a loopback port, captures the whole
 * exchange, and asserts against what was really transmitted.
 *
 * **Nothing leaves the machine.** No mail is sent to any real address, and no provider credentials
 * are used — the server below accepts a throwaway username and password. The adapter's own
 * `describe()` claim, `deliversRealMail: true`, means "a provider accepted the message", which is
 * the strongest thing a sender can honestly say and is exactly what is asserted here.
 *
 * ## STARTTLS
 *
 * A real deployment must use STARTTLS on a plain port, so a plaintext loopback server could not be
 * reached at all if that were hard-coded. It is therefore stated in `SmtpConfig` instead, and the
 * protocol tests build a config with `requireTls: false` directly. Nothing in the environment can
 * produce that — `readSmtpConfig` always sets it on a plain port, and a test in this file holds
 * that, which is what keeps the relaxation confined to a loopback socket.
 */

interface CapturedSession {
  commands: string[];
  data: string;
}

/**
 * A minimal SMTP server. Enough of the protocol for a client to complete a send, and it records
 * everything it was told.
 */
function startCaptureServer(options: { rejectRecipients?: boolean } = {}): Promise<{
  port: number;
  sessions: CapturedSession[];
  close: () => Promise<void>;
}> {
  const sessions: CapturedSession[] = [];

  const server = net.createServer((socket) => {
    const session: CapturedSession = { commands: [], data: '' };
    sessions.push(session);

    let inData = false;
    let buffer = '';

    socket.write('220 capture.test ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      // SMTP is line-oriented; the DATA body ends with a bare dot on its own line.
      for (;;) {
        const breakAt = buffer.indexOf('\r\n');
        if (breakAt === -1) break;
        const line = buffer.slice(0, breakAt);
        buffer = buffer.slice(breakAt + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued as CAPTURED-1\r\n');
          } else {
            // Undo dot-stuffing, as a real server does.
            session.data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          }
          continue;
        }

        session.commands.push(line);
        const verb = line.split(' ')[0]?.toUpperCase() ?? '';

        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-capture.test\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (verb === 'AUTH') {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (verb === 'MAIL') {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (verb === 'RCPT') {
          socket.write(
            options.rejectRecipients ? '550 5.1.1 No such recipient here\r\n' : '250 2.1.5 Ok\r\n',
          );
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else if (verb === 'RSET' || verb === 'NOOP') {
          socket.write('250 2.0.0 Ok\r\n');
        } else {
          socket.write('502 5.5.1 Command not implemented\r\n');
        }
      }
    });

    socket.on('error', () => {
      // A client hanging up mid-conversation is a normal end to a rejected send.
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        sessions,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * The adapter, pointed at a loopback capture server.
 *
 * `requireTls: false` is stated in the config rather than patched into nodemailer afterwards. It
 * is reachable only from a config object built here — `readSmtpConfig`, the only path a
 * deployment takes, always sets it on a plain port, and a test below holds that.
 */
function adapterFor(port: number): SmtpEmailAdapter {
  return new SmtpEmailAdapter({
    host: '127.0.0.1',
    port,
    secure: false,
    requireTls: false,
    username: 'throwaway',
    password: 'throwaway',
    fromEmail: 'notifications@uboss.test',
    fromName: 'UBoss',
  });
}

describe('SMTP email adapter', () => {
  describe('the protocol conversation', () => {
    let server: Awaited<ReturnType<typeof startCaptureServer>>;
    let adapter: SmtpEmailAdapter;

    before(async () => {
      server = await startCaptureServer();
      adapter = adapterFor(server.port);
    });

    after(async () => {
      adapter.close();
      await server.close();
    });

    it('authenticates, sends the envelope, and returns the provider id', async () => {
      const result = await adapter.send({
        to: 'recipient@uboss.test',
        subject: 'Your invitation to SPM Medicare',
        text: 'Someone invited you. This is a test message that left no machine.',
        reference: 'outbox-row-42',
      });

      assert.equal(result.channel, 'smtp');
      assert.equal(typeof result.providerMessageId, 'string');

      const [session] = server.sessions;
      const commands = session?.commands.join('\n') ?? '';

      // The protocol, in order, is what actually has to work.
      assert.match(commands, /^EHLO /m, 'should introduce itself');
      assert.match(commands, /^AUTH /m, 'should authenticate');
      assert.match(commands, /^MAIL FROM:<notifications@uboss\.test>/m);
      assert.match(commands, /^RCPT TO:<recipient@uboss\.test>/m);
      assert.match(commands, /^DATA$/m);
    });

    it('transmits the subject, the body and the outbox reference', () => {
      const body = server.sessions[0]?.data ?? '';

      assert.match(body, /^Subject: Your invitation to SPM Medicare$/m);
      assert.match(body, /^From: UBoss <notifications@uboss\.test>$/m);
      // The reference is what lets a bounce be traced back to the row that produced it. Matched
      // case-insensitively because header names are case-insensitive and nodemailer normalises
      // them — asserting the exact casing would be testing the library, not the product.
      assert.match(body, /^x-uboss-reference: outbox-row-42$/im);
      assert.match(body, /left no machine/);
    });

    it('says it delivers real mail, and says what that does and does not mean', () => {
      const described = adapter.describe();

      assert.equal(described.deliversRealMail, true);
      assert.match(described.name, /^SMTP \(127\.0\.0\.1:/);
      // The distinction the whole seam exists to preserve.
      assert.match(described.note, /accepted the message/i);
      assert.match(described.note, /not that it reached an inbox/i);
    });
  });

  describe('a recipient the provider refuses', () => {
    it('throws, so the outbox can retry or dead-letter it', async () => {
      const server = await startCaptureServer({ rejectRecipients: true });
      const adapter = adapterFor(server.port);

      // Swallowing this would mark the outbox row delivered for a message nobody will ever get.
      await assert.rejects(
        adapter.send({
          to: 'nobody@uboss.test',
          subject: 'Refused',
          text: 'This recipient does not exist.',
          reference: 'outbox-row-43',
        }),
        (error: unknown) => {
          assert.match(String(error), /nobody@uboss\.test|No such recipient|550/i);
          return true;
        },
      );

      adapter.close();
      await server.close();
    });
  });

  describe('reading the environment', () => {
    it('returns null when nothing is configured, so the logging adapter stays', () => {
      assert.equal(readSmtpConfig({}), null);
    });

    it('refuses a half-configured transport rather than silently sending nothing', () => {
      // The failure this guards against: somebody sets a host, forgets the password, and the
      // product quietly goes on delivering nothing while reporting notifications as dispatched.
      assert.throws(
        () => readSmtpConfig({ UBOSS_SMTP_HOST: 'smtp.example.com' }),
        /partly configured/i,
      );
      assert.throws(
        () =>
          readSmtpConfig({
            UBOSS_SMTP_HOST: 'smtp.example.com',
            UBOSS_SMTP_USERNAME: 'someone@example.com',
          }),
        /UBOSS_SMTP_PASSWORD/,
      );
    });

    it('defaults to STARTTLS on 587 and implicit TLS on 465', () => {
      const base = {
        UBOSS_SMTP_HOST: 'smtp.example.com',
        UBOSS_SMTP_USERNAME: 'someone@example.com',
        UBOSS_SMTP_PASSWORD: 'secret',
      };

      assert.equal(readSmtpConfig(base)?.port, 587);
      assert.equal(readSmtpConfig(base)?.secure, false);
      assert.equal(readSmtpConfig({ ...base, UBOSS_SMTP_PORT: '465' })?.secure, true);
    });

    it('falls back to the username as the sender, and refuses a nonsense port', () => {
      const config = readSmtpConfig({
        UBOSS_SMTP_HOST: 'smtp.example.com',
        UBOSS_SMTP_USERNAME: 'someone@example.com',
        UBOSS_SMTP_PASSWORD: 'secret',
      });
      assert.equal(config?.fromEmail, 'someone@example.com');

      assert.throws(
        () =>
          readSmtpConfig({
            UBOSS_SMTP_HOST: 'smtp.example.com',
            UBOSS_SMTP_USERNAME: 'someone@example.com',
            UBOSS_SMTP_PASSWORD: 'secret',
            UBOSS_SMTP_PORT: 'not-a-port',
          }),
        /is not a port/,
      );
    });

    it('always requires TLS on a plain port, and no variable can turn it off', () => {
      // The one setting whose absence would put a password and an invitation on the wire in clear
      // text. Asserted on the reader, because the reader is the only path a deployment has.
      const base = {
        UBOSS_SMTP_HOST: 'smtp.example.com',
        UBOSS_SMTP_USERNAME: 'someone@example.com',
        UBOSS_SMTP_PASSWORD: 'secret',
      };

      assert.equal(readSmtpConfig(base)?.requireTls, true);
      // Nothing in the environment relaxes it — not a truthy-looking variable of its own name.
      assert.equal(readSmtpConfig({ ...base, UBOSS_SMTP_REQUIRE_TLS: 'false' })?.requireTls, true);
      assert.equal(readSmtpConfig({ ...base, requireTls: 'false' })?.requireTls, true);

      // On 465 the connection is already TLS from the first byte, so STARTTLS does not apply.
      const implicit = readSmtpConfig({ ...base, UBOSS_SMTP_PORT: '465' });
      assert.equal(implicit?.secure, true);
      assert.equal(implicit?.requireTls, false);
    });
  });
});

describe('choosing the transport', () => {
  it('uses the logging adapter when no mail provider is configured', () => {
    const adapter = chooseEmailAdapter({});
    const described = adapter.describe();

    assert.equal(described.deliversRealMail, false);
    assert.match(described.name, /logging/i);
  });

  it('uses SMTP when the environment is complete', () => {
    const adapter = chooseEmailAdapter({
      UBOSS_SMTP_HOST: 'smtp.example.com',
      UBOSS_SMTP_USERNAME: 'someone@example.com',
      UBOSS_SMTP_PASSWORD: 'secret',
    });
    const described = adapter.describe();

    assert.equal(described.deliversRealMail, true);
    assert.match(described.name, /^SMTP \(smtp\.example\.com:587\)$/);
    (adapter as SmtpEmailAdapter).close();
  });

  it('refuses to start on a half-configured environment', () => {
    // The alternative is a deployment that boots, reports notifications as dispatched, and
    // delivers nothing — which is the exact failure the logging adapter's docblock warns about.
    assert.throws(
      () => chooseEmailAdapter({ UBOSS_SMTP_HOST: 'smtp.example.com' }),
      /partly configured/i,
    );
  });
});
