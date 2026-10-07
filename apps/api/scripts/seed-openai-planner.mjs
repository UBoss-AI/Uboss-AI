/*
 * Send Objective analysis to OpenAI, and leave everything else on Anthropic.
 *
 * ## What the client asked for
 *
 * "Objective run ko ChatGPT use hona chahiye" — the Objective Optimization analysis, and only
 * that. Engine Agents, Agent Builder and the Executor stay where they are.
 *
 * That maps exactly onto one logical profile. `OBJECTIVE_PLANNER` is what
 * `ObjectiveAnalysisService` asks the gateway for; `AGENT_STANDARD`, `AGENT_FAST`, `EXECUTOR` and
 * `HIGH_REASONING` are what everything else asks for. So this repoints one route and touches no
 * code: which model answers which kind of work has always been data.
 *
 * ## Anthropic stays behind it, as the fallback
 *
 * OpenAI answers first and Anthropic answers if it cannot, which is what was asked for. The
 * profile's own policy already allows exactly this and no more: `SameCapabilityOnly` — "fall back
 * only to a model of the same declared capability" — and both sides are `high-reasoning-v1`. A
 * plan is therefore never quietly produced by a weaker model, which is what that reading of §18
 * is there to prevent; it is produced by the other high-reasoning model, or not at all.
 *
 * Nothing is deleted. The existing routes keep their order and simply move down behind OpenAI, so
 * putting the planner back is a matter of preferences rather than a rebuild.
 *
 * ## Idempotent, and silent without a key
 *
 * No `OPENAI_API_KEY` means there is nothing to route to, and a profile pointing at a provider
 * that cannot be reached is a route to a guaranteed failure. It exits instead, leaving the
 * planner on Anthropic — which is a working product, not a broken one.
 *
 * Run:  node apps/api/scripts/seed-openai-planner.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The model, and why this one.
 *
 * A real 25-step objective produced about 5,900 completion tokens across the planner's seven
 * calls, and what comes back is a workflow graph a manager approves and that assigns work to
 * named people. That is reasoning-grade work at low volume — one analysis per objective — so the
 * smaller and cheaper tiers are a saving measured against the cost of a wrong plan.
 *
 * `capability` is the product's own word for what a model is *for*. It stays `high-reasoning-v1`
 * so the routing table keeps meaning the same thing whichever vendor answers.
 */
const MODEL = { ref: 'gpt-5', capability: 'high-reasoning-v1' };

const PROFILE = 'OBJECTIVE_PLANNER';

if ((process.env['OPENAI_API_KEY'] ?? '').trim() === '') {
  console.log(
    'No OPENAI_API_KEY, so there is nothing to route to. Leaving Objective analysis on its ' +
      'current provider.',
  );
  process.exit(0);
}

const url = process.env['DATABASE_URL'];
if (url === undefined) throw new Error('DATABASE_URL is not set.');

const { PrismaClient } = require('../dist/generated/prisma/client.js');
const { PrismaPg } = require('@prisma/adapter-pg');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

try {
  const already = await prisma.$queryRaw`
    SELECT r.id FROM logical_model_routes r
      JOIN provider_models pm ON pm.id = r.provider_model_id
      JOIN provider_profiles pp ON pp.id = pm.provider_profile_id
     WHERE r.tenant_id IS NULL
       AND r.profile = ${PROFILE}
       AND r.enabled = true
       AND pp.kind = 'OpenAI'
     LIMIT 1`;

  if (already.length > 0) {
    console.log(`${PROFILE} already routes to OpenAI. Leaving it as it is.`);
  } else {
    await prisma.$transaction(async (tx) => {
      // Transaction-local, and in the same transaction as the writes it authorises: outside one,
      // every Prisma call is its own and row-level security refuses the next statement.
      await tx.$executeRaw`SELECT set_config('app.platform_operation', 'on', true)`;

      // An OpenAI profile may already exist from an earlier run or from the Providers screen.
      const found = await tx.providerProfile.findFirst({
        where: { tenantId: null, kind: 'OpenAI', enabled: true },
        select: { id: true },
      });

      const profileId =
        found?.id ??
        (
          await tx.providerProfile.create({
            data: {
              tenantId: null,
              kind: 'OpenAI',
              mode: 'UBossManaged',
              label: 'OpenAI (UBoss account)',
              lifecycle: 'Active',
              enabled: true,
            },
            select: { id: true },
          })
        ).id;
      console.log(found ? '  using the existing OpenAI profile' : '  created the OpenAI profile');

      const existingModel = await tx.providerModel.findFirst({
        where: { tenantId: null, providerProfileId: profileId, providerModelRef: MODEL.ref },
        select: { id: true },
      });

      const modelId =
        existingModel?.id ??
        (
          await tx.providerModel.create({
            data: {
              tenantId: null,
              providerProfileId: profileId,
              providerModelRef: MODEL.ref,
              capability: MODEL.capability,
              lifecycle: 'Active',
              enabled: true,
            },
            select: { id: true },
          })
        ).id;
      console.log(`  model ${MODEL.ref} (${MODEL.capability})`);

      /*
       * The planner's existing routes become the fallback, in the order they were already in.
       *
       * OpenAI answers first; if it cannot, the analysis falls back to what was there before
       * rather than failing. The profile's policy already permits exactly this and no more:
       * `SameCapabilityOnly` — "fall back only to a model of the same declared capability" — and
       * both sides are `high-reasoning-v1`. So the plan is never quietly produced by a weaker
       * model, which is the thing that reading of §18 exists to prevent.
       *
       * **Moved before anything is inserted.** `one_model_per_platform_profile_preference` is
       * unique on (profile, preference) and takes no notice of `enabled`, so the existing route
       * occupies slot 0 until it is moved: creating the OpenAI route at 0 first fails on that
       * constraint. Found by running this against a real database rather than by reading it, and
       * it would have failed on the first deployment.
       */
      const previous = await tx.logicalModelRoute.findMany({
        where: { tenantId: null, profile: PROFILE, providerModelId: { not: modelId } },
        select: { id: true, preference: true },
        orderBy: { preference: 'asc' },
      });

      // Parked high first, so that neither the old slot nor the new one is occupied twice at any
      // point inside the transaction, then brought down to 1, 2, 3 behind OpenAI.
      for (const [index, route] of previous.entries()) {
        await tx.logicalModelRoute.update({
          where: { id: route.id },
          data: { preference: 900 + index },
        });
      }
      for (const [index, route] of previous.entries()) {
        await tx.logicalModelRoute.update({
          where: { id: route.id },
          data: { enabled: true, preference: index + 1 },
        });
      }
      console.log(`  kept ${previous.length} existing ${PROFILE} route(s) as the fallback`);

      const priorRoute = await tx.logicalModelRoute.findFirst({
        where: { tenantId: null, profile: PROFILE, providerModelId: modelId },
        select: { id: true },
      });

      if (priorRoute) {
        await tx.logicalModelRoute.update({
          where: { id: priorRoute.id },
          data: { enabled: true, preference: 0 },
        });
        console.log(`  re-enabled ${PROFILE} -> ${MODEL.ref}`);
      } else {
        await tx.logicalModelRoute.create({
          data: {
            tenantId: null,
            profile: PROFILE,
            providerModelId: modelId,
            preference: 0,
            enabled: true,
          },
        });
        console.log(`  ${PROFILE} -> ${MODEL.ref} (preference 0)`);
      }
    });

    console.log('Objective analysis now runs on OpenAI. Agents are unchanged.');
    console.log(
      'Anthropic remains behind it as the fallback, which OBJECTIVE_PLANNER permits because both ' +
        'models declare the same capability. A plan is never answered by a weaker model — only ' +
        'by the other high-reasoning one.',
    );
  }
} finally {
  await prisma.$disconnect();
}
