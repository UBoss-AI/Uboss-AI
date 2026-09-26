import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { json, raw, urlencoded } from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module.js';
import { annotateGuards } from './openapi-annotations.js';
import { DEV_ACTOR_HEADER } from './request-context/actor-resolver.js';
import { WORKSPACE_HEADER } from './tenancy/tenant.guard.js';

/**
 * Is the browsable API reference served?
 *
 * Off in production unless somebody says otherwise, on everywhere else. The document is a map of
 * every route and the permission each one needs, which is exactly the map an attacker would like
 * and exactly the map a developer needs — so the default follows the environment rather than
 * being the same everywhere.
 *
 * `API_DOCS_ENABLED` overrides in both directions, because a staging box that wants it and a
 * development box that does not are both reasonable.
 */
function docsEnabled(): boolean {
  const explicit = process.env['API_DOCS_ENABLED'];
  if (explicit !== undefined) return explicit === 'true';
  return process.env['NODE_ENV'] !== 'production';
}

/** Parse a comma-separated origin allow-list. An empty value disables cross-origin access. */
function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

async function bootstrap(): Promise<void> {
  // `bodyParser: false` so the JSON limit can differ by route — see below. Nest's default parser
  // is replaced rather than supplemented, because two parsers would both consume the stream.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  const logger = new Logger('Bootstrap');

  // Security headers by default rather than as a later retrofit.
  app.use(helmet());

  /**
   * Two JSON body limits, and the reason is Prompt 35.
   *
   * A file upload arrives base64-encoded in a JSON body, so the upload route has to accept roughly
   * a third more than `MAX_CONFIGURABLE_UPLOAD_BYTES` — 250 MB becomes about 334 MB on the wire.
   * Raising the global limit to that would mean **every** route in the product would happily buffer
   * a third of a gigabyte from an unauthenticated client, which is a denial-of-service surface
   * bought for one endpoint's convenience.
   *
   * So: 1 MB everywhere, and the larger limit only on the paths that end in the files collection.
   * The route's own validation then enforces the company's configured limit against the decoded
   * length, which is the real control — this is only the ceiling on what the process will buffer
   * before that control gets to run.
   */
  const uploadJson = json({ limit: '340mb' });
  const ordinaryJson = json({ limit: '1mb' });

  /**
   * The payment provider's webhook gets the raw bytes, and nothing else does.
   *
   * Its signature is computed over the **exact body** that was sent. A body parsed to JSON and
   * serialised again is not those bytes — key order and number formatting both differ — so every
   * genuine delivery would fail verification and look like a forgery.
   *
   * A literal path rather than a pattern, because there is exactly one such endpoint and a
   * pattern here would be a way to accidentally hand another route an unparsed body. The handler
   * asserts it received a Buffer rather than assuming, so if this ever stops matching, the failure
   * says so instead of looking like a wrong signing secret.
   *
   * One megabyte, like every other ordinary route: a webhook body is a few kilobytes, and this
   * endpoint is reachable without a session.
   */
  const providerWebhook = raw({ type: '*/*', limit: '1mb' });
  const PROVIDER_WEBHOOK_PATH = '/billing/stripe/webhook';
  const UPLOAD_PATHS = /\/tenants\/[^/]+\/files\/?$/;
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path === PROVIDER_WEBHOOK_PATH) {
      providerWebhook(request, response, next);
      return;
    }
    const parser = UPLOAD_PATHS.test(request.path) ? uploadJson : ordinaryJson;
    parser(request, response, next);
  });
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  // Session cookies are read by the actor resolver, so parsing must happen before any guard.
  // No signing secret: the cookie holds an opaque high-entropy token whose hash is looked up
  // server-side, so a tampered value simply matches no session.
  app.use(cookieParser());

  // Whitelist + forbid unknown properties so no later DTO can silently accept extra fields
  // (for example a browser-supplied tenant_id, which working rule E forbids trusting).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const origins = parseCorsOrigins(process.env['API_CORS_ORIGINS']);
  if (origins.length > 0) {
    app.enableCors({ origin: origins, credentials: true });
  }

  // Graceful shutdown so in-flight work is not cut off mid-request.
  app.enableShutdownHooks();

  /**
   * The browsable API reference.
   *
   * ## Why the auth schemes are declared rather than left blank
   *
   * Nothing here is a bearer-token API. A caller is identified by the session cookie the sign-in
   * routes set, and a company request additionally names the workspace in a header — the tenant
   * guard refuses without it, which is the single most common "why does this 403" in this API. A
   * reference that omitted both would send every reader down that path once.
   *
   * ## What this document does not carry
   *
   * **Request body schemas.** Deriving them needs `@nestjs/swagger`'s CLI plugin, which hooks
   * into `nest build`; this workspace builds with plain `tsc`, so the plugin never runs and a DTO
   * arrives as an unnamed object. The routes, their parameters, their guards and the permission
   * each one requires are all real. Saying so here rather than letting an empty `{}` read as
   * "this endpoint takes nothing".
   */
  if (docsEnabled()) {
    const document = annotateGuards(
      app,
      SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('UBoss AI AMS API')
        .setDescription(
          'The company plane lives under `/tenants/{tenantId}`; the platform plane under ' +
            '`/platform`. Every route states the permission it requires as `module:Action`, ' +
            'which is the same vocabulary the product enforces — a role that does not hold it ' +
            'is refused with 403 and a reason. Request body schemas are not derived: this ' +
            'workspace builds with plain tsc, so the Swagger CLI plugin does not run.',
        )
        .setVersion('0.1.0')
        .addCookieAuth('uboss_session', {
          type: 'apiKey',
          in: 'cookie',
          name: 'uboss_session',
          description:
            'Set by POST /auth/login. Opaque and high-entropy; only its hash is stored, so a ' +
            'tampered value matches no session.',
        })
        .addApiKey(
          {
            type: 'apiKey',
            in: 'header',
            name: WORKSPACE_HEADER,
            description:
              'The workspace this request is for. Required by every `/tenants/{tenantId}` ' +
              'route: the tenant guard refuses when it is missing or disagrees with the path.',
          },
          WORKSPACE_HEADER,
        )
        .addApiKey(
          {
            type: 'apiKey',
            in: 'header',
            name: DEV_ACTOR_HEADER,
            description:
              'Development only, and only when AUTH_DEV_HEADERS_ENABLED=true. Names the acting ' +
              'person by UBoss unique id, so a suite can act as somebody without a session. It ' +
              'is refused outright when the flag is off.',
          },
          DEV_ACTOR_HEADER,
        )
        .build(),
      ),
    );

    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs-json',
      swaggerOptions: {
        // The cookie travels on its own; this keeps whatever the reader typed across reloads.
        persistAuthorization: true,
        docExpansion: 'none',
        filter: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
      customSiteTitle: 'UBoss API reference',
    });
  }

  const port = Number(process.env['API_PORT'] ?? 4000);
  const host = process.env['API_HOST'] ?? '0.0.0.0';

  await app.listen(port, host);
  logger.log(`UBoss API listening on http://${host}:${port} — health at /health`);
  logger.log(
    docsEnabled()
      ? `API reference at http://${host}:${port}/docs — OpenAPI document at /docs-json`
      : 'API reference not served: API_DOCS_ENABLED is off (the default in production).',
  );
}

void bootstrap();
