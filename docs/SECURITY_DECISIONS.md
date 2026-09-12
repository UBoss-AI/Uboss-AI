# Security Decisions

Security choices and their reasoning, recorded as they are made.

---

## In force

### S-001 — No secret ever lands in a tracked file

`.env.example` files at the root, `apps/api` and `apps/web` contain **placeholders only**.
`.gitignore` ignores `.env` and `.env.*` while re-including `*.example`, and also ignores `*.pem`,
`*.key` and `*.p12`. Variables that will hold secret material are named as _references_
(`SESSION_SECRET_REF=vault://…`, `AI_PROVIDER_KEY_REF=vault://…`) to make the intended indirection
obvious before the code exists.

**Locked rule:** no plaintext passwords or reusable provider credentials in normal UI or database
fields. From Prompt 5 onward, secret material resolves through KMS / Secrets Manager / Vault.

### S-002 — `NEXT_PUBLIC_` is a publication boundary

Anything prefixed `NEXT_PUBLIC_` is inlined into the client bundle. The `.env.example` files state
this explicitly so no future prompt places a secret behind that prefix. Only
`NEXT_PUBLIC_API_BASE_URL` uses it, and a base URL is not sensitive.

### S-003 — Security headers on by default

`helmet()` is installed in `apps/api` bootstrap at Prompt 1 rather than added later. Verified live:
`Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy`, `X-Frame-Options: SAMEORIGIN`.
`poweredByHeader: false` in `next.config.ts` and Nest's default `x-powered-by` suppression mean
neither app advertises its framework — confirmed absent in the running response.

### S-004 — Strict input validation before any DTO exists

The global `ValidationPipe` runs with `whitelist: true` and `forbidNonWhitelisted: true`. Unknown
body properties are **rejected**, not stripped silently. This is set up now, while there is nothing
to validate, so that no later endpoint can accidentally accept an unexpected field — in particular a
browser-supplied `tenant_id`, `role` or `permission`, which working rule E forbids trusting.

### S-005 — CORS is closed by default

`API_CORS_ORIGINS` is an explicit allow-list. When it is empty, `enableCors` is never called, so
cross-origin browser access is denied rather than defaulting to `*`. `credentials: true` is set only
alongside a concrete origin list, since wildcard-plus-credentials is invalid and unsafe.

### S-006 — The unauthenticated endpoint discloses nothing

`GET /health` is reachable without authentication, so its response is restricted to the five fields
in the shared contract. A test asserts the exact key set, which will fail if anyone later adds
tenant, actor, environment or configuration detail to it.

### S-007 — The UI prototype's demo credential must never be carried forward

The client's `index.html` contains a demo password literal (`UBossDemo@2026!`) prefilled into a
password input and printed in a `DEV`-gated quick-fill panel. It is labelled QA-only in the
prototype. When the real Login and activation screens are built (Prompt 5), that value must **not**
become a seeded credential, a prefilled input, or database content, and no password field may carry a
default value.

### S-008 — The prototype's authorization model is presentation only

`index.html` implements roles, a scope pill and a `ROUTE_GUARD` that blocks direct URL access — but
entirely client-side, with the session being an email swap in memory. It is a UI contract for what
users should _see_, never the enforcement mechanism. Every one of those checks is re-implemented
server-side against authenticated membership.

### S-009 — Aadhaar is a matching field, not an identity proof

Aadhaar Number is a mandatory Add Employee field used **only** for internal person matching. Aadhaar
OTP/authentication/verification is explicitly **not** implemented, and UBoss must never display or
imply verified Aadhaar status. The prototype stores only the last four digits; full-value handling,
masking and access restrictions are to be decided at the prompt that builds the employee record.
Cross-company profile lookup uses the **UBoss Unique ID**, never Aadhaar.

---

### S-010 — Prisma pulls two high-severity advisories into the runtime tree (accepted, with reasoning)

`npm audit` reports **4 high severity** findings after Prompt 3. Reported honestly rather than as
"0 vulnerabilities":

| Package              | Advisory                                                                          | Path                                                   |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `mysql2@3.15.3`      | Auth-plugin downgrade leaking plaintext credentials; unbounded zlib inflate (DoS) | `@prisma/client@7.10.0 → prisma@7.10.0 → mysql2`       |
| `deepmerge-ts@7.1.5` | Stack exhaustion on recursive object graphs                                       | `prisma@7.10.0 → @prisma/config@7.10.0 → deepmerge-ts` |

**Why they are in the runtime tree at all:** Prisma 7 made `@prisma/client` depend on the `prisma`
CLI package, so these are not dev-only even though the CLI is a build-time tool.

**Reachability assessment:**

- `mysql2` is **never loaded**. The datasource is PostgreSQL through `@prisma/adapter-pg`, and Node
  only loads a module when something imports it. Nothing in UBoss imports a MySQL connector, and
  both advisories require an active MySQL protocol connection.
- `deepmerge-ts` is used by `@prisma/config` when parsing `prisma.config.ts`, a file in this
  repository. The advisory needs a maliciously recursive config object; an attacker who can edit
  our build config already has code execution.

**Why not "fix" it:** `npm audit fix --force` installs `prisma@6.19.3` — a major downgrade that
mismatches `@prisma/client@7.10.0`. That is strictly worse than a pair of unreachable advisories.

**Why no `overrides`:** patched versions exist (`mysql2@3.24.4`, `deepmerge-ts@8.0.2`) and root
`overrides` were attempted, but npm 11 did not apply them — the resolved tree kept the pinned
versions even after regenerating the lockfile from scratch. Dead configuration was removed rather
than left in place implying protection it does not provide.

**Re-check trigger:** on every Prisma upgrade, re-run `npm audit` and re-test `overrides`. If
Prisma stops depending on the CLI at runtime, or bumps these transitives, this entry can be closed.

### S-011 — the seed contains no credentials, and the schema has nowhere to put one

The development seed creates a demo Platform Admin and a demo company with one member, and
**seeds no password, hash, invitation token or session**. Authentication does not exist until
Prompt 5, and when it does, credentials are set by the user during invitation activation.

This is structural, not just a convention: verified against `information_schema.columns`, the
schema contains **no column** matching `%password%`, `%secret%`, `%token%`, `%credential%` or
`%aadhaar%`. There is currently nowhere in the database to store a plaintext credential.

Demo identities use reserved example domains (`@uboss.example`, `@demo-company.example`) so they can
never collide with a real mailbox.

The client UI prototype's demo password (`UBossDemo@2026!`, see S-007) has **not** entered the
database and must not when Prompt 5 lands.

### S-012 — local database credentials are deliberately visible, and deliberately local-only

`infra/docker-compose.yml` and the `.env.example` files contain `uboss:uboss_local_dev`. These are
development-only credentials for a container bound to a local port, and treating them as secrets
would be theatre. They are documented as non-secrets so nobody is tempted to reuse them.

Every real environment injects `DATABASE_URL` from a secret manager; `.env` is gitignored, and
`schema.prisma` no longer contains a connection string at all (Prisma 7 moved it to
`prisma.config.ts`).

**Isolation note:** this repository's database is published on **5442** with its own compose project
and volume, because two unrelated UBoss-named stacks from other project directories already run on
5432 and 5433 on this machine. Pointing this repository at those would risk another project's data.

### S-013 — the health endpoint cannot leak connection details

`GET /health` is unauthenticated, and it now probes PostgreSQL, so its failure path had to be
checked rather than assumed. The dependency `reason` is reduced to a short summary — an error code
plus the most informative line, capped at 200 characters. Verified at runtime against an
unreachable database: the response was
`{"name":"postgres","status":"down","latencyMs":5,"reason":"ECONNREFUSED: PrismaClientKnownRequestError"}`
with no connection string, username or password present. A unit test asserts the response contains
neither `postgresql://` nor `password`.

The probe also has a 2-second timeout, so a hung database degrades the endpoint instead of hanging
it — a health check that never answers takes the load balancer down with it.

### S-014 — the audit trail is append-only by construction

`AuditEventRepository` exposes no update and no delete method, and `audit_events` has no
`updated_at` or `row_version` column. The absence is the enforcement.

`audit_events.actor_user_id` uses `ON DELETE SET NULL` rather than `CASCADE`, so deleting a person
cannot erase the record of what they did.

Audit rows are written inside the same transaction as the change they record, so the trail can
never claim something happened that was rolled back — proven by an integration test.

Retention and archival, when they arrive, will be an explicit administrative operation with its own
audit event, never a repository call.

---

### S-015 — Row-Level Security is a real second layer, and its limits are stated

RLS is enabled with `FORCE` on the tenant-owned tables, with `USING` and `WITH CHECK` policies,
and the application connects as `uboss_app` — a role with neither `SUPERUSER` nor `BYPASSRLS`,
because the owner role has both and policies would otherwise never have applied.

Verified directly in SQL as the application role:

| Situation                                                   | Result                             |
| ----------------------------------------------------------- | ---------------------------------- |
| No scope declared                                           | **0 rows** — fails closed          |
| Scoped to Tenant A, `SELECT` with no `WHERE`                | only Tenant A's row                |
| Scoped to Tenant A, selecting Tenant B's row by primary key | **0 rows**                         |
| Scoped to Tenant A, `INSERT` with Tenant B's `tenant_id`    | **rejected** by `WITH CHECK`       |
| Declared platform operation                                 | all rows, as provisioning requires |

**What it protects:** any path that declares a tenant scope — which is every guarded request. It
catches the realistic bug, a query that forgets `WHERE tenant_id = ...`.

**What it does not protect:** a path that declares `app.platform_operation = 'on'`. Those
legitimately cross tenants (provisioning, Master Console reads, membership verification) and their
correctness rests on the application layer. This is stated rather than glossed: RLS here is a
backstop for scoped sessions, not a universal guarantee.

**Future hardening, not yet done:** add a user-scoped policy so "which companies do I belong to"
can run without the platform escape hatch, which would shrink the number of call sites outside the
backstop.

### S-016 — the tenant guard denies by default

Every route is refused unless it carries `@AllowAnonymous`, `@PlatformOnly` or `@TenantScoped`. A
new controller is therefore private until someone consciously opens it, and a forgotten decorator
produces a 403 plus an explicit error log naming the route — not an accidentally public endpoint.
A test asserts an undecorated route is refused even for an authenticated caller.

`GET /health` is the only route marked public.

### S-017 — a requested workspace is a request, never a credential

A client selects a workspace via a route parameter or the `x-uboss-workspace` header. That value
is rejected unless it is a well-formed UUID, then used **only** to look up a membership for the
authenticated person. The membership row is what authorises; the submitted value never is.

Two disclosure decisions:

- **"Not your company" and "no such company" return the identical message**, so the endpoint
  cannot be used to discover which companies exist. A test asserts the two response bodies match.
- **A platform actor is refused inside a company workspace** without an explicit membership.
  Support impersonation would need its own audited design; silently granting the Master Console
  access to every tenant's data would not be it.

### S-018 — dev-only actor impersonation cannot be enabled by accident

The production default authenticates **nobody** (`AnonymousActorResolver`), so every
tenant-scoped route is denied until real authentication lands at Prompt 5. This is deliberately
not an "allow everything pending auth" stub, because that shape survives into production.

`DevHeaderActorResolver` requires `AUTH_DEV_HEADERS_ENABLED=true` **and** a non-production
`NODE_ENV`. If the flag is set while `NODE_ENV=production`, the process **refuses to start** —
verified at runtime: exit code 1 with
`AUTH_DEV_HEADERS_ENABLED=true is not permitted when NODE_ENV=production`. Also verified: with the
flag absent, production starts normally, logs no dev-resolver warning, and the header grants
nothing.

An unknown id in the header resolves to anonymous rather than erroring, so it cannot be used to
enumerate which UBoss Unique IDs exist.

### S-019 — correlation ids are sanitised untrusted input

Every response carries `x-correlation-id`. An inbound `x-correlation-id` or `x-request-id` is
honoured **only** if it matches `^[A-Za-z0-9._:-]{1,64}$`; anything else is replaced with a
generated UUID.

This matters because correlation ids are written to logs: a value containing newlines could forge
log lines, and an unbounded one would bloat every record for the request. Verified at runtime —
`bad value` (spaces) was replaced, `my-trace-001` was honoured.

Ids are assigned before guards run, so a **denied** request still has one to quote, and
concurrent requests get distinct ids (asserted by a test).

### S-020 — tenant lifecycle states gate workspace access

`tenants.lifecycle_state` is enforced by the guard on every tenant-scoped request:

| State               | Access  | Writes     |
| ------------------- | ------- | ---------- |
| `Provisioning`      | denied  | denied     |
| `PendingActivation` | denied  | denied     |
| `Active`            | allowed | allowed    |
| `ReadOnly`          | allowed | **denied** |
| `Suspended`         | denied  | denied     |
| `Closed`            | denied  | denied     |

Each blocked state returns its **own** message, because "still being provisioned" and "suspended"
need completely different actions from the reader.

Write detection treats only `GET`, `HEAD` and `OPTIONS` as safe — `POST` counts as a write even
when used for a read-shaped query, because guessing permissively would let a read-only company be
modified.

A newly provisioned company starts at `Provisioning`, so it is **not** usable until the Master
Console activates it; a test asserts this, and the seed performs the activation explicitly rather
than relying on a permissive default.

### S-021 — no plaintext password exists anywhere, and no admin path can read one

Passwords are stored only as Argon2id PHC strings in `user_credentials.password_hash`. There is
no endpoint, no service method, no admin screen and no log line that returns or accepts a password
for reading. A password reaches the server exactly twice in its life — once when it is set during
activation or reset, once per sign-in to be verified — and is never written anywhere but the hash.

Consequences that are deliberate rather than missing features:

- An administrator **cannot** set a person's password for them. They can cancel and reissue an
  invitation, or the person can use Access Help; both hand the recipient a one-time link that only
  the recipient can spend.
- A lost password is not recoverable, only replaceable. That is the point.
- The activation and reset screens carry **no** default value in any password field. The client's
  UI reference prefills a shared demo password (`UBossDemo@2026!`) in its login form; that is not
  carried forward — see UX_MAP defect 6.

Asserted by tests: only 64-hex hashes and PHC strings are present in the credential and token
tables, the reset response contains no token, and the audit trail contains no password, no token
and no attempted email address.

### S-022 — one-time tokens are stored as hashes and rotate on resend

Invitation, password-reset and session tokens are 32 CSPRNG bytes, base64url-encoded. Only a
SHA-256 hash is stored, so a database disclosure yields no working link (see ADR-026 for why a slow
KDF is the wrong tool for a high-entropy secret).

- **Returned once.** `POST /invitations` is the only place an activation token appears. A lost link
  is resent, never recovered.
- **Rotated on resend.** A resend replaces the hash, so two valid links for one invitation cannot
  coexist. Tested: the previous link is refused after a resend.
- **Single-use, enforced transactionally.** Activation uses a compare-and-set on `acceptedAt`;
  reset marks `usedAt` in the same transaction that writes the new hash. Replay is refused.
- **Never logged.** An activation token in a log file is a working credential. Log lines carry the
  invitation id only.
- **A rejected password does not spend the token.** The length policy is checked before the
  transaction opens, so a 400 rolls back and the link still works. Tested explicitly, because the
  opposite behaviour — a link burnt by a typo — would be a support burden with no security benefit.

### S-023 — session cookie flags, and the two expiry rules

`uboss_session` is `HttpOnly` (so no script can read it), `SameSite=Lax` (so a cross-site form
post cannot ride it, while ordinary top-level navigation still works), `Path=/`, and `Secure`
whenever `NODE_ENV=production` or `AUTH_SECURE_COOKIES=true`.

`Secure` is **not** hard-coded on: local development is plain HTTP, and a cookie the browser
refuses to send produces a login loop that gets "fixed" by someone disabling the flag everywhere.
Production cannot opt out — `secureCookies` is `isProduction || AUTH_SECURE_COOKIES === 'true'`.

Two rules, both server-side:

| Rule     | Default | Basis                                  |
| -------- | ------- | -------------------------------------- |
| Idle     | 30 min  | Time since `lastSeenAt`                |
| Absolute | 12 h    | Time since the session row was created |

Whichever fires first ends the session, and a client cannot extend either. The cookie's `Expires`
is set to the **absolute** expiry so the browser never holds a cookie the server would reject.
Both rules are asserted by tests that manipulate the stored timestamps directly.

### S-024 — failed-login throttling and lockout

`user_credentials.failed_attempts` and `locked_until` implement a per-identity lockout:
`AUTH_MAX_FAILED_ATTEMPTS` (5) consecutive failures lock the account for `AUTH_LOCKOUT_MINUTES`
(15). A successful sign-in resets the counter.

- The lockout response carries `Retry-After` in seconds, so the UI can say how long rather than
  guessing. Verified at runtime: `Retry-After: 900`.
- Lockout is **per identity, not per IP.** An IP-based limit is trivially defeated by a botnet and
  punishes shared networks; the account-level limit is what actually protects the account. Request-
  rate limiting arrives at Prompt 21 and is the complementary control, not a replacement.
- Password reset is separately capped at 5 requests per hour per identity, so the reset endpoint
  cannot be used to flood someone's inbox.

**Stated limitation.** A per-identity lockout can be used to deny service to a known account by
deliberately failing five sign-ins. That is accepted for now: the alternative — no lockout —
leaves the account open to guessing, and the mitigation (progressive delays plus IP reputation)
belongs with the rate-limiting work at Prompt 21.

### S-025 — a session list is not a location history

`sessions.client_hint` stores a truncated network prefix — a /16 for IPv4, a /48 for IPv6 — never
a full client address. `device_label` is a coarse pair such as "Chrome on Windows", derived from
the user-agent.

That is deliberately the _least_ information that still lets someone look at their own session
list and recognise "that was not me". A full address and precise user-agent per session would be a
per-person movement log sitting in the application database, available to anyone with read access,
and useful to an attacker who got that far.

New-device detection keys on the **network hint**, not the user-agent: a UA string changes on every
browser update and is trivially forged, so alerting on it would train people to ignore the alert.

### S-026 — SSO and MFA are interfaces with no implementation, on purpose

`enterprise-identity.interfaces.ts` declares `AuthenticationMethod`, `SecondFactorProvider`,
`AuthenticationPolicy`, `EnterpriseIdentityProvider` and `DomainVerification`. Nothing implements
them, nothing calls them, and no code path branches on them.

They exist so that Prompt 6 does not have to reshape the session model, and so that the shape of
the extension point is reviewable now. `EnterpriseIdentityProvider` deliberately requires
`terminateProviderSession`: a federated sign-out that ends only the local session is a security
bug, and making the method mandatory means an implementation cannot forget it.

The login screen's "Continue with enterprise SSO" button is rendered **disabled**, not hidden and
not wired to a stub. The UI reference has it navigate straight into the app; carrying that forward
would be a button that appears to authenticate and does not.

### S-027 — audit failure cannot break sign-out

`SecurityEventPublisher.record()` runs as a platform operation and swallows its own failures,
logging them at `error`. A failure writing the trail must not stop someone signing out or
completing a password reset — the security action matters more than its record, and a caller who
cannot log out because of a database hiccup is worse off than one whose logout went unrecorded.

The trail itself remains append-only by construction (S-014), and the action vocabulary is a
closed set, so a typo produces a compile error rather than an unqueryable row.

**Redaction is key-based but value-typed.** Metadata keys matching `password|token|secret|
credential` are redacted — but only when the value is a **string**. An earlier version redacted by
key alone and turned `{ setPassword: true }` into `{ setPassword: "[redacted]" }`, destroying a
useful boolean while protecting nothing. Both forms are visible in the dev database's history,
which is how the fix was confirmed.

### S-028 — three secrets are encrypted at rest; everything else stays hashed

`user_credentials.password_hash` (Argon2id) and every one-time token (SHA-256) remain one-way and
unreadable by anyone. Three values cannot be, because the server has to **use** them rather than
compare them:

| Value              | Column                                       | Why it cannot be hashed                  |
| ------------------ | -------------------------------------------- | ---------------------------------------- |
| TOTP shared secret | `mfa_factors.secret_ciphertext`              | Verification recomputes the code from it |
| OIDC client secret | `sso_connections.client_secret_ciphertext`   | Sent to the provider's token endpoint    |
| PKCE code verifier | `sso_auth_requests.code_verifier_ciphertext` | Replayed verbatim in the token exchange  |

All three are AES-256-GCM with a key from `AUTH_ENCRYPTION_KEYS`, held **outside** the database.
That reduces the threat from "read the database" to "read the database _and_ obtain the process's
key material". Envelope: `v1.<keyId>.<iv>.<tag>.<ciphertext>`, base64url — the key id makes
rotation possible (first key seals, retired keys still open), and dropping a retired key too early
fails loudly naming the missing key rather than producing unreadable rows.

**Purpose binding.** The purpose string is AES-GCM additional authenticated data, so a ciphertext
sealed as `mfa.totp_secret` **fails to open** as `sso.client_secret`. Without it, a database writer
could move a value between columns and have it accepted somewhere it grants more. Tested.

**Stated limitation.** The key is an environment variable, not a managed KMS key. That is the
honest state: "we encrypt secrets at rest" is not the same claim as "the key is managed".
`EncryptionKeyProvider` is the seam a KMS/Vault implementation replaces at Prompt 20, and nothing
downstream depends on where the key came from. The process refuses to start without a valid key,
so a deployment cannot silently run with MFA broken.

### S-029 — no enterprise secret is ever returned after the request that created it

- **OIDC client secret** — accepted on create/update, encrypted immediately, and never returned.
  Connection responses carry `hasClientSecret: true|false` so a screen can say whether one is
  configured without seeing it. Rotation is recorded in the audit trail as a **boolean**.
- **SCIM bearer token** — returned once at creation, stored as SHA-256. A lost token is replaced,
  never recovered.
- **TOTP secret and `otpauth://` URI** — returned once, over the authenticated request that asked
  for them. `GET /auth/mfa/factors` never includes the secret in any form, sealed or otherwise.
- **Recovery codes** — shown once. Only hashes are stored, so "show me my codes again" is
  impossible by construction rather than by policy. The UI says so instead of leaving someone
  hunting for the button.

Each of these has a test that serialises the response (and, separately, the stored row) and asserts
the plaintext does not appear.

### S-030 — MFA recovery codes carry 100 bits of entropy, which is what makes SHA-256 correct

A recovery code bypasses MFA, so it is exactly as powerful as the factor it replaces. It is stored
as a SHA-256 hash, and that is only defensible because the code itself is unguessable: 20
characters of a 32-symbol alphabet is 2^100. A test asserts `32 ** 20 === 2 ** 100`, so shortening
the code forces a re-read of this reasoning.

Argon2id was considered and rejected here for a specific reason: verification would have to try
each of the person's stored codes in turn, so ten codes would mean ten Argon2 verifications.
Instead, lookup is a single indexed probe on the hash. The trade is a longer code to type, which is
the right way round — recovery codes are typed once, in an emergency, from a printout.

Crockford's base32 omits I, L, O and U, and normalisation maps what people actually type (`I`,
`l`, `O`) onto what was meant, so a transcription slip is not a lockout.

### S-031 — an unfinished MFA sign-in is not a session

A correct password at an MFA-required company produces an `MfaChallenge` and a five-minute
`uboss_mfa` cookie. **No session cookie is set** — a test asserts its absence explicitly.

`SameSite=Strict` on that cookie, stricter than the session cookie's `Lax`: nothing legitimately
navigates to the second-factor step from another site, so there is no case to accommodate.

Failed second factors increment the **same** `user_credentials.failed_attempts` counter as a failed
password, and five failures against one challenge destroy it. Without that, the second factor would
be the cheap thing to brute-force: six digits is a million possibilities, and an attacker holding
the password would otherwise have unlimited attempts at the part meant to stop them.

**Replay protection.** `mfa_factors.last_used_counter` records the highest accepted TOTP step, and
a code at or below it is refused — so an intercepted code cannot be used again even inside its own
30-second window. The guard is the _write_, not the check: `WHERE last_used_counter < ?` means two
requests presenting the same code concurrently cannot both pass. A visible consequence, verified by
test: the code used to complete enrolment cannot then be used to sign in.

One message for a wrong TOTP code and a wrong recovery code — a response that distinguished them
would confirm which kind of credential the caller is holding. Asserted by comparing the two bodies.

### S-032 — ID token verification refuses `alg: none` and every HMAC variant

`src/auth/sso/jwt.ts` accepts RS256/384/512, PS256/384/512 and ES256/384/512. It refuses `none`
and `HS*`, and the refusal is **published** in `GET /tenants/:id/identity/sso-setup` so a company
finds out before configuring one.

HMAC is refused even though OIDC permits it: with HMAC the verification key _is_ the client secret,
so anyone holding it — including our own database, if it leaked — could mint valid ID tokens.
Asymmetric signing keeps that power with the identity provider.

Three structural properties, each tested against a real RSA-signed test provider:

- the algorithm allow-list is a module constant, so `none` cannot be reached;
- candidate keys are filtered by the key type recorded in the **JWKS**, never by the token's own
  header — which is what makes algorithm confusion impossible;
- `iss`, `aud`, `azp`, `exp`, `iat` and `nonce` are checked unconditionally, not on opt-in.

The signature is verified **before** any claim is read, so a forged token never reaches the claim
logic. Tests cover `alg: none`, wrong audience, wrong nonce, missing nonce, expired, and an
unpublished `kid`.

### S-033 — SAML is declared and refused, not half-built

The connection model, its columns and service-provider metadata all exist. Assertion consumption
throws, and a SAML connection **cannot be enabled** — refused at the API, so no login screen can
offer a button that cannot work.

The reason is specific rather than a matter of time: SAML's security rests on XML Digital
Signature, where a plausible implementation is reliably exploitable — XML Signature Wrapping (a
valid signature over a fragment that is not the assertion actually read), canonicalisation
mismatches (the 2018 `NameID` comment-truncation bug that hit several libraries at once), and XXE
against an unauthenticated endpoint that accepts attacker-supplied XML. Shipping that without the
review it needs would mean an authentication path that appears to federate and can be forged. See
ADR-035 for what implementing it will require.

### S-034 — federation authenticates; it never provisions

An OIDC assertion signs in a person who **already has an `Active` membership** in that company.
Refused otherwise, with one identical message for "unknown address", "domain not verified" and "not
a member" — an unauthenticated endpoint must not explain which.

Just-in-time provisioning is deliberately absent. It is the industry default and it contradicts a
locked rule: with JIT, anyone the identity provider will authenticate becomes a UBoss user, which
turns the IdP's directory into a signup form. A test asserts that an assertion for a stranger at a
verified domain creates **no** user row.

Matching is by email and requires the domain to be **verified** for that company, which is what
stops a compromised or careless provider asserting `someone@another-company.com` and being
believed.

**Three defences bind the callback**, none redundant: `state` (proves the callback belongs to a
request we started — stored hashed, since it travels in a URL), `nonce` (proves the _ID token_
belongs to that request — also stored hashed, compared by hash), and the PKCE verifier (proves the
_code_ is redeemed by the client that asked for it). The authorization request is consumed
atomically with its lookup, so a replayed callback finds nothing; tested.

**The callback cannot become an open redirect.** Only a path on the configured web origin is
honoured; anything else falls back to the login screen. An open redirect on an authentication
endpoint is the most useful kind to a phisher, because the link genuinely starts at our domain.

**SSRF posture.** The discovery URL is administrator-configured, and `jwks_uri` and
`token_endpoint` are required to share the issuer's origin — so a discovery document cannot
redirect key fetches, or the client secret, elsewhere. All outbound calls carry a 5-second timeout.

### S-035 — SSO session termination works in both directions

- **Provider-initiated (back-channel).** `POST /auth/sso/:connectionId/backchannel-logout` verifies
  the `logout_token` against the provider's signing keys exactly like an ID token, then revokes
  every local session carrying that `sid`. Unauthenticated by necessity — the provider calls it
  server-to-server — so verification is the whole control: a tampered token is refused and the
  session survives, tested. An **ID token presented as a logout token is refused**, because the
  spec forbids a `nonce` there precisely to prevent that substitution.
- **UBoss-initiated.** `SsoService.providerLogoutUrl` returns the provider's `end_session_endpoint`
  when it publishes one, and `undefined` otherwise — the caller then has to say plainly that only
  the UBoss session ended. Claiming a full sign-out we did not perform is exactly the failure
  `terminateProviderSession` was made mandatory to prevent. The ID token is **not** retained for
  `id_token_hint`: keeping a live bearer credential for the life of a session to make logout
  tidier is a bad trade.
- **Configuration change.** Disabling or deleting a connection revokes every session it issued — a
  federated session whose federation has been switched off can never be re-validated. Both tested.

### S-036 — domain verification is DNS-based, exclusive, and grants no access

A company proves control by publishing `_uboss-verification.<domain> TXT
uboss-domain-verification=<token>`. DNS proves control of the zone; an email challenge to
`admin@domain` proves control of one mailbox, which a departing employee or a compromised alias
can also have.

The token is unguessable, so one company cannot publish another's expected value and pre-empt it.
Any number of companies may hold a **pending** claim — otherwise the first company to type a
domain could block its real owner — but only one may ever hold a **verified** claim, enforced by a
partial unique index in the database rather than an application check, so two simultaneous
verifications cannot both win.

**It creates no membership.** If verifying `example.com` auto-provisioned every `@example.com`
address that signed in, domain verification would be public company signup wearing a DNS record.
A test asserts the membership count is unchanged after verification.

Removing a claim is recorded as **suspicious** activity, because it widens who this company will
believe an assertion about — a security-relevant loosening, not housekeeping.

Input is restricted to a bare domain: schemes, paths, ports, wildcards, userinfo and underscores
are refused, since each is a way to write something that looks like a domain and would produce a
DNS name we never intended to query. A public-suffix check (refusing a claim on `co.uk`) needs a
suffix list that has to be kept current and is deferred to Prompt 21 — stated rather than implied.

### S-037 — SCIM provisioning is gated on a verified domain, and deprovisioning is immediate

A SCIM request may only provision an address whose domain the calling company has **verified**.
SCIM adds a person to a company _without that person doing anything_; control of the domain is the
proof that makes that legitimate. Contractors on other domains are invited instead, which is the
flow that asks for their consent.

**The credential is the scope.** No SCIM path or body carries a tenant id — the tenant comes from
the bearer token alone, so there is nothing for a caller to tamper with. A test asserts that a
token for one company gets 404 for another company's user id, on both read and delete, and that the
other company's addresses do not appear in a list.

**Deprovisioning revokes every session in the same operation.** `active: false` → `Suspended`,
`DELETE` → `Offboarded`, both with immediate session revocation. A test signs in, deprovisions, and
asserts the next request is 401 — because deprovisioning that leaves a live session means a
departed employee keeps working for up to twelve hours after their employer said to remove them.

Rows are **suspended, not deleted**: an identity provider that briefly loses sight of a person
would otherwise destroy the record of their employment.

**Unsupported operations are refused, never ignored.** An unsupported `PATCH` path returns 400 —
silently ignoring a deprovisioning PATCH would leave a departed employee with access while the
connector reported success. An unsupported filter is likewise refused, because answering it as "no
filter" would return every user and the connector would read that as "this address does not exist"
and create a duplicate. Both tested.

One answer for a missing and an unknown bearer token, so a caller cannot probe which tokens exist.

### S-038 — sign-in-method discovery is keyed on the domain, never on the address

`GET /auth/sign-in-methods?email=…` answers from the email's **domain**, not from whether the
address has an account. The obvious implementation — look the person up, return their companies'
policy — would make this an account-enumeration oracle: an address at an SSO-only company would
answer differently from one with no account, and an unauthenticated caller could sift a list of
addresses for which ones exist.

Keying on the domain answers a question about _configuration_: it reveals only "a company has
verified this domain and requires SSO", which is already visible to anyone who tries to sign in.
Whether a specific address exists stays unknowable. A test asserts that a real member and a
non-existent address at the same domain give **byte-identical** answers, and that an unclaimed
domain looks exactly like an ordinary password-only company.

The response carries connection names and ids only — never an issuer, client id or discovery URL.

### S-039 — policy is evaluated across every company, and cannot lock a company out of itself

The strictest requirement across all of a person's companies applies, because a UBoss session is
person-level and can switch workspaces without re-authenticating (ADR-033). Evaluating only the
workspace being entered would be a bypass: a password-only session from a permissive company would
then open the MFA-mandating one.

Two write-time invariants, both about self-lockout:

- **Requiring SSO needs an enabled connection**, or every member — including the administrator who
  set it — is redirected to a provider that does not exist. Refused with 400; tested.
- **Requiring SSO disables password sign-in**, as the meaning of the setting rather than a side
  effect.

**MFA cannot become a lockout.** `mfaGraceUntil` lets a company impose MFA without instantly
locking out the un-enrolled, and independently of it, someone with a correct password and no factor
may **enrol against their challenge** and complete that sign-in. So the worst case is "you must set
this up now", never "ask your administrator". Both paths tested, including that an _expired_ grace
period stops being honoured.

Removing the last factor is refused while any of the person's companies requires MFA, with a
message telling them to enrol a replacement first — actionable, unlike discovering it at the next
sign-in.

### S-040 — the authorization engine denies by default at every dimension

Five dimensions, and each one fails closed on its own:

| Dimension             | With nothing configured                                       |
| --------------------- | ------------------------------------------------------------- |
| **User type**         | Ceilings apply first and no role can lift them                |
| **Role**              | No assignment → **nothing**, not "own work". Tested           |
| **Scope**             | An empty selected-resource or department list grants nothing  |
| **Module visibility** | A module no assignment names is not visible                   |
| **Actions**           | An action no role grants is refused, whatever the policy says |

A membership with no role assignment can do nothing at all — the refusal names it ("You have no
role in this company yet"), so the state is diagnosable rather than mysterious. An unrecognised
module or action in a stored custom-role matrix is **dropped** by `sanitisePermissionSet` rather
than treated as a wildcard, so a renamed module becomes no grant instead of an unenforceable one.

### S-041 — the precedence rule is implemented literally, including "mandatory"

`Platform → Company → Department → Objective → Engine Agent`. Any layer may tighten; a **mandatory**
higher control cannot be lifted by any lower one, and an attempted override is recorded in the
decision trace rather than silently ignored.

Tested from every lower layer against a mandatory Platform control, and against a mandatory
Department control from the two layers below it. A **mandatory `Allow`** is refused by the service
_and_ by a database check constraint, because a grant that lower layers cannot tighten is the one
thing the rule forbids.

**Scope only narrows.** A layer requesting a wider scope is ignored and the ignoring is traced —
tested with an Engine Agent layer trying to award itself `WholeCompany` from `OwnWork`.

### S-042 — three privilege-escalation gates on granting authority

1. **An assignment cannot exceed its role's `maxScope`** — refused by the API _and_ capped again by
   the engine at read time, so a row written by any other path still cannot over-grant.
2. **A custom role cannot grant what its creator does not have** — otherwise "can create custom
   roles" is equivalent to "can do anything".
3. **Nobody can grant themselves a role** — refused outright, because it is the shortest path from
   "can manage access" to "can do anything".

Plus: a role cannot be assigned to a non-member or to an offboarded person, a department scope with
no department is refused, and an expiry in the past is refused.

Every grant and revocation is recorded as **suspicious activity** with the subject, role, scope and
whether a justification was written — because "who granted this person Company Admin, when, and
why" is the first question of an access review, and an assignment row alone answers only the first
two.

### S-043 — separation of duties has no bypass, and the Executor Agent cannot satisfy it

The platform baseline is **seeded by the migration**, mandatory, and applies `NoSelfApproval` to
`Approve` in every company — so a company that never opens a settings screen still cannot
self-approve. No Company, Department, Objective or Engine Agent layer can lift it.

Keyed on the **creator**, not the owner: work is reassigned routinely, and keying on the owner
would let a reassignment launder a self-approval. Tested.

`checkSeparationOfDuties` has no `force`, `override` or `systemActor` parameter, and an automated
actor **can never** satisfy a four-eyes control — two agents are not four eyes. That is the locked
rule (the Executor Agent must never silently bypass or replace a required Human approval) expressed
as code rather than as documentation, and there are two tests asserting it, one of them at the
request layer.

A blocked self-approval is recorded as suspicious activity whether or not it was a mistake: an
attempted self-approval is exactly the pattern an audit wants to find.

### S-044 — the decision trace is platform-only

Every denial names the dimension that blocked it, and the message is safe to show the person
refused ("Your role does not include Approve on this"). The **trace** — the full layer-by-layer
reasoning — is returned by exactly one endpoint, `POST .../authorization/evaluate`, which is
platform-only.

That asymmetry is deliberate: the trace describes a company's own policy configuration, and a
caller who has just been refused has no business reading it. A test asserts a 403 body contains
neither `trace` nor `decidedBy`.

The internal permission test page exists because a five-dimension, five-layer engine is close to
undebuggable otherwise. It is not linked from any navigation and is reached by typing the URL.

### S-045 — user-type ceilings cannot be lifted by any role

An **External Guest** may never `Approve`, `Publish`, `Run`, `Schedule`, `Pause`, `Export`,
`ManageAccess`, `Administer` or `Audit` — each either commits the company to something or reveals
its internals, and a guest is by definition outside the company's accountability chain. Tested by
giving a guest every action, every module and `WholeCompany` scope and asserting each one is still
refused.

A **Platform User** may not `Approve`, `Assign`, `Publish`, `Run`, `Schedule` or `Pause` inside a
company. `TenantGuard` already refuses a platform actor without a membership; the ceiling says the
same thing inside the engine so the rule is visible in one place.

`userType` lives on `tenant_memberships`, not on `users` — the same human can be an internal
employee at one company and an external guest at another, so it is a property of the relationship.
Changing it is recorded as suspicious in both directions: promoting a guest widens everything their
role reaches, and demoting an internal person is how an account is quietly neutered.

### S-046 — Row-Level Security covers the authorization tables

`custom_roles`, `role_assignments`, `policy_rules`, `separation_of_duties_policies` and
`tcsion_mappings` all have RLS enabled and **forced**, with the same fail-closed policy as
Prompt 4. This is the last place a missing `WHERE tenant_id` should be survivable: a
`role_assignments` row _is_ somebody's authority, so a leak here is not a data disclosure but a
permission disclosure — or, on a write, a permission grant.

`policy_rules` and `separation_of_duties_policies` have a **nullable** `tenant_id`, because a
Platform-layer rule legitimately belongs to no company. Those rows are visible only during a
declared platform operation, exactly as `audit_events` already handles platform-plane rows.

A test issues a raw `SELECT COUNT(*) FROM role_assignments` with no scope declared and asserts
**zero**.

### S-047 — the TCSiON mapping invents nothing, and fails closed when unmapped

No seeded mapping, no default, no example row. The external fields are free text holding the
client's approved vocabulary verbatim; constraining them to an enum would mean guessing, which the
client explicitly forbade. The UBoss side is validated strictly, so a transcription error is
refused at load time naming the wrong value rather than surfacing at a sign-in.

`approvedReference` is **mandatory** on every row: the point of the table is that its contents are
traceable to an approved client document rather than to an assumption, and a blank reference is
refused.

An unmapped external type resolves to `null`, records a `tcsion_mapping_missing` security event
carrying the external type, and produces a message naming the missing mapping. It does **not**
default to Employee — a silent default is how an external user ends up with permissions nobody
chose. Tested, including that the refusal message does not mention a role.

The mapping's `allowedActions` is an **intersection** with the role's permissions, never a union.
Tested directly: a ceiling naming `Approve` on a role that lacks it produces no `Approve`.

### S-048 — `TeamSubtree` scope is refused, not guessed

The reporting hierarchy arrives at Prompt 12, so `TeamSubtree` returns a distinct
`scope-unevaluable` denial rather than a default. Allowing it would silently make every Manager's
scope the whole company; denying it as `out-of-scope` would look like a policy decision rather than
a missing capability.

The practical consequence is stated rather than hidden: a `Manager` assignment grants nothing at
the row level today. `Department` and `MultipleDepartments` do work, because a department is an
opaque id on both the assignment and the resource and needs no tree.

---

### S-049 — the audit trail is append-only in the database, not by convention

Prompt 5 made `audit_events` append-only by writing no update or delete method. True, and a
property of the **code**. Prompt 8 makes it a property of the **data**, with four controls:

1. `REVOKE UPDATE, DELETE` from `uboss_app`, the role the API connects as. A compromised
   application cannot rewrite history at all — it fails with `permission denied`.
2. A `BEFORE UPDATE OR DELETE` trigger, which binds every role including the **owner** — the
   role migrations and seeds run as, which a `REVOKE` cannot reach.
3. A `BEFORE TRUNCATE` statement trigger, because row-level triggers do not see `TRUNCATE`.
   Without it, the two strongest-looking controls above would both stay intact while somebody
   erased the entire trail.
4. Per-chain SHA-256 hashing, which **detects** what the first three cannot prevent.

One consequence worth knowing: a hard `DELETE FROM tenants` now **fails**, because the cascade
would remove that tenant's audit rows. That is the intended reading — closing a company must not
erase what it did — and nothing in the application hard-deletes a tenant.

The exact guarantee, and the superuser attack it does **not** stop, is written out in ADR-046 and
returned at runtime by the verify endpoint. It is not summarised here, because a security guarantee
paraphrased in two places drifts in one of them.

The `TRUNCATE` trigger yields to one session variable, `uboss.allow_history_truncate`, which the
integration harness sets with `SET LOCAL` for the duration of its reset — so the permission dies
with the transaction and cannot leak onto a pooled connection. Nothing in `src/` sets it, and a
test asserts its absence from the audit source files rather than trusting that.

### S-050 — a company sees its own trail; the platform plane is a different controller

`security_events` has a nullable `tenant_id`, because a failed sign-in happens before any
workspace is chosen and belongs to no company. Those tenant-less rows are reachable **only**
through `/platform/security`, a separate `@PlatformOnly` controller, and only inside a declared
platform operation.

A separate controller rather than a flag on the tenant one: a flag is a parameter, and a parameter
is something a request can set. The tenant route fixes `tenantId` from the verified scope, so there
is no filter value that widens it. Row-Level Security is forced on the table as the second layer,
so even a mistaken query returns nothing.

The `ValidationPipe` runs with `forbidNonWhitelisted`, which matters more here than elsewhere: a
mistyped filter field that was silently ignored would return a **wider** result set than asked for,
and on an audit export "wider than asked for" is a disclosure rather than a bug. `action` and
`actionPrefix` together are refused for the same reason — they filter the same column, so one
would silently win.

### S-051 — reading the audit trail is authorized, scoped, and itself audited

`{ module: "settings", action: "Audit" }` to read; `Audit` **and** `Export` to export; whole-company
scope required or the read is **refused** rather than over-returned. Full reasoning in ADR-047.

Every export writes a security event naming who took the copy. A trail that records every change
to a company but not who read it has a blind spot exactly where a curious insider operates.
Ordinary paged reads are deliberately not audited — auditing every page of a screen that scrolls
the trail would drown the thing it is reading.

Export is capped at 5,000 rows per call. Not for memory: an unbounded export is the most efficient
way for one compromised auditor account to take a company's entire operational history in a single
request. With a cursor, a genuine full export is a sequence of calls, each separately audited.

### S-052 — break-glass cannot be walked through by one person

Six endpoints, seven states, and a second person required at both the identity-verification and
the approval step. Enforced in the service **and** by four database check constraints, so a future
code path that skipped the service still could not store a self-approved, unverified or endless
grant. The full table of constraints and the failure each prevents is in ADR-048.

Three properties worth calling out here:

- **`Administer` and `ManageAccess` cannot be granted by break-glass at all.** They are the actions
  that change who else has access, so a time-limited grant containing one could be used to create a
  permanent grant before the window closes — which would make the expiry decorative.
- **Expiry is evaluated on every read**, not by a scheduled sweep. A sweep running every minute
  leaves a minute of access nobody authorised.
- **The audit row lands in the customer's own trail.** The company can see that somebody broke
  glass into it. Recording it only platform-side would make transparency a platform choice.

Customer notification is a tracked obligation with four states. `Pending` is a visible debt rather
than a silent default, and `Suppressed` requires a written reason — checked in the service and by a
check constraint — because suppression is both legitimate and exactly how an obligation gets
quietly dropped.

### S-053 — metadata redaction guards both trails, and only redacts strings

One list, applied to both trails: keys matching password, passphrase, secret, token, credential,
authorization, cookie, aadhaar or private key have their **string** values replaced with
`[redacted]`.

Only strings. A boolean or a number cannot be a secret, and blanking them destroys useful detail
for nothing — an early version turned `{ setPassword: true }` into
`{ setPassword: "[redacted]" }`, which told an investigator nothing at all. The key pattern alone
is too blunt a test; the key _and_ a string value together are what indicate a risk.

This is defence in depth, not the primary control — the call sites are. It exists because an audit
row is now genuinely permanent: with S-049 in force, a secret written into metadata by mistake
**cannot** be removed by fixing the caller afterwards. That asymmetry is why the check is code
rather than a review convention. The enterprise-identity suite's "contains no secret of any kind"
test now searches both trails, because searching only the old one would have quietly stopped
covering the table the identity events actually land in.

---

### S-054 — the platform-plane tables have no Row-Level Security, deliberately

Five of the six Prompt 9 tables — `plans`, `feature_flags`, `platform_settings`,
`service_alerts` and `platform_role_assignments` — have **no RLS policy**. They also have no
`tenant_id`, which is the reason: RLS isolates rows by tenant, and there is no tenant to isolate
them by.

The two alternatives were both worse than nothing. A policy keyed on `app.current_tenant_id`
evaluates false for every row and makes the Master Console unable to read its own tables. A policy
keyed on `app.platform_operation` alone says "allow if you declared you are allowed" — it would
appear in a schema dump as a control and stop nobody, which is worse than an honest absence.

What protects them: every Master Console controller is `@PlatformOnly`; the platform-role guards
decide which module a platform actor may touch (S-055); and `platform_role_assignments` carries
two check constraints of its own, because a row in it _is_ somebody's platform authority — no
self-granted row, and a revocation must name who revoked it.

`tenant_subscriptions` is the exception and does get RLS, forced and fail-closed. A company's
plan, seats and billing state are commercially sensitive: a leak would tell one customer what
another is paying, and it is the one table here a company will eventually read about itself.
Verified in raw SQL — with no scope declared it returns zero rows.

### S-055 — platform access stops being one boolean

Until Prompt 9, `isPlatformActor` was the whole of platform authorization, and `platformContext`
granted any platform actor all fifteen platform modules with `Administer` on nearly all of them. A
permission decorator on a Master Console route therefore could not refuse anybody who got past
`@PlatformOnly`.

Six roles now exist as code, assignments live in a table, and `platformContext` **fails closed**:
no assignment, no permissions, and every module refuses. Full reasoning in ADR-049. The properties
worth stating as security decisions:

- **Only `PlatformOwner` may grant a platform role.** Behind `platform-settings:Administer` rather
  than a permission of its own, so that no Platform Admin can appoint an Owner and make the
  distinction between the two decorative.
- **Nobody grants themselves a platform role.** Enforced in the service and by a check constraint.
  It matters more here than on the company side: a company admin self-granting affects one
  company, a platform role affects every company at once.
- **Granting a role does not create platform staff.** A company person cannot be given a platform
  role; promoting somebody to platform staff is a separate decision with a separate path.
  Conflating them would let "grant a support role" quietly mean "create platform access".
- **The platform cannot be locked out of itself.** Revoking the last live `PlatformOwner` is
  refused, because Owner is the only role that can grant roles — removing it would leave a running
  platform with nobody able to appoint anybody and no way back through the product. The same
  reasoning as S-039 on the company side, and it records a `Critical` security event when it
  fires.
- **Expiry is evaluated on read**, never by a sweep. A role that expired a minute ago and still
  works is authority nobody granted.
- **A revoked assignment is kept, not deleted.** Who _used_ to hold platform authority is the
  first question an access review asks.

**Open question for the client.** The client named one platform role ("Platform Admin"). The other
five are a UBoss-side decomposition of the client's own navigation grouping, and a real support
organisation will have opinions about them. Every role is a strict subset of the approved platform
ceiling, so no vocabulary was invented — but the _boundaries_ are a proposal.

### S-056 — the console shows where every number came from

Each dashboard panel carries `measured`, `configured` or `demo`, and the screen renders it.
Reasoning in ADR-051; the security point is narrow and worth stating on its own: an operations
console that presents seeded data identically to measured data trains its operator to trust both
equally, and the first time that matters is an incident.

The one panel that is **entirely measured** is Security attention — critical security events,
active break-glass grants, outstanding customer notifications — because it reads the Prompt 8
append-only, hash-chained trails. Those figures cannot have been quietly edited, which is a
stronger claim than any commercial panel here can make.

Two consequences accepted rather than papered over: the reference's KPI deltas ("+3 this month")
are absent because there is no history to compute them from, and the reference's health KPIs
(uptime, p95, run success, queue depth) are **named and left empty** rather than filled with
plausible values. A health screen showing an uptime figure no probe measured is the most dangerous
fake data in an operations console.

### S-057 — locked platform settings are shown and refused

Two settings record client-stated **product rules** rather than preferences, and the API refuses
to change either:

- `governance.company_creation` — a company is created from the Master Console. There is no public
  company signup, and nothing in the product provides one.
- `governance.aadhaar_handling` — Aadhaar is entered for internal person matching only. UBoss
  performs no Aadhaar authentication and claims no verified Aadhaar status.

They are **displayed** so an operator can confirm the constraint is in force, and refused on write
so a click cannot change a requirement. Hiding them would leave the rule unverifiable; showing
them with a working control would make a client constraint editable. The reference itself renders
"Master Console only (no public signup)" as a fixed value, which is the same instinct.

Every change to an _unlocked_ global setting requires a reason and records a `Critical` security
event — a global default has the widest blast radius a single change can have.

### S-058 — Create Company has no provisioning endpoint at all

The client asked for the Create Company **entry** and no wizard until the next prompt.
`create-company/prerequisites` is a `GET`; there is no `POST` anywhere behind that screen, and a
test asserts the 404.

The absence is deliberate and specific: `TenantProvisioningService` already works, so a `POST`
would be a few lines — and the reference prototype has exactly that shortcut on this screen ("Skip
to review & provision"). Shipping it would create a working provisioning path that skips plan
selection, entitlements, budget and security, and that path would then be the one everybody used.
See ADR-052.

The same reasoning removed two buttons from Company Detail. "Impersonate (audited)" is break-glass
by another name and break-glass already exists properly (ADR-048); a one-click button beside a
company would route around identity verification, the second approver, the bounded scope, the
expiry and the customer notification. "Suspend tenant" needs a reason, a confirmation and a
notification path. Both are listed on the screen as unbuilt.

---

### S-059 — there is no public company signup, and the enforcement is an absence

A company comes into existence through exactly one path: `POST /platform/provisioning/companies`,
which is `@PlatformOnly` **and** requires `create-company:Create` — held by `PlatformOwner` and
`PlatformAdmin` only. Platform Support is platform staff and deliberately cannot provision:
creating a customer is a commercial act, not a support one.

The rule is enforced by there being no alternative rather than by a check that could be bypassed.
A test asserts that the four shapes somebody would reach for — `/companies`, `/signup`,
`/tenants`, `/provisioning/companies` — all fail to create anything.

### S-060 — the activation path never involves a password, and the wizard cannot carry one

The initial administrator receives a one-time hashed activation token through the Prompt 5
invitation flow. Provisioning creates **no credential row at all** — a test asserts that too —
because the password is set by the administrator during activation, and a password provisioning
created would be one UBoss knew.

Three layers keep it that way:

- **No password field exists** on any wizard step or in the DTO. `forbidNonWhitelisted` means a
  payload containing `adminPassword` is a 400 rather than a silently-ignored field.
- **The token is never returned.** It exists once, inside the transaction, and is deliberately
  dropped. A provisioning response containing it would put a credential in a platform operator's
  browser history.
- **The outbox carries the invitation id, not the token** (ADR-055).

The response says "No password was created" in words, so a client does not look for a token that
is deliberately absent and conclude something failed.

### S-061 — the AI budget guardrails are ordered, and the order is enforced

Four thresholds: warn at a percentage, require human approval above an amount, refuse above
another. A check constraint requires `approval_threshold <= hard_stop`.

Without it, an approval threshold above the hard stop would make the approval step **unreachable**
— the run would already be blocked — and the "approval threshold" would be decorative
configuration. That is precisely the kind of setting an operator configures once and then trusts
for a year, which is why it is a constraint and not a comment.

The client requires these to exist _before_ any AI work starts, so they are collected at
provisioning rather than left to a later settings visit. The Executor Agent raises the exception
when a spend crosses the approval threshold; it may never approve it itself.

### S-062 — a domain claimed at provisioning is not a domain verified

Wizard step 8 accepts a primary domain and creates a `DomainVerification` row in `Pending` with
a fresh token and a 14-day expiry. It is **not** verified, and grants nothing.

Provisioning cannot check DNS inside a database transaction, and a claim that silently counted as
verified would let whoever provisions a company assert ownership of any domain — including one
belonging to somebody else. The Prompt 6 rule is unchanged: a domain grants nothing until its TXT
record is observed.

### S-063 — a company cannot set its own contracted ceiling, and the enforcement is the absence of a route

The company-facing commercial group is read-and-request only: `GET position`, `GET seats`,
`GET/POST requests`, `POST requests/:id/withdraw`. There is **no** company-side endpoint that
writes `seats_licensed`, an entitlement, an allowance or a release channel — not a guarded one, not
a hidden one. A test issues `PUT` against both company-facing paths and asserts neither returns 200.

A ceiling a company could set for itself would not be a contract. Making the _absence_ the control
means there is no permission to misconfigure: `settings:Administer` lets a Company Admin _ask_,
and asking commits the company to a conversation rather than to a number.

Viewing needs only `settings:View`, which every company role holds. That is deliberate in the
other direction — a manager who cannot see how many seats remain will invite somebody into a
refusal, and hiding a number nobody can change protects nothing.

### S-064 — the requester can never decide their own commercial request, and the record of the refusal survives the refusal

Enforced three times over: `CommercialService.decideChange` refuses when
`requestedByUserId === actorUserId`, the `commercial_request_is_not_self_decided` check constraint
makes the row unstorable, and `companies:Administer` — the permission the decide route requires —
is held only by Platform Owner and Platform Admin, so a Commercial role can define plans and
cannot decide which customer is on one.

**The refusal is recorded in its own transaction.** The first implementation wrote the
`commercialSelfDecisionBlocked` security event inside the transaction it was about to abort with a
`ForbiddenException`, so the refusal correctly blocked the action and left **no trace at all**.
This is the same bug as the Prompt 8 break-glass self-approval, and it recurred despite being
documented — which is why it is now written down as a pattern rather than as an incident: any
"record why this was refused, then throw" path must record outside the aborting transaction. A
failure in the recording is swallowed and logged, because turning a correct 403 into a 500 would
tell the caller they hit a bug rather than a control.

### S-065 — a lifecycle change requires a reason, and `Closed` is terminal through this route

`ALLOWED_LIFECYCLE_TRANSITIONS` is a closed adjacency table with `Closed: []`. Reopening a closed
company by flipping a column would restore access to data whose retention decision has already
been made, and would do it without any of the checks a re-provisioning applies — so it is refused
with an explanation rather than being merely unusual.

A **reason is mandatory** in code and by check constraint. A suspension with no recorded reason is
the one a customer disputes and nobody can account for six months later.

**A scheduled transition is not an applied one.** A future-dated transition is recorded and the
company keeps its current state until the date arrives; every screen says so explicitly rather
than displaying the future state. Showing a company as suspended before it is would be a false
statement about a customer's access.

**Nothing is deleted by any state change**, including closure — recorded as `nothingDeleted: true`
in the audit metadata, in the company's own trail, so the customer can see it too.

### S-066 — Aadhaar is an entered-only match input, and the number is never stored

The client's rule, unchanged: in this flow an Aadhaar number is entered for **internal person
matching only**. There is no OTP, no authentication against any authority, and no verification.

What UBoss keeps is a keyed HMAC-SHA-256 blind index and the **last four digits**. The number
itself is written nowhere — not encrypted, not in a log, not in audit metadata. Four
reinforcements, each independent of the others:

1. **A check constraint.** `match_hash` must be 64 lower-case hex characters, so a twelve-digit
   number written into that column is rejected by PostgreSQL. Verified by attempting it.
2. **A four-character column.** `last_four` is `VARCHAR(4)` with a digits-only constraint.
3. **No `Verified` state exists.** `IdentifierAssurance` is `EnteredOnly | NotVerified`. No row can
   claim verification, so no API response and no screen can. `psql` rejects `'Verified'`.
4. **A test that greps for it.** After adding an employee, a query searches
   `person_identifiers`, `audit_events`, `security_events`, `users` and `employment_records` for
   the number and asserts **zero** occurrences.

**Aadhaar is never the UBoss Unique ID.** `ubossUniqueId` is generated independently of any
personal identifier, and a test asserts it does not even contain the last four digits.
**Cross-company profile search keys on the UBoss Unique ID**, never on Aadhaar.

**Why the index is keyed rather than a plain hash.** A bare SHA-256 of twelve digits is
enumerable — 10^12 candidates is minutes of GPU time — so a plain hash would let anybody who read
the column recover every number in it. See ADR-063 for the derivation and for the residual
weakness a deterministic index necessarily has.

### S-067 — a matching company learns that a person exists, and nothing about where they work

Match-or-create tells the entering company that one UBoss identity already exists and gives them
its permanent id. It does **not** disclose the person's other employers, their other employment
records, or who entered the identifier before.

That boundary is the difference between a portable professional identity and a background-check
service. It is enforced by shape rather than by discipline: the repository method returns a
**decision** — `{ userId, ubossUniqueId, displayName }` — rather than rows, and a test asserts the
result object has exactly five keys and that its serialised form mentions no company or
employment.

Disclosing that a person is _on the platform_ is inherent to the client's requirement ("existing
match links same UBoss Unique ID") and cannot be avoided while that requirement stands.

### S-068 — the masked identifier is withheld from colleagues, by omission

The org chart is company-wide: an employee seeing the structure of the company they work for is
normal, and the approved reference renders every department to every role that has the screen.

The **entered identifier is not**. Four digits of a colleague's Aadhaar is not directory
information, so `aadhaarMasked` is sent only to somebody who can `hierarchy:Administer`, plus each
person for themselves.

**Withheld by omitting the field, not by nulling it.** A `null` would render as "no identifier on
record", which is a different and false statement. The response also carries an explicit
`identifiersVisible` flag so the screen states what it was given rather than inferring it.

### S-069 — a reporting manager cannot be somebody from another company

Enforced by a **composite foreign key** on `(tenant_id, reporting_manager_user_id)` (ADR-064), so
it holds against a raw `UPDATE` as well as against the service. A cross-tenant reporting line
would be a tenant-isolation breach reachable through the org chart, and every `TeamSubtree`
authorization decision downstream would silently span the boundary.

The same mechanism refuses a department whose parent is in another company, and an employment
record pointing at another company's department.

### S-070 — the reporting tree cannot contain a cycle, and the reason is now an availability one

A database trigger with a bounded upward walk refuses any reporting-manager change that would
close a loop, whatever wrote it. The service refuses it first with an explanation and records a
`Blocked` security event **in its own transaction**, so the refusal survives the exception that
caused it.

This stopped being only a data-quality control at Prompt 12: **`TeamSubtree` authorization runs a
recursive query over this tree on permission decisions**. A cycle would make that query run to its
depth cap on every check — a denial of service on authorization, introduced by one bad update. An
invariant that load-bearing does not belong only in application code.

### S-071 — adding somebody to the hierarchy does not give them access

An employee added from the hierarchy gets a `NotInvited` membership: known to the company, **no
credential, no invitation, no session**. The client's rule is that the invitation source is
Settings → Users & Access and a hierarchy node must not carry the primary Invite button.

The enforcement is an **absence**: there is no invite route in the organization group at all, and
a test asserts two plausible paths do not exist. The API response carries `invitationSent: false`
so the screen can say so rather than leaving the reader to assume.

### S-072 — an invitation cannot create a second identity for the same person

The client's rule: _if employee already exists in hierarchy, invitation links to same stable user
identity; no duplicate._

Prompt 5's `invite()` is keyed on **email**, and Prompt 12 creates people with a synthesised
`<uboss-id>@person.uboss.invalid` address, because somebody in the org chart may have no work
address yet. An email-keyed invitation would therefore have created a **second** UBoss identity
for the same human — and a person's UBoss Unique ID is the key to their portable professional
history, so a duplicate splits their record permanently.

`inviteExistingPerson` is keyed on the **userId** and sets their real address on the way through.
That is the only shape that cannot duplicate, and a test counts `users` before and after and
asserts the count is unchanged.

### S-073 — an account cannot activate into a company where it can reach nothing

Department, reporting manager and at least one role are required before activation (ADR-065),
checked at the invitation **and** at activation. The window between them is real: a role can be
revoked after the email goes out, and an invitation link is valid for hours.

Without the second check, a person could activate into a company where they have no placement and
no permissions. That account can sign in, which makes it look like a working account to its holder
and to the administrator who sent the invitation — and it reaches nothing. Refusing is more
useful than a working sign-in to an empty product.

### S-074 — inviting somebody consumes a seat, and the ceiling holds

Moving a membership to `InvitePending` is what the default counting rule counts, so **inviting** —
not adding to the org chart — is the act that consumes a seat. That path now goes through
`SeatService.claimSeat` under its per-tenant advisory lock (ADR-060).

Before this prompt the enforcement existed and the path that needed it did not call it, recorded
as limitation 5g. A bulk invite of 400 people against a 5-seat contract now fails **per row** at
the ceiling rather than the file overshooting it wholesale, which a test asserts.

### S-075 — a guest has an expiry, stays outside the hierarchy, and gets no new permission path

A guest is a membership with a **mandatory** access expiry, no employment record, and a
resource-scoped role assignment that expires with their access (ADR-066).

- **The expiry is mandatory in both directions** — a guest must have one and nobody else may —
  enforced by a check constraint. An optional expiry is one somebody forgets; a guest account
  still open two years after the project finished is the failure this prevents.
- **Guests stay outside the hierarchy**, enforced by triggers firing from _both_ sides: an
  employment record cannot be created for a guest, and an employed person cannot be converted
  to one. A guest in the org chart would count toward a department's headcount and be
  selectable as somebody's reporting manager.
- **The ceiling is the Prompt 7 one**, unchanged: `ExternalGuest` is forbidden Approve,
  Publish, Run, Schedule, Pause, ManageAccess, Administer, Audit and Export whatever role they
  are given. So a guest can never let anybody else in, and no second permission system exists
  to disagree with the first.
- **Access must name resources.** An empty list is refused: it would mean company-wide access,
  and "whatever they need" is not a scope anybody can review.
- **Capped at 365 days.** A longer grant is indistinguishable from a standing one.

### S-076 — suspension and offboarding remove authority, never history

Suspension is reversible and touches nothing but the account state: roles, employment record and
every audit event stay exactly as they were.

Offboarding keeps the membership row, the employment record (state `Ended` with a date), every
audit event and the person's **UBoss Unique ID** — which is theirs, not the company's. What it
removes is **authority**: role assignments are revoked, because a role is permission to act and
somebody who has left must not hold one.

**Roles are revoked, not transferred.** Copying a departing person's grants onto their successor
would silently widen the successor's authority — the escalation the Prompt 7 granting gates exist
to prevent, happening without anybody choosing it. The successor inherits work, not permissions.

**Any outstanding invitation is cancelled**: a live activation link for somebody who has left is a
working way into the company.

**Neither can be done to oneself.** A company must not be lockable-out by one person acting alone,
and an administrator cannot remove themselves.

### S-077 — a bulk operation cannot escalate, cannot bypass a seat ceiling, and cannot reach another company

A bulk import is the most attractive route to privilege escalation in any admin console: one file,
hundreds of rows, and nobody reads row 214. Five controls, none of them a check that could be
forgotten:

1. **Permission per operation kind**, from `BULK_PERMISSIONS`. Uploading a file is not a
   permission; a bulk role change needs `roles:ManageAccess`, a bulk move needs
   `hierarchy:Administer`.
2. **No bulk-only write path.** Every row calls the same service a single-record change calls, as
   the same actor, so every gate that applies to one person applies to four hundred.
3. **Bulk role and scope changes are refused at apply time**, with the reason, rather than routed
   around `RoleAdministrationService`'s three escalation gates (ADR-040). Validated, so the
   operator sees what would happen; not applied, because the alternative is the one place in the
   product where authority is handed out unchecked.
4. **Seat claims per row.** The 401st invitation against a 400-seat contract fails as an
   individual row.
5. **Cross-tenant references are impossible**, not merely checked: the composite foreign keys
   (ADR-064) refuse a department or a manager from another company, and the validator refuses a
   subject who is not in this one.

An escalation attempt records a **`Critical`** `security.bulk_escalation_blocked` event of its
own, because "somebody tried to grant themselves something through a spreadsheet" is exactly the
event an access review needs to find.

**Only the person who validated an operation may apply it.** Not a permission question — a
responsibility one: the rows were checked against their authority, so applying them as somebody
else would apply a plan nobody reviewed.

### S-078 — the backend enforces every setting permission, per setting

The client's rule, verbatim: _Backend enforces every setting permission._ So each setting carries
its own read and write permission in the catalogue, and the service checks the **setting's**
permission rather than one blanket check for the screen.

Four consequences, each of which is a test:

- A setting the caller may not read is **not in the response at all**, and the count of
  withheld categories is — so a screen shows a shorter list rather than an empty section that
  reads as a bug.
- `editable` is the server's answer **per setting**. A screen may disable a control on it; the
  write path checks again regardless.
- A payload mixing a setting the caller may change with one they may not is **refused whole**,
  naming the key. Applying the permitted half is a change nobody asked for; dropping the other
  half silently tells them it worked.
- The **history** needs `settings:Audit`, not `settings:View`. Reading who changed a governance
  setting and why is an audit question — an Employee may read some settings and may not read
  that.

### S-079 — authorization is never through hidden navigation

`GET /settings/categories` returns the **full 19-category architecture to any caller** who can
reach the screen, and a write is refused all the same. The sidebar a given person sees is
narrower, and that narrowing is a _presentation_ consequence of the per-setting read check — never
the enforcement.

This is the client's rule stated as a property that can be tested rather than a principle: a test
asks for the category list as an ordinary Employee, gets all nineteen, and then has a write
refused. If hiding were the enforcement, the second half would succeed.

### S-080 — an unknown setting key is refused rather than stored

The catalogue is closed. A key that is not in `SETTING_DEFINITIONS` is a **400**, and the database
additionally refuses anything that is not catalogue-shaped (`category.setting_name`, lower case)
and anything that is not a JSON scalar.

Storing an unknown key would create a value nothing ever reads — a setting that appears to work
and does not, which is worse than an error. It is also the shape a stale or hostile client would
send.

### S-081 — a governance change requires a reason and cannot be rewritten by the application

A **material** setting requires a reason, enforced in the service and by a `NOT BLANK` constraint,
and its previous value is kept.

`company_setting_changes` has `UPDATE` and `DELETE` **revoked from the application role**, so no
code path in UBoss can rewrite the history. That is deliberately a weaker claim than the Prompt 8
audit trails: there is **no hash chain**, so tampering by somebody with database-owner access
would not be _detectable_. The claim made is exactly "the application cannot rewrite it", it is
written next to the `REVOKE` in the migration, and a test proves it by attempting an `UPDATE` as
the application role.

### S-082 — the performance ledger cannot be rewritten by the application

`REVOKE UPDATE, DELETE ON performance_events FROM uboss_app`. The score is derived from these rows,
so altering one silently restates somebody's performance history — and a performance record is
evidence in a review, a promotion decision and, eventually, a dispute.

The claim is precisely **"the application cannot rewrite it"**, not "tampering is detectable":
there is no hash chain here, unlike the Prompt 8 trails. A superuser with database access can still
alter a row. Stating the weaker guarantee is the point — an overstated one is worse than none,
because somebody would rely on it.

A correction is a new `ManualAdjustment` event carrying a reason, which the database also enforces.

### S-083 — points for delivered work cannot be typed in

`POST /performance/events` accepts only `ManualAdjustment` and `BlockerNeutralised`. The four
derived outcomes — on time and accepted, late, missed, rejected — are recorded by the modules that
own the work, through the service rather than the HTTP surface.

A route that accepted `OnTimeAccepted` would let anybody with `performance:Administer` mint points
for work that never existed, and audit does not fix that: the entire value of the ledger is that
every row points at real work. A test posts a derived kind over HTTP and asserts both the refusal
**and** that no event was written.

### S-084 — a performance record is company-specific and frozen on exit

Every event carries `employment_record_id`, and the whole feature is under forced RLS, so the same
person employed by two companies has two independent records and neither company can see the
other's. Offboarding writes a final `badge_history` row with `is_exit_snapshot`, closing every open
period.

Without the snapshot the history would keep re-deriving against a policy that changes **after** the
person has left, so the level they are recorded as having held could move years later. The snapshot
also means a later employer, reading a portable profile (Prompt 37A), sees a figure that cannot
drift — and it is read-only to them.

The history is **never transferred to a successor.** Offboarding hands over work, not standing:
crediting a successor with somebody else's performance would corrupt both records.

### S-085 — `performance:Administer` is one role, and not the manager's

Only `CompanyAdmin` carries it. A department `Head` or a `Manager` can read their team's scores and
cannot version the company policy or adjust a report's standing directly.

A manager unilaterally forgiving their own report's missed deadline, or quietly raising the
thresholds their team is measured against, is the conflict of interest this separation exists to
prevent. A manager's exception reaches the ledger through the approvals path, which decides it on
its own authority — the same shape as every other high-risk action in the system.

### S-086 — a mandatory alert cannot be muted, and three layers say so

The client's rule is that mandatory security and critical alerts cannot be muted. It is enforced
in three places on purpose, because it is a security property rather than a preference:

1. **`isMandatoryNotification` in `@uboss/types`** — one function, asked by the engine when
   deciding delivery **and** by the preference screen when deciding what to disable. Two
   implementations would eventually disagree, and the one that mattered would be the engine's, so
   the screen would be offering a control that does nothing.
2. **The engine ignores the preference** for anything critical, and for every `SecurityEvent`
   whatever its severity — including the digest, because "your account was accessed from a new
   country, in Friday's summary" is not a reasonable reading of a digest preference. The result
   reports `preferenceOverridden` so a caller can tell.
3. **The database refuses the state.** `security_notifications_cannot_be_muted` rejects a
   `SecurityEvent` preference that is off on either channel or set to a digest;
   `mandatory_notification_is_marked_mandatory` rejects a critical notification whose own row does
   not say it is mandatory and needs acknowledgement.

`is_mandatory` is **stored** rather than derived at read time, so a later change to the mandatory
set cannot retroactively make an alert that was delivered as mandatory look optional.

### S-087 — reading a critical alert does not clear it

`requires_acknowledgement` is separate from `read_at`, and `POST /notifications/read-all` states
in its own response that acknowledgements are untouched. The bell carries two numbers for the same
reason: an unread count of zero can still mean somebody must act.

A person who scrolled past an alert has not seen it. Treating a page view as an acknowledgement
would make the acknowledgement record worthless, which matters because it is exactly what an
incident review asks about — and acknowledgement is audited, while read state is not.

### S-088 — a notification cannot be deleted, and cannot point off-site

`REVOKE DELETE ON notifications FROM uboss_app`: nobody can make a delivered critical alert
disappear. `UPDATE` is necessarily permitted — read, acknowledge and escalate all write to the row
— so the claim is precisely **"the application cannot delete a notification"**, not "the record is
tamper-evident". What must not be rewritable is the _fact_ an alert was raised, and the audit
trail carries that separately.

`notification_deep_link_is_a_relative_path` requires the link to start with `/`. A notification is
a message a person is primed to click, so an absolute URL in one would be a stored redirect
vector; a workspace-relative path cannot leave the application, and it survives a domain change.

### S-089 — an escalation chain cannot cross a company boundary

`notifications_tenant_id_id_key` plus a composite foreign key on
`(tenant_id, escalated_from_id)`, declared in the Prisma schema (ADR-064). A single-column key on
`escalated_from_id` alone would have permitted an escalation whose parent was another company's
notification — and the chain is followed when showing "this was escalated from", so the breach
would have surfaced in the UI.

The escalation sweeper resolves the manager through `findEmploymentForPlatform(tenantId, userId)`,
which uses the tenant in its `where` clause even though it runs unscoped — so a platform-plane job
still reads exactly one company's reporting line.

### S-090 — the outbox payload carries no address and no message

The Prompt 10 rule was "never a token or a credential". Prompt 15 extends the reasoning: an email
address is not a credential, but an outbox row is long-lived, widely readable working state, and
personal data sitting somewhere nobody is thinking about is how leaks happen. The payload is a
notification id; the dispatcher reads the address and the body at delivery time, one query.

The dispatcher also **refuses to send to the `.invalid` placeholder** Prompt 12 gives somebody
added by identifier with no work address. A mail to an invalid domain is a bounce nobody sees; a
dead-lettered row saying "no address" is findable.

### S-091 — a security event notifies the person it happened to, and only within a company

The Prompt 8 `onSuspiciousActivity` seam — built for this and stating so in its own comment — now
has a subscriber. It notifies `subjectUserId ?? actorUserId`, and skips the event entirely when
there is **no tenant**.

That skip is deliberate. A platform-plane security event (a failed sign-in before a workspace was
chosen) belongs to the platform's security plane (ADR-045); putting one in a company's
notification list would leak the fact that somebody tried an account there. The event is still on
the security trail, which is where a cross-tenant event lives.

The handler contract is synchronous and must not block, so the bridge starts the work and does not
await it, and a failure is logged rather than propagated: a notification that could not be raised
must not turn a refused sign-in into a 500.

### S-092 — points and budget alerts go to somebody who can act, not to everybody

A budget threshold notifies every **active** `CompanyAdmin`, resolved by role kind rather than by
effective-permission lookup (the sweep runs platform-plane with no request context). Not the
employee whose agent run crossed the threshold — buying more allowance is not their decision — and
not somebody who has been offboarded.

A company with **no** active Company Admin is counted in the outcome rather than skipped silently:
an alert with nobody to receive it is itself a finding.

### S-093 — a credential never leaves the vault except to a connector

`secret` exists in three places and no others: a request DTO, `SecretsVault.put`/`rotate`, and the
`ConnectorContext` handed to an adapter at the moment of use. **No route returns one**, no response
type has a field for one, and a test serialises the entire connections response and asserts the
credential string does not appear in it.

The structural half is that the sealed value lives in `connection_secrets`, a table no screen, no
list and no affected-agent query touches — so the grant surface for reading a credential is one
method rather than "anything that can read a connection". The adapter is given the value and no
access to the vault, so it cannot read a credential for a connection nobody asked it about.

`connection_secret_ref_is_not_a_secret` refuses a handle beginning `v1.`: whatever else the handle
is, it is not a `SecretBox` envelope somebody pasted into the wrong column.

### S-094 — the handle is random, not derived

`cs_` plus 24 random bytes. Derived from the connection id it would leak the association across
the boundary the vault interface exists to hide. Derived from the value it would be a **probe**:
anybody who could guess a credential could confirm it by looking for its handle. Two connections
holding the same credential get different handles, and a test asserts it.

### S-095 — Agent Tool Permission cannot be satisfied by a person

The client's rule, enforced four ways (ADR-078): two vocabularies, two tables, one function that
takes an `agentId` and not a user id, and a unit test asserting the two action lists share no
member.

The danger is specific: `Administer` is in the human vocabulary, so a merged list would mean that
granting somebody administration of the Integrations module silently granted every agent the
ability to _administer_ a connected ERP. Nobody would have chosen it, and nothing would have said
so.

`mayAgentUse` also requires the connection to be `Connected`. A grant on an expired credential is
permission that would fail at the provider — and failing at the boundary instead is what prevents
a half-completed external action, which is the failure mode that cannot be rolled back.

### S-096 — a high-risk tool grant cannot exist without a reason

`Delete`, `ExternalBulkSend`, `SensitiveExport`, `FinancialChange`, `ProductionChange` — the
client's four plus `Delete`, which they name first. Refused by the service **and** by
`high_risk_tool_grant_has_a_reason`.

These grants let an automated agent take an irreversible action in a live external system with no
person present at the time. An unexplained one is precisely the grant somebody will be asked to
justify, and `permissionKind: 'AgentToolPermission'` in the audit metadata makes the trail say
which kind of permission it was.

A revocation is equally attributed — `tool_grant_revocation_is_attributed` requires an actor and a
reason — and `DELETE` is revoked on the table, so "who could do this in March" stays answerable.

### S-097 — a personal credential is never handed to anybody

A `User` connection cannot be transferred (ADR-081), an administrator cannot rotate or reauthorize
one, and offboarding **disables** it with the reason on the row rather than moving it. The
credential is that person's own account.

The other half: a person's own personal connection needs only `settings:View`, because connecting
your own account grants nobody else anything. Requiring `Administer` made the type unreachable by
the people it exists for — caught by this prompt's own tests, and fixed in the product rather than
in the test.

### S-098 — the check history cannot be rewritten

`REVOKE UPDATE, DELETE ON connection_checks`. "It has been failing since Tuesday" is the only
question this history exists to answer, and a rewritable one cannot answer it. The claim is
exactly "the application cannot alter it", not "tampering is detectable".

The adapter's message is truncated in the adapter **and** in the service before storage: an
adapter is the layer most likely to be handed a provider error containing something it should not
repeat.

### S-099 — the mock connector fails by default

An unrecognised credential fails. A mock that succeeded for any input would make every test of
`Error`, `NeedsReauthorization`, `Expired` and the missing-credential path meaningless — and those
paths are the entire governance layer this prompt builds.

It also means a mistyped credential behaves the way a real provider would: refused, with a message
that says what was expected.

### S-100 — nothing claims an integration that does not exist

The catalogue lists **only** the two mocks, each flagged `isMock: true`. `SecretsVault.describe()`
reports `isExternalProvider: false` and that reaches the screen. Every dispatch and every audit
event carries what the adapter actually is.

Both are **implemented adapters, not live credential-verified integrations.** A catalogue naming
Salesforce with nothing behind it would produce a _Test Connection_ failure that looks like a
customer's credential problem, and that is a worse outcome than an honestly short list.

### S-101 — a company can read platform Skills and can never write one

The first asymmetric Row-Level Security policy in UBoss (ADR-086). `USING` permits reading own
rows **and** `tenant_id IS NULL` rows; `WITH CHECK` permits writing own rows only.

The asymmetry is the security property. A symmetric policy would let any company insert a
`tenant_id IS NULL, layer = 'UbossVerified'` row — and every other company would then read it as
verified by UBoss, in a catalogue whose entire value is that the Verified layer means something.

Two locks, not one: `skill_layer_matches_its_owner` refuses a layer that lies about its owner even
within one plane, so a company row can never claim `UbossVerified` and a platform row can never
claim `CompanyCustom`. Verified directly against the database in both directions.

### S-102 — approved content cannot be altered, including by a caller that bypasses the service

`skill_version_content_is_frozen_once_approved`, a `BEFORE UPDATE` trigger. It refuses any change
to a content column on a version that is `Approved`, `Published`, `Deprecated` or `Archived`,
while still permitting the status to move.

**Frozen at approval, not publication.** An approval is a decision about specific content; if the
content could change afterwards, somebody could get "delete records" approved by having "read
records" reviewed, and the approval record would look intact while meaning nothing.

A trigger rather than a revoked grant because deprecation needs `UPDATE`. The function lists the
frozen columns explicitly, so adding a content field without considering immutability fails
loudly rather than silently permitting a hole.

### S-103 — a high-risk Skill can never be fully autonomous

Refused in three layers: `validateSkillGovernance` in `@uboss/types`, the service at creation
**and again at the approval boundary**, and `high_risk_skill_is_not_fully_autonomous` in the
database.

The combination is an irreversible action in somebody else's system with no person involved at any
point. The **Executor Agent is not a substitute** — the locked rule is that it never silently
approves high-risk work — and the refusal message says so, because that is exactly the reasoning
somebody would otherwise reach for.

The second half of the same rule: a high-risk Skill must either require approval or only suggest.
Anything else means the high-risk action happens on nobody's decision.

Re-validating at approval matters independently: it is the last moment content can be refused, so
a governance rule introduced after a draft was written still applies to it. A test forces an
invalid state past the service and watches the approval refuse it.

### S-104 — a Skill declares tool categories; it is not granted them

`allowedToolCategories` uses Prompt 16's vocabulary and is a **declaration of need**. What an
Engine Agent actually gets is a `ConnectionToolGrant` (S-095), which names the agent, the
connection and the category, and needs a reason for anything high-risk.

Declaring is not being granted, and the boundary refuses a human action in that field: a Skill
claiming `Administer` would be a category error in the most literal sense, and the DTO rejects it.

### S-105 — an administrator cannot approve a Skill, and an approver cannot author one

`settings:Approve` lives on the **`Approver`** role alone (ADR-088). `CompanyAdmin` carries no
`Approve` anywhere — the Prompt 7 invariant, which refused this prompt's attempt to widen it.

Approving and **rejecting** are the same permission, because sending a version back is what
rejection is, and a reviewer who can approve but not reject will approve and fix later.

A test asserts both directions: the administrator can do neither, and the approver can do both and
cannot author. That is what makes the separation real rather than nominal.

### S-106 — the governance trail cannot be rewritten

`REVOKE UPDATE, DELETE ON skill_transitions`. "Who sent this back to draft, and what did they say"
is the question a governance review asks, and a rewritable history cannot answer it. A rejection,
a deprecation and an archival each require a reason at the database
(`rejecting_transition_has_a_reason`), and a transition that does not actually move is refused.

### S-107 — a clone is a new Skill under its own approval, never a live copy

A clone starts as `Draft` whatever the source's status was. Inheriting `Published` would mean a
company's Skill was live without anybody there approving it — which would make the layer
separation decorative.

It also records `clonedFromSkillId` and `clonedFromVersionId`, so the provenance survives. That is
what a template could not do, and it is what lets impact analysis count clones as an affected
domain — while stating that they are independent and are _not_ upgraded by a change to the source.

### S-108 — an unapproved Skill can never be selected for work

Two independent locks. The router's candidate query filters `status: 'Published'`, so a draft is
**not in the set** — no scoring decision can reach one. And `scoreSkillForContext` disqualifies
any other status with its own message, so a future caller assembling candidates differently still
cannot get one through.

There is no parameter that relaxes either. A test asserts that a catalogue containing only drafts
and approved-but-unpublished versions produces zero matches **and zero rejections**, because
nothing entered the set to be rejected.

The reason for the belt and brace: a draft reaching production once is a draft nobody goes back to
review. It worked, so it stays.

### S-109 — a missing capability cannot be silently published or auto-used

The client's rule, enforced by an **absence**: `SkillCandidateStatusKind` has no `Published`
member, so there is no value to set. `UPDATE skill_candidates SET status = 'Published'` fails as an
invalid enum input, verified directly against the database.

Accepting a Candidate goes through `SkillService.createCompanySkill` and produces a **draft** under
the ordinary lifecycle, with `createdAs: 'Draft'` and `requiresApprovalBeforeUse: true` in the
audit metadata. `accepted_candidate_produced_a_draft` and `only_acceptance_creates_a_skill` close
both directions: acceptance must have produced something, and nothing else may claim to have.

`raiseCandidateIfMissing` defaults to **true**, because a rule that has to be opted into is a rule
the common path drops.

### S-110 — every selection and every rejection is explainable

A match carries its `confidence` and its `reasons`; a rejection carries the single rule that ruled
it out; and the whole decision is reproducible from its inputs because the router is a pure
function.

This is a security property, not a usability one. An AI system whose capability selection cannot
be explained cannot be audited, and cannot be argued with when it does the wrong thing — and the
first serious incident is precisely when somebody will need to know why a particular Skill was
chosen. ADR-089 records why no model sits in this path.

### S-111 — company policy on autonomy disqualifies rather than ranks

`maxAutonomy` in the routing context removes any Skill above it. "We do not allow fully autonomous
AI in this department" is a policy statement, and a policy ranked slightly lower is a policy that
gets used the first time nothing better is available.

Three sibling hard rules, each preventing a specific outcome: a Skill needing a tool the work
forbids (it would fail part-way through an external action), a Skill requiring no approval when the
work must be approved (output taking effect with nobody having decided), and a Skill whose own
**"when not to use it"** describes this task — which is why Prompt 17 made that field mandatory.

### S-112 — the evaluation record cannot be rewritten, and cannot fabricate a verdict

`REVOKE UPDATE, DELETE ON skill_evaluation_runs`. A verdict editable after the fact is not
evidence, and a regression comparison is exactly the evidence somebody publishes on. A wrong
result is corrected by recording another run — which is also the honest shape, because the first
result did happen.

`evaluation_run_records_its_output` refuses a verdict with no output: a pass attached to nothing is
a result with no evidence. Output may be empty **only** when the run is unjudged.

**No verdict is invented.** `HumanJudged` cannot be computed, and a run without a supplied verdict
is stored unjudged — counting as neither pass nor fail, so a comparison cannot report `Improved` on
the strength of cases nobody looked at. Supplying a verdict requires a note saying what it was
based on.

### S-113 — a comparison's verdict cannot disagree with its own evidence

`verdict_matches_its_evidence` refuses a row where the verdict and the regression/improvement
arrays disagree, and `inconclusive_means_nothing_was_compared` refuses a conclusion drawn from
nothing compared. Together they mean a stored verdict can only have come from the comparison it
claims to summarise.

`REVOKE DELETE ON skill_regression_comparisons` keeps it. Publishing over a regression requires an
actor and a real reason (`regression_acceptance_is_attributed`), because the person who later finds
the broken behaviour will read it.

### S-114 — a case cannot be edited to agree with a result

Once a comparison has depended on a case, `usedInComparison` freezes its expectation. A case whose
expectation could be changed after a run is evidence that can be made to say whatever is
convenient, and the whole point of saved cases is that they were written **before** the result was
known.

Retiring a case is possible and requires a reason; its previous runs are kept, so a comparison made
last month stays interpretable.

### S-115 — evaluation cases on a platform Skill belong to the platform

A company cannot add a case to a UBoss Verified Skill or an Industry Pack — the service refuses,
naming cloning, and the asymmetric RLS `WITH CHECK` refuses the write independently.

A company that wants its own cases clones the Skill, which gives it its own version, its own
approval trail and its own cases. The evidence behind a Verified Skill is part of what makes it
trustworthy to every other company, so it is not something one company edits.

## Known gaps (deliberate, scheduled)

| Gap                                                                      | Arrives at           |
| ------------------------------------------------------------------------ | -------------------- |
| ~~Authentication, activation, sessions, password reset, lockout~~        | **Done at Prompt 5** |
| ~~MFA, SSO/OIDC, domain verification, SCIM~~                             | **Done at Prompt 6** |
| SAML assertion consumption (model and metadata done)                     | See S-033            |
| WebAuthn / passkeys (model and policy are method-agnostic)               | Not scheduled        |
| Public-suffix check on a domain claim                                    | Prompt 21            |
| ~~Tenant isolation guard, cross-tenant negative tests, RLS~~             | **Done at Prompt 4** |
| Audit event persistence (a table shell arrives at Prompt 3)              | Prompt 3 onward      |
| Rate limiting and throttling (correlation IDs done at Prompt 4)          | Prompt 21            |
| Secret manager integration (KMS/Vault) — the seam exists, see S-028      | Prompt 20 onward     |
| Email delivery of invitation and reset links                             | Prompt 28            |
| Company-scoped invitation and session administration (role model)        | Prompt 7             |
| ~~Roles, permissions, scope, module visibility, allowed actions~~        | **Done at Prompt 7** |
| ~~Append-only audit trail enforced by the database~~                     | **Done at Prompt 8** |
| ~~Break-glass recovery record with four-eyes approval~~                  | **Done at Prompt 8** |
| ~~Platform-role guards for the Master Console~~                          | **Done at Prompt 9** |
| Reporting hierarchy, so `TeamSubtree` scope can be evaluated             | Prompt 12            |
| TCSiON mapping contents (the extension point is built)                   | Blocked on client    |
| Company-scoped administration of policy, roles, identity and SCIM        | Prompt 10 onward     |
| Company provisioning wizard — the entry screen and defaults exist        | Next prompt          |
| AI usage metering; the allowance column and screens are ready            | AI module prompts    |
| Payment provider integration for Billing & Payments                      | Prompt 20 onward     |
| Health probes that write service alerts by observation                   | Prompt 21 onward     |
| An **external** anchor for audit checkpoints — the column and seam exist | See ADR-046          |
| Wiring an active break-glass grant into the authorization engine         | See ADR-048          |
| Retention and archival for either trail (append-only makes it explicit)  | Prompt 20 onward     |
| Alerting on `Critical` security events (severity is indexed for it)      | Prompt 21/28         |
| Type-aware lint rules that catch unsafe `any` around tenant context      | See ADR-008          |

Nothing above is "assumed handled". The API now exposes the `/auth`, `/invitations`,
`/tenants/:id/identity`, `/tenants/:id/authorization`, **`/tenants/:id/audit`**,
**`/platform/security`**, **`/platform/break-glass`**, **`/platform/console`** and
`/scim/v2` routes documented in
`docs/API_CONTRACTS.md`. **Two** guards now apply, in order: `TenantGuard` still denies anything
with no tenancy policy, and `PermissionGuard` then enforces whatever `@RequirePermission`
declares. Where a capability is not implemented it is **advertised** as unimplemented — SAML
cannot be enabled, `TeamSubtree` scope returns a distinct "cannot evaluate" denial, and the
TCSiON mapping table reports that no approved reference has been loaded — rather than being absent
and discovered.

---

## Supply chain

- All dependencies pinned to exact versions; `package-lock.json` committed.
- `npm audit` at Prompt 1: 0 vulnerabilities across 411 packages.
- `npm audit` at Prompt 3: **4 high severity**, all from Prisma transitives and all
  assessed as unreachable — see S-010. This is stated plainly rather than rounded to zero.
- Two optional native build scripts remain unapproved by npm's `allow-scripts` gate
  (`@parcel/watcher`, `unrs-resolver`). Both are optional accelerators; the pipeline passes without
  them, so they are left unapproved rather than granted install-time script execution.

## Prompt 19 — Objective Builder, exact Form 2

### S-116 — a live objective's plan cannot be rewritten, and the grid counts as the plan

Two triggers, not one. `objective_version_content_is_frozen_once_live` freezes the Form 2 columns
from `Active` onwards while still letting the status move; `objective_grid_is_frozen_once_live`
refuses `INSERT`, `UPDATE` and `DELETE` on the steps of a live version. Freezing the
objective-level columns while leaving the workflow grid writable would be a hole rather than a
subtlety — inserting a step into a running plan changes it exactly as much as editing the expected
result. The service refuses these too; the triggers are what make the rule structural.

### S-117 — a genuine cascade is permitted and a direct edit is not

`DELETE FROM objectives` removes the version row and then cascades to its steps as a separate
command, so the grid trigger's lookup does not see the version and the delete proceeds. Verified
by deleting a live objective and confirming zero steps remained. Tearing down a company works;
editing a live grid does not. Both trigger functions are `SECURITY INVOKER`, so the lookup runs
under the caller's Row-Level Security context and the trigger cannot become a way to read another
tenant's version.

### S-118 — one live version per objective

A partial unique index on `(tenant_id, objective_id) WHERE status = 'Active'`. Two simultaneously
live versions would make "which plan is running" unanswerable, which is the state the client's
versioning rule exists to prevent. A Draft alongside the live version is permitted — that is the
shape of the rule, not a violation of it.

### S-119 — a department outside your scope is refused without confirming it exists

Creating an objective checks the actor's scope against the _department named on the form_ before
looking the department up. A department belonging to another company is therefore refused with
"that is outside what your role covers" rather than "not in this company". The existence check
behind it is defence in depth, exercised where the department genuinely is the caller's. The
assertion in the test follows the code rather than the code being bent to the assertion.

### S-120 — a missing objective is 404, not 403

Under Row-Level Security another company's objective is not visible at all. Returning `403` would
confirm that an objective with that id exists somewhere; `404` says only that this caller cannot
see one. The reward panel behaves the same way.

### S-121 — nobody can attach a reward to their own objective by role alone

The reward panel is gated on `objective:Assign`. `Employee` carries `Create` and `EditDraft` on
`objective` and **not** `Assign`, so an employee can draft their own objective and cannot promise
themselves a bonus. No new permission was invented for this — the client's existing action already
draws the line in the right place. Tested through both the service and the route.

### S-122 — recording a reward writes no performance event and creates no payable

The client's rule is that nothing auto-pays on completion and that approved points reach
performance only through policy. Enforced by absence: `objective_rewards` has no `approved`,
`settled`, `paid`, `payout` or `disburse` column, and no connector call exists. Asserted twice —
an `information_schema` query proving those columns do not exist, and an e2e test proving
`performance_events` is still empty after a reward is saved. The audit event carries
`autoPaid: false` so the trail states it rather than leaving it to be inferred.

### S-123 — hidden navigation is still not security, on this screen too

Every objective route carries a phase-1 `@RequirePermission` and a row-level check in the service
against the objective's department, owner and creator. A department-scoped Head who knows another
department's objective id is refused by the row check, and the same objective is absent from their
list. Both directions are tested, because a list that over-returns and a fetch that under-refuses
are different bugs.

## Prompt 19A — Objective extra work, bonus and reward controls

### S-124 — approving a reward is not paying it

`Approved` is a decision and carries no money. Settlement is a separate act needing all of: an
approved award, a `Cash` type, a positive amount, a configured payroll connector, and an actor who
is **not** the approver. Each is refused separately so a failure names the reason. `only_cash_is_settled`
and `settled_award_has_a_provider_reference` enforce two of them in the database.

### S-125 — with no connector configured, the product refuses rather than pretending

`UnconfiguredPayoutAdapter` is what ships: `canSettle: false`, and it throws if called. The refusal
message says UBoss will not record a payment it did not make. `GET …/rewards/meta` reports
`payoutConnector.canSettle` so a screen never offers a button the product cannot honour.

### S-126 — `payout_was_real` is stored, not inferred

Every adapter that exists — including the test mock — returns `deliveredRealPayment: false`, and
that value is written to the award and reported on every read. No report, screen or audit entry can
claim a settlement was real when it was not. The settlement audit summary states it in words.

### S-127 — four eyes on the money

The person who approved an award may not settle it. Enforced in the service and by
`settlement_needs_a_second_person`. Related: the subject may never declare their own work eligible
nor approve their own award, even when the rule names them as approver.

### S-128 — holding `objective:Approve` is not the same as being the named approver

Approving requires both the permission and being the approver the rule named when the award was
assigned. The permission says who may approve things in general; the rule says who is accountable
for this one. The separation-of-duties engine may refuse even earlier — "you cannot approve
something you created" — and that is a stronger control firing first, not a conflict.

### S-129 — the terms cannot move after assignment

`reward_type`, `amount_minor_units`, `eligibility_condition`, `completion_deadline`,
`approver_user_id` and `subject_user_id` are frozen from assignment by a trigger. Editing the rule
afterwards does not change what an existing award promises. Without this somebody could raise the
amount or soften the condition after the work was done, and the trail would show the new terms as
though they had always been the terms.

### S-130 — a terminal award cannot be reopened

`Rejected`, `Settled` and `Recorded` are final, in the transition table and in the trigger. An
un-settled award could be paid twice; an un-rejected one would let a refused claim quietly
reappear. A mistake is corrected with a new award and a reason.

### S-131 — being paid is not a performance outcome

`only_recorded_points_touch_performance` refuses a performance event on anything but a `Recorded`
**Points** award. A cash settlement can never move somebody's score, even with the reward-points
policy enabled — tested explicitly.

### S-132 — a policy refusal is recorded, not silent

When policy does not permit reward points to reach the score, the award finishes as `Recorded` with
`performance_note` explaining why, and `unscored_points_award_explains_itself` refuses the row
otherwise. An unexplained absence of a performance event would be indistinguishable from a bug.

### S-133 — a person can always see their own awards

Found by a failing test rather than reasoned in advance: `listForSubject` applied the row-level
scope check uniformly, and a person's own award carries no department on the resource descriptor,
so a `Department`-scoped Head asking about their own bonus was refused as unevaluable. Being told
you may not see your own bonus is absurd. The scope check now applies only to _somebody else's_
awards, matching how a person's own performance score has always worked. Both directions are
tested.

## Prompt 20 — Objective review routing and strict versioning

### S-134 — nothing goes live without an approval

`live_objective_version_was_approved` refuses `Active` or `Completed` with no `approved_at`, and
`objective_publication_follows_approval` refuses a publication timestamped before its own approval.
The service checks both too; the constraints are what make it hold against a direct database write.
Tested through the service **and** by attempting the write directly.

### S-135 — an author cannot route around the reviewer

The client's rule that an edit automatically opens the next draft is deliberately **not** applied
while a version is `UnderReview` or `ReadyForApproval`. Without that exception an author could
edit the auto-opened copy, take it through approval and publish it, and the review in progress
would have decided nothing. The first implementation omitted the condition and a Prompt 19 test
caught it — the exception is now explicit and has its own test.

### S-136 — only the Responsible Owner may act as the reviewer

Confirming the team, sending back and completing the review all require being the person the form
was routed to, not merely holding `objective:Approve`. The same shape as a reward's named approver:
a permission is not the same as being accountable for this objective. The separation-of-duties
engine refuses even earlier for somebody acting on what they created.

### S-137 — an approval does not survive a send-back

Sending a version back clears `approvedAt` and `approvedByUserId`. An approval is a decision about
**specific content**, and content that is about to change makes it worthless — leaving it would let
the next publish go live on an approval nobody gave for what the version now says. This is why
send-back is the one review action that also accepts `ReadyForApproval`.

### S-138 — a live version's provenance and approval are frozen with its content

The Prompt 19 freeze trigger was replaced so `origin`, `copied_from_version_id`, `approved_at` and
`approved_by_user_id` are frozen alongside the Form 2 columns. Rewriting who approved a live plan
is precisely what an audit exists to detect, and the client requires historical records to keep
exact version ids. The status still moves (`Active → Completed → Archived`), which is why this is a
trigger and not a constraint.

### S-139 — a rollback moves forward and never reopens history

`rollbackTo` creates a **new** draft copied from the older version, recorded with
`origin: 'Rollback'` and a provenance pointer. The old row is untouched and the new draft must go
through review and approval before it can go live. A rollback that reopened an archived version
would let a previously superseded plan become live again with no fresh decision.

### S-140 — employees receive no actionable work during review

`isObjectiveWorkAssignable` returns true only for `Active`, and every version view carries
`workAssignable`. One function rather than a rule each consumer re-derives. An
approved-but-unpublished version is deliberately not assignable: a plan awaiting publication is not
work anybody owes yet, and handing it out would mean recalling it if publication did not follow.

### S-141 — a concurrency bug made the hierarchy check answer in the dangerous direction

The routing check originally ran its four lookups with `Promise.all` inside an already-open tenant
transaction. Concurrent queries on one interactive transaction lose the AsyncLocalStorage scope, so
they ran unscoped, and under Row-Level Security an unscoped read returns **nothing** — which the
code read as "the hierarchy cannot be evaluated" and therefore **permitted** a routing it should
have refused. The lookups are now sequential, with the reasoning recorded at the call site. The
general lesson is already in this document's Prompt 17 entry: an unscoped read returning nothing is
not a neutral failure, it is a false answer whose direction depends on how the caller reads it.

## Prompt 21 — Objective AI analysis

### S-142 — analysis output is always a draft, and cannot become anything else

The version moves only to `AiAnalysis` and `WorkflowDraft`, both pre-approval, so `workAssignable`
stays false and nothing is handed to anybody. `objective_analysis_runs` has **no approval or
publish column at all** — enforced by absence and asserted from `information_schema`. The only
route to live remains the Prompt 20 approve-then-publish sequence performed by people.

### S-143 — provider names never leave the Model Gateway

`ModelGateway`'s request type carries no model name and no provider option, and its response
carries an opaque `capability` label. Nothing downstream — service, view, database column, audit
entry or screen — can name a provider, because it is never told one. `ModelGatewayModule` is
`@Global` so no caller has a reason to reach a provider SDK directly.

### S-144 — `produced_by_real_model` is stored, and a finished run cannot have it flipped

Every adapter that ships returns `producedByRealModel: false`; the flag travels with each response,
is persisted, and is reported on every read. A constraint refuses a row claiming a real model with
no capability named, and the freeze trigger refuses **any** change to a finished run — including
flipping that flag, which is precisely the field somebody would be tempted to change after the
fact.

### S-145 — a draft is validated before it is stored, and refused knowingly on read

`validateWorkflowDraft` runs before any store: a malformed draft never reaches the database,
because a screen will try to render one and the failure would surface far from its cause. A stored
draft whose schema version this build does not read returns `draft: null` with a stated reason
rather than being interpreted against a shape it was not written in.

### S-146 — the locked node-shape rule is enforced on the data

`validateWorkflowDraft` refuses a node whose `shape` contradicts its `kind`, so an AI node drawn as
a rectangle cannot be stored, let alone rendered. The renderer draws what it is told. Restyling a
component cannot break the client's rule, and an invariant test in `packages/types` asserts the
mapping directly.

### S-147 — the analysis cannot reach an unapproved Skill

Skill matching reuses the Prompt 18 Skill Router rather than matching here. The router already
filters its candidate set to `Published` and disqualifies anything else, so there is exactly one
implementation that could ever reach a draft Skill — and it does not. A second matcher would have
been a second thing to get wrong.

### S-148 — cancellation is honoured, not merely recorded

The pipeline re-reads its own status between stages, so a cancellation from another request stops
it at the next boundary. Checked _between_ stages rather than inside them, so a cancelled run never
claims to have completed a stage it abandoned. A partial unique index permits one live run per
version, so two analyses cannot race to write one draft.

### S-149 — an unscoped read inside the pipeline reported the run as missing

The pipeline's own status re-read was written without a tenant transaction, and under Row-Level
Security an unscoped read returns nothing — so the helper concluded the run had disappeared and
failed **every** analysis. The helper now scopes itself explicitly. This is the third instance of
the same class in this document (Prompt 17's pre-transition read, Prompt 20's `Promise.all`), and
the shared lesson is worth stating once more: an unscoped read does not fail loudly, it returns an
empty result whose meaning depends entirely on how the caller reads it.

## Prompt 22 — the workflow editor

Every route is authorised on the server. `objective:EditDraft` gates every mutation **and** the
open call, because opening seeds a row and is therefore an edit rather than a read;
`objective:View` gates reading the plan and the Pre-Publish Summary. A `CompanyAdmin` can read a
plan and cannot edit one — the Prompt 7 decision, pinned by a test rather than assumed.

Tenant isolation is enforced by RLS with `FORCE`, and tested from both directions: another
company asking in its own workspace gets 404, and asking against the owning tenant's URL is
refused before any row is read, with no workflow in the body either way.

### S-150 — a partial edit silently emptied the fields it did not mention

`editNode` merged the Definition-of-Done patch with `{ ...node.dod, ...patch.dod }`. A validated
DTO is a class instance, and a declared TypeScript field is an own property **whether or not the
request set it** — so the spread wrote `undefined` over every part the manager had not touched.
Editing only the criteria emptied the dependency and tool lists, and the whole-graph validation
then refused the write with a message about lists the manager never removed.

Fixed with a `definedOnly` helper that drops undefined keys before merging. The class of bug is
worth naming: `{...dto}` is not a partial patch, and "the request omitted this" and "clear this"
are different instructions that a plain spread cannot tell apart. The regression test now asserts
that the four untouched parts survive, not merely that the call returned 200.

### An assigned plan cannot be rewritten, in the service or in the database

Once `assigned_at` is set the service refuses every edit with a readable message, and
`uboss_assigned_workflow_draft_is_immutable` refuses the write even for a caller that bypasses the
service. People are already working to an assigned plan; editing it underneath them is what
versioning exists to prevent. Tested at both levels.

## Prompt 23 — Approve & Assign and the To-do list

Approve & Assign requires `objective:Assign` at both the module level and the row level, and the
`todo` module carries its own permissions at its own scope: an Employee has `todo: View, Comment,
EditDraft` at `OwnWork`, which is why the To-do routes are their own controller rather than a
branch of objectives. Routing an employee's work through the objective module would have made that
separation impossible to express — an employee has no right to browse objectives at all.

Row-level visibility is the authorization engine's answer, not a query predicate. `list` fetches
and then asks the resource check per row, so "is this mine to see?" has exactly one implementation.
Filtering in SQL as well would give two answers that eventually disagree.

### S-151 — an unscoped read refused a valid publish. The fourth instance

The membership check in Approve & Assign's validation read `tenantMembership` without a tenant
scope. Under Row-Level Security that returns nothing, which the code read as "this person has no
active membership" and refused a perfectly valid publish for every assignee at once.

What makes this instance worth recording separately: the code was **correct when written**, inside
the transaction, and carried a comment explaining this exact hazard. Splitting the method into
read / validate / write phases (ADR-115) moved it outside, and the comment stayed. The lesson to
carry forward is narrower and sharper than the previous three: **moving a database read out of a
transaction is as dangerous as forgetting to open one**, and a comment warning about a hazard does
not protect the code it sits above.

Now scoped explicitly with `runInTenantTransaction`, and read one at a time — `Promise.all` inside
an open interactive transaction loses the AsyncLocalStorage scope and produces the same empty
result by a different route (S-141).

### An approval gate names a role, not a person, and that is not a gap

The analysis records which role must approve, because that is what Form 2's grid says. It does not
name an individual, and this prompt does not resolve the role to people: that belongs to the
Approval Engine prompt, and guessing here would notify somebody with real authority to act on a
decision that was never theirs. So an approval request carries `approver_role_kind` and no named
approver unless a manager named one in the editor — and no individual notification is raised in
that case. Both branches are tested.

### Nothing is notified about work that was never assigned

Notifications are raised after the transaction commits, not inside it. See ADR-115: telling an
approver about a publish that then rolled back is the failure worth designing against.

### Evidence is a reference, not a file

`human_task_evidence` stores a description and a reference — a document id, a run id, a system of
record. No prompt has specified file storage for task evidence, and inventing an upload path would
create a place for company documents to live that nothing else in the product governs: no
retention rule, no export policy, no answer for the confidential-prior-work rule. The reference
names where the evidence actually is.

## Prompt 24 — Agent Builder

**S-160 — The Employee `agent-builder` grant was widened, deliberately and narrowly.**
`EditDraft` and `Run` were added (ADR-270). This is a real widening of what an Employee may do, so
the reasoning is on the record: the approved source document requires the employee to complete
their own agent's setup and activate it, and the previous `View, Comment` grant made that
impossible. It is safe only because `Employee.maxScope` is `OwnWork` and the scope engine confines
every one of these actions to work the person owns — a test asserts both halves, because the grant
without the cap would hand every employee everybody else's agents.

`Publish` was deliberately **not** granted. The first attempt used it and broke the standing rule
that an Employee holds no Approve, Publish, Assign, ManageAccess or Administer on any module. The
guardrail was right and the action choice was wrong.

**S-161 — A service must not carry its own authorization policy.**
The first version of `AgentBuilderService` decided access itself: "the owner, or anyone with
Administer". That is a second, disagreeing policy living in a service, and it would have
over-shared the moment any role gained a module-level action. Replaced with the scope engine,
handing it the resource's owner and department so `OwnWork`, `TeamSubtree`, `Department` and
`WholeCompany` mean what the role templates say. Effective access is User Type + Role + Scope +
Module Visibility + Allowed Actions + Policy Constraints, and none of those belong to a module.

**S-162 — Setup-time connection validation cannot imply run-time permission.**
`mayBeUsedForSetup` (ADR-119) answers only what is knowable before the agent exists. Its `true`
means "a sensible choice to record", never "this agent may act", and the readiness panel says so
as a Warning. The Agent Tool Permission remains a separate `settings:Administer` act, so an
employee configuring their own agent cannot widen an integration's reach as a side effect.

**S-163 — A stored test result cannot be silent about the provider.**
`agent_test_says_whether_the_model_was_real` is a database CHECK, not a convention: a recorded
test must state whether a real model was involved. The activation audit event additionally records
`testedBeforeActivation`, `lastTestPassed` and `lastTestUsedRealModel`, so "this agent was
activated untested against a mock" is a fact in the trail rather than an inference.

**S-164 — Deny-by-default on tenancy caught a missing decorator.**
`AgentBuilderController` shipped its first compile without `@TenantScoped()`, and every request —
including an anonymous one — was refused with "This route has no tenancy policy and is refused by
default." Worth recording as evidence the default works: the failure mode of forgetting the
decorator is a closed door, not an open one.

## Prompt 25 — Engine Agent registry

**S-165 — Passing an owner without a department is an easy mistake to make twice.**
`EngineAgentService.mayTouch` initially handed the scope engine only the agent's `ownerUserId`. A
Department-scoped Head — the role the templates give archiving and versioning to — therefore
matched nothing, and the refusal surfaced as `404 There is no such Engine Agent you can see`.
Sixteen e2e tests failed on it. The identical omission had already been found and fixed in Agent
Builder days earlier, which is why it is recorded here as a pattern rather than an incident: when
a service hands the scope engine a resource, it must supply **every** dimension the role templates
scope by, and a 404 that looks like "missing" may be "unscoped".

**S-166 — Reach may only widen through review.**
Activating an agent version that adds a tool category, or that moves memory from ephemeral to
persistent, requires an approval by someone other than the activator (ADR-124). A narrowing change
does not. The requirement is computed at draft time and stored, and the freeze trigger protects it
once published, so the justification a reviewer saw cannot be edited afterwards.

**S-167 — The default memory mode persists nothing.**
`CurrentRunOnly` is the column default and the fallback when reading a version that predates the
field. Prompt 33 implements retention, visibility, deletion, cross-user and cross-objective
sharing limits and offboarding behaviour; until it exists, an agent that could retain anything
would be retaining it under no policy at all. A database CHECK also refuses any mode outside the
architecture's four, so a fifth cannot appear without a migration and a governance rule.

**S-168 — Archiving is terminal, and the record survives it.**
`ALLOWED_ENGINE_AGENT_TRANSITIONS.Archived` is empty, and drafting a version on an archived agent
is refused explicitly rather than left to fail somewhere downstream — a version edit must not be a
back door around a status the company chose as final. The agent, its versions and its history stay
readable, which is the difference between archiving and deleting.

## Prompt 26 — Runs

**S-169 — A bounded retry policy that silently never retries is a security-relevant failure.**
The `running_run_was_reserved_first` CHECK omitted `Retrying`, so every retry rolled back and each
run stopped at attempt one. Recorded here rather than only in the changelog because the failure
mode is the dangerous kind: the policy *appeared* configured, the audit trail showed a failure, and
nothing indicated that the remaining attempts had never happened. A control that looks enforced and
is not is worse than an absent one. The lesson for the raw-SQL probe discipline: probe every state
the code actually writes, not the one the constraint is named after.

**S-170 — Run events are append-only in the database, not by convention.**
`agent_run_events` refuses `UPDATE` and `DELETE` by trigger. The table exists so that live progress
is not the record; a history that can be rewritten afterwards would not be evidence. Same reasoning
as the audit trail, and verified the same way — against a mirror table carrying the trigger, because
the real table was empty and a zero-row `UPDATE` proves nothing.

**S-171 — Cross-tenant progress is impossible by construction, not by filtering.**
`RunProgressGateway` keeps one listener set per tenant id and publishes only into the set for the
company an event belongs to. There is no code path that could deliver one company's run progress to
another's subscriber, which is a stronger statement than "the filter is correct". A test subscribes
as the other company and asserts it receives nothing.

**S-172 — A swallowed error that no test can see is an availability risk.**
`InlineRunQueue` deliberately does not rethrow — the engine records failures on the run row, and
rethrowing would report the same failure twice. But the first version left the error nowhere
observable, and a run that stopped mid-flight presented only as a state that had not advanced.
`lastFailure` now retains it. Deliberate suppression is fine; invisible suppression is not.

**S-173 — The mock executor is recorded as a mock on every run.**
`produced_by_real_model` is NOT NULL for any completed run, by CHECK. The prompt permits a mock
executor while the provider gateway is incomplete; what it does not permit is a report that cannot
tell the difference. The value comes from the gateway's own answer, never from a default.

## Prompt 27 — The Executor Agent

**S-174 — One rule, three enforcement layers, and no route around them.**
The Executor never closes its own findings. `EXECUTOR_PERMITTED_ACTIONS` has no word for it, the
service refuses it, and `executor_never_closes_an_exception` refuses the row (ADR-131). This is the
only rule in the codebase given three layers, because it is the one the whole oversight design
rests on. There is also no endpoint through which a caller can act *as* the Executor: `act` takes
its actor from the authenticated session, never from a parameter, so there is nothing to forge.

**S-175 — The Executor cannot act at all on an exception a control raised.**
On a `PermissionDenied` or a `BudgetOrTokenLimit`, even a retry is refused. A retry there would be
the oversight layer pressing on past a control that has just said no — which is a worse failure
than the original block, because it would be automated. It may only route the exception to whoever
owns the decision.

**S-176 — A high-risk action is never passed by the machine stages.**
`concludeValidation` returns `Deferred` for a configured high-risk action with no human decision,
however confidently the deterministic and AI stages agreed (ADR-133). `Deferred` exists as a
distinct verdict precisely so this state cannot be reported as a pass. The AI stage advises and
never vetoes, and every stage result says whether a real model was involved — `null` for the human
stage, so "no model" and "a mock" are never the same value.

**S-177 — The resolution history is evidence, so it is append-only and attributed.**
`executor_exception_events` refuses `UPDATE` and `DELETE` by trigger, and
`exception_event_has_an_actor` refuses an entry that names neither a person nor the Executor. A
report that conflated "nobody" with "the machine" would misrepresent who was accountable for a
decision about a problem.

**S-178 — An acknowledgement cannot silence an exception.**
Escalation ignores the `Acknowledged` state (ADR-134). If acknowledging stopped the aging clock,
"I have seen it" would be a way to hold a High-severity exception indefinitely with no further
signal — which is the mechanism by which a queue quietly stops being read. An unowned exception is
never marked escalated to nobody; it stays open and reports itself overdue.

**S-179 — The self-approval refusal has exactly one implementation.**
The Approval Engine contains no self-approval check. `checkSeparationOfDuties` owns it and the
Prompt 7 migration seeds a mandatory platform-wide `NoSelfApproval` control on `Approve` that every
company inherits (ADR-137). The engine is fed the requester as `createdByUserId` and the decision
history as `priorActorUserIds`. A second implementation would be a second answer to the same
question, and the copy in the approvals code would not have recorded a security event. A unit test
pins that `isAddressedTo` has no opinion on self-approval, so the duplication cannot creep back.

**S-180 — Rejecting your own request is refused too.**
Every decision exercises the same `Approve` action on the same module, so one control covers
approve, reject and send back. Somebody who may not approve their own work may not dispose of it by
rejecting it either — asserted directly, because "reject" looks harmless and is not.

**S-181 — Blocked self-approvals reach the security trail.**
Fixing ADR-142 was a security fix, not a refactor. With `authorize` running inside a tenant
transaction the platform-plane write refused, the log said "the security trail now has a gap", and
the attempt left no row. An attempt to self-approve is exactly the pattern an audit exists to
catch, whether it was a mistake or not. A test now counts the
`security.separation_of_duties_blocked` rows rather than trusting the code path.

**S-182 — A four-eyes gate cannot be read as a role and quietly bypassed.**
`approver_role_kind` can hold the literal `FourEyes` from `STEP_APPROVAL_KINDS`. Treating it as a
role would have deadlocked every gate; treating it as "anyone may decide" would have removed the
control. It routes to any authorized approver *and* carries a mandatory `FourEyes` policy of its
own, so the control applies whether or not the company configured one (ADR-138). Tested against a
company with no `FourEyes` policy rows at all.

**S-183 — Delegation grants nothing.**
`approval_delegations` has no permission columns. Three attacks are refused and tested: a delegate
with no `Approve` gains none; a request the actor raised stays refused however it was delegated;
and an administrator cannot arrange for somebody else's approvals to land on themselves — checked
before the permission check, because it is refused whatever permission the caller holds. A delegate
also cannot revoke their own cover, since silently dropping cover somebody relies on is how a queue
stops being watched without anybody noticing.

**S-184 — The decision record cannot be edited, and the tests prove the product.**
`uboss_approval_decisions_are_append_only` and `uboss_approval_decision_is_final` refuse a verdict
change, a reopen, a rewritten reason, and any edit or delete of the history (ADR-139). There is
deliberately **no escape-hatch session variable**: the test harness clears the table with
`TRUNCATE`, which does not fire row-level triggers, so the tests need no privilege the application
lacks. Every refusal is asserted against the database directly rather than through the service.

**S-185 — Activation approval is evidence, not a claim.**
Prompt 25's `approvedByUserId` was a caller-supplied name nobody verified, so anybody with
`agents:Publish` could satisfy a four-eyes requirement by typing a uuid. It is now an
`approvalRequestId` the service looks up and checks for type, subject, status and a different
decider (ADR-143).

**S-186 — Nothing approves on a timer.**
No route, sweep or setting settles a request without a person's decision. Escalation writes
`escalated_at` and notifies a manager; the request stays `Pending` with `decided_by_user_id` null.
A test sweeps a very overdue request twice and asserts that no row anywhere left `Pending`.

**S-187 — The queue never lists what the reader could not open.**
`list` runs a row-level `View` authorization per request, with the requester's department supplied
so a Department-scoped grant can resolve at all. The first version omitted the department, which
failed closed — the safe direction and the wrong answer: a Head saw an empty queue for requests
they could legitimately decide. The resource descriptor is now built in one place shared by `list`,
`view` and `decide`, so the three cannot disagree again.

**S-188 — A configuration that validates is not a provider that answered.**
`ProviderTestResult` carries `reachedProvider` separately from `ok`, the database requires
`last_tested_at`, `last_test_ok` and `last_test_reached_provider` together
(`a_test_result_says_whether_a_provider_answered`), and the Master Console shows the second flag
rather than a green tick. For every adapter that ships the answer is `ok: true,
reachedProvider: false`, and the detail says so in words. The audit event records both, so the
trail can answer "has this ever actually talked to a provider" years later.

**S-189 — A mock call cannot be recorded as real, and cannot borrow a request id.**
`produced_by_real_model` is stored rather than inferred, and
`a_mock_call_has_no_provider_request_id` refuses a request id on a call that did not reach a
provider. A fabricated id would let somebody raise a support ticket about a call that never left
the building — the same class of harm as presenting mock output as a model's judgement.

**S-190 — There is no company-facing provider endpoint at all.**
Not even read-only. §19 of the approved functional document says "employees do not manage provider
keys", and §18 keeps provider names behind the gateway — so a company that could enumerate
profiles could tell which vendor answers its work. A test asserts a company user gets 403 on the
platform route, and the routing reasons a company *can* see are asserted not to contain a provider
name.

**S-191 — A credential is revealed at the moment of use and nowhere else.**
`ProviderProfileView.custom.hasSecret` is a boolean; no endpoint reads a secret back.
`SecretsVault.reveal` is called by the adapter inside the call and by `testConnection`, both of
which hold the plaintext only for the duration of one request and never log it. A test asserts the
plaintext appears in neither the create response nor the list response.

**S-192 — A custom endpoint must be https, and must map its usage.**
Both refused twice over, in `customProviderProblems` and in `a_custom_endpoint_is_https` /
`a_custom_provider_maps_its_usage`. The first because a provider call carries the company's own
data and, under BYOK, its credential. The second because without it the gateway would estimate
what it had just spent and record the estimate as measured (ADR-150).

**S-193 — An auth type and its secret must agree, in both directions.**
`auth_type_and_secret_agree` refuses `BearerToken` or `ApiKeyHeader` with no secret, *and* refuses
`None` carrying one. The second half matters: a stored credential nothing reads is a credential
nobody rotates.

**S-194 — A provider error body never reaches a caller.**
`callJsonProvider` throws a status code and a short note, never the response body. A provider's
error can echo the request back, and for a misconfigured custom endpoint the request carries the
credential. The cause is attached to the `Error` for a log and never interpolated into the message.

**S-195 — A company model cannot become routable for everybody.**
`uboss_provider_model_matches_profile_tenant` refuses attaching a company model to the platform
profile, and `setRoute` refuses a platform route pointing at a company model and a company route
pointing at another company's. Three tests, because the shapes fail differently and only one of
them is obvious.

**S-196 — A platform-plane write cannot silently enter a company's audit trail.**
Fixing that was a real bug found by the tests: `ProviderService` audited from inside
`runAsPlatformOperation`, where no tenant scope is declared, and PostgreSQL refused the insert with
"new row violates row-level security policy for table audit_events". The policy was right — a
platform transaction must not write into a company's trail without saying which company — so the
audit now opens its own tenant transaction and declares the scope. Related:
[[uboss-authorize-outside-transactions]] is the same class of mistake in the opposite direction.


**S-197 — Two agents cannot spend the same last of a budget.**
The property §20's Reserve step exists for, and the one that cannot be established by reading
code. `reserve` locks every wallet in the hierarchy with `SELECT ... FOR UPDATE` in a fixed
outermost-first order, re-reads inside the lock, and writes. Two e2e tests fire ten and twenty
genuinely concurrent reservations through the connection pool and assert the total held never
exceeds the allowance — not that a particular number got through, which would be testing the
arithmetic rather than the safety.

**S-198 — No endpoint can move a balance by hand.**
There is deliberately no `POST /cost/settle` or `/cost/reserve`; a test asserts both 404. Such a
route would be a way to charge a company for work that never happened, and it would sit outside
the reserve/settle pairing that makes the ledger reconcilable. The only writes are
`setAllowance` (audited, `settings:Administer`) and the sweep.

**S-199 — The ledger cannot be edited or deleted.**
`uboss_cost_ledger_is_append_only` refuses UPDATE and DELETE with no escape hatch — the harness
clears it with TRUNCATE, which does not fire row-level triggers, so the tests need no privilege
the application lacks. Asserted against the database directly rather than through the service.

**S-200 — A reservation settles exactly once.**
`uboss_reservation_closes_once` refuses any state change once a reservation has left `Held`, and
refuses rewriting what it was charged. Both the service path and a direct database update are
tested. Without it, two settles racing on one reservation would each read `Held` and each charge
the budget.

**S-201 — Drift is reported, never corrected.**
`reconcile` replays each wallet's ledger and reports disagreement. A test writes around the engine
and asserts both that the drift is found *and* that the stored balance is left wrong — because
silently repairing it would destroy the only evidence that a write bypassed the engine.

**S-202 — An overspend is visible rather than capped.**
`settle` charges the provider's actual cost even above the reserved estimate, `remainingMinor`
goes negative, and the next call is hard-stopped. A capped figure would make the ledger disagree
with the provider's invoice — the company would be told it had money it had already spent.

**S-203 — A notification cannot fail a spend.**
Fixing that was a real defect found by the concurrency tests (ADR-162). A threshold alert racing
on its own dedupe key failed reservations that had already been written correctly.

**S-204 — One company's budget is invisible to another.**
All four tables are strictly tenant-owned with `FORCE ROW LEVEL SECURITY` and no platform-plane
rows — unlike provider configuration, a budget always belongs to exactly one company. Asserted for
wallets and for the ledger.

---

**S-205 — A company cannot grant itself credit.**
The request and the decision are on different planes, and the company plane has no route that
approves — a test asserts 404 on both a company-side decide and a company-side grant, and 403 on
the platform queue. That separation is the control; everything else in this prompt is
bookkeeping (ADR-168).

**S-206 — Employees cannot increase company credits.**
The prompt's own words. Every write on the company credits controller is
`settings:Administer`, which only `CompanyAdmin` holds; a test asserts an Employee gets 403 on
the request route.

**S-207 — The commercial policy is set by UBoss, not by the company.**
Monthly reset, carry-forward, top-up expiry, negative balance and plan change are contract
terms. A company that could set its own carry-forward policy could grant itself credit it had
not bought, which is self-approval in a different hat. The company UI shows them read-only and
says who to ask.

**S-208 — A credit decision is final.**
`uboss_credit_request_decided_once` refuses any state change once a request has left `Submitted`,
and refuses rewriting how much was approved, by whom, or when. Asserted through the service and
against the database directly. A reversible decision would let an approval be undone with no
record of the undoing.

**S-209 — A grant's amount cannot be edited.**
`uboss_grant_amount_is_fixed` freezes amount, currency, source and effective date, and refuses
un-revoking. An editable grant would move a company's allowance with nothing in the ledger
explaining the movement — exactly the drift `reconcile` exists to catch.

**S-210 — Reallocation cannot create allowance.**
`validateReallocation` compares against `remainingMinor`, not `allowanceMinor`, so budget that is
reserved or already spent cannot be moved. A test holds a reservation and then tries to move the
money underneath it.

**S-211 — Only a run blocked by budget resumes after a top-up.**
Every other blocked state is left alone, and the resume re-queues rather than runs (ADR-172).
Buying credits must not clear a governance decision, and a test walks `BlockedByPermission` and
`BlockedByConnection` to prove it does not.

**S-212 — No payment is taken, and the product says so.**
No payment provider is integrated or approved. The billing choice records an intent; Finance
records the invoice reference. The API `note` and the request drawer both state it (ADR-173).

**S-213 — Every credit movement is auditable.**
UBoss_Final_1: "Every commercial adjustment remains auditable." Requests, decisions, grants,
revocations, reallocations, resets and policy changes each write an audit event with the actor,
the amount and the reason — and every balance movement additionally writes a ledger entry,
because this prompt added no second way to move money.

---

**S-214 — The Security Center cannot change anything it shows.**
There is no acknowledge, dismiss, clear or delete route, and a test asserts `DELETE` and `PATCH`
on a view return 404 — because a later prompt adding a "clear" control here would break the
client's tamper-protection requirement without touching a trigger. The one act on the screen
revokes a session, which changes a session rather than a record.

**S-215 — Tamper protection is below the application, and proved there.**
A company administrator's update and delete against `security_events` and `audit_events` are
attempted with the *application* role in the test and refused by PostgreSQL with `42501 permission
denied` — the role holds no UPDATE or DELETE grant at all, on top of the append-only triggers. The
refusal therefore applies to every caller, including an administrator with every action granted
(ADR-174).

**S-216 — Reading, exporting and acting are separable grants.**
`settings:Audit` to read, plus `settings:Export` to export, plus `settings:Administer` to revoke a
session. A custom role holding `Audit` without `Export` is built in the suite and refused an
export; an `Auditor` is refused the revoke route with 403 (ADR-178).

**S-217 — A narrower scope is refused rather than narrowed.**
Security events are not department-scoped. A `MultipleDepartments` grant cannot be honoured by
filtering, so the service refuses — the same rule the audit trail states. A Manager gets 403.

**S-218 — One company's security posture is invisible to another.**
Asserted four ways: a cross-tenant request is refused, another company's events are absent from
the views, another company's guests are absent, and another company's live sessions are not
counted. The last matters most: `sessions` has no `tenant_id`, so the confinement is the
membership list rather than RLS, and it is tested rather than assumed.

**S-219 — A company administrator cannot revoke a stranger's session.**
`sessions` carries no tenant, so the membership check is the whole control. A session belonging to
another company's person is refused with the same message as one that does not exist, so the
refusal does not confirm the id (ADR-177).

**S-220 — Signing somebody out is attributed, reasoned and person-wide, and says so.**
A mandatory reason of at least four characters, a distinct action for a company revoke versus a
platform one, and `signedOutOfCompanies` recorded on the event. The drawer states in bold that the
person will be signed out of every company they belong to, before the button is pressed.

**S-221 — The Security Center's own exports are visible in it.**
`security.security_center_exported` is a first-class action, classified `Warning`, and is one of
the three actions the Data Exports view is built from. A test exports a view and then finds the
export in Data Exports — because the one export path a company could not see would be the one on
the screen that shows exports.

**S-222 — A guest cannot exist without an expiry, and the database is what says so.**
`guest_membership_has_an_expiry` makes `guest_access_expires_at` mandatory for an `ExternalGuest`.
The Security Center still handles and flags a missing expiry, as defence for a nullable column —
if that count is ever non-zero, something has gone wrong below the application and this is where it
should show. The test asserts the *refusal* rather than the badge, because the refusal is the
stronger guarantee.

---

**S-223 — No cross-tenant memory, and no setting that could create one.**
`memory_records` is tenant-owned with `FORCE ROW LEVEL SECURITY`, and `run_id` carries a composite
foreign key including `tenant_id` — so a record cannot reference another company's run. A test
attempts exactly that insert and the foreign key refuses it. There is no policy field for
cross-tenant sharing because there is nothing to set (ADR-182).

**S-224 — Cross-user memory needs company-wide visibility, enforced twice.**
§19's "never unrestricted cross-user memory" as a rule: `allowCrossUser` is false in every default,
and both `memoryPolicyProblems` and the check constraint
`cross_user_memory_needs_company_wide_visibility` refuse it on any narrower scope. Asserted through
the service *and* by updating the row directly.

**S-225 — Each of the four scopes confines what it claims to.**
Six tests: a run cannot read another run's ephemeral memory; an agent cannot read another agent's;
the same agent can read its own across runs; one person cannot read another's; two null Objectives
are never "the same Objective"; and expired or deleted records are never returned.

**S-226 — Classification controls persistence, not use.**
A mode refuses to *remember* data above its ceiling and says so in those words — the run may still
work with it. §19 makes classification the control over persistence and nothing more, and a message
that implied otherwise would send somebody to change the wrong setting.

**S-227 — An agent trying to remember what it may not is a governance event.**
A refused write is audited as `memory.write_refused` with the mode, the classification and the
reason, even though nothing was written. A refusal that left no trace is one nobody can act on.

**S-228 — Approved long-term memory cites a verified approval.**
`approved_long_term_record_cites_its_approval` requires the id, and the mode's policy cannot have
`requiresApproval` false — `approved_long_term_memory_requires_an_approval` refuses it. A verified
id rather than a boolean, for the reason Prompt 28 established: a boolean is a claim, an id is a
record.

**S-229 — A deletion removes the content and keeps the record of itself.**
`deleted_memory_keeps_no_content` and `memory_deletion_is_explained` together mean a deleted record
holds nothing, says when, and says why. An expiry does the same. Asserted at the database, not only
through the service (ADR-184).

**S-230 — No route writes a memory record.**
Remembering is an agent's act during a run, under the mode its published version declares. A person
writing one directly would be memory with no provenance, so no route exists — asserted with a 404
on `POST /memory/records`.

**S-231 — Rating an output cannot change what UBoss tests.**
`agents:Comment` to rate, `settings:Administer` to promote, and an Employee holds only the first —
asserted with a 403 on the promote route. `only_eligible_feedback_is_promoted` additionally refuses
promoting a `Correct` rating, at the database.

**S-232 — One rating per reviewer per run, and only your own to amend.**
A unique index refuses the second rating; the service refuses amending somebody else's. Two ratings
from one person would count twice in the quality figures, and a manager overwriting an employee's
judgement would make those figures a record of what management thinks rather than of what happened.

**S-233 — No correction, no negative rating.**
`negative_feedback_says_what_is_wrong` requires twenty non-blank characters for every rating but
`Correct`, using `length(btrim(COALESCE(...)))` — the fifth appearance of the NULL-valued-CHECK
lesson. A bare "Incorrect" tells an agent's owner that something failed and nothing about what.

**S-234 — Feedback never becomes provider training data, and no setting could make it.**
Asserted as an absence in two places (ADR-187). The stance is rendered on the rating drawer and on
the quality card, in the server's own words.

---

**S-235 — A live, paused, reviewed or closed version cannot be edited.**
`uboss_objective_version_is_immutable_once_live` now covers all six live-side states. Three probes
prove a `Paused`, `Closed` and `OutcomeReview` version each refuse a Form 2 edit with the trigger's
own message, and an e2e test proves it through the application role. Before this migration a
paused version was freely editable at the database level (ADR-190).

**S-236 — A version cannot be paused, reviewed or closed without having gone live.**
`live_objective_version_records_when` and `live_objective_version_was_approved` were both written
at Prompts 19 and 20 listing `('Active','Completed')`, and both now cover the three new states.
Without it a `Closed` version could exist with no publication and no approval — closed without ever
having been live.

**S-237 — Closure satisfies the policy that was in force when it was reviewed.**
The sign-off policy is stored on the review row, not read from the company at closing time, and
`closure_satisfies_its_sign_off_policy` refuses a closed row that does not carry what its own
policy requires. A company loosening the rule next quarter cannot retroactively justify a closure.

**S-238 — Only the objective's owner signs it off.**
The route gates on `View` because no permission can express "the owner of this particular
objective"; the service then requires the actor to *be* the owner. A signature from anybody else
would satisfy the letter of the policy while defeating it.

**S-239 — There is no route that reopens a closed objective.**
Reopening is `startNewDraft` — a new version under the versioning rule. A `reopen` route would be a
second way to do it, and §27.1 is explicit that a historical live version is never mutated. A test
walks close → new draft and asserts V1 is still `Closed` while V2 is `Draft`.

**S-240 — Every closure act is gated on a grant somebody actually holds.**
`objective:Pause` is granted on `agents` only, so a pause route gated on it would have been a 403
for every user in every company (ADR-195). A unit test now asserts every action this module uses is
held by some role template, and route-level tests prove the decorators rather than only the
service.

**S-241 — One review per objective version.**
A unique index. Two reviews of the same executed version would be two contradictory answers to
"how did this turn out", and the second would silently win in any report that took the newest.

**S-242 — A pause is attributed, reasoned, and at most one is open.**
A mandatory reason with a category, both ends attributed, resume-after-pause enforced, and a
partial unique index refusing a second open pause — two would make "is this paused?" a question
with two answers.

---

## Prompt 35 — Knowledge, files, classification and safe uploads

**S-243 — Nothing reads a file that has not been scanned clean.**
`fileIsUsable` returns true for `Clean` and nothing else, and the check sits at the top of every
read path — download, adding a file to a knowledge source, and the file list an agent receives —
rather than in one shared guard. A shared guard is a thing somebody later calls a method around.
`Quarantined` is separate from `Infected` on purpose: a scan that did not complete leaves a file
nobody should use *and* nobody should treat as proven malicious.

**S-244 — The upload allowlist is an allowlist, and the extension check is a second lock.**
A blocklist is a list of the attacks somebody thought of. `DEFAULT_ALLOWED_CONTENT_TYPES` is
documents, spreadsheets, presentations, PDFs, plain text and images, and deliberately excludes
archives — a scanner that unpacks archives has a much larger attack surface and UBoss has no reason
to accept one. `ALWAYS_REFUSED_EXTENSIONS` refuses `.exe`, `.ps1`, `.js` and sixteen others
**whatever content type is declared**, because the content type is supplied by the uploader and is
therefore a claim, not a fact.

A filename containing a path separator or `..` is refused rather than normalised. The storage key
is generated (`tenants/<id>/files/<uuid>`) and never derived from the filename, so the validator is
the second lock rather than the only one.

**S-245 — A refused upload is a security event.**
`security.file_upload_refused`, classified `Risk`/`Notice`/`Blocked`. Most refusals are somebody
attaching the wrong thing, which is why it is `Notice` rather than `Warning` — but the interesting
case is the person attempting `invoice.exe`, and it is in the trail with the filename and the
reason. Validation runs **before** the bytes reach storage, so a refused upload never becomes a
stored object with no row.

**S-246 — A download is an export, and the trail says so.**
`security.file_downloaded` was added to `SECURITY_EXPORT_ACTIONS`, so the Security Center's Data
Exports view — whose description already promised *"what left this company as a file"* — can finally
show it. Three gates in order: `settings:Export`, the scan, and the export ceiling.

**S-247 — A legal hold beats everything, in the service and in the database.**
`decideDeletion` refuses a held file, retention sweep skips it, and
`held_file_is_not_deleted` refuses the write. A hold exists precisely to stop a deletion every
other rule would permit, so the rule belongs where a bug cannot walk around it. Both directions are
audited with a mandatory reason: a hold nobody can explain is a hold nobody can lift.

**S-248 — A deletion is explained; attribution is optional.**
`file_deletion_is_explained` originally required `deleted_by_user_id`. That is right for a deletion
somebody asked for and wrong for the retention sweep, which is the policy acting rather than a
person — and the two ways around it were worse than fixing the constraint: writing the id of
whoever triggered the sweep is false attribution, and a sentinel user id is a fake person in a
foreign key. Attribution is now optional, the explanation is not, and a NULL author means UBoss
itself deleted the file under the policy named in `deleted_reason`.

**S-249 — The file inventory is not a `settings:View` screen.**
`settings:View` is on the Employee role template — it is what lets somebody open Settings and see
their own profile. A list of every document the company holds, with its classification and who
uploaded it, is a different thing: filenames alone leak a great deal, and the classification column
tells a reader which files are worth pursuing. Reading the inventory requires `settings:Administer`
**or** `settings:Approve` — CompanyAdmin or Approver, both real grants on real templates, neither
held by an Employee. An Approver needs it, because approving a knowledge source without seeing what
is in it is approving nothing.

**S-250 — Sensitive content that may leave is still refused, because nothing redacts.**
`decideEgress` separates the permission from the treatment. `mayLeaveTheCompany` refuses a transfer
whose `redactionRequired` is true, and says why. Answering "permitted" and leaving the redaction to
a caller that cannot redact is how a confidential document leaves intact because somebody was
allowed to send it.

**S-251 — A source never becomes more sensitive than its approval.**
A trigger refuses adding a file classified above its knowledge source, and the service refuses
lowering a source's classification below what its files already hold. Every read decision
downstream trusts the source's classification, so a source that quietly acquired `Restricted`
material would be a ceiling that no longer means anything.

**S-252 — The upload body limit is per-route, not global.**
A base64 upload needs roughly a third more than the configured maximum on the wire. Raising the
global JSON limit to that would let **every** route in the product buffer a third of a gigabyte from
an unauthenticated client. `main.ts` binds 1 MB everywhere and the larger limit only on the files
collection; the company's configured limit is then enforced against the *decoded* length, so a
client cannot understate the size.

**S-253 — The scan state a synchronous scan never occupies.**
A file moves from `Pending` straight to its verdict; the guard asks whether a scan may *start*, not
whether `Scanning` may be written. `Scanning` is in the vocabulary now rather than being added later
because the state becomes real the day the scan moves onto a queue, and a state added after the
fact is a state every existing CHECK and trigger has to be re-read for — the failure this schema
has already had twice (Prompt 25 agents, Prompt 34 objectives).

---

## Prompt 36 — Support, authorized support sessions and system health

**S-254 — Platform support holds no permission on any company module.**
The prompt's own requirement: *"Platform support staff must not automatically gain unrestricted
tenant content access."* `PlatformSupport` is granted `support: Administer`, `companies: View` and
`system-health: View`, and **nothing on any of the fourteen company modules**. That was already
true at Prompt 9; what this prompt adds is a test that iterates `COMPANY_MODULES` and asserts the
grant is empty for every one, so widening it becomes a test failure rather than a decision nobody
noticed.

The only route into a company is a break-glass session: a written reason, a verified identity,
approval by a second UBoss person, an explicit module and action scope, a hard expiry, and a
notification to the company.

**S-255 — A support session the company declined cannot be activated, and there is no bypass.**
Where a company's policy is `Required`, `decideSessionStart` refuses activation unless they
authorized, `declined_session_is_not_activated` refuses the row, and a declined session is
**terminal** — support does not get to wait for a different administrator to say yes, because that
turns a refusal into a poll. No emergency override exists: one would make the control advisory,
which is worse than not having it, because the company believes they are protected.

**S-256 — A blocked activation is recorded outside the transaction that refuses it.**
The gate originally ran inside `runAsPlatformOperation` and wrote its security event there, then
threw — so the event **rolled back with the refusal** and the control worked invisibly. A control
nobody can show a regulator is not a control. The e2e test caught it by asserting the event rather
than only the 403. The gate now runs in its own read before the transaction.

**S-257 — The customer status has no field an internal string can travel in.**
`CustomerVisibleStatus` originally carried a `title`, which the service filled from the alert's
`summary` — an operator's internal headline, in the test's own fixture *"db-primary-2 exhausted its
connection pool"*. That published a host name and an architecture detail to every company. A test
asserting on those words caught it.

The fix is structural rather than a sanitiser: the type no longer has a title or a summary, and the
query no longer selects `summary` or `detail` at all. The only free text a customer receives is
`customer_impact`, which `published_incident_has_customer_wording` requires an operator to write
before the incident can be published. A column that is never read cannot leak, and there is no
field left for a later edit to reintroduce one into.

**S-258 — An operator's note is internal by default.**
`support_ticket_notes.is_internal` defaults to true, and the company's read filters on it **in the
query** rather than after it. The two mistakes are not symmetric: a reply accidentally kept internal
is a slow answer, and an internal note accidentally shared is an operator's unguarded words in
front of a customer.

**S-259 — Raising a ticket is `settings:View`; authorizing UBoss access is `settings:Administer`.**
Reporting a problem is not an administrative act, and a product where only an administrator can
report one is a product where problems go unreported. Letting UBoss into the company's data is the
opposite, and takes the grant that governs the company's configuration.

**S-260 — A ticket cannot grant access.**
`AccessRequest` is a ticket *kind*. `break_glass_requests.support_ticket_id` links a session to the
ticket it came from, in that direction only — no amount of ticket activity widens anybody's access,
and the support ticket service takes no part in authorization beyond checking who may read a
ticket.

**S-261 — A new ticket cannot be parked on the customer.**
`New -> WaitingOnCustomer` is not a transition. Asking a company for more information means somebody
has read the ticket, which is what `Acknowledged` records; without that step a ticket nobody had
looked at could be marked as waiting on them, and the support queue would understate its own
backlog.

---

## Prompt 37 — Reporting and management dashboards

**S-262 — Reports do not widen anybody's access.**
Every report requires `reports:View` **and** the permission governing its source rows, and every
row is filtered to the scope the authorization engine would apply to those rows directly. The
filter is resolved on the server from the signed-in person's role assignments; no parameter a
client sends can widen it. `REPORT_SCOPE_STANCE` states this in the product's own words and the
Reports screen prints it.

**S-263 — Assuming `View` on the source module was a leak, and a test found it.**
The report definition originally carried a module and implied `View`. An Employee holds
`settings:View` — that is what opens Settings and shows their own profile — so **AI Usage & Cost
and Audit Activity were readable by every employee in every company.** Both now name the action
they need: `settings:Administer` and `settings:Audit` respectively. A unit test asserts an Employee
holds neither, and an e2e test asserts a 403 at each route rather than only their absence from the
catalogue.

**S-264 — An empty scope is nobody, not everybody.**
`ReportScope.userIds` is `null` only for a `WholeCompany` grant, produced in exactly one branch. A
`Department` grant held by somebody with no employment record resolves to `[]`, and every report is
then empty. The check is explicit and early in each query rather than relying on Prisma's treatment
of `{ in: [] }` — a security boundary that depends on a library's edge-case behaviour is a boundary
that can disappear in a version bump.

**S-265 — A withheld report is absent, not empty.**
An empty Approval Aging table tells a reader there is nothing waiting. That is a different and
wrong answer from "you may not see this", and the difference matters to somebody deciding whether
to chase an approval.

**S-266 — Exporting is a separate permission from reading.**
`reports:Export`, held by Manager, Head and CompanyAdmin. An Employee can read Approval Aging on
screen and is refused its export — both asserted through the API. The export is audited and the
read is not: ordinary reading would bury the trail, and data leaving the building is what an
investigation looks for.

**S-267 — Every CSV cell is neutralised against formula injection.**
A cell beginning `=`, `+`, `-` or `@` is executed by Excel and Google Sheets when the file opens,
and report cells carry free text a company typed. `csvCell` prefixes an apostrophe to every such
cell, and an e2e test seeds `=cmd|"/c calc"!A1` as an approval title and asserts the export escaped
it. `toCsv` emits only the declared columns, so a query selecting more cannot leak it into the
file.

**S-268 — A report cannot be used as an unbounded scan.**
A range longer than `MAX_REPORT_RANGE_DAYS` (366) is refused with a 400 rather than served slowly,
and every result is capped at `REPORT_ROW_LIMIT`. Both bounds are stated to the reader — a
truncated report says so — because a silent cap is a wrong answer presented as a complete one.

**S-269 — The dashboard cannot grow a third number.**
`DASHBOARD_ALLOWED_KEYS` is asserted as the **whole** key set of the response, not as keys that
must be present. The locked contract erodes by addition, so the test is written against addition.

---

## Prompt 37A — Portable UBoss Profile Search

**S-270 — The input is a UBoss Unique ID and nothing else.**
`isUbossUniqueId` validates the format before anything reads. An email, a name and a
twelve-digit Aadhaar-shaped number are all refused with a 400 saying a portable profile is found by
UBoss Unique ID *and by nothing else*. There is no name search, no email search and no "advanced
search", because a search that accepts those is a way to **enumerate** people rather than to verify
one. The requirement is stated as `PROFILE_SEARCH_INPUT_STANCE` so it cannot erode into a
convenience somebody adds.

**S-271 — Aadhaar is neither an input nor an output.**
Never a search key, never returned, and the e2e test greps the serialized response for the word.
`person_identifiers` is not read by this feature at all — not even the masked last four, which
exists for a person's *own* profile screen and has no business in another company's verification.

**S-272 — The projection is a whitelist, and the leak test greps rather than inspects.**
Three field lists, asserted against the response's own keys. Then a second test greps the
serialized JSON for every word in `NEVER_IN_A_PORTABLE_PROFILE` — `aadhaar`, `objective`, `task`,
`prompt`, `credential`, `connection`, `secret`, `file`, `email`, `phone` — **and** for the specific
values the source companies hold: the internal work email, the phone number, both employee ids and
the department name. A shape test passes the moment somebody nests a forbidden thing one level
deeper; a grep does not.

A unit test also asserts no *permitted* field name contains a forbidden word, so the grep cannot
start failing against a correct response and tempt somebody into weakening it.

**S-273 — Reading another company's employment history needs HR/Admin authority.**
`profile-search:View` **and** `users:Administer`. The first is on every role template and governs
the nav item; the second is the "Authorized HR/Admin" the approved documents name. An Employee with
the feature switched on is still refused, asserted through the API.

**S-274 — The capability is off until a company turns it on, and a settings failure keeps it off.**
`DEFAULT_PROFILE_SEARCH_ENABLED` is false, the refusal says it is a setting rather than a
permission, and `searchEnabledFor` returns **false** when the settings read throws — a settings
failure must never make a cross-company lookup *more* available than the company configured.

**S-275 — Each source company decides whether its performance travels, and `BadgeOnly` cannot leak a score.**
The sharing mode is read from the *source* company's settings, not the searcher's, and
`shareablePerformance` returns `score: null` under `BadgeOnly` **by construction**. A test passes a
score in and asserts it does not come out. One company choosing to share does not speak for
another: proved by a test where Beta shares and Alpha does not.

**S-276 — Every lookup is audited in the searcher's company, and only there.**
Including a lookup that found nobody — the audit row is written **before** the read, so a search
that 404s or throws is still on the record. "Who has this person been verifying" is the question
the trail exists to answer, and a failed search is as interesting as a successful one.

The row is written in the *searching* company's trail and a test asserts the two employers'
trails stay empty: a company must not learn who has been verifying their former employees.

**S-277 — Cross-tenant and IDOR.**
A searcher who puts another company's tenant id in the path is refused by the tenant guard before
anything reads. One company enabling the feature does not enable it for another. And the cross-tenant
read itself is confined to the narrow `select` of ADR-213 — the platform privilege buys access to
*those columns* and nothing else.

**S-278 — On-time percentage is null, not zero, when nothing had a due date.**
A person whose work carried no due dates has no on-time percentage, and 0% would read as "never on
time" — the opposite of the truth, on a screen somebody may use to decide whether to employ them.
The UI says "Nothing with a due date to measure" rather than showing a number.

---

## Prompt 38 — Company exit and data portability

**S-279 — Accountability survives a deletion, and a test proves it with row counts.**
The audit trail, the security trail, break-glass history, lifecycle transitions, role assignments,
custom roles, separation-of-duties policies, approval requests and decisions, the subscription, the
cost ledger, the credit grants and the wallets are all `Accountability` and all preserved. The e2e
test counts them before and after a real deletion. The audit trail is asserted to have **grown**,
because the exit is itself audited.

**S-280 — A person's record is not the company's to erase.**
Employment records, badge history, performance events and the departments they name survive. These
are what a portable profile reads (Prompt 37A), and `badge_history.is_exit_snapshot` exists
precisely so the badge somebody left with outlives their leaving.

**S-281 — Four independent gates before anything is deleted.**
`RetentionHold` state; the elapsed retention window; a **second person's** approval on the request;
and the company's identifier typed out. `exit_approver_is_not_the_requester` and
`deletion_respects_the_retention_window` enforce two of them in the database as well, because the
whole value of a retention window is that it cannot be skipped by a code path somebody adds later.

**S-282 — The self-approval refusal was rolled back with its own exception, twice.**
`recordWithinCurrentScope` inside `runAsPlatformOperation` followed by a `throw` discards the
security event with the transaction — so the control works invisibly. **This is the identical bug
S-256 fixed at Prompt 36, reintroduced here within the same session.** Both gates now run in their
own read before the transaction. The recurrence is the point: the pattern is easy to write and the
only thing that catches it is a test asserting the *event* rather than the 403.

**S-283 — The certificate carries evidence, including what could not be deleted.**
`deletion_manifest` holds per-table row counts for what went **and** `retainedByPrivilege` for the
six `Content` tables the application role cannot delete (ADR-219). A certificate saying only
"deleted" would be unfalsifiable; this one can be read against `TABLE_DISPOSITION` and checked. A
constraint refuses a `Deleted` row without a manifest, both counts, a timestamp and an author.

**S-284 — The typed confirmation is the company's slug, not `DELETE`.**
Case-sensitive and exact. `DELETE`, `delete`, the slug upper-cased and *another company's slug* are
each refused and each recorded as `security.company_exit_confirmation_failed` — four refusals
asserted in the test, because the interesting case is not a typo but somebody confirming against
the wrong company.

**S-285 — One open exit per company.**
A partial unique index on `state NOT IN ('Deleted','Cancelled')`. Two open exits would mean two
answers to "when is our data deleted", and the one a screen happened to read would win. Finished
exits accumulate as history, so a company that cancelled once can leave later.

**S-286 — A deleted exit cannot be cancelled, and a cancelled one cannot be deleted.**
`Deleted` and `Cancelled` are both terminal, `an_exit_is_not_both_deleted_and_cancelled` refuses the
combination, and `decideCancellation` explains that deletion is the one genuinely irreversible step
in UBoss — which is why the window before it is sixty days by default.

**S-287 — The export is not a database dump.**
It carries the company's own records as structured data, including its audit trail. It excludes
file bytes (downloaded individually, where the scan and export-ceiling checks apply), connection
credentials (a secret never leaves UBoss), the security trail (cross-tenant identity events
belonging to the platform plane), and anybody's Aadhaar. The exclusions are stated **in the
manifest**, so nothing is discovered on opening the archive. A test asserts the package contains no
work email address: those live on `users`, a shared platform table, and a company's export is not a
route to its people's contact details.

**S-288 — Every other company is verified untouched after a real deletion.**
Checked rather than assumed. The deletion runs as a **platform operation** — precisely the context
in which Row-Level Security protects nobody — so the second company's agents, notifications, audit
rows, employment records, memberships and lifecycle state are all asserted unchanged afterwards.

**S-289 — A legal hold blocks a company exit, not just retention.**
Prompt 35 set the rule in its strongest form: *"a legal hold beats everything — not by retention,
and not by request"* (S-247). A company exit is a request, and emptying `files` would have deleted
held files — a direct contradiction of a locked rule, and one the first version of this suite did
not check. It is now a **refusal rather than a skip**: any file under an unlifted hold stops the
whole deletion and the message names the count. Deleting everything except the held files would
leave a company half-erased under a certificate implying otherwise.

The gate covers files because files are the only records in the product carrying a per-record hold.
If a later prompt adds one elsewhere, this gate will not consult it unless somebody extends it —
recorded as a limitation, because nothing reminds them.

---

## Prompt 39 — Observability, metrics, tracing and the incident workflow

**S-290 — A metric carries no identity, and the allow-list is enforced rather than trusted.**
`metricLabelsArePermitted` refuses any label not on the metric's list, and a unit test asserts no
permitted label matches `FORBIDDEN_METRIC_LABELS` — no tenant, user, run, email or provider
anywhere. An e2e test records an observation with a `tenant_id` label and asserts **nothing was
recorded and the drop was counted**. Dropped rather than thrown: a metric must not be able to fail
the request it measures.

**S-291 — `/metrics` is unauthenticated, which is only safe because of S-290.**
A scraper holds no session, so the endpoint sits outside `@RequirePermission` rather than growing a
second authentication mechanism for one route. It is still `@PlatformOnly`. Network-level
restriction is a deployment concern the application cannot enforce, and the runbook says so instead
of implying otherwise.

**S-292 — `provider_errors` is labelled by logical profile, never provider name.**
The locked rule is that provider names do not leave the Model Gateway. A metric label is exactly
where one would leak onto a shared operations dashboard, and a test asserts `provider` is absent
from the allow-list while `profile` is present.

**S-293 — Log fields and span attributes are redacted, and separators no longer defeat it.**
`logFieldIsForbidden` strips non-alphanumerics from both sides, so `apiKey`, `api_key` and
`API-KEY` all match one entry. The first version compared lowercased strings and **missed
`API_KEY` entirely** — a unit test caught it. Log fields are written in every casing convention a
codebase has ever had, and a redaction list that catches one of them leaks.

Span attributes go through the same pass: a span attribute is a log field by another name, and it
ends up wherever spans end up — which one day is a third party's console. What neither protects is
a secret interpolated into a message string; only review catches that, and the runbook says so.

**S-294 — Redacted, not deleted.**
A silently absent field looks like a bug in the producer. `[redacted]` tells a reader something was
withheld deliberately.

**S-295 — The correlation chain now reaches the money, which is a disclosure decision as well as an operability one.**
One id links a request to the run, the provider call and the cost ledger entry. That makes "what did
this click spend" answerable — and it is deliberately an *internal* join: the id appears in no
customer-facing payload, and the customer status endpoint projects `customer_impact` alone (S-257).

**S-296 — A tracer that exports nothing reports `exportsSpans: false`.**
Asserted by a test. `OpenTelemetryTracer` refuses every call rather than silently succeeding, and
is not bound. The worst of the three options would be a tracer that appeared to export and exported
nothing, because an incident is when somebody discovers it.

**S-297 — An alert fires once per problem, not once per evaluation.**
Idempotent against the row rather than against remembered state (ADR-226), so a restart during an
outage cannot lose the fact that anybody was told. Asserted by evaluating twice and checking one
row.

**S-298 — A P0 or P1 cannot be closed without a postmortem and a timeline.**
In the service and in `serious_incident_is_post_mortemed_before_resolving`, because *"we'll write it
up later"* is the pressure this resists and later never comes once the incident is off the board.
A P2 may close on its mitigation alone. Asserted both ways.

**S-299 — Dropping a corrective action needs a reason; completing one does not.**
`dropped_action_says_why` enforces it. Doing what you said needs no explanation; deciding not to is
the decision somebody will be asked about — and an unowned or undated action is refused outright,
because a postmortem full of actions nobody agreed to do is the commonest way an incident process
becomes theatre.

**S-300 — The rate limiter fails *open*, and that is a decision rather than a catch block.**
Everywhere else in UBoss the rule is fail-closed: an authorization check that cannot reach the
database refuses. This one is the opposite. The reasoning is about what each control protects — a
failing authorization check that let a request through would expose a customer's data, whereas a
failing rate limiter that let a request through removes a protection against *load*. Failing closed
would mean a Redis blip takes the entire API down for every customer, converting a capacity
protection into the outage it exists to prevent. Counted (`failures()`) and reported, so a degraded
limiter is visible rather than assumed. Asserted against an unreachable broker.

**S-301 — Limits are keyed by identity, not by IP address.**
`X-Forwarded-For` is set by whatever is in front of the application and can be forged when nothing
is, so an IP limiter here would be a control whose strength depended on infrastructure this code
cannot see. `WAF_ASSUMPTIONS` states plainly that TLS, malformed requests and volumetric protection
are the proxy's job and that UBoss does none of them — and that if there is no proxy, that job is
nobody's. An honest boundary beats a control that appears to cover more than it does.

**S-302 — An idempotency key is unique per actor, never globally.**
`idempotency_key_is_unique_per_actor` is `(scope_key, user_id, key)`, and every read filters by all
three. A global key space would let one customer send another customer's key and be handed their
stored **response body** — idempotency would become a cross-tenant read primitive rather than a
safety net. `scope_key` exists precisely so the uniqueness can be stated without a NULL in it: a
nullable `tenant_id` in a unique index makes every platform-plane row distinct from every other, and
Postgres would accept a duplicate key. Asserted by two people sharing a key and each getting their
own answer.

**S-303 — `idempotency_records` gets the strict RLS policy, not the shared one.**
`provider_profiles` admits a NULL-tenant row to a tenant reader, because there a NULL row is shared
platform *configuration* with no company data in it. This table is the opposite: a NULL-tenant row is
a platform operator's own request and response. `NULL = <tenant>` is NULL, which fails the policy —
so the strict form is also the fail-closed form, and a platform-plane record is reachable only inside
a platform operation. Asserted by reading the table in another company's scope and getting nothing.

**S-304 — A reused key with different content is refused, not answered.**
Answering with the first response would silently discard the second request, which is the failure
idempotency exists to prevent rather than cause. Recorded as `idempotency_key_reused` because it is
the one outcome that is *not* a retry: either a client is generating keys wrongly — in which case
somebody's requests are being discarded somewhere — or somebody is probing what a replay does.
Recorded **outside** any transaction, so the refusal cannot roll its own record back (the mistake of
S-256 and S-282).

**S-305 — A rate-limit refusal is recorded once per identity per five minutes, not once per refusal.**
A throttled client produces thousands of 429s a minute. A row each would bury the rest of the
security trail under the noisiest caller in the product — the trail would become less useful exactly
as it became more needed. The metric `rate_limit_refusals` carries the volume and the
`abuse-suspected` rule watches it; the trail carries the fact, once. Asserted by five refusals
producing one row.

**S-306 — Three routes are never rate-limited, each for a stated reason.**
`/health` (a load balancer probes it constantly, and rate-limiting the probe would take the service
out of rotation under exactly the load the limit exists to survive), the metrics scrape (losing
observability during an incident is the worst time to lose it), and sign-out (a person unable to end
their own session is a security problem, not a capacity one). **Sign-in is deliberately not on the
list** — it has its own lockout from Prompt 5, and that throttle is the point. `routeIsUnlimited`
matches a route or a path under it, not a prefix, so `/healthcheck-internal` is limited; asserted.

**S-307 — A throttled request does not claim an idempotency key.**
The limiter is registered as the outer interceptor. A key claimed by a request that was never served
would be found in flight by the client's retry — forever, since nothing would ever complete it.
Asserted by throttling a keyed POST and checking no record exists.

**S-308 — An expired idempotency key is usable again, and this was a real defect.**
The read treats an expired record as absent, but the row remains, so the insert tripped the unique
index and the caller was told `InFlight` by a request that finished last week — a key unusable
*forever* rather than for twenty-four hours. Found by the test that reuses a key after its window.
`begin` now clears the expired claim for that exact key in the same transaction as the new one.

**S-309 — A provider name never leaves the Model Gateway, including through the throttle.**
`ProviderThrottleService.snapshot()` reports provider **model ids** and a failure reason, never a
vendor name, and `GET /platform/limits/providers` serves exactly that. A status endpoint is precisely
where a provider name would leak into a dashboard. Asserted by searching the serialised snapshot for
vendor names.

**S-310 — A nonsense configured limit falls back rather than applying.**
A typed `0` in `limits.api_requests_per_user_per_minute` would refuse every request in the product
from every customer — a total outage produced by one keystroke in a text field. `limitProblems`, the
same validator the unit tests use, rejects it and the code default applies, with a warning. Asserted
by setting zero and getting a served request.

# CR-03 (Prompt 40A)

**S-311 — A standard Employee cannot reach Objective Optimization or Agent Builder, by the same
absent grant that hides them.**
`visibleModules` is derived from whichever modules a person holds any grant on, so removing
`objective` and `agent-builder` from the Employee template hides the screens *and* makes the route
guard refuse. Hidden navigation is presentation only — here there is nothing to keep in step,
because the presentation reads the same fact the guard does. Asserted both ways: the published
permission matrix omits both modules, and `GET /objectives` returns 403 to a standard Employee.

**S-312 — An administrator cannot grant what they do not hold, or grant above their own tier.**
Two rules, and the second is the one people forget: holding one Build capability is not a licence to
hand out every Build capability. Enforced before any row is written and **outside the transaction**,
so a refusal cannot roll back the security event recording it — the mistake of S-256 and S-282, not
made a third time. A refused delegation writes `permission_denied` with the refused keys.

**S-313 — Nobody may change their own capabilities.**
Refused even where the delegation rule would allow it, and recorded as
`separation_of_duties_blocked`. Somebody widening their own access is the one case where "you
already hold it" is not reassurance.

**S-314 — A granted capability never widens scope.**
Every capability grant is written at `OwnWork`, and the custom role's own `maxScope` is `OwnWork`
as well. A Power Employee builds their *own* assigned work and nobody else's; somebody who needs
wider reach gets a role, which is a more visible decision. Asserted by reading the effective scope
back after granting two Build capabilities.

**S-315 — Being the operator of an agent grants nothing else.**
`builtForUserId` and `EngineAgentOperator` are not permissions. A shared agent can be run and
cannot be read as configuration: after a share, the employee still holds no `agent-builder` grant
and the module is still absent from their visible list. Asserted directly, because this is the
sentence the whole amendment exists to make true.

**S-316 — A run refusal names the assignment first, so it leaks nothing.**
`RUN_PRECONDITIONS` is ordered and `Assignment` is first. Somebody with no share must not learn
from the message whether the agent is approved, what it connects to, or whether the company has run
out of budget — checking budget first would leak a customer's commercial state to anybody who
guessed an id. Asserted by failing four preconditions at once and greping the message for
"budget", "approval", "connection", "expired" and "version".

**S-317 — An operator's screen carries no prompt, model, key or configuration.**
`OPERATOR_VIEW_FIELDS` is a closed list and `NEVER_IN_AN_OPERATOR_VIEW` is greped against the
serialised response. A screen built for somebody who cannot open Agent Builder must not print Agent
Builder's contents.

**S-318 — A downloaded Job Method form is checked for secrets on the way out.**
`exportLeaks` runs on the produced form every time, over the context *and* every cell, with
separators stripped — the same gap that let `API_KEY` through a forbidden-field check at Prompt 39.
A refusal rather than a redaction: quietly stripping something forbidden out of a company's own
Form 2 text would hide a real problem in their data. The form carries the company's own Employee ID
and **never** a UBoss Unique ID: this file is forwarded by email, and a portable cross-company
identifier would travel with it.

**S-319 — An uploaded form is refused before its cells are read.**
`IMPORT_STAGES` puts `ValidateFile` then `VerifyLinkage` ahead of `ParseRows`, and the order is
the safety property: once cells are read into fields, a wrong mapping looks exactly like a
filled-in form. A file from an unreadable form version, for a different assignment, or from a
superseded objective version is refused with nothing saved. Asserted, including that no rows exist
afterwards.

**S-320 — An upload never tests and never activates.**
`AUTOMATION_STANCE`, asserted by counting runs and checking `lastTestedAt` before and after. A
spreadsheet must not be able to put an agent into production.

**S-321 — A photo is authorized by the photo rule, not by the Knowledge & Data grant.**
Yours always; somebody else's needs `users:EditDraft`. `FileService` grew
`uploadAuthorizedElsewhere` / `deleteAuthorizedElsewhere` rather than loosening its own gate,
because widening `settings:EditDraft` would have handed every employee the company file store.
The legal-hold refusal is not bypassed. A photo is not served until a scan clears it, falling back
to initials — indistinguishable from "no photo", so it says nothing about what the scanner did.
Asserted that one employee cannot change another's photo, and that removal deletes the bytes rather
than only the pointer.

**S-322 — Chat membership grants no access to anything a conversation refers to.**
The reference is a type and an id; every preview is resolved against the **viewer's** own
permissions, at read time, on the **row** as well as the module. Asserted by two people in one
conversation seeing different answers for the same reference, and by greping the restricted
viewer's whole response for the objective's name. Losing access removes the preview with nobody
editing the conversation.

**S-323 — You cannot link something you cannot see yourself.**
Otherwise anybody could attach an arbitrary id and wait for a colleague with access to open the
conversation and render the preview — using somebody else's permissions as an oracle. Checked at
attach time *and* at every read, so losing access afterwards is also covered. Asserted, including
that no row is stored on refusal.

**S-324 — Chat search never reaches a conversation you are not in.**
The same escalation as an unchecked preview wearing a different hat, and far easier to run. Scoped
to the searcher's own participant rows; attachment *contents* are not searched at all.
`SEARCH_STANCE` says so. Asserted with a secret word in a conversation the searcher is not in.

**S-325 — A chat attachment is an ordinary file, and an uncleared one cannot be opened.**
Same store, same limits, same scan, same audit. The message still shows that something was
attached — hiding it would make the conversation misleading, and serving it would make chat the way
malware moves around a company.

**S-326 — Chat has no permission module, and a non-participant gets `NotFound`.**
A `chat:View` grant would let somebody be given access to everybody's conversations. `Forbidden`
would confirm a conversation exists and that these particular people are talking. An administrator
who needs a conversation goes through break-glass, which is recorded and tells the customer.

**S-328 — A person can always see their own reward awards.**
The CR-03 narrowing broke this by removing the `objective:View` grant the route happened to be
gated on. Re-gated on `performance:View` (ADR-250), which is what a reward award actually is. The
row-level check on somebody *else's* awards is unchanged, and it is what has always done the
restricting — the module grant was never keeping anybody out.

**S-327 — Ordinary chat messages are not audited; structural changes are.**
An audit trail holding every message would be a second copy of every conversation in the one table
designed never to be deleted. Starting a conversation and linking a context *are* audited, because
they change who can see what — and the conversation's audit row records the participant **count**,
not the list, because an audit trail is read by people who are not in it.

**S-331 — A two-column page collapses on a phone rather than scrolling sideways.**
Not a security finding, recorded here only because it was found the same way as S-329 and S-330 —
by opening the screens. Agent Builder forced a 400px viewport 534px wide. See ADR-258.

**S-330 — Every modal in the product accepted one character per click.**
`useFocusTrap` depended on `onClose`, which every caller passes as an inline arrow, so the effect
re-ran on every render and re-focused the first control. Typing a work email, a suspension reason or
an issue correction produced a single letter. Not an authorization fault, but a usability fault
severe enough to make people abandon the confirmation gates on dangerous actions — and one that 112
passing design-system tests did not catch because none typed more than one character. Fixed by
holding `onClose` in a ref (ADR-257); two regression tests now type a sentence.

**S-329 — The operator's Run button and the run route now answer the same question.**
`assertMayRun` existed with no caller. The operator screen enabled Run from `mayRun`; the route
decided from ownership and answered 404, because a manager-built agent is owned by the manager while
the employee is capped at `OwnWork`. Every test that covered the share asked the service, so nothing
failed — the one path CR-03 exists to create was never driven end to end.

The route now consults the live share and delegates to `assertMayRun`, which records a security
event for an unshared attempt. What the share does **not** confer is as important: not `agents:Run`,
not scope, and not `Pause` — cancelling a run in flight is the authority to stop somebody's work.
See ADR-251.

The general lesson: **a rule enforced in a service and a rule enforced by a route are two different
claims.** The CR-03 suite now drives its three controllers directly, and the run route is driven
over HTTP as the operator.

**S-332 — A backup is never taken as the application role.**
`uboss_app` is `NOBYPASSRLS`. A dump taken as it would silently omit every tenant row it cannot
see, producing a backup that restores into an empty database and exits zero at every step.
`pg-backup.sh` refuses the connection string outright rather than trusting whoever invokes it.

**S-333 — A restore verification checks that tenant isolation survived.**
RLS policies, `FORCE ROW LEVEL SECURITY` and the `uboss_app` grants are schema objects and a
restore can lose them. A restored database serving every tenant to every reader would pass every
other check in the list. The drill counts policies and forced tables against the number of
tenant-scoped tables — 104 and 104 against 103 in the run recorded in `infra/backup/evidence/`.

**S-334 — A verification never runs against production.**
`environmentIsSafeForRestore` is an allow-list, and `pg-restore-verify.sh` refuses any database
whose name is not `uboss_restore_check_*`. A "verification" that restored over live data would be
the disaster it exists to prevent. The scratch database is dropped in a `trap`, so it goes even
when the drill fails — a forgotten restore is an unmonitored copy of customer data.

**S-335 — A restored database is unreadable without its encryption keys, and the drill says so.**
Connection credentials and provider keys are stored encrypted with keys held outside the database,
so a recovery that restores PostgreSQL and not the key material gives a company its objectives back
and none of its integrations. `CheckKeys` is a drill step and **fails** rather than warns when no
key is available: a drill that passed without it would be a failed recovery wearing a success
message.

**S-336 — The application cannot take or restore a backup, deliberately.**
It holds no owner credentials. `RecoveryService` reports and the scripts act, so there is no route
through which a compromised application session could dump the database — and no table the API can
write to make itself look recoverable.

**S-337 — The product does not claim disaster-recovery readiness.**
`RECOVERY_CLAIM_STANCE` is served verbatim and asserted by a test that checks even a *fresh*
verified restore does not produce a "ready" flag. Most of DR — archiving, replication, key custody,
DNS failover — is configured where UBoss runs, and `DEPLOYMENT_RESPONSIBILITIES` names all of it so
a green status cannot be read as more than it is.

**S-338 — Hostile context is sent to the provider verbatim, and that is the safe choice.**
UBoss does not strip or rewrite what a customer's document says. The defence against prompt
injection is that the instruction and the context reach the provider as different turns (ADR-267),
not that the context has been sanitised — a filter is a defence that can be phrased around, and
redacting an instruction-shaped sentence out of a genuine compliance document would corrupt the
work. A test asserts the content arrives unedited, so a future "safety" filter cannot be added
without someone deciding to delete that test.

**S-339 — No caller may build a model instruction out of data.**
The invariant that makes S-338 safe. If an instruction were assembled from a Job Method cell, an
uploaded document or a chat message, the separation of turns would protect nothing — the untrusted
text would already be in the trusted half. Enforced by a scan over every `instruction:` in the API,
verified against a deliberately introduced violation.

**S-340 — The auth surface has no route to public signup, and this is now checked rather than
remembered.**
UBoss companies are provisioned, never self-served. The rule was verified **by hand at Prompt 2**
and recorded as a manual check; nothing re-checked it for forty prompts. It is now asserted across
every route a signed-out person can reach, along with the rule that none of those routes strands a
person — each offers a way back to sign-in and forward to help.

**S-341 — Naming the tenant in a query is a performance measure, not a security one, and must not be
mistaken for either alone.**
Row-Level Security is what confines every tenant-scoped read, and Prompt 43 changed nothing about
that. The eight queries that gained a `tenantId` predicate were already correct: the policy allowed
exactly the rows they returned, and the added predicate is redundant by construction.

Recorded here because the inverse reading is dangerous in both directions. Somebody who believes the
predicate is what provides isolation will eventually write a query without it and think they have
opened a hole — they have not, they have written a slow query. And somebody who removes RLS because
"the queries name the tenant anyway" would remove the only thing that actually enforces it. See
ADR-271.
