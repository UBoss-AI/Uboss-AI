# Test Matrix

## Tooling

| Workspace        | Runner                                                       | Command                                                                                                     | Why                                                                                    |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/api`       | Node built-in (`node --test`) on compiled output, serialised | `prisma generate && tsc -p tsconfig.test.json && node --test --test-concurrency=1 "dist-test/**/*.spec.js"` | ESM-only NestJS (ADR-006); serialised because suites share one test database (ADR-023) |
| `apps/web`       | Vitest 5 + jsdom + Testing Library                           | `vitest run`                                                                                                | Needed for JSX and a DOM environment                                                   |
| `packages/types` | Node built-in                                                | `npm run build && node --test "dist/**/*.test.js"`                                                          | Pure TypeScript, no DOM                                                                |
| `packages/ui`    | Vitest 5 + jsdom + Testing Library                           | `vitest run`                                                                                                | React components need JSX and a DOM (ADR-011)                                          |

Run everything from the root: `npm test`. Full gate: `npm run verify`
(lint → typecheck → test → build).

**The `apps/api` integration tests need a running database**, and run serialised
(`--test-concurrency=1`) because both suites truncate the same `uboss_test` database — running
them in parallel makes them race (ADR-023). Start the database with
`docker compose -f infra/docker-compose.yml up -d`; the suite fails with an explicit
instruction rather than a stack trace if it is missing, and refuses outright to run against
any database whose name does not contain `test`, because it truncates tables.

Discovery is glob-based for the Node-runner workspaces: API specs must end `.spec.ts`, and
`packages/types` tests `.test.ts`. Vitest picks up `*.test.tsx` / `*.spec.tsx` itself. A file named
`*.e2e-spec.ts` would not be discovered — the API e2e tests are therefore named
`health.e2e.spec.ts`, `auth.e2e.spec.ts`, `enterprise-identity.e2e.spec.ts`,
`authorization.e2e.spec.ts`, `audit.e2e.spec.ts` and `platform-console.e2e.spec.ts`.

---

## Results — 1546 passing, 0 failing (30 at Prompt 1, +82 at Prompt 2, +31 at Prompt 3, +40 at Prompt 4, +57 at Prompt 5, +126 at Prompt 6, +117 at Prompt 7, +75 at Prompt 8, +72 at Prompt 9, +36 at Prompt 10, +48 at Prompt 11, +53 at Prompt 12, +50 at Prompt 13, +36 at Prompt 14, +47 at Prompt 12B, +75 at Prompt 15, +64 at Prompt 16, +65 at Prompt 17, +68 at Prompt 18, +160 at Prompt 19, +83 at Prompt 19A, +66 at Prompt 20, +65 at Prompt 21)

### Prompt 1 — foundation

| Suite                              | Tests | Covers                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api` — `HealthController`    | 6     | Nest DI resolution; contract conformance; `ok`/`uboss-api`; version read from the app's own `package.json` (not the fallback); ISO-8601 timestamp and non-negative integer uptime; **exact key set, so no tenant/actor/config detail can leak into the unauthenticated response** |
| `apps/api` — `GET /health` (e2e)   | 3     | 200 with a valid contract over real HTTP; `application/json` content type; 404 for an unknown route                                                                                                                                                                               |
| `apps/web` — `HealthView`          | 7     | Success state; degraded state does not claim health; loading state; error state including the recovery hint; contract-mismatch state; API base URL always visible so misconfiguration shows; **status carries text, not colour alone**                                            |
| `packages/types` — health contract | 7     | Exactly three statuses; accepts a well-formed body and every valid status; rejects non-objects, unknown status, a foreign `service`, and missing/mistyped fields                                                                                                                  |
| `packages/ui` — `cn()`             | 7     | Joins classes; drops falsy values; keeps true conditions; flattens nested arrays; normalises whitespace; de-duplicates; empty result                                                                                                                                              |

### Prompt 2 — design system (`packages/ui`, 82 tests across 5 files)

| Suite                                                                                                                                                                                                                            | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DonutDashboard`                                                                                                                                                                                                                 | 9     | **Exactly three `<circle>` elements — one track, two arcs — so a third slice fails the suite**; only the two permitted category labels; total and per-category counts; both drill-downs reachable as buttons; accessible chart description; empty state instead of an empty chart; a 1-of-20 slice still renders a visible arc; a zero category drops its arc but keeps its legend entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Shells (`TopBar`, `AppShell`, `SettingsShell`, `LoginPresentation`, nav model)                                                                                                                                                   | 21    | `UBOSS AI AMS \| {Active Workspace Name}` format and order; workspace name resolved from props, not hard-coded; Master Console shows platform identity and **no** tenant name; scope pill; both shells render with their navigation; `aria-current` on the active item; navigation reports the selected key; sidebar collapse/expand; **`roles` and `users` present in `COMPANY_NAV`** (the two prototype defects); canonical Engine/Executor Agent labels; **no "template" anywhere in any label**; 19 settings sections; active section marked; personal labels for non-admins; only the sections passed in are rendered, so scope stays a server decision; all six login sections with the approved copy; **no sign-up/register/create-account affordance**; the provisioning notice                                                                      |
| Primitives (`Button`, `StatusBadge`, `MedalBadge`, `MetricCard`, `DataTable`, `EmptyState`, `ErrorState`, `Banner`, `SkeletonText`, `FormField`, `SearchField`, `ProgressStep`, `ApprovalCard`, `CreditMeter`, `SecurityMetric`) | 35    | `type="button"` default; all variants; disabled does not fire; canonical status→tone mapping and neutral fallback; badge ladder order and rendering; metric card as button only when it can drill down; DataTable success/loading/empty/error states and keyboard row activation; permission-denied carries a route onward; hard errors announced via `role="alert"`; every banner tone; loading region marked `aria-busy`; FormField label association, `aria-required`, `aria-invalid`, accessible description and `role="alert"` error; search field always labelled; ProgressStep text state per step; **ApprovalCard states that the Executor Agent cannot approve on the user's behalf**; **CreditMeter shows all four cost-lifecycle stages**, exposes a `meter` role, warns when over budget, and does not divide by zero; SecurityMetric level text |
| Overlays (`Modal`, `Drawer`, `ConfirmDialog`, `Tabs`)                                                                                                                                                                            | 17    | Closed renders nothing; labelled `aria-modal` dialog; Escape closes; backdrop click closes but an inside click does not; focus moves into the dialog on open; **ConfirmDialog shows the impact preview**, refuses to confirm until a required reason is supplied then passes it through, requires an exact confirmation phrase for destructive actions, and cancels without confirming; Tabs roving tabindex, arrow/Home/End navigation, wrap-around, disabled-tab skipping, and only the active panel rendered                                                                                                                                                                                                                                                                                                                                              |
| `cn()`                                                                                                                                                                                                                           | 7     | Joins, drops falsy, keeps true conditions, flattens arrays, normalises whitespace, de-duplicates, empty result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Prompt 3 — persistence (`apps/api`, 40 tests; 31 new)

Integration tests run against **real PostgreSQL** in the dedicated `uboss_test` database, not a
mock. A mocked client would happily agree with a broken `where` clause, so the guarantee that
matters here can only be proven against real SQL.

| Suite                          | Tests | Covers                                                                                                                                                                                                                                                                                |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation — memberships | 7     | Reads its own membership; **returns `null` for another tenant's membership id**; `null` for another tenant's user; lists/counts only its own; **a cross-tenant delete affects 0 rows and the row provably survives**; deletes its own; **cannot bump another tenant's `row_version`** |
| Optimistic concurrency         | 3     | Update applies when the expected `row_version` matches; **a stale write is rejected rather than silently overwriting a concurrent one**; a tenant rename is version-guarded                                                                                                           |
| Users through membership       | 4     | Finds a member; **`null` for a person who belongs only to another tenant**; lists only its own people; **one human employed by two companies is visible to both without either seeing the other's people**, keeping a single UBoss Unique ID                                          |
| Tenants                        | 2     | Reads only the scoped tenant; the platform-wide unique slug is enforced                                                                                                                                                                                                               |
| Audit events                   | 3     | Provisioning is a platform event and membership a tenant event, so a platform event does **not** appear in a tenant's trail; **one tenant cannot read another's trail or fetch its event by id**; counts are per-tenant                                                               |
| Transaction convention         | 3     | **A failure rolls back every write — no orphan user, membership or audit row**; multi-table writes commit together; a nested `runInTransaction` joins the outer transaction and the store does not leak afterwards                                                                    |
| Identity rules                 | 4     | Every person gets a `UB-XXXX-XXXX` UBoss Unique ID; **identity survives an email change** (the UUID and UBoss Unique ID do not move); unique email and unique UBoss Unique ID enforced; one membership per person per company                                                         |
| Health (unit, 10)              | 10    | Contract conformance; DI resolution; version from `package.json`; **`degraded` when the database is unreachable**; **a hung probe times out instead of hanging the endpoint**; exact key set; **no `postgresql://` or `password` in any failure response**                            |
| Health (e2e, 4)                | 4     | 200 with a valid contract over real HTTP against the test database; the postgres dependency reports `up`; JSON content type; 404 for an unknown route                                                                                                                                 |

### Prompt 4 — tenancy (`apps/api`, 80 tests; 40 new)

Two integration suites, both against real PostgreSQL as the unprivileged `uboss_app` role — so
every isolation assertion exercises the application layer **and** the RLS policy at once.

| Suite                                                 | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request layer — deny by default                       | 3     | An **undecorated route is refused** even for an authenticated caller; an `@AllowAnonymous` route is reachable without auth; a tenant-scoped route returns 401 unauthenticated                                                                                                                                                                                                                                                          |
| Request layer — cross-tenant denial                   | 8     | A person opens their own workspace; **Person A asking for Tenant B's workspace with a real tenant id is refused**; the same for a WRITE; **"not yours" and "does not exist" return identical bodies** (no existence oracle); a scoped read returns only the caller's own membership ids; a malformed workspace id is rejected before any query; a missing workspace is refused; Person B's own workspace works (fixture is symmetric)  |
| Request layer — platform plane                        | 4     | A platform actor reaches a platform-only route; a company person is refused there; **a platform actor is refused inside a company workspace** without a membership; an unknown actor header resolves to anonymous (401), so it cannot enumerate UBoss Unique IDs                                                                                                                                                                       |
| Request layer — lifecycle states                      | 6     | `Provisioning`, `PendingActivation`, `Suspended` and `Closed` each block access **with their own specific message**; `ReadOnly` **allows GET and refuses POST**; `Active` allows both                                                                                                                                                                                                                                                  |
| Request layer — correlation ids                       | 5     | Generated and echoed; a caller-supplied id honoured; an **unsafe id replaced** rather than echoed; **a denied request still gets one**; concurrent requests get distinct ids                                                                                                                                                                                                                                                           |
| Request layer — actor isolation                       | 1     | A verified actor does not leak from one request into the next                                                                                                                                                                                                                                                                                                                                                                          |
| RLS defence-in-depth                                  | 7     | **Zero rows when no scope is declared (fails closed)**; scoped raw SQL with **no `WHERE` clause** still returns only the caller's rows; another tenant's row is hidden **even when selected by primary key**; an `INSERT` targeting another tenant is **rejected by `WITH CHECK`**; nesting a different tenant scope throws; escalating a tenant scope to a platform operation throws; a declared platform operation may cross tenants |
| Lifecycle transitions                                 | 3     | A new company starts at `Provisioning`, not `Active`; activation is **version-guarded** and a stale second operator is refused; all six states are reachable                                                                                                                                                                                                                                                                           |
| Isolation, concurrency, identity, audit, transactions | 43    | Carried forward from Prompt 3 and re-run under RLS, plus a test that a tenant scope **refuses a non-UUID** (`' OR 1=1 --`), which is the `SET LOCAL` injection boundary                                                                                                                                                                                                                                                                |

### Prompt 5 — authentication (`apps/api` 50 new, `packages/ui` 7 new)

The authentication suite runs against **real Argon2id and real PostgreSQL**. Mocking the hasher
would make the suite fast and prove nothing: the properties under test are that a stored value is
unreadable, that verification is the only way to check a password, and that a parameter change
triggers a transparent rehash — all of which are properties of the real implementation.

| Suite (`auth.e2e.spec.ts`)           | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invitation issue, resend and cancel  | 8     | A token is returned once and **only its 64-hex hash is stored**; a resend **rotates** the token so the previous link stops working; cancel returns the account to `Not Invited` and kills the link; an invitation **cannot create a membership** (there is no public signup); an already-`Active` person cannot be re-invited; an `Offboarded` person cannot; `resend_count` increments; expiry is honoured                                                                                                                                                                                                                                                                                                                                                                                   |
| Activation                           | 5     | A valid token activates and signs in; **replay of a spent token is refused**; an expired token is refused; **a password below the minimum returns 400 and does NOT consume the invitation** (transaction rollback, then the same link still works); someone who already has a UBoss password joins without being asked for a new one                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Login                                | 5     | Correct credentials sign in and set the cookie; **the cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`**; an unknown email and a wrong password return **byte-identical bodies**; a person with no credential is refused the same way; a successful sign-in **upgrades a weaker stored hash transparently**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Lockout                              | 3     | Five consecutive failures lock the account; the locked response carries **`Retry-After`**; a successful sign-in resets the counter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Sessions                             | 14    | The list shows this device as current and others as not; **no token or hash appears in the response**; `clientHint` is a truncated prefix, never a full address; revoking one's own session returns 204 and that session's next request is 401; **revoking a session that is not yours returns the same 403 as one that does not exist**; revoking the current session signs this browser out; `logout-all` keeps the current session and reports the count; `logout-all` on an expired session clears the cookie; **one person's list never contains another person's sessions**; idle expiry refuses a stale session; absolute expiry refuses an old one; `lastSeenAt` is not rewritten while fresh; logout is idempotent; admin revoke works for a platform actor and is refused otherwise |
| Password reset                       | 6     | The request response is identical for a real and an unknown address and **carries no token**; a valid token sets a new password and **revokes every session**; the token is **single-use**; an expired token is refused; a rejected password does not spend the token; the hourly request cap is enforced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Account states gate workspace access | 6     | `NotInvited` and `InvitePending` cannot open a workspace; `Active` can; `Suspended` and `Offboarded` are refused; the **more restrictive** of the company lifecycle state and the account state wins, and the message names whichever actually blocked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Security trail                       | 3     | Activation, login, logout, reset and revoke each write a `security.*` event; **no password, token, token hash or attempted email address appears anywhere in the trail**; an audit write failure does not fail the sign-out that triggered it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

| Suite (`packages/ui`)        | Tests | Covers                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LoginPresentation` fidelity | 2     | The **radial mind-map** structure: four concentric rings, six connector paths, the central `UB` node, three cards per side; and the assurance strip (Tenant-isolated / Human governed / Fully audited). Added after the login was found to be built from the reference's **superseded** definition — see UX_MAP defect 4 |
| `TopBar` sign-out            | 2     | The sign-out control fires its handler and the avatar renders its initials; **no sign-out control when no handler is supplied**, so the shell never shows a dead button                                                                                                                                                  |
| `AppShell` sign-out wiring   | 3     | Sign-out is reachable from **both** the sidebar footer and the top bar, as the reference does, and both are wired; the role stays visible in the scope pill once the footer gives its second line to Sign out; the footer falls back to showing the role when there is nothing to sign out of                            |

The existing login copy test was **corrected**, not added to: it had been asserting the superseded
definition's wording ("Chart your organization, roles and objectives") and now asserts what the
reference actually renders ("Departments and people", and the other five).

### Prompt 6 — enterprise identity (`apps/api` 126 new: 46 unit + 80 integration)

Nothing security-relevant is mocked. The unit tests run the **published RFC vectors**; the
integration tests run against real PostgreSQL, real Argon2id, real AES-256-GCM and a **real
RSA-signing OIDC identity provider** stood up inside the suite. The only substituted component is
the DNS lookup, because a test that needs a live TXT record is a test that fails on a train.

#### Primitives — `enterprise-identity-primitives.spec.ts` (46)

The justification for implementing RFC 6238 and JWT verification in-house (ADR-030) is that they
can be _proved_ correct rather than trusted. These are the proof.

| Suite                | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| base32 (RFC 4648)    | 4     | Round-trips arbitrary bytes; **every RFC 4648 §10 vector**; the sloppy input a human actually pastes (lower case, spaces, missing padding); rejects characters outside the alphabet                                                                                                                                                                                                                                                                                     |
| HOTP (RFC 4226)      | 1     | **All ten published Appendix D values** for counters 0–9                                                                                                                                                                                                                                                                                                                                                                                                                |
| TOTP (RFC 6238)      | 4     | **Every Appendix B vector for SHA-1, SHA-256 and SHA-512**; plus the `T=20000000000` case isolated, because the RFC notes that implementations using two 32-bit halves get exactly that one wrong                                                                                                                                                                                                                                                                       |
| `verifyTotp`         | 9     | Accepts current, previous and next code (clock drift); refuses two steps away; honours a wider window; reports the matched step; **refuses a replayed step**; still accepts the _next_ code after one is spent; prefers the earliest match so it does not invalidate codes about to be shown; rejects malformed input without touching the secret; tolerates the spacing apps display                                                                                   |
| `generateTotpSecret` | 2     | 160-bit secret decoding to 20 bytes; does not repeat                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `otpauthUri`         | 2     | A scannable Key Uri with the issuer in both places; strips base32 padding, which several apps mishandle when percent-encoded                                                                                                                                                                                                                                                                                                                                            |
| Recovery codes       | 8     | 20 characters of Crockford base32 in four groups; **never contain I, L, O or U** (200 samples); hash to 64-hex and never contain the code; hash consistently however the person types them back (case, dashes, spaces, underscores); map the confusables a person mistypes (`I`→`1`, `O`→`0`); refuse input that cannot be a code; a distinct batch of ten; and **`32 ** 20 === 2 ** 100`**, asserted so shortening the code forces a re-read of why SHA-256 is correct |
| `SecretBox`          | 9     | Round-trips; **no plaintext in the envelope**; a different envelope each time so equal secrets are not detectable; **refuses to open a value sealed for a different purpose** (the column-swap attack); refuses a tampered ciphertext; refuses a value sealed with a different key; **opens a value sealed with a retired key and names a missing one**; rejects a malformed envelope; refuses to seal empty                                                            |
| `keyProviderFromEnv` | 7     | Explains how to generate a key when absent; rejects a wrong-length key **reporting the length but not the key**; rejects a malformed entry **without echoing it**; rejects a duplicate key id; rejects an unusable id; treats the first key as active                                                                                                                                                                                                                   |

#### Integration — `enterprise-identity.e2e.spec.ts` (80)

| Suite                            | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Policy: MFA required**         | 9     | A correct password **issues no session** and returns no identity, only a challenge cookie; the challenge cookie is `HttpOnly` and **`SameSite=Strict`**; a correct code completes the sign-in; the session records `mfaSatisfiedAt`; a wrong code issues nothing; **a replayed code is refused inside its own validity window**; five failed codes reach the _password_ lockout counter; the challenge is destroyed after too many attempts and even the right code cannot rescue it; **a wrong TOTP and a wrong recovery code return byte-identical bodies**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **MFA enrolment**                | 9     | Someone with no factor **enrols during a forced sign-in** and is signed in with ten recovery codes — so imposing the policy is not a lockout; codes are issued only for the _first_ factor; the secret is **never returned again**, sealed or otherwise; the stored value is an AES-GCM envelope, not the plaintext; a wrong enrolment code leaves the pending factor in place so a typo is not a re-scan; **removing the last factor is refused while a company requires MFA**; removal is allowed otherwise and takes the recovery codes with it; an active grace period permits the sign-in; an **expired** grace period stops permitting it                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Recovery codes**               | 3     | Sign in **once and only once**; are stored only as hashes with no code present in the database; a new batch invalidates the whole previous one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Policy: SSO required**         | 4     | **Cannot be set with no enabled connection** (400); once set, forces `allowPasswordSignIn: false`; a correct password is refused and the connection offered instead, with no session; **sign-in-method discovery is domain-keyed** — a real member and a non-existent address at the same domain give identical answers, and an unclaimed domain looks like an ordinary password-only company                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **OIDC, real identity provider** | 18    | Signs in a member at a verified domain, recording `primaryAuthMethod: Oidc`, the connection and the provider `sid`; satisfies an SSO-required policy; **refuses a replayed callback**; refuses an unknown `state`; refuses **`alg: none`**; refuses a wrong audience; refuses a wrong nonce; refuses a **missing** nonce; refuses an expired token; refuses an **unpublished `kid`**; refuses an unverified domain; **refuses a non-member and creates nothing** — federation is not signup; refuses a suspended member; a disabled and a non-existent connection answer identically; requests `code` + **S256 PKCE** with state, nonce and `openid`; stores the verifier encrypted and the state and nonce hashed; **never returns the client secret**; stores the client secret encrypted                                                                                                                                                                                                                                                                        |
| **SSO session termination**      | 6     | A provider back-channel logout **ends the local session immediately**, not at the next expiry; a tampered logout token is refused **and the session survives**; a token with no logout event is refused; **an ID token presented as a logout token is refused**; disabling a connection ends the sessions it issued; deleting one does too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **SAML**                         | 2     | A connection is accepted but **cannot be enabled**, with the reason; service-provider metadata is published alongside `samlStatus: not-implemented` and the **refused** ID-token algorithms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Domain verification**          | 8     | Returns the exact DNS record, normalised (lower case, trailing dot removed); an absent record fails with an **actionable** reason mentioning propagation; a wrong token fails distinctly; **joins the chunks of a long TXT record** as DNS splits them at 255 bytes; **only one company may hold a verified claim** and the second is told it is a dispute, not a DNS problem; rejects seven forms that are not a bare domain; **creates no membership**; removing a claim is recorded as a security-relevant loosening                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **SCIM 2.0**                     | 19    | Discovery is public and declares unsupported features `false`; every resource endpoint refuses without a valid bearer token, and a bare token (no `Bearer`) too; **a missing and an unknown token answer identically**; **provisioning is refused without a verified domain**; provisions once verified, `Active` and `Scim`-sourced; an equality filter finds a user, as connectors do before creating; **an unsupported filter is refused, not answered as unfiltered**; `active: false` suspends **and revokes every session immediately**; the pathless replace shape some connectors send is accepted; **an unsupported PATCH is refused, never ignored**; `DELETE` offboards and **keeps the row**; a re-push reactivates a suspended member; a duplicate is 409; **cannot see or touch another company even by guessing an id**; full group lifecycle including filtered PATCH remove; a member outside the company is **dropped**; a duplicate group name is 409; the provisioning token is returned once and stored hashed; a revoked token stops working |
| **The security trail**           | 2     | The seven enterprise-identity actions are recorded; the trail **contains no TOTP secret, client secret, SCIM token or password**, and a rotated secret appears as a boolean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

#### The test identity provider

`test/support/test-identity-provider.ts` is a real OIDC provider: a generated RSA keypair, a
discovery document, a JWKS endpoint and a token endpoint that issues properly signed ID tokens. It
is deliberately **not lenient** — it records the PKCE challenge, nonce and redirect URI from the
authorization request and refuses a token exchange that does not match, and it treats an
authorization code as single-use. A test provider that accepted anything would let a broken client
pass.

`tokenOverrides` lets a test mint a _specifically_ wrong token — wrong issuer, wrong audience,
wrong or absent nonce, expired, `alg: none`, unpublished `kid` — which is what turns "we verify ID
tokens" into an assertion rather than a claim.

### Prompt 7 — the authorization engine (`apps/api` 117 new: 63 unit + 54 integration)

The engine is a **pure function**, which is why the unit count is high and the coverage is
exhaustive rather than sampled: `evaluatePrecedence` takes a resolved input and returns a decision,
with no database, no request and no clock (ADR-039). Every privilege-escalation negative below is
something a person could plausibly try, expressed as an assertion that it does not work.

#### The engine — `authorization-engine.spec.ts` (63)

| Suite                              | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The five dimensions                | 4     | Refuses an ungranted action, naming it; refuses an invisible module; permits a granted action; **reports the outermost reason** when several would refuse, so a guest is told they are a guest rather than told their scope is wrong                                                                                                                                                                                                                                                   |
| User type ceilings                 | 4     | **A guest given every action, every module and `WholeCompany` scope still cannot `Approve`, `Publish`, `Run`, `ManageAccess`, `Administer`, `Audit` or `Export`**; a guest can still view, comment and draft; a Platform User cannot perform company workflow actions; an Internal User has no ceiling                                                                                                                                                                                 |
| Policy precedence                  | 6     | Every one of the five layers can deny; a lower layer may grant an exception to a **non-mandatory** higher denial; **no lower layer can lift a mandatory one** (tried from all four); a refused override is **traced, not silently ignored**; a mandatory control works at any layer, not only Platform; wildcard rules apply, irrelevant ones do not                                                                                                                                   |
| Scope narrowing                    | 5     | A layer may narrow; **a layer may not widen, and the ignoring is traced**; the narrowest of several ceilings wins; `SCOPE_KINDS` is asserted to be in breadth order; a listing scope is computed without deciding permission                                                                                                                                                                                                                                                           |
| Resource scope                     | 10    | `OwnWork`, `SelectedResource`, `Department`, `WholeCompany` each cover exactly what they should; an empty selected list grants nothing; **a resource with no department is not covered by a department scope** (fails closed rather than treating absence as a wildcard); `TeamSubtree` returns a distinct `scope-unevaluable`, and resolves once a resolver is registered; several grants **union** rather than narrow; two single-department grants promote to `MultipleDepartments` |
| Separation of duties               | 10    | Blocks the creator; permits a different person; **keys on the creator, not the owner**, so a reassignment cannot launder a self-approval; does not apply to unconfigured actions; four eyes needs a genuine second person; **the actor is not their own second pair of eyes**; **an automated agent can never satisfy four eyes**; there is no bypass parameter; the strictest control is reported for display; a module-scoped control does not leak to other modules                 |
| Role templates                     | 9     | Employee has no approve/publish/assign/administer anywhere; Employee can `Run` but not `Publish` or `Schedule`; **Manager has no `Approve`**, preserving the Approve & Assign boundary; **Company Admin has no `Approve`**; **Auditor has no write action anywhere, including `Comment`**; Approver cannot author what it approves; scope caps are sensible; no template names anything outside the vocabulary; company and platform sets stay separate                                |
| **Privilege-escalation negatives** | 8     | An assignment cannot grant beyond the template; **a custom role naming an unknown module or a `*` wildcard grants nothing for it**; a non-object matrix grants nothing; an Engine Agent layer cannot grant past a company mandate; an Objective layer cannot widen past its department; a guest cannot reach a forbidden action through a permitted module; an empty grant list refuses everything; an empty visibility list refuses everything                                        |
| The permission matrix              | 1     | Produced by the **same** engine that enforces, asserted action-by-action, so the two cannot disagree                                                                                                                                                                                                                                                                                                                                                                                   |
| The vocabulary                     | 5     | No duplicate modules or actions; **exactly the 14 approved actions in the approved order**; exactly the 6 approved scopes; `EditDraft`/`Publish` and `Assign`/`Approve` remain distinct                                                                                                                                                                                                                                                                                                |

#### At the request layer — `authorization.e2e.spec.ts` (54)

Against real PostgreSQL, with a probe controller declared inside the suite so the decorators are
exercised on a real route without shipping a feature endpoint.

| Suite                            | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The guard                        | 10    | Refuses someone with no assignment, naming it; permits a granted action; refuses an ungranted one with the dimension in the message; **never leaks the trace in a 403**; an **undecorated route stays permission-unchecked but is still tenancy-checked** (401 anonymous); several required permissions mean **all**; a user-type requirement applies independently of the role; several assignments **union**; an expired assignment stops granting; an expired assignment **stays on the record** |
| Escalation gates on granting     | 11    | An over-wide assignment is refused naming the ceiling; **the engine caps it again if a row is written directly**; **self-assignment is refused**; a non-member is refused; an offboarded person is refused; department and selected-resource scopes need contents; `Custom` consistency both ways; a past expiry is refused; grants and revocations are audited; whether a justification exists is recorded without requiring one                                                                   |
| Custom roles                     | 4     | **Cannot grant a permission its creator lacks**; grants only what its matrix names; a disabled role grants nothing but keeps its assignments; **the database check constraint refuses an inconsistent row written directly**                                                                                                                                                                                                                                                                        |
| Policy precedence through the DB | 6     | A company rule denies an action the role grants, with the rule's own reason surfacing to the caller; a Platform rule cannot be created from a company endpoint; **a mandatory `Allow` is refused by the API and by the database**; a Department rule needs a department; a rule narrows the listing scope                                                                                                                                                                                           |
| Separation of duties             | 5     | **The seeded platform baseline applies to a company that configured nothing**; a different person may approve; a blocked self-approval is recorded as suspicious; **the Executor Agent cannot complete a four-eyes approval** at the request layer; the baseline is exposed as inherited and mandatory                                                                                                                                                                                              |
| The internal test endpoint       | 4     | Answers with the full reasoning; evaluates a **hypothetical** resource; the matrix **agrees with the guard** on the same route; the vocabulary is published with 14 actions, 6 scopes and the guest ceiling                                                                                                                                                                                                                                                                                         |
| Tenant isolation                 | 3     | One company cannot see another's assignments; a person has no authority in a company they hold no assignment in; **a raw `SELECT` with no scope declared returns zero rows**                                                                                                                                                                                                                                                                                                                        |
| The TCSiON extension point       | 10    | Ships empty **and says why**; refuses to resolve an unmapped type **rather than defaulting** (and the message names no role); records a `tcsion_mapping_missing` event so the gap is findable; loads and resolves a supplied mapping; **requires an `approvedReference`**; refuses an unknown module; refuses a restriction on an invisible module; **the action list is a ceiling, never a grant**; a module the ceiling omits is untouched; one company's mappings do not leak to another         |

### Manual verification at Prompt 7

| Check                                                    | Result                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| Migration applied to a real database                     | 5 tables, 6 enums, 3 added columns                                       |
| RLS forced on the 5 new tables                           | `relrowsecurity` and `relforcerowsecurity` true on all 5                 |
| The 4 check constraints                                  | All present in `information_schema.table_constraints`                    |
| The seeded platform SoD baseline                         | 1 mandatory tenant-less row present                                      |
| **A mandatory `Allow` written directly**                 | Refused by the database, not only by the service                         |
| **An inconsistent `Custom` assignment written directly** | Refused by the database                                                  |
| Two guards in order                                      | `TenantGuard` then `PermissionGuard`; an undecorated route is unaffected |

### Manual verification at Prompt 6

| Check                                                      | Result                                                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration applied to a real database                       | 10 new tables, 5 enums, 6 added columns                                                                                                                                                     |
| RLS on the 7 new tenant-owned tables                       | `relrowsecurity` and `relforcerowsecurity` both true on all 7                                                                                                                               |
| Person-level MFA tables outside RLS                        | `mfa_factors`, `mfa_recovery_codes`, `mfa_challenges` — false, as intended (S-015)                                                                                                          |
| Partial unique index                                       | `... ON domain_verifications (domain) WHERE state = 'Verified'` present                                                                                                                     |
| **RLS caught a real bug on the first run**                 | Every write failed `new row violates row-level security policy` because the new repositories merged `tenant_id` but did not _declare_ the scope. Fail-closed made it loud; fixed in ADR-037 |
| A tenant scope cannot be escalated to a platform operation | Also caught at runtime — `users.createForPlatform` inside a tenant transaction was refused, and turned out not to need the escalation at all (`users` is not under RLS)                     |

### Manual verification at Prompt 5

End-to-end against the built server and the dev database, with the API started from compiled
output rather than in a test harness:

| Check                                                                                 | Result                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invite → activate → sign in                                                           | Token returned once; activation set the password and signed in; `activeWorkspaceId` returned                                                                     |
| Two devices signed in, `GET /auth/sessions`                                           | Both listed with device labels ("Chrome on Windows", "Safari on macOS"), `isCurrent` correct                                                                     |
| Field shapes consumed by the Active Sessions page                                     | Every field matched: `id`, `deviceLabel`, `clientHint`, `createdAt`, `lastSeenAt`, `absoluteExpiresAt`, `isCurrent`                                              |
| `clientHint`                                                                          | `127.0.0.0/16` — truncated prefix, never a full address                                                                                                          |
| `DELETE /auth/sessions/:id` on another of my own sessions                             | **204**, and that session removed from the list                                                                                                                  |
| `POST /auth/logout-all`                                                               | `{ "revoked": 1, "keptCurrentSession": true }`; only the current session remained                                                                                |
| The revoked device's next request                                                     | **401**                                                                                                                                                          |
| `GET /auth/me` without a workspace header                                             | `activeWorkspaceId: null` — correct for a person-level call, and the page's fallback handles it                                                                  |
| Audit trail after the whole flow                                                      | `invitation_issued`, `new_device_sign_in`, `invitation_accepted`, `login_succeeded` ×2, `session_revoked`, `logout_all_devices` — in order, with correlation ids |
| Leak scan of the entire trail (`%password%`, `%token%`, the test password, the email) | **No secret present.** The only matches were the metadata _key_ `setPassword` and the reason `password_changed`                                                  |
| Redaction fix confirmed                                                               | New rows record `{"setPassword": true}`; an older row from before the fix still shows `{"setPassword": "[redacted]"}`, which is what the fix removed             |
| Lockout                                                                               | `Retry-After: 900` accompanied the locked response                                                                                                               |
| Short password at activation                                                          | 400, and the invitation link still worked afterwards                                                                                                             |

### Manual verification at Prompt 4

RLS checked directly in SQL as `uboss_app`, before any application code depended on it:

| Situation                                         | Result                                                     |
| ------------------------------------------------- | ---------------------------------------------------------- |
| No scope declared                                 | **0 rows**                                                 |
| Scoped to Tenant A, count all memberships         | 1 (only A's)                                               |
| Scoped to Tenant A, select B's row by primary key | **0 rows**                                                 |
| Declared platform operation                       | all 3 rows                                                 |
| Roles                                             | `uboss` = superuser + bypassrls; `uboss_app` = **neither** |

Runtime checks against the built server:

| Check                                                     | Result                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /health` public, DB probed via the unprivileged role | 200, `postgres: up`                                                       |
| Correlation id generated and echoed                       | `x-correlation-id` present                                                |
| Caller-supplied id honoured                               | `my-trace-001` echoed                                                     |
| Unsafe id (`bad value`)                                   | replaced with a generated UUID                                            |
| `AUTH_DEV_HEADERS_ENABLED=true` + `NODE_ENV=production`   | **process exits 1** with the explicit refusal                             |
| `NODE_ENV=production` without the flag                    | starts normally; **no** dev resolver wired; the dev header grants nothing |
| Seed after the lifecycle migration                        | idempotent; demo company `Active`; still no credentials                   |

### Manual verification at Prompt 3

| Check                                | Result                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration applied to a real database | 4 tables + `_prisma_migrations`, all indexes and FKs present (`\d` inspected)                                                                                         |
| Column naming                        | every column `snake_case`, verified against `information_schema`                                                                                                      |
| **No credential columns anywhere**   | `information_schema` query for `%password%`, `%secret%`, `%token%`, `%credential%`, `%aadhaar%` returned **nothing**                                                  |
| Seed                                 | created a demo Platform Admin (`UB-DEMO-PLAT`) and one demo company with one member; **no credentials**                                                               |
| Seed idempotency                     | second run reported "already present" and changed nothing                                                                                                             |
| API against a reachable database     | `Connected to PostgreSQL`; `/health` returned `status: ok`, `postgres: up`, 3ms                                                                                       |
| API against an unreachable database  | `/health` returned `status: degraded`, `postgres: down`, `reason: "ECONNREFUSED: PrismaClientKnownRequestError"` — and **no connection string, username or password** |

### Manual verification at Prompt 2

Served the production build and inspected the rendered HTML:

| Check                                        | Result                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| All six showcase routes                      | 200                                                                                                                                 |
| Company shell header                         | `UBOSS AI AMS` + `<span class="uboss-ws-mark-name">SPM Medicare`                                                                    |
| **Company Workspace Dashboard widget audit** | 1 donut; **0** metric cards, **0** tables, **0** credit meters, **0** security metrics                                              |
| Login page                                   | all six sections present; the only signup match is the "No public company signup" disclaimer; **no `<a href>` to any signup route** |
| Master Console                               | platform identity present; **0** tenant workspace-name elements                                                                     |
| Settings shell                               | 19 left-navigation items                                                                                                            |

### Runtime verification at Prompt 1

| Check                              | Result                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| API starts and serves `/health`    | 200 with the exact contract body                                                    |
| Security headers present           | CSP, HSTS, `nosniff`, `Referrer-Policy`, COOP, `X-Frame-Options`                    |
| `X-Powered-By`                     | Absent                                                                              |
| Unknown route                      | 404                                                                                 |
| Web `/health` against a live API   | Rendered "API Healthy", service `uboss-api`, version, status, uptime                |
| Web `/health` with the API stopped | Rendered "API Unreachable" with the recovery hint — error state proven, not assumed |

---

### Prompt 8 — audit and security foundations (`apps/api` 75 new: 20 unit + 55 integration)

#### The tamper-evidence primitive — `audit-chain.spec.ts` (20)

No database. These are the tests that decide whether the guarantee in ADR-046 is real: a hash
chain that _looks_ right but does not cover a field, or verifies a reordered chain, is worse than
no chain — it produces a confident green tick over tampered data.

| Suite        | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hashing      | 8     | Deterministic; **every one of the 12 hashed audit fields changes the hash, with the case count asserted equal to the field count** so a new column added without coverage fails a test; position, predecessor and chain key are covered (a row cannot be moved or transplanted); the format version is inside the hash; metadata hashes by content, not key order; **a delimiter moved between two values does not collide**; the 15 security fields, including turning a failed sign-in into a successful one |
| Verification | 10    | Accepts an intact chain and reports its head; accepts an empty chain; detects an **altered** row, a **deleted** row, a **reordered** chain, a **self-consistently forged** insertion, and two rows claiming one position; **reports unchained pre-Prompt-8 rows instead of counting them as verified**; honours a sealed checkpoint as a starting point; **reports a checkpoint that no longer matches the chain** — the case an external anchor exists for                                                    |
| Keys, locks  | 2     | Tenant vs platform chain key; a stable, **positive** 63-bit lock key that differs per trail and per chain (a negative value would be a runtime error on whichever chain key hashed with the top bit set)                                                                                                                                                                                                                                                                                                       |

#### At the request and database layer — `audit.e2e.spec.ts` (55)

| Suite                           | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Append-only, by the database    | 12    | Every row is chained and linked; **`UPDATE` and `DELETE` from the application role fail with `permission denied`**; **both fail from the OWNER role too, via the trigger**; **`TRUNCATE` is refused on both trails**; the same protection covers the checkpoints; **the test-only truncate flag is asserted absent from all six audit source files**; the chain stays contiguous under 12 concurrent appends; each company gets its own chain starting at 1; every client-named field is stored; a secret in metadata is redacted while a boolean survives                                                                                                                                                                                                                                                                                                                                                                                        |
| Chain verification              | 7     | Reports intact with the guarantee **including its "NOT guaranteed" half**; **detects a row rewritten by a superuser with the trigger disabled**; detects a deleted row; records a `Critical` event when a chain breaks; seals at the head and **refuses to seal a broken chain**; **the stated guarantee changes once a checkpoint is externally anchored**; refuses to seal an empty chain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Export and filter authorization | 12    | Auditor and Company Admin may read; an Employee may not; **a department-scoped `Audit` grant is refused rather than over-returned**; export needs `Audit` **and** `Export`, and records who exported; a role with `Audit` but not `Export` may read and not export; **another company's rows never appear, whatever the filter asks for**; a workspace the caller does not belong to is refused; filters by action, actor, resource and window; `action` + `actionPrefix` together is a 400; an undeclared filter field is a 400; the cursor stops without an extra empty request                                                                                                                                                                                                                                                                                                                                                                 |
| The security trail              | 5     | **Security events land in `security_events`, not in the audit trail** (ADR-045); classification is derived from the action key, so `sod_policy_deleted` is `Critical` and `login_succeeded` is `Info`; **tenant-less events are unreachable from a company trail**; the platform plane is platform-only; filters by category, severity and outcome, and rejects an invalid one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Break-glass                     | 19    | The **full lifecycle**, with all seven audit actions landing in the **customer's** trail carrying the incident reference; **self-approval refused and recorded as `Critical`/`Blocked`**; self-verification refused; cannot approve before identity is verified; cannot activate before approval; a failed verification denies terminally and cannot be retried; an unbounded scope is refused; **`Administer` and `ManageAccess` are refused outright**; a platform module is refused; a thin reason is refused; the window is capped; **an elapsed grant stops granting on read, without a sweep**; uses are counted so "granted but never used" is provable; suppression needs a written reason and is `Critical`; outstanding notification debts are listable; **all three database check constraints refuse a bypass of the service**; platform-only at the request layer; the requester comes from the actor and a body naming one is a 400 |

### What Prompt 8 changed in the existing suites

Recorded because it is the visible cost of ADR-045, and because a reader comparing counts will
notice: **eight** Prompt 5–7 tests read `security.*` events out of `audit_events`. They now read
`security_events`. Only the destination changed. The enterprise-identity "contains no secret of
any kind" test was widened to search **both** trails — searching only the old one would have
quietly stopped covering the table the identity events actually land in, which is the worst kind
of test rot: still green, no longer testing anything.

Three suites also had to register `SecurityEventService` and `AuditTrailRepository`, because
`SecurityEventPublisher` now delegates to them.

### Bugs these tests found (not fixed speculatively — found by a red test)

| Bug                                                                                                                                                                                                                                                                                                                                                                                           | Found by                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **A blocked self-approval was rolled back by the exception that refused it.** The refusal was recorded inside the transaction the `ForbiddenException` then aborted, so the control blocked the action and left no trace of having blocked it. Refusals now record in their own transaction (ADR-048).                                                                                        | "records a blocked self-approval as suspicious activity"                                                                        |
| `pg_advisory_xact_lock` returns `void`, which the Prisma pg adapter cannot deserialize — `$queryRaw` fails with `UnsupportedNativeDataType`. Every append failed.                                                                                                                                                                                                                             | The whole append-only suite at once                                                                                             |
| The adapter returns `int8` as a decimal **string**, so a raw-query row typed `bigint` compiled and lied at runtime.                                                                                                                                                                                                                                                                           | Same                                                                                                                            |
| `JSON.stringify` throws on a `bigint`, so every trail read endpoint was a 500 until the rows were given an explicit API shape.                                                                                                                                                                                                                                                                | Seven authorization tests                                                                                                       |
| **Provisioning and the seed were still writing _unchained_ rows** through the Prompt 3 repository, which would have turned the reported `unchainedCount` from "rows written before the chain existed" into "…plus whatever still uses the old path". The write methods were deleted from `AuditEventRepository` rather than deprecated, so an unchained write is now structurally impossible. | A deliberate check of who still used the old repository, then a new regression test asserting zero rows with a null `chain_key` |

### Manual verification at Prompt 8

Every append-only control was exercised in raw `psql` **before** any code depended on it, the
same discipline as Prompt 4's RLS work — a control assumed to work and never exercised is a
control that does not work.

| Check                                              | Result                                        |
| -------------------------------------------------- | --------------------------------------------- |
| `UPDATE` / `DELETE` as `uboss_app`                 | `permission denied for table audit_events`    |
| `UPDATE` / `DELETE` as the owner `uboss`           | Refused by trigger, message naming ADR-046    |
| `TRUNCATE` as the owner                            | Refused by the statement trigger              |
| `TRUNCATE` with `uboss.allow_history_truncate` set | Permitted — the harness path, and only that   |
| A duplicate `(chain_key, sequence)`                | Rejected by the unique index                  |
| All five `break_glass_requests` check constraints  | Each one fired on the row it exists to forbid |
| Migration diffed `--from-migrations`               | 3 `CREATE TABLE`, **0** `DROP` statements     |

---

### Prompt 9 — the UBoss Master Console (`apps/api` 72 new: 26 unit + 46 integration)

#### Platform roles and the dashboard's derivation — `platform-roles.spec.ts` (26)

No database. Two properties are proved here that a request-layer test cannot prove cheaply.

| Suite                   | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The ceiling             | 4     | Every role defined and summarised; **no role grants anything `PLATFORM_PERMISSIONS` does not** — the property the whole decomposition rests on, so a role can only ever subtract; no role names a company module; **every role can read every module**, because an operator who cannot see a module cannot reason about the platform                                                                                                                                                                                                                                     |
| Who may change what     | 6     | **Exactly `PlatformOwner` administers `release` and `platform-settings`**; **`PlatformAdmin` loses nothing else relative to the ceiling**, so the migration backfill is provably not a downgrade; Security administers only security; Support administers nothing commercial or security; Engineer reads releases and cannot control them; roles union; **no roles ⇒ empty set**                                                                                                                                                                                         |
| Navigation key mapping  | 3     | The two keys that differ (`dashboard`, `health`) map correctly; all fifteen modules have a nav key and every mapping names a real module; **an unmapped key returns `undefined`** so a new navigation item fails closed                                                                                                                                                                                                                                                                                                                                                  |
| Company attention flags | 13    | The reference's `42 / 60` and `68%` labels; an em dash for both when there is no plan; Billing on overdue and on grace; Budget at exactly the 85% threshold and **not** below it; Seats at 90%; Renewal inside the window and a past renewal reported as overdue; **Security outranks every commercial flag** in three separate ways; an un-notified break-glass record is a security signal with its reason named; **a pinned flag beats the derivation and says it was pinned**; every reason is collected even though one flag shows; a suspended company is reported |

#### At the request layer — `platform-console.e2e.spec.ts` (46)

Against real PostgreSQL, one platform actor per role plus one with no role plus a company person.
Most of this suite is one shape repeated across six roles, and **the negatives are the point** —
before Prompt 9 the guards could not refuse anybody.

| Suite                | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform-role guards | 9     | A company person is refused outright; **a platform actor with no role is refused** (the fail-closed change); such an actor can still reach `me` to discover why; every role reads the dashboard; only Owner/Admin/Commercial administer plans; **only the Owner controls a release, changes a setting or grants a role**; a Security reviewer reads the access review and cannot grant; only Owner/Engineer act on an alert; each caller is told which navigation and which actions they hold                    |
| The dashboard        | 4     | Companies, seats, renewals, billing, usage and alerts in one aggregate; **every panel marked measured / configured / demo**; **a real break-glass obligation moves the company's flag to Security** — proving the link to the Prompt 8 trails rather than asserting it; **only active memberships count as used seats**                                                                                                                                                                                          |
| Companies & detail   | 6     | The list carries each company's commercial position; detail returns entitlements plus **the company's own audit trail**; **withheld modules win over extras**; a commercial change is written into the company's own trail with its reason; a change with no reason is refused; a missing company 404s                                                                                                                                                                                                           |
| Plans                | 5     | The migration-seeded plans with subscriber counts; **a plan cannot entitle a platform module**; a duplicate code is refused; **retiring a plan with subscribers is refused and names the count**; a negative price is refused by the API **and** by the check constraint                                                                                                                                                                                                                                         |
| Feature flags        | 4     | A new flag is `Dev`/`Paused`/0% and `state` is not accepted at creation; **an `Active` flag at 0% with nobody named is refused**; a paused flag carrying a rollout is refused by the service **and** the database; every change needs a reason and records a security event                                                                                                                                                                                                                                      |
| Platform settings    | 4     | **A locked setting is refused even for the Owner**; the two client-stated locked rules are exposed; a change records a `Critical` security event; a reason is required                                                                                                                                                                                                                                                                                                                                           |
| Granting authority   | 9     | **A self-grant is refused and the attempt recorded** (outside the refused transaction, so the record survives); the database refuses a self-granted row too; **a company person cannot be given a platform role**; a past expiry is refused; a justification is required; **an expired grant stops working on the very next request**; **revoking the last Platform Owner is refused** and records a `Critical` event; revoking one is allowed once a second exists; platform staff holding no role are surfaced |
| Create Company entry | 2     | The prerequisites carry `wizardImplemented: false` and the locked creation rule; **there is no provisioning endpoint at all** — both plausible POST paths 404                                                                                                                                                                                                                                                                                                                                                    |
| Module shells        | 1     | Seven shells, each with a **specific** blocker rather than "coming in the next batch"                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Bugs Prompt 9's tests found

| Bug                                                                                                                                                                                                                                                                                                                                                  | Found by                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **`PlatformAdmin` was silently losing an action relative to the ceiling.** Listed by hand, it dropped `Comment` on the dashboard — which would have made the migration backfill a downgrade of somebody's working access. The role is now **derived from the ceiling by subtraction**, so the relationship is structural.                            | "keeps PlatformAdmin equal to the old blanket grant"     |
| **Every platform-settings write was a 400.** `UpdatePlatformSettingDto.value` had no validation decorator, and `whitelist: true` **strips** undecorated properties before `forbidNonWhitelisted` rejects the request. Fixed with `@Allow()`, which is load-bearing rather than cosmetic.                                                             | "lets ONLY the Owner change a global setting"            |
| **`platformContext('')` — an empty user id.** The authorization controller built a whole authorization context around a fake id purely to read the platform SoD baseline. Harmless while the method did no user lookup; Prompt 9 gave it one, and `WHERE user_id = ''` is an invalid uuid — a 500. Replaced with a `platformSodBaseline()` accessor. | "exposes the platform baseline as inherited"             |
| **Test-created plans and flags leaked across runs.** Platform-plane tables have no tenant to cascade from, so `TRUNCATE tenants CASCADE` cannot reach them; a plan created by one run collided with the same test on the next. The harness now resets to exactly what the migration seeds.                                                           | "lets only Owner, Admin and Commercial administer plans" |
| **`uboss-hint` had no CSS rule at all** and had been rendering unstyled since Prompt 8. Replaced with `uboss-muted-3` across every use, including the Prompt 8 audit page.                                                                                                                                                                           | Reading the stylesheet before reusing the class          |

### Manual verification at Prompt 9

Every constraint exercised in raw `psql` **before** any code depended on it, and the dashboard's
columns compared against the client's reference data.

| Check                                                        | Result                                            |
| ------------------------------------------------------------ | ------------------------------------------------- |
| All seven new check constraints                              | Each fired on the row it exists to forbid         |
| Backfill reached the existing platform actor                 | `PlatformAdmin`, `granted_by_user_id` NULL        |
| `tenant_subscriptions` with no scope declared                | 0 rows — RLS fail-closed                          |
| `plans` with no scope declared                               | 4 rows — no RLS, as designed (S-054)              |
| Migration diffed `--from-migrations`                         | 6 `CREATE TABLE`, **0** `DROP` statements         |
| Seeded plans / settings / flags                              | 4 plans, 8 settings (2 locked), 1 flag            |
| Dashboard columns vs the client's `COMPANIES` reference data | Usage 68/44/91/0/57%, billing and flags all match |
| `npm run build` route manifest                               | 16 `/master/*` routes                             |

---

### Prompt 10 — company provisioning and activation (`apps/api` 36 new, all integration)

`company-provisioning.e2e.spec.ts`, against real PostgreSQL. Three properties carry this prompt,
and the negatives are where the work is.

| Suite                    | Tests | Covers                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No public company signup | 4     | A company person is refused; a platform actor **without `create-company:Create` is refused** (Platform Support cannot provision — creating a customer is not a support act); anonymous is 401; **four plausible self-service paths all fail to create anything**                                                                                           |
| The ten wizard steps     | 4     | Company identity lands with `Provisioning` state; plan, AI settings, budget policy, security defaults and a **claimed-not-verified** domain all written; the ten checklist items in the client's order with their rationales; the narrow provisioning primitive deliberately creates **no** checklist                                                      |
| Bootstrap authority      | 5     | `CompanyAdmin`/`WholeCompany` with **null grantor and `bootstrap: true`**; a distinct `company.bootstrap_admin_granted` audit action **in the company's own trail** with its reason; a `Critical` security event; **the first admin can administer immediately**; provisioning **cannot mint any other role**                                              |
| Secure activation        | 4     | An invitation exists with only a 64-char hash stored; **no token or password-bearing field in the response**; the outbox payload carries the invitation **id** and nothing token-shaped; **no credential row is created at all**; the account is left `InvitePending`, not `Active`                                                                        |
| One transaction          | 2     | **A failure after the tenant insert leaves no company, no person, no invitation and no outbox row** — counted before and after; a replayed `idempotencyKey` returns the **same** company and creates no second one                                                                                                                                         |
| Validation               | 8     | Renewal before start; **approval threshold above the hard stop**; a platform module in the entitlement list; a Custom Enterprise Provider with no endpoint; **a payload carrying `providerApiKey` is a 400**; **a payload carrying `adminPassword` is a 400**; a hint long enough to be a real key; junk code/country/currency; zero seats; a retired plan |
| The setup checklist      | 5     | Readable by the new administrator with the **next recommended action** named; **skipping requires a reason** and counts as resolved while staying visibly skipped; progress is audited into the company's own trail; an unknown key is refused; `complete` only when nothing is unresolved                                                                 |
| The outbox               | 2     | Visible to platform support and **reports `dispatcher.running: false`**; claim → `InFlight` → delivered, with attempts counted                                                                                                                                                                                                                             |

### Bugs Prompt 10's own review found before applying

| Bug                                                                                                                                                                                                                                                                             | Found by                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **The migration added a constraint before the backfill that satisfies it.** `grant_with_no_grantor_is_marked_bootstrap` requires the flag in both directions, so it would have failed on any database already holding a null-grantor grant. Reordered so section 2a runs first. | Reading the SQL before applying it    |
| `DomainVerification.expiresAt` is required, and the claim created at step 8 had none.                                                                                                                                                                                           | `npm run typecheck`                   |
| **A test assertion forbade the word "password" anywhere in the response**, which would have banned the deliberate "No password was created" reassurance. Narrowed to password-bearing _keys_.                                                                                   | The test failing on correct behaviour |

### Manual verification at Prompt 10

| Check                                          | Result                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| All eleven new check constraints               | Each fired on the row it exists to forbid          |
| The four new tables with no RLS scope declared | 0 rows each — fail-closed                          |
| Migration diffed `--from-migrations`           | 4 `CREATE TABLE`, **0** `DROP` statements          |
| Backfill across the six existing companies     | codes, AI settings, ordered budgets, 10 tasks each |
| `npm run build` route manifest                 | 31 routes, wizard included                         |

---

### Prompt 11 — plans, entitlements, seats and company lifecycle (`apps/api` 48 new)

`seats-lifecycle.e2e.spec.ts`, against real PostgreSQL. Four properties carry this prompt.

| Suite                                   | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seat counting rules                     | 6     | The three rules count exactly the states they name; used/available/per-state breakdown; an outstanding invitation **is** a committed seat under the default; it is free under `ActiveOnly`; a suspended account **keeps** its seat under `ActiveInvitedAndSuspended`; a per-company override beats the plan's rule                                                                                                                                                                                                                                 |
| The ceiling cannot be silently exceeded | 8     | A warning near the ceiling; a claim while there is room; **a refusal at the ceiling that says whether more can be requested**; a plan that forbids requests says so instead; a state the rule does not count consumes nothing; somebody already counted is not double-charged; **a company with no plan is refused rather than treated as unlimited**                                                                                                                                                                                              |
| — **the concurrency race**              | 1     | **Two concurrent claims for the last seat, in separate transactions: exactly one succeeds, one is refused, and the company never exceeds its contracted ceiling.** The case a displayed count cannot handle, and the reason `claimSeat` takes an advisory lock (ADR-060)                                                                                                                                                                                                                                                                           |
| Reducing seats destroys nothing         | 5     | The assessment states in the API's own words that nothing is deleted; **users, memberships and audit rows counted before and after a reduction — the first two unchanged, audit only grows**; the grace window holds the old ceiling; the lower ceiling is enforced once grace passes and the existing people are untouched; `nothingDeleted` in the trail                                                                                                                                                                                         |
| Plan is not RBAC                        | 5     | **The position serialises with nothing role-shaped in it** and an `rbacNote` explaining why; the five concepts are five separate groups; **changing plan and seats leaves the permission matrix byte-identical**; withheld beats extra; the release channel is separate from the entitlement                                                                                                                                                                                                                                                       |
| Company views, platform decides         | 13    | Any company role may read the seat position; a Company Admin may request; **a non-admin role is refused**; **there is no company-side route that sets a ceiling** (PUT refused on both paths); a request naming nothing is 400; a second open request of a kind is 409; **the requester cannot decide their own request** and a `Critical` event records it; an increase applies at once; a downgrade schedules; a scheduled change applies on its date; withdraw; **one company never sees another's requests**                                   |
| Company lifecycle                       | 11    | State, what it permits and where it may go; the exact per-state behaviour table; a suspension records its reason **in the company's own trail**; no reason is refused; **a closed company cannot be reopened**; closure deletes nothing (memberships, roles and audit counted); a scheduled transition is recorded and **not applied**; it applies on its date and `ReadOnly` is accessible-but-not-writable; the history answers "what state, when"; platform-only at the request layer; **a Commercial platform role cannot suspend a customer** |

### Bugs Prompt 11's own tests found

| Bug                                                                                                                                                                                                                                                                                                                                                       | Found by                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **A blocked self-decision left no trace.** The `commercialSelfDecisionBlocked` security event was recorded inside the transaction the refusing `ForbiddenException` then rolled back — so the control worked and the evidence vanished. **The same bug as Prompt 8's break-glass self-approval, recurring.** Now recorded in its own transaction (S-064). | The test asserting the security event exists  |
| **A plan column mutated by one test poisoned a different test on the next run.** A test set `allow_seat_requests = false` on the Growth plan; plans are platform-plane configuration that `TRUNCATE tenants CASCADE` cannot reach, so the leak crossed runs rather than tests. The harness now resets the seeded plans' commercial columns.               | A previously-passing test failing on a re-run |

### A design change the tests forced

`applyDuePlanChanges` and the immediate plan-change path opened a grace window on **any**
downgrade, while `setContractedSeats` opened one only when the company was actually over the new
number. Writing the assertion exposed that the "harmless" version is the dangerous one: a company
at 3 people dropping from 40 seats to 10 could add 37 more during the window and be far over its
contract the moment it shut. All three paths now share `graceForNewCeiling` (ADR-061).

### Manual verification at Prompt 11

| Check                                            | Result                                          |
| ------------------------------------------------ | ----------------------------------------------- |
| All ten new check constraints                    | Each fired on the row it exists to forbid       |
| The two new tables with no RLS scope declared    | 0 rows each — fail-closed                       |
| `relrowsecurity` / `relforcerowsecurity`         | Both true on both new tables                    |
| Migration chain diffed `--from-migrations`       | Empty — the chain matches the datamodel exactly |
| The migration file itself                        | 2 `CREATE TABLE`, 4 `CREATE TYPE`, **0** `DROP` |
| `DROP` in any migration in the whole chain       | None                                            |
| Lifecycle backfill across the six demo companies | Exactly one reconstructed transition each       |
| `npm run build` route manifest                   | 34 routes, both new screens included            |

---

### Prompt 12 — hierarchy, departments and the person registry (`apps/api` 53 new)

`hierarchy.e2e.spec.ts`, against real PostgreSQL. Five properties carry this prompt.

| Suite                            | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aadhaar normalisation            | 4     | Spaced and unspaced input produce the **same** normalised value (or one person entered twice becomes two people); the wrong length, a bad leading digit, twelve identical digits and a bad checksum are each rejected with their own reason; **every single-digit error and every adjacent transposition is caught**; the mask is exactly `XXXX XXXX 5510`                                                                                                                                                                                                        |
| Departments                      | 9     | The tree; a duplicate name refused; **a parent from another company refused**; re-parenting under a descendant refused; archiving refused while people are in it; archiving an empty one keeps it queryable with `nothingDeleted`; needs `hierarchy:Administer`; one company never sees another's                                                                                                                                                                                                                                                                 |
| Add Employee                     | 14    | Exactly six mandatory keys served; the first person may have no manager; **a permanent UBoss ID is created**; the new person is `NotInvited` with **no credential and no invitation**; a keyed 64-hex digest and only the last four digits are stored; **one UBoss Unique ID across two companies with two Employee IDs**; a second root refused naming who is already at the top; a duplicate Employee ID refused; a manager not employed here refused; malformed and checksum-invalid Aadhaar refused; needs `hierarchy:Administer`; **no invite route exists** |
| — **the number appears nowhere** | 1     | After adding an employee, a query searches `person_identifiers`, `audit_events`, `security_events`, `users` and `employment_records` for the Aadhaar number and asserts **zero** occurrences                                                                                                                                                                                                                                                                                                                                                                      |
| — **no company leak on match**   | 1     | The match result has exactly five keys and its serialised form mentions no company or employment — a matching company learns a person exists, not where they work                                                                                                                                                                                                                                                                                                                                                                                                 |
| The reporting tree               | 11    | Grouped by department and nested by manager, with a cross-department manager appearing at their own department's root; the list view's seven columns; Vision and Mission displayed and gated on `settings:Administer`; a move; **a cycle refused with the refusal recorded**; self-management refused; **a cycle refused by the database with the service bypassed entirely**; a 23-level chain; detaching; needs `hierarchy:Administer`                                                                                                                          |
| `TeamSubtree` authorization      | 5     | **Resolves instead of returning `scope-unevaluable`** — the limitation open since Prompt 7; a resource owned by somebody _above_ the manager is out of scope; the manager's own work is in scope; it does not reach across companies; **it answers false when there is no tree at all** (fail-closed)                                                                                                                                                                                                                                                             |
| Who may see what                 | 6     | An ordinary employee sees the structure; **the masked identifier is withheld from them by omission**, and present for an administrator; a person sees their own; no response carries `Verified`; the Company Employee ID and the UBoss Unique ID are distinct and the permanent id is not derived from the identifier; no cross-company employment records                                                                                                                                                                                                        |
| Editing employment               | 4     | This company's fields update; **the portable identity cannot be changed** (a 400 from `forbidNonWhitelisted`); a duplicate Employee ID on edit refused; moving into an archived department refused                                                                                                                                                                                                                                                                                                                                                                |

### Bugs Prompt 12's own tests found

| Bug                                                                                                                                                                                                                                                                                                                                                                                                         | Found by                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **The person registry had the wrong scoping model.** Its lookup wrapped itself in `runAsPlatformOperation`, which correctly **refuses to escalate** from inside a tenant transaction — and the whole match-or-create must be atomic with the employment record. Fixed by joining the caller's transaction, like `OutboxRepository`: the tables involved have no RLS policy, so there is nothing to declare. | The suite failing on every Add Employee test     |
| **A Prompt 8 test used `'dept-1'` as a placeholder department id.** Harmless while `department_ids` was an unvalidated `text[]`; the new trigger refuses a department that does not exist, which is exactly the dangling reference it exists to prevent. The fixture now creates a real department.                                                                                                         | The whole API suite, after the migration applied |
| **The trigger's own error message was a raw cast failure.** `candidate::uuid` on a non-uuid produced PostgreSQL's `invalid input syntax for type uuid`. The trigger now checks the format first and explains what is wrong. Fixed in the migration and both databases rebuilt from the chain, rather than patched in place.                                                                                 | Reading the failure above                        |
| **An over-broad assertion banned the word "verified".** It forbade `/verified/i` anywhere in a profile, which banned the deliberate reassurance "Aadhaar was entered for matching only and **is not verified**" — the same mistake narrowed at Prompt 10 for "password". Now forbids `Verified` as a _value_ and any phrase _claiming_ verification.                                                        | The test failing on correct behaviour            |

### Manual verification at Prompt 12

A 16-case raw-SQL script, run before any code depended on the schema.

| Check                                                      | Result                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| RLS forced on `departments` and `employment_records`       | `relrowsecurity` and `relforcerowsecurity` both true              |
| `person_identifiers` has no RLS                            | Both false — deliberate; it has no tenant column (S-066)          |
| All ten check constraints and three composite foreign keys | Present, and each refused the row it exists to forbid             |
| Both triggers                                              | Present on the right tables and each fired                        |
| `identifier_assurance` values                              | `EnteredOnly, NotVerified` — **no `Verified`**; `psql` rejects it |
| An Aadhaar number in `match_hash`                          | Refused by `match_hash_is_a_hex_digest`                           |
| A three-person reporting loop, driven at the table         | Refused by the trigger                                            |
| A reporting manager with no employment record here         | Refused by the composite foreign key                              |
| A department parent from another company                   | Refused by the composite foreign key                              |
| A `Department` role assignment naming a non-existent uuid  | Refused, with the explanation; the real department accepted       |
| The recursive subtree query                                | 3 from the top of a three-person chain, 2 from the middle         |
| Both new tables with no scope declared                     | 0 rows each — fail-closed                                         |
| `departments` inside a declared tenant scope               | 1 row, and 0 rows from any other tenant                           |
| Backfill                                                   | One `General` department per company, 6 of 6                      |
| Migration chain diffed `--from-migrations`                 | Empty — the chain matches the datamodel exactly                   |
| `DROP` in the migration, and in the whole chain            | None                                                              |

---

### Prompt 13 — Users & Access, guests and bulk lifecycle (`apps/api` 50 new)

`users-access.e2e.spec.ts`, against real PostgreSQL. Six properties carry this prompt.

| Suite                         | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The activation readiness rule | 3     | Department, manager and role all required, with **every** missing prerequisite returned; the manager requirement waived for the first person in a company; guests exempt entirely                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The three tabs                | 4     | Employees, guests and pending invitations split server-side; **somebody with no employment record, no role and no invitation still appears** (an inner join would hide exactly the person an administrator came to deal with); the seat position; `users:View` refused to an ordinary Employee                                                                                                                                                                                                                                                                                                           |
| Inviting an existing person   | 8     | **Links to the same identity — `users` count unchanged**; the synthesised placeholder replaced by a real address; refused when there is nowhere to send it; refused before sending when not ready; **a seat is claimed**; refused at the contracted ceiling; the token is never returned; `users:ManageAccess` required                                                                                                                                                                                                                                                                                  |
| Guests                        | 7     | Created outside the hierarchy with a mandatory expiry; a resource-scoped grant expiring with the access; an empty resource list refused; capped at 365 days; an existing employee cannot be demoted to a guest; **a guest cannot be given an employment record even by a raw `INSERT`**; appears in the Guests tab only                                                                                                                                                                                                                                                                                  |
| Suspend and reinstate         | 6     | Suspension deletes nothing (roles and memberships counted); self-suspension refused; a reason required; reinstatement; both recorded as security events **with `subjectUserId`**; `users:ManageAccess` required                                                                                                                                                                                                                                                                                                                                                                                          |
| Offboarding                   | 8     | The impact reported before acting; **membership, employment record, users and audit all preserved** with only the states changed; **roles revoked and the successor's unchanged**; direct reports moved; refused with reports and no successor; the not-implemented domains named rather than implied; the outstanding invitation cancelled; self-offboarding refused; a successor from another company refused                                                                                                                                                                                          |
| Bulk operations               | 13    | The parser handles quoted commas, doubled quotes and CRLF, with spreadsheet-matching row numbers; **validation applies nothing**; per-row errors with every problem in one pass; valid rows applied and invalid skipped; cannot be applied twice; only the validator may apply; **a bulk import cannot overshoot the seat ceiling**; a row naming another company refused; **a bulk role change refused at apply time rather than skipping its escalation gates**; the kind's own permission required; an empty file refused; cancelling keeps row outcomes; one company never sees another's operations |

### Bugs Prompt 13's own work found

| Bug                                                                                                                                                                                                                                                                                                                                                                          | Found by                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Prisma generated `DROP CONSTRAINT` for Prompt 12's three composite foreign keys**, because a constraint it did not generate is drift. Running it would have silently removed a tenant-isolation guarantee — a reporting manager from another company would have become storable. The relations are now declared in the schema and the drift check is empty.                | Reading the generated migration before applying it |
| **`array_length` on an empty array is NULL, and a CHECK treats NULL as satisfied.** This prompt's `invalid_bulk_row_has_errors` accepted a row marked Invalid with no errors; **Prompt 11's `commercial_request_names_what_it_wants` accepted a `ModuleEntitlement` request with an empty module list.** Both verified by inserting the row, both fixed with `COALESCE`.     | The raw-SQL verification script                    |
| **`SET NULL` on a composite foreign key would have failed the delete**, because it nulls `tenant_id` too, which is `NOT NULL`. Latent in Prompt 12 and never fired, because nothing deletes those rows. Now `NO ACTION`.                                                                                                                                                     | `prisma validate` warning after the schema change  |
| **A header named `Employee ID` camel-cases to `employeeID`**, so every field lookup missed and every row reported every column as absent. Replaced with an alias table that strips punctuation and case, so `Employee ID`, `employee_id` and `EmployeeID` are one column.                                                                                                    | The suite failing on a valid file                  |
| **The validator checked that a manager was a member; applying required them to be _employed_.** A preview could say "valid" for a row that then failed — which makes the preview worse than useless, since it is the thing the operator agreed to. Both paths now resolve the manager identically, and a duplicate name is refused with the advice to use a UBoss Unique ID. | A row that previewed valid and failed on apply     |

### Fixtures the new rules invalidated, and why that is the rule working

Four suites had fixtures that predate this prompt's requirements:

- **The Prompt 5 auth suite** activated accounts with no department, manager or role. The gate
  refused them, which is correct — the fixture now builds the minimum real setup a company would
  actually have, in **both** companies for the cross-company password test, because setup is a
  per-company fact.
- **The Prompt 7 authorization suite** set `userType = ExternalGuest` with no expiry. The check
  constraint refused it; the fixture now supplies one.

---

### Prompt 14 — company settings (`apps/api` 36 new)

`company-settings.e2e.spec.ts`, against real PostgreSQL. Five properties carry this prompt.

| Suite                                 | Tests | Covers                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The catalogue                         | 5     | All 19 categories including the two later amendments; **every setting's default satisfies its own declared type**; every key matches the database's shape constraint; no duplicate keys; an unknown key resolves to `undefined` rather than a guess                                                                                                        |
| Typed validation                      | 4     | The string form of a boolean and an integer accepted (a checkbox posts `"true"`) and nothing else; an out-of-range integer and a non-integer refused; an enum value refused **naming the options**; a declared pattern enforced; **cross-setting rules** — escalation may not precede the reminder                                                         |
| Effective inheritance                 | 5     | The code default, with `source: 'default'`; a **platform default preferred** over it; a **company value preferred** over both; a stored value that no longer validates **falls back** rather than being served; a company with **no rows is fully configured**                                                                                             |
| The backend enforces every permission | 7     | An admin sees and may edit everything; an employee sees a permitted subset with **none of it editable**; a write from a read-only caller refused; **a mixed payload refused whole with nothing written**; an unknown key refused; **the category list is not narrowed** and a write is still refused; the screen refused outright to somebody with no role |
| Material changes                      | 6     | A reason required; not required for a non-material setting; **history keeps the previous value** and the first entry's previous value is `null`; no history for a non-material setting, with the reason; `settings:Audit` required to read it; **the history cannot be rewritten by the application role**                                                 |
| Audit and isolation                   | 5     | Every change audited with its key, value and materiality; one company never sees another's settings; **one value per setting per company**; a nested JSON value refused **at the database**; a non-catalogue key refused at the database                                                                                                                   |
| The shell                             | 4     | A category with no settings of its own renders with where it _is_ configured; the whole screen over HTTP with all 19 categories; several settings saved in one call; an invalid **combination** refused even when only one setting is changing                                                                                                             |

### The bug Prompt 14's own tests found

| Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Found by                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **`platform_settings` was not reset between test runs** — the _third_ instance of this class, after a Prompt 9 plan row and a Prompt 11 plan column. A platform default one test created made a company inherit `Weekly` on the **next run**, where the test expected the code default. Platform-plane tables have no tenant to cascade from, so `TRUNCATE tenants CASCADE` never reaches them. The harness now resets it, and the comment states the rule: **if a table has no `tenant_id`, the truncate cannot clean it.** | Four inheritance tests failing on a re-run |
| **`PlatformRepository.listSettings` declares a platform operation**, and `runAsPlatformOperation` refuses to escalate from inside a tenant transaction — correctly. The resolver now reads the platform defaults **before** opening the transaction, which is both correct and cheaper: once per operation instead of once per setting.                                                                                                                                                                                      | The suite failing on every write           |

### Manual verification at Prompt 14

| Check                                      | Result                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| RLS forced on both new tables              | `relrowsecurity` and `relforcerowsecurity` both true   |
| A nested JSON value                        | Refused by `company_setting_value_is_a_scalar`         |
| A non-catalogue-shaped key                 | Refused by `company_setting_key_is_dotted_lower_snake` |
| `UPDATE` on the history as the app role    | `permission denied` — the `REVOKE` holds               |
| Migration chain diffed `--from-migrations` | Empty — the chain matches the datamodel exactly        |
| `DROP` in the migration                    | None                                                   |

---

### Prompt 12B — performance score and badges (`apps/api` 47 new)

`performance-badges.e2e.spec.ts`, against real PostgreSQL. Seven properties carry this prompt.

| Suite                              | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The policy                         | 7     | A baseline version 1 with the documented defaults; a change **supersedes** and the old event keeps its points _and_ its policy id; a reason required; the **database** refuses a second active version, non-ascending thresholds, and a policy that would reward a missed deadline; `performance:Administer` required, not merely `View`                                                                                                                                                                                                                                                 |
| Scoring                            | 7     | Each outcome scores its policy points and they sum; **on-time work that was rejected does not score positively**; the reported score equals the sum of the events shown; the on-time percentage; **`null` rather than 0%** with nothing completed; the event links to the employment record; an event with no source refused                                                                                                                                                                                                                                                             |
| Idempotency                        | 3     | The same source scored once with `alreadyRecorded` reported; **enforced by the unique index**, proven by inserting a duplicate directly; a _different_ outcome for the same source is its own event                                                                                                                                                                                                                                                                                                                                                                                      |
| Approved blockers                  | 6     | Full neutralisation, with the forgiven event still visible and marked; **half** neutralisation when the policy says so, rounded towards zero so partial forgiveness is never a reward; refusing to neutralise something that cost nothing; a neutralisation with no reason and one naming nothing; a manual adjustment with no reason and one with no points; the **database** refusing a discretionary event with no reason                                                                                                                                                             |
| The badge ladder                   | 6     | Bronze → Diamond through every configured threshold; every level kept as history with the previous period closed and **the score at the moment of transition**; the database refusing a second current level; a threshold change **re-deriving the level without rewriting points**; no next level at Diamond; **Bronze with a negative score** rather than a sixth rung                                                                                                                                                                                                                 |
| The exit snapshot                  | 3     | The record frozen with `isExitSnapshot` and nothing left open; **nothing written** for somebody who never scored; every event preserved — the snapshot deletes nothing                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Append-only, isolation, API, audit | 15    | `UPDATE` and `DELETE` refused for the application role; one company never sees another's events or policy; a cross-workspace read refused; own record readable; a colleague's refused; **a manager reads their team and not somebody else's**; an admin reads anybody; the policy shown next to the score; **a derived outcome cannot be typed in over HTTP**; a replay reported as changing nothing; an employee refused an adjustment for themselves; a policy write refused without `Administer`; all four audit actions written; `pastScoresRewritten: false` in the policy metadata |

### The bug Prompt 12B's own tests found

| Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Found by                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **A badge period's two ends came from two different clocks.** `started_at` defaulted to `now()` — the _transaction start_ in PostgreSQL's clock — while `ended_at` was a `Date` from the API process. PostgreSQL runs in a container, so a few milliseconds of skew is normal, and when the database was ahead, closing a period milliseconds after opening it produced `ended_at < started_at` and `badge_period_is_ordered` refused the write. Somebody crossing two thresholds in quick succession, or offboarded shortly after a badge change, would have failed on a clock difference rather than on anything about their performance. Every badge row now sets `started_at` explicitly and a transition uses **one** `Date` for both ends — which also makes the history contiguous. | The exit-snapshot tests                  |
| **`CompanyAdmin` had no `performance:Administer`.** The role templates were written at Prompt 7, before this engine existed, so nobody in a company could version the policy or record an approved blocker's neutralisation. Added to `CompanyAdmin` only — deliberately not to `Head` or `Manager`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Six policy tests failing with a 403      |
| **`OffboardingService` gained a dependency the Prompt 13 test module did not provide.** Nest failed to construct the whole suite rather than one test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The users-access suite failing wholesale |

### Manual verification at Prompt 12B

| Check                                                     | Result                                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| RLS forced on all three new tables                        | `relrowsecurity` and `relforcerowsecurity` both true |
| A duplicate `(subject, source, kind)` inserted directly   | Refused by the unique index                          |
| `UPDATE`/`DELETE` on `performance_events` as the app role | `permission denied` — the `REVOKE` holds             |
| Migration chain diffed `--from-migrations`                | Empty — the chain matches the datamodel exactly      |
| `DROP` in the migration                                   | None                                                 |

---

### Prompt 15 — notifications and escalation (`apps/api` 61 new, `packages/types` 8, `packages/ui` 6)

`notifications.e2e.spec.ts` (59) against real PostgreSQL, plus two in `users-access.e2e.spec.ts`
for the live Invitation source, `notifications.test.ts` in the shared package, and six bell tests
in `shells.test.tsx`. Eight properties carry this prompt.

| Suite                                   | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The catalogue                           | 5     | Exactly the client's six sources; every kind has a label, description and **stated producer**; security mandatory at every severity and critical mandatory of any kind; an approval keyed **without** time and an overdue item **per day**; an unknown kind resolves to `undefined`                                                                                                           |
| Raising                                 | 5     | The row with its deep link and assignment; a critical item marked mandatory **and** acknowledgement-requiring; the **database** refusing an absolute deep link, a critical row that is not mandatory, and a security row that is not mandatory                                                                                                                                                |
| Duplicate suppression                   | 3     | A repeat suppressed and reported; **not** suppressed for a different person; enforced by the unique index, proven by inserting a duplicate directly                                                                                                                                                                                                                                           |
| Preferences                             | 7     | The documented default with `source: 'default'`; security marked immutable and a change refused; the **database** refusing a muted _and_ a digested security preference; a muted optional kind suppressed **storing nothing**; **a critical alert cannot be muted even of a muted kind**; a digest holding back the email but keeping the in-app item; a digest ignored for a mandatory alert |
| Read, acknowledge, the bell             | 7     | Three counts kept separate; **mark-all-read does not clear an acknowledgement**; acknowledging marks read too, satisfying the database rule; the acknowledgement audited and reading **not** audited; somebody else's item refused; filters by unread/assigned/kind; `DELETE` refused for the application role                                                                                |
| Email through the outbox                | 7     | One row carrying **no address and no content**; not enqueued twice; dispatched with `deliversRealMail: false` reported; a critical email marked `[Action required]` and saying why it could not be muted; the channel in the audit trail; a placeholder `.invalid` address **failing with backoff** rather than pretending; an unhandled topic **counted** rather than swallowed              |
| Escalation                              | 8     | A new notification for the reporting manager with `escalatedFromId`, the original kept and marked; not escalated twice; not escalated once acknowledged; **left un-escalated with nobody above them**, then escalating once they are given a manager; severity floored at `Warning`; both people in the audit event; the **database** refusing a chain across companies                       |
| The security source                     | 3     | A suspicious event becoming a mandatory notification with real wording and the right deep link; **a storm collapsed to one per minute**; a platform-plane event with no company notifying nobody                                                                                                                                                                                              |
| Budget thresholds                       | 7     | A warning to the Company Admin at four fifths **and nobody else**; critical when exhausted; **only the highest threshold crossed**; idempotent on a second sweep; notifying again at the next threshold; a seat warning; a company with no Company Admin **counted, not skipped silently**                                                                                                    |
| Isolation and the API                   | 7     | One company never sees another's; the centre and the counts over HTTP; nothing shown to a non-recipient; mark-read and mark-all-read; preferences served and a mandatory change refused; an unknown kind refused at the boundary; the operational jobs refused to a company admin and allowed to a platform owner                                                                             |
| The shared catalogue (`packages/types`) | 8     | The six-kind closed set; the mandatory rule at every severity for security and for every kind at critical; only escalating kinds naming a window; the dedupe-key shapes, including that overdue differs across a UTC midnight and an escalation differs per manager; `utcDay` is UTC, not local                                                                                               |
| The bell (`packages/ui`)                | 6     | The count is a **badge**, never concatenated into the label; capped at `99+` with the real number in the accessible name; urgent while something awaits acknowledgement; **a dot rather than a `0`** when nothing is unread but something needs acknowledging; no marker at all when there is nothing; the counts passed through `AppShell`                                                   |

### The bugs Prompt 15's own tests found

| Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Found by                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **`raise` returned a stale row.** `emailQueuedAt` is written by a second statement, so the object handed back still had `null` — a caller checking whether an email was queued would have concluded it was not. `markEmailQueuedWithinCurrentScope` now returns the updated row and `raise` hands that back.                                                                                                                                                   | The outbox payload test                  |
| **The operational controller was missing `@PlatformOnly`.** `@RequirePermission` alone was not enough: the platform owner has no company membership, so `TenantGuard` refused the request before the permission check ever ran, and the route was unreachable by the only role meant to use it. The Prompt 9 comment says exactly this — "`@RequirePermission` alone would let a company admin reach a platform route" — and the reverse was the failure here. | The platform-plane test                  |
| **`OffboardingService` and `InvitationAccessService` each gained a dependency the Prompt 13 test module did not provide**, so Nest failed to construct the whole suite rather than one test. The second instance of this class in two prompts.                                                                                                                                                                                                                 | The users-access suite failing wholesale |
| **`SubscriptionState` has no `Trialing` or `PastDue`.** Guessing the enum's members instead of reading it cost a typecheck failure; the sweep now covers `Active` and `Suspended`, with the reasoning for including a suspended subscription written down.                                                                                                                                                                                                     | `npm run typecheck`                      |
| **A hook after an early return.** The bell was wired into `/sessions` below its signed-out `return`, which React forbids.                                                                                                                                                                                                                                                                                                                                      | `npm run lint`                           |

### Manual verification at Prompt 15

| Check                                              | Result                                                   |
| -------------------------------------------------- | -------------------------------------------------------- |
| RLS forced on both new tables                      | `relrowsecurity` and `relforcerowsecurity` both true     |
| A critical notification not marked mandatory       | Refused by `mandatory_notification_is_marked_mandatory`  |
| An absolute deep link                              | Refused by `notification_deep_link_is_a_relative_path`   |
| A muted **and** a digested security preference     | Both refused by `security_notifications_cannot_be_muted` |
| An escalation naming another tenant's notification | Refused by the composite foreign key                     |
| `DELETE` on `notifications` as the app role        | `permission denied` — the `REVOKE` holds                 |
| `UPDATE` on `notifications` as the app role        | Permitted, as read and acknowledgement require           |
| Migration chain diffed `--from-migrations`         | Empty                                                    |
| `DROP` in the migration                            | None                                                     |

---

### Prompt 16 — connections, secrets and tool permission (`apps/api` 53 new + 2 in users-access, `packages/types` 9)

`connections.e2e.spec.ts` (53) against real PostgreSQL, two offboarding tests in
`users-access.e2e.spec.ts`, and `connections.test.ts` in the shared package. Seven properties
carry this prompt.

| Suite                                      | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The catalogue and the vocabulary           | 7     | Only connectors with an adapter are listed; **the tool vocabulary contains no human action**; the client's four high-risk categories plus `Delete`; state derivation in precedence order; the expiry horizon; an unimplemented connector refused; a scope the connector does not support refused; an environment insisted on where there are two and refused where there is one                                                                                                                                                                                                                                                                                                                 |
| Secrets are references                     | 7     | The handle on the row and the **sealed** value elsewhere; two connections with the same credential get **different handles**; the vault reveals only by handle and **not across companies**; **no credential over HTTP**, asserted by serialising the whole response; the database refusing a ciphertext handle and an unsealed value; **the handle survives rotation so grants survive**                                                                                                                                                                                                                                                                                                       |
| Test Connection and the five states        | 7     | A success with its history and last-successful time; a provider failure becoming `Error` with the message kept; **withdrawn consent distinguished from a wrong key**; a provider-reported expiry deriving `Expired` even though the check succeeded; a missing stored credential reported as a check failure rather than a crash; an unrecognised credential **refused rather than succeeding by default**; the database refusing a rewritten or deleted history                                                                                                                                                                                                                                |
| Agent Tool Permission ≠ human permission   | 9     | **An agent refused however privileged the humans are**; allowed only for the granted category and the granted agent; **refused while the connection is unusable**, with the reason naming the half-completed-action risk; the department restriction, with **empty meaning the whole company**; a reason required for high-risk and not for safe; the database refusing an unexplained high-risk grant; a category the connector cannot perform refused; revocation kept as a row with re-granting allowed; the database refusing a second live grant and an unattributed revocation; **affected agents counted, not grants**; the audit event carrying `permissionKind: 'AgentToolPermission'` |
| Ownership, disabling, personal connections | 7     | Transfer to an active member with a reason, and refused to a stranger; **a User Connection cannot be transferred at all**; one cannot be created on somebody else's behalf; **an administrator may disable but not rotate** somebody's personal connection; a reason required to disable, and **grants kept standing**; both failure states cleared by a new credential; reauthorization without a new credential; the database refusing an unexplained disable                                                                                                                                                                                                                                 |
| The expiry sweep                           | 2     | Expiring and expired both reported to the **owner**; nothing said about a distant expiry or a **disabled** connection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Isolation and the API                      | 9     | One company never sees another's connections or secrets; **an agent in one company refused another's connection**; an employee sees their own personal connection and not a colleague's, in the service **and over HTTP**; **an employee can create and test their own**; `Administer` required to configure the company's; the full lifecycle over HTTP with no credential in any response; an unknown category refused at the boundary; the vault reporting what it actually is; **the catalogue and the adapter kept in agreement**                                                                                                                                                          |
| Offboarding (`users-access`)               | 2     | A leaver's personal connection **disabled with the reason on the row and the owner unchanged**; a company connection they owned **reported rather than reassigned**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The shared vocabulary (`packages/types`)   | 9     | **The two vocabularies share no member** — the most important assertion in the package; the high-risk set, with `Read`/`Write` the only exceptions; every category labelled and described; five states each with a label and tone, and only `Connected` usable; derivation precedence including whitespace-is-not-an-error; an expiry exactly now is `Expired`; the warning is a horizon, not a moment; the catalogue lists only mocks and claims no unknown category; a personal connector is never company infrastructure                                                                                                                                                                     |

### The bugs Prompt 16's own tests found

| Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Found by                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| **An ordinary employee could not create their own User Connection.** `create` asserted `settings:Administer`, which an Employee does not hold — so the client's User Connection type existed and was unreachable by exactly the people it is for. The permission model was rebuilt around `assertMayConfigure`: `Administer` for anything belonging to the company, the `View` floor for your **own** personal connection, and disable-but-not-rotate for an administrator on somebody else's. The route decorators moved to `View` accordingly, with the real rule in the service — the Prompt 7 two-phase shape. | Four tests failing with 403        |
| **The uuid fixtures were not valid uuids.** `55555555-5555-5555-5555-555555555555` has an invalid variant nibble, so `@IsUUID()` refused it. The validator was right and the fixture was wrong; fixing the fixture rather than relaxing the validator is the whole point of the rule.                                                                                                                                                                                                                                                                                                                              | The HTTP lifecycle test, via a 400 |
| **Two suites gained a dependency their hand-built test modules did not provide** — the third instance in three prompts. A comment in the wiring script now says so, because it is a consequence of hand-built modules rather than a surprise.                                                                                                                                                                                                                                                                                                                                                                      | Both suites failing wholesale      |
| **`SubscriptionState` guessed rather than read** (carried over from Prompt 15's budget sweep).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `npm run typecheck`                |

### Manual verification at Prompt 16

| Check                                                    | Result                                               |
| -------------------------------------------------------- | ---------------------------------------------------- |
| RLS forced on all four new tables                        | `relrowsecurity` and `relforcerowsecurity` both true |
| A ciphertext envelope in `secret_ref`                    | Refused by `connection_secret_ref_is_not_a_secret`   |
| An unsealed secret value                                 | Refused by `connection_secret_is_sealed`             |
| A high-risk grant with no reason                         | Refused by `high_risk_tool_grant_has_a_reason`       |
| A second live grant for the same agent and category      | Refused by the partial unique index                  |
| A revocation with no actor or reason                     | Refused by `tool_grant_revocation_is_attributed`     |
| Revoking properly, then re-granting                      | Both succeed                                         |
| A grant naming another tenant's connection               | Refused by the composite foreign key                 |
| Disabling with no reason                                 | Refused by `disabled_connection_has_a_reason`        |
| `UPDATE`/`DELETE` on `connection_checks` as the app role | `permission denied`                                  |
| `DELETE` on `connection_tool_grants` as the app role     | `permission denied`                                  |
| Migration chain diffed `--from-migrations`               | Empty                                                |
| `DROP` in the migration                                  | None                                                 |
| Two consecutive full API runs                            | 906 passing both times                               |

---

### Prompt 17 — Skills catalogue and governance (`apps/api` 47 new, `packages/types` 18)

`skills.e2e.spec.ts` (47) against real PostgreSQL, and `skills.test.ts` in the shared package.
Seven properties carry this prompt.

| Suite                                    | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The vocabulary                           | 6     | The client's three layers and seven statuses; **`Published` cannot return to `Draft`** and `Archived` is terminal; content frozen at `Approved` and not merely `Published`; every required field reported **at once**; a fully autonomous high-risk Skill refused with the Executor-Agent reasoning named; a high-risk Skill that neither requires approval nor only suggests                                                                                                                                                                                                                                                                                                                                                 |
| Authoring                                | 6     | A draft with every field stored and `nextStatuses` from the shared table; a fully autonomous high-risk Skill refused by the service **and** by the database; a duplicate handle refused; a document-sourced draft must name its document; a clone is sent through the clone route so provenance is recorded; `settings:Administer` required                                                                                                                                                                                                                                                                                                                                                                                   |
| The lifecycle                            | 7     | Draft → Review → Approved → Published with each actor recorded and content frozen at approval; a move the table forbids refused; **reopening a published version refused, naming the alternative**; a reason required to send back; **an administrator can neither approve nor reject and an approver can do both and cannot author**; the trail kept with who and why; the trail unrewritable; the previous version deprecated on publish                                                                                                                                                                                                                                                                                    |
| Immutability                             | 5     | An edit to an approved version refused naming the alternative; **the database trigger refuses it too, bypassing the service**; the status can still move, which is why it is a trigger; **the live version untouched while a new draft is written**; a second open draft refused; **governance re-validated at the approval boundary**, forcing an invalid state past the service                                                                                                                                                                                                                                                                                                                                             |
| Platform Skills and cloning              | 7     | A published platform Skill readable by **every** company; marked not editable here; editing refused naming cloning; **a clone is a draft under this company's approval with recorded provenance**; an unpublished version cannot be cloned; **a company write to a platform Skill refused by RLS, not just the service**; an Industry Pack must name its industry; a company layer refused from the platform plane                                                                                                                                                                                                                                                                                                            |
| Impact analysis                          | 3     | **Unknown, not zero**, for the three uncountable domains, each naming its prompt; clones counted, and described as independent; the version being replaced named                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Isolation and the API                    | 8     | One company's custom Skill invisible in another; the vocabulary and catalogue over HTTP with the locked rule **on the wire**; an employee reads and cannot author; the whole lifecycle over HTTP; a non-kebab handle and unknown category refused at the boundary; **a human action refused as a tool category**; the platform catalogue kept on the platform plane; every creation, clone and lifecycle move audited; `publishedVersionUnchanged` in the trail                                                                                                                                                                                                                                                               |
| The shared vocabulary (`packages/types`) | 18    | Layers, statuses, autonomy levels all labelled; only the two UBoss layers platform-owned; published never returns to draft and archived is terminal in **every** direction; a reviewer can send anything reviewable back; nothing jumps the lifecycle; content frozen at Approved; only Published is usable; valid content clean; every required field; a Skill with no procedure; duplicate step positions and input names; a half-written rule; **a high-risk Skill cannot be fully autonomous at any of the five categories**; a safe one may be; approval-or-suggest for high-risk; tool categories come from the connection vocabulary; every closed-set category usable; the impact registry names what it cannot count |

### The bugs Prompt 17's own tests found

| Bug                                                                                                                                                                                                                                                                                                                         | Found by                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **`settings:Approve` existed in no role template**, so the Skill approval step was unreachable by anybody. The first attempt put it on `CompanyAdmin` and the **Prompt 7 invariant test refused** — correctly. It went to `Approver` instead, which matches that role's stated purpose, and the invariant stands (ADR-088). | Nine tests failing with 403, then one Prompt 7 invariant failing |
| **Rejecting was routed to `Administer`.** Sending a version back is what rejection _is_, so an approver could approve and then not reject — a lifecycle that gets worked around by approving things and fixing them later. Both are now `settings:Approve`.                                                                 | The Approver fixture failing on a send-back                      |
| **The publish path published before deprecating.** `one_published_version_per_skill` permits one, so the index refused it — while the comment above the code claimed the correct order. Both planes now deprecate first.                                                                                                    | The version-supersession test                                    |
| **A pre-transition read ran outside a tenant transaction.** Moving `requireCompanyVersion` above `runInTenantTransaction` meant RLS returned nothing and every version looked non-existent. Nineteen tests failed at once, which is the right failure mode: fail closed rather than read across tenants.                    | Nineteen tests failing together                                  |
| **`BadRequestException(string[])` loses its message.** The array reaches the response body but `error.message` stays "Bad Request Exception", so a caller logging the error — and a test asserting on it — lose the reason entirely. Joined into one message.                                                               | The high-risk-autonomy test asserting on the reason              |
| **A duplicated transition table.** The service kept its own copy of `ALLOWED_SKILL_TRANSITIONS` to put `nextStatuses` on the wire — exactly the drift the file's own comment warns about. Removed in favour of the shared one.                                                                                              | Reading it back before running anything                          |

### Manual verification at Prompt 17

| Check                                                                               | Result                                                                 |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| RLS forced on all three new tables                                                  | `relrowsecurity` and `relforcerowsecurity` both true                   |
| A company row claiming `UbossVerified`, and a platform row claiming `CompanyCustom` | Both refused by `skill_layer_matches_its_owner`                        |
| An `IndustryPack` with no industry; a Verified Skill claiming one                   | Both refused                                                           |
| A non-kebab handle                                                                  | Refused by `skill_key_is_lower_kebab`                                  |
| A company handle alongside an identical platform handle                             | Permitted — the point of cloning                                       |
| A second platform Skill with the same handle                                        | Refused by `one_platform_skill_key`                                    |
| A fully autonomous Skill declaring `Delete`                                         | Refused by `high_risk_skill_is_not_fully_autonomous`                   |
| A blank required field                                                              | Refused                                                                |
| A second open draft                                                                 | Refused by `one_open_draft_per_skill`                                  |
| Approving with no actor; publishing before approval                                 | Both refused                                                           |
| **Changing `purpose` or `allowed_tool_categories` after approval**                  | Refused by the trigger, with the "creates a new draft version" message |
| **Publishing an approved version, then deprecating it**                             | Both succeed — the status moves while the content cannot               |
| Deprecating with no reason                                                          | Refused                                                                |
| A transition that does not move; a rejection with no reason                         | Both refused                                                           |
| `UPDATE`/`DELETE` on `skill_transitions` as the app role                            | `permission denied`                                                    |
| **A company writing a `tenant_id IS NULL` row**                                     | Refused by the RLS `WITH CHECK`                                        |
| **A company reading platform Skills**                                               | 2 rows — its own and the platform one                                  |
| Migration chain diffed `--from-migrations`                                          | Empty                                                                  |
| `DROP` in the migration                                                             | None                                                                   |

---

### Prompt 18 — Skill Router and evaluation (`apps/api` 39 new, `packages/types` 29)

`skill-router.e2e.spec.ts` (39) against real PostgreSQL, and `skill-router.test.ts` in the shared
package (29 — the router is pure, so most of its behaviour is provable without a database). Six
properties carry this prompt.

| Suite                                             | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The router never reaches an unapproved Skill      | 9     | A published Skill selected with reasons and a confidence; **a draft is not even a candidate** (zero matches _and_ zero rejections); an approved-but-unpublished version not considered; a deprecated one not considered; another company's Skill never returned; `onlyPublishedConsidered: true` in the trail; `agents:Run` is the permission and an **employee has it**; a route with no task refused; at most a small set returned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A missing capability becomes a Candidate          | 9     | The Candidate carries the context **and every rejection**; `nothingPublished`/`nothingAutoUsed` in the trail; **deduplicated** while an earlier request is open; accepting creates a **draft**, not a publication, with `createdAs: 'Draft'`; accepting and rejecting each need a reason; both endings terminal; the **database** refusing an accepted Candidate with no draft; the queue carrying the moves the service accepts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Saved evaluation cases                            | 7     | A case saved against the **Skill**, not a version; a case on a platform Skill refused naming cloning; a computable verdict computed; **a human-judged case left unjudged** unless somebody judges it, and a judgement requiring a note; a case run against the wrong Skill refused; `producedBy: 'Recorded'` with the "no evaluator exists yet" note; the **database** refusing a rewritten or deleted run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Regression comparison                             | 8     | **Inconclusive with nothing to compare**, not clean; a regression reported and marked blocking; no change when both pass; **the expectations a comparison depended on frozen**; comparing the published version with itself refused; a real reason required to publish over a regression, with the actor recorded; accepting a regression that does not exist refused; the **database** refusing a deleted comparison                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The API surface                                   | 6     | The router publishing its own parameters and the rules it enforces; the whole evaluation flow over HTTP; an employee can route and cannot administer cases; an unknown assertion and an unknown tool category refused at the boundary; the candidate queue over HTTP with a reasoned rejection; **a Candidate cannot be set to a published state because the enum has no such member**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The router, as a pure function (`packages/types`) | 29    | An unpublished version disqualified **at every status**; an empty catalogue reporting a missing capability rather than a best guess; a catalogue of drafts reporting missing with reasons; the autonomy ceiling disqualifying and saying it is not a preference; a forbidden tool; a missing required input, and an optional one **not** disqualifying; approval-required work refusing a Skill that needs none; **the "when not to use it" field actually excluding**, and a single incidental overlap **not** excluding; a wrong category; a match's reasons naming the signals; a company's own Skill outranking an identical platform one; an industry pack for another industry usable but ranked lower; **a Skill matching only on category not offered**; a weakly relevant one below the floor; the small set ordered by confidence; a long `whenToUse` unable to win by volume; filler words dropped; the three assertion kinds; **a human-judged case not defaulting to a pass**; `ContainsAll` with no fragments failing rather than passing vacuously; a regression reported separately from mixed; improved and unchanged distinguished; **an unjudged case counting as neither**; an empty comparison inconclusive; unjudged cases not blocking a verdict on the rest; the verdict set closed; **a Candidate having no path to published**, and both endings final |

### The bugs Prompt 18's own tests found

| Bug                                                                                                                                                                                                                                                                                                                                                                                                                                   | Found by                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **The exclusion rule almost never fired.** `meaningfulWords` de-duplicates and did no stemming, so "pricing floors" in a Skill's `whenNotToUse` never matched "pricing floor" in a task — and the three-word absolute threshold was therefore nearly unreachable. The safety-relevant rule was effectively off. Now a crude stem plus a **ratio** rule: at least two of the exclusion's distinctive words, and at least half of them. | The "when not to use it actually excludes" test |
| **A Skill could be offered on category and tool-count alone.** A birthday-message Skill scored _exactly_ the confidence floor for tender screening: +20 category, +5 fewer-tools. Neither is evidence of relevance. A Skill must now match on its `whenToUse`, purpose or requested output — a rule rather than a tuned number, because a number drifts.                                                                              | The irrelevant-Skill test                       |
| **A duplicated transition table, again.** `CANDIDATE_NEXT` was a second copy of `ALLOWED_CANDIDATE_TRANSITIONS`, the same mistake Prompt 17 had to remove. Caught by reading the file back before running anything.                                                                                                                                                                                                                   | Self-review                                     |
| **The dedupe test used a Company Admin to route.** A Company Admin deliberately holds no `agents:Run` — administering the company is not doing its work — so the test was exercising the wrong person. Fixed by adding a second Employee, which is also a truer test: two different people hitting the same capability gap.                                                                                                           | The dedupe test failing with 403                |

### Manual verification at Prompt 18

| Check                                                                              | Result                                                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| RLS forced on all four new tables                                                  | `relrowsecurity` and `relforcerowsecurity` both true                    |
| A case with a blank expectation                                                    | Refused by `evaluation_case_is_stated`                                  |
| A duplicate case name on one Skill                                                 | Refused                                                                 |
| Retiring a case with no reason                                                     | Refused                                                                 |
| A run with a verdict but no output                                                 | Refused by `evaluation_run_records_its_output`                          |
| **An unjudged run with no output**                                                 | Permitted — neither pass nor fail                                       |
| `UPDATE`/`DELETE` on `skill_evaluation_runs` as the app role                       | `permission denied`                                                     |
| A comparison of a version with itself                                              | Refused                                                                 |
| `Regressed` with no regression listed; `Improved` with one listed                  | Both refused by `verdict_matches_its_evidence`                          |
| A conclusion with nothing compared                                                 | Refused by `inconclusive_means_nothing_was_compared`                    |
| Accepting a regression with no reason                                              | Refused                                                                 |
| `DELETE` on `skill_regression_comparisons` as the app role                         | `permission denied`                                                     |
| A Candidate accepted with no draft; with no reviewer; a draft on a `Suggested` one | All three refused                                                       |
| **`skill_candidate_status_kind` members**                                          | `Suggested`, `UnderReview`, `Accepted`, `Rejected` — **no `Published`** |
| Migration chain diffed `--from-migrations`                                         | Empty                                                                   |
| `DROP` in the migration                                                            | None                                                                    |

---

## Coverage gaps (deliberate)

The following are scheduled with the prompts that
introduce them, and are listed so they are not mistaken for passing:

| Area                                                                                           | Arrives at           |
| ---------------------------------------------------------------------------------------------- | -------------------- |
| ~~Cross-tenant negative tests (Tenant A cannot read/update Tenant B, even by guessing IDs)~~   | **Done at Prompt 3** |
| ~~Repository-level tenant isolation integration test~~                                         | **Done at Prompt 3** |
| Auth: activation, login, session rotation, idle/absolute expiry, lockout, password reset       | Prompt 5             |
| MFA-required and SSO-required policy tests                                                     | Prompt 6             |
| Objective lifecycle: Form 2 → analyze → workflow → pre-publish → **Approve & Assign** boundary | Prompts 15–19        |
| Versioning: editing a Live Objective creates a new Draft Version and never overwrites          | Prompts 15–19        |
| Engine Agent recurrence creates Runs, not new Agents                                           | Prompt 21            |
| Executor Agent never bypasses a required Human approval                                        | Prompt 22            |
| Credit lifecycle Estimate → Reserve → Execute → Settle/Reconcile                               | Prompt 26            |
| Accessibility and keyboard-navigation audit                                                    | Prompt 44            |

---

## User-type test matrix (CR-01/8)

Required format, to be populated per user type once the **TCSiON user-type/allotment reference is
supplied by the client**. Types must not be invented, so the rows are intentionally empty.

Per `UBoss_Final_2` (acceptance checklist ~line 1115), each user type must be exercised for:
dashboard, navigation, workspace identity, Vision/Mission, UBoss ID / person linkage,
performance/badge, cross-company lookup, and reward permission scenarios.

| User Type                  | Allotted Access | Expected Behavior | Actual Behavior | Pass/Fail | Issue/Correction |
| -------------------------- | --------------- | ----------------- | --------------- | --------- | ---------------- |
| _pending TCSiON reference_ |                 |                   |                 |           |                  |

The 14 roles already modelled in the client's UI prototype (see `docs/UX_MAP.md` §6) are the starting
point for the UBoss side of the mapping, but they are **not** a substitute for the client's TCSiON
list.

### Prompt 19 — Objective Builder, exact Form 2 (`apps/api` 80 new, `packages/types` 66, `apps/web` 14)

| Suite                                           | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/objectives.test.ts`         | 66    | The Form 2 field list verbatim; the 15 grid columns in order with their grouping; Unit and Time Unit as separate fields; the client's exact labels; the eight states and their full wording; the closed transition table (no self-transitions, nothing unknown, `Active` never moves backwards, `Archived` terminal, `Active` reachable only from `ReadyForApproval`); editable ≠ not-frozen; every validator including the reward panel's completeness rules and the absence of any approve/settle/pay vocabulary.                                                                                                                                                                                                                                  |
| `apps/api/test/objectives.e2e.spec.ts`          | 80    | Round-trip of every objective field and all fourteen stored grid columns, walked from the shared arrays; 40-row grid accepted; the `/form2` response; validation refusals; derived codes per department; version 1 in Draft; whole-grid replacement including shrinking; submission gates; the two freeze triggers across all three write kinds; one live version with a Draft permitted alongside; the live-pointer FK; the reward panel's seven fields, its note, its idempotent upsert, its zero performance events and its absent columns; the `Assign` gate through service and route; `CompanyAdmin` read-but-not-create; department-scoped row refusal in both directions; tenant isolation on list, fetch, edit and reward; the audit trail. |
| `apps/web/src/components/WorkflowGrid.test.tsx` | 14    | Every source column header and all six group banners rendered from the shared array; row numbering; cell editing by field name; the engine and approval vocabularies; insert / duplicate / delete / reorder with contiguous renumbering; Delete disabled at one row; Move up/down disabled at the ends; 40 rows uncapped; read-only locking.                                                                                                                                                                                                                                                                                                                                                                                                         |

### The bugs Prompt 19's own tests found

- **`versionViewOf` shipped a broken placeholder.** `nextStatuses` had an `await` inside a
  non-async method — nonsense left in while sketching. Caught by self-review before the first run
  and replaced with a read of `ALLOWED_OBJECTIVE_TRANSITIONS`, which is where it should have come
  from.
- **Four fixture errors, each a real constraint I had wrong rather than a product bug.** The
  role-assignment column is `departmentIds`, not `scopeDepartmentIds`. `CompanyAdmin` has no
  `objective:Create` — Prompt 7's deliberate split, now pinned by its own test so it cannot be
  "corrected" later. `Head` caps at `MultipleDepartments`, so a `WholeCompany` grant narrows to a
  department set that with no ids matches nothing. `Manager` caps at `TeamSubtree`, so a Manager
  cannot be department-scoped at all — the role that can prove a department boundary is a
  single-department `Head`. In each case the fixture was fixed, not the engine.
- **My own harness error:** the first run used `npx tsx --test`, but the API suite compiles with
  `tsc` because it needs `emitDecoratorMetadata`. tsx does not emit it, so every test failed with
  a Nest DI error about `PrismaService` being unresolvable. Nothing was wrong with the code.

### Manual verification at Prompt 19

45 raw-SQL checks against `uboss_dev` before any code depended on the schema: every CHECK
constraint refusing its bad input and accepting its good one, the partial unique index, both
freeze triggers across INSERT/UPDATE/DELETE, the status still moving `Active → Completed` under
the content freeze, the live-pointer FK refusing a foreign version and refusing to delete a
running one, `information_schema` proving the reward table has no approve/settle/pay column and no
Form 2 column, the cascade leaving zero steps, and RLS enabled and forced on all four tables. A
separate cross-tenant check as `uboss_app` confirmed tenant A sees one of two objectives and that
inserting a row for tenant B is refused by the policy.

### Prompt 19A — Reward rules and awards (`apps/api` 56 new, `packages/types` 27)

| Suite                                | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/rewards.test.ts` | 27    | The client's eight-state chain; the closed transition table (nothing unknown, no self-loops, rejection from every open state, no rejection after approval, **nothing reaches `Settled` or `Recorded` except from `Approved`**, `Approved` only from `Eligible`, every ending terminal, open and terminal partitioning the vocabulary); `settlementRouteFor` sending only cash to payout; `terminalStatusFor`; rule-completeness validation; and `validatePayout` refusing every non-cash type, a missing connector, a zero amount, and reporting all three at once.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/api/test/rewards.e2e.spec.ts`  | 54    | Assignment snapshotting the rule's terms; the whole chain walked by three different people; refusal to skip a step, to assign under a switched-off rule, to assign with no panel, and to open two live claims for one person; rejection from an open state with a required reason and no reopening; **settlement refused with no connector, refused for a non-cash award, refused for an unapproved award, refused to the approver themselves, refused twice, and leaving the award `Approved` when the connector fails**; `payoutWasReal` false and said so in the trail; the policy gate off and on, with the event's kind, source and points asserted; cash never scoring even with the gate on; the terms surviving a later edit of the rule; the named-approver rule; subject-may-report-own-completion but not own eligibility or approval; a person always seeing their own awards; tenant isolation on touch, list and subject query; and every audit action attributed to whoever performed it. |

### The bugs Prompt 19A's own tests found

- **A constraint that contradicted the lifecycle.** `assigned_award_records_when` demanded an
  `assigned_at` for a `Rejected` award, but `Draft → Rejected` is a permitted transition — a claim
  can be refused before anybody is assigned. The only way to record that refusal would have been to
  first record an assignment that never happened. Caught by the raw-SQL verification pass before any
  service code depended on it, and corrected in its own migration because the first had already
  been applied.
- **A person could not see their own reward awards.** `listForSubject` applied the row-level scope
  check uniformly, and an own-award resource descriptor has no department — so a
  `Department`-scoped Head was refused as unevaluable when asking about their own bonus. Fixed in
  the product (own awards are always visible to yourself, as with performance) and pinned by a new
  test.
- **A test expectation that was weaker than the product.** The named-approver test used the Head who
  created the objective, and the separation-of-duties engine refused them first with "you cannot
  approve something you created". The stronger control firing earlier is correct; the test now uses
  an actor who neither created the objective nor is named on it, so the named-approver rule is what
  is actually exercised.

### Manual verification at Prompt 19A

32 raw-SQL checks against `uboss_dev`: every CHECK refusing its bad input and accepting its good
one; all five attribution pairs in both directions; the four-eyes settlement constraint; a Points
award unable to reach `Settled`; an unsettled award unable to claim a payout or a real payout; a
performance event refused on anything but a Recorded Points award; a Recorded Points award with no
event and no note refused; the partial unique index permitting a new claim only after the previous
one is terminal; the trigger freezing terminal awards and the snapshotted terms while still
permitting status progress; a Draft award still correctable; the policy column present with a
`false` default; and RLS enabled and forced on `reward_awards`.

### Prompt 20 — Review routing and strict versioning (`apps/api` 49 new, `packages/types` 17)

| Suite                                            | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/types/src/objective-diff.test.ts`      | 17    | `isObjectiveWorkAssignable` true only for `Active` and explicitly false for approved-but-unpublished; the three version origins; and `diffObjectiveVersions` — identical versions reported as identical, changed fields with both values and their section, `null` and `''` treated as the same "not set", a cleared field reported, the diff driven by the shared field list so a field missing from one side still shows, added / removed / changed steps, every changed cell in a row, the Step column never reported, directionality, and the summary's singular and plural wording.                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/api/test/objective-versioning.e2e.spec.ts` | 49    | Hierarchy-aware Send To in six shapes including the unevaluable case; the reviewer's four actions with Responsible-Owner enforcement; a send-back requiring a reason, returning to Draft and clearing an approval; Confirm-Execution-Team as a precondition; **refusing to edit a version awaiting a decision rather than opening a new draft**; approve-without-publishing and the derived review stage; publishing refused without an approval through the service _and_ the database; V2 copied from V1 on edit with V1 untouched and still live; V1 archived the moment V2 publishes; **a minor edit that changes nothing still creating a version**; rollback creating a forward version from an older one with V1 left archived and V2 still live; version history with exact ids and provenance; the compare view including added/removed/changed and directionality; route-level authorization; and every audit event carrying its exact version id. |

### The bugs Prompt 20's own tests found

- **The auto-V2 rule let an author route around the reviewer.** The first implementation opened a
  new draft whenever there was no open draft — including while a version sat `UnderReview`. The
  author could then edit the copy, publish it, and the review in progress would have decided
  nothing. Caught by an existing Prompt 19 test, and the exception now has its own test (S-135).
- **A `Promise.all` inside an open transaction made the hierarchy check answer unsafely.**
  Concurrent queries on one interactive transaction lose the AsyncLocalStorage scope, so the four
  routing lookups ran unscoped; under RLS an unscoped read returns nothing, which the code read as
  "hierarchy unevaluable" and therefore **permitted** a routing it should have refused (S-141).
- **`sendBack` could not reach an approved version**, although the transition table permits
  `ReadyForApproval → Draft` and clearing the approval only matters in exactly that case. Widened,
  with the reasoning at the call site.
- **Three test-fixture errors of my own**, each a real constraint I had wrong: `employmentRecord`
  takes `joinedOn` not `startDate`; `EMP-${userId.slice(0, 6)}` collides because uuid v7 is
  timestamp-prefixed so ids minted together share a prefix; and a `return` left on its own line by
  a scripted edit made the whole employment-record fixture dead code via automatic semicolon
  insertion — **so six routing tests were passing vacuously** until the compiled output was read.
  That last one is the argument for checking compiled output when a scripted edit touches control
  flow.

### Manual verification at Prompt 20

24 raw-SQL checks against `uboss_dev`: every attribution pair in both directions; a send-back with
no reason refused; `Active` and `Completed` refused with no approval; a publication predating its
approval refused; V1-with-a-parent, V2-with-`Initial`, and V2-with-no-parent all refused; a proper
V2 and a `Rollback` V3 both accepted; a foreign-tenant parent refused by the composite FK; a
self-parent refused; the replaced trigger refusing changes to a live version's content, origin and
approval while still permitting `Active → Completed`; a draft's approval still settable; the
one-live-version index still holding; and a provenance listing confirming V1 `Initial` (none),
V2 `Edit` ← V1, V3 `Rollback` ← V1.

### Prompt 21 — Objective AI analysis (`apps/api` 38 new, `packages/types` 27)

| Suite                                           | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/types/src/objective-analysis.test.ts` | 27    | The seven stages in order and labelled; `Cancelled` kept apart from `Failed`; the three endings terminal and uncancellable; **Human = rectangle and AI = diamond**, the Goal distinct from every other kind, and Approval kept separate from Condition; schema versioning reading only its own version and refusing another "rather than guessing"; and `validateWorkflowDraft` refusing no nodes, duplicate ids, **a shape contradicting its kind**, no Goal or two Goals, a mismatched `goalNodeId`, a node with no label / definition of done / evidence, an edge to a node that does not exist, a self-edge, an inverted or negative usage range, a usage estimate with no stated basis, and a missing risk or gap list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api/test/objective-analysis.e2e.spec.ts`  | 38    | All seven stages running to completion with **one gateway call per stage**; a draft that satisfies its own schema; the shapes on the produced data; exactly one Goal; every node traced to a Form 2 row and carrying a definition of done and evidence; approval gates from the grid's Approval column; edges from the grid order starting at the Goal; the usage range with a mock-stating basis; owner assignment by display name, and a **gap rather than a guess** when the name is unknown or absent; Skill matching attaching a published version, recording a gap and a high risk when none applies, raising **no** Skill Candidate, and flagging an Executor step as a checking step; the version reaching only `WorkflowDraft` with `workAssignable` false and no approval; **no approval column on the run table**; `producedByRealModel` false in the view, the meta and the audit trail; a failure recorded in actionable words; **cancellation mid-flight stopping the pipeline at the next boundary**; refusing to cancel a finished run; one live run per version with a fresh one allowed afterwards; the freeze trigger; the latest-run lookup for a reopened screen; an unreadable schema version refused with a reason; and authorization plus tenant isolation. |

### The bugs Prompt 21's own tests found

- **An unscoped read failed every analysis.** The pipeline's own status re-read had no tenant
  transaction, and under RLS an unscoped read returns nothing — so the helper concluded the run had
  disappeared and every run ended `Failed`. Third instance of this class in the project (S-149).
- **A status assertion that hid its reason cost a debugging cycle.** The first version asserted
  `status === 'Completed'` with no message; the failure said only `'Failed' !== 'Completed'`. The
  assertion now carries `failureReason`, which is how the cause above was found in one run rather
  than several.
- **Two fixture errors, both real constraints I had wrong:** `SkillCategory` has no
  `'Documentation'` member, and `createCompanySkill` needs `settings:Administer` while approving
  needs `settings:Approve` — neither lives on `Head`, so the Skill fixture needs its own
  CompanyAdmin and Approver. That is Prompt 17's separation of duties working as designed.
- **`RoutingOutcome` and `SkillMatch` field names guessed wrong** (`result.matches`, `versionId`,
  `name` rather than `matches`, `skillVersionId`, `skillName`) — caught by the compiler, and the
  reason to read a shared type rather than assume it.

### Manual verification at Prompt 21

24 raw-SQL checks against `uboss_dev`: the stage counter bounded at seven; `Running` with no start
refused; `Completed` refused with no draft and refused at stage five; `Failed` refused with no
reason; completion before start refused; a draft with no `schemaVersion` refused and one
disagreeing with its column refused; version zero refused; `produced_by_real_model` refused with no
capability; negative tokens refused; a second live run for one version refused and a fresh one
accepted after the first finished; the freeze trigger refusing every change to a completed run
including flipping `produced_by_real_model`; a running run still updatable; cancellation attributed
in both directions and a cancelled run frozen; and RLS enabled and forced.

## Prompt 22 — the workflow editor

`test/workflow-editor.e2e.spec.ts` — 45 tests. `packages/types/src/objective-analysis.test.ts`
gained 34, taking the shared-type suite to 242.

`apps/web/src/components/WorkflowCanvasNode.test.tsx` — 9 tests. The canvas node was extracted for
the same reason `WorkflowGrid` was: the locked shape rule deserves a test, and a test needs
something smaller than a page to render. It asserts the shape on the **rendered output** and checks
every node kind against `nodeShapeFor`, so a renderer that decided shapes for itself would fail
here rather than quietly disagreeing with the schema.

Full suite after Prompt 22: **1634 passing** — API 1260, shared types 242, UI 102, web 30.

| Area                    | What is pinned                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Opening                 | Seeds from the completed analysis; refuses a version never analysed; idempotent.          |
| The two-record decision | An edit leaves the analysis run byte-identical, including its `version`.                  |
| Re-analysis             | A second analysis does not discard the manager's edits.                                   |
| Concurrency             | A stale revision is refused, names both numbers, and the first edit survives.             |
| Concurrency (database)  | A rewound revision is refused by the trigger.                                             |
| Node editing            | Title, assignee, partial Definition of Done; blank title refused; unknown node 404.       |
| Conversion              | AI → Human clears the Skill; Human → AI refused with no Skill; the Goal never converts.   |
| The locked shape rule   | After a conversion, every node's shape still matches its kind.                            |
| Add / delete            | Blank DoD on a new node; no second Goal; the Goal cannot be deleted; edges follow.        |
| Edges                   | Sequential, parallel and failure branches; IF/ELSE needs a condition; ghost node refused. |
| Dependencies            | Resolved against the graph; self-dependency refused.                                      |
| Pre-Publish Summary     | All twelve client items present; counts match the graph; cost is a range with a basis.    |
| Pre-Publish Summary     | Publishes nothing: status, version count, `assignedAt` and revision all unchanged.        |
| Assigned plan           | Read-only in the service and in the database; `editable` reports it.                      |
| Authorization           | 401 unauthenticated; CompanyAdmin reads but cannot edit or open; no cross-tenant read.    |
| Audit                   | Opening and editing recorded; the opening summary states the analysis is unchanged.       |

### Real bugs this suite found

- **S-150 — a partial Definition-of-Done patch emptied the fields it did not mention.** Spreading
  a validated DTO writes `undefined` over every declared field the request omitted. It failed as a
  400 complaining about lists the manager had never removed, which is why the assertion now carries
  the response body: the first run reported only "400 !== 200" and cost a cycle.
- **A CHECK constraint that failed open.** `jsonb_typeof` on an absent key is NULL, and a CHECK
  only refuses on FALSE — so the graph-shape constraint accepted a graph with no `edges` key at all.
  Caught by probing constraints in raw SQL, not by a test: the application never writes that shape.
- **`upgradeWorkflowDraft` left `approvalKind` undefined** on an upgraded version 1 node, where the
  type promises `string | null`. Normalised, and the flat version 1 fields are now dropped rather
  than left beside the structure they were lifted into.

### Fixture notes

- `ObjectiveController` gained a fifth dependency, so the three existing objective specs each
  needed `WorkflowEditorService` in their own testing module. A shared-controller change is exactly
  the case that justifies a full API run.
- `ObjectiveView` has no `status`; status lives on a version. `objective_analysis_runs` exposes
  `version`, not `rowVersion`.
- Running a single test with `--test-name-pattern` exhausted the transaction pool. The full file
  runs clean; the filtered run is not a reliable way to isolate one failure here.

### Manual verification at Prompt 22

15 raw-SQL probes against `uboss_test`: a graph holding `4` and holding `null` refused; a scalar in
place of `nodes` refused without raising; a missing `edges` key refused; a missing `nodes` key
refused; an empty node list refused; schema version zero refused; revision zero refused;
assignment attributed in both directions; a well-shaped row accepted (failing only on its
deliberately dangling FK, which proves no CHECK blocked it); and RLS enabled and forced. The
missing-`edges` case passed before the correcting migration and is the reason it exists.

## Prompt 23 — Approve & Assign and the To-do list

`test/assignment.e2e.spec.ts` — 33 tests. `packages/types/src/assignments.test.ts` — 37 tests.

| Area                | What is pinned                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The gate            | An unapproved version is refused, and the refusal says approving is separate.                                                         |
| The gate            | An AI step with no Skill, and an incomplete Definition of Done, each refuse.                                                          |
| The gate            | **Every** failing check comes back at once, each naming its check.                                                                    |
| The gate            | An actor without `objective:Assign` is refused, over HTTP as well as in-process.                                                      |
| Success             | The version goes live and becomes the objective's active version.                                                                     |
| Success             | One human task per Human node, carrying every field the client's UI list names.                                                       |
| Success             | One AI assignment per AI node, `AwaitingAgentSetup`, with the Skill in its prefill.                                                   |
| Success             | Approval gates land in the one generic queue, `Pending`, naming their node.                                                           |
| Success             | Executor expectations registered, each with a detail and an overdue time.                                                             |
| Success             | A named approver is notified; a role-only gate notifies nobody and records the role.                                                  |
| Success             | The plan is frozen and the audit counts match what was made.                                                                          |
| Success             | A second assignment of the same plan is refused.                                                                                      |
| **Rollback safety** | A forced mid-transaction failure leaves the version not live, the plan unfrozen, and zero AI assignments, approvals and expectations. |
| To-do               | An employee sees their own work and nobody else's; acting on another's is refused.                                                    |
| To-do               | Start; block requires a reason; resuming clears the blocker.                                                                          |
| To-do               | Submitting without required evidence is refused; with evidence it completes.                                                          |
| To-do               | A step needing approval goes to `WaitingApproval` and raises an `OutputApproval`.                                                     |
| To-do               | A clarification moves the task to `NeedsInput`; a comment leaves it alone.                                                            |
| To-do               | A finished task cannot be submitted again.                                                                                            |
| To-do               | `Overdue` is derived: the stored status still says what the task is waiting on.                                                       |
| To-do               | Actions are audited to the person who took them; 401 unauthenticated.                                                                 |

### The rollback test, and why it is shaped that way

Forcing a real partial failure rather than mocking one: a task row is pre-planted in one node's
unique slot, so the create fails **after** the version has been published and after other rows
have been written. The assertions are then about what is absent — the version is not live, the
plan is not frozen, and the three sibling tables are empty. A live version whose work was never
created is precisely the half-publish this design exists to prevent, and nothing short of a real
failure proves the transaction covers it.

### Real bugs and constraints this suite found

- **S-151 — an unscoped read refused every valid publish.** The fourth instance of this class, and
  the first caused by _moving_ correct code out of a transaction rather than by never opening one.
- **A CHECK constraint that forbade a real state.** `started_task_records_when` refused a task
  blocked or needing input before it was started — two ordinary first actions. Found by a test
  doing the obvious thing.
- **Audit metadata takes scalars only**, so a string array silently became the wrong thing. Caught
  by the compiler.

### Fixture notes worth keeping

- **The `Manager` persona needs the real hierarchy resolver.** No earlier objective spec exercised
  `TeamSubtree` scope, so they all pass `OrganizationRepository` as the `HIERARCHY_RESOLVER` and
  never notice. `TeamSubtree` needs `ReportingHierarchyResolver`, or authorization fails with
  `input.hierarchy.isInSubtree is not a function`.
- **A Manager's subtree does not include their own manager.** The objective must be owned by the
  Manager doing the assigning, which is also what the client's journey describes. Owning it with
  the Head produced a correct refusal that looked like a bug.
- **UBoss refuses to let anybody approve what they created**, so the fixture needs a separate
  approver. `Approver` holds `objective:Approve` but caps at `MultipleDepartments` — a
  `WholeCompany` grant narrows to an empty department set and grants nothing (the Prompt 19
  lesson), so it must be granted with the department named.
- **The analysis honestly leaves `criteria` and `failureCondition` blank**, so every freshly
  analysed plan is refused until a manager fills them. The fixture fills them through the editor,
  which is the journey rather than a workaround.
- **An analysis leaves an approval gate's owner null on purpose.** The fixture names one through
  the editor to test the notification path, and a separate test covers the role-only branch.
- **`NotificationService` needs `NotificationRepository` and `OutboxRepository`** in a testing
  module.

### Manual verification at Prompt 23

33 raw-SQL probes against `uboss_test`: every status and kind vocabulary refused an unknown value;
a blank title, note body and evidence description refused; `Blocked` refused with no reason and
with a whitespace-only reason; `InProgress` and `Completed` refused with no start time, while
`Blocked` and `NeedsInput` before starting are accepted; a completion time without the status
refused; submitted-before-started refused; an assignment claiming a mapping while naming no agent
refused, and the reverse refused; a prefill holding `7` and holding JSON `null` both refused (the
`jsonb_typeof` trap from Prompt 22, now failing closed); a `Pending` row carrying a decision
refused; `Approved` with nothing recorded refused; a decision time with no decider refused;
`Rejected` with no reason refused; half-pointers refused; an overdue expectation with no due time
refused; and two well-formed rows reaching only their foreign key, which proves no CHECK blocked
them.

## Prompt 24 — Agent Builder and Engine Agent activation

`packages/types/src/agents.test.ts` — 69 unit tests. The client's vocabularies transcribed and
pinned (four run types, six missing-data behaviours, seven Engine Agent statuses, Form 3's eight
job-level groups and seventeen action columns); `missingSetupFields` as the ZERO-QUESTION RULE,
including the two cases it must *not* ask about (a manual agent's schedule, a connection for work
with no tool needs); and the Engine Agent lifecycle, including that Archived is terminal.

`apps/api/test/agent-builder.e2e.spec.ts` — 32 integration tests across six areas: the
zero-question rule, Test, Activate, Form 3, authorization/scope/isolation, and credentials.

Four of these earn their keep by defending decisions rather than behaviour:

- *records the result, and records that the model was a mock* — asserts `wasReal === false` on a
  mock run, so no screen or report can present it as a live provider integration.
- *never creates a second Engine Agent for the same work* — the locked lifecycle rule.
- *freezes the published configuration* — proves the database trigger, not just the service.
- *returns nothing that could be a credential* — greps the serialised response for `secret`,
  `apikey`, `credential`, `password`, `token`.

One test records a limitation instead of forcing a path: *never even sees an AI step with no
approved Skill, because assignment refuses first*. The readiness check does carry that blocker,
but Prompt 23's gate refuses to publish such a plan at all, so Agent Builder never receives one.
Asserting the earlier refusal is honest; faking an assignment the product cannot produce would
not have been.

`apps/api/test/authorization-engine.spec.ts` gained six tests pinning the Employee correction
(ADR-270) with its source citation, including that activation must **not** require `Publish`.

## Prompt 25 — Engine Agent registry and versioning

`packages/types/src/agents.test.ts` — 20 further unit tests: the four memory modes with their
technical rules and the safe default; the seven-action set derived from the lifecycle rather than
restated (a property test asserts `Pause` is offered exactly where `Active → Paused` is legal);
health reporting a null success rate; and every branch of `versionActivationNeedsApproval`,
including that a narrowing change needs none.

`apps/api/test/engine-agent.e2e.spec.ts` — 31 integration tests, built on the Agent Builder
fixture chain because the registry is about an agent that activation produced.

Five that defend decisions rather than behaviour:

- *reports no run data rather than a fabricated success rate* and *reports usage as absent rather
  than zero* — ADR-123.
- *needs no approval to narrow memory back again* — ADR-124's narrowing rule.
- *refuses to let the activator be their own approver* — otherwise the requirement is decorative.
- *cannot have a published version edited, even in the database* — three separate attempts
  (config, impact, test result), proving the replacement trigger covers the new columns.
- *reports Run now as available but serves no route for it* — records ADR-122's boundary as a
  test, so the gap cannot be mistaken for an oversight.

One bug this suite caught in review: `EngineAgentService.mayTouch` first omitted the department
from the resource it handed the scope engine, so a Department-scoped Head — the role that owns
archiving and versioning — could not reach any agent, and the refusal looked like the agent did
not exist. Sixteen tests failed on it. The same omission had already been fixed in Agent Builder;
passing an owner without a department is evidently an easy thing to get wrong twice.

## Prompt 26 — Run engine, queue and scheduler

`packages/types/src/runs.test.ts` — 42 unit tests. The thirteen states and five triggers
transcribed; the transition table as properties rather than examples (every unfinished state is
cancellable, every terminal state leads nowhere, no state moves to itself, `Queued` cannot reach
`Running`); retry classification and the capped backoff; both policy vocabularies; idempotency key
construction; and the calendar maths.

The calendar tests are the ones worth reading. `2026-01-05T20:00Z` is Monday in London and already
Tuesday in Kolkata, and `2026-01-25T20:00Z` is already the 26th — a holiday — in Kolkata. Both are
asserted, because a scheduler that used the server's day is the classic version of this bug and it
only shows up for companies in the wrong half of the world.

`apps/api/test/run-engine.e2e.spec.ts` — 41 integration tests over nine areas: starting a run,
idempotency, overlap, retries, blocked states, cancellation, live progress, the scheduler, and the
routes ADR-122 deferred.

Five that defend decisions rather than behaviour:

- *makes two callers meaning one occurrence into one run* and *lets a person start the same agent
  twice on purpose* — the two halves of the idempotency rule, which are opposites.
- *spends its bounded attempts then dead-letters, preserving the context* — asserts the attempt
  ceiling *and* that every attempt is still on the record.
- *leaves the durable history complete even with nobody listening* — the point of the event table.
- *does not fail the run when a listener throws* — losing the animation beats losing the work.
- *reports an unreadable schedule instead of silently never firing* — the worst available outcome
  is a company believing an agent is scheduled when it is not.

**Two real bugs this suite found**, both mine and both in the constraints I had just written:

1. `running_run_was_reserved_first` omitted `Retrying`, so every retry rolled back and bounded
   retries silently never retried. The raw-SQL probe had checked `Running` without a reservation
   and not `Retrying` — probe every state the code actually writes, not the obvious one.
2. Resuming a blocked run kept the first attempt's `started_at` while taking a new reservation,
   violating `run_started_after_it_was_reserved`.

The second took a cycle to find because `InlineRunQueue` swallows handler errors by design (the
engine records failures on the run row, and rethrowing would report them twice). The only symptom
was a state that had not advanced. `InlineRunQueue.lastFailure` now keeps it, and the spec asserts
on it, so the next one is diagnosed rather than deduced.

## Prompt 27 — Executor Agent and Exception Center

`packages/types/src/executor.test.ts` — 40 unit tests. The ten kinds with the document's default
owner and severity; the lifecycle as properties (closed leads nowhere, no self-transitions, an
escalation can be handed back); every branch of `concludeValidation`; and the escalation window.

A whole describe block is given to the locked rule — *THE LOCKED RULE — the Executor never
decides* — asserting across **every** exception kind that the Executor cannot resolve or dismiss,
that it cannot even retry when a control refused the work, and that it still can route and
escalate. Written as loops over `EXCEPTION_KINDS` rather than examples, so a kind added later is
covered automatically.

`apps/api/test/executor.e2e.spec.ts` — 35 integration tests over six areas: detection, the locked
rule, validation order, escalation and self-healing, resolution by a person, and the Exception
Center over HTTP.

Six that defend decisions rather than behaviour:

- *cannot be closed by the Executor even directly in the database* — proves the third layer, by
  writing the event row directly rather than through the service.
- *refuses even to retry work a control has refused* — the subtler half of the rule.
- *records whether a person or the Executor did each thing* — the history distinguishes them.
- *acknowledges a provider outage that has passed, but does not close it* — ADR-135.
- *does not escalate into the void when nobody owns it* — and asserts it still reports itself
  overdue, so it is not merely silent.
- *does not treat a retry as progress* — otherwise an exception would look handled because
  somebody pressed retry.

Two fixture facts worth recording, both found by failures: a Skill key and an Engine Agent name
are each unique per company, so a test that builds four agents in one company collides on both.
The blocked-state cases became four tests with a fresh company each rather than one loop — simpler
than working around either constraint, and it names the four mappings in the output.

## Prompt 28 — the Approval Engine, delegation and four-eyes

**`packages/types/src/approvals.test.ts` — 47 unit tests.** Decisions, the type→module mapping,
routing, delegation windows, aging and escalation. Two are invariants rather than examples:

- *leaves no approval type that nobody can decide* — `everyApprovalTypeIsDecidable` run against
  the real `ROLE_TEMPLATES`. This caught a live bug: `WorkflowStepApproval` pointed at `todo`,
  `OutputApproval` at `executor` and `GuestAccess` at `users`, and **no role holds `Approve` on
  any of those three**, so all three could be raised and never decided. Invisible in the type
  system and in review; it only shows up as a stuck queue.
- *reports an undecidable mapping rather than passing quietly* — the same invariant against a
  fabricated template with no `Approve` anywhere, so a green result means something.
- *has no opinion on self-approval, which the authorization engine owns* — pins that
  `isAddressedTo` does **not** refuse the requester, so the duplication ADR-137 forbids cannot
  creep back.
- *reads every step approval kind that reaches the column* — loops `STEP_APPROVAL_KINDS` and
  asserts each routes to something decidable, which is what would have caught the `FourEyes`
  deadlock (ADR-138).

**`apps/api/test/approvals.e2e.spec.ts` — 51 tests**, on the Prompt 23–27 fixture chain so the
approvals decided are the real ones. Grouped by what they defend:

- *one engine across every domain* — every one of the eight types raised through the same call;
  the queue aged; a request addressed to nobody refused.
- *separation of duties* — a self-approval refused by the **platform** control with the
  `security.separation_of_duties_blocked` row counted; the creator refused from *rejecting* their
  own request too; a comment on your own request allowed; a `FourEyes` gate applied against a
  company with zero `FourEyes` policy rows, satisfied once a second person has acted, and refused
  for a second decision from the same person.
- *the decision record is immutable* — a verdict change, a reopen, a rewritten reason, and an edit
  or delete of the history, each asserted **against the database** rather than through the service,
  because the service can be bypassed by the next prompt and the trigger cannot. Plus the
  send-back → resubmit chain and the one-resubmission limit.
- *routing* — named approver excludes everybody else; a role-addressed request refused without the
  role; and *tells a screen exactly what it may do, matching what the server will allow*, which
  asserts the `available` reason is the same sentence `decide` throws.
- *out-of-office delegation* — a delegate decides; **grants no authority they did not have**;
  **does not launder a self-approval**; type-scoped cover honoured and ignored elsewhere;
  revocation immediate; a delegate cannot hand cover back.
- *escalation* — routes one step up the reporting hierarchy; **never decides anything, however
  overdue** (sweeps twice, then asserts no row left `Pending`); does not escalate on age alone;
  escalates once; escalates to nobody rather than inventing a recipient.
- *integration* — the Executor's `RequestApproval` produces a row somebody can see, and cannot
  decide it; a workflow step gate reaches the same queue and is governed by `approvals`, not
  `todo`.
- *tenant isolation and the API* — unauthenticated 401, cross-tenant 403/404 with no body, nothing
  stored outside its own tenant, meta and queue over HTTP, an unknown decision 400, audit events
  for every decision.

**Prompt 25's activation tests were rewritten, not relaxed.** They now build a real approval:
`requestActivationApproval` → an Approver decides → `activateVersion` cites it. They assert more
than before, including that a `Pending` request authorises nothing, and that the Head cannot
address the approval to themselves.

### Fixture facts found by failures, worth recording

- **The `Approver` role's `WholeCompany` assignment resolves to nothing.** Its template `maxScope`
  is `MultipleDepartments`, so `WholeCompany` caps to that with an empty department list, which
  fails closed. Both specs now add a department-scoped `Approver` assignment alongside it —
  additive, because `widestGrant` unions department lists for grants of the same kind.
- **`RequestApproval` is only offered for `ApprovalPending` and `BudgetOrTokenLimit` exceptions**
  (Prompt 27's `resolutionsFor`, from the source document's §18). A dead-lettered run is a
  `RepeatedFailure`, so the Executor integration tests use a budget block.
- **`agents:Approve` is held only by `Approver`.** `Manager` and `Head` deliberately hold no
  `Approve` on `agents`, so an activation approval must be decided by an Approver — the Approve &
  Assign boundary, and the reason self-approval on that type is structurally impossible.

### Regression

`engine-agent.e2e.spec.ts` 31/31, `executor.e2e.spec.ts` 35/35, `run-engine.e2e.spec.ts` 41/41 —
all three re-run because `ApprovalService` is now injected into the Executor and the registry.
`apps/web` 30/30 and a clean `next build` including the `/approvals` route.


## Prompt 29 — AI Provider Profiles and the Model Gateway

**`packages/types/src/providers.test.ts` — 37 unit tests.** Modes, the five profiles, lifecycle
transitions, routing under each fallback policy, pricing arithmetic, custom-config validation. Two
are about the shape of the seam rather than its behaviour:

- *keeps provider kinds and logical profiles disjoint* — nothing can be both a name business code
  may store and a provider name that must stay behind the gateway.
- *never names a provider in a routing reason* — those reasons are shown when a call cannot be
  routed, so they must not leak which vendor was unavailable.

Also worth naming: *rounds once at the end rather than per component* (three separate ceilings
would have billed 4 minor units where the exact total is 2.49), and *bills cached tokens at the
full input rate when the model does not discount them* — `null` means "not priced separately", not
free.

**`apps/api/test/model-gateway.e2e.spec.ts` — 37 tests** against the real `RoutingModelGateway`,
not the mock one. Grouped by what they defend:

- *provider names stay behind the gateway* — the response is serialised and asserted not to
  contain a provider name; the call record names the logical profile; a company user gets 403 on
  the platform route.
- *nothing claims a real provider* — `usesRealModel` false; every recorded call
  `producedByRealModel = false` with a null request id; Anthropic and OpenAI both refuse with
  `ProviderNotConfiguredError` and the message says the adapter has never been run; `meta` reports
  which adapters are registered *and* which can reach a provider; Test Connection reports
  `ok: true, reachedProvider: false`.
- *routing* — all five profiles resolve; `MigrationRequired` refuses new work and records an
  `Unroutable` call with no model; `AGENT_STANDARD` falls back and says it did; `HIGH_REASONING`
  refuses to substitute; the planner refuses a different capability.
- *company modes* — a BYOK route overrides the platform default outright; the four
  mode/ownership mismatches are each refused.
- *custom enterprise provider* — the secret is stored as a handle and appears in no response;
  plain http, a missing usage mapping and an endpoint on a first-party profile are each refused.
- *pricing* — a call cites the version that priced it; superseding leaves the earlier call's price
  intact; editing is refused in the database; exactly one current price survives.
- *lifecycle* — no return to `Active`; a withdrawn removal notice steps back to `Deprecated`.
- *the call record* — append-only; records exactly what the adapter reported; stays in its tenant.

### Two real bugs the tests found, both mine

1. **The audit event violated RLS.** `ProviderService` audited from inside
   `runAsPlatformOperation`, and PostgreSQL refused the `audit_events` insert. The policy was
   right; the caller was wrong (S-196).
2. **The reset left provider configuration mutated between tests.** Clearing only tenant-owned
   rows left a deprecated platform model, or a deleted platform route, in place for every later
   test — order-dependence that surfaced as "no model is configured" somewhere unrelated
   (ADR-152).

A third was a plain wiring cycle: the `PROVIDER_ADAPTERS` token defined in the module that imports
the service that needs it, which ESM reported as "cannot access before initialization" before a
single test ran (ADR-151).

### Regression

executor 35/35, run-engine 41/41, engine-agent 31/31, agent-builder 32/32, approvals 51/51 — all
five re-run because `ModelRequest` gained a required field and the harness reset changed. Web
30/30 and a clean `next build` including `/master/providers`.


## Prompt 30 — the Token/Cost Engine

**`packages/types/src/cost.test.ts` — 53 unit tests.** The hierarchy, wallet arithmetic,
thresholds, the three spend decisions, reservation transitions, the ledger's effect table, replay,
reconciliation and projection. The ones that carry weight:

- *keeps a stable lock order, which is what stops two reservations deadlocking* — looks like a
  tautology and is not; it is what stops somebody tidying the function into a different order.
- *does not hard stop a spend that lands exactly on the allowance* and *compares in minor units,
  so a floored percentage cannot mislead it* — both pin ADR-157, the off-by-one that made the last
  slice of every budget unspendable.
- *lets remaining go negative rather than hiding an overspend*.
- *reports rather than corrects* — reconciliation leaves the wrong number in place.
- *projects nothing when nothing has been spent / from less than an hour of data* — a date
  extrapolated from twenty minutes would be quoted in a meeting.

**`apps/api/test/cost-engine.e2e.spec.ts` — 33 tests**, against a real database:

- *concurrent agents cannot overspend the same balance* — ten and twenty genuinely concurrent
  reservations; the assertion is `reserved <= allowance`, not a particular count.
- *the flow* — hold the estimate, charge the actual, give the rest back; an overspend recorded at
  what it cost; a double settle refused by the service **and** by the database; `Released` kept
  distinct from settled-at-zero.
- *the hierarchy* — holds against every level at once; a department limit stops a spend the
  company could afford; the **company** is reported as binding when both would stop; a level with
  no budget defers rather than meaning zero.
- *thresholds* — hard stops past the allowance and not merely at it; the crossed level appears on
  the wallet; an admin is notified; three runs crossing one level do not produce three alerts.
- *the ledger* — every movement written and replaying to the balance; reserve and release present
  though they net to zero; append-only; drift found when something writes around the engine, and
  left uncorrected.
- *abandoned reservations* — expired after the window and marked `Expired`, fresh ones untouched.
- *through the model gateway* — the whole flow with no caller involvement; a call the budget
  cannot afford refused and recorded as never having happened; the hold given back when no model
  could answer.
- *the API and tenant isolation* — no route that spends by hand (404 asserted), unauthenticated
  401, one company's budget invisible to another, an audit event for an allowance change.

### Two real defects the concurrency tests found, both mine

1. **The hard stop was off by one** (ADR-157) — it refused the spend landing exactly on the
   allowance, making the last slice unspendable. Invisible in a single-threaded test; it showed up
   as "4 reservations were allowed, not 5".
2. **A threshold notification could fail a reservation** (ADR-162, S-203) — twenty concurrent
   reservations raced on one dedupe key and the unique-index error escaped.

Both are cases where the test expectation was *also* wrong, and it was worth deciding which of the
two was right rather than adjusting whichever was easier.

### Regression

model-gateway 37/37, run-engine 41/41, executor 35/35, engine-agent 31/31, web 30/30. Prompt 30 is
a full-verify checkpoint, so the whole API suite was run.

---

## Prompt 31 — credit top-up, reallocation and commercial edge cases

**`packages/types/src/credits.test.ts` — 45 unit tests.** Request states, Finance's decision
rules, grant lifetimes, the five commercial policies, carry-forward arithmetic, negative-balance
grace, plan-change pro-rating, reallocation and the resume rule. The ones that carry weight:

- *does not model an adjusted approval as its own state* (ADR-169).
- *defaults to never expiring purchased credit* — a default, asserted, because it is a decision.
- *does not count a grant that has not started* — what makes a future-dated top-up safe.
- *carries nothing from an overspent period* — a negative balance is a debt, not credit to carry.
- *leaves every other block alone* — loops the other blocked states to prove a top-up clears none.
- *refuses to move more than is uncommitted* — the reallocation invariant.

**`apps/api/test/credits.e2e.spec.ts` — 40 tests** against a real database:

- *a company cannot grant itself credit* — no company decide route (404), no company grant route
  (404), no platform queue from the company plane (403), and an Employee refused (403).
- *Finance decides* — approve, adjust, reject with a reason, refuse a second decision through the
  service and through the database, and a future-dated approval that is not yet spendable.
- *reallocation does not create allowance* — the total is unchanged, more-than-uncommitted is
  refused, **reserved budget cannot be moved**, and both ledger halves are equal and opposite.
- *the commercial policy* — starts at the documented defaults, is refused from the company plane,
  refuses an incoherent combination, and audits a change.
- *the edge cases* — reset not due, forfeit, carry-forward, capped carry-forward; a top-up with
  no expiry surviving ten years; a dated grant expiring exactly once; payment-failure revocation
  taking the balance negative and the policy then blocking; grace tolerating an overdraft;
  plan change deferred, immediate and pro-rated.
- *resuming blocked runs* — a budget-blocked run re-queued with its reservation cleared, other
  blocks untouched, resume as part of an approval, and **no resume on a future-dated approval**.
- *the ledger still explains the balance* — a top-up, a reallocation, an expiry and a revocation
  in one test, then `reconcile` finds nothing. That is the single most valuable assertion in the
  suite: it proves this prompt added no second way to move money.

### What running them found

Four defects, none of which a reading of the code had caught:

1. **The ledger kind carried the wrong sign.** An `Expiry` was written as a negative amount, which
   `ledger_amount_sign_matches_its_kind` refused outright — and would have desynchronised the
   maintained balance from the replayed ledger if it had not. Fixed in `adjustAllowance`
   (ADR-171), which now takes direction from `LEDGER_EFFECT` and a magnitude from the caller.
2. **A withdrawal was recorded as a `Refund`.** Wrong kind: `Refund` reduces `used`, so an unpaid
   top-up would have left the allowance untouched and written off real spend. The *test* had the
   same mistake in it, and was corrected along with the code rather than kept as the expectation.
3. **Two clocks in one operation.** `applyPeriodReset` was given a period boundary and threaded it
   into the grant's `effectiveFrom`, but `grant` judged liveness against `Date.now()` — so a reset
   applied for a named boundary wrote off the unused allowance and recorded the new period's
   allowance as future-dated, granting nothing back. The worst outcome in the module, and only a
   test that passes its own `now` reveals it. `grant` now takes the caller's clock.
4. **A missing plan allowance would have zeroed a budget.** `monthlyAllowanceMinor` defaulted to 0
   when no `tenant_ai_budget_policies` row existed, so a reset would write off everything and
   grant nothing. It now refuses to reset and says why.

### Regression

types 98/98 (credits 45, cost 53), cost-engine 33/33 and platform-console 46/46 after
`adjustAllowance` changed its contract, web 30/30, `next build` clean.

The Prompt 29 change to `providers` module status broke one Prompt 9-era assertion that every
Master Console module was a shell. **Updated rather than relaxed**: it now checks that every
module has a real blocker *and* that a live module is honest about what it still cannot do. The
same test covers `credits` going live at Prompt 31.

---

## Prompt 32 — the Security Center

**`packages/types/src/security-center.test.ts` — 27 unit tests.** The vocabulary, the seven views
and their sources, the eleven metrics and their drill-downs, the time-range arithmetic, MFA
coverage, guest expiry and SSO status. The ones that carry weight:

- *leaves no recorded event category invisible* — **this test found a real gap.** With Active
  Sessions reading live state, the `Session` category (sign-outs, admin revokes, expiries)
  appeared in no view, so a company could not have seen that somebody was signed out.
- *leaves no view unreachable from a metric* — a view with no card leading to it is a screen
  nobody finds.
- *claims a correlation id only where a request produced the row* — state rows have none, and
  offering the filter would send an investigator after a request that never existed.
- *judges incomplete coverage against the company's own policy* — the approved documents set no
  MFA target, so a red badge on a company that does not require MFA would be invented policy.
- *floors rather than rounds* — 249 of 250 must not read as 100% on a screen asking "is everybody
  covered".
- *sets no threshold it was not given* — one failed login and five hundred are both `watch`.
- *builds the exports view from named actions rather than a category* — `Access` holds fifty
  actions, so a category filter would answer the wrong question.

**`apps/api/test/security-center.e2e.spec.ts` — 45 tests** against a real database:

- *who may look* — a Company Admin reads and acts; an `Auditor` reads and exports and is refused
  the revoke route; an Employee, a Manager and a guest are refused outright; and **a UBoss
  platform actor is refused too** — support reaching a customer’s security history goes through
  break-glass, not through the customer’s own screen.
- *tenant isolation* — a cross-tenant request refused, and another company's events, guests and
  live sessions absent from the three views that could have leaked them.
- *the posture* — MFA coverage judged against the company's policy, a confirmed factor counted and
  a pending one not, SSO reported as a word, a lapsed guest reported as a problem, failed logins
  counted inside the window and not outside it, and a single administrator flagged as a lockout
  risk.
- *the views* — every advertised view served, an unknown view 404, a sign-out visible as an
  authentication event, a live session carrying its device and a revoke handle, a refused
  permission listed, filters by actor and correlation id, and the total counting the filter rather
  than the trail.
- *export* — the export records itself and appears under Data exports; a custom role with `Audit`
  and no `Export` is refused.
- *revoking a session* — a colleague signed out with the reason recorded; the act distinguished
  from a platform revoke in the trail; another company's person refused and left signed in; an
  empty reason refused; a second revoke refused; and the cross-company count reported when the
  person belongs to two companies.
- *tamper protection* — update and delete refused by the database for both trails, with the
  application role, and no route on this controller that edits or deletes anything.

### Regression

audit 55/55 (the shared `findSecurityEvents` gained set filters), auth 50/50, authorization 54/54
and enterprise-identity 80/80 (`SessionService` and the security-action vocabulary both changed),
web 30/30, `next build` clean.

---

## Prompt 33 — Engine Agent memory and AI output feedback

**`packages/types/src/memory.test.ts` — 43 unit tests** and
**`packages/types/src/feedback.test.ts` — 29**, covering the classification order, the per-mode
defaults, policy validation, the write decision, the four read scopes, expiry, offboarding, the
ratings, eligibility, validation, evaluation candidacy and the quality summary. The ones that carry
weight:

- *gates promotion on a module a company user can actually hold* — **this test found a real
  defect.** The promote route was gated on `skills:EditDraft`, and `skills` is a platform module,
  so nobody in any company could have promoted anything (ADR-185).
- *has coherent defaults, by its own validator* — a default the product would refuse if a company
  entered it is not a default.
- *persists no Restricted data by default, in any mode* — the substantive classification decision,
  pinned.
- *never treats two nulls as the same Objective* — treating null as a matching value is how a
  scoped read silently becomes a company-wide one.
- *checks the cross-user rule before the scope* — §19's "never" holds however narrow the scope is.
- *deletes rather than leaving a record owned by somebody who has left* — the offboarding fallback.
- *exposes no field, flag or function that could enable it* — asserts the *absence* of provider
  training, so a later prompt adding a consent toggle fails here (ADR-187).
- *floors rather than rounds* — 66.6% must not read as 67% on a screen asking "is this agent
  reliable".

**`apps/api/test/memory-feedback.e2e.spec.ts` — 58 tests** against a real database:

- *the memory policy* — all four created from the documented defaults, idempotently; an admin can
  narrow a mode; a Manager is refused in the service *and* at the route; widening past the
  architecture's ceiling is refused; cross-user on a narrow scope is refused **by the database**;
  and a change is audited with both the old and the new value.
- *remembering* — the mode comes from the agent rather than the caller; data above the ceiling is
  refused and the refusal is audited; Objective memory with no Objective is refused; approved
  long-term with no approval is refused; another company's run is refused; and **no route writes a
  record**.
- *memory scope leaks* — the prompt's own words, and the heaviest section: run, agent, person and
  company scope each confining what they claim to, the composite foreign key refusing a
  cross-tenant write outright, and expired and deleted records never returned.
- *forgetting* — content cleared and the record of the deletion kept; a Manager refused; a second
  deletion refused; the sweep clearing content too; and nothing swept before its time.
- *offboarding* — delete, transfer, anonymise, the no-successor fallback, and other people's
  memory left alone.
- *feedback permissions* — the prompt's other named requirement: an Employee may rate; somebody
  with no role may not; an Employee is refused the promote route; a second rating from one reviewer
  is refused in the service **and** by the unique index; two reviewers may both rate; only your own
  is amendable; another company's output is refused; and a run with no output is refused.
- *feedback and quality* — a correction insisted on (and refused at the database for one word); the
  mock-model flag copied onto the row; quality reported with how much of it was real; eligibility
  decided and explained; promotion of an ineligible rating refused at the database; and the
  provider-training stance asserted twice.
- *promotion* — a `HumanJudged` case created in the Prompt 18 tables, a second promotion refused,
  and amending a promoted rating refused because its correction is now an assertion other work
  depends on.

### What running them found

**The guest test asserted the wrong thing.** It claimed a guest cannot rate an output; the guest
was refused for having *no role at all*, which proves nothing about guest-ness. Under the client's
own model an External Guest holds read, comment and draft — "an External Guest with a Manager role
is still a guest" — and a rating is a comment, so a guest who has been given a role may
legitimately judge an output they can see. The test now asserts the true statement.

**`BadRequestException(string[])` leaves `error.message` as "Bad Request Exception"** — the fifth
time this has cost time. The list is on `error.response.message`, which is what a client receives,
and asserting on `error.message` would have passed for any bad request at all. The suite now has a
`problemsFrom` helper.

### Regression

users-access 54/54 (offboarding gained a step), skills 47/47, engine-agent 31/31 and run-engine
41/41 — 173 in total, all pass. Web 30/30, `next build` clean, `eslint .` clean.

---

## Prompt 34 — Objective completion, outcome review and archive

**`packages/types/src/objective-closure.test.ts` — 41 unit tests**, plus three Prompt 19 tests
updated for the extended lifecycle. The ones that carry weight:

- *gates every closure act on a grant some role actually holds* — **this found a real defect.**
  The pause route was gated on `objective:Pause`, which the role templates grant on `agents` only
  (ADR-195).
- *does not gate anything on `objective:Pause`* — pinned, so a later prompt does not reach for the
  name that reads better and is held by nobody.
- *refuses skipping the review to reach Closed* — closure is what the review produces.
- *refuses completing a paused objective without resuming it*.
- *offers no route from Outcome Review back to Active* — reopening is a new version.
- *freezes content from Active onwards, pause included* — the assumption ADR-190 is about.
- *does not count a paused objective as finished* — a report counting it as closed would
  understate what a company still has open.
- *rounds lateness up, so three hours over is a day late* — rounding down would report a missed
  deadline as met.
- *says no target was set rather than calling it on time* — `Unknown` is a first-class answer.
- *reports unresolved exceptions without blocking on them* (ADR-193).
- *does not let an owner's own signature stand in for an approval*.

The three Prompt 19 tests were **updated rather than relaxed**, and two got stronger:

- *carries the client's states with their full approved wording* — eight became eleven, and the
  authoring states must still be in their original order with their original labels.
- *reaches Active for the first time only through ReadyForApproval* — now asserts the two states
  that reach `Active` **and** that nothing in the authoring half can jump the approval gate. A
  resume is not a second route to publication.
- *freezes content from Active onwards, pause included*.

**`apps/api/test/objective-closure.e2e.spec.ts` — 37 tests** against a real database, built on the
versioning suite's fixture so every objective really goes live through draft → submit → confirm →
review → approve → publish:

- *controlled pause and resume* — paused with a reason, work no longer assignable, a second pause
  refused by the transition table, a pause with no reason refused, resumed with the days counted,
  every pause kept, and **a paused version's Form 2 refused at the database**.
- *completion* — completed from live, refused from paused, and the outstanding work reported.
- *the outcome review* — refused while the work is unfinished, recorded once it has finished, the
  comparison carrying what §27.1 asks for, **the snapshot proved not to move** when a later run
  lands, explanations and actual results insisted on, a second review of the same version refused
  by the unique index, and a review refused to somebody without `Approve`.
- *sign-off and closure* — the default policy read from the settings catalogue, a closure by a
  non-owner refused, the owner signing and then closure succeeding, a signature from the wrong
  person refused, second signatures and second closures refused, and the policy recorded on the
  review.
- *archive and reopening* — archived from closed, archived from completed **with the audit event
  recording that there was no review**, no route back to live, and a reopen producing V2 Draft
  while V1 stays Closed.
- *the route guards* — a Head pausing over the route, an Employee refused at pause and at review,
  the meta served to anybody who may see the objective, and an invented verdict refused with a 400.
  These exist because a service-level test passes whatever the decorator says.

### Regression

objectives 80/80, objective-versioning 49/49, objective-analysis 38/38, assignment 35/35 and
company-settings 36/36 — every suite that reads the objective lifecycle or the settings catalogue.
types 735/735, web 30/30, `next build` clean, `eslint .` clean.

---

## Prompt 35 — Knowledge, files, classification and safe uploads

### Unit — `packages/types/src/knowledge.test.ts` (46/46)

The rules with no database: the scan transition table, `fileIsUsable` returning true for exactly
one state, upload validation returning **every** problem rather than the first, retention expiry,
`decideDeletion` with a legal hold beating an expired retention *and* an explicit request,
`decideKnowledgeRead`'s three conditions, and both egress ceilings including the
permitted-but-needs-redaction case.

One test asserts an **absence**: the module exposes nothing resembling a shared vector store, per
§35. An absence is only durable if something checks for it.

### E2E — `apps/api/test/knowledge.e2e.spec.ts` (30/30, real PostgreSQL)

- *uploads* — a permitted file stored outside the database with a sha-256 hash; an `.exe` refused
  whatever it claims to be, **with nothing reaching storage**; a filename containing a path
  refused; an archive refused; an oversized file refused **and recorded as a security event**.
- *scanning* — the EICAR test file flagged `Infected` with a `Critical` security event; an infected
  file refused at download; an unscanned file refused entry to a knowledge source; a clean file
  refused a second scan and a quarantined one allowed it.
- *classification* — `Confidential` downloadable and `Restricted` not, under the default ceiling; a
  download recorded so Data Exports can show it; `Confidential` egress refused, then still refused
  after the ceiling is raised because it would need redaction; an incoherent policy refused by the
  database.
- *knowledge sources* — an unapproved source refused to a named agent and permitted after approval;
  an agent not named on it refused; an approved source returned to Draft when changed; a file more
  sensitive than its source refused; a source refused a reclassification below what it holds; a
  quarantined file excluded from what an agent receives.
- *retention and holds* — content deleted with the record surviving **and the bytes gone from the
  adapter**; a held file refused deletion in the service *and* by
  `held_file_is_not_deleted`; a sweep deleting one file and holding back both the held one and the
  one whose policy asks for a person.
- *permissions* — an Employee refused the list, the upload, the download, the knowledge sources
  **and the access preview** (which returns file ids, so it goes through the same rule); an Approver
  able to approve, to see the inventory and to run the preview but **not** to download; an Approver
  refused the authoring routes.
- *tenant isolation* — one company's files invisible to another through the API, by id, and
  directly against the table under RLS; a path-swapped tenant id refused.
- *the seam* — every `S3StorageAdapter` method refusing rather than appearing to store anything.

### Regression

**The full API suite was run**, because `tablesInDeletionOrder` in `test-database.ts` is shared by
every e2e spec and this prompt added four tables to it.

**1769 of 1770 passed across 327 suites.** The one failure was
`performance-badges.e2e.spec.ts` → *"starts at Bronze and climbs through every configured
threshold"*, which reported `A query cannot be executed on an expired transaction. The timeout for
this transaction was 5000 ms, however 412526 ms passed`. **412 seconds inside a 5-second
transaction window is the machine stalling, not a defect**: the test does not open a long
transaction, and nothing in this prompt touches performance events. Re-run on its own alongside the
knowledge suite it passed — **76/76** — and it is recorded here rather than quietly re-run and
reported as green, because a 413-second stall is worth knowing about even when it is not a bug.

Also clean: types 781/781, web 30/30, `eslint` on every changed path, and both API tsconfigs.

---

## Prompt 36 — Support, authorized support sessions and system health

### Unit — `packages/types/src/support.test.ts` (23/23)

Both state machines proved reachable from their start state and terminal at their end; `Resolved`
able to go back to work and `Closed` not; `WaitingOnCustomer` counted as open but **not** as UBoss's
own backlog; the three incident severities pinned to exactly P0/P1/P2.

The weight is on `decideSessionStart`: every authorization state under `NotRequired`, a pending
session refused with the words *"no emergency bypass"*, a declined one refused as *"not retried"*,
and a request raised before the policy was turned on refused rather than waved through.

One test iterates `COMPANY_MODULES` and asserts `PlatformSupport` holds **nothing** on any of them.

### E2E — `apps/api/test/support.e2e.spec.ts` (22/22, real PostgreSQL)

- *tickets* — an Employee raising one; references numbered per company so two companies both start
  at 1; a resolution refused without an explanation; a closed ticket never reopened; a company reply
  moving a parked ticket back into UBoss's queue; one company's tickets invisible to another through
  the API, by id, and under RLS.
- *internal notes* — an operator's note absent from the company's detail **and from the serialized
  API response**, present in the operator's; the default asserted as internal.
- *support sessions* — activation without asking under `NotRequired`; refused under `Required` with
  **the security event asserted, not just the 403**; activated once authorized; refused for good
  once declined; a decline refused without a reason; a second decision refused; an Employee refused
  the decision and the list; one company refused a decision about another's session.
- *incidents* — declaring an alert (and that declaring acknowledges); a second declaration refused;
  publishing refused without customer wording; publishing an undeclared alert refused; tickets tied
  to an incident so "how many companies" is answerable; linking to an undeclared alert refused.
- *the customer status* — a published P0 reads `down` and carries the operator's wording, and the
  **serialized response is asserted not to contain** `db-primary-2.internal`, `pool max 200`,
  `query 40s` or `exhausted`; an unpublished incident reads `ok` to the company while the operator
  sees it.
- *honest health* — the inline queue and the absent providers reported as `measured: false` rather
  than green; the database as measured and `ok`.

### Two real defects the tests found

**The customer status leaked the alert's internal headline.** `CustomerVisibleStatus.title` was
filled from `service_alerts.summary`, so *"db-primary-2 exhausted its connection pool"* would have
been published to every company. Fixed structurally: the field is gone and the query no longer
selects the internal columns.

**The blocked-activation security event was rolled back with the refusal.** The gate wrote its event
inside the platform transaction and then threw, discarding both. The test asserted the event rather
than only the 403, which is the only reason it was visible.

### Regression

audit 41/41, platform-console 33/33, company-settings 36/36, health 14/14, knowledge 30/30,
connections 47/47, support 22/22 — **246/246**. Adding a constructor dependency to
`BreakGlassService` broke two suites that build their own testing module; both were fixed by
declaring the provider rather than by loosening anything. types 804/804, web 30/30, `eslint` clean
on every changed path, both API tsconfigs clean.

---

## Prompt 37 — Reporting and management dashboards

### Unit — `packages/types/src/reports.test.ts` (20/20)

The locked contract first: exactly two slices, both named, both with a destination, and
`DASHBOARD_ALLOWED_KEYS` asserted as the whole permitted set with six forbidden keys checked by
name.

Then the permission rule, asserted **against the real role templates** rather than described: every
report names a real company module and a real action; `ApprovalAging` needs `approvals:View`;
`AiUsageAndCost` needs `settings:Administer`; `AuditActivity` needs `settings:Audit`; and an
Employee — who does hold `settings:View` — holds neither of the last two. That test is the one that
found the leak.

Export as its own grant: absent on Employee and Approver, present on Manager, Head and
CompanyAdmin.

Windows: each fixed range measured from the caller's clock, a custom range refused when backwards
or missing an end, refused beyond 366 days, and **accepted exactly at the limit** — the boundary,
not just past it.

Scope: an empty list is nobody and `null` is everybody. CSV: all four injection prefixes
neutralised, quotes doubled, and a column not in the list absent from the output.

### E2E — `apps/api/test/reports.e2e.spec.ts` (17/17, real PostgreSQL)

Built on a **real reporting tree** with the real `ReportingHierarchyResolver` — admin
(`WholeCompany`), manager (`TeamSubtree`), one employee reporting to them, and a fourth person in
the same company outside the subtree, who is the leakage control.

- *the locked contract* — the response's whole key set asserted; six forbidden keys checked; both
  slices and both destinations from `/meta`.
- *scoped counts* — 4 agents for the admin, **2** for the manager, 1 for the employee; an archived
  agent not counted, so the donut matches the list it drills into; the scope sentence differing per
  role.
- *the catalogue* — AI Cost and Audit Activity **absent** for an Employee and present for an admin;
  both **403 at their own route**, because hiding them in the catalogue is presentation; an
  invented report key 404s.
- *scoped rows* — a manager's Engine Agent Health containing their own and their report's agents
  and **not** the stranger's or the admin's, asserted on full uuids; Approval Aging showing 1 row
  to the employee, 2 to the manager, 3 to the admin.
- *the empty scope* — a `Department` grant held by somebody with no employment record resolving to
  `[]` and the report returning nothing rather than everything.
- *export* — an Employee reading Approval Aging (200) and refused its export (403); a manager
  exporting; `report.exported` written for an export and **no audit row for a read**; a seeded
  `=cmd|"/c calc"!A1` title escaped in the file.
- *windows* — a two-year range refused 400; a row 200 days old excluded from both the 30- and
  90-day windows.
- *tenant isolation* — the other company seeing only its own agent in both the report and the
  dashboard, and a path-swapped tenant id refused.

### Four test bugs worth recording

Three fixtures tripped real constraints doing their job — an `Active` agent needs `activated_at`,
an archived one needs `archived_at` **and** `archived_by_user_id`, and `ObjectivePublish` is not an
approval type (`ObjectiveReview` is). The fourth was mine: **uuid v7 ids minted in the same
millisecond share their first 8 characters**, so a leak assertion comparing `id.slice(0, 8)`
matched every row and failed against correct behaviour. It now compares full ids.

### Regression

types 824/824; reports, authorization, hierarchy, company-settings and health — **164/164**. web
30/30, `eslint` clean on every changed path, both API tsconfigs and the web tsconfig clean.

---

## Prompt 37A — Portable UBoss Profile Search

### Unit — `packages/types/src/profile-search.test.ts` (15/15)

The input is one identifier and the stance says why. The three field whitelists asserted exactly.
The prompt's forbidden list checked to actually contain what the prompt forbids — **and** a test
asserting no *permitted* field name contains a forbidden word, so the e2e grep cannot start failing
against a correct response and tempt somebody into weakening it.

Both defaults off. And the one that would be a quiet leak: `shareablePerformance` under `BadgeOnly`
is given a score and asserted to withhold it, because that decision living in the service and the
row being passed through is exactly how a score escapes.

On-time percentage null at zero due dates, and rounding checked at 67 / 100 / 0.

### E2E — `apps/api/test/profile-search.e2e.spec.ts` (16/16, real PostgreSQL)

Built as the two-tenant security test the prompt asks for, with **three** companies rather than
two: a person who worked at **Alpha Works** (2023–2025, Analyst) and now works at **Beta Labs**
(Senior Analyst), and an HR administrator at **Gamma HR** who employs neither. Two companies would
let a leak hide behind "the searcher is one of the employers".

Company names carry none of the forbidden words on purpose — a company called "TaskForce Ltd" would
fail a correct response, and the fix would then be to weaken the grep instead of the field.

- *the capability* — refused before it is enabled, with a message saying it is a setting; `/meta`
  reporting `enabled` both ways so the screen need not offer a box that always 403s.
- *authority* — an Employee refused with the feature **on**; a CompanyAdmin permitted.
- *the input* — an email, a name and a twelve-digit number each refused 400; an unknown but
  well-formed id 404.
- *the projection* — the response's key set asserted against the whitelist, and every employment
  entry's too; then the serialized JSON greped for all ten forbidden words **and** for the six
  specific values the employers hold: `internal.example`, the phone number, both employee ids, the
  department name and the person's own email address.
- *the useful facts* — designation and current/past per employer, so the whitelist has not
  narrowed the feature into uselessness.
- *sharing* — nothing travels by default; `BadgeOnly` returning a badge and a null score;
  `BadgeAndScore` returning a number; and Beta's choice to share **not** speaking for Alpha.
- *audit* — two rows for two lookups including the one that found nobody, each recording the id
  searched; and **both employers' trails asserted empty**, because a company must not learn who
  has been verifying their former employees.
- *cross-tenant* — a searcher refused when another company's id is in the path, and one company's
  enablement not enabling another's.

### What the tests found

**The `users` settings category is deliberately settings-free.** Both new controls were first put
there and a Prompt 14 test caught it — the category carries a note pointing at the Users & Access
screen and asserts it owns no settings. They moved to `security`, which is the better home anyway:
both are "who outside this company can see what", the same question as the Prompt 36 support-access
control beside them.

**`employment_end_state_and_date_agree`** pairs the employment state with the end date in both
directions, so the Alpha fixture needed `state: 'Ended'` alongside `endedAt`. The constraint doing
its job.

### Regression

profile-search, company-settings, hierarchy, enterprise-identity and reports — **202/202**. types
839/839, web 30/30, `eslint` clean on every changed path, all tsconfigs clean.

---

## Prompt 38 — Company exit and data portability

### Unit — `packages/types/src/company-exit.test.ts` (26/26)

The lifecycle reachable from `Requested`, terminal at `Deleted` and `Cancelled`, cancellable from
all four earlier states, and refusing to rewind a read-only period. The schedule stacking both
windows and defaulting to sixty days.

Then the classification, asserted as lists rather than described: the audit trail, security trail,
break-glass history and lifecycle transitions never `Content`; the financial record never
`Content`; who-held-what-authority never `Content`; and employment records, badges, performance
events and departments all `PersonRecord`.

Three tests record what the dependency graph decided: `reward_awards` deleted because its links to
objective data are NOT NULL, `performance_policies` preserved because a score cannot be read
without its policy, and every `DETACH_BEFORE_DELETE` column belonging to a non-`Content` table.

The confirmation being the slug and not `DELETE`, case-sensitive and exact. The export naming its
exclusions with real reasons.

### E2E — `apps/api/test/company-exit.e2e.spec.ts` (20/20, real PostgreSQL)

**The test that keeps this correct as the schema grows** reads `information_schema` for every
tenant-scoped table and fails if any is unclassified. It caught `company_exits` itself on the first
run.

- *request and approval* — an unexplained exit refused; a second open exit refused and permitted
  after the first is cancelled; **the requester refused their own approval with the security event
  asserted**; the schedule frozen at approval with both windows stacked.
- *the lifecycle* — `ReadOnly` and `Closed` applied through `CompanyLifecycleService`, with that
  service's own transition history asserted, because going through it is the point.
- *the export* — the audit trail present and non-empty; the exclusions naming credentials and
  Aadhaar; **no work email address in the payload**; refused once the content is gone.
- *the confirmation* — `DELETE`, `delete`, the upper-cased slug and **another company's slug** each
  refused, four security events asserted, then the correct slug accepted.
- *what survives* — row counts before and after a real deletion: agents and memberships gone;
  **the audit trail grown**, the financial record intact, the deletion certificate present,
  employment records and badges untouched; the manifest carrying `engine_agents` and **not**
  `audit_events` or `employment_records`; and `notifications` reported under
  `retainedByPrivilege` rather than claimed as deleted.
- *the other company* — agents, notifications, audit rows, employment records, memberships and
  lifecycle state all asserted unchanged **after** the deletion, because it runs as a platform
  operation and RLS protects nobody there.
- *cancellation* — from `RetentionHold` leaving the company `Closed` with the trail saying why;
  from `ReadOnly` restoring it to `Active`; refused after deletion; refused with no reason.
- *audit* — all six step actions asserted present in the company's own trail.

### Three latent Prompt 37 bugs this prompt found

Adding *"runs every report in the catalogue without throwing"* — a loop that simply asks for each
of the ten and expects a 200 — found **three runtime errors that tsc had passed**:

* `ObjectiveVersion.title` does not exist; the field is `objectiveName`.
* `AiOutputFeedback` has no `skillVersionId` — feedback is recorded against a *run*, so Skill
  Usage & Quality now measures evaluation pass/fail, which the schema can actually attribute.
* `SkillEvaluationRun` has no `createdAt`; the column is `runAt`.

The original Prompt 37 suite exercised two of the ten reports, so all three shipped. The loop is
cheap and would have caught every one.

### Regression

types 865/865. company-exit, reports, company-provisioning, company-settings, audit and
profile-search — **181/181**. `eslint` clean on every changed path; both API tsconfigs clean.

---

## Prompt 39 — Observability, metrics, tracing and the incident workflow

### Unit — `packages/types/src/observability.test.ts` (23/23)

Every metric the prompt lists by name, each with its kind and the question it answers — latency a
histogram, depth a gauge, errors a counter, because a latency *counter* would grow forever and mean
nothing.

Then the two that matter: **no permitted label matches `FORBIDDEN_METRIC_LABELS`** anywhere, and
`provider_errors` is labelled by `profile` and never `provider`. Plus ascending histogram buckets,
because non-ascending ones make cumulative counts nonsense.

Alert rules: every rule names a real metric and carries a rationale over forty characters; keys
unique; the threshold exclusive at the boundary; **reservation drift the only zero-threshold rule**;
and **at most three Critical rules**, because Critical stops meaning anything past that.

Incident workflow: a postmortem refused on an unresolved incident, refused with no timeline,
refused on an undeclared alert, accepted when resolved with a timeline; required for P0 and P1 and
not for P2.

### E2E — `apps/api/test/observability.e2e.spec.ts` (24/24, real PostgreSQL)

- *the correlation chain* — one id written onto **both** `model_gateway_calls` and
  `cost_ledger_entries` inside a real ambient context, then read back by that id. This is the gap
  the prompt found and the headline of the suite.
- *tracing* — the correlation id used as the trace id with parent/child nesting recorded; a span
  recorded for work that **threw** and the error re-raised; an `apiKey` attribute redacted;
  `exportsSpans` asserted **false**.
- *metrics* — counter, gauge and histogram recorded and rendered, with `# TYPE` lines and the
  required `le="+Inf"` bucket; **an observation carrying `tenant_id` dropped and the drop counted**;
  differently-ordered labels treated as one series; a histogram mean reported.
- *alert rules* — drift measured from a two-hour-old held reservation; **an alert raised once and
  not twice** across two evaluations, with the reading and threshold in its detail; nothing raised
  when quiet.
- *the incident workflow* — a **backfilled** timeline ordered by when things happened rather than
  when they were typed; an empty entry refused; a **P0 refused resolution without a postmortem**
  then accepted with one; a P1 refused with no timeline at all; a **P2 resolved on its mitigation
  alone** with a `Resolved` entry appended.
- *corrective actions* — owner and due date recorded and **overdue flagged**; a vague description
  refused; `Done` accepted with no note and `Dropped` **refused without a reason** then accepted
  with one; a second close refused; every open action listed across incidents for a weekly review.

### What the tests found

**`logFieldIsForbidden` missed `API_KEY`.** It compared lowercased strings, so a snake_case or
kebab-case spelling of a forbidden field slipped through — and log fields are written in every
casing convention a codebase has ever had. Separators are now stripped from both sides.

Four fixture attempts also ran into real constraints doing their job, each recorded in the test that
hit it: a successful gateway call must name the model that answered, a `Settle` must name its
reservation, and a non-`Held` reservation must record when and why it closed.

### Regression

types 888/888. observability, security-center, support, cost-engine, model-gateway and
engine-agent — **192/192**, which covers every module the correlation threading touched. `eslint`
clean on all six changed paths; both API tsconfigs clean.

## Prompt 40 — Rate limits, abuse protection and execution fairness

`packages/types/src/rate-limits.test.ts` — **42/42**.
`apps/api/test/rate-limits.e2e.spec.ts` — **39/39** against real PostgreSQL.

The prompt asks for **load-oriented tests**, so the weight is on behaviour under volume:

* a burst that exhausts a bucket, the refusal that follows, and the headers that let a client
  cooperate rather than merely be punished;
* **one person's exhausted bucket not refusing their colleague**, and one company's not refusing
  another company — tenant isolation applied to capacity, not just to data;
* **fifty queued runs from one company not putting another company's single run behind them** — the
  quiet company lands second, not fifty-first — plus a thousand jobs across ten companies with every
  quiet company served in the first pass;
* a retried `POST` doing the work **once** and returning the same answer, proved by a handler that
  counts its own calls;
* a provider that says "slow down" being obeyed and one that says "no" not being retried;
* the Redis and in-memory stores returning **identical decisions**, which is what makes the Lua
  script trustworthy — skipped and reported as skipped where no broker is running, never passed
  silently.

### What the tests found

**An expired idempotency key was unusable forever, not for twenty-four hours.** The read treated an
expired record as absent — correctly — but the row remained, so the insert tripped the unique index
and the caller was told `InFlight` by a request that had finished last week. `begin` now clears the
expired claim for that exact key in the same transaction as the new one (S-308). This is the defect
of the prompt: nothing else would have surfaced it, because it needs a test that waits out a window.

**Two constraints refused a test fixture and were right to.**
`idempotency_record_expires_after_it_was_created` refused a row backdated only in its expiry — so
the test now backdates **both** columns, which is what actually happens as time passes.
`completed_run_says_whether_the_model_was_real` refused a run finished without saying whether a live
provider or the mock produced it.

**Two registrations of one class are two instances.** `{ provide: RateLimitStore, useClass:
InProcessRateLimitStore }` alongside `InProcessRateLimitStore` gave the test a store nothing had
used, so a leak assertion read zero. `useExisting` binds the abstraction to the one instance — worth
recording because the assertion appeared to fail while the product was correct.

**An optional constructor parameter still needs `@Optional()`.** `RunEngineService` took
`fairness?: RunFairnessService | undefined` and Nest refused to construct it — 41 run-engine tests
cancelled at once. A type-level optional is not a DI-level optional.

### The Executor side

`apps/api/test/executor.e2e.spec.ts` gains two, and they are a pair on purpose:

* a run queued **45 minutes** raises `AgentRunOverdue` at `Medium`, with the wait and the deferral
  reason both in its detail;
* a run queued **5 minutes** raises **nothing** — the threshold is what makes the first test worth
  having, and without this second one the feature could fire on every busy morning and nobody would
  notice until the exception list was being ignored.

The run is planted with an aged `created_at` rather than produced, because producing one would mean
holding the queue for half an hour. The row is what the sweep reads, so an aged row is the same
input a genuinely starved run presents.

### Regression

**123/123** across run-engine, model-gateway, company-exit and observability — the four suites the
run engine, gateway and exit-classification changes touch. Then the **full API suite**, because two
global interceptors and an `app.module` change can realistically break unrelated specs and the
standing test-scope rule calls for it at exactly that point.

**One process note worth recording:** the first full-suite run was discarded rather than reported.
`packages/types/dist` and `dist-test` were both rebuilt while it was in flight, which is the
documented way to make a whole suite look flaky — specs that had not yet started would have loaded
newly written files. It was stopped and re-run once every source change was complete. A tainted
green is worse than no result.

### What the full suite found that the targeted suites could not

Three failures, all from the eleventh exception kind, and the third is the interesting one:

1. **`scheduled_run_knows_its_moment`** refused the new fixture — a `Scheduled` run must record the
   moment it was due. The fixture keeps the trigger and supplies `scheduledFor`, because a scheduled
   run is the realistic starvation case: nobody is watching it.
2. **A hardcoded `assert.equal(kinds.length, 10)`** in a Prompt 27 test broke on the eleventh kind.
   Now `EXCEPTION_KINDS.length`, which keeps the intent — every kind is published with an owner —
   without rotting each time the set grows.
3. **`exception_kind_is_known`** refused the row at runtime. A CHECK enumerating the ten kinds,
   written five prompts earlier. TypeScript, 930 type tests and lint all passed; only a test that
   actually *raised* one found it. Fixed by `20260915110000_executor_knows_a_starved_run` — see the
   DB changelog for why the constraint stays rather than going away.

`idempotency_records` was also added to `tablesInDeletionOrder`: a platform-plane record has a null
`tenant_id`, so nothing cascades it away when the tenants go, and it would survive a reset to
collide with the next test using the same key.

types **930/930**. Both API tsconfigs clean; `eslint` clean on every changed path.

## Prompt 40A (CR-03) — access, the Job Method, photos and chat

| Suite | Result |
| --- | --- |
| `packages/types/src/operating-model.test.ts` | **28/28** |
| `packages/types/src/job-method.test.ts` | **41/41** |
| `packages/types/src/workspace-chat.test.ts` | **30/30** |
| `apps/api/test/workspace-chat.e2e.spec.ts` | **24/24** |
| `apps/api/test/cr03-access-and-job-method.e2e.spec.ts` | **38/38** |

The weight is on the distinctions the amendment exists to draw, not on the plumbing:

* a standard Employee refused Agent Builder **and** an explicitly granted one allowed — proved by
  reading the effective grants back out of the live engine, not by inspecting a constant;
* an administrator refused a capability they do not hold, and refused their own;
* a manager building for an employee who can then run it **and still holds no builder grant**;
* download with no builder permission, upload with it;
* an upload that activates nothing, proved by counting runs either side;
* two people in one conversation seeing different previews of the same reference, with the
  restricted one's whole response greped for the objective's name.

### What the tests found — nine things, and seven were the product or the approved matrix

1. **An `OwnWork` employee could not run a manager-built agent.** `ownerUserId` is the manager, the
   employee is capped at `OwnWork`, and the scope engine correctly refused — which made the entire
   build-for-employee case unreachable. Resolved by recognising that a live share *is* what makes
   the work theirs (ADR-242), with the share still checked first so nothing is let through without
   one.
2. **`agents:Assign` is granted to no role template at all.** Gating the share on it made the
   feature unreachable for every role in the product. Now two grants that exist (ADR-243). A real
   property of the approved matrix, like `objective:Pause`.
3. **`users:ManageAccess` is CompanyAdmin-only**, and a CompanyAdmin may grant anything — so no
   template can express "may manage access, may not build agents", which is exactly the case the
   delegation rule exists for. The test now builds a "People Admin" custom role, which is how a real
   company would express it.
4. **A Head genuinely holds `BuildAgents`** (`agent-builder` Create/EditDraft/Run/Publish). The
   first version of the delegation test used a Head and failed because the product was right and
   the test was wrong.
5. **`FileService.upload` requires `settings:EditDraft`**, which an Employee does not hold — so a
   photo could not go through it. Resolved with a named seam rather than a looser gate (ADR-247).
6. **`Connection` has no relation to assigned work.** The connection id lives in
   `executionSetup` JSON. The relation-based query compiled and failed at runtime, because Prisma's
   `where` types do not reject a relation name that does not exist — the same family as the Prompt
   37 `select` bugs.
7. **A live `ObjectiveVersion` cannot be given workflow steps.** A Prompt 20 trigger refuses it —
   "an authorised edit creates a new draft version; it never rewrites the plan that is live" — so
   the fixture seeds a Draft, adds steps, then promotes. The product refusing a fixture correctly.
8. **A nested Prisma `create` rejects `tenantId`.** The parent supplies it through the composite
   relation, and passing it is a runtime error the nested-create types do not catch. tsc accepted
   it.
9. **`@Optional()` again.** `AgentOperatorService`'s optional cost engine had the same omission
   that cancelled 41 run-engine tests at Prompt 40 — **twice in two prompts**. A type-level optional
   is not a DI-level optional, and nothing but a failing suite says so.

**A tenth finding, from the full suite rather than the new tests**: `GET /reward-awards/:id` was
gated on `objective:View`, so after CR-03 **a person could no longer see their own bonus**. The
declared permission was never the one doing the work — the row-level check was — and removing the
grant is what exposed that. Re-gated on `performance:View` (ADR-250, S-328). This is the argument
for running everything after an authorization change rather than only the suites that look related.

Three more fixture refusals were constraints doing their job:
`workflow_draft_has_at_least_one_node`, `mapped_assignment_names_its_agent` and the
`AiWorkAssignment` requirement to name who assigned it.

### Regression

The CR-03 authorization change broke **62 existing tests**, all legitimately: `agent-builder.e2e`,
`engine-agent.e2e`, `approvals.e2e` and `objectives.e2e` all drove Agent Builder *as an employee*,
which is the documented journey CR-03 supersedes. Each now grants builder access explicitly through
`grantBuilderAccess` — a new test helper that writes a `Custom` role, the existing mechanism — and
new tests assert a standard Employee is refused the same journey. **No assertion was weakened**: the
guard test that pinned the old rule now pins the new one with CR-03 cited in it, and
`objectives.e2e` gained a Power Employee so its `OwnWork` scoping coverage survived intact.

`authorization.e2e` needed its probe routes retargeted from `objective` onto `agents`: those tests
are about the *engine* — granted, lacked, expired, denied-by-rule — and `objective` was merely the
exemplar module an Employee happened to hold. The `objective` routes stay, because the custom-role
tests deliberately grant `objective` through a stored matrix and must keep exercising that path.

Then: authorization + builder **188/188**, objectives + approvals **133/133**, users & access
**54/54**, and the **full API suite** — required by the prompt, since CR-03 changes authorization
and RLS.

## Prompt 40A (CR-03), second pass — the user interface

The first pass built and tested every API and shipped **no UI at all**. This pass built the screens,
and building them found two defects the API tests could not have found.

### What the screens are

| Screen | Component | CR-03 |
| --- | --- | --- |
| Users & Access — row action and Invite | `AccessPermissionsStep` | §1 |
| Hierarchy — Add Employee, after the save | `AccessPermissionsStep` | §1 |
| Hierarchy list, employee profile, person picker | `EmployeePhoto` | §3 |
| Agent Builder — Import / Export and the import review | `JobMethodImportExport` | §4, §5 |
| Engine Agents — "Assigned to you" | `MyEngineAgents` | §5 |
| Workspace Chat | `app/chat/page.tsx` | §6 |
| Objective, Task, Engine Agent, Run, Approval, Exception | `DiscussButton` | §6 |
| Every company page's sidebar | `useCompanyNavigation` | §1, §6 |

### Frontend — 102 tests across 9 files

`MyEngineAgents.test.tsx` (13) — the four actions; a disabled Run printing the server's own
sentence; an agent that cannot run is still **listed**; View Result and History reading one list; a
run still in flight is not a result; Report Issue refusing a correction too short to act on;
"Correct" never offered as a way to report a problem; and a grep of the rendered body for prompts,
model names, keys and JSON.

`EmployeePhoto.test.tsx` (12) — initials before the server answers; **a photo awaiting its scan
renders exactly as no photo**, with no "pending" state anywhere; Upload / Replace / Remove appearing
only when they should; the photo's own content route rather than the generic download; and the
prefetch path that keeps a forty-person list to one request.

`AccessPermissionsStep.test.tsx` (10) — tiers and defaults from the server; a capability the
administrator cannot grant shown **disabled and explained** rather than hidden; grant and revoke
going through the server; the refusal rendered verbatim; the real grants behind the friendly words.

`JobMethodImportExport.test.tsx` (13) — a real file rather than JSON; Download working for somebody
who cannot upload, with the asymmetry explained; the review naming objective, work, person and step
count; all four problem kinds; the agent suggestion; and **no Test and no Activate anywhere in the
review**.

`DiscussButton.test.tsx` (11) — Direct for one colleague, Group for several; **a type and an id
attached, never a copy of the title**; the first message; the deep link to the one screen that owns
chat.

`chat-page.test.tsx` (13) — unread as a badge; the deep link from Discuss; an accessible context as a
link and a refused one as a stated reason with no trace of the real title; a deleted message keeping
its place; an unscanned attachment shown as attached and not openable; and a grep proving the screen
never says "is typing", "online now" or "Live".

`navigation-model.test.ts` (10, in `packages/ui`) — Objective Optimization and Agent Builder hidden
from a standard Employee and back the moment the grant arrives; Workspace Chat under Operations; an
empty group dropped; source order kept; and a granted module with no nav item conjuring nothing.

`overlays.test.tsx` gained 2 — typing a whole sentence into a modal field, and Escape still closing.

### API — 60 in the CR-03 suite, 48 in the run engine

`§8 — the routes, not only the services` (15 new) drives `MyAccessController`,
`AgentOperatorController` and `JobMethodController` inside a real request context. It covers
`/my-access` for a standard Employee; the absence of `objective` and `agent-builder` and their
return on a grant; run history refused to a stranger **with the same sentence an invented id gets**;
the redaction asserted on the *serialised* response, not the type; a real `.xlsx` (a zip, so `PK`)
under a filename naming the work; the declared spreadsheet content type; a download → upload round
trip; and an unopenable file **answered rather than thrown away**.

`§7 — two-tenant isolation` (7 new) — the capability grant lands in `roleAssignment`/`customRole`
(there is no capability table, because there is no second permission system) and is invisible to the
other company; the same person holds nothing there; the operator share, the photo and the run
history are all scoped; and a Job Method form is refused across companies.

`run-engine.e2e.spec.ts` gained 7 for the defect that prompted all of this: an unshared operator
refused, a shared one allowed, **`mayRun` and the route agreeing**, run history readable, the share
withdrawn stopping the run, `Pause` still refused, and the owner path unchanged.

### The two defects the screens found

**The operator's Run button was a lie.** `assertMayRun` had no caller; the run route decided from
ownership and answered 404 for exactly the person CR-03 exists to serve. Every test covering the
share asked the service. ADR-251, S-329.

**Every modal accepted one character per click.** `useFocusTrap` depended on `onClose`, which every
caller passes inline, so the effect re-ran each render and pulled focus back to the first control.
112 passing design-system tests missed it because none typed more than one character. ADR-257,
S-330.

### Visual verification

Nine screens, at 1440px and 400px, in a real browser with the API intercepted — 18 passes, no
console errors, no page scrolling sideways. Then the four states a page load cannot reach: the
Access & Permissions dialog, the import review, View Result / History / Report Issue, and Discuss.

It found six layout faults, all fixed: bullet markers on the chat message list and on the capability
list, context icons sitting on top of their titles, the operator section touching the banner above
it, "What this allows" rendering as a browser form button, a screenful between each import problem
group, and Agent Builder forcing a 400px viewport 534px wide (ADR-258).

### Totals

Web **102/102**, design system **114/114**, CR-03 suite **60/60**, run engine **48/48**, and the
**full API suite 2029/2029** — required again, because the run route's authorization changed.
Frontend build, typecheck and lint clean.

## Prompt 41 — Backups, restore and disaster recovery

### The pure layer — 32 tests in `packages/types/disaster-recovery.test.ts`

The distinction everything rests on: **configured, taken and verified are three different states**,
and `mayBeReliedOn` returns true for `Verified` alone. A test asserts `Taken` is not enough, which
is the assertion that stops a status page reporting green on a file nobody has ever read back.

Recovery targets give every tier both an RPO and an RTO with a reason, tighten as the tier rises,
and keep the two as different promises. `rpoStatus` reports **how far out** a stale backup is rather
than merely that it is, treats no verified backup as the worst case rather than as a missing
measurement, and refuses to report a negative age when the clock disagrees.

Verification gives **no partial credit**: it passes only when all six checks passed, refuses a
result that skipped one, and refuses one that ran the same check twice instead of six. The
environment allow-list refuses anything that is not scratch or staging.

The decision tree is asserted to never recommend restoring blind — every `restore` action in it goes
to scratch, to a point in time, or to a standby, or says *do not restore*.

And a test asserts the product **does not describe itself as disaster-recovery ready**, even after a
fresh verified restore.

### The reporting layer — 15 tests in `recovery.e2e.spec.ts`

`GET /platform/recovery` answers the only question that matters — *when did a restore last
succeed* — and `neverVerified` is true until one has. The service reports; it cannot take or restore
a backup, because the application holds no owner credentials (ADR-260).

### The drill itself — evidence, not a test

`infra/backup/evidence/uboss-20260912T042244Z.verification.json` is a **real run against a real
database**: 6 checks passed, 0 failed, state `Verified`, restore completed in 3 seconds. It records
104 RLS policies and 104 forced tables covering 103 tenant-scoped tables, an audit chain of 26
events every one of which hashed, and a restored database that accepted connections and answered.

**The drill found a defect in its own check.** `SchemaMatches` first failed against a migration row
that had been rolled back — the check was reading the latest row rather than the latest *applied*
row, and would have reported a healthy restore as a schema mismatch at 3am. It now excludes
`rolled_back_at IS NOT NULL`.

### A test that polluted the database for every later suite

`recovery.e2e` wrote a fake row into `_prisma_migrations` to exercise the drift check.
`resetTestDatabase` does **not** truncate that table, so the row survived into every subsequent
suite and broke `migrate deploy` with P3009. Fixed with `clearFakeMigrations` in both `beforeEach`
and `afterEach` — the second because a failing test must not leave the database worse than it found
it.

### Totals

Types **1062/1062** (32 of them this prompt), recovery **15/15**, and one real restore drill whose
evidence is in the repository rather than in a claim.

## Prompt 42 — the coverage audit

The prompt asks to audit the whole repository against this file and the source documents, add what
is missing, and **produce a coverage/gap report**. This is that report.

### Method, and what it is worth

Every test file in the four trees was read for its test titles, and each area the prompt names was
searched across them. That produced a first list of gaps which was then **checked by hand, one at a
time** — and most of it turned out to be the matcher rather than the repository. That correction is
recorded below rather than quietly dropped, because a coverage report that only lists what it found
is indistinguishable from one that looked in the wrong place.

Nobody should read the table below as "these areas are adequately tested". A pattern match proves a
subject is *addressed*; only reading the assertions proves it is covered. The areas this prompt
actually changed were read.

### The audit, area by area

| Area the prompt names | Verdict |
| --- | --- |
| Unit domain rules | Covered — 32 files in `packages/types`, 1062 assertions |
| Integration: DB, queue, provider, connection | Covered — every `*.e2e.spec.ts` runs against a real PostgreSQL under RLS |
| Integration: Redis | Covered, thinly — the queue selects BullMQ by `REDIS_URL` and the inline fallback is what runs in CI |
| API contract | Covered by route-level specs; **no OpenAPI document exists**, so there is nothing to contract-test against. See the gap list |
| E2E complete company journey | **Was missing. Added this prompt.** |
| Tenant isolation | Covered — 51 titles across 27 files, plus the new CR-03 §7 block |
| IDOR negatives | Covered under other words — 55 titles asserting a guessed id, a cross-company read or a 404-rather-than-403 |
| Auth / session | Covered — 43 titles |
| MFA | Covered — 8 titles |
| SSO | Covered — OIDC and SAML providers, SCIM |
| Strict Objective versioning | Covered — `objective-versioning.e2e` |
| Approve & Assign transaction | Covered — `approvals.e2e` and `assignment.e2e` |
| Engine Agent run state / retry / idempotency | Covered — 25 titles in `run-engine.e2e` |
| Executor exception / escalation | Covered — 40 titles |
| Credit concurrent reservation / top-up | Covered — 23 titles |
| Audit immutability | Covered — `audit-chain.spec` |
| **Prompt-injection / tool policy** | Tool policy covered (`knowledge.test.ts`). **Injection was not tested at all. Added this prompt.** |
| Memory scope isolation | Covered — 32 titles |
| Seat limits / company exit | Covered — 20 titles |
| AI decomposition / Skill routing | Covered — `objective-analysis.e2e`, `skill-router.e2e` |
| Login six-section presentation | Covered — `shells.test.tsx` asserts all six in order *and* the approved copy |
| **Auth back/forward routes** | **Was missing. Added this prompt.** |
| Workspace header identity | Covered — `shells.test.tsx` |
| Dashboard two-slice-only rule | Covered — `DonutDashboard.test.tsx` |
| Hierarchy Vision/Mission | Covered — `hierarchy.e2e` |
| Six mandatory Add Employee fields | Covered — `hierarchy.e2e`, and CR-03 asserts they did not change |
| Global UBoss person match / link / duplicates | Covered — `enterprise-identity.e2e` |
| Performance score / badge events | Covered — `performance-badges.e2e` |
| Cross-company lookup privacy | Covered — `profile-search.e2e` |
| Objective extra-work reward | Covered — `rewards.e2e`, 27 titles |
| TCSiON mapping matrix | **Correctly deferred.** The prompt says "once approved client definitions are supplied"; they have not been. `TcsionMappingService` exists and is unexercised by design |

### What was added

**Prompt injection — `apps/api/test/prompt-injection.spec.ts`, 9 tests.**

The finding behind it: UBoss has a *good* injection posture and **nothing tested it**. `ModelRequest`
separates `instruction` from `context`; every adapter puts the instruction in the provider's system
turn and the context in the user turn; every caller passes a literal instruction. That is the whole
defence, and it is the kind that costs nothing to break and whose breach is invisible until a cell
of somebody's spreadsheet is being obeyed.

The spec pins it three ways: a scan asserting no caller anywhere in the API builds an instruction
from data; the two provider shapes driven with `fetch` stubbed, asserting hostile context lands in
the user turn and nowhere near the system turn; and an assertion that neither adapter flattens the
two into one field.

**The scan was verified against a real violation.** An interpolated instruction was introduced into
`run-engine.service.ts`, the scan failed, and the source was restored — because a static test that
cannot fail is worse than no test, and this one had to be shown to bite.

There is deliberately **no filter and no denylist**. A test asserts hostile content reaches the
provider *verbatim*: redacting "ignore all previous instructions" from a genuine compliance document
would corrupt the work, and a filter is a defence that can be phrased around. The separation is the
defence; the content is evidence.

**The complete company journey — `run-engine.e2e.spec.ts`, 2 tests.**

Added to that suite rather than a new one, because it already wires the entire chain; a separate
spec would have duplicated six hundred lines of module setup to assert less.

It walks Objective → analysis → workflow → AI work assignment → Agent Builder → activation → share →
the employee running it over HTTP, and asserts the **hand-offs** rather than repeating each stage's
own suite: the assignment names its objective, the assignment names its agent, the operator's screen
carries the objective forward, and the run is attributed back to the objective. Those seams are
where an integration breaks without any single suite failing. The second test asks the only
cross-boundary question that matters — none of the arc landed in another company.

**Auth back/forward routes — `apps/web/src/app/auth-routes.test.ts`, 9 tests.**

`TEST_MATRIX` recorded the login rules as a **manual verification at Prompt 2**. A manual check is a
fact about one afternoon, and forty prompts later nothing had re-checked either rule. Now automated:
every auth route offers a way back to sign-in and forward to help, no auth route links to a signup
path, and the only mention of signup anywhere is the disclaimer denying it.

### One documentation defect, found and fixed

**Two different decisions were both numbered ADR-118** — the budget-evaluation one and the
`Run`-not-`Publish` activation one — and five documents cited "ADR-118" meaning one or the other.
Auditing is what surfaced it; a reader following any of those citations had a coin-flip chance of
landing on the wrong decision. The earlier entry keeps the number, the activation one became
ADR-270 with a note recording the collision, and the three citations that meant activation now
point at it.

### Gaps left open, deliberately

- **No OpenAPI document.** The prompt lists "API contract/OpenAPI". Routes are covered by their own
  specs, but there is no generated schema, so there is nothing for a contract test to diff against.
  Writing one is a build task rather than a test task and would be invented work here — recorded as
  a gap rather than papered over with a test that asserts the routes match a document this prompt
  would have had to write itself.
- **TCSiON mapping matrix.** Conditional on client definitions that have not been supplied.
- **PITR drill.** Named in Prompt 41's limitations and unchanged by this prompt.
- **Redis is exercised through the inline queue.** The BullMQ path is selected by `REDIS_URL` and a
  container runs locally, but no test asserts behaviour *specific to* the broker — a restart losing
  queue position, for instance. `REDIS_STANCE` says Redis is never authoritative, which is what
  makes this acceptable rather than urgent.

### Totals after this prompt

API **2047/2047** across 52 spec files, types **1062/1062**, design system **114/114**, web
**111/111**. No test was weakened to make anything pass; two assertions were **removed as wrong**
and both are explained where they were: the journey test asserted a builder-grant property that is
untrue of its own fixture and belongs to the CR-03 suite, and the auth test asserted the help page
links to itself.

## Prompt 43 — Performance and scale validation

### The pure layer — 25 tests in `packages/types/scale-validation.test.ts`

A benchmark whose arithmetic is wrong is worse than no benchmark: it produces confident numbers, and
somebody optimises the wrong thing. So the percentile function and the verdict rules are tested
without a database or a clock.

Percentiles are **nearest-rank**, so a p99 is an observation — a request that really took that long —
rather than a weighted average of the two slowest that appears in no request anybody made. No
samples returns null, never zero, because "nothing ran" and "everything was instant" must not look
alike.

Three verdict rules, each closing a way a benchmark lies: a failed attempt never contributes a
latency sample; **any** error fails the scenario whatever the latency was; and no samples reports
`NotMeasured` rather than `Pass`.

### The regression guard — `test/tenant-predicate.spec.ts`

Every read of an unbounded table names its tenant, or is one of four stated exceptions carrying its
reason as data — primary-key lookups, hash-chain reads, deliberate platform-plane sweeps, and a
spread base checked by reading the base.

It ends with a test that the scan **would notice a read that dropped the tenant**, because a scan
that cannot fail reads as coverage.

### The measurement — `infra/perf/evidence/`

Real runs against a purpose-built database of twenty companies, 5,000 employees and 1,000,000 audit
events. Every scenario the application actually makes is inside its budget and none sequentially
scans a table that grows without bound. Full results and method in `docs/PERFORMANCE.md`.

**The harness produced three false findings before a true one** — single-tenant seeding, and two
queries written by hand that did not match the repository. Each looked like a missing index. ADR-272.

### Regression

Naming the tenant in eight reads is behaviour-preserving by construction: RLS already confined them.
`objectives`, `objective-analysis`, `objective-versioning`, `assignment` and `workflow-editor` pass
**249/249** unchanged, and the full API suite was run because the change is cross-cutting.
