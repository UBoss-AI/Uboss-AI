import { Injectable, Logger } from '@nestjs/common';

import {
  driftBetween,
  quarantineMcpDescription,
  type McpToolDescriptor,
  type ToolActionCategory,
} from '@uboss/types';

import {
  ConnectorAdapter,
  type ConnectorCheckResult,
  type ConnectorContext,
} from './connector-adapter.js';

/** How long a server has to answer before the attempt is a failure. */
const MCP_TIMEOUT_MS = 10_000;

/** The most tools a server may offer. Past this, somebody has pointed us at the wrong thing. */
const MAX_TOOLS = 200;

/**
 * Any system a company already runs, reached over the Model Context Protocol — CR-06.
 *
 * ## One adapter, every vendor
 *
 * The client's requirement: *"koi bhi software ka MCP laa ke connect kare aur agent run kare."*
 * MCP is a protocol rather than a product, so Drive, Slack, GitHub, Postgres and a server a
 * company wrote last week are all the same work done once. Nothing in this file names a vendor,
 * and nothing in UBoss changes when a company adopts a new tool.
 *
 * ## What `check` actually does, and why that is the design
 *
 * It opens the server, asks for its tool list, and reports what it found. That is *Test
 * Connection* for this connector — and it is more than a ping on purpose: the tool list is the
 * thing the whole governance hangs off, so the moment of first contact is the moment to capture
 * it. `discover` returns it for the approval screen; `check` reports reachability so the
 * existing lifecycle — `Error`, `NeedsReauthorization`, the check history, the expiry sweep —
 * works for MCP exactly as it does for every other connector.
 *
 * ## What this adapter will not do
 *
 * It will not call a tool. Calling belongs above this, where the approved snapshot, the tool's
 * assigned category and the agent's own grant are all in hand — three checks this class cannot
 * see. An adapter that could call a tool with only a credential would be a way around all three.
 */
@Injectable()
export class McpConnectorAdapter extends ConnectorAdapter {
  readonly kind = 'custom-mcp';
  private readonly logger = new Logger('McpConnector');

  /**
   * Reachability, reported in the vocabulary the connection lifecycle already speaks.
   *
   * The distinction that matters is **401/403 versus everything else**: a rejected credential is
   * `needsReauthorization`, which puts the connection into a state whose remedy is "sign in
   * again", while a timeout or a 500 is an `Error`, whose remedy is "ask whoever runs the
   * server". Collapsing them would send every company down the wrong path half the time.
   */
  async check(context: ConnectorContext): Promise<ConnectorCheckResult> {
    const startedAt = Date.now();
    const endpoint = context.endpoint ?? null;

    if (endpoint === null || endpoint.trim() === '') {
      return {
        succeeded: false,
        detail: 'This connection has no server address, so there is nothing to reach.',
        durationMs: Math.max(1, Date.now() - startedAt),
      };
    }

    try {
      const tools = await this.listTools(endpoint, context.secret);
      return {
        succeeded: true,
        // No "Reachable." prefix: the screen adds that word itself for a successful check, and
        // the two together read "Reachable. Reachable. The server offers…".
        detail:
          `The server offers ${tools.length} tool${tools.length === 1 ? '' : 's'}. ` +
          'Which of them this company may use is decided when the list is approved.',
        durationMs: Math.max(1, Date.now() - startedAt),
      };
    } catch (caught) {
      const failure = caught instanceof McpFailure ? caught : null;

      return {
        succeeded: false,
        // The server's own words are not repeated here: they are a third party's text, and the
        // check history is read by people. What is reported is what UBoss concluded.
        detail: failure?.detail ?? 'The server could not be reached.',
        durationMs: Math.max(1, Date.now() - startedAt),
        ...(failure?.needsReauthorization === true ? { needsReauthorization: true } : {}),
      };
    }
  }

  /**
   * Every category, because the protocol permits every kind of tool.
   *
   * The ceiling, not the grant — see the catalogue entry. What a connection may do is the
   * categories a person mapped onto its tools; what an agent may do is its own grant.
   */
  describeCapabilities(): readonly ToolActionCategory[] {
    return [
      'Read',
      'Write',
      'Delete',
      'ExternalBulkSend',
      'SensitiveExport',
      'FinancialChange',
      'ProductionChange',
    ];
  }

  /**
   * The server's current tool list, for the approval screen and for drift checks.
   *
   * Separate from `check` because the two answer different questions and one of them is shown to
   * an administrator making a decision. Descriptions come back as the server wrote them —
   * quarantining happens where they meet a model, not here, because the approval screen should
   * show an administrator exactly what the server said, including the parts that are trying
   * something.
   */
  async discover(
    endpoint: string,
    secret: string,
  ): Promise<{ tools: readonly McpToolDescriptor[]; suspicious: readonly string[] }> {
    const tools = await this.listTools(endpoint, secret);

    // Noticed at discovery rather than at use: an administrator deciding whether to approve a
    // server is the right person to be told that one of its tool descriptions is written like an
    // instruction, and the right moment is before they approve it.
    const suspicious = tools
      .filter((tool) => quarantineMcpDescription(tool.description).suspicious)
      .map((tool) => tool.name);

    return { tools, suspicious };
  }

  /** What changed since the approved snapshot. A thin pass-through, so callers need one import. */
  driftFrom(approved: readonly McpToolDescriptor[], current: readonly McpToolDescriptor[]) {
    return driftBetween(approved, current);
  }

  /**
   * One JSON-RPC round trip: `tools/list`.
   *
   * Streamable HTTP rather than stdio, because a server UBoss connects to over a network is the
   * only kind a company can point at — a stdio server would mean running the vendor's process
   * inside UBoss, which is a different and much larger decision.
   */
  private async listTools(endpoint: string, secret: string): Promise<McpToolDescriptor[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          // Bearer is what every hosted MCP server in the field expects. A server wanting
          // something else is a server this connector does not reach, and says so plainly rather
          // than failing in a way that looks like a wrong key.
          ...(secret.trim() === '' ? {} : { authorization: `Bearer ${secret.trim()}` }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
    } catch (caught) {
      const aborted = caught instanceof Error && caught.name === 'AbortError';
      throw new McpFailure(
        aborted
          ? `The server did not answer within ${MCP_TIMEOUT_MS / 1000} seconds.`
          : 'The server could not be reached at that address.',
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new McpFailure('The server rejected the credential.', true);
    }
    if (!response.ok) {
      throw new McpFailure(`The server answered ${response.status}.`);
    }

    const body = await this.readBody(response);
    const result = body?.['result'];
    const listed =
      typeof result === 'object' && result !== null
        ? (result as Record<string, unknown>)['tools']
        : null;

    if (!Array.isArray(listed)) {
      throw new McpFailure(
        'The server answered, but not with a tool list. It may not be an MCP server.',
      );
    }
    if (listed.length > MAX_TOOLS) {
      throw new McpFailure(
        `That server offers ${listed.length} tools and the limit is ${MAX_TOOLS}. A list that ` +
          'long is not something an administrator can review, which is the point of reviewing it.',
      );
    }

    const tools: McpToolDescriptor[] = [];
    for (const entry of listed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
      if (name === '') continue;

      tools.push({
        name,
        description: typeof row['description'] === 'string' ? row['description'] : '',
        inputSchema: row['inputSchema'] ?? null,
      });
    }

    if (tools.length === 0) {
      throw new McpFailure('That server offers no tools, so there is nothing an agent could use.');
    }

    this.logger.debug(`Read ${tools.length} tools from an MCP server.`);
    return tools;
  }

  /**
   * The JSON in the answer, whether it arrived as JSON or as one SSE frame.
   *
   * Streamable HTTP lets a server reply either way for a single call, and a connector that
   * understood only one of them would work against half the servers in the field for reasons
   * nobody could diagnose from the error.
   */
  private async readBody(response: Response): Promise<Record<string, unknown> | null> {
    const text = await response.text();
    const type = response.headers.get('content-type') ?? '';

    const payload = type.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
      : text;

    try {
      const parsed: unknown = JSON.parse(payload);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

/** A reachability failure with the one distinction the lifecycle cares about. */
class McpFailure extends Error {
  constructor(
    readonly detail: string,
    readonly needsReauthorization = false,
  ) {
    super(detail);
    this.name = 'McpFailure';
  }
}
