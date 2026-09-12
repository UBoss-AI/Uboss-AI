# Performance and scale — what was measured, and what it is worth

Prompt 43. The harness is `apps/api/scripts/perf/`, the evidence is in `infra/perf/evidence/`, and the
budgets are declared in `packages/types/src/scale-validation.ts` — written down *before* the
measuring, so the measuring could not quietly become the target.

## The honest frame, first

These figures were measured on **one developer machine against one PostgreSQL container**. They are
evidence that a query plan is sound and that no scenario regressed. They are **not a capacity plan**,
and UBoss must not be described as validated to any particular user count on the strength of them.

What transfers between this machine and a cluster is **the query plan**. A plan that sequentially
scans a million rows here sequentially scans a hundred million there. What does not transfer is the
millisecond.

Not measured at all, each for a reason: throughput, multi-node behaviour, WebSocket fan-out at
scale, Redis saturation, and sustained load over hours. `NOT_MEASURED_HERE` carries the list in code
so a report cannot quietly imply otherwise.

## What the harness does

Creates `uboss_perf_<stamp>`, migrates it with the real migrations, seeds **twenty companies**,
measures one of them, and drops the database in a `finally` — including when a scenario throws.

It never touches `uboss_test`. That is not a preference: `audit_events` refuses `DELETE`, `UPDATE`
and `TRUNCATE` by trigger, so a million seeded rows in the shared test database could never be
removed by anything short of dropping it.

Seeded: 5,000 employees in the measured company (a five-level reporting tree), 50,000 audit events
and 20,000 notifications each across twenty companies — 1,000,000 audit rows in total, of which the
measured company owns 5%.

## Results

Every query the application actually makes is within budget, and none of them sequentially scans a
table that grows without bound.

Figures from `infra/perf/evidence/scale-20260912T080226.json`, which is the run currently in the
repository. Re-running replaces it; the numbers move by a few milliseconds between runs on the same
machine, which is why the **verdict** and the **plan** are what this table is for.

| Scenario | p50 | p95 | p99 | Budget (p95) | Verdict |
| --- | --- | --- | --- | --- | --- |
| Large tenant hierarchy list | 59.7 | 79.0 | 99.6 | 400 | Pass |
| Reporting subtree query | 12.2 | 23.1 | 27.3 | 50 | Pass |
| Audit page, as the application queries it | 2.8 | 3.5 | 3.8 | 400 | Pass |
| Concurrent logins and sessions | 5.8 | 7.9 | 8.7 | 200 | Pass |
| *Control* — audit page relying on RLS alone | 349.4 | 437.6 | 457.3 | 400 | **OverBudget** |

Milliseconds. The last row is **a control, not the product**: it omits the tenant predicate to
measure what the convention is worth, and it fails the budget — which is the finding, not a defect.
`AuditEventRepository` does not query that way.

Seeded totals for this run: 20 companies, 43,000 employment records, 1,000,000 audit events and
400,000 notifications, of which the measured company owns 5%. The evidence file records both the
per-company and the across-all-companies figures, because they are different numbers and the
distinction is what makes a plan worth reading.

## The one finding, and it is a real one

**Relying on Row-Level Security alone for the tenant predicate costs roughly 100×.**

349.4ms against 2.8ms at p50 in the run above. Across four runs on this machine the
absolute figures moved by tens of milliseconds and the ratio stayed near 100×, which is the shape of a
real finding rather than of noise.
ratio is stable between runs even though the absolute figures are not, which is the shape of a
real finding rather than of noise.

The policy reads:

```sql
tenant_id = current_setting('app.current_tenant_id')
  OR current_setting('app.platform_operation') = 'on'
```

PostgreSQL cannot use a `tenant_id`-prefixed index for an `OR` whose other branch does not mention
that column. And **every** index on `objective_versions`, `employment_records` and `audit_events` is
tenant-prefixed. So a query that leaves the tenant to RLS can use none of them:

```
Parallel Seq Scan on audit_events
  Filter: ((tenant_id = current_setting(...)) OR (current_setting(...) = 'on'))
  Rows Removed by Filter: 316667
```

RLS is what makes these queries **correct**. Naming the tenant is what makes them **fast**. Both are
required, and the second was missing in eight places.

### What was changed

Eight reads that filtered an unbounded table by a non-key column now name the tenant:
`objective.service.ts` (×3), `objective-analysis.service.ts` (×2), `assignment.service.ts`,
`workflow-editor.service.ts`, and the employment lookups behind separation-of-duties routing.

**No behaviour changed.** RLS already confined every one of them to the caller's tenant, so the added
predicate is redundant by construction and can only match rows the policy already allowed. The five
affected suites pass 249/249 unchanged.

`test/tenant-predicate.spec.ts` now holds the rule, with an explicit list of permitted exceptions —
primary-key lookups, hash-chain reads and deliberate platform-plane sweeps — each carrying its reason.

### What was *not* changed

**No index was added.** The schema's 187 indexes turned out to be right; the problem was queries that
could not reach them. Adding an index would have been the obvious move and the wrong one.

## How the harness lied three times

Worth recording, because each failure produced a *confident false finding* that would have led to
real damage.

**1. One tenant.** The first run reported sequential scans on `employment_records` and
`audit_events`. Neither was a finding: with a single company, `tenant_id = X` matches every row, so a
tenant-prefixed index would mean reading the whole index *and* the whole heap. The planner chose the
scan because the planner was right, and `audit_events_tenant_id_occurred_at_idx` — the exact index
that query wants — already existed and was correctly ignored. Acting on it would have added a
duplicate index production never uses.

**2. A hand-written subtree query.** The recursive walk measured 120ms and blew its budget. The
harness had written the CTE by hand and left the tenant out of both terms; the repository does not.
With the repository's actual SQL it measures 14ms.

**3. A hand-written audit query.** Same mistake, and this one survived longest because its number
looked plausible.

The lesson is one line: **a benchmark that writes its own version of the query is measuring the
benchmark.** The harness now copies the repository's SQL, and says so in a comment above each one.

## Remaining limits

- **Throughput is unmeasured** and would be a statement about this laptop wearing the authority of a
  capacity plan.
- **`employment_records` is seeded at 43,000 rows** and `audit_events` at 1,000,000. Beyond that,
  partitioning questions arise that nothing here has explored.
- **Five of the nine declared scenarios were not driven.** Four were: the hierarchy list, the
  reporting subtree, the audit page and concurrent sessions. The other five — objective list and
  version history, workflow canvas retrieval, the scheduled-agent spike, concurrent credit
  reservations, and provider latency and failure — need the **application** wired up rather than raw
  SQL against a seeded schema, which is a larger harness than this prompt built. They are declared in
  `SCALE_SCENARIOS` with budgets and reasons, so the gap is visible in code rather than absent.

  WebSocket fan-out is deliberately **not** among them: it is in `NOT_MEASURED_HERE` rather than
  `SCALE_SCENARIOS`, because the gateway is in-process here and measuring it would be measuring an
  event emitter.
- **No connection-pool saturation test.** The pool is 10 here and production is not.
