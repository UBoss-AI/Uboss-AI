#!/usr/bin/env bash
#
# Take a backup on a clock, and prove one of them restores.
#
# ## Why a loop and not cron
#
# One container, one job, one schedule. A cron daemon inside a container adds a second process to
# supervise, its own log destination and a class of failure — the daemon running while the job's
# environment is not what the container was given — that a `while` loop simply does not have. The
# cost is that a restart shifts the schedule, which for a daily backup is not a cost.
#
# ## Taken is not the same as verified
#
# `pg-backup.sh` says so itself: it writes `"state": "Taken"` and prints that nothing has proved
# the file is readable. So this restores one, weekly, into a scratch database and throws it away.
# A backup nobody has ever restored is a belief, not a backup — and the failure it hides is the
# one you find out about on the day you need it.
#
# ## What it will not do
#
# It does not ship anything off this host. Off-host copying is a decision about where a company's
# data may live, and `infra/backup/object-storage-policy.md` is where that decision belongs. A
# script that quietly uploaded a database dump somewhere would be making that decision silently.
set -euo pipefail

INTERVAL_SECONDS="${UBOSS_BACKUP_INTERVAL_SECONDS:-86400}"
KEEP_DAYS="${UBOSS_BACKUP_KEEP_DAYS:-14}"
VERIFY_EVERY="${UBOSS_BACKUP_VERIFY_EVERY:-7}"
OUT_DIR="${UBOSS_BACKUP_DIR:-/backups}"

if [[ -z "${DATABASE_MIGRATION_URL:-}" ]]; then
  echo "No DATABASE_MIGRATION_URL. The dump must be taken as the owner role, never as uboss_app." >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
echo "Backups to $OUT_DIR every ${INTERVAL_SECONDS}s, keeping ${KEEP_DAYS} days, verifying every ${VERIFY_EVERY} runs."

run=0
while true; do
  run=$((run + 1))
  echo
  echo "=== backup run ${run} at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

  # A failed backup must not kill the loop: tomorrow's attempt is the thing most likely to
  # succeed, and a container that exited last week is a container nobody noticed.
  if pg-backup.sh "$DATABASE_MIGRATION_URL" "$OUT_DIR"; then
    echo "backup ok"
  else
    echo "BACKUP FAILED (run ${run}) — the next run will try again." >&2
  fi

  if (( run % VERIFY_EVERY == 1 )); then
    newest="$(ls -1t "$OUT_DIR"/uboss-*.dump 2>/dev/null | head -n 1 || true)"
    if [[ -n "$newest" ]]; then
      echo "verifying ${newest}"
      if pg-restore-verify.sh "$newest" "$DATABASE_MIGRATION_URL"; then
        echo "restore verified"
      else
        echo "RESTORE VERIFICATION FAILED for ${newest} — the backups are not proven." >&2
      fi
    fi
  fi

  # Retention. Manifests go with their dumps: a manifest whose dump is gone describes nothing,
  # and a dump whose manifest is gone is a file of unknown provenance.
  find "$OUT_DIR" -name 'uboss-*.dump' -mtime "+${KEEP_DAYS}" -print -delete || true
  find "$OUT_DIR" -name 'uboss-*.manifest.json' -mtime "+${KEEP_DAYS}" -print -delete || true

  sleep "$INTERVAL_SECONDS"
done
