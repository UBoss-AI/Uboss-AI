import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DATA_CLASSIFICATIONS } from './classification.js';
import {
  ALWAYS_REFUSED_EXTENSIONS,
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_EXPORT_CEILING,
  DEFAULT_EXTERNAL_EGRESS_CEILING,
  DEFAULT_KNOWLEDGE_ACCESS_SCOPE,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_UPLOAD_POLICY,
  FILE_SCAN_STATE_DESCRIPTIONS,
  FILE_SCAN_STATE_LABELS,
  FILE_SCAN_STATES,
  MAX_RETENTION_DAYS,
  REDACTION_STANCE,
  RETENTION_ACTIONS,
  decideDeletion,
  decideEgress,
  decideKnowledgeRead,
  fileIsUsable,
  filesDueForRetention,
  mayMoveKnowledgeSource,
  mayMoveScan,
  onlyCleanFilesAreUsable,
  retentionExpiry,
  retentionProblems,
  uploadProblems,
  type KnowledgeReadRequest,
} from './knowledge.js';

const upload = (overrides: Partial<Parameters<typeof uploadProblems>[0]> = {}) => ({
  filename: 'supplier-contract.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2 * 1024 * 1024,
  ...overrides,
});

const read = (overrides: Partial<KnowledgeReadRequest> = {}): KnowledgeReadRequest => ({
  sourceState: 'Approved',
  sourceScope: 'WholeCompany',
  namedAgentIds: [],
  sourceDepartmentId: 'dept-1',
  sourceClassification: 'Internal',
  engineAgentId: 'agent-1',
  askingDepartmentId: 'dept-1',
  agentClassificationCeiling: 'Confidential',
  ...overrides,
});

describe('the scanning workflow', () => {
  it('has the five states, including one for a scan that did not finish', () => {
    // `Quarantined` is separate from `Infected` on purpose: collapsing them would either release
    // unscanned files or accuse clean ones.
    assert.deepEqual(
      [...FILE_SCAN_STATES],
      ['Pending', 'Scanning', 'Clean', 'Infected', 'Quarantined'],
    );
  });

  it('labels and explains every state', () => {
    for (const state of FILE_SCAN_STATES) {
      assert.ok(FILE_SCAN_STATE_LABELS[state].length > 0, state);
      assert.ok(FILE_SCAN_STATE_DESCRIPTIONS[state].length > 0, state);
    }
  });

  it('lets nothing but a clean file be used', () => {
    // §22's "before use" rule, and the one question in this module where a wrong answer is a data
    // incident.
    assert.equal(fileIsUsable('Clean'), true);
    for (const state of FILE_SCAN_STATES.filter((candidate) => candidate !== 'Clean')) {
      assert.equal(fileIsUsable(state), false, state);
    }
    assert.equal(onlyCleanFilesAreUsable(), true);
  });

  it('does not release a pending file', () => {
    // The state an upload starts in. If this were usable, every upload would be readable before
    // it had been looked at.
    assert.equal(fileIsUsable('Pending'), false);
  });

  it('walks Pending → Scanning → an outcome', () => {
    assert.equal(mayMoveScan('Pending', 'Scanning'), true);
    assert.equal(mayMoveScan('Scanning', 'Clean'), true);
    assert.equal(mayMoveScan('Scanning', 'Infected'), true);
    assert.equal(mayMoveScan('Scanning', 'Quarantined'), true);
  });

  it('refuses to move a file straight to clean without scanning it', () => {
    assert.equal(mayMoveScan('Pending', 'Clean'), false);
  });

  it('keeps an infected file terminal', () => {
    // An infected file is deleted, not cleared.
    for (const state of FILE_SCAN_STATES) {
      assert.equal(mayMoveScan('Infected', state), false, state);
    }
  });

  it('keeps a clean file terminal too', () => {
    // Re-scanning on a schedule is a different subject; this workflow decides once.
    for (const state of FILE_SCAN_STATES) {
      assert.equal(mayMoveScan('Clean', state), false, state);
    }
  });

  it('lets a quarantined file be scanned again', () => {
    // Nothing was ever determined about it, so there is something to determine.
    assert.equal(mayMoveScan('Quarantined', 'Scanning'), true);
    assert.equal(mayMoveScan('Quarantined', 'Clean'), false);
  });
});

describe('upload validation', () => {
  it('accepts an ordinary document', () => {
    assert.deepEqual(uploadProblems(upload(), DEFAULT_UPLOAD_POLICY), []);
  });

  it('refuses an executable whatever it claims to be', () => {
    // The content type is supplied by the uploader and is therefore a claim, not a fact.
    const problems = uploadProblems(
      upload({ filename: 'invoice.exe', contentType: 'text/plain' }),
      DEFAULT_UPLOAD_POLICY,
    );
    assert.ok(problems.some((problem) => /does not accept \.exe/.test(problem)));
  });

  it('refuses every extension on the always-refused list', () => {
    for (const extension of ALWAYS_REFUSED_EXTENSIONS) {
      const problems = uploadProblems(
        upload({ filename: `thing${extension}`, contentType: 'application/pdf' }),
        DEFAULT_UPLOAD_POLICY,
      );
      assert.ok(problems.length > 0, extension);
    }
  });

  it('refuses a filename containing a path', () => {
    // Either a mistake or an attempt to write outside the intended prefix, and neither should be
    // quietly corrected.
    for (const filename of ['../etc/passwd', 'a/b.pdf', 'a\\b.pdf', '..pdf.pdf']) {
      const problems = uploadProblems(upload({ filename }), DEFAULT_UPLOAD_POLICY);
      assert.ok(problems.length > 0, filename);
    }
  });

  it('refuses a content type that is not on the allowlist', () => {
    // An allowlist, not a blocklist: a blocklist is a list of the attacks somebody thought of.
    const problems = uploadProblems(
      upload({ contentType: 'application/x-msdownload' }),
      DEFAULT_UPLOAD_POLICY,
    );
    assert.ok(problems.some((problem) => /not an accepted file type/.test(problem)));
  });

  it('accepts no archive format by default', () => {
    // A scanner that unpacks archives has a much larger attack surface.
    for (const type of ['application/zip', 'application/x-tar', 'application/gzip']) {
      assert.equal(DEFAULT_ALLOWED_CONTENT_TYPES.includes(type), false, type);
    }
  });

  it('refuses a file over the limit and says both figures', () => {
    const problems = uploadProblems(
      upload({ sizeBytes: DEFAULT_MAX_UPLOAD_BYTES + 1 }),
      DEFAULT_UPLOAD_POLICY,
    );
    assert.ok(problems.some((problem) => /The limit is 50 MB/.test(problem)));
  });

  it('refuses a zero-byte or fractional size', () => {
    assert.ok(uploadProblems(upload({ sizeBytes: 0 }), DEFAULT_UPLOAD_POLICY).length > 0);
    assert.ok(uploadProblems(upload({ sizeBytes: 1.5 }), DEFAULT_UPLOAD_POLICY).length > 0);
  });

  it('reports every problem at once', () => {
    // So somebody fixing a rejected upload does not discover the size limit after fixing the type.
    const problems = uploadProblems(
      upload({ filename: 'x.exe', contentType: 'application/zip', sizeBytes: 10 ** 9 }),
      DEFAULT_UPLOAD_POLICY,
    );
    assert.ok(problems.length >= 3);
  });
});

describe('retention, legal hold and deletion', () => {
  const now = new Date('2026-09-11T00:00:00.000Z');

  it('keeps files indefinitely by default', () => {
    // Deleting a company's documents on a schedule nobody set is the most damaging possible
    // default.
    assert.equal(DEFAULT_RETENTION_POLICY.retentionDays, null);
    assert.equal(DEFAULT_RETENTION_POLICY.action, 'DeleteContent');
  });

  it('defaults to keeping the record of a deletion', () => {
    // So "was our data deleted?" stays answerable.
    assert.ok(RETENTION_ACTIONS.includes('DeleteRecord'));
    assert.notEqual(DEFAULT_RETENTION_POLICY.action, 'DeleteRecord');
  });

  it('computes an expiry from the upload date', () => {
    const expiry = retentionExpiry({ retentionDays: 30, action: 'DeleteContent' }, now);
    assert.equal(expiry?.toISOString(), '2026-10-11T00:00:00.000Z');
  });

  it('has no expiry when retention is unset', () => {
    assert.equal(retentionExpiry(DEFAULT_RETENTION_POLICY, now), null);
  });

  it('refuses a retention longer than ten years', () => {
    const problems = retentionProblems({
      retentionDays: MAX_RETENTION_DAYS + 1,
      action: 'DeleteContent',
    });
    assert.ok(problems.some((problem) => /cannot exceed/.test(problem)));
  });

  it('refuses a zero or fractional retention', () => {
    assert.ok(retentionProblems({ retentionDays: 0, action: 'DeleteContent' }).length > 0);
    assert.ok(retentionProblems({ retentionDays: 1.5, action: 'DeleteContent' }).length > 0);
  });

  it('lets an ordinary file be deleted', () => {
    assert.deepEqual(
      decideDeletion({ onLegalHold: false, legalHoldReason: null, alreadyDeleted: false }),
      { mayDelete: true },
    );
  });

  it('lets a legal hold beat everything', () => {
    // The entire purpose of a legal hold: it stops a deletion every other rule would permit.
    const decision = decideDeletion({
      onLegalHold: true,
      legalHoldReason: 'Held for the Acme dispute.',
      alreadyDeleted: false,
    });
    assert.equal(decision.mayDelete, false);
    if (decision.mayDelete) return;
    assert.match(decision.reason, /not by retention, and not by request/);
    assert.match(decision.reason, /Acme dispute/);
  });

  it('refuses a second deletion', () => {
    const decision = decideDeletion({
      onLegalHold: false,
      legalHoldReason: null,
      alreadyDeleted: true,
    });
    assert.equal(decision.mayDelete, false);
  });

  it('sweeps only what has expired and is not held', () => {
    const ids = filesDueForRetention(
      [
        { id: 'due', retentionExpiresAt: new Date(now.getTime() - 1), onLegalHold: false, deletedAt: null },
        { id: 'held', retentionExpiresAt: new Date(now.getTime() - 1), onLegalHold: true, deletedAt: null },
        { id: 'later', retentionExpiresAt: new Date(now.getTime() + 1), onLegalHold: false, deletedAt: null },
        { id: 'forever', retentionExpiresAt: null, onLegalHold: false, deletedAt: null },
        { id: 'gone', retentionExpiresAt: new Date(now.getTime() - 1), onLegalHold: false, deletedAt: now },
      ],
      now,
    );
    assert.deepEqual(ids, ['due']);
  });
});

describe('knowledge sources', () => {
  it('consults nothing that has not been approved', () => {
    // "Approved knowledge sources" is a requirement, not a description.
    const decision = decideKnowledgeRead(read({ sourceState: 'Draft' }));
    assert.equal(decision.permitted, false);
    if (decision.permitted) return;
    assert.match(decision.reason, /nobody agreed to/);
  });

  it('says when a source has been retired rather than never approved', () => {
    const decision = decideKnowledgeRead(read({ sourceState: 'Retired' }));
    assert.equal(decision.permitted, false);
    if (decision.permitted) return;
    assert.match(decision.reason, /retired/);
  });

  it('defaults a new source to the strictest scope', () => {
    // A source is consulted by nothing until somebody says so.
    assert.equal(DEFAULT_KNOWLEDGE_ACCESS_SCOPE, 'NamedAgentsOnly');
  });

  it('lets only a named agent read a named-agents source', () => {
    const scoped = read({ sourceScope: 'NamedAgentsOnly', namedAgentIds: ['agent-1'] });
    assert.deepEqual(decideKnowledgeRead(scoped), { permitted: true });

    const other = decideKnowledgeRead({ ...scoped, engineAgentId: 'agent-2' });
    assert.equal(other.permitted, false);
  });

  it('refuses a person on a named-agents source', () => {
    const decision = decideKnowledgeRead(
      read({ sourceScope: 'NamedAgentsOnly', namedAgentIds: ['agent-1'], engineAgentId: null }),
    );
    assert.equal(decision.permitted, false);
    if (decision.permitted) return;
    assert.match(decision.reason, /no agent is asking/);
  });

  it('confines a department source to its department', () => {
    const scoped = read({ sourceScope: 'Department' });
    assert.deepEqual(decideKnowledgeRead(scoped), { permitted: true });
    assert.equal(
      decideKnowledgeRead({ ...scoped, askingDepartmentId: 'dept-2' }).permitted,
      false,
    );
  });

  it('never treats two nulls as the same department', () => {
    // Treating null as a matching value turns a scoped read into a company-wide one.
    const decision = decideKnowledgeRead(
      read({ sourceScope: 'Department', sourceDepartmentId: null, askingDepartmentId: null }),
    );
    assert.equal(decision.permitted, false);
  });

  it('refuses a source above the agent’s tool-policy ceiling', () => {
    // §35's third condition: classification, judged against the agent's own tool policy.
    const decision = decideKnowledgeRead(
      read({ sourceClassification: 'Restricted', agentClassificationCeiling: 'Confidential' }),
    );
    assert.equal(decision.permitted, false);
    if (decision.permitted) return;
    assert.match(decision.reason, /deliberate decision somebody has to make/);
  });

  it('applies no agent ceiling when a person is asking', () => {
    // A person's limit is their role and scope, not an agent tool grant.
    assert.deepEqual(
      decideKnowledgeRead(
        read({
          sourceScope: 'WholeCompany',
          engineAgentId: null,
          sourceClassification: 'Restricted',
          agentClassificationCeiling: null,
        }),
      ),
      { permitted: true },
    );
  });

  it('moves Draft → Approved → Retired, and back to draft to change it', () => {
    assert.equal(mayMoveKnowledgeSource('Draft', 'Approved'), true);
    assert.equal(mayMoveKnowledgeSource('Approved', 'Draft'), true);
    assert.equal(mayMoveKnowledgeSource('Approved', 'Retired'), true);
    // Terminal: a retired source is not revived, because its approval was of a scope and a
    // classification that may no longer hold.
    assert.equal(mayMoveKnowledgeSource('Retired', 'Approved'), false);
  });
});

describe('export and external egress', () => {
  it('lets nothing above Internal leave the company by default', () => {
    // The strictest default here, and the one worth defending: too strict costs a settings
    // change, too loose costs a confidential document in somebody else's system.
    assert.equal(DEFAULT_EXTERNAL_EGRESS_CEILING, 'Internal');
    assert.equal(DEFAULT_EXPORT_CEILING, 'Confidential');
  });

  it('refuses content above the ceiling, and says what would change it', () => {
    const decision = decideEgress({
      classification: 'Restricted',
      ceiling: 'Internal',
      leavesTheCompany: true,
    });
    assert.equal(decision.permitted, false);
    if (decision.permitted) return;
    assert.match(decision.reason, /settings decision, not something a run can do/);
  });

  it('requires redaction for sensitive content that is permitted to leave', () => {
    // The permission and the treatment are different questions. Answering only the first is how
    // a confidential document leaves intact because somebody was allowed to send it.
    const decision = decideEgress({
      classification: 'Confidential',
      ceiling: 'Confidential',
      leavesTheCompany: true,
    });
    assert.equal(decision.permitted, true);
    if (!decision.permitted) return;
    assert.equal(decision.redactionRequired, true);
  });

  it('requires no redaction for an internal export', () => {
    const decision = decideEgress({
      classification: 'Confidential',
      ceiling: 'Confidential',
      leavesTheCompany: false,
    });
    assert.equal(decision.permitted, true);
    if (!decision.permitted) return;
    assert.equal(decision.redactionRequired, false);
  });

  it('requires no redaction for content that is not sensitive', () => {
    for (const classification of ['Public', 'Internal'] as const) {
      const decision = decideEgress({
        classification,
        ceiling: 'Internal',
        leavesTheCompany: true,
      });
      assert.equal(decision.permitted, true);
      if (!decision.permitted) continue;
      assert.equal(decision.redactionRequired, false, classification);
    }
  });

  it('says plainly that UBoss does not redact', () => {
    // §22 asks for hooks. A product that implied it redacted would be claiming work nobody did.
    assert.match(REDACTION_STANCE, /It does not redact/);
    assert.match(REDACTION_STANCE, /refused rather than sent unredacted/);
  });

  it('uses the shared classification order rather than its own', () => {
    // The ceilings are comparisons against `classification.ts`, so a reordering there cannot
    // leave this module disagreeing about what is stricter.
    assert.ok((DATA_CLASSIFICATIONS as readonly string[]).includes(DEFAULT_EXPORT_CEILING));
    assert.ok(
      (DATA_CLASSIFICATIONS as readonly string[]).includes(DEFAULT_EXTERNAL_EGRESS_CEILING),
    );
  });
});

describe('what this module does not build', () => {
  it('exposes nothing resembling a shared vector store', async () => {
    // §35: "Do not build unrestricted vector-memory sharing." Asserted as an absence, so a later
    // prompt adding an embedding index has to come past this test.
    const module = (await import('./knowledge.js')) as Record<string, unknown>;
    const suspicious = Object.keys(module).filter((name) =>
      /vector|embedding|similarity|semanticIndex/i.test(name),
    );
    assert.deepEqual(suspicious, []);
  });
});
