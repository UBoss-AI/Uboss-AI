# Point-in-time recovery: the configuration to apply

Prompt 41 asks for "PostgreSQL automated backup + PITR configuration/documentation". The backup half
is `pg-backup.sh` and it runs. **This half is configuration for the host PostgreSQL, and this build
has not enabled it** — one container, no archive destination. Everything below is what to apply, and
what changes once it is applied.

It is written out rather than left as "configure archiving" because the gap it closes is the
expensive one. `pg-backup.sh` takes a logical dump; a dump gets you back to the moment it was taken
and no other moment. The decision tree's second branch — _a migration destroyed data, recover to
just before it_ — is the case where that is not good enough, and it is also the likeliest real
disaster in a system that ships migrations. Until archiving is on, that branch is unavailable and
the honest fallback is the last dump.

Like the object-store policy, **the application cannot see whether any of this has been applied.**
`DEPLOYMENT_RESPONSIBILITIES` says so in the API for the same reason it is said here.

---

## 1. The server settings

In `postgresql.conf` on the primary. All four need a restart except `archive_command`, which is
`SIGHUP`.

```conf
# Enough detail in the WAL to replay to an arbitrary point.
wal_level = replica

# Turn archiving on. `archive_mode = on` needs a restart; the command does not.
archive_mode = on

# Copy each completed WAL segment somewhere durable. %p is the path, %f the filename.
# It MUST refuse to overwrite: a silently clobbered segment is an unrecoverable hole in the
# timeline that nothing notices until a restore needs it.
archive_command = 'test ! -f /var/lib/postgresql/wal_archive/%f && cp %p /var/lib/postgresql/wal_archive/%f'

# How long to wait before archiving a partial segment. Bounds the worst-case data loss on a
# quiet system, where a segment might otherwise sit unfilled for hours.
archive_timeout = 300

# Keep enough WAL on the primary that a briefly disconnected standby can catch up without
# falling back to the archive.
wal_keep_size = 1GB
```

`archive_timeout = 300` is the setting that ties to the RPO. A five-minute timeout means the worst
case on an idle system is five minutes of writes, which is inside the Standard tier's RPO and
outside nothing. Tighten it for a tier that promises less; do not tighten it below a minute, because
every timeout writes a full segment whether or not it is full.

### The archive destination

A local directory is shown above because it is the smallest thing that works and it is wrong for
production: **an archive on the same host as the database is not a backup.** Use object storage.

```conf
archive_command = 'aws s3 cp %p s3://uboss-wal-archive/%f --only-show-errors'
```

That bucket needs the same policy as the content bucket — versioning on, cross-region replication,
and a lifecycle that does not expire segments younger than the oldest base backup you still intend
to restore. See `object-storage-policy.md`; the reasoning is identical and the consequence of
getting the lifecycle wrong is worse, because an expired WAL segment breaks the chain and every
point after it becomes unreachable.

---

## 2. The base backup

PITR replays WAL **on top of a base backup**. Without one the archive is unusable, so the two are a
pair and a schedule that takes one without the other is a schedule that recovers nothing.

```bash
pg_basebackup \
  --pgdata=/backups/base-$(date -u +%Y%m%dT%H%M%SZ) \
  --format=tar --gzip --wal-method=stream \
  --checkpoint=fast --progress \
  --username=uboss --host=$PGHOST
```

`--wal-method=stream` matters: it streams the WAL generated _during_ the backup alongside it, so the
base backup is self-consistent and restorable on its own even if the archive has a gap at that
moment.

Take one weekly, and take one **immediately before any migration you would not want to replay
through**. The second is cheap insurance against exactly the case the decision tree names.

Note which role: `uboss` — the owner. `pg_basebackup` is a physical copy so `NOBYPASSRLS` does not
silently empty it the way it empties a logical dump (S-332), but the role still needs
`REPLICATION`, and using the application role here would fail outright rather than quietly.

---

## 3. Recovering to a point in time

1. **Stop the server.** Do not attempt this against a running primary.
2. Move the damaged data directory aside. Do not delete it — it is evidence, and if the recovery
   target is wrong you will want another attempt.
3. Restore the most recent base backup taken _before_ the target time.
4. In the restored data directory, create `recovery.signal` (an empty file) and set:

```conf
restore_command = 'cp /var/lib/postgresql/wal_archive/%f %p'
recovery_target_time = '2026-09-12 04:20:00+00'

# Stop *before* the target rather than after it. When the target is "just before the migration",
# `inclusive` would replay the transaction you are trying to escape.
recovery_target_inclusive = off

# Pause rather than promote, so somebody can look before the timeline forks.
recovery_target_action = 'pause'
```

5. Start the server. It replays to the target and pauses.
6. **Look before promoting.** Connect and check the thing you came for — the table that was dropped,
   the rows that were overwritten. This is the step people skip and it is the only one that cannot
   be undone: `pg_wal_replay_resume()` and a promotion fork the timeline, and getting back means
   starting from step 1.
7. When satisfied: `SELECT pg_promote();`

### Choosing the target

`recovery_target_time` is the usual choice and the least precise. Two others are better when you
have them:

- `recovery_target_lsn` — exact, when you can read the LSN out of the logs.
- `recovery_target_xid` — exact, when you know the transaction. A migration runs in one, and
  `_prisma_migrations` records `started_at`, which gets you close enough to find it.

---

## 4. What changes once this is on

**The drill.** `pg-restore-verify.sh` verifies a logical dump, which is the right check for the
backup this build takes. A PITR-capable deployment needs a second drill that restores a base backup,
replays to a chosen point and asserts the database stopped where it was told to. Until that drill
has run, PITR is documented and not proven — and the same rule applies as everywhere else in this
prompt: **a recovery path nobody has exercised is a belief, not a capability.**

**The decision tree.** Branch 2 becomes available. Nothing else in the tree changes.

**The RPO.** It stops being "since the last dump" and becomes "since the last archived segment",
bounded by `archive_timeout`. That is the change that makes the tier targets in
`DEFAULT_RECOVERY_TARGETS` achievable rather than aspirational — worth saying plainly, because a
documented RPO the deployment cannot actually meet is worse than no number at all.

**What does not change.** A restored database is still unreadable without the keys that encrypted
its secrets (S-335), and the object store still has to be recovered alongside it. PITR recovers
PostgreSQL. It does not recover a company.
