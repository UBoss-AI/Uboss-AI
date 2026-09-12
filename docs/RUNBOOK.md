# Operational Runbook

Prompt 39 asks for *"operational runbook docs"*. This is written for somebody woken at 3am who did
not build UBoss. It says what to look at, in what order, and what each answer means.

**It describes only what exists.** Where a capability is missing, the gap is stated here rather
than implied — a runbook that tells you to check a dashboard that does not exist is worse than no
runbook.

---

## 0. The thirty-second orientation

| Question | Where |
| --- | --- |
| Is anything broken? | `GET /platform/observability/alert-rules` — every rule with its current value |
| What is on fire right now? | `GET /platform/support/health` — components, and active declared incidents |
| What are the numbers? | `GET /platform/observability/metrics` (Prometheus text) or `/metrics/snapshot` (JSON) |
| What did this one request do? | `GET /platform/observability/traces?correlationId=…` |
| What are customers being told? | `GET /tenants/:tenantId/service-status` — published incidents only |
| Is anybody being throttled? | `GET /platform/limits` — the limits in force and which store enforces them |
| Why is a run not starting? | `GET /platform/limits/fairness` — the queue, in the order it will be served |
| Can we actually restore? | `GET /platform/recovery` — when a restore last **succeeded**, not when a backup was last taken |

Every route above is `@PlatformOnly`. `/metrics` is the one endpoint outside the permission model,
because a scraper holds no session — see §6.

---

## 1. Follow one request end to end

A **correlation id** is generated at the edge by `CorrelationIdMiddleware`, and since Prompt 39 it
reaches all five stages:

```
request → queue job → agent_runs.correlation_id
        → model_gateway_calls.correlation_id
        → cost_ledger_entries.correlation_id
```

So given one id you can answer "what did this click actually do, and what did it cost":

```sql
-- The audit trail
SELECT occurred_at, action, resource_type, summary
  FROM audit_events WHERE correlation_id = $1 ORDER BY occurred_at;

-- The run
SELECT id, state, attempt, failure_reason FROM agent_runs WHERE correlation_id = $1;

-- What AI work it did
SELECT profile, capability, outcome, input_tokens, output_tokens, produced_by_real_model
  FROM model_gateway_calls WHERE correlation_id = $1;

-- What it cost
SELECT kind, amount_minor, currency, reason
  FROM cost_ledger_entries WHERE correlation_id = $1;
```

**`produced_by_real_model = false` means a mock answered.** It is not an error; it means no real
provider is configured. Do not report a mock result as AI output.

In-process spans for the same id: `GET /platform/observability/traces?correlationId=…`. They are
held in memory, newest 500 only, and **lost on restart** — so capture them before restarting
anything.

---

## 2. The alert rules, and what to do about each

`ALERT_RULES` in `packages/types/src/observability.ts` is the list, with a rationale on every
threshold. Read it before tuning one.

### `queue-stuck` — a run waiting more than 15 minutes (**Critical**)

1. `GET /platform/observability/metrics/snapshot` → `queue_depth` and `queue_oldest_age_ms`.
2. Depth low, age high → **one wedged job**, not a backlog. Find it:
   `SELECT id, state, attempt, reserved_at FROM agent_runs WHERE state IN ('Reserved','Running') ORDER BY reserved_at LIMIT 20;`
3. Depth high *and* age high → the worker is not consuming. Check Redis reachability; the queue's
   own `health()` reports `measured: false` when the broker cannot be reached.
4. A run stuck in `Reserved` past any retry backoff is safe to fail: the row is the source of
   truth and the engine is idempotent on its key.

### `reservation-drift` — any drift at all (**Critical**, threshold 0)

The only zero-threshold rule. Money was reserved and neither settled nor released, so the ledger
and the wallets disagree.

1. `POST /platform/observability/alert-rules/evaluate` refreshes the measurement.
2. Find them:
   `SELECT id, tenant_id, estimate_minor, held_at FROM budget_reservations WHERE state = 'Held' AND held_at < now() - interval '1 hour';`
3. Each one is a run that died between reserving and settling. Cross-reference
   `agent_runs.correlation_id`.
4. **Do not delete a reservation.** Release it through the cost engine so the ledger records the
   release — a deleted reservation is drift that stops being visible rather than drift that is
   fixed.

### `api-erroring` — elevated 5xx (**Critical**)

Counts 5xx only; a 403 is the authorization engine working correctly. Check
`request_errors{route,status}` in the snapshot to find which route.

### `provider-failing`, `connections-unhealthy`, `notifications-failing`, `queue-backed-up`

All **Warning**. Somebody should look; nobody should be paged. Each alert's `detail` carries the
reading, the threshold and the rationale, so you do not have to come back here.

---

## 3. Raising and running an incident

Evaluation is **idempotent**: `POST /platform/observability/alert-rules/evaluate` opens an alert
only if that rule has no open alert already. Run it every minute and a persistent problem produces
one alert, not sixty.

**Nothing schedules it yet.** Until the business-cron scheduler runs, somebody or something
external has to call it. That is the single most important gap in this runbook.

An alert is not an incident. Declaring one is a judgement:

```
POST /platform/support/incidents/:alertId/declare   { severity: 'P0'|'P1'|'P2', ownerUserId }
POST /platform/observability/incidents/:alertId/timeline  { kind, note, occurredAt? }
POST /platform/support/incidents/:alertId/mitigate  { mitigation }
POST /platform/support/incidents/:alertId/publish   { customerVisible: true, customerImpact }
POST /platform/observability/incidents/:alertId/resolve   { postmortem? }
```

* **`occurredAt` is optional and backdatable.** Write the timeline as you go; if you cannot, backfill
  it afterwards with real times. A timeline that only knows when each line was typed misreports the
  sequence of the thing it exists to explain.
* **Publishing needs customer wording.** A check constraint refuses a published incident without
  `customer_impact`, because a status page would otherwise have to assemble one out of internal
  notes that may name a host or another customer.
* **A P0 or P1 cannot be resolved without a postmortem** (at least 50 characters) **and at least one
  timeline entry.** `resolve` accepts the postmortem and does both in one transaction — that is the
  only order in which both rules hold. A P2 resolves on its mitigation note alone.

### Corrective actions

```
POST /platform/support/incidents/:alertId/actions  { description, ownerUserId, dueOn }
POST /platform/observability/actions/:actionId/close  { state: 'Done'|'Dropped', outcomeNote? }
GET  /platform/observability/actions/open
```

An owner and a due date are mandatory. Dropping one needs a reason; completing one does not —
deciding *not* to fix something a postmortem identified is the decision somebody will be asked
about. Read `/actions/open` at the weekly review: overdue actions are what an incident process
quietly stops doing.

---

## 4. What customers see

`GET /tenants/:tenantId/service-status` returns **published incidents only** — a severity, a state,
a start time and the operator's `customerImpact`. No component name, no error text, no host, no
latency.

**An outage nobody published reads as `ok`.** That is deliberate (ADR-206): UBoss says nothing
rather than leaking an internal reading. If customers should know, publish the incident — that is
the only lever, and it is the right one.

---

## 5. Reading the health page honestly

`GET /platform/support/health` returns five components. **`measured: false` means nothing probed
it**, and three of them report that today:

| Component | Measured? | Why |
| --- | --- | --- |
| API, Database | yes | the health endpoint probes them |
| Queue | only with a broker | the inline transport has no backlog to measure, and reports `null` rather than `0` |
| Providers | **no** | `canReachProvider` is the adapter's statement about its own configuration, not a live call — a health check that called a provider would spend a customer's credits to colour a dashboard |
| Connections | yes | counted from the connections table |

The worst component decides the whole. A health page that averaged its components would show
"mostly fine" during an outage.

---

## 6. Metrics, scraping and cardinality

`GET /platform/observability/metrics` renders Prometheus text format. Scrape it every 15–60s.

**It is outside the permission model**, because a scraper is not a person and holds no session.
That is only acceptable because of what it contains: counts and latencies with **no tenant, user,
run or provider label anywhere**, enforced by `metricLabelsArePermitted` and asserted by a test.
Anybody reading it learns how busy UBoss is and nothing about whose work made it busy.

**Restrict the scrape endpoint at the network layer anyway.** The application cannot do it and does
not pretend to.

`metrics/snapshot` reports `rejectedObservations`. **It should be zero.** Non-zero means code is
trying to record a disallowed label — the observation was dropped rather than the request failed,
which is the right trade, but somebody should fix the caller.

### Known limits of the registry

* **In process.** Counters reset on restart, and a multi-process deployment reports per-process
  figures. UBoss runs single-process today; a shared store is one adapter away.
* **No histogram quantiles server-side.** The buckets are exported; compute quantiles in the
  scraper.

---

## 7. Tracing

**There is no OpenTelemetry exporter.** No collector endpoint, no credentials, no backend — so
nothing is exported and nothing claims to be (`TRACING_STANCE`, ADR-225).

What exists: `InProcessTracer` records spans, uses the **correlation id as the trace id**, redacts
secret-looking attributes, and holds the newest 500 in memory. `OpenTelemetryTracer` is in the same
file, refuses every call, and is deliberately not bound — so the day a collector exists, one line
changes in `ObservabilityModule`.

Do not tell anybody UBoss has distributed tracing. It has correlation ids that reach the money,
which is most of the value and is a different claim.

---

## 8. Structured logs

Nest's logger, one line per event, correlation id available via `getCorrelationId()`.

`FORBIDDEN_LOG_FIELDS` + `redactLogFields` strip anything whose name looks like a secret —
separators are ignored, so `apiKey`, `api_key` and `API-KEY` all match. **Redacted, not deleted**:
a silently absent field looks like a bug in the producer.

The same protection guards span attributes. It does **not** guard a string somebody interpolated
into a message — `logger.log(\`token=\${token}\`)` defeats it, and only review catches that.

---

## 9. Limits, throttling and a queue that is not moving

### "Customers are getting 429s"

`GET /platform/limits` first. It gives you four things, and the fourth is the one people miss:

1. **`inForce`** — the limits actually applied, from `platform_settings` with the code defaults
   behind them.
2. **`limiter.store`** — `redis` or `in-process`.
3. **`limiter.sharedAcrossProcesses`**.
4. **`caveat`** — with an in-process store behind a load balancer, **the effective limit is the
   configured limit multiplied by the number of instances.** If you are seeing fewer refusals than
   the configured limit implies, this is usually why.

Then `metrics/snapshot` → `rate_limit_refusals{scope}`:

| `scope` | What it means |
| --- | --- |
| `User` | one person, almost always a script in a loop rather than somebody working |
| `Tenant` | a whole company, almost always one integration retrying |
| `Provider` | we are throttling *ourselves* to respect a provider's quota — not a customer problem |

```sql
-- Who, and when. One row per identity per five minutes, not one per refusal (S-305).
SELECT occurred_at, actor_user_id, tenant_id, reason, metadata
  FROM security_events
 WHERE action = 'security.api_rate_limit_tripped'
 ORDER BY occurred_at DESC LIMIT 50;
```

**Raising a limit is a platform setting, not a code change:**
`PUT /platform/console/settings/limits.api_requests_per_user_per_minute` with a `reason`. It takes
effect within sixty seconds (the cache) and is recorded as a Critical security event.

**Do not set one to zero.** It would refuse every request in the product from every customer. The
validator rejects it and the code default applies with a warning in the log — but do not rely on
that as a design.

### "A run has been queued for ages and the queue is not deep"

This is the fairness cap, not a stuck worker. `GET /platform/limits/fairness`:

* **`deferred > 0` with `dispatchable > 0`** — working as designed. Some company is at its ceiling
  and others are being served ahead of it.
* **`companiesWaiting` = 1 and `deferred` high** — one company has more work than its ceiling
  allows. Either raise `limits.concurrent_runs_per_company` or add workers; nothing is broken.
* **`dispatchable` high and nothing starting** — *this* is a stuck worker. Go to §2 `queue-stuck`.

`nextUp` is the order runs will actually be taken in: round-robin across companies, oldest first
within each. A deferred run carries its reason on `agent_runs.progress_message`, so the person
waiting can be told something true.

```sql
-- What each company has in flight right now. This is the number the cap compares against —
-- there is no counter, deliberately (ADR-232).
SELECT tenant_id, count(*) FROM agent_runs
 WHERE state IN ('Reserved','Running') GROUP BY tenant_id ORDER BY 2 DESC;
```

Two different knobs, and they are easy to confuse:

| Knob | Question it answers |
| --- | --- |
| `RUNS_WORKER_CONCURRENCY` (env, default 4) | how much work **this process** carries |
| `limits.concurrent_runs_per_company` (setting, default 8) | **whose** work gets to use it |

Raising the worker figure without raising the database pool is the trap: every concurrent run holds
a connection for its state transitions, so a worker concurrency above the pool size presents as a
slow database rather than as a misconfiguration.

### "An AI provider is failing"

`GET /platform/limits/providers` shows what the gateway has learned: consecutive failures, cooldown
remaining, and the last reason — by **provider model id**, never a vendor name.

* `RateLimited` / `Timeout` / `Unavailable` / `ServerError` → backed off, and it will recover on
  its own. A success clears the cooldown completely.
* Anything else → **no cooldown, by design**. A rejected prompt or a refused credential will be
  refused identically next time, so backing off would spend a customer's wait to reach the same
  answer.

Learned state is **in this process and lost on restart**, deliberately: a cooldown surviving a
restart would describe a provider's behaviour from before it. The cost is that each instance
discovers a rate limit separately — which is the argument for setting
`quotaRequestsPerMinute` on the model, since a declared quota goes through the shared store.

### "A client says its retries are being rejected"

```sql
SELECT key, method, path, status_code, created_at, expires_at
  FROM idempotency_records
 WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20;
```

* `status_code` **null** and recent → in flight. The client's retry is correctly told to wait.
* `status_code` **null** and old → the first attempt died without completing or releasing. The
  sweep will clear it; `POST /platform/limits/idempotency/sweep` clears it now.
* A **409 on every retry** → the client is reusing one key with different content. Check
  `security_events` for `security.idempotency_key_reused`. This is a client bug, and the refusal is
  protecting them: answering would silently discard one of their two requests.

**Nothing schedules the sweep.** It is the eighth job waiting on the business-cron scheduler.

---

## 10. Backups, restore and DR

### The only question that matters

**When did a restore last succeed?** Not "when did a backup last run" — a backup nobody has
restored is a file, and the difference between those two questions is the difference between
having backups and believing you do.

`GET /platform/recovery` answers it, along with the targets in force and whether the drill is
overdue. If `neverVerified` is true, UBoss has no evidence it can be recovered, whatever the
backup schedule says.

### Taking a backup

```bash
infra/backup/pg-backup.sh "$DATABASE_MIGRATION_URL" ./backups
```

A logical dump plus a manifest recording the migration the schema was at, the size and a SHA-256.
Two things it refuses to do, both learned the hard way:

* **It will not dump as `uboss_app`.** That role is `NOBYPASSRLS`, so a dump taken as it would
  silently omit every tenant row it cannot see — producing a backup that restores to an empty
  database and exits zero. Use the owner role.
* **It will not accept a dump under 1 KB**, which is what "it dumped nothing" looks like.

The manifest says `state=Taken`. That is deliberate: nothing has yet proved the file is readable.

### Verifying it — the part that counts

```bash
infra/backup/pg-restore-verify.sh ./backups/uboss-<stamp>.dump "$DATABASE_MIGRATION_URL"
```

Restores into a scratch database, runs six checks, and drops the scratch database whatever happens.
It refuses to restore anywhere whose name is not `uboss_restore_check_*` — a "verification" that
restored over live data would be the disaster it exists to prevent.

| Check | What it catches that nothing else does |
| --- | --- |
| `RestoreCompletes` | The floor: a backup that cannot be read. |
| `SchemaMatches` | A dump taken **mid-migration** — restores to a schema no application version can run against, and looks healthy until the first query. |
| `RowCountsPlausible` | A backup of the wrong database, or of an empty one. A restore into nothing exits zero. |
| `TenantIsolationIntact` | **RLS lost in the restore.** Policies and `FORCE ROW LEVEL SECURITY` are schema objects; a restored database serving every tenant to every reader passes every other check here. |
| `AuditChainIntact` | Rows lost or reordered — detectable because the trail is hash-chained. |
| `ApplicationStarts` | Everything above can pass against a database nothing can use. |

**Every one must pass.** There is no partial credit: a restore that lost row-level security is not
83% of a good restore.

The script writes a `.verification.json` beside the dump. That file is the evidence, and
`state: "Verified"` in it is the only thing that entitles anybody to say UBoss has backups.

### The last drill, and what it found

Run against `uboss_dev` on 2026-09-12: **6/6 passed**, 7 tenants across 121 tables, 104 RLS
policies covering 103 tenant tables, restore time **3 seconds**. Evidence in
`infra/backup/evidence/`.

The first run **failed** `SchemaMatches`, and the check was wrong rather than the backup. It counted
any `_prisma_migrations` row with no `finished_at` as in-flight, including a **rolled-back** row
from Prompt 24 — a failure somebody had already resolved, which will sit in every backup of this
database forever. The check now excludes rolled-back rows. Recorded because it is the argument for
running the drill rather than writing it down: a verification that cries wolf is one people learn
to skip.

### What UBoss does not do

Named here so a green recovery status is not read as more than it is:

* **Continuous WAL archiving** — `archive_mode` and `archive_command` are PostgreSQL and host
  configuration. This build takes logical dumps only, so **point-in-time recovery is not available
  until archiving is configured**, and the decision tree's "recover to just before the migration"
  branch depends on it. The settings to apply, the base-backup pairing and the recovery procedure
  are written out in `infra/backup/pitr-configuration.md` — including the one step people skip,
  which is to look at the paused replica *before* promoting it, because promotion cannot be undone.
* **Cross-region replication, object-store versioning and lifecycle** — bucket and provider policy.
* **KMS custody and rotation** — and this one bites: a restored database is **unreadable without
  the keys that encrypted its secrets**. A recovery that restores PostgreSQL and not the key
  material gives a company its objectives back and none of its integrations. The drill has a step
  for it.
* **DNS and traffic failover.**
* **Scheduling the drill** — the ninth job waiting on the business-cron scheduler.

### Redis

Not restored. Rebuilt empty, and the scheduler re-derives what is due from the rows. Every run has
a durable row before it is enqueued, every rate limit fails open, and the ledger is in PostgreSQL —
so losing Redis costs queue order, not work.

### Failover or roll back?

`GET /platform/recovery` serves the full tree. The four that come up most:

1. **A deploy broke the application, the data is fine** → roll back the deploy. **Do not restore** —
   that would throw away every change customers made since the backup to fix a problem in code.
2. **A migration destroyed data** → point-in-time recovery to just before it (needs WAL archiving,
   see above).
3. **The database is unreachable but undamaged** → investigate first. **Do not fail over yet**: the
   commonest cause is network or credentials, and failing over discards recent writes for nothing.
4. **One company's data was wrongly deleted** → restore that company into a scratch database and
   copy their rows back. A cluster restore would roll back every other customer.

And when you are not sure whether the data is intact: **restore to scratch and look.** An hour and
some disk, against every write since the backup. Take the hour.

---

## 10a. Is it slow, or is it big?

The first question when a screen is slow for one customer and fine for everyone else.

Almost always it is a query that cannot reach an index, and almost always the reason is the same:
**the tenant is not named in the `where`.** Row-Level Security still returns the right rows, so
nothing is *wrong* — it is scanning every company to find them. Measured at roughly 100x on a
million-row
audit table (ADR-271).

To check, run the query with `EXPLAIN (ANALYZE, BUFFERS)` and look for a `Seq Scan` together
with a large `Rows Removed by Filter`. If the filter text contains
`current_setting('app.current_tenant_id') OR ...`, that is the policy being used as a
filter instead of an index — and the fix is to add `tenantId` to the query, **not** to add an index.

`test/tenant-predicate.spec.ts` is supposed to stop this reaching production. If you find one in
the wild, work out why the scan let it through before fixing the query.

To re-measure the whole set: `node dist-scripts/scripts/perf/scale-run.js` from `apps/api`. It builds
its own database and drops it afterwards, so it is safe to run beside a test database. Method and
current figures are in `docs/PERFORMANCE.md`.

---

## 11. What this runbook cannot tell you to do

Stated plainly, because a runbook's credibility rests on it:

* **Nothing schedules alert evaluation, the retention sweep, the executor sweep, due lifecycle
  transitions, the scan queue, exit steps or the idempotency sweep.** **Eight** jobs wait on the
  business-cron scheduler. Until it runs, each has a route and somebody must call it.
* **A deferred run is re-dispatched only by the broker, or by the next admission pass.** With BullMQ
  the run is re-enqueued with a one-second delay and comes back on its own. On the inline transport
  it stays `Queued` with its reason on the row — re-enqueuing there would recurse until the stack
  gave out, turning a fairness cap into a crash. Which one you have is `RunQueue.isDurableTransport`.
* **Rate limits are per process unless `REDIS_URL` is set.** Behind a load balancer that multiplies
  the effective limit by the instance count. `GET /platform/limits` says which you have; nothing
  else will tell you.
* **No alerting transport.** A raised alert is a database row on a screen. No email, no pager, no
  webhook. `notifications` exists and this does not use it.
* **No log aggregation, no metric storage, no trace backend.** Everything here is in-process or in
  PostgreSQL.
* **No point-in-time recovery.** Logical dumps only until WAL archiving is configured where UBoss
  runs. The decision tree's migration branch assumes it and cannot be followed without it.
* **Nothing schedules the backup or the drill.** Both are scripts somebody or something must call.
* **No runtime error budget or SLO.** Latency is measured; no target is declared, so nothing can
  say whether it is acceptable.
