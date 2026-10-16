import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * An MCP server, for tests — CR-06.
 *
 * ## Why a real HTTP server rather than a stubbed adapter
 *
 * The adapter's whole job is the things a stub cannot have: a socket that can refuse, a status
 * code that means "wrong credential" rather than "broken server", a reply that arrives as SSE
 * instead of JSON, and a body that is not the shape it claimed. Stubbing `fetch` would test the
 * code either side of those and none of them — and those are exactly where a connector to
 * somebody else's software goes wrong.
 *
 * It listens on 127.0.0.1 on a port the OS picks, so two of these can run at once and neither
 * has a port anybody has to remember.
 */
export class FakeMcpServer {
  private server: Server | null = null;
  private port = 0;

  /** The tools this server currently says it has. Reassign it to make the list drift. */
  tools: { name: string; description: string; inputSchema: unknown }[] = [
    {
      name: 'get_row',
      description: 'Reads one row from the sheet.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'append_row',
      description: 'Adds a row to the end of the sheet.',
      inputSchema: { type: 'object' },
    },
  ];

  /** The credential it accepts. Anything else is answered 401. */
  expectedSecret = 'mcp-test-key';

  /** Reply as one SSE frame instead of JSON — both are legal for a single call. */
  replyAsEventStream = false;

  /** Answer this status instead of serving the list. 0 means serve normally. */
  failWithStatus = 0;

  /** Answer 200 with something that is not a tool list, as a non-MCP server would. */
  replyWithRubbish = false;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const authorised = (request.headers.authorization ?? '') === `Bearer ${this.expectedSecret}`;

      if (!authorised) {
        response.writeHead(401).end('unauthorised');
        return;
      }
      if (this.failWithStatus !== 0) {
        response.writeHead(this.failWithStatus).end('no');
        return;
      }
      if (this.replyWithRubbish) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":"world"}');
        return;
      }

      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: this.tools } });

      if (this.replyAsEventStream) {
        response
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end(`event: message\ndata: ${body}\n\n`);
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
    return this.url();
  }

  /**
   * Its address.
   *
   * `https://127.0.0.1` would be refused by the endpoint guard, which is correct — a company
   * must not point UBoss at a private address. Tests that need a *stored* connection therefore
   * write the row directly; tests of the adapter call it with this url and no guard in between.
   */
  url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}
