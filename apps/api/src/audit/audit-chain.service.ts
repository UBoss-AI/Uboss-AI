import { ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuditChainCheckpoint } from '../generated/prisma/client.js';
import { AuditTrailRepository } from '../persistence/audit-trail.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import {
  AUDIT_CHAIN_VERSION,
  PLATFORM_CHAIN_KEY,
  auditRowHash,
  securityRowHash,
  verifyChain,
  type ChainVerificationResult,
  type TrailName,
} from './audit-chain.js';

/**
 * Verifying the chains, and sealing checkpoints.
 *
 * ## What a "verified" result actually means
 *
 * It means: every chained row's stored hash matches its content, every link matches its
 * predecessor, and there are no gaps or duplicate positions. It does **not** mean the trail is
 * complete, because nothing inside the database can establish that — a superuser who rewrote
 * rows and recomputed every hash would produce a chain that verifies. ADR-046 states this
 * limitation in full; the result object carries `unchainedCount` so an operator can see exactly
 * how much of the trail the check does not cover.
 *
 * ## Checkpoints, and why they are the part that matters
 *
 * A checkpoint is `(chain key, trail, sequence, row hash, row count)` at a moment in time. Its
 * value is entirely in being held **somewhere this database cannot reach**: a chain that has been
 * checkpointed externally cannot be rewritten without the rewrite disagreeing with the copy.
 * `externalAnchorRef` is the column that records where that copy went.
 *
 * No external sink is implemented at Prompt 8, so a sealed checkpoint with a null
 * `externalAnchorRef` is honestly labelled as unanchored, and the verification result says so.
 * Shipping a checkpoint table and calling the guarantee "tamper-proof" would be the kind of
 * claim that gets believed and then relied on.
 */
@Injectable()
export class AuditChainService {
  private readonly logger = new Logger(AuditChainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trail: AuditTrailRepository,
    private readonly authorization: AuthorizationService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * Verify one company's chains. Requires `settings:Audit` at whole-company scope.
   *
   * Both trails are checked in one call: an operator asking "is my trail intact" means both, and
   * making them separate calls invites checking one and forgetting the other.
   */
  async verifyForTenant(
    scope: TenantScope,
    userId: string,
  ): Promise<{
    audit: ChainVerificationResult;
    security: ChainVerificationResult;
    guarantee: string;
  }> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Audit' });

    const effective = this.authorization.scopeForListing(context, 'settings', 'Audit');
    if (effective !== 'WholeCompany') {
      throw new ForbiddenException(
        `Verifying the audit chain requires whole-company scope; this grant is "${effective}". ` +
          'A chain cannot be verified in part: a partial slice reports a broken link at its ' +
          'first row.',
      );
    }

    return this.verifyChainKey(scope.tenantId, scope);
  }

  /** Verify the platform chains — the tenant-less rows. Platform actors only. */
  async verifyPlatformChains(): Promise<{
    audit: ChainVerificationResult;
    security: ChainVerificationResult;
    guarantee: string;
  }> {
    return this.verifyChainKey(PLATFORM_CHAIN_KEY, undefined);
  }

  /**
   * Verify any chain key, in whichever RLS scope reaches it.
   *
   * A broken chain records a `Critical` security event before returning. This is the one place
   * where writing the event matters more than the answer: whoever asked already knows, and the
   * event is what tells everybody else.
   */
  private async verifyChainKey(
    chainKey: string,
    scope: TenantScope | undefined,
  ): Promise<{
    audit: ChainVerificationResult;
    security: ChainVerificationResult;
    guarantee: string;
  }> {
    const run = <T>(work: () => Promise<T>): Promise<T> =>
      scope
        ? this.prisma.runInTenantTransaction(scope, work)
        : this.prisma.runAsPlatformOperation(work);

    const result = await run(async () => {
      const auditRows = await this.trail.readAuditChain(chainKey);
      const securityRows = await this.trail.readSecurityChain(chainKey);
      const unchained = await this.trail.countUnchainedAuditRows(
        chainKey === PLATFORM_CHAIN_KEY ? null : chainKey,
      );

      const audit = verifyChain({
        chainKey,
        trail: 'audit',
        rows: auditRows.map((row) => ({
          id: row.id,
          chainKey: row.chainKey,
          sequence: row.sequence,
          prevHash: row.prevHash,
          rowHash: row.rowHash,
          payload: {
            tenantId: row.tenantId,
            action: row.action,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            actorUserId: row.actorUserId,
            summary: row.summary,
            reason: row.reason,
            resourceVersion: row.resourceVersion,
            resourceRef: row.resourceRef,
            correlationId: row.correlationId,
            metadata: row.metadata,
            occurredAt: row.occurredAt,
          },
        })),
        hashRow: (row) => auditRowHash(row),
      });

      const security = verifyChain({
        chainKey,
        trail: 'security',
        rows: securityRows.map((row) => ({
          id: row.id,
          chainKey: row.chainKey,
          sequence: row.sequence,
          prevHash: row.prevHash,
          rowHash: row.rowHash,
          payload: {
            tenantId: row.tenantId,
            category: row.category,
            severity: row.severity,
            outcome: row.outcome,
            action: row.action,
            actorUserId: row.actorUserId,
            subjectUserId: row.subjectUserId,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            reason: row.reason,
            deviceLabel: row.deviceLabel,
            clientHint: row.clientHint,
            correlationId: row.correlationId,
            metadata: row.metadata,
            occurredAt: row.occurredAt,
          },
        })),
        hashRow: (row) => securityRowHash(row),
      });

      // `readAuditChain` returns only chained rows, so the pre-Prompt-8 count has to be added
      // separately. Reporting it is the point — see `ChainVerificationResult.unchainedCount`.
      return { audit: { ...audit, unchainedCount: unchained }, security };
    });

    const anchored = await this.hasAnchoredCheckpoint(chainKey, scope);
    const broken = !result.audit.intact || !result.security.intact;

    if (broken) {
      this.logger.error(
        `Audit chain verification FAILED for ${chainKey}: ` +
          `${result.audit.breaks.length} audit break(s), ` +
          `${result.security.breaks.length} security break(s).`,
      );
    }

    await this.securityEvents.record({
      action: broken ? SECURITY_ACTIONS.auditChainBroken : SECURITY_ACTIONS.auditChainVerified,
      ...(scope ? { tenantId: scope.tenantId } : {}),
      resourceType: 'audit_chain',
      resourceId: chainKey,
      summary: broken
        ? `Chain verification failed: ${result.audit.breaks.length + result.security.breaks.length} break(s).`
        : `Chain verified: ${result.audit.verifiedCount + result.security.verifiedCount} row(s).`,
      metadata: {
        auditBreaks: result.audit.breaks.length,
        securityBreaks: result.security.breaks.length,
        unchainedAuditRows: result.audit.unchainedCount,
      },
    });

    return { ...result, guarantee: describeGuarantee(anchored) };
  }

  /**
   * Seal the current head of a chain as a checkpoint.
   *
   * Refuses to seal a chain that does not verify. A checkpoint over a broken chain would fix a
   * corrupted state as the new baseline, which is worse than having no checkpoint: from then on,
   * verification from the checkpoint would report the tampered trail as intact.
   */
  async sealCheckpoint(input: {
    chainKey: string;
    trail: TrailName;
    scope?: TenantScope | undefined;
    sealedByUserId?: string | undefined;
    externalAnchorRef?: string | undefined;
  }): Promise<AuditChainCheckpoint> {
    const verification = input.scope
      ? await this.verifyChainKey(input.chainKey, input.scope)
      : await this.verifyChainKey(input.chainKey, undefined);

    const target = input.trail === 'audit' ? verification.audit : verification.security;

    if (!target.intact) {
      throw new ForbiddenException(
        `Refusing to seal a checkpoint for the ${input.trail} chain "${input.chainKey}": it has ` +
          `${target.breaks.length} unresolved break(s). Sealing now would make the tampered ` +
          'state the verified baseline.',
      );
    }
    if (target.headHash === null || target.headSequence === null) {
      throw new ForbiddenException(
        `Refusing to seal an empty ${input.trail} chain "${input.chainKey}": there is no ` +
          'position to record.',
      );
    }

    const run = <T>(work: () => Promise<T>): Promise<T> =>
      input.scope
        ? this.prisma.runInTenantTransaction(input.scope, work)
        : this.prisma.runAsPlatformOperation(work);

    const checkpoint = await run(() =>
      this.trail.sealCheckpoint({
        chainKey: input.chainKey,
        trail: input.trail,
        sequence: BigInt(target.headSequence as string),
        rowHash: target.headHash as string,
        rowCount: BigInt(target.verifiedCount),
        sealedByUserId: input.sealedByUserId ?? null,
        externalAnchorRef: input.externalAnchorRef ?? null,
      }),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.auditChainCheckpointSealed,
      ...(input.sealedByUserId ? { actorUserId: input.sealedByUserId } : {}),
      ...(input.scope ? { tenantId: input.scope.tenantId } : {}),
      resourceType: 'audit_chain_checkpoint',
      resourceId: checkpoint.id,
      summary:
        `Sealed ${input.trail} chain "${input.chainKey}" at position ${target.headSequence}` +
        (input.externalAnchorRef ? ' and anchored it externally.' : ' (not externally anchored).'),
      metadata: {
        chainKey: input.chainKey,
        trail: input.trail,
        sequence: target.headSequence,
        rowCount: target.verifiedCount,
        anchored: input.externalAnchorRef !== undefined,
        chainVersion: AUDIT_CHAIN_VERSION,
      },
    });

    return checkpoint;
  }

  async listCheckpoints(
    scope: TenantScope,
    userId: string,
    trail?: TrailName,
  ): Promise<AuditChainCheckpoint[]> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Audit' });

    return this.prisma.runInTenantTransaction(scope, () =>
      this.trail.listCheckpoints(scope.tenantId, trail),
    );
  }

  private async hasAnchoredCheckpoint(
    chainKey: string,
    scope: TenantScope | undefined,
  ): Promise<boolean> {
    const run = <T>(work: () => Promise<T>): Promise<T> =>
      scope
        ? this.prisma.runInTenantTransaction(scope, work)
        : this.prisma.runAsPlatformOperation(work);

    const checkpoints = await run(() => this.trail.listCheckpoints(chainKey));
    return checkpoints.some((checkpoint) => checkpoint.externalAnchorRef !== null);
  }
}

/**
 * The guarantee, in words, returned alongside every verification.
 *
 * It is returned rather than documented-only because the strength of the guarantee **changes**
 * depending on whether an external anchor exists, and a caller reading a green "intact: true"
 * has no other way to know which of the two situations they are in.
 */
export function describeGuarantee(anchored: boolean): string {
  const common =
    'Guaranteed: the application database role cannot UPDATE or DELETE a trail row (privilege ' +
    'revoked), and a trigger refuses the same for the owner role. Any modification, deletion or ' +
    'reordering of a chained row is detectable by recomputing the chain.';

  return anchored
    ? `${common} A checkpoint has been anchored outside this database, so a wholesale rewrite ` +
        'with recomputed hashes would disagree with that anchor and is therefore also detectable.'
    : `${common} NOT guaranteed: no checkpoint has been anchored outside this database, so an ` +
        'attacker with superuser access could disable the trigger, rewrite rows and recompute ' +
        'every hash, and this check would still report the chain as intact. Hash chaining alone ' +
        'cannot detect that. Anchor a checkpoint externally to close the gap.';
}
