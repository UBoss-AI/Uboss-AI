import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Every read of an unbounded table names its tenant — Prompt 43.
 *
 * ## Why this is a performance rule with a correctness-shaped name
 *
 * Row-Level Security already confines these queries. Naming `tenantId` in the `where` changes no
 * result: the predicate is redundant by construction and can only match rows the policy would have
 * allowed. So this test is not about correctness, and RLS is not being second-guessed.
 *
 * It is about what the **planner** can see. The policy reads
 *
 *     tenant_id = current_setting('app.current_tenant_id') OR current_setting('app.platform_operation') = 'on'
 *
 * and PostgreSQL cannot use a `tenant_id`-prefixed index for an OR whose other branch does not
 * mention that column. **Every index on `objective_versions`, `employment_records` and
 * `audit_events` is tenant-prefixed**, so a query that leaves the tenant to RLS can use none of
 * them and degrades to a sequential scan over every company's rows.
 *
 * Measured on 1,000,000 audit events across twenty companies: the same audit page costs hundreds of
 * milliseconds relying on RLS alone and a few with the tenant named — roughly **100x**, stable
 * across runs even though the absolute figures are not. Both return identical rows.
 *
 * ## Why a scan and not a benchmark
 *
 * A benchmark would have to seed a large database to assert this, which takes half a minute and
 * belongs in `scripts/perf`. The invariant is a property of the source, and a scan is the cheap,
 * non-flaky way to hold it — provided it is shown to bite, which the last test here does.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The source tree, found by walking up — this spec runs from `dist-test/test`. */
function findSourceTree(): string {
  const marker = path.join('src', 'persistence', 'audit-event.repository.ts');
  let dir = here;
  for (let up = 0; up < 6; up += 1) {
    try {
      readFileSync(path.join(dir, marker));
      return path.join(dir, 'src');
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error(`could not find the API source tree from ${here}`);
}

const SRC = findSourceTree();

/** Prisma models whose tables grow for as long as a company exists. */
const UNBOUNDED_MODELS = [
  'auditEvent',
  'auditTrailEntry',
  'notification',
  'agentRun',
  'agentRunEvent',
  'employmentRecord',
  'objectiveVersion',
  'chatMessage',
  'securityEvent',
  'aiOutputFeedback',
  'memoryRecord',
] as const;

/**
 * Reads that are allowed to omit the tenant, each for a stated reason.
 *
 * Kept as an explicit list rather than a looser pattern, so adding to it is a decision somebody
 * makes and a reviewer sees.
 */
const PERMITTED = [
  {
    against: 'call',
    match: /where:\s*\{\s*id:/,
    why: 'A primary-key lookup is an index scan whatever the tenant predicate says.',
  },
  {
    against: 'call',
    match: /where:\s*\{\s*chainKey/,
    why: 'The hash chain has its own unique index on (chain_key, sequence).',
  },
  {
    // Read from the surrounding function, because the wrapper is what makes it deliberate.
    against: 'context',
    match: /runAsPlatformOperation/,
    why: 'A deliberate platform-plane read across companies, such as the escalation sweep.',
  },
  {
    against: 'call',
    match: /\.\.\.where/,
    why: 'The tenant is in the spread base. Checked by reading the base, not by this scan.',
  },
] as const;

interface Read {
  file: string;
  line: number;
  model: string;
  method: string;
  call: string;
  /** The whole enclosing function, so a `runAsPlatformOperation` wrapper is visible. */
  context: string;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'generated') continue;
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** Every read of an unbounded model, with its argument object taken by brace balance. */
function unboundedReads(): Read[] {
  const reads: Read[] = [];

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');

    for (const model of UNBOUNDED_MODELS) {
      const pattern = new RegExp(
        `client\\.${model}\\.(findMany|findFirst|findUnique|count|aggregate|groupBy)\\(`,
        'g',
      );

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        let depth = 0;
        let index = match.index + match[0].length - 1;
        const start = index;
        do {
          const character = text[index];
          if (character === '(') depth += 1;
          else if (character === ')') depth -= 1;
          index += 1;
        } while (depth > 0 && index < text.length);

        reads.push({
          file: path.relative(SRC, file).split(path.sep).join('/'),
          line: text.slice(0, match.index).split('\n').length,
          model,
          method: match[1] ?? '',
          call: text.slice(start, index),
          // A window wide enough to see a `runAsPlatformOperation` wrapper around the call.
          context: text.slice(Math.max(0, match.index - 600), index),
        });
      }
    }
  }

  return reads;
}

const namesTenant = (read: Read) => /\btenantId\b|tenant_id/.test(read.call);

const permitted = (read: Read) =>
  PERMITTED.some((rule) => rule.match.test(rule.against === 'context' ? read.context : read.call));

describe('every read of an unbounded table can reach an index', () => {
  const reads = unboundedReads();

  it('finds the reads it claims to be checking', () => {
    // A scan that silently matched nothing would pass every assertion below.
    assert.ok(reads.length >= 50, `expected many reads, found ${reads.length}`);
  });

  it('names the tenant, or is one of the stated exceptions', () => {
    const offenders = reads
      .filter((read) => !namesTenant(read) && !permitted(read))
      .map((read) => `${read.file}:${read.line}  ${read.model}.${read.method}`);

    assert.deepEqual(
      offenders,
      [],
      'these reads leave the tenant to RLS, so no tenant-prefixed index can serve them:\n' +
        offenders.join('\n') +
        '\n\nEither name the tenant in the `where`, or add the case to PERMITTED with a reason.',
    );
  });

  it('would notice a read that dropped the tenant', () => {
    /*
     * The test that makes the test worth having. A scan that cannot fail reads as coverage, so this
     * runs the same predicate over a query written the wrong way and asserts it is caught.
     */
    const bad: Read = {
      file: 'invented.ts',
      line: 1,
      model: 'objectiveVersion',
      method: 'findMany',
      call: `({ where: { objectiveId: someId }, orderBy: { versionNumber: 'desc' } })`,
      context: 'return this.prisma.runInTenantTransaction(scope, () =>',
    };

    assert.equal(namesTenant(bad), false);
    assert.equal(permitted(bad), false);
  });

  it('accepts the shapes this codebase actually writes', () => {
    const shorthand: Read = {
      file: 'invented.ts',
      line: 1,
      model: 'auditEvent',
      method: 'findMany',
      call: '({ where: { tenantId }, take: 50 })',
      context: '',
    };
    const explicit: Read = { ...shorthand, call: '({ where: { tenantId: scope.tenantId } })' };

    assert.ok(namesTenant(shorthand));
    assert.ok(namesTenant(explicit));
  });

  it('permits a primary-key lookup, and says why', () => {
    const byId: Read = {
      file: 'invented.ts',
      line: 1,
      model: 'agentRun',
      method: 'findFirst',
      call: '({ where: { id: runId } })',
      context: '',
    };

    assert.ok(permitted(byId));
    // The reason is data, so the exception cannot be silent.
    assert.ok(PERMITTED.every((rule) => rule.why.length > 30));
  });
});
