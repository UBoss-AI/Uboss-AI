# Deployment architecture and the promotion checklist

Production deployment for Chief Agent, powered by UBoss AI.

## The honest frame, first

The production target is the Hostinger VPS reserved for `ubossai.com`; project name `ubossai`.
The Docker stack and GitHub Actions deploy workflow are prepared. They are **not live until the
first deploy completes and DNS is pointed to the VPS**. The website is served at `ubossai.com`,
the product at `app.ubossai.com`, and the API at `api.ubossai.com`.

The legacy release-promotion workflow below remains a separate, gated process. Automatic pushes to
`main` use `.github/workflows/deploy-hostinger.yml`; that workflow calls Hostinger's deploy action
with the `ubossai` Compose project and the secrets listed below.

---

## The four environments

|                | Purpose                                                    | Who approves                                         | Data                                       |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| **Dev**        | Where a merged change is first seen running.               | Nobody — a gate here only teaches people to skip it. | Throwaway. Reset freely.                   |
| **Staging**    | Production-shaped. Where a release candidate is exercised. | One engineer.                                        | Synthetic. **Never a copy of production.** |
| **UAT**        | Where the client accepts the work.                         | Client-side approver.                                | Client's own test data.                    |
| **Production** | Customers.                                                 | Two reviewers, one of whom did not write the change. | Real.                                      |

**Staging never holds real customer data.** A copy of production into a lower environment is a
second, less-guarded place customer data lives — and every control that protects production
(break-glass, audit chain, restricted access) would have to be duplicated there to make it safe.
Synthetic data is less convenient and it is the only defensible choice.

Approvals are enforced by **GitHub Environments**, not by the workflow YAML. An environment with
required reviewers pauses the job until a named person approves. That cannot be bypassed by editing
a workflow in a pull request, which is exactly why it is configured there and not here.

### What GitHub actually enforces, and what it does not

The four environments exist and are configured. Each is restricted to the `main` branch, so a
commit nobody merged cannot be promoted even by a hand-run workflow.

| Environment  | Reviewer required | Self-approval | Branches    | Secrets / variables |
| ------------ | ----------------- | ------------- | ----------- | ------------------- |
| `dev`        | none              | —             | `main` only | none                |
| `staging`    | yes               | allowed       | `main` only | none                |
| `uat`        | yes               | allowed       | `main` only | none                |
| `production` | yes               | **blocked**   | `main` only | none                |

**The two-reviewer rule for production is policy, not enforcement, and the difference matters.**
GitHub Environments take a list of reviewers and release the job when **any one** of them
approves. There is no approval-count setting, so "two reviewers" cannot be configured — adding
more names widens who _may_ approve, it does not require more approvals. Believing otherwise
would be worse than knowing the gate is partial.

What the platform does enforce on production is `prevent_self_review`: the person who started
the deployment cannot be the one who approves it. That is the half of _"one of whom did not write
the change"_ that is mechanical. The other half — that a second person actually reviews — is a
checklist item below and is only as real as the people following it.

Separately, only one account currently has access to the repository, so there is no second
reviewer to name even as policy. Add one before the first production promotion.

The legacy `production` environment remains separate from the automatic Hostinger deploy workflow.
The latter requires the repository Actions secrets and variable listed below. Never place these
values in source files or workflow text.

---

## The pipeline

```
 pull request ──▶ CI ──────────────▶ merge to main
                  lint, format,
                  typecheck, build,
                  unit, integration,
                  migration validation,
                  audit, secret scan, CodeQL

 tag ─────────▶ Release candidate ──▶ qualified commit
                  full verify,
                  migration rehearsal,
                  rollback decision tree,
                  security suite,
                  AI regression

 manual ──────▶ Deploy ─────────────▶ Dev ▸ Staging ▸ UAT ▸ Production
                  approval per environment,
                  migrate → release → health check → roll back on failure
```

Three workflows, three different questions:

- **`ci.yml`** — _is this change sound?_ Runs on every PR. Fast job first (`static`), so a
  formatting slip fails in a minute rather than behind a twenty-minute database suite.
- **`release.yml`** — _is this commit fit to promote?_ Runs on a `prompt-*-pass` or `v*` tag. It
  **does not deploy**; qualifying and promoting are separate decisions.
- **`deploy.yml`** — _promote this qualified commit to this environment._ Manual, approved, ordered.

### Why CI runs the same commands you do

Every CI step is an existing npm script — `npm run lint`, `npm run format:check`, `npm run
typecheck`, `npm test`, `npm run build`. There is no CI-only script, so a green pipeline cannot mean
something different from a green machine, and a failure can always be reproduced locally by running
the command the log shows.

### Migration validation is two questions

`migrate deploy` proves every migration applies **in order to an empty database** — what a new
environment does.

`migrate diff --from-migrations --to-schema` proves the migrations and `schema.prisma`
**agree**. An empty diff means nothing was edited in the schema without a migration to carry it.
This repository contains hand-written SQL that Prisma cannot see, which is precisely why the check
is run rather than assumed.

---

## The order of operations, and why it is this order

Inside `.github/actions/promote/action.yml`, reused by all four environments so it cannot drift
between them:

1. **Migrate, then release.** The new schema must exist before the new code runs against it — and
   the _old_ code must keep working while it does, because there is always a window where both are
   live. That is what makes every migration additive or flag-gated. A migration that breaks the
   running version cannot be deployed without downtime, and that is a design problem, not a pipeline
   problem.

2. **Release.** Production goes to a slice first. The point is not the percentage; it is that a
   fault reaches some customers rather than all of them.

3. **Health check.** Ten attempts over about a minute. A container still starting is not a broken
   release, and failing on the first attempt would roll back every deploy.

4. **Roll back on failure — the release, never the database.** The previous version was built to
   tolerate the new schema, so leaving the migration applied is safe. Un-applying it is not: schema
   reversal loses the data the change touched.

### Why there are no down-migrations

A deliberate decision, not an omission. An automated reverse of a destructive change silently
destroys the data that change touched — the reverse of `DROP COLUMN` is a column full of nulls, not
the column you had.

Recovery from a bad migration is **point-in-time restore**, and which tool to reach for is in
`DECISION_TREE` (`packages/types/src/disaster-recovery.ts`), served by `GET /platform/recovery` and
summarised in `RUNBOOK.md` §10. The release workflow asserts that tree is present and coherent, so a
release cannot go out without one.

---

## Secrets

**Never in the repository.** Injected per environment by GitHub Environments, so a staging secret is
not visible to a production job and neither is visible to a pull request from a fork.

| Variable                 | Kind     | Purpose                                                                                    |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_MIGRATION_URL` | secret   | Owner role. Applies migrations.                                                            |
| `DATABASE_URL`           | secret   | `uboss_app`, `NOBYPASSRLS`. What the application connects as.                              |
| `AUTH_ENCRYPTION_KEYS`   | secret   | Encrypts stored credentials. **Lose these and a restored database is unreadable** (S-335). |
| `HOSTINGER_API_KEY` | Actions secret | Deploy permission for the Hostinger account. Use a rotated key; never reuse one pasted in chat. |
| `UBOSS_POSTGRES_PASSWORD` | Actions secret | PostgreSQL owner password used for migrations. |
| `UBOSS_APP_DB_PASSWORD` | Actions secret | Separate restricted `uboss_app` database password. |
| `UBOSS_AUTH_ENCRYPTION_KEYS` | Actions secret | Application encryption keyring; back it up outside GitHub too. |
| `UBOSS_INITIAL_ADMIN_PASSWORD` | Actions secret | One-time account bootstrap password for `dev@ubossai.com`. |
| `HOSTINGER_VM_ID` | Actions variable | The intended VPS ID. |
| `UBOSS_DEPLOY_COMMAND`   | variable | The host's own deploy command. Absent ⇒ nothing is released and the log says so.           |
| `UBOSS_ROLLBACK_COMMAND` | variable | The host's own rollback. Absent ⇒ manual rollback, loudly.                                 |
| `UBOSS_HEALTH_URL`       | variable | Checked after release. Absent ⇒ release unverified, and the log says so.                   |
| `UBOSS_ENVIRONMENT_URL`  | variable | Shown on the GitHub deployment.                                                            |

Environment files are not tracked. The deploy workflow injects these values into the Hostinger Docker
project; it does not commit an `.env` file. The secret scan examines Git history as well as current
files, because a deleted secret remains in old commits.

---

## The promotion checklist

Run top to bottom. Anything unchecked stops the promotion.

### Before promoting anything

- [ ] The commit is **on `main`** — the pipeline refuses a branch that was never merged.
- [ ] `release.yml` **succeeded for this exact commit**. Enforced, not trusted: the `precheck`
      job asks the GitHub API for a completed, successful `Release candidate` run whose
      `head_sha` is this commit, and refuses the promotion otherwise. A green CI is not a
      qualified candidate, and neither is a run that is still in progress.
- [ ] The change's `prompt-NN-pass` tag exists, or the change is documented in a release note.
- [ ] `docs/IMPLEMENTATION_STATE.md` reflects what is actually built, including its limitations.
- [ ] Any new migration has been read by a second person — Prisma cannot see hand-written SQL.

### Dev

- [ ] Deploy. No approval.
- [ ] Health check green.
- [ ] The change is visible doing what it claims.

### Staging

- [ ] One engineer approves.
- [ ] Migrations applied cleanly; `prisma migrate status` shows nothing pending.
- [ ] Health check green.
- [ ] The **journey** test path exercised by hand: an objective through to an employee running the
      agent built for them.
- [ ] No new error-level entries in the log for the first ten minutes.

### UAT

- [ ] Client-side approver approves.
- [ ] The client has been told what changed, in their words, not commit messages.
- [ ] Their acceptance is recorded before promoting further.

### Production

- [ ] **Two reviewers**, one of whom did not write the change. GitHub enforces only that a named
      reviewer approves and that it is not the person who started the promotion; the second pair of
      eyes is this checkbox and nothing else (S-346). Tick it only if a second person actually read
      the change.
- [ ] A verified backup exists and `GET /platform/recovery` does not report `neverVerified`.
- [ ] The DR drill is not overdue (`drillIsOverdue` is false).
- [ ] Release flags for this change are in their intended state — check, do not assume.
- [ ] Staged rollout: first slice, then watch.
- [ ] Health check green **and** the alert rules quiet for fifteen minutes before completing.
- [ ] After completion: the flag that gated this change is scheduled for removal.

### When a promotion fails

1. The pipeline rolls back the **release** automatically if `UBOSS_ROLLBACK_COMMAND` is configured.
   If it is not, the log says so as an error — roll back by hand, now.
2. **Leave the migration applied.** The previous version tolerates it.
3. If the data itself is wrong rather than the code, stop and read `DECISION_TREE` before touching
   anything. Its first branch exists for this exact moment: _a deploy broke the application but the
   data is intact ⇒ roll back the deploy, do not restore._ Restoring here would discard every change
   customers made since the backup, to fix a problem in code.
4. Record it. `RUNBOOK.md` §3 is the incident process.

---

## Deployment status and remaining checks

- **The local machine cannot run Docker.** Docker configuration parses, but image builds must be
  verified by the VPS on first deployment.
- **First deploy requires GitHub Actions secrets and the Hostinger VM ID variable** from the table.
- **DNS still needs to be changed** to point the root website and `www` to the VPS after the stack
  is ready; preserve all Google Workspace and Hostinger mail records.
- **A working journey has not yet been smoke-tested on the live host.** The health check proves the
  process answers; it does not prove login and product flows work.
- **No smoke-test suite against a deployed environment.** The health check proves the process
  answers; it does not prove a journey works. The staging checklist asks for that by hand until
  there is an environment to automate it against.
- **Do not treat a successful workflow dispatch as proof the site is healthy.** Check the Hostinger
  project containers and verify `https://ubossai.com`, `https://app.ubossai.com/login`, and
  `https://api.ubossai.com/health` after each first deploy.
