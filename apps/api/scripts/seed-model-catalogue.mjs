/*
 * Give a deployment a model catalogue, so AI can actually run on it.
 *
 * ## The gap this closes
 *
 * `ANTHROPIC_API_KEY` is a credential. It says *who may call the provider*; it says nothing about
 * **which model answers which kind of work**, and that is a separate decision the product keeps in
 * `provider_profiles`, `provider_models` and `logical_model_routes`. No migration seeds those, so
 * a freshly deployed database has all three empty — and every model call fails with
 * "No model is configured for OBJECTIVE_PLANNER", whatever the key is.
 *
 * It worked in development because development had been seeded by hand, months earlier. The
 * production deployment shipped the same code to an empty database, which is exactly the shape of
 * bug that only appears the first time something is deployed somewhere new.
 *
 * ## Why this runs on every start
 *
 * The same reason `bootstrap-platform-owner.mjs` does: a deployment needs this to be true, and a
 * step somebody has to remember is a step that gets missed. It is idempotent — it looks for an
 * enabled Anthropic profile and does nothing if one is there, so a restart, a redeploy and a
 * rollback all leave an existing catalogue alone.
 *
 * ## Why it does nothing without a key
 *
 * A profile with no credential behind it is a route to a guaranteed failure. With no
 * `ANTHROPIC_API_KEY` this exits quietly and the gateway reports "no model configured", which is
 * the truthful state of that deployment rather than a confusing one.
 *
 * ## Not a back door
 *
 * Everything goes through `ProviderService`, exactly as the Providers & Models screen does: the
 * same validation, the same audit rows, the same platform actor. Nothing is written by hand.
 *
 * Run:  node apps/api/scripts/seed-model-catalogue.mjs
 */
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../dist/app.module.js';
import { ProviderService } from '../dist/model-gateway/provider.service.js';
import { PrismaService } from '../dist/persistence/prisma.service.js';

/**
 * Two models, because the five logical profiles ask for two different things.
 *
 * `capability` is the product's own word for what a model is *for* — the gateway routes on it and
 * never on a model name, so swapping `claude-sonnet-5` for its successor is a row change here and
 * no change anywhere else.
 */
const MODELS = [
  { ref: 'claude-sonnet-5', capability: 'high-reasoning-v1' },
  { ref: 'claude-haiku-4-5-20251001', capability: 'fast-v1' },
];

/**
 * Which model answers which profile, lowest `preference` first.
 *
 * `AGENT_STANDARD` lists both: the capable model first and the fast one behind it, so an agent's
 * ordinary work still completes when the first choice is rate-limited rather than failing the run.
 * The others name one model each, because a fallback that quietly produces worse reasoning on a
 * planning or executor step is worse than a refusal somebody can see.
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
  console.log('No ANTHROPIC_API_KEY, so no model catalogue to seed. Leaving it empty.');
  process.exit(0);
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
const prisma = app.get(PrismaService);
const providers = app.get(ProviderService);

try {
  // The platform actor this is attributed to, read rather than assumed so the audit trail names a
  // real person. `bootstrap-platform-owner.mjs` runs before this and has created them.
  const actor = await prisma.runAsPlatformOperation(() =>
    prisma.client.user.findFirst({ where: { isPlatformActor: true }, select: { id: true } }),
  );
  if (actor === null) {
    throw new Error('No platform actor exists yet, so there is nobody to attribute this to.');
  }

  const existing = await prisma.runAsPlatformOperation(() =>
    prisma.client.providerProfile.findFirst({
      where: { tenantId: null, kind: 'Anthropic', enabled: true },
      select: { id: true },
    }),
  );

  if (existing !== null) {
    console.log('An Anthropic profile is already configured. Leaving the catalogue as it is.');
    await app.close();
    process.exit(0);
  }

  const profile = await providers.createProfile({
    actorUserId: actor.id,
    tenantId: null,
    kind: 'Anthropic',
    mode: 'UBossManaged',
    label: 'Anthropic (UBoss account)',
  });
  console.log(`Created provider profile ${profile.id}`);

  const byRef = new Map();
  for (const model of MODELS) {
    const added = await providers.addModel({
      actorUserId: actor.id,
      providerProfileId: profile.id,
      providerModelRef: model.ref,
      capability: model.capability,
    });
    byRef.set(model.ref, added.id);
    console.log(`  model ${model.ref} (${model.capability})`);
  }

  for (const route of ROUTES) {
    const providerModelId = byRef.get(route.ref);
    if (providerModelId === undefined) throw new Error(`No model id for ${route.ref}`);
    await providers.setRoute({
      actorUserId: actor.id,
      tenantId: null,
      profile: route.profile,
      providerModelId,
      preference: route.preference,
    });
    console.log(`  ${route.profile} -> ${route.ref} (preference ${route.preference})`);
  }

  console.log('Model catalogue seeded. AI work can now be routed.');
  console.log(
    'Prices are deliberately not set here: a published price is a commercial decision, and ' +
      'until one exists these calls settle at zero and are reported as unpriced rather than free.',
  );
} finally {
  await app.close();
}
