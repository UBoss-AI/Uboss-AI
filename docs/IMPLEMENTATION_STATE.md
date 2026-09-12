# Implementation State

**Last updated:** 2026-09-12 · **Last completed prompt:** 43 — Performance and Scale
Validation · **Next recommended prompt: 44**

---

## Completed at Prompt 40A — CR-03

The client amendment, and the first prompt in this build whose main effect is to **take access
away**.

- **A standard Employee is operations-only** (ADR-239). The Employee template no longer grants
  `objective` or `agent-builder`, so neither BUILDERS screen appears in the sidebar and neither
  route is reachable — **the same absent grant does both**, because `visibleModules` is derived
  from what a person holds. This supersedes an earlier decision that a test had deliberately pinned;
  the guard now pins the new rule with CR-03 cited in it.
- **A business-friendly Access & Permissions step over the existing engine** (ADR-240). Eight
  capabilities, each expanding to real grants, written as `Custom` role assignments — the mechanism
  from Prompt 7. No second RBAC. A granted capability never widens scope (S-314), an administrator
  cannot grant what they do not hold or grant above their tier (S-312), and nobody can change their
  own (S-313).
- **The operator, which was the one agent role that did not exist** (ADR-241). Four of the five
  CR-03 asks for were already columns on `engine_agents`; the fifth needed a table, because an
  agent can be run by a rota. Plus `builtForUserId`: *who was this built for* is a different
  question from *who may run it*, and **neither grants anything** (S-315).
- **A live share is what makes a manager-built agent the employee's own work** (ADR-242) — the fix
  for the defect that made the whole build-for-employee case unreachable.
- **Seven run preconditions, assignment first** so a refusal to a stranger leaks nothing about
  approval, connections or budget (S-316). An operator's screen carries no prompt, model, key or
  configuration, greped rather than trusted (S-317).
- **The Job Method as a third artifact** (ADR-244), with thirteen columns in the client's exact
  headings. Form 2 prefills it, five columns are deliberately left blank because Form 2 cannot
  answer them, **download needs no builder permission and upload does** (ADR-245), and an upload
  saves a draft and never tests or activates (S-320).
- **One Job Method row is not one Engine Agent** (ADR-246): eight boundary factors held as data with
  the argument for each, and a grouping that suggests rather than decides.
- **The optional employee photo** (ADR-247), through the Prompt 35 file layer — which grew a named
  seam rather than a looser gate, because `FileService.upload` needs `settings:EditDraft` and an
  Employee holds `settings:View`. The six mandatory Add Employee fields are untouched.
- **Workspace Chat**, built around one rule: **membership grants no access to anything a
  conversation refers to** (ADR-248), enforced structurally — a type and an id, resolved per viewer
  at read time, on the row as well as the module, through a `switch` a seventh type cannot slip
  past. No `chat` permission module at all (ADR-249), and ordinary messages are not audited.

### What the tests found

Nine things, and **seven were the product or the approved role matrix rather than the tests**:

- **An `OwnWork` employee could not run a manager-built agent** — the scope engine refusing
  correctly, which made CR-03's central case impossible. Resolved by ADR-242.
- **`agents:Assign` is granted to no role template**, like `objective:Pause`. Gating the share on
  it made the feature unreachable for every role in the product.
- **`users:ManageAccess` is CompanyAdmin-only**, and a CompanyAdmin may grant anything — so no
  template can express the case the delegation rule exists for.
- **A Head genuinely holds `BuildAgents`**; the first delegation test was wrong and the product was
  right.
- **`Connection` has no relation to assigned work** — the id is in `executionSetup` JSON, and the
  relation-based query compiled and failed at runtime.
- **A live `ObjectiveVersion` cannot be given workflow steps** — a Prompt 20 trigger refusing a
  fixture correctly.
- **A nested Prisma `create` rejects `tenantId`**, which tsc accepted.
- **`@Optional()` again**, twice in two prompts.

The CR-03 change also broke **62 existing tests**, all legitimately — four suites drove Agent
Builder as an employee. Each now grants builder access explicitly through a new
`grantBuilderAccess` helper, and new tests assert a standard Employee is refused. **No assertion
was weakened.**

## Completed in the second pass at Prompt 40A — the user interface

The first pass delivered every API, permission-gated and tested, and **no screens**. That gap was
recorded here as the largest in the prompt, and the client audit that followed was right to refuse
the prompt on it. This pass built the screens.

Building them found two defects nothing at the API level could have found, which is the honest
argument for why a UI pass is not decoration:

- **The operator’s Run button was a lie.** `AgentOperatorService.assertMayRun` had no caller. The
  screen asked `mayRun`, was told yes, and enabled Run; the run route decided visibility from
  ownership and answered 404 — for precisely the person CR-03 exists to serve. Every test covering
  the share asked the *service*, so nothing failed. ADR-251, S-329.
- **Every modal in the product accepted one character per click.** `useFocusTrap` listed `onClose`
  in its dependencies and every caller passes an inline arrow, so the effect re-ran on each render
  and pulled focus back to the first control. The work email on Invite User, the reason on Suspend,
  the correction on Report Issue. ADR-257, S-330.

### What renders

- **Access & Permissions** (§1) in three places, one component: a row action on Users & Access, the
  Invite dialog, and the end of Add Employee — where it can only appear *after* the save, because a
  capability is granted to a person and until then there is no person. The six mandatory Add
  Employee fields are untouched.
- **The employee photo** (§3) on the Hierarchy list, the employee profile and the person picker —
  the three places the amendment names. Lists read every photo in one request; a photo awaiting its
  malware scan renders exactly as no photo, because a "pending" badge would tell an uploader what
  the scanner is doing.
- **Import / Export** (§4) as a compact card *below* the approved Agent Builder layout. Nothing in
  A. Skill / Job Overview or B. One-time Job Method moved, and the removed right sidebar was not
  restored. Download needs no builder grant; Upload does, and the screen says so.
- **The import review** (§5) naming the objective, the assigned work, the person, the step count and
  every problem by kind, with the agent-boundary suggestion. It offers Cancel Import and Review Job
  Method. There is no Test and no Activate on it at all.
- **OPERATIONS → Engine Agents** (§5) with "Assigned to you" above the registry: agent name,
  objective, assigned work, last and next run, and Run / View Result / History / Report Issue. Run
  works end to end now. The redaction is structural — `OperatorRunView` has no field for a prompt,
  a model or a key (ADR-252).
- **Workspace Chat** (§6) under OPERATIONS, with the conversation list, unread badges, mentions,
  attachments, search and per-viewer context previews. It never claims to be live.
- **Discuss** (§6) on all six context types: Objective, Task, Engine Agent, Agent Run, Approval and
  Exception. It attaches a type and an id, never a copy of the title (ADR-256).
- **The sidebar** (§1) on all 26 company pages, derived from grants through one hook. No role label
  is read anywhere (ADR-255).

### Verification

Web 102/102, design system 114/114, CR-03 suite 60/60, run engine 48/48, **full API suite
2029/2029** — run again because the run route’s authorization changed. Frontend build, typecheck
and lint clean.

Nine screens opened in a real browser at 1440px and 400px with the API intercepted: 18 passes, no
console errors, nothing scrolling sideways. Then the four states a page load cannot reach. Six
layout faults were found and fixed — two lists showing bullet markers, context icons sitting on
their titles, a section touching the banner above it, a disclosure rendering as a form button, a
screenful between import problem groups, and Agent Builder forcing a 400px viewport 534px wide.

### Real limitations after the second pass

- **Chat is still not live.** Polling and a refresh, stated in the server’s own words at the foot of
  the screen. CR-03 says "use existing realtime/WebSocket infrastructure **where appropriate**" and
  the audit allowed polling explicitly, provided the UI never claims otherwise. It does not.
- **The visual verification ran against intercepted API responses**, not a live backend. That makes
  the data deterministic and lets a screen be judged on hard cases, and it means these screenshots
  prove layout and wiring rather than end-to-end behaviour. The end-to-end behaviour is what the
  2029 API tests are for.
- **A person selector that is a native `<select>` cannot show a photo.** The reporting-manager
  dropdown is one. The person *picker* — a list — does.
- **Chat still has no group membership editing** and **still does not notify a mentioned person**,
  both unchanged from the first pass.

---

### Real limitations at Prompt 40A

- ~~**No UI at all.**~~ **Closed.** The user interface exists and has been opened. See
  "Completed in the second pass" above. The nine screens CR-03 §7 names were rendered in a real
  browser at two widths, and the six layout faults that found were fixed.
- **No socket transport for chat.** Messages are durable and complete the moment they are sent, and
  "live" means a client polls. `REALTIME_STANCE` says so; the realtime seam is the same
  transport-free publisher the run engine uses. **UBoss must not be described as having realtime
  chat.**
- ~~**The Job Method is a JSON contract, not a spreadsheet.**~~ **Closed.** `GET
  /job-methods/:id/form.xlsx` serves a real OOXML workbook through `exceljs`, and
  `POST /job-methods/:id/import-workbook` reads one back. The tolerant heading matching was indeed
  what made the adapter thin: it survives renamed tabs, mangled headings, formula cells and rich
  text. The JSON routes stay for a client that renders the form rather than downloading it.
- **Mentions are resolved by the caller.** `sendMessage` takes a handle → user id map, because
  resolving a handle needs a directory lookup the pure function cannot do. Nothing yet notifies a
  mentioned person: the notifications engine exists and this does not use it.
- **Chat attachments are attached, not uploaded here.** A client uploads through the Prompt 35 file
  route and passes the id — genuine reuse, but it means the chat API alone cannot accept a file.
- **No group membership editing.** A conversation's participants are fixed at creation. Adding
  somebody later, and deciding what history they see, is a real product question this prompt did
  not answer.
- **The connection precondition reads health rather than probing.** Correct — probing a customer's
  system to colour a button would spend their rate limit on a page load — but it means a connection
  that broke since its last check shows as healthy until something checks it.
- **`suggestAgentGroups` is deliberately unclever.** It groups on tool, approval and prohibitions,
  and nothing subtler. A confident automatic answer would be worse than an obvious rough one,
  because nobody checks a confident answer.

---

## Completed at Prompt 40 — Rate Limits, Abuse Protection and Execution Fairness

Four of the prompt's nine controls already existed and were **not rebuilt**: login abuse throttling
(Prompt 5's lockout), request body and file size limits (Prompt 35's per-route ceilings), run retry
caps (`AgentRun.maxAttempts`) and token/cost caps (Prompt 30's reservations). What follows is what
was genuinely missing.

- **Queue fairness, as a pure function** (ADR-230). `fairOrder` takes each company's oldest job in
  turn, so **a tenant's wait depends on how many companies are busy, not on the size of the busiest
  one's backlog**. Fifty queued runs from one company put another company's single run in position
  *two*, not fifty-one. Round-robin rather than weighted, because nobody can choose the weights.
- **A per-company concurrency ceiling, enforced at pickup with no counter** (ADR-231/232). The
  in-flight figure is `COUNT(*) WHERE state IN ('Reserved','Running')`, so a worker killed
  mid-run cannot permanently consume a company's cap. Checked *before* `Reserved`, so a deferred
  run never holds money against a wallet.
- **Per-user and per-tenant API limits** as a token bucket (ADR-229), with a store seam that
  **reports whether it is shared across processes** (ADR-233) — because a per-process Map behind a
  load balancer silently multiplies the limit by the instance count and nothing else would say so.
  The Redis implementation is a Lua script so refill-and-take is atomic, with a contract test
  asserting it agrees with the pure function.
- **Business-readable 429s.** Scope, limit, `Retry-After` and a sentence a screen shows unchanged —
  it says whether this is the person or their company, and whether to wait or call somebody. The
  person's own limit is checked first, so a refusal names the real cause.
- **Idempotency for retried mutating requests** (ADR-235). Opt-in, `POST` only, unique **per
  actor**, remembered for 24 hours, claim released on failure, and a reused key with different
  content **refused rather than answered**.
- **Provider quota-aware throttling and adaptive backoff** (ADR-236): a declared
  `quotaRequestsPerMinute` through the shared bucket, and learned cooldowns with full jitter where
  no quota was declared. A non-retryable failure sets no cooldown at all.
- **`AgentRunOverdue`** (ADR-238) — the Executor exception fairness itself creates, so a starved
  run becomes the customer's problem rather than sitting in a state that reads as normal forever.
- **Limits are platform configuration, not company settings** (ADR-234), because a company that
  could raise its own per-company limit could opt out of a protection every other customer depends
  on.

### What the tests found

- **An expired idempotency key was unusable forever rather than for twenty-four hours** (S-308).
  The read treated the expired record as absent — correctly — but the row remained, so the insert
  tripped the unique index and the caller was told `InFlight` by a request that had finished last
  week. Found by the test that reuses a key after its window; nothing else would have surfaced it.
- **Two constraints refused a fixture and were right to**: an idempotency record cannot expire
  before it was created, and a completed run must say whether a real model produced its output.
- **Two registrations of one class are two instances** — `useClass` beside the concrete class gave
  a test a store nothing had used, so a leak assertion read zero while the product was correct.
- **A type-level optional is not a DI-level optional**: `fairness?: RunFairnessService` without
  `@Optional()` cancelled 41 run-engine tests at once.

### Real limitations at Prompt 40

- **The in-process store is what runs today.** `REDIS_URL` is set locally so the shared store is
  available and its contract test passes against the live broker, but the bound store is whatever
  the environment has — and with the per-process store behind more than one instance **the
  effective limit is the configured limit multiplied by the instance count**. This is reported by
  `GET /platform/limits` and logged at startup rather than left to be discovered.
- **Nothing schedules the idempotency sweep.** The **eighth** job waiting on the Prompt 26
  business-cron scheduler, alongside alert evaluation, the retention sweep, the executor sweep, due
  lifecycle transitions, the scan queue and exit steps. Expired records are ignored correctly on
  read, so the consequence is table growth rather than wrong behaviour — but the table grows.
- **A deferred run is re-dispatched by the broker, or by the next admission pass.** With BullMQ it
  is re-enqueued with a one-second delay. On the inline transport it stays `Queued` with its reason
  on the row, because re-enqueuing there would recurse until the stack gave out — a fairness cap
  turning into a crash is worse than the starvation it prevents. `admissionPlan` computes the fair
  order but **nothing calls it on a timer**, so on the inline transport a freed slot is taken by the
  next enqueue rather than by the longest-waiting company.
- **Provider failures are classified by string-matching the adapter's error text.** The adapters
  throw `Error`, not a typed failure, so `classifyProviderFailure` looks for "429", "rate limit",
  "timeout" and so on. Anything unrecognised is treated as **not** retryable, so the unknown never
  becomes the retrying default — but a provider whose wording is unusual will not be backed off
  from. A structured reason on `ProviderAdapter` is the fix, across four adapters.
- **Learned provider cooldowns are per process.** Deliberate — a cooldown surviving a restart would
  describe behaviour from before it — but it means each instance discovers a rate limit separately.
  The argument for declaring `quotaRequestsPerMinute`, which goes through the shared store.
- **No per-company negotiated limit override.** The limits are global platform configuration; an
  enterprise customer needing more is served by changing the global figure, not by a row of their
  own. The plan tier does not carry limits.
- **No IP-level or unauthenticated protection, and no claim of any** (S-301). Identity is what the
  application knows for certain; `WAF_ASSUMPTIONS` states that TLS, malformed requests and
  volumetric protection are the proxy's job and that if there is no proxy, that job is nobody's.
- **No UI.** The 429 carries everything a screen needs and `GET /platform/limits` is
  permission-gated and tested, but no Master Console screen renders limits or the fairness queue,
  and no web-side handler turns a 429 into a banner yet.
- **The load-oriented tests are load-*shaped*, not a load test.** They prove the decisions under
  volume — a thousand jobs across ten companies, a bucket exhausted and refused — in process,
  deterministically. Nothing here measures throughput or latency under concurrent real traffic, and
  UBoss must not be described as load-tested.

---

## Completed at Prompt 39 — Observability, Metrics, Tracing and Incident Workflow

- **The correlation chain now reaches the money** (ADR-222). It stopped at the run row;
  `model_gateway_calls` and `cost_ledger_entries` now carry it, so "what did this click spend" is
  four queries the runbook spells out. The worker re-establishes the context around each job, which
  is the line that makes the chain unbroken rather than nearly unbroken.
- **A metric registry with an enforced label allow-list** (ADR-223): no tenant, user, run or
  provider label anywhere, dropped-and-counted rather than thrown, Prometheus text format rendered
  without a dependency.
- **Alert rules that finally raise an alert** (ADR-226), closing Prompt 36's own recorded
  limitation. Idempotent against the row, so a persistent problem produces one alert rather than
  sixty, and a restart mid-outage cannot lose the fact that somebody was told.
- **The incident workflow Prompt 36 deferred here by name** (ADR-227/228): a written, backdatable
  timeline; a postmortem a P0 or P1 cannot be resolved without; and corrective actions with
  mandatory owners and due dates.
- **A tracing seam that says it exports nothing** (ADR-225). The correlation id is the trace id;
  `OpenTelemetryTracer` refuses every call and is deliberately not bound.
- **`docs/RUNBOOK.md`** — written for somebody woken at 3am who did not build UBoss, including a
  section on what it cannot tell them to do.

### What the tests found

- **`logFieldIsForbidden` missed `API_KEY`.** It compared lowercased strings, so snake_case and
  kebab-case spellings of a forbidden field slipped past the redaction list. Separators are now
  stripped from both sides.
- **Four fixtures tripped real constraints** doing their job: a successful gateway call must name
  the model that answered, a `Settle` must name its reservation, and a closed reservation must
  record when and why.

### Real limitations at Prompt 39

- **No OpenTelemetry exporter.** No collector endpoint, no credentials, no backend — so nothing is
  exported and `TRACING_STANCE` says so. **UBoss must not be described as having distributed
  tracing.** It has correlation ids that reach the money, which is most of the value and a
  different claim.
- **Nothing schedules alert evaluation.** The seventh job waiting on the business-cron scheduler,
  alongside the retention sweep, the executor sweep, due lifecycle transitions, the file scan queue
  and the exit steps. Until it runs, `POST /alert-rules/evaluate` has to be called by something
  external — and this is the most consequential gap in the prompt, because an alert rule nobody
  evaluates is a comment.
- **No alerting transport.** A raised alert is a database row on a screen: no email, no pager, no
  webhook. The notifications engine exists and this does not use it, deliberately — an alert
  firing on a test evaluation would train operators to ignore them.
- **The metric registry is in process.** Counters reset on restart and a multi-process deployment
  reports per-process figures. Correct for the single-process API UBoss runs today, one adapter
  away from correct later, and stated in the runbook rather than discovered.
- **Alert rules are matched to open alerts by their summary text**, because `service_alerts` has no
  `rule_key` column. Editing a rule's summary would orphan its open alert and let a duplicate be
  raised. A column is the fix and it is a migration this prompt did not need.
- **No SLO or error budget.** Latency is measured and no target is declared, so nothing can say
  whether it is acceptable.
- **The metrics are recorded where code already ran, not everywhere.** `credit_reservation_drift`
  and `connection_health` are measured on demand by `AlertRulesService`; `request_latency_ms` and
  `request_errors` have no interceptor feeding them yet, so they stay at zero until one is added.
  The registry, the labels and the rendering are real and tested; two of the ten metrics have no
  producer.
- **No Master Console screen.** The routes are permission-gated and covered by tests; System Health
  from Prompt 36 does not yet render the metric snapshot beside its component probes.

---

## Completed at Prompt 38 — Company Exit and Data Portability

- **All seven steps**, with three of them reusing Prompt 11's lifecycle rather than rebuilding it:
  `ReadOnly` is the read-only period, `tenant_lifecycle_transitions` carries the scheduled dates,
  and the exit *drives* `CompanyLifecycleService` instead of writing `lifecycleState` itself.
- **Deletion is by classification** (ADR-217). All 91 tenant-scoped tables are `Content`,
  `Accountability` or `PersonRecord`, and **an e2e test reads `information_schema` and fails if
  any is unclassified** — which caught `company_exits` itself on its first run.
- **A company leaving does not erase somebody's career.** Employment records, badges, performance
  events and the departments they name survive.
- **Four gates before anything is deleted** (S-281), two of them enforced by the database as well:
  the retention window and the second person's approval.
- **The certificate carries evidence, including what could not be deleted** (ADR-219).

### What the database and the tests decided

- **Five foreign keys from preserved tables into content**, found one at a time (ADR-218). Two
  became detach-before-delete; two forced a table into a preserved bucket; and `reward_awards` —
  whose links to objective data are NOT NULL — had to become `Content`, which is a **real loss**
  recorded rather than hidden.
- **Six `Content` tables deny DELETE to the application role**, because they are append-only by
  privilege. The certificate reports them under `retainedByPrivilege` rather than claiming they
  went (ADR-219).
- **The self-approval security event was rolled back with its own exception** — the identical bug
  S-256 fixed at Prompt 36, reintroduced in the same session. Only a test asserting the *event*
  rather than the 403 catches it.
- **Three latent Prompt 37 runtime bugs** surfaced from one new loop that asks for each of the ten
  reports and expects a 200: `ObjectiveVersion.title`, `AiOutputFeedback.skillVersionId` and
  `SkillEvaluationRun.createdAt` all do not exist, and **tsc passed all three**.

### Real limitations at Prompt 38

- **Six `Content` tables are not actually deleted.** `notifications`, `connection_checks`,
  `connection_tool_grants`, `skill_evaluation_runs`, `skill_regression_comparisons` and
  `skill_transitions` deny DELETE to `uboss_app`. The certificate says so. **Closing this needs a
  client decision**: grant the privilege, or provision an owner-role path for exit with its own
  credentials and review. It should not be decided unilaterally, and it is the one item here that
  blocks a claim of complete erasure.
- **A departed company's reward count no longer reaches a portable profile** (ADR-218). Making
  `reward_awards` survivable means making two NOT NULL foreign keys nullable, which is a schema
  change with its own migration.
- **Nothing schedules the exit steps.** `beginReadOnly`, `beginRetentionHold` and the deletion are
  all called by an operator. Prompt 11's `applyDueTransitions` could drive the first two from the
  stored dates; the deletion should stay manual because of the typed confirmation. The sixth job
  waiting on the business-cron scheduler.
- **No notifications.** The prompt asks for operator/customer notifications and the exit raises
  none — no email to the company when the read-only period starts, no operator alert when a
  retention window elapses. The notifications engine exists; `awaitingDeletion` is the query a
  producer would read. Deliberately not wired, because a notification that fired on a *test* exit
  would be the worst possible first bug.
- **No Master Console screen.** The routes are permission-gated and covered, and a destructive
  confirmation flow deserves a screen designed with the client rather than assembled here.
- **The legal-hold check covers files only.** A file under a Prompt 35 legal hold now blocks the
  whole deletion, which is the rule S-247 requires — but files are the only records in the product
  that carry a per-record hold. If a later prompt adds one elsewhere, the exit will not consult it
  unless somebody adds it to this gate, and nothing reminds them.
- **The export is a JSON payload, not an archive.** No streaming, no chunking, and a 50,000-row
  audit cap. A large company's export would be a very large response.

---

## Completed at Prompt 37A — Portable UBoss Profile Search by UBoss Unique ID

- **The one read in the product that deliberately crosses tenancies**, and built accordingly: a
  whitelist projection rather than a filtered row, so a new column on `employment_records` is
  invisible until somebody deliberately adds it to the list (ADR-213).
- **Input is a UBoss Unique ID and nothing else** (S-270). No name search, no email search, and
  Aadhaar is neither an input nor an output.
- **"Authorized HR/Admin" is `users:Administer`** (ADR-214), not `profile-search:View` — which
  every role template holds and which governs only whether the nav item appears.
- **Two company policies, both off by default** (ADR-215), and the second is owned by the *source*
  company: each employer decides whether its own performance record travels, and `BadgeOnly`
  cannot return a score by construction.
- **Every lookup audited in the searcher's trail and only there**, before the read, so a search
  that found nobody is still recorded (S-276).

### What the tests and the schema found

- **The `users` settings category is deliberately settings-free.** Both new controls were put
  there first and a Prompt 14 test caught it. They moved to `security`, which is the better home:
  both are "who outside this company can see what".
- **An achievement summary cannot carry titles.** A `RewardAward`'s only human-readable label is
  its Objective, which the prompt forbids — so the summary is a count and a date. The compiler
  found it (`ObjectiveReward` has no recipient and no title; `RewardAward` is the per-person
  record) and the narrower answer is the right one (ADR-216).
- **`employment_end_state_and_date_agree`** pairs the state with the end date in both directions,
  so an ended-employment fixture needs both.

### Real limitations at Prompt 37A

- **A lookup confirms that an id exists.** An unknown id 404s and a known one returns a profile, so
  the endpoint is an existence oracle for UBoss Unique IDs. Accepted deliberately: the id is not a
  secret — `uboss-unique-id.ts` says so and it is printed on profile screens — and the space is
  32^8. What would matter is enumeration by name or email, and no route accepts either.
- **No rate limit on lookups.** An authorized HR administrator could script the endpoint. Rate
  limiting and abuse protection are a later prompt's subject and this endpoint is one of the first
  things it should cover.
- **The person is not told they were looked up.** The searching company's trail records it; the
  subject has no notification and no view of who verified them. Nothing in the approved documents
  asks for it, and it is the kind of thing a data-protection review would raise — recorded here
  rather than implemented unasked.
- **On-time percentage is computed from human tasks only**, capped at 5,000 rows per employment. A
  person whose contribution was mostly configuring agents has no on-time figure, which reads as
  "nothing to measure" rather than as a gap.
- **Employment periods come from `joinedOn` and `endedAt` as entered.** Nothing verifies them, and
  the product does not claim to: the profile reports what the employer recorded.
- **No screen for the two new settings beyond the generic catalogue.** The Settings screen renders
  the catalogue, so both appear under Security — but they have not been checked on that screen, and
  the default is what every test exercises.

---

## Completed at Prompt 37 — Reporting and Management Dashboards

- **The locked Company Workspace Dashboard**: one donut, two slices, counted in the signed-in
  person's backend-authorized scope, each slice drilling into the list it counts. The endpoint
  returns three keys and a test asserts the **whole** key set, because the contract erodes by
  addition (ADR-210).
- **The ten reports the prompt names**, each gated on `reports:View` **plus** the permission
  governing its own rows — with the action named rather than assumed (ADR-208).
- **Scope resolved once and passed to every query** (ADR-209). `null` means the whole company and
  an empty list means nobody, so a bug narrows rather than widens.
- **Export is its own grant**, audited, with every CSV cell neutralised against formula injection
  (ADR-212).
- **Bounded rather than warehoused** (ADR-211): a 366-day ceiling and a 500-row limit, both stated
  to the reader rather than applied silently.

### What the tests found

- **Assuming `View` on a report's source module was a leak.** An Employee holds `settings:View`, so
  AI Usage & Cost and Audit Activity were readable by every employee in every company. A unit test
  written against the real role templates caught it; both now name `settings:Administer` and
  `settings:Audit` (S-263).
- **uuid v7 ids minted in the same millisecond share their first 8 characters.** A leak assertion
  comparing `id.slice(0, 8)` matched every row and "failed" against correct behaviour, and the same
  collision broke an employee-id fixture. Compare full ids.
- **Three fixtures tripped constraints doing their job** — an `Active` agent needs `activated_at`,
  an archived one needs both `archived_at` and `archived_by_user_id`, and `ObjectivePublish` is not
  an approval type.

### Real limitations at Prompt 37

- **`pendingJobs` counts human tasks only.** An agent run awaiting a retry is pending work in
  ordinary language and is not in that number. The slice drills into the To-do List, which is
  human tasks, so the count and the list agree — but the label is broader than the figure, and
  widening it means deciding what an agent run awaiting retry means to a person.
- **Human vs AI Work Mix attributes agent runs by objective ownership.** An agent run carries no
  assignee, so a scoped mix counts runs for objectives the reader owns. A run against an objective
  they do not own is invisible to them even if their own agent performed it. Attributing a run to
  the person who triggered it needs a column `agent_runs` does not have.
- **Four of the ten reports are covered by the scope resolver's tests rather than by their own
  fixture.** Employee Workload, Objective Progress, Executor Exceptions and Performance/Badges all
  need an objective → version → workflow-draft chain to seed a single row, and the scope filter
  they apply is the same `ReportScopeService.userFilter` proved directly against Engine Agent
  Health and Approval Aging. The queries are written and typed; the row-level assertions for those
  four are not.
- **No drill-down from a report row.** The prompt asks for drill-down and the reports return ids
  rather than links; clicking a row does nothing. The dashboard's two drill-downs are built and
  tested, which are the two the locked contract names.
- **No custom date range in the UI.** The range selector filters `Custom` out. The API accepts it
  with a bounded window and a test covers the refusal; the date pickers belong with the UI pass.
- **Rows carry user ids, not names.** Employee Workload and Approval Aging show a uuid where a
  reader wants a person. Resolving names means joining `users`, which is a platform-plane table
  with no RLS — so it needs a deliberate, scoped lookup rather than a join, and that is a change
  worth making carefully rather than in passing.
- **No scheduled or emailed reports.** Nothing in the approved documents asks for them.

---

## Completed at Prompt 36 — Support, Authorized Support Sessions and System Health

- **Break-glass *is* the support session** (ADR-205). Prompt 8 already had the reason, the scope,
  the expiry, the operator, revocation and the audit; this prompt added the one missing piece — the
  company's own authorization — to that record rather than building a parallel one.
- **Customer authorization has no bypass** (S-255). Where a company's policy requires it, a session
  cannot activate without their yes; a decline is terminal; and a check constraint refuses an
  activated row on a declined session.
- **A declared incident is a service alert** (ADR-203). A `platform_incidents` table was written and
  deleted before it shipped — `service_alerts` already answers "what is wrong with UBoss right now"
  and is already on the Master Console dashboard.
- **The customer status is built from published incidents, never from probes** (ADR-206), and the
  type has no field an internal string could travel in.
- **Queue depth lives on `RunQueue`** (ADR-207), reported as `measured: false` where it is
  structural rather than probed.
- **Platform support holds nothing on any company module** (S-254), now asserted by a test that
  iterates `COMPANY_MODULES`.

### What the tests and the database found

- **The customer status leaked the alert's internal headline.** `CustomerVisibleStatus.title` was
  filled from `service_alerts.summary` — "db-primary-2 exhausted its connection pool" — and would
  have published a host name to every company. Fixed structurally rather than with a sanitiser
  (S-257).
- **The blocked-activation security event was rolled back with the refusal.** The gate wrote it
  inside the platform transaction and then threw. The control worked invisibly, which is the exact
  failure the event exists to prevent (S-256).
- **`ON DELETE SET NULL` on a composite FK is always wrong**, and Prompt 35 had shipped one: it
  nulls `tenant_id` too, so deleting a connection a knowledge source referenced failed outright
  (ADR-204). **`prisma validate` warns about this and `migrate diff` does not** — Prompt 35 only
  ran `migrate diff`.
- **A probe that trips the wrong constraint proves nothing.** Two Prompt 36 probes were caught by
  pre-existing Prompt 8 constraints and had to be tightened; `check_violation` catches them all.

### Real limitations at Prompt 36

- **No Master Console screens were built.** The platform routes exist, are permission-gated and are
  covered by the service-level tests, but Support & Operations and System Health have no pages in
  `apps/web`. The Master Console is a thin shell across the whole product so far, and building two
  screens here would have been the first of many — it belongs with the UI pass.
- **The operator ticket queue has no notification.** A new ticket appears in `/platform/support/
  tickets` and nothing tells anybody it arrived. The notifications engine exists and this does not
  use it.
- **Nothing raises a service alert automatically.** Every alert in the product is written by hand.
  §30's metrics — latency, error rate, queue age, provider error — are not collected, so no
  threshold can fire, and that collection is the observability prompt's.
- **System Health does not probe providers.** `canReachProvider` is the adapter's statement about
  its own configuration, not a live call, because a health check that called a provider would spend
  a company's credits to colour a dashboard. Reported as `measured: false`.
- **The affected-components list on an incident is the alert's single `service` string.** §30 asks
  which components an incident affects; `service_alerts` has recorded one service since Prompt 9
  and widening it to an array is a change the observability prompt should make alongside the
  timeline.
- **No SLA or first-response target on tickets.** The queue reports counts, not ageing against a
  promise, because no approved document states one.
- **The incident timeline, postmortem and corrective actions are absent**, deliberately — they are
  the observability prompt's, which extends this record (`INCIDENT_WORKFLOW_BOUNDARY`).

---

## Completed at Prompt 35 — Knowledge, Files, Data Classification and Safe Uploads

- **The database holds a reference, never bytes** (ADR-197). `files.storage_ref` is an opaque key a
  storage adapter understands; a deletion nulls the row first and asks the adapter second, so a
  failure leaves an orphan rather than a lie to a customer who asked for a deletion.
- **Two storage adapters, one of which refuses everything** (ADR-198). The in-memory one works;
  `S3StorageAdapter` has no bucket, endpoint or credential and throws with the reason. `canStore`
  is checked before a row is written, because an adapter that silently stored nothing is the worst
  possible failure — the upload succeeds, the scan succeeds, the record exists, and the file is
  gone.
- **A mock scanner that actually finds something** (ADR-199). It detects the EICAR test file, and
  every verdict carries `scannedByRealScanner: false` onto the row, into the audit metadata and
  onto the screen — on every row, not once in a banner.
- **Two classification ceilings, not one** (ADR-200) — export inside the company, and egress out of
  it. A CHECK refuses a policy whose outer ceiling is looser than its inner one.
- **Nothing redacts, so a transfer needing redaction is refused** (S-250) rather than reported as
  permitted and left to a caller that cannot redact.
- **A knowledge source is approved, not assembled** (ADR-201). Editing an approved source returns it
  to Draft; authoring and approving are different role templates, so by default two people are
  involved.
- **No vector store, no embedding index, no semantic sharing**, per §35 — and a test asserts the
  absence, because an absence is only durable if something checks for it.

### What the tests and the database found

- **A CHECK that can evaluate to NULL passes.** `array_length("named_agent_ids", 1) >= 1` accepted
  exactly the row it was written to refuse. **Third appearance of this failure mode** in this schema
  (Prompt 14, Prompt 22, this one). Caught by a raw-SQL probe, not by code.
- **A constraint written before its only edge case existed.** `file_deletion_is_explained` required
  an author, and the retention sweep has none — the policy deletes, not a person. Writing whoever
  triggered the sweep would have been false attribution (S-248). The e2e suite found it; no probe
  could have, because the sweep did not exist when the constraint was written.
- **`settings:View` is an Employee grant.** Gating the file inventory on it would have shown every
  employee every filename and classification in the company. It is now `settings:Administer` **or**
  `settings:Approve` (S-249).
- **A base64 upload does not fit the default body limit**, and raising it globally would have given
  every route in the product a denial-of-service surface. Per-route limits in `main.ts` (S-252).

### Real limitations at Prompt 35

- **No S3 bucket exists.** `S3StorageAdapter` is a shaped seam with no network call in it. Files
  live in memory and do not survive a restart. This is development-grade storage, stated plainly,
  and the class says so in its own error message. **UBoss must not be described as storing customer
  files durably** until a bucket is provisioned and the adapter is written against it.
- **No real malware scanner is connected.** The mock detects EICAR and nothing else, and records
  `scannedByRealScanner: false` on every file it clears. **UBoss must not be described as scanning
  uploads for malware** until a real product is behind `MALWARE_SCANNER`.
- **The scan runs inside the upload request.** A large file blocks its request. The right answer is
  the Prompt 26 business-cron scheduler, which still does not run — the fifth job waiting on it,
  alongside the retention sweep below.
- **Nothing schedules the retention sweep.** It is reachable, tested and correct, and it runs only
  when somebody posts to it.
- **No agent run consults a knowledge source yet.** `canRead` and `readForAgent` are built and
  tested, and the run engine does not call them: an Engine Agent version has no knowledge-source
  binding in its config. That binding changes the agent version schema and belongs with the prompt
  that gives agents their knowledge, not here.
- **There is no per-agent classification ceiling.** An agent is held to the company's export ceiling
  (ADR-202), because no such field exists in the approved documents or in the schema.
- **The knowledge-source panel is read-and-approve only.** It lists sources, shows what they hold
  and approves drafts; creating and editing one is API-only. The routes exist and are tested; the
  form belongs with Prompt 45's UI work.
- **The file policy is displayed, not edited, on the screen.** Changing it is an API call.
- **`DeleteRecord` retention is not implemented.** The sweep treats every non-`Review` action as
  `DeleteContent`. It is in the vocabulary with its warning, and deleting the record of a deletion
  is a decision no company has asked for yet.

---

## Completed at Prompt 34 — Objective Completion, Outcome Review and Archive

- **§27.1's lifecycle, exactly**: `Completed -> Outcome Review -> Closed -> Archived`, plus the
  controlled Pause/Resume on a live objective — as three new states on the objective's own
  transition table rather than a second table (ADR-189).
- **Pausing does not reopen the plan** (ADR-190). `Paused` is frozen like every other live-side
  state, so rethinking a paused objective is a new Draft version.
- **The review compares and does not measure** (ADR-191). Every figure comes from the module that
  owns it and is snapshotted at signing, so a signed closure cannot move afterwards.
- **Sign-off is configuration defaulting to the owner** (ADR-194), stored on the review so a
  closure stays judged under the rule it was judged under.
- **Unresolved exceptions are reported, not blocking** (ADR-193) — §27.1 asks the review to see
  them, not to require them gone.
- **Reopening is a new version and nothing else** (S-239). There is no reopen route.

### What the tests and the database found

- **A paused version would have been freely editable.** The immutability trigger listed three
  statuses and returned early for anything else, so all three new live-side states walked past it.
  A company could have paused a live objective and rewritten its Form 2 in place — the exact rule
  the trigger exists to enforce. Two further constraints had the same gap. **A CHECK that
  enumerates states must be revisited whenever the state list grows, and nothing reminds you.**
- **The pause route was gated on a grant nobody holds.** `objective:Pause` is granted on `agents`
  only. Second prompt running to ship an unreachable route, so there is now a unit test asserting
  every action this module gates on is held by some role template, and route-level tests that
  prove the decorators rather than only the service.
- **"Human effort" cannot be measured, only elapsed time** (ADR-192). The field was renamed and
  the screen says why it is not comparable with the AI cost beside it.
- **A migration that adds an enum value is not atomic.** PostgreSQL commits the label even when a
  later statement fails, and a label cannot be removed — so the statement has to be re-runnable.

### Real limitations at Prompt 34

- **Nothing stops work when an objective is paused.** `statusStartsNewWork` and
  `isObjectiveWorkAssignable` both say a paused objective assigns nothing, and the assignment path
  reads the version status — but no scheduler consults it, because the Prompt 26 business-cron
  scheduler still does not run. A paused objective with a scheduled agent would still be scheduled
  by a scheduler that does not exist yet. This is the fourth job waiting on that one.
- **`Approval` sign-off raises no approval.** The policy is honoured — a closure under it needs a
  verified approved request id, and both the service and the database refuse without one — but no
  screen raises the approval. `APPROVAL_REQUEST_TYPES` has room for it; wiring it is a small change
  this prompt did not make because no company can select the policy from a screen yet either.
- **The closure policy has no settings UI.** It is in the catalogue with a documented default, and
  the Settings screen renders the catalogue — but it has not been checked on that screen, and the
  default is what every test exercises.
- **AI cost counts only settled entries against the objective.** A run that was reserved and never
  settled contributes nothing, which is correct, and a run whose cost was settled against a
  department rather than an objective is invisible to this comparison. The ledger carries the
  attribution; the query does not yet walk up the hierarchy.
- **The closure screen is reachable only by URL.** Nothing on the objective list or the versions
  screen links to `/objective/closure` yet — the versions screen links onward but not back. A
  navigation pass belongs with Prompt 45's UI polish rather than here.
- **No report reads the outcomes.** §27.1 says "Reports retain historical outcomes" and the
  reviews are stored, indexed by verdict and closure date, ready for one. Prompt 36 is Reports.

---

## Completed at Prompt 33 — Engine Agent Memory and AI Output Feedback

- **Four governed memory modes, enforced** (ADR-181). Retention, visibility, classification
  ceiling, cross-user and cross-objective limits, and offboarding behaviour — per mode, configurable
  with documented conservative defaults, because §27.1 requires them *defined* and states no value.
  Nothing persists `Restricted` by default and only the ephemeral and approved modes may hold
  `Confidential`.
- **"No cross-tenant memory" has no code, because it is structural** (ADR-182): RLS plus a
  composite foreign key to the run. A test proves the foreign key refuses a cross-tenant write.
  There is no setting, so there is nothing to get wrong.
- **A record carries the rule it was written under** (ADR-183), so narrowing a policy later cannot
  retroactively widen or hide what an agent already kept.
- **A deletion is a deletion** (ADR-184): the content goes, the row and the reason stay, and a check
  constraint refuses the tombstone-with-data. An expiry does the same.
- **Data classification is its own module** (ADR-180), introduced here because §19 makes it the
  control over persistence, and shaped for Prompt 35 to own rather than for memory to keep.
- **Rating and promoting are two grants** (ADR-185). An Employee may judge an AI output; only
  `settings:Administer` may turn that judgement into a regression case, and a promoted case is
  `HumanJudged` because a reviewer's prose cannot be asserted mechanically (ADR-186).
- **There is nothing to disable** (ADR-187). No consent field, no adapter parameter, no route that
  could send a correction to a provider — and two tests assert the absence rather than trusting it.
- **Offboarding handles a leaver's memory inside the same transaction** (ADR-188), each record under
  the policy for its own mode.

### What the tests found

- **The promote route was unreachable by everybody.** It was gated on `skills:EditDraft`, and
  `skills` is a *platform* module — `COMPANY_MODULES` does not contain it, because the reference
  puts Skills & AI inside Settings. No company user could hold that grant, so every promotion would
  have been a 403. Moved to `settings:Administer`, the gate Prompt 17 already uses for every change
  to a company Skill, and a unit test now asserts the promote module is a company module.
- **A test asserted the wrong thing about guests.** Under the client's model an External Guest holds
  read, comment and draft, so a guest with a role may legitimately rate an output they can see — the
  guest in the fixture was refused for having no role at all. The test now says what is true.
- **The assertion kind was invented.** `Contains` does not exist; the kinds are `ExactMatch`,
  `ContainsAll` and `HumanJudged`, and `HumanJudged` is the honest one for prose (ADR-186).

### Real limitations at Prompt 33

- **Nothing schedules the retention sweep.** `sweepExpired` exists, is tested and is reachable
  through a platform route, but no cron fires it. It belongs with the Prompt 26 business-cron
  scheduler, alongside the Prompt 30 reservation sweep and the Prompt 31 period reset — three jobs
  now waiting on one scheduler, which is worth doing once rather than three times badly.
- **No run writes a memory record yet.** The write path is built, governed and tested, and the run
  engine does not call it: deciding *what* is worth remembering from a run is a prompt about agent
  execution rather than about memory governance. Every test writes through the service, which is the
  same path a run would use.
- **Approved long-term memory needs an approval that nothing raises.** The check is real — a record
  in that mode cites a verified approval id or the database refuses it — but no screen raises the
  approval request. The Prompt 28 approval engine has the type list; wiring a memory-approval type
  into it is a small change this prompt did not make because no run writes memory yet.
- **Promotion has no UI.** The route exists and is permissioned; a promote control belongs beside
  the Skill it would gate rather than beside the rating, and the Skills panel is Prompt 17's.
- **`producedByRealModel` is false everywhere**, because no provider credential has been supplied.
  Every quality figure is over mock output, and the screen says so rather than showing a percentage
  that would read as a provider's.
- **No run detail screen.** `agentRunsApi.list` was added because the feedback control needed
  something to attach to, but Prompt 26's run engine still has no screen of its own — the agents
  page's "Open runs" button has been disabled since Prompt 25. The feedback control lives in
  Settings › Agent Policy as a result, which is a reasonable home and not the obvious one.

---

## Completed at Prompt 32 — Security Center

- **A view, not a store** (ADR-174). Seven purpose-shaped views and eleven metrics, composed from
  the records each module already keeps: `security_events`, `sessions`, `tenant_memberships`,
  `connection_tool_grants`, `mfa_factors`, `sso_connections`, `break_glass_requests` and
  `role_assignments`. **This prompt added no table and no migration.**
- **"Normal tenant admins cannot edit/delete audit/security records" needed no work** — it is
  structural. The application role holds no UPDATE or DELETE grant on either trail, so PostgreSQL
  refuses with `42501` before the append-only triggers would run. The tests assert the refusal
  rather than a guard.
- **Read, export and act are three grants** (ADR-178): `settings:Audit`, plus `settings:Export`,
  plus `settings:Administer`. An `Auditor` can investigate and export and cannot sign anybody out;
  a custom role with `Audit` and no `Export` can investigate and cannot remove the evidence.
- **Company-admin session revoke now exists** (ADR-177), closing a gap Prompt 5 recorded in its own
  code. It checks the person is a member of this company, insists on a reason, records a company
  revoke as a distinct action from a platform one, and states — before the button and in the trail
  — that a session is person-level so the sign-out reaches every company they belong to.
- **No tone was invented** (ADR-176). Every judgement follows from the company's own policy or is
  not made: MFA coverage is only a problem when the company requires MFA, and a failed-login count
  has no threshold because the approved documents set none.
- **The Security Center's own exports appear in it**, as a first-class action in the Data Exports
  view.

### What the tests found

- **`Session` events were invisible.** With Active Sessions reading live state and Authentication
  Events filtering `Login` and `Risk`, the whole `Session` category — sign-outs,
  logout-all-devices, expiries, both admin revokes — appeared in **no view**. A company could not
  have seen that somebody had been signed out. `everySecurityCategoryIsReachable` now fails the
  build if any recorded category has nowhere to appear.
- **Administrators were counted by a column that does not exist.** The admin-accounts metric
  filtered `revokedAt: null` on `role_assignments`, which has no such column — a grant ends by
  expiring. Prisma refused it outright; had the column existed, an expired administrator would
  have been counted as a current one. It now uses the same live-grant predicate
  `AuthorizationRepository` uses, so "how many administrators" and "who can administer" cannot
  disagree.
- **A guest cannot exist without an expiry.** `guest_membership_has_an_expiry` refuses one, which
  is stronger than the screen flagging it. The test asserts the refusal; the badge stays as
  defence for a nullable column and should never have anything to show.

### Real limitations at Prompt 32

- **The agent high-risk view shows authority, not use.** No Engine Agent run performs an external
  tool action — runs reach AI providers through the Model Gateway only — so there is no
  tool-invocation log to read. The view shows the grants in the client's five high-risk categories
  and says this on the view itself (ADR-179).
- **No alerting.** The Security Center surfaces a figure; nothing watches it. A company that never
  opens the screen learns nothing. Notification rules over security events belong with the Prompt
  15 notification engine and the Prompt 26 scheduler, and wiring them here would have meant a
  second alerting path.
- **The export returns JSON, not a file.** The rows and the audit record are real; turning them
  into a CSV download is presentation work the reference does not specify, and the same is true of
  the audit trail's export from Prompt 8.
- **No date-range picker, only four windows.** 24 hours, 7, 30 and 90 days. An arbitrary
  from/to is supported by the underlying filters and not offered on the screen.
- **`guestHorizonDays` defaults to the company's `guestExpiryDays`** and is a query parameter. §23
  states no review period, so there is no invented default — but it also means two companies can
  read "expiring soon" differently, which is correct and worth knowing.
- **Device and location are coarse.** `deviceLabel` and `clientHint` are what Prompt 5 chose to
  record deliberately — no full user agent, no IP address — so a session row cannot answer "from
  where exactly". That is a privacy decision, not a gap.
- **Sessions are person-level throughout.** The Active Sessions count, the list and the revoke are
  all confined by the membership list rather than by RLS, because `sessions` has no `tenant_id`. It
  is tested, but it is a different mechanism from every other tenant-scoped read in the product and
  worth remembering.

---

## Completed at Prompt 31 — Credit Top-Up, Reallocation and Commercial Edge Cases

- **The company asks and Finance decides**, on different planes (ADR-168). There is no company
  route that approves anything and no company control that looks like one — that separation is
  the control, and everything else in the prompt is bookkeeping.
- **Credit arrives in lots** (ADR-166). Top-up expiry forces it: expiring "the ₹40,000 from
  March" means knowing which part of the allowance it was. Carry-forward and plan changes reuse
  the same shape.
- **Every commercial term is configuration** (ADR-165), because UBoss_Final_1 line 1048 asks for
  them to be *defined* and states no value. Each has a documented, conservative default — and the
  one that matters: **a purchased top-up does not expire unless somebody says it does.**
- **Reallocation cannot create allowance** (ADR-170): two equal and opposite entries, against
  *uncommitted* budget only, so reserved money cannot be moved out from under a run.
- **All seven edge cases implemented**: monthly reset, carry-forward (three policies), top-up
  expiry, refunds/promotional/manual adjustments, plan change mid-cycle (three policies),
  payment failure after top-up, and negative balance with an optional grace.
- **Only a run blocked by budget resumes**, and it is re-queued rather than run (ADR-172), so
  every other permission, approval and limit applies again.
- **No second way to move money.** Every flow goes through `CostEngineService.adjustAllowance`,
  and the suite's last test performs a top-up, a reallocation, an expiry and a revocation and
  then asserts `reconcile` finds nothing.

### Verified

types 45/45 for credits (98/98 with the Prompt 30 cost tests), `credits.e2e` 40/40, and
cost-engine 33/33 plus platform-console 46/46 as regressions after `adjustAllowance` changed its
contract. Web 30/30, `tsc` clean in all three packages, `next build` clean, eslint clean.

Prompt 30's full-verify checkpoint ran the whole API suite: **1561/1561 in 287 suites, 0 failures**.

`npm run lint` is clean repo-wide again, which it had not been for several prompts: forty
unused imports and fixture values had accumulated across fourteen older specs, and a red lint
gate hides the next real one. Ten of them were `reachabilityFailureReason`, imported and never
called — those specs now say *why* the database was unreachable instead of only that it was.
The 178 tests in the specs touched still pass.

### Four defects the tests found

1. **The ledger kind carried the wrong sign.** `adjustAllowance` moved the wallet by the raw
   delta, so an `Expiry` was passed as a negative number — which
   `ledger_amount_sign_matches_its_kind` refuses, and which `replayLedger` would have read back as
   an *increase* if it had not. Direction now comes from `LEDGER_EFFECT` and the amount is a
   magnitude (ADR-171). The maintained balance and the replayed ledger have to be the same
   arithmetic or `reconcile` means nothing.
2. **A withdrawal was recorded as a `Refund`.** `Refund` reduces what has been *used*; taking back
   an unpaid top-up removes allowance that was never spent. As written it would have left the
   allowance intact and written off real spend. The test asserted the same wrong kind, and both
   were corrected — the vocabulary was right and the reasoning around it was not.
3. **Two clocks in one operation.** `applyPeriodReset` was given a period boundary and used it for
   the new grant's `effectiveFrom`, but `grant` judged liveness against `Date.now()` — so the
   reset wrote off the unused allowance and then recorded the new period's allowance as
   future-dated, granting nothing back. A company would have opened the month with nothing. The
   clock now travels with the operation.
4. **A missing plan allowance would have zeroed a budget.** `monthlyAllowanceMinor` fell back to 0,
   so a reset with no `tenant_ai_budget_policies` row would write off everything and grant nothing
   back. It now refuses to reset and says why.

### Two defects found by reading, before anything ran

1. **The period reset was arithmetically wrong.** `usedMinor` is cumulative because the ledger is
   immutable, so writing off the whole previous allowance would have left last period's spend
   still subtracted from the new period's budget — a company using ₹10,000 of ₹100,000 would
   start the new month able to spend ₹90,000. Only the *unused, non-carried* part lapses
   (ADR-165's worked examples), and a test now pins the remaining figure rather than the
   allowance total.
2. **`grant` was not atomic.** Row, balance movement and audit ran in three transactions; a
   failure between them leaves a grant the company can see and cannot spend, with `reconcile`
   finding nothing wrong because neither wallet nor ledger moved. Both `grant` and `revokeGrant`
   are now one transaction.

### Real limitations at Prompt 31

- **No payment is taken, anywhere.** No payment provider is integrated or approved. A request
  records an amount, a reason and a billing *intent*; Finance records the invoice reference from
  whatever system actually bills. This is **not** a purchase flow and nothing in the product
  claims it is (ADR-173).
- **Nothing runs the periodic jobs on a schedule.** `applyPeriodReset`, `expireGrants` and the
  Prompt 30 reservation sweep all exist, are tested, and are reachable through platform routes —
  but no cron fires them. Wiring them belongs with the Prompt 26 business-cron scheduler, and
  doing it here would have meant a second scheduler.
- **A future-dated grant is not applied by anything automatic.** It is recorded and excluded from
  the allowance until its date, and the allowance moves when a reset or another grant runs. Until
  the scheduler exists, a future-dated top-up needs an operator to trigger the reset.
- **`applyPlanChange` is called, not observed.** Nothing watches the subscription and applies a
  plan change automatically; Finance calls the route. Hooking it to a plan change event is a
  billing-integration question this prompt does not own.
- **Reallocation is company-wide, not "within delegated limits".** §20 says "within delegated
  limits" and no limit model is defined anywhere in the approved documents. A Company Admin can
  move any uncommitted budget between any two levels. The extension point is
  `validateReallocation`, which already takes the source's uncommitted figure and would take a
  delegated cap the same way.
- **The credit history view is the ledger, not a separate statement.** §20's "credit
  purchase, addition, adjustment, reallocation, deduction, release, refund, approval and
  resulting balance" are all ledger kinds, shown in the Prompt 30 panel. A dedicated
  finance-facing statement with running totals per period is not built.
- **Currency is single and assumed.** Every wallet, grant and request carries a currency and
  the engine refuses to mix them implicitly, but there is no conversion and no multi-currency
  company. A company operating in two currencies would need a wallet per currency, which the
  schema allows and nothing exercises.

---

## Completed at Prompt 30 — Tokens, Credits, Budgets and Reserve/Settle Ledger

- **§20's flow, in full**: Check → Estimate → Reserve → Execute → Provider actual usage → Settle →
  Release unused reserve → Reconcile.
- **Concurrency-safe by row lock, not by hope.** `reserve` locks every wallet in the hierarchy
  with `SELECT ... FOR UPDATE` in a fixed outermost-first order and decides *inside* the lock
  (ADR-153). Two e2e tests fire ten and twenty genuinely concurrent reservations and assert the
  total held never exceeds the allowance.
- **The four-level hierarchy holds at every level at once** — a reservation that held only against
  the company budget would let an objective exceed its own.
- **An immutable ledger beside a maintained balance**, with `reconcile` proving they agree
  (ADR-156). Drift is reported and never corrected.
- **Three controls stay three** (ADR-158): a warning notifies, an approval threshold asks a
  person, a hard stop refuses.
- **The whole flow lives in the Model Gateway** (ADR-161), so five existing call sites gained cost
  governance without one of them changing — which is what the Prompt 29 single-seam rule buys.
- **Settings › Tokens & Cost** implements the reference's `setTokens()` with §20's fuller figure
  set, and repeats the reference's own rule that these widgets never appear on the Dashboard.
- **Redis is deliberately not in this path** (ADR-160). PostgreSQL is the source of truth and a
  second counter would be a second truth with no reconciliation story.

### Two real defects, both found by the concurrency tests

1. **The hard stop was off by one** — it refused the spend landing exactly on the allowance, so a
   company that bought ₹10,000 could only ever spend ₹9,999 (ADR-157). It is now compared in minor
   units, strictly past the ceiling.
2. **A threshold notification could fail a reservation** — twenty concurrent reservations raced on
   one dedupe key and the unique-index error escaped, failing writes that were already correct
   (ADR-162). A notification can never fail a money movement.

### Real limitations at Prompt 30

- **Nothing resets or expires an allowance yet.** `resets_at` and `expires_at` are stored and
  displayed; no job acts on them. Monthly reset, carry-forward and top-up expiry are **Prompt 31's
  commercial edge cases**, and implementing half of them here would have produced a reset that
  disagreed with the top-up rules arriving next.
- **Top-up and reallocation are not requestable.** The buttons are present and disabled, marked as
  Prompt 31. `setAllowance` is the platform-side act of setting a number, which is what Prompt
  31's approval flow will call.
- **The commercial allowance above the company budget is not enforced.** §20's hierarchy starts at
  "Commercial allowance", which lives on the subscription; the company wallet is seeded from
  `tenant_ai_budget_policies` at creation and is not re-checked against the plan afterwards. A
  company whose plan shrinks keeps the wallet it had.
- **Thresholds are derived from the existing budget policy, not configured directly.**
  `warningPercent` maps to Warning and the two absolute limits convert to percentages. §20 wants
  them configurable, and they are — through Settings › Tokens & Cost's existing policy fields
  rather than a new four-field form, which would have been a second home for the same numbers.
- **The reservation sweep has no scheduler entry.** `sweepExpiredReservations` exists, is tested,
  and is reachable through `POST sweep-reservations`; wiring it to the business-cron scheduler
  belongs with the Prompt 26 scheduler work.
- **`used_minor` has no upper bound and remaining can be negative.** Deliberate (ADR-159), but it
  means a single very expensive call can take a company past its hard stop before anything can
  refuse it. The estimate is pessimistic to make that rare; it cannot make it impossible.
- **Drill-down is one level deep in the UI.** The API returns every wallet and the ledger can be
  filtered by run, so company → department → objective → agent → run is answerable; the panel
  shows company and the levels beneath it in one table rather than as a navigable tree.

---

## Completed at Prompt 29 — AI Provider Profiles and Model Gateway

- **The locked rule is now structural.** Technical Architecture §18 — "provider names are
  configuration, not business object identity" — is kept by construction: `ModelRequest` carries a
  required `LogicalModelProfile` and has no field a provider or model name could occupy, and a
  unit test asserts the profile and provider vocabularies are disjoint (ADR-144).
- **The five logical profiles are transcribed, not designed.** `LOGICAL_MODEL_PROFILE_SPEC` holds
  §18's own sentences; the machine-readable defaults beside them say which phrase they read.
- **All three provider modes**, with §19's own descriptions. §19's fourth row, *Auto / Policy
  Choice*, is deliberately not a fourth mode — it states the behaviour logical profiles *are*, and
  modelling it as a mode would have made "policy chooses" opt-out-able.
- **Anthropic and OpenAI adapters behind one interface**, written against their real APIs and
  refusing without a credential, plus a custom-endpoint adapter driven entirely by stored
  configuration. All four registered, so `usesRealModel` reports the absence rather than leaving
  it to be inferred (ADR-149).
- **Immutable, versioned pricing** a call cites (ADR-147), **lifecycle where
  `MigrationRequired` actually refuses new work** (ADR-146), and an append-only call record with
  the provider's own request id and exact usage.
- **`/master/providers`** is live, and its two unmeasurable KPIs say so instead of showing zeros.

### Three real defects found and fixed, all mine

1. **The audit event violated `audit_events` RLS** — audited from inside a platform operation,
   where no tenant scope is declared. The policy was right (S-196).
2. **The test reset left provider configuration mutated between tests** — clearing only
   tenant-owned rows left a deprecated model or a deleted route standing, and the order-dependence
   surfaced as "no model is configured" elsewhere (ADR-152).
3. **An import cycle** — the `PROVIDER_ADAPTERS` token in the module that imports the service that
   needs it. ESM failed the whole suite before one test ran (ADR-151).

### Real limitations at Prompt 29

- **No provider has ever been contacted.** The Anthropic and OpenAI adapters are implemented
  against the real APIs and have never run: no credential has been supplied. Every gateway call
  today is answered by the mock adapter and recorded `producedByRealModel = false`, and the
  database refuses a provider request id on such a row. **This is not a live, credential-verified
  integration and nothing in the codebase claims it is.** Supplying `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY` plus a registered profile is the whole of what is missing.
- **`AGENT_FAST` and `HIGH_REASONING` have no caller.** Configured, routable and tested; nothing
  selects them (ADR-145). `HIGH_REASONING` should wait for Prompt 30's budget guardrail.
- **p95 latency and fallback rate are not computed.** The data is there —
  `model_gateway_calls.latency_ms` and `used_fallback` — but with mock calls the answer is zero,
  so the screen says the figures need real calls rather than showing them.
- **The custom adapter's request body shape is a guess.** `{model, max_tokens, instruction,
  input}` is not from any approved specification, because the source documents describe the field
  list of a custom profile and not the wire format of a customer's endpoint. The usage *mapping* is
  configurable and the body is not; a real enterprise endpoint will likely need a request template,
  which is the extension point.
- **Provider health is not monitored.** Test Connection is on demand. Nothing polls, and no
  exception is raised when a provider starts failing — the run engine's
  `ProviderOrToolUnavailable` block is what the Executor sees, one run at a time.
- **A company cannot see or choose its own mode.** Modes are set by platform staff, which is what
  §19 describes ("employees do not manage provider keys"). If a company-facing read of "we are on
  BYOK" is wanted, that is a new decision rather than a gap here.
- **`RoutingModelGateway` retries at most once across candidates.** Enough to exercise fallback;
  not a considered retry policy. The run engine owns retries and already has one.

---

## Completed at Prompt 28 — Approvals, Delegation and Four-Eyes Controls

- **One approval table across every domain.** `approval_requests` gained four columns rather than
  a sibling per module (ADR-136), and every domain now raises rows through `ApprovalService.raise`
  instead of writing its own. Which permission decides a request comes from its type
  (`APPROVAL_TYPE_MODULE`), so an agent activation needs `agents:Approve` and a workflow publish
  needs `objective:Approve`.
- **Separation of duties was not reimplemented.** `checkSeparationOfDuties` and the mandatory
  platform `NoSelfApproval` control from Prompt 7 do the work; the Approval Engine feeds them the
  requester and the decision history (ADR-137). A workflow step's `FourEyes` gate reaches the same
  engine as an additional policy through the new `AuthorizeInput.additionalSodPolicies`.
- **The immutable decision record is a table with two triggers** — a verdict cannot change, a
  request cannot reopen, and the history cannot be edited or deleted (ADR-139). A corrected
  submission is a new row pointing back through `supersedes_id`.
- **Delegation moves routing, never authority** (ADR-140), bounded to a quarter by a check
  constraint, revocable immediately, and resolved deterministically when several cover one moment.
- **Escalation moves attention, never the verdict** (ADR-141), one step up the reporting hierarchy,
  and to nobody rather than to an invented recipient.
- **The `/approvals` screen** is the reference's queue and decision view, with every button
  rendered from the server's own `available[]`.
- **All three items Prompt 27 deferred are closed**: the Executor's `RequestApproval` now creates a
  real row somebody can see; escalation walks the hierarchy instead of looping back to the owner;
  and Prompt 25's `approvedByUserId` is now a verified `approvalRequestId`.

### Four real defects found and fixed, three of them mine

1. **Three approval types were undecidable by anybody.** The first type→module mapping pointed
   `WorkflowStepApproval` at `todo`, `OutputApproval` at `executor` and `GuestAccess` at `users`,
   and no role template grants `Approve` on any of those three. Those requests could be raised and
   never decided. Now governed by `approvals`, with `everyApprovalTypeIsDecidable` pinned against
   the real templates.
2. **`FourEyes` was being read as a role.** `STEP_APPROVAL_KINDS` puts that literal into
   `approver_role_kind`, and treating it as a `RoleKind` addresses the request to a role with no
   members — every four-eyes gate in the product would have deadlocked (ADR-138).
3. **The security trail had a gap.** `authorize` was being called inside a tenant transaction, so
   the `security.separation_of_duties_blocked` write was refused and a blocked self-approval left
   no record. Permissions are now evaluated outside the transaction (ADR-142). This was the most
   serious of the four because it failed silently, in the log only.
4. **A pre-existing four-eyes bypass in Prompt 25.** `activateVersion` trusted a caller-supplied
   `approvedByUserId`, so anybody with `agents:Publish` could satisfy the requirement by typing a
   colleague's uuid (ADR-143). Not introduced by this prompt; closed by it.

### Real limitations at Prompt 28

- **`APPROVAL_TYPE_RISK` is presentation, and three of its eight levels are reasoned rather than
  transcribed.** Five come from the reference UI's own sample rows. `HighRiskAction`, `GuestAccess`
  and `WorkflowStepApproval` have no row in the reference, so their levels are argued in the
  vocabulary's comment. If the client has a risk model, this is the extension point — nothing
  authorizes off it, so replacing it is safe.
- **The "Decided" tab filters client-side.** The server has no word for "any settled status", so
  the screen fetches and filters. Fine at the current 300-row cap; it needs a server-side filter
  before a company accumulates thousands of decided requests.
- **Overlapping delegations are resolved by convention, not by constraint.** The database allows
  two delegations from one person covering the same moment, because type-scoped cover is a real
  arrangement. The service picks the more specific, then the most recent. That is deliberate and
  tested, but it is a service rule rather than a schema one — an exclusion constraint would need
  `btree_gist` and would forbid the legitimate case.
- **`escalateAllCompanies` has no scheduler entry yet.** The method exists and continues past a
  failing tenant, and the per-company sweep is reachable through `POST escalate`. Wiring it to the
  business-cron scheduler belongs with the Prompt 26 scheduler work rather than here.
- **A request whose type has no governing module is refused at decision time**, not at creation.
  It cannot happen through `raise`, which validates the type, but a row written directly would sit
  in the queue and report why it cannot be decided.
- **`decide` re-reads the row inside the write transaction** to turn a race into a readable
  conflict. The actual guarantee is the `uboss_approval_decision_is_final` trigger, not that check.

---

## Completed at Prompt 27 — Executor Agent and Exception Center

- **The ten exception types**, each with the source document's default owner and a reasoned default
  severity. `High` is reserved for the three that mean the company is exposed now — a permission
  the agent should not have attempted, a budget already hit, a failure past its threshold. A
  provider outage is `Medium` however dramatic it sounds, because it clears itself.
- **The locked rule is enforced three times over** (ADR-131): the vocabulary has no word for the
  Executor closing something, the service refuses it, and a database CHECK refuses the row. There
  is no route through which a caller can act as the Executor at all.
- **The validation order is code, not prose** (ADR-133). A failed deterministic check ends it
  without a model call; a configured high-risk action is `Deferred`, never `Passed`, until a person
  decides.
- **The sweep closes Prompt 26's open boundary**: a dead-lettered run becomes a `RepeatedFailure`
  exception with the attempt count and correlation id as evidence, and each of the four blocked run
  states becomes the exception kind whose owner can clear it (ADR-132).
- **One condition holds one open exception**, by partial unique index, so sweeping repeatedly does
  not fill the queue with copies of the thing nobody has fixed. A recurrence after a resolution
  raises a new one.
- **The resolution history is append-only and attributed**, per entry, to a person or the machine.
- **An acknowledgement does not stop the aging clock** (ADR-134), and an unowned exception is never
  escalated to nobody — it stays open and reports itself overdue.

### Real limitations at Prompt 27

1. **No timer drives the sweep.** `sweepAllCompanies` exists and one sweep is exposed per company
   over HTTP; nothing calls either on a schedule. Same position as the run scheduler, and the same
   reason: no background work runs unobserved before it is wanted.
2. **`RequestApproval` records the intent but creates no approval.** The Approval Engine and its
   queue are Prompt 28. Today the action is captured in the resolution history and the exception
   stays open — honest, but a person still has to go and start the approval themselves.
3. **Escalation routes to the exception's existing owner**, not up a hierarchy. The source
   document's escalation paths are per-kind ("employee reminder then manager escalation", "manager
   / Head based on threshold"), and resolving those needs the reporting tree plus the delegation
   rules that Prompt 28 introduces. Until then escalation is a state change and a notification
   target rather than a route to a *different* person, and `EXCEPTION_DEFAULT_OWNER` carries the
   intended path as text so it is visible rather than lost.
4. **No notification is sent when an exception is raised or escalated.** The audit event is
   written and the queue shows it. `notifications.notify_on_agent_exception` already exists as a
   company setting from Prompt 15 with nothing producing it; wiring the two together is small and
   belongs with the escalation routing above.
5. **`MissingEvidence` and `ValidationFailed` are never raised by the sweep.** Both are real kinds
   with owners and resolutions, and `validate()` returns `ValidationFailed` — but nothing yet calls
   `validate()` on a completed human task's evidence. The detector for that needs the evidence
   rules per task, which the To-do module holds; the exception kind is ready for it.
6. **The Exception Center's reassign and escalate ask for a user id.** There is no person picker
   yet, so the drawer prompts for an id. The server validates it; the screen is unfinished.

---

## Completed at Prompt 26 — Run Engine, Queue and Scheduler

- **The durable row exists before the work.** A crashed worker leaves a run somebody can find, not
  work that silently never happened. Everything else follows: the queue is transport, the row is
  the truth, and live progress is a convenience.
- **Thirteen states, transcribed from the architecture and made total.** The four `Blocked by`
  variants stay four states because four different people resolve them, and `BLOCK_OWNER` records
  who. `Queued → Reserved → Running` is enforced by the transition table *and* a database CHECK,
  because `Reserved` is where budget is set aside.
- **Idempotency is the scheduler's safety.** Two ticks noticing one due moment produce one run; a
  person pressing the button twice gets two. No lock is needed anywhere.
- **BullMQ on Redis ships** (compose publishes it on 6381), behind a seam with an inline
  single-process implementation that genuinely performs runs. `isDurableTransport` is reported so
  nobody guesses.
- **Retries are the engine's, classified and bounded**, with BullMQ's own retry machinery switched
  off so a run cannot be attempted more often than the company configured. The dead-letter path
  preserves the whole attempt history.
- **The scheduler works in the company's timezone**, honours working days and holidays, and
  refuses a cron expression outside the business subset rather than approximating one.
- **Run events are append-only by trigger**, so live progress is never the record.

### Real limitations at Prompt 26

1. **No WebSocket transport yet.** `RunProgressGateway` is the publisher and is fully tested; what
   is missing is the socket server that carries its events to a browser. Deliberate: the
   architecture requires that live updates never replace durable state, so the durable side was
   built first and the wire is additive. `@nestjs/websockets` is not yet a dependency.
2. **No runs screen.** The registry's `Run now` and `Open runs` buttons are still disabled even
   though the routes now exist and are tested. Presentation work over a complete API.
3. **`Reserved` sets no actual budget aside.** The state, its ordering and its constraint are in
   place, and the cost ledger is Prompt 30 — so today the reservation is a checkpoint with nothing
   behind it. A run therefore cannot yet reach `BlockedByBudget` on its own; the state and its
   handling are tested by steering the executor.
4. **Nothing yet raises an exception row from a dead-lettered run.** The context is preserved on
   the run (`dead_lettered_at`, the failure reason, the full event history, the correlation id) and
   audited. `ExecutorExpectation` is foreign-keyed to an objective *version*, which a run started
   directly against an agent does not have — writing the agent id there would have been fabricated
   linkage. Prompt 27 owns the Exception Center and can find these precisely.
5. **No timer drives the scheduler.** `tickAllCompanies` exists and one tick is exposed per company
   over HTTP; nothing calls either on a schedule. A cron or a BullMQ repeatable job is the last
   piece, and leaving it out means no background work runs unobserved before it is wanted.
6. **Concurrency is per-agent, not per-tenant.** The overlap policy bounds runs of one agent. There
   is no tenant-wide concurrent-run ceiling or queue fairness yet; the architecture asks for both
   at the rate-limiting layer, which is a later prompt.
7. **An agent activated through Agent Builder has no machine-readable schedule.** Prompt 24 records
   the trigger as free text, so `schedule_cron` is null and the scheduler ignores the agent
   entirely rather than guessing a cron from a phrase. Setting it needs a UI or an API field on the
   version flow — worth closing when the runs screen is built.

---

## Completed at Prompt 25 — Engine Agent Registry and Versioning

- **The registry shows every field the source document lists** (§17), plus the memory mode and
  connection the prompt adds. Its action set is *derived* from the status lifecycle rather than
  restated, so a screen cannot offer a button the service will refuse.
- **Agent → Assignment/Job → Run is structural.** The registry owns the agent and runs nothing.
  `Run Now` and `Open Runs` are reported as permitted and have no routes, because the engine is
  the next prompt and a route that queued nothing would be indistinguishable from one that worked
  (ADR-122).
- **Versioning is draft → test → activate**, with the published version frozen by a trigger that
  now also covers the impact analysis and the test result — the things a reviewer relied on. One
  open draft per agent, enforced by a partial unique index.
- **Approval "where required" is concrete** (ADR-124): a new tool category, memory that starts
  outliving the run, or an agent more than one objective depends on. Narrowing needs no approval,
  and the activator may not be the approver.
- **Memory mode is declared and constrained** to the architecture's four, defaulting to the only
  one that persists nothing.
- **Health and usage report absence rather than a plausible figure** (ADR-123).

### Real limitations at Prompt 25

1. **No runs, so no real health, cost, or last/next run.** Every one of those fields is null with
   `hasRunData: false`. They become real at Prompts 26 and 30, and nothing here has to be undone
   for that.
2. **An agent serving several departments resolves to the first** for the scope decision. The
   assignment rows carry the objective, and the objective carries the department; an agent shared
   across departments would need a set rather than a single value, and the scope engine takes one
   `departmentId`. Stated rather than hidden — it cannot leak across tenants, but a Head of one
   department could reach a shared agent whose first assignment is in another.
3. **No approval *record*.** `approvedByUserId` is supplied by the caller and checked against the
   activator, but there is no row in the Approvals queue proving the approval happened. The
   Approval Engine prompt owns that table, and this should route through it rather than trusting a
   parameter. Worth closing at Prompt 28.
4. **The registry screen has no version editor.** The API supports draft/test/activate fully and
   the drawer shows what a draft would change, but creating one from the UI is not wired. It is
   presentation work over a complete API.
5. **Memory is declared, not enforced.** Nothing yet writes or reads agent memory; Prompt 33
   implements retention, visibility, deletion, sharing limits and offboarding. The declared mode
   is what that prompt will enforce against.

---

## Completed at Prompt 24 — Agent Builder

- **The ZERO-QUESTION RULE lives in one function.** `missingSetupFields` in the shared types is
  what both the screen and the server consult, so they cannot disagree about whether a question
  needs asking. An empty result is the client's requirement met literally: show *Ready to Test /
  Activate* and ask nothing extra. Two cases it deliberately stays silent about — a manual agent's
  schedule, and a connection for work whose Definition of Done lists no tools — because asking
  either is exactly the unnecessary question the rule forbids.
- **Nothing is re-entered.** Prompt 23 already wrote an `AgentSetupPrefill` per AI node from the
  objective, the edited workflow and policy; this prompt reads it. `Approval Required` and
  `Completion Evidence` are shown as policy-derived and never asked.
- **Form 3 is a view, exactly as the source document defines it** — "the complete job-definition
  view for authorized users … not a blank form every employee must re-enter". Eight job-level
  field groups and seventeen action columns, transcribed from the document, composed from Form 2,
  the manager's workflow and the execution setup. It reports which record each part came from, so
  it never reads as a document nobody wrote.
- **One agent, then Runs.** Activation creates the reusable Engine Agent and its first published,
  immutable version in one transaction. A second activation of the same work is refused by name.
- **A published configuration is frozen by a trigger**, because Runs will cite it as what produced
  their output; editing it in place would silently rewrite the provenance of every past Run.
- **A mock is never dressed as a live provider.** Every stored test result records whether a real
  model was involved, and a database CHECK refuses a result that will not say. The screen states
  which it was in words.

### Real limitations at Prompt 24

1. **An activated agent has no tool permission yet.** The Agent Tool Permission is granted to an
   agent by an administrator (`settings:Administer`), and cannot exist before the agent does — so
   a freshly activated agent whose work needs a connection will have its runs refused until that
   grant is made. This is surfaced as a Warning on the readiness panel rather than left to be
   discovered at the first run (ADR-119, S-162). Closing it properly means either a grant step in
   the activation flow for an actor who holds `settings:Administer`, or a per-assignment grant
   concept — a product decision, not a bug to patch.
2. **The connection field is a typed id, not a picker.** The server validates it against the
   company's connections, so a wrong id is refused rather than accepted, but the screen does not
   yet list the approved connections to choose from. It needs the connections module's own list
   endpoint, which exists; wiring it is presentation work.
3. **`Test Agent` proves the gateway answers, not that the work is correct.** It runs the assigned
   work through the Model Gateway once and records whether output came back. With the mock gateway
   that is all it can mean. It deliberately writes nothing to the real output destination — a test
   that delivered would not be a test.
4. **No Engine Agent registry yet.** There is no list, no Run Now, no pause, resume, archive or
   new-draft-version flow. The identity, the status vocabulary, the transition table and the
   immutable-version rule are all in place for the next prompt to build on; it extends this
   module rather than introducing a second one.
5. **Renaming is unrestricted at activation.** The source document says "Auto-generated; rename if
   policy permits", and no policy value for that exists yet, so a rename is currently always
   allowed (uniqueness per company is still enforced). A missing policy value with no safe default
   would be worth a client decision if it mattered more; permitting a rename is the behaviour the
   document describes by default.

---

## Completed at Prompt 23 — Approve & Assign Transaction and Human To-do

- **Approve & Assign is a real transactional boundary** (ADR-115). Four phases: read, validate,
  write in one transaction, notify after the commit. A forced mid-transaction failure leaves the
  company untouched — the version not live, the plan unfrozen, and no orphaned work — which a test
  pins by forcing a genuine partial failure rather than mocking one.
- **All seven of the client's checks, with every failure returned at once.** Workflow schema and
  version, owners and assignees, permissions, required approvals, connection readiness, budget
  estimate policy, no prohibited high-risk path. A manager fixing one blocker at a time and
  re-running is being told the truth in instalments.
- **It does not approve** (ADR-116). The version must already be approved, and the refusal says
  approving is a separate act. The role templates give a `Manager` `objective:Assign` and not
  `objective:Approve`, so auto-approving would be a real privilege escalation behind a button
  label.
- **One approvals table, generic from the start** (ADR-114), carrying the Approval Engine prompt's
  whole type vocabulary. The client's requirement is approvals "without duplicating separate
  approval tables per module", so that prompt extends this table rather than introducing a second.
- **Human nodes become To-do tasks** carrying everything the client's UI list names — task,
  Objective, Assigned By, input, due/trigger, expected output, evidence, dependencies, approval —
  on the row, so a task still reads correctly after the objective moves to a new version.
- **AI nodes become assignments awaiting Agent Builder setup**, with the prefill the next prompt's
  zero-question rule needs. It never creates an Engine Agent: recurring work creates Runs, and the
  relationship is Agent → Assignment → Run. This is the Assignment.
- **The Executor Agent is told what to watch**, in its own prompt's exception vocabulary. An
  expectation nobody recorded cannot be unmet: a task with no recorded due time can never be
  reported overdue.
- **Submit & complete is one action with two outcomes** — straight to completed when no approval is
  required, to `WaitingApproval` with an `OutputApproval` raised when one is. Submitting without
  required evidence is refused with the requirement quoted, rather than accepted and flagged
  afterwards.
- **`Overdue` is derived, not stored** (ADR-117), so a task can be waiting on somebody else and
  late without either fact being lost.
- **`/todo` and `/todo/detail`**, from the reference — and deliberately **not** its "To-do &
  Approvals" merge, which the locked rule forbids.
- **Approve & Assign is live on `/objective/prepublish`**, enabled even when the summary reports
  blockers, because the server is the authority on readiness.
- **70 tests** (33 e2e, 37 shared-type). Two real defects found and fixed, one of them mine from a
  previous prompt.

### Real limitations at Prompt 23

1. **An approval gate names a role, not a person**, unless a manager named one in the editor.
   Resolving a role to the people who hold it belongs to the Approval Engine prompt; guessing here
   would notify somebody with real authority over a decision that was never theirs. Both branches
   are implemented and tested.
2. **No assignment notification is sent to assignees.** The approved catalogue has six kinds and
   none of them is "work was assigned to you"; its `Overdue` kind is explicitly this prompt's. New
   work appears in the To-do list and lateness raises the alert. Adding a seventh kind would change
   an approved vocabulary with no source asking for it — a cheap change if the client wants one.
3. **The budget estimate check cannot be evaluated** (ADR-118). The policy is in currency, the
   estimate is in tokens, and no provider pricing exists yet. The check records that it could not
   price the estimate and permits; the hard stop is enforced when work runs. Nobody reading the
   audit trail will conclude the budget was verified.
4. **`Overdue` notifications need a scheduler to fire.** The derivation, the due times and the
   Executor expectations are all real; nothing wakes up to send the notification. Same missing job
   runner as Prompt 21's limitation 2.
5. **Task evidence is a reference, not a stored file.** No prompt has specified file storage for
   it, and an upload path would create a place for company documents that nothing else in the
   product governs — no retention rule, no export policy.
6. **Due times are derived from the objective's target completion time**, and working days are
   approximated as calendar days. No working calendar or holiday rule is modelled yet; that is the
   Run Engine prompt's. A task whose objective set no target has no due time and is never reported
   late.
7. **`engine_agent_id` has no foreign key.** The Engine Agent registry is the next-but-one prompt.
   A CHECK constraint ties the column to the status so a row cannot claim a mapping it does not
   have; the registry prompt adds the key.
8. **`Test workflow` remains disabled.** Nothing can execute a workflow until the Run Engine.
9. **The `team` filter is authorization, not a query.** It fetches and then asks the resource check
   per row. Correct, and O(n) permission checks per page — fine at present volumes, and the place
   to look first if the To-do list ever feels slow.

### One lesson worth carrying forward

**Moving a database read out of a transaction is as dangerous as forgetting to open one.** S-151 is
the fourth instance of the unscoped-read-under-RLS class, and the first where the code was correct
when written and broken by a refactor that moved it — with the comment warning about that exact
hazard still sitting above it. An unscoped read returns an empty result, not an error, so its
meaning depends entirely on how the caller reads it; here it read as "this person has no active
membership" and refused every valid publish. A comment does not protect the code beneath it.

---

## Completed at Prompt 22 — Workflow Graph Editor and Pre-Publish Readiness

- **The AI's proposal and the manager's plan are two records** (ADR-110), on the client's explicit
  approval. `objective_analysis_runs` stays frozen as what the AI suggested;
  `objective_workflow_drafts` is what the company decided. Seeding happens on **open**, so an
  analysis nobody opens leaves nothing behind and re-analysing never discards a manager's edits —
  both pinned by tests.
- **Every manager action the client listed**: edit title and details, change the assignee, Human ↔
  AI conversion where allowed, add and delete nodes, reorder and reconnect, dependencies,
  sequential and parallel paths, IF/ELSE conditions, wait/approval gates, failure branches, and
  event triggers.
- **The Definition of Done is a structure, not a paragraph** — expected output, criteria, evidence,
  dependencies, tools, approval, failure condition. Schema version 2. It had to be structured
  because the Pre-Publish Summary counts nodes with **incomplete fields**, and a paragraph cannot
  be partially missing.
- **Version 1 drafts still open** (`upgradeWorkflowDraft`). The flat strings are lifted into the
  parts they correspond to, and the parts version 1 never recorded are left **blank** — so the
  summary reports them incomplete rather than inventing content a manager never wrote.
- **Every edit carries its revision** (ADR-111). A stale one is refused with both numbers named, a
  database trigger refuses a rewind, and the whole graph is revalidated on every write so a draft
  cannot rot one edit at a time.
- **Human → AI needs an approved, published Skill** (ADR-112), otherwise the conversion would
  create a step nothing can perform. AI → Human is always allowed and clears the Skill.
- **The Pre-Publish Summary reports readiness; it does not grant it** (ADR-113). All twelve client
  items, `Blocker` / `Warning` findings, cost as a range with its basis. A test pins that reading it
  moves nothing.
- **An assigned plan is frozen** in the service and in the database, for the same reason a live
  objective version is: people are already working to it.
- **`/objective/workflow` and `/objective/prepublish`**, from the reference's effective
  definitions — Form 2 left, flow right, the four-swatch legend, and the action row in its own
  order.
- **88 tests** (45 e2e, 34 shared-type, 9 component), taking the suite to **1634 passing** —
  API 1260, shared types 242, UI 102, web 30. One real product bug found and fixed: S-150, plus a
  CHECK constraint of my own that failed open.

### Real limitations at Prompt 22

1. **Still no AI provider.** Unchanged from Prompt 21: the plan a manager edits was proposed by a
   mock. The editing, validation, concurrency and readiness reporting are all real.
2. **Nothing is assigned yet.** `Approve & Assign` and `Test workflow` are present and disabled;
   Prompt 23 owns the transaction, and `readyToAssign` is a report that Prompt 23 must revalidate
   rather than trust.
3. **"Assign AI node → Agent Builder" is disabled.** Agent Builder is Prompt 24.
4. **Workload conflict detection is structural, not calendrical.** It reports a person holding more
   concurrent steps than the plan can honour; it does not read their other objectives or a
   calendar, because neither is modelled yet.
5. **Missing connections are read from unrevoked tool grants, not from connection health.** A
   category whose connection is granted but broken, expired or never tested still reports as
   available. Narrowing that needs a health signal the connection model does not yet expose, and
   guessing from grant state alone would report a readiness the company does not have.
6. **`Condition` and `Trigger` nodes are creatable but never generated.** Form 2's grid has no
   branch or event column, so the analysis cannot infer them; a manager adds them by hand.
7. **The graph is stored as JSON, so the database guarantees its shape, not its content.** Six
   CHECK constraints and two triggers cover the shape and the lifecycle; node-level correctness is
   `validateWorkflowDraft`, which runs on every write.

### One lesson worth carrying forward

**A CHECK constraint treats NULL as satisfied — again.** Prompt 13 hit this with
`array_length` on an empty array; Prompt 22 hit it with `jsonb_typeof` on an absent key, and the
constraint accepted precisely the row it existed to refuse. The rule generalises: any CHECK built
on a function that returns NULL for missing input must `COALESCE`, and the only reliable way to
know is to probe each constraint in raw SQL before code depends on it. The tests would not have
caught this one — the application never writes that shape.

---

## Completed at Prompt 21 — Objective AI Analysis and Right-Side Progress

- **The client's seven stages**, in order, as a real pipeline: Understanding Objective → Reading
  Team Structure → Detecting Human Work → Identifying AI Work → Matching Skills → Assigning Owners
  → Building Workflow. Each writes its progress to the run row, so a reopened screen shows where
  it actually got to — the approved UI's "no fake completion", honoured.
- **A Model Gateway abstraction** (ADR-107), `@Global`, the only path to a model. Its request type
  names no provider and its response carries an **opaque capability label** — the client's locked
  rule that provider names stay behind the gateway, made structural. Every stage makes exactly one
  gateway call, so a real provider changes the analysis everywhere at once.
- **`producedByRealModel` is false for every adapter that ships** (S-144), travels with each
  response, is persisted and is reported on every read. A finished run cannot have it flipped.
- **The output is always a Draft** (S-142). The version reaches only `AiAnalysis` and
  `WorkflowDraft`, both pre-approval, so nothing becomes assignable. The run table has **no
  approval or publish column at all**.
- **A versioned draft schema** (ADR-108), stamped into the document _and_ the row with a constraint
  refusing them to disagree, validated before storage, and refused knowingly on read when a later
  build cannot understand it.
- **The locked node-shape rule as data** (ADR-109): Human is a rectangle, AI is a diamond, the Goal
  is visually distinct. `validateWorkflowDraft` refuses a node whose shape contradicts its kind, so
  a restyle cannot break it.
- **The analysis decomposes Form 2** rather than inventing work — every node records the grid row
  it came from — and records **what it could not do** in `gaps`: an unmatched person, a step naming
  nobody, an AI step with no approved Skill.
- **Skill matching reuses the Prompt 18 router** (S-147), so an unapproved Skill version cannot be
  reached by any path. No Skill Candidate is raised, because an analysis is exploratory.
- **Estimated AI usage is a range with its basis stated**, never a single figure.
- **Cancellation is honoured, not merely recorded** (S-148), checked between stages so a cancelled
  run never claims a stage it abandoned.
- **`/objective/analyze`**, matching the reference's layout, with a prominent warning that the
  analysis ran against a mock model.
- **65 tests**, taking the suite to 1546 passing.

### Real limitations at Prompt 21

1. **No AI provider is configured, so no analysis is a model's judgement.** The pipeline, the
   schema, the progress and the cancellation are all real and tested; the reasoning is a mock. Do
   not describe this as a working AI integration. A real adapter is one class and one line in
   `ModelGatewayModule`.
2. **The pipeline runs inline, driven by the request.** The row is durable so progress survives a
   reload and cancellation works across tabs, but there is no background worker: if the process
   dies mid-run the row stays `Running` until somebody cancels it. A job runner is the fix and no
   prompt has specified one yet.
3. **Owner assignment matches on display name**, because that is what the Form 2 grid holds. A
   near-miss is left unassigned and recorded as a gap rather than guessed at.
4. **The workflow editor is not built.** `objWorkflow()` — the canvas with "Add node" and "Assign
   AI node → Agent Builder" — is a later prompt. The node shapes it needs are ported and exercised.
5. **`Condition` nodes are defined but never produced.** Form 2's grid has no branch column, so
   there is nothing to derive one from. The kind exists, with its own shape, for when a later
   prompt introduces branching.

## Completed at Prompt 20 — Objective Review Routing and Strict Versioning

- **The client's strict rule, in full.** `V1 Draft → Review → Approved → Published → LIVE V1`; any
  later edit automatically opens **V2 copied from V1**, content and grid together; V1 stays live
  until V2 is approved _and_ published; **minor edits create a version too**, with no exemption;
  a **rollback creates a new version based on an older one** rather than reopening it; and every
  historical record keeps its exact version id.
- **Approving and publishing are two acts** (ADR-104). Approval is a fact on the version —
  `approvedAt` / `approvedByUserId` — not a ninth status, because the client's own state list has
  no `Approved` member. A derived `reviewStage` says "Approved — awaiting publish" so no screen
  shows an approved version as still waiting. **Nothing goes live without an approval** (S-134),
  enforced by a constraint as well as the service.
- **An author cannot route around the reviewer** (S-135). The auto-V2 rule deliberately does not
  apply while a version is under review or awaiting approval — that exception is the difference
  between a review that decides something and one that can be bypassed.
- **An approval does not survive a send-back** (S-137), because an approval is a decision about
  specific content.
- **Only the Responsible Owner may review** (S-136) — confirm the team, send back, complete the
  review. Holding `objective:Approve` is not the same as being the person it was routed to.
- **Confirm Execution Team is load-bearing**: a review cannot be completed until it has happened.
- **Send To is hierarchy-aware** (ADR-105): active membership is required always, and the reporting
  line is checked whenever both people have an employment record. The direction is deliberately
  unconstrained, and an unevaluable hierarchy permits with the gap recorded rather than refusing —
  routing is data quality, not a security boundary.
- **Employees receive no actionable work during review** (S-140). `isObjectiveWorkAssignable` is
  true only for `Active`, and it is one function so every future consumer asks the same question.
- **Version History and the Compare view**, both served and both screened at
  `/objective/versions` — which also fixes the third of the prototype's seven known defects, an
  orphaned screen with no link to it.
- **A live version's provenance and approval are frozen with its content** (S-138).
- **66 tests**, taking the suite to 1481 passing.

### Real limitations at Prompt 20

1. **No review inbox screen.** The reviewer's actions are all served and tested, but the prototype's
   `objReview()` is a stub with a fabricated comment count and no prompt has specified the inbox
   that would list "objectives waiting on me". Built from the stub it would have been invention.
2. **The Send To direction is unconstrained.** The prompt says "Responsible manager"; the approved
   reference shows a Head sending _down_ to a specialist. Same-reporting-line satisfies both, and
   this is the most likely item in Prompt 20 to need a client answer.
3. **Concurrent editing of one draft is still last-write-wins.** The grid is replaced whole, which
   is right for a spreadsheet-shaped editor with one owner. Two people editing one draft is not
   addressed, and now matters slightly more because an edit can open a version.
4. **`AiAnalysis` and `WorkflowDraft` have no producer yet.** They are in the transition table and
   reachable, but nothing moves an objective into them — that is Prompt 21.

## Completed at Prompt 19A — Objective Extra Work, Bonus and Reward Controls

- **The client's reward chain**, with both slash pairs expanded into four distinct states:
  `Draft → Assigned → Completed → Eligible → Approved/Rejected → Settled/Recorded`. `Settled` and
  `Recorded` are separate because "was this paid?" is the first question an audit asks.
- **Cash is never auto-paid** (S-124). Approving is a decision carrying no money. Settlement needs
  an approved award, a `Cash` type, a positive amount, a configured payroll connector **and** an
  actor who is not the approver — five conditions, each refused separately so a failure names the
  reason, and two of them enforced by CHECK constraints as well.
- **With no connector configured the product refuses rather than pretending** (S-125).
  `UnconfiguredPayoutAdapter` is what ships; it reports `canSettle: false` and its refusal says
  UBoss will not record a payment it did not make. `…/rewards/meta` reports the flag so a screen
  never offers a Settle button the product cannot honour.
- **`payoutWasReal` is stored, never inferred** (S-126). Every adapter that exists, the test mock
  included, returns `deliveredRealPayment: false`, and that value goes onto the award and into the
  audit summary in words. No screen or report can claim a settlement was real when it was not.
- **Four eyes on the money** (S-127). The approver may not settle their own approval; the subject
  may never find their own work eligible nor approve their own award.
- **Approving needs the approver the rule named**, not merely the permission (S-128) — and the
  separation-of-duties engine refuses even earlier for somebody approving what they created.
- **Approved points reach performance only through policy** (ADR-102), via a new
  `PerformancePolicy.rewardPointsReachPerformance` that is **off by default**. When policy refuses,
  the award still finishes as `Recorded` with a note explaining why, and a constraint refuses the
  row if the absence is unexplained (S-132). A cash settlement can never score (S-131).
- **The promise is snapshotted at assignment and frozen** (S-129), so editing the rule afterwards
  cannot raise the amount or soften the condition for an award already in flight.
- **Terminal awards cannot be reopened** (S-130) — an un-settled award could be paid twice.
- **No second rule table** (ADR-100): `objective_rewards` from Prompt 19 _is_ the reward rule.
- **83 tests**, taking the suite to 1415 passing.

### Real limitations at Prompt 19A

1. **Nothing can actually pay anybody.** No payroll or payment provider has been approved or
   integrated, so `settle` refuses in every shipping configuration. This is the honest state, not a
   gap to paper over: the boundary exists, the governance around it is complete and tested, and a
   real provider is one adapter class plus one line in `RewardsModule`. Do not describe this as a
   working payroll integration.
2. **No screen.** The prompt names none and the approved reference has no award UI. The API is
   complete and `…/rewards/meta` carries what a screen will need, including whether settlement is
   possible at all.
3. **Eligibility is a human finding, not an evaluated condition.** `eligibilityCondition` is text
   and somebody reads it and decides. Evaluating it automatically would mean inventing a rule
   language the client has not specified.
4. **One reward rule per objective.** That follows the panel's shape from Prompt 19. An objective
   needing two different bonuses for two different outcomes cannot express that yet.

## Completed at Prompt 19 — Objective Builder, Exact Form 2

- **Form 2, preserved exactly, as data.** `FORM2_OBJECTIVE_FIELDS` and
  `FORM2_WORKFLOW_COLUMNS` in `@uboss/types` are the single source (ADR-094): the migration was
  written from them, the DTOs mirror their ceilings, validation walks them, `GET /form2` is
  derived from them, and the grid renders them. Invariant tests assert the source-field list
  verbatim, the fifteen columns, their grouping and the client's exact labels — so a dropped or
  renamed field fails a test instead of quietly shipping.
- **`Unit` and `Time Unit` are two separate fields** and the screen carries the reference's notice
  saying they are never collapsed. A duration with no unit is refused by a CHECK constraint; a
  workload unit with no duration is fine, because the two pairs are independent.
- **The full fifteen-column workflow grid**, with grouped sticky headers, a sticky Step column,
  horizontal scroll and per-row Insert / Duplicate / Delete / Reorder. **The row count is not
  fixed** — no database ceiling, verified to 40 rows, with only a request-size guard in the DTO.
- **Identity and content are separate tables** (ADR-095), the same shape as `Skill`/`SkillVersion`,
  so Prompt 20's immutable-versions rule needs endpoints rather than a schema move. The complete
  transition table is declared once even though Prompt 19 exposes only create, save and submit.
- **A live version's plan cannot be rewritten** (S-116). Two triggers: one freezes the Form 2
  columns from `Active` onwards while still letting the status move, the other refuses INSERT,
  UPDATE **and** DELETE on a live version's grid — because the grid _is_ Form 2. A genuine cascade
  still works, and that is by design rather than luck (S-117).
- **One live version per objective** (S-118), with a Draft permitted alongside it. That is the
  shape of the client's versioning rule, not an exception to it.
- **The Performance & Reward panel is structurally outside Form 2** (ADR-098): its own table, its
  own endpoint, its own permission. All seven fields from the client's latest requirement.
- **Nothing auto-pays** (S-122). Enforced by absence — no approved, settled, paid, payout or
  disburse column exists — and asserted twice: once from `information_schema`, once by proving
  `performance_events` is still empty after a reward is saved. The audit event says
  `autoPaid: false` rather than leaving it to be inferred.
- **Promising a bonus needs `objective:Assign`** (S-121), which `Employee` does not have. Nobody
  can attach a reward to their own objective by role alone, and no new permission was invented to
  say so.
- **Row-level authorization on every route** (S-123), tested in both directions: a
  department-scoped Head is refused an objective outside their scope by id _and_ does not see it
  in their list.
- **160 tests**, taking the suite to 1332 passing.

### Real limitations at Prompt 19

1. **Department, Owner, Send To and Approver are id inputs, not people pickers.** The people and
   department lists belong to the Hierarchy module and a second source for them here is how two
   lists come to disagree. The hierarchy-aware pickers arrive with the routing work at Prompt 20.
2. **`Analyze & Generate Workflow` is present but disabled.** The AI analysis it opens is Prompt
   21, and Prompt 19 says not to build the right-side workflow yet. The button keeps its place and
   its label and says why it is unavailable, rather than silently doing nothing.
3. **Only three lifecycle moves have endpoints** — create, save draft, submit for review. The
   transition _table_ is complete, but review routing, AI analysis, pre-publish and publish are
   Prompts 20 to 22 and have no route yet.
4. **Concurrent editing of one draft is last-write-wins.** The grid is replaced whole (ADR-097),
   which is right for a spreadsheet-shaped editor with a single owner; concurrent editing gets a
   real answer when review routing lands.
5. **Objective-level closure behaviour is not built.** The prompt defers it explicitly ("plus
   closure behavior later"); `Completed` currently lives on the version.

## Completed at Prompt 18 — Skill Router and Evaluation Foundation

- **A Skill Router that takes the client's whole context** — Objective, department, industry,
  company policy, AI task, required inputs and output, allowed tools, risk and approval — and
  returns **at most five approved published versions**, each with a confidence and its reasons,
  plus every rejection with the one rule that ruled it out.
- **No unapproved Skill can be selected** (S-108). Two independent locks: the candidate query
  filters to `Published`, and the scorer disqualifies any other status. A draft is not even a
  candidate, so no scoring decision can reach one.
- **A missing capability becomes a Skill Candidate** (ADR-090) carrying the routing context and
  every rejection, deduplicated while an earlier request is open. The status enum has **no
  `Published` member** — the client's rule expressed as the absence of a value — and accepting one
  creates a **draft** that goes through the ordinary lifecycle.
- **Hard rules disqualify rather than rank lower** (S-111): a policy ceiling on autonomy, a tool
  the work forbids, an unavailable required input, work that must be approved against a Skill that
  needs none, and a Skill whose own **"when not to use it"** describes this task.
- **Saved evaluation cases**, attached to the **Skill** rather than a version so two versions can
  be compared, with three assertion kinds — including `HumanJudged`, which cannot be computed and
  is stored **unjudged** rather than passing.
- **The evaluation harness records rather than runs** (ADR-091). There is no evaluator; output is
  supplied and `producedBy` says so at every layer. A stub inventing plausible output would have
  made every green comparison worthless.
- **A regression comparison data model** with five verdicts, where `Regressed` is separate from
  `Mixed` and both block (ADR-092). Publishing over one is a signed act with a real reason, and
  the verdict cannot disagree with its own evidence (S-113).
- **A comparison freezes the expectations it depended on** (S-114), so a case cannot be edited to
  agree with a result.
- **68 tests**, taking the suite to 1172 passing.

### Real limitations at Prompt 18

1. **No evaluator, so no comparison runs itself.** Recording a run means supplying the output.
   That is honest rather than convenient, and it is the single thing to revisit when the Model
   Gateway lands: `produced_by` already distinguishes a recorded result from a generated one.
2. **The router does not read company policy from Settings yet.** `maxAutonomy` is passed in by
   the caller. The Prompt 14 settings catalogue has no autonomy-ceiling key, and adding one would
   be inventing a setting the client has not specified — so the ceiling is a parameter until the
   Agent Policy settings category is filled.
3. **`objectiveId` and `departmentId` are opaque and unused for scoring.** They are recorded in the
   audit trail and on a Candidate, which is what they are for today. Objective-aware and
   department-aware ranking needs the Objective model (Prompt 19) and a way to know which
   departments have used which Skills; guessing either now would produce ranking nobody could
   explain.
4. **Industry matching is exact string equality.** A pack for "Medical Devices" does not match a
   company recorded as "Medical devices". There is no company industry field yet (noted at Prompt
   17), so there is nothing to normalise against — the moment one exists, both sides should be
   normalised together rather than the router guessing.
5. **The scoring weights are judgement, and are documented as such.** Every number in
   `scoreSkillForContext` is commented with what it is for and why it is capped. Two were already
   corrected by this prompt's own tests, which is the argument for keeping them visible and
   testable rather than tuned in private.
6. **No UI.** The pack asks for the router, the cases and the comparison model — data and API. The
   approved reference has no router screen, and the natural home for a comparison view is the
   Agent Builder or the Skills panel's version detail, both of which are shaped by later prompts.
   Prompt 17's Skills panel already shows each version's lifecycle; the evaluation and comparison
   panels belong beside it once there is a screen that publishes a version.
7. **A Candidate cannot be raised by hand.** It is raised by the router when nothing applies. A
   person who knows a capability is missing has no button for it — which is a real gap, and a
   deliberate one for now: the Candidate's value is the routing context it carries, and a
   hand-raised one would arrive without it.

---

## Completed at Prompt 17 — Skill Catalog and Company Skills & AI

- **All three client layers**: UBoss Verified Universal Skills, Industry Packs, Company Custom
  Skills — as one catalogue with one asymmetric Row-Level Security policy (ADR-086), so a company
  reads platform Skills and can never author, edit or approve one.
- **Every content field the client lists**, validated in three layers: purpose, category, when to
  use, when **not** to use, inputs, IF/THEN rules, steps, allowed tools, output schema,
  validation, failure handling, approval, autonomy, evidence, owner, version and status.
- **The full lifecycle as a closed table** — Draft → Test → Review → Approved → Published →
  Deprecated → Archived — with `Published` having no route back to Draft and `Archived` terminal.
  Each version response carries `nextStatuses` from that table, so a screen cannot offer a move
  the server will refuse.
- **Published content is immutable, and so is approved content** (ADR-085) — stricter than the
  client asked, because an approval is a decision about specific content. Enforced by a database
  trigger so the status can still move while the content cannot.
- **An edit creates a new draft version and the live one is untouched.** Work carries on
  referencing the published version until the new one is approved and published; publishing
  deprecates the outgoing version, in that order, because the unique index permits one live
  version at a time.
- **Impact analysis that reports unknown rather than zero** (ADR-087). Three of five domains
  cannot be counted until the modules that reference a Skill exist, and each says which prompt
  brings it. Clones are counted and described as independent.
- **All four creation modes recorded**, with Manual, From-document and Clone accepted today and
  Create-with-UBoss-AI declared. A clone is a **draft under this company's own approval** with its
  provenance recorded — which is what makes it different from copying a template (ADR-083).
- **A high-risk Skill can never be fully autonomous**, refused by the shared validator, the
  service (at creation **and** at the approval boundary) and a check constraint (S-103).
- **`settings:Approve` on the `Approver` role alone** (ADR-088), covering both approving and
  rejecting. The Prompt 7 invariant — a Company Admin carries no `Approve` — stands.
- **The Skills & AI panel**, matched to the reference, with the locked rule visible on the screen
  rather than merely obeyed.
- **65 tests**, taking the suite to 1104 passing.

### Real limitations at Prompt 17

1. **No authoring form for a Skill from scratch.** The API accepts Manual and From-document
   creation and both are tested; the fifteen-field governance form belongs with the Agent Builder
   screen that consumes a Skill, and building it here would mean guessing that screen's shape. The
   panel lists what each mode waits on rather than offering a button the server would refuse.
2. **Create-with-UBoss-AI records the mode and drafts nothing.** It needs the Model Gateway
   (Prompts 25–30). The creation mode is already on the version, so a reviewer will be able to see
   that a model drafted a Skill — which is the part that matters for governance.
3. **Impact analysis is three-fifths unknown**, by design and by declaration. It becomes real as
   Engine Agents, Objectives and runs arrive.
4. **Nothing consumes a Skill yet.** The catalogue is complete and governed; the Skill Router that
   selects approved versions for AI work is the next prompt, and the Engine Agents that would run
   them come later. `USABLE_SKILL_STATUSES` is `['Published']` so the rule is already in place for
   the first consumer.
5. **No evaluation cases, no corrections.** The reference's `Corrections` column is deliberately
   absent: corrections are evaluation data, which the next prompt owns. A column of zeroes would
   read as "nothing has ever been corrected".
6. **`outputSchema` is stored as text.** Validating a Skill's output against it is the next
   prompt's work, and parsing it into a stored shape now would freeze a decision that belongs
   there.
7. **An Industry Pack is not yet filtered by a company's industry.** Every published pack is
   visible to every company, because there is no company industry field to filter on — `Tenant`
   has none, and adding one to make a filter work would be inventing a field the client has not
   specified. The `industry` column on the Skill is populated and indexed, so the filter is one
   `where` clause away from whichever prompt introduces company industry.

---

## Completed at Prompt 16 — Connections, Secrets and Agent Tool Permission

- **Both connection types**, and they behave differently where it matters. A Company Connection is
  company infrastructure that can be transferred; a **User Connection is never transferred**
  (ADR-081), and offboarding disables it with the reason on the row.
- **`secret_ref` only, made structural** (ADR-079). The sealed value lives in its own table that
  no screen, list or count query touches; `SecretsVault.reveal` is the only path to plaintext and
  it goes straight to a connector adapter, which has no access to the vault. **No route returns a
  credential**, asserted by serialising the whole response.
- **A Secrets Manager adapter seam**, defaulting to a local store sealed with the existing
  `SecretBox` (AES-256-GCM, keyed, versioned) under a new `connection.secret` purpose. It reports
  `isExternalProvider: false`, and that reaches the screen.
- **Agent Tool Permission, separate from human permission** (ADR-078) — the client's rule,
  enforced four ways: two vocabularies, two tables, one function that takes an `agentId` and not a
  user id, and a unit test asserting the lists share no member.
- **The client's high-risk categories**: `Delete`, `ExternalBulkSend`, `SensitiveExport`,
  `FinancialChange`, `ProductionChange`. Each needs a reason, refused by the service **and** a
  check constraint; each revocation is attributed; `DELETE` is revoked on the table.
- **The five states derived at read time** (ADR-080), in a precedence order where every step
  prevents a specific wrong message. No `state` column.
- **The whole lifecycle**: Test Connection with an append-only history, credential rotation that
  keeps the handle so grants survive, reauthorize, disable with a mandatory reason that **keeps
  the grants** (ADR-082), enable, transfer owner, and the affected **agent** count — distinct
  agents, not grants.
- **A real mock connector**, driven by its own credential so every state the governance layer can
  produce is reachable and tested. It **fails by default** on an unrecognised credential.
- **The credential-expiry sweep**, which is the producer behind Prompt 15's `ConnectionExpiry`
  notification kind — that kind shipped with its preference controls working and nothing raising
  it, and now three of the six sources are live.
- **The Integrations panel**, matched to the reference's `setIntegrations()` table, with the
  credential nowhere on it and high-risk grants visible with their reasons.
- **64 tests**, taking the suite to 1039 passing.

### Real limitations at Prompt 16

1. **No vendor is integrated.** Two mock connectors, both flagged `isMock`. This is the pack's own
   instruction ("do not yet integrate every vendor"), and the catalogue lists only what has an
   adapter — a real connector adds a catalogue entry and an adapter implementation, and nothing in
   the lifecycle, the secret handling, the tool grants, the expiry sweep or the notification
   changes.
2. **No external secrets provider.** The local sealed store is a real guarantee — encrypted at
   rest with a versioned key — and a **different** guarantee from a managed secrets service. This
   is an **implemented adapter, not a live credential-verified integration**, and every layer says
   so.
3. **There is no `execute` path yet.** `ConnectorAdapter` has `check` and
   `describeCapabilities` and nothing else, because Engine Agent runs arrive at a later prompt. An
   execute method with no caller would be untested code holding a live credential.
4. **`agent_id` has no foreign key.** Engine Agents do not exist yet, so the column is an
   unconstrained uuid written only by an administrator. It gains its key at the Engine Agent
   prompt.
5. **Nothing runs the expiry sweep on a timer** — the same limitation as Prompt 15's dispatcher
   and escalation. `POST /platform/notifications/connection-expiry` is callable; until a scheduler
   calls it, an expiring credential is visible on the screen (the state is derived) but nobody is
   _told_.
6. **Departments are opaque ids on a connection.** `allowedDepartmentIds` is a uuid array with no
   foreign key, matching how Prompt 7 stored department scopes before Prompt 12 existed. It could
   now be a composite key to `departments`; it is not, because changing it is a migration on a
   column nothing has written yet in anger, and the sensible moment is the prompt that first
   restricts a real connection by department.
7. **Key rotation has no re-sealing job.** `connection_secrets.key_id` records which key sealed
   each value precisely so one can be written, and `SecretBox` opens values sealed with retired
   keys — so a rotation is safe today and merely leaves old envelopes in place. The job belongs
   with the operations prompts.

---

## Completed at Prompt 15 — Notifications and Escalation Center

- **A durable, role-aware notification store.** One row per recipient per event (ADR-074), under
  forced RLS, with severity, read, acknowledgement, a deep link, a dedupe key and escalation
  state. Every one of the client's required features is a real column or a real filter, not a
  screen-level convenience.
- **Duplicate suppression as a database constraint**, with the dedupe key's shape defined once per
  source in `@uboss/types` (ADR-075) — an approval keyed without time, overdue work keyed per day,
  a budget threshold keyed per threshold, a security storm collapsed per minute. Getting these
  backwards is the whole failure mode of a notification system.
- **A mandatory alert cannot be muted, enforced three times** (S-086): one shared function asked
  by both the engine and the screen, an engine that overrides the preference for anything critical
  or security-related, and two check constraints that refuse the state outright.
- **Acknowledgement is separate from reading** (S-087). `Mark all read` says so in its own
  response, the bell carries two numbers, and acknowledgement is audited while read state is not.
- **Email through the Prompt 10 outbox, not a second queue** (ADR-076) — closing the "no
  dispatcher exists yet" limitation ADR-055 has carried since Prompt 10. At-least-once delivery
  inside the caller's transaction, an idempotency key, exponential backoff and dead-lettering all
  came with it. The payload carries a notification id and **nothing else**.
- **An `EmailAdapter` that never claims delivery it did not perform.** The default logs and sends
  nothing, and says so on every dispatch result and in every audit event.
- **Escalation that creates a new notification rather than reassigning** (ADR-077): the manager
  gets their own row with `escalatedFromId`, the original stays visible and marked, severity is
  floored at `Warning`, and an item with nobody above it is left un-escalated so it escalates
  later rather than being lost.
- **Three of the six sources are live**: invitations (Prompt 13's path), security events (through
  the Prompt 8 `onSuspiciousActivity` seam, which was built for exactly this), and budget/seat
  thresholds (a new `BudgetAlertService` over Prompt 11's subscription).
- **The bell, the centre and the preference panel**, matched to the design system, with the count
  as a badge and the real number in the accessible name.
- **75 tests**, taking the suite to 975 passing.

### Real limitations at Prompt 15

1. **Nothing runs the jobs on a timer.** `POST /platform/notifications/dispatch`,
   `escalate-due` and `budget-alerts` are callable endpoints — the precedent Prompt 11 set with
   `apply-due` — because there is no scheduler in this deployment and adding one is an operations
   decision (Prompts 38–42). **Until something calls them, a queued email waits and an
   unacknowledged alert does not escalate.** This is the single most important thing to wire up in
   a real deployment.
2. **No mail is actually sent.** The adapter is implemented and tested; there is no verified
   provider. This is an **implemented adapter, not a live credential-verified integration** — the
   distinction is on every dispatch result and in every audit event, so nothing in the system
   claims otherwise. Swapping one provider line in `NotificationsModule` is the whole change.
3. **Three of the six sources cannot fire yet** — approvals waiting, overdue work and connection
   expiry — because the modules that own that work arrive at Prompts 16, 20–24 and 16
   respectively. The engine is complete and callable; each preference row and the centre's own
   footer state which prompt brings the producer, rather than implying they are live.
4. **No digest is actually sent.** `digest: Daily | Weekly` correctly _holds back_ the immediate
   email and keeps the in-app notification, and `notification.digest` is a declared outbox topic —
   but nothing batches and sends the summary, because that needs the scheduler in limitation 1. A
   person who chooses Daily currently gets the in-app notification and no email. That is the safe
   direction (nothing is lost, nothing is sent twice) and it is stated rather than hidden.
5. **No live push.** The bell reads its counts per screen; there is no poll and no socket. A
   notification raised while somebody sits on one screen appears on their next navigation. A poll
   every few seconds across every open tab is real load for a number that is usually zero.
6. **The budget dedupe key has no billing period**, so a company that renews and crosses 80% again
   next period is not notified again until the subscription row changes. The AI cost lifecycle
   (Prompts 25–30) introduces a per-period consumption record and the key gains the period then.
7. **`performance:Administer` was added to `CompanyAdmin` at 12B and no other role.** Noted here
   because it is the one role-template change in this batch, and it is the kind of thing a later
   prompt could widen by accident.

---

## Completed at Prompt 12B — performance score and badge engine

The special prompt the autopilot's starting gate found had been missed. **12A was already
delivered** inside Prompt 12 — the global person registry, where `global_person` _is_ `User`
(ADR-062) — so only 12B was outstanding, and it was implemented against its exact requirement from
the pack rather than by restarting anything.

- **A versioned performance policy per company.** Points per outcome and the five thresholds, one
  active version at a time (a partial unique index), a mandatory reason, and `Administer` required.
  A change **supersedes** and creates version N+1; there is no in-place edit (ADR-072).
- **An append-only `performance_events` ledger, and a score derived from it** (ADR-071). No stored
  total: the API returns the score _and_ the events it is the sum of, so "why is my score 240" is
  answerable line by line. Each event keeps the points it earned **and** the policy version that
  decided them, so a threshold change re-derives _levels_ without rewriting _points_.
- **Both halves of the client's positive rule.** A positive event needs work completed within the
  required time **and** accepted. On-time delivery of work that is then rejected is
  `QualityRejected` — treating it as positive is how a score stops meaning anything.
- **Idempotency as a schema constraint, not a convention.**
  `UNIQUE (tenant, subject, source_kind, source_id, kind)`, proven by inserting a duplicate
  directly. The callers will be a completion handler and a scheduler, both of which retry, so a
  duplicate has to be impossible rather than unlikely. The same source may carry _different_ kinds:
  a task can be late and then rejected, and those are two facts.
- **Approved blockers neutralise**, fully or by half depending on policy, rounded towards zero so
  partial forgiveness is never a reward. A blocker may only forgive something that **cost** points,
  it must name the event it cancels, and it must say why — all three refused at the database as
  well as in the service. The forgiven event stays visible and marked, because it happened.
- **Bronze → Silver → Gold → Platinum → Diamond with configurable thresholds**, kept as a
  _history_ of periods rather than a current-level column: "they were Gold last quarter" is what a
  review asks. One current level per person, enforced by a partial unique index. A score below the
  Bronze threshold reports **Bronze with a negative score** rather than inventing a sixth rung.
- **Company-specific, and frozen on exit.** Every event carries its employment record;
  offboarding writes a final snapshot and closes every open period, so the record cannot drift
  against a policy that changes after the person has left. `performanceHistory` is now a declared
  handover domain: preserved, snapshotted, **never transferred to a successor**.
- **Two screens matched to the reference** — `/performance` (`SCR.performance`) and
  `/performance/badges` (`badgeHistory()`) — plus the employee profile's two mini cards and its
  Performance/Achievements pills, which now navigate rather than saying "not built yet". A new
  `BadgeProgression` primitive carries the five-medal ladder.
- **47 tests**, taking the suite to 900 passing.

### Real limitations at Prompt 12B

1. **Nothing produces a derived event yet.** `OnTimeAccepted`, `LateCompletion`, `Missed` and
   `QualityRejected` are recorded by the modules that own the work — Human To-do completion, an
   approval decision, a deadline sweeper — and none of those exist before Prompts 20–30. The engine
   is complete and callable; a real company's ledger stays empty until a to-do can be completed.
   This is the correct order: building the sweeper first would mean scoring work that cannot exist.
2. **`sourceKind`/`sourceId` are opaque, with no foreign key.** Deliberate (ADR-073) — the owning
   modules arrive later and this engine must not grow a column per module — but it does mean a
   deleted source leaves an event pointing at nothing. Since the ledger is append-only and nothing
   in the system hard-deletes work, no path can currently produce that.
3. **No reward.** The client's Performance & Reward Policy is two things. Scoring and badges are
   here; **reward stays outside**, and there is deliberately **no automatic cash payout** — that is
   a locked rule, and the reward panel sits outside canonical Form 2 when it arrives.
4. **A "last 90 days" figure does not exist.** The reference labels on-time delivery that way; the
   engine scores the whole employment, so the screens say what the number actually covers. A real
   windowed figure needs a date filter the prompt did not ask for.
5. **`badge_history` does not stamp a policy version.** A level is a reading of the _current_
   policy, so stamping one on a period would imply the level was frozen under it. The badge-history
   table's Policy version column therefore shows the current version, labelled as such; the
   _events_ are where a historical version lives.
6. **The `performance` sidebar item is a restored screen, not a pack item.** The reference's `NAV`
   array does not list Performance — but it defines a full `SCR.performance` screen reachable from
   the employee profile, one of the prototype's orphaned-screen defects. The nav entry has existed
   since Prompt 2 and now points at something real. Worth confirming against the client's locked
   OPERATIONS list at Prompt 45, which is where UI polish belongs; it changes no business logic.

---

## Completed at Prompt 14

- **The full Settings information architecture** — left navigation, right detail panel (the locked
  UI rule), all **19** categories in the client's approved order. Nineteen rather than the
  original Prompt 14 list of seventeen: the client's later amendments added UBoss Profile Search
  Policy and Performance & Reward Policy, and the precedence rule puts a later correction above
  the pack.
- **A typed configuration catalogue in code, with values as data** (ADR-069). Every setting
  declares its category, type, safe default, and **both** the permission to read it and the
  permission to write it. An unknown key is refused rather than stored, so a typo cannot become
  a setting that silently does nothing, and there is exactly one default per setting rather than
  one per screen.
- **Effective inheritance in three layers**: the company's row, then a platform default under the
  same key, then the code default. `source` is on the wire with every value, because "we chose 24
  hours" and "nobody has chosen, so it is 24 hours" are different facts and a screen showing only
  the number invites the wrong one. A company with **no rows at all is fully configured** — no
  backfill migration exists or is needed.
- **The backend enforces every setting permission** — the client's rule, taken literally. Each
  setting's own permission is checked, not one blanket check for the screen: a caller sees exactly
  what they may read, `editable` is the server's answer per setting, and a payload mixing a
  permitted setting with a refused one is rejected **whole** rather than half-applied.
  **Authorization is never through hidden navigation**: a category withheld from the sidebar is
  also refused on write, and the response says how many were withheld so a shorter list reads as
  a boundary rather than a bug.
- **Working General, Appearance, Notifications and Organization settings** — the ones the prompt
  asks to be real. Twelve settings across four categories, with typed controls, per-field
  validation and **cross-setting rules** (escalation may not precede the reminder), checked
  against the _effective_ result so a rule applies even when only one of the two is changing.
- **Version history where material** (ADR-070). A governance setting requires a reason and keeps
  its previous value; a branding colour does not. Keeping history for everything would bury the
  entries that matter. `company_setting_changes` has `UPDATE` and `DELETE` revoked from the
  application role — a weaker guarantee than the Prompt 8 chained trails, and stated as such:
  "the application cannot rewrite it", not "tampering is detectable".
- **An unsaved-change warning on both halves** — blocking an in-app category switch and warning
  on page close.
- **36 new tests (853 total)**, including every setting's default validating against its own
  declared type, a stored value that no longer validates falling back rather than being served,
  and the history proving it cannot be rewritten by the application role.

**One defect found before it shipped**, and it is the **third instance of the same class**:
`platform_settings` was not reset by the test harness, so a platform default created by one test
made a company inherit `Weekly` on the next run when the test expected the code default. Platform-
plane tables have no tenant to cascade from, so `TRUNCATE tenants CASCADE` never reaches them.
The harness now resets it, and the comment states the rule plainly: **if a table has no
`tenant_id`, the truncate cannot clean it.**

## Completed at Prompt 13

- **Settings → Users & Access** with the client's three tabs — Employees, Guests, Pending
  Invitations — split server-side so the screen cannot disagree about who is what. Each row
  carries **why** somebody can or cannot activate yet, because "why can I not invite this person"
  is the next question and making an administrator guess is the difference between a screen that
  helps and one that refuses.
- **An invitation links to the same stable identity.** `inviteExistingPerson` is keyed on the
  **userId**, never on an email: Prompt 12 creates people with a synthesised
  `…@person.uboss.invalid` address, so an email-keyed invitation would have created a **second**
  UBoss identity for the same human. A test counts `users` before and after and asserts it is
  unchanged.
- **The activation gate** (ADR-065). The client's rule — a new internal employee needs a
  department, a manager and a role before activation — enforced at **both** ends: the invitation
  refuses to send, and activation itself refuses to complete. The window between them is real: a
  role can be revoked after the email goes out. One pure function serves all three callers so
  they cannot disagree.
- **Seat limits are no longer bypassable.** Inviting moves a membership to `InvitePending`, which
  the default rule counts, so this is the path that actually consumes a seat — and it now goes
  through `SeatService.claimSeat` under the per-tenant advisory lock. **Known limitation 5g is
  closed**, one prompt after it was recorded.
- **Guests, with no new authority model** (ADR-066). A guest is a membership with
  `userType = ExternalGuest`, a **mandatory** access expiry (enforced in both directions by a
  check constraint), **no employment record** (enforced by a trigger from both sides) and a role
  assignment scoped to `SelectedResource` with its own expiry. The Prompt 7 user-type ceiling
  already forbids them Approve, Publish, Run, Schedule, Pause, ManageAccess, Administer, Audit
  and Export — so guest access needed no second permission path, which is the point.
- **Suspend, reinstate and offboard preserve everything.** Offboarding keeps the membership, the
  employment record (state `Ended` with a date), every audit event and the person's UBoss Unique
  ID — which is theirs, not the company's. What is removed is their **authority**: roles are
  revoked rather than transferred, because copying a departing person's grants onto a successor
  would silently widen the successor's authority (ADR-067).
- **A handover registry that names what it cannot move.** Direct reports move to the successor
  (and offboarding is refused without one when there are any). Open work, Engine Agent ownership
  and connections **do not exist yet**, and the offboarding record says so per domain with the
  prompt that owns each — the difference between "moved nothing because there was nothing" and
  "moved nothing because we forgot".
- **Bulk operations: validate, then apply.** Nothing is applied until a second call, and every
  row persists with its own outcome and **all** of its errors. Partial application is deliberate:
  a 400-row import rejected for three bad rows is worse for the customer than 397 applied and
  three named. Every row is applied **as the requester, through the same service a single-record
  change uses**, so the Prompt 7 escalation gates apply unchanged — and a bulk role change is
  validated but **refused at apply time** rather than routed around those gates.
- **50 new tests (817 total)**, including one company never seeing another's bulk operations, a
  bulk import that cannot overshoot the seat ceiling, and a guest who cannot be given an
  employment record even by a raw `INSERT`.

**Three defects found before they shipped**, recorded in `docs/TEST_MATRIX.md`: Prisma generated
`DROP CONSTRAINT` for Prompt 12's hand-written composite foreign keys because it could not see
them — which would have silently removed a tenant-isolation guarantee; `array_length` on an empty
array returns NULL, so **two** check constraints (one new, one from Prompt 11) accepted exactly
the row they existed to refuse; and a header named `Employee ID` camel-cased to `employeeID`, so
every field lookup missed and every row reported every column as absent.

## Completed at Prompt 12

- **Departments and the reporting tree, as two separate structures** — the client's requirement
  ("reporting manager relationship separate from department membership") taken literally, because
  a person reporting across a department boundary is the norm, not the exception. The tree groups
  people by department and nests them by manager _within_ it, so both facts are visible at once.
- **`TeamSubtree` authorization resolves.** `HIERARCHY_RESOLVER` — declared and deliberately
  unprovided since Prompt 7 — is now registered by `OrganizationModule`. **Known limitation 6 is
  closed**, after standing open through Prompts 7, 8, 9, 10 and 11. A `Manager` assignment now
  grants at the row level, proved by a test that asserts the decision is no longer
  `scope-unevaluable`.
- **A cycle in the reporting tree is impossible**, and enforced twice: the service explains the
  refusal and records a `Blocked` security event, and a **database trigger** with a bounded
  recursive walk refuses it regardless of code path. Verified by driving a cycle straight at the
  table as the owner role with no service in the way. This matters more than it looks —
  `TeamSubtree` permission checks now run a recursive query over this tree, so a cycle would be a
  denial of service on authorization.
- **A reporting manager must be employed by the same company**, guaranteed by a _composite
  foreign key_ on `(tenant_id, reporting_manager_user_id)` rather than by a trigger or a service
  check. That is the tenant-isolation case, and it is the one worth having the database refuse.
- **The Global Person Registry, built on `User`** (ADR-062). `User` already _is_ the global
  person — one row per human, platform-plane, carrying the permanent `ubossUniqueId` — so a
  second `global_person` table would have created two competing answers to "who is this human".
  What is new is `person_identifiers` (the matching layer) and `employment_records` (per-company
  employment). The naming difference from the prompt pack is stated rather than hidden.
- **Aadhaar is a match input and nothing else** (ADR-063, S-066). The number is **never stored** —
  not encrypted, not anywhere. What is kept is a keyed HMAC-SHA-256 blind index and the last four
  digits, and a `CHECK` constraint requiring 64 hex characters means the database _rejects_ an
  Aadhaar number written into the hash column. The `IdentifierAssurance` enum has two values and
  neither is `Verified`, so no screen or API can claim verified status. A test greps every
  plausible column for the number and asserts zero hits.
- **Exactly six mandatory Add Employee fields**, held as data so the form and the API cannot
  disagree, with every other field optional _and_ unmarked. Verhoeff checksum validation
  (verified to catch 100% of single-digit errors and 100% of adjacent transpositions) as a
  **format** check that explicitly does not claim verification.
- **No Invite button anywhere in the hierarchy** — not on a node, not in the toolbar, and no such
  route exists to call. Adding somebody creates a `NotInvited` membership: known to the company,
  unable to sign in, no credential, no invitation. Asserted as the absence of a route.
- **The scoped part of "scoped visibility"**: the structure is company-wide, the masked
  identifier is not. It is withheld by _omission_ rather than blanking, so a screen cannot render
  a withheld value as "no identifier on record".
- **53 new tests (767 total)**, including the cycle refused at the database, a 23-level reporting
  chain, one person linked to one UBoss Unique ID across two companies, and the match flow
  proving it reveals nothing about where else that person works.

**Two defects found before they shipped**, recorded in `docs/TEST_MATRIX.md`: `runAsPlatformOperation`
correctly **refused to escalate** from inside a tenant transaction, which exposed that the
registry's lookup had the wrong scoping model (fixed by making it join the caller's transaction,
like the outbox); and the new department trigger caught a **Prompt 8 test using `'dept-1'`** as a
placeholder department id — exactly the dangling reference it exists to prevent.

## Completed at Prompt 11

- **Five commercial concepts kept provably separate** (ADR-059): Commercial Plan, Module
  Entitlements, Feature/Release Channel, Commercial Allowance and RBAC. `CommercialPosition` is
  five named groups with **no role or permission field in it at all**, and it carries an
  `rbacNote` saying so — the separation is structural, not a convention. A test changes a
  company's plan and asserts the permission matrix is byte-identical afterwards.
- **A seat ceiling that cannot be silently exceeded** (ADR-060). `SeatService.claimSeat` takes a
  **transaction-scoped advisory lock keyed per tenant** before counting, so two administrators
  inviting the last seat at the same moment queue instead of both seeing room. The race test
  asserts exactly one succeeds and the company never exceeds its contract.
- **Configurable seat counting**, per plan with a per-company override: `ActiveOnly`,
  `ActiveAndInvited` (the default — an outstanding invitation is a committed seat) and
  `ActiveInvitedAndSuspended` (for per-provisioned-person contracts, where suspending somebody
  does not free their seat). Every screen shows the rule and the per-state breakdown, because
  "31 seats used when 28 people work here" needs an answer on the screen.
- **Reducing seats deletes nothing** (ADR-061). There is **no delete path in either new
  service**. A reduction sets a grace window that holds the old ceiling while the company gets
  under the new number, the audit event records `nothingDeleted: true`, and a test counts users,
  memberships and audit rows before and after to prove it. A grace window opens **only when the
  company is actually over the new number** — an unnecessary one would let a company add seats it
  is about to lose.
- **Company lifecycle as a closed transition table** with a durable history. `Closed → Active` is
  impossible rather than merely unusual; a reason is mandatory; transitions can be scheduled and
  are **not** applied until their date; and the state's _behaviour_ is still the single Prompt 4
  capability table the `TenantGuard` reads on every request, deliberately not restated.
- **Request-and-decide, split by design.** A Company Admin may view its position and request
  changes; only the platform sets a contracted number. The requester can never decide their own
  request — refused in code, refused by a check constraint, and the refusal is recorded in a
  **separate transaction** so the throw cannot roll away the evidence.
- **48 new tests (714 total)**, including the concurrency race, the four lifecycle states' exact
  behaviour, non-destructive reduction, grace expiry, and plan-versus-RBAC independence.

**Two defects found before they shipped**, recorded in `docs/TEST_MATRIX.md`: the Prompt 8
break-glass bug recurring — a blocked self-decision recorded inside the transaction its own
`ForbiddenException` rolled back, leaving no trace (caught by the test asserting the security
event exists) — and a plan column mutated by one test poisoning a different test on the _next_
run, because a plan is platform configuration no `TRUNCATE` reaches.

## Completed at Prompt 10

- **The client's ten-step Create Company wizard**, submitted once. Company identity, initial
  Company Super Admin, commercial plan, module entitlements, AI mode, skill packs, AI budget
  policy, security defaults, review-and-provision, and the activation invitation.
- **One transaction** (ADR-054). Tenant, subscription, AI settings, budget policy, security
  defaults, the administrator, the bootstrap grant, the setup checklist and the invitation all
  commit together or not at all — proved by a test that counts rows before and after an induced
  mid-transaction failure.
- **Bootstrap authority, made accountable** (ADR-056). The first Company Admin is granted by
  provisioning with **no human grantor**, because requiring an existing Company Admin is
  impossible. Two check constraints tie the `bootstrap` flag to the null grantor in both
  directions, a distinct audit action lands in the **company's own trail**, and a `Critical`
  security event records it. Provisioning cannot mint any other role.
- **A transactional outbox** (ADR-055) so the activation email is never sent for work that
  rolled back and never omitted for work that committed. The payload carries the invitation
  **id**, never its token. No dispatcher runs — the API reports `running: false` rather than
  implying mail is going out.
- **No password, anywhere.** No field on any step, none in the DTO, no credential row created,
  no token in the response or the outbox. `forbidNonWhitelisted` turns an attempt to send one
  into a 400 rather than a silently-dropped field.
- **The ten-item first-login Setup Checklist**, verbatim from the approved onboarding sequence
  including its "why it comes here" rationales. Skipping needs a written reason and counts as
  resolved while staying visibly skipped (ADR-058).
- **36 new tests (666 total)**, all integration, weighted toward the negatives — four ways a
  company cannot be created, two payload shapes that must be refused, and the atomicity check.

**Three defects found before they shipped**, recorded in `docs/TEST_MATRIX.md`: a migration that
added a constraint before the backfill satisfying it (caught by reading the SQL), a missing
required column on the domain claim (caught by typecheck), and a test assertion that forbade the
deliberate "No password was created" reassurance (caught by the test failing on correct
behaviour).

## Completed at Prompt 9

- **Platform roles that actually guard** (ADR-049). Six roles as code, assignments in a table,
  and `platformContext` **fails closed**: it builds permissions from the caller's assignments
  instead of granting every platform actor all fifteen modules. Before this, a permission
  decorator on a Master Console route could not refuse anybody who got past `@PlatformOnly` —
  the guards were nominal. Now `release` and `platform-settings` are **Owner-only**, granting a
  platform role is Owner-only, and a Security reviewer can read the access review while
  changing nothing.
- **The migration backfills every existing platform actor to `PlatformAdmin`**, which is what
  makes a fail-closed change safe to ship. `PlatformAdmin` is _derived from the ceiling by
  subtraction_ rather than listed by hand, so it is provably the old blanket grant minus the two
  separated controls — a unit test caught the hand-listed version silently dropping an action.
- **Sixteen `/master/*` routes** on the Prompt 2 shell. Seven full screens (Dashboard,
  Companies, Company Detail, Plans, Release, Security, Platform Settings), one entry screen,
  System Health with its real alert data, and seven honest shells.
- **The dashboard shows what the client asked for, from real data** — companies, status, seats,
  renewals, AI usage and billing attention, service alerts — and **says where each number came
  from** (ADR-051). Companies, seats-used and the entire security panel are _measured_; plans,
  seats-licensed, renewals and billing are _configured_; AI consumption and service alerts are
  _demo_. The security panel reads the Prompt 8 append-only trails, so those are the only
  figures here that cannot have been quietly edited.
- **The attention flag is derived and explainable.** One flag per company, worst first
  (Security → Billing → Budget → Seats → Renewal), with every reason collected for the detail
  view — and a hand-pinned flag beats the derivation and says so. A real un-notified break-glass
  record moves a company to Security, which a test proves rather than asserts.
- **Six tables, seven check constraints, and a stated RLS decision.** `tenant_subscriptions` is
  tenant-owned and RLS-forced; the five platform-plane tables have none, because they have no
  tenant to isolate by and a policy keyed on "did you declare you are allowed" would be theatre
  (ADR-053, S-054).
- **Create Company ships as an entry point with no `POST` anywhere behind it** (ADR-052). The
  wizard is the next prompt, `TenantProvisioningService` already works, and the reference
  prototype has a "Skip to review & provision" shortcut — so the absence is the deliverable
  rather than an omission.
- **72 new tests (630 total)** — 26 pure-function tests including the invariant that no platform
  role can exceed the platform ceiling, and 46 request-layer tests that are mostly negatives,
  because the negatives are what did not exist before.

**Five bugs were found by red tests or by reading, not by inspection**, all recorded in
`docs/TEST_MATRIX.md`. The two worth carrying forward: `whitelist: true` on the global
`ValidationPipe` **strips any property with no validation decorator**, which made every
platform-settings write a 400 until `@Allow()` was added — and `uboss-hint`, a CSS class this
codebase has used nine times since Prompt 8, **has no rule in the stylesheet** and had been
rendering unstyled the whole time.

**Four deliberate divergences from the client's UI reference**, all recorded in
`docs/UX_MAP.md`: no provisioning shortcut, no "Impersonate (audited)" button (break-glass is
the real path and it must not be routed around), no "Suspend tenant" button, and no fabricated
KPI deltas or health figures. Each refuses to render a control that would either lie or work too
easily.

## Completed at Prompt 8

- **The audit trail is append-only in the database, not by convention.** Four controls, and the
  distinction between them matters: `REVOKE UPDATE, DELETE` from the application role and a
  `BEFORE UPDATE OR DELETE` trigger that binds even the **owner** role **prevent** alteration;
  a `BEFORE TRUNCATE` statement trigger prevents wholesale erasure (row-level triggers do not
  see `TRUNCATE`); per-chain SHA-256 hashing **detects** what none of them can prevent.
- **Every field the client named**, on `audit_events`: actor, tenant, action, resource,
  version/ref, **reason**, correlation id, timestamp. `reason` is a separate column from
  `summary` on purpose — _why_ is the field somebody reads months later, and folding it into
  _what_ makes both useless.
- **A separate `security_events` table, reversing a Prompt 5 decision** (ADR-045) with the reason
  stated rather than quietly applied. The 106 existing call sites are unchanged: the façade
  survived, and classification moved into one table keyed by the same union as the action set —
  so **adding a security action without classifying it is a type error**.
- **Tamper evidence with the guarantee written down and returned at runtime** (ADR-046). The
  `verify` endpoint returns the exact claim as prose, and **its wording changes** depending on
  whether a checkpoint has been anchored outside the database, because a caller looking at
  `intact: true` has no other way to know which situation they are in.
- **Pre-Prompt-8 rows are deliberately not retro-chained.** Hashing rows whose integrity was
  never protected would produce a chain that verifies and proves nothing. Verification reports
  the unchained count instead, and the internal page prints it.
- **Export and filter APIs, authorized three ways.** `@TenantScoped` for which company,
  `@RequirePermission({ module: "settings", action: "Audit" })` for whether the role could ever,
  and a service-level scope check the guard cannot make. A narrower-than-whole-company grant is
  **refused**, not narrowed, because `audit_events` has no department (ADR-047).
- **Break-glass as a seven-state machine across six endpoints** (ADR-048), not one call. Reason
  with substance, identity verification as its own step and actor, four-eyes approval enforced
  in the service _and_ by database check constraints, a bounded scope that cannot include
  `Administer` or `ManageAccess`, an expiry evaluated on **read**, a use counter, and customer
  notification as a tracked obligation whose suppression needs a written reason. Every step
  writes to **the customer's own audit trail**, so transparency is not a platform choice.
- **One internal read page**, `/internal/audit`, and not the Security Center — which the prompt
  explicitly excluded. It prints the guarantee verbatim, caveat included.
- **75 new tests (558 total)** — 20 pure-function chain tests including one mutation case per
  hashed field with the case count asserted equal to the field count, and 54 integration tests
  including the superuser attack ADR-046 documents, performed both with and without recomputing
  the hashes.

**Four bugs were found by red tests, not by inspection**, and are recorded in
`docs/TEST_MATRIX.md` because three of them are easy to repeat. The substantive one: a blocked
self-approval was being **rolled back by the exception that refused it**, so the control blocked
the action and left no trace of having blocked it. The other three are Prisma driver-adapter
facts — `pg_advisory_xact_lock` returns `void` and cannot go through `$queryRaw`; `int8` comes
back as a string, not a `bigint`; and `JSON.stringify` throws on a `bigint`, which made every
trail read a 500 until the rows were given an explicit API shape.

**What Prompt 8 did not do, and was expected to.** The Prompt 7 notes named "re-home company
administration onto the engine" as Prompt 8's work. It did not happen — Prompt 8 built these
foundations instead. The six route groups still wait, and the re-homing is now Prompt 9's. Said
plainly rather than left as a promise that quietly slipped.

## Completed at Prompt 7

- **Five dimensions**, all enforced server-side: **User Type** (Internal / External Guest /
  Platform, on the membership because the same human can be an employee at one company and a guest
  at another), **Role** (six built-in templates plus Custom), **Scope** (six kinds, ordered
  narrowest to widest), **Module Visibility**, and **14 Allowed Actions** in the client's approved
  order.
- **The precedence engine as a pure function** (ADR-039). `Platform → Company → Department →
Objective → Engine Agent`: any layer may tighten, a **mandatory** higher control cannot be lifted
  by any lower one, a non-mandatory one may be excepted, and a refused override is **traced rather
  than silently ignored**. Scope only ever narrows. 63 unit tests, no database.
- **Two guards, in order.** `TenantGuard` (may they be here) then `PermissionGuard` (what may they
  do). `@RequirePermission`, `@RequireAnyPermission` and `@RequireUserType` are reusable, and the
  guard is global so the decorator is the whole declaration — a route carrying none is unaffected,
  and one carrying them cannot be left unguarded by a forgotten `@UseGuards`.
- **Two-phase checking** (ADR-040), forced by HTTP: the guard answers "could this role ever", the
  handler's `assertCanOnResource` answers "may they, to this row" — which is where scope and
  separation of duties live, because a guard cannot know the row.
- **Separation of duties with no bypass** (ADR-042). A mandatory platform baseline is **seeded by
  the migration**, so a company that never opens a settings screen still cannot self-approve. Keyed
  on the **creator**, not the owner. **An automated actor can never satisfy a four-eyes control** —
  the locked Executor Agent rule expressed as code, with no `force` or `override` parameter, and
  two tests asserting it.
- **Three privilege-escalation gates on granting** (ADR-041), one of them doubled: an assignment
  cannot exceed its role's `maxScope` (refused _and_ capped again at read time); a custom role
  cannot grant what its creator lacks; **nobody can grant themselves a role**. Backed by four
  database check constraints, for rules Prisma cannot express.
- **The TCSiON extension point, shipping empty** (ADR-043). The external side is free text holding
  the client's vocabulary verbatim; the UBoss side is validated strictly; `approvedReference` is
  mandatory; the action list is a **ceiling, never a grant**; and an unmapped type **fails closed**
  with a message naming the missing mapping rather than defaulting to Employee.
- **RLS forced on all five new tables.** A `role_assignments` row _is_ somebody's authority, so a
  leak here is a permission disclosure — or, on a write, a permission grant.
- **One internal screen**, `/internal/permissions`, which shows the whole layer-by-layer reasoning
  and renders every dropdown from the server's own vocabulary. Not linked from any navigation.
- **117 new tests (483 total)** — 63 pure-function unit tests including every privilege-escalation
  negative, and 54 at the request layer against real PostgreSQL.

**UX_MAP defect 7 finally closes.** "Client-side-only authorization" has been open since Prompt 2;
navigation filtering is now a stated rendering hint with server-side enforcement behind every
route, and the internal test page exists to prove the two agree.

Two migration mistakes were made and fixed while building this, both recorded in
`docs/DB_CHANGELOG.md` because they are easy to repeat: two columns missing `@map`, and a migration
diffed against a half-applied development database that came out full of rename statements and
applied on exactly one machine. `prisma.config.ts` now configures a shadow database so
`--from-migrations` is possible.

Deliberately **not** built: any feature UI beyond the permission test page, the reporting hierarchy
that `TeamSubtree` needs, and the re-homing of company administration onto this engine.

## Completed at Prompt 6

- **MFA policy and TOTP enrolment.** RFC 6238 TOTP implemented in-house and proved against every
  published RFC 4226/6238 vector for SHA-1, SHA-256 and SHA-512 (ADR-030). Two-step enrolment
  (issue a secret, prove a code from it), so a mis-scanned QR code cannot produce a factor that
  locks someone out. Replay-protected: a code accepted for its time step is refused thereafter,
  enforced by the _write_ so two concurrent presentations cannot both pass.
- **WebAuthn-ready by construction.** `AuthMethod.WebAuthn` is a real enum value; the factor model,
  the policy, the challenge flow, recovery codes and the cookie handling are all method-agnostic.
  Adding passkeys means a new verifier, not a migration.
- **Recovery codes**, hashed and single-use, 100 bits of entropy in Crockford base32 so a fast
  digest is provably the right choice (S-030). Shown once; there is no endpoint that could show
  them again.
- **An unfinished MFA sign-in is not a session** (ADR-032). A correct password produces an
  `MfaChallenge` and a five-minute `SameSite=Strict` cookie. `TenantGuard` needed **no change** —
  the strongest evidence for the design.
- **OIDC authorization-code flow with PKCE**, fully implemented, including ID-token verification
  against a JWKS written from `node:crypto` so `alg: none`, algorithm confusion and optional
  `iss`/`aud` checking are structurally unreachable (ADR-030, S-032).
- **SAML as an abstraction with no implementation** (ADR-035, S-033). The model, columns and
  service-provider metadata exist; a SAML connection **cannot be enabled**; the reason is published
  in `/sso-setup`. XML DSig done without review time would be an authentication path that appears
  to federate and can be forged.
- **Federation authenticates, never provisions** (ADR-034). No just-in-time provisioning: an
  assertion for someone with no membership is refused and creates nothing.
- **SSO session termination in both directions** (S-035): verified back-channel logout, an
  RP-initiated logout URL that returns `undefined` rather than implying a sign-out we did not
  perform, and session revocation when a connection is disabled or deleted.
- **Domain verification** by DNS TXT, exclusive for verified claims via a partial unique index, and
  granting **no** membership (S-036).
- **Per-company authentication policy** — require MFA and/or SSO, with an optional MFA grace
  period — evaluated across every company a person belongs to, strictest wins (ADR-033). Two
  write-time invariants stop a company locking itself out.
- **SCIM 2.0**: discovery, Users, Groups, equality filters, the standard envelopes. Gated on a
  verified domain; deprovisioning suspends rather than deletes and **revokes every session
  immediately**; an unsupported PATCH or filter is refused rather than silently ignored (ADR-036,
  S-037).
- **Three secrets encrypted at rest** with AES-256-GCM, purpose-bound and key-rotatable, because
  they must be _used_ rather than compared (ADR-031, S-028). No enterprise secret is ever returned
  after the request that created it (S-029).
- **Sign-in-method discovery keyed on the email's domain**, not the address, so the login screen
  can show the right controls without becoming an account-enumeration oracle (S-038).
- **Login UI**: email-first method discovery, a second-factor step, first-time enrolment mid
  sign-in, recovery-code display, SSO buttons, and a Login & Security card for managing factors.
- **126 new tests (366 total)** — 46 unit against the RFC vectors, 80 integration against real
  PostgreSQL, real Argon2id, real AES-GCM and a **real RSA-signing OIDC provider** stood up in the
  suite.

Two bugs were found by the system's own defences rather than by review, which is worth recording:
Row-Level Security rejected every write from the new repositories because they merged `tenant_id`
but did not _declare_ the scope (fixed in ADR-037), and `PrismaService` refused a tenant→platform
escalation that turned out not to be needed at all. Both failed closed and loudly.

Deliberately **not** built: SAML assertion consumption, WebAuthn verification, SCIM bulk/sort/etag,
a public-suffix check on domain claims, and the role and permission model.

## Completed earlier

- **Prompt 5** — invitation activation with hash-only one-time tokens; Argon2id passwords; opaque
  server-side sessions with idle and absolute expiry; Active Sessions, Logout All Devices and admin
  revoke; password reset; lockout and new-device hooks; account states; the `/auth` screens.
- **Prompt 4** — request context and correlation ids; two-stage actor model; `TenantGuard` denying
  by default; tenant lifecycle states; PostgreSQL Row-Level Security as a fail-closed second layer
  under a non-`BYPASSRLS` role.
- **Prompt 3** — PostgreSQL 17 + Prisma 7.10.0; four foundation tables; transaction and
  tenant-scoped repository conventions; provisioning service; credential-free seed; health probe.
- **Prompt 2** — design tokens from the client's approved UI reference, 22 shared components, both
  application shells, the Settings shell, login presentation, the two-slice `DonutDashboard`, and
  the `/design-system` showcase.
- **Prompt 1** — npm workspaces monorepo, shared config, root scripts, env examples, eight docs,
  verification-only `/health`.

---

## Routes

**Prompt 30** added `/tenants/:tenantId/cost` — `meta`, `wallets`, `ledger`, `allowance`,
`reconcile` and `sweep-reservations`. There is deliberately no route that spends, reserves or
settles. The web app's Settings › Tokens & Cost category gained its bespoke panel.


**Prompt 29** added `/platform/providers` — `meta`, `profiles`, `routing`, model and pricing
writes, lifecycle, and `profiles/:id/test`. All platform-only; there is deliberately no
company-facing provider route. The web app's `/master/providers` shell became live.


**Prompt 28** added `/tenants/:tenantId/approvals` — `meta`, the queue, one request,
`:approvalId/decide`, `delegations` (list / create / revoke) and `escalate` — plus
`POST /tenants/:tenantId/agents/:agentId/versions/:versionId/request-approval`. The web app gained
`/approvals`. There is deliberately no per-module approve route and no route that decides without
a person.


Prompt 5's `/auth` and `/invitations` routes are unchanged except `POST /auth/login`, which now has
three successful response shapes. New at Prompt 6:

| Route                                             | Policy            | Notes                                                 |
| ------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| `GET /auth/sign-in-methods`                       | `@AllowAnonymous` | Domain-keyed, so not an enumeration oracle            |
| `POST /auth/mfa/verify`                           | `@AllowAnonymous` | Challenge-cookie driven; completes the sign-in        |
| `POST /auth/mfa/challenge/enroll/start`           | `@AllowAnonymous` | First-time enrolment during a forced sign-in          |
| `POST /auth/mfa/challenge/enroll/confirm`         | `@AllowAnonymous` | Enrols **and** completes the sign-in                  |
| `GET /auth/mfa/factors`                           | `@Authenticated`  | Never includes the secret                             |
| `POST /auth/mfa/enroll/start` · `…/confirm`       | `@Authenticated`  | Enrolment from Login & Security                       |
| `DELETE /auth/mfa/factors/:factorId`              | `@Authenticated`  | Refused if it would break an MFA requirement          |
| `POST /auth/mfa/recovery-codes`                   | `@Authenticated`  | Returns a new batch once; invalidates the old         |
| `POST /auth/sso/start`                            | `@AllowAnonymous` | Returns the authorization URL, not a 302              |
| `GET /auth/sso/callback`                          | `@AllowAnonymous` | Always 302; never redirects to a URL from the request |
| `POST /auth/sso/:connectionId/backchannel-logout` | `@AllowAnonymous` | Verified logout token is the whole control            |
| `GET`/`PUT /tenants/:id/identity/policy`          | `@PlatformOnly`   | Interim authority until the role model                |
| `/tenants/:id/identity/sso-connections`           | `@PlatformOnly`   | Created disabled; secret never returned               |
| `GET /tenants/:id/identity/sso-setup`             | `@PlatformOnly`   | Redirect URI, accepted **and refused** algorithms     |
| `/tenants/:id/identity/domains`                   | `@PlatformOnly`   | Claim, verify, remove                                 |
| `/tenants/:id/identity/scim-clients`              | `@PlatformOnly`   | Token returned once                                   |
| `/scim/v2/*`                                      | Bearer token      | The credential **is** the tenant scope                |
| `GET /tenants/:id/authorization/vocabulary`       | `@PlatformOnly`   | The five dimensions, from `@uboss/types`              |
| `GET .../authorization/role-catalogue`            | `@PlatformOnly`   | The six built-in roles, read-only (ADR-038)           |
| `POST .../authorization/evaluate`                 | `@PlatformOnly`   | The permission test endpoint; **the only trace**      |
| `GET .../authorization/matrix/:userId`            | `@PlatformOnly`   | Same engine as the enforcement                        |
| `/tenants/:id/authorization/assignments`          | `@PlatformOnly`   | Three escalation gates on granting                    |
| `/tenants/:id/authorization/custom-roles`         | `@PlatformOnly`   | Cannot grant what the creator lacks                   |
| `/tenants/:id/authorization/policy-rules`         | `@PlatformOnly`   | Restrictions only; a mandatory Allow is refused       |
| `/tenants/:id/authorization/separation-of-duties` | `@PlatformOnly`   | Baseline inherited and not removable                  |
| `/tenants/:id/authorization/tcsion-mappings`      | `@PlatformOnly`   | Empty until the approved reference is supplied        |
| everything else                                   | —                 | Refused: the guard denies by default                  |

Web routes: `/login`, `/activate`, `/access-help`, `/sessions`, `/health`,
`/internal/permissions` and **`/internal/audit`** (both diagnostics, neither linked from any
navigation), and `/design-system` plus its five previews.

API route groups added at Prompt 8: **`/tenants/:tenantId/audit`** — the first _shipped_
tenant-facing group that is `@TenantScoped` with `@RequirePermission` rather than
`@PlatformOnly` — plus `/platform/security` and `/platform/break-glass`. Prompt 9 adds
**`/platform/console`**, every route of which is `@PlatformOnly` **and** guarded by a
platform-role permission.

Prompt 9 also adds **sixteen `/master/*` web routes**, the Master Console. Its sidebar is
filtered by the server's own permission answer, so it cannot offer a module the API refuses.

Prompt 10 adds `POST /platform/provisioning/companies` (`@PlatformOnly`, `create-company:Create`)
and the tenant-scoped `/tenants/:tenantId/setup` checklist group, plus the `/master/create-company`
wizard.

Prompt 11 adds two groups, and the split between them **is** the client's rule:

| Route                                           | Policy                                 | Notes                                          |
| ----------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| `GET /tenants/:id/commercial/position`          | `@TenantScoped` `settings:View`        | Five groups, **no RBAC field**                 |
| `GET /tenants/:id/commercial/seats`             | `@TenantScoped` `settings:View`        | The numbers the enforcement uses               |
| `GET`/`POST /tenants/:id/commercial/requests`   | `View` / `Administer`                  | Read-and-request; one open request per kind    |
| `POST .../requests/:requestId/withdraw`         | `@TenantScoped` `settings:Administer`  | The company's own to withdraw                  |
| `GET /platform/commercial/requests`             | `@PlatformOnly` `companies:View`       | The decision queue, with the customer named    |
| `POST /platform/commercial/requests/:id/decide` | `@PlatformOnly` `companies:Administer` | Never the requester — code **and** constraint  |
| `GET /platform/commercial/companies/:id/seats`  | `@PlatformOnly` `companies:View`       | Same computation as the refusal                |
| `GET .../companies/:id/seat-reduction/:seats`   | `@PlatformOnly` `companies:View`       | The consequence, before agreeing to it         |
| `PUT .../companies/:id/seats`                   | `@PlatformOnly` `companies:Administer` | Reason mandatory; grace on a reduction         |
| `GET`/`POST .../companies/:id/lifecycle`        | `companies:View` / `Administer`        | Closed adjacency table; reason mandatory       |
| `POST /platform/commercial/apply-due`           | `@PlatformOnly` `companies:Administer` | Applies scheduled work; not itself enforcement |

There is deliberately **no company-side route that sets a contracted number** — a ceiling a
company could set for itself would not be a contract. `companies:Administer` is held only by
Platform Owner and Platform Admin, so a Commercial role can define plans and cannot decide which
customer is on one.

Prompt 11 web routes: `/master/companies/[tenantId]/commercial` (plan, seats, lifecycle, the
decision queue) and **`/settings/billing`**, the company's own view — read-and-request, following
the `/sessions` precedent for a company-facing screen before the Settings shell exists (Prompt 14).

Prompt 12 adds the Organization Hierarchy group. Every route is `@TenantScoped` with a
`@RequirePermission`, and the split between `View` and `Administer` is the whole authorization
story: reading the structure is something every company role does, changing it alters what a
`TeamSubtree`-scoped manager can reach.

| Route                                            | Policy                 | Notes                                                 |
| ------------------------------------------------ | ---------------------- | ----------------------------------------------------- |
| `GET /tenants/:id/organization/hierarchy`        | `hierarchy:View`       | Vision, Mission, departments, tree and list           |
| `GET .../organization/employee-fields`           | `hierarchy:View`       | The six mandatory keys, served from one source        |
| `GET`/`POST .../organization/departments`        | `View` / `Administer`  | Duplicate name refused; parent must be same-tenant    |
| `PUT .../organization/departments/:departmentId` | `hierarchy:Administer` | Re-parenting under a descendant refused               |
| `POST .../departments/:departmentId/archive`     | `hierarchy:Administer` | **Archive, never delete**; reason mandatory           |
| `POST .../organization/employees`                | `hierarchy:Administer` | Six mandatory fields, one transaction, no invite      |
| `GET .../organization/employees/:userId`         | `hierarchy:View`       | Masked identifier only, and only if permitted         |
| `PUT .../organization/employees/:userId`         | `hierarchy:Administer` | This company's fields; cannot touch portable identity |
| `POST .../employees/:userId/reporting-manager`   | `hierarchy:Administer` | Cycles refused, in the service and by a trigger       |
| `PUT /tenants/:id/organization/identity`         | `settings:Administer`  | Vision and Mission — company identity, not structure  |

**There is deliberately no invite route in this group**, and no route that changes a person's
`ubossUniqueId` or their identifiers. One company must not be able to rewrite a portable identity
that follows a real person to their next employer.

Prompt 12 web routes: **`/hierarchy`** (Tree View default, List View secondary, Add Department,
Add Employee) and **`/hierarchy/[userId]`** (the employment and UBoss identity profile).

Prompt 13 adds `/tenants/:tenantId/access`. Every route is `@TenantScoped` with a
`@RequirePermission`, and the split is the whole authorization story: `users:View` to see the
roster, **`users:ManageAccess`** to change anybody's access — its own action in the Prompt 7
vocabulary precisely so "may edit a person's details" and "may let a person into the company" are
separable, and `ExternalGuest` is forbidden it outright by the user-type ceiling.

| Route                                              | Policy                        | Notes                                            |
| -------------------------------------------------- | ----------------------------- | ------------------------------------------------ |
| `GET /tenants/:id/access`                          | `users:View`                  | Three tabs, seat position, per-person readiness  |
| `POST .../access/invitations`                      | `users:ManageAccess`          | Keyed on **userId** — no duplicate identity      |
| `POST .../access/guests`                           | `users:ManageAccess`          | Resource-scoped, expiry mandatory and capped     |
| `POST .../access/invitations/:id/cancel`           | `users:ManageAccess`          | The link stops working immediately               |
| `POST .../access/people/:userId/suspend`           | `users:ManageAccess`          | Reversible; reason mandatory; nothing deleted    |
| `POST .../access/people/:userId/reinstate`         | `users:ManageAccess`          | Claims a seat if the rule freed one              |
| `GET .../access/people/:userId/offboarding-impact` | `users:ManageAccess`          | What would move, before agreeing to it           |
| `POST .../access/people/:userId/offboard`          | `users:ManageAccess`          | Successor required when there are direct reports |
| `POST .../access/bulk/validate`                    | the **kind's** own permission | Validates; **applies nothing**                   |
| `POST .../access/bulk/:id/apply`                   | the kind's own permission     | Row by row, as the requester                     |
| `POST .../access/bulk/:id/cancel`                  | the kind's own permission     | Row outcomes are kept                            |
| `GET .../access/bulk` · `.../offboardings`         | `users:View`                  | The history of both                              |

**A bulk route's permission is the operation's, not the route's.** `BULK_PERMISSIONS` maps each
kind to the action its single-record equivalent needs — a bulk role change needs
`roles:ManageAccess`, a bulk move needs `hierarchy:Administer`. Uploading a file is not a
permission.

Prompt 13 web route: **`/settings/users`** — the three tabs, invite, guest invite, suspend,
reinstate, offboard with its impact preview, and the bulk validate-then-apply flow with per-row
errors.

Prompt 14 adds `/tenants/:tenantId/settings`. `settings:View` gets a caller to the screen; **each
individual setting's own permission is then checked by the service**, which is the client's rule
that the backend enforces every setting permission.

| Route                            | Policy                        | Notes                                             |
| -------------------------------- | ----------------------------- | ------------------------------------------------- |
| `GET /tenants/:id/settings`      | `settings:View`               | Permitted categories, each value with its source  |
| `GET .../settings/categories`    | `settings:View`               | The full 19-category architecture, for any caller |
| `PUT /tenants/:id/settings`      | `settings:View` + per-setting | Several at once; a mixed payload is refused whole |
| `GET .../settings/history?key=…` | **`settings:Audit`**          | Version history for a material setting only       |
| `GET .../settings/value/:key`    | `settings:View`               | One effective value, for a screen that needs one  |

**The route decorator is the floor, not the check.** `PUT` is decorated `settings:View` because
Nest needs one at the route; the service then asserts each key's own write permission and returns
a 400 naming the key it refused. Stated because the decorator alone would read as the whole check.

**`settings:Audit` for the history, not `settings:View`.** Reading who changed a governance
setting and why is an audit question — an Employee may read some settings and may not read that.

Prompt 14 web route: **`/settings`** — the shell with left navigation and a right detail panel,
all 19 categories, working General / Organization / Notifications / Appearance panels, the
source badge on every value, change history for governance settings, and the unsaved-change
warning.

Full request/response shapes in `docs/API_CONTRACTS.md`.

## Migrations

**Prompt 30:** `20260911090000_cost_engine_wallets_reservations_ledger` — four tables, two
triggers, sixteen check constraints and three partial unique indexes. 19 raw-SQL probes;
`migrate diff` empty.


**Prompt 29:** `20260910130000_provider_profiles_and_model_gateway` — five tables, three
triggers, twenty check constraints, seven partial unique indexes, and a mock-provider baseline.
`20260910133000_pricing_immutability_has_the_same_escape_hatch` corrects the pricing trigger so a
cascade and the test reset can delete. 28 raw-SQL probes; `migrate diff` empty.


**Prompt 28:** `20260910120000_approval_engine_delegation_and_four_eyes` — four columns on
`approval_requests`, the `approval_decisions` history (append-only by trigger) and
`approval_delegations`. Two triggers, twelve check constraints, one partial unique index. All
probed in raw SQL before use; `migrate diff --from-migrations` empty.


**13 applied.** Every one expand-only: no migration in the chain contains a `DROP`, verified with
`prisma migrate diff --from-migrations` against the shadow database.

| Migration                                                | Type                          |
| -------------------------------------------------------- | ----------------------------- |
| `20260908085001_foundation_tenant_user_membership_audit` | expand                        |
| `20260908092325_tenant_lifecycle_state`                  | expand + migrate (backfill)   |
| `20260908093000_row_level_security_defence_in_depth`     | expand                        |
| `20260908104516_auth_credentials_invitations_sessions`   | expand + migrate (backfill)   |
| `20260908124500_enterprise_identity_mfa_sso_scim`        | expand                        |
| `20260908210000_authorization_engine`                    | expand                        |
| `20260908233000_audit_security_foundations`              | expand + migrate (backfill)   |
| `20260909093000_master_console_platform_roles`           | expand + migrate (backfill)   |
| `20260909120000_company_provisioning_activation`         | expand + migrate (backfill)   |
| `20260909140000_plans_seats_lifecycle`                   | expand + migrate (backfill)   |
| `20260909160000_hierarchy_departments_reporting`         | expand + migrate (backfill)   |
| `20260909180000_users_access_guests_bulk`                | expand + migrate (corrective) |
| `20260909200000_company_settings_shell`                  | expand                        |

Rolling back the Prompt 6 migration destroys every enrolled second factor, recovery code and SSO
connection; Prompt 7's destroys **every role assignment, custom role and policy rule** — that is,
everyone's authority, including the separation-of-duties controls; Prompt 8's destroys every
security event, every sealed checkpoint and **every break-glass record**, including who accessed
which customer's data and whether the customer was told, and leaves `audit_events` intact but
unverifiable and once again editable. Rolling back Prompt 9's destroys every plan, every company's commercial terms, and **every
platform role assignment** — which would return the platform to "any platform actor can do
anything". Rolling back Prompt 10's destroys every company's setup checklist and **every record
of which bootstrap grant was made by provisioning**; rolling back Prompt 11's destroys **every
commercial change request and every lifecycle transition record**, so "why was this customer
suspended in March" becomes unanswerable outside the audit trail. All are recorded in
`docs/DB_CHANGELOG.md`.

## Tests

**Prompt 30:** `packages/types` cost 53/53; `cost-engine.e2e.spec.ts` 33/33 including the
concurrent-overspend and reconciliation tests the prompt names. Full API suite run at this
checkpoint.


**Prompt 29:** `packages/types` providers 37/37; `model-gateway.e2e.spec.ts` 37/37. Regression:
executor 35/35, run-engine 41/41, engine-agent 31/31, agent-builder 32/32, approvals 51/51, web
30/30, `next build` clean.


**Prompt 28:** `packages/types` approvals 47/47; `approvals.e2e.spec.ts` 51/51. Regression after
the rewiring: engine-agent 31/31, executor 35/35, run-engine 41/41, web 30/30, `next build` clean.


**853 passing, 0 failing** — `apps/api` 743, `packages/ui` 96, `apps/web` 7, `packages/types` 7.

---

## Verification commands and results

| Command                | Result                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run lint`         | Clean                                                                                            |
| `npm run typecheck`    | Clean across all five workspaces                                                                 |
| `npm test`             | 853 passed, 0 failed                                                                             |
| `npm run build`        | All workspaces                                                                                   |
| `npm run format:check` | Clean                                                                                            |
| `npm audit`            | **4 high severity**, all Prisma transitives, all assessed unreachable — SECURITY_DECISIONS S-010 |

RLS was re-verified on the seven new tenant-owned tables (`relrowsecurity` and
`relforcerowsecurity` both true), and the person-level MFA tables confirmed to be outside it by
design. The partial unique index on verified domains was checked in `pg_indexes`. Details in
`docs/TEST_MATRIX.md`.

---

## Known limitations

1. **Still not a git repository.** No `git init`, commit or branch has been made, since it has not
   been requested. Six prompts of work now exist with no way to review or roll back a change. This
   remains the most valuable thing to fix, and it gets more valuable every prompt.
2. **`AUTH_ENCRYPTION_KEYS` is an environment variable, not a managed key.** The process refuses to
   start without it, and rotation is supported, but "we encrypt secrets at rest" is not the same
   claim as "the key is managed". `EncryptionKeyProvider` is the seam a KMS/Vault implementation
   replaces at Prompt 20 (S-028).
3. **SAML sign-in is not implemented** and cannot be enabled. The model, columns and metadata
   exist, and the refusal is advertised rather than silent (S-033). ADR-035 lists what implementing
   it actually requires.
4. **WebAuthn/passkeys are not implemented.** The model and policy are method-agnostic, so this is
   a new verifier rather than a redesign — but it is not built.
5. **Company administration is still platform-only, and it has now not been re-homed at Prompt 8
   _or_ Prompt 9.** Both prompts built what the client asked for — the audit foundations, then the
   Master Console — and both times this was the thing that did not get done. Said plainly a second
   time rather than quietly re-dated. It is now Prompt 10-or-later work, behind the provisioning
   wizard the client has asked for next.
   5z. **Superseded note, kept for the record:**
   Six route groups wait for a Company Admin to hold them: invitations, admin session revoke,
   authentication policy, SSO connections and domains, SCIM credentials, and authorization
   administration itself. The engine has existed since Prompt 7 and the Prompt 8 audit routes prove
   it works in shipped code; the re-homing is now Prompt 9's. This slipped, and saying so is more
   useful than moving the target quietly.
   5a. **No audit checkpoint is anchored outside the database, so the tamper-evidence guarantee is
   weaker than it looks.** The column, the sealing flow and the runtime wording all exist, and the
   verify endpoint states plainly what is **not** guaranteed without an anchor: a superuser could
   disable the trigger, rewrite rows, recompute every hash, and the check would still report the
   chain intact. Closing this needs a write-once external sink (ADR-046), which is a Prompt 20-era
   piece of infrastructure.
   5b. **An active break-glass grant is not wired into the authorization engine.** Nothing consults
   `activeGrantFor` to widen a decision, so an approved, activated grant currently confers
   nothing beyond its own record. Deliberate: connecting an access-widening path into the engine
   deserves its own prompt with its own negative tests, and a half-wired one would be worse than
   neither (ADR-048).
   5c. **Neither trail has a retention or archival policy**, and append-only makes that a real
   decision rather than a default: rows cannot be deleted later to fix a policy chosen now. The two
   trails were separated partly so they can have different answers (ADR-045). Prompt 20 onward.

5e. **~~The company provisioning wizard does not exist~~ — built at Prompt 10.** The wizard,
the one-transaction provisioning, the bootstrap grant and the setup checklist all exist. What
remains unbuilt around it: no email dispatcher (the invitation is queued and the API says so),
no logo _upload_ (the metadata columns exist; the file goes to object storage from Settings →
Appearance), and per-department budget allocations wait for departments to exist at Prompt 12.

5f. **Prompt 11's scheduled work has no scheduler.** A future-dated lifecycle transition and a
future-effective plan change are _recorded_ and applied by `POST /platform/commercial/apply-due`,
called by hand or by a test — nothing fires on a clock. Deliberate, and the error falls the safe
way: an unapplied restriction leaves a company operating for a while longer, which is the
generous direction, whereas an unapplied _expiry of access_ would leave authority nobody granted.
Applied transitions record `byScheduler: true`, so the trail does not attribute the act to
whoever scheduled it. The job runner is Prompt 21.

5g. **~~Seat claims are not yet called from the invitation path~~ — CLOSED at Prompt 13.** The
invitation path now claims a seat under the per-tenant advisory lock, so a company cannot be
pushed over its contracted ceiling by inviting people. The original text is kept below for the
record.

5g-old. **Superseded, kept for the record:** Seat claims are not yet called from the invitation path. `SeatService.claimSeat` is the
enforcement point and it is tested against the concurrent race, but the Prompt 5 invitation flow
and the SCIM provisioning path **do not call it yet** — so today a company can still be pushed
over its ceiling through those two routes. Wiring them is Prompt 13 (Users & Access, guests and
bulk lifecycle), where every path that moves a membership into a counted state is in scope. Said
plainly rather than implied by the service existing: a ceiling is enforced where it is called,
and it is called from the commercial plane only.

5h. **Billing and invoicing do not exist.** `billingState` is a column the platform sets; no
payment, invoice, dunning or proration logic exists anywhere. A plan change applies a new ceiling
and allowance — what a customer is _charged_ is out of scope until the Billing & Payments prompt.
The company-facing screen names this rather than mocking up an invoice list.

5i. **AI allowance is contracted, not metered.** `aiConsumedMinor` is a stored figure nothing
increments yet, so the percentage on both screens is only as current as whatever last wrote it.
The Prompt 9 dashboard already marks this class of number as _demo_ provenance; per-run metering
arrives with AI usage.

6z. **~~`TeamSubtree` scope cannot be evaluated~~ — CLOSED at Prompt 12.** `OrganizationModule`
provides `HIERARCHY_RESOLVER`, and a `Manager` assignment now grants at the row level against the
reporting tree. Kept here rather than deleted because it was open through five prompts and the
record of that matters: an authorization gap that stays open across prompts is worth being able
to point at afterwards.

6a. **Prompt 12's remaining gaps.**

- **No department-scoped _listing_ helper yet.** `Department` and `TeamSubtree` scopes decide
  per-resource questions correctly, but a list endpoint still has to narrow its own query.
  `reportingSubtreeUserIds` exists for exactly that and is called by nothing yet — the modules
  that need it (To-do, Objectives, Approvals) arrive later.
- **Employment cannot be ended through the API.** The model, the state, the `ended_at` column and
  the constraint tying them together all exist, and nothing calls them: offboarding is Prompt 13's
  work, alongside suspension and guest expiry. Said plainly rather than implied by the enum's
  existence.
- **Department head is recorded and grants nothing.** `departments.head_user_id` is stored and
  displayed; it is not an authorization input. Making it one would be a second, invisible way to
  gain authority beside the role model, which is exactly what Prompt 7's design forbids.
- **The reference's Full screen and Download are not built.** Both are presentation features over
  the org chart. Listed in `docs/UX_MAP.md` as a deliberate divergence rather than shipped as
  buttons that do nothing.
- **Work email is not verified.** The optional email on an employment record is a contact field.
  It is _not_ a login handle and does not become one — the invitation flow at Prompt 13 is what
  turns a person into an account, and it has its own verification.
- **A synthesised placeholder email exists for a person added before invitation.** A person in
  the org chart with no work address gets `<uboss-id>@person.uboss.invalid`, because
  `users.email` is a unique login handle and this person has no account yet. It cannot receive
  mail (`.invalid` is reserved by RFC 2606) and cannot collide. The invitation flow replaces it
  when a real address arrives.

7a. **Prompt 13's remaining gaps.**

- **Bulk role and scope changes are validated but not applied.** Refused at apply time with the
  reason, rather than routed around the three Prompt 7 escalation gates (ADR-040). A grant that
  skipped them would be the one place in the product where authority is handed out unchecked.
  Wiring it through `RoleAdministrationService` belongs with the Roles & Permissions prompt.
- **Nothing sends the invitation email.** Unchanged since Prompt 5, and now more visible: the
  Users & Access screen shows an invitation as sent when the record exists. Delivery is the
  notifications module.
- **Guest access expiry is stored and not swept.** A guest past their expiry has every _grant_
  expired — `RoleAssignment.expiresAt` is filtered on read, so they reach nothing — and their
  membership still reads `Active` until somebody looks. The screen shows "Access expired" from
  the date, so it is visible rather than hidden; a sweep that flips the membership belongs with
  the job runner (Prompt 21), like every other scheduled expiry.
- **"Last access" is not shown on the roster**, and the reference has a column for it. Session
  last-seen exists per session; rendering one figure per person would mean choosing which session
  counts, and the prototype's "Today 08:42" for everybody is invented data. The column shows the
  invitation date instead — recorded in `docs/UX_MAP.md` as a deliberate divergence.
- **A bulk operation's file is not stored**, only its parsed rows. That is deliberate: the rows
  are what anybody needs later, and storing customer uploads means storing customer uploads.
- **Offboarding cannot be scheduled.** `effectiveAt` exists on the record and offboarding applies
  immediately; a future-dated offboarding needs the scheduler, like the Prompt 11 lifecycle
  transitions.

8a. **Prompt 14's remaining gaps.**

- **Fifteen of the nineteen categories have no settings of their own.** That is the prompt's own
  instruction — "do not implement each deep module yet" — and each one renders with a note saying
  where its configuration actually lives or which prompt brings it, rather than an empty panel.
  Four are real: General, Organization, Notifications and Appearance.
- **Nothing consumes the notification settings yet.** `notifications.approval_reminder_hours` and
  `escalate_after_hours` are stored, validated and versioned, and no reminder is sent because
  there is no scheduler and no notifications module. `CompanySettingsService.effectiveValue` is
  the accessor those prompts will call.
- **`appearance.accent_colour` and `density` are stored and not applied.** The design system's
  tokens are static CSS; wiring a company's accent into them means emitting a per-tenant custom
  property, which is a rendering change rather than a settings one. Stored, so the decision is
  recorded; not yet read by any stylesheet.
- **The change history has no hash chain.** `UPDATE` and `DELETE` are revoked from the
  application role, so the claim is "the application cannot rewrite it" — deliberately weaker
  than the Prompt 8 audit trails, which are chained and can _detect_ tampering. Said plainly
  rather than implied by the phrase "append-only".
- **A platform default cannot be locked from the company.** `platform_settings.locked` exists and
  the Prompt 9 console honours it, but the company-settings resolver treats a platform value as a
  _default_ a company may override rather than a floor it cannot. A genuine platform floor needs
  the catalogue to say which settings admit an override, and no client requirement has asked for
  one yet.
- **No per-department or per-person inheritance.** The client's phrase is "effective inheritance",
  and the three layers implemented are company → platform → code. A department-level override
  would be a fourth layer; nothing in the requirements needs one, and adding a layer nothing
  populates would be a mechanism with no meaning.

5e-old. **Superseded, kept for the record:** The Create
Company entry screen shows the plans, defaults and locked constraints; there is no `POST`
behind it at all, and a test asserts the 404. `TenantProvisioningService` works and is used
by the seed, so the wizard is a matter of wiring the five steps to it — which is the next
prompt.
5f. **AI usage is not metered.** The allowance column, the per-company consumption column and
the screens that read them all exist; nothing writes consumption except the seed. Every
figure derived from it is marked `demo` on the wire and on the screen, so it cannot be
mistaken for operational data — but it is not operational data.
5g. **No payment provider is connected**, so `billingState` is set by hand and Billing &
Payments is a shell. Invoices, dunning and payment state need a provider integration and a
webhook path.
5h. **Nothing observes the running system.** Service alerts are a real table with seeded rows;
the health probes that would raise them do not exist, so System Health names uptime, p95, run
success and queue depth and leaves them empty rather than filling them in.
5i. **The platform-role decomposition is a proposal.** The client named one platform role;
the other five are a UBoss-side split of the client's own navigation grouping. Every role is
a strict subset of the approved ceiling, so no vocabulary was invented — but the boundaries
need the client's confirmation (S-055).
5j. **Feature flags are not consumed by anything.** The table, the guards and the screen are
built; no feature checks a flag yet. When one does, it needs a narrow flag-evaluation service
exported from `PlatformModule` — not the module going global and every feature gaining the
ability to change a plan.
5d. **Nothing alerts on a `Critical` security event.** Severity is classified and indexed for it,
and a broken audit chain records `Critical` — but the only way to see it today is to look.
`onSuspiciousActivity` is the subscription seam; delivery is the notifications module. 6. **~~`TeamSubtree` scope cannot be evaluated yet~~ — CLOSED at Prompt 12.** The hierarchy
arrived and `OrganizationModule` provides `HIERARCHY_RESOLVER`, so a `Manager` assignment now
grants at the row level. See 6z below for the record of how long this stood open. 7. **The TCSiON mapping table is empty**, and reports that fact. The extension point is built and
tested; its contents are blocked on the client's approved reference, which is deliberately not
invented (ADR-043). 8. **Two repository conventions coexist**, unchanged from Prompt 6: the Prompt 6 and 7
repositories declare their own tenant scope (ADR-037); the Prompt 3/4 ones rely on the caller. 9. **Domain claims have no public-suffix check**, so a claim on something like `co.uk` is not
refused today. It needs a suffix list that must be kept current, which belongs with the job
runner at Prompt 21. Stated rather than implied. 10. **Domain verification is caller-triggered, never re-checked.** A company that removes its TXT
record keeps its verified claim until someone re-runs verification. A scheduled re-check belongs
with the job runner (Prompt 21). 11. **Invitation and reset links are still not delivered.** Email is the notifications module
(Prompt 28). Until then a password reset cannot be completed by an end user without someone
reading the token out of the database — the honest state, not a hidden gap. 12. **Choosing a workspace still does nothing.** `/login` lists the workspaces a person may open;
the dashboard those buttons should lead to arrives with the dashboard prompts. 13. **Two repository conventions coexist.** The Prompt 6 repositories declare their own tenant
scope (ADR-037); the Prompt 3/4 ones still rely on the caller. The inconsistency is real and
recorded; migrating the older ones is a follow-up worth doing when something else touches them. 14. **No rate limiting.** Account lockout exists (5 attempts / 15 min, now including failed second
factors), password reset is capped at 5/hour, and MFA challenges allow 5 attempts — but there
is no per-IP or per-route request throttle. That is Prompt 21. 15. **Person-level tables are not under RLS** — `user_credentials`, `password_reset_tokens`,
`sessions`, `mfa_factors`, `mfa_recovery_codes`, `mfa_challenges` have no tenant, so the policy
has nothing to key on. Protected by scoping on a `user_id` taken from a verified session or
challenge, never from caller input (S-015). 16. **Two other UBoss Docker stacks run on this machine** from different directories (ports 5432
and 5433). This repo uses **5442** with its own compose project, volume and roles. 17. **TypeScript still pinned to 6.0.3**, blocked by `typescript-eslint` (<6.1.0) — ADR-002. 18. **Blocked on the client:** the TCSiON user-type/allotment reference. The CR-01/8 user-type test
matrix stays unpopulated until it arrives.

`npm run db:reset` (ADR-024) does a genuine from-scratch rebuild and refuses any target that is not
a loopback `dev`/`test` database. **After Prompt 6 a reset also destroys every enrolled factor,
recovery code and SSO connection**, so dev users must be re-invited and re-enrol.

---

## Next recommended prompt

**Prompt 35 — Knowledge, Files, Data Classification and Safe Uploads**, as the client’s pack
sequences it. Prompts 15–34 are complete and green.

What Prompt 35 will find already built, and must not rebuild:

- **Data classification already exists.** `packages/types/src/classification.ts` was introduced at
  Prompt 33 with §23's four classes — Public / Internal / Confidential / Restricted — their order,
  their ceiling comparison and the `Internal` default, **shaped for Prompt 35 to own** rather than
  for memory to keep. Extend it; a second set of labels is the specific failure it exists to
  prevent (ADR-180).
- **Sensitive-data restriction has a working precedent.** Memory refuses to persist above its
  mode's ceiling and says so in words that distinguish *using* data from *keeping* it. Files and
  knowledge sources want the same distinction.
- **Connections already carry high-risk tool categories**, including `SensitiveExport`, so "apply
  stricter AI/tool policies to sensitive classes" extends `HIGH_RISK_TOOL_CATEGORIES` rather than
  introducing a parallel idea.
- **Export already means `Export` plus an audit event** wherever it exists, and the Security
  Center's Data Exports view reads the named export actions — a new export path has to be added to
  `SECURITY_EXPORT_ACTIONS` or it will be invisible there.

---

## Lessons carried forward

- **A CHECK constraint only refuses a row when its expression is FALSE, and a missing JSON key
  makes it NULL.** `jsonb_typeof(graph -> 'edges') = 'array'` passed for a graph with no `edges`
  key at all — the exact case it was written to catch. Wrap key lookups in `COALESCE`, and probe
  every constraint in raw SQL before code depends on it. This is the third appearance of one
  pattern: `array_length` on an empty array is NULL too, and that accepted exactly the row it
  forbade at Prompt 14. A NULL-valued CHECK fails open, whatever the column type.
- **Size a connection pool from what the code does concurrently, and remember the server has a
  ceiling too.** `AuthorizationService.contextFor` opens five transactions at once on every
  authorized request and one suite makes twelve concurrent appends, so the driver's default of ten
  could never seat it — the audit chain's concurrency test was under-provisioned from the day it
  was written and had looked flaky ever since. Neither the small pool nor the raised pool reported
  anything about connections: the symptoms were a transaction timeout and a bare `P1001` in
  unrelated specs.
- **Never let a service carry its own authorization rule.** "The owner, or anyone with Administer"
  looked reasonable and was a second policy that would have over-shared the moment a role gained a
  module-level action. Hand the scope engine an owner and a department and let it answer.
- **When a fixture cannot be built honestly, the product is usually wrong.** Agent Builder's
  connection check could not pass before activation because an Agent Tool Permission is granted to
  an agent that does not exist yet. Faking the grant in the fixture would have hidden a defect that
  would have blocked every real activation.

---

## A standing performance limitation: `contextFor` opens five transactions per request

Not a Prompt 27 item, but found there and worth stating where the next person will see it.

`AuthorizationService.contextFor` runs five reads concurrently through `Promise.all`, each in its
own interactive transaction: live role assignments, company policy rules, company separation-of-duties
policies, platform policy rules, platform separation-of-duties policies. It runs on **every
authorized request**.

The consequence is that each request needs five connection-pool slots *simultaneously*, so a pool
of N serves only N/5 concurrent authorized requests before the next one waits. That is what made
four unrelated tests fail inside `platformSodPolicies` once the suite grew past thirty spec files —
and the symptom named nothing about pools, only "Unable to start a transaction in the given time".

Raising the test pool to 40 is a workaround for the suite, not a fix for the application. Two
things would actually fix it, in increasing order of care needed:

1. **The two platform-plane reads do not vary by tenant.** `platformPolicyRules` and
   `platformSodPolicies` return the same rows for every company, and caching them with an explicit
   invalidation on policy change would cut five transactions to three. Caching authorization policy
   needs care — a policy change must take effect promptly, and "promptly" has to be defined — so it
   is a deliberate piece of work rather than a quick win.
2. **The three tenant reads could share one transaction.** They are already scoped to the same
   tenant and the same instant; running them sequentially inside one transaction would use one slot
   instead of three, at the cost of a little latency per request. That trade is almost certainly
   worth making, and it is the smaller change of the two.

Belongs with the rate-limiting and observability work rather than being done as a side quest
mid-feature.

## Completed at Prompt 41 — Backups, restore and disaster recovery

All eight things the prompt asks for exist, and the one it forbids claiming is not claimed.

- **PostgreSQL backup and PITR.** `infra/backup/pg-backup.sh` takes a logical dump with a manifest
  recording the migration the schema was at, the size and a SHA-256. Base backup, WAL archive and
  logical dump are three `BackupKind`s with three stated purposes, because they answer different
  questions. PITR configuration is documented in RUNBOOK §10.
- **Restore procedure and automated verification.** `pg-restore-verify.sh` restores into a scratch
  database, runs six checks and drops the scratch database in a `trap` — so it goes even when the
  drill fails, because a forgotten restore is an unmonitored copy of customer data.
- **Object storage policy.** `infra/backup/object-storage-policy.md` — versioning, lifecycle and
  replication, with what is the deployment's responsibility named as such.
- **Redis is non-authoritative.** `REDIS_STANCE`, asserted by a test. A recovery that loses Redis
  loses queue position and cache, not correctness.
- **Secrets and KMS.** `SECRETS_RECOVERY_ASSUMPTIONS`: a restored database is unreadable without
  its keys, and `CheckKeys` **fails** rather than warns when none is available.
- **RPO/RTO by tier**, configurable through `RECOVERY_TARGET_SETTING_KEYS` and documented with a
  reason per tier.
- **Drill checklist and cadence** — `DRILL_STEPS`, 90 days, with `drillIsOverdue` treating "never"
  as overdue.
- **Failover/rollback decision tree** as data, with a test asserting it never recommends restoring
  blind.

### The restore test actually succeeded

The prompt says not to claim DR is complete until a restore test succeeds in a safe environment. One
did: `infra/backup/evidence/uboss-20260912T042244Z.verification.json`, 6/6 checks, 3-second restore,
against a real database. **The drill found a defect in its own `SchemaMatches` check on the first
run** — it read the latest migration row rather than the latest *applied* one, so a rolled-back
migration made a healthy restore look like a schema mismatch.

### Real limitations at Prompt 41

- **What was verified is a logical dump, not PITR.** `infra/backup/pitr-configuration.md` writes
  out the settings to apply, the base-backup pairing archiving depends on, and the recovery
  procedure — including the step people skip, which is to look at the paused replica *before*
  promoting it. None of it has been exercised: this environment has one container and no archive
  destination. The decision tree’s "restore to just before the migration" therefore rests on
  documentation rather than on a drill. **A recovery path nobody has run is a belief, not a
  capability**, and that applies to this one.
- **No standby exists, so failover has never been tested.** The tree says to promote one; nothing
  here has promoted anything.
- **The drill is manual.** `dr-drill.sh` runs on demand and `drillIsOverdue` will say so after 90
  days, but nothing schedules it. A cadence nobody automated is a cadence somebody will miss.
- **`lastVerifiedRestoreAt` is passed in by the caller.** Deliberate (ADR-260), but it means the
  status page is only as honest as whoever wires the evidence file to it.
- **UBoss does not claim disaster-recovery readiness**, and `RECOVERY_CLAIM_STANCE` says so in the
  response. Most of DR — archiving, replication, key custody, DNS failover — belongs to the
  deployment, and `DEPLOYMENT_RESPONSIBILITIES` names all of it.

## Completed at Prompt 42 — Comprehensive Automated Test Matrix

An audit prompt rather than a build prompt. The full report is in `TEST_MATRIX.md`; what follows is
what it changed and what it found.

### What the audit actually found

**The repository was in better shape than the first pass of the audit suggested.** A pattern match
over test titles produced a list of eleven apparent gaps; checking them one at a time reduced that
to three. Six were the matcher looking for words nobody writes in a test title — "IDOR" is tested 55
times under phrasings like *an id somebody guessed must not confirm that the agent exists*, and the
login six-section rule is asserted in `shells.test.tsx` including its approved copy. Two were
correctly deferred work (TCSiON, PITR). That correction is recorded in the report rather than
dropped, because a coverage report that only lists what it found looks identical to one that looked
in the wrong place.

### The three real gaps, now closed

- **Prompt injection was untested.** The posture is good and structural — separate `instruction` and
  `context`, system turn and user turn, literal instructions — and nothing asserted any of it
  (ADR-267).
- **No end-to-end company journey.** Every stage was covered; the hand-offs between them were not
  (ADR-269).
- **The auth route rules were a manual check from Prompt 2** and had not been re-verified since
  (S-340).

### No critical product failures were found

Worth stating plainly, because "fix critical failures" is in the prompt and the honest answer is
that the audit did not surface any. Every new test passed against the existing implementation once
the *tests themselves* were corrected. The three defects this session found were found by **building
the CR-03 screens and opening them**, not by auditing the test matrix — which is a fair argument
about where defects actually hide.

### Real limitations at Prompt 42

- **There is no OpenAPI document**, so "API contract" coverage means route-level specs and not a
  schema diff. Generating one is a build task; inventing it inside a test prompt would have meant
  writing the document and the test that checks it against itself.
- **Redis is exercised through the inline queue.** Nothing asserts broker-specific behaviour such as
  a restart preserving queue position. Acceptable because `REDIS_STANCE` makes Redis
  non-authoritative, and dishonest to describe as covered.
- **The static scans prove absence in source, not at runtime.** They cannot prove a link is
  reachable in every branch — only that it is written. Their docstrings say so.

## Completed at Prompt 43 — Performance and Scale Validation

A measurement prompt. The instruction that shaped it was **"optimize only proven bottlenecks"**, and
most of the work went into making a finding trustworthy enough to act on.

### What was built

`apps/api/scripts/perf/` — a harness that creates its own database, migrates it with the real
migrations, seeds twenty companies (5,000 employees, 1,000,000 audit events, 400,000 notifications),
measures, and drops the database in a `finally`. It never touches `uboss_test`, because
`audit_events` refuses `DELETE`, `UPDATE` and `TRUNCATE` by trigger and seeded rows there could
never be removed.

`packages/types/src/scale-validation.ts` — the budgets, the percentile arithmetic and the verdict
rules, tested away from any database (25 tests). A failed attempt never contributes a latency sample,
any error fails the scenario whatever the latency was, and no samples reports `NotMeasured` rather
than `Pass`. Each of those is a way a benchmark otherwise lies.

### The finding

**Relying on RLS alone for the tenant predicate costs roughly 100x** — hundreds of milliseconds
against a few, on the same
audit page returning identical rows. The policy's `OR` makes every tenant-prefixed index unreachable,
and every index on the three large tables is tenant-prefixed (ADR-271).

Eight reads were fixed to name the tenant. No behaviour changed; no index was added; the five
affected suites pass 249/249. `test/tenant-predicate.spec.ts` stops it regressing.

### The harness lied three times first

Single-tenant seeding, and two queries written by hand that did not match the repository. Each
produced a confident false bottleneck. Recorded as ADR-272 because the general lesson — a
measurement that disagrees with the code is usually wrong about the code — is the durable part.

### Real limitations at Prompt 43

- **Five of the nine declared scenarios were not driven.** Driven: the hierarchy list, the
  reporting subtree, the audit page, concurrent sessions. Not driven: objective list and version
  history, workflow canvas retrieval, the scheduled-agent spike, concurrent credit reservations, and
  provider latency and failure — each needs the application wired up rather than raw SQL against a
  seeded schema. They are declared in `SCALE_SCENARIOS` with budgets and reasons, so the gap is
  visible in code. WebSocket fan-out is not among them because it is not a declared scenario: it sits
  in `NOT_MEASURED_HERE`, since the gateway is in-process and measuring it would measure an event
  emitter.
- **Throughput is not measured and should not be quoted.** It is a property of the hardware.
- **One machine, one container, one API process.** No load balancer, no replica, no broker
  saturation, and nothing sustained for longer than seconds.
- **Beyond ~1,000,000 rows nothing has been explored**, including whether any table wants
  partitioning.

## Recovery — the root ESLint config, deleted during Prompt 43

`eslint.config.mjs` was accidentally deleted while Prompt 43 was being written, by a shell
command of this build's own making: a `node -e` body inside double quotes containing Markdown
backticks, which Git Bash executed as commands. `npm run lint` and `npm run verify` were
broken repository-wide until it was rebuilt.

**There was no backup** — no version control, not in the editor's local history, not in the recycle
bin.

It was reconstructed from four agreeing sources: ADR-008 (which describes the file in as many words),
the surviving `packages/config/eslint.base.mjs` where every rule actually lives, lint output
captured earlier in the same session, and the absence of any per-workspace ESLint config. The rebuilt
config reproduces **the identical violation set** seen before the deletion. Full account in ADR-273.

**Byte-for-byte identity with the original cannot be proven**, and the file says so in its own
header. What can be said is that no rule was lost: the root file never held any, and the file that
does survived untouched.

**No rule was weakened.** The nine `console.log` violations in the scale harness were fixed by
moving it to `apps/api/scripts/perf/`, where the config's existing exemption for operational
scripts applies — not by editing the exemption (ADR-274).

### One pre-existing finding, left alone deliberately

**Prettier formatting is not clean repository-wide.** `npx prettier --check apps/api/test` reports
13 files, and at least eight of them were never touched during this work. So the repository was
already in that state; the ESLint recovery did not cause it.

It is not a gate: `npm run verify` runs lint, typecheck, test and build, and does **not** run
`format:check`. The three files created during Prompt 43 were formatted; the rest were left,
because reformatting files unrelated to this work would bury the recovery in a diff nobody asked
for. Worth fixing on its own terms, as its own change.

### Proof that no rule was weakened

Asserted by printing the **resolved** configuration for a representative file of each kind, rather
than by reading the config and hoping:

| File | no-console | no-unused-vars | no-explicit-any | rules-of-hooks |
| --- | --- | --- | --- | --- |
| `apps/api/src/main.ts` | error | error | error | — |
| `apps/web/src/components/MyEngineAgents.tsx` | error | error | error | error |
| `apps/api/test/tenant-predicate.spec.ts` | error | error | error | — |
| `apps/api/scripts/perf/scale-run.ts` | **off** | error | error | — |

Application code and React surfaces keep every rule at `error`. **Tests are not exempt from
`no-console`.** The single relaxation is the last row, and it is not new: the untouched
`packages/config/eslint.base.mjs` has always turned `no-console` off for operational
scripts, scoped to that one rule and that one directory. The recovery moved a file into that scope;
it did not widen the scope.

### Repository integrity after the incident

Checked rather than assumed, since there was no reason to think one file was the only casualty:

- **Every file referenced by a `package.json` script, a tsconfig `extends`, or a package
  `exports`/`files` entry exists** — 32 references, all resolving.
- **Every conventional config file is present**: both Prettier configs, all seven tsconfigs, both
  Vitest configs and setups, the Prisma schema, the Next config, the compose file, and the shared
  lint base.
- **The source tree is intact**, proven by the full API suite at 2052/2052, a clean typecheck across
  every workspace, and a clean build — a deleted source file could not survive any of those.

The only file lost was `eslint.config.mjs`.
