import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * Prisma 7 removed `url` from the schema's `datasource` block: the CLI reads the connection
 * string from here, and the runtime client is constructed with a driver adapter instead
 * (see `src/persistence/prisma.service.ts`). One consequence worth knowing — the schema file
 * no longer contains a connection string at all, so it is safe to read and share.
 *
 * Prisma 7 also no longer auto-loads `.env`, so this file loads it explicitly.
 */

// Node 24 can read a dotenv file without a dependency. Absent in CI, where the environment
// supplies DATABASE_URL directly, so a missing file is not an error.
try {
  process.loadEnvFile();
} catch {
  // No local .env file; rely on the ambient environment.
}

/**
 * Falls back to the local `infra/docker-compose.yml` database.
 *
 * `prisma generate` loads this config too, and it must work on a fresh clone that has no `.env`
 * yet — otherwise `npm run typecheck` fails before anyone can run the setup steps. These local
 * credentials are already in the compose file and are not secrets; CI and every real
 * environment set DATABASE_URL explicitly.
 */
const LOCAL_FALLBACK_DATABASE_URL =
  'postgresql://uboss:uboss_local_dev@localhost:5442/uboss_dev?schema=public';

// Migrations and seeds need the OWNER role: the application's role is deliberately
// unprivileged so Row-Level Security applies to it, and cannot alter the schema.
const databaseUrl =
  process.env['DATABASE_MIGRATION_URL'] ??
  process.env['DATABASE_URL'] ??
  LOCAL_FALLBACK_DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Seed runs on compiled output so it uses exactly the code path the app uses.
    seed: 'node --enable-source-maps dist-scripts/prisma/seed.js',
  },
  datasource: {
    url: databaseUrl,
    // A scratch database Prisma replays the migration history into, so
    // `migrate diff --from-migrations` can compute a NEW migration against a clean baseline
    // rather than against whatever state the development database happens to be in.
    //
    // Getting this wrong at Prompt 7 produced a migration full of `DROP COLUMN` / `DROP INDEX`
    // rename statements: it had been diffed against a development database that already held a
    // half-applied version, so it applied there and nowhere else. Diffing from the migration
    // history is the only way to get a migration that also works on an empty database.
    shadowDatabaseUrl:
      process.env['SHADOW_DATABASE_URL'] ??
      'postgresql://uboss:uboss_local_dev@localhost:5442/uboss_shadow?schema=public',
  },
});
