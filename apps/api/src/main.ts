import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { json, urlencoded } from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module.js';

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
  const UPLOAD_PATHS = /\/tenants\/[^/]+\/files\/?$/;
  app.use((request: Request, response: Response, next: NextFunction) => {
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

  const port = Number(process.env['API_PORT'] ?? 4000);
  const host = process.env['API_HOST'] ?? '0.0.0.0';

  await app.listen(port, host);
  logger.log(`UBoss API listening on http://${host}:${port} — health at /health`);
}

void bootstrap();
