#!/usr/bin/env bash
#
# Take a UBoss PostgreSQL backup — Prompt 41.
#
# ## What this does, and what it deliberately does not
#
# It takes a **logical dump** (`pg_dump -Fc`) and records a manifest beside it. That is the backup
# kind that survives a major-version upgrade and a corrupted cluster, and it is the only one that
# can be restored into a *different* PostgreSQL — which is exactly the situation where a physical
# backup cannot help you.
#
# It does **not** configure continuous archiving. `archive_mode`, `archive_command` and off-host
# shipping are PostgreSQL and host configuration, set where UBoss runs; see
# `docs/RUNBOOK.md` §11 and `DEPLOYMENT_RESPONSIBILITIES`. A script that pretended to set them up
# would produce a green check for something nobody had configured.
#
# ## Why the manifest matters more than the dump
#
# A dump with no manifest is a file of unknown provenance. The manifest records the database, the
# server version, the migration the schema was at, the byte size and a SHA-256 — so a restore can
# say *which* backup it restored and prove it got the same bytes. The migration name is the field
# that catches the worst case: a dump taken mid-migration restores to a schema no application
# version can run against, and it looks perfectly healthy until the first query.
#
# Usage:
#   ./pg-backup.sh                      # uses DATABASE_MIGRATION_URL
#   ./pg-backup.sh postgres://…  ./out  # explicit source and destination

set -euo pipefail

SOURCE_URL="${1:-${DATABASE_MIGRATION_URL:-}}"
OUT_DIR="${2:-${UBOSS_BACKUP_DIR:-./backups}}"

if [[ -z "$SOURCE_URL" ]]; then
  echo "No source database. Pass a URL or set DATABASE_MIGRATION_URL." >&2
  exit 2
fi

# Never dump *as* the application role: `uboss_app` is NOBYPASSRLS, so a dump taken as that role
# would silently omit every tenant row it cannot see. A backup that restores to an empty database
# is the single worst failure this script could have, and it would exit zero.
if [[ "$SOURCE_URL" == *"uboss_app"* ]]; then
  echo "Refusing to dump as uboss_app: row-level security would silently omit tenant data." >&2
  echo "Use the owner role (DATABASE_MIGRATION_URL)." >&2
  exit 2
fi

mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="$OUT_DIR/uboss-$STAMP.dump"
MANIFEST_FILE="$OUT_DIR/uboss-$STAMP.manifest.json"

echo "Taking a logical dump to $DUMP_FILE"

# `-Fc` (custom format): compressed, and restorable selectively — which is what makes the
# per-tenant recovery case in the decision tree possible at all.
# `--no-owner --no-privileges` are deliberately NOT passed: the grants and the RLS policies are
# part of what has to come back, and a restore that lost them would serve every tenant to every
# reader while passing every other check.
pg_dump --format=custom --file="$DUMP_FILE" "$SOURCE_URL"

SIZE_BYTES="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
SHA256="$(sha256sum "$DUMP_FILE" | cut -d' ' -f1)"
SERVER_VERSION="$(psql "$SOURCE_URL" -tAc 'SHOW server_version' | tr -d ' ')"

# The migration the schema was at. The field that catches a dump taken mid-migration.
LAST_MIGRATION="$(psql "$SOURCE_URL" -tAc \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1" \
  2>/dev/null | tr -d ' ' || echo 'unknown')"

# A dump of an empty database succeeds and exits zero. Counting a table that must never be empty
# is what turns that into a failure here rather than a discovery during a recovery.
TENANT_COUNT="$(psql "$SOURCE_URL" -tAc 'SELECT count(*) FROM tenants' 2>/dev/null | tr -d ' ' || echo '0')"

cat > "$MANIFEST_FILE" <<JSON
{
  "kind": "LogicalDump",
  "takenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "file": "$(basename "$DUMP_FILE")",
  "sizeBytes": $SIZE_BYTES,
  "sha256": "$SHA256",
  "serverVersion": "$SERVER_VERSION",
  "lastMigration": "$LAST_MIGRATION",
  "tenantCount": $TENANT_COUNT,
  "state": "Taken",
  "note": "Taken, never restored. A backup becomes Verified only when pg-restore-verify.sh succeeds against it."
}
JSON

echo "Manifest: $MANIFEST_FILE"
echo "  size=$SIZE_BYTES sha256=${SHA256:0:16}… migration=$LAST_MIGRATION tenants=$TENANT_COUNT"

if [[ "$SIZE_BYTES" -lt 1024 ]]; then
  echo "REFUSING: the dump is under 1 KB, which means it dumped nothing." >&2
  exit 1
fi

# **The state is `Taken`, not `Verified`.** Said here so nobody reading the script's output
# concludes otherwise: this has produced a file, and nothing has yet proved the file is readable.
echo
echo "state=Taken — NOT verified. Run pg-restore-verify.sh to make this a backup you can rely on."
