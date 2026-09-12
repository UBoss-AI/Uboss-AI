# Database Changelog

PostgreSQL is the primary system of record. Prisma owns the schema and the migration history.

## Local setup

```bash
docker compose -f infra/docker-compose.yml up -d   # PostgreSQL 17 on port 5442
cd apps/api
cp .env.example .env
npm run db:deploy                                  # apply migrations
npm run db:seed                                    # demo Platform Admin + demo company
```

**Port 5442, not 5432.** Two other UBoss-named Docker stacks from different project directories
(`Uboss Ai`, `Uboss Ai New`) already occupy 5432 and 5433 on this machine. This repository has its
own compose project (`uboss-ent`), its own volume and its own port so it can never read or destroy
their data.

Two databases exist: `uboss_dev` for development and `uboss_test` for integration tests. The test
harness refuses to run against any database whose name does not contain `test`, because it
truncates tables.

### Scripts (`apps/api`)

| Script                      | Purpose                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run db:up` / `db:down` | Start/stop the local PostgreSQL container                                                |
| `npm run db:generate`       | Regenerate the Prisma client (also runs before build/typecheck/test)                     |
| `npm run db:migrate`        | Create and apply a migration in development                                              |
| `npm run db:deploy`         | Apply pending migrations — the command CI and production use                             |
| `npm run db:status`         | Show migration state                                                                     |
| `npm run db:seed`           | Run the idempotent development seed                                                      |
| `npm run db:reset`          | Guarded from-scratch rebuild: drop schema, re-migrate, re-seed (**destroys local data**) |
| `npm run db:reset:dry-run`  | Preview exactly what a reset would destroy, changing nothing                             |
| `npm run db:studio`         | Prisma Studio                                                                            |

---

## Migration policy — enforced from Prompt 3

1. **Expand → migrate → contract.** A breaking schema change is never a single deploy. First add
   the new shape (expand), then move data and switch readers/writers (migrate), then remove the old
   shape in a later release (contract). This keeps rollback possible at every step. Concretely: add
   a nullable column, backfill it, start writing it, start reading it, and only then make it
   `NOT NULL` or drop its predecessor.
2. **Every migration is a committed file** applied through Prisma Migrate. No hand-edited
   production schema, and never `db push` against a shared environment.
3. **Every tenant-owned table carries `tenant_id`**, with indexes that lead with it so a
   single-tenant query never degrades into a full scan.
4. **Stable IDs are UUID/ULID.** This schema uses **UUIDv7** (`@default(uuid(7))`): time-ordered,
   so index locality stays good as rows are appended, while remaining opaque externally. **Email is
   never a primary identity** — a person's email can change while their identity must not.
5. **Migrations are dangerous actions.** Each one gets an impact review, a stated reason and
   explicit confirmation, and applying it is audited.
6. **Destructive steps are separated** from additive ones, so a drop can never ride along unnoticed
   with an add.
7. **Column names are `snake_case`** throughout, so raw SQL — including the Row-Level Security
   policies planned for Prompt 4 — reads consistently. Prisma field names stay camelCase via
   `@map`.
8. **`row_version` is optimistic-concurrency only.** It is deliberately _not_ named `version`, to
   keep it distinct from the Objective draft/live version chain, which is a domain concept with
   entirely different rules.
9. **Every entry below records:** date, prompt, migration name, tables and columns touched,
   index/constraint changes, whether it is expand/migrate/contract, and how to roll back.

---

## Entries

### 2026-09-08 — Prompt 3 — `20260908085001_foundation_tenant_user_membership_audit`

**Type:** expand (initial creation; nothing to migrate or contract).

Creates the four foundation tables.

| Table                | Columns                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenants`            | `id` (uuid pk), `slug`, `name`, `legal_name`, `created_at`, `updated_at`, `row_version`                                                                |
| `users`              | `id` (uuid pk), `uboss_unique_id`, `email`, `display_name`, `is_platform_actor`, `created_at`, `updated_at`, `row_version`                             |
| `tenant_memberships` | `id` (uuid pk), `tenant_id`, `user_id`, `created_at`, `updated_at`, `row_version`                                                                      |
| `audit_events`       | `id` (uuid pk), `tenant_id`, `actor_user_id`, `action`, `resource_type`, `resource_id`, `summary`, `metadata` (jsonb), `correlation_id`, `occurred_at` |

**Constraints and indexes, and why each exists:**

| Object                                                           | Reason                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tenants_slug_key` (unique)                                      | The workspace handle must be unambiguous platform-wide                                                   |
| `users_uboss_unique_id_key` (unique)                             | One permanent UBoss Unique ID per person                                                                 |
| `users_email_key` (unique)                                       | Email is a unique login handle — but not the identity                                                    |
| `tenant_memberships_tenant_id_user_id_key` (unique)              | A person holds at most one membership per company                                                        |
| `tenant_memberships_user_id_idx`                                 | "Which companies does this person belong to" — workspace switching                                       |
| `audit_events_tenant_id_occurred_at_idx` (DESC)                  | The primary audit read: one tenant's trail, newest first                                                 |
| `audit_events_actor_user_id_occurred_at_idx` (DESC)              | "What did this actor do", newest first                                                                   |
| `audit_events_resource_type_resource_id_idx`                     | History of one specific record                                                                           |
| FK `tenant_memberships.tenant_id → tenants.id` ON DELETE CASCADE | Closing a company removes its memberships                                                                |
| FK `tenant_memberships.user_id → users.id` ON DELETE CASCADE     | Deleting a person removes their memberships                                                              |
| FK `audit_events.tenant_id → tenants.id` ON DELETE CASCADE       | A closed company's trail goes with it                                                                    |
| FK `audit_events.actor_user_id → users.id` ON DELETE SET NULL    | The event survives even if the actor is deleted — an audit row must never disappear because a person did |

**Deliberately absent:** no password, hash, token, secret, credential or Aadhaar column exists
anywhere in this migration. Verified against `information_schema.columns`. Credentials arrive at
Prompt 5 and are set by the user during invitation activation; the employment record that carries
Aadhaar arrives at Prompt 12.

**Also deliberately deferred**, each to the prompt that owns it: tenant lifecycle states
(Prompt 4), roles/scope/permissions (Prompt 7), Vision/Mission and the hierarchy (Prompt 12).
`audit_events.correlation_id` exists as a column but nothing populates it until request context
lands at Prompt 4.

**Rollback:** `DROP TABLE audit_events, tenant_memberships, users, tenants CASCADE;` — safe only
because this is the first migration and no data predates it. Every later migration needs a real
reverse path.

### 2026-09-08 — Prompt 4 — `20260908092325_tenant_lifecycle_state`

**Type:** expand + migrate (single deploy, justified below).

Adds the company lifecycle state the tenant guard enforces.

| Object                          | Detail                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `tenant_lifecycle_state` (enum) | `Provisioning`, `PendingActivation`, `Active`, `Suspended`, `ReadOnly`, `Closed` |
| `tenants.lifecycle_state`       | `NOT NULL DEFAULT 'Provisioning'`                                                |
| `tenants_lifecycle_state_idx`   | The Master Console filters companies by state                                    |
| Backfill                        | `UPDATE tenants SET lifecycle_state = 'Active' WHERE created_at < NOW()`         |

**Why one deploy rather than three:** adding a `NOT NULL` column **with a default** is safe in a
single step on PostgreSQL 11+ (no table rewrite), and no pre-existing writer can produce a NULL,
so expand/migrate/contract legitimately collapses. A column added _without_ a default would have
needed the full nullable → backfill → `NOT NULL` sequence across separate deploys. The backfill is
still written explicitly, because companies that predate the column were provisioned and
functioning — `Active` is the truthful state for them, and leaving them at the `Provisioning`
default would have locked existing users out.

**Rollback:** `ALTER TABLE tenants DROP COLUMN lifecycle_state; DROP TYPE tenant_lifecycle_state;`

### 2026-09-08 — Prompt 4 — `20260908093000_row_level_security_defence_in_depth`

**Type:** expand (no data change).

Adds PostgreSQL Row-Level Security as a **second** isolation layer. The application's tenant
scoping remains authoritative; RLS exists to catch a query that forgets `WHERE tenant_id = ...`.

| Object               | Detail                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- |
| Role `uboss_app`     | `LOGIN NOBYPASSRLS NOSUPERUSER`, not the table owner. DML granted, `CREATE` revoked     |
| Default privileges   | Future tables/sequences are reachable by `uboss_app` without another grant              |
| `tenant_memberships` | `ENABLE` + **`FORCE`** ROW LEVEL SECURITY, policy `tenant_memberships_tenant_isolation` |
| `audit_events`       | `ENABLE` + **`FORCE`** ROW LEVEL SECURITY, policy `audit_events_tenant_isolation`       |

**Two facts made a naive setup useless, and both are handled:** the owner role `uboss` is a
superuser _with `rolbypassrls`_, so policies would never have applied to it — hence the separate
application role; and a table owner bypasses RLS even without that attribute — hence
`FORCE ROW LEVEL SECURITY`.

**Policy shape.** Access is granted when either `app.current_tenant_id` matches the row's
`tenant_id`, or `app.platform_operation = 'on'`. Both `USING` (reads) and `WITH CHECK` (writes)
are set, so a write cannot plant a row in another company either. A code path that declares
**neither** setting sees zero rows: **RLS fails closed**, so forgetting to declare a scope is an
immediate visible failure rather than a silent leak.

`tenants` and `users` are deliberately **not** under RLS: `tenants` is the tenant root that the
Master Console legitimately reads across, and `users` is the permanent platform person identity —
one human belongs to several companies, so a `tenant_id` on the person would be wrong. Isolation
for people is applied at the membership join instead.

**What this does and does not protect.** It protects any path that declares a tenant scope —
which is every guarded request. It does **not** constrain a path that legitimately declares a
platform operation; those are supposed to cross tenants, and their correctness rests on the
application layer. Narrowing the platform-operation escape hatch further (for example a
user-scoped policy for "which companies do I belong to") is recorded as future hardening in
`docs/SECURITY_DECISIONS.md` S-015.

**Rollback:**

```sql
DROP POLICY tenant_memberships_tenant_isolation ON "tenant_memberships";
DROP POLICY audit_events_tenant_isolation ON "audit_events";
ALTER TABLE "tenant_memberships" NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY;
-- The role is cluster-level; drop it only if nothing else uses it.
```

**Operational consequence — two connection strings.** The application connects as `uboss_app`
(`DATABASE_URL`) so RLS applies to it; migrations and seeds connect as the owner
(`DATABASE_MIGRATION_URL`). `prisma.config.ts` prefers the migration URL. The test harness mirrors
this with `TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` — the isolation suite runs as the
unprivileged role so it exercises the same policies the application does.

### 2026-09-08 — Prompt 5 — `20260908104516_auth_credentials_invitations_sessions`

**Type:** expand + migrate (single deploy, on the same reasoning as the lifecycle-state entry).

Adds authentication: credentials, invitations, password-reset tokens, sessions, and the person's
account state inside a company. This is the migration where the schema first gains anywhere to
store a secret, so what it stores is deliberately narrow — one password hash and three token
hashes, nothing else.

| Object                                | Detail                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `account_state` (enum)                | `NotInvited`, `InvitePending`, `Active`, `Suspended`, `Offboarded`                                                            |
| `tenant_memberships.account_state`    | `NOT NULL DEFAULT 'NotInvited'` — the person's state in **this** company                                                      |
| `tenant_memberships_tenant_state_idx` | `(tenant_id, account_state)` — Users & Access filters by state within a company                                               |
| `user_credentials`                    | One row per identity: `password_hash`, `password_updated_at`, `failed_attempts`, `locked_until`                               |
| `user_credentials.user_id`            | `UNIQUE` — one UBoss identity, one password, across every company                                                             |
| `invitations`                         | `tenant_id`, `user_id`, `token_hash`, `expires_at`, `accepted_at`, `cancelled_at`, `invited_by_user_id`, `resend_count`       |
| `password_reset_tokens`               | `user_id`, `token_hash`, `expires_at`, `used_at`, `requested_from`                                                            |
| `sessions`                            | `user_id`, `token_hash`, `last_seen_at`, `absolute_expires_at`, `revoked_at`, `revoked_reason`, `device_label`, `client_hint` |
| `token_hash` on all three             | `VARCHAR(64)` `UNIQUE` — a SHA-256 hex digest, looked up **by hash** so comparison is an index probe                          |
| `sessions_user_revoked_idx`           | `(user_id, revoked_at)` — the Active Sessions list                                                                            |
| `sessions_absolute_expires_idx`       | `(absolute_expires_at)` — expiry sweeps                                                                                       |
| `invitations_tenant_created_idx`      | `(tenant_id, created_at DESC)` — the invitation list, newest first                                                            |
| Backfill                              | `UPDATE tenant_memberships SET account_state = 'Active' WHERE created_at < NOW()`                                             |
| RLS                                   | Enabled and **forced** on `invitations` only                                                                                  |

**Why the backfill.** A membership that existed before this column did was already in use, so
`Active` is the truthful state for it. Leaving those rows at the `NotInvited` default would have
locked out every existing user. New memberships correctly default to `NotInvited`: provisioning a
company creates its first membership, and that person is not yet invited.

**Why only `invitations` is under RLS.** RLS keys on `app.current_tenant_id`, so it can only
protect tables that _have_ a tenant. `user_credentials`, `password_reset_tokens` and `sessions` are
**person-level**, not tenant-level — one identity's password and sessions span every company they
belong to, which is the whole point of a single UBoss identity. Giving them a `tenant_id` purely to
satisfy a policy would be inventing a relationship the domain does not have, and would break the
cross-company case the client asked for. They are protected instead by never being queried outside
the authentication services, each of which scopes by `user_id` taken from the verified session —
never from anything the caller supplied. This limit is stated in SECURITY_DECISIONS S-015 rather
than papered over.

**What is deliberately absent.** No `password` column, no reversible encryption, no "temporary
password", no password-history table, and no column anywhere that could hold a reusable provider
credential. `password_hash` is a `VARCHAR(255)` PHC string; the three token columns hold hex
digests. Nothing in this migration can be decrypted.

**Rollback:**

```sql
DROP TABLE sessions;
DROP TABLE password_reset_tokens;
DROP TABLE invitations;
DROP TABLE user_credentials;
ALTER TABLE tenant_memberships DROP COLUMN account_state;
DROP TYPE account_state;
```

Rolling back drops every password and every session, which is the correct consequence: those rows
cannot be reconstructed, and everyone would have to be re-invited. Noted here so nobody discovers
it during an incident.

### 2026-09-08 — Prompt 6 — `20260908124500_enterprise_identity_mfa_sso_scim`

**Type:** expand only.

Every added column is nullable or carries a default and no existing row's meaning changes, so
there is nothing to backfill and no expand/migrate/contract sequence:

- `sessions.primary_auth_method` defaults to `'Password'`, which is truthfully what every session
  created before this migration was;
- `sessions.mfa_satisfied_at` is null, which is correct — none of them needed a second factor;
- `tenant_memberships.provisioning_source` defaults to `'Local'`, which is what every existing
  membership is: none came from SCIM, because SCIM did not exist.

| Object                                               | Detail                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `auth_method` (enum)                                 | `Password`, `Totp`, `WebAuthn`, `Oidc`, `Saml`, `RecoveryCode`                                 |
| `mfa_factor_state` (enum)                            | `Pending`, `Active`, `Revoked`                                                                 |
| `sso_protocol` (enum)                                | `Oidc`, `Saml`                                                                                 |
| `domain_verification_state` (enum)                   | `Pending`, `Verified`, `Failed`, `Expired`                                                     |
| `provisioning_source` (enum)                         | `Local`, `Scim`                                                                                |
| `tenant_auth_policies`                               | One row per company: `require_mfa`, `require_sso`, `allow_password_sign_in`, `mfa_grace_until` |
| `mfa_factors`                                        | Person-level. `secret_ciphertext` (AES-GCM envelope), `last_used_counter` (replay guard)       |
| `mfa_recovery_codes`                                 | `code_hash` UNIQUE (SHA-256), `used_at`, `batch_id`                                            |
| `mfa_challenges`                                     | A password sign-in awaiting its second factor. `token_hash` UNIQUE, `attempts`, `expires_at`   |
| `sso_connections`                                    | Per company. `client_secret_ciphertext`, issuer/discovery/client id, SAML columns              |
| `sso_auth_requests`                                  | `state_hash` UNIQUE, `nonce_hash`, `code_verifier_ciphertext`, `consumed_at`                   |
| `domain_verifications`                               | `verification_token`, `state`, `expires_at`, `failure_reason`                                  |
| `scim_clients`                                       | `token_hash` UNIQUE (SHA-256), `enabled`, `last_used_at`                                       |
| `user_groups` / `user_group_members`                 | Provisioning targets. No permissions attached until Prompt 7                                   |
| `sessions` + 4 columns                               | `primary_auth_method`, `mfa_satisfied_at`, `sso_connection_id`, `provider_session_id`          |
| `tenant_memberships` + 2 columns                     | `scim_external_id` (unique per tenant), `provisioning_source`                                  |
| `sessions_sso_connection_id_provider_session_id_idx` | Back-channel logout: "end every session belonging to this provider session"                    |
| RLS                                                  | Enabled and **forced** on all 7 new tenant-owned tables                                        |
| Partial unique index (hand-written)                  | `domain_verifications(domain) WHERE state = 'Verified'`                                        |

**Why the domain index has to be partial.** A plain unique index on `domain` would mean the first
company to _attempt_ a claim blocks everyone else from trying — including the company that
actually controls the domain. The rule is "any number of pending claims, at most one verified
one", which needs a `WHERE`. Prisma has no partial-index syntax, which is why that statement is
hand-written in the migration.

**Which tables are under RLS, and which are not.** `tenant_auth_policies`, `sso_connections`,
`sso_auth_requests`, `domain_verifications`, `scim_clients`, `user_groups` and
`user_group_members` are all tenant-owned, and all have `FORCE ROW LEVEL SECURITY` with the same
fail-closed policy as Prompt 4. That matters more here than for ordinary business data: an
`sso_connections` row holds a company's encrypted client secret and its issuer configuration, so a
missing `WHERE tenant_id` would be a cross-company disclosure of _security configuration_.

`mfa_factors`, `mfa_recovery_codes` and `mfa_challenges` are deliberately **not** under RLS, for
the same reason as `user_credentials` and `sessions`: they are person-level. One human keeps one
set of second factors across every company they belong to — that is the point of a single UBoss
identity — so there is no `tenant_id` for a policy to key on, and adding one would break the
cross-company case the client asked for. They are protected instead by never being queried outside
the MFA services, each of which scopes on a `user_id` taken from a verified session or a verified
challenge, never from caller input. Stated in SECURITY_DECISIONS S-015 rather than papered over.

**The RLS policy caught a real bug on first run**, which is worth recording because it is the
justification for having it. The new repositories merged `tenant_id` into every query but did not
_declare_ the scope to PostgreSQL, so every write failed with `new row violates row-level security
policy`. Fail-closed made the omission immediate and loud instead of a silent cross-tenant leak.
The fix (ADR-037) makes those repositories declare their own scope, so the signature now implies
the guarantee.

**What this migration does NOT store.** No plaintext password, no plaintext TOTP secret, no
plaintext client secret, no reusable provider credential in any readable column. Three columns hold
AES-256-GCM envelopes; four hold SHA-256 digests; the rest is configuration. A SAML signing
certificate is stored as-is because a certificate is public material.

**Rollback:**

```sql
ALTER TABLE sessions
  DROP COLUMN provider_session_id,
  DROP COLUMN sso_connection_id,
  DROP COLUMN mfa_satisfied_at,
  DROP COLUMN primary_auth_method;
ALTER TABLE tenant_memberships
  DROP COLUMN provisioning_source,
  DROP COLUMN scim_external_id;
DROP TABLE user_group_members, user_groups, scim_clients, domain_verifications,
           sso_auth_requests, sso_connections, mfa_challenges, mfa_recovery_codes,
           mfa_factors, tenant_auth_policies;
DROP TYPE provisioning_source, domain_verification_state, sso_protocol,
          mfa_factor_state, auth_method;
```

Rolling back **destroys every enrolled second factor, every recovery code and every SSO
connection**, and none of it can be reconstructed: TOTP secrets and recovery codes exist nowhere
else, and a company's client secret would have to be reissued by its identity provider. Everyone
with MFA would have to re-enrol. Recorded here so it is not discovered during an incident.

**One new environment variable is mandatory.** `AUTH_ENCRYPTION_KEYS` (`id:base64key`, comma
separated, first key active) — the process refuses to start without a valid one, because a
deployment that cannot decrypt a TOTP secret would otherwise appear healthy and fail at someone's
first sign-in. See `apps/api/.env.example`.

### 2026-09-08 — Prompt 7 — `20260908210000_authorization_engine`

**Type:** expand only. Every added column is nullable or carries a default:
`tenant_memberships.user_type` defaults to `InternalUser`, which is truthfully what every existing
membership is (no external guest had been provisioned, because there was no way to be one), and the
two external-identity columns are null because no membership came through a TCSiON mapping.

| Object                             | Detail                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `user_type` (enum)                 | `InternalUser`, `ExternalGuest`, `PlatformUser`                                                                            |
| `role_kind` (enum)                 | `Employee`, `Manager`, `Head`, `CompanyAdmin`, `Approver`, `Auditor`, `Custom`                                             |
| `scope_kind` (enum)                | Six, ordered narrowest to widest — the ordering is load-bearing                                                            |
| `policy_layer` (enum)              | `Platform`, `Company`, `Department`, `Objective`, `EngineAgent`                                                            |
| `policy_effect` (enum)             | `Deny`, `Allow`                                                                                                            |
| `sod_rule` (enum)                  | `NoSelfApproval`, `FourEyes`                                                                                               |
| `custom_roles`                     | Per-company roles. `permissions` JSONB, `max_scope`, `enabled`                                                             |
| `role_assignments`                 | Person + role + scope, with `department_ids`, `selected_resource_ids`, `expires_at`, `granted_by_user_id`, `justification` |
| `policy_rules`                     | One statement at one layer. Nullable `tenant_id` for the Platform layer                                                    |
| `separation_of_duties_policies`    | Configured SoD controls. Nullable `tenant_id` for the platform baseline                                                    |
| `tcsion_mappings`                  | The extension point. Ships **empty**                                                                                       |
| `tenant_memberships` + 3 columns   | `user_type`, `external_user_type`, `external_allotment`                                                                    |
| RLS                                | Enabled and **forced** on all 5 new tables                                                                                 |
| 4 check constraints (hand-written) | See below                                                                                                                  |
| 1 seeded row (hand-written)        | The mandatory platform no-self-approval baseline                                                                           |

**Why the built-in roles are not rows.** A built-in role's meaning must be identical in every
company, and six rows per tenant would diverge under editing and migration. They live in
`@uboss/types` as `ROLE_TEMPLATES` — see ADR-038. Only `Custom` roles are stored.

**The four check constraints, and why each is not just service logic.** Prisma cannot express any
of them, so the service enforces them — and these make sure the service is not the _only_ thing
that does:

- `role_assignments_custom_role_consistency` and `tcsion_mappings_custom_role_consistency` — a
  `Custom` row must name a custom role and a built-in row must not. Otherwise `Custom` with a null
  role is an assignment that appears to grant something and grants nothing, and a built-in row with
  a custom role is two answers to one question.
- `policy_rules_layer_subject` — a `Department` rule must have a department, an `Objective` rule an
  objective, and so on; `Platform` is the deliberate exception with no tenant. A rule with no
  subject would apply either everywhere or nowhere, and both are wrong in a way that is hard to
  notice.
- `policy_rules_mandatory_is_deny_only` — a mandatory `Allow` is refused outright. "Mandatory"
  means lower layers cannot lift it, and a grant lower layers cannot tighten is the one thing the
  precedence rule forbids.

**The seeded baseline.** One row: `Platform` layer, `Approve`, `NoSelfApproval`, `mandatory`. Seeded
as data rather than left to configuration because the default has to be the safe one — a company
that never opens a settings screen should still not be able to self-approve. Written idempotently,
so re-running the chain or a `db:reset` does not duplicate it. `Publish` and `ManageAccess` are
deliberately left to each company: publishing your own draft is normal in a small team, and a
one-person company must be able to grant itself access.

**A test-harness consequence worth recording.**
`separation_of_duties_policies.tenant_id` is nullable with a foreign key to `tenants`, so
`TRUNCATE tenants CASCADE` takes the platform-layer rows with it — including that baseline. Correct
behaviour for a truncate, and wrong for a fixture: every test would then run against a company in a
state no real deployment can be in. `resetTestDatabase` restores it, rather than the truncate
naming every table explicitly and having to stay in step with the schema.

**Two migration mistakes made and fixed while building this**, recorded because both are easy to
repeat:

1. **Missing `@map` on two camelCase fields** produced `displayName` and `roleKind` columns, which
   the Prompt-3 naming test would have caught later. Every column in this repository is
   `snake_case`.
2. **The migration was first diffed against the development database**, which already held a
   half-applied version — so it came out full of `DROP COLUMN` / `DROP INDEX` rename statements and
   applied on exactly one machine. `prisma.config.ts` now configures a `shadowDatabaseUrl`, and a
   new migration must be diffed with `--from-migrations` against that clean baseline. The comment
   on that config option says so.

**Rollback:**

```sql
ALTER TABLE tenant_memberships
  DROP COLUMN external_allotment,
  DROP COLUMN external_user_type,
  DROP COLUMN user_type;
DROP TABLE tcsion_mappings, separation_of_duties_policies, policy_rules,
           role_assignments, custom_roles;
DROP TYPE sod_rule, policy_effect, policy_layer, scope_kind, role_kind, user_type;
```

Rolling back drops **every role assignment, custom role and policy rule** — that is, everyone's
authority, including the separation-of-duties controls. Nobody would be able to do anything until
assignments were rebuilt. Recorded here so it is not discovered during an incident.

---

### 2026-09-08 — Prompt 8 — `20260908233000_audit_security_foundations`

Three tables, seven columns, and a block of hand-written statements that turn "append-only" from a
code convention into a database property.

**New tables**

| Table                     | Holds                                                   |
| ------------------------- | ------------------------------------------------------- |
| `security_events`         | Login, session, risk, support and access events         |
| `audit_chain_checkpoints` | Sealed chain positions; the seam for an external anchor |
| `break_glass_requests`    | Emergency access, with its full paper trail             |

**New columns on `audit_events`** — `reason` (the _why_, distinct from `summary`'s _what_),
`resource_version`, `resource_ref`, and four chain columns: `chain_key`, `sequence`,
`prev_hash`, `row_hash`. All **nullable**.

**Old rows are deliberately not retro-chained.** Computing hashes now over rows whose integrity was
never protected would produce a chain that verifies and proves nothing. Verification reports the
unchained count instead (ADR-046).

**Hand-written half** — the generated diff cannot express any of this:

- `REVOKE UPDATE, DELETE` on `audit_events`, `security_events` and `audit_chain_checkpoints`
  from `uboss_app`. Explicit and permanent, rather than relying on the Prompt 4 default privileges,
  which grant all four verbs on new tables — right for business tables, wrong for these three.
- `uboss_refuse_history_change()` on `BEFORE UPDATE OR DELETE` for all three tables, raising
  `restrict_violation`. Binds the **owner** role too, which a `REVOKE` cannot.
- `uboss_refuse_history_truncate()` on `BEFORE TRUNCATE`, because row-level triggers do not see
  `TRUNCATE`. Yields only to the session variable `uboss.allow_history_truncate`, which the test
  harness sets with `SET LOCAL` and nothing in `src/` sets at all.
- RLS enabled **and forced** on all three new tables, fail-closed on `app.current_tenant_id` /
  `app.platform_operation`. `audit_chain_checkpoints` keys on `chain_key` compared as text,
  because a chain key is either a tenant id or the literal `platform`.
- Five check constraints on `break_glass_requests`: approver ≠ requester; `Approved`/`Active`
  requires an approver **and** an expiry; `Approved`/`Active` requires a verified identity;
  `Suppressed` notification requires a reason; a blank reason is refused.

**A consequence worth knowing before it surprises somebody.** With the append-only trigger in
place, a hard `DELETE FROM tenants` now **fails**, because the cascade would delete that tenant's
audit rows. That is the intended reading — closing a company must not erase what it did — and
nothing in the application hard-deletes a tenant (lifecycle state does that job). The test harness
truncates, which is why the escape hatch above exists.

**Every control was verified in raw SQL before any code depended on it**, the same discipline as
Prompt 4's RLS work: `uboss_app` refused by privilege, the owner refused by trigger, `TRUNCATE`
refused, the flag working, the `(chain_key, sequence)` unique index rejecting a duplicate position,
and all five break-glass constraints firing. A control assumed to work and never exercised is a
control that does not work.

**Rollback destroys:** every security event, every sealed checkpoint, and every break-glass record
— including who accessed which customer's data and whether the customer was told. It also drops the
three columns that make the audit trail verifiable, leaving `audit_events` intact but
unverifiable and once again editable. There is no reconstructing any of it.

**Two mistakes from Prompt 7 did not recur**, because both now have a mechanism rather than a
resolution: every new column was checked for `@map` before diffing, and the migration was diffed
`--from-migrations` against the configured shadow database, producing 3 `CREATE TABLE`s and **zero**
`DROP` statements.

**The old unchained write path was deleted, not deprecated.** `AuditEventRepository` was the
Prompt 3 append-only writer; it is now **read-only**, and `TenantProvisioningService` and the
seed write through the chained path instead. Leaving two writers would have meant new
unchained rows kept appearing, which would quietly redefine the `unchainedCount` a
verification reports — and that count exists precisely to be an honest statement of how much
of the trail cannot be verified. A regression test now asserts no row has a null `chain_key`.

**One bug the migration exposed in application code**, recorded because it is easy to repeat:
`pg_advisory_xact_lock` returns `void`, and the Prisma pg driver adapter cannot deserialize a
void column — `$queryRaw` fails with `UnsupportedNativeDataType`. Use `$executeRaw` for a lock
call. Relatedly, the adapter returns `int8` as a decimal **string**, not a JavaScript `bigint`,
so typing a raw-query row as `bigint` compiles and then lies at runtime.

---

### 2026-09-09 — Prompt 9 — `20260909093000_master_console_platform_roles`

Six tables, seven check constraints, and the statement that made a fail-closed change safe to
ship.

**New tables**

| Table                       | Plane    | RLS        | Holds                                            |
| --------------------------- | -------- | ---------- | ------------------------------------------------ |
| `platform_role_assignments` | platform | none       | which platform roles a person holds              |
| `plans`                     | platform | none       | commercial plans, seats, entitlements, allowance |
| `feature_flags`             | platform | none       | staged rollout for Release & Feature Control     |
| `platform_settings`         | platform | none       | global configuration, one row per setting        |
| `service_alerts`            | platform | none       | platform service alerts                          |
| `tenant_subscriptions`      | tenant   | **forced** | a company's plan, seats, billing, renewal        |

**"No RLS" is a decision, not an omission.** Five of these have no `tenant_id`, so there is no
tenant to isolate them by; a policy keyed on `app.current_tenant_id` would hide every row from the
console itself, and one keyed on `app.platform_operation` alone would be theatre. Written out in
section 1 of the migration and in `docs/SECURITY_DECISIONS.md` S-054, because a reviewer reading
the schema deserves the reasoning rather than having to guess at it.

**The consequential statement is the backfill in section 4.** `platformContext` stops granting
every platform actor all fifteen modules and starts reading assignments — a fail-closed change
that, without a backfill, would lock every existing platform actor (including the seed's and every
test's) out of the console the moment it deployed. Every `is_platform_actor` user gets a
`PlatformAdmin` assignment, with `granted_by_user_id` **NULL** and a justification saying it was
backfilled: attributing it to a person who did not grant it would be a false record in the one
table where a false record is a privilege. The access-review screen flags those rows so they get
narrowed rather than silently inherited.

**Check constraints, and the failure each prevents**

| Constraint                                    | Prevents                                                           |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `platform_role_not_self_granted`              | granting yourself authority over every company at once             |
| `platform_role_revocation_is_attributed`      | "it was revoked and we do not know by whom"                        |
| `plans_amounts_are_not_negative`              | a negative price silently crediting a customer                     |
| `plans_currency_is_iso4217`                   | `usd` and `USD` becoming two currencies                            |
| `subscription_amounts_are_not_negative`       | the same, per company                                              |
| `subscription_term_is_ordered`                | a term that ends before it starts                                  |
| `feature_flag_rollout_is_a_percentage`        | a rollout at 140%, which is a broken gate not an error             |
| `paused_feature_flag_has_no_rollout`          | a state and a percentage disagreeing about whether a feature is on |
| `resolved_service_alert_has_a_resolved_state` | an alert with a resolution timestamp and an Open state             |

**Also seeded by the migration**, not the seed script: four plans (`starter`, `growth`,
`enterprise`, `pilot`), eight platform settings of which **two are locked**, and one feature flag.
Same reasoning as the Prompt 7 separation-of-duties baseline — a Master Console with an empty plan
table cannot provision a company, so these are product configuration a fresh install needs, while
the seed's job is illustrative _customers_. All idempotent (`ON CONFLICT DO NOTHING`).

Money is stored as **integer minor units** throughout, never a float. A rounding difference in a
price is an invoice dispute.

**Rollback destroys:** every plan and every company's commercial terms — plan, seats, billing
state, renewal date and AI allowance — and **every platform role assignment**, which would return
the platform to "any platform actor can do anything". It also drops the two locked governance
settings, so the record that no public company signup exists would be gone from the database (it
remains a code and documentation constraint).

**Every control was verified in raw SQL before code depended on it**, the same discipline as
Prompts 4 and 8: all seven check constraints fired on the row each exists to forbid, the backfill
reached the existing platform actor, `tenant_subscriptions` returned zero rows with no scope
declared, and `plans` returned its four rows — confirming RLS is present on the one table that
needs it and absent on the ones that do not.

**Two bugs this migration's fail-closed change exposed elsewhere**, both worth remembering:

1. `platformContext('')` was being called with an **empty user id** in the authorization
   controller, purely as a way to read the platform separation-of-duties baseline. That worked
   only while the method did no user lookup; adding one turned it into `WHERE user_id = ''`, which
   PostgreSQL rejects as a uuid — a 500 on a settings screen. Replaced with a
   `platformSodBaseline()` accessor. Building a whole authorization context around a fake id was
   the actual defect; the migration just revealed it.
2. Test-created `plans` and `feature_flags` **leaked across test runs**, because they are
   platform-plane with no tenant to cascade from, so `TRUNCATE tenants CASCADE` cannot reach them.
   The harness now deletes back to exactly what the migration seeds rather than truncating — a
   test database with no plans cannot exercise the Master Console at all.

---

### 2026-09-09 — Prompt 10 — `20260909120000_company_provisioning_activation`

Four tables, seven new `tenants` columns, one new `role_assignments` column, eleven check
constraints, and the backfill that keeps six existing companies usable.

**New tables**

| Table                       | Plane  | RLS        | Holds                                             |
| --------------------------- | ------ | ---------- | ------------------------------------------------- |
| `tenant_ai_settings`        | tenant | **forced** | AI mode, model-profile policy, skill packs        |
| `tenant_ai_budget_policies` | tenant | **forced** | allowance, warning, approval threshold, hard stop |
| `company_setup_tasks`       | tenant | **forced** | the ten-item first-login checklist                |
| `outbox_messages`           | mixed  | **forced** | the transactional outbox (nullable tenant_id)     |

**New `tenants` columns** — `code`, `timezone`, `country_region`, `currency`, and four logo
**metadata** columns. Wizard step 1. `code` is uniquely indexed (partial, on non-null) because a
human-facing identifier two companies share is useless as an identifier.

**New `role_assignments.bootstrap`** — see ADR-056. Two check constraints tie it to a null
grantor in **both** directions, and section 2a backfills existing null-grantor rows _before_ the
constraints are added, because otherwise the migration fails on any database that has one. That
ordering was wrong on the first draft and caught before applying.

**Check constraints, and the failure each prevents**

| Constraint                                  | Prevents                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `bootstrap_grant_has_no_human_grantor`      | an ordinary grant wearing a bootstrap label                                     |
| `grant_with_no_grantor_is_marked_bootstrap` | a grant nobody made looking ordinary                                            |
| `ai_budget_thresholds_are_ordered`          | an approval threshold above the hard stop, making the approval step unreachable |
| `ai_budget_warning_is_a_percentage`         | a warning at 140%                                                               |
| `skipped_setup_task_has_a_reason`           | "skipped" being indistinguishable from "forgotten"                              |
| `setup_task_position_is_in_range`           | a checklist item at position 0 or 900                                           |
| `tenant_country_region_is_iso3166`          | `India`, `IN` and `in` becoming three countries                                 |
| `tenant_currency_is_iso4217`                | the same, for currency                                                          |
| `tenant_code_is_readable`                   | an unreadable identifier on an invoice                                          |
| `tenant_logo_metadata_is_complete`          | a storage key with no mime type — a file nothing renders                        |
| `delivered_outbox_message_has_a_timestamp`  | an unauditable "Delivered" with no delivery time                                |

**No UPDATE/DELETE revoke on `outbox_messages`**, unlike the audit trails, and deliberately: an
outbox row is _working state_ a dispatcher must claim, fail and complete. What happened to a
message belongs in the audit trail.

**The backfill** gives all six existing companies a company code derived from their slug, AI
settings on safe defaults (UBoss Managed, universal pack only), a budget policy derived from their
existing allowance (warn 80%, approve at the allowance, stop at 120% of it) and the ten checklist
rows. Without it the new screens would show an empty state that reads as a bug rather than as a
company provisioned before the wizard existed.

**Rollback destroys:** every company's AI mode and budget guardrails, every setup checklist, every
queued-but-undelivered activation invitation, and the `bootstrap` marker that distinguishes a
grant nobody made from an ordinary one. It also drops the company code, timezone and currency —
so every schedule would fall back to the default timezone, silently.

**Every constraint was verified in raw SQL before code depended on it** (the Prompt 4/8/9
discipline): eleven constraints each fired on the row it exists to forbid, and all four new tables
returned zero rows with no RLS scope declared.

---

### 2026-09-09 — Prompt 11 — `20260909140000_plans_seats_lifecycle`

Four enums, two tables, four `plans` columns, eight `tenant_subscriptions` columns, ten check
constraints, and a backfill that gives the lifecycle interval query a starting point.

**New enums** — `release_channel` (`Stable`/`Early`/`Internal`), `seat_counting_rule`,
`commercial_change_kind`, `commercial_change_state`. Enums rather than free text because each is
a closed vocabulary the code switches on exhaustively; a typo'd `'ActiveOnly '` would silently
change what a company is billed for.

**New tables**

| Table                          | Plane  | RLS        | Holds                                              |
| ------------------------------ | ------ | ---------- | -------------------------------------------------- |
| `commercial_change_requests`   | tenant | **forced** | what a company asked for, who decided, and when    |
| `tenant_lifecycle_transitions` | tenant | **forced** | every state change, its reason and its effect date |

`tenant_lifecycle_transitions` exists **as well as** the audit trail, not instead of it. The trail
records that a transition happened; this answers a different question — _what state was this
company in on a given date, and for how long_ — which a chained append-only log can only answer by
replay.

**New `plans` columns** — `seat_counting_rule` (default `ActiveAndInvited`), `allow_seat_requests`
(default true), `downgrade_grace_days` (default 30) and `release_channel` (default `Stable`).
Defaults rather than a backfill: every existing plan gets the safe behaviour without a data step.

**New `tenant_subscriptions` columns** — `seat_counting_override` and `release_channel_override`
(the negotiated exception to a plan's norm), `seat_grace_until` / `seat_grace_ceiling` (the
downgrade window), and `pending_plan_id` / `pending_seats` / `pending_effective_at` /
`pending_reason` (a future-effective plan change). `pending_plan_id` is `ON DELETE SET NULL`, so
retiring a plan cannot leave a subscription pointing at nothing.

**Check constraints, and the failure each prevents**

| Constraint                                      | Prevents                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `decided_commercial_request_is_attributed`      | "it was declined and we do not know by whom" — the gap a dispute lands in      |
| `commercial_request_is_not_self_decided`        | a company deciding its own contracted ceiling, making the ceiling a preference |
| `applied_commercial_request_was_decided`        | an applied change with no recorded decision                                    |
| `commercial_request_names_what_it_wants`        | `MoreSeats` with no seat count sitting in the queue forever                    |
| `commercial_request_justification_is_not_blank` | a request the platform cannot evaluate                                         |
| `lifecycle_transition_changes_state`            | an `Active → Active` row, which makes the interval query wrong                 |
| `lifecycle_transition_reason_is_not_blank`      | a suspension nobody can explain six months later                               |
| `pending_plan_change_is_complete`               | half a scheduled change — one the operator believes is scheduled and is not    |
| `seat_grace_is_complete`                        | a grace window with no held ceiling, so nothing is actually held               |
| `plan_downgrade_grace_is_reasonable`            | a 40-year grace period, which is not a grace period                            |

**The `commercial_request_is_not_self_decided` constraint is the database half of a control the
service also enforces.** Both, deliberately: the service can explain the refusal to a person and
record a `Critical` security event; the constraint means no future code path can bypass it,
including a migration or a hand-run `UPDATE`.

**The backfill** writes one reconstructed transition per company whose state is not
`Provisioning`, with `from_state = 'Provisioning'`, the company's own `created_at` as the
effective date, **no actor**, and a reason that says in words that the row was reconstructed and
not observed. Without it the interval query has no starting point and every company looks as
though it has always been in its current state. Marking it as reconstructed matters more than
having it: a synthesised row that reads like a recorded decision is worse than a missing one.

**Rollback destroys:** every commercial change request — including who asked for what, who
decided it and why — and **every lifecycle transition record**, so "why was this customer
suspended in March" becomes unanswerable outside the audit trail. It also drops every seat grace
window, which would immediately enforce a reduced ceiling on companies that were mid-offboarding,
and every scheduled plan change, which would silently not happen.

**Every constraint was verified in raw SQL before code depended on it** — the Prompt 4/8/9/10
discipline. All ten fired on the row each exists to forbid, both new tables returned zero rows
with no RLS scope declared (`relrowsecurity` and `relforcerowsecurity` both true), and the
backfill was confirmed to cover all six existing companies with exactly one row each.

**One test-harness defect this migration exposed.** The new `plans` columns are platform-plane
configuration, so `TRUNCATE tenants CASCADE` cannot reach them: a test that set
`allow_seat_requests = false` on the Growth plan made a **different test in the same file** fail on
the **next run**. The harness now resets the seeded plans' commercial columns to their migration
defaults, the same fix pattern Prompt 9 needed for the plan rows themselves.

---

### 2026-09-09 — Prompt 12 — `20260909160000_hierarchy_departments_reporting`

Three enums, three tables, two `tenants` columns, nine check constraints, three composite foreign
keys, two triggers, and a backfill that gives every existing company somewhere to put people.

**New enums** — `person_identifier_kind`, `identifier_assurance`, `employment_state`.

`identifier_assurance` has exactly two values, `EnteredOnly` and `NotVerified`, and **there is no
`Verified`**. That is the enforcement, not a convention: no row, no API response and no screen can
claim a verified Aadhaar, because the type system of the database has no way to express it. A
`psql` insert of `'Verified'` fails with `invalid input value for enum`.

**New tables**

| Table                | Plane  | RLS        | Holds                                                   |
| -------------------- | ------ | ---------- | ------------------------------------------------------- |
| `departments`        | tenant | **forced** | the department tree, archived rather than deleted       |
| `employment_records` | tenant | **forced** | Employee ID, designation, department, reporting manager |
| `person_identifiers` | person | **none**   | a keyed match hash and the last four digits — no number |

`person_identifiers` has **no Row-Level Security and no `tenant_id`**, deliberately: an identifier
belongs to a person, not to a company, and that is precisely what makes "the same human at their
second employer keeps one UBoss Unique ID" possible. It is protected the same way `users` is
(S-054): reachable only through the registry service, which is the only code that can compute a
match hash. Recorded as S-066.

**New `tenants` columns** — `vision` and `mission`, displayed above the hierarchy.

**Three composite foreign keys, and why they are worth a redundant index**

Each needs a `UNIQUE (tenant_id, <target>)` that adds nothing to uniqueness — the target is
already a primary key — and exists solely so a foreign key can reference the pair. That is the
standard way to make **"the referenced row is in the same tenant"** a database guarantee rather
than an application assumption:

| Constraint                                | Refuses                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `department_parent_is_in_same_tenant`     | a department whose parent belongs to another company                                  |
| `employment_department_is_in_same_tenant` | an employment record pointing at another company's department                         |
| `reporting_manager_is_employed_here`      | a reporting manager from another company, **or one with no employment record at all** |

The third is the one that matters most. A cross-tenant reporting manager would be a
tenant-isolation breach reachable through the org chart, and it is exactly the class of bug a
same-tenant assumption in application code lets through. All three were verified by attempting the
violation in raw SQL.

**Check constraints, and the failure each prevents**

| Constraint                            | Prevents                                                               |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `department_is_not_its_own_parent`    | an immediate cycle; the recursive query would not terminate            |
| `department_name_is_not_blank`        | an unnamed department in every picker                                  |
| `department_sort_order_is_in_range`   | a sort order that is really a typo                                     |
| `employment_is_not_self_managed`      | somebody reporting to themselves                                       |
| `employee_id_is_not_blank`            | a mandatory field satisfied by a space                                 |
| `designation_is_not_blank`            | the same                                                               |
| `employment_end_state_and_date_agree` | "Ended" with no date, or Active carrying one — two screens disagreeing |
| **`match_hash_is_a_hex_digest`**      | **an Aadhaar number stored in the hash column**                        |
| `last_four_is_four_digits`            | more of the identifier than four digits ever reaching the row          |
| `match_key_id_is_not_blank`           | a hash nobody can attribute to a key, so it cannot be rotated          |

`match_hash_is_a_hex_digest` requires 64 lower-case hex characters. The claim "UBoss never stores
an Aadhaar number" therefore does not rest on the application getting it right every time —
PostgreSQL rejects the row. Verified by inserting a twelve-digit number into the column.

**Two triggers**

1. `employment_reporting_has_no_cycle` — a bounded upward walk before insert or update of the
   reporting manager. A cycle would make the subtree query non-terminating, and **`TeamSubtree`
   authorization now runs that query on permission decisions**, so a cycle introduced by one bad
   update would be a denial of service on authorization. An invariant that load-bearing must not
   depend on which code path wrote the row. Verified by driving a three-person loop straight at
   the table as the owner role.
2. `role_assignment_departments_exist` — closes the gap the Prompt 7 schema comment described.
   `department_ids` is a `text[]` and PostgreSQL has no foreign key on array _elements_, so this
   is the mechanism the column shape allows. It validates the uuid format first and then
   existence, so a non-uuid value produces an explanation rather than a raw cast error — which it
   did on its first run, against a Prompt 8 test fixture using `'dept-1'`.

**The backfill** gives every existing company one `General` department, because Department is one
of the six mandatory Add Employee fields and a company with none cannot use the screen at all.

**Employment records are deliberately not backfilled.** An employee id, a designation and a
reporting manager are facts about a real person's job; inventing them would put fabricated
employment data in front of an administrator who would reasonably believe it. An empty hierarchy
that says "no employees recorded yet" is honest, and the screen says exactly that. The demo
companies get illustrative people from the seed instead, which is where illustrative data belongs.

**Rollback destroys:** every department, every employment record — so the whole reporting
structure and everyone's company Employee ID and designation — and **every person identifier**,
which means the match-or-create flow would create a second permanent UBoss identity for a person
UBoss had already recognised. It also drops each company's Vision and Mission, and re-opens the
`TeamSubtree` authorization gap.

**Every constraint and both triggers were verified in raw SQL before code depended on them** —
the Prompt 4/8/9/10/11 discipline, in a 16-case script. Both new tenant tables returned zero rows
with no scope declared and their real rows inside one; `person_identifiers` was confirmed to have
no RLS by design; and the recursive subtree query was checked to return 3 for the top of a
three-person chain and 2 from the middle.

---

### 2026-09-09 — Prompt 13 — `20260909180000_users_access_guests_bulk`

Four enums, three tables, one `tenant_memberships` column, nine check constraints, two triggers —
and **two corrections to earlier prompts** that this migration's own testing exposed.

**New enums** — `bulk_operation_kind`, `bulk_operation_state`, `bulk_row_state`,
`offboarding_state`.

`Validated` is a first-class state rather than an implementation detail: the client asks for
"preview/validation and per-row errors", which means validating **without applying** has to be
something the system can be in the middle of and report on.

**New tables**

| Table                 | Plane  | RLS        | Holds                                            |
| --------------------- | ------ | ---------- | ------------------------------------------------ |
| `bulk_operations`     | tenant | **forced** | one bulk run, its parameters and its row counts  |
| `bulk_operation_rows` | tenant | **forced** | every row, its outcome and **all** of its errors |
| `offboardings`        | tenant | **forced** | who left, who took over, and what could not move |

**New `tenant_memberships.guest_access_expires_at`** — when an External Guest's access ends.

**The guest constraints, and why both directions matter**

`guest_membership_has_an_expiry` requires an expiry for a guest **and forbids one for anybody
else**. Without the second half, an internal employee could be given a date that nothing enforces
and nothing displays — a field that looks like a control and is not. Without the first, a guest
account outlives the project it was created for, which is the failure the client's
"expiry-capable" requirement exists to prevent.

**Two triggers keep a guest outside the hierarchy**, and they fire from _both_ sides:
`employment_record_subject_is_not_a_guest` refuses an employment record for an existing guest, and
`guest_membership_has_no_employment` refuses converting an employed person to a guest. One
direction alone leaves the other reachable. A guest with an employment record would appear in the
org chart, count toward a department's headcount and be selectable as somebody's reporting
manager — none of which is true of a contractor.

**Check constraints, and the failure each prevents**

| Constraint                                  | Prevents                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `guest_membership_has_an_expiry`            | a guest with no end date, or an expiry on somebody who is not one       |
| `offboarding_successor_is_somebody_else`    | handing somebody's work to themselves                                   |
| `offboarding_reason_is_not_blank`           | removing access with no recorded reason                                 |
| `offboarding_terminal_state_is_timestamped` | "Completed" with no answer to "when did they lose access"               |
| `one_open_offboarding_per_person` (index)   | two offboardings racing to move the same work                           |
| `bulk_counts_are_not_negative`              | a summary screen showing an impossible number                           |
| `bulk_counts_fit_within_total`              | "402 of 400 applied", after which no number on the screen is believable |
| `bulk_terminal_state_is_timestamped`        | an applied operation with no application time                           |
| `bulk_row_number_is_one_based`              | an error pointing at row 0                                              |
| `invalid_bulk_row_has_errors`               | a row marked Invalid that nobody can fix                                |

**Correction 1 — the same-tenant composite foreign keys are now declared in the Prisma schema.**

Prompt 12 wrote three of them by hand, because `@relation` had not been used for them. **Prisma
cannot see a constraint it did not generate**, so it reported all three as drift and this
migration's first generated draft contained:

```sql
ALTER TABLE "departments" DROP CONSTRAINT "department_parent_is_in_same_tenant";
ALTER TABLE "employment_records" DROP CONSTRAINT "employment_department_is_in_same_tenant";
ALTER TABLE "employment_records" DROP CONSTRAINT "reporting_manager_is_employed_here";
DROP INDEX "departments_tenant_id_id_key";
```

Running that would have **silently removed a tenant-isolation guarantee** — a reporting manager
from another company would have become storable again. Caught by reading the generated SQL before
applying it, which is why that step is in this project's discipline.

The fix is not to delete the DROPs and move on: the drift would return with the next generated
migration. The relations are now declared in the schema (`@relation(fields: [tenantId, …],
references: [tenantId, …])`), Prisma owns the constraints, and
`migrate diff --from-migrations --to-schema` is **empty**. Both databases were rebuilt from the
chain to prove the migration produces what the schema describes.

**A latent bug the switch exposed.** The hand-written versions used `ON DELETE SET NULL`. A
composite key's `SET NULL` nulls **every** referencing column — including `tenant_id`, which is
`NOT NULL` — so a delete would have failed with a confusing error rather than detaching the row.
It never fired because nothing deletes these rows (a department is archived; an employment record
is ended). They are now `NO ACTION`, which is the honest action.

**Correction 2 — `array_length` on an empty array is NULL, and a CHECK treats NULL as satisfied.**

This migration's `invalid_bulk_row_has_errors` was written as `array_length("errors", 1) >= 1`
and **accepted a row marked Invalid with no errors**, because `array_length(ARRAY[]::text[], 1)`
is NULL and `NULL >= 1` is NULL. Verified by inserting one.

The Prompt 11 constraint `commercial_request_names_what_it_wants` has the identical bug for
`kind = 'ModuleEntitlement'` with an empty module list — also verified by inserting one, which
was **accepted**. Corrected here with `COALESCE(array_length(col, 1), 0)` rather than by editing
the Prompt 11 migration, so the chain records that the defect existed and when it was found.
`CommercialService.assertRequestNamesSomething` was always refusing it at the API, so no such row
could be created through the product; the database was simply not the second layer it claimed to
be.

**Rollback destroys:** every bulk operation and every row — so the record of what a large change
attempted, including the rows that failed — and **every offboarding record**, which is the only
place that answers "who took over this person's work". It also drops every guest's access expiry,
leaving guest memberships with no end date at all.

**Every constraint and both triggers were verified in raw SQL before code depended on them**, and
the two corrections were verified by inserting the row each constraint had been accepting. Both
databases were then rebuilt from the migration chain and the drift check re-run.

---

### 2026-09-09 — Prompt 14 — `20260909200000_company_settings_shell`

Two tables, five check constraints, and one `REVOKE`.

**New tables**

| Table                     | Plane  | RLS        | Holds                                        |
| ------------------------- | ------ | ---------- | -------------------------------------------- |
| `company_settings`        | tenant | **forced** | one company's value for one setting          |
| `company_setting_changes` | tenant | **forced** | the version history for a _material_ setting |

**Why the value is JSON and the type is not.** The column holds a JSON scalar so one table serves
booleans, integers, strings and enums. The **type** lives in the catalogue in code
(`SETTING_DEFINITIONS`), and `validateSetting` is the only way a value gets in — so an integer
setting cannot come to hold a string even though the column would permit it, and a key that is
not in the catalogue is refused outright.

**Why the history is a separate table rather than more audit events.** The audit trail records
_that_ a setting changed. This answers a different question — **what was the value before** —
which a chained append-only log can only answer by replaying every event for that key.

**Check constraints, and the failure each prevents**

| Constraint                                         | Prevents                                                      |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `company_setting_key_is_dotted_lower_snake`        | a hand-run INSERT creating a row no screen will ever read     |
| `company_setting_change_key_is_dotted_lower_snake` | the same, in the history                                      |
| `company_setting_change_reason_is_not_blank`       | a governance change nobody can account for at a review        |
| `company_setting_value_is_a_scalar`                | a nested value no validator checked and no control can render |

The key constraint is the _shape_ check underneath the catalogue: the catalogue in code is the
real gate — an unknown key never reaches the database — and this stops a direct INSERT creating a
setting that exists and does nothing.

**`REVOKE UPDATE, DELETE ON company_setting_changes FROM uboss_app`.** Weaker than the Prompt 8
audit trails and deliberately so: there is no hash chain here, so the claim is "**the application
cannot rewrite it**", not "tampering is detectable". Saying which claim is which is the point of
writing it down — and a test proves the revoke by attempting an `UPDATE` as the application role.

**No backfill, and none needed.** The catalogue's defaults mean a company with **no rows at all**
is fully configured, and a setting added in a later release works on the day it ships. A
migration inserting a row per company per setting would have been 19 categories of write-once
data that the code default already provides.

**Rollback destroys:** every company's configuration — so every company silently reverts to the
code defaults, which is _safe_ but not _the same_ — and the version history for every governance
setting, which is the only record of what a value used to be and why it changed.

**Every constraint was verified in raw SQL before code depended on it**, including the two the
tests exercise directly: a nested JSON value and a non-catalogue key are both refused by the
database, not only by the validator.

### 2026-09-09 — Prompt 12B — `20260909210000_performance_score_badges`

Three tables, two enums, **0 `DROP` statements**. The migration chain still diffs empty against the
datamodel.

| Table                  | Purpose                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `performance_policies` | Versioned per company: points per outcome, five thresholds, whether a blocker forgives fully |
| `performance_events`   | The append-only ledger the score is derived from                                             |
| `badge_history`        | Every level a person has held in a company, with the score that earned it                    |

**Row-Level Security forced on all three**, with `USING` + `WITH CHECK` and the standard
fail-closed predicate.

| Guarantee                                               | How                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One active policy version per company                   | `one_active_performance_policy_per_tenant`, a partial unique index on `WHERE superseded_at IS NULL`. Two active versions would make "which rules scored this" ambiguous and the engine would pick one arbitrarily                                                                                                                               |
| Thresholds ascend                                       | `badge_thresholds_ascend`. Out of order a score could satisfy Diamond and not Gold, and the ladder would stop being a ladder                                                                                                                                                                                                                    |
| A missed deadline can never help                        | `performance_points_have_the_right_sign` — the policy configures the magnitude, the event kind fixes the sign                                                                                                                                                                                                                                   |
| A discretionary event says why                          | `discretionary_performance_event_has_a_reason` — a `ManualAdjustment` or `BlockerNeutralised` with no reason is refused at the database                                                                                                                                                                                                         |
| A neutralisation names its target, and nothing else may | `neutralisation_names_its_event`, both directions                                                                                                                                                                                                                                                                                               |
| Every event points at real work                         | `performance_event_source_is_named`                                                                                                                                                                                                                                                                                                             |
| One current level per person                            | `one_current_badge_per_person`, partial unique on `WHERE ended_at IS NULL`                                                                                                                                                                                                                                                                      |
| A badge period cannot end before it began               | `badge_period_is_ordered`                                                                                                                                                                                                                                                                                                                       |
| **The ledger cannot be rewritten by the application**   | `REVOKE UPDATE, DELETE ON performance_events FROM uboss_app`. As with the Prompt 14 settings history there is no hash chain, so the claim is exactly "the application cannot rewrite it" — not "tampering is detectable". A correction is a new `ManualAdjustment` with a reason, which is also the honest shape: the original outcome happened |

**Idempotency is the schema, not a convention.**
`UNIQUE (tenant_id, subject_user_id, source_kind, source_id, kind)` — verified by inserting a
duplicate directly and watching PostgreSQL refuse it, because the service's read-then-write is not
atomic against a concurrent caller. The key includes `kind` so a task that was late **and** then
rejected records both facts.

**Backfill:** a baseline version-1 policy per existing company, so performance accrues from the day
the feature ships rather than from the first time somebody opens the screen. `activePolicy` also
creates one on demand for a company provisioned later.

**`ended_at`/`started_at` come from one clock.** `started_at` defaulted to `now()` — the
_transaction start_ in the database's clock — while `ended_at` was a `Date` from the API process.
PostgreSQL runs in a container, so a few milliseconds of skew is normal, and when the database was
ahead, closing a period milliseconds after opening it produced `ended_at < started_at` and
`badge_period_is_ordered` refused the write. Every badge row now sets `started_at` explicitly and a
transition uses one `Date` for both ends, which also makes the history contiguous. Found by this
prompt's own exit-snapshot test.

---

### 2026-09-09 — Prompt 15 — `20260909220000_notifications_escalation_center`

Two tables, three enums, **0 `DROP` statements**. Chain still diffs empty.

| Table                      | Purpose                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `notifications`            | One row per recipient per event: severity, read, acknowledgement, deep link, dedupe key, escalation |
| `notification_preferences` | One person's choice per kind: in-app, email, digest                                                 |

**Row-Level Security forced on both**, with the standard fail-closed predicate.

**One row per recipient, not a shared event with a join table.** Read state, acknowledgement and
escalation are all per person — six approvers waiting on the same objective have six answers to
"have you seen this" — so a shared row would need a side table carrying every one of those
columns, which _is_ this table plus a join.

| Guarantee                                                 | How                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A security alert cannot be muted**                      | `security_notifications_cannot_be_muted` — a `SecurityEvent` preference must have both channels on and no digest. The client's rule, in the database, because "the alert nobody could turn off" must not depend on a service remembering                                      |
| **A critical alert is mandatory and needs acknowledging** | `mandatory_notification_is_marked_mandatory`. Stored on the row rather than derived, so a later change to the mandatory set cannot retroactively make a delivered mandatory alert look optional                                                                               |
| A security notification is mandatory at any severity      | `security_notification_is_mandatory`                                                                                                                                                                                                                                          |
| Duplicate suppression                                     | `UNIQUE (tenant_id, recipient_user_id, dedupe_key)`. Verified by inserting a duplicate directly — the service's read-then-write is not atomic against a concurrent caller                                                                                                     |
| **Every notification has a route to its resource**        | `notification_deep_link_is_a_relative_path` — must start `/`. "Something needs you" with no route is worse than silence, and an absolute link would let a notification point off-site                                                                                         |
| Acknowledging implies having read                         | `acknowledged_notification_has_been_read` and `acknowledgement_follows_reading`. Otherwise the unread count and the acknowledgement queue disagree on the same screen                                                                                                         |
| Only something with a deadline can have escalated         | `only_escalating_notifications_escalate`                                                                                                                                                                                                                                      |
| It says something                                         | `notification_says_something`, `notification_dedupe_key_is_not_blank`                                                                                                                                                                                                         |
| **An escalation chain cannot cross companies**            | `notifications_tenant_id_id_key` + a composite FK on `(tenant_id, escalated_from_id)`, **declared in the Prisma schema** (ADR-064). A single-column key would have permitted it, and the chain is followed when showing "escalated from", so a breach would surface in the UI |
| **A delivered alert cannot be deleted**                   | `REVOKE DELETE ON notifications FROM uboss_app`. `UPDATE` is needed — read, acknowledge and escalate all write — so the claim is precisely "the application cannot delete a notification", not "the record is tamper-evident"                                                 |

**The dedupe key's shape is a design decision, not an implementation detail.** An approval is
keyed `approval:<id>` — no time component, so one notification per approval per person however
often a queue re-runs. Overdue work is keyed `overdue:<id>:<yyyy-mm-dd>` — per day, because a
second day of silence is new information. Getting these backwards is the whole failure mode of a
notification system: silent when it matters, or a flood that trains people to ignore it. The
builders live in `@uboss/types` so the shapes are one definition, and a unit test asserts the
difference.

**No new outbox table.** `OUTBOX_TOPICS` gained two topics in code; `outbox_messages.topic` is a
VARCHAR. This migration's comment records that the notification email adapter is the **first
consumer of the Prompt 10 outbox**, closing that repository's documented "no dispatcher exists
yet" limitation.

**Every constraint was verified in raw SQL before code depended on it** — sixteen checks,
including a critical notification without `is_mandatory`, an absolute deep link, an
acknowledged-but-unread row, a muted _and_ a digested security preference, a cross-tenant
escalation, and `DELETE` as the application role.

### 2026-09-09 — Prompt 16 — `20260909230000_connections_secrets_tool_permission`

Four tables, three enums, **0 `DROP` statements**. Chain still diffs empty.

| Table                    | Purpose                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `connections`            | One integration: owner, connector, environment, the state **inputs**, and a `secret_ref` |
| `connection_secrets`     | **The only table that holds a credential**, and only sealed                              |
| `connection_tool_grants` | Agent Tool Permission: what one Engine Agent may do through one connection               |
| `connection_checks`      | Append-only _Test Connection_ history                                                    |

**Row-Level Security forced on all four.**

**There is deliberately no `state` column.** The five client states are derived at read time
(`derivedConnectionState`). A stored copy would be a second answer to a question that already has
one, and the gap between a credential expiring and a sweep noticing is a gap in which every Engine
Agent run would be authorised against a stale answer. Same rule as break-glass and platform-role
expiry (ADR-047).

| Guarantee                                 | How                                                                                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A secret is a reference, structurally** | The value lives in its own table, so reading a connection cannot read a credential. `connection_secret_ref_is_not_a_secret` also refuses a handle that starts `v1.` — whatever else it is, it is not ciphertext |
| **A stored secret is sealed**             | `connection_secret_is_sealed` requires the `v1.` envelope prefix and a key id. Plaintext is refused at the database                                                                                             |
| **A high-risk grant says why**            | `high_risk_tool_grant_has_a_reason`, covering the client's four plus `Delete`                                                                                                                                   |
| A revocation is attributed                | `tool_grant_revocation_is_attributed` — an actor **and** a reason, or it is not a revocation anybody can account for                                                                                            |
| One live grant per agent per category     | `one_live_tool_grant_per_agent_category`, partial unique on `WHERE revoked_at IS NULL` — so a revoked grant does not block re-granting                                                                          |
| A disabled connection says why            | `disabled_connection_has_a_reason`. "Disabled" with no reason is the state nobody can safely undo                                                                                                               |
| A failed check says what failed           | `failed_check_says_what_happened`                                                                                                                                                                               |
| Check times are ordered                   | `connection_check_times_are_ordered`, `connection_check_duration_is_not_negative`                                                                                                                               |
| **A grant cannot cross companies**        | Composite FK `(tenant_id, connection_id)` → `connections(tenant_id, id)`, **declared in the Prisma schema** (ADR-064). Same for `connection_checks`                                                             |
| **The check history cannot be rewritten** | `REVOKE UPDATE, DELETE ON connection_checks` — "it has been failing since Tuesday" is the only question it exists to answer                                                                                     |
| **A grant cannot be deleted**             | `REVOKE DELETE ON connection_tool_grants`. `UPDATE` is needed for revocation; "who could do this in March" must stay answerable                                                                                 |

**No foreign key on `connection_tool_grants.agent_id`.** Engine Agents arrive at a later prompt.
The column is a uuid and gains its key then; inventing the Engine Agent model two prompts early to
satisfy a constraint would be worse than an unconstrained uuid on a table that only an
administrator writes.

**Every constraint was verified in raw SQL before code depended on it** — sixteen checks,
including a ciphertext handle, an unsealed value, an unexplained high-risk grant, a second live
grant, an unattributed revocation, a cross-tenant grant, and `UPDATE`/`DELETE` on the histories as
the application role.

**Test-harness note.** The reset now names every table added since Prompt 12 in its `TRUNCATE`
rather than leaving them to `CASCADE`. Two department tests failed intermittently at this prompt
with a two-second duration, which is what a growing cascade dependency graph looks like: the
truncate has to discover more tables and takes a wider lock each prompt. Naming them keeps the
lock set deterministic. Two consecutive full runs then passed clean.

### 2026-09-10 — Prompt 17 — `20260910000000_skill_catalog_governance`

Three tables, four enums, one trigger, **0 `DROP` statements**. Chain still diffs empty.

| Table               | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `skills`            | A Skill's **identity**: layer, handle, owner, the version currently published   |
| `skill_versions`    | One version, with every content field the client lists and its lifecycle status |
| `skill_transitions` | Append-only governance trail: every lifecycle move, with who and why            |

**Identity and content are separate tables** because "Published V1 is immutable; an edit creates a
V2 Draft" only means something if there is something for both versions to be versions _of_. Work
references a **version**; a person talks about the **Skill**.

#### The first asymmetric Row-Level Security policy in UBoss

`tenant_id` is **nullable**: null means platform-owned — a Verified Skill or an Industry Pack. So
the policy's two halves say different things, and the asymmetry _is_ the security property:

| Half         | Rule                                                      | Why                                                                                                                                       |
| ------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `USING`      | a company may **read** its own rows **and** platform rows | That is what "available to every company" means. Without it the catalogue is empty for everyone                                           |
| `WITH CHECK` | a company may **write** only its own rows                 | A symmetric policy would let any company publish a "UBoss Verified" Skill, which every other company would then read as verified by UBoss |

Verified directly: as `uboss_app` with a tenant set, `SELECT` returns the company's Skill **and**
the platform one (2 rows); `INSERT` of a `tenant_id IS NULL` row is refused by the policy.

| Guarantee                                         | How                                                                                                                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A layer cannot lie about its owner**            | `skill_layer_matches_its_owner` — a platform layer has no tenant, `CompanyCustom` must have one                                                                                                                 |
| Only a pack names an industry                     | `only_an_industry_pack_names_an_industry`, both directions                                                                                                                                                      |
| A handle is a handle                              | `skill_key_is_lower_kebab`, so it can appear in a URL and be typed                                                                                                                                              |
| One handle per owner                              | `one_skill_key_per_company` and `one_platform_skill_key`, both partial — so a company may have its own `tender-screen` **alongside** the Verified one, which is the point of cloning                            |
| Every client field is present                     | `skill_version_states_the_required_fields` — a Skill with an empty `whenNotToUse` is the one used for the wrong work                                                                                            |
| **A high-risk Skill is never fully autonomous**   | `high_risk_skill_is_not_fully_autonomous`, using `&&` against the client's five high-risk categories. That combination is an irreversible action in somebody else's system with no person involved at any point |
| Review, approval and publication are attributed   | three constraints; a timestamp with no actor is not an approval anybody can account for                                                                                                                         |
| Publication follows approval                      | `skill_publication_follows_approval`                                                                                                                                                                            |
| Retiring says why                                 | `retired_skill_version_has_a_reason`                                                                                                                                                                            |
| A clone names its source; nothing else claims one | `cloned_version_names_its_source`, both directions                                                                                                                                                              |
| **One published version per Skill**               | `one_published_version_per_skill`, partial unique                                                                                                                                                               |
| **One open draft per Skill**                      | `one_open_draft_per_skill` over Draft/Test/Review — so "the draft" means something                                                                                                                              |
| A transition moves and explains                   | `transition_actually_moves`, `rejecting_transition_has_a_reason`                                                                                                                                                |
| **The trail cannot be rewritten**                 | `REVOKE UPDATE, DELETE ON skill_transitions`                                                                                                                                                                    |

#### The immutability trigger

`skill_version_content_is_frozen_once_approved` refuses any UPDATE that changes a content column
on a version whose status is `Approved`, `Published`, `Deprecated` or `Archived`.

**A trigger and not a revoked grant**, because the _status_ must still move — `Published →
Deprecated → Archived` — while the content cannot. A blanket `REVOKE UPDATE` would have made
deprecation impossible. The function lists exactly the columns that may not change, so adding a
content field without thinking about immutability makes it fail rather than silently permit it.

Verified directly: changing `purpose` or `allowed_tool_categories` on an approved version is
refused with the message _"An authorised edit creates a new draft version; it never rewrites one
that has been approved"_; moving `Approved → Published` and then `Published → Deprecated` both
succeed.

**Freezing at `Approved` is stricter than the client asked.** The rule names publication; an
approval is a decision about specific content, so content that could change afterwards would let
somebody get "delete records" approved by having "read records" reviewed.

#### A real ordering bug the constraint caught

`one_published_version_per_skill` permits exactly one. The publish path set the new version to
`Published` **before** deprecating the outgoing one — with a comment claiming the opposite order —
and the index refused it. Both planes now deprecate first. The constraint is what makes "which
version does work reference" unambiguous, and it is why the bug could not ship.

**Twenty-seven checks verified in raw SQL** before code depended on any of them.

### 2026-09-10 — Prompt 18 — `20260910010000_skill_router_evaluation`

Four tables, three enums, **0 `DROP` statements**. Chain still diffs empty.

| Table                          | Purpose                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `skill_evaluation_cases`       | A saved case: inputs, an expectation, and how to judge           |
| `skill_evaluation_runs`        | One recorded result of one case against one version. Append-only |
| `skill_regression_comparisons` | Current version against candidate, case by case                  |
| `skill_candidates`             | A capability the router could not find, recorded for governance  |

The three evaluation tables follow Prompt 17's **asymmetric** RLS policy — a company may read a
platform Skill's cases and runs (the evidence behind a Verified Skill is part of what makes it
trustworthy) and may never write one. `skill_candidates` takes the ordinary symmetric policy:
there is no such thing as a platform-plane Candidate, because a missing capability is missing _for
somebody_.

**A case belongs to the Skill, not a version.** That is what makes a regression comparison
possible at all: the same case runs against the live version and the candidate. A case per version
could never compare two.

| Guarantee                                                        | How                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A case is a case                                                 | `evaluation_case_is_stated` — name, description and expectation all non-blank                                                                                                                                                                                     |
| Retiring a case says why                                         | `retired_case_has_a_reason`                                                                                                                                                                                                                                       |
| **A run cannot fabricate a verdict**                             | `evaluation_run_records_its_output` — a verdict requires output; no output is permitted only when the run is **unjudged**                                                                                                                                         |
| A run says where its output came from                            | `evaluation_run_says_where_output_came_from`                                                                                                                                                                                                                      |
| **The evaluation record is append-only**                         | `REVOKE UPDATE, DELETE ON skill_evaluation_runs`. A verdict editable afterwards is not evidence — and a comparison is exactly what somebody publishes on. A wrong result is corrected by recording another run, which is also honest: the first result did happen |
| A comparison compares two things                                 | `comparison_compares_two_versions`                                                                                                                                                                                                                                |
| **A verdict matches its evidence**                               | `verdict_matches_its_evidence` — `Regressed`/`Mixed` must list a regression, `Improved` must list an improvement and no regression, `NoChange` must list neither. A row whose verdict disagrees with its arrays is a verdict that came from somewhere else        |
| **A conclusion cannot come from nothing**                        | `inconclusive_means_nothing_was_compared`, both directions                                                                                                                                                                                                        |
| Publishing over a regression is signed                           | `regression_acceptance_is_attributed` — actor **and** reason                                                                                                                                                                                                      |
| A comparison cannot be deleted                                   | `REVOKE DELETE ON skill_regression_comparisons`                                                                                                                                                                                                                   |
| A Candidate says what was wanted                                 | `candidate_states_what_was_wanted`                                                                                                                                                                                                                                |
| A decision is attributed and explained                           | `candidate_decision_is_attributed`                                                                                                                                                                                                                                |
| **Acceptance produced a draft, and only acceptance creates one** | `accepted_candidate_produced_a_draft` and `only_acceptance_creates_a_skill`, both directions                                                                                                                                                                      |

**The client's strongest rule is enforced by an absence.** "Never silently publish a missing
capability" — the `skill_candidate_status_kind` enum has **no `Published` member at all**, so
there is no value to set. Verified directly: `UPDATE skill_candidates SET status = 'Published'`
fails as an invalid enum input.

**No routing-decision table.** The router is a pure function over declared Skill fields, so a
decision is reproducible from its inputs; persisting every one would be a high-volume log of
something derivable. What _is_ recorded is the exception — a Candidate, carrying the context and
every rejection — because that is the case somebody has to act on.

**Twenty-two checks verified in raw SQL** before code depended on any of them.

## Resetting the local database

`npm run db:reset` (in `apps/api`) does a genuine from-scratch rebuild: it drops the `public`
schema, re-applies **every** migration, and re-runs the seed. Because the schema goes with it, the
migration history, the RLS policies and the `uboss_app` grants are all rebuilt by the migrations —
which is what makes this a real test of the migration chain rather than a truncate.

It is a project-owned script (`apps/api/scripts/reset-database.mjs`, ADR-024) rather than
`prisma migrate reset`, which refuses to run unattended. The safety guards are deliberately
narrower than Prisma's:

- `NODE_ENV=production` → refused;
- a non-loopback host → refused unless `UBOSS_RESET_ALLOW_REMOTE_HOST=yes`;
- a database name not containing `dev` or `test` → refused, so plain `uboss` and the other UBoss
  stacks on ports 5432/5433 can never be targeted;
- it prints the row counts it is about to destroy first.

Use `npm run db:reset:dry-run` to see what would be destroyed without changing anything.

### 2026-09-10 — Prompt 19 — `20260910020000_objective_builder_form2`

Four tables, five enums. `objectives` is identity, `objective_versions` holds the Form 2 content,
`objective_workflow_steps` is the grid, `objective_rewards` is the optional panel.

**Identity and content are separate tables** for the same reason as `Skill`/`SkillVersion`, and
here the client stated the rule outright: a live version is immutable and an authorized edit after
Live creates a new **Draft** version. That is only expressible if there is something for V1 and V2
to be versions of.

**`tenant_id` is NOT NULL and the RLS is symmetric**, unlike the Skill policies. There is no
platform-owned objective — an objective is one company's business intent — so neither half of the
policy has any reason to admit a null-tenant row. `ENABLE` + `FORCE` on all four tables.

**Composite foreign keys (ADR-064), declared in the schema:** version → objective, step → version,
reward → objective, and objective.`department_id` → department, all on `(tenant_id, …)`.
`objectives.active_version_id` also carries one, `ON DELETE NO ACTION` — a composite `SET NULL`
would null `tenant_id` too, and refusing to delete the version an objective is currently running
is the honest answer. `Skill.published_version_id` has no such key; that turned out to be a gap
worth closing rather than a precedent worth copying.

**Constraints, all verified in raw SQL before any code depended on them (45 checks):**

| Constraint                                                                    | What it refuses                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `objective_name_is_not_blank`, `expected_final_result_is_not_blank`           | A required field holding only spaces — worse than absent, because it looks answered. |
| `objective_version_number_is_positive`                                        | Version 0.                                                                           |
| `objective_workload_is_not_negative`, `objective_target_time_is_not_negative` | A negative quantity, which is wrong rather than unset.                               |
| `objective_target_time_has_a_unit`                                            | A duration with no Time Unit. "10" is not a target.                                  |
| `workflow_step_position_is_positive`                                          | Step 0.                                                                              |
| `workflow_step_states_its_work`                                               | A step with no Exact Work.                                                           |
| `one_active_version_per_objective` (partial unique)                           | Two live versions — the state that makes "which plan is running" unanswerable.       |
| `live_objective_version_records_when`                                         | `Active`/`Completed` with no `published_at`.                                         |
| `objective_submission_is_attributed`                                          | A recorded submission with no author.                                                |
| `objective_under_review_was_submitted`                                        | `UnderReview` with no `submitted_at`.                                                |
| `reward_amount_is_not_negative`                                               | A negative amount, applicable or not.                                                |
| `applicable_reward_is_complete`                                               | An applicable reward with no type, condition or approver.                            |
| `quantified_reward_has_an_amount`                                             | An applicable Cash or Points reward with no amount. Recognition needs none.          |

**There is deliberately no ceiling on grid rows.** The approved UI states the row count is not
fixed. Forty rows was verified as accepted; the only guard is the request-size `ArrayMaxSize(500)`
in the DTO, which is not a business cap.

**Two triggers, because a constraint cannot say "these columns are frozen but that one is not":**

- `objective_version_content_is_frozen_once_live` — from `Active` onwards, refuses any change to
  the Form 2 columns while still permitting the status to move (`Active → Completed → Archived`)
  and leaving `updated_at`, `row_version`, `published_at` and the submission columns alone.
- `objective_grid_is_frozen_once_live` — refuses `INSERT`, `UPDATE` **and** `DELETE` on the steps
  of a live version. Freezing the objective-level columns while leaving the grid writable would be
  a hole, not a subtlety: the grid _is_ Form 2.

**A genuine cascade still works, and that is not luck.** `DELETE FROM objectives` removes the
version row first and cascades to its steps as a separate command, so by the time the grid trigger
runs the version is no longer visible to its snapshot and the delete proceeds. Verified: deleting a
live objective left zero steps. A direct edit of a live grid is refused; tearing down a company is
not. Both trigger functions are `SECURITY INVOKER`, so their lookups run under the caller's RLS
context and cannot become a cross-tenant read.

**The reward table has no `approved`, `settled`, `paid`, `payout` or `disburse` column, and no
Form 2 column.** Both asserted by `information_schema` queries in the migration verification and
again in the e2e suite. The client's rule — nothing auto-pays on completion, and the panel is
never inside the canonical Form 2 field list — is enforced by those columns not existing.

`migrate diff --from-migrations` empty; generated SQL contained zero `DROP` statements.

**Test harness:** the four tables are named explicitly in `resetTestDatabase`, children first.
Every table needs its own entry — the cascade would find these, but naming them keeps the
truncate's lock set deterministic.

### 2026-09-10 — Prompt 19A — `20260910030000_reward_rule_and_award_lifecycle`

One table, one enum, one policy column, and one composite unique index added to a Prompt 19 table.

**There is no `reward_rules` table, deliberately.** `objective_rewards` — the Performance & Reward
panel from Prompt 19 — _is_ the rule: one per objective, carrying the client's seven fields. A
second table would have disagreed with it immediately. `reward_awards` is one person's claim under
that rule, and it carries the lifecycle because the lifecycle belongs to an instance: two people
can be assigned under one rule and one of them rejected.

**`objective_rewards` gained `@@unique([tenantId, id])`** so an award can hold a composite foreign
key back to its rule within the tenant (ADR-064).

**`performance_policies.reward_points_reach_performance`**, `BOOLEAN NOT NULL DEFAULT false`. The
client's "link approved points/achievement to performance only through policy", as a gate. `false`
by default and deliberately so: a company that has not decided this has not agreed that a bonus can
move somebody's score.

**The promise is snapshotted.** `reward_type`, `amount_minor_units`, `eligibility_condition`,
`completion_deadline` and `approver_user_id` are copied from the rule at assignment and frozen by a
trigger. Reading them through the rule instead would let somebody raise the amount after the work
was done and the trail would show the new terms as though they had always been the terms — the same
reasoning as S-114.

**Constraints, all verified in raw SQL first (32 checks):**

| Constraint                                            | What it refuses                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `award_condition_is_not_blank`                        | A promise with no stated condition.                                                                                                       |
| `quantified_award_has_an_amount`                      | A Cash or Points award with no amount.                                                                                                    |
| `award_amount_is_not_negative`                        | A negative amount.                                                                                                                        |
| `award_*_is_attributed` (×5)                          | A timestamp with no actor **or** an actor with no timestamp, for each of the five steps.                                                  |
| `assigned_award_records_when`                         | A status past Draft with no assignment recorded. **Corrected by the next migration** — see below.                                         |
| `decided_award_records_its_decision`                  | `Approved`/`Rejected`/`Settled`/`Recorded` with no decision recorded.                                                                     |
| `rejected_award_has_a_reason`                         | An unexplained refusal of somebody's bonus.                                                                                               |
| `only_cash_is_settled`                                | A Points or Recognition award reaching `Settled`.                                                                                         |
| `settled_award_has_a_provider_reference`              | "We paid it" with nothing to check against.                                                                                               |
| `settlement_needs_a_second_person`                    | **The approver paying out their own approval.** Four eyes on the money.                                                                   |
| `unsettled_award_claims_no_payout`                    | A non-settled award carrying a reference or `payout_was_real`.                                                                            |
| `only_recorded_points_touch_performance`              | A performance event on anything but a Recorded **Points** award — being paid is not a performance outcome.                                |
| `unscored_points_award_explains_itself`               | A Recorded Points award with neither an event nor a note, so a policy refusal is never indistinguishable from a bug.                      |
| `one_open_award_per_person_per_rule` (partial unique) | Two live claims for one person under one rule. Terminal awards do not block a later one — a rejected claim can legitimately be re-raised. |

**One trigger, `reward_award_terms_and_endings_are_immutable`**, doing two related jobs: a terminal
award (`Rejected`, `Settled`, `Recorded`) cannot change at all, and the snapshotted terms cannot
change from assignment onwards. An un-settled award could be paid twice; an un-rejected one would
let a refused claim quietly reappear.

`migrate diff --from-migrations` empty; zero `DROP` statements in the generated SQL.

**`migrate dev --create-only` could not be used** — it wanted interactive confirmation for the new
unique index — so the SQL came from `migrate diff --from-migrations … --to-schema … --script`,
which is fully non-interactive, and the hand-written half was appended as usual.

### 2026-09-10 — Prompt 19A — `20260910030500_reward_award_rejection_before_assignment`

A correction, in its own migration because the previous one had already been applied and an applied
migration is append-only.

`assigned_award_records_when` was written as `status = 'Draft' OR assigned_at IS NOT NULL`, which
**contradicts the lifecycle it was meant to protect.** `ALLOWED_AWARD_TRANSITIONS` permits
`Draft → Rejected`: a claim can be refused before anybody is assigned under it. The constraint
demanded an `assigned_at` for a `Rejected` row, so the only way to record that refusal would have
been to first record an assignment that never happened. **A constraint that forces a false record
is worse than no constraint.** Corrected to
`status IN ('Draft', 'Rejected') OR assigned_at IS NOT NULL`.

Found by the raw-SQL verification pass before any service code depended on it — the twelfth time
that discipline has caught something, and the first time it caught a constraint that was wrong
rather than missing.

**Test harness:** `reward_awards` is named explicitly in `resetTestDatabase`, before
`objective_rewards`.

### 2026-09-10 — Prompt 20 — `20260910040000_objective_review_and_strict_versioning`

One enum and nine columns on `objective_versions`, plus eight constraints and a replaced trigger.

**`objective_version_origin_kind`** — `Initial` / `Edit` / `Rollback`. A **minor** edit is still an
`Edit`: the client's rule gives it no exemption, and a "this barely changed so reuse the version"
shortcut is how a live plan gets rewritten under the people executing it.

**`copied_from_version_id`**, with a composite FK to `objective_versions(tenant_id, id)` and
`ON DELETE NO ACTION`. Provenance for both an ordinary edit and a rollback — inferring it from
version numbers would be wrong the moment a rollback makes V4 a copy of V1 rather than of V3.

**`approved_at` / `approved_by_user_id`.** Approval is recorded as a **fact on the version**, not a
ninth status: the client's chain names `Approved → Published` as two acts, and the status enum is
the client's own eight-state list with no `Approved` member. See ADR-104.

**`sent_back_*` and `execution_team_confirmed_*`** — the reviewer's two other acts.

**Constraints, all verified in raw SQL first (24 checks):**

| Constraint                                  | What it refuses                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `objective_approval_is_attributed`          | An approval timestamp with no approver, or an approver with no timestamp.                                 |
| `objective_send_back_is_attributed`         | The same, for a send-back.                                                                                |
| `objective_team_confirmation_is_attributed` | The same, for a team confirmation.                                                                        |
| `objective_send_back_has_a_reason`          | A send-back the author cannot act on.                                                                     |
| `live_objective_version_was_approved`       | **`Active` or `Completed` with no approval.** Nothing goes live without one, even through a direct write. |
| `objective_publication_follows_approval`    | A publication timestamp earlier than its own approval.                                                    |
| `first_version_has_no_parent`               | V1 with a parent, V2+ with `origin: Initial`, or V2+ with no parent.                                      |
| `version_is_not_its_own_parent`             | A self-referencing provenance loop.                                                                       |

**The freeze trigger was replaced, not supplemented.** `origin`, `copied_from_version_id`,
`approved_at` and `approved_by_user_id` join the frozen set — rewriting who approved a live plan is
exactly what an audit exists to detect, and the client requires historical records to keep exact
version ids. Replacing the function rather than adding a second trigger keeps one list of content
columns instead of two that drift.

`migrate diff --from-migrations` empty; zero `DROP` statements.

**Fixture consequence:** Prompt 19's `publish` test helper wrote `status: 'Active'` with no
approval, which `live_objective_version_was_approved` now correctly refuses. The helper records a
real approval, with `published_at` a millisecond later so
`objective_publication_follows_approval` holds. Two other Prompt 19 fixtures gained
`origin`/`copied_from_version_id`. In each case the fixture was wrong once the product got
stricter — the constraints were not weakened.

### 2026-09-10 — Prompt 21 — `20260910050000_objective_ai_analysis`

One table, two enums, thirteen constraints, one partial unique index and one freeze trigger.

**`objective_analysis_runs`** is a **durable** record, not an in-flight promise. The approved UI
says it outright — _"Analysis runs as a durable job. You can leave this screen and return —
progress is preserved."_ A promise held in one process cannot honour that and cannot be cancelled
from a second tab either, so the run, its stage and its counters are rows written at each stage
boundary.

**No approval or publish column exists**, deliberately. Approval belongs to the objective
_version_, and the client's rule is that analysis output is always a draft. Asserted from
`information_schema` in the e2e suite rather than left as a comment.

**`produced_by_real_model`** records what the Model Gateway reported. False for every adapter that
ships. Stored rather than inferred so no screen, report or audit entry can present mock output as
a model's judgement — the same reasoning as `reward_awards.payout_was_real`.

**`model_capability`** is an opaque label, **never a provider or model name**: the client's locked
rule is that provider names stay behind the gateway.

**Constraints, all verified in raw SQL first (24 checks):**

| Constraint                                                   | What it refuses                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `analysis_stage_count_is_within_range`                       | More than the client's seven stages.                                                                                       |
| `completed_analysis_has_a_draft`                             | `Completed` with no draft — the state that makes a screen render nothing and look broken.                                  |
| `completed_analysis_finished_every_stage`                    | "Completed at stage five", which is not a completion.                                                                      |
| `failed_analysis_says_why`                                   | A failure nobody can act on.                                                                                               |
| `analysis_cancellation_is_attributed`                        | A cancellation timestamp with no actor, or an actor with no timestamp.                                                     |
| `cancelled_analysis_records_when`                            | `Cancelled` with no timestamp, or a timestamp without the status.                                                          |
| `running_analysis_records_when_it_started`                   | A started run that does not say when.                                                                                      |
| `analysis_completion_follows_start`                          | Completion before start.                                                                                                   |
| `analysis_schema_version_is_positive`                        | Version zero.                                                                                                              |
| `stored_draft_declares_its_schema`                           | A stored draft with no `schemaVersion` inside it.                                                                          |
| `draft_schema_version_matches_column`                        | The column and the document disagreeing — two sources of one fact is how a reader picks the wrong one.                     |
| `real_model_output_names_its_capability`                     | A row claiming a real model while naming no capability.                                                                    |
| `analysis_token_counts_are_not_negative`                     | Negative usage.                                                                                                            |
| `one_active_analysis_per_objective_version` (partial unique) | Two live runs racing to write one draft. A _finished_ run does not block a new one — re-analysing after an edit is normal. |

**`analysis_run_is_frozen_once_finished`** refuses **any** change to a `Completed`, `Cancelled` or
`Failed` run. Its draft, its token counts and its `produced_by_real_model` flag are what a later
cost review or dispute reads, and that flag in particular is the one somebody would be tempted to
flip. Re-analysing produces a new run; nothing rewrites an old one.

`migrate diff --from-migrations` empty; zero `DROP` statements.

**Test harness:** `objective_analysis_runs` is named explicitly in `resetTestDatabase`, before
`reward_awards`.

## Prompt 22 — `objective_workflow_drafts`

`20260910060000_manager_editable_workflow_draft` adds one table: the workflow the manager edits,
kept **separate** from `objective_analysis_runs` by the client's approved design decision. The run
stays frozen as the record of what the AI proposed; this row is what the company decided to do.
The link is `seeded_from_run_id`, a composite FK with `ON DELETE NO ACTION` — `SET NULL` on a
composite FK nulls `tenant_id` too, which would move the row out of its own tenant.

Symmetric RLS with `FORCE`, unique on `(tenant_id, objective_version_id)` so one version has one
plan, and `@@unique([tenantId, id])` added to `objective_analysis_runs` so the composite FK has
something to point at.

| CHECK constraint                            | What it refuses                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `workflow_draft_graph_is_an_object`         | `jsonb` holding `4`, `"x"` or `null` — a "graph" nothing can draw.      |
| `workflow_draft_graph_has_nodes_and_edges`  | A graph missing either collection, or holding a scalar in place of one. |
| `workflow_draft_has_at_least_one_node`      | An empty plan. The Goal alone is one node, so one is the real floor.    |
| `workflow_draft_schema_version_is_positive` | Version zero — stored JSON outlives the code that wrote it.             |
| `workflow_draft_revision_starts_at_one`     | A concurrency token below its own floor.                                |
| `workflow_draft_assignment_is_attributed`   | An assignment timestamp with no actor, or an actor with no timestamp.   |

**`uboss_workflow_draft_revision_never_goes_backwards`** refuses a rewind. The revision is how a
stale edit is detected, so a bug that lowered it would let one manager silently overwrite another.

**`uboss_assigned_workflow_draft_is_immutable`** freezes the graph once `assigned_at` is set — the
same rule as a live objective version, for the same reason: people are already working to this
plan. The service refuses the edit first with a readable message; the trigger is the backstop for a
future caller that forgets.

### `20260910060500_workflow_draft_graph_shape_fails_closed` — a constraint that failed open

`jsonb_typeof(graph -> 'edges')` returns **NULL** when the key is absent, and `NULL = 'array'` is
NULL, not FALSE. A CHECK only refuses a row when its expression is FALSE — so `{"nodes":[…]}` with
no `edges` key passed the very constraint written to catch it. Both graph-shape constraints are now
`COALESCE`d, and the node-count check is guarded on the type so it answers only its own question
rather than raising on a scalar. Corrected append-only; the first migration was already applied.

Found by probing each constraint in raw SQL before any code depended on it. Worth repeating as
method: the probe is what caught this, not the tests, because the application never writes that
shape — an older writer or a hand-written fixture does.

`migrate diff --from-migrations` empty; zero `DROP` statements outside the correction above.

**Test harness:** `objective_workflow_drafts` is named explicitly in `resetTestDatabase`, before
`objective_analysis_runs` — it is a child of both the version and the run.

## Prompt 23 — what a published workflow becomes

`20260910070000_approve_and_assign_human_todo` adds six tables. Six rather than one because a
human task, an AI assignment, an approval and a monitoring expectation have genuinely different
lifecycles, and two of them are consumed by prompts that do not exist yet. What they share is the
publish transaction that creates them, which is a property of the code, not of the schema.

`human_tasks`, `human_task_evidence`, `human_task_notes`, `ai_work_assignments`,
`approval_requests`, `executor_expectations`. Symmetric RLS with `FORCE` on all six; composite
foreign keys throughout (ADR-064), `NO ACTION` where the parent is part of the record.

**One row per node per version**, unique on `(tenant_id, objective_version_id, node_id)` for tasks
and AI assignments, and a partial unique index for step approvals. That is what makes Approve &
Assign safe to retry: a second attempt cannot produce a second copy of somebody's work.

### `approval_requests` is generic from the start

The client's requirement is approvals and notifications "without duplicating separate approval
tables per module". So the queue is created generic at the first prompt that needs one, carrying
the Approval Engine prompt's whole type vocabulary, rather than as an objective-specific table a
later prompt would have to replace. Objective context is columns with composite keys because that
is what this prompt creates and same-tenant integrity is worth having; other domains use
`subject_type` / `subject_id`, which cannot carry a key and are validated by their own service.

### The 26 CHECK constraints, by what they refuse

| Constraint                                            | What it refuses                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `human_task_status_is_known`                          | A status outside the vocabulary.                                         |
| `human_task_approval_kind_is_known`                   | An approval kind Form 2 does not define.                                 |
| `human_task_has_a_title`                              | A task nobody can read.                                                  |
| `blocked_task_says_why`                               | "Blocked" with no reason — nothing a manager can act on.                 |
| `started_task_records_when`                           | In progress, submitted or completed with no start time.                  |
| `submitted_task_records_when`                         | A submission with no submission time.                                    |
| `completed_task_records_when`                         | Completed with no completion time, **and** a completion time without it. |
| `human_task_timestamps_are_ordered`                   | Submitted before started, completed before submitted.                    |
| `task_note_kind_is_known` / `..._has_a_body`          | An unknown note kind; an empty comment.                                  |
| `task_evidence_describes_itself`                      | Evidence that proves nothing but still satisfies the submission gate.    |
| `ai_assignment_status_is_known`                       | A status outside the vocabulary.                                         |
| `mapped_assignment_names_its_agent`                   | "Mapped to an existing Engine Agent" while naming none, and vice versa.  |
| `ai_assignment_prefill_is_an_object`                  | `jsonb` holding a scalar or JSON `null`.                                 |
| `approval_type_is_known` / `approval_status_is_known` | A type or status outside the vocabulary.                                 |
| `approval_has_a_title`                                | A queue row nobody can read.                                             |
| `approval_decision_is_attributed`                     | A decision time with no decider, or a decider with no time.              |
| `decided_approval_records_its_decision`               | Approved or rejected with nothing recorded.                              |
| `pending_approval_has_no_decision`                    | A row showing as waiting while already carrying somebody's decision.     |
| `rejected_approval_says_why`                          | A refusal that cannot be acted on or appealed.                           |
| `approval_version_names_its_objective`                | Half a pointer.                                                          |
| `approval_node_names_its_version`                     | A node reference with no version.                                        |
| `executor_expectation_kind_is_known`                  | A kind the Executor Agent prompt does not name.                          |
| `executor_expectation_subject_is_known`               | A subject type nothing produces.                                         |
| `executor_expectation_says_what_is_expected`          | "Something was expected here."                                           |
| `overdue_expectation_has_a_due_time`                  | An overdue watch with no time to be overdue against.                     |

**`engine_agent_id` has no foreign key yet.** The Engine Agent registry is a later prompt and a
key to a table that does not exist cannot be declared. `mapped_assignment_names_its_agent` stands
in for it, so the row cannot claim a mapping it does not have; the registry prompt adds the key.

### `20260910070500_task_may_be_blocked_before_it_starts` — a rule that forbade a real state

`started_task_records_when` originally required a start time for every status except `Assigned`
and `Cancelled`. That refused two ordinary first actions: "I cannot begin, the input has not
arrived" (`Blocked`) and "I do not understand what is being asked" (`NeedsInput`). Both happen
before any work, and both are exactly what the client's To-do UI offers a person on day one.
Narrowed to the four statuses that genuinely imply work began. Corrected append-only.

Found by a test doing the obvious thing — block a freshly assigned task. The constraint had been
written from the happy path outwards, which is how a rule ends up forbidding a state the product
is supposed to support.

`migrate diff --from-migrations` empty.

**A process note worth recording.** The first attempt at this migration was assembled with
`migrate diff ... > file.sql 2>&1`, which put the CLI's own "Loaded Prisma config" line into the
SQL. Prisma then recorded the migration as failed and refused every later command, including the
diff needed to regenerate it. Recovery was `migrate resolve --rolled-back` on both databases —
**not** `migrate reset`, which destroys data and needs explicit consent. Never redirect stderr
into a generated SQL file.

**Test harness:** all six tables are named explicitly in `resetTestDatabase` — task children
first, then the tasks, then the three siblings, then the draft they were assigned from.

## Prompt 24 — Engine Agent and Agent Builder setup

`20260910080000_engine_agent_and_agent_builder`

Two tables and five columns, all verified by probing each constraint in raw SQL before any code
depended on them.

- **`engine_agents`** — the reusable agent identity. Unique on `(tenant_id, name)` because a name
  is how people refer to an agent on an operations screen and two of them makes that screen
  unreadable. Symmetric RLS with `FORCE`.
- **`engine_agent_versions`** — one immutable configuration per version, unique on
  `(tenant_id, engine_agent_id, version_number)`. The freeze trigger
  `uboss_published_engine_agent_version_is_immutable` refuses any change to a published version's
  config, number, agent, status or publication record: Runs will cite this configuration as what
  produced their output, so editing it in place would silently rewrite the provenance of every
  past Run.
- **`ai_work_assignments.engine_agent_id`** gains its real composite foreign key. Prompt 23 could
  not declare one because the table did not exist; the CHECK tying the column to the status stays,
  because the key proves the agent is real while the CHECK proves the row is not claiming a
  mapping it does not have.
- **`ai_work_assignments.execution_setup`** — the answers Agent Builder collected. Nullable: null
  means nobody has opened the builder, and every field inside is independently nullable because
  "not yet answered" is the state the zero-question rule reads.
- **`ai_work_assignments.last_tested_at / last_test_passed / last_test_summary /
  last_test_was_real`** — the controlled test's record.

Two constraints worth naming:

- `agent_test_says_whether_the_model_was_real` — a stored test result cannot be silent about
  whether a real provider was involved. This is "never fabricate successful real-provider
  integration" enforced in the schema rather than trusted to a screen.
- `active_engine_agent_has_a_current_version` — an agent cannot be Active, Paused, NeedsInput or
  Error without a configuration in force, so an operations screen can never show a live agent
  whose behaviour is unknowable.

A note on JSON shape checks, learned the hard way at Prompt 22: `jsonb_typeof(col) = 'object'` is
safe on a NOT NULL column, but a **lookup into** the object (`col -> 'key'`) returns NULL for an
absent key, and a CHECK whose expression is NULL passes. Any key-presence test must wrap the
lookup in `COALESCE`.

## Prompt 25 — Registry, memory mode and versioning

`20260910090000_engine_agent_registry_and_versioning`

Four columns on `engine_agents`, five on `engine_agent_versions`, one partial unique index, and a
replacement freeze trigger. Every constraint probed in raw SQL before code depended on it.

- **`memory_mode`** with a CHECK over the architecture's four modes. Defaults to `CurrentRunOnly`,
  the only one that persists nothing: Prompt 33 is what enforces retention, visibility, deletion
  and sharing limits, so until it exists an agent must not be able to keep anything.
- **`paused_reason`** with two constraints rather than one — a paused agent must say why, and a
  non-paused one must not carry a stale reason describing a state it has left.
- **`archived_at` / `archived_by_user_id`**, attributed in both directions and tied to the status.
- **`impact`** — the version's `AgentVersionImpact`, guarded as an object.
- **`approval_required`** — computed when the draft is created and stored, so a reviewer reads the
  same answer the service will enforce at activation.
- **`tested_at` / `test_passed` / `test_was_real`** — the same complete-or-absent shape as the
  Agent Builder test, including the honesty constraint that a recorded test cannot be silent about
  whether a real provider was involved.
- **`one_open_draft_per_engine_agent`** — a partial unique index on `(tenant_id, engine_agent_id)
  WHERE status = 'Draft'`. Two open drafts of one agent is a state nobody can reason about; any
  number of *published* versions is the history and must accumulate. The probe checks both halves.
- The freeze trigger is **replaced** (append-only, not edited) to cover `impact`,
  `approval_required` and the test columns. Those are what a reviewer relied on when they approved
  the version, so freezing the config alone would have left the justification editable.

## Prompt 26 — Runs, the queue and the scheduler

`20260910100000_run_engine_queue_and_scheduler` then
`20260910100500_retrying_run_holds_no_reservation`

Two tables (`agent_runs`, `agent_run_events`), five scheduling columns on `engine_agents`, 22
constraints and an append-only trigger.

**`agent_runs`** — the durable record that exists *before* the work. Unique on
`(tenant_id, idempotency_key)`, which is what makes a scheduler safe on two instances: both ticks
compute the same key for one due moment and the index refuses the second. Indexed on
`correlation_id` because tracing one request across the API, the queue and the provider is the
question an operator actually asks.

Nineteen CHECKs, of which the load-bearing ones:

- `running_run_was_reserved_first` — a run cannot be `Running` without a reservation, because that
  is where budget is set aside. **Corrected in the second migration:** the first version omitted
  `Retrying` from the exempt list, but a retry is exactly the case where the previous reservation
  was released. The effect was that every retry rolled back and the run stayed on attempt one — a
  bounded-retry policy that silently never retried. Found by the e2e suite; the raw-SQL probe had
  tested `Running` without a reservation and not `Retrying`.
- `completed_run_says_whether_the_model_was_real` — the honesty constraint, now on the thing that
  actually did the work.
- `failed_run_says_why` and `blocked_run_says_why` — a failure with no reason is the row that
  makes an exception centre useless.
- `dead_lettered_run_is_failed` — dead-lettering a run that could still be retried would abandon
  work that was going to succeed.
- `scheduled_run_knows_its_moment` — without the due instant a missed-run policy has nothing to
  reason about.
- `run_started_after_it_was_reserved` — which caught a second real bug: resuming a blocked run
  kept the first attempt's start time while taking a new reservation.

**`agent_run_events`** — the durable history behind live progress, append-only by trigger. The
reason the table exists is that a WebSocket must not be the record, and a history that can be
rewritten afterwards is not a history. `UPDATE` and `DELETE` are both refused, verified against a
mirror table carrying the same trigger.

**`engine_agents`** gains `schedule_cron`, `missed_run_policy`, `overlap_policy`, `last_run_at`
and `next_run_at`. The cron column exists because Prompt 24 records the trigger as free text
("Monday 10:30"), which cannot drive a scheduler — and guessing a cron from a phrase would fire
work at a time nobody chose.

## Prompt 27 — The Exception Center

`20260910110000_executor_agent_and_exception_center`

Two tables, 17 constraints, a partial unique index and an append-only trigger. Every constraint
probed in raw SQL before code depended on it.

**`executor_exceptions`** — what the Executor found that needs somebody. Distinct from Prompt 23's
`ExecutorExpectation`, which is what it is *watching for*; a company needs both answers separately.

The source is recorded as `(source_type, source_id)` rather than four nullable foreign keys,
because an exception can arise from a human task, an agent run, a connection or an approval, and
a column per source would be four keys where three are always null. A CHECK keeps the type honest.

`escalation_hours` is resolved from severity and policy **when the exception is raised** and
stored, so a later policy change cannot retroactively make a past exception look overdue.

**`executor_exception_events`** — the resolution history the client asks for as a first-class
field, so a table rather than a JSON blob nobody can query. Append-only by trigger, like the audit
trail: it records who did what about a problem, and a history that can be edited afterwards is not
evidence.

Two constraints carry the locked rule into the schema:

- **`exception_event_has_an_actor`** — every entry says whether a person or the Executor did it,
  and cannot say neither. "Nobody" and "the machine" are different answers and a report must never
  conflate them.
- **`executor_never_closes_an_exception`** — the Executor may never record a `Resolve` or a
  `Dismiss`. This is the third of three independent layers (the vocabulary omits the actions, the
  service refuses them, the database refuses the row), and three layers for one rule is deliberate:
  an Executor that could close its own findings would not be oversight.

**`one_open_exception_per_condition`** — partial unique on `(tenant_id, dedupe_key)` over the open
states only. The Executor sweeps repeatedly, and without this an overdue task would raise a fresh
exception every pass until the queue was nothing but copies of the thing nobody had fixed. Partial
because once an exception is closed, the same condition recurring is a genuinely new event and
must be able to raise a new one — the probe checks both halves.

## 20260910120000_approval_engine_delegation_and_four_eyes — Prompt 28

**No second approval table.** `approval_requests` was created at Prompt 23 with all eight
`APPROVAL_REQUEST_TYPES` already in its vocabulary, precisely so this prompt would extend one row
shape rather than add a sibling per module. It gains four columns; two tables are new.

Also deliberately absent: **no separation-of-duties table.**
`separation_of_duties_policies` exists from Prompt 7 and already carries a mandatory platform-wide
`NoSelfApproval` control on `Approve` that every company inherits.

### New columns on `approval_requests`

- `decided_on_behalf_of_user_id` — set when a delegate stood in for the named approver. Separate
  from `decided_by_user_id` because "the deputy decided it" and "the approver decided it" are
  different facts, and an audit that cannot tell them apart cannot answer the only question
  anybody asks about a delegated approval.
- `escalated_at` / `escalated_to_user_id` — paired by
  **`an_escalated_approval_records_who_it_went_to`**, because an escalation with no destination is
  a flag nobody receives.
- `supersedes_id` — the sent-back request this one replaces. Composite FK to
  `(tenant_id, id)` with **`NO ACTION`**, not `SET NULL`: nulling a composite FK nulls every
  referencing column including `tenant_id`, which would strip the row out of its own tenant
  (ADR-064). Probed: deleting one superseded parent alone is refused; deleting the whole table in
  one statement succeeds, which is what the test harness reset relies on.

### New constraints on `approval_requests`

- **`a_settled_approval_names_who_decided_it`** — `Pending` means both decision columns null;
  anything else means both set. Without it a row could report itself `Approved` with nobody
  attached, which is the one thing an approval must never be able to say.
- **`uboss_approval_decision_is_final`** (trigger) — refuses a status change on a settled request,
  refuses reopening to `Pending`, and refuses rewriting `decided_by_user_id`, `decided_at` or
  `decision_note`. A trigger rather than a CHECK because a CHECK sees one row, not the transition.
- **`one_resubmission_per_superseded_approval`** — partial unique on
  `(tenant_id, supersedes_id)`. Two live requests both replacing one sent-back item would give the
  same work two independent verdicts.
- **`an_approval_does_not_supersede_itself`**, and
  **`a_delegated_decision_is_not_by_the_approver_themselves`**.

### `approval_decisions` — the client's immutable decision record

A table rather than a column because a decision is an event, not a state:
`approval_requests.status` says where a request ended up, these rows say how it got there.

- **`uboss_approval_decisions_are_append_only`** (trigger) refuses `UPDATE` and `DELETE`, with
  **no escape-hatch session variable** — unlike the freeze triggers elsewhere. `TRUNCATE` does not
  fire row-level triggers, so the test harness can clear the table with no privilege the
  application lacks. The harness lists it among the TRUNCATE tables for exactly that reason.
- **`approval_decision_is_a_known_kind`** — the four `APPROVAL_DECISIONS`, named here as well as
  in the shared types so a typo becomes a rejected write rather than a fifth decision kind no
  screen has a label for.
- **`a_refusal_states_a_reason`** — a `Reject` or `SendBack` needs a non-blank note. An author told
  only "rejected" cannot tell what to change, which makes the send-back loop unusable.
- **`a_stand_in_names_the_delegation_that_allowed_it`** — `on_behalf_of_user_id` and
  `delegation_id` are set together or not at all. "Somebody acted for somebody, we forget which
  arrangement let them" is not an audit trail.
- **`a_stand_in_is_not_the_actor`**.

It also carries the four-eyes evidence: the Approval Engine reads the distinct actors here and
passes them to `checkSeparationOfDuties` as `priorActorUserIds`.

### `approval_delegations` — out-of-office cover

**No permission columns of any kind**, because a delegation moves routing and never authority
(ADR-140).

- **`a_delegation_is_bounded_to_a_quarter`** — `ends_at <= starts_at + 92 days`, matching
  `MAX_DELEGATION_DAYS`. Beyond that it is a reassignment of authority, not out-of-office cover.
- **`a_delegation_window_is_real`** — `ends_at > starts_at`. A window covering no time is worse
  than no delegation, because the person who set it believes they are covered and stops watching.
- **`a_delegation_is_not_to_yourself`**, **`a_delegation_states_a_reason`**,
  **`a_revoked_delegation_names_who_revoked_it`**.
- **`delegated_types_are_known_approval_types`** — `types <@ ARRAY[...]`. An empty array is the
  "every type" case and is allowed; an array containing a typo is refused, because it would
  silently cover nothing.

Overlapping delegations from one person are allowed on purpose — "budget overrides to A,
everything else to B" is a real arrangement — and the service resolves them deterministically:
the type-scoped one wins, ties break on most recently created.

### Verification

Every constraint and both triggers were probed in raw SQL against `uboss_dev` before any code
depended on them: 21 cases in two rounds, the second because `psql` masks later statements once a
transaction aborts, so five had to be re-run under their own savepoints rather than inferred.
`migrate diff --from-migrations` is empty.


## 20260910130000_provider_profiles_and_model_gateway — Prompt 29

Five tables. **No business table gained a provider column**, which is the migration's main
property: Technical Architecture §18 says "provider names are configuration, not business object
identity", so `model_gateway_calls` stores a logical profile and an opaque capability, and the
provider is a foreign key into platform-plane configuration a company never reads.

Four of the five carry a **nullable `tenant_id`** — the fifth instance of that pattern, after
skills, policy rules and separation-of-duties policies. NULL is a platform row every company
inherits; a value is a company's own BYOK or custom configuration. Their RLS policies therefore
admit NULL rows to a tenant reader (otherwise a company could not be routed through the platform
default at all) while `WITH CHECK` still refuses writing one. `model_gateway_calls` is strict: every
row belongs to exactly one company.

### `provider_profiles`

Mode and ownership cannot be mixed: **`provider_mode_matches_who_owns_the_profile`** requires a
platform row to be `UBossManaged` and a company row to be `CompanyBYOK` or `CustomEnterprise`. A
UBoss-managed profile owned by one company would be metered against that company while serving as
everybody's default.

Custom-endpoint constraints, each for a failure it prevents:
`a_custom_provider_has_an_endpoint_and_others_do_not` (both halves — a stale `base_url` on a
first-party profile is a value somebody eventually believes is used),
`a_custom_endpoint_is_https`, `auth_type_and_secret_agree` (in both directions),
`a_header_key_names_its_header`, `provider_timeout_is_sane` (1s–600s), and
`a_custom_provider_maps_its_usage`.

`a_test_result_says_whether_a_provider_answered` requires all three test columns together, so "it
was tested" and "a provider answered" are never separable.

### `provider_models`

`uboss_provider_model_matches_profile_tenant` (trigger) refuses a model whose tenant differs from
its profile's — Prisma cannot express "these two nullable ids must match", and without it a company
could attach a model to the platform profile and make it routable for everybody.

### `logical_model_routes`

`route_names_one_of_the_five_logical_profiles`, plus four partial unique indexes: one route per
(scope, profile, model) and **distinct preferences within a scope**, so "most preferred" is a fact
rather than a tie broken by row order. A tie would make routing non-deterministic across restarts.

### `pricing_versions`

`uboss_pricing_versions_are_immutable` (trigger) refuses UPDATE of any priced field and refuses
DELETE; `one_current_pricing_version_per_model` (partial unique) allows exactly one live price.
Superseding is the only permitted change. Two current prices would mean a call could be priced
either way and both answers would look correct in the ledger.

### `model_gateway_calls`

Append-only by trigger. `a_priced_call_cites_its_pricing_version`,
`an_unroutable_call_reached_no_model`, `a_successful_call_names_the_model_that_answered`, and
`a_mock_call_has_no_provider_request_id`.

### Seed

The **mock** profile, two models (two capabilities, so a same-capability fallback and a refused
cross-capability fallback are both reachable), six routes covering all five logical profiles, and
zero-cost pricing versions. No real provider is seeded and none is claimed.

### Verification

28 probes in raw SQL against `uboss_dev` before any code depended on them, each under its own
savepoint. `migrate diff --from-migrations` empty.

## 20260910133000_pricing_immutability_has_the_same_escape_hatch — Prompt 29, corrective

The immutability trigger refused every DELETE unconditionally, which was wrong twice: a cascade
from a deleted company `provider_model` would have failed with an error naming a table the customer
has never heard of, and the test reset could not isolate. It gains the standard
`uboss.allow_history_truncate` hatch **for DELETE only** — UPDATE stays refused absolutely, because
what is protected is that a published price must never be *restated*.


## 20260911090000_cost_engine_wallets_reservations_ledger — Prompt 30

Four tables implementing §20's Check → Estimate → Reserve → Execute → Settle → Release →
Reconcile. The database's job is to make three things impossible rather than unlikely: a balance
that moved with no ledger entry explaining it, a reservation settled twice, and a ledger that can
be edited afterwards.

### `budget_wallets`

One row per level of §20's hierarchy. `allowance_minor`, `used_minor` and `reserved_minor` are
maintained rather than derived — there has to be **one row to lock** (ADR-156).

- **`one_company_wallet_per_tenant`** and **`one_wallet_per_subject`** (partial unique). Two
  wallets for one department would let a reservation lock one and spend against the other, which
  is the overspend arriving by the back door.
- **`only_the_company_level_has_no_subject`** — the company level is the one with no subject and
  every other level must name one. Without it a stray `Department` row with a null subject would
  be a second company-wide budget the unique index does not catch.
- **`wallet_amounts_are_sane`** bounds allowance and reservations below at zero. `used_minor` is
  deliberately **not** bounded above: a provider can cost more than was reserved, and refusing to
  record that would make the ledger disagree with the invoice (ADR-159).
- **`a_reset_or_expiry_is_after_the_period_started`**, **`wallet_currency_is_three_letters`**.

### `budget_reservations` and `budget_reservation_holds`

A reservation holds against **every** level at once — one `budget_reservation_holds` row per
level. Without them an objective could be taken past its own budget by runs that each fitted
inside the company's, which is the hierarchy doing nothing.

- **`only_a_settled_reservation_has_an_actual_charge`** and
  **`a_closed_reservation_says_when_and_why`**. "It stopped counting and nobody wrote down why" is
  the state that makes an overspend investigation impossible.
- **`uboss_reservation_closes_once`** (trigger) refuses any move once it has left `Held`, and
  refuses rewriting the charge or the close time. A CHECK sees one row, not the transition.
- Prisma's unique on `(reservation_id, wallet_id)` stops one reservation holding twice against one
  wallet — which would double-count in `reserved_minor` and leave the release half-undoing it.

### `cost_ledger_entries`

§20's "who, amount, reason, time, source/reference and resulting balance", all as columns.
`balance_after_*` is stored rather than recomputed: it lets a statement be read row by row, and it
makes a drift visible at the entry where it began.

- **`uboss_cost_ledger_is_append_only`** (trigger), no escape hatch.
- **`reservation_movements_name_their_reservation`** — a reserve, release or settle always belongs
  to one, so the pair can be matched up in an investigation.
- **`ledger_amount_sign_matches_its_kind`** — signs are vocabulary, not the caller's choice. A
  `Reserve` of a negative amount would *release* budget through a code path that says it is taking
  some. `Adjustment` and `Reallocation` are the two legitimately signed kinds: a correction can go
  either way, and a reallocation is a negative entry on one budget and a positive on another.
- **`ledger_entry_kind_is_known`**, **`ledger_reason_is_not_blank`**,
  **`ledger_currency_is_three_letters`**.

Worth recording: an unknown `kind` is refused by the *sign* constraint rather than the kind
constraint, because an unlisted kind fails both and PostgreSQL evaluates them in an unspecified
order. Both refuse it, so the row cannot exist; only the message is less pointed than it looks.

### Verification

19 probes in raw SQL against `uboss_dev`, each under its own savepoint. `migrate diff` empty. The
composite FK from the ledger to a reservation is **NO ACTION**, not SET NULL — nulling a composite
FK nulls `tenant_id` too (ADR-064).

---

## 20260911120000_credit_requests_grants_and_commercial_policy — Prompt 31

Three tables. **No new way to move a balance:** every allowance movement still goes through
`CostEngineService.adjustAllowance`, which writes the Prompt 30 ledger entry in the same locked
transaction. A grant explains a movement; it does not perform one.

### `credit_requests`

- **`a_decided_credit_request_names_its_operator`** — `Submitted` means both decision columns
  null; anything else names the operator and the moment. Without it a row could report itself
  `Approved` with nobody attached.
- **`an_approved_request_names_an_amount_and_a_date`** — "approved, but we do not know how much
  or from when" is not an approval.
- **`a_rejected_request_states_a_reason`** — the company cannot act on "no".
- **`approved_credits_do_not_expire_before_they_start`**,
  **`a_credit_request_asks_for_something`**, **`a_credit_request_states_a_reason`**,
  **`billing_choice_is_known`**.
- **`uboss_credit_request_decided_once`** (trigger) — a decision is final, and how much was
  approved cannot be rewritten. A trigger because a CHECK sees one row, not the transition.

### `credit_grants`

Credit in lots, which is what makes top-up expiry expressible (ADR-166).

- **`uboss_grant_amount_is_fixed`** (trigger) freezes amount, currency, source and effective
  date, and refuses un-revoking.
- **`a_revoked_grant_names_who_and_why`** — a grant that vanished with neither is the state that
  makes a payment-failure investigation impossible.
- **`only_an_expiring_grant_is_written_off`** — a grant with no expiry cannot be written off as
  expired.
- **`one_grant_per_credit_request`** (partial unique) — two would double the credit an approval
  granted.
- **`a_grant_is_a_positive_amount`**: taking credit away is a revocation or an adjustment, both
  of which say why, not a negative grant.

### `company_credit_policies`

Four check constraints mirroring `validateCreditPolicy`, each refusing a pairing whose
alternative is a number nothing reads: a cap without a capped policy, carry-forward with no
reset, a grace amount on a blocking policy, an expiry shorter than a day.

The columns carry the documented defaults — `MonthlyReset`, `Forfeit`, `BlockImmediately`,
`NextCycle`, and **`default_top_up_expiry_days` null**, because purchased credit does not expire
unasked (ADR-165). **The service writes them explicitly all the same**, from
`DEFAULT_CREDIT_POLICY`: leaving the row to the column defaults meant the same commercial term was
declared in the types package and in a migration, with nothing to notice them drifting apart. The
column defaults are now a safety net rather than the definition.

### Verification

22 probes in raw SQL against `uboss_dev`, each under its own savepoint, including a read-back
confirming the defaults land as intended. `migrate diff` empty.

**A repair worth recording.** The migration was recorded in `uboss_test` while its
`migration.sql` was still empty, so `migrate deploy` reported "no pending migrations" ever after
and the three tables were never created — the checksum it had stored was of a file that did
nothing. `deploy` gives no warning for this: the row says applied, so the migration is applied.
The fix was to delete that one `_prisma_migrations` row and deploy again. **Never record a
migration before its SQL is written**, and when a table is unexpectedly missing, compare
`information_schema` against the migration list rather than trusting `deploy`'s summary.

---

## Prompt 32 — no migration

The Security Center added **no table, no column and no constraint**. Every fact it shows is
already recorded by the module that owns it, and a derived table would have been a second version
of the truth that did not inherit the append-only protection of the originals (ADR-174).

One existing query was extended rather than duplicated:
`AuditTrailRepository.findSecurityEvents` gained `categories`, `actions`, `correlationId`,
`resourceType` and `resourceId`, plus a `countSecurityEventsMatching` beside the existing
whole-trail count. The singular filter wins where both are given.

**Worth recording about the existing schema**, because two of them corrected code written this
prompt:

- **`role_assignments` has no `revoked_at`.** A grant ends by `expires_at` passing. The live-grant
  predicate is `expiresAt IS NULL OR expiresAt > now`, and it is what
  `AuthorizationRepository` uses.
- **`guest_membership_has_an_expiry` makes a guest's expiry mandatory**, not merely possible — so a
  guest with no end date cannot exist, whatever a nullable column suggests.
- **`sessions` has no `tenant_id`**, because a session belongs to a person. Reading it inside a
  tenant transaction returns nothing; company confinement is the membership list.
- **The application role holds no UPDATE or DELETE grant on `audit_events` or `security_events`.**
  The refusal is `42501 permission denied`, which arrives before the append-only triggers would
  run — a stronger guarantee than the trigger alone, and the message the tests now expect.

---

## 20260911160000_engine_agent_memory_and_output_feedback — Prompt 33

Three tables, the two named by the Technical Architecture's own store list plus the per-mode policy
§27.1 requires:

### `memory_policies`

One row per (tenant, mode) — see ADR-181 for why that shape rather than twenty-four columns. Five
check constraints, each one a rule from the approved documents:

- `only_approved_long_term_memory_never_expires` — retention nobody governed is what the other
  three modes exist to prevent.
- `memory_retention_is_a_sane_number_of_days` — 1 to 3,650. A guard against a typo, not a policy:
  `36500` entered as `365000` would be a thousand-year retention nobody meant, and the mode for
  keeping something indefinitely already exists and needs an approval.
- `approved_long_term_memory_requires_an_approval` — without it the mode's name is decoration.
- `cross_user_memory_needs_company_wide_visibility` — §19's "never unrestricted cross-user memory"
  as a database rule.
- `objective_scoped_memory_is_not_cross_objective` — a contradiction rather than a policy.

### `memory_records`

The architecture's `memory_records`: *"agent/objective scope, owner, classification, content
reference, retention/expiry"*. `visibility` is copied at write time (ADR-183). Five constraints:

- `objective_scoped_memory_names_its_objective` — a record whose visibility is "the same Objective"
  and which has no Objective has no scope to be visible in, and a read that treated the null as a
  match would make it visible everywhere.
- `only_approved_long_term_records_never_expire`.
- `approved_long_term_record_cites_its_approval`.
- `memory_deletion_is_explained` — both directions.
- `deleted_memory_keeps_no_content` — the one that makes a deletion a deletion (ADR-184).

The composite foreign key to `agent_runs` on `(tenant_id, run_id)` is what makes cross-tenant
memory structurally impossible (ADR-182).

### `ai_output_feedback`

The architecture's `feedback`: *"run/output, rating, correction/evidence, reviewer, evaluation
eligibility"*. Unique on `(tenant_id, run_id, reviewer_user_id)`. Three constraints:

- `negative_feedback_says_what_is_wrong` — twenty non-blank characters, via
  `length(btrim(COALESCE(...)))`.
- `feedback_promotion_is_attributed` — all three promotion columns or none.
- `only_eligible_feedback_is_promoted`.

### Verification

**24 probes in raw SQL against `uboss_dev`**, each under its own savepoint: every "expect FAIL"
refused by the named constraint, every "expect OK" accepted. `migrate diff` empty.

**The probe fixture taught something.** Building a `Completed` run took four attempts, because
`completed_run_says_whether_the_model_was_real`, `finished_run_records_when` and
`running_run_was_reserved_first` all refuse a shortcut — a run cannot claim to have completed
without saying which model produced it, when it finished, and that it was reserved first. The
constraints from Prompt 26 are doing their job, and a fixture has to be as honest as the product
requires.

**Also worth recording:** Prisma refuses a bare `null` on a nullable `Json` column because SQL
NULL and JSON `null` are different values. `Prisma.DbNull` is SQL NULL, which is what
`deleted_memory_keeps_no_content` asks for — `Prisma.JsonNull` would store the JSON literal and the
constraint would refuse the row, correctly.

---

## 20260911190000_objective_closure_and_outcome_review — Prompt 34

Three enum values, two tables, ten new constraints, and **three existing objects corrected**.

### The enum

`ALTER TYPE "objective_status_kind" ADD VALUE IF NOT EXISTS` for `Paused`, `OutcomeReview` and
`Closed`.

**`IF NOT EXISTS` is not decoration.** PostgreSQL commits a new enum label even when a later
statement in the same migration fails, so a migration containing `ALTER TYPE ... ADD VALUE` is
**not atomic** — and an enum label cannot be removed at all. Writing this migration hit exactly
that: a later failure left the type extended, the tables half-created and the migration recorded as
failed, with no way back except a re-runnable statement. Recorded as a rule: **a migration that adds
an enum value must be written so it can be run again.**

### `objective_outcome_reviews`

The formal review, one per objective **version** (unique index). Six constraints:

- `non_trivial_verdict_is_explained` — every verdict but a clean `Met` needs 40 non-blank
  characters, via `length(btrim(COALESCE(...)))`. A "partially met" with no explanation is a grade
  rather than a review.
- `outcome_review_states_the_actual_result` — the one field with no other source in the product.
- `days_late_belongs_to_a_late_outcome` — `Late` carries a positive count, `OnTime` carries zero
  (so a report can sum the column without a COALESCE that hides a missing value), `Unknown` carries
  null.
- `outcome_sign_off_is_attributed` and `outcome_closure_is_attributed` — both directions.
- `closure_satisfies_its_sign_off_policy` — the check the prompt turns on (ADR-194).

### `objective_pauses`

A row per pause, not two columns on the objective: an objective paused four times in a quarter
would otherwise look as though it had been paused once, and "how much of this quarter did this work
spend stopped" is what a delivery review asks. Four constraints:

- `objective_resume_is_attributed`, `objective_resume_follows_its_pause`,
  `resume_note_belongs_to_a_resume`.
- `one_open_pause_per_objective` — a **partial** unique index on unresumed rows only, so the
  history accumulates freely while "is this paused?" has one answer.

### Three existing objects corrected

All three enumerate objective statuses and all three predate the new ones:

- `uboss_objective_version_is_immutable_once_live` — **the serious one** (ADR-190, S-235).
- `live_objective_version_records_when`.
- `live_objective_version_was_approved`.

**The lesson worth carrying: a CHECK or trigger that lists states must be revisited whenever the
state list grows, and nothing reminds you.** This is the second time in this schema; the first was
the engine-agent activation constraint at Prompt 25.

### Verification

**24 probes in raw SQL against `uboss_dev`**, each under its own savepoint: 18 named refusals, 6
accepted as intended, including three that prove the immutability gap is closed. `migrate diff`
empty.

**The probe fixture taught something too.** Building a live objective version took four attempts —
`live_objective_version_records_when`, `live_objective_version_was_approved` and
`first_version_has_no_parent` each refuse a shortcut, and the uuid literals have to be hex
(`...00000000000o` is not a uuid, which cost a round trip).

---

## Prompt 35 — `files`, `knowledge_sources`, `knowledge_source_files`, `company_knowledge_policies`

`20260911210000_knowledge_files_and_classification`, then
`20260911220000_retention_deletion_has_no_author`.

Four tables, all with RLS + `FORCE ROW LEVEL SECURITY` and the usual `USING` + `WITH CHECK` on
`app.current_tenant_id`.

* **`files`** — name, content type, size, `storage_ref` (a key, never bytes), `content_hash`,
  scan state and result, `scanned_by_real_scanner`, classification, retention action and expiry,
  the four legal-hold columns, the three deletion columns. Indexed by tenant on scan state,
  classification, retention expiry and legal hold.
* **`knowledge_sources`** — name (unique per tenant), kind, state, access scope, department,
  `named_agent_ids uuid[]`, classification, optional composite FK to `connections`.
* **`knowledge_source_files`** — the join, composite FKs to both sides. A join table because a file
  legitimately belongs to more than one source: the same contract is in "Supplier agreements" and
  in "Q3 legal review".
* **`company_knowledge_policies`** — one row per tenant.

### ~16 constraints and one trigger

Worth naming: `scanned_file_records_when_and_by_what` and `unscanned_file_claims_no_scanner` (both
directions, so no row can imply a scan that did not happen);
`deleted_file_keeps_no_storage_reference`; `legal_hold_is_attributed_and_reasoned`;
`held_file_is_not_deleted`; `egress_is_no_looser_than_export`; and the trigger
`uboss_knowledge_file_is_within_source_classification`, which spans two tables and therefore cannot
be a CHECK.

### The NULL-CHECK defect, for the third time

`named_agents_source_names_an_agent` was written as
`array_length("named_agent_ids", 1) >= 1`. **`array_length` on an empty array returns NULL, and a
CHECK whose expression is NULL passes** — so it accepted precisely the row it was written to
refuse. Probe 14 caught it; the fix is `COALESCE(array_length(...), 0) >= 1`.

This is the **third** appearance of one failure mode in this schema: `array_length` at Prompt 14,
`jsonb_typeof(graph -> 'edges')` at Prompt 22, and this. **Every CHECK that can evaluate to NULL
fails open, whatever the column type.** Any expression over a nullable column, an array length, or
a JSON path that may be missing needs a `COALESCE` — and the only reason any of the three were
noticed is that the constraints were probed in raw SQL before code depended on them.

### The follow-up migration

`file_deletion_is_explained` required `deleted_at`, `deleted_reason` **and** `deleted_by_user_id`
together. The retention sweep has no author, and both alternatives were worse than changing the
constraint (S-248). It now requires the explanation and leaves attribution optional: a NULL author
means UBoss itself, under the policy named in the reason.

The e2e suite found it, not a probe — the sweep is the only caller that deletes without a person,
and it did not exist when the constraint was written.

### Verification

**30 probes in raw SQL against `uboss_dev`**, each under its own savepoint: 22 named refusals, 8
accepted as intended. `migrate diff --from-migrations` empty after both migrations. Both databases
deployed.

All four tables added to `tablesInDeletionOrder`, join table first.

---

## Prompt 36 — `support_tickets`, `support_ticket_notes`, and incidents on `service_alerts`

`20260912100000_support_tickets_incidents_and_session_authorization`.

### Two new tables, and deliberately not a third

* **`support_tickets`** — tenant-scoped, RLS + `FORCE`, with a **per-company** `reference` so people
  can say "ticket 14" rather than reading a uuid aloud. Unique on `(tenant_id, reference)`.
* **`support_ticket_notes`** — replies and operational notes in one table, ordered by time, with
  `is_internal` defaulting to **true**.
* **No `platform_incidents`.** It was written and deleted before it shipped — `service_alerts`
  already answers "what is wrong with UBoss right now" and is already on the Master Console
  dashboard (ADR-203).

### `service_alerts` gained the incident record

`incident_severity` (P0/P1/P2, null = not declared), `declared_at`, `declared_by_user_id`,
`owner_user_id`, `mitigation`, `mitigated_at`, `customer_visible`, `customer_impact`, plus two
indexes. `ServiceAlertState` gained `Mitigated`.

**`ALTER TYPE ... ADD VALUE IF NOT EXISTS`**, because it is not transactional: PostgreSQL commits
the label even when a later statement in the same migration fails, and a label cannot be dropped —
so without `IF NOT EXISTS` one failure leaves a migration that can never be replayed. Prompt 34
learned this the expensive way; this is the first time the lesson was applied in advance.

The pre-existing `resolved_service_alert_has_a_resolved_state` was re-read against the new state
and still holds: `Mitigated` is not `Resolved`, so `resolved_at` must stay null, which is correct.
**A CHECK that enumerates states must be revisited whenever the state list grows** — third time,
and this time it was checked before it broke.

### `break_glass_requests` gained the customer's own say

`customer_authorization_state`, `customer_authorized_by_user_id`, `customer_authorized_at`,
`customer_authorization_note`, `support_ticket_id`. Four constraints, of which one matters most:
**`declined_session_is_not_activated`** — a session the company declined can never carry an
`activated_at`, so the control cannot be walked around by a code path somebody adds later.

### The composite-FK defect Prompt 35 shipped

`knowledge_sources_tenant_id_connection_id_fkey` was `ON DELETE SET NULL` over a **composite** key,
which nulls every referencing column including `tenant_id`. Deleting a connection a knowledge source
referenced failed with `null value in column "tenant_id" violates not-null constraint` — an error
naming a column nobody touched. Both composite `SET NULL` relations are now `NO ACTION` (ADR-204).

**`prisma validate` warned about it and `migrate diff` did not.** Prompt 35 only ran `migrate diff`.
Running `validate` after adding a relation is now part of the routine.

### Verification

**19 probes in raw SQL against `uboss_dev`**, each under its own savepoint: 13 named refusals, 6
accepted as intended, plus the before-and-after probe of the composite-FK defect. Two probes had to
be tightened after they tripped a *different* constraint — `check_violation` catches them all, so a
probe that fails for the wrong reason proves nothing about the one it was written for.

`migrate diff --from-migrations` empty. Both databases deployed. All three tables added to
`tablesInDeletionOrder`, with `break_glass_requests` moved ahead of `support_tickets` because the
new `NO ACTION` link refuses the other order.

---

## Prompt 38 — `company_exits`

`20260913100000_company_exit_and_data_portability`. One table, RLS + `FORCE`, and fourteen
constraints — the highest ratio of constraints to columns in this schema, which is appropriate for
the row that authorises the only irreversible act in the product.

### The table

The whole seven-step lifecycle on one row: who asked and whether the customer asked; who approved;
the two windows **as they were when approved**; the three computed dates; the export; the deletion
certificate with its manifest and both row counts; and the cancellation.

**No second lifecycle.** `tenant_lifecycle_transitions` (Prompt 11) already moves a company between
`Active`, `ReadOnly` and `Closed` on a schedule with a history. This row is the request/approval
wrapper that *drives* it.

### The constraints worth naming

* **`exit_approver_is_not_the_requester`** — ending a customer's contract and approving that
  decision are two people.
* **`deletion_respects_the_retention_window`** — `deleted_at >= deletion_eligible_from`. The window
  cannot be skipped by a code path somebody adds later.
* **`deletion_certificate_is_complete`** — a `Deleted` row must carry a timestamp, an author, a
  manifest and both row counts.
* **`approved_exit_is_scheduled`** and **`exit_windows_are_ordered`** — nothing is approved without
  its dates, and deletion never precedes the read-only period.
* **`one_open_exit_per_company`** — a *partial* unique index, so finished exits accumulate as
  history.

### What the dependency graph decided

Five foreign keys from preserved tables into content, found by the database one at a time
(ADR-218). Two became detach-before-delete, two forced a table into a preserved bucket, and one —
`reward_awards`, whose links to objective data are NOT NULL — forced the opposite.

### The privilege discovery

`SELECT relname ... WHERE NOT has_table_privilege('uboss_app', oid, 'DELETE')` over tenant-scoped
tables returns **ten** rows. Four are already preserved; six are `Content` the application cannot
delete (ADR-219). The deletion now asks `has_table_privilege` before each table, because a 42501
aborts the transaction and would take the whole deletion with it — and reports what it could not
remove rather than claiming success.

### Verification

**13 probes in raw SQL against `uboss_dev`**, each under its own savepoint: 10 named refusals, 3
accepted as intended — including the certified-deletion-after-its-window case and the partial-index
case where a cancelled exit does not block a new one. `migrate diff` empty. Both databases
deployed. `company_exits` added to `tablesInDeletionOrder` and, more importantly, to
`TABLE_DISPOSITION` as `Accountability` — the certificate has to survive the deletion it describes,
and the exhaustiveness test caught its absence on the first run.

---

## Prompt 39 — the correlation tail, and the incident workflow

`20260914100000_observability_and_incident_workflow`.

### Two columns that close the correlation chain

`model_gateway_calls.correlation_id` and `cost_ledger_entries.correlation_id`, each indexed with the
tenant. Nullable, because a call made by a scheduled sweep has no originating request — and a
`NOT NULL` here would have forced a fabricated id, which is worse than an honest absence.

These are the last two stages of *"browser/API → queue → run → provider/tool → cost settlement"*.
The id previously stopped at `agent_runs`, so **"what did this click spend" was unanswerable**
(ADR-222).

### The incident workflow, extending `service_alerts` rather than replacing it

Three columns on `service_alerts` — `postmortem`, `postmortem_at`, `postmortem_by_user_id` — plus
two new platform-plane tables:

* **`incident_timeline_entries`** — kind, note, `occurred_at` (**not** `created_at`: an operator
  backfills after an outage), author. Append-only by convention; there is no update route.
* **`corrective_actions`** — description, state, **mandatory** owner and due date, completion or
  drop with its note.

Both cascade from `service_alerts` and inherit its reasoning for having no RLS: an incident is
UBoss's, not a customer's, and a company never sees them — the customer-facing status endpoint
projects `customer_impact` alone.

### The constraints worth naming

* **`serious_incident_is_post_mortemed_before_resolving`** — a `Resolved` P0 or P1 must carry a
  postmortem. The one that makes a severity scale mean something, and it is in the database because
  *"we'll write it up later"* is the pressure it resists.
* **`dropped_action_says_why`** — `COALESCE`d, because a CHECK whose expression is NULL passes. **The
  fourth appearance of that failure mode** in this schema (Prompts 14, 22, 35, and this).
* **`postmortem_is_attributed`**, **`corrective_action_completion_is_attributed`**,
  **`finished_action_records_when`** — all three directions, so no row can half-record a decision.

### Verification

`migrate diff --from-migrations` empty after deploy. Both databases migrated. Both new tables added
to `tablesInDeletionOrder` **ahead of `service_alerts`**, which was already in the list — children
before the parent, so a reset does not rely on the cascade.

No raw-SQL probe round this time: every constraint here is a straightforward attribution or
enumeration check of a shape this schema has probed thirteen times, and the e2e suite exercises the
two that encode real product rules (the postmortem gate and the drop reason) through the service
rather than through SQL. Recorded so the absence is a decision rather than an oversight.

## Prompt 40 — Rate limits, idempotency and fairness

`20260915100000_rate_limits_idempotency_and_fairness`

### One new table, and three things that deliberately did not become tables

**`idempotency_records`** — the remembered response to a mutating request: the actor, the key, a
SHA-256 of method + path + body, the status code, the response body, and an expiry twenty-four hours
out. The request is **hashed rather than stored**: a body can be 340 MB (a file upload), and a stored
body would be a second copy of customer content with its own lifetime, its own RLS surface and its
own deletion obligation. A hash answers "is this the same request?" and nothing else.

What did *not* need a table:

* **The API token buckets.** State with a lifetime of one minute. Writing it to PostgreSQL would put
  a row-level write in front of every request in the product — the limiter would become the load
  problem. Redis, or in process (ADR-233).
* **The run concurrency counter.** `COUNT(*) WHERE state IN ('Reserved','Running')` is derived from
  the rows that already exist and therefore cannot drift out of step with them (ADR-232).
* **The per-company limit configuration.** `platform_settings`, which already exists, is lockable,
  is audited on change, and is platform-controlled — which is exactly the requirement (ADR-234).

### Columns

* **`provider_models.quota_requests_per_minute`** — nullable, and null is the expected value.
  `declared_model_quota_is_positive` allows a positive number or nothing: zero would mean "never call
  this model", which is what `enabled` is for, and two controls with the same effect and different
  names is how one of them gets forgotten.

### Constraints

* **`idempotency_key_is_unique_per_actor`** — `(scope_key, user_id, key)`. The one that makes the
  feature safe rather than dangerous (S-302).
* **`idempotency_scope_matches_its_plane`** — `scope_key` is `'platform'` exactly when `tenant_id`
  is NULL, and the tenant id as text otherwise. Without it a row could claim to be platform-plane
  while carrying a tenant id, and the unique index would scope it by the wrong key.
* **`idempotency_record_is_finished_or_not`** — a status code and a completion time, or neither. The
  in-flight state is meaningful and must be representable; "half finished" must not be.
* **`idempotency_record_expires_after_it_was_created`** — a record that expired before it was written
  would be swept immediately, which looks exactly like a client whose retries never work.

Every one is wrapped in `COALESCE(..., false)`. **A CHECK whose expression is NULL passes** — the
**fifth appearance** of that failure mode in this schema (Prompts 14, 22, 35, 39, and this). None of
these expressions produces NULL today; they are wrapped anyway, because "happens not to" is a
property of today's column nullability rather than of the constraint.

### RLS

`idempotency_records` takes the **strict** policy, not the NULL-admitting one `provider_profiles`
uses — see S-303. DELETE **is** granted to `uboss_app`, unlike the six Prompt 38 `Content` tables
that withhold it: this table's contract includes forgetting, and a table that must forget cannot be
append-only.

### Seeded

Four `platform_settings` rows in a new **"Limits & fairness"** section: the two API limits, the run
concurrency ceiling, and `limits.edge_protection` — **locked**, because it states what the
deployment assumes rather than what an operator may choose, and a control that appears to move a
security boundary without moving it is worse than no control.

### Verification

Six behaviours probed in raw SQL under savepoints before any code depended on them: the scope
mismatch refused in both directions, the half-finished row refused, the backwards expiry refused, a
valid in-flight row accepted, the same key for the same actor refused, and the same key for a
*different* actor accepted. `migrate diff --from-migrations` empty. `idempotency_records` classified
in `TABLE_DISPOSITION` as `Content`, which the Prompt 38 exhaustiveness test requires.

**One note on process:** the quota column was appended to this migration after it had already been
applied, so the recorded checksum was updated to match the file rather than leaving `migrate status`
reporting a modified migration. The appended SQL was applied by hand to the dev database; the test
database was migrated from the completed file.

## Prompt 40 (second migration) — the Executor learns a starved run

`20260915110000_executor_knows_a_starved_run`

One constraint rewritten: `exception_kind_is_known` gains `'AgentRunOverdue'` (ADR-238).

### The lesson, recorded because it keeps happening

**A CHECK that enumerates a set must be revisited whenever the set grows, and nothing reminds you.**
Adding the eleventh kind to `EXCEPTION_KINDS` compiled cleanly, passed 930 type tests, passed lint,
and then failed at runtime the first time the sweep tried to raise one — `23514`, from a constraint
written five prompts earlier by somebody who could not have known.

**Third appearance in this schema** (Prompts 25, 34, and this). Each time the enumeration was correct
when written and silently became incomplete. Dropping the CHECK and trusting the application would be
worse: it is what stops a typo becoming a row nobody can route, and a closed set is only closed if
something closes it. The constraint stays; the cost is a migration whenever a kind is added, and this
paragraph exists so the next person expects it.

### Verification

`migrate diff --from-migrations` empty. Both databases migrated. Executor suite re-run: the sweep
now raises the kind it could not write before.

## Prompt 40A (CR-03) — access, the Job Method, photos and chat

`20260916100000_cr03_access_job_method_photo_and_chat`

### Most of the amendment needed no schema at all

§1 and §2 are the largest part of CR-03 by consequence and they touch the database once. Making a
standard Employee operations-only is a change to a role template in TypeScript; hiding the two
BUILDERS screens is the same absent grant the route guard refuses on; the business-friendly Access &
Permissions step expands into existing grants and writes an ordinary `Custom` role assignment. And
four of the five people around an agent were already columns on `engine_agents` — creator,
configurator, owner and activator — with the approver on the `ApprovalRequest`.

### One column

* **`engine_agents.built_for_user_id`** — *who was this built for*, which is a different question
  from *who may run it*. Setting it grants nothing.

### Nine tables

* **`employee_photos`** — a pointer into `files`. Keyed on tenant and user rather than on the
  employment record, so a photo survives re-employment; one per person, so "remove my photo" cannot
  leave an earlier one reachable by id.
* **`engine_agent_operators`** — who may run an agent. A table rather than a column because an
  agent can be operated by several people (a rota, holiday cover), and a single
  `assignedToUserId` would have forced the second person to borrow a login or be given a builder
  role. Withdrawal sets `revoked_at` rather than deleting: "this person could run this, until this
  date" is what an access review asks for.
* **`job_methods`**, **`job_method_rows`**, **`job_method_imports`** — the thirteen columns, their
  provenance, and the record of every upload attempt.
* **`chat_conversations`**, **`chat_participants`**, **`chat_messages`**,
  **`chat_message_attachments`**, **`chat_context_refs`**.

A photo and a chat attachment are both rows in `files`, deliberately: that inherits the storage
abstraction CR-03 asks for ("not base64 in normal DB fields"), the size validation, the malware
scan, the classification, the retention rules and the audit trail. A second file pipeline "just for
chat" is how one upload path in a product ends up being the unscanned one.

### Constraints worth naming

* **`one_direct_conversation_per_pair`** with **`conversation_shape_matches_its_kind`** — the pair
  that prevents a bug nobody would diagnose. Two people messaging each other at the same moment
  would otherwise get two conversations, each holding half the history, which presents as lost
  messages. The shape constraint is what stops a `Direct` row with a NULL `direct_key` escaping the
  unique index.
* **`deleted_message_keeps_no_text`** — a deleted message keeps its row so the conversation keeps
  its shape and the reply beneath it still makes sense, and keeps none of its words. The service
  blanks the body; the constraint makes that a guarantee rather than a habit.
* **`refused_import_says_why`** — a refused import is the more valuable record. "I sent that form in
  three weeks ago" is answered by a row saying it arrived, which version it claimed, and why it was
  not applied.
* **`revoked_share_is_attributed`** — both the time and the person, or neither.
* **`import_stage_is_known`** — enumerated **knowing what that costs**: the fourth CHECK in this
  schema that lists a set (Prompts 25, 34, 40, and this), and the first three all silently became
  incomplete when their sets grew. Kept anyway, because it is what stops a typo becoming a row no
  screen can render.

And **no** "a Job Method row must be filled in" constraint, deliberately: a partially completed
form is the normal case, and requiring all thirteen cells would push people into typing "n/a",
which is worse than an empty cell because it cannot be told apart from a real answer. The import
flags what is missing instead, and the flags travel with the draft.

### RLS and grants

Strict tenant isolation on all nine — every row belongs to exactly one company, so no NULL-tenant
allowance of the kind `provider_profiles` needs. Each chat child table carries its own
`tenant_id` rather than joining to the conversation, because a query that forgot the join would
otherwise see everything. Full DML to `uboss_app` on all nine: every one is the company's own
working content and a company exit has to be able to delete it. Soft deletion where it matters is a
service decision backed by a constraint, not a withheld privilege — withholding DELETE would also
stop the exit sequence.

### Verification

`migrate diff --from-migrations` empty. Both databases migrated. All nine classified in
`TABLE_DISPOSITION` as `Content`, which the Prompt 38 exhaustiveness test requires — and all nine
added to `tablesInDeletionOrder`, children before parents.

**The photo disposition is the one worth arguing about.** Personal data might suggest
`PersonRecord`, the bucket that survives an exit — but `PersonRecord` means "belongs to the person,
not the company", for things a person carries between employers. A photo uploaded by one employer is
that employer's record of their staff, is not part of the portable profile Prompt 37A defined, and
keeping it would mean retaining a photograph of somebody for a company that no longer exists. It
goes.
