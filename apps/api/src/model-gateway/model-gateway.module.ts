import { Global, Module } from '@nestjs/common';

import { SecretsVault } from '../connections/secrets-vault.js';
import { CostEngineService } from '../cost/cost-engine.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { ProviderThrottleService } from '../rate-limits/provider-throttle.service.js';
import { ModelGateway } from './model-gateway.js';
import { ProviderController } from './provider.controller.js';
import { ProviderService } from './provider.service.js';
import {
  AnthropicProviderAdapter,
  CustomProviderAdapter,
  MockProviderAdapter,
  OpenAiProviderAdapter,
  PROVIDER_ADAPTERS,
  ProviderAdapter,
} from './provider-adapter.js';
import { RoutingModelGateway } from './routing-model-gateway.js';

// `PROVIDER_ADAPTERS` lives in `provider-adapter.ts`: the service needs it and this module needs
// the service, so declaring it here closed an import cycle.
export { PROVIDER_ADAPTERS } from './provider-adapter.js';

/**
 * The Model Gateway module.
 *
 * `@Global` because the client's locked rule is that **every** AI call goes through this seam and
 * provider names never leave it. A module each caller had to remember to import is a module
 * somebody eventually works around by importing a provider SDK directly — which would put a
 * provider name in a company-facing service, bypass central cost metering, and take provider
 * configuration out of the Master Console's hands, all at once.
 *
 * ## What Prompt 29 changed
 *
 * `RoutingModelGateway` replaced `MockModelGateway` as what the application provides. It resolves
 * the request's logical profile through configured routes, calls the adapter for whichever
 * provider kind that lands on, prices the result and records the call.
 *
 * **All four adapters are registered, and only one of them can answer.** `MockProviderAdapter`
 * works offline; the Anthropic and OpenAI adapters are implemented against their real APIs and
 * refuse without a credential, which none of them has; the custom adapter works against whatever
 * endpoint a profile configures. Registering the two that cannot run is deliberate — it is what
 * makes "no provider is configured" a fact the gateway reports (`usesRealModel`) rather than
 * something a reader has to infer from an absence.
 *
 * The migration seeds only the mock profile. Nothing in this codebase claims a verified provider
 * integration, and adding one is a configuration change plus a credential, not a code change.
 */
@Global()
@Module({
  controllers: [ProviderController],
  providers: [
    ProviderService,
    MockProviderAdapter,
    AnthropicProviderAdapter,
    OpenAiProviderAdapter,
    CustomProviderAdapter,
    {
      provide: PROVIDER_ADAPTERS,
      inject: [
        MockProviderAdapter,
        AnthropicProviderAdapter,
        OpenAiProviderAdapter,
        CustomProviderAdapter,
      ],
      useFactory: (...adapters: ProviderAdapter[]): readonly ProviderAdapter[] => adapters,
    },
    {
      provide: ModelGateway,
      inject: [
        PrismaService,
        SecretsVault,
        PROVIDER_ADAPTERS,
        CostEngineService,
        ProviderThrottleService,
      ],
      useFactory: (
        prisma: PrismaService,
        vault: SecretsVault,
        adapters: readonly ProviderAdapter[],
        cost: CostEngineService,
        throttle: ProviderThrottleService,
      ) => new RoutingModelGateway(prisma, vault, adapters, cost, throttle),
    },
  ],
  exports: [ModelGateway, ProviderService, PROVIDER_ADAPTERS],
})
export class ModelGatewayModule {}
