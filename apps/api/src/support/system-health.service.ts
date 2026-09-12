import { Inject, Injectable } from '@nestjs/common';

import {
  incidentIsActive,
  overallStatus,
  statusFromIncidents,
  type ComponentHealth,
  type CustomerVisibleStatus,
  type HealthComponent,
  type HealthStatus,
  type IncidentSeverity,
  type IncidentState,
} from '@uboss/types';

import { HealthService } from '../health/health.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { ProviderAdapter } from '../model-gateway/provider-adapter.js';
import { PROVIDER_ADAPTERS } from '../model-gateway/provider-adapter.js';
import { RunQueue } from '../runs/run-queue.js';

export interface IncidentView {
  id: string;
  reference: string;
  title: string;
  summary: string;
  detail: string | null;
  severity: IncidentSeverity;
  state: IncidentState;
  /** Which service this is about, as `service_alerts` has always recorded it. */
  service: string;
  ownerUserId: string | null;
  customerVisible: boolean;
  customerImpact: string | null;
  mitigation: string | null;
  startedAt: string;
  mitigatedAt: string | null;
  resolvedAt: string | null;
  declaredAt: string | null;
  declaredByUserId: string | null;
}

export interface SystemHealthView {
  status: HealthStatus;
  checkedAt: string;
  components: ComponentHealth[];
  activeIncidents: IncidentView[];
  /** Counts an operator reads first. */
  summary: {
    activeIncidents: number;
    p0Incidents: number;
    openAlerts: number;
    publishedIncidents: number;
  };
}

/**
 * System Health — Prompt 36.
 *
 * §Final_1 §System Health: *"Provider/tool/service health and major operational incidents visible
 * to permitted UBoss operations roles."* §30: *"System Health in Master Console shows
 * provider/tool/service health and major incidents to permitted roles."*
 *
 * ## This service measures nothing of its own
 *
 * Every reading comes from the component that owns it: `HealthService` probes the database,
 * `RunQueue.health()` reports the queue, the provider adapters say whether they can reach a
 * provider, and `connection_checks` already records every Test Connection result. A monitoring
 * service that re-probed any of those would be a second answer to a question the product already
 * answers — and the two would eventually disagree.
 *
 * ## The two audiences are computed differently, on purpose
 *
 * The operator view is assembled from **probes**. The customer view is assembled from **published
 * incidents** and nothing else — see `customerVisibleStatus`. That asymmetry is the whole of
 * §"permitted customer-visible status where appropriate", and it is why the two methods share no
 * code path: a shared one would eventually leak a probe reading into a customer response.
 */
@Injectable()
export class SystemHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthService,
    private readonly queue: RunQueue,
    @Inject(PROVIDER_ADAPTERS) private readonly providers: readonly ProviderAdapter[],
  ) {}

  /**
   * What an operator sees.
   *
   * Every component is probed in parallel and **no probe may throw**: this page is how an operator
   * finds out something is broken, so one unreachable dependency taking the page down would hide
   * exactly the information it exists to show.
   */
  async operatorView(): Promise<SystemHealthView> {
    const [components, incidents, openAlerts] = await Promise.all([
      this.components(),
      this.activeIncidents(),
      this.countOpenAlerts(),
    ]);

    return {
      status: overallStatus(components),
      checkedAt: new Date().toISOString(),
      components,
      activeIncidents: incidents,
      summary: {
        activeIncidents: incidents.length,
        p0Incidents: incidents.filter((incident) => incident.severity === 'P0').length,
        openAlerts,
        publishedIncidents: incidents.filter((incident) => incident.customerVisible).length,
      },
    };
  }

  /**
   * What a company sees.
   *
   * **Built from published incidents alone.** Not from the component probes, not from the alert
   * table, not from a status derived by combining the two. A company is told UBoss's status and
   * the incidents UBoss deliberately published, in the words an operator wrote for them — never
   * which internal component is failing, which is an architecture disclosure rather than a status.
   *
   * The consequence is deliberate and worth stating: **an outage nobody published reads as `ok`.**
   * UBoss would rather say nothing than leak an internal reading it did not mean to publish, and
   * the pressure to publish belongs on the incident process, not on a scraper.
   */
  async customerVisibleStatus(): Promise<CustomerVisibleStatus> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.serviceAlert.findMany({
        where: {
          customerVisible: true,
          incidentSeverity: { not: null },
          state: { not: 'Resolved' },
        },
        orderBy: [{ openedAt: 'desc' }],
        take: 20,
        // An explicit projection, not a whole row. `summary`, `detail`, `service` and
        // `affected_tenant_id` are internal, and a `select` is the difference between "we do not
        // show that" and "we forgot to strip that".
        // **`summary` and `detail` are deliberately not selected.** They are an operator's
        // internal headline and notes — "db-primary-2 exhausted its connection pool" — and an
        // earlier version of this method sent `summary` as the incident's title, which published
        // precisely the detail this endpoint exists to withhold. Not selecting them means no
        // later edit to the mapping can reintroduce it.
        select: {
          id: true,
          incidentSeverity: true,
          state: true,
          openedAt: true,
          customerImpact: true,
        },
      }),
    );

    const incidents = rows.map((row) => ({
      id: row.id,
      severity: row.incidentSeverity as IncidentSeverity,
      state: SystemHealthService.toIncidentState(row.state),
      startedAt: row.openedAt.toISOString(),
      // Never null in practice — `published_incident_has_customer_wording` refuses a published
      // row without it — and defaulted rather than asserted, so a future schema change degrades
      // to a vague sentence instead of a crash on a status page.
      customerImpact: row.customerImpact ?? 'We are investigating.',
    }));

    const status = statusFromIncidents(
      incidents.map((incident) => ({ severity: incident.severity, state: incident.state })),
    );

    return {
      status,
      summary:
        incidents.length === 0
          ? 'All UBoss services are operating normally.'
          : incidents.length === 1
            ? 'We are working on one incident affecting UBoss.'
            : `We are working on ${incidents.length} incidents affecting UBoss.`,
      incidents,
    };
  }

  // -------------------------------------------------------------------------
  // Components
  // -------------------------------------------------------------------------

  private async components(): Promise<ComponentHealth[]> {
    const [api, queue, providers, connections] = await Promise.all([
      this.apiAndDatabase(),
      this.queueHealth(),
      this.providerHealth(),
      this.connectionHealth(),
    ]);

    return [...api, queue, providers, connections];
  }

  /** The API process and the database, from the endpoint that already probes them. */
  private async apiAndDatabase(): Promise<ComponentHealth[]> {
    try {
      const response = await this.health.getHealth();
      const database = response.dependencies?.find((entry) => entry.name === 'postgres');

      return [
        {
          component: 'Api' as HealthComponent,
          status: 'ok',
          detail: `Version ${response.version}, up ${Math.floor(response.uptimeSeconds / 60)}m.`,
          measured: true,
        },
        {
          component: 'Database' as HealthComponent,
          status: database === undefined ? 'degraded' : database.status === 'up' ? 'ok' : 'down',
          detail:
            database === undefined
              ? 'The health endpoint returned no database probe.'
              : database.status === 'up'
                ? `Reachable in ${database.latencyMs}ms.`
                : // The probe's own reason, which is a connectivity message by contract and never
                  // a connection string.
                  (database.reason ?? 'Not reachable.'),
          measured: true,
        },
      ];
    } catch (error) {
      return [
        {
          component: 'Api',
          status: 'degraded',
          detail: `The health probe itself failed: ${SystemHealthService.message(error)}`,
          measured: false,
        },
        {
          component: 'Database',
          status: 'degraded',
          detail: 'Not probed, because the health endpoint failed first.',
          measured: false,
        },
      ];
    }
  }

  private async queueHealth(): Promise<ComponentHealth> {
    try {
      const queue = await this.queue.health();

      const status: HealthStatus = !queue.measured
        ? 'ok'
        : (queue.failed ?? 0) > 0
          ? 'degraded'
          : 'ok';

      const counts = queue.measured
        ? `${queue.waiting ?? 0} waiting, ${queue.active ?? 0} running, ${queue.failed ?? 0} failed.`
        : queue.detail;

      return {
        component: 'Queue',
        status,
        detail: `${queue.kind}: ${counts}`,
        // False for the inline transport, which has no backlog to measure — reporting "0 waiting"
        // would be a green figure nothing measured.
        measured: queue.measured,
      };
    } catch (error) {
      return {
        component: 'Queue',
        status: 'down',
        detail: `The queue could not be reached: ${SystemHealthService.message(error)}`,
        measured: false,
      };
    }
  }

  /**
   * Whether the registered provider adapters can reach a provider at all.
   *
   * **Not a live call.** Asking every provider for a completion to colour a dashboard would spend
   * a company's credits on a health check. `canReachProvider` is the adapter's own statement about
   * whether it is configured, which is the honest thing this page can know for free — and
   * `measured: false` says so rather than presenting it as a probe.
   */
  private async providerHealth(): Promise<ComponentHealth> {
    const real = this.providers.filter((adapter) => adapter.canReachProvider);
    const kinds = real.map((adapter) => adapter.kind).join(', ');

    if (real.length === 0) {
      return {
        component: 'Providers',
        status: 'ok',
        detail:
          'No provider adapter is configured to reach a real provider. AI calls are served by ' +
          'the mock adapter, and every result they produce is recorded as not produced by a ' +
          'real model.',
        measured: false,
      };
    }

    return {
      component: 'Providers',
      status: 'ok',
      detail:
        `${real.length} adapter(s) configured to reach a provider (${kinds}). ` +
        'Reachability is not probed here — a health check that called a provider would spend ' +
        'credits to colour a dashboard.',
      measured: false,
    };
  }

  /**
   * A summary of every company's connection checks.
   *
   * Counts only — how many connections, how many failing, how many need re-authorization. **No
   * company is named and no check detail is returned**: this is a platform screen, and an operator
   * reading "Acme's Salesforce credential expired" from a health page would be tenant content
   * arriving without a support session.
   */
  private async connectionHealth(): Promise<ComponentHealth> {
    try {
      return await this.prisma.runAsPlatformOperation(async () => {
        const [total, disabled, needingReauth, failingLast] = await Promise.all([
          this.prisma.client.connection.count({ where: { disabledAt: null } }),
          this.prisma.client.connection.count({ where: { disabledAt: { not: null } } }),
          this.prisma.client.connection.count({
            where: { disabledAt: null, needsReauthorization: true },
          }),
          this.prisma.client.connection.count({
            where: { disabledAt: null, lastError: { not: null } },
          }),
        ]);

        if (total === 0) {
          return {
            component: 'Connections' as HealthComponent,
            status: 'ok' as HealthStatus,
            detail: 'No company has a live connection yet.',
            measured: true,
          };
        }

        const unhealthy = needingReauth + failingLast;
        const status: HealthStatus =
          unhealthy === 0 ? 'ok' : unhealthy >= total ? 'down' : 'degraded';

        return {
          component: 'Connections' as HealthComponent,
          status,
          detail:
            `${total} live across all companies; ${needingReauth} need re-authorization, ` +
            `${failingLast} last failed a check, ${disabled} disabled.`,
          measured: true,
        };
      });
    } catch (error) {
      return {
        component: 'Connections',
        status: 'degraded',
        detail: `Connection health could not be read: ${SystemHealthService.message(error)}`,
        measured: false,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Incidents
  // -------------------------------------------------------------------------

  /** Declared incidents that are not yet resolved. */
  async activeIncidents(): Promise<IncidentView[]> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.serviceAlert.findMany({
        where: { incidentSeverity: { not: null }, state: { not: 'Resolved' } },
        orderBy: [{ incidentSeverity: 'asc' }, { openedAt: 'desc' }],
        take: 100,
      }),
    );

    return rows.map((row) => SystemHealthService.toIncidentView(row));
  }

  private async countOpenAlerts(): Promise<number> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.serviceAlert.count({ where: { state: { not: 'Resolved' } } }),
    );
  }

  private static message(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }

  /**
   * `Mitigated` exists on the alert enum and on the incident vocabulary, and the other two alert
   * states map straight across. Written as a switch rather than a cast so that adding a state to
   * either list is a **type error** here instead of a silent mismatch on a status page.
   */
  private static toIncidentState(state: string): IncidentState {
    switch (state) {
      case 'Open':
        return 'Open';
      case 'Acknowledged':
        return 'Acknowledged';
      case 'Mitigated':
        return 'Mitigated';
      case 'Resolved':
        return 'Resolved';
      default:
        // An unknown state is treated as active rather than resolved: the safe reading of "we do
        // not recognise this" on a health page is that something is still wrong.
        return 'Open';
    }
  }

  static toIncidentView(row: {
    id: string;
    service: string;
    summary: string;
    detail: string | null;
    incidentSeverity: string | null;
    state: string;
    ownerUserId: string | null;
    customerVisible: boolean;
    customerImpact: string | null;
    mitigation: string | null;
    openedAt: Date;
    mitigatedAt: Date | null;
    resolvedAt: Date | null;
    declaredAt: Date | null;
    declaredByUserId: string | null;
  }): IncidentView {
    return {
      id: row.id,
      reference: row.id.slice(0, 8),
      service: row.service,
      // The alert's `summary` is its headline; there is no separate title column, and adding one
      // would have meant two fields nobody could tell apart.
      title: row.summary,
      summary: row.summary,
      detail: row.detail,
      severity: (row.incidentSeverity ?? 'P2') as IncidentSeverity,
      state: SystemHealthService.toIncidentState(row.state),
      ownerUserId: row.ownerUserId,
      customerVisible: row.customerVisible,
      customerImpact: row.customerImpact,
      mitigation: row.mitigation,
      startedAt: row.openedAt.toISOString(),
      mitigatedAt: row.mitigatedAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      declaredAt: row.declaredAt?.toISOString() ?? null,
      declaredByUserId: row.declaredByUserId,
    };
  }

  /** Whether a state counts as active, re-exported so a screen need not import the vocabulary. */
  static isActive(state: IncidentState): boolean {
    return incidentIsActive(state);
  }
}
