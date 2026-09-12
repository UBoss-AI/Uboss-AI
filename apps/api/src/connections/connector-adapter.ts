import { Injectable, Logger } from '@nestjs/common';

import {
  connectorDefinition,
  type ConnectionEnvironment,
  type ToolActionCategory,
} from '@uboss/types';

export interface ConnectorCheckResult {
  succeeded: boolean;
  /** What happened, in words somebody debugging can use. **Never a credential.** */
  detail: string;
  durationMs: number;
  /**
   * When the provider says the credential expires, if it says. `undefined` means it did not tell
   * us — distinct from `null`, which would claim it never expires.
   */
  credentialExpiresAt?: Date | undefined;
  /** True when the provider says consent has been withdrawn rather than the key being wrong. */
  needsReauthorization?: boolean | undefined;
}

export interface ConnectorContext {
  connectorKind: string;
  environment: ConnectionEnvironment | null;
  /**
   * The credential, resolved from the vault at the moment of use.
   *
   * Passed rather than fetched so an adapter has no access to the vault, and therefore cannot
   * read a secret belonging to a connection it was not asked about.
   */
  secret: string;
}

/**
 * A connector: the thing that actually talks to an outside system.
 *
 * ## Deliberately narrow
 *
 * Two methods. `check` is *Test Connection*; `describeCapabilities` reports what the connector can
 * do so a tool grant outside that set can be refused. There is no `execute` yet — Engine Agent
 * runs arrive at a later prompt, and an execute path with no caller would be untested code holding
 * a live credential.
 *
 * ## An adapter never sees the vault
 *
 * The secret arrives in the context, resolved by the service. An adapter that could reach the
 * vault could read a credential for a connection nobody asked it about, and the whole reason the
 * vault interface exists is to keep that reach short.
 */
export abstract class ConnectorAdapter {
  abstract readonly kind: string;
  abstract check(context: ConnectorContext): Promise<ConnectorCheckResult>;
  abstract describeCapabilities(): readonly ToolActionCategory[];
}

/**
 * The mock connector, standing in for both catalogue entries.
 *
 * ## Why a mock is the right thing to ship here
 *
 * The pack is explicit: "build a mock connector adapter plus tests; do not yet integrate every
 * vendor". A catalogue listing real vendors with nothing behind them would be worse than an
 * honest stand-in — somebody would configure Salesforce, press *Test Connection*, and get a
 * failure that looks like their credential rather than a missing feature.
 *
 * ## It is a real adapter, not a stub that always succeeds
 *
 * The whole governance layer above it — states, expiry, reauthorization, the check history,
 * `Error` versus `NeedsReauthorization` — can only be tested against something that can actually
 * fail in each of those ways. So this adapter reads its instructions from the **secret itself**,
 * which is the one input a test controls end to end:
 *
 *   * `mock:ok` — succeeds.
 *   * `mock:fail:<message>` — fails with that message, which becomes `Error`.
 *   * `mock:reauthorize` — reports consent withdrawn, which becomes `NeedsReauthorization`.
 *   * `mock:expires:<ISO date>` — succeeds and reports an expiry, exercising the expiry sweep.
 *   * anything else — fails as an unrecognised credential, which is what a real provider would
 *     say and what a mistyped key should produce.
 *
 * That last case matters: a mock that succeeded for any input would make every test of the
 * failure paths meaningless.
 */
@Injectable()
export class MockConnectorAdapter extends ConnectorAdapter {
  readonly kind = 'mock';
  private readonly logger = new Logger('MockConnector');

  async check(context: ConnectorContext): Promise<ConnectorCheckResult> {
    const startedAt = Date.now();
    const instruction = context.secret.trim();

    // A mock that pretended to be instantaneous would hide a timeout bug in the caller.
    await new Promise((resolve) => setTimeout(resolve, 1));
    const durationMs = Math.max(1, Date.now() - startedAt);

    if (instruction === 'mock:ok') {
      return {
        succeeded: true,
        detail: 'Reachable. The mock connector accepted the credential.',
        durationMs,
      };
    }

    if (instruction === 'mock:reauthorize') {
      return {
        succeeded: false,
        detail: 'The provider reports that consent was withdrawn. Reauthorize the connection.',
        durationMs,
        needsReauthorization: true,
      };
    }

    if (instruction.startsWith('mock:expires:')) {
      const raw = instruction.slice('mock:expires:'.length);
      const expiry = new Date(raw);
      if (Number.isNaN(expiry.getTime())) {
        return {
          succeeded: false,
          detail: 'The mock connector was given an expiry it could not read.',
          durationMs,
        };
      }
      return {
        succeeded: true,
        detail: `Reachable. The provider reports the credential expires ${expiry.toISOString()}.`,
        durationMs,
        credentialExpiresAt: expiry,
      };
    }

    if (instruction.startsWith('mock:fail:')) {
      return {
        succeeded: false,
        // Truncated here as well as in the service: an adapter is the layer most likely to be
        // handed a provider error containing something it should not repeat.
        detail: instruction.slice('mock:fail:'.length).slice(0, 400) || 'The provider refused.',
        durationMs,
      };
    }

    this.logger.debug(
      `The mock connector did not recognise its instruction for ${context.connectorKind}.`,
    );
    return {
      succeeded: false,
      detail:
        'The credential was not recognised. The mock connector accepts mock:ok, ' +
        'mock:reauthorize, mock:expires:<date> or mock:fail:<message>.',
      durationMs,
    };
  }

  describeCapabilities(): readonly ToolActionCategory[] {
    // Whatever the catalogue says this connector kind supports. One definition, in
    // `@uboss/types`, so the chooser, the grant check and the adapter cannot disagree.
    return [
      ...new Set(
        ['mock-erp', 'mock-mailbox'].flatMap(
          (kind) => connectorDefinition(kind)?.supportedCategories ?? [],
        ),
      ),
    ];
  }
}
