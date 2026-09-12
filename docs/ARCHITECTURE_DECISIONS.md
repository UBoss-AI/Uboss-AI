# Architecture Decisions

One entry per decision. Supersede rather than rewrite, so the reasoning stays auditable across the
46-prompt build.

---

## ADR-001 — npm workspaces as the monorepo tool

**Prompt 1. Accepted.**

Node 24.19.0 and npm 11.17.0 are present; pnpm and yarn are not installed on the build machine.
npm workspaces covers what this repo needs (hoisting, `--workspace`, `--workspaces --if-present`)
with no extra tooling to install or pin.

Turborepo was considered and rejected for now: with five workspaces and a sub-two-minute pipeline,
its caching does not yet pay for the added dependency. Revisit if CI wall-clock becomes a problem.

**Consequence:** root scripts orchestrate builds in dependency order (`build:packages` first,
because `apps/*` consume the built `dist/` of `packages/*`).

---

## ADR-002 — TypeScript pinned to 6.0.3, not the latest 7.0.2

**Prompt 1. Accepted.**

TypeScript 7.0.2 is the current `latest` tag, but the toolchain does not support it:

- `typescript-eslint@8.70.0` declares `typescript: >=4.8.4 <6.1.0`
- `ts-jest@29.4.12` declared `typescript: >=4.3 <7`

The Master Prompt requires _current stable **compatible**_ versions. TypeScript **6.0.3** is the
newest release the whole graph accepts, so it is pinned.

`ts-jest` was subsequently dropped (ADR-006), which removes one of the two constraints. The
remaining blocker is `typescript-eslint`.

**Upgrade trigger:** when `typescript-eslint` publishes a release accepting TypeScript ≥ 7, bump
TypeScript and that package together, in their own change, and re-run the full pipeline. Do not
casually major-upgrade otherwise.

**Related:** `baseUrl` was removed from `apps/api/tsconfig.json` — TypeScript 6 deprecates it and
7.0 removes it. Path aliases, if ever needed there, must use `paths` without `baseUrl`.

---

## ADR-003 — apps/api is ESM because NestJS 12 is ESM-only

**Prompt 1. Accepted. Supersedes the initial CommonJS assumption.**

`@nestjs/core@12.0.1`, `@nestjs/common@12.0.1` and `@nestjs/config@12.0.0` all ship
`"type": "module"` with no CommonJS build. A CommonJS `apps/api` fails to compile with
`TS1479: … the referenced file is an ECMAScript module and cannot be imported with 'require'`.

`apps/api/package.json` therefore declares `"type": "module"`, and `module: Node16` emits ES modules.

**Consequences:**

- Relative imports inside `apps/api` **must** carry an explicit `.js` extension.
- `__dirname` does not exist; use `import.meta.dirname`.
- NestJS 12 decorators are still legacy-style (`Injectable(): ClassDecorator`), so
  `experimentalDecorators` and `emitDecoratorMetadata` remain **on** — dependency injection depends
  on the metadata `tsc` emits. Do not switch to standard TC39 decorators.

---

## ADR-004 — `module: Node16` rather than `module: CommonJS`

**Prompt 1. Accepted.**

TypeScript rejects `moduleResolution: Node16` combined with `module: CommonJS`
(`TS5110`). Using `module: Node16` lets the package's own `"type"` field decide the emitted format:

- `packages/types`, `packages/ui` — no `"type"` field → **CommonJS** output
- `apps/api` — `"type": "module"` → **ESM** output

One base config therefore serves both, with modern Node resolution semantics in both.

---

## ADR-005 — shared packages emit CommonJS

**Prompt 1. Accepted.**

`packages/types` and `packages/ui` build to CommonJS. ESM consumers (`apps/api`) can import
CommonJS; the reverse is not true. Next.js consumes either. Emitting CommonJS keeps both apps
working from a single build output, and leaves the door open for any future CommonJS tooling.

---

## ADR-006 — Node's built-in test runner for the API and shared packages; Vitest for the web app

**Prompt 1. Accepted. Supersedes the initial "Jest for apps/api" choice.**

Jest + `ts-jest` under ESM needs `--experimental-vm-modules` and ESM-specific transform config —
avoidable complexity given `apps/api` must be ESM (ADR-003). `apps/api`, `packages/types` and
`packages/ui` compile with `tsc` and run tests on the compiled output with `node --test`. This:

- removes the `ts-jest` cap on the TypeScript version (ADR-002),
- removed **321 packages** from the dependency tree,
- exercises the same compiled artefacts that ship,
- keeps `@nestjs/testing` and `supertest` working unchanged (both are just libraries).

`apps/web` keeps **Vitest**, which is required for JSX and a jsdom DOM environment.

**Consequences:**

- Test files are discovered by the glob `"**/*.spec.js"` (API) and `"**/*.test.js"` (packages).
  A file named `*.e2e-spec.ts` would **not** match `*.spec.js`, so the API e2e test is named
  `health.e2e.spec.ts`.
- Pass `node --test "dist/**/*.test.js"` (quoted glob), not `node --test dist/`. The directory form
  reports the whole folder as a single test and hides individual results.
- `apps/api` compiles tests to `dist-test/` via `tsconfig.test.json` so production `dist/` contains
  no spec files.

---

## ADR-007 — Vitest uses the `threads` pool, and its config is `.mts`

**Prompt 1. Accepted.**

The repository path contains spaces (`UBoss Enterprices developemt`). Vitest 5's default `forks`
pool fails on this machine with `Failed to start forks worker` / `Timeout waiting for worker to
respond`, and the reported paths show percent-encoded spaces. `pool: 'threads'` is unaffected.

`@vitejs/plugin-react@6.1.1` is required for the JSX transform: the app `tsconfig` sets
`jsx: preserve` for Next.js, and Vite 8 transforms via **Oxc**, not esbuild, so the `esbuild.jsx`
option is ignored and JSX fails to parse without the official plugin.

The config file is `vitest.config.mts` (not `.ts`) so it loads as ESM; `apps/web` has no
`"type": "module"`, and Vite's native config loader warns about ESM syntax in a CommonJS-loaded file.

---

## ADR-008 — one ESLint flat config at the root; type-aware linting deferred

**Prompt 1. Accepted.**

A single flat config (`eslint.config.mjs` → `packages/config/eslint.base.mjs`) lints every workspace,
so rules cannot drift between them. It is imported by **relative path** so `npm run lint` works on a
cold clone before workspace symlinks exist.

Next.js 16 **removed** the built-in ESLint integration and the `eslint` key from `NextConfig`
(passing it is a type error), which settles ownership: linting happens once, at the root.
`eslint-config-next` is therefore not a dependency.

`typescript-eslint`'s `recommendedTypeChecked` is **not** enabled yet: it needs a resolved project
graph per workspace and slows the bootstrap loop. **Trigger to enable:** once the API has real
domain services (Prompt 3+), turn it on for `apps/api` first, where unsafe `any` flows around tenant
context matter most.

Build output (`dist/`, `dist-test/`, `.next/`) and the client's `index.html` UI reference are
ignored — the prototype is kept byte-for-byte as delivered and is never linted or reformatted.

---

## ADR-009 — the client `index.html` prototype is a reference, not a source to port verbatim

**Prompt 1. Accepted.**

`index.html` is the approved exact UI. It is treated as read-only input: `.prettierignore` and the
ESLint ignore list exclude it. Its design tokens and component structure are transcribed into
`packages/ui` at Prompt 2 rather than the file being wrapped or served.

Seven defects in the prototype must **not** be carried forward; they are catalogued in
`docs/UX_MAP.md` §6, and the client-side-only role model must be re-implemented server-side.

---

## ADR-010 — exact version pinning, and why each package was chosen

**Prompt 1. Accepted.**

Every dependency is pinned to an exact version (no `^`/`~`) so a fresh install cannot silently drift
mid-build. `package-lock.json` is committed.

### Root (dev)

| Package                   | Version | Why                                                          |
| ------------------------- | ------- | ------------------------------------------------------------ |
| typescript                | 6.0.3   | Newest version the whole toolchain accepts — see ADR-002     |
| eslint                    | 10.10.0 | Current stable; flat config                                  |
| @eslint/js                | 10.0.1  | Matches ESLint 10                                            |
| typescript-eslint         | 8.70.0  | Current stable; accepts ESLint 10                            |
| eslint-plugin-react-hooks | 7.1.1   | Hook correctness for the React surfaces; accepts ESLint 10   |
| prettier                  | 3.9.6   | Current stable                                               |
| concurrently              | 10.0.5  | Runs api+web dev, and tsc watch + node watch, cross-platform |
| @types/node               | 24.13.3 | Matched to the Node 24.19 runtime, not the newer 26.x line   |

### apps/api

| Package                                                | Version        | Why                                                                        |
| ------------------------------------------------------ | -------------- | -------------------------------------------------------------------------- |
| @nestjs/common, @nestjs/core, @nestjs/platform-express | 12.0.1         | Current stable NestJS; ESM-only (ADR-003)                                  |
| @nestjs/config                                         | 12.0.0         | Matching config module for env loading                                     |
| @nestjs/testing                                        | 12.0.1         | Matches the runtime version                                                |
| reflect-metadata                                       | 0.2.2          | Required peer for decorator metadata                                       |
| rxjs                                                   | 7.8.2          | Required peer (`^7.1.0`)                                                   |
| class-validator / class-transformer                    | 0.15.1 / 0.5.1 | Declared peers; back the global `ValidationPipe` every later DTO relies on |
| helmet                                                 | 8.3.0          | Security headers from the start, not as a retrofit                         |
| supertest / @types/supertest                           | 7.2.2 / 7.2.1  | HTTP-level assertions for the e2e test                                     |

### apps/web

| Package                         | Version          | Why                                          |
| ------------------------------- | ---------------- | -------------------------------------------- |
| next                            | 16.3.4           | Current stable; App Router, Turbopack build  |
| react / react-dom               | 19.2.8           | Within Next 16's peer range (`^19.0.0`)      |
| @types/react / @types/react-dom | 19.2.18 / 19.2.7 | Match React 19                               |
| vitest                          | 5.0.0            | Current stable; needs vite ^6.4/^7/^8        |
| vite                            | 8.2.2            | Explicit peer for Vitest 5                   |
| @vitejs/plugin-react            | 6.1.1            | JSX transform under Vite 8/Oxc — see ADR-007 |
| jsdom                           | 30.0.1           | DOM environment for component tests          |
| @testing-library/react          | 16.3.3           | React 19 compatible                          |
| @testing-library/dom            | 10.4.1           | Declared peer of RTL 16                      |
| @testing-library/jest-dom       | 7.0.1            | DOM matchers, via its `/vitest` entry point  |

No database, cache, queue, storage or secrets package is installed yet — those arrive with the
prompts that use them (Prisma at Prompt 3, Redis/BullMQ at Prompt 21), so nothing sits unused in the
tree.

---

## ADR-011 — packages/ui ships as TypeScript source, not a compiled bundle

**Prompt 2. Accepted. Supersedes the CommonJS build for this package only.**

At Prompt 1 `packages/ui` compiled to CommonJS with `tsc`. That breaks now that it holds React
components: the `"use client"` directive marking a client boundary does not reliably survive `tsc`
emit, and a design system whose interactive components silently lose their client boundary would
fail at runtime in ways unit tests do not catch.

`packages/ui` therefore has **no build step**. Its `exports` map points at `./src/index.ts`, and
`apps/web` compiles it via `transpilePackages: ['@uboss/ui']` — the standard Next.js monorepo
pattern for a first-party component library.

**Consequences:**

- `packages/ui` is typechecked with `tsc --noEmit` and tested with Vitest (jsdom), not `node --test`.
- Root `build:packages` now builds only `@uboss/types`.
- `apps/api` must not import `@uboss/ui` — it would receive untranspiled TSX. Nothing in the API
  needs it; shared contracts belong in `@uboss/types`, which is still compiled.
- `packages/ui` imports are **extensionless**, because bundlers resolve them and a `.js` specifier
  pointing at a `.ts` file is fragile across Vite and Next.

`@uboss/types` keeps its CommonJS build (ADR-005): it is consumed by the ESM API, holds no JSX, and
benefits from being a real compiled artefact.

---

## ADR-012 — plain CSS with custom properties, and the FormField render-prop tradeoff

**Prompt 2. Accepted.**

Styling is **plain CSS with CSS custom properties**, shipped as one stylesheet
(`@uboss/ui/styles.css`) and imported once in the root layout.

Rejected alternatives:

- **Tailwind** — the client's approved UI reference _is_ hand-written CSS with a token block.
  Re-expressing it as utility classes would make it far harder to review a screen against the
  approved design, and would put design decisions back into per-page markup, which the locked UI
  rule ("reusable components instead of one-off page styling") exists to prevent.
- **CSS Modules** — hashed class names would break that same reviewability, and the reference's
  class vocabulary (`.uboss-card`, `.uboss-badge--warn`) is deliberately readable.

Class names are prefixed `uboss-` to avoid collision with anything a future integration injects.

**The FormField tradeoff:** `FormField` takes its control through a render prop, which makes it
impossible to render a labelled field whose input is not wired to its label, hint and error
message. The cost is that a function prop cannot cross the server-to-client boundary, so **any
screen using `FormField` must be a client component**. That is an acceptable trade: forms need
state anyway. It is recorded here because the failure mode ("Functions cannot be passed directly to
Client Components") is otherwise cryptic.

---

## ADR-013 — the DonutDashboard contract forbids a third slice at the type level

**Prompt 2. Accepted.**

The Company Workspace Dashboard must show exactly one donut with exactly two slices, Agents and
Pending Jobs (`UBoss_Final_2` §29, which declares "LATEST RULE WINS" over older dashboard
examples). A generic `slices: Slice[]` prop would make breaking that rule a one-line change that no
reviewer would notice.

`DonutDashboard` therefore takes two **named numeric props**, `agents` and `pendingJobs`. Adding a
category would require changing the component signature — and therefore the source-of-truth
document — at the same time. A unit test additionally asserts that exactly three `<circle>`
elements render (one track, two arcs), so a third arc fails the suite.

The legend entries are real `<button>`s: the SVG arcs alone would leave keyboard users unable to
reach either drill-down.

---

## ADR-014 — an internal showcase route instead of Storybook

**Prompt 2. Accepted.**

The Prompt Pack allows "Storybook or an internal component showcase route if consistent with the
repo". `/design-system` is a set of real Next.js routes rendering the real components.

Storybook was rejected for now: it is a second build toolchain, bundler config and dependency tree
to pin and keep compatible with Next 16 / Vite 8 / React 19, for a benefit — isolated component
rendering — that the showcase already provides. The showcase also exercises the components inside
the actual app, so a client-boundary or stylesheet-import mistake shows up immediately, as it did
for ADR-012.

Revisit if designers outside the repo need to browse components without running the app.

---

## ADR-015 — Prisma pinned to 7.10.0, because `latest` is a release candidate

**Prompt 3. Accepted.**

At the time of writing, `npm view prisma version` returns **8.0.0-rc.13**: the `latest` dist-tag on
the `prisma` CLI points at a release candidate, while `prev` is `7.10.0`. `@prisma/client@latest` is
`7.10.0`.

Installing `prisma@latest` would therefore have pulled an unreleased major _and_ mismatched the
client. Both are pinned to **7.10.0**, the current stable matched pair, per the Master Prompt's
"current stable compatible versions".

**Upgrade trigger:** when `prisma@latest` resolves to a stable 8.x and `@prisma/client` matches it,
upgrade both together in their own change and re-run the full pipeline. Prisma 8 is a major release
with its own migration guide.

---

## ADR-016 — the Prisma client is generated as ESM TypeScript into `src/generated/prisma`

**Prompt 3. Accepted.**

This is the resolution of the caveat flagged at the end of Prompt 1.

Prisma's default output (`node_modules/.prisma/client`) does not work with this repository:
`@prisma/client` re-exports it via the bare specifier `.prisma/client/default`, and
`node_modules/.prisma` has no package root. That resolves under legacy node10 resolution but not
under `moduleResolution: Node16`, which `apps/api` requires. The symptom is
`TS2305: Module '"@prisma/client"' has no exported member 'User'` — the client works at runtime but
has no types.

Generating into `node_modules` with a `package.json` shim was rejected: a CommonJS `index.js` inside
our `"type": "module"` package would fail to parse at runtime.

Instead the schema uses Prisma 7's `prisma-client` generator with `moduleFormat = "esm"`, emitting
TypeScript into `apps/api/src/generated/prisma`. Imports are relative
(`../generated/prisma/client.js`), so node_modules resolution is not involved at all.

**Consequences:**

- `prisma generate` runs before `build`, `typecheck` and `test`, because the generated client is
  not committed.
- `src/generated/**` is excluded from ESLint and Prettier and is listed in `.gitignore` — it is
  build output that happens to live under `src`.
- Prisma 7 also removed `url` from the schema's `datasource` block. The CLI reads the connection
  string from `prisma.config.ts`; the runtime client is constructed with the `@prisma/adapter-pg`
  driver adapter. A useful side effect: `schema.prisma` contains no connection string at all.
- Prisma 7 no longer auto-loads `.env`, so `prisma.config.ts` calls `process.loadEnvFile()` and
  falls back to the local compose URL so `prisma generate` (and therefore `typecheck`) works on a
  fresh clone with no `.env`.

---

## ADR-017 — transactions travel in AsyncLocalStorage, not as a parameter

**Prompt 3. Accepted.**

`PrismaService` exposes `client`, which returns the ambient interactive transaction when one is open
and the root client otherwise. A service opens one with `runInTransaction(fn)`; every repository
call inside that callback — at any depth — automatically joins it. Nested calls join the outer
transaction rather than opening a second one.

The alternative, threading a `tx` argument through every repository signature, was rejected because
a _forgotten_ argument silently writes outside the transaction, and that failure is invisible in
review and usually invisible in tests too. With the ambient store there is no argument to forget.

`PersistenceModule` is `@Global` for the same reason: a second `PrismaService` instance would carry
a second store, so a repository resolved from the wrong instance would miss the transaction.

`PrismaTransactionClient` is derived from Prisma's own `$transaction` callback parameter type rather
than hand-listing excluded methods, so it cannot drift when Prisma changes that surface.

Rules recorded in the service's own doc comment: a service method writing more than one row must
wrap them; an audit event is written in the same transaction as the change it records; no network
calls inside a transaction.

---

## ADR-018 — tenant isolation is a repository convention with a branded scope type

**Prompt 3. Accepted.**

Every tenant-owned repository method takes a `TenantScope` as its first parameter and merges
`tenantId` into the `where` clause. There is deliberately **no method that accepts only a record
id**, because such a method would let a caller in Tenant A read or modify Tenant B's row by
guessing a UUID.

`TenantScope` is a _branded_ type: a bare `string` cannot be passed where a scope is required, and
the only ways to obtain one are `tenantScopeFromVerifiedMembership` (the request path, wired up at
Prompt 4) and `tenantScopeForPlatformOperation` (provisioning, seeds, tests). The names are the
documentation: a reviewer seeing `tenantScopeForPlatformOperation` in a request handler knows it is
wrong.

Two supporting choices:

- **Misses return `null` / `0`, never a throw.** A cross-tenant guess is then indistinguishable
  from a genuinely absent record, so nothing leaks about whether the id exists.
- **Writes use `updateMany`/`deleteMany` rather than `update`/`delete`.** The singular forms need a
  unique selector and throw when the row exists but belongs to another tenant — which both
  discloses its existence and turns a scoping bug into a 500. The plural forms report 0 affected
  rows instead.

`users` is intentionally **not** tenant-owned: one person keeps one permanent UBoss Unique ID across
companies, so isolation is applied at the membership join (`findInTenant`, `listInTenant`) rather
than by putting `tenant_id` on the person.

This is an application-layer convention. It is defence in depth, not the only layer: PostgreSQL
Row-Level Security is evaluated at Prompt 4, and the Master Prompt is explicit that RLS must not be
the sole authorization mechanism either.

---

## ADR-019 — request context travels in AsyncLocalStorage, with a two-stage actor

**Prompt 4. Accepted.**

`RequestContext` (correlation id + actor + start time) lives in `AsyncLocalStorage`, established
by `CorrelationIdMiddleware` for every request before guards run — so even a request that is
about to be refused has a correlation id to quote, which is exactly the request worth correlating
with its logs.

The actor is resolved in **two stages**, with two distinct types:

- `ResolvedPrincipal` — what authentication produced: `anonymous`, `platform`, or `person`.
- `AuthenticatedActor` — what the guard verified: `anonymous`, `platform`, or `tenant` (which
  carries `tenantId` **and** `membershipId`).

They are separate types on purpose. A signed-in company person is not yet a `TenantActor`,
because that requires a membership the server has checked. Keeping them distinct makes a
half-verified tenant actor unrepresentable rather than merely discouraged.

**Mechanical wrinkle worth recording:** Nest runs guards, interceptors and handlers on separate
call stacks, so an `AsyncLocalStorage` scope opened inside `canActivate` does not reach the
handler. The guard therefore attaches the verified actor to the request object and
`RequestActorInterceptor` re-establishes it around the handler. Interceptors run after guards,
which Nest guarantees for a global pair.

---

## ADR-020 — the tenant guard denies by default, and a requested workspace is never a credential

**Prompt 4. Accepted.**

`TenantGuard` is registered globally and refuses any route carrying none of `@AllowAnonymous`,
`@PlatformOnly` or `@TenantScoped`. A forgotten decorator therefore produces a 403 that someone
notices, instead of an accidentally public endpoint that nobody does. `GET /health` is explicitly
marked `@AllowAnonymous`.

Working rule E says a tenant operation derives its tenant from authenticated membership, never
from a browser-supplied `tenant_id`. That cannot mean "ignore what the client asks for" — a person
who belongs to two companies has to be able to choose one. The distinction the guard draws:

1. the requested workspace (route param `:tenantId`/`:workspaceId`, else the
   `x-uboss-workspace` header) is treated as a **request**;
2. it is rejected outright unless it is a well-formed UUID, so a malformed value never reaches a
   query;
3. a membership for _that person and that workspace_ is looked up **in the database**;
4. the company's lifecycle state is enforced;
5. only then is a verified `TenantActor` installed.

The value the client sent is never what authorises anything — the membership row is.

**Two deliberate refusals:**

- A **platform actor is not implicitly a member of every company.** Acting inside a tenant
  requires an explicit membership; a support-impersonation path would need its own audited
  design, which does not exist yet.
- "Not your company" and "no such company" return the **identical** message, so the endpoint
  cannot be used as a tenant-existence oracle. A test asserts the two responses match.

---

## ADR-021 — RLS is a second layer with a fail-closed policy, not the authorization mechanism

**Prompt 4. Accepted.**

The Master Prompt permits RLS as defence in depth and forbids relying on it alone. Both halves
are honoured: the repository convention from ADR-018 is unchanged and still authoritative, and RLS
sits underneath it.

Making RLS real required two discoveries about this database, both recorded because a naive setup
would have looked correct while doing nothing:

1. the owner role `uboss` is a **superuser with `rolbypassrls`** — policies would never apply, so
   the application now connects as a separate `uboss_app` role with neither attribute;
2. a table owner bypasses RLS regardless — hence `FORCE ROW LEVEL SECURITY`.

The policy grants access when `app.current_tenant_id` matches the row, or when
`app.platform_operation = 'on'`. A path declaring neither reads nothing. **Failing closed is the
point**: a missing scope becomes an immediate, obvious failure instead of a silent cross-tenant
read.

`PrismaService` gained `runInTenantTransaction(scope, …)` and `runAsPlatformOperation(…)`, which
open a transaction and declare the scope with `SET LOCAL` — transaction-scoped, so a pooled
connection can never carry one tenant's scope into another's request. Re-entering with a
different tenant, or escalating a tenant scope to a platform operation, both throw rather than
silently widening access.

**Consequence accepted:** `runAsPlatformOperation` is an escape hatch, and code that calls it is
outside the RLS backstop. It is named verbosely so it looks wrong in a company-workspace handler,
and the guard guarantees request paths get tenant scope instead. Narrowing it further is recorded
as future hardening.

**Injection note:** `SET LOCAL` cannot be parameterised — PostgreSQL only accepts a literal — so
the tenant id is interpolated into SQL. `TenantScope` therefore validates UUID format at
construction, which makes that interpolation provably safe rather than dependent on every future
caller having sanitised its input. A test asserts `tenantScopeForPlatformOperation("' OR 1=1 --")`
throws.

---

## ADR-022 — authentication is a seam whose default authenticates nobody

**Prompt 4. Accepted.**

Login is Prompt 5. Prompt 4 ships the `ActorResolver` seam and **no** real implementation.

The default, `AnonymousActorResolver`, authenticates nobody — so every tenant-scoped route is
denied until Prompt 5 supplies a real resolver. This is deliberately not the more convenient
"allow everything pending auth" stub, because that shape has a habit of surviving into
production; a resolver that denies everything produces failures that get noticed.

`DevHeaderActorResolver` treats `x-uboss-dev-actor` as "this person is signed in", for
development and tests. It still confirms the person exists — what it skips is proof of
possession. It is wired only when `AUTH_DEV_HEADERS_ENABLED=true` **and** `NODE_ENV` is not
`production`; if the flag is set in production the process **throws at startup** rather than
quietly ignoring it, because a deployment that believes impersonation is enabled must fail loudly
in either direction. Verified at runtime: the process exits 1 with that message, and starts
normally with the anonymous resolver when the flag is absent.

An unknown id in the header resolves to anonymous rather than an error, so the header cannot be
used to enumerate which UBoss Unique IDs exist.

---

## ADR-023 — integration test files are serialised

**Prompt 4. Accepted.**

Node's test runner executes spec files concurrently in separate processes. Both integration
suites truncate the shared `uboss_test` database in `beforeEach`, so they raced — producing
failures in whichever file lost, with confusing symptoms (`No record was found for an update`).

`--test-concurrency=1` serialises the files. Per-file databases were considered and rejected as
premature: the suite runs in about twenty seconds, and one shared database keeps the harness
simple. Revisit if the suite gets slow enough that parallelism is worth the isolation work.

---

## ADR-024 — a project-owned guarded database reset, not `prisma migrate reset`

**Prompt 4 (follow-up). Accepted.**

`prisma migrate reset` refuses to run unattended: Prisma detects an automated caller and declines
to drop a database without a human explicitly consenting. That check is correct and was not
bypassed — `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` is deliberately not used anywhere in this
repository.

Instead `npm run db:reset` runs `apps/api/scripts/reset-database.mjs`, which re-implements the
operation with guards that are **narrower** than Prisma's, because they can be
project-specific:

| Guard                                 | Behaviour                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `NODE_ENV=production`                 | Refused outright                                                                                       |
| Non-loopback host                     | Refused unless `UBOSS_RESET_ALLOW_REMOTE_HOST=yes` is set deliberately                                 |
| Database name without `dev` or `test` | Refused — so plain `uboss`, and the other UBoss stacks' databases on ports 5432/5433, can never be hit |
| Preview                               | Prints the exact row counts it is about to destroy; `--dry-run` stops there                            |

All four refusals are verified, including against the neighbouring project's `uboss_ai_ams`
database.

**Why it is worth having rather than just truncating tables.** It drops and recreates the `public`
schema, so the migration history, the RLS policies and the role grants all go with it and are
rebuilt by the migrations. That exercises the same path a new developer or a fresh CI database
takes. Confirmed after a reset: RLS re-enabled _and_ forced on both tenant-owned tables, both
policies recreated, `uboss_app` grants and schema usage restored, an unscoped query still returning
0 rows, and the seed's `Provisioning → Active` transition actually running — which a truncate would
never have tested, and which had previously only been covered indirectly.

**Related fix.** The first version used `execFileSync(..., { shell: true })`, which Node flags as
`DEP0190`: arguments are concatenated rather than escaped. Every child process is now invoked as
`node <cli entry point>` with no shell, and the entry points are located with
`createRequire(...).resolve(...)` rather than counted `../` hops — the test harness had exactly
that bug, because the compiled file sits at a different depth from its source and a hard-coded
relative path pointed at the wrong directory.

---

## ADR-025 — opaque server-side sessions, not self-contained tokens

**Decision.** A session is a row in `sessions`. The cookie carries 32 random bytes; the database
stores only the token's SHA-256 hash. No JWT, no self-contained access token.

**Why.** Every session requirement in this step depends on invalidating one specific session
_immediately_: Active Sessions, Logout All Devices, administrative revoke, and revoke-everything-
on-password-change. A stateless token cannot be un-issued. The usual workarounds — a short TTL
plus a refresh token, or a revocation list — either leave a window in which a revoked session
still works, or reintroduce the per-request database read while keeping the token's complexity.

**Cost, stated honestly.** One indexed lookup on a 64-character hash per authenticated request.
That is a real cost and it is accepted: correctness of revocation matters more here than shaving
a query, and the alternative's "revocation" would be a promise the architecture could not keep.

**What this buys immediately.** `absoluteExpiresAt` and `lastSeenAt` are server state, so both the
idle and absolute rules are enforced where they cannot be tampered with, and a session's device
label and coarse network hint can be shown to its owner.

**`lastSeenAt` is not written on every request.** It is refreshed only when it is more than
`AUTH_LAST_SEEN_REFRESH_SECONDS` (default 60) stale, so a busy session does not turn every read
into a write. The idle rule is therefore accurate to within a minute, which is the right trade for
a 30-minute window.

---

## ADR-026 — SHA-256 for one-time tokens, Argon2id for passwords

**Decision.** Passwords are hashed with Argon2id (`memoryCost` 19 MiB, `timeCost` 2,
`parallelism` 1). Invitation, password-reset and session tokens are hashed with a single SHA-256.

**Why not one algorithm for both.** A slow KDF exists to make _guessing_ expensive, and guessing
is only a threat when the secret is guessable. A password may be `Summer2026!`. An invitation
token is 32 bytes from a CSPRNG — 256 bits of entropy, which no amount of hashing effort makes
meaningfully harder to guess than it already is. Argon2 on a token would add ~50 ms to every
session validation, which is every authenticated request, in exchange for nothing.

**What SHA-256 must still provide, and does.** Pre-image resistance, so a stolen database does not
yield working tokens; and constant-time comparison, done with `timingSafeEqual`. Tokens are looked
up _by hash_, so the comparison is a unique-index probe rather than a scan.

**Why Argon2id specifically.** Memory-hard, so GPU and ASIC attacks lose most of their advantage,
and the `id` variant resists both side-channel and time-memory trade-off attacks. Parameters are
the OWASP-recommended baseline. `needsRehash` compares a stored hash's parameters against the
current ones and upgrades transparently on the next successful sign-in — so raising the cost later
does not need a migration or a forced password reset.

**Implementation note.** `@node-rs/argon2` exports no `needsRehash`, so it is implemented here via
`parseOptions`, and only _weaker_ stored parameters trigger a rehash. Its `Algorithm` enum is an
ambient `const enum`, unreadable under `isolatedModules`, so the literal `2` is used with a named
constant and a comment rather than importing a type that cannot be erased.

---

## ADR-027 — the session resolver replaces the anonymous one; `@Authenticated` and a fourth actor kind

**Decision.** `SessionActorResolver` reads the session cookie and resolves the real principal.
`CompositeActorResolver` tries it first and falls back to the development header resolver when
that is permitted. A new `@Authenticated()` policy and a fourth actor kind, `UserActor`, cover
routes that need a signed-in person but **no** workspace.

**Why the fourth kind was necessary.** ADR-019's actor was `anonymous | platform | tenant`. But
`GET /auth/sessions` is neither: it is a person acting on their own account, before or without
choosing a company. Marking such routes `@AllowAnonymous` was tried first and was wrong — that
decorator skips actor resolution entirely, so `/auth/me` returned 401 with a perfectly valid
cookie. Modelling it as a `tenant` actor would have been worse: it would have invented a workspace
the request never named.

**Why the composite is not a Nest provider.** An optional `ActorResolver | undefined` constructor
parameter is not resolvable by the DI container. It is constructed by the `TenancyModule` factory
instead, which also keeps the production gate on the development resolver in one place. It
carries no `@Injectable()`, so it cannot be wired in by accident.

**What did not change.** ADR-022 said authentication was a seam whose default authenticated
nobody. That seam held: swapping the resolver required no change to `TenantGuard`, the request
context, the repositories or the RLS wiring. The only guard change was additive — one new branch
for the `authenticated` policy.

---

## ADR-028 — account state lives on the membership, and the guard takes the stricter of the two

**Decision.** `AccountState` (`NotInvited`, `InvitePending`, `Active`, `Suspended`, `Offboarded`)
is a column on `tenant_memberships`. The guard computes `effectiveCapability(lifecycleState,
accountState)` and applies the **more restrictive** of the company's state and the person's.

**Why on the membership and not on the user.** A person can be Active at one company and Suspended
at another; the state is a property of the relationship, not of the identity. Putting it on `users`
would make suspension global — which is a _platform_ action, and a different concept.

**Why not on `tenants`.** `TenantLifecycleState` is the company's state. Conflating "this company
is read-only" with "this person is suspended" would produce a single flag that could not express
the ordinary case of an active person in a read-only company.

**Reporting which one blocked.** `effectiveCapability` returns not just the capability but which
state produced it, so the 403 says whether the company or the account is the reason. A user told
"access denied" with no distinction cannot tell whether to call their admin or wait for a billing
issue to clear.

**Migration consequence.** Existing rows were backfilled to `Active`
(`WHERE created_at < NOW()`), because a membership created before this column existed was already
in use. New memberships default to `NotInvited`, which correctly broke six Prompt-4 guard tests:
`provision()` leaves the first member un-invited, and those fixtures had been relying on a
membership being usable the moment it existed. They now activate the membership explicitly, which
is what the real flow does.

---

## ADR-029 — uniform failure responses, and equalised timing to match

**Decision.** Login, invitation preview, invitation activation, password-reset request and
password-reset confirm each return **one** response for every failure mode. Login additionally
burns an Argon2id verification against a dummy hash when no credential exists.

**Why the timing part is not optional.** Identical response bodies are useless if the responses
arrive at measurably different times. "Unknown email" would return in about 1 ms — no hashing to
do — and "wrong password" in about 50 ms. That difference alone is a working account-enumeration
oracle, readable over the network without any special tooling.

**The one deliberate exception.** Lockout is reported distinctly, with a `Retry-After` header.
Someone locked out has to know in order to act, and by the time an attacker has triggered a
lockout the enumeration signal is worthless anyway — the account stops answering.

**What is left unsaid on purpose.** Invitation preview answers `{ valid: false }` for expired,
cancelled, already-used and never-existed alike. Own-session revoke returns the same 403 for
"not yours" and "does not exist", so session ids cannot be probed. Password-reset request answers
identically for a real and an unknown address, and returns no token.

---

## ADR-030 — RFC 6238 TOTP and JWT verification are implemented here, not taken from a package

**Decision.** `src/auth/totp.ts` implements HOTP/TOTP and RFC 4648 base32 from `node:crypto`.
`src/auth/sso/jwt.ts` verifies OIDC ID tokens against a JWKS from `node:crypto`. Neither takes a
dependency.

**Why, for TOTP.** The algorithm is short and completely specified, and both RFCs publish test
vectors — so a from-scratch implementation can be _proved_ correct rather than trusted. The unit
tests run every vector from RFC 4226 Appendix D and RFC 6238 Appendix B for SHA-1, SHA-256 and
SHA-512. Against that, an authentication dependency is a supply-chain path directly into the
sign-in flow, and the popular options in this space have a history of awkward ESM/CJS interop that
this repository (ESM-only NestJS, ADR-006) would have had to work around.

**Why, for JWT — a stronger argument.** JWT verification is where JWT libraries have historically
gone wrong, quietly and catastrophically. The three classic failures are accepting `alg: none`,
letting the token's own `alg` header select the key type (so an RSA public key gets used as an
HMAC secret), and treating `iss`/`aud` checking as opt-in. All three are _unreachable_ here: the
algorithm allow-list is a module constant, candidate keys are filtered by the key type recorded in
the **JWKS** rather than by anything in the token, and every claim check is unconditional. A
library gives those properties only if configured correctly at every call site.

**Cost, stated plainly.** Two pieces of security-critical cryptography are now ours to maintain,
and a future algorithm (Ed25519 ID tokens, say) is our work rather than a version bump. That is
accepted because the surface is small and pinned to published specifications.

**What is deliberately refused.** HMAC-signed ID tokens (`HS256` and friends), even though OIDC
permits them: with HMAC the verification key _is_ the client secret, so anyone holding the client
secret — including our own database, if it leaked — could mint valid ID tokens. Asymmetric signing
keeps that power with the identity provider, which is the entire point of federation. The
refusal is advertised in `GET /tenants/:id/identity/sso-setup` so a company finds out before it
configures one, not after.

---

## ADR-031 — three secrets are encrypted rather than hashed, with purpose binding and key rotation

**Decision.** `src/auth/secret-box.ts` provides AES-256-GCM envelope encryption for exactly three
values: the TOTP shared secret, a company's OIDC client secret, and a PKCE code verifier.
Everything else stays hashed.

**Why these three are different.** Hashing is always preferable, because a hash cannot be turned
back into a working credential by anyone, including us. But all three of these must be **used**
rather than merely compared: TOTP verification recomputes the code from the secret, the client
secret is sent to the identity provider's token endpoint, and the PKCE verifier is replayed
verbatim in the token exchange. A hash cannot do any of that. So the choice is not
hash-versus-encrypt, it is encrypt-versus-plaintext — and plaintext means a database reader gets
working credentials.

Encryption reduces the threat from "read the database" to "read the database **and** obtain the
process's key material", because the key lives in `AUTH_ENCRYPTION_KEYS`, outside the database.

**Envelope format.** `v1.<keyId>.<iv>.<tag>.<ciphertext>`, each part base64url. The version prefix
means the format can change without guessing. The key id means keys can be **rotated**: the first
entry in `AUTH_ENCRYPTION_KEYS` seals new values, and retired entries still open old ones. Dropping
a retired key too early fails loudly and names the missing key, rather than silently producing
undecryptable rows.

**Purpose binding is not decoration.** The purpose string (`mfa.totp_secret`,
`sso.client_secret`, `sso.pkce_verifier`) is passed to AES-GCM as additional authenticated data, so
a ciphertext sealed for one purpose **fails to open** as another. Without it, a database writer
could move a value between columns and have it accepted somewhere it grants more than it should.
There is a test for exactly that.

**What this does not solve, and where it goes.** The key is an environment variable. A real
deployment wants it in a KMS or Vault with audited access and automatic rotation.
`EncryptionKeyProvider` is the seam for that, and everything downstream depends on `SecretBox`
rather than on where the key came from — so Prompt 20 replaces one factory. Stated here rather
than implied, because "we encrypt secrets at rest" is not the same claim as "the key is managed".

---

## ADR-032 — an unfinished MFA sign-in is not a session

**Decision.** When policy requires a second factor, a correct password produces an `MfaChallenge`
row and a separate short-lived cookie (`uboss_mfa`, `SameSite=Strict`, five minutes). It does not
produce a `Session` row.

**The alternative, and why it was rejected.** The obvious implementation is a `Session` with an
`mfa_pending` flag, cleared once the code verifies. It is rejected because it makes every guard,
every repository and every future feature responsible for remembering that _some sessions are not
really authenticated_. The first one that forgets is a full authentication bypass, and it would
look like ordinary code.

Keeping the half-finished login a separate object means `TenantGuard` needed **no change at all**
for MFA: an unfinished sign-in simply has no session, and the deny-by-default guard already
handles that. That is the strongest evidence for the decision — a security feature that required
no change to the security-critical component it protects.

**Consequences.**

- The challenge cookie uses `SameSite=Strict`, stricter than the session cookie's `Lax`. Nothing
  legitimately navigates to the second-factor step from another site, so there is no case to
  accommodate; the session cookie needs `Lax` so an emailed activation link works.
- One challenge yields at most one session, enforced by a compare-and-set on `consumedAt`.
- Failed second factors increment the **same** `user_credentials.failed_attempts` counter as a
  failed password. Otherwise the second factor would be the cheap thing to brute-force: six digits
  is a million possibilities, and an attacker who already has the password would have unlimited
  attempts at the part meant to stop them.
- The same challenge authorises **first-time enrolment**, which is what stops a newly-imposed MFA
  requirement from being a lockout — see ADR-033.

---

## ADR-033 — policy is evaluated across every company a person belongs to, taking the strictest

**Decision.** `AuthenticationPolicyService.decideForPasswordSignIn` reads the policy of **every**
company the person is a member of and applies the strictest requirement found. SSO-required wins
over MFA-required, which wins over no requirement.

**Why not evaluate the workspace being entered.** Because a UBoss session is _person-level_: it can
switch workspaces without re-authenticating. Issuing a password-only session because the person
happened to land on a permissive company would hand them a session that then opens the
MFA-mandating one. Evaluating only the entered workspace is a bypass with extra steps.

**The cost, stated.** Joining one strict company makes a person's sign-in stricter everywhere,
including at companies that asked for nothing. That is the correct trade — the strict company's
requirement is the one with a real consequence behind it — but it is a genuine consequence and it
belongs in the record rather than being discovered.

**Two invariants enforced on write, both about self-lockout.**

- **Requiring SSO needs an enabled connection.** Otherwise every member is redirected to a
  provider that does not exist, including the administrator who would undo it.
- **Requiring SSO disables password sign-in.** Not as a side effect but as the meaning of the
  setting; leaving passwords enabled beside it would make the requirement decorative.

**The MFA grace period.** `mfaGraceUntil` lets a company impose MFA without instantly locking out
everyone who has not enrolled. It is optional, and omitting it means "immediately" — a legitimate
choice for a company where everyone is already enrolled, and a lockout for one where they are not.
The API does not guess; the screen says which it is. Independently of the grace period, someone
with a correct password and no factor can **enrol against their challenge** and complete the
sign-in, so the failure mode is "you must set this up now", not "ask your administrator".

---

## ADR-034 — federation authenticates; it never provisions

**Decision.** A successful OIDC assertion signs in a person who **already has a membership** in
that company. An assertion for an unknown email, or for an email whose domain the company has not
verified, or for someone with no membership, is refused. Just-in-time provisioning is not
implemented.

**Why.** JIT provisioning is the industry default, and it is the wrong default for UBoss because it
contradicts a locked rule: no public company signup. With JIT, anyone the identity provider will
authenticate becomes a UBoss user — which turns the IdP's directory into a signup form, operated by
whoever administers it. Access comes from an invitation, or from SCIM pushing it explicitly and
auditably.

**How an external identity is matched.** The `sub` claim is the provider's stable identifier, but
it cannot be the join key on a _first_ sign-in, because nothing in UBoss has seen it before. So
matching is by email, and only when both hold:

1. the email's domain is one this company has **verified** it controls, and
2. a membership already exists and is `Active`.

The domain check is what stops a compromised or careless identity provider asserting
`someone@another-company.com` and being believed. Every failure returns one identical message: an
unauthenticated endpoint must not explain whether the address was unknown, the domain unverified
or the membership missing.

**SCIM is the sanctioned provisioning path**, and it carries the same domain requirement — see
ADR-036.

---

## ADR-035 — SAML ships as an abstraction with no implementation

**Decision.** `SsoProtocol.Saml`, the connection columns (`entity_id`, `sso_url`, `slo_url`,
`signing_certificate`, attribute mapping) and service-provider metadata generation all exist. Every
method that would _consume_ an assertion throws `NotImplementedException`, and a SAML connection
**cannot be enabled**.

**Why.** SAML's security rests entirely on XML Digital Signature verification, and XML DSig is one
of the few places in applied cryptography where a plausible-looking implementation is reliably
exploitable:

- **XML Signature Wrapping** — the signature is valid, over a fragment that is not the assertion
  the parser actually consumed. An implementation that verifies "a" signature and then reads "the"
  assertion is bypassed by an attacker who supplies both.
- **Canonicalisation mismatches** — exclusive vs inclusive C14N, comment handling, namespace
  inheritance. The `NameID` comment-truncation bug that hit several SAML libraries simultaneously
  in 2018 was exactly this.
- **Entity expansion and XXE** — a SAML response is attacker-supplied XML posted to an
  unauthenticated endpoint, so this is live _before_ any signature is checked.

Writing that alongside everything else in this step, without the review time it needs, would
produce the worst available outcome: an authentication path that appears to federate and can be
forged. A working OIDC path plus an honest refusal is strictly better than two paths where one is
quietly broken.

**Why the metadata generator is implemented anyway.** It is inert descriptive XML with no security
decision in it, and it lets a company complete its side of the configuration. It advertises no
signing or encryption certificate of our own, because we have none — an administrator reading it
can see the integration is incomplete.

**What implementing it will require**, so the cost is not underestimated: a hardened parser with
DTD and external entities disabled; signature verification that resolves the signed reference and
confirms it is the same element as the assertion being read; exclusive canonicalisation;
`Conditions`/`NotBefore`/`NotOnOrAfter`, `AudienceRestriction`, `InResponseTo`, `Destination` and
`Recipient` all checked; assertion-id replay tracking; and certificate rotation. Each is a test
case, not a line of code.

---

## ADR-036 — SCIM provisioning requires a verified domain, and deprovisioning suspends rather than deletes

**Decision.** A SCIM request may only provision an address whose domain the calling company has
**verified**. `active: false` and `DELETE /Users/:id` move the membership to `Suspended` and
`Offboarded` respectively and revoke every session; neither deletes a row.

**Why the domain requirement.** SCIM provisions a person into a company _without that person doing
anything_ — no invitation link, no activation click. That is how enterprise provisioning is meant
to work, and it is also a way to add someone to a company they have nothing to do with. Control of
the domain is the proof that makes non-consensual provisioning legitimate: it is the difference
between "this company is this person's employer" and "this company typed in an address".

Two consequences, both deliberate: a company must verify a domain before SCIM does anything
(`/ServiceProviderConfig` stays reachable so a connector can still be configured), and contractors
on other domains are invited instead, which is the flow that asks for their consent.

**Why suspend rather than delete.** An identity provider that briefly loses sight of a person — a
sync error, a filter change, a scoping mistake — would otherwise destroy the record of their
employment, and nothing would bring it back. The membership row and its audit history survive.

**Why sessions are revoked immediately, in the same operation.** Deprovisioning that leaves a live
session means a departed employee keeps working until their session happens to expire, which is up
to twelve hours after their employer said to remove them. That is the failure the whole feature
exists to prevent, and there is a test that signs in, deprovisions, and asserts the next request
is 401.

**Scope of the implementation.** A standards-compliant subset: discovery, Users, Groups, the
list/error envelopes, and equality filters. Unsupported features are declared `false` in
`/ServiceProviderConfig` rather than omitted, and an unsupported `PATCH` path is **refused** rather
than ignored — silently ignoring a deprovisioning PATCH would leave a departed employee with access
while the connector reported success. An unsupported filter is likewise refused: answering it as
"no filter" would return every user, and a connector would read that as "this address does not
exist" and create a duplicate.

---

## ADR-037 — a repository that takes a `TenantScope` declares that scope

**Decision.** Every scope-taking method on `EnterpriseIdentityRepository` and
`ProvisioningRepository` wraps its own body in `prisma.runInTenantTransaction(scope, …)`. Methods
named `*ForPlatform` do not, and are the documented cross-tenant cases.

**Why this changed.** ADR-018's convention was that a repository merges `tenant_id` into the query
and the _caller_ declares the RLS scope. That is one more thing to remember, and on the first run of
the Prompt 6 integration suite it had been forgotten — every write to `tenant_auth_policies`,
`sso_connections` and the rest failed with `new row violates row-level security policy`.

That failure is the system working: RLS fails closed, so the omission was loud and immediate rather
than a silent cross-tenant leak. But it demonstrated that "the caller must remember" is a weak
invariant, so on these repositories the signature now _implies_ the guarantee: taking a
`TenantScope` means the scope is declared.

**Why nesting is safe.** `runInTenantTransaction` joins an existing transaction with the same
tenant, refuses a _different_ tenant, and passes through unchanged inside a declared platform
operation. So a service that already opened a scope is unaffected, and a platform-plane caller
still works.

**What is not changed.** The Prompt 3/4 repositories (`TenantMembershipRepository`,
`AuditEventRepository` and the rest) keep the caller-declares convention, because their callers
already declare it correctly and 130 passing tests depend on that behaviour. The inconsistency is
real and is recorded here rather than hidden: new repositories are self-scoping, and migrating the
older ones is a follow-up worth doing when something else touches them. `ScimService` therefore
declares the scope explicitly around its `TenantMembershipRepository` calls.

**One consequence worth knowing.** `SecurityEventPublisher` runs as a platform operation, and
`PrismaService` refuses to escalate a tenant scope to one — deliberately, so a tenant-scoped
request cannot quietly disable the backstop. Audit events are therefore written _outside_ the
tenant transaction, which is why the services here read as "scoped work, then record".

---

## ADR-038 — the six built-in roles are code, not rows

**Decision.** `ROLE_TEMPLATES` in `@uboss/types` defines Employee, Manager, Head, Company Admin,
Approver and Auditor as immutable permission matrices. Only **Custom** roles are database rows.

**Why.** A built-in role's meaning has to be the same in every company. Six rows per tenant would
diverge — somebody edits one, a migration touches another — and "Manager" would stop being a thing
you can reason about across the platform. A support conversation that begins "what can a Manager
do?" needs one answer.

**Cost, accepted.** Changing a built-in role is a deploy, not a configuration change. That is the
right way round: it changes what the product _means_, and it should go through review. Companies
that need something different get a Custom role, which is exactly what the row-backed path is for.

**Consequence for the UI.** `GET .../authorization/role-catalogue` serves the templates read-only,
so a permissions screen can render them without a per-tenant seed and without a "reset to
defaults" button that would have no defined behaviour.

**Two template decisions that will look like omissions and are not:**

- **Manager has no `Approve`.** The client's locked Approve & Assign boundary is that handing work
  to a person and approving the plan are separate decisions. A manager who should also approve is
  _additionally_ assigned the Approver role, which makes the second decision visible in an
  assignment record instead of implied by a job title.
- **Company Admin has no `Approve` either.** Administering a company is not being an approver in
  its workflow. Blanket approval rights for an administrator is precisely how "the admin approved
  their own change" happens.

---

## ADR-039 — the precedence engine is a pure function

**Decision.** `evaluatePrecedence` in `@uboss/types` takes a fully resolved input and returns a
decision. No database, no request context, no clock. Everything stateful — assembling the
permission union, reading policy rules, resolving a resource — lives in `AuthorizationService`.

**Why.** This is the one place in the system where a subtle mistake is a privilege-escalation bug.
A pure function can be tested _exhaustively_ rather than sampled: `authorization-engine.spec.ts`
runs 63 cases including every escalation negative, with no database and no fixture, in
milliseconds. The same coverage against a service would need a fixture per case and would still
only prove the fixtures.

It also means the **matrix and the enforcement cannot disagree**. `permittedActions` and
`matrixFor` are the same function called per action, so a permissions screen renders exactly what
the server will allow. There is no second implementation to drift.

**The rule it implements, and the reading it required.** The client's rule is _lower levels may be
stricter, never weaker than a mandatory higher-level control_. Taken literally, "never weaker"
would forbid any lower layer from relaxing anything — which would make a company unable to grant
an exception to its own advisory default, and would make the word "mandatory" redundant. So:

- **any** restriction tightens (effects intersect down the chain);
- a restriction marked **mandatory** is sealed — no lower layer can lift it, and an attempt is
  recorded in the trace as a refused override rather than silently ignored;
- a restriction **not** marked mandatory is a default that a lower layer may explicitly `Allow`
  past.

A mandatory `Allow` is refused by the service _and_ by a database check constraint, because a
grant that lower layers cannot tighten is the one thing the rule forbids.

**Scope only ever narrows.** A layer asking for a _wider_ scope is ignored, and the ignoring is
traced. `SCOPE_BREADTH` makes that a comparison against an ordering rather than a rule per pair.

---

## ADR-040 — authorization is checked in two phases, because HTTP forces it

**Decision.** `@RequirePermission(module, action)` on the route (phase 1, in `PermissionGuard`),
and `assertCanOnResource({ module, action, resource })` in the handler (phase 2). Scope and
separation of duties live only in phase 2.

**Why it is not a choice.** A guard runs before the handler and therefore before the row is
loaded. The alternative — treating a route parameter as the resource id and checking that — would
authorize _the id in the URL_ rather than the row that actually gets fetched, which is worse than
not checking at all because it looks like a check.

**What phase 1 is still worth.** It stops the handler running on the common denial ("your role
does not include Approve"), and it makes the requirement declarative and greppable. A route with
only phase 1 is protected against the wrong _role_; it is not protected against the wrong _row_,
and `assertCanOnResource` is a one-liner so that omission is visible rather than implicit.

**`PermissionGuard` is registered globally**, and that is safe: it returns `true` when a route
carries no authorization metadata, so it cannot break an existing route — and it cannot open one,
because `TenantGuard` still denies anything with no tenancy policy. Global registration means the
decorator is the whole declaration; a permission decorator that silently did nothing because
someone forgot `@UseGuards` would be the worst available failure.

**One implementation detail that bit during development**, recorded because it will bite again:
the guard reads the actor from **`request.ubossActor`**, not from `getActor()`. Nest runs guards,
interceptors and the handler on separate call stacks, so the `AsyncLocalStorage` scope that
`RequestActorInterceptor` opens does not reach a guard. `getActor()` inside a guard returns
anonymous and refuses everybody.

---

## ADR-041 — three privilege-escalation gates on granting, and one of them is doubled

**Decision.** `RoleAdministrationService` enforces three rules that the API could otherwise be
talked out of:

1. **An assignment cannot exceed its role's `maxScope`.** Refused with a message naming the
   ceiling, _and_ capped again by the engine at read time (`scopeGrantFor`). Both on purpose:
   refusing tells the caller they were wrong, and capping means being wrong is not exploitable —
   a row written by a migration or a console still cannot over-grant.
2. **A custom role cannot grant what its creator does not have.** Without this, "can create
   custom roles" is equivalent to "can do anything": an administrator lacking `Approve` could mint
   a role carrying it and assign it to a colleague, or to a second account they control. Checked
   against the creator's own _effective_ matrix, so it respects every policy layer restricting
   them too.
3. **Nobody can grant themselves a role.** Refused outright rather than audited-and-allowed. It is
   the shortest path from "can manage access" to "can do anything", and an audit trail of an
   escalation that succeeded is a worse outcome than a refusal.

**Why the doubling in (1) rather than picking one.** They answer different questions. The API
refusal is a usability property — a caller with a wrong mental model gets told. The engine cap is
a security property — the system does not depend on every write path having been careful.

**Two database check constraints back the service up**: an assignment or TCSiON mapping naming
`Custom` must name a custom role and vice versa, and a policy rule must have a subject appropriate
to its layer. Both are rules Prisma cannot express, so the service enforces them — and the
constraints make sure the service is not the _only_ thing that does.

---

## ADR-042 — separation of duties is a separate check, and it has no bypass

**Decision.** `checkSeparationOfDuties` runs after the permission decision, against a specific
resource, and is configured per company on top of a mandatory platform baseline.

**Why not part of the permission.** It is not about authority. The same person with the same role
may approve one thing and not another, purely because they wrote the second one. Folding it into a
permission matrix would make it invisible in every permissions screen and impossible to explain to
the person it refuses.

**Keyed on the creator, not the owner.** Work is reassigned routinely; the person who _wrote_ a
thing is the one who must not wave it through. Keying on the owner would let a reassignment
launder a self-approval.

**The Executor Agent, and why there is no override parameter.** The locked rule is that the
Executor Agent must never silently bypass or replace a required Human approval. This function is
where that becomes enforceable: an automated actor calls exactly the same check, is refused for
exactly that reason, and has to escalate. There is deliberately no `force`, `systemActor` or
`override` argument — an agent cannot satisfy a four-eyes control, because two agents are not four
eyes.

A blocked self-approval is recorded as **suspicious activity**, whether or not it was a mistake:
an attempted self-approval is exactly the pattern an audit wants to find.

**The platform baseline is seeded by the migration**, mandatory, and applies `NoSelfApproval` to
`Approve` in every company. Seeded as data rather than left to configuration because the default
has to be the safe one — a company that never opens the settings screen should still not be able
to self-approve. `Publish` and `ManageAccess` are deliberately left to the company: publishing your
own draft is normal in a small team, and a one-person company must be able to grant itself access.

---

## ADR-043 — the TCSiON mapping is an extension point that ships empty

**Decision.** `TcsionMapping` and `TcsionMappingService` are the shape the client's approved
external reference maps into. There are **no** seeded mappings, no defaults and no example rows,
and an unmapped external type resolves to `null`.

**Why it ships empty.** The client has stated that TCSiON user types and allotments are an external
dependency, and the approved reference has not been supplied. Inventing a plausible-looking
vocabulary would be the single most damaging thing this prompt could do: it would look like a
working integration, and every downstream decision would be built on values nobody approved.

**How the two sides differ, deliberately:**

- The **external** side (`externalUserType`, `externalAllotment`) is free text holding the client's
  vocabulary verbatim. Constraining it to an enum would mean guessing.
- The **UBoss** side is validated strictly against `@uboss/types` — a mapping cannot name a module,
  action, role or scope UBoss does not have, and a transcription error is refused _at load time_
  with a message naming the wrong value, rather than surfacing at somebody's first sign-in.

**`approvedReference` is mandatory.** Every row records which client document and version it came
from, because the entire point of the table is that its contents are traceable to an approved
reference rather than to someone's assumption. A blank one is refused.

**The action list is a ceiling, never a grant.** `applyCeiling` intersects the mapping's
`allowedActions` with what the mapped role grants. A mapping cannot award an action the role lacks
— otherwise the mapping table would be a second, invisible role system and "what can this person
do" would have two answers.

**An unmapped type fails closed and says so.** `resolve` returns `null`, records a
`tcsion_mapping_missing` security event carrying the external type (configuration, not a
credential — and the one thing an administrator needs to fix it), and the endpoint answers with a
message naming the missing mapping. It does **not** default to Employee: a silent default is how an
external user ends up with permissions nobody chose.

---

## ADR-044 — `TeamSubtree` scope fails closed until the hierarchy exists

**Decision.** `HierarchyResolver` is an interface with no implementation and no registered
provider. `TeamSubtree` scope returns a distinct `scope-unevaluable` denial until Prompt 12
registers one.

**Why a distinct reason rather than reusing `out-of-scope`.** "We cannot tell" and "no" need
different messages and different follow-up. A person told they are out of scope will ask their
administrator to widen it; a person told the hierarchy is unavailable knows to wait.

**Why not a default.** Defaulting to _allow_ would silently make every Manager's scope the whole
company — the exact escalation this engine exists to prevent, introduced by a convenience.
Defaulting to `OwnWork` would look like it worked while quietly withholding a manager's access,
which is the kind of bug that gets diagnosed as a data problem for a week.

**What this costs today.** `Manager`'s default scope is `TeamSubtree`, so a Manager assignment
grants nothing at the row level until Prompt 12. That is visible, tested, and recorded in
`docs/IMPLEMENTATION_STATE.md` as a limitation rather than left to be discovered. `Department` and
`MultipleDepartments` work now, because a department is an opaque id on the assignment and on the
resource — no tree needed — so a company that needs departmental scope today has it.

---

## ADR-045 — Two trails, reversing the Prompt 5 single-trail decision

**Decision.** `security_events` is a separate table from `audit_events`. `SecurityEventPublisher`
keeps its interface and writes to the new one.

**What is being reversed, and why that matters.** Prompt 5 wrote security events into
`audit_events` and recorded, in a class comment, that a separate table "was considered and
rejected" because one trail means one thing to query when investigating an incident. That is
recorded here rather than quietly deleted: a reversed decision with no stated reason is worse than
the original mistake, because the next person re-derives the same argument from scratch.

**Why the original reasoning was insufficient:**

1. **They want different columns.** A security event has a category, a severity, an outcome, a
   device, and a _subject_ distinct from the actor. Pushed into `metadata` JSON, an alert rule
   cannot index on severity and "every blocked sign-in this week" becomes a JSON scan. Those
   columns are meaningless on an audit event, so one table means half the columns are always null.
2. **They want different retention.** Sign-in noise is high-volume and useful for months. "Who
   published which Objective" is low-volume and useful for years. One table forces one policy, and
   it will be wrong for half the rows — and since the trails are now append-only, getting
   retention wrong is not something a later `DELETE` fixes.
3. **They have different audiences.** A Company Admin reading their own audit trail is routine.
   Cross-tenant security events — a failed sign-in before any workspace was chosen — belong to the
   platform security plane and must not appear in a tenant's trail at all. With one nullable
   `tenant_id` that separation was a query discipline; with two tables it is a schema fact and a
   separate controller.

**What the reversal costs, and how it is paid.** An investigator reads two trails. That is real,
and it is accepted. Both trails carry the same `correlation_id`, so one identifier joins them, and
`AuditQueryService` exposes both behind the same permission.

**Why the façade survived.** 106 call sites across Prompts 5–7 call
`securityEvents.record({ action, ... })` and every one of them still does. Rewriting them to pass
a category and a severity would have put an editorial judgement — "is a failed sign-in a warning?"
— at each call site, where it would drift. Classification lives in one `CLASSIFICATION` table
keyed by the same union as `SECURITY_ACTIONS`, so **adding an action without classifying it is a
type error**.

---

## ADR-046 — Tamper evidence: the exact guarantee, and its limits

**Decision.** Both trails are append-only in the database and hash-chained per chain key. The
guarantee is stated below in full, including what it does not cover, and the same wording is
returned by the verify endpoint at runtime.

### The four controls

| Control                                                          | What it does                   | What binds it            |
| ---------------------------------------------------------------- | ------------------------------ | ------------------------ |
| `REVOKE UPDATE, DELETE` on both trails and the checkpoints       | **Prevents** alteration        | The `uboss_app` role     |
| `BEFORE UPDATE OR DELETE` trigger raising `restrict_violation`   | **Prevents** alteration        | Every role, owner too    |
| `BEFORE TRUNCATE` statement trigger                              | **Prevents** wholesale erasure | Every role, owner too    |
| Per-chain SHA-256 hash chain with `UNIQUE (chain_key, sequence)` | **Detects** alteration         | Nothing — it is evidence |

### Guaranteed

- The application role **cannot** `UPDATE` or `DELETE` a trail row. Not "does not" — cannot. A
  compromised application, an injection, a rogue endpoint or a migration mistakenly run through
  the app's connection all fail with `permission denied`.
- The **owner** role cannot either. The trigger fires regardless of privilege, so a mistaken
  `UPDATE audit_events SET ...` in a future migration fails loudly instead of succeeding quietly.
- `TRUNCATE` is refused on both trails and on the checkpoint table. Row-level triggers do not see
  `TRUNCATE`, so it needs its own statement-level trigger — without one, the strongest-looking
  setup would still permit erasing everything.
- Any modification, deletion or reordering of a **chained** row is **detectable** by recomputing
  the chain. The hash covers every meaningful column, the chain key, the position and the
  predecessor hash, so a row cannot be edited, moved, or transplanted between chains without a
  break. `audit-chain.spec.ts` asserts one mutation case per hashed field and asserts the case
  count equals the field count, so adding a column without covering it fails a test.

### Not guaranteed

- **A database superuser can defeat all of it.** `ALTER TABLE ... DISABLE TRIGGER`, rewrite the
  rows, recompute every hash, re-enable the trigger — and verification reports the chain intact.
  Hash chaining cannot prevent this, because whoever holds the data also holds the ability to
  re-derive the hashes. The e2e suite performs exactly this attack, both with and without
  recomputing, so the boundary is tested rather than asserted.
- **Detecting a wholesale rewrite requires an anchor outside the database.** That is what
  `audit_chain_checkpoints.external_anchor_ref` is the seam for. **No external sink is implemented
  at Prompt 8.** So today's honest claim is: _detectable by anyone holding a previously exported
  checkpoint; with no exported checkpoint, a full rewrite with recomputed hashes is undetectable._
- **Rows written before Prompt 8 are not covered.** The chain columns are nullable and old rows
  are deliberately **not** retro-chained: hashing them now would produce a chain that verifies and
  proves nothing, because their integrity was never protected. Verification reports
  `unchainedCount` instead, and the internal page prints it. A green tick covering three rows out
  of five without saying so is a false assurance.

**The guarantee is returned, not just documented.** `verify` includes a `guarantee` string, and its
wording _changes_ depending on whether an anchored checkpoint exists — because a caller looking at
`intact: true` has no other way to know which of the two situations they are in.

**Sealing a broken chain is refused.** A checkpoint over a broken chain would make the tampered
state the verified baseline, so every later verification would report the tampering as intact.
That is strictly worse than having no checkpoint at all.

### Design notes

**Why per-chain rather than one global chain.** One global chain would serialise every write in
the system behind one lock — two unrelated companies signing in at the same moment would contend.
Keying by tenant keeps contention inside one company and gives each company an export that
verifies on its own without revealing anything about another. The cost is that chains do not order
events relative to each other; `occurred_at` does that for reading, and integrity is a per-chain
property.

**Why `pg_advisory_xact_lock` as well as the unique index.** The index is the guarantee: two rows
cannot occupy one position, so the chain can never be ambiguous. But without a lock, two concurrent
appends both read the same head and one fails — a user-visible error for an entirely internal
race. The lock makes them queue. It is transaction-scoped, so there is no release path to get
wrong, and keyed per chain, so two companies never wait on each other.

**Why the hash input is JSON rather than a delimited string.** Joining fields with a separator is
ambiguous when the separator appears inside a value: `['a|b', 'c']` and `['a', 'b|c']` join to the
same string, so two different rows would hash identically. JSON encoding removes the whole class
of problem, the array's fixed length pins the field order, and metadata is stringified with sorted
keys so the hash is a function of content rather than of insertion order.

**Why the format version is inside the hash.** If the canonical form ever changes, rows written
under the old form must still verify under the rules that were in force when they were written.
The version travels with the data instead of living in the code as an assumption.

**One narrow, deliberately ugly escape hatch.** The `TRUNCATE` trigger yields if the session
variable `uboss.allow_history_truncate` is set, which the integration harness sets with `SET
LOCAL` for the duration of its reset. Nothing in `src/` sets it, and `audit.e2e.spec.ts` asserts
its absence from the six audit source files rather than trusting that.

---

## ADR-047 — An audit read requires whole-company scope, and there is no `audit` module

**Decision.** The company-side audit trail is reached as `{ module: 'settings', action: 'Audit' }`,
with `Export` additionally required to export. A grant at any scope narrower than `WholeCompany` is
**refused**, not narrowed.

**Why no fifteenth module.** The reference UI puts "Audit & Activity" inside Settings, as a
_section_ rather than a top-level module, and the 14 company modules are the client's approved set.
Adding one would be inventing vocabulary the client did not supply. The `Audit` action already
exists precisely so that reading a trail is separately grantable from administering the thing it
describes: `settings: ['View']` does not imply `settings: ['Audit']`.

**Why a narrower scope is refused rather than honoured.** `audit_events` has no `department_id`,
and cannot usefully have one — an event about a user account or a company setting belongs to no
department. So a `Department`-scoped `Audit` grant cannot be narrowed:

- Returning everything would silently turn a department grant into a company-wide one. That is a
  privilege escalation introduced by a convenience.
- Returning nothing would make a granted permission look like a bug, and get diagnosed as a data
  problem for a week.
- Refusing, with a message that says why, is the only option that neither lies nor escalates.

Same fail-closed reasoning as ADR-044's `scope-unevaluable`, applied to a different limit. The
built-in templates match, so the refusal is unreachable through them: `Auditor` and `CompanyAdmin`
hold `Audit` at `WholeCompany`, and `Head` deliberately does not hold it at all. The refusal exists
for custom roles, which can be given `Audit` at any scope.

**Why `Audit` **and** `Export` to export, not either.** `Export` alone is held by roles that export
reports and performance data and have no business reading the audit trail. `Audit` alone is read
access. Exporting the trail is the intersection, so neither permission accidentally confers it.

**Why exports are audited and ordinary reads are not.** "Who read the audit log" is a question
auditors ask, and a trail recording every change to a company but not who read it has a blind spot
exactly where a curious insider operates. But auditing every _page_ of a screen that scrolls the
trail would drown the thing it is reading. Export is the line, because export is where data leaves
the system — which is also why it is a `POST` despite reading nothing.

---

## ADR-048 — Break-glass: six endpoints, and why not one

**Decision.** Break-glass is a seven-state machine across six separate platform-only endpoints:
request, verify identity, approve, activate, revoke, notify. Every step writes to both trails, and
the audit row carries the **customer's** tenant id.

**Why not one "create an approved grant" call.** Because that is precisely the endpoint somebody
under incident pressure would ask for, and it would make the whole control a formality. Each step
is performed by a different person at a different time; separating them is what makes the record of
each step meaningful rather than a single row asserting that a process was followed.

**Each constraint, and the failure it prevents:**

| Constraint                                        | Prevents                                                       |
| ------------------------------------------------- | -------------------------------------------------------------- |
| Reason ≥ 20 characters                            | A record that satisfies `NOT NULL` and answers nothing         |
| Identity verification as its own state and actor  | Social engineering — being the support engineer over the phone |
| Approver ≠ requester (service **and** constraint) | Self-approved emergency access                                 |
| Verifier ≠ requester                              | Verifying one's own identity, which establishes nothing        |
| Named modules and actions, empty list refused     | "Whatever I need", which cannot be reviewed                    |
| `Administer` and `ManageAccess` refused outright  | Using a time-limited grant to create a permanent one           |
| Platform modules refused                          | Granting platform authority via the customer-access path       |
| Expiry ≤ 8 hours, evaluated on **read**           | A permanent back door with an incident number attached         |
| `usage_count`                                     | Makes "granted but never used" a provable outcome              |
| Notification `Pending` as a visible debt          | An obligation quietly dropped                                  |
| Suppression requires a written reason             | Withholding notification with nobody accountable               |

**Expiry is enforced on read, not by a sweep.** `activeGrantFor` re-evaluates the window every time
it is consulted. A sweep that runs every minute leaves a minute of access nobody authorised; the
sweep exists to tidy state for reporting, and nothing depends on it having run.

**The audit row goes to the customer's trail.** The tenant id is on the audit event, so the company
can see that somebody broke glass into it. Recording it only platform-side would make the
transparency obligation depend on the platform choosing to honour it.

**A refusal is recorded outside the transaction that refuses it.** This was a real bug, caught by a
test: the blocked self-approval was recorded inside the transaction the `ForbiddenException` then
aborted, so the record of the attempt rolled back with the attempt. A control that blocks something
and leaves no trace of having blocked it is half a control — the blocked attempt is often the more
interesting of the two events. `refuse` now runs in its own transaction, after the first has ended.

**No foreign keys on the user columns.** `requester_user_id`, `approver_user_id` and the rest are
plain UUIDs. A cascade from `users` would delete the record of who accessed a customer's data when
that person's account was removed — which is the moment the record matters most.

**What is deliberately unfinished.** An active grant is **not** wired into the authorization
engine: nothing consults `activeGrantFor` to widen a permission decision yet. Connecting an
access-widening path into the engine deserves its own prompt with its own negative tests, and a
half-wired one would be the worst of both. What exists is the record, the state machine, and the
query the engine will call. Recorded in `docs/IMPLEMENTATION_STATE.md` as a limitation.

---

## ADR-049 — Platform roles, and why `platformContext` had to start failing closed

**Decision.** `isPlatformActor` stops being the whole answer. Six platform roles live in
`packages/types/src/platform-roles.ts` as code, a `platform_role_assignments` table records who
holds which, and `platformContext` builds its permissions from those assignments instead of
granting every platform actor the whole of `PLATFORM_PERMISSIONS`.

**The gap.** Prompt 7 gave `platformContext` a documented interim shortcut: any platform actor
received all fifteen platform modules with `Administer` on nearly all of them. That was reasonable
when no Master Console existed. It stops being reasonable the moment one does, because it makes
`@RequirePermission({ module: 'plans', action: 'Administer' })` on a Master Console route
**decorative** — it cannot refuse anybody who got past `@PlatformOnly`. The client asked for
platform-role guards; this is what makes them real rather than nominal.

**Why six roles, and why that is not inventing client vocabulary.** Every role is a **strict
subset of `PLATFORM_PERMISSIONS`**, which is itself built from the client's approved fifteen
platform modules and fourteen actions. No role introduces a module, an action or a capability that
did not exist — the decomposition only subtracts, and `sanitisePlatformRole` throws at module load
if a future edit tries to widen one, so the property is a startup failure rather than a shipped
privilege.

`PlatformAdmin` is the role the client's own prototype names ("Dibyanshu (Platform) · Platform
Admin"), and it is **derived from the ceiling by subtraction** rather than listed by hand. That
detail is load-bearing: the migration backfills every existing platform actor to this role, so it
must be exactly the old blanket grant minus the controls being separated out. Listing it by hand
dropped `Comment` on the dashboard, which a unit test caught — subtracting makes the relationship
structural and the backfill provably not a downgrade.

The other four follow the client's own navigation grouping (Platform / Commercial / AI Platform /
Operate) rather than a structure invented here:

| Role                 | Administers                                                                      | Notably cannot                      |
| -------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| `PlatformOwner`      | everything                                                                       | —                                   |
| `PlatformAdmin`      | companies, plans, billing, credits, providers, skills, testing, dev-ops, support | releases, global settings, security |
| `PlatformCommercial` | plans, billing, credits                                                          | provisioning, security              |
| `PlatformSupport`    | support                                                                          | anything commercial or security     |
| `PlatformSecurity`   | security                                                                         | everything else                     |
| `PlatformEngineer`   | providers, skills, testing, dev-ops                                              | releases                            |

Every role can **read** every module. A platform operator who cannot see that a module exists
cannot reason about the platform they run; the roles differ in what they may change.

**The central separation.** `release` and `platform-settings` are administered by `PlatformOwner`
**alone**. A feature flag or a global default changes the product for every customer at once, which
is a categorically different decision from administering one company — so the role that can do
nearly everything else deliberately cannot do those two. Granting platform roles sits behind
`platform-settings:Administer` for the same reason: only an Owner can create platform authority,
because putting it behind `companies:Administer` would let every Admin appoint an Owner and make
the distinction decorative.

**The backfill is what makes this safe to ship.** Failing closed without one would lock every
existing platform actor — including the seed's and every test's — out of the console the moment it
deployed. The migration inserts a `PlatformAdmin` assignment for every `is_platform_actor` user,
with `granted_by_user_id` NULL and a justification saying it was backfilled, because attributing
it to a person who did not grant it would be a false record in the one table where a false record
is a privilege. The access-review screen flags those rows so they get narrowed rather than
inherited.

**Recorded as an open question** (S-055): the client named one platform role. A real support
organisation will have opinions about the rest, and this decomposition is a UBoss-side proposal.

**A person may hold several roles**, and the permissions union — holding two roles must never be
more restrictive than holding either alone, or nobody would accept the second. Expiry is evaluated
**on read**, never by a sweep, the same rule as break-glass: a role that expired a minute ago and
still works is authority nobody granted.

---

## ADR-050 — Master Console navigation keys are mapped to module keys, not renamed

**Decision.** `MASTER_NAV_MODULE` maps each `MASTER_NAV` key to a platform module key.
`moduleForMasterNavKey` returns `undefined` for anything unmapped, and callers must hide such an
item.

**Why a map is needed at all.** Two of the fifteen do not match: the navigation says `dashboard`
and `health`, the approved module set says `platform-dashboard` and `system-health`. Filtering
navigation by permission without the map would look up a module named `dashboard`, find nothing,
and **hide the Dashboard and System Health from everybody**.

**Why not rename one side.** The navigation keys come from the client's locked UI prototype; the
module keys come from the client's approved permission list. Neither is wrong, and changing either
to match the other would be editing a client-supplied list to suit our code. Mapping is the
honest form of "these are two vocabularies that describe overlapping things".

**Why unmapped fails closed.** A navigation entry with no module mapping is, by definition,
unguarded — there is no permission to check. Hiding it turns that into a visibly missing item
somebody investigates, rather than a door left open.

---

## ADR-051 — Data provenance is a field on the wire, not a footnote

**Decision.** Every Master Console dashboard panel carries a `provenance` of `measured`,
`configured` or `demo`, the API returns a `provenanceNotes` list covering all six panels, and the
screen renders both.

**The problem.** The client asked for a dashboard fed by "real database/demo data". Those are two
very different claims about a billing figure, and the product genuinely has both: companies,
seats-used and the entire security panel are counted from real data, while AI consumption and
service alerts are seeded because no metering and no health probes exist yet.

A dashboard that presents a seeded AI-spend figure identically to a measured company count teaches
its operator to trust both equally. The first time that matters is an incident, and by then the
habit is formed.

**Three provenances rather than two**, because "real vs fake" is too coarse:

- `measured` — counted from data the product produces. Companies, seats used, the security panel.
- `configured` — a real row somebody set deliberately. Plan prices, seat limits, renewal dates,
  billing state. Not invented at render time, and an operator can change it — but no payment
  provider confirmed it.
- `demo` — seeded and illustrative. AI consumption, service alerts.

**Why it is redundant on purpose.** Each KPI carries its own source _and_ the footer lists all six
panels. A screen that forgets one badge still has to render the table, so the caveat cannot be lost
to a single rendering oversight.

**What this forced us to drop.** The reference's KPI deltas — "+3 this month", "82% utilized" —
are not reproduced where the product cannot compute them. There is no month-over-month history, so
"+3 this month" would be decorative fiction on a screen whose whole purpose is operational truth.
Seat utilisation _is_ computable and is shown. Likewise the reference's health KPIs (uptime, p95,
run success, queue depth) are **named and left empty** on System Health rather than filled with
plausible numbers: a health screen showing "99.98% uptime" that no probe measured is the most
dangerous kind of fake data in an operations console.

---

## ADR-052 — Create Company ships as an entry point with no POST

**Decision.** `/master/create-company` shows the plans, the platform defaults, the locked
constraints and the five step names. There is no form, no submit, and **no provisioning endpoint**
— `create-company/prerequisites` is a `GET` and carries `readiness.wizardImplemented: false`.

**Why the absence is the deliverable.** The instruction was explicit: do not implement the wizard
until the next prompt. The risk is specific rather than theoretical — `TenantProvisioningService`
already exists and works, so a `POST` here would be a handful of lines. And the reference
prototype has exactly that shortcut on this screen: a button labelled "Skip to review & provision"
that fires a toast and navigates away.

Carrying that forward would produce the thing the instruction rules out: a working provisioning
path that skips plan selection, entitlements, budget and security, and that would then be the path
everybody used. Shipping the endpoint "but only for testing" is the same outcome with a comment
attached.

**What the screen does instead** is answer, from real data, the questions the wizard will ask:
which plans exist and which is the default, what region and currency a new company starts on, and
that company creation is Master-Console-only because there is no public company signup. That makes
it useful now and makes the wizard's job smaller later.

**Two reference actions on Company Detail get the same treatment.** "Impersonate (audited)" is
break-glass by another name, and break-glass already exists properly (ADR-048) with identity
verification, a second approver, a bounded scope, an expiry and a customer notification — a
one-click button beside a company would route around all of it, and the point of that design is
that there is no such route. "Suspend tenant" needs a reason, a confirmation and a notification
path. Both are listed on the screen as unbuilt rather than rendered as controls.

---

## ADR-053 — The platform tables have no Row-Level Security, and that is a decision

**Decision.** `tenant_subscriptions` gets RLS like every other tenant-owned table. `plans`,
`feature_flags`, `platform_settings`, `service_alerts` and `platform_role_assignments` get **none**.

**Why.** RLS isolates rows _by tenant_. These five have no `tenant_id`, so there is nothing to
isolate them by. A policy keyed on `app.current_tenant_id` would evaluate false for every row and
make the Master Console unable to read its own tables; one keyed on `app.platform_operation` alone
would say "allow if you declared you are allowed", which is theatre — it would look like a control
in a schema dump and stop nobody.

**What protects them instead**, and this is the part that has to be true for the decision to hold:

1. every Master Console controller is `@PlatformOnly`, so a company-plane request cannot reach the
   routes;
2. the platform-role guards decide which module a platform actor may touch (ADR-049);
3. `platform_role_assignments` carries two check constraints of its own, because a row in it _is_
   somebody's platform authority — no self-granted row, and a revocation must name who revoked it.

**Why `tenant_subscriptions` is different.** A company's plan, seats and billing state are
commercially sensitive, and a leak would tell one customer what another is paying. It is also the
one table here a company will eventually read about itself, so it needs the same isolation as its
audit trail.

Stated in `docs/SECURITY_DECISIONS.md` S-054 so "these tables have no RLS" is a property with a
reason rather than something a reviewer discovers and has to guess about.

---

## ADR-054 — Provisioning is one transaction, and the wizard submits once

**Decision.** The Create Company wizard collects ten steps client-side and posts a single
payload. `CompanyProvisioningService.provision` writes the tenant, its subscription, AI settings,
budget policy, security defaults, the first administrator's identity and membership, the bootstrap
role grant, the setup checklist and the activation invitation in **one** database transaction.

**Why not step-by-step.** A step-per-request API would create the company after step 1. Every
person who closed the tab at step 4 would leave behind a tenant with no plan, no administrator and
no way to finish — and a company with no administrator cannot be recovered through the product at
all, because there is no one to sign in and fix it. The failure mode is not "an untidy row"; it is
an unusable customer record that support has to repair by hand.

**What it costs.** Nothing is saved until the end, so navigating away loses the form. The wizard
warns. Losing a form is recoverable; a broken tenant is not.

**Idempotency, and where it lives.** The final button is exactly the button somebody
double-clicks. The wizard generates one `idempotencyKey` per session — per _session_, not per
submit, which is the point — and the **outbox row's unique constraint on it** is what makes the
retry safe: the second attempt's insert collides, its transaction rolls back, and the first result
is returned. The uniqueness sits on the outbox rather than in a separate idempotency table because
that row is already written in the same transaction, so there is nothing extra to keep in step.

---

## ADR-055 — The transactional outbox, and why no dispatcher ships with it

**Decision.** Provisioning writes the _intent to send_ the activation invitation into
`outbox_messages`, in the same transaction as the work. Delivery is a separate concern.

**Why.** Sending the email inline breaks the transaction in one of two ways: an SMTP round-trip
holding a database transaction open, or a mail that goes out and is then rolled back — leaving a
customer holding an activation link for a company that does not exist. The outbox buys exactly the
property provisioning needs: **no message is ever sent for work that rolled back, and no committed
work is ever left without its message.**

**The payload never carries a token.** An activation row holds the invitation's _id_; a dispatcher
reads the one-time token through the service that owns it. An outbox row is long-lived, widely
readable working state, and a token in one would be a credential at rest in a queue.

**No dispatcher runs at Prompt 10**, because email delivery is the notifications module. Rows
accumulate as `Pending` and the Master Console shows them, with `dispatcher.running: false` on
the API. That is deliberate: an operator who provisioned a company must be able to see that the
invitation is queued and undelivered rather than assume it was sent and wonder why the customer
never activated. `claimDue`/`markDelivered`/`markFailed` exist and are tested, so the dispatcher
will be a consumer of a working queue rather than a queue and a dispatcher written together and
never exercised apart.

**Not self-scoping, unlike every repository since ADR-037.** `enqueue` **must** join the caller's
transaction — a row written in its own would commit even when the work rolled back. Opening a
scope would open a transaction and destroy the guarantee. The readers do scope themselves.

---

## ADR-056 — Bootstrap authority: the one grant with no human grantor

**Decision.** Provisioning grants the initial Company Super Admin `CompanyAdmin` at
`WholeCompany` with `grantedByUserId = null` and `bootstrap = true`.

**Why it has to exist.** The client is explicit: _do not require an already-existing Company Admin
to grant the first Company Admin role_. That requirement is unsatisfiable by the Prompt 7 engine
alone, because every other grant needs a grantor who already holds the authority.

**Four things make it accountable rather than a back door:**

1. **Two check constraints tie the flag to the absence.** A `bootstrap` row must have no granting
   user, _and_ a row with no granting user must be marked bootstrap. Either alone would let the
   two disagree — the first would allow an ordinary grant wearing a bootstrap label, the second
   would let a grant nobody made look ordinary, which is worse.
2. **It is queryable.** "Show me every authority nobody chose" is the first question an access
   review asks, and an audit event cannot answer it in a list. The column can.
3. **It writes a distinct audit action** — `company.bootstrap_admin_granted`, into the **new
   company's own trail**, with a reason saying why there was no grantor — plus a `Critical`
   platform security event.
4. **It can only ever grant that one role.** There is no field in the wizard payload that names a
   role, so provisioning cannot be used to mint arbitrary authority.

The migration's own backfill uses the same mechanism for pre-existing grants with a null grantor,
so the constraint holds on every database rather than only on fresh ones.

---

## ADR-057 — A logo is metadata; a credential is a reference

**Decision.** `tenants` stores a logo's file name, mime type, size and storage key — never its
bytes. `tenant_ai_settings` stores a credential _reference_ and a masked hint — never a key.

**Why they are the same decision.** Both are cases where the obvious column is the wrong one. A
base64 image in `tenants` would be loaded on every tenant read, for a value that is displayed
once per page. A provider key in `tenant_ai_settings` would be a reusable credential sitting in
a normal database field, which the client's locked rules forbid outright.

**The hint is length-capped at 40 characters**, which turns the rule into something the validator
enforces rather than something a reviewer has to notice: a real API key does not fit. The
credential itself is stored through the Prompt 6 secret box by a separate, explicitly-authorised
call, so a wizard payload cannot carry one even by mistake — and `forbidNonWhitelisted` rejects a
request that tries, rather than silently dropping the field.

**A check constraint makes logo metadata all-or-nothing**: a storage key with no mime type is a
file nothing can render.

---

## ADR-058 — The setup checklist is a table, not a derived view

**Decision.** `company_setup_tasks` holds one row per checklist item, created by provisioning
(and by the migration for pre-existing companies). The ten items, their order and their
`rationale` are verbatim from `UBoss_Final_1` §33.

**Why not derive it.** The client's list mixes what the system can detect ("build departments and
reporting hierarchy") with what only a person can assert ("run readiness review and mark workspace
ready for managers"). A derived checklist cannot represent the second kind at all, and one that
silently ticks itself is one nobody trusts — the moment an item goes green without the work being
done, the whole checklist stops being read.

**Skipping is allowed and requires a written reason**, enforced by a check constraint. An item
that cannot be skipped is an item people work around by marking it done, and then the checklist is
worse than useless. `Skipped` counts toward _resolved_ — a company that legitimately has no
external collaborators is not permanently stuck at 90% — while staying visibly skipped, which is a
different claim from done.

**Duplication accepted, drift prevented.** The same list exists in TypeScript (for provisioning)
and in SQL (for the migration's backfill), because a migration cannot import TypeScript. A test
asserts the two agree.

---

## ADR-059 — Five commercial concepts, kept apart by the shape of the type

**Decision.** Commercial Plan, Module Entitlements, Feature/Release Channel, Commercial Allowance
and RBAC are five separate concepts. `CommercialPosition` models the first four as four named
groups and **contains no role, permission or scope field at all**. `CommercialService` injects
`AuthorizationService` for exactly one purpose — asking whether the caller may _see_ this data —
and no method in it consults a plan to decide a permission, or a permission to decide an
entitlement.

**Why the type shape and not a convention.** The bug this prevents is a classic and it is very
easy to introduce: a plan upgrade that quietly widens somebody's authority, or a role change that
quietly grants a module the company never bought. A comment saying "don't do that" survives until
the first person in a hurry. A response object with no permission field in it cannot be misread
as one, and a service with no read path into role assignments cannot derive from them by accident.

**`rbacNote` is a field on the wire.** A reader who expects to find permissions in a commercial
response should learn _why_ they are not there rather than concluding it is an oversight and
adding them. Stated in the response for the same reason as ADR-051's data provenance: the
explanation belongs where the confusion happens.

**Verified rather than asserted.** A test changes a company's plan from Growth to Enterprise and
its contracted seats from 4 to 40, then compares the permission matrix for the same user before
and after byte-for-byte. Another serialises the whole position and asserts nothing role-shaped
appears anywhere in it.

**What this costs.** Two questions that a merged model would answer in one query now take two:
"can this person do X" and "did this company buy X" are both real gates, and a screen usually
needs both. That is the correct cost — they are genuinely different questions with genuinely
different answers, and a company that has bought a module still has people in it who may not use
it.

---

## ADR-060 — The seat ceiling is enforced under an advisory lock, not by a displayed count

**Decision.** `SeatService.claimSeat` takes a **transaction-scoped PostgreSQL advisory lock keyed
on the tenant** (`pg_advisory_xact_lock`), then counts, then decides. It must be called inside the
caller's transaction, so the seat claim and the membership change commit together.

**The failure it prevents.** Two administrators invite the last seat at the same moment. Both read
`used = 24` against a ceiling of 25, both conclude there is room, both write. The company ends up
at 26 seats on a 25-seat contract, and no error was raised anywhere — the first anybody knows is
the invoice. A count that is only _rendered on a screen_ has this bug by construction, and it is
invisible in testing unless the race is written deliberately.

**Why an advisory lock rather than an alternative.**

- **Row locks on the memberships** would need a row to lock, and the whole question is whether a
  _new_ row may exist.
- **A `SERIALIZABLE` transaction** would work and would make every unrelated write in the same
  transaction retryable; the callers are invitation and activation flows that also write audit
  rows, and turning those into retry-on-conflict paths is a much larger change for the same
  guarantee.
- **A counter column with a check constraint** duplicates the count, and a duplicated count is a
  count that can disagree with the thing it counts.

Same mechanism and same reasoning as the audit chain (ADR-046): a read-then-write invariant needs
the read and the write inside one serialised unit. The key is namespaced `seat:<tenantId>` so it
cannot collide with a chain lock — a collision would only mean two unrelated operations
serialising, never an incorrect result, but keeping the namespaces distinct means that never has
to be reasoned about.

**One transaction per claim, per tenant.** Two different companies never wait on each other, and
the lock releases on commit or rollback with no cleanup path to get wrong.

**A company with no plan is refused, not treated as unlimited.** Defaulting to unlimited is how
an unbilled company ends up with two hundred users.

**Verified.** `seats-lifecycle.e2e.spec.ts` runs two concurrent claims for the last seat in
separate transactions and asserts exactly one succeeds, one is refused, and the company's counted
seats never exceed the contracted ceiling.

---

## ADR-061 — Reducing a contracted number holds the old ceiling; it never removes anybody

**Decision.** Neither `SeatService` nor `CompanyLifecycleService` has a delete path. A seat
reduction sets `seat_grace_until` and `seat_grace_ceiling`, which hold the **old, higher** ceiling
in force while the contracted number drops. `SeatPosition` reports both, so a screen can say "the
contract now says 25; 30 are still available until the 14th".

**Why.** The client's rule is explicit: reducing contracted seats must never delete users,
employment history, tasks, Agent history or audit history. Closure is the same rule with more
force — a company moving to `Closed` keeps every row it ever had, and retention or erasure is a
separate, explicitly-authorised operation with its own audit.

**A grace window opens only when the company is actually over the new number.** An unnecessary
window is not merely pointless: a company at 3 people dropping from 40 seats to 10 could add 37
more during the window and be far over its contract the moment it shut. So the "harmless" version
of this is the one that breaks the ceiling guarantee, and one helper — `graceForNewCeiling` —
makes all three paths that change a ceiling behave identically.

**`nothingDeleted: true` is recorded in the audit metadata** on every reduction, closure and
applied change. The claim is then answerable from the trail rather than from a document, which is
what a customer asking "what happened to our data" actually needs.

**Expiry is evaluated on read, not by a job.** A grace window that has passed stops holding the
ceiling the next time the position is computed, with no scheduler involved. That is the opposite
of the lifecycle rule below it, and the difference is which way the error falls: an unapplied
_restriction_ is generous for a while, while an unapplied _expiry of extra capacity_ would leave
a company operating above its contract indefinitely.

---

## ADR-062 — `User` **is** the global person; there is no second `global_person` table

**Decision.** The Global Person Registry the prompt pack asks for is built on the existing `User`
model. `person_identifiers` is the new matching layer and `employment_records` the per-company
employment; there is no `global_person` table.

**Why, given the pack names one.** `User` already has every property a global person needs and has
behaved as one since Prompt 10:

- one row per **human**, on the platform plane, with no `tenant_id`;
- carrying `ubossUniqueId`, the permanent identifier that follows a person across employers;
- already reused across companies — `TenantProvisioningService` looks a person up by email and
  reuses them rather than creating a second identity;
- already separate from the **account**: credentials, sessions and MFA factors are their own
  tables, so a `User` with no `UserCredential` is exactly "a person who cannot sign in".

Adding a parallel table would create **two competing answers to "who is this human"**, and every
later feature — profile search, performance, cross-company history — would have to pick one and
join to the other. The first place they disagreed would be a bug nobody could reason about.

**The naming difference is recorded rather than hidden.** The requirement is a global person
registry with match-or-create, one permanent portable identifier, per-company employment records
and a keyed deterministic match hash. All of it is implemented. The table is called `users`.

**What would change this.** If a person ever needs to exist in UBoss with _no_ possibility of an
account — a data subject in a record with no login path at all — the account fields on `User`
become dead weight and the split earns its cost. Nothing in the client's requirements needs that
today, and the fields are already nullable.

---

## ADR-063 — The Aadhaar number is not stored, encrypted or otherwise

**Decision.** `person_identifiers` stores a **keyed HMAC-SHA-256 blind index** and the **last four
digits**. The number itself is never written to the database in any form.

**Why not encrypt it.** Encryption is for a secret the server must later _reproduce_ — a TOTP seed,
an OIDC client secret (see `SecretBox`). Aadhaar is not one of those:

- **matching** uses the blind index, which is computed from the input at entry time;
- **display** uses the last four digits, which is all the reference UI ever shows
  (`XXXX XXXX 5510`).

So the full value is never needed again. Storing it encrypted would mean holding a national
identity number, for no purpose, behind a key that can be compromised. Not holding it is strictly
stronger, and the pack's "encryption/masking **as required**" is satisfied by it not being
required.

**Why the index is keyed.** A plain SHA-256 of a twelve-digit number is not protection: there are
10^12 candidates and enumerating them is minutes of commodity GPU time, so anybody who read the
column would recover every number in it. The HMAC key lives outside the database, which reduces
the threat from "read the database" to "read the database **and** obtain the process's key
material" — the same reduction `SecretBox.seal` provides.

**Key derivation, and why not the encryption key directly.** The HMAC key is
`HMAC(masterKey, "uboss-blind-index-v1:<purpose>")`. Two consequences worth the extra line: a
blind index cannot be compared against a ciphertext, and an Aadhaar index cannot be used to probe
a work-email index of the same string.

**The cost, stated.** A deterministic index is what makes matching possible and is also its
weakness: an attacker holding both the key and a candidate number can confirm whether that person
is in UBoss. There is no way to have match-on-value without that property, and the alternative —
no matching — fails the client's requirement that one person keeps one UBoss Unique ID.

**Enforced by the database.** `match_hash` must be 64 hex characters, so an Aadhaar number written
into that column is rejected by PostgreSQL. The claim does not depend on code review.

**And the assurance state cannot lie.** `IdentifierAssurance` has two values, `EnteredOnly` and
`NotVerified`. There is no `Verified`, so no row can claim it, which means no API response or
screen can either. Adding verification would require adding an enum value _and_ the flow that
earns it — a deliberate act, not an accident.

---

## ADR-064 — A composite foreign key, not a trigger, for "the referenced row is in the same tenant"

**Decision.** Where a tenant-owned row references another tenant-owned row, the foreign key is on
the **pair** `(tenant_id, target_id)`, backed by a redundant `UNIQUE (tenant_id, id)` on the
target. Prompt 12 uses it three times: a department's parent, an employment record's department,
and an employment record's reporting manager.

**Why.** A single-column foreign key proves the target _exists_; it says nothing about whose it
is. A cross-tenant reporting manager would be a tenant-isolation breach reachable through the org
chart — a company could build a reporting line into another company's person, and every
`TeamSubtree` decision downstream would silently span the boundary.

**Why not a trigger.** A trigger would work and costs more: a function to maintain, a per-row
`plpgsql` call on every write, and an invariant expressed as code rather than as a constraint the
planner and `pg_constraint` both know about. The composite key is declarative, and the redundant
unique index is a genuinely small price — one index on a column pair that is already indexed by
the primary key.

**Why the extra `UNIQUE` is not redundant in the way it looks.** `UNIQUE (tenant_id, id)` adds
nothing to uniqueness, since `id` alone is already unique. It exists solely to give the foreign
key something to reference, which is the documented PostgreSQL idiom for this pattern.

**Where a trigger is still the right tool.** Two cases in the same migration, for the same reason
in both: the invariant is _recursive_ (the reporting tree must have no cycle) or the column is an
**array** (`role_assignments.department_ids`, which PostgreSQL cannot foreign-key element-wise).
A constraint cannot express either.

---

## ADR-065 — Activation readiness is one pure function, checked at both ends

**Decision.** The client's rule — _a new internal employee requires department + manager + role
before activation_ — is a single pure function, `activationReadiness`, checked at **three** call
sites: the Users & Access screen showing why an invitation is not ready, the invitation flow
refusing to send one, and `InvitationService.activate` refusing to complete.

**Why both ends and not just the invitation.** The window between them is real. A role can be
revoked or a department archived after the email goes out, and an invitation link is valid for
hours. Checking only at invitation time would let an account activate into a company where it has
no department, no manager and no permissions — an account that can sign in and reach nothing,
which looks like a working account to the person holding it and to the administrator who sent it.
Checking only at activation would send an email that cannot be used, which is a worse experience
than being told now.

**Why a pure function rather than a service method.** Three callers must give the same answer,
and one of them is in `AuthModule` while the data lives behind `AccessModule` — which depends on
`AuthModule`. A shared function with an explicit input has no dependency direction at all, and it
is testable without a database, which is where the exception below is actually verified.

**The one exception, and why it is structural.** The **first** person in a company has nobody to
report to. `companyHasReportingRoot` is false only then, and the manager requirement is waived
for exactly that case — the same exception Add Employee makes for the same reason, and it stops
applying the moment a root exists.

**Guests are exempt entirely.** A guest has no department, no manager and no employment record by
definition (ADR-066). Applying the gate to them would make guests impossible.

**Every missing prerequisite is returned, not the first.** An administrator fixing setup wants one
pass, and the screen puts the list on the person's row — because "why can I not invite this
person" is the next question either way.

---

## ADR-066 — A guest is a user type with an expiry, not a second permission system

**Decision.** An External Guest is:

- a `TenantMembership` with `userType = ExternalGuest` and a **mandatory** `guestAccessExpiresAt`;
- **no** `EmploymentRecord`, enforced by a trigger from both sides;
- a `RoleAssignment` with `scopeKind = SelectedResource`, the resources named, and its own
  `expiresAt`.

No new table, no new permission path, no guest-specific authorization code.

**Why this needed nothing new.** The client's requirement is "resource-specific, expiry-capable
access", and every piece of that already existed after Prompt 7:

- `ScopeKind.SelectedResource` with `selectedResourceIds` — resource-specific;
- `RoleAssignment.expiresAt`, already filtered out on read — expiry-capable;
- the `ExternalGuest` user-type ceiling, which forbids Approve, Publish, Run, Schedule, Pause,
  ManageAccess, Administer, Audit and Export **whatever role the guest is given**.

A parallel guest-permission system would have been a second answer to "what may this person do",
and the first place the two disagreed would be a security bug nobody could reason about.

**Why the membership carries its own expiry as well as the grants.** `RoleAssignment.expiresAt`
expires one _grant_. `guestAccessExpiresAt` expires the person's **presence in the company**, so
revoking it does not depend on having found every grant they were ever given. Two different
questions, two columns.

**Why the expiry is mandatory in both directions.** A guest must have one, and anybody who is not
a guest must not. An optional expiry is one somebody forgets — a guest account still open two
years after the project finished. An expiry on an internal employee would be a field that looks
like a control and enforces nothing.

**Why guests must stay outside the hierarchy.** A guest with an employment record would appear in
the org chart, count toward a department's headcount, and be selectable as somebody's reporting
manager. None of that is true of a contractor or a client contact, and all of it would be
believed by whoever read the screen.

---

## ADR-067 — Offboarding revokes authority and transfers work; it deletes nothing

**Decision.** Offboarding sets `accountState = Offboarded`, sets `EmploymentRecord.state = Ended`
with a date, moves direct reports to a named successor, cancels any outstanding invitation, and
**revokes** the person's role assignments. Every row is kept.

**Why roles are revoked rather than transferred.** A successor already has their own roles.
Copying a departing person's grants onto them would silently widen the successor's authority —
precisely the escalation the Prompt 7 granting gates exist to prevent — and it would happen
without anybody choosing it. **The successor inherits work, not permissions.**

**Why direct reports must go somewhere.** Ending the employment of somebody with direct reports
would leave those people reporting to an ended manager: they would vanish from the reporting tree
below their old lead, and `TeamSubtree` scope for whoever should now cover them would be wrong.
So a successor is **required** when there are any, and the refusal names the count.

**Why the handover is a registry rather than a list of calls.** Most of what the client asks to
transfer — open work, Engine Agent ownership, connections — **does not exist yet**.
`HANDOVER_DOMAINS` declares every domain with its status and, for the unbuilt ones, the prompt
that owns it. Each offboarding record carries the outcome per domain, so the difference between
_moved nothing because there was nothing_ and _moved nothing because we forgot_ is written down
on the record rather than inferred from silence.

**Why a table and not just an audit event.** Setting `accountState` answers "can they sign in".
It does not answer the question that matters six months later: **who took over their work**. A
transfer with no record of where things went is indistinguishable from things being lost.

**What is never touched.** The person's `ubossUniqueId`. It is theirs, not the company's, and it
follows them to their next employer — which is the whole point of a portable professional
identity.

---

## ADR-068 — A bulk operation validates first, applies row by row, and has no write path of its own

**Decision.** Every bulk kind is two calls. `validate` parses, checks every row, persists each
with its outcome and **all** of its errors, and applies **nothing**. `apply` then acts row by
row, each row going through **the same service a single-record change uses**.

**Why validate-then-apply.** The client asks for "preview/validation and per-row errors". An
import that applied as it parsed would leave a company half-changed by row 214's typo, with
nothing to look at afterwards. Persisting the preview rather than holding it in memory means a
400-row import survives a page reload and the per-row errors are still there tomorrow when
somebody asks why three people were not imported.

**Why not one transaction.** A 400-row import rejected because row 214 has a duplicate Employee
ID is worse for the customer than 399 applied and one named. Each row _is_ atomic in itself; the
operation is deliberately not. `Applied` and `Failed` rows sit side by side and the counts say
which is which.

**Why there is no bulk-only write path.** This is the escalation control, and it is structural
rather than a check: a bulk row calls `EmploymentService.addEmployee`,
`InvitationAccessService.inviteExistingPerson`, `UserAccessService.suspend` — the same methods a
single change calls, as the same actor. So every gate that applies to one person applies to four
hundred, including the seat claim under its advisory lock, the composite foreign keys that refuse
a cross-tenant reference, and the Prompt 7 granting gates.

A bulk operation is the most attractive route to privilege escalation in any admin console: one
file, hundreds of rows, and nobody reads row 214. **Bulk role and scope changes are therefore
validated and refused at apply time**, with the reason, rather than routed around
`RoleAdministrationService`'s three gates — the alternative would be the one place in the product
where authority is handed out unchecked.

**Why only the validator may apply.** Not a permission question — both people may hold it. A
_responsibility_ question: the rows were checked against the requester's authority, so applying
them as somebody else would apply a plan nobody reviewed.

**Why the parser is written rather than imported.** The format is a header row and quoted fields —
genuinely that small — and a spreadsheet library is a file-format attack surface accepting
untrusted uploads. It handles the three things real exports do: quoted commas, doubled quotes, and
CRLF. Header names are matched through an **alias table** with punctuation and case stripped, so
`Employee ID`, `employee_id` and `EmployeeID` are one column — a camel-case transform alone
produces `employeeID` and silently reports a present column as missing.

---

## ADR-069 — The settings catalogue is code; the values are data

**Decision.** Every setting is a literal in `SETTING_DEFINITIONS` — its category, type, safe
default, and both the permission to read it and the permission to write it. Per-company values
are rows in `company_settings`. A key that is not in the catalogue cannot be written.

**Why not a settings table with a free-text key.** That table can hold anything, and three
specific failures follow:

- two screens disagree about a default, because each carries its own;
- a typo creates a setting that silently does nothing, and looks like it worked;
- nothing states which permission governs which value, so the check is per-handler — and
  eventually one handler forgets, which is a permission bug nobody can see by reading a route.

The catalogue fixes all three by construction. There is one default per setting, an unknown key
is a 400, and the write path enforces the permission the _setting_ declares rather than the one
the route happened to name.

**Why code and not a database table of definitions.** The same reason as the role templates
(ADR-038): a built-in setting's **meaning** must be identical in every deployment, and changing
it should be a reviewed deploy rather than an `UPDATE`. Per-company values are data; the shape of
the thing is not.

**Three layers of inheritance, and the source on the wire.** A value is the company's row, then a
platform default under the same key, then the code default. `source` is returned with every value
because "we chose 24 hours" and "nobody has chosen, so it is 24 hours" are different facts, and a
settings screen that shows only the number invites somebody to believe the first.

**A stored value that no longer validates falls back to the default.** A setting's type can change
in a release while old rows remain; handing a screen an integer where it expects an enum member is
worse than showing the default and letting somebody set it again.

**The catalogue is checked against itself.** A test asserts every default satisfies its own
declared type, every key matches the database's shape constraint, and no key appears twice — the
three ways a catalogue entry can be wrong on the day it is written.

---

## ADR-070 — Version history only where a change is material

**Decision.** Each setting declares `material`. A material change **requires a reason** and
appends to `company_setting_changes` with its previous value; a non-material one does neither.
Every change, material or not, still produces an audit event.

**Why not keep history for everything.** The client's phrase is "version/change history **where
material**", and the reason is readability. A branding colour changing twenty times during a
rebrand buries the one entry somebody needs — an escalation window that moved from 72 hours to 8
before an incident. A history that is complete and unreadable answers no questions.

**Why the reason is mandatory for those.** The whole purpose of keeping the previous value is to
reconstruct a decision. "The value changed" without a reason reconstructs nothing, and the
constraint is in the database rather than only in the service.

**What "append-only" means here, precisely.** `UPDATE` and `DELETE` are revoked from the
application role, so the application cannot rewrite the history. There is **no hash chain**, so
unlike the Prompt 8 trails this does not claim tampering is _detectable_ — a superuser could
rewrite a row and nothing would notice. The weaker claim is the honest one, and it is written into
the migration next to the `REVOKE`.

**Which settings are material, and why those.** The ones that change what the product _does_ to
somebody: the workspace name everybody sees, the business timezone every deadline is computed
against, the approval reminder and escalation windows, and the Employee ID uniqueness rule. Not
density, not accent colour, not the digest frequency.

## ADR-071 — A performance score is derived from an append-only ledger, never stored

**Status:** Accepted at Prompt 12B.

A stored running total is a number nobody can reconstruct, and "why is my score 240" is the
question this feature exists to answer. So `performance_events` is the record and every score is
the sum of it — checked by a test that adds up the events the API returns and compares.

Three consequences that would each have been awkward the other way:

1. **A policy change re-derives cleanly.** Raising the Gold threshold changes who is Gold with no
   migration to fix up totals, because there are no totals.
2. **Points are historical, levels are current.** Each event stores the points it earned _and_ the
   policy version that decided them, so a later change never rewrites what somebody earned; the
   level is a reading of the policy active when it is read. Somebody who earned Gold under
   version 1 does not appear to have earned it under version 3.
3. **A correction is an event.** With `UPDATE` and `DELETE` revoked on the table, fixing a wrong
   score means a new `ManualAdjustment` with a reason — which is also the honest shape, because
   the original outcome did happen.

**Rejected:** a `performance_score` column maintained by a trigger. Fast to read, impossible to
explain, and a bug in the trigger silently corrupts everybody's standing with no way to tell.

## ADR-072 — Performance policy is versioned; there is no in-place edit

**Status:** Accepted at Prompt 12B.

`PUT /performance/policy` supersedes the active row and creates version N+1, enforced by a partial
unique index that permits exactly one row with `superseded_at IS NULL`. A reason is mandatory.

A score means nothing without the rules that produced it, and a company will change those rules —
the client's requirement is explicitly "configurable thresholds". Editing them in place would
silently restate every past score. Versioning makes "why was this person Gold in March" answerable
and makes the change itself auditable, with `pastScoresRewritten: false` stated in the audit
metadata so the guarantee is in the trail rather than only in this document.

## ADR-073 — An Engine Agent is reusable; a performance event is per occurrence

**Status:** Accepted at Prompt 12B. Restates the locked terminology in the one place it could be
broken by accident.

The idempotency key is `(tenant, subject, sourceKind, sourceId, kind)`. `sourceKind`/`sourceId` are
**opaque** — `todo`, `objective`, `agent_run`, `manual` — because the modules that own that work
arrive at later prompts and this engine must not wait for them, nor grow a foreign key per module.

The shape matters for the locked rule: recurring work produces **Runs**, and each Run is a separate
`sourceId`, so it scores separately without anything creating a second Engine Agent. A key on the
Engine Agent rather than the Run would have collapsed a quarter's work into one event.

## ADR-074 — One notification row per recipient, not a shared event

**Status:** Accepted at Prompt 15.

Read state, acknowledgement and escalation are all **per person**. Six approvers waiting on the
same objective have six different answers to "have you seen this", six different escalation
deadlines and six different managers to escalate to.

A shared event row would therefore need a per-recipient side table carrying every one of those
columns — which is this table plus a join. The cost of the chosen shape is that the title and body
are duplicated per recipient; the benefit is that the one query the Notification Center runs
("what is unread for me") touches one table with one index.

`raise` accordingly notifies **one person**. A caller with six approvers calls it six times, and
each call consults that person's preference, their own dedupe key and their own deadline. A
"notify these people" signature would have buried the preference check in a loop inside the engine
and made the dedupe key ambiguous.

**Rejected:** a shared `notification` + `notification_recipient` pair. It is the normalised shape
and it makes every read a join for no gain, because nothing ever reads a notification without a
recipient.

## ADR-075 — The dedupe key's shape is the caller's decision, and it defines "duplicate"

**Status:** Accepted at Prompt 15.

`UNIQUE (tenant, recipient, dedupe_key)` makes duplicate suppression a constraint rather than a
convention — the callers are retrying schedulers and event handlers, so a duplicate has to be
impossible, not unlikely.

But **the key's shape decides what a duplicate is**, and the right shape differs by source:

- `approval:<id>` — **no time component.** One notification per approval per person, however many
  times a queue re-runs. A second "this is waiting on you" is noise.
- `overdue:<id>:<yyyy-mm-dd>` — **per day.** Still not done tomorrow is new information; a key
  without the date would notify once and then stay silent for ever.
- `budget:<subscription>:<percent>` — per threshold, so 80% and 100% both notify and neither
  repeats.
- `security:<action>:<person>:<minute>` — per minute, because the Prompt 8 seam hands over the
  event _input_ with no id, and a key per attempt would mail somebody once per guess during a
  password-spraying run.

Getting this backwards is the entire failure mode of a notification system: silent when it
matters, or a flood that trains people to ignore exactly the alerts that count. So the builders
live in `@uboss/types` as one definition per source, with a unit test asserting the difference,
rather than being assembled at each call site.

**A known consequence, stated:** the budget key has no billing period in it, so a company that
renews and crosses 80% again in the next period is not notified again until the subscription row
changes. The AI cost lifecycle (Prompts 25–30) introduces a per-period consumption record and the
key gains the period then.

## ADR-076 — Notification email reuses the Prompt 10 outbox; the transport is an adapter

**Status:** Accepted at Prompt 15. Closes the limitation ADR-055 recorded.

`OutboxRepository` has carried a documented "no dispatcher exists yet" note since Prompt 10: rows
accumulated as `Pending`, `claimDue`/`markDelivered`/`markFailed` existed and were tested, and
nothing consumed them. That was deliberate — a queue and its consumer written together and never
exercised apart are two halves of one untested thing.

Prompt 15 adds the consumer, and adds **no second queue**. The outbox already provides everything
notification email needs: enqueue inside the caller's transaction (so no mail is sent for work
that rolled back), a unique idempotency key, exponential backoff, and dead-lettering that keeps
the row. Introducing a job runner alongside it would have been the duplicate-infrastructure
mistake the reuse rule exists to prevent, and would have needed a new dependency.

Two further decisions:

1. **The payload is a notification id and nothing else.** No address, no body. An outbox row is
   long-lived, widely readable working state; reading the recipient and the message at dispatch
   time costs one query and keeps personal data out of a queue.
2. **`EmailAdapter` reports whether it delivers real mail**, and the default implementation logs
   and sends nothing. That flag is on the dispatch result and in every audit event, so
   "dispatched" is distinguishable from "delivered" at every layer. An adapter that quietly
   pointed at localhost would appear to work in development and fail silently in production.

**There is no scheduler.** `runOnce` is called by `POST /platform/notifications/dispatch`, the
precedent Prompt 11 set with `apply-due`. The consequence — a queued email waits until something
calls it — is a stated limitation, not a hidden one.

## ADR-077 — Escalation creates a new notification; it never reassigns

**Status:** Accepted at Prompt 15.

When an item goes unacknowledged past its deadline, the original is marked `escalatedAt` and a
**new** notification is raised for the recipient's reporting manager, carrying `escalatedFromId`.

Two rows rather than a reassignment, for three reasons: the person originally asked still needs to
see it; the manager needs their own read and acknowledgement state; and reassigning would erase
the fact that the first person was asked at all — which is exactly what an escalation is evidence
of.

Three details that each prevent a specific wrong behaviour:

- **The escalation is not `isAssignedToRecipient`.** The manager is being told, not given the
  work. Marking it assigned would misrepresent whose task it is and pollute their queue.
- **Severity is floored at `Warning`.** An escalation that arrived looking like information would
  be ignored exactly as the original was.
- **An item with nobody above it is left un-escalated**, and counted. Marking it done would lose
  the escalation permanently for anybody at the top of a hierarchy; leaving it means giving that
  person a manager later escalates it then.

The reporting hierarchy is passed to `escalateDue` as a function rather than imported, so the
notification engine does not depend on the organization module — which would become a circular
dependency the moment offboarding wanted to notify somebody.

## ADR-078 — Agent Tool Permission is a separate vocabulary, a separate table, and a separate function

**Status:** Accepted at Prompt 16. Implements a locked client rule.

`ACTIONS` — View, Comment, Create, EditDraft, Assign, Approve, Publish, Run, Schedule, Pause,
Export, ManageAccess, Administer, Audit — answers "what may this **person** do in this module".

`TOOL_ACTION_CATEGORIES` — Read, Write, Delete, ExternalBulkSend, SensitiveExport,
FinancialChange, ProductionChange — answers "what may an **Engine Agent** do to somebody else's
system through this credential".

They are different questions about different subjects, and the client's rule is that they stay
separate. The concrete danger of merging them is specific and severe: `Administer` appears in the
human list, so a single merged vocabulary would mean that granting somebody administration of the
Integrations module silently granted every agent the ability to _administer_ a connected ERP. One
lookup would satisfy both, and nobody would have chosen it.

So the separation is enforced four ways:

1. **Two files**, each with a comment naming the other.
2. **Two tables**: `role_assignments` and `connection_tool_grants`.
3. **One function** — `ConnectionService.mayAgentUse` — which takes an `agentId`, never a user id,
   so it is not _possible_ to satisfy it by passing a person.
4. **A unit test in `@uboss/types`** asserting the two lists share no member, so a future edit
   that reaches for the convenient answer fails there rather than in production.

`mayAgentUse` requires a live grant **and** a `Connected` state. A grant on an expired credential
is permission that would fail, and failing at the boundary rather than at the provider is what
prevents a half-completed external action.

## ADR-079 — A connection stores a reference; the vault is an adapter

**Status:** Accepted at Prompt 16. Implements the client's `secret_ref` only rule.

`SecretsVault` is an abstract class with one default implementation. The rule is made
**structural** rather than conventional: the value lives in `connection_secrets`, a table no
screen, no list and no affected-agent query touches, so reading a connection cannot read a
credential. `reveal` is the only method that returns plaintext, it is called by the service at the
moment of use, and the value goes straight to a connector adapter — which is itself given no
access to the vault, so an adapter cannot read a credential for a connection nobody asked it
about.

Three decisions inside that:

- **The handle is random** (`cs_` + 24 bytes). Derived from the connection id it would leak
  across the boundary the interface exists to hide; derived from the value it would let anybody
  who could guess a credential confirm it by looking for its handle.
- **Rotation keeps the handle.** A new handle would silently detach every tool grant, and the
  grants are the configuration somebody spent time on.
- **The default is local, sealed, and says so.** `describe()` reports
  `isExternalProvider: false`, and that reaches the screen. "Encrypted at rest in our own database
  with a versioned key" is a real guarantee; it is a _different_ guarantee from "held in a managed
  secrets service", and stating the weaker one is the whole point.

## ADR-080 — Connection state is derived; there is no state column

**Status:** Accepted at Prompt 16. Extends ADR-047 to a third case.

The client's five states — Connected, NeedsReauthorization, Expired, Disabled, Error — are
computed at read time from four facts: `disabled_at`, `credential_expires_at`,
`needs_reauthorization`, `last_error`.

A stored state would leave a window between a credential expiring and a sweep noticing, and every
Engine Agent run in that window would be authorised against a stale answer. This is the same
reasoning as break-glass expiry (Prompt 8) and platform-role expiry (Prompt 9): **evaluate on
read; sweep only to tidy state for reporting.**

The precedence _is_ the logic, and each step prevents a specific wrong message:

1. `Disabled` first — a disabled connection reporting `Error` would invite somebody to fix it.
2. `Expired` before `NeedsReauthorization` — re-consenting cannot fix a key that has run out, and
   sending somebody to re-consent when they need a new key wastes their afternoon.
3. `Error` last — a transient failure on a valid credential is the least of these.

## ADR-081 — A User Connection is never transferred, and offboarding disables it

**Status:** Accepted at Prompt 16.

`transferOwner` refuses a User Connection outright, and offboarding **disables** the leaver's
personal connections rather than moving them. The credential is that person's own account: handing
it to a successor would give somebody access to a mailbox that is not theirs, which is a different
and worse thing than inheriting their work.

The corollary shaped the permission model. An administrator may **disable** anybody's personal
connection — that is the security action a company needs — but may not rotate or reauthorize one,
because that means holding their credential. And a person's **own** personal connection needs only
`settings:View`: connecting your own account grants nobody else anything, the same as enrolling
your own second factor. Requiring `Administer` there made the client's User Connection type
unreachable by the people it exists for, which this prompt's own tests caught.

**Company** connections a leaver owned are reported, not reassigned. Silently making the named
successor the owner of an ERP credential is exactly the automatic escalation of access the
role-revocation rule (ADR-067) exists to prevent — somebody has to choose.

## ADR-082 — Disabling a connection keeps its tool grants

**Status:** Accepted at Prompt 16.

`disable` sets `disabled_at` and a mandatory reason. It does **not** revoke the grants.

There is no security gain in revoking them: `mayAgentUse` refuses on state, so a disabled
connection cannot be used whatever any grant says. There is a real cost: the grants are a
configuration somebody assembled — several agents, several categories, each with a reason — and
destroying it means rebuilding it by hand to re-enable something that was disabled for a week
while a contract was renegotiated.

So the audit event states `grantsRevoked: false` explicitly, because it is the surprising half,
and the screen says the same thing when disabling. The affected agent count is recorded at the
moment of disabling, so "how many agents did this break" stays answerable.

## ADR-083 — Skills are governed capabilities; there is no Templates Library

**Status:** Accepted at Prompt 17. Implements a locked client rule, and records _why_ the rule is
structural rather than a naming preference.

The rule is that there is no Objective Template, no Workflow Template, no Agent Template and no
Templates Library. The temptation to build one is real — "give people a starting point" is a
reasonable-sounding feature — so this ADR records the actual difference:

|                       | Template                                        | Skill                                                         |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Ownership after use   | the copy is yours; the original stops mattering | the version stays under its own lifecycle                     |
| What work references  | a copy taken at some past moment                | **a published version**, by id                                |
| Changing it           | edit your copy; nobody reviews                  | a **new draft**, approved before anything uses it             |
| "What is using this?" | unanswerable                                    | answerable, and asked before every upgrade                    |
| Governance            | none                                            | status, owner, approver, autonomy limit, evidence requirement |

So the implementation has versions, statuses, approvals, owners, autonomy limits and impact
analysis — every one of which a template library would not need. **The absence of an `instantiate`
route is the rule being kept**, and `clone` is not a loophole: it produces a `CompanyCustom` Skill
with its own draft, its own approval and a recorded provenance link, so the catalogue can still
answer the question a template cannot.

## ADR-084 — A Skill's identity and its versions are separate tables

**Status:** Accepted at Prompt 17.

`skills` carries what persists — layer, handle, owner, which version is live. `skill_versions`
carries content and status.

"Published V1 is immutable; an edit creates a V2 Draft" only means something if there is something
for both versions to be versions _of_. One table would force a choice between rewriting history
and duplicating identity on every row, and work needs to reference a **version** by id while a
person talks about the **Skill**.

Two partial unique indexes make the pair unambiguous: `one_published_version_per_skill` (so "which
version does work reference" has one answer) and `one_open_draft_per_skill` (so "the draft" means
something). The first of those caught a real ordering bug on the publish path.

## ADR-085 — Content freezes at `Approved`, not at `Published`, and a trigger enforces it

**Status:** Accepted at Prompt 17. Deliberately stricter than the client's stated rule.

The rule names publication. Freezing one step earlier is a decision worth recording because it
looks like over-reach and is not: **an approval is a governance decision about specific content.**
If content could change after approval, somebody could get "delete records" approved by having
"read records" reviewed — and the approval record would be worthless while looking intact.

Enforced by a `BEFORE UPDATE` trigger rather than a revoked grant, because the _status_ must still
move (`Published → Deprecated → Archived`) while the content must not. A blanket `REVOKE UPDATE`
would have made deprecation impossible. The trigger names the frozen columns explicitly, so adding
a content field without thinking about immutability fails loudly.

## ADR-086 — The platform/company split is one asymmetric RLS policy, not two tables

**Status:** Accepted at Prompt 17. The first nullable-tenant RLS policy in UBoss.

`skills.tenant_id` is nullable: null means platform-owned. The policy's halves differ:

- `USING` permits reading **own rows and platform rows** — that is what "a Verified Skill is
  available to every company" means, and without it the catalogue is empty for everyone.
- `WITH CHECK` permits writing **own rows only** — so a company can use and clone a Verified
  Skill and can never author, edit or approve one.

**The asymmetry is the security property.** A symmetric policy would let any company insert a
`tenant_id IS NULL, layer = 'UbossVerified'` row, which every other company would then read as
verified by UBoss. `skill_layer_matches_its_owner` is the second lock: a layer cannot lie about
its owner even within one plane.

Two tables were considered and rejected: every read would then be a union, the lifecycle service
would exist twice, and the one thing that must be identical across the planes — the transition
table — would be the thing most likely to drift.

## ADR-087 — Impact analysis reports unknown, never zero

**Status:** Accepted at Prompt 17. Same shape as `HANDOVER_DOMAINS` (ADR-067).

The client requires impact analysis before an upgrade: affected Agents, Objectives, departments
and runs in flight. **Three of those cannot be counted yet** — the modules that reference a Skill
arrive at later prompts.

So `SKILL_IMPACT_DOMAINS` is a declared registry, each uncountable domain returns `count: null`
naming the prompt that will make it real, and the response carries `incomplete: true`.

Reporting four zeroes would have been trivially easy and actively dangerous: somebody would read
"0 affected Objectives" as a clean bill of health and publish. An analysis that admits what it
cannot see is more useful than one that under-reports, and this is the one place in the product
where that difference could break live work.

## ADR-088 — Approving and rejecting a Skill are the same permission, and it is not the administrator's

**Status:** Accepted at Prompt 17. Corrects an attempt to widen `CompanyAdmin`.

A Skill's approval step needed a permission. `CompanyAdmin` was the obvious place and the Prompt 7
invariant test refused it — correctly. The invariant is that **a Company Admin carries no
`Approve` anywhere**, because blanket approval for an administrator is how "the admin approved
their own change" happens, and the client's model is that an administrator who must also approve
is _additionally_ assigned the Approver role.

So `settings: ['View', 'Approve']` went to **`Approver`** instead, which matches that role's stated
purpose exactly — "reviews and approves, deliberately cannot author what it approves".

**Rejecting is the same permission as approving.** Sending a version back to `Draft` is what
rejection _is_, and a lifecycle where a reviewer can approve but not reject gets worked around by
approving things and fixing them later. A test asserts both halves: the administrator can do
neither, and the approver can do both and cannot author.

## ADR-089 — The Skill Router is a rules engine, and that is a decision

**Status:** Accepted at Prompt 18.

There is no model in the router. It scores what a Skill **declares about itself** — category,
when-to-use, when-**not**-to-use, declared inputs, allowed tool categories, autonomy — against the
context it is given.

This is not a placeholder for an embedding search. **A selection nobody can explain cannot be
governed.** Somebody will ask "why did an agent use _that_ Skill on our tender", and the answer has
to be something a company can act on: which of its declarations matched, and why each alternative
was ruled out. "The vectors were close" fails that test, and would fail it more the more the
product is trusted.

Prompt 17 made those fields mandatory precisely so this would be possible. Using them is the
design working, not a compromise.

Two consequences, both deliberate:

- **Hard rules disqualify rather than rank lower.** A policy ceiling on autonomy, a tool the work
  forbids, an unavailable required input, a "when not to use it" that describes this task — each
  removes the Skill. Ranking a policy violation slightly lower is how it eventually gets used.
- **A relevance signal is required.** Category and tool-count are a filter and a tie-breaker. This
  prompt's own test found a birthday-message Skill scoring exactly the confidence floor for tender
  screening on those two alone, so a Skill must now match on what it says it is _for_.

## ADR-090 — A missing capability becomes a Candidate; there is no path to published

**Status:** Accepted at Prompt 18. Implements a locked client rule.

The rule: when the required capability is missing, create or suggest a Skill Candidate and route
it to authorized governance — **never silently publish or auto-use it**.

The strongest expression of that turned out to be an **absence**: `SkillCandidateStatusKind` has
no `Published` member, so there is no value anybody could set, and the database refuses the update
as an invalid enum input. Accepting a Candidate calls `SkillService.createCompanySkill`, which
produces a **draft** subject to the ordinary Draft → Review → Approved → Published lifecycle.

Three supporting decisions:

- **`raiseCandidateIfMissing` defaults to true.** Making the client's rule opt-in would mean the
  common path silently dropped it.
- **The Candidate carries the routing context and every rejection.** A reviewer needs to see what
  was asked for and what was tried; without that, "we need a new Skill" is a request nobody can
  evaluate.
- **Both endings are terminal.** A re-openable Candidate would be a second, weaker lifecycle
  running beside the real one.

## ADR-091 — The evaluation harness records results; it does not produce them

**Status:** Accepted at Prompt 18.

`skill_evaluation_runs.actual_output` is **supplied** — by an operator or a test — and
`produced_by` defaults to `Recorded`. There is no evaluator, because running a Skill needs the
Model Gateway (a later prompt).

A stub evaluator was the obvious alternative and would have been actively harmful: every
regression comparison would go green against invented output, and a comparison is exactly the
evidence somebody publishes on. The honest version is a harness that works today with real
recorded outputs and gains a producer later, with `produced_by` already carrying which it was.

`HumanJudged` follows the same principle from the other side: it **cannot** be computed,
`evaluateOutput` returns null, and a run with no supplied verdict is stored **unjudged** — counting
as neither pass nor fail, so no comparison can lean on cases nobody looked at.

## ADR-092 — A regression is reported separately from a mixed result, and blocks

**Status:** Accepted at Prompt 18.

Any case the live version passes and the candidate fails is a **regression**, whatever else
improved. `Mixed` exists so "eight better, one worse" reads as a decision, and `Regressed` exists
so "one thing that used to work no longer does" reads as a blocker — but both set
`blocksPublication`.

Publishing anyway is possible and is a **signed act**: an actor, a timestamp and a reason of at
least ten characters, enforced by `regression_acceptance_is_attributed`. The person who later
finds the broken behaviour will read that reason.

Two further guarantees make the verdict trustworthy:

- **`verdict_matches_its_evidence`** — a row whose verdict disagrees with its regression and
  improvement arrays is refused, so a verdict cannot come from anywhere but the comparison.
- **A comparison freezes the expectations it depended on** (`usedInComparison`). A case editable
  after a comparison is evidence that can be made to agree with whatever happened.

## ADR-093 — Routing decisions are not persisted; only the exception is

**Status:** Accepted at Prompt 18.

The router is a pure function over declared Skill fields and its context, so any decision is
reproducible from its inputs. A `skill_routing_decisions` table would be a high-volume log of
something derivable — one row per AI task, forever, to record an answer the same inputs would give
again.

What **is** persisted is the exception: a `SkillCandidate` when nothing applied, carrying the
context and every rejection. That is the case somebody has to act on, and the case the client's
rule says must not be silently improvised past.

The audit trail carries the summary of every routing call regardless — counts, the top match, and
`onlyPublishedConsidered: true` — so "what did the router do on Tuesday" is answerable without a
second table growing without bound.

## ADR-094 — Form 2's field list is code, not markup

**Status:** Accepted at Prompt 19.

**Context.** The client's locked instruction is that Form 2 is preserved exactly: no source field
dropped, renamed, merged or reordered, and the fifteen-column grid kept whole. That is an easy
promise to make and a very easy one to break by accident — collapse `Unit` and `Time Unit` because
two number-and-unit pairs look redundant, drop `Current Problem` because it is usually blank,
shorten `INPUT Received From` to `Source`. Each is a one-line change in a form component and none
would fail a conventional test.

**Decision.** `FORM2_OBJECTIVE_FIELDS` and `FORM2_WORKFLOW_COLUMNS` in `@uboss/types` are the
single source. The migration was written from them, the DTOs mirror their ceilings, validation
walks them, the `GET /form2` response is derived from them, and the grid component renders them.
Invariant tests assert the source-field list verbatim, the column count, the grouping and the
client's exact labels.

**Consequences.** A dropped field is a failing test rather than a quiet loss of the client's form.
The cost is indirection: the form's shape is not visible by reading the JSX. That is the right
trade for a form whose exactness is a contractual requirement.

## ADR-095 — Objective identity and Form 2 content are separate tables

**Status:** Accepted at Prompt 19.

**Context.** Published/live versions are immutable, and any authorized edit after Live creates a
new Draft version rather than overwriting the live one. Prompt 20 owns the version _engine_, but
the table layout has to support the rule now or every field moves later.

**Decision.** `Objective` is identity (code, department, owner, live pointer); `ObjectiveVersion`
holds the Form 2 content and the lifecycle status; `ObjectiveWorkflowStep` belongs to a version.
The same shape as `Skill`/`SkillVersion`. The complete transition table is declared once in
`ALLOWED_OBJECTIVE_TRANSITIONS`, even though Prompt 19 exposes only the moves it owns — two
partial tables in two services is how they come to disagree, which has already happened twice in
this codebase.

**Consequences.** Prompt 20 adds endpoints, not columns. The cost is that reading "the objective's
status" is a join, so the list resolves the live version or the newest one.

## ADR-096 — The objective's department is denormalized onto the identity row

**Status:** Accepted at Prompt 19.

**Context.** Department is a Form 2 field, so the version carries it. Authorization scope
evaluation also asks "which department is this objective in?" on every read, and answering that
through a join into versions would make the scope check depend on version state.

**Decision.** `Objective.department_id` and `objective_owner_user_id` mirror the _live_ version's
values, or the draft's while nothing is live. The service keeps them in step inside one
transaction. A draft proposing a move cannot relocate a running objective — once a version is
live, the anchor follows that version.

**Consequences.** One denormalization with a named owner and a test asserting the two agree,
rather than a scope check whose cost and correctness depend on the version table.

## ADR-097 — The workflow grid is replaced whole, not patched per row

**Status:** Accepted at Prompt 19.

**Context.** The approved UI edits the grid as a spreadsheet: insert below, duplicate, delete,
reorder, and a row count that is explicitly not fixed.

**Decision.** `PUT /:objectiveId/draft` takes the complete `steps` array; the service deletes and
rewrites the version's rows inside one transaction. `position` must arrive as 1..n with no gaps and
the API refuses a gap rather than renumbering.

**Consequences.** Reconciling spreadsheet edits into per-row operations would invent an ordering
the screen never had, and a silent renumber would hide a client bug by reordering somebody's plan.
The cost is that two people editing one draft is last-write-wins; that is acceptable while a draft
has a single owner, and review routing at Prompt 20 is where concurrent editing gets a real answer.

## ADR-098 — The Performance & Reward panel is a separate table, not a section

**Status:** Accepted at Prompt 19.

**Context.** The client's amendment adds an optional Performance & Reward panel "around the
Objective/extra-work assignment, **not inside** the canonical Form 2 field list", with seven
fields, and states that nothing auto-pays on completion.

**Decision.** Its own table, its own endpoint, its own permission (`objective:Assign`). It has no
approved, settled or paid state and no link to the performance ledger — enforced by those columns
not existing, asserted from `information_schema`. One panel per objective, keyed on the objective
rather than a version, because a reward is about the assignment and not about a form revision.

**Consequences.** "Outside Form 2" is structural: there is no column on `objective_versions` for a
future change to add a reward field to by accident, and the Form 2 invariant test would fail if one
appeared. Prompt 19A extends this table with the reward lifecycle rather than creating a second
one.

## ADR-099 — The objectives list applies scope per row through the authorization engine

**Status:** Accepted at Prompt 19.

**Context.** A list has to be filtered by the actor's scope. The fast way is to translate each
scope kind into a `where` clause.

**Decision.** The list fetches candidates under RLS and then calls the same
`authorize({ module, action, resource })` per row that a direct fetch makes.

**Consequences.** Slower, and correct: a second implementation of scope in SQL is a second thing
that can be wrong, and the one that is wrong would be the one deciding what a manager may see. If
this becomes a measured problem the fix is a cache in front of the engine, not a parallel
implementation.

## ADR-100 — The reward rule is the Prompt 19 panel; only the award is new

**Status:** Accepted at Prompt 19A.

**Context.** The prompt asks for "reward_rule and reward_award lifecycle". Prompt 19 had already
built the Performance & Reward panel as `objective_rewards`, one row per objective, with the
client's seven fields.

**Decision.** `objective_rewards` _is_ the reward rule. Prompt 19A adds only `reward_awards`, and
the lifecycle lives on the award because it belongs to an instance — two people can be assigned
under one rule and one of them rejected.

**Consequences.** No second rule table to disagree with the panel, and the panel's own screen keeps
working unchanged. The naming differs from the prompt's literal `reward_rule`, and that is recorded
here rather than resolved by creating a duplicate table.

## ADR-101 — The payout adapter is a seam with a refusing default

**Status:** Accepted at Prompt 19A.

**Context.** The prompt asks to "expose integration boundary for approved payroll/payment
connector" and, separately, not to auto-pay cash. No payroll provider has been approved or
integrated.

**Decision.** `PayoutAdapter` is an abstract class with `canSettle` and `settle`.
`UnconfiguredPayoutAdapter` is what the module provides: it reports `canSettle: false` and throws
if called. `MockPayrollPayoutAdapter` exists for tests and returns
`deliveredRealPayment: false`, always. That flag is part of the result type, is stored on the award
as `payout_was_real`, and is reported on every read.

**Consequences.** A stub that returned a plausible reference and reported success would be the most
dangerous thing in this codebase — somebody would read "Settled · ref PAY-8842" and believe an
employee had been paid. Instead the product refuses, and says why. A real provider is one adapter
class and one line in the module; the lifecycle, the four-eyes control and the audit trail are
provider-agnostic.

## ADR-102 — Approved points reach performance through a policy gate, defaulting to off

**Status:** Accepted at Prompt 19A.

**Context.** "Link approved points/achievement to performance only through policy." The Prompt 12B
performance policy had no such field, and the prompt requires one.

**Decision.** `PerformancePolicy.rewardPointsReachPerformance`, `false` by default. `record` on a
points award writes a `ManualAdjustment` event through the existing `PerformanceService.recordEvent`
— reusing the Prompt 12B ledger rather than adding a second scoring path — and only when the gate
is on. When it is off the award finishes as `Recorded` with a note saying why.

**Consequences.** The safe reading of an unanswered question is no. The cost is that a company must
deliberately enable it, which is the point. `performance:Administer` is required to change it, and
only `CompanyAdmin` holds that.

## ADR-103 — Settlement requires a different person from the approver

**Status:** Accepted at Prompt 19A.

**Context.** The client's high-risk controls include four-eyes. Paying out money is the highest-risk
act in the reward lifecycle.

**Decision.** `settle` refuses when the actor is the award's `decided_by_user_id`, in the service
**and** in a CHECK constraint. Separately, the subject may never find their own work eligible or
approve their own award.

**Consequences.** A company needs at least two people to move money, which is the intent. The
constraint is the load-bearing half: a service is one missed branch away from losing it.

## ADR-104 — Approval is a fact on the version, not a ninth status

**Status:** Accepted at Prompt 20.

**Context.** Prompt 20 states the chain as `V1 Draft → Review → Approved → Published → LIVE V1`,
naming Approved and Published as separate stages. Prompt 19 gave the client's enumerated state
list, which is eight values and contains **neither** `Review` nor `Approved` as distinct from
`Submitted/Under Review` and `Published/Active`.

**Decision.** Keep the client's eight-state enum. Make approving and publishing two separate
**acts**: `approve` stamps `approvedAt`/`approvedByUserId` and leaves the status at
`ReadyForApproval`; `publish` requires that stamp and moves to `Active`. A derived `reviewStage`
reports "Awaiting approval" or "Approved — awaiting publish" so a screen never shows an approved
version as though it were still waiting.

**Consequences.** Both source documents are satisfied without inventing a state the client's own
list does not have — the source-precedence rule, applied to a genuine tension between two prompts.
The cost is that "approved" is a field rather than a status, so any screen must render
`reviewStage` rather than the raw status; the API therefore computes it rather than leaving each
screen to. If the client does want a distinct Approved state, it is an enum addition and a
migration, and this ADR is where to start.

## ADR-105 — Hierarchy-aware routing permits what it cannot evaluate

**Status:** Accepted at Prompt 20.

**Context.** "Responsible Owner / Send To is hierarchy-aware." The reporting tree lives in
`employment_records`, and a company part-way through onboarding has people with no record yet.

**Decision.** The membership check is hard and always applies. The reporting-line check applies
only when **both** people have an employment record; when either does not, the routing is
permitted and the gap is recorded rather than refused. The direction is not constrained — one
person at or beneath the other satisfies it — because the prompt's "Responsible manager" implies
upward while the approved reference shows a Head sending downward.

**Consequences.** A considered exception to this codebase's fail-closed habit, and the reasoning
is the load-bearing part: routing is a data-quality concern, not a security boundary. The recipient
still needs `objective:Approve` **and** the row-level scope check **and** to be the named
Responsible Owner before they can do anything. Refusing instead would make the Objective Builder
unusable until the hierarchy was complete — a real regression to prevent a non-breach. The
unconstrained direction is the item most likely to need a client answer; it is in the open-questions
list.

## ADR-106 — An edit of a live objective opens the next draft; an edit under review does not

**Status:** Accepted at Prompt 20.

**Context.** The client's rule is that any later edit automatically creates V2 Draft copied from
V1. Taken literally that would also apply to a version sitting in review.

**Decision.** `PUT …/draft` opens the next draft automatically when every version is live,
completed or archived. When a version is `UnderReview` or `ReadyForApproval` it refuses, and the
author must obtain a send-back first.

**Consequences.** Without the exception an author could route around the reviewer entirely: edit
the copy, take it through approval, and the original review would have decided nothing. The first
implementation omitted the condition and a Prompt 19 test caught it. The cost is that the rule now
has a stated exception rather than being unconditional, which is why it is an ADR.

## ADR-107 — Every model call goes through one gateway, and what ships is a mock

**Status:** Accepted at Prompt 21.

**Context.** The client's locked rule is that provider names live behind the Model Gateway. No
provider has been configured or approved. The prompt requires the gateway abstraction "even if the
provider adapter is mocked initially".

**Decision.** `ModelGateway` is an abstract class with a provider-agnostic request type — no model
name, no temperature, no provider option. `MockModelGateway` is what `ModelGatewayModule` provides,
it is `@Global`, and its responses carry `producedByRealModel: false` and an opaque `capability`
label. Callers persist both. Every analysis stage makes exactly one gateway call.

**Consequences.** A service that reached a provider SDK directly would break three things at once —
put a provider name in company-facing code, bypass central cost metering, and take provider
configuration out of the Master Console's hands — and it would be one import, easy to add and hard
to notice. Making the module global and the mock the default means the wrong path does not exist.

Note the deliberate asymmetry with `UnconfiguredPayoutAdapter`, which **refuses**: a fabricated
payment makes somebody believe an employee was paid, whereas a fabricated analysis produces a draft
that a person must read, edit and approve before anything happens. The human review is already in
the path, so the mock does its job and the flag travels with the result.

## ADR-108 — The workflow draft is a versioned document, validated before it is stored

**Status:** Accepted at Prompt 21.

**Context.** The prompt requires a versioned JSON schema for the analysis draft. A stored draft
outlives the code that wrote it.

**Decision.** `ANALYSIS_SCHEMA_VERSION` is stamped into the document and into its column, with a
constraint refusing them to disagree. `validateWorkflowDraft` runs before any store and the draft is
refused if it fails. On read, a version this build does not recognise returns `draft: null` with an
`unreadableReason`.

**Consequences.** A draft is either readable or knowingly refused, never mis-interpreted. A
malformed draft never reaches the database, so a rendering failure cannot surface far from its
cause. The cost is a version to remember to bump; the rule is in the constant's comment — adding an
optional field does not need one, renaming or re-meaning a field does.

## ADR-109 — The node shape is data, and the analysis decomposes Form 2

**Status:** Accepted at Prompt 21.

**Context.** The client's locked UI rule: Human nodes are rectangles, AI nodes are diamonds, the
Goal is visually distinct. Separately, the analysis has to produce a plan.

**Decision.** `NODE_SHAPE_BY_KIND` is the authority; every node carries its `shape`, and
`validateWorkflowDraft` refuses a node whose shape contradicts its kind. The renderer draws what it
is told. And every node is derived from a row of the objective's own Form 2 grid, recording
`fromStepPosition`; what the analysis cannot work out goes into `gaps`.

**Consequences.** The shape rule cannot be broken by restyling a component, and an invariant test
asserts it. Deriving from Form 2 rather than inventing steps means the output is traceable to what
the company itself wrote down — and `gaps` is what keeps it honest, because an analysis that
silently omitted its blind spots would look complete and be wrong.

## ADR-110 — The AI's proposal and the manager's plan are two records

**Status:** Accepted at Prompt 22, on the client's explicit approval.

**Context.** Prompt 21 stores a completed analysis, frozen. Prompt 22 requires that plan to be
"fully manager-editable before publish". One row cannot be both frozen history and an editable
working document.

**Decision.** `objective_analysis_runs` stays immutable as the historical AI proposal.
`objective_workflow_drafts` holds the plan the manager edits, seeded from the run on first open and
linked by `seeded_from_run_id`. Seeding happens on **open**, not at the end of the analysis: an
analysis nobody opens leaves no draft behind, and re-analysing does not discard a manager's edits.

**Consequences.** "What did the AI actually propose?" and "what did we decide?" both stay
answerable a year later. The cost is two rows and a link. Re-analysis produces a new run and leaves
the draft alone, which an e2e test pins directly.

## ADR-111 — Every workflow edit carries the revision it was made against

**Status:** Accepted at Prompt 22.

**Context.** Two managers editing one plan is ordinary. The plan decides what people are told to
do.

**Decision.** The draft carries a `revision`; every mutating call sends the revision it read, and a
mismatch is refused with a message naming both numbers. A database trigger refuses a rewind. The
revision is not optional on any edit.

**Consequences.** A concurrent edit is reported, never silently merged or lost. The client pays one
reload when it happens, which is the correct price for not overwriting a colleague's work. Deliberately
not last-write-wins and deliberately not a merge: a graph cannot be merged field-by-field without
inventing a plan neither manager wrote.

## ADR-112 — Human → AI conversion requires an approved Skill

**Status:** Accepted at Prompt 22.

**Context.** The client's phrasing is "Human ↔ AI conversion **where allowed**", without saying
what the allowance is.

**Decision.** `mayConvertNode` is the single answer. Only Human and AI work nodes convert at all —
a Goal, an approval, a condition and a trigger are not work anybody performs. AI → Human is always
allowed. Human → AI needs an approved, published Skill; without one the conversion would create a
step nothing can perform. Converting to Human clears the Skill, so the diagram cannot imply an
agent is still involved.

**Consequences.** A plan cannot go live containing an unperformable step. The rule lives in
`@uboss/types`, so the editor's palette and the server's refusal cannot disagree, and the reason
travels with the refusal rather than the UI having to guess it.

## ADR-113 — The Pre-Publish Summary reports readiness; it does not grant it

**Status:** Accepted at Prompt 22.

**Context.** The prompt ends "Do not publish yet; next prompt handles publish transaction", and
also asks for a summary covering twelve things including "estimated cost".

**Decision.** The summary is a read. `readyToAssign` is a **report**, not permission — Prompt 23
revalidates everything inside its transaction. Findings are `Blocker` or `Warning`; a high-risk
step behind an approval is a Warning, one with no gate at all is a Blocker. Cost is always a range
with a stated basis, never a single figure, because it is derived rather than measured.

**Consequences.** Reading readiness moves nothing, which an e2e test pins. The prototype's
confident `Est. AI cost / run $0.42` is deliberately not carried forward: a single number reads as
a quote.

## ADR-114 — One approvals table, created generic at the first prompt that needs it

**Status:** Accepted at Prompt 23.

**Context.** Prompt 23 must put approval gates into an "Approvals queue". The Approval Engine is a
later prompt, and the client's requirement is approvals and notifications "without duplicating
separate approval tables per module".

**Decision.** `approval_requests` is created generic, carrying the Approval Engine prompt's full
type vocabulary (`ObjectiveReview`, `WorkflowPublish`, `AgentActivation`, `HighRiskAction`,
`OutputApproval`, `BudgetOverride`, `GuestAccess`, plus `WorkflowStepApproval` for a workflow's own
gates). That prompt adds delegation, separation-of-duties wiring, aging and the queue UI **to this
table**. Objective context is columns with composite keys; other domains use
`subject_type` / `subject_id`.

**Consequences.** No second approvals table, and no migration later to merge two. The cost is a
table slightly wider than this prompt needs, and one type (`WorkflowStepApproval`) added beyond the
client's list — justified because that list ends "as policy requires" and a workflow's own gate is
not any of the seven named.

## ADR-115 — Approve & Assign publishes in a transaction and notifies after it

**Status:** Accepted at Prompt 23.

**Context.** Approve & Assign publishes a version, creates human tasks, AI assignments, approval
requests and monitoring expectations, freezes the plan, notifies people and audits. Half of that is
worse than none.

**Decision.** Four phases. **Read** the objective, plan and version. **Validate** all seven client
checks, collecting every failure. **Write** everything in one `runInTenantTransaction`, re-reading
and re-checking the two rows the decision hinges on. **Notify** after the commit.

Notifying after the commit is the substantive half: a notification is an outward-facing side
effect, and sending it inside a transaction that might still roll back would tell an approver about
work that was never assigned. This way a failed notification leaves a correct assignment somebody
can be reminded about — the recoverable failure of the two.

**Consequences.** A forced mid-transaction failure leaves the company untouched, which a test pins
directly. Validation runs outside the write transaction, so its result is advice by the time the
transaction opens — which is why the transaction re-checks rather than trusting it. Forced by the
runtime as much as chosen: the readiness summary and the notification engine both establish their
own scope, and `runAsPlatformOperation` refuses to escalate from inside a tenant transaction.

## ADR-116 — Approve & Assign does not approve

**Status:** Accepted at Prompt 23.

**Context.** The button is called "Approve & Assign". The role templates give a `Manager`
`objective:Assign` and **not** `objective:Approve`, and the client's journey has a Manager pressing
it. Prompt 20's rule is that nothing goes live without an approval and that approving and
publishing are separate acts.

**Decision.** Approve & Assign requires `objective:Assign` and requires the version to be
**already approved**. If it is not, it refuses and says that approving is a separate act. It never
approves on somebody's behalf.

**Consequences.** The name describes the journey — review, approval, then assignment — rather than
one privilege. A Manager cannot escalate to an approval decision by pressing a button labelled with
the word. The alternative, auto-approving when the actor happens to hold `Approve`, would let a
Head skip the explicit approval Prompt 20 made separate.

## ADR-117 — Overdue is derived, not stored

**Status:** Accepted at Prompt 23.

**Context.** The approved UI shows `Overdue` in the Status column of Pending Jobs. It also shows
`Blocked`, `Needs input` and `Waiting Approval` there.

**Decision.** `HUMAN_TASK_STATUSES` does not contain `Overdue`. A task stores what it is waiting
on; `isHumanTaskOverdue` derives lateness from `due_at`, and `humanTaskDisplayStatus` is what the
screen renders. A task with no due time is never overdue, and a finished task is never overdue
however late it was.

**Consequences.** A task can be waiting on somebody else **and** late without either fact being
lost — one status column would have to pick. The Executor Agent prompt's "Human Task Overdue"
exception asks the same function the screen does. The cost is that "overdue" cannot be queried by
status directly; `due_at` is indexed for exactly that.

## ADR-118 — The budget check reports that it cannot be evaluated, and permits

**Status:** Accepted at Prompt 23.

**Context.** The client requires Approve & Assign to validate "budget estimate policy" before
publish. `TenantAiBudgetPolicy` is real and denominated in **money minor units** — a monthly
allowance, an approval threshold, a hard stop. The plan's estimate is in **tokens**. No provider
pricing exists until the AI Provider Profiles prompt, so there is no way to convert one to the
other.

**Decision.** The check runs, records in words that the estimate could not be priced against the
allowance, and **permits**. The outcome goes onto the audit event (`budgetCheck`), not into a
silent pass.

Permitting is the right default rather than the convenient one: the hard stop is enforced when
work actually runs — the Run Engine prompt has a `Blocked by Budget` run state for exactly this —
so refusing every publish until pricing exists would block the product to protect a limit already
protected downstream. Inventing a token price to make the check "work" would put a fabricated
number next to a hard-stop threshold, which is the worst place in the product to guess.

**Consequences.** The check is honest about its own limits and leaves a record of them, so nobody
reading an audit trail later concludes the budget was verified. When provider pricing lands, this
becomes a real comparison in one place.

**Superseded behaviour.** An earlier version of this code refused **every** readiness warning under
the `BudgetEstimatePolicy` label when `acceptWarnings` was not set. That both blocked publishes for
reasons that had nothing to do with budget and told the manager the wrong thing about why.
`PrePublishSummary` already documents that warnings do not block; `acceptWarnings` is now an
acknowledgement recorded on the audit event rather than a gate, because a warning that blocked
would by definition be a blocker.

## ADR-270 — Activation is `Run`, not `Publish`

> **Renumbered at Prompt 42.** This was written as a second ADR-118 — the number was already
> taken by the budget-evaluation decision above — and five documents cited "ADR-118" meaning
> one or the other. The audit found the collision; the earlier decision keeps the number.

**Prompt 24.** Agent Builder's _Activate Agent_ asks for `agent-builder:Run`.

The approved source document puts activation on the employee: "Employee completes Human work and
only missing Agent setup → Test → Activate", and lists "assigned Agent Builder work" and "My
Engine Agents" in the employee's own scope. The Prompt 7 Employee template granted only
`View, Comment` on `agent-builder`, which made that documented journey impossible — a real
under-grant, corrected here.

The first attempt at the correction was wrong, and a pre-existing test caught it. Granting the
Employee `Publish` broke a blanket guardrail — _"gives Employee no approve, publish, assign or
administer anywhere"_ — and that guardrail is right: `Publish` means deciding what the company
releases. Activating the agent for your own assigned step is **doing the work**, which is exactly
what `Run` already means, and the same reasoning the `agents: ['View','Comment','Run']` grant had
been carrying since Prompt 7.

So: Employee gains `EditDraft` and `Run`; `Publish` stays out of the Employee template entirely.
`Publish` instead gates the canonical Form 3 read and, later, releasing a reusable agent's
configuration to the company — authority over the job method rather than over performing it.

Safe because `Employee.maxScope` is `OwnWork`: the scope engine confines every one of these
actions to work the person owns. Pinned by tests that carry the citation, so a future narrowing
has to argue with the document rather than with a preference.

## ADR-119 — `mayBeUsedForSetup`, because an agent's tool grant cannot precede the agent

**Prompt 24.** Agent Builder validates a chosen connection with a new, narrower question than
`mayAgentUse`.

An Agent Tool Permission is granted **to an agent**. Agent Builder chooses a connection _before_
activation creates the agent identity, so `mayAgentUse` there is unanswerable — no grant can exist
for an identity that does not exist yet, and the first implementation therefore made every piece
of work needing a connection permanently unable to activate. The e2e fixture is what surfaced it;
faking a grant against the assignment id would have hidden a real defect behind a fictional row.

`ConnectionService.mayBeUsedForSetup` asks what is answerable at setup time: does the connection
exist, is its derived state healthy, can the connector actually perform the category, and is this
work's department allowed to use it. It deliberately does **not** consider the per-agent grant, and
its own contract says a `true` means "this is a sensible choice to record", never "this agent may
act".

The grant stays a separate administrative act (`grantToolPermission`, `settings:Administer`). That
separation is the point: an employee completing their own agent's setup must not widen an
integration's reach as a side effect. The consequence is stated on the readiness panel as a
Warning rather than left to be discovered at the first run — a healthy connection is not the same
as this agent being permitted to use it.

## ADR-120 — An AI node carries an accountable owner

**Prompt 24, correcting Prompts 21 and 23.** The analysis assigns owners to Human **and** AI
nodes, and an AI work assignment's prefilled owner is the person the plan named for that step,
falling back to the objective owner only when the plan named nobody.

The analysis originally assigned owners to Human nodes only. Defensible for the diagram — no
person performs an AI step — but it left every AI work assignment owned by the objective owner,
which put every agent's setup in front of the manager rather than the employee. That contradicts
the source document twice: an Engine Agent must carry an "accountable owner", and Agent Builder
prefills an "employee/business owner". The Form 2 grid names a person on the Engine row for
exactly this reason.

Safe for everything downstream because both places that count people filter to Human nodes
explicitly: `affectedUserIds` in the Pre-Publish Summary, and the "this human step has no owner"
blocker. The canvas likewise draws an owner line only for Human nodes.

## ADR-121 — A passed test is not a condition of activation

**Prompt 24.** Readiness gates activation; a passing test does not.

The source document makes _Activate_ conditional on readiness — setup complete, an approved
published Skill behind the work, a usable connection where one is needed — and says nothing about
having tested first. Adding that gate would have blocked work the client never said to block.

Instead the absence of a test, and a failed one, are **Warnings** on the readiness panel, and the
activation audit event records `testedBeforeActivation` and `lastTestPassed`. A reviewer can see
that an agent went live untested rather than having to infer it. The test result itself always
records whether a real provider was involved, and the database refuses a result that will not say.

## ADR-122 — `Run Now` has no route until the run engine exists

**Prompt 25.** The registry reports `RunNow` and `OpenRuns` in an agent's `actions` — the status
genuinely permits them — but serves no endpoint for either, and the screen disables both with the
reason.

A route that accepted "run now" and queued nothing would leave a caller unable to distinguish a
silent no-op from a successful start, and an operations person unable to tell whether their agent
is working. That is worse than a missing route, which fails loudly and honestly. An e2e test
asserts the boundary (`POST .../run` answers 404) so the gap is recorded rather than assumed.

The next prompt adds the engine and the routes; nothing here has to be undone for it.

## ADR-123 — Health and usage report absence, never a plausible figure

**Prompt 25.** `health.successRate` and every `usage` figure are `null` until real data exists,
and `hasRunData` / `hasData` say which.

A zero-valued success rate on an agent that has never run reads as total failure. A zero cost
reads as "this agent is free". Both are claims, and both are the cells an operations person would
trust without checking. `emptyEngineAgentHealth` exists so no caller invents a different empty
shape, and it carries a note saying in words what the numbers do and do not cover.

The registry screen follows the same rule: Health renders "Unknown", not a green badge, and Cost
renders an em dash. This is a deliberate departure from the prototype, which showed a health badge
and a cost for every row.

## ADR-124 — Approval before activation, and what "where required" means

**Prompt 25.** `versionActivationNeedsApproval` decides it, from three triggers, all about reach
rather than taste:

- the draft adds a **tool category** the agent cannot use today;
- it **widens memory** — a mode that starts keeping information beyond the run it was gathered in;
- **more than one objective** relies on the agent, so the change is not local to one of them.

A **narrowing** change needs no approval. Requiring permission to reduce an agent's reach would
discourage exactly the edits a company should be free to make immediately, and a test pins that
(`needs no approval to narrow memory back again`).

Where approval is required, the activator may not be the approver. Without that, the requirement
is decorative — the same four-eyes reasoning as the reward payouts at Prompt 19A.

The decision is computed when the draft is created and **stored on the row**, so a reviewer reads
exactly the answer the service will enforce, and the freeze trigger protects it once published.

## ADR-125 — The declared memory mode follows the version in force

**Prompt 25.** Activating a version copies its `memoryMode` onto the agent.

Two places could hold this — the agent, or its configuration — and letting them disagree would
mean the registry says one thing about what an agent may remember while the configuration
governing its runs says another. The version is the source of truth because it is immutable and
cited by runs; the agent's column is the fast read the registry needs, kept in step at the one
moment it can change.

A version written before memory mode existed reads as `CurrentRunOnly`, which is the safe
direction to guess in.

## ADR-126 — The queue is a seam, and BullMQ is what ships

**Prompt 26.** `RunQueue` is an abstract class with two implementations: `BullMqRunQueue` (Redis,
selected whenever `REDIS_URL` is set) and `InlineRunQueue` (single process, runs the handler on the
spot).

Two things had to be true at once. The approved architecture requires BullMQ on Redis, and it
ships. But the engine's behaviour — thirteen states, idempotency, retry classification, the
dead-letter path — has to be testable deterministically inside a suite that runs a thousand other
things. A test that needs a broker up, a worker polling and a sleep to observe a state change is a
test that will be flaky for ever.

`InlineRunQueue` is deliberately _not_ a fake that records calls: it genuinely performs the run, so
the engine's contract (enqueuing leads to execution) is exercised rather than asserted. What is
left uncovered is the wire, which belongs in an integration check.

`RunQueue.isDurableTransport` is reported by the runs endpoint, so nobody has to guess whether
their deployment's queue survives a restart.

## ADR-127 — Retries belong to the engine, not to BullMQ

**Prompt 26.** `BullMqRunQueue` sets `attempts: 1`, switching BullMQ's own retry machinery off.

BullMQ has an attempt counter and a backoff curve; so does the engine, driven by the company's
`runs.max_attempts` and a classification of the failure. With both in charge a run would be
attempted the product of the two, not the number the company configured. So the queue's opinion
about retrying is turned off rather than merged, and the engine re-enqueues deliberately with its
own delay.

The classification matters more than the curve: retrying a permission error wastes attempts and
delays the exception a person needs to see, while not retrying a provider timeout turns a blip
into a failed job. An **unclassified** throw is treated as retryable, because a bug that always
throws then burns its bounded attempts and dead-letters visibly, whereas treating it as terminal
would make the first transient fault permanent.

## ADR-128 — Live progress is published after the row is written, never before

**Prompt 26.** `RunProgressGateway` is transport-free and every event it publishes has already
been committed to `agent_run_events`.

The architecture is explicit: "WebSockets carry live updates but never replace durable API state."
Two consequences are enforced rather than intended. A client that acted on a state the database
then refused would be acting on something that never happened — so publication follows the write.
And a subscriber that throws cannot fail the run reporting progress: the state is already
committed, and losing the animation is acceptable where losing the work is not.

Keeping the socket transport out of this class also means a test can assert that a run reported
progress without a socket server, a client library or a sleep. Fan-out is per company by
construction: a listener is registered against a tenant id and never appears in another's list.

## ADR-129 — A business cron, not a general one

**Prompt 26.** `parseBusinessCron` accepts `minute hour * * day-of-week` with `*` and comma lists,
and refuses everything else with its reason.

A full cron expression can say "every seven minutes between 3 and 4 AM on the 13th". That is not a
business schedule, and supporting it would let a schedule bypass the working-day and holiday rules
this scheduler exists to enforce. Day-of-month and month must therefore be `*`.

The company calendar has the final say regardless: a schedule that names Saturday explicitly still
does not run on a Saturday the company does not work, and never on a holiday. Everything is
evaluated in the company's timezone, because "Monday" means the company's Monday — and holidays
are stored as dates rather than instants for the same reason.

An expression outside the subset is **reported**, not approximated. A schedule that quietly never
fires is the worst outcome available: the company believes an agent is running and it is not.

## ADR-130 — A retry is an attempt on one run; a rerun is a new run

**Prompt 26.** `Retrying → Reserved` keeps one row with an incrementing attempt. Re-running a
finished run creates a new row with its own idempotency key, and every terminal state leads
nowhere in the transition table.

One occurrence has one history, and its provider calls have to be attributable to one attempt.
Resurrecting a `Failed` run would give that row two attempt sequences and make "what did this run
cost?" unanswerable.

The retry passes back through `Reserved` rather than straight to `Running`, because the previous
reservation was released when the attempt failed — the next attempt takes a new one rather than
assuming the old one still holds. That is also why the engine clears `started_at` when reserving:
a resumed or retried run still carries the previous attempt's start time, and leaving it would put
the start before the reservation.

## ADR-131 — The locked rule is enforced in three independent places

**Prompt 27.** "The Executor Agent must never silently approve high-risk work or replace a
required manager decision." That is enforced by:

1. **The vocabulary.** `EXECUTOR_PERMITTED_ACTIONS` omits `Resolve` and `Dismiss`, so there is no
   word for the Executor closing something.
2. **The service.** `act()` refuses an Executor-initiated close, and refuses even a `Retry` or a
   `PauseAgent` on a `PermissionDenied` or `BudgetOrTokenLimit` exception — acting on those would
   be the Executor pressing on past a control that has just refused the work.
3. **The database.** `executor_never_closes_an_exception` refuses the row.

Three layers for one rule is deliberate, and it is the only rule in this codebase treated that
way. It is the boundary the entire oversight design rests on: an Executor that could close its own
findings would not be oversight, it would be a mechanism for making problems disappear. A future
caller that bypasses the service still cannot do it.

There is also **no route** through which a caller can act as the Executor.
`POST .../exceptions/:id/act` always attributes the action to the authenticated person, because a
parameter that could make the actor null would be a way around all three layers.

## ADR-132 — The four blocked run states map to four exception kinds

**Prompt 27.** `BlockedByBudget → BudgetOrTokenLimit`, `BlockedByConnection →
CredentialOrConnectionExpired`, `BlockedByPermission → PermissionDenied`, `BlockedByProvider →
ProviderOrToolUnavailable`.

This is why Prompt 26 kept them as four states rather than one with a reason code. Four different
people resolve them, and the source document names each: the budget's owner, the connection's
owner or an admin, a manager or admin by policy, and — for a provider outage — nobody, because it
clears itself. A screen that said only "blocked" would leave every one of them waiting for
somebody to guess whose problem it was.

`EXCEPTION_DEFAULT_OWNER` carries the document's words verbatim, and the Exception Center shows
them wherever routing could not name an individual. "Unassigned" alone would be an empty cell;
"Unassigned — connection owner or company admin" is an honest answer to whose it is.

## ADR-133 — The validation order is enforced, not documented

**Prompt 27.** `concludeValidation` runs the client's three stages in order and stops at the first
that settles the matter.

The ordering is the substance rather than a preference:

- A **failed deterministic check ends it**, and the AI evaluator is not consulted. A definite rule
  has already answered, and asking a model to second-guess it would turn a schema violation into a
  matter of opinion — as well as spending a provider call to do so.
- A **configured high-risk action is `Deferred`, never `Passed`**, until a person has decided,
  however confidently the first two stages agreed. `Deferred` is a first-class verdict for exactly
  this reason: reporting it as passed or failed would be a lie in one direction or the other.

The AI stage **advises and does not veto**. A mock gateway produces plausible prose either way, so
treating its output as a rejection would have the mock failing real work; and an evaluator that
could not run is recorded as `NotApplicable` rather than as either a pass or a failure. Every AI
stage result carries `producedByRealModel`, and the human stage carries `null` — so "no model was
involved" and "a mock was" are never the same value.

## ADR-134 — An acknowledged exception still escalates

**Prompt 27.** `escalationDue` ignores `Acknowledged` when deciding whether the aging window has
passed.

Acknowledging is not fixing. If it stopped the clock, "I have seen it" would become a way to hold
something indefinitely, which is exactly how an aging queue becomes a queue nobody reads. An
exception that has already escalated does not escalate again, and a closed one never does.

The Executor escalates on its own — routing is what it is for — but **only where the exception has
an owner**. Escalating an unowned exception would be an escalation into the void; it stays open and
reports itself overdue, which the queue shows, rather than being marked "escalated" to nobody.

## ADR-135 — Only a provider outage self-clears, and even then only to Acknowledged

**Prompt 27.** `SELF_CLEARING_EXCEPTIONS` contains one kind, and the sweep moves such an exception
to `Acknowledged` rather than closing it.

A provider returning is not the same as the work that failed getting done. Closing it would be the
Executor deciding the consequence was dealt with, which is the locked rule again — so it records
that the cause has passed and leaves the judgement to a person. Marking any other kind as
self-clearing would be a route by which an exception ages out of a queue without anybody deciding
anything.

## ADR-136 — One approval table, and the type decides which permission governs it

**Prompt 28.** The client's constraint is explicit: approvals work "without duplicating separate
approval tables per module". So `approval_requests` — created at Prompt 23 with all eight
`APPROVAL_REQUEST_TYPES` already in its vocabulary — gained four columns rather than a sibling
table, and every domain raises rows through `ApprovalService.raise`.

What differs between types is not the row shape but **which module's `Approve` permission decides
it**, recorded in `APPROVAL_TYPE_MODULE`. An objective review or workflow publish needs
`objective:Approve`; an agent activation needs `agents:Approve`. Without that mapping a single
`approvals:Approve` grant would let whoever signs off a budget also publish a workflow.

Three types are governed by the generic `approvals` module instead, and that is a finding rather
than a preference: **nothing in `ROLE_TEMPLATES` grants `todo:Approve`, `executor:Approve` or
`users:Approve`.** The first version of the mapping pointed `WorkflowStepApproval` at `todo`,
`OutputApproval` at `executor` and `GuestAccess` at `users`, which made all three undecidable by
anybody — the request could be raised and every approver would be told their role does not include
Approve. `everyApprovalTypeIsDecidable` asserts against the real templates so that class of bug
cannot return.

## ADR-137 — Separation of duties stays in the authorization engine

**Prompt 28.** The Approval Engine contains no self-approval check and no four-eyes check. It
loads the row and hands `authorize` a `ResourceDescriptor`:

- `createdByUserId` — the requester, which is what makes the **mandatory platform-wide
  `NoSelfApproval` control seeded at Prompt 7** bite;
- `priorActorUserIds` — the distinct people who have already _decided_ (commenters excluded),
  which is what makes a `FourEyes` control bite.

Writing either rule again in the approvals code would have produced two answers to "may this
person approve this", and only one of them would have recorded a security event.

A consequence worth stating: every decision — approve, reject, send back — exercises the same
`Approve` action, so one control covers all three. Somebody who may not approve their own work may
not dispose of it by rejecting it either.

## ADR-138 — `FourEyes` in `approver_role_kind` is a control, not a role

**Prompt 28.** `STEP_APPROVAL_KINDS` is `['NotRequired', 'Manager', 'Head', 'FourEyes']`, and
Prompt 23 writes that value straight into `approver_role_kind`. So the column holds a `RoleKind`
_or_ the word `FourEyes`, which is not a role anybody holds.

Read as a role it would address the request to a role with no members and **deadlock every
four-eyes gate in the product**. `routingFor` therefore classifies it as its own routing kind —
addressed to any authorized approver, because the control is on how many distinct people must act
rather than on which one — and `requiredSodRule` turns it into an additional `SodPolicy` passed to
`checkSeparationOfDuties` through the new `AuthorizeInput.additionalSodPolicies`.

That parameter is additive only. A caller cannot pass a policy that relaxes a configured one: the
engine refuses on the first control that bites, and the mandatory platform baseline is always in
the list.

## ADR-139 — A decision is final; a correction is a new row

**Prompt 28.** `uboss_approval_decision_is_final` refuses any status change on a settled request,
refuses reopening one to `Pending`, and refuses rewriting who decided, when, or why.
`uboss_approval_decisions_are_append_only` refuses `UPDATE` and `DELETE` on the history — with no
escape-hatch session variable, unlike the freeze triggers elsewhere.

So a sent-back request is corrected by raising a **new** request pointing back through
`supersedes_id`, and `one_resubmission_per_superseded_approval` allows exactly one, because two
live requests both claiming to replace the same item would give one piece of work two independent
verdicts.

Enforced in the database rather than the service because a service can be bypassed by the next
prompt and a trigger cannot. Note the FK is `NO ACTION`, not `SET NULL` (ADR-064): nulling a
composite FK nulls `tenant_id` too and would strip the row out of its own tenant.

## ADR-140 — Delegation moves routing, never authority

**Prompt 28.** `approval_delegations` carries no permission columns of any kind. A delegate passes
the same module check and faces the same separation-of-duties controls: somebody who cannot
approve agent activations does not gain that power by being delegated to, and somebody who raised
a request cannot decide it by having it delegated to them.

The window is bounded to 92 days by a check constraint, matching `MAX_DELEGATION_DAYS`. An
open-ended delegation is indistinguishable from a permanent grant, and the client asked for
_out-of-office_ cover — beyond a quarter it is a reassignment of authority and should be made as
one so that it is visible as one. Revocation is immediate rather than at the end date, because
somebody who returns early means now.

Where several delegations cover the same moment, the **more specific wins**: a type-scoped
delegation beats a blanket one, because "budget overrides to A, everything else to B" is a real
arrangement and the narrower instruction is the more deliberate. Ties break on the most recently
created, so re-delegating supersedes rather than becoming ambiguous.

## ADR-141 — Escalation moves attention, never the verdict

**Prompt 28.** `escalateAged` writes `escalated_at` and `escalated_to_user_id` and raises an
`Overdue` notification. There is no code path, and no configuration, by which a request is
approved, rejected or expired because a deadline passed. An approval that happens because nobody
looked is not an approval — the same locked rule the Executor Agent lives under.

Only genuinely `Overdue` requests escalate, and only once. `approvalEscalationDue` refuses on age
alone, because escalating everything old trains people to ignore escalations, which is how a queue
with an escalation policy ends up worse than one without. A request with **no due date never
reports itself overdue**: it can be old, but calling it late against a deadline nobody set would be
an invention and would make the queue's most urgent colour meaningless.

Where it escalates _to_ closes the gap Prompt 27 left open — the Executor's escalation routed back
to the existing owner, which is a loop. This walks one step up the reporting hierarchy from
whoever was expected to decide, and where there is no step up it escalates to **nobody** and says
so, rather than inventing a recipient.

## ADR-142 — Permissions are evaluated outside the tenant transaction

**Prompt 28.** `ApprovalService` loads in a short transaction, evaluates `authorize` outside it,
then writes in a second. Not a style choice — a bug fix.

`authorize` records a security event when a separation-of-duties control bites, and that is a
platform-plane write which `runAsPlatformOperation` correctly refuses to escalate out of an open
tenant transaction. Evaluating inside one logged "the security trail now has a gap" and left the
table empty: an attempted self-approval, silently unrecorded. The same applies to `contextFor`,
which reads the inherited platform policy rules, so callers resolve the context before opening a
transaction and pass it in.

The window between the check and the write is closed by the database, not by hope:
`uboss_approval_decision_is_final` makes a second verdict impossible whatever races.

## ADR-143 — Activation cites an approval; it no longer names an approver

**Prompt 28.** `EngineAgentService.activateVersion` took `approvedByUserId` at Prompt 25 and
trusted it. Nothing behind it was ever checked, so anybody holding `agents:Publish` could activate
a reach-widening version by naming a colleague who had never seen it — the four-eyes requirement
was satisfied by typing a uuid.

It now takes `approvalRequestId` and verifies four things: the request exists, its type is
`AgentActivation`, its `subjectId` is _this_ version, its status is `Approved`, and its
`decidedByUserId` is not the person activating. `requestActivationApproval` creates it. Per
version rather than per agent, because what is being judged is a specific impact analysis against a
specific configuration in force; an approval carried over from a previous version would be an
approval of something else.

Worth recording: for this type the four-eyes guarantee turns out to be **structural**. Raising the
approval needs `agents:Publish` and deciding it needs `agents:Approve`, and no built-in role
template holds both — the client's Approve & Assign boundary again.

## ADR-144 — A caller may name a logical profile and nothing else

**Prompt 29.** `ModelRequest` gained a required `profile: LogicalModelProfile` and gained nothing
else. There is no model name, no provider, no temperature, and no default for the profile.

Required rather than defaulted, deliberately. A default would let a caller stay silent about
whether its work needs a planner or a fast model, and the gateway would have to guess — and a
guess made once inside a helper becomes the routing for half the product. Making it required
forced all five existing call sites to declare one, and each maps to a sentence in Technical
Architecture §18 rather than to a preference: objective analysis is `OBJECTIVE_PLANNER`, the
Executor's validation is `EXECUTOR`, agent work and both agent tests are `AGENT_STANDARD`.

`LOGICAL_MODEL_PROFILE_SPEC` transcribes §18's table verbatim in `gatewayBehaviour`. The
machine-readable fields beside it are a reading of that sentence, and two are judgements worth
naming: "conservative fallback" became `SameCapabilityOnly`, and "explicit budget/approval
guardrail" became `NoFallback`.

## ADR-145 — Three approval types aside, `AGENT_FAST` and `HIGH_REASONING` have no caller yet

**Prompt 29.** Both are configured, routable and tested, and nothing in the product selects them.
Recorded rather than papered over: forcing a caller onto `AGENT_FAST` to make the profile look used
would be choosing a cheaper model for work nobody has decided is low-risk, and `HIGH_REASONING`
needs the budget guardrail Prompt 30 builds before anything should route to it.

## ADR-146 — `MigrationRequired` refuses new work; `Deprecated` does not

**Prompt 29.** §18 names three lifecycle states and the difference between the last two is the
reason there are three rather than a boolean.

`Deprecated` still answers. Existing configuration keeps working, so deprecating a model does not
break running Objectives. `MigrationRequired` is refused outright by `routeLogicalProfile` — a
model whose provider has announced removal must stop being selected **while there is still time to
move**, not on the day it disappears.

`mayMoveLifecycle` is forward-only with one exception: `MigrationRequired` may step back to
`Deprecated`, because a provider withdrawing a removal notice is a real event and the alternative
is re-registering the model and losing its history. Nothing returns to `Active`: a model that
needed migrating is re-approved deliberately rather than by relaxing a state.

## ADR-147 — Pricing is versioned and immutable, and a call cites the version that priced it

**Prompt 29.** `pricing_versions` refuses `UPDATE` by trigger, and `publishPricing` supersedes the
current version rather than editing it. `model_gateway_calls.pricing_version_id` is required
whenever a cost is recorded — `a_priced_call_cites_its_pricing_version` — because a cost with no
cited price is a number nobody can check.

The consequence is the point: a price change cannot retroactively restate what a Run cost, and
Prompt 30's reconciliation has something stable to reconcile against. Prices are per **million**
tokens in integer minor units, because a per-token price in minor units rounds to zero for every
model in existence, and `usageCostMinorUnits` rounds **up once at the end** so a long run of small
calls cannot bill less in total than it consumed.

`cachedInputPerMillionMinorUnits` is nullable and null means "this provider does not price cached
input separately" — those tokens are then billed at the full input rate. Zero would have made
them free, which is a different and wrong claim.

## ADR-148 — A company's own routes override the platform defaults rather than merging with them

**Prompt 29.** `RoutingModelGateway.resolve` looks for the company's routes and, finding any, uses
_only_ those. Merging would mean a company that configured BYOK for its planner silently kept the
platform model as a fallback — which is the opposite of what choosing BYOK means, and it would
send that company's planning data to the UBoss account it deliberately opted out of.

A company with no routes of its own inherits the platform defaults, which is how UBoss Managed
works with no second code path.

## ADR-149 — The adapters that cannot run are registered anyway

**Prompt 29.** All four adapters are in the module: mock, Anthropic, OpenAI and custom. The middle
two are implemented against their real APIs — request shape, response parsing, usage extraction,
request id — and refuse with `ProviderNotConfiguredError` when no credential is present, which is
the case in every environment today.

Registering them is what makes **"no provider is configured" a fact the gateway reports** through
`usesRealModel`, rather than something a reader infers from an absence. A screen can then warn that
output will be mocked before offering an AI action.

`CustomProviderAdapter.canReachProvider` was `true` at first, reasoning that a custom profile
carries its own endpoint so reachability is a property of the row. The reasoning was right and the
answer was wrong: `usesRealModel` is the union across adapters, so a `true` there made an
installation with no provider at all claim it could reach one. It reports `false`, and whether a
_particular_ endpoint answers is what Test Connection establishes per profile.

## ADR-150 — Usage is measured or absent, never estimated

**Prompt 29.** A custom provider profile cannot be saved without a usage mapping — where in its
response the token counts live — enforced by `customProviderProblems` and by
`a_custom_provider_maps_its_usage`. Without it the gateway would have to estimate what it had just
spent, and an estimate recorded where measured usage belongs is the specific fabrication the
client's rules forbid and the thing that would make Prompt 30's reconciliation meaningless.

Where an adapter reports nothing, the call is recorded with zeros and no cost. `Unroutable` and
`Failed` calls are recorded too — "we could not route OBJECTIVE_PLANNER for two hours" is the most
useful row in the table — and `an_unroutable_call_reached_no_model` stops a routing failure being
counted against a provider.

`a_mock_call_has_no_provider_request_id` closes the last gap: a fabricated request id would let
somebody raise a support ticket about a call that never left the building.

## ADR-151 — `PROVIDER_ADAPTERS` lives with the abstraction, not with the module

**Prompt 29.** A small thing with a sharp edge. The injection token was first declared in
`model-gateway.module.ts`, which imports `provider.service.ts`, which needs the token — a cycle
ESM resolved as `ReferenceError: Cannot access 'PROVIDER_ADAPTERS' before initialization` at
import time, failing the whole suite before a single test ran.

It now lives in `provider-adapter.ts` beside the `ProviderAdapter` it lists. The general rule
worth keeping: a token belongs with the thing it identifies, not with the module that binds it.

## ADR-152 — The test reset clears and re-seeds provider configuration

**Prompt 29.** The platform provider baseline is migration-seeded, so the reset's first version
deleted only tenant-owned rows in order to leave it standing. **The tests caught that as wrong.**
A test that deprecates the platform fast model, or deletes the platform `EXECUTOR` route to prove
an unroutable call is recorded, leaves that change in place for every later test — and it surfaced
as "no model is configured" in an unrelated test, which is exactly the order-dependence the reset
exists to prevent.

So `resetTestDatabase` now clears all four configuration tables and writes the baseline again. The
ids and values are duplicated from the migration on purpose: if the migration's baseline changes
this must change with it, and a copy somebody has to update is more honest than a query that
silently adopts whatever it finds.

`pricing_versions` needed the standard `uboss.allow_history_truncate` escape hatch for that, which
is why `20260910133000` exists — and which also fixed a real application bug, since a cascade from
a deleted company provider model would otherwise have been refused by the immutability trigger.

## ADR-153 — The reservation is the safety, and the pre-run check is not

**Prompt 30.** §20 lists a "pre-run check" and an "estimate/reserve" step, and it is worth being
explicit about which one prevents the overspend: **only the reservation does.**

`check` is read-only and therefore advisory — by the time a caller acts on its answer another
agent may have taken the room it reported. It exists so a screen can grey out a button and so a
run can be refused before the work of preparing it.

`reserve` is the real control. Inside one transaction it takes `SELECT ... FOR UPDATE` on every
wallet in the hierarchy, **re-reads the balances inside that lock**, decides, and writes. Deciding
before the lock would be deciding against a balance somebody else may already have spent.

## ADR-154 — The lock order is the deadlock prevention

**Prompt 30.** `scopesToCheck` returns the budget levels outermost first, and that single ordering
does two jobs. It is the reporting order, so a refusal names the company budget rather than one
agent's limit. And it is the **lock** order: two transactions taking the same two rows in opposite
orders deadlock, and the only reason concurrent reservations here cannot is that every caller
locks in the same sequence.

A unit test pins that two callers with the same levels produce the same sequence. It looks like a
tautology and is not — it is what stops somebody "tidying" the function into a different order.

## ADR-155 — Two records: a mutable reservation and an immutable ledger

**Prompt 30.** §20 names "credit wallet/budget, reservation, immutable ledger" and all three
exist, because they answer different questions.

A **reservation** is state: held, then settled, released or expired. A **ledger entry** is an
event. Collapsing them would make "what has ever happened to this budget" unanswerable the moment
a reservation was released.

`Reserve` and `ReleaseReserve` entries are written even though they net to zero across a run.
Omitting them would make the balance unexplainable at any moment _during_ a run, and "why does
this say we have less than the sum of our spends" is the first question anybody asks.

The four reservation states are three terminal ones for a reason: **`Expired` is not `Released`.**
A released reservation is a run that finished cheaply; an expired one is a run the engine lost.
Without the distinction, "we are at 90% and nothing is running" is undiagnosable.

## ADR-156 — The balance is maintained, the ledger is the truth, and reconcile proves it

**Prompt 30.** `usedMinor` and `reservedMinor` are columns rather than sums over the ledger.
Deriving them would mean summing the whole ledger inside every pre-run check and — worse — there
would be **no single row to lock**, so two concurrent reservations could each sum the same ledger
and each decide there was room.

The cost is that they can drift. §20 asks for a reconciliation job by name, and `reconcile`
replays each wallet's ledger and compares. It **reports and does not correct**: overwriting the
stored balance would destroy the only evidence that a write happened outside the engine or that
the engine has a bug.

## ADR-157 — The hard stop is strictly past the ceiling, and compared in minor units

**Prompt 30.** A real off-by-one, found by the concurrency tests rather than by reading the code.

The first version hard-stopped at `percentAfter >= hardStopPercent`, which refused the spend that
lands _exactly_ on the allowance — making the last slice of every budget unspendable. A company
that buys ₹10,000 of AI should be able to spend ₹10,000. "Block when the limit is reached" means
that once it _is_ reached the next call is refused, which is the same test one unit later.

It is also compared in **minor units, not percent**. Percent is floored for display, so a spend
landing on 100.4% reads as 100: a `>=` test would refuse a spend that fits and a `>` test would
allow one that does not. The ceiling in minor units is exact.

The approval threshold stays `>=`: crossing _into_ the band is what should ask a person.

## ADR-158 — Three controls stay three

**Prompt 30.** §20 has a warning that only notifies, an **approval threshold** where higher-cost
execution needs a person, and a **hard stop** that blocks. `SPEND_DECISIONS` keeps all three.

Collapsing approval into blocked would make an expensive-but-authorised run impossible; collapsing
it into allowed would make the threshold decorative. So the gateway treats `NeedsApproval` as
**permitted**: the reservation stands, the call proceeds, and the caller is told. Asking the person
is the Approval Engine's job (Prompt 28) and the gateway has no way to do it — pretending
otherwise would put an approval decision inside a component that cannot make one.

## ADR-159 — An overspend is recorded, never capped

**Prompt 30.** A provider's actual usage can exceed the estimate that was reserved. `settle`
charges what it actually cost, `remainingMinor` goes negative, and `used_minor` is deliberately
**not** bounded above by a CHECK.

Capping would make the ledger disagree with the provider's own invoice. The next call's hard stop
is where an overspend is caught, and that is the right place: the money is already gone.

## ADR-160 — Redis is not in the cost path

**Prompt 30.** The prompt permits Redis to assist with locking or counters and states that
**PostgreSQL is the source of truth**. It is not used.

A correct `SELECT ... FOR UPDATE` on the row that already holds the balance is simpler than a
distributed lock, and a Redis counter that drifted from the ledger would be a second source of
truth with no reconciliation story — the exact failure `reconcile` exists to catch, reintroduced
one layer up. If throughput ever demands it, `reserve` is the seam and the ledger stays the
arbiter.

## ADR-161 — The whole flow lives in the Model Gateway

**Prompt 30.** Check, estimate, reserve, settle and release happen inside
`RoutingModelGateway.complete`, not in the five services that call it.

That is only possible because of the Prompt 29 locked rule that **every** AI call goes through one
seam — and it is what that rule buys. Five call sites gained cost governance without one of them
being changed, and a sixth added later gets it for free. Putting the flow in the callers would
have meant five chances to forget it, and forgetting it is silent.

The cost engine is an **optional** collaborator so a unit test exercising routing need not stand up
wallets and notifications. When absent the gateway behaves exactly as it did at Prompt 29.

## ADR-162 — A notification can never fail a money movement

**Prompt 30.** Found by the concurrency tests: twenty simultaneous reservations each crossed the
same threshold and each raced to insert the same deduplicated notification. All but one hit the
unique index, the error escaped, and reservations that had already been written correctly failed.

`notifyThreshold` now swallows and logs. The duplicate _is_ the deduplication working, and more
generally telling somebody their budget is low is strictly less important than the budget being
right. It was already outside the wallet transaction for the same reason; this finishes the job.

## ADR-163 — A budget refusal is a blocked run, not a retryable failure

**Prompt 30.** `BudgetRefusedError` is a distinct type, and the run engine maps it to a `Terminal`
failure in the `BlockedByBudget` state.

Retrying would hammer a hard stop until the attempts ran out and then dead-letter, which tells
nobody anything. `BlockedByBudget` is a state Prompt 27's Executor already turns into a
`BudgetOrTokenLimit` exception owned by whoever holds the budget — so the existing oversight
machinery picks it up with no new vocabulary.

## ADR-164 — A level with no budget defers; it does not mean zero

**Prompt 30.** Only the company wallet is created on demand. A department or objective with no
wallet has no budget of its own and defers to the level above.

Creating an empty wallet for every level a spend touches would turn "not configured" into "a
budget of zero", which hard-stops everything — and the hierarchy would be unusable until every
level had been filled in, which is not how a company adopts one.

---

## ADR-165 — The commercial terms are configuration, because the documents say "define"

**Prompt 31.** UBoss_Final_1 line 1048 and Technical Architecture §26 both require monthly reset,
carry-forward, top-up expiry, refunds/promotional/manual adjustments, plan change mid-cycle,
payment failure and negative balance to be **defined, configurable and auditable**. Neither states
a value for any of them.

That is the whole shape of this prompt. A commercial term is the client's to set, so each is a
column on `company_credit_policies` with a documented default, and `CreditService` reads the
policy rather than deciding. Nothing here hard-codes a rule a contract would override, and a
change to any of them is audited with a reason.

The defaults are the conservative reading in each case:

- **`MonthlyReset`** — the provisioned field is already `monthlyAllowanceMinor`, so not resetting
  would contradict its own name.
- **`Forfeit`** — the strict reading of a monthly allowance. Carrying forward by default would
  quietly hand a customer more than their contract says, which is harder to undo than the reverse.
- **A purchased top-up does not expire.** The one default that could not be defended otherwise:
  expiring money somebody paid for, unasked, is not a safe default.
- **`BlockImmediately`** — the safe direction the moment a balance goes negative.
- **`NextCycle`** — a plan change that does not disturb a cycle already in progress.

## ADR-166 — Credit arrives in lots, not as a single number

**Prompt 31.** A top-up creates a `CreditGrant` with its own effective date and optional expiry.

**Top-up expiry forces this.** "The ₹40,000 from March expires on 31 March" cannot be expressed by
a single `allowance_minor`, because expiring it means knowing which part of the allowance it was.
Carry-forward and plan changes then fall out of the same model: carrying forward is a grant that
survives a reset, and a plan change is a grant added or an adjustment applied.

A grant does **not** replace the wallet's running total — it explains it. The allowance still
moves only through `CostEngineService.adjustAllowance`, which writes the ledger entry, so
`reconcile` (ADR-156) stays meaningful.

A grant's amount, currency, source and effective date are fixed by trigger. Its _life_ can change
— revoked, written off — but an editable amount would move a company's allowance with nothing
explaining the movement.

## ADR-167 — A future-dated grant is recorded and not yet spendable

**Prompt 31.** `grant` writes the row always and moves the allowance only when
`effectiveFrom <= now`. That is what makes a future-dated approval safe: the company can see the
credit coming and cannot spend it early, which is what an agreed effective date means.

It also makes the resume rule exact. The approved wording is "eligible runs blocked only by
exhausted allowance can resume **after effective balance**", so a future-dated approval resumes
nothing — asserted directly, because the obvious implementation resumes on approval.

## ADR-168 — The company asks and Finance decides, on different planes

**Prompt 31.** `/tenants/:tenantId/credits` has no route that approves anything, and
`/platform/credits` is `@PlatformOnly`. A company approving its own credit request would be
setting its own commercial terms, and the review is what makes a request a request.

The same reasoning puts the **policy** on the platform plane. A company that could set its own
carry-forward policy could grant itself credit it had not bought — the same hole as
self-approval wearing a different hat.

The company UI reflects this by offering **no decision control at all**, not even a disabled one:
a greyed-out Approve button implies the permission exists somewhere in that workspace.

## ADR-169 — "Adjust Amount" is an approval, not a fifth state

**Prompt 31.** The prompt lists four Finance actions — review, Approve & Add Credits, Adjust
Amount, Reject with reason — and `CREDIT_REQUEST_STATES` has four values of which only two are
decisions.

"Adjust Amount" produces the same outcome as an approval: an approval for the amount Finance
names. `approvedMinor` is already recorded separately from `requestedMinor`, so a fifth state
would mean two rows could describe the same thing and every report would have to remember to
count both. The audit event records `adjusted: true` so the difference is answerable without
arithmetic.

## ADR-170 — Reallocation is a pair of movements against uncommitted budget

**Prompt 31.** §20: reallocation happens "without purchasing new credits; **this does not
increase the total commercial allowance**".

So it is always two `Reallocation` ledger entries of equal and opposite sign, and the source must
have the amount **uncommitted** — `remainingMinor`, not `allowanceMinor`. Moving budget that is
reserved or already spent would let the same money be spent twice: once by the run holding it and
once wherever it was moved to.

The movements are ordered out-then-in deliberately. If the second fails, the company is left with
_less_ available than it had — visible and correctable — rather than more, which would be
allowance from nowhere.

## ADR-171 — A revocation may take the balance below what was spent

**Prompt 31.** `revokeGrant` is the "payment failure after top-up" case. It reduces the allowance
by what the grant added, and that can leave `remaining` negative — the company spent credit it
turned out not to have paid for.

Refusing to revoke because the money is gone would leave a company holding credit it never
bought. Recording it and letting the negative-balance policy decide what happens next is the
honest outcome, and it is why `used_minor` has no upper bound (ADR-159).

It is recorded as a **signed `Adjustment`**, and this was wrong in the first cut. The reasoning
that failed was "a refund is money going back where it came from, and a finance report should be
able to separate that from a correction" — which reads well and contradicts the ledger's own
vocabulary. `LEDGER_EFFECT` (Prompt 30, §20) says a `Refund` reduces `used_minor`: money coming
back _after a charge_, such as a provider credit. Withdrawing an unpaid top-up takes back
allowance that was **never spent**, so a `Refund` would have left the allowance intact and written
off real spend instead, and an `Expiry` would have claimed the credit lapsed rather than that the
payment failed. Only `Adjustment` and `Reallocation` carry a signed amount, and a withdrawal is a
correction. The test asserts the negative `Adjustment` _and_ that no `Refund` was written.

Promotional credit is an `Adjustment` and not a `TopUp` for a related reason — counting it as a
top-up would overstate revenue.

### The rule this produced

**Direction belongs to the ledger kind; the amount is a magnitude.** `adjustAllowance` now moves
the wallet by `LEDGER_EFFECT[kind].allowance * amountMinor` instead of by the raw delta, refuses a
negative amount for any kind outside the signed pair, and refuses a kind that does not move an
allowance at all. Before that it wrote an `Expiry` as a negative number and moved the balance the
same way — so the database's `ledger_amount_sign_matches_its_kind` refused the row, and had it not,
`replayLedger` would have read the entry back as an _increase_ and `reconcile` would have reported
drift of twice the amount with nothing to explain it. The maintained balance and the replayed
ledger have to be the same arithmetic, which is the whole reason `reconcile` means anything.

## ADR-172 — Only a run blocked by budget resumes

**Prompt 31.** `mayResumeAfterTopUp` refuses every state but `BlockedByBudget`, and the resume
moves a run to `Queued` rather than running it.

Both halves come from the approved wording: "**blocked only because** the credit/allowance was
exhausted" and "**subject to all other permissions, approvals and limits**". Resuming a run
stopped by a permission failure because somebody bought credits would be a credit purchase
quietly clearing a governance decision; re-queueing rather than running is what makes "subject to
all other limits" true in practice, because every check happens again when it is picked up.

`reservedAt` and `startedAt` are cleared on resume — a stale reservation timestamp would fail
`run_started_after_it_was_reserved`, which is the Prompt 26 bug repeating.

## ADR-173 — No payment is taken anywhere in this flow

**Prompt 31.** The prompt says "Request / Buy More Credits ... billing choice where enabled", and
no payment provider is integrated or approved.

`BILLING_CHOICES` records an **intent** so Finance knows what was agreed; `reference` is where
Finance records the invoice they raised in whatever system actually bills. `Unspecified` exists
because "where enabled" means a plan may not offer the choice, and forcing one would make the
field a lie on those plans.

The API note and the request drawer both say this in words. A screen that implied a card was
being charged would be the fabrication the client's rules forbid, in a place where it would cost
somebody money.

---

## ADR-174 — The Security Center composes; it stores nothing

**Prompt 32.** §27.1 asks for "a Security view for MFA/SSO coverage, admin accounts, guests,
active sessions, suspicious/failed logins, high-risk actions, exports, support access and security
events with permission-aware drill-down". Every one of those facts is already recorded by the
module that owns it: `security_events` for authentication, access and support; `sessions` for who
is signed in; `tenant_memberships` for guests and their expiry; `connection_tool_grants` for what
an Engine Agent may do; `mfa_factors` and `sso_connections` for coverage; `break_glass_requests`
for support access; `role_assignments` for who administers.

So the Security Center is a **view**, and this prompt added no table.

That is the security property rather than a preference for tidiness. A Security Center with its
own copy of the evidence gives an investigation two versions of the truth and a first question of
which to believe. Worse, a derived table would not inherit what protects the originals: the
application role holds **no UPDATE or DELETE grant at all** on `audit_events` and
`security_events`, on top of the append-only triggers — so PostgreSQL refuses an alteration before
a trigger would ever run. A convenience table beside them would be editable, and would become the
easiest thing in the product to tamper with.

It also settles "normal tenant admins cannot edit/delete audit/security records" without adding a
permission: there is nothing to permit. The tests assert it by attempting an update and a delete
as the application role and watching the database refuse.

## ADR-175 — Direction of view: seven purpose-shaped reads, not one filtered list

**Prompt 32.** The audit trail already offers a flat, filterable list of everything. The prompt
asks for seven named views, and they are not seven saved filters over that list — three of them do
not read events at all:

| View                       | Source                                                    | Why                    |
| -------------------------- | --------------------------------------------------------- | ---------------------- |
| Authentication events      | `security_events` where category ∈ {Login, Session, Risk} |                        |
| Active sessions            | `sessions`, live, for this company's members              | **State, not history** |
| Admin & permission changes | `security_events` where action ∈ 18 named actions         | `Access` holds fifty   |
| Guest access & expiry      | `tenant_memberships` where type = ExternalGuest           | **State**              |
| Data exports               | `security_events` where action ∈ the three export actions |                        |
| Agent high-risk actions    | `connection_tool_grants` in the five high-risk categories | **State**              |
| Support & break-glass      | `security_events` where category = Support                |                        |

Two decisions inside that table are worth stating.

**`Access` is never a category filter.** Fifty of the 102 actions are classified `Access`, so
"show me the access events" answers a question nobody asked. The two views that need access
records name the actions they mean — eighteen for permission changes, three for exports — and a
new export path has to be added to that list. That is a deliberate cost: an export nobody can see
is precisely the failure the Data Exports view exists to prevent, so the list is short enough to
notice and the test asserts the Security Center's own export is in it.

**Three views show state, and are not dressed as events.** A live session has no "when did it
happen" — the answer is "it still is". Presenting one as an event row would put a timestamp column
on a fact that has no timestamp, and would imply a correlation id that does not exist.
`viewHasCorrelationIds` is exported so the UI asks the server rather than guessing, and a test
pins it.

### `Session` events were nearly invisible

A test caught this before the screen existed. With Active Sessions reading live state and
Authentication Events filtering `Login` and `Risk`, the `Session` category — sign-outs,
logout-all-devices, session expiry, both admin revokes — appeared in **no view at all**. A company
could not have seen that somebody had been signed out. `everySecurityCategoryIsReachable` now
fails the build if any recorded category has nowhere to appear, and Authentication Events carries
`Session` too. The fix was one line; finding it was the test's doing.

## ADR-176 — A tone is derived from the company's own configuration, never from a threshold

**Prompt 32.** Each metric carries a `tone` — `neutral`, `good`, `watch` or `bad` — and the
approved documents state **no target for any of the eleven figures**. So the rule is that a tone
either follows from the company's own policy or it is not a judgement at all:

- **MFA coverage below 100%** is `bad` only when `tenant_auth_policies.require_mfa` is set, `watch`
  while an MFA grace period is running, and `neutral` otherwise. A company that has not required
  MFA is complying with its own policy, and a red badge would be UBoss inventing a rule it was not
  given.
- **SSO** reports a word, not a count: `RequiredButNotConfigured` is `bad` because a company that
  requires SSO with nothing enabled cannot sign in — which the Security Center should be the first
  place to say, and "0" does not say it.
- **Guests** are `bad` when any access has lapsed or has no end date, because §23 requires guest
  access to be expiry-capable and both cases defeat it.
- **Failed logins and suspicious events** are `watch` at one and `watch` at five hundred. There is
  no threshold because none was given, and a company's tolerance for three failed logins depends on
  its size. The screen's job is to surface, not to grade.
- **A single Company Admin** is `watch`, with the caption saying "lockout risk" — that is exactly
  the situation §27.1's break-glass path exists for.

Counted figures are always captioned with their window, because "47 failed logins" is unreadable:
47 today is an incident and 47 this quarter is background noise.

## ADR-177 — Company-admin session revoke, and the person-level consequence

**Prompt 32.** Admin session revoke has been `@PlatformOnly` since Prompt 5, with the reason
recorded in the code: _"company-admin session revoke needs the role model, which arrives at Prompt
7"_. The role model has been in place for twenty-five prompts and §27.1 asks for admin session
revoke inside the company's own Security Center, so this closes it.

Two things the company route checks that the platform one does not.

**The session belongs to a member of this company.** `sessions` carries a `user_id` and **no
`tenant_id`**, because a session belongs to a _person_ — one sign-in, several workspaces. Without
a membership check, a company administrator could sign out somebody who has never worked for them,
by id. The refusal is deliberately the same message as a session that does not exist: telling an
administrator "that one belongs to another company" confirms the id is real.

**And the caller is told what they are doing.** Since the session is person-level, revoking it
signs that person out of UBoss entirely, including any other company they belong to. The
alternative — refusing to revoke the session of anybody with a second membership — would leave a
compromised session alive, which is worse. So it proceeds, the drawer says so in bold before the
button is pressed, the response returns how many memberships were affected, and the security event
records `signedOutOfCompanies` and `crossCompanyEffect`.

`security.session_revoked_by_company_admin` is a separate action from
`security.session_revoked_by_admin`. One is UBoss acting on a customer's tenancy and the other is
the customer acting on their own people; a single action for both would leave the trail unable to
answer "did UBoss sign our CFO out, or did we?" except by inference.

A reason is mandatory and not defaulted. Signing somebody out is a security act, the person it
happened to is entitled to an answer, and `admin_revoke` is not one.

## ADR-178 — Read, export and act are three grants

**Prompt 32.** The Security Center's permissions are all existing actions on `settings`, and
nothing here invents one:

- **Read** — `settings:Audit` at whole-company scope. `CompanyAdmin` and `Auditor` hold it;
  `Manager`, `Approver` and `Employee` hold it nowhere.
- **Export** — additionally `settings:Export`. Both, not either, for the reason
  `AuditQueryService` already gives: `Export` alone is granted to roles that export reports and
  have no business reading security history, and `Audit` alone is read access. A custom role with
  `Audit` and no `Export` can investigate and cannot remove the evidence, and a test builds exactly
  that role to prove it.
- **Revoke a session** — `settings:Administer`, because it is an act rather than a read. An
  `Auditor` holds `Audit` and `Export` and no write action anywhere, so an auditor cannot sign
  anybody out. That is the point of the role, and `mayRevokeSessions` tells the UI so the button is
  absent rather than present-and-refusing.

A narrower scope than `WholeCompany` is **refused, not narrowed** — the same rule the audit trail
uses. Security events carry no department, so there is nothing to narrow on, and returning "what a
department head may see" would mean returning everything.

## ADR-179 — What the agent high-risk view honestly shows

**Prompt 32.** The prompt asks for a view of "agent high-risk actions". The client defines the
category precisely (§21: "Delete, external bulk send, sensitive export, financial or production
changes"), and `HIGH_RISK_TOOL_CATEGORIES` has transcribed it since Prompt 16.

**But UBoss records no tool invocations, because no Engine Agent run performs an external tool
action.** Runs reach AI providers through the Model Gateway; tool execution against a connected
CRM or ledger is not built. So the view shows what an agent has been **permitted** to do — the
live and revoked `connection_tool_grants` in those five categories, with who granted them and why
— and says so on the view itself rather than in a document nobody reading the screen will open.

Revoked grants are shown deliberately: "who _used_ to be able to delete from our CRM" is a
question an investigation asks.

---

## ADR-180 — Data classification is its own module, introduced here and owned by Prompt 35

**Prompt 33.** §19 states the rule that forces the issue: _"Sensitive data classification controls
whether a memory record can be persisted."_ A memory policy cannot enforce a sensitive-data
restriction without a vocabulary of sensitivity, so Prompt 33 needs one.

But classification is not memory's property. **Prompt 35 owns Knowledge, Files and Data
Classification**, and §23 names the four classes for the whole product: _"Company can classify data
such as Public / Internal / Confidential / Restricted and apply stricter AI/tool policies to
sensitive classes."_ So `packages/types/src/classification.ts` exists on its own, where files,
knowledge sources, connections and exports will all reach it — rather than inside `memory.ts`,
which would leave Prompt 35 either importing from memory or declaring a second set of labels.

**A second set of labels is the specific failure this prevents.** Two orderings of "Confidential"
and "Restricted" in one product means a policy that is stricter in one module than another for no
reason anybody can explain.

Two decisions inside it:

- **The order is the contract.** Everything else is a comparison against
  `DATA_CLASSIFICATIONS.indexOf`, so no caller hard-codes "Confidential or higher" as a list that
  could fall out of step.
- **The default is `Internal`, not `Public`.** An unlabelled document is one nobody has thought
  about, and treating it as safe to leave the company is the wrong way to be wrong. It is
  deliberately not `Restricted` either: defaulting to the strictest class would block ordinary work
  and teach people to override the label without reading it, which is how a classification scheme
  dies.

## ADR-181 — A row per memory mode, and every number is configuration

**Prompt 33.** §27.1 requires that **for each mode** UBoss define retention, visibility, deletion,
cross-user/objective sharing limits, sensitive-data restrictions and offboarding behaviour — and
states no value for any of them. The same situation as Prompt 31's commercial terms, and the same
answer: a policy row with a documented, conservative default, read by the engine rather than
decided by it.

**A row per mode rather than columns on one row.** Four modes times six settings as columns would
be twenty-four columns whose names all end in a mode, and adding a setting would mean four more. A
row per mode is the shape the requirement has.

The defaults, with the reasoning:

| Mode               | Kept          | Visible to    | Up to        | On offboarding        |
| ------------------ | ------------- | ------------- | ------------ | --------------------- |
| Current run only   | 1 day         | the run       | Confidential | delete                |
| Objective memory   | 90 days       | the Objective | Internal     | transfer to successor |
| Agent memory       | 180 days      | the agent     | Internal     | keep, anonymised      |
| Approved long-term | until deleted | the company   | Confidential | keep, anonymised      |

**The substantive decision is the classification ceiling: nothing persists `Restricted` by
default, and only the ephemeral and approved modes may hold `Confidential`.** §19 makes
classification the control over persistence, and the strictest class is the one a company should
have to permit deliberately rather than inherit. The ephemeral mode may hold sensitive context
because it is the only way a run can work on a confidential document at all — and it is gone within
the day.

### What is _not_ configurable

`MEMORY_MODE_MAX_VISIBILITY` is a **ceiling, not a setting**. A company may narrow Agent Memory to
`SameObjective`; it may not widen Objective Memory to `SameAgent`, because §19's rule for that mode
is "visible only to same Objective scope" and a policy field that could contradict the approved
document would make the document advisory.

And there is no field anywhere for cross-tenant memory — see ADR-182.

## ADR-182 — "No cross-tenant memory" is structural, so it has no code

**Prompt 33.** §19 says _"Never use unrestricted cross-tenant or cross-user memory."_ The two
halves are enforced completely differently, and the difference is the point.

**Cross-user is a policy field**, because there is a legitimate case for it: `CompanyWide`
visibility under `ApprovedLongTermMemory` _is_ cross-user reading, and it is the mode whose name
says somebody approved it. So `allowCrossUser` exists, defaults to false in every mode, and is
refused by both the validator and a check constraint unless visibility is `CompanyWide`.

**Cross-tenant has no field, no flag and no code path.** `memory_records` is tenant-owned with
`FORCE ROW LEVEL SECURITY`, and `run_id` carries a composite foreign key including `tenant_id`
(ADR-064) — so a record cannot even _reference_ another company's run, let alone be read across
companies. A test proves the foreign key refuses it.

`memoryReadable` deliberately contains **no tenant check**, and that is a decision rather than an
omission. A visible `if (record.tenantId !== scope.tenantId)` would imply such rows can arrive,
which is the belief that leads to the one query somebody forgets to scope. §19 calls it "never",
and a `never` that appears as a setting is not a never.

## ADR-183 — A memory record carries the rule it was written under

**Prompt 33.** `memory_records.visibility` is copied from the policy **at write time**, not read
from the policy at read time.

A company narrowing Agent Memory from `SameAgent` to `SameObjective` must not retroactively change
what an existing record was written under — a read that joined to the current policy would do
exactly that, in both directions: tightening the policy would hide records an agent had been
relying on, and loosening it would widen records nobody reviewed. Carrying the rule on the record
is also what makes "why was this visible?" answerable months later.

The same reasoning puts `produced_by_real_model` on `ai_output_feedback` as a copy rather than a
join. A quality figure computed from that table alone can then never present mock output as a
provider's, and a report that joined to the run to find out would be one refactor away from
dropping the join.

## ADR-184 — A deletion is a deletion; the record of it survives

**Prompt 33.** Deleting a memory record **nulls its content and keeps the row**, with the
timestamp and a mandatory reason. Enforced by `deleted_memory_keeps_no_content`, so it cannot
become a tombstone with the data still in it.

Both halves matter. A vanished row makes "was our data deleted?" unanswerable, which is the
question a customer asks and an auditor follows up. A row that kept its content would mean the
deletion never happened, whatever the timestamp said. So the row survives with its scope, its
dates and its reason, and the content does not.

An **expiry does exactly the same thing**, because a record past its retention window that still
held its content has not expired in any sense a customer would accept.

## ADR-185 — Rating an output and changing what UBoss tests are two grants

**Prompt 33.** §27.1 says feedback "feeds Agent/Skill quality and evaluation workflows", and those
are two different things with two different costs.

**Quality is automatic.** A rating counts the moment it is given, and it needs `agents:Comment` —
the action for "has something to say about this work without changing it", which an Employee holds.
The person who did the work is usually the one who can tell whether the AI got it right, so
requiring a manager's grant would silence the best-placed reviewer.

**An evaluation case is not automatic.** It is a permanent assertion about how a Skill must behave,
and it will fail somebody's release six months from now. So promotion is a separate, permissioned
act, and only eligible feedback can be promoted — enforced by `only_eligible_feedback_is_promoted`.

### The gate was wrong, and a test caught it

The first cut gated promotion on `skills:EditDraft`. **`skills` is a platform module**:
`COMPANY_MODULES` does not contain it, because the reference UI puts "Skills & AI" inside Settings
as a section rather than a top-level module. So `skills:EditDraft` is a grant no company user can
hold, and the route was unreachable by everybody — a 403 for the whole product.

Prompt 17 had already settled the right answer when it built company Skill authoring: every change
to a company Skill is `settings:Administer`. Promotion uses the same gate. The separation the
prompt wanted is intact — an Employee holds `agents:Comment` and not `settings:Administer` — and it
is now one answer to "who may change a company Skill" rather than two.

`feedback.test.ts` now asserts the promote module is in `COMPANY_MODULES`, which is the check that
would have caught it before anything ran.

## ADR-186 — An evaluation case built from feedback is `HumanJudged`

**Prompt 33.** When feedback becomes a `skill_evaluation_case`, the assertion kind is
`HumanJudged`, and the alternatives were both wrong:

- **`ExactMatch`** fails on a better answer than the one the reviewer wrote.
- **`ContainsAll`** treats a sentence of prose as a list of required fragments.

Prompt 18 defined `HumanJudged` as _"a person judged it — recorded, never computed"_, which is
exactly the provenance of a case built from human feedback. Somebody has to look at the result, and
pretending otherwise would produce a regression gate that fails for the wrong reasons.

The case lands in the Prompt 18 tables, so the Skill's existing regression machinery picks it up.
A second dataset beside `skill_evaluation_cases` would mean two answers to "what must this Skill
do".

## ADR-187 — There is nothing to disable, and the product says so

**Prompt 33's own words:** _"Do NOT assume or automatically enable external provider model training
on company data."_ §27.1 puts it as "it is not assumed to train external provider models".

The strongest form of that is not a setting defaulted to off — a setting implies the capability
exists and somebody may turn it on. So feedback goes exactly two places, both inside UBoss: this
company's own quality figures, and this company's own evaluation cases. There is **no consent
field, no adapter parameter and no route** that could send a correction to a provider, and
`FEEDBACK_TRAINING_STANCE` says so in words the UI renders verbatim.

Two tests assert the _absence_: a unit test that the only exported name matching `/train/i` is the
stance constant itself, and an e2e test that the meta response contains no `trainingEnabled`,
`trainingConsent` or `allowTraining`. A later prompt adding a consent toggle fails here rather than
shipping.

## ADR-188 — Memory offboarding happens inside the offboarding transaction

**Prompt 33.** §27.1 asks for "offboarding behavior" per memory mode. It runs as step 8 of Prompt
13's `offboard`, inside the same transaction as the role revocations and the employment record —
because "roles revoked, memory still owned by a departed person" is a state nobody would notice and
nobody would fix.

Each record is handled under the policy for **its own mode**, so a company can delete personal
ephemeral context and keep anonymised agent knowledge in one offboarding. The outcome is reported
on the offboarding's `handover`, beside the connections and the performance snapshot.

**`TransferToSuccessor` with no successor deletes.** Prompt 13 makes a successor optional, and a
record owned by somebody who has left is access nobody reviews — so the fallback is the stricter of
the two, and the outcome says which it took.

---

## ADR-189 — The closure states extend the objective's own table

**Prompt 34.** §27.1 asks for "controlled Pause/Resume" on a live objective and a formal
`Completed -> Outcome Review -> Closed -> Archived` lifecycle. Those are objective states, so they
went into `OBJECTIVE_STATUSES` and `ALLOWED_OBJECTIVE_TRANSITIONS` — the table whose own comment
already says why it is one table: _"once there are two tables they disagree. That has already
happened twice in this codebase."_

Eight states became eleven. The authoring states keep their order and wording, and a test pins
both — a reordering would break every screen that reads the list as a progression.

Four decisions inside the new edges:

- **`Paused` sits beside `Active`, not after `Completed`.** It is a live objective held
  deliberately, and it is reversible. Putting it in the closure chain would have implied it was a
  step towards finishing.
- **`Paused` cannot reach `Completed`.** Finishing work that is currently stopped means resuming
  it first, so nobody closes an objective whose remaining work was never restarted.
- **`Completed` may be archived without a review.** A company that wants no review of a finished
  objective should not be forced through one — and the archive event records that there was none,
  so a report asking "how did this turn out" can tell.
- **`OutcomeReview` and `Closed` have no edge back to `Active`.** §27.1: _"Reopening a
  closed/live definition follows version rules."_ Reopening is `startNewDraft` — a new version —
  never a resurrection of the version people executed. A `reopen` route would have been a second
  way to do it and the one thing the document is explicit about.

## ADR-190 — Pausing does not reopen the plan

**Prompt 34.** `FROZEN_OBJECTIVE_STATUSES` gained `Paused`, `OutcomeReview` and `Closed`.

`Paused` is the one people assume is editable: the work has stopped, so surely the plan can
change? No — pausing stops the work and does not reopen the definition, or "pause" would be a way
round the versioning rule. An objective paused to be rethought is rethought as a **new Draft
version**, which is the same rule as every other edit after Live.

What a pause actually does is stated once, in `PAUSE_EFFECT`, and rendered verbatim by the UI:
it stops new work, it does not cancel work in flight — killing a run mid-flight would lose what it
had done, and a pause is meant to be reversible.

### The defect this created, and the layer that caught it

`uboss_objective_version_is_immutable_once_live` returned early — permitting **any** edit — for
any status outside `('Active', 'Completed', 'Archived')`. All three new states are on the live
side of the lifecycle, so a version in any of them would have been **freely editable at the
database level**: a company could have paused a live objective and rewritten its Form 2 in place.

The TypeScript list was updated in the same change, so the application would have refused it. That
is not a reason to leave the trigger — the trigger is the layer that holds when the application is
wrong, which is the whole point of having it. Three probes now prove a `Paused`, `Closed` and
`OutcomeReview` version each refuse a Form 2 edit.

**The general lesson, now its own entry in the DB changelog: a CHECK or trigger that enumerates
states has to be revisited whenever the state list grows, and nothing reminds you.** Two other
constraints — `live_objective_version_records_when` and `live_objective_version_was_approved` —
had the same gap and were extended in the same migration.

## ADR-191 — The review compares; it does not measure

**Prompt 34.** §27.1 lists what closure compares: expected vs actual result, SLA/target, human
effort, AI cost, unresolved exceptions. Every one of those is **already recorded by the module
that owns it** — Form 2 for the expected result and the target, `human_tasks` for effort, the
Prompt 30 ledger for AI cost, `executor_exceptions` for unresolved items.

So `objective_outcome_reviews` stores the part that exists nowhere else — the **actual result**,
which is a judgement somebody makes — plus the verdict, the sign-off, and a **snapshot** of the
compared figures.

**Why a snapshot rather than a join.** A review read live would change after it was signed: a late
cost settlement or a reopened exception would silently alter what somebody put their name to.
§27.1 asks for a _formal_ closure, and a signed document whose contents move is not one. The live
figures stay available beside the snapshot, so a drift between them is visible rather than hidden
— the screen labels which it is showing.

**One review per objective _version_, not per objective.** An objective reopened under the
versioning rule becomes a new Draft, and that version gets its own review when it finishes. The
old one stays exactly as it was signed, enforced by a unique index.

### Only settled cost counts

The comparison sums `Settle` ledger entries and nothing else. A `Reserve` is money held and a
`ReleaseReserve` gives it back, so summing every kind would double-count — and "what did this
objective cost" is a question about what the company was actually charged.

## ADR-192 — "Human effort" is elapsed time, and the product says so

**Prompt 34.** §27.1 asks the review to compare human effort. **UBoss records none.**
`human_tasks` has a `started_at` and a `completed_at` and no time log; nobody logs effort against a
task anywhere in the product.

So the honest measure is the task counts plus the _elapsed_ time between starting and completing,
and the field is called `humanElapsedMinutes` rather than something that implies effort. A task
somebody picked up on Monday and finished on Friday reads as four days whether they spent four
days or twenty minutes on it.

Naming matters here more than usual because of what sits beside it: "human effort: 5,760 minutes"
next to "AI cost: ₹125.00" is a comparison a manager would act on, and the two are not measuring
the same kind of thing. The screen says so in a line under the figure.

The first cut had a `humanMinutesRecorded` field reading a `minutesSpent` column that does not
exist — the compiler caught the column, and the _name_ was the part worth fixing.

## ADR-193 — Unresolved work is reported, not blocking

**Prompt 34.** §27.1 requires the review to compare "exceptions/unresolved items", which means the
review has to be able to **see** them — not that they must be gone.

So `readinessForReview` separates `outstanding` from `blocking`:

- **Open exceptions are reported and do not block.** A company closing an objective with three
  open exceptions is making a decision, and the review's job is to make sure it is a decision
  rather than an oversight. The screen lists them before anything is signed.
- **Unfinished human tasks do block**, because "what was the actual result" has no answer while
  the work is in progress.
- **No completion date blocks**, because there is nothing to compare the target against.

## ADR-194 — Sign-off is configuration, defaulting to the owner

**Prompt 34.** §27.1: _"approval/owner sign-off **where policy requires**"_ — a company decision,
and the document states no default. Three policies, in the existing settings catalogue rather than
in a table of their own (`objective.closure_sign_off`, `objective` category, which existed with
nothing in it):

- `Never` — the reviewer closes it.
- `OwnerSignOff` — **the default.**
- `Approval` — it goes through the Prompt 28 approval engine.

**Why `OwnerSignOff` is the default**: the case it prevents is a review written by somebody other
than the owner, closing the owner's objective, with the owner never told. That is not four-eyes —
it is making sure the person accountable for the work sees how it was judged.

Two details:

- **The owner closing their own objective satisfies it** without a separate signature. Requiring
  them to sign their own closure would be ceremony, and §27.1 asks for sign-off rather than for two
  signatures.
- **The policy is stored on the review**, not read from the company at closing time. A closure
  judged under this quarter's rule stays judged under it when the company changes the rule later.

`closure_satisfies_its_sign_off_policy` enforces the database's half: a closed row under
`OwnerSignOff` carries a signature or a closer, and under `Approval` carries an approval id.

## ADR-195 — Pause is `objective:Publish`, because `objective:Pause` is held by nobody

**Prompt 34.** The obvious gate for pausing an objective is `objective:Pause`. `Pause` is in the
closed `ACTIONS` set, and the role templates grant it on **`agents` only** — no role has it on
`objective`. A pause route gated on it is a route nobody in any company can call.

**This is the second prompt running to hit the same thing**: Prompt 33 gated feedback promotion on
`skills:EditDraft` and `skills` turned out to be a platform module. Both read perfectly well and
both were a 403 for every user.

The fix is the conservative one rather than widening the approved role model: **authority over a
live objective is `objective:Publish`** — the grant that put it live, held by `Head`, and already
what `complete` and `archive` use. Adding `Pause` to the templates was the alternative and was
rejected: the role model is locked, the approved documents say nothing about who may pause an
objective, and inventing a grant is a bigger change than reusing the one the product already
treats as authority over live work.

`objective-closure.test.ts` now asserts that every action this module gates on is held by some
role template, and that nothing gates on `objective:Pause`. Route-level tests were added too,
because a service-level test passes whatever the decorator says.

## ADR-196 — Reviewing is not the same grant as completing

**Prompt 34.** Six acts, four grants:

| Act               | Grant                                     | Why                                                             |
| ----------------- | ----------------------------------------- | --------------------------------------------------------------- |
| Pause, resume     | `objective:Publish`                       | Authority over live work is one authority (ADR-195)             |
| Complete, archive | `objective:Publish`                       | Declaring work finished weighs the same as declaring it started |
| Review            | `objective:Approve`                       | A judgement, not an edit                                        |
| Sign off          | `objective:View` + **is the owner**       | A permission cannot express "the owner of _this_ objective"     |
| Close             | `objective:Publish` + the review's policy |                                                                 |

**Review is deliberately not `Publish`.** The person who declared the work finished should not be
the only one who can grade it. A company that wants those to be the same person assigns both roles,
which makes the choice visible in the assignment record rather than implied by the code.

**Sign-off gates on `View` and checks identity in the service**, because the real control is "are
you the owner" and no permission can say that. The grant is the low one; the identity check is
where the control lives.

---

## ADR-197 — The database holds a reference to a file, never its bytes

**Prompt 35.** §22's store list says `files / knowledge_sources` carry _"tenant, classification,
storage ref, scan status, retention policy"_. `files.storage_ref` is an opaque key a storage
adapter understands and nothing else interprets; the content lives in the adapter.

The same rule as `secret_ref` at Prompt 16, for the same reasons. A database that holds file
content becomes the thing that has to be encrypted at rest, scanned, backed up, replicated and
selectively deleted — and it is the wrong place for all five. Backups in particular: a "delete this
customer's document" request against content stored in a table is a request against every backup of
that table.

A deletion nulls `storage_ref` **first** and asks the adapter to remove the object **second**. A
failure between the two leaves an orphan in storage, which is a cleanup problem; the other order
leaves a row claiming the content is gone while it is not, which is a lie to a customer who asked
for a deletion.

## ADR-198 — Two storage adapters, one of which refuses everything

`InMemoryStorageAdapter` is complete and is what every test and development run uses. It is process
-local and does not survive a restart, and it says so rather than being described as "local
storage".

`S3StorageAdapter` has **no bucket, no endpoint, no credential and no SDK call**. The prompt asks
for an "S3-compatible storage adapter", and an adapter written against nothing would be a claim
rather than an integration. It exists so the seam is real — `FileService` depends on
`StorageAdapter` through a token and on no concrete class — and every method throws
`StorageUnavailableError` with the reason.

`canStore` is on the abstract class, and `upload` checks it before writing a row. **A storage
adapter that appeared to work and stored nothing is the worst possible failure**: the upload
succeeds, the scan succeeds, the record exists, and the file is gone.

Same distinction as ADR-150 draws between an implemented provider adapter and a live
credential-verified integration, drawn the same way: in the type, in the error, and on the screen.

## ADR-199 — A mock scanner that finds something

`MockMalwareScanner` detects the **EICAR test string** — the standard harmless file every antivirus
product is required to flag. A mock that always returned "clean" would leave the infected branch of
this module — the branch that matters — never executed.

Every verdict carries `scannedByRealScanner`, which travels onto `files.scanned_by_real_scanner`,
into the audit metadata, into the API and onto the screen's scan column. The same rule as
`produced_by_real_model` at ADR-160: a compliance answer built on this data can tell the
difference, and a green tick that came from a mock says so on every row rather than once in a
banner somebody scrolled past.

**The scan runs inside the upload request**, not on a queue. That is a real limitation and it is
recorded rather than hidden: a large file blocks its request. Wiring it to the Prompt 26
business-cron scheduler is the right answer and would have meant building a second queue here.

## ADR-200 — Export and external egress are two different ceilings

§22: _"Apply stricter tool/AI/export rules by classification"_ and _"add DLP/redaction hooks before
sensitive data leaves the permitted boundary."_ Those are two questions, and one ceiling could only
answer one of them.

- **`exportCeiling`** (default `Confidential`) — what may be exported _inside_ the company. A
  Confidential contract downloaded by the administrator who is entitled to it is an ordinary act.
- **`externalEgressCeiling`** (default `Internal`) — what may leave UBoss through a connected
  system. The strictest default in the module, and the one worth defending: too strict costs
  somebody a settings change; too loose costs a confidential document in a third party's system,
  which cannot be undone.

A CHECK constraint refuses a policy whose egress ceiling is looser than its export ceiling — the
one cross-field rule a company could get wrong in a way nobody would notice.

**`decideEgress` returns `redactionRequired`, and `FileService.mayLeaveTheCompany` turns that into
a refusal.** UBoss has no redaction engine. A function that reported "permitted, and by the way it
needs redacting" would let a caller send it intact, so the transfer is refused instead. `REDACTION_
STANCE` says this in the product's own words and the screen renders it verbatim.

## ADR-201 — A knowledge source is approved, not assembled

§Settings calls them _"approved knowledge sources"_, which is a requirement rather than a label:
`decideKnowledgeRead` refuses any source not in `Approved`, so a collection somebody built and
never had signed off is consulted by nothing.

**Editing an approved source returns it to `Draft`**, clearing the approval columns together. The
approval was of a particular scope and classification; changing either means the approval no longer
covers what it approved. This costs a company a second approval to fix a typo, and that is the
right trade — the alternative is an approval that means nothing.

**Authoring is `settings:EditDraft` and approving is `settings:Approve`.** Those are two different
role templates — CompanyAdmin and Approver — so by default the person who assembles a knowledge
source is not the person who approves it. The only structural separation of duties in this module,
and the one that matters, because an approved source is what an Engine Agent is allowed to read.

**There is no vector store, no embedding index and no semantic sharing**, per §35's _"do not build
unrestricted vector-memory sharing"_. A source is a named list of files and a scope; a read is a
decision about that list. A test asserts the module exposes nothing resembling a shared vector
store, because an absence is only durable if something checks for it.

## ADR-202 — An agent's classification ceiling is the company's export ceiling, for now

`decideKnowledgeRead` takes an `agentClassificationCeiling`. **UBoss has no per-agent classification
ceiling**: Prompt 16's tool grants are by _action category_ — read, write, delete — not by data
class, and the approved documents specify no such field.

Passing `null` would skip the check entirely for agents, which is the wrong default. So an agent is
held to the company's `exportCeiling`, which by default excludes `Restricted`. A documented default
standing in for a field the approved documents have not specified; the extension point is the
argument itself, which the runtime may pass once a real per-agent ceiling exists.

---

## ADR-203 — A declared incident is a service alert, not a second table

**Prompt 36.** §30 asks for incidents with severity P0/P1/P2, an owner, acknowledgement, customer
impact and mitigation. `service_alerts` has existed since Prompt 9, is acknowledged and resolved by
operators, and is already counted on the Master Console dashboard.

A `platform_incidents` table was written and then **deleted before it shipped**. Two tables would
have meant two answers to "what is wrong with UBoss right now", and the dashboard's alert count and
the System Health incident list could disagree — which is the failure mode the code-reuse rule
exists to prevent.

So an incident is an alert with `incident_severity`, `declared_at`, `declared_by_user_id`,
`owner_user_id`, `mitigation`, `customer_visible` and `customer_impact`. **Not every alert is an
incident**: an alert is _raised_, an incident is _declared_, and declaration is a human judgement
that this is worth owning and publishing. `incident_severity IS NULL` is the ordinary case.

**The P-level is a separate column from `severity`.** The alert's own scale is Info/Warning/
Critical; mapping Critical onto P0 would assert a judgement nobody made.

The incident _workflow_ — timeline, postmortem, corrective actions — belongs to the observability
prompt, which extends this record rather than adding its own. `INCIDENT_WORKFLOW_BOUNDARY` states
that in the product's own words so the boundary need not be rediscovered.

## ADR-204 — `ON DELETE SET NULL` is wrong on every composite foreign key

**Found at Prompt 36, in code Prompt 35 had already shipped.**

PostgreSQL's `SET NULL` on a composite foreign key nulls **every** referencing column, including
`tenant_id`, which is `NOT NULL` on every tenant-owned table. `knowledge_sources` referenced
`connections` that way, so **deleting a connection a knowledge source pointed at failed outright**
with `null value in column "tenant_id" violates not-null constraint` — an error naming a column
nobody had touched.

A probe proved it before and after. Both composite `SET NULL` relations are now `NO ACTION`, so the
delete is refused by a named foreign key and the fix is to retire the knowledge source first — which
is the correct behaviour anyway: a Connection-backed source whose connection vanished points at
nothing.

The rule, stated so it is not rediscovered a third time: **a composite FK may be `CASCADE` or
`NO ACTION`, never `SET NULL`.** Prisma warns about this at `validate` time, and the warning was
there all along — `migrate diff` does not print it, and Prompt 35 only ever ran `migrate diff`.
Running `prisma validate` is now part of adding a relation.

## ADR-205 — Break-glass is the support session, extended rather than duplicated

Prompt 36 asks for _"support session with reason, scope, expiry, operator, actions"_ plus
_"revoke/expire"_ and _"complete audit"_. Prompt 8's `BreakGlassRequest` already carries every one
of those fields, plus identity verification, approval by somebody other than the requester, usage
counting and customer notification.

So this prompt added the **one** thing it lacked — the company's own authorization — to that record
and that service. A parallel `SupportSession` table would have given UBoss two answers to "who
reached into this company and why", and the audit trail two places to look.

**The customer-authorization state is stamped at request time** from the policy in force then,
rather than read at activation. A company turning the policy on mid-request cannot retroactively
block a session they were never asked about, and turning it off cannot unblock one they declined —
the same reasoning as the Prompt 34 closure policy being recorded on the review.

**There is no emergency bypass**, and that is the decision. An override for a P0 would make the
control advisory, and an advisory control is worse than none because the company believes they are
protected.

## ADR-206 — The customer status is built from published incidents, never from probes

The operator's System Health view is assembled from **probes**: the health endpoint, the queue's own
`health()`, the provider adapters, the connections table. The customer-facing status is assembled
from **incidents an operator deliberately published**, and the two methods share no code path.

That asymmetry is the whole of _"permitted customer-visible status where appropriate"_. A shared
path would eventually leak a probe reading into a customer response — and an early version of the
customer view did exactly that with the alert's internal headline, which a test caught by asserting
on the words (S-257).

The consequence is deliberate: **an outage nobody published reads as `ok`.** UBoss would rather say
nothing than leak an internal reading it did not mean to publish, and the pressure to publish
belongs on the incident process rather than on a scraper.

## ADR-207 — Queue depth is on the queue, not in a monitoring service

`RunQueue` gained an abstract `health()`. The alternative — a monitoring service reaching into
BullMQ directly — would have been a second thing that knows how runs are transported, and the whole
point of that abstraction is that there is one.

`measured: false` when the reading is structural rather than probed. The inline queue has **no
depth to report**, because `enqueue` runs the job; reporting a confident "0 waiting" would put a
green figure nothing measured on a health page. Same honesty rule as `produced_by_real_model` and
`scanned_by_real_scanner`.

---

## ADR-208 — A report needs two permissions, and the second one names its action

**Prompt 37.** `reports:View` is on every company role template — it is what lets anybody open the
Reports section. A report is a _view onto another module's rows_, so it also requires the
permission that governs those rows.

The first version of this carried a `sourceModule` and **assumed `View`**, and that assumption was
a leak: an Employee holds `settings:View` — it is what lets them open Settings and see their own
profile — so AI Usage & Cost and Audit Activity were readable by every employee in every company.
A unit test written against the role templates caught it.

So a report names a `{ module, action }` pair:

| Report               | Needs, beyond `reports:View`                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| AI Usage & Cost      | `settings:Administer` — what AI work cost is commercial information                                                          |
| Audit Activity       | `settings:Audit` — the trail has its own grant, and reading it through Reports must need the same one as reading it directly |
| Human vs AI Work Mix | nothing; it is this person's own work, aggregated                                                                            |
| the other seven      | their own module's `View`                                                                                                    |

**A report the reader may not open is absent from the catalogue, not present-and-empty.** An empty
Approval Aging table tells a reader there is nothing waiting, which is a different and wrong
answer. The route refuses it too — the catalogue filtering is presentation, the 403 is the control.

## ADR-209 — Scope is resolved once and passed to every query

`ReportScopeService` turns the caller's role assignments into a set of user ids; every method on
`ReportsService` **takes** that set rather than resolving its own. A service where each method
resolved its own scope is a service where nine of ten methods do it right.

**`userIds: null` means the whole company and an empty list means nobody**, and `null` is produced
in exactly one place — the `WholeCompany` branch. That asymmetry is deliberate: the most dangerous
default a reporting layer can have is "an empty filter means no filter", because a bug that
produced an empty list would then widen every report to the whole company instead of narrowing it
to nobody. With this shape, the same bug narrows.

Two roles give the **union** of what they permit, matching what the authorization engine already
does: a person who is both an Employee and a Manager is a manager. Taking the narrowest would make
adding a role reduce somebody's reach, which nobody expects.

A client cannot widen any of it, because there is no parameter in which to ask.

## ADR-210 — The dashboard endpoint returns three keys and a test asserts the whole set

The locked contract is one donut, two slices, and no KPI cards, report tables, cost or token cards,
notification lists, hierarchy summaries or performance details. **The way it erodes is additive** —
nobody removes the donut; somebody adds "and while we're here, the pending approvals count".

So `GET /dashboard` returns `{ agents, pendingJobs, scope }`, `DASHBOARD_ALLOWED_KEYS` states that
as a value, and the e2e test asserts `Object.keys(body)` equals it exactly rather than asserting
the two it needs are present. A fourth field is then a test failure.

`scope` is the legend, not a metric: the server's own sentence for what the counts cover. Without
it a manager and an employee see two different numbers with no way to tell why.

**`pendingJobs` is expressed as "not terminal"**, using `TERMINAL_HUMAN_TASK_STATUSES` rather than a
list written out in the query — so a status added later cannot silently start counting as pending.
That is the enumerated-state-list failure this codebase has now had three times in the schema, and
this is the first place it was avoided in advance.

## ADR-211 — Reports query live tables, bounded rather than warehoused

No warehouse, no materialised views, no rollup tables. Each report is a query against the live
tables, bounded by a window (`MAX_REPORT_RANGE_DAYS`, a year) and a row limit
(`REPORT_ROW_LIMIT`, 500).

That is correct at this scale and honest about what it is. Both bounds are **shown to the reader**
rather than hidden: a truncated report says so and explains that the limit is what stops one query
scanning everything the company has ever done. A range longer than a year is a 400 rather than a
slow success.

## ADR-212 — Export is its own grant, and the CSV neutralises formulas

`reports:Export` — Manager, Head and CompanyAdmin, and deliberately not Employee or Approver.
Taking a company's data out of UBoss is a different act from reading it on a screen, and the role
templates already drew that line.

The export is audited; a read is not. Reading a report is ordinary work and auditing every one
would bury the trail, but data leaving the building is the event an investigation looks for.

**Every cell is escaped against CSV injection.** A cell beginning `=`, `+`, `-` or `@` executes as a
formula when the file is opened in Excel or Sheets, and report cells carry free text a company
typed — an objective title, a ticket subject, a display name. The apostrophe prefix is applied to
every cell rather than to the ones somebody thought of, and `toCsv` emits **only the declared
columns**, so a query that selected more cannot leak it through the file.

---

## ADR-213 — Portable profile search is a whitelist projection, not a filtered row

**Prompt 37A.** This is the one read in the product that deliberately crosses tenancies: a
person's employment history belongs to the person, not to whichever company holds a row about
them. Everything else is confined by Row-Level Security, so this query runs as a platform
operation — which makes it the highest-risk read UBoss performs.

It is therefore built the opposite way round from every other query here. **Nothing is fetched and
then filtered.** Each `select` names the columns that may travel, and the response shape is
declared in `PORTABLE_PROFILE_FIELDS` / `PORTABLE_EMPLOYMENT_FIELDS` /
`PORTABLE_PERFORMANCE_FIELDS`, which an e2e test asserts against the response's own keys.

The alternative — read the row, delete what must not go — leaks the first time somebody adds a
column to `employment_records`, and nothing would fail. Under a whitelist, a new column is invisible
until somebody deliberately adds it to the list, and adding it to the list breaks the test.

Deliberately absent from an employment entry: `employeeId` (the other company's internal
numbering), `departmentId` (their org structure), `workEmail` and `workPhone` (contact details they
hold), and `reportingManagerUserId` — which names a **third person** who did not consent to appear
in somebody else's verification.

## ADR-214 — "Authorized HR/Admin" is `users:Administer`, not `profile-search:View`

The source documents say _"Authorized HR/Admin can search a person by UBoss Unique ID"_.
`profile-search:View` is on **every** company role template — it governs whether the nav item
appears — so it cannot be the control. An Employee reading another company's employment records is
exactly what "Authorized HR/Admin" excludes.

So the service requires both: the module grant, and `users:Administer` — HR/Admin authority over
employment records, held by CompanyAdmin. A company wanting a specific HR person to do it grants
them a custom role carrying that action; the engine already supports it.

The route decorator asks only for the module grant, so an unauthorized request is refused at the
guard before touching the database; the service then applies the real one.

## ADR-215 — Two company policies, and the source company owns the second

§905 lists profile search among Settings _"where enabled"_, so the capability is configured:

- **`security.portable_profile_search_enabled`** — may _our_ people look outward. **Off by
  default.** Looking into other companies' employment records is a capability a company should
  choose rather than inherit.
- **`security.portable_performance_sharing`** — how much of _our own_ performance record travels
  when somebody verifies our former employee. `Nothing` / `BadgeOnly` / `BadgeAndScore`, defaulting
  to **`Nothing`**.

The second is the one worth defending. **The source company decides**, because it recorded the data
and its own policy governed how the score was earned — a company that scores harshly should not have
its numbers read by a third party who cannot see either policy. A badge is comparable across
companies in a way a raw score is not, which is why `BadgeOnly` exists as a middle option.

`shareablePerformance` builds the shape, so **`BadgeOnly` cannot return a score** however the
service is edited later. Putting that decision in the service and passing the row through is
precisely how a score escapes.

Both live in the `security` category, not `users`: the `users` category is deliberately
settings-free and carries a note pointing at the Users & Access screen, which a Prompt 14 test pins
— and it caught this when they were first put there.

## ADR-216 — An achievement summary is a count and a date, because titles are forbidden

The prompt asks for an _"approved achievement/reward summary"_ and forbids exposing Objectives.
A `RewardAward`'s only human-readable label **is** the Objective it was earned against.

So the summary is `{ count, mostRecentAt }`: "three approved rewards, most recently in March". That
verifies what a verification needs — this person earned recognition, and roughly when — without
naming a piece of another company's work. The narrower answer was forced by the constraint rather
than chosen, and it is the right one.

`APPROVED_REWARD_STATES` is `Approved`, `Settled` and `Recorded` — everything from approval onward,
because counting only `Approved` would under-report the people whose rewards were actually paid.

---

## ADR-217 — Exit deletes by classification, and the classification is exhaustive by test

**Prompt 38** leads with _"without silently erasing accountability"_, which forbids the obvious
implementation. `DELETE FROM ... WHERE tenant_id = $1` over every tenant-owned table would satisfy
"delete eligible tenant content" and destroy the audit trail, the financial record and every
person's employment history — with nothing left to show what went or on whose authority.

So `TABLE_DISPOSITION` classifies **all 91** tenant-scoped tables into three buckets:

- **`Content`** — the company's work. Deleted.
- **`Accountability`** — the audit trail, the security trail, break-glass history, lifecycle
  transitions, who held what authority, who approved what, and the financial record. Preserved.
- **`PersonRecord`** — records that belong to a _person_ rather than the company: employment dates
  and designation, badge history, performance events, and the departments those name. **A company
  leaving UBoss does not get to erase somebody's career**, and these are what a portable profile
  reads at Prompt 37A.

**An e2e test reads `information_schema` and fails if any tenant-scoped table is unclassified.**
That test caught `company_exits` itself on its first run. Without it, a table added by a later
prompt defaults into whichever bucket the code happens to choose — into `Content` it deletes
something legally required, into `Accountability` it retains a departed customer's data forever,
and nothing else in this codebase would notice.

## ADR-218 — The dependency graph decided three of the classifications, not taste

The database refused five versions of this design before it worked, and each refusal was
informative:

| Dependency                                                       | Outcome                                                                                                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `employment_records → departments`                               | **Departments preserved.** A record saying "Analyst in Delivery" must not point at nothing.                                                     |
| `performance_events → performance_policies` (NOT NULL)           | **Policy preserved** — and right on its own terms: a score cannot be read without the policy that produced it, the same argument ADR-215 makes. |
| `approval_requests → objectives / objective_versions` (nullable) | **Detached.** The approval keeps what it decided and who decided it, and loses the pointer.                                                     |
| `cost_ledger_entries → budget_reservations` (nullable)           | **Detached.**                                                                                                                                   |
| `reward_awards → objectives / objective_rewards` (**NOT NULL**)  | **Deleted.** No detach is possible and preserving every objective would defeat the exercise.                                                    |

`DETACH_BEFORE_DELETE` nulls the pointers before the deletion runs; a unit test asserts every
column in it belongs to a non-`Content` table, so nobody adds a NOT NULL column and discovers it at
runtime.

The `reward_awards` outcome is a **real loss, recorded rather than hidden**: a departed company's
reward count no longer reaches a portable profile. The badge and the score still do.

## ADR-219 — Six `Content` tables cannot be deleted by the application, and the certificate says so

Ten tenant-scoped tables deny `DELETE` to `uboss_app` — they are append-only by privilege, which is
the Prompt 8 tamper-protection pattern. Four are already preserved (consistent). **Six are
`Content`**: `notifications`, `connection_checks`, `connection_tool_grants`,
`skill_evaluation_runs`, `skill_regression_comparisons`, `skill_transitions`.

Three possible responses, and only one is honest:

- grant `DELETE` — undoes a deliberate tamper protection for one feature's convenience;
- run the deletion as the database owner — a real privilege escalation needing its own credentials,
  wiring and review, not something to add in passing;
- **delete what the application may delete, and report exactly what it could not.**

The third. The certificate carries `retainedByPrivilege` with row counts per table, and the audit
summary names the figure. A company asking "is it all gone" gets the truth. Closing the gap — by
granting the privilege or by provisioning an owner-role path — is a decision for the client, and it
is recorded as a limitation rather than resolved unilaterally.

The privilege is checked with `has_table_privilege` **before** attempting, because a statement that
hits 42501 aborts the surrounding transaction and would take the whole deletion with it.

## ADR-220 — Cancelling an exit stops the exit; it does not necessarily restore access

A genuine conflict between two approved requirements, resolved by reading both.

Prompt 11 locks `Closed` as terminal through `CompanyLifecycleService`: reopening a closed company
would restore access to data whose retention decision has already been made. Prompt 38 requires
_"cancellation before destructive point **where policy allows**"_.

So:

- cancelling from `ReadOnly` — the company is still `ReadOnly` — restores it to `Active`;
- cancelling from `RetentionHold` — the company is `Closed` — **stops the exit and leaves it
  closed.** Nothing has been deleted, which is the entire value of the retention window, but
  restoring access is the deliberate re-provisioning Prompt 11 reserves.

The audit summary says which happened, so nobody is left wondering why the company is still shut.

## ADR-221 — The typed confirmation is the company's own identifier

Not the word `DELETE`. Typing `DELETE` is muscle memory — somebody who has done it once will do it
again on the wrong company — and typing the name of the company you are about to erase is a moment
of attention that `DELETE` is not. Case-sensitive, exact, and every failed attempt is recorded as a
security event.

Four things must be true before content is deleted: the exit is in `RetentionHold`, the retention
window has elapsed, a **second person** approved the original request, and the identifier is typed.
The service checks all four; the database independently refuses a row violating the second, the
third or the certificate's completeness. A service is a thing somebody eventually adds a code path
around, and _"delete it now, the customer is on the phone"_ is exactly that pressure.

---

## ADR-222 — The correlation chain reaches the money, and the last two stages were missing

**Prompt 39** asks for propagation _"browser/API → queue → run → provider/tool → cost
settlement"_. `CorrelationIdMiddleware` has generated one since Prompt 5 and both trails carry it —
and it **stopped at the run row**. `model_gateway_calls` and `cost_ledger_entries` had no column for
it, so "what did this click actually spend" could not be answered at all.

Both now carry it, indexed with the tenant. One id answers the whole chain in four queries, which
the runbook spells out.

**The id is read from the ambient request context at each write site, not threaded through every
signature.** `AsyncLocalStorage` already carries it on every request path; adding a `correlationId`
parameter to `ModelRequest`, the settlement input and everything between would be a dozen signature
changes whose only job is to re-transport something already in scope — and each one a place a future
caller forgets.

The queue is the exception, because a worker is a different async context. `RunEngineService` now
wraps each job in `runWithRequestContext(createRequestContext(job.correlationId), …)`. Without that
one line the chain would be _nearly_ unbroken — a run's provider call and cost entry would record
no correlation at all — which is the worst kind of observability: present enough to be trusted and
absent exactly where it matters.

## ADR-223 — Metric labels are a closed set with no identity in them

`METRIC_LABELS_ALLOWED` names the permitted labels per metric, `metricLabelsArePermitted` enforces
it, and a test asserts no permitted label matches anything in `FORBIDDEN_METRIC_LABELS`.

Two distinct reasons, both sufficient:

- **Cardinality.** A label is a dimension every series is multiplied by. `tenant_id` on a
  per-request metric means one series per customer per route; `user_id` means one per person. That
  is how a metrics system takes down the thing it was meant to observe.
- **Disclosure.** `/metrics` is scraped by a machine with no session (ADR-224). A tenant label would
  make a shared operations dashboard a cross-tenant disclosure.

`provider_errors` is labelled by **logical profile, never provider name** — the locked rule is that
provider names do not leave the Model Gateway, and a metric label is precisely where one would leak
onto a shared screen.

"Which customer was affected" is an audit-trail question, answered by the correlation id. A
rejected observation is **dropped and counted, never thrown**: a metric must not be able to fail the
request it is measuring, and `rejectedObservations` makes the drop visible instead of silent.

## ADR-224 — `/metrics` is outside the permission model, and that is why it carries no identity

A Prometheus scraper is not a person and holds no session, so the endpoint cannot be behind
`@RequirePermission`. Rather than invent a scraper credential — a second authentication mechanism
for one endpoint — the endpoint carries nothing worth protecting: counts and latencies with no
tenant, user, run or provider label anywhere (ADR-223).

It remains `@PlatformOnly`, so it is unreachable from a tenant route. Network-level restriction is a
deployment concern the application cannot enforce, and the runbook says so rather than implying the
application has it covered.

## ADR-225 — There is no OpenTelemetry exporter, and the seam says so

The prompt asks for _"OpenTelemetry traces"_. There is no collector: no endpoint, no credentials, no
backend. Installing the SDK and pointing it at nothing would buy a dependency, a startup cost and a
claim.

So `Tracer` is an abstraction with `InProcessTracer` bound — which genuinely works: it records
spans, **uses the correlation id as the trace id**, redacts secret-looking attributes, bounds its
buffer at 500 and re-raises what it catches. `OpenTelemetryTracer` sits in the same file, refuses
every call with the reason, and is deliberately **not** registered.

Identical to `S3StorageAdapter` (ADR-198) and the provider adapters (ADR-150), for the same reason:
the seam is real, the integration is not claimed, and `TRACING_STANCE` states it in words a screen
shows. "We have tracing" is exactly the kind of claim that gets made on a slide and discovered to be
false during an incident.

The trace id **is** the correlation id because a different one would mean an operator holding one
had to translate to find the other — the situation tracing exists to remove.

## ADR-226 — Alert evaluation is idempotent against the row, not against remembered state

`evaluate()` opens an alert for a firing rule **only if that rule has no open alert already**. Run
it every minute and a persistent problem produces one alert rather than sixty.

The alternative — raise on the not-firing → firing transition — requires remembered state, and
remembered state in a process that restarts means **a restart during an outage loses the fact that
anybody was told**. The row is the state, which is the same reasoning the run engine applies to its
idempotency key.

It deliberately does **not** auto-resolve when a metric recovers. A queue that drained on its own
still happened, and an operator acknowledging and resolving it is how anybody learns that it did.
Auto-resolution would mean a 3am incident nobody ever saw.

This closes the limitation Prompt 36 recorded in its own words: _"Nothing raises a service alert
automatically."_

## ADR-227 — A P0 cannot be resolved without a postmortem, and the two rules resolve together

§30 lists the postmortem as part of the incident. `SEVERITIES_REQUIRING_POSTMORTEM` is `P0` and
`P1`; a P2 closes on its mitigation note alone, because most are a configuration fix nobody needs to
read about — and a scale whose levels are treated identically is not a scale.

Two rules that would deadlock if applied separately: a P0 cannot be **resolved** without a
postmortem (`serious_incident_is_post_mortemed_before_resolving`), and a postmortem cannot be
**written** on an unresolved incident (`postmortemReadiness` — one written during an incident is a
guess). `resolve()` performs both in one transaction, which is the only order in which both hold —
and is also the right product behaviour, since the write-up and the closure are one act.

A postmortem also requires **at least one timeline entry**. One written from memory is how the same
incident happens twice.

## ADR-228 — A timeline is written, and backdatable

The state changes are already in the audit trail. What an audit trail cannot produce is _"we thought
it was the database, it was the connection pool"_ — and that sentence is what a postmortem is
written from. So `incident_timeline_entries` is narrative, entered by an operator.

`occurredAt` is a parameter defaulting to now, because **an operator catching up after an outage
backfills**. A timeline that only knew when each line was typed would misreport the sequence of the
very thing it exists to explain.

Append-only by convention, not by privilege: correcting a reading mid-incident is legitimate, and a
new entry saying so is better than an edit that hides the first one. There is no update route.

A corrective action has a **mandatory owner and due date** — the commonest failure of an incident
process is a postmortem full of actions nobody agreed to do. Dropping one requires a reason;
completing one does not. Deciding _not_ to fix something a postmortem identified is the decision
somebody will be asked about.

## ADR-229 — A token bucket, not a fixed window

A "100 per minute" fixed window lets 200 through in one second across a boundary: 100 at 11:59:59
and 100 at 12:00:00. The documented limit and the enforced limit are then different numbers, and the
difference appears precisely under the burst the limit exists to handle.

`consumeToken` refills continuously at `limit / windowSeconds` per second, capped at `burst`. A
fresh bucket starts **full**, so the first request after a deploy is never refused, and
`retryAfterSeconds` is rounded up and floored at one — a `Retry-After: 0` turns a rate limit into a
busy loop, which is worse than no limit.

The arithmetic lives in `@uboss/types` as a pure function over the state and the clock, so the
store is an implementation detail and the algorithm is testable without one.

## ADR-230 — Queue fairness is round-robin, and it is a pure function

One company schedules a thousand runs at nine o'clock. Four workers, FIFO. Every other customer's
work sits behind a thousand jobs. Nothing has failed, no alert fires, the queue-depth metric looks
like a busy morning — and the product is unusable for everybody except the company that caused it.

`fairOrder` takes the oldest job of each tenant, then the second-oldest of each, and so on; tenant
turn order is by each tenant's oldest job, so the company waiting longest goes first on every pass.
**The property that matters: a tenant's wait depends on how many companies are busy, not on the size
of the biggest one's backlog.**

Not a weighted or priority queue, because somebody would have to choose the weights and nobody can —
a company's plan does not tell you whose run matters more this minute. Round-robin needs no such
judgement. FIFO _within_ a tenant, because there the oldest work is the likeliest to have somebody
waiting on it.

A pure function over the pending set rather than logic inside a queue adapter: a fairness rule buried
in a transport is a fairness rule nobody can prove.

## ADR-231 — Two controls, because either alone leaves the starvation intact

The **cap** (`concurrencySlotsFor`, default eight per company) limits runs in flight. Without it one
company holds every worker for as long as its work takes. The **order** (`fairOrder`) decides who is
next. Without it a capped company still owns the whole _queue_: as each of its runs finishes the next
job in line is another of its own.

The cap is enforced at **pickup, not at enqueue**. At enqueue the answer would be stale by the time
the job ran, and the work is not being refused — only ordered. The durable row is created either way.
It is checked **before `Reserved`**, because reserving budget for a run about to be put back would
hold money against a wallet for work that has not started, and the reservation-drift alert would then
fire on a queue that was merely busy.

## ADR-232 — The in-flight count is a query, never a counter

A counter drifts. A worker killed mid-run decrements nothing, and after a few crashes the cap is
permanently consumed by runs that no longer exist — a company quietly limited to zero with no way to
see why. `COUNT(*) WHERE state IN ('Reserved','Running')` is derived from the rows that _are_ the
truth, so it self-heals: whatever state the rows end up in, the count agrees with them. It costs an
indexed count per job, which is the right price. No migration, no column, nothing to reconcile.

## ADR-233 — The rate-limit store is a seam, and it says which one you have

A per-process `Map` is correct for the single-process API that runs today. Behind a load balancer
with four instances the same Map gives every caller **four times** the configured limit — the limit
silently becomes whatever the instance count happens to be. The metrics look healthy, every test
passes, and the number in the documentation is wrong.

So `RateLimitStore` has two implementations: `RedisRateLimitStore` (bound when `REDIS_URL` is set)
and `InProcessRateLimitStore`. **`isSharedAcrossProcesses` reports which**, logged at startup and
served by `GET /platform/limits` with the caveat spelled out rather than implied. The same shape as
`RunQueue`, `StorageAdapter`, `MalwareScanner` and the provider adapters.

The Redis implementation is a **Lua script**, so refill-and-take is atomic. Read-then-write from four
processes is a lost-update race whose lost update is a token somebody already spent — a non-atomic
limiter lets _more_ through under load, which is the worst possible direction for this control. The
arithmetic mirrors `consumeToken` and a contract test asserts the two agree rather than trusting it.

## ADR-234 — The limits are platform configuration, not company settings

Every other knob affecting one company lives in that company's Settings. These do not.

A per-user limit protects a company from its own broken script. A **per-company** limit protects
every _other_ company from this one — it is the API-layer counterpart of the run concurrency cap. A
customer who could raise their own would be a customer who could opt out of a protection the rest
depend on, which makes the control decorative. So they are rows in `platform_settings`
(`limits.*`, section "Limits & fairness"), changed through the Master Console path that already
records a setting change as a Critical security event.

Cached for sixty seconds, because a database read per request to discover the request limit would be
the most-executed query in the product and would make the limiter itself a load problem. A
configured value that fails `limitProblems` — a typed zero, which would refuse every request from
every customer — is logged and **ignored** in favour of the code default.

## ADR-235 — Idempotency is opt-in, per actor, and forgets

`AgentRun` has had an idempotency key since Prompt 26, but it is _derived_ from the occurrence, so
it only deduplicates work the server can name in advance. A client-initiated POST has no natural
occurrence: two "create this objective" requests a second apart are indistinguishable unless the
client says they are the same one. The engine's key protects the scheduler; this protects the client.

**Opt-in**, because the server cannot tell a retry from a second identical action — only the caller
knows. **POST only**: PUT, PATCH and DELETE on a specific resource are idempotent by construction.
**Unique per `(scope_key, user_id, key)`**, never globally — see S-302. **Twenty-four hours**, after
which a reused key is simply a new request; pretending to remember forever would make the table grow
without bound.

The record is written **before** the work, because the insert is the claim: written afterwards, two
concurrent retries would both find nothing, both do the work, and the unique index would catch the
second only after the damage. A **failed** request releases its claim — a remembered 500 would replay
for twenty-four hours and the client could never succeed.

## ADR-236 — Provider throttling is declared where it can be and learned where it cannot

Two mechanisms, because providers state their limits in two different ways.

**Declared**: `ProviderModel.quotaRequestsPerMinute`, nullable, and null is the expected value —
most contracts state a limit nobody transcribes. Enforced through the same store and the same token
bucket as the API, because a rate limit is a rate limit and a second implementation would be a second
thing to get wrong.

**Observed**: when the quota is not declared, the provider says 429 and UBoss learns. Consecutive
retryable failures raise a cooldown via `providerBackoffMs`; a success clears it **completely**, not
gradually — a model that just worked is working, and a decaying counter keeps throttling a provider
whose problem is over.

The jitter matters more than the backoff. Four workers throttled at the same instant, all retrying
after exactly 2,000ms, re-trigger the same limit together and turn a brief throttle into a sustained
outage produced entirely by the retry policy. Full jitter spreads them.

A non-retryable failure sets **no** cooldown: a rejected prompt or a refused credential will be
refused identically next time, so backing off spends a customer's wait to reach the same answer. The
classifier is a string match on the adapter's error text, which is stated as a limitation rather than
dressed up — the adapters throw `Error`, not a typed failure, and anything unrecognised is treated
as _not_ retryable so the unknown is never the retrying default.

State is in memory, because it is worth seconds: a cooldown surviving a restart would describe a
provider's behaviour from before the restart. The cost — each process learns separately — is the
argument for declaring the quota, which goes through the shared store instead.

## ADR-237 — Worker concurrency and company concurrency are different questions

`RUNS_WORKER_CONCURRENCY` (default four, previously hardcoded) is how much work **this process**
carries. `limits.concurrent_runs_per_company` is **whose** work gets to use it. Conflating them
would mean a bigger machine silently let one company take more of it.

Raising the worker figure without raising the database pool is the trap: every concurrent run holds
a connection for its state transitions, so a worker concurrency above the pool size becomes pool
exhaustion, which presents as a slow database rather than as a misconfiguration.

## ADR-238 — A starved run becomes an Executor exception; a fairly queued one does not

The prompt asks for _"Executor exceptions where appropriate"_, and the appropriate case is the one
fairness itself creates. Round-robin ordering and a per-company ceiling both mean a company waits —
correctly — and both are **invisible to the person who asked for the work**. The run sits in
`Queued`, which reads as normal, indefinitely.

So `EXCEPTION_KINDS` gains **`AgentRunOverdue`**, the counterpart to `HumanTaskOverdue`, raised by
the existing Executor sweep for a run queued longer than `STARVED_RUN_AFTER_MS` (thirty minutes).
Severity `Medium`: the work is queued, not lost, and the usual cause is a ceiling set lower than the
company's appetite — a capacity conversation rather than an incident.

**The threshold is the whole design.** Thirty minutes is past any legitimate round-robin wait at a
realistic queue depth, so a run that reaches it is being starved rather than queued. Raising it at
ten minutes would fire on a normal busy morning and teach everybody to ignore the exception list —
the failure mode every alert and exception in this product is designed against, and the same
argument as `abuse-suspected` being `Warning` rather than `Critical`.

It reuses the exception framework rather than adding a second one, and it is the _customer's_ view
of the fact that Prompt 39's `queue-stuck` alert tells UBoss. The deferral reason already on
`agent_runs.progress_message` carries into the exception detail, because "your company is at its
concurrency ceiling" is the actual answer to "why is this waiting".

# CR-03 (Prompt 40A)

## ADR-239 — A standard Employee is operations-only, and this supersedes an earlier decision

The Employee role template used to grant `objective: CONTRIBUTE` and
`agent-builder: ['View','Comment','EditDraft','Run']`. That was a **correct** reading of the source
document then in force, which said "Employee completes Human work and only missing Agent setup →
Test → Activate" and listed "assigned Agent Builder work" in the employee's own scope. A test pinned
it with the citation attached, precisely so nobody would narrow it by accident.

CR-03 narrows it on purpose: it "supersedes any earlier assumption that every assigned employee must
use Agent Builder", and requires the two BUILDERS screens hidden and backend-blocked unless
explicitly granted. A latest explicit client amendment outranks the earlier functional document, so
the grant goes — and the guard test now pins the **new** rule with its own citation, so the next
person to widen it by accident is stopped too.

**One mechanism, not two.** `visibleModules` is derived from whichever modules a person holds any
grant on, so removing the keys is what hides the screens — and the same absent grant is what the
route guard refuses on. There is nothing to keep in step.

## ADR-240 — Capabilities are a vocabulary over the existing engine, never a second one

CR-03 asks for a business-friendly Access & Permissions step and says "do not create a second RBAC
system". So `CAPABILITIES` is a map from a phrase an administrator understands — _"can build
agents"_ — onto grants the existing engine already evaluates, and granting one writes a `Custom`
role assignment, the mechanism that has existed since Prompt 7. The engine's own union across a
person's assignments does the rest, which is what makes "a standard Employee plus an explicit grant"
the definition of a Power Employee rather than a new user type.

**One custom role per capability, not one per person.** Revoking is then the deletion of one row
rather than the recomputation of a matrix — and a matrix diff that goes wrong silently removes
access.

A granted capability is always scoped `OwnWork`. Widening what somebody _can do_ must not widen
_whose work they can do it to_; somebody who needs wider reach gets a role, which is a more visible
decision.

## ADR-241 — Four of the five agent roles already existed

CR-03 asks that creator, configurator, operator, owner, approver and activator be tracked
distinctly. Most of that was already true on `engine_agents`: `createdByUserId` is the creator,
`updatedByUserId` with `updatedAt` is the configurator, `ownerUserId` is the accountable owner,
`activatedByUserId` is the activator, and the approver has always lived on the `ApprovalRequest`
where approval decisions live. Adding parallel columns would have been a second answer to questions
the row already answered.

What was genuinely missing was the **operator**, and it needed a table rather than a column, because
an agent can be run by several people — a rota, holiday cover. A single `assignedToUserId` would
have forced the second person to borrow a login or be given a builder role, which are the two things
this amendment exists to avoid. Plus one column, `builtForUserId`: _who was it built for_ is a
different question from _who may run it_.

## ADR-242 — A live share is what makes a manager-built agent the operator's own work

The case CR-03 is about: a manager builds an agent for an employee, so `ownerUserId` is the
manager, and the employee is capped at `OwnWork`. Evaluate the run's scope against the manager's
ownership and the scope engine correctly refuses — **the entire build-for-employee flow becomes
unreachable**. Found by a test.

The resolution is not to weaken the scope check. It is to recognise what a share means:
`EngineAgentOperator` is the record that this work was given to this person, which is exactly what
`OwnWork` describes. So when a live share exists, the operator is the owner _for that check_. The
share is still evaluated separately and **first**, so nothing is let through without one; and
`createdByUserId` stays the manager, because separation of duties asks who wrote it and that answer
has not changed.

## ADR-243 — `agents:Assign` is granted to nobody, so staffing needs two grants

The obvious gate for sharing an agent would be `agents:Assign`. **No role template carries it** —
not Manager, not Head, not CompanyAdmin — which is a real property of the approved matrix, like
`objective:Pause` being granted to nobody. Gating on it made the feature unreachable for every role
in the product, and a test is what said so.

So the gate composes two grants that exist: `agents:View` (you must see the agent you are staffing)
and `todo:Assign` (you must be entitled to hand work to a person — and the agent _is_ the work).
Manager and Head hold both; a standard Employee holds the first and not the second.

## ADR-244 — The Job Method is a third artifact, not part of Form 2 or of the Skill

Five of its thirteen columns have no home in either: **TOOL / SYSTEM / WORKPLACE** (distinct from
_where_ the work happens), **HOW**, **RULE / FORMULA / CHECK**, **AGENT MUST NEVER DO** and **IF
MISSING / WRONG**. Those five are precisely what turns a described business step into something an
agent could be built from, which is why the client asks for them — and folding this into Form 2
would either lose them or corrupt a locked structure.

So Form 2 **prefills** it, the employee **fills** it, and the upload **feeds** the Agent design.
`FORM2_PREFILL` maps only where the two genuinely mean the same thing, and
`COLUMNS_THE_EMPLOYEE_MUST_ANSWER` is the five left blank on purpose. `whereInputSource` maps from
`inputReceivedFrom` and **not** from `whereWorkIsDone`: where the input comes from and where the
work happens are different questions, and conflating them would put a plausible wrong answer in
front of the person least likely to challenge it.

## ADR-245 — Download needs no builder permission; upload does

The whole point of the file flow. **Download** is `todo:View`, which a standard Employee holds — the
person who knows how the work is actually done can receive the form, fill it in offline, and send it
back with no Agent Builder access at all. **Upload** is `agent-builder:EditDraft`, because bringing
somebody's answers into a draft _is_ building, and it is the moment a business description becomes
agent configuration.

Nothing is invented: a blank cell is reported `Missing` and stays blank, and an over-long cell is
reported `Invalid` and is **not** truncated — a sentence cut mid-word would be stored as though the
company had written it that way. Nothing is activated: an import saves a draft and stops
(`AUTOMATION_STANCE`), because a spreadsheet must not be able to put an agent into production.

Rows are **replaced, not merged**. A returned form is the company's complete statement of how the
job is done, so a step they deleted must disappear — merging row by row would leave an orphaned step
seven between the new six and eight, and nobody would notice until an agent was built from it.

## ADR-246 — One Job Method row is not one Engine Agent

`AGENT_BOUNDARY_FACTORS` holds the client's eight factors as data with the argument for each,
because "why is this two agents and not one?" is a question a builder will be asked and should not
have to answer from instinct. `suggestAgentGroups` groups on the declared tool, the approval
requirement and the stated prohibitions — and it is deliberately **not clever**. A confident
automatic answer would be worse than an obvious rough one, because nobody checks a confident answer;
the name says `suggest`, and a builder accepts, merges or splits.

## ADR-247 — A photo is a file, and the file layer grew a seam rather than a looser gate

CR-03: store the photo "through the existing secure object/file-storage abstraction, not base64 in
normal DB fields". So a photo goes through `FileService` and inherits the size validation, the
storage adapter, the content hash, the malware scan, the classification and the audit row.

But `FileService.upload` requires `settings:EditDraft` and `delete` requires
`settings:Administer`, and a standard Employee holds `settings:View` only — so routing a photo
through them would have meant either refusing an employee their own picture or widening the
Knowledge & Data grant for everybody, which would hand every employee the company file store to
prove a point about avatars.

So the _work_ is shared and the _gate_ is the caller's:
`uploadAuthorizedElsewhere` / `deleteAuthorizedElsewhere`, named to say out loud that the caller
has taken on the obligation. The legal-hold refusal is **not** bypassed and must never be.

A photo is keyed on tenant and user rather than on the employment record, so it survives
re-employment; one per person, so "remove my photo" cannot leave an earlier one reachable by id; and
not viewable until a scan clears it, falling back to initials — which is indistinguishable from "no
photo yet" and therefore says nothing about what the scanner did.

## ADR-248 — Chat membership grants nothing, enforced structurally

Get this wrong and chat is the easiest privilege escalation in the product: join a thread, read the
context preview, walk out with a restricted Objective — with no permission check anywhere near it,
because the check was on the conversation and the conversation was yours.

Three structural decisions rather than three rules to remember:

1. **The stored reference is a type and an id.** There is nowhere to cache a title, so nothing can
   leak by sitting in the wrong table and nothing can go stale.
2. **Every preview is resolved per viewer at read time**, against the resource's own module
   permission — and against the **row**, not just the module, because an `OwnWork` employee holds
   `todo:View` and must still not read a colleague's task.
3. **A `switch` over the closed set**, so adding a seventh context type is a type error. A registry
   keyed by string would let a later prompt add a type with no resolver and get an unchecked preview
   by default.

A viewer without access gets a stated refusal from one place, so six resolvers cannot each invent a
message that reveals something. Losing access removes the preview with nobody editing the
conversation — the property a cache could not have. And where the descriptor is incomplete (an
Engine Agent has no department) the answer is a **refusal**: an incomplete descriptor makes a
preview more restrictive, never less.

## ADR-250 — Reward awards are gated on `performance`, not `objective`

Found by the full suite after the CR-03 narrowing, and worth recording because of _how_ it was
found rather than what it was.

`GET /reward-awards/:subjectUserId` and `RewardService.listForSubject` both checked
`objective:View`. That worked, but only because a standard Employee happened to hold
`objective:View` — it was never the check that decided anything. CR-03 removed that grant, and the
effect was that **a person could no longer see their own bonus**.

That is the same absurdity the service's own asymmetry was written to prevent — "being told you may
not see your own bonus is absurd" is a comment already in that method — arriving through a
different door eight prompts later.

`performance:View` is both the fix and the more accurate gate: a reward award is performance
information about a person, not part of authoring an Objective. Every company role holds it. The
real restriction has always been the row-level check on somebody _else's_ awards, which is
unchanged.

**The general lesson**: removing a grant breaks routes that depended on it incidentally, and a
route whose declared permission is not the permission doing the work will not show that until the
grant goes. Only a full suite finds it.

## ADR-249 — Chat has no module in the permission set

Every chat route is gated on **being a participant**. A `chat:View` grant would mean somebody could
be given access to everybody's conversations, which is a capability no role in this product should
have — and an administrator who needs a conversation for an investigation goes through break-glass,
which is recorded, time-boxed and tells the customer.

A non-participant gets `NotFound`, not `Forbidden`: "you are not allowed in that conversation"
confirms it exists and that these particular people are talking, which the participants have not
shared either.

Ordinary messages are **not audited** — CR-03 says so, and it is right: an audit trail holding every
message would be a second copy of every conversation in the one table designed never to be deleted.
What is audited is the structural act — starting a conversation, linking a context — because those
change who can see what. The conversation audit records the participant _count_, not the list.

## ADR-251 — An operator share is a second way to _reach_ an agent, not a second permission system

`AgentOperatorService.assertMayRun` was written at Prompt 40A and **called by nothing**. The
operator screen asked `mayRun`, was told yes, and enabled Run; the run route then decided visibility
from ownership, and a manager-built agent is owned by the manager while the employee is capped at
`OwnWork`. Pressing Run answered 404.

Nothing failed, because every test covering the share asked the _service_. The route was only
exercised by tests that used the owner, so the one path CR-03 exists to create was the one path
nobody drove.

`RunController.assertOnAgent` now consults a live `EngineAgentOperator` row first. What makes this a
reach rather than a grant:

- `mayRun` asks the same `AuthorizationService` for `agents:Run` and for scope. A share does not
  confer either.
- The share substitutes who counts as the _owner of that one row_ for the scope question, and
  nothing else. `createdByUserId` deliberately stays the manager, because separation of duties
  asks who wrote it.
- `Pause` is excluded. Cancelling a run in flight is the authority to stop somebody's work, and
  being handed a job to do is not being handed that.

The lesson is about test level rather than about agents: **a rule enforced in a service and a rule
enforced by a route are two different claims**, and a suite that only ever makes the first will
report the second as working. `cr03-access-and-job-method.e2e.spec.ts` now drives the three CR-03
controllers directly, and `run-engine.e2e.spec.ts` drives the run route over HTTP as the operator.

## ADR-252 — The operator's run view is projected at the service, not filtered at the screen

CR-03 §5 forbids showing an operator prompts, JSON, model internals, keys or system instructions.
A screen can honour that and the next screen can forget it, so the guarantee is made structural:
`OperatorRunView` has six fields and no place to put any of them, and `AgentOperatorService.myRuns`
is the only thing that builds one.

`engineAgentVersionId`, `correlationId`, `producedByRealModel`, `attempt`, `retryability` and the
raw `output` document never leave that method. `operatorResultOf` reads `output.text` and drops
`capability`; anything of another shape yields null rather than a stringified object, because an
operator shown a JSON blob is precisely what the amendment forbids.

The test asserts on the **serialised response**, not on the type: a field absent from an interface
can still be present in the bytes.

## ADR-253 — View Result and History read one list

Both open the same `my-runs` response — Result showing the newest ended run, History showing all of
them. Two endpoints would let a "latest result" disagree with the top row of the history printed
underneath it, which is a contradiction an operator cannot resolve and should never be shown.

"Ended" is asked of `isRunFinished` from the run state machine rather than answered with a list in
the component. A second copy of "which states are terminal" stops agreeing with the first the moment
a state is added — the recurring failure this codebase has now hit at Prompts 25, 34, 40 and 40A.

## ADR-254 — `/my-access` has no permission of its own

Gating "what am I allowed to do" behind a permission is circular, and the person who most needs the
answer is the one holding the least. The route is `@TenantScoped()` and answers only about the
caller, which is what makes it safe to leave ungated.

It is separate from `authorizationApi`, which is platform-only and answers the same question about
_other_ people. Without this endpoint a standard Employee's own navigation could not be rendered at
all, because every existing way to ask required a grant they do not hold.

## ADR-255 — The sidebar is derived from grants, in one hook, for every page

`useCompanyNavigation` filters `COMPANY_NAV` by `visibleModules`. There is deliberately **no**
`if (role === 'Employee')` anywhere: a second rule would have to be kept in step with the first, and
CR-03 says explicitly not to hardcode by role label.

It fails **open** — a pending or failed request renders the full navigation. That is the right
direction for a menu and the wrong one for a control, so the two lean opposite ways on purpose:
`useMyAccess`'s `can()` returns false while the answer is unknown, and the navigation reads
`visibleModules` directly rather than going through it. A Remove button that appears a moment late
is better than one that appears and then fails; a sidebar that flickers to empty on every page load
looks broken.

Hidden navigation remains presentation only. Twenty-six pages adopt the hook; every route still
refuses independently, and the tests assert the refusal rather than the absence of the link.

## ADR-256 — A conversation carries a reference, never a copy

`DiscussButton` attaches `{ type, id }` and nothing else. The title, the status and the link are
resolved for **each viewer** when they open the conversation, so somebody who may not see that
Objective is told so rather than reading its name out of a chat message.

Copying a title in at creation time would have leaked it permanently and invisibly — the escalation
the whole context design exists to prevent. Two people in one conversation genuinely seeing
different previews of the same reference is correct, and the screen does nothing to reconcile it.

Discuss navigates to `/chat?conversation=<id>` rather than continuing the conversation in a popover.
A second chat surface would have its own unread state, and that is how two of them end up
disagreeing about what has been read.

## ADR-257 — The focus trap must not re-run on every render

`useFocusTrap` listed `onClose` in its dependency array, and every caller passes an inline arrow. The
identity changed on every render, so the effect tore down and re-ran on every render — and its first
act is to focus the first focusable element in the dialog.

The effect was: **typing into any field in any modal moved focus back to the first control after a
single character.** The work email on Invite User, the reason on Suspend, the correction on Report
Issue. Every modal in the product accepted one character per click.

`onClose` is now held in a ref, so the handler stays current while the effect runs once per open.
Found by opening the screens, not by a test — the design-system suite had 112 passing tests and
none of them typed more than one character. Two regression tests now do.

## ADR-258 — A two-column page layout collapses on a phone, and `!important` is the honest fix

Sixteen pages set `gridTemplateColumns` as an inline style. Agent Builder's `1fr 320px` forced the
page 534px wide at a 400px viewport: it scrolled sideways, and the left column was squeezed until
every label wrapped one word per line.

An inline style beats any stylesheet rule, so the media query on `.uboss-grid` carries
`!important` — used here and nowhere else. The alternative was editing sixteen pages to carry a
breakpoint each, which is exactly the per-page styling the locked UI rule forbids.

## ADR-259 — Configured, taken and verified are three different states

The distinction the whole module is built on. A backup that is _configured_ means somebody wrote a
policy; _taken_ means a file exists; _verified_ means a restore actually succeeded and something
checked the result. Only the third is worth anything, and `mayBeReliedOn` returns true for
`Verified` alone.

A status that reported `Taken` as green is how a company discovers at the worst possible moment
that its backups were never readable — so `pg-backup.sh` prints `state=Taken — NOT verified` and
says what to run next.

## ADR-260 — The application reports on recovery; it does not perform it

`RecoveryService` reads evidence. The backup and the restore are shell scripts run where the
database server is, because **the application deliberately holds no owner credentials** — it
connects as `uboss_app`, which is `NOBYPASSRLS`, and that is the point. An endpoint that ran
`pg_dump` would need to undo that.

The consequence worth stating: `lastVerifiedRestoreAt` is supplied from the drill's own evidence
file rather than stored in a table the API can write. A status the API could update without a
restore having happened is a status somebody will eventually update.

## ADR-261 — A backup taken as `uboss_app` would be an empty backup that exits zero

`pg-backup.sh` refuses to dump as the application role. `uboss_app` is `NOBYPASSRLS`, so a dump
taken as it would silently omit every tenant row it could not see — producing a file that restores
successfully into a database with no customer data in it, and reports success at every step.

This is the single worst failure the backup path could have, and it is invisible: the dump is
non-empty, `pg_restore` succeeds, and only `RowCountsPlausible` would catch it. The refusal is
belt to that braces.

## ADR-262 — Six verification checks, no partial credit

`RestoreCompletes`, `SchemaMatches`, `RowCountsPlausible`, `TenantIsolationIntact`,
`AuditChainIntact`, `ApplicationStarts` — cheapest first, and **all six must pass**. A restore that
lost row-level security is not 83% of a good restore; it is a data breach waiting for a reader.

`TenantIsolationIntact` is the one nothing else would notice. RLS policies and `FORCE ROW LEVEL
SECURITY` are schema objects, a restore can drop them or fail to reapply them, and a restored
database that serves every tenant to every reader passes every other check on the list.

`verificationPassed` also refuses a run that **skipped** a check or repeated one six times —
otherwise a run that quietly dropped the expensive check would report success.

## ADR-263 — A rolled-back migration is not an unfinished one

Found by the first real drill, which **failed** against a perfectly good backup.

`SchemaMatches` counted any `_prisma_migrations` row with no `finished_at` as in flight. One such
row exists in this database — a rolled-back attempt from Prompt 24 — and it will sit in every backup
forever. Prisma itself reports the database as up to date.

A row that is neither finished **nor rolled back** is genuinely in flight, which is the dangerous
case: a dump taken mid-migration restores to a schema no application version can run against, and
it looks healthy until the first query. A rolled-back row is a resolved failure. The check now
excludes them.

Recorded because it is the argument for running the drill rather than writing it down: **a
verification that cries wolf is a verification people learn to skip.**

## ADR-264 — RPO is measured against a verified restore, never a taken backup

`rpoStatus` takes `newestVerifiedAt`. A company whose last verified restore was a week ago has a
week-old RPO in practice, however many files were written since — and measuring against the newest
_file_ would report a healthy figure for a backup chain nobody has ever read.

No verified restore at all returns `withinTarget: false` with an infinite breach, rather than a
null that a status page would render as blank and a reader would take for fine.

## ADR-265 — Targets are tiered, and RPO and RTO are different promises

Conflating them is how a contract becomes unachievable: continuous archiving gives a small RPO and
says nothing at all about RTO, which is dominated by how long a restore takes. Tiered because the
cost is real — a five-minute RPO means continuous archiving with off-site shipping, and promising
every customer the enterprise tier would be promising something nobody has bought.

The approved documents state no figures, so these are defaults with an argument attached, and a
company's real numbers belong in its agreement with `recovery.*` platform settings recording them.

## ADR-266 — Redis is not restored

Not an aspiration — a property the codebase already has, stated so a recovery plan can rely on it.
Every run has a durable row before it is enqueued, the ledger and the wallets are in PostgreSQL, and
the rate limiter fails open. So a recovery starts an **empty** Redis and the scheduler re-derives
what is due from the rows. Losing Redis costs queue order, not work.

## ADR-267 — Prompt injection is answered by a shape, not by a filter

UBoss has no injection denylist and should not get one. A filter is a defence that can be phrased
around, and one that removed "ignore all previous instructions" from a genuine compliance document
would corrupt the work it was hired to do.

The defence is that `ModelRequest` has a separate `instruction` and `context`, that every adapter
puts the instruction in the provider's **system** turn and the context in the **user** turn, and
that every caller passes a **literal** instruction. Untrusted material is never in a position to
impersonate an instruction, so there is nothing to detect.

Prompt 42 found this posture entirely untested — the worst combination, because it is correct
today, costs nothing to break, and its breach is invisible until somebody's spreadsheet cell is
being obeyed. `prompt-injection.spec.ts` now pins all three legs, and the static scan was verified
by introducing a real violation and watching it fail.

## ADR-268 — A static scan is the right test for an invariant about source, and must be shown to bite

Two tests added at Prompt 42 read the repository rather than running it: no caller builds a model
instruction from data, and no auth route links to a signup path.

That is unusual and it is the correct level. The claim in both cases is about **absence across the
whole codebase** — a property no amount of executing one path can establish, and one a reviewer
cannot hold in their head as the codebase grows.

The rule that comes with it: **a scan that cannot fail is worse than no scan**, because it reads as
coverage. Each of these has a companion assertion that the scan found the things it was meant to be
checking, and the injection scan was additionally proven by introducing a violation into
`run-engine.service.ts`, watching the test fail, and restoring the source.

The scan was wrong three times before it was right — it read a wrapped string literal as a
concatenation, an interface member as an assignment, and a trailing comma as a line continuation
that swallowed the next property. Every one of those was a false positive reported against correct
code, which is the failure mode to prefer: it is loud, and it was fixed by making the scan sharper
rather than by making the assertion weaker.

## ADR-269 — The end-to-end journey test asserts hand-offs, not stages

Prompt 42 asks for an E2E complete company journey. It was added to `run-engine.e2e.spec.ts` rather
than to a spec of its own, because that suite already wires the whole chain and a separate one would
have duplicated six hundred lines of module setup to assert less.

What it asserts is deliberately **not** what the per-stage suites assert. Each stage is already
covered deeply; what nothing covered is that the artefact one stage produces is the artefact the
next consumes — the assignment naming its objective, the assignment naming its agent, the operator's
screen carrying the objective forward, the run attributed back to the objective. Those seams are
where an integration breaks without any single suite failing.

One assertion was **removed from it as wrong**: that the operator holds no builder access. True of a
standard Employee, untrue of this suite's fixture, where every persona was granted `agent-builder`
when the CR-03 narrowing broke the 62 tests that drive Agent Builder as an employee. Asserting it
there would have failed, and the tempting repair — weakening the fixture — would have damaged the
suite to satisfy a test that belongs elsewhere. It lives in the CR-03 suite, which builds a clean
standard Employee for exactly that question.

## ADR-271 — RLS makes a query correct; naming the tenant makes it fast

Both are required, and until Prompt 43 only the first was a convention anybody could state.

The policy on every tenant-scoped table reads `tenant_id = current_setting('app.current_tenant_id')
OR current_setting('app.platform_operation') = 'on'`. PostgreSQL cannot use a `tenant_id`-prefixed
index for an OR whose second branch does not mention that column — and **every index on
`objective_versions`, `employment_records` and `audit_events` is tenant-prefixed**. So a query that
leaves the tenant to RLS can reach none of them and scans every company's rows.

Measured on 1,000,000 audit events across twenty companies: the same page, returning identical rows,
costs between **two and three hundred milliseconds** relying on RLS alone and **three to five
milliseconds** with `where: { tenantId }` added — a ratio of roughly **100x**, measured across four
runs. The absolute figures move with the machine; the ratio does not, which is what makes it a
finding rather than noise. Exact figures for the run in the repository: `docs/PERFORMANCE.md`.

Eight reads were filtering an unbounded table by a non-key column without naming the tenant. They
now name it. **No behaviour changed** — RLS already confined them, so the predicate is redundant by
construction and can only match rows the policy already allowed — and the five affected suites pass
249/249 unchanged.

**No index was added.** The schema's 187 indexes were right; the problem was queries that could not
reach them. Adding one would have been the obvious move and the wrong one.

`test/tenant-predicate.spec.ts` holds the rule, with permitted exceptions listed explicitly —
primary-key lookups, hash-chain reads, and deliberate platform-plane sweeps such as the notification
escalation sweeper — each carrying its reason as data.

## ADR-272 — A benchmark that writes its own version of the query is measuring the benchmark

The scale harness produced three confident false findings before it produced a true one, and each
would have caused real damage if acted on.

**It seeded one company.** With a single tenant, `tenant_id = X` matches every row, so a
tenant-prefixed index means reading the whole index _and_ the whole heap — strictly worse than
scanning. The planner chose the scan because the planner was right, and
`audit_events_tenant_id_occurred_at_idx` already existed and was correctly ignored. The harness
reported it as a missing index. Acting on that would have added a duplicate production never uses.
It now seeds **twenty** companies and measures one.

**It wrote the recursive subtree query by hand** and left the tenant out of both terms, which the
repository does not. That measured 120ms and blew its budget; with the repository's actual SQL it
measures 14ms.

**It wrote the audit query by hand** and made the same omission — the one that survived longest,
because its number looked plausible.

Two rules came out of it. The harness **copies the repository's SQL** rather than paraphrasing it.
And the slow variant is kept, relabelled as a **control**, because the comparison is the finding —
but labelled loudly enough that nobody reads its number as a UBoss latency.

The general form is worth stating, because it applies beyond this prompt: **a measurement that
disagrees with the code is usually wrong about the code**, and the first move on a surprising
benchmark result is to check the benchmark.

## ADR-273 — `eslint.config.mjs` was deleted during Prompt 43 and reconstructed from evidence

Recorded because a configuration that was rebuilt rather than restored should say so, and because
the reconstruction is only as trustworthy as the evidence behind it.

**What happened.** A `node -e` command was written with the script body inside double quotes,
and the body contained Markdown with backticks. Git Bash performs command substitution inside double
quotes, so fragments of the documentation text were executed as shell commands — the error output
shows `truncate` and `seq` being invoked, `node` being started, and whole files
(`docs/PERFORMANCE.md`, `packages/types/src/scale-validation.ts`) being run line by line
as scripts, each line's own backticks substituting again.

**What could not be established.** Which fragment removed the file. The root directory holds no stray
file of the kind a botched `>` redirection leaves, and the file was not in the recycle bin —
consistent with a shell removal rather than an editor deletion. A successful lint ran _after_ that
broken command and _before_ the file went missing, so the incident cannot be pinned to it with
confidence either. That is stated rather than resolved, because inventing a mechanism would be worse
than admitting the gap.

**Why there was no backup.** The repository is not under version control, the file was not in the
editor's local history (it had been generated rather than hand-edited), and it was not in the recycle
bin.

**How it was reconstructed.** Four independent sources agreed, which is what makes the result
trustworthy despite the loss:

1. **ADR-008** states the design in as many words — a single flat config at the root delegating to
   `packages/config/eslint.base.mjs`, _"imported by relative path so `npm run lint`
   works on a cold clone"_. That sentence is the file.
2. **`packages/config/eslint.base.mjs` survived untouched.** Every rule lives there; the root
   file held none of its own. Nothing about the rules was lost or guessed.
3. **Lint output captured earlier in the same session** matched the surviving base exactly:
   `no-console` reporting _"Only these console methods are allowed: warn, error"_, and
   `@typescript-eslint/no-unused-vars` reporting _"Allowed unused vars must match /^\_/u"_.
4. **No workspace carries its own ESLint config**, so the root must apply the base unscoped.

**Verification that it is faithful.** Running the reconstructed config reproduced **the identical
violation set** observed before the deletion — same file, same nine lines, same rule, same message —
with nothing spurious added. That is the strongest available evidence short of the original.

**What is still unproven.** Whether the original passed `extraIgnores` to `ubossConfig()`.
The base's own ignore list already covers every path in the tree that must not be linted, and linting
with no extra ignores produces a clean result, so the no-argument form is what the evidence supports.
**Byte-for-byte identity with the original cannot be claimed.**

**No rule was weakened to make lint pass.** The one genuine violation — nine `console.log` calls
in the scale harness — was fixed by moving that file to `apps/api/scripts/perf/`, where the
config's pre-existing exemption for operational scripts already applies, rather than by editing the
exemption. See ADR-274.

## ADR-274 — The scale harness lives under `scripts/`, because that is what it is

It began under `apps/api/test/perf/` for one reason: `tsconfig.test.json` compiled that
directory. That is convenience, not a category.

It is an operational script — nothing asserts, and its console output is its interface. The shared
lint config already carves out operational scripts from `no-console`, with the rationale
written beside the rule: _"a seed that reports nothing is worse than one that does"_. The repository
already keeps such things in `apps/api/scripts/`.

So when lint flagged the harness, the choice was between changing the rule and moving the file. Moving
it is the honest one: the rule was right, and the file was in the wrong place.
`tsconfig.scripts.json` gained `scripts/**/*.ts` so it still compiles, and it now runs as
`node dist-scripts/scripts/perf/scale-run.js`.

The move surfaced a second defect immediately. The docblock explaining all of this contained the glob
for a scripts directory written out literally — and that glob begins with a doubled asterisk and a
slash, which **ends a block comment**. The comment closed mid-sentence and the remaining prose was
parsed as code. TypeScript accepted it, because the fragments happened to be valid expressions;
`@typescript-eslint/no-unused-expressions` is what caught it. A small argument for the rule
being set to `error`.

## ADR-275 — CI runs the same commands a developer runs, and nothing else

Every step in `ci.yml` is an existing npm script: `npm run lint`, `npm run format:check`,
`npm run typecheck`, `npm test`, `npm run build`. There is no CI-only script and no
CI-only flag.

Two things follow, and both are the point. A green pipeline cannot mean something different from a
green machine — the two are running identical commands. And any failure can be reproduced locally by
running the command the log shows, rather than by guessing what the runner did differently.

The jobs are split by **what they need**, not by what they check: `static` needs only the source
and fails in under a minute; `integration` needs PostgreSQL and takes far longer. A formatting
slip is therefore reported in a minute rather than behind a twenty-minute database suite, and the
expensive job still runs in parallel rather than behind it.

## ADR-276 — Migrate, then release; roll back the release, never the database

The order in `.github/actions/promote/action.yml`, written once and reused by all four
environments so it cannot drift between them. Staging deploying differently from production is how a
release passes staging and fails in production for reasons nobody can reproduce.

**Schema first.** There is always a window where the new schema is live and the old application is
still serving, so every migration has to be additive or flag-gated. A migration that breaks the
running version cannot be deployed without downtime — that is a design problem, not a pipeline
problem, and pushing it into the pipeline would only hide it.

**Roll back the release, leave the migration applied.** The previous version was built to tolerate
the new schema, so leaving it is safe; un-applying it is not, because schema reversal loses the data
the change touched.

**No down-migrations at all**, and that is a decision rather than an omission. The reverse of
`DROP COLUMN` is a column full of nulls, not the column you had. Recovery from a bad migration is
point-in-time restore, and which tool to reach for is in `DECISION_TREE` — which the release
pipeline asserts is present and coherent before anything is promoted (ADR-277).

## ADR-277 — The pipeline says plainly when it did nothing

`UBOSS_DEPLOY_COMMAND` is a per-environment variable holding the host's own command. No host has
been chosen, so on every environment today it is unset — and every step that would use it checks,
logs `NOTE: nothing was released`, and exits zero.

The alternative was a step that printed "deployed to production" while running nothing. That is the
single most dangerous thing this work could have produced: a green tick that reads as a deployment,
in a repository whose documentation would then describe UBoss as having a working pipeline.

The same guard is on the health check (absent URL ⇒ _"the release was not verified"_) and on the
rollback (absent command ⇒ an **error**, because a failed release with no rollback needs a person
now, not a reassuring log line).

So: UBoss has a promotion **process** that is defined, ordered and gated. It does not have a
**deployment**. Both halves are stated in `docs/DEPLOYMENT.md` and neither should be quoted
without the other.

## ADR-278 — A release flag must declare when it will be deleted

`packages/types/src/release-flags.ts` is a registry rather than scattered `process.env` reads,
and every entry carries a `removeWhen`. A flag without one is a permanent branch in the product,
and two permanent branches are two products.

Three properties come from the registry that a bare environment read cannot give: somebody can list
what is currently gated without grepping; a flag that is not declared **cannot be read at all**, so
the registry is a constraint rather than documentation; and a typo in a flag name is a type error
rather than a silently-off feature.

Unset means **off**. A flag exists because something is not yet safe everywhere, so the failure mode
of a missing variable should be "the new thing did not switch on" — not the reverse. Only `true`,
`1` and `on` turn one on: a permissive reader turns `FLAG=false` into "on", which is
invisible in a dashboard and obvious only during an incident.

The registry ships **empty**, which is the correct state — nothing is currently gated. Its behaviour
is tested against example registries so that "empty" does not mean "untested" when the first real
flag is added by somebody in a hurry during a deploy.
