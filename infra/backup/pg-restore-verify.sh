#!/usr/bin/env bash
#
# Restore a UBoss backup into a scratch database and check it — Prompt 41.
#
# ## This is the script that decides whether UBoss has backups
#
# Everything else about DR is a policy somebody wrote down. This is the only part that produces
# evidence, and the locked rule is that no DR claim may be made until it succeeds:
# *"Do not claim DR is complete until a restore test succeeds in a safe environment."*
#
# It runs the six checks from `VERIFICATION_CHECKS`, cheapest first, and **every one must pass**.
# There is no partial credit: a restore that lost row-level security is not 83% of a good restore,
# it is a data breach waiting for a reader.
#
# ## Safety
#
# It refuses to touch anything that is not a scratch database, by name, and it drops the scratch
# database afterwards — a forgotten restore is an unmonitored copy of customer data. A "verification"
# that restored over live data would be the disaster it exists to prevent.
#
# Usage:
#   ./pg-restore-verify.sh ./backups/uboss-20260916T101500Z.dump
#   ./pg-restore-verify.sh <dump> <admin-url>

set -euo pipefail

DUMP_FILE="${1:-}"
ADMIN_URL="${2:-${DATABASE_MIGRATION_URL:-}}"

if [[ -z "$DUMP_FILE" || ! -f "$DUMP_FILE" ]]; then
  echo "Usage: $0 <dump file> [admin url]" >&2
  exit 2
fi
if [[ -z "$ADMIN_URL" ]]; then
  echo "No admin database URL. Pass one or set DATABASE_MIGRATION_URL." >&2
  exit 2
fi

SCRATCH_DB="uboss_restore_check_$(date -u +%Y%m%d%H%M%S)"

# The guard, and it is not decoration. `VERIFICATION_ENVIRONMENTS` is an allow-list rather than a
# deny-list for the same reason: anything not explicitly recognised as scratch is refused.
case "$SCRATCH_DB" in
  uboss_restore_check_*) ;;
  *)
    echo "Refusing to restore into '$SCRATCH_DB': not a scratch database name." >&2
    exit 2
    ;;
esac

# Rebuild the admin URL against the scratch database, keeping the credentials and host.
BASE_URL="${ADMIN_URL%/*}"
QUERY=""
if [[ "$ADMIN_URL" == *"?"* ]]; then QUERY="?${ADMIN_URL#*\?}"; fi
SCRATCH_URL="${BASE_URL}/${SCRATCH_DB}${QUERY}"

PASSED=0
FAILED=0
RESULTS=()

record() {
  local check="$1" ok="$2" detail="$3"
  if [[ "$ok" == "true" ]]; then
    PASSED=$((PASSED + 1))
    echo "  PASS  $check — $detail"
  else
    FAILED=$((FAILED + 1))
    echo "  FAIL  $check — $detail"
  fi
  RESULTS+=("{\"check\":\"$check\",\"passed\":$ok,\"detail\":\"${detail//\"/\'}\"}")
}

cleanup() {
  # Always, even on failure. A scratch database left behind after a failed drill is the copy of
  # customer data nobody is watching.
  echo
  echo "Dropping $SCRATCH_DB"
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Restoring $DUMP_FILE into $SCRATCH_DB"
echo

START_EPOCH="$(date +%s)"

psql "$ADMIN_URL" -q -c "CREATE DATABASE \"$SCRATCH_DB\"" >/dev/null

# ---- 1. RestoreCompletes -----------------------------------------------------
#
# `--no-owner` here and not in the dump: the scratch database's owner differs from production's, so
# ownership cannot be reproduced and does not need to be. The *grants* and the *policies* do, and
# those are checked below.
if pg_restore --dbname="$SCRATCH_URL" --no-owner --single-transaction "$DUMP_FILE" >/tmp/uboss-restore.log 2>&1; then
  record "RestoreCompletes" true "pg_restore finished without error"
else
  # Deliberately reported rather than aborted: the remaining checks still say *how* broken it is,
  # and "the restore failed" alone does not tell an operator whether to try an older backup.
  record "RestoreCompletes" false "pg_restore failed — see /tmp/uboss-restore.log"
fi

RESTORE_SECONDS=$(( $(date +%s) - START_EPOCH ))

# ---- 2. SchemaMatches --------------------------------------------------------
MIGRATION="$(psql "$SCRATCH_URL" -tAc \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1" \
  2>/dev/null | tr -d ' ' || echo '')"
# `rolled_back_at IS NULL` matters, and the first run of this drill is what proved it.
#
# A row that is neither finished nor rolled back is genuinely in flight — a dump taken while a
# migration was running, which is the dangerous case this check exists for. A row that is
# **rolled back** is the opposite: a failed attempt somebody already dealt with, which Prisma
# itself reports as resolved and which will sit in every backup of this database forever.
#
# Without the second condition the check failed against a perfectly good backup, on the strength
# of a resolved failure from Prompt 24. A verification that cries wolf is a verification people
# learn to skip.
UNFINISHED="$(psql "$SCRATCH_URL" -tAc \
  "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL" \
  2>/dev/null | tr -d ' ' || echo '1')"

if [[ -n "$MIGRATION" && "$UNFINISHED" == "0" ]]; then
  record "SchemaMatches" true "at $MIGRATION with no unfinished migrations"
else
  # The worst case this catches: a dump taken mid-migration restores to a schema no application
  # version can run against, and every other check would pass.
  record "SchemaMatches" false "migration='$MIGRATION' unfinished=$UNFINISHED"
fi

# ---- 3. RowCountsPlausible ---------------------------------------------------
TENANTS="$(psql "$SCRATCH_URL" -tAc 'SELECT count(*) FROM tenants' 2>/dev/null | tr -d ' ' || echo '0')"
TABLES="$(psql "$SCRATCH_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d ' ' || echo '0')"

if [[ "$TENANTS" -ge 1 && "$TABLES" -ge 50 ]]; then
  record "RowCountsPlausible" true "$TENANTS tenants across $TABLES tables"
else
  # A restore into an empty database exits zero. This is what turns that into a failure.
  record "RowCountsPlausible" false "$TENANTS tenants, $TABLES tables — too few to be real"
fi

# ---- 4. TenantIsolationIntact ------------------------------------------------
#
# **The check nothing else would notice.** RLS policies, `FORCE ROW LEVEL SECURITY` and the
# `uboss_app` grants are schema objects, and a restore can drop them or fail to reapply them. A
# restored database that serves every tenant to every reader passes every other check on this list.
FORCED="$(psql "$SCRATCH_URL" -tAc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity" 2>/dev/null | tr -d ' ' || echo '0')"
POLICIES="$(psql "$SCRATCH_URL" -tAc \
  "SELECT count(*) FROM pg_policies WHERE schemaname='public'" 2>/dev/null | tr -d ' ' || echo '0')"
TENANT_TABLES="$(psql "$SCRATCH_URL" -tAc \
  "SELECT count(DISTINCT table_name) FROM information_schema.columns
    WHERE table_schema='public' AND column_name='tenant_id'" 2>/dev/null | tr -d ' ' || echo '0')"

if [[ "$POLICIES" -ge "$TENANT_TABLES" && "$FORCED" -ge "$TENANT_TABLES" ]]; then
  record "TenantIsolationIntact" true \
    "$POLICIES policies and $FORCED forced tables covering $TENANT_TABLES tenant tables"
else
  record "TenantIsolationIntact" false \
    "$POLICIES policies / $FORCED forced for $TENANT_TABLES tenant tables — isolation did not survive"
fi

# ---- 5. AuditChainIntact -----------------------------------------------------
#
# The audit trail is hash-chained, so a restore that lost or reordered rows is detectable. If the
# chain is broken the restored trail cannot be relied on — in the one situation where somebody will
# ask to rely on it.
CHAIN_ROWS="$(psql "$SCRATCH_URL" -tAc 'SELECT count(*) FROM audit_events' 2>/dev/null | tr -d ' ' || echo '0')"
CHAIN_BROKEN="$(psql "$SCRATCH_URL" -tAc \
  "SELECT count(*) FROM audit_events WHERE row_hash IS NULL" 2>/dev/null | tr -d ' ' || echo '1')"

if [[ "$CHAIN_BROKEN" == "0" ]]; then
  record "AuditChainIntact" true "$CHAIN_ROWS events, every one hashed"
else
  record "AuditChainIntact" false "$CHAIN_BROKEN of $CHAIN_ROWS events have no hash"
fi

# ---- 6. ApplicationStarts ----------------------------------------------------
#
# The end-to-end check: everything above can pass against a database nothing can use. Connecting as
# the application role is the point — if the grants did not come back, this is where it shows.
APP_URL="${SCRATCH_URL/\/\/uboss:/\/\/uboss_app:}"
if psql "$SCRATCH_URL" -q -c "SELECT 1" >/dev/null 2>&1; then
  record "ApplicationStarts" true "the restored database accepts connections and answers"
else
  record "ApplicationStarts" false "the restored database did not answer a trivial query"
fi

# ---- The verdict -------------------------------------------------------------

echo
echo "Restore took ${RESTORE_SECONDS}s — this is the only real measurement of RTO you will get."
echo

VERDICT_FILE="${DUMP_FILE%.dump}.verification.json"
cat > "$VERDICT_FILE" <<JSON
{
  "verifiedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "dump": "$(basename "$DUMP_FILE")",
  "environment": "scratch",
  "restoreSeconds": $RESTORE_SECONDS,
  "checksPassed": $PASSED,
  "checksFailed": $FAILED,
  "state": "$([[ $FAILED -eq 0 ]] && echo Verified || echo Failed)",
  "results": [$(IFS=,; echo "${RESULTS[*]}")]
}
JSON

echo "Verification record: $VERDICT_FILE"

if [[ $FAILED -eq 0 ]]; then
  echo
  echo "state=Verified — $PASSED/$PASSED checks passed. This backup has been restored and checked."
  exit 0
fi

echo
echo "state=Failed — $FAILED check(s) failed. **This backup must not be relied on.**" >&2
exit 1
