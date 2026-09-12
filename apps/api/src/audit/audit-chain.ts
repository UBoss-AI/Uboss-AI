import { createHash } from 'node:crypto';

/**
 * The tamper-evidence primitive: a per-chain SHA-256 hash chain.
 *
 * Every trail row carries the hash of the row before it, so the rows form a linked list that
 * can only be extended. Changing, removing or reordering any row breaks every hash after it,
 * and recomputing the chain finds the first break.
 *
 * ## What this guarantees, exactly
 *
 * The precise claim — and, more importantly, what it does **not** claim — is written out in
 * `docs/ARCHITECTURE_DECISIONS.md` ADR-046. The short version, because it is easy to overstate:
 *
 *   * **Prevented:** the application role cannot `UPDATE` or `DELETE` a trail row at all. That
 *     is a database privilege (`REVOKE`), backed by a trigger that refuses even the owner role.
 *   * **Detected:** any modification, deletion or reordering is found by recomputing the chain.
 *   * **NOT prevented and NOT detected on its own:** a database superuser can disable the
 *     trigger, rewrite rows *and recompute the whole chain*. Hash chaining alone cannot stop
 *     that, because whoever holds the data also holds the ability to re-derive the hashes.
 *     Detecting it needs a checkpoint held somewhere the database cannot reach, which is what
 *     `audit_chain_checkpoints.externalAnchorRef` is the seam for. No external sink is
 *     implemented at Prompt 8, so today the guarantee is "detectable by anyone holding a
 *     previously exported checkpoint" — and with no exported checkpoint, a full rewrite is
 *     undetectable. Saying otherwise would be the kind of security claim that gets believed.
 *
 * ## Why chains are per key rather than one global chain
 *
 * A single global chain would serialise every write in the system behind one lock: two
 * unrelated companies signing in at the same moment would contend. Keying the chain by tenant
 * keeps contention inside one company, and gives a tenant's export a chain that verifies on its
 * own without exposing anything about another tenant. Tenant-less rows share the `platform`
 * chain.
 *
 * The cost is that the chains do not order events *relative to each other*. That is acceptable:
 * `occurredAt` orders across chains for reading, and integrity is a per-chain property.
 */

/** The chain key used by rows that belong to no single company. */
export const PLATFORM_CHAIN_KEY = 'platform';

/**
 * Hash input format version, included in every hash.
 *
 * If the canonical form ever changes, old rows must still verify against the rules that were in
 * force when they were written — so the version travels with the data rather than living in the
 * code as an assumption. A verifier reads the version from the row and applies that format.
 */
export const AUDIT_CHAIN_VERSION = 'uboss-audit-chain-v1';

/** Which trail a chain belongs to. Kept as a literal union so a typo cannot invent a trail. */
export type TrailName = 'audit' | 'security';

export function chainKeyForTenant(tenantId: string | null | undefined): string {
  return tenantId ?? PLATFORM_CHAIN_KEY;
}

/**
 * The fields of an audit row that the hash covers.
 *
 * Everything that carries meaning is in here. Anything left out could be altered without
 * breaking the chain, so the list is the real security boundary — adding a meaningful column in
 * a later prompt means adding it here too, and `audit-chain.test.ts` asserts the field count so
 * that omission fails a test rather than passing silently.
 */
export interface AuditChainPayload {
  tenantId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  summary: string | null;
  reason: string | null;
  resourceVersion: number | null;
  resourceRef: string | null;
  correlationId: string | null;
  metadata: unknown;
  occurredAt: Date;
}

/** The equivalent for a security row. */
export interface SecurityChainPayload {
  tenantId: string | null;
  category: string;
  severity: string;
  outcome: string;
  action: string;
  actorUserId: string | null;
  subjectUserId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  reason: string | null;
  deviceLabel: string | null;
  clientHint: string | null;
  correlationId: string | null;
  metadata: unknown;
  occurredAt: Date;
}

/**
 * Deterministic JSON, with object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so the same metadata object built two different
 * ways would hash differently and a row written today could fail to verify tomorrow for no
 * reason. Sorting makes the hash a function of the *content*.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Encode the fields as one unambiguous string.
 *
 * `JSON.stringify` of an **array** is used rather than joining with a separator, because a
 * separator can appear inside a value: joining `['a|b', 'c']` and `['a', 'b|c']` with `|` gives
 * the same string, so two different rows would hash identically. JSON escaping removes that
 * whole class of problem, and the array's fixed length pins the field order.
 */
function encode(
  version: string,
  chainKey: string,
  sequence: bigint,
  prevHash: string | null,
  fields: readonly (string | null)[],
): string {
  return JSON.stringify([version, chainKey, sequence.toString(), prevHash, ...fields]);
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** The ordered field list an audit row hashes over. Exported so a test can assert its length. */
export function auditChainFields(payload: AuditChainPayload): readonly (string | null)[] {
  return [
    payload.tenantId,
    payload.action,
    payload.resourceType,
    payload.resourceId,
    payload.actorUserId,
    payload.summary,
    payload.reason,
    payload.resourceVersion === null ? null : String(payload.resourceVersion),
    payload.resourceRef,
    payload.correlationId,
    stableStringify(payload.metadata ?? null),
    payload.occurredAt.toISOString(),
  ];
}

export function auditRowHash(input: {
  chainKey: string;
  sequence: bigint;
  prevHash: string | null;
  payload: AuditChainPayload;
  version?: string;
}): string {
  return sha256Hex(
    encode(
      input.version ?? AUDIT_CHAIN_VERSION,
      input.chainKey,
      input.sequence,
      input.prevHash,
      auditChainFields(input.payload),
    ),
  );
}

/** The ordered field list a security row hashes over. */
export function securityChainFields(payload: SecurityChainPayload): readonly (string | null)[] {
  return [
    payload.tenantId,
    payload.category,
    payload.severity,
    payload.outcome,
    payload.action,
    payload.actorUserId,
    payload.subjectUserId,
    payload.resourceType,
    payload.resourceId,
    payload.reason,
    payload.deviceLabel,
    payload.clientHint,
    payload.correlationId,
    stableStringify(payload.metadata ?? null),
    payload.occurredAt.toISOString(),
  ];
}

export function securityRowHash(input: {
  chainKey: string;
  sequence: bigint;
  prevHash: string | null;
  payload: SecurityChainPayload;
  version?: string;
}): string {
  return sha256Hex(
    encode(
      input.version ?? AUDIT_CHAIN_VERSION,
      input.chainKey,
      input.sequence,
      input.prevHash,
      securityChainFields(input.payload),
    ),
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * What a verifier needs from each row: its stored position and hashes, and enough content to
 * recompute the hash independently.
 */
export interface VerifiableRow<TPayload> {
  id: string;
  chainKey: string | null;
  sequence: bigint | null;
  prevHash: string | null;
  rowHash: string | null;
  payload: TPayload;
}

/** Why a chain failed to verify. A closed set, so a caller can branch on it rather than parse text. */
export type ChainBreakKind =
  /** A row's stored hash does not match its content: the row was altered. */
  | 'content-altered'
  /** A row's `prevHash` does not match the previous row's hash: a row was removed or reordered. */
  | 'link-broken'
  /** Sequence numbers skip: a row is missing from the middle of the chain. */
  | 'sequence-gap'
  /** Two rows claim the same position. Prevented by a unique index; checked in case it is dropped. */
  | 'duplicate-sequence';

export interface ChainBreak {
  kind: ChainBreakKind;
  rowId: string;
  sequence: string | null;
  detail: string;
}

export interface ChainVerificationResult {
  chainKey: string;
  trail: TrailName;
  /** True only when every chained row verifies and the links are unbroken. */
  intact: boolean;
  /** Rows that carry chain data and were checked. */
  verifiedCount: number;
  /**
   * Rows with no chain data, which are reported rather than counted as verified.
   *
   * These are rows written before Prompt 8. They are deliberately **not** retro-chained: hashing
   * them now would produce a chain that verifies and proves nothing, because their integrity was
   * never protected in the first place. A number an operator can see is more honest than a green
   * tick that covers rows it cannot vouch for.
   */
  unchainedCount: number;
  /** The last verified position, suitable for sealing a checkpoint. */
  headSequence: string | null;
  headHash: string | null;
  breaks: ChainBreak[];
}

/**
 * Recompute a chain and report what, if anything, is wrong.
 *
 * `rows` must be **every** chained row for this key, in ascending sequence. A partial slice
 * would report a spurious `link-broken` at its first row, which is why the caller reads the
 * whole chain rather than a page of it.
 */
export function verifyChain<TPayload>(input: {
  chainKey: string;
  trail: TrailName;
  rows: readonly VerifiableRow<TPayload>[];
  hashRow: (row: {
    chainKey: string;
    sequence: bigint;
    prevHash: string | null;
    payload: TPayload;
  }) => string;
  /** A previously sealed checkpoint the chain must still agree with, if one is being carried in. */
  expectedStart?: { sequence: bigint; rowHash: string } | undefined;
}): ChainVerificationResult {
  const breaks: ChainBreak[] = [];
  const chained = input.rows.filter((row) => row.sequence !== null && row.rowHash !== null);
  const unchainedCount = input.rows.length - chained.length;

  const sorted = [...chained].sort((a, b) => {
    const left = a.sequence as bigint;
    const right = b.sequence as bigint;
    return left < right ? -1 : left > right ? 1 : 0;
  });

  let previousHash: string | null = input.expectedStart?.rowHash ?? null;
  let previousSequence: bigint | null = input.expectedStart?.sequence ?? null;
  let headHash: string | null = previousHash;
  let headSequence: bigint | null = previousSequence;

  for (const row of sorted) {
    const sequence = row.sequence as bigint;

    if (previousSequence !== null) {
      if (sequence === previousSequence) {
        breaks.push({
          kind: 'duplicate-sequence',
          rowId: row.id,
          sequence: sequence.toString(),
          detail: `Two rows claim position ${sequence}. The chain cannot be ordered.`,
        });
        continue;
      }
      if (sequence !== previousSequence + 1n) {
        breaks.push({
          kind: 'sequence-gap',
          rowId: row.id,
          sequence: sequence.toString(),
          detail:
            `Position ${sequence} follows ${previousSequence}: ` +
            `${sequence - previousSequence - 1n} row(s) are missing.`,
        });
      }
    }

    // The link is checked before the content, because a broken link is the more specific finding:
    // if a row was removed, the following row's content is intact and only its link is wrong.
    if (row.prevHash !== previousHash) {
      breaks.push({
        kind: 'link-broken',
        rowId: row.id,
        sequence: sequence.toString(),
        detail:
          `Row at position ${sequence} expects predecessor hash ` +
          `${row.prevHash ?? '(none)'} but the chain gives ${previousHash ?? '(none)'}.`,
      });
    }

    const recomputed = input.hashRow({
      chainKey: row.chainKey ?? input.chainKey,
      sequence,
      prevHash: row.prevHash,
      payload: row.payload,
    });

    if (recomputed !== row.rowHash) {
      breaks.push({
        kind: 'content-altered',
        rowId: row.id,
        sequence: sequence.toString(),
        detail:
          `Row at position ${sequence} stores hash ${String(row.rowHash).slice(0, 16)}… but its ` +
          `content hashes to ${recomputed.slice(0, 16)}…. The row was altered after it was written.`,
      });
    }

    // Continue from what the row actually stores, not from the recomputed value: the goal is to
    // find every break, and re-deriving from a corrected hash would report one break as many.
    previousHash = row.rowHash;
    previousSequence = sequence;
    headHash = row.rowHash;
    headSequence = sequence;
  }

  return {
    chainKey: input.chainKey,
    trail: input.trail,
    intact: breaks.length === 0,
    verifiedCount: sorted.length,
    unchainedCount,
    headSequence: headSequence === null ? null : headSequence.toString(),
    headHash,
    breaks,
  };
}

/**
 * A stable 63-bit key for `pg_advisory_xact_lock`, derived from the trail and chain key.
 *
 * PostgreSQL advisory locks take a bigint rather than a string, so the chain key is hashed into
 * one. A collision between two chain keys would only mean two chains briefly serialising behind
 * the same lock — slower, never incorrect — so a 63-bit truncation of SHA-256 is ample.
 */
export function chainLockKey(trail: TrailName, chainKey: string): bigint {
  const digest = createHash('sha256').update(`${trail}:${chainKey}`, 'utf8').digest();
  // Clear the top bit so the value is always a positive signed bigint.
  return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & 0x7fff_ffff_ffff_ffffn;
}
