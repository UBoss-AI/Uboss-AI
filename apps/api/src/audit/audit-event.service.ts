import { Injectable, Logger } from '@nestjs/common';

import type { AuditEvent, Prisma } from '../generated/prisma/client.js';
import { AuditTrailRepository } from '../persistence/audit-trail.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor, getCorrelationId } from '../request-context/request-context.js';

/**
 * Metadata keys whose **string** values must never reach a trail.
 *
 * The same list guards both trails. An audit row is permanent — the whole design of this prompt
 * is that nobody can go back and remove one — so a secret written into metadata by mistake
 * cannot be cleaned up by fixing the caller afterwards. That asymmetry is why this exists as
 * code rather than as a review convention.
 */
const FORBIDDEN_METADATA_KEY =
  /pass(word|phrase)|secret|token|credential|authorization|cookie|aadhaar|private[_-]?key/i;

export type TrailMetadata = Record<string, string | number | boolean | null>;

export interface AuditEventInput {
  /** Stable machine-readable action key, e.g. `'objective.published'`. */
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  /**
   * **Why**, in words a person will read months later. Distinct from `summary`, which says
   * *what*. A high-risk action with no reason is itself a finding, so services performing one
   * should require it from the caller rather than defaulting it.
   */
  reason?: string | undefined;
  summary?: string | undefined;
  /** The affected record's row version at the time, so the trail lines up with the row. */
  resourceVersion?: number | undefined;
  /** A stable external reference — a version label, a Run id, a document revision. */
  resourceRef?: string | undefined;
  actorUserId?: string | undefined;
  metadata?: TrailMetadata | undefined;
  correlationId?: string | undefined;
  occurredAt?: Date | undefined;
}

/**
 * The append-only audit trail: **what changed, who changed it, and why.**
 *
 * ## Its relationship to `SecurityEventService`
 *
 * Two trails, on purpose, and the reasoning is in ADR-045. In one line: this trail answers
 * "what happened to this record", the security trail answers "what happened to this account or
 * session". Prompt 5 put both in one table and that decision is now reversed — with the reason
 * stated, because reversing a documented decision silently is worse than the original mistake.
 *
 * ## Actor and correlation id are taken from the request, not from the caller
 *
 * A caller that has to pass its own actor id can pass the wrong one, and the most likely wrong
 * one is the subject of the action rather than the person performing it. The ambient request
 * context already knows who is authenticated, so that is the default; an explicit
 * `actorUserId` is honoured for the cases the context cannot know — a scheduled job, a SCIM
 * client acting for a provider, a platform operation on a tenant's behalf.
 *
 * ## Failures are logged, not thrown
 *
 * Except when they are. `record` swallows a write failure, because a user who cannot sign out
 * because logging failed is worse than a gap in the log — and the gap is logged at error level
 * so it is visible. `recordOrThrow` does not swallow, and is for the cases where the audit row
 * **is** the deliverable: a break-glass grant with no audit row must not be a break-glass grant.
 */
@Injectable()
export class AuditEventService {
  private readonly logger = new Logger(AuditEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trail: AuditTrailRepository,
  ) {}

  /**
   * Record a tenant-scoped event.
   *
   * Joins the caller's transaction when there is one, so the event and the change it describes
   * commit together. Opens its own tenant transaction when called outside one.
   */
  async recordForTenant(scope: TenantScope, input: AuditEventInput): Promise<AuditEvent | null> {
    return this.write(() =>
      this.prisma.runInTenantTransaction(scope, () =>
        this.trail.appendAuditEvent(this.normalise(scope.tenantId, input)),
      ),
    );
  }

  /** Record an event that belongs to no single company. */
  async recordForPlatform(input: AuditEventInput): Promise<AuditEvent | null> {
    return this.write(() =>
      this.prisma.runAsPlatformOperation(() =>
        this.trail.appendAuditEvent(this.normalise(null, input)),
      ),
    );
  }

  /**
   * Record a tenant-scoped event and **let a failure propagate**.
   *
   * Use this where the audit row is part of what the operation promises rather than a
   * side-effect of it. Break-glass is the clear case: "emergency access was granted and we
   * failed to write it down" must fail the grant, not proceed with a note in the log.
   */
  async recordForTenantOrThrow(scope: TenantScope, input: AuditEventInput): Promise<AuditEvent> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.trail.appendAuditEvent(this.normalise(scope.tenantId, input)),
    );
  }

  async recordForPlatformOrThrow(input: AuditEventInput): Promise<AuditEvent> {
    return this.prisma.runAsPlatformOperation(() =>
      this.trail.appendAuditEvent(this.normalise(null, input)),
    );
  }

  /**
   * Append inside a transaction the caller has already opened and scoped.
   *
   * The plain `recordForTenant` also joins an existing transaction, so this exists for the case
   * where the caller is inside a **platform** operation acting on one tenant's data and wants
   * the row to carry that tenant id — a combination the scope alone cannot express.
   */
  async appendWithinCurrentScope(
    tenantId: string | null,
    input: AuditEventInput,
  ): Promise<AuditEvent> {
    return this.trail.appendAuditEvent(this.normalise(tenantId, input));
  }

  private async write(work: () => Promise<AuditEvent>): Promise<AuditEvent | null> {
    try {
      return await work();
    } catch (error) {
      this.logger.error(
        `Failed to write an audit event: ${
          error instanceof Error ? error.message : 'unknown error'
        }. The trail now has a gap, which is itself worth investigating.`,
      );
      return null;
    }
  }

  private normalise(
    tenantId: string | null,
    input: AuditEventInput,
  ): Parameters<AuditTrailRepository['appendAuditEvent']>[0] {
    const metadata = redactMetadata(input.metadata);
    return {
      tenantId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      actorUserId: input.actorUserId ?? actorUserId(getActor()) ?? null,
      summary: input.summary ?? null,
      reason: input.reason ?? null,
      resourceVersion: input.resourceVersion ?? null,
      resourceRef: input.resourceRef ?? null,
      correlationId: input.correlationId ?? getCorrelationId() ?? null,
      metadata: (metadata ?? null) as Prisma.InputJsonValue | null,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    };
  }
}

/**
 * Blank any **string** value under a risky key.
 *
 * Only strings are redacted. A boolean or a number cannot be a secret, and blanking them
 * destroys useful detail for no benefit: an early version of this turned `{ setPassword: true }`
 * into `{ setPassword: "[redacted]" }`, which told an investigator nothing at all. The key
 * pattern alone is too blunt a test — the key *and* a string value together are what indicate
 * a risk.
 */
export function redactMetadata(metadata: TrailMetadata | undefined): TrailMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const safe: TrailMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    safe[key] =
      typeof value === 'string' && FORBIDDEN_METADATA_KEY.test(key) ? '[redacted]' : value;
  }
  return safe;
}
