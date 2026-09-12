import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { createRequestContext, runWithRequestContext } from './request-context.js';

/** Header UBoss reads an inbound correlation id from, and echoes back on every response. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';
/** Also accepted, since many proxies and clients standardise on this name instead. */
export const REQUEST_ID_HEADER = 'x-request-id';

const MAX_CORRELATION_ID_LENGTH = 64;
/** Conservative allow-list: ids end up in logs, so control characters and newlines are out. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * A caller-supplied correlation id is untrusted input. It is accepted only when it matches a
 * conservative pattern, because an id containing newlines could forge log lines, and an
 * unbounded one could bloat every log record for the request.
 */
export function sanitiseCorrelationId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CORRELATION_ID_LENGTH) {
    return undefined;
  }
  return SAFE_CORRELATION_ID.test(trimmed) ? trimmed : undefined;
}

function firstHeaderValue(value: string | string[] | undefined): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Establishes the request context for every request.
 *
 * Runs before guards and handlers, so a correlation id exists even for a request that is about
 * to be rejected — a denied request is exactly the one worth correlating with its logs.
 *
 * The actor starts as anonymous; the TenantGuard replaces it once it has verified membership.
 * Nothing here reads identity from the request, so no header can assert who the caller is.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const inbound =
      sanitiseCorrelationId(firstHeaderValue(request.headers[CORRELATION_ID_HEADER])) ??
      sanitiseCorrelationId(firstHeaderValue(request.headers[REQUEST_ID_HEADER]));

    const correlationId = inbound ?? randomUUID();

    // Echo it so the caller can quote it in a support request.
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    runWithRequestContext(createRequestContext(correlationId), () => {
      next();
    });
  }
}
