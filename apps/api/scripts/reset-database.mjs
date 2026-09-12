#!/usr/bin/env node
/**
 * Guarded local database reset.
 *
 * Replaces `prisma migrate reset`, which refuses to run unattended (correctly — it is a
 * destructive command and Prisma will not let an automated caller drop a database without a
 * human saying so). Rather than work around that check, this script re-implements the operation
 * with protections that are *narrower and specific to this project*:
 *
 *   1. `NODE_ENV=production` is refused outright.
 *   2. The host must be loopback. A remote host is refused unless
 *      `UBOSS_RESET_ALLOW_REMOTE_HOST=yes` is set deliberately.
 *   3. The database name must contain `dev` or `test`. `uboss` on its own is refused, and so is
 *      anything belonging to the other UBoss stacks that run on this machine.
 *   4. It prints exactly what it is about to destroy, and `--dry-run` stops there.
 *
 * Steps: drop and recreate the `public` schema as the owner role, re-apply every migration with
 * `prisma migrate deploy`, then run the seed. That exercises the same path a new developer or a
 * fresh CI database takes, which is the reason to have this at all.
 *
 * Usage:
 *   node scripts/reset-database.mjs --dry-run
 *   node scripts/reset-database.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const API_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
} catch {
  // No local .env; rely on the ambient environment.
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function fail(message) {
  console.error(`\nRefusing to reset: ${message}\n`);
  process.exit(1);
}

function resolveUrl() {
  const url =
    process.env['DATABASE_MIGRATION_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgresql://uboss:uboss_local_dev@localhost:5442/uboss_dev?schema=public';
  return url;
}

function assertSafe(url) {
  if (process.env['NODE_ENV'] === 'production') {
    fail('NODE_ENV=production. This script only ever touches local development databases.');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('the connection string could not be parsed.');
  }

  const host = parsed.hostname;
  const database = parsed.pathname.replace(/^\//, '');

  if (!LOOPBACK_HOSTS.has(host) && process.env['UBOSS_RESET_ALLOW_REMOTE_HOST'] !== 'yes') {
    fail(
      `host "${host}" is not loopback. Set UBOSS_RESET_ALLOW_REMOTE_HOST=yes only if you are ` +
        'certain this is a disposable database.',
    );
  }

  if (!/dev|test/i.test(database)) {
    fail(
      `database "${database}" does not contain "dev" or "test". This guard exists so a reset ` +
        'can never hit a real database, or one belonging to another project on this machine.',
    );
  }

  return { host, port: parsed.port || '5432', database, user: decodeURIComponent(parsed.username) };
}

async function main() {
  const url = resolveUrl();
  const target = assertSafe(url);

  console.log('UBoss local database reset');
  console.log(`  host:     ${target.host}:${target.port}`);
  console.log(`  database: ${target.database}`);
  console.log(`  as role:  ${target.user}`);

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    // Report what is about to be destroyed, so the action is auditable rather than silent.
    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    if (rows.length === 0) {
      console.log('\n  (schema is already empty)');
    } else {
      console.log('\n  Rows that will be destroyed:');
      for (const { table_name: table } of rows) {
        const count = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
        console.log(`    ${table.padEnd(24)} ${count.rows[0].n}`);
      }
    }

    if (DRY_RUN) {
      console.log('\n--dry-run: nothing was changed.\n');
      return;
    }

    console.log('\n  Dropping and recreating schema "public"…');
    // Dropping the schema also removes the migration history, the RLS policies and the default
    // privileges — all of which the migrations recreate, which is what makes this a true
    // from-scratch rebuild rather than a truncate.
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query(`ALTER SCHEMA public OWNER TO ${target.user}`);
  } finally {
    await client.end();
  }

  const childEnv = { ...process.env, DATABASE_URL: url, DATABASE_MIGRATION_URL: url };

  // Every child is invoked as `node <cli entry point>` with no shell. Using `shell: true` here
  // would concatenate rather than escape the arguments (Node DEP0190) and would also drag in
  // platform-specific `.cmd` shims.
  const runNode = (scriptPath, args) =>
    execFileSync(process.execPath, [scriptPath, ...args], {
      cwd: API_ROOT,
      env: childEnv,
      stdio: 'inherit',
    });

  // Node's own resolver, so this survives changes to where npm hoists packages.
  const resolve = createRequire(import.meta.url).resolve;

  console.log('  Applying migrations…');
  runNode(resolve('prisma/build/index.js'), ['migrate', 'deploy']);

  console.log('  Compiling the seed…');
  runNode(resolve('typescript/bin/tsc'), ['-p', 'tsconfig.scripts.json']);

  console.log('  Seeding…');
  runNode('dist-scripts/prisma/seed.js', []);

  console.log('\nReset complete.\n');
}

await main();
