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
# Seeding must never stop the product from serving.
#
# These two fill the model and Skill catalogues, without which AI cannot be routed. They are
# worth running on every start — but they are not worth the site for. `set -e` is on, and the
# gateway will not start until the API reports healthy, so a seed that throws took down *every*
# host on this VPS, including the marketing pages that need no API at all. That is what happened
# the first time they shipped.
#
# So a failure here is loud and survivable: the log says what broke, the API starts anyway, and
# the catalogue can be seeded again by hand. A product that is up with no models beats a product
# that is down.
seed() {
  if node "$@"; then
    return 0
  fi
  echo "WARNING: seeding failed ($*). The API is starting without it; AI routing may be" >&2
  echo "         unavailable until this is run again. This is not fatal by design." >&2
  return 0
}

seed scripts/seed-model-catalogue.mjs
# `--only-if-empty`: the import is four hundred transactions, and paying that on every restart
# would add tens of seconds to the API coming back. Updating it is a deliberate run without it.
seed scripts/import-skill-catalog.mjs data/skill-catalog.xlsx --only-if-empty

exec node --enable-source-maps dist/main.js
