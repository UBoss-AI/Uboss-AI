# Deployment architecture and the promotion checklist

Prompt 44. How a commit becomes production, and what has to be true at each step.

## The honest frame, first

**Nothing here has deployed anything.** The pipeline, the order of operations, the gates and the
rollback are real and are in the repository. The _host_ is not chosen, so there is no cluster, no
registry and no URL — and every step that would run a host command checks for
`UBOSS_DEPLOY_COMMAND` and **says plainly that it did nothing** when it is absent.

That guard is deliberate and is the most important line in `.github/actions/promote/action.yml`. A
pipeline that printed "deployed to production" while running nothing is the single most dangerous
thing this work could produce, and it is the easiest thing to write by accident.

So: UBoss has a promotion _process_ that is defined and testable. It does not yet have a
_deployment_. Both halves of that sentence matter.

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
| `UBOSS_DEPLOY_COMMAND`   | variable | The host's own deploy command. Absent ⇒ nothing is released and the log says so.           |
| `UBOSS_ROLLBACK_COMMAND` | variable | The host's own rollback. Absent ⇒ manual rollback, loudly.                                 |
| `UBOSS_HEALTH_URL`       | variable | Checked after release. Absent ⇒ release unverified, and the log says so.                   |
| `UBOSS_ENVIRONMENT_URL`  | variable | Shown on the GitHub deployment.                                                            |

`.env.example` at each workspace root documents the shape. The real `.env` is git-ignored and holds
live local credentials — `git check-ignore` confirms it, and the secret scan in CI runs over history
rather than the working tree, because a secret removed in a later commit was still published.

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

- [ ] **Two reviewers**, one of whom did not write the change.
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

## What is not built

- **No container image and no registry.** `image/container scan if applicable` in the prompt is not
  applicable yet, and a scan step that scanned nothing would be worse than its absence.
- **No host.** The deploy and rollback commands are per-environment variables precisely so choosing
  a host later is configuration rather than a rewrite.
- **No smoke-test suite against a deployed environment.** The health check proves the process
  answers; it does not prove a journey works. The staging checklist asks for that by hand until
  there is an environment to automate it against.
- **Nothing has run.** The workflows are syntactically valid and their steps are the real commands,
  but no GitHub Actions run has executed them. The first push of this branch is the first time they
  will.
