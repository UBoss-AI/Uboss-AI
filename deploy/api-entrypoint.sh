#!/bin/sh
set -eu

: "${POSTGRES_PASSWORD:?Missing database owner password}"
: "${APP_DB_PASSWORD:?Missing application database password}"

# Compose passes passwords as values. URL-encode them here so punctuation cannot
# change the host, port, or database parsed by Prisma. Never print the URLs.
encode_password() {
  PASSWORD_ENV_NAME="$1" node -e "process.stdout.write(encodeURIComponent(process.env[process.env.PASSWORD_ENV_NAME]).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()))"
}

DATABASE_MIGRATION_URL="postgresql://uboss:$(encode_password POSTGRES_PASSWORD)@postgres:5432/uboss_prod?schema=public"
DATABASE_URL="postgresql://uboss_app:$(encode_password APP_DB_PASSWORD)@postgres:5432/uboss_prod?schema=public"
export DATABASE_MIGRATION_URL DATABASE_URL
unset POSTGRES_PASSWORD APP_DB_PASSWORD

cd /workspace/apps/api
../../node_modules/.bin/prisma migrate deploy
node scripts/bootstrap-platform-owner.mjs
exec node --enable-source-maps dist/main.js
