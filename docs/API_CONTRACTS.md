# API Contracts

Every endpoint is recorded here with its auth requirement, tenant scoping and response shape.

**Base URL:** `http://localhost:4000` in development (`API_PORT`, `API_HOST`).
**Shared types:** `@uboss/types` — the contract is defined once and imported by both producer and
consumer, so a change that breaks the web app fails at compile time rather than at runtime.

## Conventions

- Responses are JSON. `Content-Type: application/json; charset=utf-8`.
- A global `ValidationPipe` runs with `whitelist: true` and `forbidNonWhitelisted: true`, so any
  request body property not declared on a DTO is **rejected**, not silently ignored. This is
  deliberate: it prevents a future endpoint from accepting a browser-supplied `tenant_id` or role.
- Tenant context is derived from authenticated membership server-side. No endpoint will accept a
  tenant identifier from the client as its authorization basis.
- Security headers are applied by `helmet`. `X-Powered-By` is disabled.
- CORS is closed by default and enabled only for the origins listed in `API_CORS_ORIGINS`.

---

## `GET /health`

Liveness/verification endpoint. **Unauthenticated by design** and therefore deliberately free of any
tenant, actor or configuration detail.

**Auth:** none. **Tenant scope:** none.

**200 OK**

```json
{
  "status": "ok",
  "service": "uboss-api",
  "version": "0.1.0",
  "timestamp": "2026-09-08T09:11:53.129Z",
  "uptimeSeconds": 2,
  "dependencies": [{ "name": "postgres", "status": "up", "latencyMs": 3 }]
}
```

| Field           | Type                            | Notes                                                                                                                                                                                        |
| --------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`        | `'ok' \| 'degraded' \| 'down'`  | `ok` when every dependency is up; `degraded` when one is down. `down` is never self-reported — the process is up if it answered — and is reserved for an external probe that cannot reach us |
| `service`       | `'uboss-api'`                   | Literal. Makes a misrouted reverse proxy obvious                                                                                                                                             |
| `version`       | `string`                        | Read from the API's own `package.json`; falls back to `0.0.0-unknown` rather than failing                                                                                                    |
| `timestamp`     | `string`                        | ISO-8601 UTC                                                                                                                                                                                 |
| `uptimeSeconds` | `number`                        | Whole seconds, non-negative integer                                                                                                                                                          |
| `dependencies`  | `DependencyHealth[]` (optional) | Added at Prompt 3. Optional, so a client built against the earlier contract keeps working                                                                                                    |

`DependencyHealth`:

| Field       | Type                | Notes                                                                                                                                                             |
| ----------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | `string`            | e.g. `'postgres'`                                                                                                                                                 |
| `status`    | `'up' \| 'down'`    |                                                                                                                                                                   |
| `latencyMs` | `number`            | Probe duration                                                                                                                                                    |
| `reason`    | `string` (optional) | Short failure summary when `down`, e.g. `'ECONNREFUSED: PrismaClientKnownRequestError'`. **Never** a connection string, username or password — asserted by a test |

The database probe is `SELECT 1` with a **2-second timeout**: a hung database must degrade the
endpoint, not hang it, or it takes the load balancer's health check down with it.

**Errors:** none. Unknown routes return `404`.

**Consumer contract:** `isHealthResponse(value: unknown): value is HealthResponse` in `@uboss/types`
narrows an untrusted body. `apps/web` uses it and renders a distinct state when the shape does not
match, rather than trusting the response.

**Planned evolution:** Redis and BullMQ (Prompt 21) will add their own entries to `dependencies`
without changing any existing field. The `dependencies` array was introduced additively for exactly
this reason — a consumer written against the Prompt 1 contract still validates.

---

## Tenancy contract (applies to every route)

Added at Prompt 4. There are still no tenant-scoped _endpoints_ — this is the contract they will
follow, enforced globally by `TenantGuard`.

### Request headers

| Header                                 | Purpose                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-correlation-id` (or `x-request-id`) | Optional. Honoured only if it matches `^[A-Za-z0-9._:-]{1,64}$`; otherwise a UUID is generated. Always echoed back as `x-correlation-id`                                                          |
| `x-uboss-workspace`                    | Selects the company workspace for a tenant-scoped route. A route parameter `:tenantId`/`:workspaceId` takes precedence. **A request, not a credential** — it is only used to look up a membership |
| `x-uboss-dev-actor`                    | Development and testing only. Ignored unless `AUTH_DEV_HEADERS_ENABLED=true` and `NODE_ENV` is not `production`                                                                                   |

### Response headers

| Header             | Always                              |
| ------------------ | ----------------------------------- |
| `x-correlation-id` | Yes, including on 401/403 responses |

### Route policies

Every route must declare one, or it is refused:

| Decorator           | Meaning                                          |
| ------------------- | ------------------------------------------------ |
| `@AllowAnonymous()` | Public. Currently only `GET /health`             |
| `@PlatformOnly()`   | UBoss Master Console actors only                 |
| `@TenantScoped()`   | Requires a verified company-workspace membership |

### Status codes

| Code  | When                                                                                                                                                                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` | No authenticated principal on a non-public route                                                                                                                                                                                                                                                         |
| `403` | Route has no tenancy policy; or a company person hit a platform-only route; or a platform actor tried to act inside a company workspace; or the workspace is missing, malformed, or not one the caller is a member of; or the company's lifecycle state blocks access (or blocks writes, for `ReadOnly`) |

**Deliberate indistinguishability:** requesting a workspace that does not exist and one the
caller is not a member of return the **same** 403 body, so the API is not a tenant-existence
oracle.

---

## Authentication (Prompt 5)

Every route below lives under `/auth` except the invitation-administration routes under
`/invitations`. Sessions are **opaque and server-side**: the cookie carries a random token, the
database stores only its SHA-256 hash, and no endpoint can return a token or a password.

**Session cookie.** `uboss_session` — `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` whenever
`NODE_ENV=production` or `AUTH_SECURE_COOKIES=true`. `Expires` is the session's **absolute**
expiry, not its idle window, so the browser never holds a cookie the server would refuse.

**Two expiry rules, both enforced server-side on every request:** idle (default 30 minutes since
`lastSeenAt`) and absolute (default 12 hours since creation). Whichever fires first ends the
session. A client cannot extend either.

### `POST /auth/login`

**Auth:** none. **Tenant scope:** none.

Request: `{ "email": string, "password": string }`

**200 OK** — sets the session cookie.

```json
{
  "user": {
    "ubossUniqueId": "UB-NEW1-0001",
    "displayName": "New Joiner",
    "isPlatformActor": false
  },
  "workspaces": [
    {
      "tenantId": "01a08098-fcf4-761d-86d2-dca250952877",
      "tenantName": "Demo Company",
      "lifecycleState": "Active"
    }
  ],
  "newDevice": false
}
```

`workspaces` is for the workspace picker only. The tenant guard still verifies membership on
every subsequent request, so this list is never the authorization.

`newDevice` is true when this person has not been seen from this **coarse network hint** before
(a /16 or /48 prefix, never a full address). It is deliberately not keyed on the user-agent
string, which changes on every browser update and is trivially forged.

| Code  | When                                                                       |
| ----- | -------------------------------------------------------------------------- |
| `401` | Unknown email, no password set, or wrong password — **one identical body** |
| `401` | Account locked. Carries a `Retry-After` header in seconds (e.g. `900`)     |
| `400` | Malformed or missing fields                                                |

**Deliberate indistinguishability:** an unknown address and a wrong password return the same
message _and_ take the same time — a dummy Argon2id verification runs when no credential exists,
because otherwise the ~1 ms vs ~50 ms difference is itself an account-enumeration oracle. Lockout
_is_ reported distinctly: someone whose account is locked has to know in order to act, and the
lockout is what makes the enumeration useless anyway.

### `POST /auth/logout`

**Auth:** the cookie, not the resolved actor — so signing out works, and still clears the cookie,
when the session has already expired. **204 No Content**, always, whether or not a session existed.

### `GET /auth/me`

**Auth:** authenticated (no workspace required).

```json
{
  "user": { "ubossUniqueId": "UB-NEW1-0001", "isPlatformActor": false },
  "workspaces": [{ "tenantId": "…", "tenantName": "Demo Company", "lifecycleState": "Active" }],
  "activeWorkspaceId": null
}
```

`activeWorkspaceId` is non-null only when the request also carried a valid `x-uboss-workspace`;
a person-level call has no active workspace, which is correct rather than missing.

### `GET /auth/sessions`

**Auth:** authenticated. Returns the caller's **own** sessions only.

```json
{
  "sessions": [
    {
      "id": "01a080c7-f40b-733c-bf49-7486c2457cd2",
      "deviceLabel": "Chrome on Windows",
      "clientHint": "127.0.0.0/16",
      "createdAt": "2026-09-08T11:29:42.924Z",
      "lastSeenAt": "2026-09-08T11:29:42.924Z",
      "absoluteExpiresAt": "2026-09-08T23:29:42.920Z",
      "isCurrent": true
    }
  ]
}
```

`deviceLabel` and `clientHint` are nullable. `clientHint` is always a truncated prefix — a /16
for IPv4, a /48 for IPv6 — enough to recognise "that was not me", not enough to be a location
history. No token, hash or session secret appears in this response.

### `DELETE /auth/sessions/:sessionId`

**Auth:** authenticated. Revokes one of the caller's **own** sessions. **204 No Content.**

`403` when the session is not the caller's — **identical** to the response for a session id that
does not exist, so the endpoint cannot be used to probe for other people's session ids. Revoking
the current session is allowed and signs this browser out.

### `POST /auth/logout-all`

**Auth:** authenticated. Revokes every session for the caller, keeping the current one.

```json
{ "revoked": 3, "keptCurrentSession": true }
```

`keptCurrentSession` is false when the calling session had itself already expired; the cookie is
then cleared, so the browser is left signed out rather than holding a dead cookie.

### `POST /auth/invitations/preview`

**Auth:** none — the activation screen has to describe an invitation before anyone is signed in.

Request: `{ "token": string }`

**200 OK**, valid: `{ "valid": true, "displayName", "email", "tenantName", "hasExistingPassword" }`

**200 OK**, anything else: `{ "valid": false }` — one answer for expired, cancelled, already used
and never-existed, so a token cannot be probed for which kind of wrong it is.

`hasExistingPassword` tells the screen not to ask for a new password: one UBoss identity keeps one
password across every company that invites it.

### `POST /auth/invitations/activate`

**Auth:** none (the token _is_ the proof). Sets the session cookie on success.

Request: `{ "token": string, "password"?: string }` — `password` is required when the person has no
UBoss password yet and **refused** when they already have one.

**201 Created**: `{ "activated": true, "activeWorkspaceId": "…" }`

| Code  | When                                                                                   |
| ----- | -------------------------------------------------------------------------------------- |
| `400` | Password shorter than `AUTH_MIN_PASSWORD_LENGTH` (12). The invitation is **not** spent |
| `401` | Token invalid, expired, cancelled or already used — one identical body                 |

The password policy is checked _before_ the transaction, so a rejected password rolls back and
the activation link still works. Verified by test.

### `POST /auth/password-reset/request`

**Auth:** none. **202 Accepted**, always:

```json
{
  "accepted": true,
  "message": "If that address has a UBoss account, a password reset link has been sent to it."
}
```

The same body for a real and an unknown address, and **no token in the response** — the link is
delivered out of band. Capped at 5 requests per hour per identity.

### `POST /auth/password-reset/confirm`

**Auth:** none (the token is the proof). Clears the session cookie.

Request: `{ "token": string, "password": string }`

```json
{
  "reset": true,
  "sessionsRevoked": 2,
  "message": "Your password has been changed and you have been signed out everywhere."
}
```

A completed reset revokes **every** session, including this browser's: if someone else had the
old password, leaving their session alive would defeat the reset. `401` for an invalid, expired or
already-used token, again with one message. Single-use is enforced in the same transaction that
writes the new hash.

### `DELETE /auth/admin/sessions/:sessionId`

**Auth:** platform actor (`@PlatformOnly`). **204 No Content.** `403` when the session cannot be
revoked — the same body whether it does not exist or is out of scope.

This is the **interim** authority. Company-admin session revoke needs the role model, which
arrives at Prompt 7; granting it now would mean either letting every company member revoke
colleagues' sessions or inventing a role check Prompt 7 would immediately replace.

### `POST /invitations`

**Auth:** platform actor (interim, as above). **201 Created.**

Request: `{ "tenantId": uuid, "email": string, "displayName": string }`

```json
{
  "invitationId": "01a080c7-d259-72cb-bf4c-c265464239f4",
  "activationToken": "<returned exactly once>",
  "expiresAt": "2026-09-11T11:29:34.265Z",
  "resent": false
}
```

`activationToken` is returned **once** and never again: only its hash is stored, so a lost link is
resent, never recovered. A resend **rotates** the token, so two valid links for one invitation can
never coexist. It is deliberately absent from every log line — an activation token in a log file
is a working credential.

An invitation cannot create a membership, and there is no public signup: the membership must
already exist, or the request is refused.

### `GET /invitations?tenantId=…`

**Auth:** platform actor (interim). Lists a tenant's invitations. The token hash is **not** in the
response, so this cannot be used to forge or replay a link.

### `DELETE /invitations/:invitationId?tenantId=…`

**Auth:** platform actor (interim). **204 No Content.** Cancelling returns the person's account
state to `Not Invited` and invalidates the outstanding link.

### Account states

`tenant_memberships.account_state` — the **person's** state inside one company, distinct from the
company's own lifecycle state:

| State           | Effect                                                             |
| --------------- | ------------------------------------------------------------------ |
| `NotInvited`    | No invitation outstanding; cannot sign in to this workspace        |
| `InvitePending` | Invitation issued and unspent                                      |
| `Active`        | Normal access, subject to the company lifecycle state              |
| `Suspended`     | Blocked; sessions are refused                                      |
| `Offboarded`    | Blocked permanently; cannot be re-invited into the same membership |

The guard takes the **more restrictive** of the company lifecycle state and the person's account
state, and reports whichever actually blocked — so "your company is read-only" and "your account
is suspended" are never confused.

### Security events

Every authentication action writes an `audit_events` row with a `security.*` action from a closed
set: `invitation_issued`, `invitation_cancelled`, `invitation_accepted`, `login_succeeded`,
`login_failed`, `account_locked`, `logout`, `logout_all_devices`, `session_revoked`,
`session_revoked_by_admin`, `password_reset_requested`, `password_reset_completed`,
`password_reset_rejected`, `new_device_sign_in`.

The trail deliberately records **no** password, no token, no token hash and **not even the
attempted email address** on a failed login — a log of addresses someone tried to sign in as is
itself an account list. Audit failures are logged and swallowed rather than propagated, so a
problem writing the trail can never stop someone signing out.

## Enterprise identity (Prompt 6)

Three route groups: the new `/auth` endpoints below, company identity administration under
`/tenants/:tenantId/identity` (platform-only, interim — the role model arrives at Prompt 7), and
SCIM 2.0 under `/scim/v2`.

**No endpoint here ever returns an OIDC client secret, a SCIM bearer token or a TOTP secret after
the request that created it.** See SECURITY_DECISIONS S-029.

### `POST /auth/login` — now has three successful shapes

Unchanged request. The response is one of three, **all 200**, because "your company requires SSO"
is not a credential error and a 401 would make the browser show one.

**1. Signed in** — as documented at Prompt 5, with the session cookie.

**2. Second factor required** — sets the `uboss_mfa` cookie, **not** a session cookie:

```json
{
  "mfaRequired": true,
  "enrolmentRequired": false,
  "expiresAt": "2026-09-08T12:05:00.000Z",
  "graceUntil": null,
  "recoveryCodesAccepted": true,
  "message": "Enter the code from your authenticator app."
}
```

`enrolmentRequired` is true when the person has no enrolled factor and must set one up to get in.
The same challenge covers it — see `POST /auth/mfa/challenge/enroll/*` — which is what stops a
newly-imposed MFA policy from being a lockout.

**3. SSO required** — no cookie of any kind:

```json
{
  "ssoRequired": true,
  "tenantName": "SPM Medicare",
  "ssoConnections": [{ "id": "01a0…", "displayName": "SPM SSO", "protocol": "Oidc" }],
  "message": "SPM Medicare requires you to sign in through its identity provider."
}
```

**Cookie:** `uboss_mfa` — `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` in production, 5-minute
expiry. Stricter than the session cookie's `Lax` because nothing legitimately navigates to the
second-factor step from another site.

### `GET /auth/sign-in-methods?email=…`

**Auth:** none.

```json
{
  "allowPassword": true,
  "requireSso": false,
  "ssoConnections": [],
  "mfaExpected": false
}
```

**Answered from the email's DOMAIN, never from whether the address has an account.** An address
that exists and one that does not, at the same domain, give byte-identical answers; an unclaimed
domain gives the response above. That is what keeps this from being an account-enumeration oracle —
see S-038. Connection names and ids only: never an issuer, client id or discovery URL.

`mfaExpected` lets the screen warn "you will be asked for a code next". It is never a substitute
for the check — the server decides again after the password.

### `POST /auth/mfa/verify`

**Auth:** the `uboss_mfa` cookie. Completes the sign-in and sets the session cookie.

Request: `{ "code": string }` — a TOTP code **or** a recovery code, in one field, because the
caller must not be able to tell which one was wrong.

```json
{
  "user": { "ubossUniqueId": "UB-…", "displayName": "…", "isPlatformActor": false },
  "workspaces": [ … ],
  "newDevice": false,
  "secondFactor": "Totp",
  "remainingRecoveryCodes": 9
}
```

`remainingRecoveryCodes` appears only when a recovery code was used.

| Code  | When                                                                           |
| ----- | ------------------------------------------------------------------------------ |
| `401` | Wrong code — **one identical body** for a wrong TOTP and a wrong recovery code |
| `401` | Challenge expired, unknown, already used, or destroyed by too many attempts    |

A code already accepted for its time step is refused even inside its own 30-second window
(`mfa_factors.last_used_counter`). Visible consequence: the code used to complete enrolment cannot
then be used to sign in.

### `POST /auth/mfa/challenge/enroll/start` and `…/confirm`

**Auth:** the `uboss_mfa` cookie. First-time enrolment _during_ a forced sign-in.

`start` → `{ "factorId", "secret", "otpauthUri", "accountName" }`. Both `secret` and `otpauthUri`
contain the shared secret and are returned **once**, over this request.

`confirm` with `{ "factorId", "code" }` → the same body as `mfa/verify` plus
`"recoveryCodes": string[]` — ten codes, shown **once**. Sets the session cookie.

Kept separate from `mfa/enroll/*` because the credential differs: this pair is authorised by a
challenge, that pair by a session. Neither handler has to work out which kind of caller it has.

### `GET /auth/mfa/factors`

**Auth:** authenticated.

```json
{
  "factors": [
    {
      "id": "01a0…",
      "method": "Totp",
      "state": "Active",
      "label": "Authenticator app",
      "confirmedAt": "…",
      "lastUsedAt": "…",
      "createdAt": "…"
    }
  ],
  "remainingRecoveryCodes": 10,
  "recoveryCodeBatchSize": 10
}
```

`secretCiphertext` is **absent** — the secret is never returned again in any form.

### `POST /auth/mfa/enroll/start` · `POST /auth/mfa/enroll/confirm`

**Auth:** authenticated. As the challenge pair above, but from Login & Security.

`confirm` returns `{ "confirmed": true, "recoveryCodes": string[] | null }`. Codes are issued only
for the **first** factor — regenerating on every enrolment would silently invalidate codes the
person has already printed.

### `DELETE /auth/mfa/factors/:factorId`

**Auth:** authenticated. **204.**

`400` when it is the last active factor and one of the person's companies requires MFA, with a
message saying to enrol a replacement first. `403` when the factor is not theirs — indistinguishable
from one that does not exist.

### `POST /auth/mfa/recovery-codes`

**Auth:** authenticated. Issues a fresh batch and **invalidates every earlier code**.

```json
{ "codes": ["ABCDE-FGHJK-MNPQR-STVWX", "…"], "generatedAt": "…", "message": "…" }
```

Shown once. Only hashes are stored, so there is no endpoint that can display them again.

### `POST /auth/sso/start`

**Auth:** none. Request: `{ "connectionId": uuid, "redirectAfter"?: string }`

```json
{ "authorizationUrl": "https://idp.example.com/authorize?response_type=code&…" }
```

Returns the URL rather than issuing a 302, so the browser navigation happens from the login
screen's own code — a redirect from an XHR would be followed by the fetch layer and the provider's
page would arrive as an opaque body.

`401` for a connection that is disabled **or** does not exist — one identical body, so the endpoint
cannot be used to discover which companies have SSO. `501` for a SAML connection.

The authorization request always carries `response_type=code`, `code_challenge_method=S256`, a
`state`, a `nonce` and `openid` in the scope.

### `GET /auth/sso/callback?code=…&state=…`

**Auth:** none — the browser arriving from the identity provider. **Always 302.**

- Success: sets the session cookie and redirects to the web application.
- Failure: redirects to `{webBaseUrl}/login?ssoError=…` with a short reason, and **no** cookie.

The destination is only ever a path on the configured web origin, never a URL from the request —
an open redirect on an authentication endpoint is the most useful kind to a phisher.

Refused (as a failure redirect) for: a replayed or unknown `state`; an ID token that fails
signature, `iss`, `aud`, `azp`, `exp` or `nonce` checks; `alg: none` or any HMAC algorithm; an
unpublished `kid`; an email whose domain the company has not verified; an unknown person; or
someone without an `Active` membership. **One message for the last three** — see S-034.

### `POST /auth/sso/:connectionId/backchannel-logout`

**Auth:** none by necessity — the identity provider calls it server-to-server. The `logout_token`
is verified against the provider's signing keys exactly like an ID token, so a caller cannot end
anyone's session by guessing a `sid`.

Request: `{ "logout_token": string }` → `{ "revoked": 2 }`

`401` when the token fails verification, carries no back-channel logout event, or is an ID token
presented in its place (the spec forbids a `nonce` on a logout token precisely to stop that).

With a `sid`, every local session from that provider session is revoked. With only a `sub`, every
session that person holds through that connection is — broader, and correct: the provider is saying
it no longer vouches for them at all.

---

## Company identity administration — `/tenants/:tenantId/identity`

**Auth:** platform actor on every route. Interim, exactly as Prompt 5's invitation and
session-revoke administration: these are Company-Admin operations, but the role model arrives at
Prompt 7, and the alternatives were to let every company member reconfigure how their colleagues
authenticate or to invent a role check that Prompt 7 would replace.

### `GET /policy` · `PUT /policy`

```json
{
  "requireMfa": false,
  "requireSso": false,
  "allowPasswordSignIn": true,
  "mfaGraceUntil": null,
  "enabledSsoConnections": 0,
  "canRequireSso": false
}
```

`PUT` takes `{ requireMfa, requireSso, mfaGraceUntil? }`. Two invariants, both about self-lockout:

- `400` when `requireSso` is set with **no enabled connection** — every member would be sent to a
  provider that does not exist, including whoever would undo it;
- `requireSso` forces `allowPasswordSignIn: false`, as the meaning of the setting rather than a
  side effect.

`canRequireSso` is surfaced so a screen can disable the control with a reason instead of letting
the administrator submit and receive a 400.

Omitting `mfaGraceUntil` means "immediately" — legitimate where everyone is already enrolled, a
lockout where they are not. The API does not guess; the screen says which.

### `GET /sso-connections` · `POST` · `PATCH /:id` · `DELETE /:id`

```json
{
  "id": "01a0…",
  "protocol": "Oidc",
  "displayName": "SPM SSO",
  "enabled": false,
  "issuer": "https://idp.example.com",
  "discoveryUrl": "https://idp.example.com/.well-known/openid-configuration",
  "clientId": "uboss",
  "hasClientSecret": true,
  "scopes": null,
  "entityId": null,
  "ssoUrl": null,
  "sloUrl": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```

`hasClientSecret` is a boolean; the secret itself is never returned, in plaintext or sealed.

- **Created disabled, always.** An untested connection that is already live is how a company locks
  itself out; it has to be enabled explicitly.
- An OIDC connection requires `issuer`, `discoveryUrl`, `clientId` and `clientSecret` — refused
  rather than stored in a state that fails at the first sign-in.
- `PATCH { enabled: true }` on a **SAML** connection returns `400` with the reason.
- Disabling or deleting a connection **revokes every session it issued**.

### `GET /sso-setup`

The values a company needs to configure its provider: the exact `redirectUri`, the back-channel
logout URI template, the accepted ID-token algorithms and — stated rather than implied — the
**refused** ones (`none`, `HS256/384/512`). Also SAML service-provider metadata, with
`"samlStatus": "not-implemented"` and the reason.

### `GET /domains` · `POST /domains` · `POST /domains/:id/verify` · `DELETE /domains/:id`

```json
{
  "id": "01a0…",
  "domain": "spmmedicare.com",
  "state": "Pending",
  "recordName": "_uboss-verification.spmmedicare.com",
  "recordType": "TXT",
  "recordValue": "uboss-domain-verification=8Kf…",
  "verifiedAt": null,
  "lastCheckedAt": null,
  "failureReason": null,
  "expiresAt": "…"
}
```

`recordValue` is safe to return: the token is proof _because_ it gets published. It is not a
credential.

`verify` checks DNS and settles the claim, returning the same shape with `state` now `Verified`,
`Failed` or `Expired` and an actionable `failureReason` ("No TXT record was found at … It can take
a few minutes to propagate after you create it"). Caller-triggered rather than polled: an
administrator who has just created the record wants an answer now.

`400` for anything that is not a bare domain — schemes, paths, ports, wildcards, userinfo and
underscores are all refused.

**A verified domain creates no membership.** It permits domain-based invitation and SSO matching,
nothing more; otherwise it would be public signup wearing a DNS record.

### `GET /scim-clients` · `POST /scim-clients` · `DELETE /scim-clients/:id`

`POST` returns the bearer token **once**:

```json
{ "id": "01a0…", "displayName": "Okta", "token": "<shown once>", "scimBaseUrl": "…/scim/v2" }
```

Only a SHA-256 hash is stored. `GET` never includes the token or its hash.

---

## SCIM 2.0 — `/scim/v2`

**Auth:** `Authorization: Bearer <provisioning token>`. **The credential is the tenant scope** —
no SCIM path or body carries a tenant id, so there is nothing for a caller to tamper with to reach
another company. One identical `401` for a missing, malformed, unknown, revoked or
inactive-company token.

Responses use `application/scim+json`. Requests are accepted with that **or** `application/json`,
because several connectors send the latter and rejecting them over a header would break real
integrations.

### Discovery — reachable without a credential

`GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`. Unsupported features are declared
`false` rather than omitted, so a connector can plan around them: `bulk`, `sort`, `etag` and
`changePassword` are all false; `patch` and `filter` are true with the limits below.

### `/Users`

| Route               | Behaviour                                                               |
| ------------------- | ----------------------------------------------------------------------- |
| `GET /Users`        | 1-based `startIndex`, `count` capped at 500, `filter` for equality only |
| `GET /Users/:id`    | `id` is the person's platform user id. 404 outside this company         |
| `POST /Users`       | Creates or **reactivates**. 409 when already an active member           |
| `PUT /Users/:id`    | Replaces the mutable attributes                                         |
| `PATCH /Users/:id`  | `active` and `displayName` only. Anything else → **400**, never ignored |
| `DELETE /Users/:id` | **204.** Offboards; the membership row and its history survive          |

**`POST /Users` requires a verified domain** — `400` otherwise, with the reason. SCIM provisions a
person without any action from them, and control of the domain is the proof that makes that
legitimate (S-037).

`active: false` and `DELETE` both **revoke every session immediately**. Deprovisioning that leaves
a live session is the failure the feature exists to prevent.

`displayName` on a User is accepted and deliberately not applied: the display name belongs to the
person's platform identity, shared across every company they work for, and one employer's directory
must not rename them everywhere. Accepted rather than refused because connectors always send it.

### `/Groups`

`GET`, `GET /:id`, `POST`, `PUT /:id`, `PATCH /:id`, `DELETE /:id`. `PATCH` understands
`add`/`remove`/`replace` on `members`, including the filtered `members[value eq "…"]` form that
connectors actually send, and `replace` on `displayName`.

A proposed member who is not a member of _this company_ is **dropped**, not added — and dropped
rather than erroring, so one stale entry does not fail an otherwise valid sync. 409 on a duplicate
`displayName`.

Groups carry **no permissions** at Prompt 6. They are the provisioning target an identity provider
pushes, and what roles attach to at Prompt 7 — modelled now so the SCIM contract does not change
then.

### Filters

Only `attribute eq "value"` on `userName`, `externalId`, `emails.value`, `id` and `displayName`.
Anything else is `400 invalidFilter`. That refusal matters: answering an unsupported filter as "no
filter" would return every user, and a connector would read that as "this address does not exist"
and create a duplicate.

### Security events

Added to the closed vocabulary: `auth_policy_changed`, `mfa_enrolment_started`, `mfa_enrolled`,
`mfa_factor_revoked`, `mfa_challenge_issued`, `mfa_succeeded`, `mfa_failed`, `mfa_replay_rejected`,
`mfa_recovery_codes_generated`, `mfa_recovery_code_used`, `login_blocked_policy`,
`sso_connection_created|updated|deleted`, `sso_login_started|succeeded|failed`,
`sso_backchannel_logout`, `sso_provider_logout_requested`, `domain_claim_created`,
`domain_verified`, `domain_verification_failed`, `domain_claim_removed`,
`scim_client_created|revoked`, `scim_auth_failed`, `scim_user_provisioned|deprovisioned`,
`scim_group_changed`.

The trail records **no** TOTP secret, client secret, SCIM token, password or recovery code. A
rotated client secret appears as a boolean. Asserted by a test that serialises the whole trail.

## The authorization engine (Prompt 7)

Five dimensions — **user type, role, scope, module visibility, allowed actions** — composed through
five policy layers: `Platform → Company → Department → Objective → Engine Agent`, where a lower
layer may be stricter but **never weaker than a mandatory higher-level control**.

The vocabulary itself lives in `@uboss/types` and is served by `GET .../vocabulary`, so a screen
rendering a permissions matrix and the server enforcing it cannot disagree about what a module or
action is called.

### How a route is protected

Two phases, forced by the shape of HTTP (ADR-040):

```ts
@Get(':id')
@TenantScoped()                                        // Prompt 4: may they be here at all?
@RequirePermission({ module: 'objective', action: 'View' })   // Phase 1: could their role ever?
async read(@Param('id') id: string) {
  const objective = await this.objectives.find(id);
  await this.authorization.assertCanOnResource({       // Phase 2: may they, to THIS row?
    scope,
    module: 'objective',
    action: 'View',
    resource: {
      id: objective.id,
      ownerUserId: objective.ownerUserId,
      createdByUserId: objective.createdByUserId,
      departmentId: objective.departmentId,
    },
  });
  return objective;
}
```

Phase 1 is a guard, so it cannot know the row. Phase 2 is where **scope** and **separation of
duties** are decided. A route with only phase 1 is protected against the wrong _role_ but not the
wrong _row_.

Decorators: `@RequirePermission(...)` (all required), `@RequireAnyPermission(...)` (at least one),
`@RequireUserType(...)`. `PermissionGuard` is registered globally and returns `true` for a route
that carries none of them — so it cannot break an existing route, and cannot open one either,
because `TenantGuard` still denies anything with no tenancy policy.

### Denial responses

A 403 body carries the engine's own message, which names the dimension that blocked —
`"Your role does not include \"Approve\" on this."`, `"That is outside what your role covers."`,
or a policy rule's own `reason` written for the person who will read it.

It **never** carries the decision trace or the deciding layer. Only `POST .../evaluate` does, and
that route is platform-only, because the trace describes a company's policy configuration.

| Reason code            | Meaning                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `no-role-assignment`   | A member with no role. Can do nothing — not "own work"      |
| `user-type-ceiling`    | Forbidden to this kind of account, whatever the role says   |
| `module-not-visible`   | No assignment makes that module visible                     |
| `role-lacks-action`    | No assigned role grants that action there                   |
| `policy-denied`        | A policy layer refused; the message is that rule's `reason` |
| `out-of-scope`         | The row is outside what the role covers                     |
| `scope-unevaluable`    | `TeamSubtree` with no hierarchy yet — refused, not guessed  |
| `separation-of-duties` | A four-eyes or no-self-approval control                     |

---

## `/tenants/:tenantId/authorization`

**Auth:** platform actor on every route. Interim, and the **last** of its kind — see "Not yet
implemented".

### `GET /vocabulary`

Every dimension with labels, served from `@uboss/types`:

```json
{
  "userTypes": [
    {
      "value": "ExternalGuest",
      "label": "External Guest",
      "forbiddenActions": [
        "Approve",
        "Publish",
        "Run",
        "Schedule",
        "Pause",
        "ManageAccess",
        "Administer",
        "Audit",
        "Export"
      ]
    }
  ],
  "roles": [{ "value": "Manager", "label": "Manager" }],
  "scopes": [{ "value": "TeamSubtree", "label": "Team / Subtree" }],
  "modules": { "company": ["dashboard", "…"], "platform": ["companies", "…"] },
  "actions": [{ "value": "Approve", "label": "Approve", "highRisk": true }],
  "policyLayers": [{ "value": "Platform", "label": "Platform" }],
  "sodRules": [{ "value": "FourEyes", "label": "Four eyes (two distinct people)" }],
  "precedenceNote": "…"
}
```

The user-type ceiling is public: a screen has to explain why a control is unavailable to a guest,
and "guests may never approve" is a product rule, not a secret.

### `GET /role-catalogue`

The six built-in roles, **read-only** — a built-in role's meaning is code, not data (ADR-038). Each
carries `kind`, `label`, `summary`, `maxScope`, `defaultScope`, `modules` and the full `permissions`
matrix.

### `POST /evaluate` — the internal permission test endpoint

Request: `{ userId?, module, action, resourceId?, resourceOwnerUserId?,
resourceCreatedByUserId?, resourceDepartmentId?, priorActorUserIds?, actingAsAgent? }`

```json
{
  "subject": { "userId": "…", "userType": "InternalUser",
               "roles": [{ "roleKind": "Approver", "scopeKind": "SelectedResource" }],
               "assignedScope": "SelectedResource" },
  "question": { "module": "objective", "action": "Approve", "resource": { … },
                "actingAsAgent": false },
  "decision": { "allowed": false, "reason": "separation-of-duties",
                "message": "You cannot approve something you created…",
                "decidedBy": null, "effectiveScope": "SelectedResource" },
  "trace": [
    { "layer": "UserType", "outcome": "noop",  "detail": "…" },
    { "layer": "Role",     "outcome": "allow", "detail": "…" },
    { "layer": "Company",  "outcome": "deny",  "detail": "…" },
    { "layer": "Scope",    "outcome": "allow", "detail": "…" },
    { "layer": "SeparationOfDuties", "outcome": "deny", "detail": "…" }
  ],
  "separationOfDuties": { "rule": "NoSelfApproval", "mandatory": true, "reason": "…" },
  "listingScope": "SelectedResource"
}
```

The resource fields are **supplied**, not loaded, so the endpoint can answer "what would happen
if" — including for a row that does not exist yet. `listingScope` is how wide a list query for that
(module, action) would be allowed to go, which a list endpoint needs _before_ it has a row.

### `GET /matrix/:userId`

The full module → actions matrix, plus `visibleModules`, `assignedScope` and how many policy rules
and SoD controls applied. Computed by running the same engine per (module, action) — there is no
second implementation to drift.

The response carries a `note` saying so: scope and separation of duties need a specific row, so a
matrix cannot express them.

### Role assignments

| Route                     | Behaviour                                                                     |
| ------------------------- | ----------------------------------------------------------------------------- |
| `GET /assignments`        | Every assignment, with `expired` computed so a screen need not compare clocks |
| `POST /assignments`       | **201.** Three escalation gates below                                         |
| `DELETE /assignments/:id` | **204.** Recorded as suspicious activity                                      |

Request: `{ userId, roleKind, customRoleId?, scopeKind, departmentIds?, selectedResourceIds?,
expiresAt?, justification? }`

`400` for each of these, with a message saying which:

- the scope is wider than the role's `maxScope` (the message names the ceiling);
- **the caller is assigning to themselves** — the shortest escalation path in any RBAC system;
- the person is not a member, or is `Offboarded`;
- a department or selected-resource scope with nothing in it;
- `Department` scope naming more than one department (use `MultipleDepartments`);
- a `Custom` role with no `customRoleId`, or a built-in role with one;
- an `expiresAt` in the past.

Every grant and revocation writes a **suspicious** security event carrying the subject, role, scope
and whether a justification was written — recorded as a boolean, because an access review's usual
finding is that nobody wrote one.

### Custom roles

`GET /custom-roles`, `POST /custom-roles` (**201**).

Request: `{ displayName, description?, permissions: { "<module>": ["<action>"] }, maxScope }`

**A custom role cannot grant a permission its creator does not have** (`400`, listing the
overreach). Without that, "can create custom roles" is equivalent to "can do anything".

`permissions` is narrowed by `sanitisePermissionSet`, so a module or action UBoss does not
recognise is **dropped** rather than stored as an unenforceable grant.

### Policy rules

`GET /policy-rules`, `POST /policy-rules` (**201**), `DELETE /policy-rules/:ruleId` (**204**).

Request: `{ layer, departmentId?, objectiveId?, engineAgentId?, module?, action?, effect,
mandatory, maxScope?, reason }`

`module` and `action` omitted mean **every** — how a broad control is expressed without enumerating
the matrix. `reason` surfaces verbatim to whoever gets refused, so it has to be written for them.

`400` for: a `Platform` layer rule (it applies to every company and is not a company's to write);
a **mandatory `Allow`** (refused by the API _and_ a database check constraint); a layer with no
subject.

### Separation of duties

`GET /separation-of-duties` returns the inherited `platformBaseline` and this company's
`companyPolicies`, plus `candidateActions` (the high-risk defaults a configuration screen would
offer) and a note that a mandatory baseline control cannot be removed by any lower layer.

`POST` (**201**) takes `{ layer?, module?, action, rule, mandatory, reason }`.
`DELETE /separation-of-duties/:policyId` is **204**.

The seeded platform baseline applies `NoSelfApproval` to `Approve` in **every** company, mandatory.

### `PUT /members/:userId/user-type`

`{ userType: "InternalUser" | "ExternalGuest" }`. `PlatformUser` is refused — a platform actor has
no company membership at all. Recorded as suspicious in both directions.

---

## The TCSiON mapping extension point

**No TCSiON definitions are invented anywhere in this codebase.** The client has stated that TCSiON
user types and allotments are an external dependency, and the approved reference has not been
supplied. These endpoints are the shape it maps into, and they ship **empty**.

### `GET /tcsion-mappings`

```json
{
  "loaded": 0,
  "externalUserTypes": [],
  "note": "No approved TCSiON reference has been loaded. TCSiON user types and allotments are an
           external client dependency and are deliberately not invented here, so external
           identities cannot be resolved until the approved mapping is supplied.",
  "mappings": []
}
```

The note is the point: an empty table must read as "not supplied yet", not as a bug.

### `PUT /tcsion-mappings`

One row of the approved reference:

```json
{
  "externalUserType": "<verbatim from the client document>",
  "externalAllotment": "<verbatim, or omitted>",
  "ubossUserType": "ExternalGuest",
  "roleKind": "Employee",
  "customRoleId": null,
  "scopeKind": "OwnWork",
  "departmentIds": [],
  "moduleVisibility": { "objective": true, "todo": true },
  "allowedActions": { "objective": ["View"] },
  "approvedReference": "Client reference doc v1, section 4"
}
```

The **external** fields are free text holding the client's vocabulary verbatim — constraining them
to an enum would mean guessing. The **UBoss** fields are validated strictly, and a `400` names the
wrong value, so a transcription error is caught at load time rather than at somebody's first
sign-in.

`approvedReference` is **mandatory**: the point of the table is that its contents are traceable to
an approved document rather than to an assumption.

`allowedActions` is a **ceiling**, intersected with the role — never a grant. A mapping cannot award
an action the mapped role lacks. `moduleVisibility` fails closed: an absent module is not visible.
An `allowedActions` entry for a module that is not visible is refused as dead configuration.

### `POST /tcsion-mappings/resolve`

A dry run: `{ externalUserType, externalAllotment? }` → the UBoss dimensions it would produce.

```json
{ "resolved": false,
  "message": "No approved TCSiON mapping exists for \"…\". TCSiON user types and allotments are an
              external client dependency and are not invented here — load the approved reference
              before provisioning identities of this type." }
```

It **never** defaults. An unmapped type also writes a `tcsion_mapping_missing` security event
carrying the external type, so the gap is findable by whoever can fix it.

Exact match on (type, allotment) wins over a match on type alone — a reference that distinguishes
allotments should beat one that does not.

### `DELETE /tcsion-mappings/:mappingId` — **204**

---

## Security events added at Prompt 7

`separation_of_duties_blocked`, `permission_denied`, `role_assigned`, `role_revoked`,
`custom_role_created`, `custom_role_updated`, `policy_rule_created`, `policy_rule_deleted`,
`sod_policy_created`, `sod_policy_deleted`, `tcsion_mapping_loaded`, `tcsion_mapping_missing`,
`user_type_changed`.

Grants, revocations, custom-role creation, user-type changes and blocked separation-of-duties
attempts are all recorded as **suspicious** activity — not because they are wrong, but because they
are what an access review and an incident investigation ask about first.

---

## Audit and security foundations (Prompt 8)

Two trails, deliberately separate (ADR-045). The audit trail answers **what changed to this
record, by whom, and why**. The security trail answers **what happened to this account or
session**. Both carry the same `correlationId`, so one identifier joins them.

### Authorization, in one place

| Route group                     | Requires                                           |
| ------------------------------- | -------------------------------------------------- |
| `GET .../audit/events`          | `settings:Audit` at `WholeCompany` scope           |
| `POST .../audit/events/export`  | `settings:Audit` **and** `settings:Export`         |
| `GET .../audit/security-events` | `settings:Audit`                                   |
| `POST .../audit/verify`         | `settings:Audit`                                   |
| `POST .../audit/checkpoints`    | `settings:Administer` — sealing changes a baseline |
| `/platform/security/*`          | Platform actor                                     |
| `/platform/break-glass/*`       | Platform actor                                     |

There is deliberately **no `audit` module**: the reference UI puts "Audit & Activity"
inside Settings as a section, and the 14 company modules are the client's approved set. A scope
narrower than `WholeCompany` is **refused** rather than narrowed, because `audit_events`
has no department (ADR-047).

**These are the first tenant-facing routes in the product that are not `@PlatformOnly`.**
Every Prompt 5–7 company route still waits for administration to be re-homed onto the engine;
these use it, which is what it was built for.

### `GET /tenants/:tenantId/audit/vocabulary`

The category, severity and outcome lists plus the current hash-format version, so a screen
renders from the server's vocabulary rather than a copy that can drift.

### `GET /tenants/:tenantId/audit/events`

Query: `action` | `actionPrefix` (exactly one — both together is a **400**,
because they filter the same column and one would silently win), `actorUserId`,
`resourceType`, `resourceId`, `from`, `to`, `before`
(keyset cursor), `limit` (≤ 200).

```json
{
  "rows": [
    {
      "id": "018f…",
      "tenantId": "018f…",
      "action": "break_glass.approved",
      "resourceType": "break_glass_request",
      "resourceId": "018f…",
      "actorUserId": "018f…",
      "summary": "Approved for 30 minute(s).",
      "reason": "Approved on the incident call.",
      "resourceVersion": 3,
      "resourceRef": "INC-4821",
      "correlationId": "c-…",
      "metadata": { "state": "IdentityVerified", "minutes": 30 },
      "occurredAt": "2026-09-08T18:04:11.204Z",
      "chain": { "key": "018f…", "sequence": "42", "prevHash": "…", "rowHash": "…" }
    }
  ],
  "nextCursor": "2026-09-08T18:04:11.204Z",
  "total": 128,
  "chainVersion": "uboss-audit-chain-v1"
}
```

`chain.sequence` is a **string**, not a number. A chain position is an `int8` that can
exceed `Number.MAX_SAFE_INTEGER`, and a position that silently lost precision would make
the row impossible to verify. It is `null` on a row written before Prompt 8; those rows are
not retro-chained, and verification reports how many there are.

One row beyond the page size is fetched internally, so `nextCursor` is absent on the last
page rather than present-and-empty — a client never makes one pointless final request.

### `POST /tenants/:tenantId/audit/events/export`

Same query shape and same response shape, capped at 5,000 rows. A `POST` despite reading
nothing: it writes a security event naming who took a copy of the company's history, so it is
not safe, idempotent or cacheable and must not look like it is. Paged reads are deliberately
**not** audited — an event per page would drown the trail being read.

### `GET /tenants/:tenantId/audit/security-events` and `/export`

Query: `category` (Login | Session | Risk | Support | Access), `severity` (Info |
Notice | Warning | Critical), `outcome` (Succeeded | Failed | Blocked), `action`,
`actorUserId`, `subjectUserId`, plus the shared time window.

Rows add `category`, `severity`, `outcome`, `subjectUserId`,
`deviceLabel` and `clientHint`. A company sees only its **own** events: the tenant id
comes from the verified scope, never from a filter, and tenant-less rows are unreachable here at
all.

### `POST /tenants/:tenantId/audit/verify`

Recomputes both chains. A `POST` because it records a security event either way — and a
broken chain records a `Critical` one.

```json
{
  "audit": {
    "chainKey": "018f…",
    "trail": "audit",
    "intact": true,
    "verifiedCount": 128,
    "unchainedCount": 4,
    "headSequence": "128",
    "headHash": "…",
    "breaks": []
  },
  "security": { "…": "same shape" },
  "guarantee": "Guaranteed: the application database role cannot UPDATE or DELETE …"
}
```

**`guarantee` is returned rather than only documented, and its wording changes.** With an
externally anchored checkpoint it says a wholesale rewrite is also detectable; without one it
says plainly what is **NOT** guaranteed — a superuser could disable the trigger, rewrite rows,
recompute every hash, and this check would still report `intact: true`. A caller looking at
a green tick has no other way to know which situation they are in. Full statement in ADR-046.

`breaks` entries carry a `kind` from a closed set — `content-altered`,
`link-broken`, `sequence-gap`, `duplicate-sequence` — so a caller can branch on
it rather than parse prose.

### `GET` / `POST /tenants/:tenantId/audit/checkpoints`

`POST` takes `trail` (audit | security) and an optional `externalAnchorRef`. It
**refuses** to seal a chain that does not verify (sealing over a break would make the tampered
state the verified baseline) and refuses to seal an empty chain. `sequence` and `rowCount`
are strings, for the same precision reason. `anchored: false` is reported honestly — a
checkpoint only proves anything once a copy lives outside this database.

### `/platform/security`

`GET events` returns cross-tenant and tenant-less security events; `POST verify` checks
the platform chains. A separate `@PlatformOnly` controller rather than a flag on the tenant
routes: a flag is a parameter, and a parameter is something a request can set (S-050).

### `/platform/break-glass`

| Route                             | Step                                                     |
| --------------------------------- | -------------------------------------------------------- |
| `POST /`                          | Raise a request. Grants nothing.                         |
| `POST /:id/verify-identity`       | Record the out-of-band identity check.                   |
| `POST /:id/approve`               | Approve, with a window ≤ 480 minutes.                    |
| `POST /:id/deny`                  | Refuse. Terminal.                                        |
| `POST /:id/activate`              | Start the clock.                                         |
| `POST /:id/revoke`                | End an active grant early.                               |
| `POST /:id/customer-notification` | Record Sent / Failed / Suppressed.                       |
| `GET /`, `GET /:id`               | List and read. `notificationPending=true` shows debts.   |
| `POST /expire-elapsed`            | Tidy state. Not enforcement — expiry is checked on read. |

**Six steps, not one call.** A single "create an approved grant" endpoint is exactly what
somebody under incident pressure would ask for, and it would make the whole control a formality
(ADR-048).

**The requester, verifier, approver and revoker all come from the authenticated actor, never
from the body.** `requesterUserId` in a request body is a **400** (`forbidNonWhitelisted`),
so a requester cannot nominate themselves as their own verifier by naming somebody else.

`POST /` body: `tenantId`, `reason` (≥ 20 characters), `allowedModules`
(≥ 1, company modules only), `allowedActions` (≥ 1; `Administer` and `ManageAccess`
are **refused outright** — they would let a time-limited grant create a permanent one),
optional `externalReference` and `allowedResourceIds`.

The response groups the record the way a reviewer reads it: `identityVerification`,
`allowedScope`, `approval`, `window`, `customerNotification`, `usage`.
Written out field by field rather than returned raw, so adding a column does not silently
publish it.

**Refusals of interest:** `409` from the wrong state, naming both the current state and
what the step requires; `403` on self-verification or self-approval, **recorded as a
`Critical` security event** in its own transaction so the blocked attempt survives the
rollback that refuses it; `400` on an unbounded scope, a thin reason, or an over-long
window.

---

## Security events added at Prompt 8

Break-glass: `break_glass_requested`, `break_glass_identity_verified`,
`break_glass_identity_verification_failed`, `break_glass_approved`,
`break_glass_denied`, `break_glass_activated`, `break_glass_used`,
`break_glass_revoked`, `break_glass_expired`, `break_glass_self_approval_blocked`,
`break_glass_customer_notified`, `break_glass_notification_failed`,
`break_glass_notification_suppressed`.

Trails: `audit_trail_exported`, `security_trail_exported`, `audit_chain_verified`,
`audit_chain_broken`, `audit_chain_checkpoint_sealed`.

**Every action is now classified in one table** rather than at 106 call sites: category,
severity and outcome are derived from the action key, and the record is typed by the same union
as the action set, so **adding an action without classifying it is a type error**. Severity is
editorial and the reasoning is in the code: `Critical` is reserved for what should page
somebody (deleting a separation-of-duties policy, every break-glass step that grants or
withholds, a broken chain); a failed sign-in is `Notice`, not `Warning`, because
people mistype passwords all day and making that a warning trains everyone to ignore warnings.

---

## The UBoss Master Console (Prompt 9)

All under `/platform/console`, all `@PlatformOnly`, and all — except `me` — additionally guarded
by a **platform-role** permission. As of this prompt that second guard is real: `platformContext`
builds its permissions from the caller's platform-role assignments instead of granting every
platform actor all fifteen modules (ADR-049).

### Which permission guards which route

| Route group              | Requires                       | Held by                  |
| ------------------------ | ------------------------------ | ------------------------ |
| `GET me`                 | _(nothing)_                    | any platform actor       |
| Dashboard, module status | `platform-dashboard:View`      | every platform role      |
| Companies (read)         | `companies:View`               | every platform role      |
| Subscription (write)     | `companies:Administer`         | Owner, Admin             |
| Create Company entry     | `create-company:View`          | Owner, Admin             |
| Plans (read)             | `plans:View`                   | every platform role      |
| Plans (write)            | `plans:Administer`             | Owner, Admin, Commercial |
| Feature flags (read)     | `release:View`                 | every platform role      |
| Feature flags (write)    | `release:Administer`           | **Owner only**           |
| Settings (read)          | `platform-settings:View`       | every platform role      |
| Settings (write)         | `platform-settings:Administer` | **Owner only**           |
| Platform roles (read)    | `security:Audit`               | Owner, Security          |
| Platform roles (write)   | `platform-settings:Administer` | **Owner only**           |
| Service alerts (read)    | `system-health:View`           | every platform role      |
| Service alerts (write)   | `system-health:EditDraft`      | Owner, Engineer          |

Two of those pairings are the substance of the module rather than bookkeeping. **Granting a
platform role** sits behind `platform-settings:Administer` so that only an Owner can create
platform authority — behind `companies:Administer` it would let every Admin appoint an Owner.
**Reading** the access review sits behind `security:Audit` instead, so a Platform Security
reviewer can see who holds what and change nothing: a reviewer who could also grant would be
reviewing their own decisions.

### `GET /platform/console/me`

Deliberately carries **no** permission requirement. A platform actor holding no role reaches
nothing, and must still be able to discover _why_ — guarding this endpoint would give somebody
locked out by a missing assignment a bare 403 and no way to find out, which is the worst version
of a fail-closed design.

```json
{
  "userId": "018f…",
  "roles": [{ "kind": "PlatformAdmin", "label": "Platform Admin", "expiresAt": null }],
  "matrix": { "companies": ["View", "Comment", "EditDraft", "Administer", "Export", "Audit"] },
  "navigation": [
    { "navKey": "dashboard", "module": "platform-dashboard", "visible": true, "actions": ["View"] },
    { "navKey": "health", "module": "system-health", "visible": true, "actions": ["View"] }
  ],
  "roleCatalogue": [
    { "kind": "PlatformOwner", "label": "…", "summary": "…", "administers": ["…"] }
  ],
  "ceiling": { "…": ["…"] }
}
```

`roles: []` and `matrix: {}` is the fail-closed state, and the console renders an explanation for
it rather than an empty sidebar.

`navigation` exists because **navigation keys are not module keys**: two differ (`dashboard` →
`platform-dashboard`, `health` → `system-health`), so the console filters its sidebar from this
array rather than mapping locally. A rendering hint, never the enforcement — every route above
carries its own check (ADR-050).

### `GET /platform/console/dashboard`

One aggregate rather than eight endpoints: a dashboard assembled from eight parallel requests
shows eight different moments in time, and the panel most likely to be stale is the one an
operator is about to act on.

```json
{
  "kpis": {
    "activeCompanies": { "value": 5, "total": 6, "provenance": "measured" },
    "platformSeats": {
      "used": 17,
      "licensed": 255,
      "utilisationPercent": 7,
      "provenance": "configured"
    },
    "aiSpend": {
      "consumedMinor": 164000,
      "allowanceMinor": 400000,
      "currency": "USD",
      "provenance": "demo"
    },
    "openIncidents": { "value": 2, "critical": 0, "provenance": "demo" }
  },
  "companiesNeedingAttention": ["…CompanySummary"],
  "companies": ["…CompanySummary"],
  "renewalsDue": ["…CompanySummary, next 30 days, soonest first"],
  "serviceAlerts": [
    { "service": "model-gateway", "severity": "Warning", "state": "Open", "…": "…" }
  ],
  "securityAttention": {
    "criticalEventsLast30Days": 0,
    "activeBreakGlassGrants": 0,
    "pendingCustomerNotifications": 1,
    "platformRoleHolders": 3,
    "provenance": "measured"
  },
  "provenanceNotes": [{ "panel": "Seats", "provenance": "configured", "note": "…" }],
  "generatedAt": "2026-09-09T…"
}
```

**Every panel says where its numbers came from** (ADR-051). `measured` is counted from data the
product produces; `configured` is a real row somebody set deliberately; `demo` is seeded with no
metering behind it. The distinction is on the wire and on the screen because a console that
presents a seeded AI-spend figure identically to a measured company count teaches its operator to
trust both equally.

Companies, seats-used and the **whole security panel** are measured — the security figures come
from the Prompt 8 append-only, hash-chained trails, so they cannot have been quietly edited. Seats
licensed, plans, renewals and billing state are configured. AI consumption and service alerts are
demo.

The reference's KPI deltas ("+3 this month") are **absent**: there is no month-over-month history
to compute them from, and a decorative figure on an operations dashboard is worse than a missing
one. Seat utilisation _is_ computable and is shown.

#### `CompanySummary`

The reference's Companies columns, pre-derived so a screen does not re-implement the formatting:

```json
{
  "tenantId": "018f…",
  "reference": "spm-medicare",
  "name": "SPM Medicare",
  "status": "Active",
  "plan": "Enterprise",
  "planTier": "Enterprise",
  "seatsUsed": 5,
  "seatsLicensed": 60,
  "seatsLabel": "5 / 60",
  "aiUsagePercent": 68,
  "aiUsageLabel": "68%",
  "billing": "Current",
  "renewsAt": "2027-03-18T…",
  "daysToRenewal": 190,
  "flag": "None",
  "attentionReasons": [],
  "security": { "criticalEvents": 0, "activeBreakGlass": 0, "breakGlassPendingNotification": 0 },
  "openServiceAlerts": 0
}
```

`seatsLabel` renders `5 / —` when no plan is assigned, because "not on a plan" and "zero licensed
seats" are different situations. `aiUsageLabel` is `—` when there is no allowance to measure
against.

**`flag` is the single worst reason; `attentionReasons` carries all of them.** The reference has
one Flag column and a cell holding four badges is a cell nobody scans — but a company can
genuinely have several problems, and dropping the rest would make the console lie by omission.
Precedence: **Security → Billing → Budget → Seats → Renewal**, roughly how soon each stops the
customer working, with security first because a commercial problem gets worse slowly and a
security one does not. A hand-pinned flag beats the derivation and says so in its reason.

Thresholds: AI allowance ≥ 85%, seats ≥ 90%, renewal within 30 days.

### Companies

`GET companies` returns the same `CompanySummary` array. `GET companies/:tenantId` adds
entitlements, the subscription, and the company's own recent audit and security events — the same
rows that company's Audit & Activity screen shows, which is what makes the two consistent.

**Entitlements resolve in a stated order**: the plan's modules, plus the company's
`extraModules`, minus its `removedModules` — and **withheld wins over extra**, so an entitlement
explicitly taken away cannot be restored by also listing it as an extra.

`PUT companies/:tenantId/subscription` requires a **reason** and writes the audit event into the
**company's own trail**, because a change to what a company is paying for is something that
company is entitled to see (the same reasoning as break-glass, ADR-048).

### Create Company — entry only

`GET create-company/prerequisites` returns the five step names, the available plans, the platform
defaults and the locked constraints, plus:

```json
{ "readiness": { "wizardImplemented": false, "note": "…" } }
```

**There is no `POST` anywhere behind this screen**, and a test asserts the 404. The client asked
for the entry point and no wizard until the next prompt; `TenantProvisioningService` already
works, so shipping a `POST` would create a provisioning path that skips plan selection,
entitlements, budget and security — and the reference prototype has exactly that shortcut on this
screen. The absence is the deliverable (ADR-052, S-058).

### Plans, feature flags, settings, service alerts

`GET plans` adds a **`subscribers`** count the reference does not have, because a plan with
companies on it cannot be retired and an operator should see why before the API refuses. Money is
integer **minor units** throughout; `null` means "Custom", which is the reference's Enterprise
row, and is not the same as zero.

`POST feature-flags` always creates **`Dev` / `Paused` / 0%** — `stage`, `state` and
`rolloutPercent` are not accepted on creation at all, because a flag that could be created live
would let one call ship an untested change to every customer. Two combinations are refused: a
paused flag carrying a rollout percentage (a database check constraint — the state and the
percentage would disagree about whether the feature is on) and an `Active` flag at 0% with nobody
named (the service — off in effect, reads as on). Every change needs a **reason** and records a
security event.

`PUT settings/:key` refuses a **locked** setting with a 403. `governance.company_creation` and
`governance.aadhaar_handling` are client-stated product rules: displayed so an operator can
confirm the constraint is in force, refused on write so a click cannot change a requirement
(S-057). Unlocked changes need a reason and record a **`Critical`** security event.

`GET module-status` returns the seven modules shipped as shells with **what specifically blocks
each one** — no payment provider, no AI metering, no provider adapters — and what of the module
does work today. The reference's stub says "wired and permission-scoped, full tables in the next
delivery batch", which tells a reader nothing they can act on.

### Security events added at Prompt 9

`platform_role_granted` and `platform_setting_changed` are **`Critical`**: they affect every
company at once, which is the definition of "should page somebody". `platform_role_revoked` and
`feature_flag_changed` are `Warning`. `platform_role_self_grant_blocked` and
`platform_lockout_prevented` are `Critical`/`Blocked` — and, like every refusal since ADR-048, are
recorded **outside** the transaction that refuses, so the record of the attempt survives the
rollback.

---

## Company provisioning and activation (Prompt 10)

### `POST /platform/provisioning/companies`

`@PlatformOnly` + `create-company:Create`. **The only way a company comes into existence.**

One request for all ten wizard steps, because provisioning is one transaction (ADR-054). The body
is `ProvisionCompanyDto`: company identity, initial administrator, commercial plan, module
entitlements, AI mode, skill packs, budget policy, security defaults, and an
`idempotencyKey`.

**What is deliberately absent from the body:** any password field, and any provider credential
field. `forbidNonWhitelisted` means a payload containing `adminPassword` or `providerApiKey` is
a **400** rather than a silently-dropped field. `providerCredentialHint` accepts a masked
fragment capped at 40 characters, so a real key does not fit.

```json
{
  "tenantId": "01a0…",
  "slug": "mednova",
  "code": "MEDNOVA",
  "name": "MedNova Healthcare",
  "lifecycleState": "Provisioning",
  "admin": {
    "userId": "01a0…",
    "ubossUniqueId": "UB-M8UL-W5BJ",
    "activation": "An activation invitation was queued. No password was created."
  },
  "bootstrapRoleAssignmentId": "01a0…",
  "outboxMessageId": "01a0…",
  "setupTaskCount": 10,
  "replayed": false
}
```

**No activation token, ever.** It exists once inside the transaction and is dropped — a response
carrying it would put a credential in a platform operator's browser history. The `activation`
string says so in words, so a client does not look for a field that is deliberately absent.

`replayed: true` means the `idempotencyKey` matched an earlier provisioning and **the same
company** is being returned. A double-clicked Provision button cannot create two companies.

**Refusals worth knowing:** `403` for a non-platform actor or a platform actor without
`create-company:Create` (Platform Support cannot provision); `409` for a company code or
workspace key already in use; `400` for a renewal before the start, an approval threshold above
the hard stop, a platform module in the entitlement list, a Custom Enterprise Provider with no
endpoint, a retired plan, zero seats, or a junk code/country/currency.

**Atomicity is tested, not assumed:** a provisioning that fails after the tenant insert leaves no
company, no person, no invitation and no queued message.

### `GET /platform/provisioning/outbox`

`support:View`. The queued activation invitations, with counts by state and:

```json
{ "dispatcher": { "running": false, "note": "No dispatcher is implemented yet…" } }
```

Exposed rather than hidden **because** no dispatcher runs yet: an operator who provisioned a
company must be able to see that the invitation is queued and undelivered, rather than assume it
was sent and wonder why the customer never activated (ADR-055). Payloads are safe to return by
construction — they carry an invitation's id, never its token.

### `GET /tenants/:tenantId/setup/checklist`

`@TenantScoped` + `settings:View` — which **every** company role holds. The client's requirement
is that a new administrator does not land on an empty dashboard; gating this behind `Administer`
would mean the one person who needs it is the only one who can see it.

```json
{
  "tasks": [
    {
      "key": "company_profile",
      "position": 1,
      "title": "Confirm company profile, timezone, locale and branding.",
      "rationale": "Every date/schedule and visible company identity depends on these defaults.",
      "targetRoute": "/settings/general",
      "state": "NotStarted",
      "skipReason": null,
      "completedAt": null
    }
  ],
  "resolved": 0,
  "total": 10,
  "percentComplete": 0,
  "nextTask": { "key": "company_profile", "title": "…", "targetRoute": "/settings/general" },
  "complete": false
}
```

The ten items, their order and their `rationale` are verbatim from the approved onboarding
sequence. `nextTask` is the client's "next recommended action".

### `PUT /tenants/:tenantId/setup/checklist/:key`

`settings:EditDraft` — bringing a workspace up is often delegated, and changing global settings
is a separate, narrower thing. Body: `{ state, skipReason? }`.

**`Skipped` requires a reason** (400 without one, and a check constraint behind that), and counts
toward `resolved`: a company with no external collaborators is not permanently stuck at 90%. It
stays visibly skipped, which is a different claim from done. An unknown key is a **404** — the
checklist is a fixed approved sequence, not a to-do list.

### Security events added at Prompt 10

`company_provisioned` (`Warning`), `company_bootstrap_admin_granted` (**`Critical`** — the one
authority in the product created with no human grantor), `company_activation_invitation_queued`
(`Notice`).

---

## Plans, entitlements, seats and company lifecycle (Prompt 11)

Two groups, and **the split between them is the client's rule**: a Company Admin may view its
permitted plan and seat position and may request allowed commercial changes; the platform controls
the contracted ceiling and the entitlements.

### `GET /tenants/:tenantId/commercial/position`

`@TenantScoped` + `settings:View`. The company's whole commercial position, as four named groups
plus seats — and **no RBAC field anywhere in it** (ADR-059).

```json
{
  "plan": {
    "code": "growth",
    "name": "Growth",
    "tier": "Growth",
    "state": "Active",
    "billingState": "Current",
    "billingCycle": "Annual",
    "startedAt": "2026-09-09T00:00:00.000Z",
    "renewsAt": "2027-03-28T00:00:00.000Z",
    "daysToRenewal": 200
  },
  "entitlements": {
    "planModules": ["dashboard", "hierarchy", "…"],
    "extraModules": ["performance"],
    "removedModules": ["reports"],
    "effectiveModules": ["dashboard", "hierarchy", "performance", "…"]
  },
  "release": { "channel": "Early", "fromPlan": "Stable", "overridden": true },
  "allowance": {
    "aiAllowanceMinor": 100000,
    "aiConsumedMinor": 20000,
    "currency": "USD",
    "percentConsumed": 20
  },
  "seats": {
    "ceiling": 4,
    "contractedCeiling": 4,
    "used": 3,
    "available": 1,
    "rule": "ActiveAndInvited",
    "countedStates": ["Active", "InvitePending"],
    "breakdown": { "Active": 3 },
    "nearCeiling": false,
    "atCeiling": false,
    "grace": null,
    "mayRequestMore": true
  },
  "pendingChange": null,
  "rbacNote": "Roles and permissions are deliberately absent from this object. …"
}
```

**`removedModules` wins over `extraModules`.** Two columns that could disagree need a stated
precedence; the same rule applies on the Master Console and in the provisioning wizard, so three
surfaces cannot answer differently.

**`ceiling` versus `contractedCeiling`.** `ceiling` is the number **in force**, which during a
downgrade grace window is the _old, higher_ one. Both are on the wire because a response carrying
only one would either understate what the company can do today or hide that the contract has
already changed.

**`breakdown` and `countedStates` exist so the number is explicable.** "31 seats used when 28
people work here" is a support ticket; the per-state counts and the named rule make it a sentence
on the screen instead.

### `GET /tenants/:tenantId/commercial/seats`

`@TenantScoped` + `settings:View`. Just the `seats` object above, for a screen deciding whether to
offer an Invite button. It is a **courtesy, not the enforcement** — `SeatService.claimSeat` is,
and this can be stale by the time the click happens, which is precisely why the claim exists.

### `GET` / `POST /tenants/:tenantId/commercial/requests`

`settings:View` to read; **`settings:Administer`** to raise. A request commits the company to a
conversation about money, so it needs the role that speaks for the company.

Body: `kind` (`MoreSeats` | `FewerSeats` | `PlanUpgrade` | `PlanDowngrade` | `MoreAiAllowance` |
`ModuleEntitlement`), the matching value (`requestedSeats`, `requestedPlanCode`,
`requestedAllowanceMinor` or `requestedModules`), and a mandatory `justification` of at least ten
characters.

- **A request that names nothing actionable is a 400** — in the DTO, in the service and in a check
  constraint. A `MoreSeats` row with no seat count would sit in the platform queue looking like
  work in progress.
- **A second open request of the same kind is a 409.** One answer to "what have we asked for".
- **`requestedModules` must be company modules.** A company cannot be entitled to a platform
  control-plane module; the platform is not sellable.

`POST .../requests/:requestId/withdraw` — `settings:Administer`. The company's own request to
withdraw, while it is still `Requested`.

### `GET /platform/commercial/requests`

`@PlatformOnly` + `companies:View`. The decision queue, oldest first, **with the customer named**
(`companyName`, `companySlug`, `companyCode`) — a queue of tenant UUIDs is not a queue anybody can
work.

### `POST /platform/commercial/requests/:requestId/decide`

`@PlatformOnly` + **`companies:Administer`** — Owner and Admin only. A Commercial role defines
plans; deciding which customer is on one is a customer-facing commitment.

Body: `decision` (`approve` | `decline`), optional `note`, `apply` (`now` | `later`), optional
`effectiveAt`.

- **The requester cannot decide their own request** — 403, plus a `Critical`
  `security.commercial_self_decision_blocked` event recorded in its own transaction (S-064).
- **An increase applies immediately.** There is no reason to make a customer wait for capacity
  they have agreed to pay for.
- **A downgrade is normally future-effective.** Applying it the moment it is agreed would take
  away capacity already paid for through the end of the term; the response reports it as
  `pendingChange` and the current plan is unchanged.

### `GET /platform/commercial/companies/:tenantId/seats`

`@PlatformOnly` + `companies:View`. The same `seats` object, computed by the same code that does
the refusing — so an operator deciding a request and a company hitting a refusal cannot disagree
about how many seats are in use.

### `GET /platform/commercial/companies/:tenantId/seat-reduction/:seats`

`@PlatformOnly` + `companies:View`. What a proposed reduction would mean, **before** agreeing to
it.

```json
{
  "used": 3,
  "newCeiling": 2,
  "overBy": 1,
  "needsGrace": true,
  "note": "This company has 3 counted seat(s) and would be 1 over a ceiling of 2. Nobody is removed: a grace window holds the current ceiling while the company offboards, and no user, employment record, task, Agent history or audit row is deleted by this change."
}
```

### `PUT /platform/commercial/companies/:tenantId/seats`

`@PlatformOnly` + `companies:Administer`. The escape hatch for a change agreed on a call rather
than through a request — most real contract changes are. Body: `seats` and a mandatory `reason`.

Returns the resulting seat position. A reduction still applies a grace window and still deletes
nothing, so the non-destructive rule holds regardless of route (ADR-061).

### `GET` / `POST /platform/commercial/companies/:tenantId/lifecycle`

`companies:View` to read, `companies:Administer` to change.

```json
{
  "state": "Active",
  "capability": { "canAccess": true, "canWrite": true, "reason": "…" },
  "allowedNext": ["Suspended", "ReadOnly", "Closed"],
  "history": [
    {
      "fromState": "Provisioning",
      "toState": "Active",
      "reason": "…",
      "effectiveAt": "2026-09-09T00:00:00.000Z",
      "appliedAt": "2026-09-09T00:00:00.000Z",
      "actorUserId": null
    }
  ],
  "scheduled": null
}
```

`capability` comes from the **Prompt 4** table the `TenantGuard` consults on every request, not a
second copy — two tables describing what `Suspended` means would eventually disagree, and the one
the guard reads would win silently.

`POST` body: `toState`, a mandatory `reason` of at least ten characters, optional `effectiveAt`.

- **An illegal transition is a 409** naming the legal ones. `Closed` has none: it is terminal
  through this route (S-065).
- **A future `effectiveAt` records the intent and does not apply it.** `state` stays as it was and
  `scheduled` is populated.
- **A concurrent change is refused, not overwritten** — optimistic concurrency on the tenant's row
  version, because the other change had its own reason.

### `POST /platform/commercial/apply-due`

`@PlatformOnly` + `companies:Administer`. Applies scheduled lifecycle transitions and plan changes
whose date has arrived, returning how many of each. It exists because **no scheduler runs yet**
(limitation 5f); it is deliberately _not_ the enforcement of anything — an unapplied scheduled
suspension still shows the old state, which is correct.

Legality is re-checked at apply time: a company that has since moved elsewhere skips the stale
transition with a logged warning rather than having it forced.

### Security events added at Prompt 11

| Action                                      | Severity | Outcome | Recorded when                                       |
| ------------------------------------------- | -------- | ------- | --------------------------------------------------- |
| `security.company_lifecycle_changed`        | Warning  | —       | a company's operating state changes or is scheduled |
| `security.commercial_self_decision_blocked` | Critical | Blocked | a requester tries to decide their own request       |
| `security.seat_ceiling_reached`             | Notice   | Blocked | a claim is refused at the contracted ceiling        |

## Hierarchy, departments and reporting relationships (Prompt 12)

Every route is `@TenantScoped` with a `@RequirePermission`. Reading the structure needs
`hierarchy:View`, which every company role holds; changing it needs `hierarchy:Administer`,
because a reporting-line change alters what a `TeamSubtree`-scoped manager can reach.

### `GET /tenants/:tenantId/organization/hierarchy`

The whole screen in one call — the client's layout puts the Vision and Mission _above_ the tree,
and two requests would let the strip render before the structure it introduces.

```json
{
  "company": { "name": "Org Co", "vision": "…", "mission": "…" },
  "departments": [
    {
      "id": "01a0…",
      "name": "Regulatory Affairs",
      "code": "REG",
      "parentDepartmentId": null,
      "description": null,
      "headcount": 12,
      "archived": false
    }
  ],
  "tree": {
    "kind": "company",
    "id": "company",
    "name": "Org Co",
    "children": [
      {
        "kind": "department",
        "id": "01a0…",
        "name": "Regulatory Affairs",
        "headcount": 12,
        "children": [
          {
            "kind": "person",
            "id": "01a0…",
            "name": "Priya Nair",
            "person": {
              "userId": "01a0…",
              "ubossUniqueId": "UB-4A9E-3320",
              "employeeId": "E-1101",
              "designation": "Head, Regulatory Affairs",
              "departmentName": "Regulatory Affairs",
              "reportingManagerName": "Arun Mehta",
              "employmentState": "Active",
              "accountState": "NotInvited"
            },
            "children": []
          }
        ]
      }
    ]
  },
  "list": [{ "userId": "01a0…", "employeeId": "E-1101", "aadhaarMasked": "XXXX XXXX 5510" }],
  "employeeCount": 12,
  "identifiersVisible": true,
  "mayAdminister": true
}
```

**The tree groups by department and nests by manager _within_ it.** Anybody whose reporting
manager sits in another department appears at their own department's root — which is what makes a
cross-department reporting line visible instead of hiding the person. Department membership and
the reporting relationship are separate facts, and the shape shows both.

**`aadhaarMasked` is present only when the caller may see it** — `hierarchy:Administer`, or the
person themselves. **Omitted, not nulled** (S-068): a `null` would render as "no identifier on
record", which is a different and false statement. `identifiersVisible` states which case it is.

**`mayAdminister` is sent so a screen can hide controls it knows will be refused.** The server
remains authoritative — every route checks again, and hiding a control is a courtesy.

### `GET /tenants/:tenantId/organization/employee-fields`

The six mandatory field keys, in the client's order, served from the same constant the service
validates against — so the form and the API cannot drift.

```json
{
  "mandatory": [
    { "key": "employeeName", "label": "Employee Name" },
    { "key": "employeeId", "label": "Employee ID" },
    { "key": "designation", "label": "Designation" },
    { "key": "departmentId", "label": "Department" },
    { "key": "reportingManagerUserId", "label": "Reporting Manager" },
    { "key": "aadhaarNumber", "label": "Aadhaar Number" }
  ],
  "note": "Exactly these six fields are mandatory. Every other profile field is optional and must not be marked with an asterisk. Aadhaar Number is an entered-only matching input: there is no OTP, no verification, and no state in UBoss that can claim it is verified."
}
```

### `POST /tenants/:tenantId/organization/employees`

`hierarchy:Administer`. Six mandatory fields, one transaction, **no invitation**.

Body: `employeeName`, `employeeId`, `designation`, `departmentId`, `reportingManagerUserId`,
`aadhaarNumber`, then the optional `workEmail`, `workPhone`, `joinedOn`, `employmentType`.

```json
{
  "userId": "01a0…",
  "ubossUniqueId": "UB-4A9E-3320",
  "matchedExistingPerson": false,
  "employeeId": "E-1130",
  "aadhaarMasked": "XXXX XXXX 5510",
  "aadhaarAssurance": "EnteredOnly",
  "seats": { "used": 13, "ceiling": 40, "available": 27 },
  "invitationSent": false
}
```

Five things happen in one transaction: the global person is matched or created, their identifier
is attached, a seat is claimed under the per-tenant advisory lock (ADR-060), a `NotInvited`
membership is created, and the employment record is written. A person created for an employment
record that then failed would be a permanent UBoss identity belonging to nobody.

- **`aadhaarNumber` is never stored.** The service normalises it, derives a keyed match hash and
  the last four digits, and discards the rest. There is no column it could be written to, and a
  check constraint refuses a raw number in the hash column (S-066).
- **`aadhaarAssurance` is always `EnteredOnly`.** The enum has no `Verified` value.
- **`invitationSent` is always `false`.** Adding somebody to the hierarchy does not invite them —
  the invitation source is Settings → Users & Access (S-071).
- **`reportingManagerUserId` may be omitted only for the first person in a company.** A second
  person with no manager is a **400** that names who is already at the top, because two
  disconnected roots is not a tree.
- **A duplicate company Employee ID is a 409.** Employee IDs are unique inside a company and mean
  nothing outside it.
- **A checksum-invalid Aadhaar is a 400** whose message states plainly that this is a format check
  and that UBoss does not verify Aadhaar.

### `GET` / `PUT /tenants/:tenantId/organization/employees/:userId`

The profile, and this company's employment fields. The `PUT` **cannot touch the person's portable
identity** — there is no field for `ubossUniqueId`, `displayName` or any identifier in the DTO, so
`forbidNonWhitelisted` turns an attempt into a 400. One company must not be able to rewrite an
identity that follows a real person to their next employer.

### `POST /tenants/:tenantId/organization/employees/:userId/reporting-manager`

`hierarchy:Administer`. Body: `newManagerUserId` (omit or `null` to detach) and an optional
`reason`.

- **A cycle is a 409** explaining that the chosen person already reports, directly or indirectly,
  to the person being moved — and a `Blocked` security event is recorded **in its own
  transaction**, so the refusal survives the exception. A database trigger refuses it too,
  whatever wrote it (S-070).
- **Self-management is a 400.**
- **A manager who is not employed here is a 400**, and a composite foreign key refuses it at the
  database as well — the tenant-isolation case (S-069).
- **A manager whose employment has ended is a 409**, with the order of operations named: move
  their reports first.

### `GET` / `POST` / `PUT` `/tenants/:tenantId/organization/departments`

`View` to read, `Administer` to change. A duplicate name is a **409** — two departments sharing a
name make every department-scoped permission ambiguous. Re-parenting a department under its own
descendant is a **409**, because it would detach the branch from the company.

### `POST /tenants/:tenantId/organization/departments/:departmentId/archive`

**Archive, never delete**, and a reason is mandatory. A department that has ever had people in it
cannot be removed without rewriting employment history, so historical records keep pointing at a
department that exists and has a name. Refused with a **409** while anybody is actively employed
in it, or while it still has live sub-departments. The response and the audit metadata both carry
`nothingDeleted: true`.

### `PUT /tenants/:tenantId/organization/identity`

`settings:Administer` — the Vision and Mission are company identity rather than structure. The
endpoint lives in this group because the hierarchy is the screen that displays them; the editing
form moves to Settings → Organization at Prompt 14.

### Security events added at Prompt 12

| Action                             | Severity | Outcome | Recorded when                                                       |
| ---------------------------------- | -------- | ------- | ------------------------------------------------------------------- |
| `security.person_identity_created` | Notice   | —       | a new permanent UBoss identity is minted from an entered identifier |
| `security.reporting_cycle_blocked` | Warning  | Blocked | a reporting-manager change would have closed a loop                 |

`SecurityEventInput` gained a **`subjectUserId`** field at this prompt. `SecurityEvent` has
carried the column and its index since Prompt 8 and the façade never exposed it; creating a
person is an act by an administrator _on behalf of somebody who is not the actor_, and without
this an access review asking "what was done to this person" has to infer the answer from a
resource id.

## Users & Access, guests and bulk enterprise lifecycle (Prompt 13)

Every route is `@TenantScoped` with a `@RequirePermission`. `users:View` reads the roster;
**`users:ManageAccess`** changes anybody's access — its own action in the Prompt 7 vocabulary so
"may edit a person's details" and "may let a person into the company" are separable, and
`ExternalGuest` is forbidden it outright by the user-type ceiling.

### `GET /tenants/:tenantId/access`

The whole screen: the client's three tabs, the seat position, and **why** each person can or
cannot activate.

```json
{
  "employees": [
    {
      "userId": "01a0…",
      "ubossUniqueId": "UB-4A9E-3320",
      "displayName": "Kavya Reddy",
      "email": "",
      "userType": "InternalUser",
      "accountState": "NotInvited",
      "employeeId": "E-1130",
      "designation": "Regulatory Associate",
      "departmentName": "Regulatory Affairs",
      "reportingManagerName": "Priya Nair",
      "employmentState": "Active",
      "roleCount": 0,
      "guestAccessExpiresAt": null,
      "guestExpired": false,
      "invitation": null,
      "readiness": {
        "ready": false,
        "missing": ["at least one company role"],
        "summary": "Not ready to activate — still needs at least one company role. An account that could sign in with none of these would look like it works and reach nothing."
      }
    }
  ],
  "guests": [],
  "pendingInvitations": [],
  "seats": { "used": 13, "ceiling": 40, "available": 27, "atCeiling": false },
  "counts": { "employees": 13, "guests": 0, "pendingInvitations": 0 }
}
```

**`email` is empty rather than the synthesised placeholder.** A person in the org chart with no
work address has `<uboss-id>@person.uboss.invalid`, which is not an address — showing it would
invite somebody to email it.

**A person appears in Pending Invitations _as well as_ their own tab.** The tab is a work queue
("who is waiting"), not a category; hiding a pending employee from Employees would make the
roster incomplete.

**`readiness` is per person, and lists every missing prerequisite.** The client's rule is that a
new internal employee needs a department, a manager and a role before activation (ADR-065). The
screen puts the reason on the row, because "why can I not invite this person" is the next
question either way.

### `POST /tenants/:tenantId/access/invitations`

`users:ManageAccess`. Body: **`subjectUserId`** and an optional `workEmail`.

**Keyed on the person, never on an email.** Somebody already in the hierarchy has a permanent
UBoss identity; inviting them by email would create a second one (S-072). The optional
`workEmail` replaces the synthesised placeholder and becomes their sign-in address.

```json
{
  "userId": "01a0…",
  "ubossUniqueId": "UB-4A9E-3320",
  "resent": false,
  "seats": { "used": 14, "ceiling": 40, "available": 26 },
  "tokenReturned": false
}
```

- **A seat is claimed** (S-074). `InvitePending` is counted by the default rule, so this is the
  path that consumes one — refused at the ceiling with the contract named.
- **Refused before sending** when the person is not ready to activate, with the reason. Sending
  an email that cannot be used is worse than being told now.
- **The activation token is never returned.** `tokenReturned: false` is on the wire so the screen
  can say so; the token exists once, inside the invitation service.
- **Refused for an offboarded person**: reinstate them first, so bringing somebody back is an
  explicit decision.

### `POST /tenants/:tenantId/access/guests`

`users:ManageAccess`. Body: `email`, `displayName`, `resourceIds` (at least one), `accessDays`
(1–365) and a mandatory `reason`.

Creates a membership with `userType = ExternalGuest` and a **mandatory** access expiry, **no
employment record**, and a role assignment scoped to `SelectedResource` expiring with the access
(ADR-066).

- **An empty `resourceIds` is a 400.** It would mean company-wide access, and "whatever they
  need" is not a scope anybody can review.
- **Over 365 days is a 400.** A longer grant is indistinguishable from a standing one.
- **An existing internal member is a 409.** An employee cannot also be a guest; a database
  trigger refuses it too, from both directions.

### `POST .../access/people/:userId/suspend` · `.../reinstate`

`users:ManageAccess`, reason mandatory. Suspension is reversible and touches **nothing** but the
account state — roles, employment record and audit history all stay. Under a
per-provisioned-person counting rule a suspended person keeps their seat, which is deliberate.

**Neither can be done to oneself**: a company must not be lockable-out by one person acting
alone.

Reinstating claims a seat, because a counting rule that frees a suspended person's seat may have
let somebody else take it.

### `GET .../access/people/:userId/offboarding-impact`

What an offboarding would move, before agreeing to it.

```json
{
  "directReports": 4,
  "roleAssignments": 2,
  "successorRequired": true,
  "domains": [
    { "key": "roleAssignments", "label": "Company roles and scopes", "status": "implemented" },
    {
      "key": "openWork",
      "label": "Open Human To-do tasks",
      "status": "not-implemented",
      "arrivesWith": "the Approve & Assign / Human To-do prompt"
    }
  ],
  "note": "Nothing is deleted. The membership, the employment record and every audit event are kept … 4 direct report(s) move to the successor, who must be named."
}
```

### `POST .../access/people/:userId/offboard`

`users:ManageAccess`. Body: optional `successorUserId` and a mandatory `reason`.

One transaction: direct reports move, roles are **revoked**, the account state becomes
`Offboarded`, the employment record becomes `Ended` with a date, and any outstanding invitation is
cancelled (ADR-067).

```json
{
  "offboardingId": "01a0…",
  "subjectUserId": "01a0…",
  "successorUserId": "01a0…",
  "handover": {
    "reportingLine": {
      "status": "moved",
      "detail": "4 direct report(s) now report to the successor.",
      "moved": 4
    },
    "roleAssignments": {
      "status": "revoked",
      "detail": "2 role assignment(s) revoked. Roles are not transferred: copying them onto a successor would silently widen their authority.",
      "moved": 0
    },
    "openWork": {
      "status": "not-implemented",
      "detail": "Open Human To-do tasks cannot be transferred yet — it arrives with the Approve & Assign / Human To-do prompt. Nothing of this kind exists to move, and this record says so rather than implying it was handled."
    }
  },
  "nothingDeleted": true
}
```

- **A successor is required when there are direct reports**, and the 400 names the count.
  Offboarding without one would leave people reporting to somebody whose employment has ended.
- **Roles are revoked, not transferred.** The successor inherits work, not permissions.
- **The person's UBoss Unique ID is untouched.** It is theirs and follows them to their next
  employer.

### `POST /tenants/:tenantId/access/bulk/validate`

The **operation kind's own** permission (`BULK_PERMISSIONS`), not the route's. Body: `kind`,
`content` (CSV text), optional `sourceFileName` and `reason`.

**Applies nothing.** Every row is persisted with its outcome and **all** of its errors:

```json
{
  "operationId": "01a0…",
  "kind": "ImportEmployees",
  "state": "Validated",
  "totalRows": 3,
  "validRows": 2,
  "invalidRows": 1,
  "rows": [
    {
      "rowNumber": 4,
      "state": "Invalid",
      "input": { "employeeName": "" },
      "errors": [
        "Employee Name is required.",
        "Department \"Nonexistent\" does not exist in this company. Create it first, or correct the spelling."
      ]
    }
  ],
  "note": "Nothing has been applied. Applying will act on the 2 valid row(s) and skip the 1 invalid one(s). Every row is applied as you, with your permissions and against this company's seat ceiling, so a row asking for something you cannot grant fails on its own rather than taking the file with it."
}
```

**Header names are matched loosely.** `Employee ID`, `employee_id` and `EmployeeID` are one
column — an alias table with punctuation and case stripped, because a camel-case transform alone
produces `employeeID` and reports a present column as missing.

**`rowNumber` matches the spreadsheet's own numbering**, header included. An error pointing at the
wrong line is worse than no line number.

### `POST /tenants/:tenantId/access/bulk/:operationId/apply`

Applies row by row, each through the same service a single-record change uses (ADR-068).

```json
{ "applied": 397, "failed": 2, "skipped": 1 }
```

- **Partial application is deliberate.** A 400-row import rejected for three bad rows is worse
  for the customer than 397 applied and three named.
- **Only the person who validated it may apply it** — the rows were checked against their
  authority.
- **An applied operation cannot be applied twice** (409).
- **A bulk role change is refused at apply time**, with the reason: it must go through the role
  administration service so its three escalation gates apply (S-077).
- **An escalation attempt records a `Critical` security event** of its own.

### Security events added at Prompt 13

| Action                             | Severity | Outcome | Recorded when                                             |
| ---------------------------------- | -------- | ------- | --------------------------------------------------------- |
| `security.account_suspended`       | Warning  | —       | somebody's access is suspended                            |
| `security.account_reinstated`      | Notice   | —       | a suspended account is reinstated                         |
| `security.account_offboarded`      | Warning  | —       | somebody is offboarded and their roles revoked            |
| `security.guest_access_granted`    | Warning  | —       | a guest is given resource-scoped access with an expiry    |
| `security.bulk_escalation_blocked` | Critical | Blocked | a bulk row asked for something the requester cannot grant |
| `security.bulk_operation_applied`  | Warning  | —       | a bulk operation is applied, with its row counts          |

## Company Settings shell and governance configuration (Prompt 14)

`settings:View` gets a caller to the screen. **Each individual setting's own permission is then
checked by the service** — the client's rule that the backend enforces every setting permission.

### `GET /tenants/:tenantId/settings`

The whole shell, scoped to what this caller may read.

```json
{
  "categories": [
    {
      "key": "notifications",
      "anyEditable": true,
      "settings": [
        {
          "key": "notifications.approval_reminder_hours",
          "category": "notifications",
          "label": "Approval reminder after (hours)",
          "description": "How long an approval may sit before the approver is reminded…",
          "type": { "kind": "integer", "min": 0, "max": 336 },
          "value": 24,
          "source": "default",
          "defaultValue": 24,
          "material": true,
          "editable": true
        }
      ]
    },
    {
      "key": "users",
      "anyEditable": false,
      "settings": [],
      "note": "Managed on Settings → Users & Access: the three tabs, invitations, guests, suspension, offboarding and bulk operations."
    }
  ],
  "withheldCategories": 0
}
```

**`source` is `company`, `platform` or `default`** — the three inheritance layers, in that
precedence. It is on the wire because "we chose 24 hours" and "nobody has chosen, so it is 24
hours" are different facts, and a screen showing only the number invites the wrong one.

**`editable` is per setting, and is the server's answer.** A screen may disable a control on it;
the write path checks again.

**A category with no settings of its own still appears, with a `note`** saying where its
configuration actually lives. The client asked for the full information architecture, and a
category silently missing from the sidebar reads as a permission problem — a different and
misleading message.

**`withheldCategories`** counts the ones this caller may not read. Stated, so a shorter list is
explicable rather than looking like a missing feature.

### `GET /tenants/:tenantId/settings/categories`

The complete nineteen-category architecture, returned to **any** caller who reaches the screen.
Nineteen rather than the original Prompt 14 list of seventeen: the client's later amendments added
UBoss Profile Search Policy and Performance & Reward Policy.

This route is deliberately not narrowed by permission — **authorization is never through hidden
navigation** (S-079). The sidebar a person sees is narrower as a consequence of the per-setting
read check, and a write is refused whether or not the category was shown.

### `PUT /tenants/:tenantId/settings`

Body: `values` (a map of catalogue key to value) and an optional `reason`.

**Several at once**, because a settings panel has one Save button and cross-setting rules exist —
validating one field at a time cannot see that escalation must not precede the reminder.

Five checks, in order, and the whole payload is refused if any fails:

1. **Every key is in the catalogue.** An unknown key is a 400 (S-080).
2. **Every key's own write permission**, individually. The refusal names the setting and the
   permission it needs — a partial save is a change nobody asked for.
3. **Each value against its declared type.** A checkbox's `"true"` and a number input's `"24"`
   are accepted as the string form of their declared type; anything else is refused with the
   reason.
4. **The combination**, against the _effective_ values after the change — so a rule between two
   settings applies even when only one of them is being changed.
5. **A material change has a reason.**

```json
{
  "changed": [
    {
      "key": "notifications.approval_reminder_hours",
      "value": 8,
      "source": "company",
      "material": true,
      "editable": true
    }
  ]
}
```

### `GET /tenants/:tenantId/settings/history?key=…`

**`settings:Audit`** — reading who changed a governance setting and why is an audit question.

```json
{
  "key": "notifications.approval_reminder_hours",
  "changes": [
    {
      "previousValue": "12",
      "newValue": "8",
      "reason": "Tightened again after the March review.",
      "changedByUserId": "01a0…",
      "changedAt": "2026-09-09T10:14:00.000Z"
    },
    {
      "previousValue": null,
      "newValue": "12",
      "reason": "Approvals were sitting too long over a weekend.",
      "changedByUserId": "01a0…",
      "changedAt": "2026-09-09T09:02:00.000Z"
    }
  ]
}
```

`previousValue` is `null` for the first change: there was no company value, only the inherited
default.

**A non-material setting is a 409**, with the reason — the audit trail still records every change,
and keeping history for everything would bury the entries that matter (ADR-070).

### `GET /tenants/:tenantId/settings/value/:key`

One effective value, for a screen that needs a single policy rather than the whole shell.

### Audit events added at Prompt 14

| Action             | Recorded when                    | Metadata                                                 |
| ------------------ | -------------------------------- | -------------------------------------------------------- |
| `settings.changed` | any setting changes, per setting | key, category, `material`, `newValue`, `hadCompanyValue` |

The new value is in the metadata deliberately: a settings change with no record of what it became
is not an audit event anybody can use. These are configuration values rather than secrets, and the
Prompt 8 redaction pass still runs over the metadata.

## Not yet implemented

**Company-scoped administration is still the one remaining interim decision, and it has now not
happened at Prompt 8 _or_ Prompt 9.** Prompt 8 built the audit foundations; Prompt 9 built the
Master Console. Both were the prompt the client asked for, and both times the re-homing was the
thing that did not get done — stated plainly a second time rather than quietly re-dated.

**Originally:** Prompt 8 built the audit and security foundations; the six route groups
still wait. The two audit route groups above are the proof the mechanism works, and the
re-homing is now Prompt 9's. Stated rather than left as a promise that quietly slipped.

**Prompt 7 is what
unblocks it.** Six route groups sit on the platform plane waiting for a Company Admin to hold
them: invitations, administrative session revoke, authentication policy, SSO connections and domain
claims, SCIM credentials, and authorization administration itself. Each is `@PlatformOnly` with a
comment saying so. The engine that will carry them now exists — the acceptance test is that those
decorators become `@RequirePermission({ module: 'roles', action: 'ManageAccess' })` and the tenant
id comes from a verified membership rather than a path parameter.

**`TeamSubtree` scope cannot be evaluated** until the reporting hierarchy arrives (Prompt 12). It
returns a distinct `scope-unevaluable` denial rather than defaulting either way (ADR-044).
`Department` and `MultipleDepartments` work today.

**SAML assertion consumption** is declared and refused rather than absent (S-033).
**WebAuthn/passkeys** are a value in the `auth_method` enum with no verifier; the factor model,
policy and enrolment flow are method-agnostic. **The TCSiON mapping table is empty** and reports
that fact, pending the client's approved reference.

Hierarchy, Objectives, Engine Agents, the Executor Agent, Skills, approvals, credits and
notifications each arrive with the prompt that owns them, together with DTO validation, permission
checks, audit events and tests. Email delivery of invitation and reset links belongs to the
notifications module (Prompt 28).

This section is the guard against speculative endpoints appearing early.

## Performance score and badge engine (Prompt 12B)

`/tenants/:tenantId/performance/*`. The special prompt from the pack, delivered after Prompt 14 —
12A shipped inside Prompt 12 (the global person registry, ADR-062), 12B had been missed.

| Method | Route                         | Permission                 | Purpose                                                        |
| ------ | ----------------------------- | -------------------------- | -------------------------------------------------------------- |
| GET    | `/performance/me`             | `performance:View`         | The caller's own score, level, timeline and badge history      |
| GET    | `/performance/policy`         | `performance:View`         | The active policy — points per outcome and the five thresholds |
| PUT    | `/performance/policy`         | `performance:Administer`   | Supersede the active version and create version N+1            |
| GET    | `/performance/:subjectUserId` | `performance:View` + scope | One person's record                                            |
| POST   | `/performance/events`         | `performance:Administer`   | A manual adjustment, or an approved blocker's neutralisation   |

**Only two event kinds are postable.** `OnTimeAccepted`, `LateCompletion`, `Missed` and
`QualityRejected` are recorded by the modules that own the work — a to-do completion, an approval
decision, the deadline sweeper — through `PerformanceService.recordEvent`. A route that accepted
them would let anybody with the permission mint points for work that never existed, and audit does
not make that acceptable: the value of the ledger is that every row points at real work. The DTO
refuses a derived kind with a message naming who records it.

**Reading somebody else's is scoped, not a second rule.** The route permission is the floor;
`viewFor` re-checks with the subject as `ownerUserId`, so `OwnWork` reads only itself,
`TeamSubtree` reads a manager's reports and `WholeCompany` reads the company. The Prompt 7 engine
answers it.

**`performance:Administer` is new on Company Admin**, the role that already holds every other
`Administer`. Deliberately not on `Head` or `Manager`: a department head setting company-wide
thresholds, or adjusting their own reports' scores unilaterally, is the conflict the separation
exists to prevent. A manager's exception reaches the ledger through the approvals path.

### The score is derived and the response proves it

`GET /performance/:id` returns `score` **and** the events it is the sum of, plus the
`policyVersion` that scored them. A client can add up the timeline and get the score. There is no
stored total, so a policy change re-derives levels without a migration to fix up numbers — and
`points` on each event is what the policy said **at the time**, never recomputed.

`onTimePercent` is `null` rather than `0` when nothing has been completed: zero means "never
delivered on time", which is a different claim from "has not delivered yet".

`nextLevel` is `null` at Diamond, and a score below the Bronze threshold reports **Bronze with a
negative score** rather than inventing a sixth rung — the client's ladder has five.

### Idempotency is on the wire

`POST /performance/events` returns `alreadyRecorded: true` and the original `eventId` when the same
`(subject, sourceKind, sourceId, kind)` has already been scored. The caller learns nothing was
added rather than being told the write succeeded twice. The same source may carry **different**
kinds — a task can be late and then rejected — because the unique key includes the kind.

### Audit events added at Prompt 12B

| Action                         | When                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `performance.event_recorded`   | Every scored event, with its kind, points and policy version                   |
| `performance.badge_changed`    | A level transition, from → to, with the score                                  |
| `performance.policy_versioned` | A new policy version, with `pastScoresRewritten: false` stated in the metadata |
| `performance.exit_snapshot`    | The final snapshot written when employment ends                                |

## Notifications and escalation (Prompt 15)

`/tenants/:tenantId/notifications/*` for a person's own notifications, `/platform/notifications/*`
for the jobs behind them.

| Method | Route                                   | Permission                      | Purpose                                                                                                       |
| ------ | --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | `/notifications`                        | `dashboard:View`                | The centre, filtered: `unread`, `assignedToMe`, `awaitingAcknowledgement`, `kind`, keyset-paged with `before` |
| GET    | `/notifications/counts`                 | `dashboard:View`                | The bell's three numbers                                                                                      |
| POST   | `/notifications/read`                   | `dashboard:View`                | Mark named ids read                                                                                           |
| POST   | `/notifications/read-all`               | `dashboard:View`                | Mark all read — **does not clear acknowledgements**                                                           |
| POST   | `/notifications/:id/acknowledge`        | `dashboard:View`                | Acknowledge a critical item. Audited                                                                          |
| GET    | `/notifications/preferences`            | `dashboard:View`                | Every kind, the caller's choice or the default, and whether it is mutable                                     |
| PUT    | `/notifications/preferences`            | `dashboard:View`                | Change one. Refused for a mandatory kind                                                                      |
| POST   | `/platform/notifications/dispatch`      | `platform-dashboard:Administer` | Deliver what is queued                                                                                        |
| POST   | `/platform/notifications/escalate-due`  | `platform-dashboard:Administer` | Escalate what is unacknowledged past its deadline                                                             |
| POST   | `/platform/notifications/budget-alerts` | `platform-dashboard:Administer` | Raise newly crossed budget and seat thresholds                                                                |

**Every company route is about the caller's own notifications.** There is no route that reads
somebody else's, and no permission governs reading your own — the row was addressed to this
person. A "read anybody's notifications" permission would be a surveillance feature nobody asked
for; requiring one to see your own bell would mean a guest could not be told they had been
invited. `dashboard:View` is the floor so an unauthenticated or non-member request is refused by
the guard rather than a null check, and **recipient scoping is in the `where` clause** — a valid
id belonging to somebody else matches nothing rather than being checked afterwards.

### Three counts, because there are three states

`unread`, `awaitingAcknowledgement`, `assignedToMeUnread`. The second is not cleared by reading,
so an unread count of zero can still mean somebody must act — which is why the bell carries two
numbers and turns red on the second.

### The bell

`AppShell` gained `unreadNotifications` and `awaitingAcknowledgement`. The count renders as a
**badge**, never concatenated into the label (a locked rule), capped at `99+`, with the real
number in the `aria-label` so it still reaches a screen reader. Nothing unread but something
awaiting acknowledgement shows a dot rather than a `0`, which would say the opposite.

### Preferences, and what cannot be changed

Six kinds. A kind with no stored row uses the documented default (in-app and email on, no
digest), so nobody has to configure anything. `isMandatoryNotification` from `@uboss/types` is the
**single** answer to "can this be muted", asked by both the engine and the screen — two
implementations would eventually disagree and the one that mattered would be the engine's.

A digest batches **email only**. There is no digest for the in-app centre: a bell that updates
once a day is a bell nobody trusts. A mandatory alert ignores the digest entirely — "your account
was accessed from a new country, in Friday's summary" is not a reasonable reading of it.

### Email is the Prompt 10 outbox, not a second queue

`OUTBOX_TOPICS` gained `notification.email` and `notification.digest`, and
`NotificationDispatcherService` is **the first consumer of that queue** — closing the "no
dispatcher exists yet" limitation `OutboxRepository` has carried since Prompt 10. At-least-once
delivery inside the caller's transaction, an idempotency key of `notification-email:<id>`,
exponential backoff and dead-lettering all came with it.

The payload carries **a notification id and nothing else** — no address, no body. An outbox row is
long-lived, widely readable working state; the address and the message are read at dispatch time,
one query, from the services that own them.

### `EmailAdapter` never claims delivery it did not perform

The default `LoggingEmailAdapter` records and sends nothing, and says so: `describe()` reports
`deliversRealMail: false`, the dispatch response repeats it, and every
`notification.email_dispatched` audit event carries `channel` and `deliversRealMail`. With no
provider configured, "delivered" means "handed to something that recorded it". A deployment with a
verified provider swaps one line in the module.

**This is an implemented adapter, not a live credential-verified integration.** No mail has been
sent to a real provider.

### Audit events added at Prompt 15

| Action                          | When                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `notification.raised`           | Every notification, with its kind, severity, whether it was mandatory and whether a preference was overridden |
| `notification.acknowledged`     | Somebody asserting they have seen a critical alert. Read state is **not** audited — it is housekeeping        |
| `notification.escalated`        | An unanswered item escalated, naming both people                                                              |
| `notification.email_dispatched` | Handed to a channel, with the channel and whether it delivers real mail                                       |

## Integrations, Connections and Agent Tool Permission (Prompt 16)

`/tenants/:tenantId/connections/*`.

| Method | Route                                       | Permission floor                | Purpose                                                                                 |
| ------ | ------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| GET    | `/connections/catalogue`                    | `settings:View`                 | The connectors that exist, and every tool category with its risk                        |
| GET    | `/connections`                              | `settings:View`                 | Every connection this caller may see, each state derived                                |
| GET    | `/connections/:id`                          | `settings:View`                 | One connection with its live tool grants                                                |
| POST   | `/connections`                              | `settings:View`                 | Create. `Administer` for a Company Connection; own User Connection needs only the floor |
| POST   | `/connections/:id/check`                    | `settings:View`                 | _Test Connection_                                                                       |
| POST   | `/connections/:id/rotate-secret`            | `settings:View`                 | Replace the credential, keeping the handle                                              |
| POST   | `/connections/:id/reauthorize`              | `settings:View`                 | Clear withdrawn consent                                                                 |
| POST   | `/connections/:id/disable`                  | `settings:View`                 | Disable, with a mandatory reason                                                        |
| POST   | `/connections/:id/enable`                   | `settings:View`                 | Re-enable                                                                               |
| POST   | `/connections/:id/transfer-owner`           | `settings:Administer`           | Company connections only                                                                |
| POST   | `/connections/:id/tool-permissions`         | `settings:Administer`           | Grant one Engine Agent one category                                                     |
| DELETE | `/connections/tool-permissions/:grantId`    | `settings:Administer`           | Revoke, kept as a row                                                                   |
| POST   | `/platform/notifications/connection-expiry` | `platform-dashboard:Administer` | The credential-expiry sweep                                                             |

**The decorators are the floor, not the check.** Whether `Administer` is required depends on **who
owns the row**, which a guard cannot know before the row is loaded — so the lifecycle routes carry
`View` and the service decides. That is the Prompt 7 two-phase shape, not a relaxation, and the
service's `assertMayConfigure` is where the rule lives.

### No route returns a credential

Not one. Every response carries `secretRef` (the handle) and `hasSecret`; `secret` appears only in
request bodies, on its way to `SecretsVault.put`. The only path to plaintext is
`SecretsVault.reveal`, called by the service at the moment of use and handed straight to a
connector adapter. A test serialises the whole list response and asserts the credential string
does not appear in it.

### Human permission ≠ Agent Tool Permission

The client's rule, and the reason for two files. `settings:Administer` lets a **person** configure
an integration. A `ConnectionToolGrant` lets an **Engine Agent** act through one. Holding the
first grants none of the second, and `ConnectionService.mayAgentUse` — the only function that
answers it — takes an `agentId`, never a user id, so it cannot be satisfied by passing a person.

A unit test in `@uboss/types` asserts the two vocabularies **share no member**, so an edit that
reaches for the convenient answer fails there rather than in production.

`mayAgentUse` requires **both** a live grant and a `Connected` state. A grant on an expired
credential is permission that would fail, and failing at the boundary rather than at the provider
is what prevents a half-completed external action.

### The five states are derived

There is no `state` column. `derivedConnectionState` reads `disabledAt`, `credentialExpiresAt`,
`needsReauthorization` and `lastError` at read time, with `Disabled` first and `Expired` before
`NeedsReauthorization` — the precedence _is_ the logic. A credential that expired an hour ago is
expired now, whether or not a sweep has run.

### High-risk tool categories

`Delete`, `ExternalBulkSend`, `SensitiveExport`, `FinancialChange`, `ProductionChange` — the
client's four, plus `Delete`, which they name first. Each needs a reason, refused by the service
**and** by a check constraint. `Read` and `Write` do not.

### The two adapters, and what they claim

| Seam               | Default                                                                       | Reports                                 |
| ------------------ | ----------------------------------------------------------------------------- | --------------------------------------- |
| `SecretsVault`     | Local sealed store — AES-256-GCM through `SecretBox`, in `connection_secrets` | `isExternalProvider: false`             |
| `ConnectorAdapter` | Mock connector                                                                | `isMock: true` on every catalogue entry |

**Both are implemented adapters, not live credential-verified integrations.** No external secrets
provider and no vendor is connected. The catalogue lists **only** the mocks: naming Salesforce
with nothing behind it would fail in a way that looks like a credential problem.

The mock reads its instruction from the secret — `mock:ok`, `mock:reauthorize`,
`mock:expires:<date>`, `mock:fail:<message>` — so every state the governance layer can produce is
reachable and tested. Anything else fails as an unrecognised credential, because a mock that
succeeded for any input would make every failure test meaningless.

### Audit events added at Prompt 16

| Action                                                   | When                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `connection.created`                                     | With the handle, the vault's name, the scope and the environment     |
| `connection.check_succeeded` / `connection.check_failed` | Every _Test Connection_, with the duration and the adapter's message |
| `connection.secret_rotated`                              | With `handleUnchanged: true` and `liveGrantsPreserved: true`         |
| `connection.reauthorized`                                | Whether a credential was also replaced                               |
| `connection.disabled`                                    | With the affected agent count and `grantsRevoked: false`             |
| `connection.enabled`                                     |                                                                      |
| `connection.owner_transferred`                           | Both people, with the reason                                         |
| `connection.tool_permission_granted`                     | With `permissionKind: 'AgentToolPermission'` and `highRisk`          |
| `connection.tool_permission_revoked`                     | With the reason                                                      |

## Skill Catalog and Company Skills & AI (Prompt 17)

`/tenants/:tenantId/skills/*` for a company; `/platform/skills/*` for the UBoss catalogue.

| Method | Route                                      | Permission floor      | Purpose                                                                                        |
| ------ | ------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/skills/catalogue-meta`                   | `settings:View`       | Layers, categories, autonomy levels, creation modes, statuses, tool categories, impact domains |
| GET    | `/skills`                                  | `settings:View`       | The catalogue: platform Skills **and** this company's                                          |
| GET    | `/skills/:id`                              | `settings:View`       | One Skill with every version                                                                   |
| POST   | `/skills`                                  | `settings:Administer` | Create a company custom Skill as a draft                                                       |
| POST   | `/skills/clone`                            | `settings:Administer` | **The only way to get your own version of a platform Skill**                                   |
| POST   | `/skills/:id/versions`                     | `settings:Administer` | Start a new draft — the published version is untouched                                         |
| PUT    | `/skills/versions/:id`                     | `settings:Administer` | Edit an open draft. Refused once frozen                                                        |
| POST   | `/skills/versions/:id/transition`          | `settings:View`       | Move through the lifecycle; the service decides the real permission                            |
| GET    | `/skills/versions/:id/impact`              | `settings:View`       | What an upgrade would affect                                                                   |
| GET    | `/skills/versions/:id/history`             | `settings:View`       | The governance trail                                                                           |
| POST   | `/platform/skills`                         | `skills:Create`       | Create a Verified Skill or an Industry Pack                                                    |
| POST   | `/platform/skills/versions/:id/transition` | `skills:Publish`      | Move a platform version                                                                        |

### There is no template route

No "instantiate", no "use as a starting point", no library. The locked rule is that there is no
Objective, Workflow or Agent Template and no Templates Library, and the **shape of the API** is
what keeps it true: the only path to a Skill of your own is `clone`, which produces a **draft
under this company's own approval** with its provenance recorded — so the catalogue can still
answer "who cloned this", which a template could never do.

### Who may do what, and why the floor is `View`

- **Read** the catalogue: `settings:View`. Not privileged — an employee needs to know what
  capabilities exist to understand what an agent is doing.
- **Author**: `settings:Administer`.
- **Approve _or reject_**: `settings:Approve`, which **only the `Approver` role holds**.

That last one is load-bearing. Prompt 17 wanted to put `settings:Approve` on `CompanyAdmin` and
the Prompt 7 invariant test refused — correctly. The client's model is that an administrator who
must also approve is _additionally_ assigned the Approver role, so the second decision is visible
in the assignment record rather than implied by a job title. Approving and **rejecting** are the
same permission: a lifecycle where a reviewer can approve but not send back is one that gets
worked around by approving things and fixing them later.

The transition route's decorator is therefore `View` and the **service** decides, because which
permission a move needs depends on the move _and_ on the row's current status — neither of which
a guard can know before the row is loaded. The Prompt 7 two-phase shape.

### The lifecycle is a closed table

`Draft → Test → Review → Approved → Published → Deprecated → Archived`, with `ALLOWED_SKILL_TRANSITIONS`
as the single source. Three shapes matter:

- **`Published` has no route back to `Draft`.** An authorised edit creates a new version.
- **`Archived` is terminal.** A new version is how a capability comes back.
- **`Review → Draft` exists**, because rejection must not be a dead end.

Each version response carries `nextStatuses` — straight from that table — so a screen offers
exactly the moves the server will accept.

### Content freezes at `Approved`, which is stricter than the client asked

The rule names publication. Freezing at approval is deliberate: an approval is a decision about
**specific content**, so content that could change afterwards would let somebody get "delete
records" approved by having "read records" reviewed. Enforced by a database trigger, so the
status can still move (`Published → Deprecated → Archived`) while the content cannot.

### Impact analysis reports unknown, not zero

Five domains. **Three cannot be counted yet** — Engine Agents, Objectives and runs in flight all
arrive at later prompts — and each returns `count: null` naming the prompt that will make it real,
with `incomplete: true` at the top. An analysis that under-reports is worse than one that admits
its limits, because somebody would publish on the strength of it. `clones` is counted today.

### Audit events added at Prompt 17

| Action                                                                                                        | When                                                          |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `skill.created`                                                                                               | A company draft, with its creation mode and autonomy          |
| `skill.cloned`                                                                                                | With the source layer and version, and `startsAs: 'Draft'`    |
| `skill.new_draft_started`                                                                                     | With `publishedVersionUnchanged: true`                        |
| `skill.review` / `skill.approved` / `skill.published` / `skill.deprecated` / `skill.archived` / `skill.draft` | Every lifecycle move, with `contentFrozen`                    |
| `skill.platform_created` / `skill.platform_*`                                                                 | The platform plane, with `visibleToEveryCompanyOncePublished` |

## Skill Router and Evaluation Foundation (Prompt 18)

`/tenants/:tenantId/skill-router/*`.

| Method | Route                                             | Permission            | Purpose                                               |
| ------ | ------------------------------------------------- | --------------------- | ----------------------------------------------------- |
| GET    | `/skill-router/meta`                              | `agents:View`         | The router's own parameters and the rules it enforces |
| POST   | `/skill-router/route`                             | `agents:Run`          | Select approved Skills, or raise a Candidate          |
| GET    | `/skill-router/candidates`                        | `settings:View`       | The governance queue                                  |
| POST   | `/skill-router/candidates/:id/accept`             | `settings:Administer` | Accept — creates a **draft** Skill                    |
| POST   | `/skill-router/candidates/:id/decide`             | `settings:Administer` | Move under review, or reject with a reason            |
| GET    | `/skill-router/skills/:id/cases`                  | `settings:View`       | Saved evaluation cases                                |
| POST   | `/skill-router/skills/:id/cases`                  | `settings:Administer` | Save a case                                           |
| POST   | `/skill-router/runs`                              | `settings:Administer` | Record what a version returned                        |
| POST   | `/skill-router/versions/:id/compare`              | `settings:View`       | Regression comparison against the live version        |
| GET    | `/skill-router/skills/:id/comparisons`            | `settings:View`       | Every comparison, newest first                        |
| POST   | `/skill-router/comparisons/:id/accept-regression` | `settings:Administer` | Publish over a regression, deliberately               |

**Routing is `agents:Run`, not an administration permission.** Finding out which Skills apply to a
piece of work is part of doing the work, so an employee who may run an approved agent can ask.
Administering the catalogue is a different permission on a different route.

### Two client rules, and the code shape that enforces them

**1. No unapproved Skill is ever selected.** The candidate query filters `status: 'Published'`, so
a draft is not even considered — and `scoreSkillForContext` disqualifies any other status as a
second lock. There is no parameter that relaxes it. A test asserts that a catalogue containing only
drafts produces zero matches **and zero rejections**, because a draft never entered the set.

**2. A missing capability is recorded, never improvised.** When nothing applies, `route` creates a
`SkillCandidate` carrying the routing context and every rejection, and routes it to governance.
The Candidate status enum has **no `Published` member** — there is no value to set — and accepting
one creates a **draft** Skill that goes through the normal lifecycle. `raiseCandidateIfMissing`
defaults to true, because making the client's rule opt-in would mean the common path dropped it.

### The selection is explainable, and that is deliberate

There is no model. The router is a rules engine over what a Skill **declares about itself** — the
fields Prompt 17 made mandatory exist precisely so a capability can be chosen without guessing.

A selection nobody can explain cannot be governed: somebody will ask "why did an agent use _that_
Skill on our tender", and "the embedding was close" is not an answer a company can act on. So:

- Every match carries `confidence` (0–100) **and** its `reasons`.
- Every rejection carries the **one rule** that ruled it out.
- The whole decision is reproducible from its inputs, which is why no routing-decision table
  exists — only the exception (a Candidate) is persisted.

**Hard rules disqualify; they never rank lower.** Not published, needs a tool this work forbids,
autonomy above the company's ceiling, work requires approval and the Skill does not, a required
input is unavailable, wrong category, or the Skill's own **"when not to use it"** is mostly about
this task. Ranking a policy violation slightly lower is how it eventually gets used.

**A relevance signal is required.** Matching the category and needing few tools are a filter and a
tie-breaker; neither is evidence. A Skill must match on its "when to use", its purpose, or the
requested output, or it is not offered — which a test caught when a birthday-message Skill scored
exactly the floor for tender screening.

**At most five results.** The caller is choosing one; a list of twenty is a list nobody reads.

### Evaluation: the harness records, it does not run

There is **no evaluator** — running a Skill needs the Model Gateway. A run's `actualOutput` is
**supplied** by an operator or a test, `producedBy` records `Recorded`, and the audit metadata
says so in words. A stub inventing plausible output would make every green comparison worthless,
and a comparison is exactly the evidence somebody publishes on.

Three assertion kinds: `ExactMatch`, `ContainsAll`, `HumanJudged`. The last **cannot be computed**
and returns no verdict unless a person supplies one with a note — an unjudged run counts as
neither pass nor fail, so no comparison can lean on it.

### Regression comparison

Cases belong to the **Skill**, not a version, so the same case runs against the live version and a
candidate. The comparison uses each case's **latest** run against each version.

| Verdict        | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| `Improved`     | Passes everything the live version passes, and more           |
| `NoChange`     | Identical on every case that could be compared                |
| `Regressed`    | **Blocks.** Something the live version passes, this one fails |
| `Mixed`        | Some better, some worse — the regression still blocks         |
| `Inconclusive` | Nothing could be compared. Not a green light                  |

`Regressed` is separate from `Mixed` on purpose: "eight better, one worse" is a decision, and "one
thing that used to work no longer does" is a blocker until somebody accepts it deliberately, with
a reason, recorded against their name.

Every case a comparison depended on is marked `usedInComparison`, which **freezes its
expectation** — a case editable after a comparison is evidence that can be made to agree with
whatever happened.

### Audit events added at Prompt 18

| Action                                                     | When                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `skill.routed`                                             | A selection, with the counts and `onlyPublishedConsidered: true` |
| `skill.routing_found_nothing`                              | Nothing applied                                                  |
| `skill.candidate_raised`                                   | With `nothingPublished` and `nothingAutoUsed` both true          |
| `skill.candidate_accepted`                                 | With `createdAs: 'Draft'` and `requiresApprovalBeforeUse: true`  |
| `skill.candidate_underreview` / `skill.candidate_rejected` | With the reason                                                  |
| `skill.evaluation_case_added`                              |                                                                  |
| `skill.evaluation_run_recorded`                            | With `producedBy` and a note that no evaluator exists            |
| `skill.regression_compared`                                | The verdict and the counts                                       |
| `skill.regression_accepted`                                | Who published over a regression, and why                         |

## Objective Builder — Exact Form 2 (Prompt 19)

Base: `/tenants/:tenantId/objectives`. `@TenantScoped()`; every route carries a phase-1
`@RequirePermission` and the row-level half runs in the service against the objective's department
and owner, so knowing an id is never enough.

| Method | Path                   | Permission            | Purpose                                                                                |
| ------ | ---------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| `GET`  | `/form2`               | `objective:View`      | The form's own definition — every field, all 15 grid columns, every closed vocabulary. |
| `GET`  | `/`                    | `objective:View`      | List. Filters: `status`, `departmentId`, `search`. Scope-filtered per row.             |
| `POST` | `/`                    | `objective:Create`    | Create an objective and its V1 draft.                                                  |
| `GET`  | `/:objectiveId`        | `objective:View`      | One objective: every version, its live version, its open draft, its reward panel.      |
| `PUT`  | `/:objectiveId/draft`  | `objective:EditDraft` | Replace the draft's Form 2 content **and** its whole grid.                             |
| `POST` | `/:objectiveId/submit` | `objective:EditDraft` | Draft → Submitted / Under Review.                                                      |
| `GET`  | `/:objectiveId/reward` | `objective:View`      | The Performance & Reward panel, or `null`.                                             |
| `PUT`  | `/:objectiveId/reward` | `objective:Assign`    | Save the panel.                                                                        |

### Why the reward panel is `objective:Assign` and not `EditDraft`

Promising a bonus is part of **assigning** work, not part of drafting it. The distinction has
teeth without any new vocabulary: `Employee` carries `Create` and `EditDraft` on `objective` and
**not** `Assign`, so somebody cannot attach a reward to their own objective. `Head` and `Manager`
carry `Assign`; `CompanyAdmin` carries none of the three.

### `CompanyAdmin` cannot create or edit an objective

Not an oversight — Prompt 7's deliberate split, and surprising enough that
`objectives.e2e.spec.ts` pins it: `CompanyAdmin` holds `objective: View, Comment, Export`.
Administering a company is not doing its business work, and an administrator who must also draft
objectives is additionally given a business role, which is a separate and visible decision.

### The grid is replaced whole, not patched per row

`PUT /draft` takes the complete `steps` array. The approved UI edits the grid as a spreadsheet —
insert, duplicate, delete, reorder — and reconciling that into per-row operations would invent an
ordering the screen never had. `position` must run 1..n with no gaps; the API refuses a gap rather
than renumbering silently, so a client bug surfaces instead of reordering somebody's plan.

### Status codes worth knowing

- `401` — no identified actor. The guard cannot say what a role covers before it knows who asks.
- `403` — the role or its scope refuses it. A department outside your scope is refused **without**
  the reply revealing whether that department exists.
- `404` — the objective is not visible under Row-Level Security. Not `403`: saying "forbidden"
  would confirm that an objective with that id exists somewhere.
- `409` — the version cannot be edited (frozen, under review, or there is more than one open
  draft and the caller did not name one).

### Audit events added at Prompt 19

`objective.created`, `objective.draft_saved`, `objective.submitted_for_review`,
`objective.reward_panel_saved`. The reward event carries `autoPaid: false` in its metadata and
says "Nothing is payable" in its summary, so an auditor reading the trail later does not have to
infer it.

## Objective Extra Work, Bonus and Reward Controls (Prompt 19A)

Two bases. Awards _on an objective_ hang off the objective; one person's awards are a query about
that person.

| Method | Path                                              | Permission                           | Purpose                                                                          |
| ------ | ------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `GET`  | `…/objectives/:id/rewards/meta`                   | `objective:View`                     | The lifecycle, its transitions, and **whether this deployment can pay anybody**. |
| `GET`  | `…/objectives/:id/rewards/awards`                 | `objective:View`                     | Every award under the objective's rule.                                          |
| `POST` | `…/objectives/:id/rewards/awards`                 | `objective:Assign`                   | Assign an award to somebody. Lands in `Assigned`.                                |
| `POST` | `…/awards/:awardId/complete`                      | `objective:EditDraft`                | Report the work done. **The subject may always report their own.**               |
| `POST` | `…/awards/:awardId/eligible`                      | `objective:Assign`                   | Find the condition met. **Never the subject.**                                   |
| `POST` | `…/awards/:awardId/approve`                       | `objective:Approve` + named approver | Decide. Pays nobody.                                                             |
| `POST` | `…/awards/:awardId/reject`                        | `objective:Approve`                  | Refuse, with a required reason.                                                  |
| `POST` | `…/awards/:awardId/settle`                        | `objective:Approve` + second person  | Cash only, through the payroll connector.                                        |
| `POST` | `…/awards/:awardId/record`                        | `objective:Approve`                  | Points and recognition. Applies the performance policy gate.                     |
| `GET`  | `/tenants/:tenantId/reward-awards/:subjectUserId` | `objective:View`                     | One person's awards. Always permitted to themselves.                             |

### The lifecycle

`Draft → Assigned → Completed → Eligible → Approved/Rejected → Settled/Recorded`, the client's
chain with both slash pairs expanded into four distinct states. `Rejected` is reachable from every
open state, because a claim can fail because the work was not done, because the condition was not
met, or because the approver said no — forcing every rejection through `Eligible` would mean
declaring somebody eligible in order to refuse them. `Rejected`, `Settled` and `Recorded` are
terminal.

### Approving is not paying

`Approved` is a decision. Money moves only in `settle`, which requires **all** of: the award is
`Approved`, its type is `Cash`, the actor is **not** the person who approved it, the amount is
positive, and a payroll connector reports that it can pay. Each is refused separately so a failure
says which one. **No connector is configured in any shipping build**, so `settle` refuses — and
`GET …/rewards/meta` says so via `payoutConnector.canSettle: false`, so a screen never offers a
button the product cannot honour.

`payoutWasReal` is stored on the award and reported on every read. It is `false` for every adapter
that exists, including the test mock. A report can therefore never claim a settlement was real
when it was not.

### Points reach performance only through policy

`record` on a `Points` award writes a `ManualAdjustment` performance event **only** when the
company's active performance policy has `rewardPointsReachPerformance` enabled, and it is `false`
by default. When policy refuses, the award still finishes as `Recorded` with `performanceNote`
saying why — a refusal is an ending, not an error. A `Cash` award can never carry a performance
event: being paid is not a performance outcome.

`PerformanceService.setPolicy` gained `rewardPointsReachPerformance` in its change set. It needs
`performance:Administer`, which only `CompanyAdmin` holds — whether a bonus can move somebody's
score is company configuration, not a departmental call.

### The terms are snapshotted at assignment

An award copies the rule's type, amount, condition, deadline and approver when it is assigned, and
a trigger freezes them. Editing the rule afterwards does not change what an existing award
promises. Without this, somebody could raise the amount or soften the condition after the work was
done and the trail would show the new terms as though they had always been the terms.

### Approving needs the named approver, not just the permission

`objective:Approve` says who may approve things in general; the rule says who may approve _this_.
Both are required. The subject can never approve their own award even when the rule names them.
Note that the separation-of-duties engine may refuse first with "you cannot approve something you
created" — that is a stronger control firing earlier, not a conflict.

### Audit events added at Prompt 19A

`reward.award_assigned`, `reward.award_completed`, `reward.award_eligible`,
`reward.award_approved`, `reward.award_rejected`, `reward.award_settled`,
`reward.award_recorded`. Every one carries `payoutWasReal` (or `autoPaid`) in its metadata, and the
settlement summary states in words that no real payment was made when the adapter is not a live
provider.

## Objective Review Routing and Strict Versioning (Prompt 20)

| Method | Path                                          | Permission                              | Purpose                                                          |
| ------ | --------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `POST` | `…/objectives/:id/review/confirm-team`        | `objective:Assign` + Responsible Owner  | Confirm the execution team. A precondition of `review/complete`. |
| `POST` | `…/objectives/:id/review/send-back`           | `objective:Approve` + Responsible Owner | Send back / request changes. Reason required.                    |
| `POST` | `…/objectives/:id/review/complete`            | `objective:Assign` + Responsible Owner  | Review done → `ReadyForApproval`.                                |
| `POST` | `…/objectives/:id/approve`                    | `objective:Approve`                     | Approve. **Does not publish.**                                   |
| `POST` | `…/objectives/:id/publish`                    | `objective:Publish`                     | Publish an approved version; archives the one it supersedes.     |
| `POST` | `…/objectives/:id/versions/new-draft`         | `objective:EditDraft`                   | Open the next draft copied from the live version.                |
| `POST` | `…/objectives/:id/versions/rollback`          | `objective:EditDraft`                   | A **new** draft copied from an older version. Reason required.   |
| `GET`  | `…/objectives/:id/versions`                   | `objective:View`                        | Version History, with exact version ids.                         |
| `GET`  | `…/objectives/:id/versions/compare?from=&to=` | `objective:View`                        | Compare view.                                                    |

### Approving and publishing are separate, and approval is a field not a status

The client's chain is `V1 Draft → Review → Approved → Published → LIVE V1`. The status enum is the
client's own eight-state list and has **no `Approved` member**, so approval is recorded as a fact
on the version: `approvedAt` / `approvedByUserId` are set while the status stays
`ReadyForApproval`. A derived `reviewStage` on every version view reports
`"Awaiting approval"` or `"Approved — awaiting publish"`, and that is what a screen should show
rather than the raw status. See ADR-104.

`live_objective_version_was_approved` enforces it in the database, so publishing without an
approval is refused even through a direct write.

### `PUT /draft` on a live objective creates V2 automatically

The client's rule: _any later edit by any authorized user automatically creates V2 Draft copied
from V1; V1 remains live until V2 is approved/published; minor edits also create a new version._
So `PUT …/draft` no longer refuses when the only versions are live or finished — it opens the next
draft, copies the content **and the whole grid**, and applies the edit to the copy. Prompt 19
refused here; this is where the rule arrives.

**But not while a version is awaiting a decision.** `UnderReview` and `ReadyForApproval` still
refuse, because quietly opening a new draft there would let an author route around the reviewer:
edit the copy, publish it, and the review would have decided nothing. Editing those needs a
send-back first.

**A minor edit gets no exemption.** A version whose content happens to match its parent is still a
version, and the compare view reports `identical: true` rather than pretending it does not exist.

### Rollback moves forward

`POST …/versions/rollback` creates a **new** draft copied from the older version, with
`origin: 'Rollback'` and `copiedFromVersionId` pointing at it. The old row is never reopened, and
the new draft goes through the ordinary review and approval before it can go live. History stays
append-only and every record keeps its exact version id.

### Send To is hierarchy-aware

Two checks. **Hard:** the person must be an active member of the company. **Hierarchy:** when both
the objective's owner and the responsible owner have an employment record, they must be in the same
reporting line — one at or beneath the other. The **direction is deliberately unconstrained**: the
prompt says "Responsible manager" while the approved reference shows a Head sending down to a
specialist, so constraining it would contradict one of the two.

When either person has no employment record the hierarchy cannot be evaluated and the routing is
**permitted, with the gap recorded**. That is a considered exception to fail-closed: routing is a
data-quality concern, not a security boundary — the recipient still needs `objective:Approve` and
the row-level scope check — and refusing would make the Objective Builder unusable for a company
that has not finished filling in its hierarchy. See ADR-105.

### Only the Responsible Owner may act as reviewer

`objective:Approve` says who may approve things in general; the form's Responsible Owner / Send To
says who _this_ objective was routed to. Both are required, the same shape as a reward's named
approver. Note the separation-of-duties engine may refuse even earlier for somebody acting on what
they created.

### Employees receive no actionable work during review

`isObjectiveWorkAssignable(status)` returns true **only** for `Active`, and every version view
carries `workAssignable`. One function, so the To-do module, the agent runner and any later
assigner ask the same question rather than each deciding for itself. An approved-but-unpublished
version is deliberately not assignable.

### Audit events added at Prompt 20

`objective.execution_team_confirmed`, `objective.sent_back`, `objective.review_completed`,
`objective.approved`, `objective.published`, `objective.new_draft_opened`,
`objective.rolled_back`. Each carries the **exact version id** in its metadata, because the client
requires historical records to keep them; `objective.published` also carries
`supersededVersionId`.

## Objective AI Analysis (Prompt 21)

| Method | Path                                      | Permission            | Purpose                                                                                           |
| ------ | ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `GET`  | `…/objectives/analysis/meta`              | `objective:View`      | The seven stages, the node shapes, the schema version, and **whether a real model is reachable**. |
| `POST` | `…/objectives/:id/analysis`               | `objective:EditDraft` | Start an analysis.                                                                                |
| `GET`  | `…/objectives/:id/analysis`               | `objective:View`      | The latest run, for a reopened screen. `{ run: null }` when never analysed.                       |
| `GET`  | `…/objectives/:id/analysis/:runId`        | `objective:View`      | One run, with its progress and its draft.                                                         |
| `POST` | `…/objectives/:id/analysis/:runId/cancel` | `objective:EditDraft` | Cancel. Takes effect at the next stage boundary.                                                  |

`objective:EditDraft` and not `Approve`: analysis produces a draft, and producing a draft is
drafting. Nothing here decides anything.

### The output is always a Draft

The version moves to `AiAnalysis` while the run works and `WorkflowDraft` when it finishes. Both
are pre-approval, so `workAssignable` stays false and nothing is handed to anybody. The only route
to live is the Prompt 20 approve-then-publish sequence. `objective_analysis_runs` has **no
approval or publish column at all**, asserted from `information_schema`.

### Every model call goes through the Model Gateway

`ModelGateway` is the only path to a model. `capability` is an **opaque label** — never a provider
or model name, per the client's locked rule — and `usesRealModel` is served so a screen can say
plainly that an analysis ran against a mock. Every stage makes exactly one gateway call, so a real
provider changes the analysis everywhere at once rather than in whichever stage was wired.

`producedByRealModel` is **false for every adapter that ships**, travels with each response, is
persisted on the run and is reported on every read. A constraint refuses a row claiming a real
model with no capability named.

### The draft is a versioned schema

`ANALYSIS_SCHEMA_VERSION` is stamped into the document _and_ into the row, and a constraint refuses
them disagreeing. A draft is validated before it is stored and refused if malformed — a malformed
draft in the database is worse than none, because a screen will try to render it. A stored draft
whose version this build does not read comes back as `draft: null` with an `unreadableReason`
rather than being guessed at.

### The node shapes are data, not styling

`nodeShapes` in the meta response is `NODE_SHAPE_BY_KIND`: **Human is a rectangle, AI is a diamond,
the Goal is visually distinct.** `validateWorkflowDraft` refuses a node whose shape contradicts its
kind, so the locked rule cannot be broken by a component restyle. `Approval` and `Condition` are
separate kinds — an approval is a person deciding, a condition is a rule being evaluated.

### What the analysis produces, and what it admits it cannot

Every node comes from a row of the objective's own Form 2 grid and records `fromStepPosition`.
Human rows become rectangles with an owner matched by the display name the grid holds; machine rows
become diamonds with an approved published Skill version attached by the **Prompt 18 Skill Router**
(reused, not reimplemented, so an unapproved version can never be reached). Approval columns become
gates. Each node carries a definition of done and an evidence requirement.

`gaps` records what it could not do — an unmatched person, a step naming nobody, an AI step with no
approved Skill — and `risks` records what it judged risky. Both are always present, even empty: an
analysis that concealed its blind spots would look complete and be wrong.

`usage` is a **range**, never a single figure, and `basis` says what it came from. A number next to
real money reads as a quote; when the run used a mock, the basis says so.

**No Skill Candidate is raised.** An analysis is exploratory and may be re-run while a draft is
edited; raising a governance item every time would bury the ones a person actually filed. The gap
appears on the draft where the reviewer sees it.

### Progress is durable and cancellation is real

The run, its stage and its counters are rows written at each stage boundary, so a reopened screen
shows where it actually got to — the reference promises exactly that. The pipeline re-reads its own
status between stages, so a cancellation from another tab stops it rather than being recorded and
ignored. One live run per version, enforced by a partial unique index.

### Audit events added at Prompt 21

`objective.analysis_started`, `objective.analysis_completed`, `objective.analysis_cancelled`. Each
carries the run id; the completion event carries `producedByRealModel`, the token counts, the node
and gap counts, and states in words that the output is a draft.

## Prompt 22 — the workflow graph editor

All under `/tenants/:tenantId/objectives`. `View` reads, `EditDraft` mutates — and **opening
counts as a mutation**, because it seeds the editable row.

| Route                                         | Permission  | Notes                                                      |
| --------------------------------------------- | ----------- | ---------------------------------------------------------- |
| `GET workflow/meta`                           | `View`      | Node kinds with shapes, edge kinds, the seven DoD parts.   |
| `POST :id/workflow`                           | `EditDraft` | Opens the draft; idempotent, seeds from the analysis once. |
| `GET :id/workflow`                            | `View`      | The plan, its revision, and whether it is still editable.  |
| `PUT :id/workflow/nodes/:nodeId`              | `EditDraft` | Title, assignee, trigger event, Definition of Done.        |
| `POST :id/workflow/nodes/:nodeId/convert`     | `EditDraft` | Human ↔ AI only, and only where allowed.                   |
| `POST :id/workflow/nodes`                     | `EditDraft` | Optional `afterNodeId` wires a sequential edge.            |
| `DELETE :id/workflow/nodes/:nodeId?revision=` | `EditDraft` | Removes the node and every edge that touched it.           |
| `PUT :id/workflow/edges`                      | `EditDraft` | Replaces the edge list whole.                              |
| `PUT :id/workflow/nodes/:nodeId/dependencies` | `EditDraft` | Resolved against the graph, self-dependency refused.       |
| `GET :id/workflow/pre-publish`                | `View`      | The readiness report. Publishes nothing.                   |

### Every mutation carries a `revision`

Required, not optional. A mismatch is `409` with a message naming both numbers, so the client can
say what happened rather than showing a generic conflict. `DELETE` takes it as a query parameter.

### The whole graph is validated on every write

A node edit can break the graph elsewhere — a dependency on a node just deleted, an edge to
nothing, a converted node whose shape no longer matches its kind. Each operation revalidates all
of it and refuses the write on any problem, so a draft cannot rot one edit at a time and surface
the failure on an unrelated edit later.

### Editing is refused once the plan is assigned

`409`, with the reason: people are already working to it, and an authorised change opens a new
objective version. `editable` on the view says so before the manager tries.

### The Pre-Publish Summary

Covers all twelve items the client named: affected employees, Human and AI counts, new versus
reusable agents, Skills, missing connections, high-risk actions, approval gates, estimated cost,
workload conflicts and incomplete fields. `findings` carries `Blocker` / `Warning`, and
`readyToAssign` is a report — Prompt 23 revalidates inside its transaction. Cost is a range with a
stated basis, never a single figure.

### Audit events added at Prompt 22

`objective.workflow_draft_opened` (naming the run it was seeded from, and stating in words that
the analysis is unchanged), `objective.workflow_node_edited`, `objective.workflow_node_converted`,
`objective.workflow_node_added`, `objective.workflow_node_deleted`, `objective.workflow_reconnected`,
`objective.workflow_dependencies_set`. Each carries the draft id and the resulting revision.

## Prompt 23 — Approve & Assign

`POST /tenants/:tenantId/objectives/:objectiveId/assign` — `objective:Assign`, at the module and
the row level. Body: optional `versionId`, optional `acceptWarnings` — an acknowledgement recorded on the
audit event, **not** a gate. Warnings do not block; a warning that blocked would be a blocker.

Either it assigns everything or it refuses and changes nothing. On refusal it answers `400` with
**every** failing check on its own line, naming the check and the node:

```
This workflow cannot be assigned yet.
• Owners and assignees (step-2): Its Definition of Done is incomplete: criteria not stated.
• Required approvals (step-3): No approved, published Skill stands behind this AI step…
```

Collecting rather than short-circuiting is the point: a manager who fixes one blocker, re-runs and
hits the next is being told the truth in instalments.

**It does not approve.** The version must already be approved, and the refusal says that approving
is a separate act — see ADR-116. `409` when the plan was already assigned, or was assigned by
somebody else while the request was being checked.

On success it publishes the version, creates a human task per Human node, an AI assignment per AI
node, an approval request per Approval node, registers Executor expectations, freezes the plan,
audits, and then notifies the approvers. The response reports what it made, including
`nodesAwaitingAgentSetup` so a caller can send somebody to Agent Builder.

### Audit event added

`objective.approved_and_assigned`, carrying the version, the plan, the four counts, the
superseded version id, whether the manager acknowledged the plan's warnings, and the budget
check's outcome in words.

### The budget check cannot be evaluated yet, and says so

The company's budget policy is in currency; the estimate is in tokens; no provider pricing exists
until the AI Provider Profiles prompt. The check records that it could not price the estimate and
permits — the hard stop is enforced when work runs. See ADR-118.

## Prompt 23 — the Human To-do list

All under `/tenants/:tenantId/todo`. Its own path and its own permission set, because an Employee
has `todo` access at `OwnWork` scope and no right to browse objectives.

| Route                       | Permission       | Notes                                                             |
| --------------------------- | ---------------- | ----------------------------------------------------------------- |
| `GET meta`                  | `todo:View`      | Statuses with labels and tones; the note says Overdue is derived. |
| `GET ?filter&status&search` | `todo:View`      | `mine` (default), `team`, `blocked`.                              |
| `GET :taskId`               | `todo:View`      | Everything the client's UI list names.                            |
| `POST :taskId/start`        | `todo:EditDraft` | Start, or resume — resuming clears the blocker.                   |
| `POST :taskId/block`        | `todo:EditDraft` | A reason is required.                                             |
| `POST :taskId/evidence`     | `todo:EditDraft` | A description and an optional reference.                          |
| `POST :taskId/notes`        | `todo:Comment`   | `Comment` or `Clarification`.                                     |
| `POST :taskId/submit`       | `todo:EditDraft` | Submit & complete: one action, two outcomes.                      |

### Submit is one action with two outcomes

A step whose Definition of Done requires an approval goes to `WaitingApproval` and raises an
`OutputApproval` request in the same queue every other approval uses. A step requiring none
completes outright — making somebody click twice for a decision nobody has to make is friction
that teaches people to ignore the button.

Submitting is refused when the step required evidence and none is attached, and refused while a
blocker still stands, with the requirement and the blocker quoted back. Refusing is better than
accepting and raising the Executor Agent's "Missing Completion Evidence" exception afterwards: the
person is right there and can attach the file.

### A clarification moves the task, a comment does not

Asking for clarification moves the task to `NeedsInput`, because a question somebody is waiting on
an answer to is what makes work visibly stalled rather than merely quiet. A plain comment leaves
the status alone.

### Overdue is never a status the API accepts

`GET meta` lists eight statuses and `Overdue` is not among them. Every task view carries
`status` (what it is waiting on), `displayStatus` (what the screen shows) and `overdue`.

### Audit events added

`todo.task_started`, `todo.task_blocked`, `todo.evidence_added`, `todo.task_commented`,
`todo.clarification_asked`, `todo.task_submitted`, `todo.task_completed`. The completion event
records whether the work was late against its due date.

## Agent Builder (Prompt 24)

`/tenants/:tenantId/agent-builder` — `@TenantScoped`.

| Route                         | Action      | Notes                                                                                                                                                     |
| ----------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET meta`                    | `View`      | Run types, missing-data behaviours, Engine Agent statuses, and Form 3's shape. Served so the screen's controls cannot drift from the server's validation. |
| `GET `                        | `View`      | Assigned AI work this person may act on. Filtered row by row through the scope engine.                                                                    |
| `GET :assignmentId`           | `View`      | The builder screen.                                                                                                                                       |
| `PUT :assignmentId/setup`     | `EditDraft` | A **patch** — one answer at a time, never blanking a field it did not carry.                                                                              |
| `POST :assignmentId/test`     | `EditDraft` | Controlled test. Writes nothing to the real output destination.                                                                                           |
| `POST :assignmentId/activate` | `Run`       | Creates the reusable Engine Agent and its first published version.                                                                                        |
| `GET :assignmentId/form3`     | `Publish`   | The canonical job method, as a read.                                                                                                                      |

**Why `Run` for activate and `Publish` for Form 3** — see ADR-270. Activating your own assigned
agent is doing the work; deciding what the company releases is not, and no Employee holds `Publish`
on any module.

Every route makes a second, row-level decision through the scope engine after the guard's
module-level check, so an `Employee` with `OwnWork` and a `Manager` with a team subtree get
different answers about the same URL.

**Nothing here returns a credential.** The builder chooses a _connection by id_ and the server
answers whether it may be used. A test asserts this against the serialised response rather than
the declared shape, because a leak would arrive as a field nobody declared.

`missing` is the ZERO-QUESTION RULE's answer, computed server-side: an empty array means the
screen asks nothing and offers _Ready to Test / Activate_.

## Engine Agent registry (Prompt 25)

`/tenants/:tenantId/agents` — `@TenantScoped`.

| Route                                        | Action    | Notes                                                                                                                                                         |
| -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET meta`                                   | `View`    | Statuses with tones, the action set, and each memory mode **with its technical rule** — so nobody picks a mode without seeing what it commits the company to. |
| `GET `                                       | `View`    | The registry. `?includeArchived=true` to see retired agents.                                                                                                  |
| `GET :agentId`                               | `View`    | Detail, including every version and the open draft's impact.                                                                                                  |
| `POST :agentId/pause`                        | `Pause`   | Reason required.                                                                                                                                              |
| `POST :agentId/resume`                       | `Pause`   | Clears the reason.                                                                                                                                            |
| `POST :agentId/archive`                      | `Publish` | Terminal.                                                                                                                                                     |
| `POST :agentId/versions`                     | `Publish` | Drafts from the version in force, with impact analysis.                                                                                                       |
| `POST :agentId/versions/:versionId/test`     | `Publish` | Draft only.                                                                                                                                                   |
| `POST :agentId/versions/:versionId/activate` | `Publish` | `approvedByUserId` where the impact analysis requires one, and it may not be the caller.                                                                      |

**No `run` and no `runs` routes.** See ADR-122 — the engine is the next prompt, and a route that
queued nothing would be indistinguishable from one that worked.

`Pause` for pause/resume because that is the action the role templates already grant a Manager and
a CompanyAdmin for exactly this. `Publish` for everything that changes what the company runs,
including archiving — retiring an identity permanently is a Head decision.

## Runs (Prompt 26)

`/tenants/:tenantId/agents/:agentId/runs` — `@TenantScoped`. Mounted under the agent because
`Agent → Assignment/Job → Run` is the locked relationship; a top-level `/runs` collection would
invite code that reads a run without establishing whose it is.

| Route                 | Action     | Notes                                                                                                                                |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET meta`            | `View`     | States with tones, triggers, **who resolves each kind of block**, the policy vocabularies, and which transport is carrying the work. |
| `GET `                | `View`     | Runs for this agent, newest first.                                                                                                   |
| `GET :runId`          | `View`     | One run with its full durable event history.                                                                                         |
| `POST `               | `Run`      | **Run now.**                                                                                                                         |
| `POST :runId/cancel`  | `Pause`    | Safe from every unfinished state, including waiting and blocked.                                                                     |
| `POST :runId/resume`  | `Pause`    | A waiting run returns to `Running`; a blocked one to `Queued`.                                                                       |
| `POST scheduler/tick` | `Schedule` | One idempotent tick for this company.                                                                                                |

**This closes ADR-122.** `Run Now` and `Open Runs` were reported as permitted actions at Prompt 25
with no routes behind them, deliberately.

`meta.transport.isDurableTransport` says whether a broker is behind the queue. It is reported
rather than assumed because "does my queue survive a restart?" is not a question anyone should
have to answer by reading deployment config.

The row-level check delegates to `EngineAgentService.view`, which hands the scope engine the
agent's owner _and_ department. Writing a third copy of that policy here is what S-165 is about.

## The Executor Agent and Exception Center (Prompt 27)

`/tenants/:tenantId/executor` — `@TenantScoped`.

| Route                     | Action                                | Notes                                                                                                                                                |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET meta`                | `View`                                | The ten kinds with their **default owner and severity**, the states, the resolution actions with `executorMayTakeItAlone`, and the validation order. |
| `GET exceptions`          | `View`                                | Filter by `kind`, `severity`, `state`, `engineAgentId`; `openOnly` defaults on.                                                                      |
| `GET exceptions/:id`      | `View`                                | One exception with its full resolution history.                                                                                                      |
| `POST exceptions/:id/act` | `Comment`, plus `Administer` to close | Acknowledge, reassign, escalate, retry, pause, request approval, resolve, dismiss.                                                                   |
| `POST sweep`              | `Pause`                               | One idempotent monitoring pass.                                                                                                                      |

**There is deliberately no way to act as the Executor.** `act` always attributes the action to the
authenticated person; a parameter that could make the actor null would be a route around
ADR-131's three layers. The Executor's own actions happen inside the sweep.

`meta.actions[].executorMayTakeItAlone` publishes the boundary rather than leaving it implicit, so
a screen can show what the machine may do on its own instead of a reader having to infer it.

`Administer` is required on top of `Comment` for `Resolve` and `Dismiss`, because closing an
exception is deciding it is dealt with — a stronger act than annotating one. A Manager holds
`executor: View, Comment` and so can acknowledge, reassign, escalate and retry but not close.

## `/tenants/:tenantId/approvals` — the Approval Engine (Prompt 28)

**One queue for every module.** There is no `/objectives/:id/approve`, no `/agents/:id/approve` and
no per-module approval route — that is the client's constraint rather than a routing preference.

| Method   | Path                 | Permission        | Purpose                                                                                  |
| -------- | -------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `GET`    | `meta`               | `approvals:View`  | Types (with governing module), statuses, decisions, aging buckets, SoD rules, thresholds |
| `GET`    | ``                   | `approvals:View`  | The queue; `status`, `type`, `mineOnly` filters                                          |
| `GET`    | `:approvalId`        | `approvals:View`  | One request, its history, and what this actor may do                                     |
| `POST`   | `:approvalId/decide` | `approvals:View`  | Approve, reject, send back or comment                                                    |
| `GET`    | `delegations`        | `approvals:View`  | Delegations in either direction                                                          |
| `POST`   | `delegations`        | `approvals:View`  | Create; naming somebody else needs `approvals:ManageAccess`                              |
| `DELETE` | `delegations/:id`    | `approvals:View`  | Revoke, immediately                                                                      |
| `POST`   | `escalate`           | `approvals:Pause` | Run the overdue sweep                                                                    |

**The route guard is deliberately the weaker check.** `POST :approvalId/decide` is gated on
`approvals:View`, and the real authorization happens in the service against the _governing module_
and the _loaded row_ — a workflow publish needs `objective:Approve`, an agent activation needs
`agents:Approve`. A route-level guard cannot know who raised this particular request or who has
already acted on it, and both decide the answer. `meta.types[].module` publishes the mapping so a
screen can explain why somebody who can see the queue still cannot decide one row.

**`escalate` is `Pause`, not `Approve`.** Triggering a sweep is an operational act that moves
nothing but attention. Gating it behind `Approve` would mean only people who can decide approvals
could ask the system to notice overdue ones, which is backwards.

**`available[]` on the detail response** carries `{decision, label, allowed, reason}` per decision,
computed by running the real routing and `authorize` calls. A screen renders buttons straight from
it, so a disabled control and a refused POST cannot disagree, and the reason shown is the sentence
the server would return.

**There is no route that decides without a person.** Nothing expires a request, auto-approves on a
deadline, or lets a caller act "as the Executor Agent". `meta.note` says so in the response body.

`POST :agentId/versions/:versionId/request-approval` was added to the agents controller
(`agents:Publish`) — asking for a decision is not making one, so the person who wants to activate
a version is exactly the person who should be able to ask. `POST .../activate` now takes
`approvalRequestId` in place of Prompt 25's `approvedByUserId`, which was a name nobody verified
(ADR-143).

## `/platform/providers` — Providers & Models (Prompt 29)

| Method | Path                   | Permission             | Purpose                                                                                      |
| ------ | ---------------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `GET`  | `meta`                 | `providers:View`       | Kinds with adapter/reachability, modes, auth types, lifecycle states, the five profile specs |
| `GET`  | `profiles`             | `providers:View`       | Every profile with its models and current pricing                                            |
| `GET`  | `routing`              | `providers:View`       | What each logical profile resolves to; `tenantId` for a company's view                       |
| `POST` | `profiles`             | `providers:Administer` | Register a profile; the secret is accepted once and stored in the vault                      |
| `POST` | `profiles/:id/models`  | `providers:Administer` | Add a model, optionally with its first price                                                 |
| `POST` | `models/:id/pricing`   | `providers:Administer` | Publish a new price — supersedes, never edits                                                |
| `POST` | `models/:id/lifecycle` | `providers:Administer` | Move a model's lifecycle, with a required note                                               |
| `POST` | `routing`              | `providers:Administer` | Point a profile at a model at a preference                                                   |
| `POST` | `profiles/:id/test`    | `providers:Administer` | Test Connection                                                                              |

**Every route is `@PlatformOnly`, and there is no company-facing counterpart at all** — not even
read-only (S-190). A company's BYOK credential is registered here, by platform staff, against that
company's tenant id, which is the shape §19 describes.

**There is no `PUT` for pricing.** A published price is immutable and a database trigger refuses
the edit, so the absence of the route is enforced rather than merely intended.

**`POST profiles/:id/test` is `Administer`, not `View`**: it sends a real request using a stored
credential, which is an action against a third party rather than a read of local configuration.

The company-facing surface changed in exactly one way: nothing. `ModelRequest` gained a required
`profile` field, which is internal — no tenant endpoint gained or lost anything, which is the
evidence the seam was in the right place.

## `/tenants/:tenantId/cost` — Tokens & Cost (Prompt 30)

| Method | Path                 | Permission            | Purpose                                                            |
| ------ | -------------------- | --------------------- | ------------------------------------------------------------------ |
| `GET`  | `meta`               | `settings:View`       | Scopes, thresholds with defaults, ledger kinds, reservation states |
| `GET`  | `wallets`            | `settings:View`       | Every budget with §20's full display set                           |
| `GET`  | `ledger`             | `settings:View`       | Credit history; `walletId` or `agentRunId` filters                 |
| `POST` | `allowance`          | `settings:Administer` | Set a budget at one level, with a required reason                  |
| `POST` | `reconcile`          | `settings:View`       | §20's reconciliation job                                           |
| `POST` | `sweep-reservations` | `settings:Administer` | Release holds nobody closed                                        |

**There is deliberately no route that spends, reserves or settles** (S-198). Those happen inside
the Model Gateway as part of a real call.

`reconcile` is `View` rather than `Administer`: it changes nothing, and somebody investigating a
suspicious balance should not need permission to change budgets in order to look.
`sweep-reservations` is `Administer` even though it only gives budget back, because releasing a
hold belonging to a run still in flight would let that run's settle overspend.

`wallets` returns the whole hierarchy in one call: the screen shows company and departments
together, and a per-level endpoint would make the common view N+1 requests.

The company-facing AI surface gained nothing else. `ModelRequest` grew four optional attribution
fields, which are internal.

---

## `/tenants/:tenantId/credits` and `/platform/credits` — Prompt 31

**Company plane** (`settings:View` to read, `settings:Administer` to write):

| Method | Path                  | Purpose                                                               |
| ------ | --------------------- | --------------------------------------------------------------------- |
| `GET`  | `meta`                | Request states, billing choices, grant sources, the policy vocabulary |
| `GET`  | `policy`              | The commercial terms, read-only                                       |
| `GET`  | `requests` / `grants` | The company's own history                                             |
| `POST` | `requests`            | Request / Buy More Credits                                            |
| `POST` | `requests/:id/cancel` | Withdraw your own request                                             |
| `POST` | `reallocate`          | Move budget between levels without increasing the total               |
| `GET`  | `negative-balance`    | Whether a negative balance is currently blocking work                 |

**Platform plane** (`@PlatformOnly`, `credits:View` / `credits:Administer`):

| Method         | Path                                             | Purpose                                                        |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `GET`          | `requests`                                       | Finance's queue for one company                                |
| `POST`         | `requests/:id/decide`                            | Approve (for any amount), or reject with a reason              |
| `POST`         | `grants`                                         | Promotional, manual or refund credit with no request behind it |
| `POST`         | `grants/:id/revoke`                              | Payment failure after a top-up                                 |
| `GET` / `POST` | `policy`                                         | The commercial terms                                           |
| `POST`         | `period-reset` / `expire-grants` / `plan-change` | The periodic edge cases                                        |

**There is no company route that approves anything** (S-205), and no route anywhere that takes a
payment (S-213). `reference` is where Finance records the invoice raised in whatever system
actually bills.

Cancelling is restricted to the person who raised the request: withdrawing somebody else's is a
conversation, and an admin who needs it gone can have Finance reject it, which leaves a reason.

---

## `/tenants/:tenantId/security-center` — Prompt 32

`@TenantScoped`, and every route additionally `@RequirePermission({ module: 'settings', … })` —
`Audit` to read, `Export` to export, `Administer` to revoke. The service then adds the
whole-company scope check the guard cannot make.

| Route                         | Method | Action     | Returns                                                                                                             |
| ----------------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `/vocabulary`                 | GET    | Audit      | the seven views with `hasCorrelationIds`, the metric and range lists, and a note saying what the Security Center is |
| `/posture`                    | GET    | Audit      | the eleven metric readings, plus `mayExport` and `mayRevokeSessions`                                                |
| `/views/:view`                | GET    | Audit      | one view's rows, its purpose, the filtered total, a cursor, and any `limitation`                                    |
| `/views/:view/export`         | POST   | Export     | the same shape, up to 5,000 rows, and records a security event                                                      |
| `/sessions/:sessionId/revoke` | POST   | Administer | `{ revoked, signedOutOfCompanies, personDisplayName }`                                                              |

**Filters** (`range`, `actorUserId`, `correlationId`, `severity`, `outcome`, `before`, `limit`,
`guestHorizonDays`) are query parameters under `forbidNonWhitelisted`, which matters more here
than elsewhere: a mistyped filter that was silently ignored would return a **wider** result than
the caller asked for, and on security evidence wider-than-asked-for is a disclosure rather than a
bug.

**The export is a POST despite reading nothing**, for the reason the audit export already gives: it
writes a security event recording who took a copy, so it is neither safe nor idempotent and should
not look like it is.

**Why `mayExport` and `mayRevokeSessions` are on the posture.** So the screen can omit a control
rather than offer it and refuse. A button that 403s teaches a user that the product is unreliable;
an absent button teaches them what their role is.

**A row is flat.** `SecurityCenterRow` carries `occurredAt`, `title`, `actor`, `subject`, `state`,
`severity`, `detail`, `correlationId`, `resourceType`, `resourceId` and `revocableSessionId` for
every view, so a client renders one table rather than seven. `revocableSessionId` is non-null only
on a live session — the server says where the action exists rather than leaving the client to infer
it from the view name.

**One extension, no new query path.** `AuditTrailRepository.findSecurityEvents` gained
`categories`, `actions`, `correlationId`, `resourceType` and `resourceId`, and a
`countSecurityEventsMatching` beside the existing whole-trail count. The singular filter wins where
both are given. A second query builder would have been a second place for the tenant predicate and
the ordering to be got right.

---

## `/tenants/:tenantId/memory` and `/tenants/:tenantId/feedback` — Prompt 33

### Memory

| Route                                      | Method | Action                        | Returns                                                                                                                                                                                         |
| ------------------------------------------ | ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/memory/vocabulary`                       | GET    | `agents:View`                 | the four modes with each one's §19 rule **and its visibility ceiling**, the visibilities, the classifications, the offboarding behaviours, and a note on why cross-tenant memory has no setting |
| `/memory/policies`                         | GET    | `agents:View`                 | the four policies, in ephemeral-to-permanent order                                                                                                                                              |
| `/memory/policies/:mode`                   | PUT    | `settings:Administer`         | the changed policy                                                                                                                                                                              |
| `/memory/records`                          | GET    | `agents:View`                 | what the agents are holding; `includeDeleted` shows the deletions too                                                                                                                           |
| `/memory/records/:recordId`                | DELETE | `settings:Administer`         | the record, with its content gone and the deletion recorded                                                                                                                                     |
| `/platform/memory/tenants/:tenantId/sweep` | POST   | platform `support:Administer` | `{ expired }`                                                                                                                                                                                   |

**There is no route that writes a memory record**, and that is the design rather than an omission
(S-230). **The vocabulary carries each mode's ceiling** so the policy form offers only what the
service will accept — offering a wider visibility would be offering a refusal.

The sweep is platform-plane because **nothing schedules it**: expiring a company's memory belongs
to the Prompt 26 business-cron scheduler, and adding a second scheduler here to make one prompt look
finished would be the wrong trade.

### Feedback

| Route                           | Method | Action                | Returns                                                                                                               |
| ------------------------------- | ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/feedback/meta`                | GET    | `agents:View`         | the four ratings with descriptions, which need a correction, the minimum length, and **the provider-training stance** |
| `/feedback/runs/:runId`         | GET    | `agents:View`         | that run's feedback                                                                                                   |
| `/feedback/runs/:runId`         | POST   | `agents:Comment`      | the recorded rating, with its evaluation eligibility and the reason where it has none                                 |
| `/feedback/:feedbackId`         | PATCH  | `agents:Comment`      | the amended rating — your own only                                                                                    |
| `/feedback/quality`             | GET    | `agents:View`         | the summary, **always including `onRealModelOutput`**                                                                 |
| `/feedback/:feedbackId/promote` | POST   | `settings:Administer` | `{ caseId, feedback }`                                                                                                |

**`onRealModelOutput` is never omitted.** A 100% correct rate over mock output says nothing about a
provider's quality, and a response that left the figure out would let a screen imply otherwise.

**`agentRunsApi` is new on the web client**, and only because the feedback control had to attach to
something: Prompt 26 built the run engine and its routes and no screen ever read them. It lists an
agent's runs — not the Runs screen, which is a prompt of its own.

---

## `/tenants/:tenantId/objectives/:objectiveId/closure` — Prompt 34

| Route        | Method | Grant                                     | Returns                                                                                                 |
| ------------ | ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/meta`      | GET    | `objective:View`                          | the pause reasons, **what a pause does**, the company's sign-off policy, the minimum explanation length |
| `/readiness` | GET    | `objective:View`                          | the live comparison and what is outstanding, separated into blocking and not                            |
| `/review`    | GET    | `objective:View`                          | the review, or null                                                                                     |
| `/pauses`    | GET    | `objective:View`                          | every pause, with days stopped                                                                          |
| `/pause`     | POST   | `objective:Publish`                       | the pause                                                                                               |
| `/resume`    | POST   | `objective:Publish`                       | the closed pause                                                                                        |
| `/complete`  | POST   | `objective:Publish`                       | `{ status, readiness }`                                                                                 |
| `/review`    | POST   | `objective:Approve`                       | the review                                                                                              |
| `/sign-off`  | POST   | `objective:View` + **is the owner**       | the signed review                                                                                       |
| `/close`     | POST   | `objective:Publish` + the review's policy | the closed review                                                                                       |
| `/archive`   | POST   | `objective:Publish`                       | `{ status }`                                                                                            |

**There is no `/reopen`.** Reopening is `POST /objectives/:id/versions` on the authoring
controller — the versioning rule — and a second route here would be a second way to do it (S-239).

**`/readiness` is refused outright until there is a completed version**, and the screen treats that
as a normal state rather than an error: an objective still running has nothing to be ready for.

**`/meta` carries `pauseEffect` verbatim** so the UI states what a pause does in the same words the
service does: it stops new work, it does not cancel work in flight, and the definition stays
frozen.

---

## Files — `/tenants/:tenantId/files` (Prompt 35)

| Route                     | Method | Grant                                           | Returns                                                                                                  |
| ------------------------- | ------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/meta`                   | GET    | `settings:View`                                 | scan states, classifications, retention actions, the redaction stance, **and which adapters are in use** |
| `/policy`                 | GET    | `settings:View`                                 | the company's file policy                                                                                |
| `/policy`                 | POST   | `settings:Administer`                           | the updated policy                                                                                       |
| ``                        | GET    | `settings:Administer` **or** `settings:Approve` | `{ files }`                                                                                              |
| ``                        | POST   | `settings:EditDraft`                            | the stored file, already scanned                                                                         |
| `/:fileId/scan`           | POST   | `settings:EditDraft`                            | the file, rescanned                                                                                      |
| `/:fileId/content`        | GET    | `settings:Export`                               | `{ file, contentBase64 }`                                                                                |
| `/:fileId/classification` | POST   | `settings:Administer`                           | the file                                                                                                 |
| `/:fileId/legal-hold`     | POST   | `settings:Administer`                           | the file                                                                                                 |
| `/:fileId/delete`         | POST   | `settings:Administer`                           | the file, content gone, record intact                                                                    |
| `/retention/sweep`        | POST   | `settings:Administer`                           | `{ deleted, heldBack }`                                                                                  |

**The list is not `settings:View`.** That grant is on the Employee template; a list of every
document the company holds is not a general settings view (S-249). The route decorator asks for
`View` and the service applies the real rule, which is `Administer` or `Approve`.

**Upload is base64 in a JSON body, not multipart.** The whole API is JSON and one request pipeline
means one place the size limit is enforced. The declared size is checked against the **decoded**
length. The body limit is raised on this route alone (S-252).

**`/meta` names both adapters and says neither is real.** A client cannot render a green "Clean"
tick without also being told a mock produced it.

**Deletion is `POST /delete`, not `DELETE`** — the reason is mandatory, and a body on a `DELETE` is
something half the HTTP stack drops.

## Knowledge sources — `/tenants/:tenantId/knowledge-sources`

| Route                     | Method | Grant                                           | Returns                                              |
| ------------------------- | ------ | ----------------------------------------------- | ---------------------------------------------------- |
| `/meta`                   | GET    | `settings:View`                                 | kinds, states, access scopes, classifications        |
| ``                        | GET    | `settings:Administer` **or** `settings:Approve` | `{ sources }`                                        |
| ``                        | POST   | `settings:EditDraft`                            | the draft source                                     |
| `/:sourceId`              | POST   | `settings:EditDraft`                            | the source, **returned to Draft if it was approved** |
| `/:sourceId/approve`      | POST   | `settings:Approve`                              | the approved source                                  |
| `/:sourceId/retire`       | POST   | `settings:Administer`                           | the retired source                                   |
| `/:sourceId/files`        | POST   | `settings:EditDraft`                            | `{ added }`                                          |
| `/:sourceId/files/remove` | POST   | `settings:EditDraft`                            | `{ removed }`                                        |
| `/:sourceId/access`       | GET    | `settings:Administer` **or** `settings:Approve` | the read decision and the usable file ids            |

**Authoring and approving are different grants on different templates** (ADR-201), so a source is
approved by somebody other than the person who built it unless a company deliberately assigns both
roles to one person.

**There is no route that reads a source's files as a download.** Reading content is
`GET /files/:fileId/content` under `settings:Export`; a second download path scoped by source would
be a second place the scan check has to be remembered. `/access` answers the question the runtime
actually asks — _may this agent consult this source, and which of its files are usable_ — and
returns file ids, never bytes.

---

## Support — `/tenants/:tenantId/support` (Prompt 36)

| Route                         | Method | Grant                 | Returns                                                                                        |
| ----------------------------- | ------ | --------------------- | ---------------------------------------------------------------------------------------------- |
| `/meta`                       | GET    | `settings:View`       | kinds, priorities, states, authorization modes, **and what a support session always involves** |
| `/tickets`                    | GET    | `settings:View`       | this company's tickets                                                                         |
| `/tickets`                    | POST   | `settings:View`       | the raised ticket                                                                              |
| `/tickets/:id`                | GET    | `settings:View`       | the ticket and **replies only**                                                                |
| `/tickets/:id/reply`          | POST   | `settings:View`       | the reply                                                                                      |
| `/access-requests`            | GET    | `settings:Administer` | sessions awaiting this company's authorization                                                 |
| `/access-requests/:requestId` | POST   | `settings:Administer` | the recorded decision                                                                          |

**Raising a ticket is `settings:View` on purpose** — the lowest company grant there is. A product
where only an administrator can report a problem is one where problems go unreported (S-259).

**The company's ticket detail never contains an internal note.** The filter is in the query, not in
the mapping (S-258).

**A decline needs a reason and cannot be revisited.** 400 without one, 409 on a second decision, and
the session can never be activated afterwards.

## Master Console — `/platform/support`

| Route                                                  | Method | Grant                |
| ------------------------------------------------------ | ------ | -------------------- |
| `/meta`, `/queue`, `/tickets`, `/tickets/:id`          | GET    | `support:View`       |
| `/tickets/:id/assign`, `/state`, `/incident`           | POST   | `support:EditDraft`  |
| `/tickets/:id/notes`                                   | POST   | `support:Comment`    |
| `/incidents/:alertId/declare`, `/mitigate`, `/publish` | POST   | `support:Administer` |
| `/incidents/:alertId/tickets`                          | GET    | `support:View`       |
| `/health`                                              | GET    | `system-health:View` |

`PlatformSupport` holds `support: Administer` and `system-health: View` — and **nothing on any
company module**, which is what keeps these routes from being a way into tenant data (S-254).

**The operator's ticket detail carries every note**, which is the difference between this and the
company's route.

## The customer-visible status — `/tenants/:tenantId/service-status`

`GET`, `settings:View`, tenant-scoped — a signed-in company member, not the public internet. UBoss
has no public status page and the approved documents do not ask for one.

It returns a status, an operator-written summary, and the incidents an operator deliberately
published: `{ id, severity, state, startedAt, customerImpact }`. **There is no `title`, no
`summary`, no component list, no latency and no service name**, and the query does not select the
internal columns at all — a column that is never read cannot leak (S-257).

An outage nobody published reads as `ok`, deliberately (ADR-206).

---

## The Company Workspace Dashboard — Prompt 37

| Route                               | Method | Grant            | Returns                                                    |
| ----------------------------------- | ------ | ---------------- | ---------------------------------------------------------- |
| `/tenants/:tenantId/dashboard`      | GET    | `dashboard:View` | **`{ agents, pendingJobs, scope }` and nothing else**      |
| `/tenants/:tenantId/dashboard/meta` | GET    | `dashboard:View` | the two slice labels, their destinations, and the contract |

**Three keys, asserted as the whole set.** `agents` and `pendingJobs` are counted in the signed-in
person's backend-authorized scope; `scope` is the server's sentence describing what they cover, so
a manager and an employee can tell why their numbers differ. A fourth key is a locked-contract
violation and a test failure (S-269).

`/meta` carries `href` per slice — `/agents` and `/todo` — so the screen and the contract cannot
drift, and `contract` verbatim so anybody reading the API sees the rule.

**There is no filter parameter.** A client cannot ask for a wider count because there is nothing to
ask with.

## Reports — `/tenants/:tenantId/reports`

| Route                | Method | Grant                                            | Returns                                                                                     |
| -------------------- | ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| ``                   | GET    | `reports:View`                                   | only the reports this person may open, the ranges, `mayExport`, their scope, and the stance |
| `/:reportKey`        | GET    | `reports:View` **+ the report's own permission** | `{ report, scope, window, columns, rows, summary, truncated }`                              |
| `/:reportKey/export` | GET    | the above **+ `reports:Export`**                 | `text/csv`                                                                                  |

The ten keys: `ObjectiveProgress`, `HumanVsAiWorkMix`, `EmployeeWorkload`, `EngineAgentHealth`,
`SkillUsageAndQuality`, `ExecutorExceptions`, `ApprovalAging`, `AiUsageAndCost`, `AuditActivity`,
`PerformanceAndBadges`.

**The second permission names its action** (ADR-208): `AiUsageAndCost` needs `settings:Administer`
and `AuditActivity` needs `settings:Audit`, because `settings:View` is an Employee grant.
`HumanVsAiWorkMix` needs nothing beyond `reports:View` — it is this person's own work, aggregated.

**A report the reader cannot open is absent from the catalogue** and 403s at its own route.

**Filters**: `range` is one of `Last7Days`, `Last30Days`, `Last90Days`, `Custom`; `Custom` takes
`from` and `to` and is refused beyond 366 days with a 400. `truncated: true` means the row limit
cut the answer short, and the screen says so.

**Export** is audited as `report.exported` with the row count, the scope kind and the window. A
read is not audited. Every cell is escaped against formula injection and only the declared
`columns` are emitted (S-267).

---

## Portable UBoss Profile Search — `/tenants/:tenantId/profile-search` (Prompt 37A)

| Route   | Method | Grant                                                                      | Returns                                                                                              |
| ------- | ------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/meta` | GET    | `profile-search:View`                                                      | the input stance, the profile stance, the sharing modes, and **whether the feature is enabled here** |
| ``      | GET    | `profile-search:View` at the route **+ `users:Administer` in the service** | the portable profile                                                                                 |

**Tenant-scoped, though the answer is not.** The lookup crosses companies; the _authority_ to
perform it does not. `@TenantScoped` puts the caller in their own company's context, which is where
their permission and their company's policy are evaluated and where the audit row is written.

**The only parameter is `ubossUniqueId`.** Format `UB-XXXX-XXXX`, validated server-side. An email,
a name or a twelve-digit number is a 400 (S-270).

**The response is exactly:**

```
{ ubossUniqueId, displayName, searchedAt,
  employments: [ { companyName, designation, joinedOn, endedAt, isCurrent,
                   performance: { score, badge, onTimePercent, achievements } | null } ] }
```

and nothing else — a whitelist projection, asserted key-by-key and then greped for every forbidden
word (ADR-213). `performance` is `null` when that employer does not share it; `score` is `null`
under `BadgeOnly`; `onTimePercent` is `null` when nothing had a due date.

**Refusals:** 403 when the company has not enabled the feature (with a message saying it is a
setting, not a permission), 403 for anybody without `users:Administer`, 400 for a malformed id,
404 for a well-formed id nobody holds.

**Every lookup is audited** as `profile_search.performed` with the id searched, in the searching
company's trail only, **before** the read — so a lookup that found nobody is still recorded
(S-276).

**Two company settings**, both in the `security` category:
`security.portable_profile_search_enabled` (default **false**) and
`security.portable_performance_sharing` (`Nothing` / `BadgeOnly` / `BadgeAndScore`, default
**`Nothing`**) — the second read from the _source_ company, not the searcher's.

---

## Company exit — `/platform/company-exits` (Prompt 38)

| Route                     | Method | Grant                                                                                                        |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `/meta`                   | GET    | `companies:View` — the states, the windows, **and what exit does to each kind of record, with table counts** |
| `/awaiting-deletion`      | GET    | `companies:View`                                                                                             |
| `/companies/:tenantId`    | GET    | `companies:View`                                                                                             |
| `/:exitId`                | GET    | `companies:View`                                                                                             |
| `/companies/:tenantId`    | POST   | `companies:EditDraft` — a request changes nothing                                                            |
| `/:exitId/approve`        | POST   | `companies:Administer` — refused if you raised it                                                            |
| `/:exitId/export`         | GET    | `companies:Export`                                                                                           |
| `/:exitId/read-only`      | POST   | `companies:Administer`                                                                                       |
| `/:exitId/retention-hold` | POST   | `companies:Administer`                                                                                       |
| `/:exitId/delete-content` | POST   | `companies:Administer` **+ three more gates**                                                                |
| `/:exitId/cancel`         | POST   | `companies:Administer`                                                                                       |

**Every route is platform-only, including the customer's own request.** A company cannot end its
own contract through the product: contract end is a commercial act with notice periods on both
sides, and a self-service button would let one administrator terminate a company's UBoss estate on
an afternoon. `requestedByCustomer` records that the customer asked; an operator raises it. Same
shape as provisioning, where there is no public signup either.

**`/delete-content` takes `{ confirm }`** — the company's own slug, typed exactly. Not `DELETE`
(ADR-221). Four gates: `RetentionHold`, the elapsed window, a second person's approval, and the
confirmation. A `POST` rather than a `DELETE` so this is not a URL somebody can arrive at.

**The response to a deletion is the certificate**: `deletedRowCount`, `preservedRowCount` and a
`deletionManifest` of `{ deleted: {table: rows}, retainedByPrivilege: {table: rows} }` — the second
being the six `Content` tables the application role cannot delete (ADR-219).

**`/export` returns `{ manifest, data }`.** The manifest carries the section row counts **and the
exclusions with their reasons** — file bytes, credentials, the security trail, Aadhaar — so nothing
is discovered on opening the archive. Refused once the content is deleted, with a message saying
the export exists throughout the read-only and retention periods, which is what those periods are
for.

**`/cancel`** works from any state before `Deleted`. From `ReadOnly` it restores the company to
`Active`; from `RetentionHold` it stops the exit and **leaves the company `Closed`**, because
Prompt 11 reserves reopening a closed company as its own deliberate operation (ADR-220). The audit
summary says which happened.

---

## Observability — `/platform/observability` (Prompt 39)

| Route                            | Method | Grant                                                                                                        |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `/meta`                          | GET    | `system-health:View` — the metrics, the alert rules, the correlation chain, and four stances served verbatim |
| `/metrics`                       | GET    | **none** — see below                                                                                         |
| `/metrics/snapshot`              | GET    | `system-health:View`                                                                                         |
| `/alert-rules`                   | GET    | `system-health:View` — every rule with its current value                                                     |
| `/alert-rules/evaluate`          | POST   | `dev-ops:EditDraft` — writes rows                                                                            |
| `/traces`                        | GET    | `system-health:View` — `?correlationId=` for one trace                                                       |
| `/incidents/:alertId/timeline`   | GET    | `system-health:View` — timeline, actions, postmortem readiness                                               |
| `/incidents/:alertId/timeline`   | POST   | `support:Comment`                                                                                            |
| `/incidents/:alertId/postmortem` | POST   | `support:Administer`                                                                                         |
| `/incidents/:alertId/resolve`    | POST   | `support:Administer`                                                                                         |
| `/incidents/:alertId/actions`    | POST   | `support:Administer`                                                                                         |
| `/actions/:actionId/close`       | POST   | `support:Administer`                                                                                         |
| `/actions/open`                  | GET    | `system-health:View`                                                                                         |

**`/metrics` carries no permission decorator**, because a Prometheus scraper holds no session. That
is only acceptable because the payload carries **no tenant, user, run or provider label anywhere**
(ADR-223/224) — enforced in code and asserted by a test. It is still `@PlatformOnly`; network
restriction is deployment's job and the runbook says so.

`/metrics/snapshot` reports **`rejectedObservations`**, which should be zero. Non-zero means code is
recording a disallowed label; the observation was dropped rather than the request failed.

**`/incidents/:alertId/resolve` takes an optional `postmortem` and applies both changes in one
transaction.** A P0 or P1 cannot resolve without one _and_ without at least one timeline entry; a P2
resolves on its mitigation note alone (ADR-227). It also appends a `Resolved` timeline entry, so the
narrative ends where the record does.

**`POST /incidents/:alertId/timeline` accepts `occurredAt`** — deliberately backdatable, because an
operator catching up after an outage backfills (ADR-228).

**`POST /actions/:actionId/close`** requires `outcomeNote` for `Dropped` and not for `Done`.

## What the correlation id now joins

`audit_events`, `security_events`, `agent_runs`, **`model_gateway_calls`** and
**`cost_ledger_entries`** — the last two added by this prompt. The runbook carries the four queries.

## Prompt 40 — Rate limits, idempotency and fairness

### What every route now carries

Two global interceptors, the limiter outside the idempotency layer (S-307).

**`RateLimit-Limit` and `RateLimit-Remaining` on every response**, allowed or refused. A client that
can see it is running out of allowance can slow down _before_ being refused, which is the difference
between a rate limit that shapes traffic and one that only punishes it.

**A refusal is `429` with a business-readable body:**

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "You have made a lot of requests very quickly. Wait a moment and try again — this limit is per person, so nobody else in your company is affected.",
  "scope": "User",
  "limit": 300,
  "retryAfterSeconds": 2
}
```

plus `Retry-After`. `message` is the sentence a screen shows unchanged: it says whether this is the
person or their company, and whether to wait or to call somebody. `scope` is `User`, `Tenant`,
`Runs` or `Provider`. The person's own limit is checked **before** the company's, so a refusal names
the real cause rather than blaming their colleagues.

Never limited: `/health`, the metrics scrape, `/auth/logout`. **Not** sign-in — see S-306.

### `Idempotency-Key`

Optional, on `POST` only. Up to 200 characters; a UUID is the usual choice.

| Situation                              | Response                                                     |
| -------------------------------------- | ------------------------------------------------------------ |
| First request with this key            | the work is done, the response remembered for 24h            |
| Retry, same key, same body             | the **same status and body**, plus `Idempotent-Replay: true` |
| Retry while the first is still running | `409` — retry with the same key in a moment                  |
| Same key, **different** body           | `409`, and neither request applied (S-304)                   |
| The first attempt failed               | the claim is released, so the retry really retries           |
| Key reused after 24 hours              | a new request (S-308)                                        |

A key longer than 200 characters is refused rather than truncated: a truncated key would be written
short and never match on read, so every retry would do the work again — silently.

### `/platform/limits` — `@PlatformOnly`

| Route                                     | Permission           |
| ----------------------------------------- | -------------------- |
| `GET /platform/limits`                    | `system-health:View` |
| `GET /platform/limits/fairness`           | `system-health:View` |
| `GET /platform/limits/providers`          | `system-health:View` |
| `POST /platform/limits/idempotency/sweep` | `dev-ops:EditDraft`  |

`GET /platform/limits` serves the configured values, the code defaults, which store is in use, and
**the caveat** — with a per-process store the effective limit is the configured limit multiplied by
the instance count, and a status endpoint reporting the number without that would be reporting a
figure that is not in force.

`GET /platform/limits/fairness` returns the counts **and the next twenty in order**, because "why is
my run not starting" is answerable only from the sequence.

`GET /platform/limits/providers` reports provider **model ids** and failure reasons, never a vendor
name (S-309).

Platform-only throughout: a company cannot read another company's queue position. Its _own_ limits
reach it in the 429, which carries everything a screen needs.

### Changed elsewhere

`POST /platform/providers/:profileId/models` accepts an optional `quotaRequestsPerMinute`.

**`EXCEPTION_KINDS` gains `AgentRunOverdue`** (ADR-238), so the Executor screen and every
exception route serve one more kind. Raised by the existing sweep for a run queued longer than
thirty minutes; severity `Medium`; owner routing "agent owner, then their manager". No route
changed shape — a new value in an existing closed set.

## Prompt 40A (CR-03) — access, the Job Method, photos and chat

### `/access/capabilities` — the Access & Permissions step

| Route                                                               | Permission           |
| ------------------------------------------------------------------- | -------------------- |
| `GET /tenants/:tenantId/access/capabilities/:userId`                | `users:ManageAccess` |
| `POST /tenants/:tenantId/access/capabilities/:userId`               | `users:ManageAccess` |
| `DELETE /tenants/:tenantId/access/capabilities/:userId/:capability` | `users:ManageAccess` |

Reading is gated as tightly as writing, deliberately: the response says which capabilities the
**caller** may grant, which is a description of their own authority and not something a colleague
should be able to enumerate. Each capability comes back with `held`, `canGrant`, a `whyNot` when
it cannot be granted, and the real `grants` it expands to — so an administrator can see what a
friendly label actually does.

`defaultForNewEmployee` is `['RunAssignedAgents', 'OwnTasks']`. **That is the CR-03 change, made
visible.**

### `/agents` — the operator's half

| Route                                                    | Permission                    |
| -------------------------------------------------------- | ----------------------------- |
| `GET /tenants/:tenantId/agents/operator-meta`            | `agents:View`                 |
| `GET /tenants/:tenantId/agents/mine`                     | `agents:View`                 |
| `GET /tenants/:tenantId/agents/:id/operator-view`        | `agents:View`                 |
| `GET /tenants/:tenantId/agents/:id/operators`            | `agents:View`                 |
| `POST /tenants/:tenantId/agents/:id/operators/:userId`   | `todo:Assign` + `agents:View` |
| `DELETE /tenants/:tenantId/agents/:id/operators/:userId` | `todo:Assign` + `agents:View` |

**Two grants on the share routes, because `agents:Assign` is granted to no role template at all.**
Staffing an agent is handing work to a person, which is what `todo:Assign` means.

An operator view returns exactly `OPERATOR_VIEW_FIELDS`: agent name, linked objective, assigned
work, status, last and next run, `canRun`, and one sentence in `cannotRunBecause`. No prompt, no
model, no key, no configuration. `cannotRunBecause` is the **first** unmet precondition in the
declared order, and assignment is first so a refusal to a stranger reveals nothing about approval,
connections or budget.

### `/job-methods` — download, offline fill, upload

| Route                                                      | Permission                |
| ---------------------------------------------------------- | ------------------------- |
| `GET /tenants/:tenantId/job-methods/meta`                  | any member                |
| `GET /tenants/:tenantId/job-methods/:assignmentId/form`    | `todo:View`               |
| `GET /tenants/:tenantId/job-methods/:assignmentId`         | `todo:View`               |
| `POST /tenants/:tenantId/job-methods/:assignmentId/import` | `agent-builder:EditDraft` |

**The split is the feature**: download needs no builder permission and upload does. The form carries
the thirteen columns with their exact headings, the objective and assignment linkage, the company's
own Employee ID (never a UBoss Unique ID), and a form version. Five columns are prefilled as blank
on purpose.

An import returns the review — `accepted`, the `stage` it reached, the flagged `problems` by kind
(`Missing`, `Invalid`, `Ambiguous`, `Unmapped`), and an `agentSuggestion`. It saves into a draft
and **never tests or activates**.

### `/photos` — the optional employee photo

| Route                                      | Permission                     |
| ------------------------------------------ | ------------------------------ |
| `GET /tenants/:tenantId/photos/meta`       | any member                     |
| `GET /tenants/:tenantId/photos/:userId`    | any member                     |
| `GET /tenants/:tenantId/photos?userIds=…`  | any member                     |
| `POST /tenants/:tenantId/photos/:userId`   | yourself, or `users:EditDraft` |
| `DELETE /tenants/:tenantId/photos/:userId` | yourself, or `users:EditDraft` |

No route-level decorator: a route-level `users:EditDraft` would refuse an employee their own
picture, and a grant loose enough to admit them would let them edit colleagues. Every response
carries `initials`, so a screen never has to compute a fallback — and a photo that a scan has not
cleared comes back `viewable: false`, which looks exactly like "no photo yet".

**The six mandatory Add Employee fields are unchanged.**

### `/chat` — Workspace Chat

| Route                                                     | Gate                                      |
| --------------------------------------------------------- | ----------------------------------------- |
| `GET /tenants/:tenantId/chat/meta`                        | any member                                |
| `GET /tenants/:tenantId/chat/conversations`               | participant                               |
| `POST /tenants/:tenantId/chat/conversations`              | must include yourself                     |
| `GET /tenants/:tenantId/chat/conversations/:id`           | participant                               |
| `POST /tenants/:tenantId/chat/conversations/:id/messages` | participant                               |
| `DELETE …/messages/:messageId`                            | the author                                |
| `POST …/:id/read`                                         | participant                               |
| `POST …/:id/context`                                      | participant **and** able to see the thing |
| `GET /tenants/:tenantId/chat/search?q=`                   | participant                               |

**No `@RequirePermission` anywhere, and no `chat` module in the permission set.** A conversation is
correspondence between specific people, not company data a role grants access to. A non-participant
gets `404`, not `403`.

A conversation's `context` comes back as a discriminated union: `{accessible: true, title, status,
deepLink}` or `{accessible: false, id, reason}`. Two people in the same conversation can get
different answers for the same reference, and that is correct rather than inconsistent.

`meta` serves `contextStance`, `attachmentStance`, `searchStance`, `realtimeStance` and
`excludedByDesign` verbatim — the last two because "chat is realtime" and "voice is coming" are
both claims somebody would otherwise make.

### Changed elsewhere

`FileService` gained `uploadAuthorizedElsewhere` and `deleteAuthorizedElsewhere` (ADR-247).
`EXCEPTION_KINDS` unchanged since Prompt 40.

### Added in the second pass — what the screens needed

| Route                                                  | Permission                   |
| ------------------------------------------------------ | ---------------------------- |
| `GET /tenants/:tenantId/my-access`                     | none                         |
| `GET /tenants/:tenantId/agents/:engineAgentId/my-runs` | `agents:View` + a live share |

**`/my-access` has no permission of its own, deliberately.** Gating "what am I allowed to do" behind
a permission is circular, and the person who most needs the answer is the one holding the least. It
is `@TenantScoped()` and answers only about the caller — separate from `authorizationApi`, which is
platform-only and answers about other people. Without it, a standard Employee's own navigation could
not be rendered at all.

It returns `visibleModules` and `granted`, which is what every company page's sidebar is derived
from, and what a screen asks before offering a control the route would refuse. Backend authorization
remains authoritative; this exists so the presentation can agree with it.

**`/my-runs` backs both View Result and History**, because they are the same list and two endpoints
could disagree. The share is checked in the service rather than inherited from the module grant:
`agents:View` is what lets somebody open the screen, and the share is what puts a particular agent
on it. A missing share is refused with the same sentence an invented id produces, so an id somebody
guessed learns nothing.

Its projection is total (ADR-252). `engineAgentVersionId`, `correlationId`, `producedByRealModel`,
`attempt`, `retryability` and the raw `output` document never leave the service; `resultText` is
`output.text` and nothing else.

### `POST /tenants/:tenantId/agents/:agentId/runs` — changed

The Prompt 26 route, unchanged in shape, now reachable by an operator. It consulted only ownership
before, which meant the person a manager built an agent _for_ was answered 404 — the one path CR-03
exists to create. A live `EngineAgentOperator` row is now a second way to reach the agent; `mayRun`
still asks the same `AuthorizationService` for `agents:Run` and for scope. `Pause` is unchanged and
a share does not confer it. See ADR-251 and S-329.

## Prompt 41 — Backups, restore and disaster recovery

| Route                                 | Permission                          |
| ------------------------------------- | ----------------------------------- |
| `GET /platform/recovery`              | `system-health:View`, platform-only |
| `GET /platform/recovery/schema-state` | `system-health:View`, platform-only |

**There is no route that takes a backup, and no route that restores one.** That is the contract, not
an omission. The application connects as `uboss_app`, which is `NOBYPASSRLS`; an endpoint that ran
`pg_dump` would need owner credentials the application deliberately does not hold, and would be a
route through which a compromised session could dump the database (S-336).

`GET /platform/recovery` answers _when did a restore last succeed_, and returns the targets in
force by tier, the drill's state and whether it is overdue, the verification checks, the decision
tree, and `RECOVERY_CLAIM_STANCE` verbatim.

`lastVerifiedRestoreAt` is a **query parameter**, supplied by the caller from the drill's own
evidence file. It is not stored in a table the API can write: a status the API could update without
a restore having happened is a status somebody will eventually update (ADR-260). `neverVerified` is
true until an evidence file says otherwise.
