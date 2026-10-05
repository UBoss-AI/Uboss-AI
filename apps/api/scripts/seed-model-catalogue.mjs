/*
 * Give a deployment a model catalogue, so AI can actually run on it.
 *
 * ## The gap this closes
 *
 * `ANTHROPIC_API_KEY` is a credential. It says who may call the provider and nothing about
 * **which model answers which kind of work** — that lives in `provider_profiles`,
 * `provider_models` and `logical_model_routes`, and no migration creates them. A freshly deployed
 * database has all three empty, and every model call fails with "No model is configured for
 * OBJECTIVE_PLANNER" whatever the key is.
 *
 * ## Why it does not boot the application
 *
 * It did, through `NestFactory.createApplicationContext(AppModule)`, so that writes could go
 * through `ProviderService` exactly as the Providers & Models screen does. That was the better
 * shape and the wrong thing to run at boot: `AppModule` starts the BullMQ worker, the schedulers
 * and every other module, inside the entrypoint, *before* the API is allowed to listen. The first
 * deployment that included it never became healthy — and because the gateway will not start until
 * the API is healthy, **every host on the VPS went down**, including pages that need no API.
 *
 * So it writes with a direct Prisma client and sets `app.platform_operation` inside each
 * transaction, which is the pattern `import-skill-catalog.mjs` already uses for the same reason.
 * Nothing is started, nothing listens, and the process exits in about a second.
 *
 * The rows it writes are the ones the screen would write. What is lost is that service's
 * validation, so the shapes here are kept deliberately literal and small.
 *
 * ## Idempotent, and silent without a key
 *
 * An enabled Anthropic profile means somebody has already configured this, by hand or by an
 * earlier run, and it is left alone. With no `ANTHROPIC_API_KEY` there is nothing to route to, so
 * a profile would be a route to a guaranteed failure; it exits instead.
 *
 * Run:  node apps/api/scripts/seed-model-catalogue.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Two models, because the five logical profiles ask for two different things.
 *
 * `capability` is the product's own word for what a model is *for* — the gateway routes on it and
 * never on a model name, so replacing `claude-sonnet-5` with its successor is a row change here
 * and no change anywhere else.
 */
const MODELS = [
  { ref: 'claude-sonnet-5', capability: 'high-reasoning-v1' },
  { ref: 'claude-haiku-4-5-20251001', capability: 'fast-v1' },
];

/**
 * Which model answers which profile, lowest `preference` first.
 *
 * `AGENT_STANDARD` lists both: the capable model first and the fast one behind it, so an agent's
 * ordinary work still completes when the first choice is rate-limited rather than failing the
 * run. The others name one model each, because a fallback that quietly produces worse reasoning
 * on a planning or executor step is worse than a refusal somebody can see.
 */
const ROUTES = [
  { profile: 'OBJECTIVE_PLANNER', ref: 'claude-sonnet-5', preference: 0 },
  { profile: 'AGENT_STANDARD', ref: 'claude-sonnet-5', preference: 0 },
  { profile: 'AGENT_STANDARD', ref: 'claude-haiku-4-5-20251001', preference: 1 },
  { profile: 'AGENT_FAST', ref: 'claude-haiku-4-5-20251001', preference: 0 },
  { profile: 'EXECUTOR', ref: 'claude-sonnet-5', preference: 0 },
  { profile: 'HIGH_REASONING', ref: 'claude-sonnet-5', preference: 0 },
];

if ((process.env['ANTHROPIC_API_KEY'] ?? '').trim() === '') {
  console.log(
    'No ANTHROPIC_API_KEY, so there is nothing to route to. Leaving the catalogue empty.',
  );
  process.exit(0);
}

const url = process.env['DATABASE_URL'];
if (url === undefined) throw new Error('DATABASE_URL is not set.');

const { PrismaClient } = require('../dist/generated/prisma/client.js');
const { PrismaPg } = require('@prisma/adapter-pg');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

try {
  const existing = await prisma.$queryRaw`
    SELECT id FROM provider_profiles
     WHERE tenant_id IS NULL AND kind = 'Anthropic' AND enabled = true
     LIMIT 1`;

  if (existing.length > 0) {
    console.log('An Anthropic profile is already configured. Leaving the catalogue as it is.');
  } else {
    await prisma.$transaction(async (tx) => {
      // Transaction-local, and it has to live in the same transaction as the writes it
      // authorises — outside one, every Prisma call is its own and the flag is gone by the next
      // statement, which row-level security then refuses.
      await tx.$executeRaw`SELECT set_config('app.platform_operation', 'on', true)`;

      const profile = await tx.providerProfile.create({
        data: {
          tenantId: null,
          kind: 'Anthropic',
          mode: 'UBossManaged',
          label: 'Anthropic (UBoss account)',
          lifecycle: 'Active',
          enabled: true,
        },
        select: { id: true },
      });

      const byRef = new Map();
      for (const model of MODELS) {
        const row = await tx.providerModel.create({
          data: {
            tenantId: null,
            providerProfileId: profile.id,
            providerModelRef: model.ref,
            capability: model.capability,
            lifecycle: 'Active',
            enabled: true,
          },
          select: { id: true },
        });
        byRef.set(model.ref, row.id);
        console.log(`  model ${model.ref} (${model.capability})`);
      }

      for (const route of ROUTES) {
        const providerModelId = byRef.get(route.ref);
        if (providerModelId === undefined) throw new Error(`No model id for ${route.ref}`);
        await tx.logicalModelRoute.create({
          data: {
            tenantId: null,
            profile: route.profile,
            providerModelId,
            preference: route.preference,
            enabled: true,
          },
        });
        console.log(`  ${route.profile} -> ${route.ref} (preference ${route.preference})`);
      }
    });

    console.log('Model catalogue seeded. AI work can now be routed.');
    console.log(
      'Prices are deliberately not set here: a published price is a commercial decision, and ' +
        'until one exists these calls settle at zero and are reported as unpriced, not free.',
    );
  }
} finally {
  await prisma.$disconnect();
}
