#!/usr/bin/env bash
#
# The quarterly DR drill, as one command — Prompt 41.
#
# ## Why a wrapper exists at all
#
# Because a drill that is three commands in the right order is a drill somebody eventually runs as
# two. This takes a backup, verifies it by restoring into a scratch database, checks that the
# encryption keys are recoverable, and writes one record saying what happened — which is the thing a
# quarterly review actually needs.
#
# It walks `DRILL_STEPS` in order and **records evidence for each**, because a checklist whose steps
# are ticked without evidence is a checklist that gets ticked.
#
# ## What a pass means, and what it does not
#
# A pass means: a backup taken from this database was restored into a fresh one, and six checks
# found the schema, the data, row-level security, the audit chain and the application all intact.
#
# It does **not** mean UBoss is disaster-recovery ready. It says nothing about WAL archiving,
# cross-region replication, object-store recovery or DNS failover, none of which this application
# can see. See `docs/RUNBOOK.md` §10 and `DEPLOYMENT_RESPONSIBILITIES`.
#
# Usage:
#   ./dr-drill.sh                       # uses DATABASE_MIGRATION_URL
#   ./dr-drill.sh <url> <out-dir>

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_URL="${1:-${DATABASE_MIGRATION_URL:-}}"
OUT_DIR="${2:-${UBOSS_BACKUP_DIR:-./backups}}"

if [[ -z "$SOURCE_URL" ]]; then
  echo "No source database. Pass a URL or set DATABASE_MIGRATION_URL." >&2
  exit 2
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_EPOCH="$(date +%s)"
STEPS=()

step() {
  local key="$1" ok="$2" evidence="$3"
  STEPS+=("{\"step\":\"$key\",\"passed\":$ok,\"evidence\":\"${evidence//\"/\'}\"}")
  if [[ "$ok" == "true" ]]; then
    echo "  ✓ $key — $evidence"
  else
    echo "  ✗ $key — $evidence"
  fi
}

echo "DR drill starting at $STARTED_AT"
echo

# ---- 1. ChooseBackup / 2. take it -------------------------------------------
echo "Taking a fresh backup"
if BACKUP_OUT="$(bash "$HERE/pg-backup.sh" "$SOURCE_URL" "$OUT_DIR" 2>&1)"; then
  DUMP="$(echo "$BACKUP_OUT" | grep -oE '[^ ]+\.dump' | head -1)"
  step "ChooseBackup" true "took $(basename "$DUMP")"
else
  echo "$BACKUP_OUT" >&2
  step "ChooseBackup" false "the backup itself failed"
  DUMP=""
fi

# ---- 3. ProvisionScratch / 4. Restore / 5. Verify ---------------------------
#
# All three happen inside pg-restore-verify.sh, which owns the scratch database's whole life —
# creating it, restoring into it and dropping it. Splitting them across scripts would mean a failure
# between two of them left the scratch database behind.
VERIFY_OK=false
RESTORE_SECONDS=0
if [[ -n "$DUMP" ]]; then
  echo
  echo "Restoring and verifying"
  if VERIFY_OUT="$(bash "$HERE/pg-restore-verify.sh" "$DUMP" "$SOURCE_URL" 2>&1)"; then
    VERIFY_OK=true
  fi
  echo "$VERIFY_OUT" | sed 's/^/  /'
  RESTORE_SECONDS="$(echo "$VERIFY_OUT" | grep -oE 'Restore took [0-9]+s' | grep -oE '[0-9]+' || echo 0)"

  step "ProvisionScratch" true "created and dropped by the verifier"
  step "Restore" "$VERIFY_OK" "restore took ${RESTORE_SECONDS}s"
  step "Verify" "$VERIFY_OK" "$(echo "$VERIFY_OUT" | grep -cE '^  PASS' || echo 0)/6 checks passed"
else
  step "ProvisionScratch" false "skipped — no backup to restore"
  step "Restore" false "skipped"
  step "Verify" false "skipped"
fi

# ---- 6. CheckKeys ------------------------------------------------------------
#
# The step that separates "the objectives came back" from "the company can work again". A restored
# database is unreadable without the keys that encrypted its secrets, and key recovery is not part
# of a database restore — so a drill that skipped this would pass while leaving every integration
# dead.
if [[ -n "${AUTH_ENCRYPTION_KEYS:-}" ]]; then
  KEY_COUNT="$(echo "$AUTH_ENCRYPTION_KEYS" | tr ',' '\n' | grep -c ':' || echo 0)"
  step "CheckKeys" true "$KEY_COUNT encryption key(s) available to this environment"
else
  # Not a warning. Without the keys a recovery restores objectives and loses every connection and
  # provider credential, which is a failed recovery wearing a success message.
  step "CheckKeys" false \
    "AUTH_ENCRYPTION_KEYS is not set — a restore here would recover data and no integrations"
fi

# ---- 7. TearDown -------------------------------------------------------------
LEFTOVER="$(psql "$SOURCE_URL" -tAc \
  "SELECT count(*) FROM pg_database WHERE datname LIKE 'uboss_restore_check_%'" 2>/dev/null | tr -d ' ' || echo '?')"
if [[ "$LEFTOVER" == "0" ]]; then
  step "TearDown" true "no scratch databases remain"
else
  step "TearDown" false "$LEFTOVER scratch database(s) left behind — an unmonitored copy of customer data"
fi

# ---- 8. Record ---------------------------------------------------------------
ELAPSED=$(( $(date +%s) - START_EPOCH ))
PASSED_ALL=true
for entry in "${STEPS[@]}"; do
  [[ "$entry" == *'"passed":false'* ]] && PASSED_ALL=false
done

RECORD="$OUT_DIR/drill-$(date -u +%Y%m%dT%H%M%SZ).json"
mkdir -p "$OUT_DIR"
cat > "$RECORD" <<JSON
{
  "startedAt": "$STARTED_AT",
  "elapsedSeconds": $ELAPSED,
  "measuredRestoreSeconds": $RESTORE_SECONDS,
  "passed": $PASSED_ALL,
  "steps": [$(IFS=,; echo "${STEPS[*]}")],
  "claim": "A pass means a backup taken from this database was restored into a fresh one and six checks found it intact. It does not mean disaster recovery is ready: archiving, replication, object-store recovery and DNS failover are configured outside this application."
}
JSON

echo
echo "Drill record: $RECORD"
echo "Measured restore time: ${RESTORE_SECONDS}s — compare against the RTO target for the tier."

if [[ "$PASSED_ALL" == "true" ]]; then
  echo
  echo "DRILL PASSED. Record the date; the next one is due in 90 days."
  exit 0
fi

echo
echo "DRILL FAILED. **Do not record UBoss as recoverable.** Fix what failed and run it again." >&2
exit 1
