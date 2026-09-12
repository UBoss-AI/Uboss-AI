import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUDIT_CHAIN_VERSION,
  PLATFORM_CHAIN_KEY,
  auditChainFields,
  auditRowHash,
  chainKeyForTenant,
  chainLockKey,
  securityChainFields,
  securityRowHash,
  stableStringify,
  verifyChain,
  type AuditChainPayload,
  type VerifiableRow,
} from '../src/audit/audit-chain.js';

/**
 * The tamper-evidence primitive, tested without a database.
 *
 * These are the tests that decide whether the guarantee in ADR-046 is real. A hash chain that
 * *looks* right but does not cover a field, or verifies a reordered chain, is worse than no chain
 * at all — it produces a confident green tick over tampered data. So the negatives here are the
 * point, and each one describes the specific attack it rules out.
 */

const BASE: AuditChainPayload = {
  tenantId: '018f0000-0000-7000-8000-000000000001',
  action: 'objective.published',
  resourceType: 'objective',
  resourceId: 'obj-1',
  actorUserId: '018f0000-0000-7000-8000-0000000000aa',
  summary: 'Published V2.',
  reason: 'Approved at the Monday review.',
  resourceVersion: 2,
  resourceRef: 'V2',
  correlationId: 'corr-1',
  metadata: { channel: 'web' },
  occurredAt: new Date('2026-09-08T10:00:00.000Z'),
};

/** Build a chain of `count` rows, each hashed over the previous one. */
function buildChain(count: number, chainKey = 'chain-a'): VerifiableRow<AuditChainPayload>[] {
  const rows: VerifiableRow<AuditChainPayload>[] = [];
  let prevHash: string | null = null;

  for (let index = 0; index < count; index += 1) {
    const sequence = BigInt(index + 1);
    const payload: AuditChainPayload = {
      ...BASE,
      resourceId: `obj-${index + 1}`,
      occurredAt: new Date(BASE.occurredAt.getTime() + index * 1_000),
    };
    const rowHash = auditRowHash({ chainKey, sequence, prevHash, payload });
    rows.push({ id: `row-${index + 1}`, chainKey, sequence, prevHash, rowHash, payload });
    prevHash = rowHash;
  }
  return rows;
}

const verify = (rows: readonly VerifiableRow<AuditChainPayload>[], chainKey = 'chain-a') =>
  verifyChain({ chainKey, trail: 'audit', rows, hashRow: (row) => auditRowHash(row) });

describe('audit chain — hashing', () => {
  it('is deterministic for the same content', () => {
    const a = auditRowHash({ chainKey: 'c', sequence: 1n, prevHash: null, payload: BASE });
    const b = auditRowHash({ chainKey: 'c', sequence: 1n, prevHash: null, payload: BASE });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('changes when any covered field changes', () => {
    // The real test of a hash chain: enumerate every field and prove each one is covered. A
    // field the hash ignores can be edited without breaking the chain, which is the whole
    // failure mode this design exists to prevent.
    const baseline = auditRowHash({ chainKey: 'c', sequence: 1n, prevHash: null, payload: BASE });

    const mutations: Partial<AuditChainPayload>[] = [
      { tenantId: '018f0000-0000-7000-8000-000000000002' },
      { action: 'objective.unpublished' },
      { resourceType: 'agent' },
      { resourceId: 'obj-2' },
      { actorUserId: '018f0000-0000-7000-8000-0000000000bb' },
      { summary: 'Published V3.' },
      { reason: 'No reason given.' },
      { resourceVersion: 3 },
      { resourceRef: 'V3' },
      { correlationId: 'corr-2' },
      { metadata: { channel: 'api' } },
      { occurredAt: new Date('2026-09-08T10:00:01.000Z') },
    ];

    // Every field in the payload must appear above, or a new column could be added without
    // being covered and this suite would still pass.
    assert.equal(
      mutations.length,
      auditChainFields(BASE).length,
      'Every hashed field needs a mutation case here. A new column added to AuditChainPayload ' +
        'without one would be editable without breaking the chain.',
    );

    for (const mutation of mutations) {
      const hash = auditRowHash({
        chainKey: 'c',
        sequence: 1n,
        prevHash: null,
        payload: { ...BASE, ...mutation },
      });
      assert.notEqual(
        hash,
        baseline,
        `Changing ${Object.keys(mutation)[0]} did not change the hash.`,
      );
    }
  });

  it('covers the position and the link, not only the content', () => {
    const content = auditRowHash({ chainKey: 'c', sequence: 1n, prevHash: null, payload: BASE });
    const moved = auditRowHash({ chainKey: 'c', sequence: 2n, prevHash: null, payload: BASE });
    const relinked = auditRowHash({ chainKey: 'c', sequence: 1n, prevHash: 'ff', payload: BASE });
    const otherChain = auditRowHash({ chainKey: 'd', sequence: 1n, prevHash: null, payload: BASE });

    assert.notEqual(moved, content, 'Sequence must be part of the hash, or a row could be moved.');
    assert.notEqual(relinked, content, 'prevHash must be part of the hash.');
    assert.notEqual(
      otherChain,
      content,
      'The chain key must be part of the hash, or a row could be transplanted between chains.',
    );
  });

  it('includes the format version, so a future format change cannot silently reinterpret old rows', () => {
    const current = auditRowHash({ chainKey: 'c', sequence: 1n, prevHash: null, payload: BASE });
    const future = auditRowHash({
      chainKey: 'c',
      sequence: 1n,
      prevHash: null,
      payload: BASE,
      version: 'uboss-audit-chain-v2',
    });
    assert.notEqual(current, future);
    assert.equal(AUDIT_CHAIN_VERSION, 'uboss-audit-chain-v1');
  });

  it('hashes metadata by content, not by key order', () => {
    const a = auditRowHash({
      chainKey: 'c',
      sequence: 1n,
      prevHash: null,
      payload: { ...BASE, metadata: { alpha: 1, beta: 2 } },
    });
    const b = auditRowHash({
      chainKey: 'c',
      sequence: 1n,
      prevHash: null,
      payload: { ...BASE, metadata: { beta: 2, alpha: 1 } },
    });
    // Without stable stringification the same metadata built in a different order would fail to
    // verify later, and a false "tampered" is as damaging as a false "intact".
    assert.equal(a, b);
  });

  it('cannot be fooled by moving a delimiter between fields', () => {
    // Joining fields with a separator would make these two rows hash identically, because the
    // separator appears inside a value. JSON encoding is what rules this out.
    const left = auditRowHash({
      chainKey: 'c',
      sequence: 1n,
      prevHash: null,
      payload: { ...BASE, summary: 'a', reason: 'b|c' },
    });
    const right = auditRowHash({
      chainKey: 'c',
      sequence: 1n,
      prevHash: null,
      payload: { ...BASE, summary: 'a|b', reason: 'c' },
    });
    assert.notEqual(left, right);
  });

  it('sorts nested object keys at every depth', () => {
    assert.equal(
      stableStringify({ b: { d: 1, c: 2 }, a: [3, { f: 4, e: 5 }] }),
      '{"a":[3,{"e":5,"f":4}],"b":{"c":2,"d":1}}',
    );
  });

  it('hashes the security payload over its own full field list', () => {
    const payload = {
      tenantId: null,
      category: 'Login',
      severity: 'Notice',
      outcome: 'Failed',
      action: 'security.login_failed',
      actorUserId: null,
      subjectUserId: null,
      resourceType: 'session',
      resourceId: null,
      reason: 'Wrong password.',
      deviceLabel: 'Chrome on Windows',
      clientHint: '203.0.113.x',
      correlationId: 'corr-9',
      metadata: null,
      occurredAt: new Date('2026-09-08T11:00:00.000Z'),
    };
    assert.equal(securityChainFields(payload).length, 15);

    const baseline = securityRowHash({
      chainKey: PLATFORM_CHAIN_KEY,
      sequence: 1n,
      prevHash: null,
      payload,
    });
    const escalated = securityRowHash({
      chainKey: PLATFORM_CHAIN_KEY,
      sequence: 1n,
      prevHash: null,
      payload: { ...payload, outcome: 'Succeeded' },
    });
    // Turning a failed sign-in into a successful one is the single most valuable edit an
    // attacker could make to this trail, so it must break the hash.
    assert.notEqual(escalated, baseline);
  });
});

describe('audit chain — verification', () => {
  it('accepts an intact chain and reports its head', () => {
    const rows = buildChain(5);
    const result = verify(rows);

    assert.equal(result.intact, true);
    assert.equal(result.breaks.length, 0);
    assert.equal(result.verifiedCount, 5);
    assert.equal(result.headSequence, '5');
    assert.equal(result.headHash, rows[4]?.rowHash);
  });

  it('accepts an empty chain', () => {
    const result = verify([]);
    assert.equal(result.intact, true);
    assert.equal(result.headSequence, null);
  });

  it('detects an altered row', () => {
    const rows = buildChain(4);
    // Edit the content and leave the stored hash alone — what an UPDATE would do.
    rows[1] = { ...rows[1]!, payload: { ...rows[1]!.payload, summary: 'Quietly rewritten.' } };

    const result = verify(rows);
    assert.equal(result.intact, false);
    const altered = result.breaks.find((b) => b.kind === 'content-altered');
    assert.ok(altered, 'A modified row must be reported as content-altered.');
    assert.equal(altered.rowId, 'row-2');
  });

  it('detects a deleted row', () => {
    const rows = buildChain(4);
    const without = [rows[0]!, rows[2]!, rows[3]!];

    const result = verify(without);
    assert.equal(result.intact, false);
    assert.ok(
      result.breaks.some((b) => b.kind === 'sequence-gap'),
      'A missing row must leave a sequence gap.',
    );
    assert.ok(
      result.breaks.some((b) => b.kind === 'link-broken'),
      'A missing row must also break the link of the row that followed it.',
    );
  });

  it('detects a reordered chain', () => {
    // Swapping the *stored positions* of two rows: the rows are unchanged, only their claimed
    // order is. A chain that only checked content hashes would pass this.
    const rows = buildChain(4);
    const swapped = [
      rows[0]!,
      { ...rows[2]!, sequence: 2n },
      { ...rows[1]!, sequence: 3n },
      rows[3]!,
    ];

    const result = verify(swapped);
    assert.equal(result.intact, false);
    assert.ok(result.breaks.some((b) => b.kind === 'link-broken' || b.kind === 'content-altered'));
  });

  it('detects a row appended with a recomputed hash but the wrong predecessor', () => {
    // The most sophisticated single-row attack: an attacker inserts a row and hashes it
    // correctly for its own content, but cannot make the *following* row's stored prevHash
    // point at it without rewriting that row too — which is the property the chain buys.
    const rows = buildChain(3);
    const forged: VerifiableRow<AuditChainPayload> = {
      id: 'forged',
      chainKey: 'chain-a',
      sequence: 2n,
      prevHash: rows[0]!.rowHash,
      rowHash: auditRowHash({
        chainKey: 'chain-a',
        sequence: 2n,
        prevHash: rows[0]!.rowHash,
        payload: { ...BASE, summary: 'Forged but self-consistent.' },
      }),
      payload: { ...BASE, summary: 'Forged but self-consistent.' },
    };
    const tampered = [rows[0]!, forged, { ...rows[2]! }];

    const result = verify(tampered);
    assert.equal(result.intact, false, 'A self-consistent forgery must still break the chain.');
  });

  it('detects two rows claiming the same position', () => {
    const rows = buildChain(3);
    const duplicated = [rows[0]!, rows[1]!, { ...rows[2]!, sequence: 2n }];

    const result = verify(duplicated);
    assert.equal(result.intact, false);
    assert.ok(result.breaks.some((b) => b.kind === 'duplicate-sequence'));
  });

  it('reports unchained rows instead of counting them as verified', () => {
    // Rows written before Prompt 8. They must be visible in the result, not silently dropped:
    // a green tick that covers 3 rows out of 5 without saying so is a false assurance.
    const rows = buildChain(3);
    const legacy: VerifiableRow<AuditChainPayload> = {
      id: 'legacy',
      chainKey: null,
      sequence: null,
      prevHash: null,
      rowHash: null,
      payload: BASE,
    };

    const result = verify([legacy, ...rows]);
    assert.equal(result.intact, true);
    assert.equal(result.verifiedCount, 3);
    assert.equal(result.unchainedCount, 1);
  });

  it('honours a sealed checkpoint as the expected starting point', () => {
    const rows = buildChain(5);
    const fromCheckpoint = rows.slice(2);

    // Verifying the tail alone reports a broken link, because the verifier cannot know what came
    // before it...
    const blind = verify(fromCheckpoint);
    assert.equal(blind.intact, false);

    // ...unless a checkpoint tells it. This is what makes a partial verification meaningful, and
    // why a growing chain is verified from a checkpoint rather than in pages.
    const anchored = verifyChain({
      chainKey: 'chain-a',
      trail: 'audit',
      rows: fromCheckpoint,
      hashRow: (row) => auditRowHash(row),
      expectedStart: { sequence: 2n, rowHash: rows[1]!.rowHash as string },
    });
    assert.equal(anchored.intact, true);
    assert.equal(anchored.headSequence, '5');
  });

  it('reports a checkpoint that no longer matches the chain', () => {
    // The case an external anchor is *for*: the rows verify against each other perfectly, and
    // disagree with a checkpoint taken earlier. Nothing inside the chain can detect a wholesale
    // rewrite; a checkpoint can.
    const rewritten = buildChain(5);
    const result = verifyChain({
      chainKey: 'chain-a',
      trail: 'audit',
      rows: rewritten.slice(2),
      hashRow: (row) => auditRowHash(row),
      expectedStart: { sequence: 2n, rowHash: 'a'.repeat(64) },
    });
    assert.equal(result.intact, false);
    assert.ok(result.breaks.some((b) => b.kind === 'link-broken'));
  });
});

describe('audit chain — keys and locks', () => {
  it('maps a tenant to its own chain and a tenant-less row to the platform chain', () => {
    assert.equal(chainKeyForTenant('t1'), 't1');
    assert.equal(chainKeyForTenant(null), PLATFORM_CHAIN_KEY);
    assert.equal(chainKeyForTenant(undefined), PLATFORM_CHAIN_KEY);
  });

  it('derives a stable, positive lock key that differs per trail and per chain', () => {
    const a = chainLockKey('audit', 't1');
    const b = chainLockKey('audit', 't1');
    assert.equal(a, b, 'The lock key must be stable, or two appends would not serialise.');
    assert.notEqual(chainLockKey('security', 't1'), a, 'Trails must not share a lock.');
    assert.notEqual(chainLockKey('audit', 't2'), a, 'Two companies must not share a lock.');

    // pg_advisory_xact_lock takes a signed bigint, so a negative value would be a runtime error
    // on whichever chain key happened to hash with the top bit set.
    for (const key of ['t1', 't2', 'platform', '', 'x'.repeat(64)]) {
      assert.ok(chainLockKey('audit', key) >= 0n, `Lock key for "${key}" must be positive.`);
      assert.ok(chainLockKey('audit', key) <= 0x7fff_ffff_ffff_ffffn);
    }
  });
});
