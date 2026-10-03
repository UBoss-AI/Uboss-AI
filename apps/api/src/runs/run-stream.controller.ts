import { Controller, Get, Param, ParseUUIDPipe, Sse, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';

import type { RunProgressEvent } from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { RunEngineService } from './run-engine.service.js';
import { RunProgressGateway } from './run-progress.gateway.js';

/** Twenty seconds. Long enough to be invisible, short enough to beat an idle proxy's timeout. */
const KEEP_ALIVE_MS = 20_000;

/**
 * Live run progress, as it happens.
 *
 * ## Why server-sent events and not a socket
 *
 * Nothing is sent upward. The browser subscribes and listens; every instruction it gives the
 * engine goes through an ordinary request. A WebSocket would be a second transport to secure, to
 * scale and to debug, for a channel that only ever flows one way.
 *
 * SSE is also the one that survives real infrastructure: plain HTTP, so proxies that refuse socket
 * upgrades pass it through, and the browser's own `EventSource` reconnects by itself when a
 * connection drops. A dropped socket needs reconnection logic somebody has to write and nobody
 * tests.
 *
 * ## The stream is a notification, never the record
 *
 * Every event published here was written to `agent_run_events` first. A client that misses one —
 * closed, reconnecting, or started late — loses nothing it cannot read back from the run's own
 * history, which is why nothing in the product reads its state from this channel.
 *
 * ## Nothing here may touch a response header
 *
 * Not `@Res()`, not `@Header()`, not an interceptor that runs on this route. Nest writes the
 * stream's headers and *then* subscribes to this observable, so every line below executes against
 * a response that has already been sent. Setting a header at that point throws *Cannot set headers
 * after they are sent*, and the SSE machinery delivers that to the browser as an `error` event —
 * the stream dies in the same instant it opens, the canvas reports "not live", and the message
 * names a header rather than whatever actually set it.
 *
 * Nest writes the ones that matter itself, including `X-Accel-Buffering: no` for the proxies that
 * would otherwise hold each event until the next one arrived. Injecting `@Res()` would also switch
 * Nest to manual-response mode, which is the opposite of what an `@Sse()` route wants.
 *
 * ## Tenant isolation is by construction
 *
 * The gateway's subscription is per company, and a listener registered against one tenant never
 * sees another's list — there is no filtering step to get wrong. `@TenantScoped` proves membership
 * in the database before a subscription exists at all.
 */
@Controller('tenants/:tenantId/runs')
@TenantScoped()
export class RunStreamController {
  constructor(
    private readonly progress: RunProgressGateway,
    private readonly engine: RunEngineService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * What is unfinished right now — the picture the stream then keeps current.
   *
   * ## Why a screen needs both
   *
   * The stream publishes changes. A run that has been running for two minutes last changed two
   * minutes ago, so a screen opened now would show an idle workspace until that run next moved —
   * and on a long step that is minutes of being wrong about the one thing somebody is watching.
   *
   * Read once on arrival, listen for changes after. Same division as everywhere else here: the
   * record is the truth and the stream is the notification.
   *
   * This one is an ordinary request, so it reads the tenant from the ambient scope as every other
   * route does. Only the stream below has to take it from the path, and the reason is in its own
   * note.
   */
  @Get('unfinished')
  @RequirePermission({ module: 'agents', action: 'View' })
  async unfinished(): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    return this.engine.listUnfinished({ scope });
  }

  /**
   * Subscribe to this company's run progress.
   *
   * `agents:View` — the same permission that reads a run's history. Watching work happen is
   * reading it, and somebody who may not see a run's record must not be handed its progress live.
   */
  @Sse('stream')
  @RequirePermission({ module: 'agents', action: 'View' })
  stream(@Param('tenantId', new ParseUUIDPipe()) tenantId: string): Observable<MessageEvent> {
    /*
     * The tenant from the route, not from the ambient scope.
     *
     * `requireScope()` reads an `AsyncLocalStorage` context that exists for the duration of one
     * request's call stack. This connection outlives that by hours, so reading the scope here was
     * a dependency on something already unwinding — and when it threw, Nest's error path tried to
     * send a response whose headers were long gone, which reached the browser as *Cannot set
     * headers after they are sent* and told nobody what had actually happened.
     *
     * The parameter is safe to trust **because of the guard, not instead of it**: `@TenantScoped`
     * has already verified a membership for this person in this company against the database, and
     * refused the request otherwise. By the time this line runs, the id has been proved.
     */
    return new Observable<MessageEvent>((subscriber) => {
      const unsubscribe = this.progress.subscribe(tenantId, (event: RunProgressEvent) => {
        subscriber.next({ data: event, type: 'run-progress' });
      });

      /*
       * A ping nobody listens for.
       *
       * Not for the client — for everything between. Proxies and load balancers close a connection
       * that has been silent too long, and a workflow waiting on a person is silent for hours.
       * Sent as its own event type so a client listening for `run-progress` never sees it, and so
       * it can never be mistaken for a run that moved.
       */
      const keepAlive = setInterval(() => {
        subscriber.next({ data: {}, type: 'keep-alive' });
      }, KEEP_ALIVE_MS);

      /*
       * Teardown runs when the client disconnects — Nest unsubscribes for us.
       *
       * It must do both things. A listener that outlives its subscriber is a leak, and in this
       * gateway it is a write to a closed connection on every later event for as long as the
       * process lives.
       */
      return () => {
        clearInterval(keepAlive);
        unsubscribe();
      };
    });
  }
}
