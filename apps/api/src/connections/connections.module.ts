import { Global, Module } from '@nestjs/common';

import { ConnectionController } from './connection.controller.js';
import { ConnectionService } from './connection.service.js';
import { ConnectorAdapter, MockConnectorAdapter } from './connector-adapter.js';
import { LocalSealedSecretsVault, SecretsVault } from './secrets-vault.js';

/**
 * Integrations, Connections and Agent Tool Permission.
 *
 * `@Global` because `mayAgentUse` is what every later prompt's Engine Agent run path must call
 * before touching an outside system. A module that had to be imported to ask "may this agent do
 * this" would eventually be skipped by one caller, and that caller would be the bug.
 *
 * **Two provider bindings are the whole deployment story:**
 *
 * - `SecretsVault` → the local sealed store. A deployment with AWS Secrets Manager or Vault
 *   provides its own implementation and nothing above it changes.
 * - `ConnectorAdapter` → the mock. Real connectors add a catalogue entry and an adapter; the
 *   lifecycle, the secret handling, the tool grants, the expiry sweep and the notification are
 *   all connector-agnostic.
 *
 * Neither binding claims to be something it is not: both `describe()` methods report what they
 * actually are, and those reports reach the operational view.
 */
@Global()
@Module({
  controllers: [ConnectionController],
  providers: [
    ConnectionService,
    { provide: SecretsVault, useClass: LocalSealedSecretsVault },
    { provide: ConnectorAdapter, useClass: MockConnectorAdapter },
  ],
  exports: [ConnectionService, SecretsVault, ConnectorAdapter],
})
export class ConnectionsModule {}
