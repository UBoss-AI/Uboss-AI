import { Injectable, Logger } from '@nestjs/common';

import type { Prisma, SecurityEvent } from '../generated/prisma/client.js';
import { AuditTrailRepository } from '../persistence/audit-trail.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { getCorrelationId } from '../request-context/request-context.js';
import { redactMetadata, type TrailMetadata } from './audit-event.service.js';
import type { SecurityAction } from '../auth/security-event.publisher.js';

/**
 * How a security event is classified. Mirrors the `security_event_category` enum.
 *
 * The client named four kinds — login, session, risk, support — and `Access` is the fifth,
 * because a permission denial is none of those four and is exactly the event an investigator
 * looks for first. Naming it `Risk` would have merged "somebody tried something they should not
 * have" with "this sign-in looks unusual", which are different questions.
 */
export type SecurityCategory = SecurityEvent['category'];
export type SecuritySeverity = SecurityEvent['severity'];
export type SecurityOutcome = SecurityEvent['outcome'];

export interface SecurityEventInput {
  action: SecurityAction | string;
  category: SecurityCategory;
  /** Defaults to `Info`. Set it deliberately: severity is what an alert rule will filter on. */
  severity?: SecuritySeverity | undefined;
  /** Defaults to `Succeeded`. `Blocked` means a control refused it — not the same as `Failed`. */
  outcome?: SecurityOutcome | undefined;
  /** Who did it. Null for a failed sign-in where the account could not be identified. */
  actorUserId?: string | undefined;
  /**
   * Who it was done *to*, when that is a different person.
   *
   * The distinction matters: "an admin revoked a session" and "a user revoked their own
   * session" are the same action with the same actor field and very different meanings.
   */
  subjectUserId?: string | undefined;
  /** Set when the event belongs to one company; omitted for platform-plane identity events. */
  tenantId?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  /** Why, in words. For a `Blocked` outcome this is the control that refused it. */
  reason?: string | undefined;
  deviceLabel?: string | undefined;
  /** A coarse client hint. **Never** a full client address — see the class comment. */
  clientHint?: string | undefined;
  metadata?: TrailMetadata | undefined;
  occurredAt?: Date | undefined;
}

/**
 * The security trail: **what happened to an account, a session or a support request.**
 *
 * ## Why this is a second table (ADR-045 reverses a Prompt 5 decision)
 *
 * Prompt 5 wrote security events into `audit_events` and recorded, in a class comment, that a
 * separate table "was considered and rejected" because one trail means one thing to query. That
 * reasoning was sound as far as it went, and it is now reversed. The reason, stated plainly
 * rather than quietly dropped:
 *
 *  1. **They answer different questions and want different columns.** A security event has a
 *     category, a severity, an outcome, a device and a *subject* distinct from the actor. Fitting
 *     those into `metadata` JSON means an alert rule cannot index on severity, and "show me every
 *     blocked sign-in this week" becomes a JSON scan.
 *  2. **They have different retention.** Sign-in noise is high-volume and useful for months; a
 *     record of who published which Objective is low-volume and useful for years. One table forces
 *     one retention policy, and it will be the wrong one for half the rows.
 *  3. **They have different audiences.** A Company Admin reading their own audit trail is routine.
 *     Cross-tenant security events — a failed sign-in before a workspace was chosen — belong to
 *     the platform's security plane and must not appear in a tenant's trail at all. One table with
 *     a nullable `tenant_id` made that a query discipline; two tables make it a schema fact.
 *
 * The cost is real: an investigator now reads two trails. That is accepted, and it is what the
 * correlation id is for — both trails carry it, so one identifier joins them.
 *
 * ## What must never be written here
 *
 * No password, token, plaintext credential, or full client address. `clientHint` is a *coarse*
 * hint — a truncated address or a user-agent family — because a security trail that logs full
 * addresses becomes a tracking database with a compliance obligation of its own. The metadata
 * redaction pass is shared with the audit trail and is defence in depth, not the primary
 * control: the call sites are the primary control.
 */
@Injectable()
export class SecurityEventService {
  private readonly logger = new Logger(SecurityEventService.name);
  private readonly suspiciousHandlers: ((event: SecurityEventInput) => void)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly trail: AuditTrailRepository,
  ) {}

  /**
   * Record a security event.
   *
   * Runs as a platform operation, because identity events are not tenant-owned even when they
   * carry a tenant id: a failed sign-in happens before any workspace is chosen, and the row must
   * be writable in that state. The tenant id is recorded when known so a company can still be
   * shown its own events.
   *
   * A write failure is logged, not thrown, for the same reason as the audit trail: a user who
   * cannot sign out because logging failed is worse than a gap in the log.
   */
  async record(input: SecurityEventInput): Promise<SecurityEvent | null> {
    try {
      return await this.prisma.runAsPlatformOperation(() => this.append(input));
    } catch (error) {
      this.logger.error(
        `Failed to record security event ${input.action}: ${
          error instanceof Error ? error.message : 'unknown error'
        }. The security trail now has a gap.`,
      );
      return null;
    }
  }

  /**
   * Record inside a platform transaction the caller has already opened.
   *
   * `runAsPlatformOperation` refuses to nest inside a tenant transaction — deliberately, so a
   * tenant request cannot silently escalate — which means a service already inside one cannot
   * call `record`. This is the entry point for those callers.
   */
  async appendWithinCurrentScope(input: SecurityEventInput): Promise<SecurityEvent> {
    return this.append(input);
  }

  /** Subscribe to events worth someone's attention — a new device, a lockout, a denial storm. */
  onSuspiciousActivity(handler: (event: SecurityEventInput) => void): void {
    this.suspiciousHandlers.push(handler);
  }

  /**
   * Record the event and notify subscribers.
   *
   * Handlers are called synchronously but must not block: notification delivery belongs to the
   * notifications module and its queue. Sending mail inside a sign-in transaction would hold a
   * database connection open on an SMTP round-trip, and a mail outage would become a sign-in
   * outage.
   */
  async recordSuspicious(input: SecurityEventInput): Promise<SecurityEvent | null> {
    const written = await this.record({ severity: 'Warning', ...input });

    for (const handler of this.suspiciousHandlers) {
      try {
        handler(input);
      } catch (error) {
        this.logger.error(
          `A suspicious-activity handler threw: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
    return written;
  }

  private async append(input: SecurityEventInput): Promise<SecurityEvent> {
    const metadata = redactMetadata(input.metadata);
    return this.trail.appendSecurityEvent({
      tenantId: input.tenantId ?? null,
      category: input.category,
      severity: input.severity ?? 'Info',
      outcome: input.outcome ?? 'Succeeded',
      action: input.action,
      actorUserId: input.actorUserId ?? null,
      subjectUserId: input.subjectUserId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      reason: input.reason ?? null,
      deviceLabel: input.deviceLabel ?? null,
      clientHint: input.clientHint ?? null,
      correlationId: getCorrelationId() ?? null,
      metadata: (metadata ?? null) as Prisma.InputJsonValue | null,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    });
  }
}
