import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NOT_MEASURED_HERE,
  percentile,
  planSeqScansLargeTable,
  SCALE_CLAIM_STANCE,
  SCALE_SCENARIOS,
  scenarioFor,
  summarise,
  UNBOUNDED_TABLES,
  type ScenarioMeasurement,
} from './scale-validation.js';

/**
 * The arithmetic behind the benchmark — Prompt 43.
 *
 * A benchmark whose maths is wrong is worse than no benchmark: it produces confident numbers, and
 * somebody optimises the wrong thing on the strength of them. So the percentile function and the
 * verdict rules are tested here, away from any database or clock.
 */

describe('percentiles', () => {
  it('returns an observation rather than an average', () => {
    // Nearest-rank, deliberately. An interpolated p99 over twenty samples is a weighted average of
    // the two slowest — a number that appears in no request anybody actually made.
    const samples = [10, 20, 30, 40, 50];
    assert.equal(percentile(samples, 99), 50);
    assert.ok(samples.includes(percentile(samples, 95) as number));
  });

  it('computes the usual three correctly', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    assert.equal(percentile(samples, 50), 50);
    assert.equal(percentile(samples, 95), 95);
    assert.equal(percentile(samples, 99), 99);
  });

  it('does not care what order the samples arrive in', () => {
    const ordered = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = [7, 2, 9, 4, 1, 10, 3, 8, 5, 6];
    assert.equal(percentile(shuffled, 95), percentile(ordered, 95));
  });

  it('handles a single sample', () => {
    assert.equal(percentile([42], 50), 42);
    assert.equal(percentile([42], 99), 42);
  });

  it('reports nothing measured as null, never as zero', () => {
    // The distinction the whole report rests on: "nothing ran" and "everything was instant" must
    // never look alike.
    assert.equal(percentile([], 95), null);
  });

  it('clamps a nonsense percentile rather than reading past the end', () => {
    const samples = [5, 10, 15];
    assert.equal(percentile(samples, 0), 5);
    assert.equal(percentile(samples, 100), 15);
    assert.equal(percentile(samples, 1000), 15);
    assert.equal(percentile(samples, -5), 5);
  });
});

describe('scenarios', () => {
  it('names all nine the prompt asks for', () => {
    assert.equal(SCALE_SCENARIOS.length, 9);
  });

  it('gives every scenario a budget and a reason for it', () => {
    for (const scenario of SCALE_SCENARIOS) {
      assert.ok(scenario.budgetMs > 0, `${scenario.key} has no budget`);
      assert.ok(scenario.why.length > 20, `${scenario.key} does not say why`);
      assert.ok(scenario.what.length > 20, `${scenario.key} does not say what it measures`);
    }
  });

  it('holds an authorization check to a tighter budget than a screen', () => {
    // The subtree walk sits on the path of other requests; the hierarchy list is a screen somebody
    // opens and reads. Treating them the same would mean one of the two numbers is wrong.
    const subtree = scenarioFor('HierarchySubtree');
    const list = scenarioFor('HierarchyList');
    assert.ok(subtree && list);
    assert.ok(subtree.budgetMs < list.budgetMs);
  });

  it('shrugs at a scenario it does not know', () => {
    assert.equal(scenarioFor('NoSuchScenario'), undefined);
  });
});

describe('verdicts', () => {
  const measurement = (over: Partial<ScenarioMeasurement> = {}): ScenarioMeasurement => ({
    scenario: 'HierarchyList',
    samples: [100, 120, 140, 160, 180],
    errors: 0,
    ...over,
  });

  it('passes a scenario inside its budget', () => {
    const result = summarise(measurement());
    assert.equal(result.verdict, 'Pass');
    assert.equal(result.withinBudget, true);
    assert.equal(result.errorRate, 0);
  });

  it('reports over-budget rather than quietly passing', () => {
    const result = summarise(measurement({ samples: [500, 600, 700] }));
    assert.equal(result.verdict, 'OverBudget');
    assert.equal(result.withinBudget, false);
  });

  it('fails a scenario that threw, however fast the rest were', () => {
    /*
     * The rule that stops a benchmark lying. A path that throws instantly would otherwise report an
     * excellent p95 built from the attempts that happened to work.
     */
    const result = summarise(measurement({ samples: [10, 12], errors: 3 }));
    assert.equal(result.verdict, 'Failed');
    assert.equal(result.runs, 5);
    assert.equal(result.errorRate, 0.6);
  });

  it('never lets a failure contribute a latency sample', () => {
    const result = summarise(measurement({ samples: [100], errors: 9 }));
    // Ten attempts, one of which produced a number. The p95 describes that one, and the error rate
    // is what tells the reader not to trust it.
    assert.equal(result.p95, 100);
    assert.equal(result.errorRate, 0.9);
    assert.equal(result.verdict, 'Failed');
  });

  it('reports a scenario that did not run as NotMeasured, never as Pass', () => {
    const result = summarise(measurement({ samples: [], errors: 0 }));
    assert.equal(result.verdict, 'NotMeasured');
    assert.equal(result.p95, null);
  });

  it('carries the label and budget into the result, so a report needs no second lookup', () => {
    const result = summarise(measurement());
    assert.equal(result.label, 'Large tenant hierarchy list');
    assert.equal(result.budgetMs, 400);
  });
});

describe('query plans — the evidence that transfers', () => {
  it('spots a sequential scan on a table that grows without bound', () => {
    const plan = `Seq Scan on employment_records e  (cost=0.00..1842.00 rows=10000 width=280)`;
    assert.deepEqual(planSeqScansLargeTable(plan, { largeTables: ['employment_records'] }), [
      'employment_records',
    ]);
  });

  it('is not fooled by a schema-qualified or quoted name', () => {
    for (const plan of [
      'Seq Scan on public.audit_events  (cost=0.00..1.00 rows=1 width=1)',
      'Seq Scan on "audit_events"  (cost=0.00..1.00 rows=1 width=1)',
    ]) {
      assert.deepEqual(planSeqScansLargeTable(plan, { largeTables: ['audit_events'] }), [
        'audit_events',
      ]);
    }
  });

  it('accepts an index scan', () => {
    const plan = `Index Scan using employment_records_tenant_id_reporting_manager_user_id_idx on employment_records`;
    assert.deepEqual(planSeqScansLargeTable(plan, { largeTables: ['employment_records'] }), []);
  });

  it('ignores a scan of a table nobody said was large', () => {
    // A seq scan over a forty-row lookup table is the planner being right, and an index there
    // would simply be ignored.
    const plan = 'Seq Scan on departments d  (cost=0.00..1.40 rows=40 width=64)';
    assert.deepEqual(planSeqScansLargeTable(plan, { largeTables: ['employment_records'] }), []);
  });

  it('does not mistake one table for another whose name it starts with', () => {
    const plan = 'Seq Scan on audit_trail_entries  (cost=0.00..1.00 rows=1 width=1)';
    assert.deepEqual(planSeqScansLargeTable(plan, { largeTables: ['audit_events'] }), []);
  });

  it('names the tables that must never be scanned', () => {
    // Each one grows for as long as the company exists.
    for (const table of ['audit_events', 'notifications', 'agent_runs', 'employment_records']) {
      assert.ok(UNBOUNDED_TABLES.includes(table as never), `${table} is missing from the list`);
    }
  });
});

describe('what a run is allowed to claim', () => {
  it('says a millisecond does not transfer and a plan does', () => {
    assert.match(SCALE_CLAIM_STANCE, /not a capacity plan/i);
    assert.match(SCALE_CLAIM_STANCE, /query plan/i);
  });

  it('names what was not measured, with a reason each', () => {
    assert.ok(NOT_MEASURED_HERE.length >= 4);
    for (const entry of NOT_MEASURED_HERE) {
      assert.ok(entry.why.length > 30, `${entry.item} is listed without a reason`);
    }
  });

  it('is explicit that throughput was not measured', () => {
    // The number everybody asks for and the one least transferable from a laptop.
    assert.ok(NOT_MEASURED_HERE.some((entry) => /throughput/i.test(entry.item)));
  });
});
