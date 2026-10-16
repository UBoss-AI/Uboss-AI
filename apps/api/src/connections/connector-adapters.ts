import { Injectable } from '@nestjs/common';

import { ConnectorAdapter, MockConnectorAdapter } from './connector-adapter.js';
import { McpConnectorAdapter } from './mcp-connector.adapter.js';

/**
 * Which adapter answers for a connector kind — CR-06.
 *
 * There used to be one adapter bound to the `ConnectorAdapter` token and every connection went
 * to it, which was true while both catalogue entries were mocks. `custom-mcp` is a real
 * integration, so the choice has to be made per connection: sending an MCP connection to the
 * mock would report a company's live server as "unrecognised credential".
 *
 * A kind with no adapter throws rather than falling back. A silent fallback is how a catalogue
 * entry with nothing behind it reaches production and then fails like a credential problem —
 * which is the thing the catalogue's own note is about.
 *
 * Its own file so that neither adapter has to import the other: `McpConnectorAdapter` extends
 * `ConnectorAdapter`, so a registry living beside the base class would close a cycle.
 */
@Injectable()
export class ConnectorAdapters {
  private readonly byKind: ReadonlyMap<string, ConnectorAdapter>;

  constructor(
    private readonly mock: MockConnectorAdapter,
    private readonly mcp: McpConnectorAdapter,
  ) {
    this.byKind = new Map<string, ConnectorAdapter>([
      ['mock-erp', this.mock],
      ['mock-mailbox', this.mock],
      [this.mcp.kind, this.mcp],
    ]);
  }

  /** The adapter for this kind. Throws when the catalogue names something nothing implements. */
  for(connectorKind: string): ConnectorAdapter {
    const adapter = this.byKind.get(connectorKind);
    if (adapter === undefined) {
      throw new Error(
        `No adapter implements the connector kind "${connectorKind}". A catalogue entry with ` +
          'nothing behind it would fail like a credential problem.',
      );
    }
    return adapter;
  }

  /** The MCP adapter, for the two things only it can do: discovery and drift. */
  mcpAdapter(): McpConnectorAdapter {
    return this.mcp;
  }

  /** Every kind this build can actually talk to. Asserted against the catalogue in the tests. */
  kinds(): readonly string[] {
    return [...this.byKind.keys()];
  }
}
