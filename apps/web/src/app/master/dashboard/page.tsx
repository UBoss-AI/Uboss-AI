'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  Banner,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  MetricCard,
  PageHeader,
  SkeletonText,
  StatusBadge,
  type DataTableColumn,
} from '@uboss/ui';

import {
  ApiError,
  formatMinor,
  platformApi,
  type CompanySummary,
  type DataProvenance,
  type PlatformDashboard,
} from '../../../lib/api-client';

/**
 * Platform Overview — the Master Console dashboard.
 *
 * ## What the client asked for, and where each piece comes from
 *
 * "Dashboard must show companies, status, seats, renewals, AI usage/billing attention and service
 * alerts from real database/demo data." Every one of those is here, and each panel says which of
 * the two it is:
 *
 *   * **Companies, status, seats used** — measured, from `tenants` and `tenant_memberships`.
 *   * **Seats licensed, renewals, billing state, AI allowance** — configured, from `plans` and
 *     `tenant_subscriptions`.
 *   * **AI consumption, service alerts** — demo. No metering and no health probes exist yet.
 *   * **Security attention** — measured, from the Prompt 8 append-only trails.
 *
 * ## Why the provenance is on the screen and not only in the docs
 *
 * An operator looking at "AI spend $18.4k" has no way to tell a metered figure from a seeded one,
 * and the difference matters the first time they act on it. Every KPI carries its source, and the
 * footer lists all six panels — so a rendering oversight on one badge cannot hide the caveat
 * entirely.
 *
 * The reference's KPI set is `Active companies / Platform seats / AI spend (MTD) / Open
 * incidents`, and that is what these four are. Its deltas ("+3 this month", "82% utilized") are
 * **not** reproduced where the product cannot compute them: there is no month-over-month history
 * yet, so a "+3 this month" here would be a decorative fiction. Seat utilisation is real and is
 * shown.
 */
export default function MasterDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<PlatformDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    platformApi
      .dashboard()
      .then(setData)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load the dashboard.'),
      );
  }, []);

  const attentionColumns: DataTableColumn<CompanySummary>[] = [
    {
      key: 'company',
      header: 'Company',
      render: (row) => (
        <>
          <b>{row.name}</b>
          <br />
          <small className="uboss-muted-3 uboss-mono">{row.reference}</small>
        </>
      ),
    },
    {
      key: 'flag',
      header: 'Flag',
      // One flag, and the reasons in the title — a table cell holding four badges is a cell
      // nobody scans, but dropping the other reasons would make the console lie by omission.
      render: (row) => (
        <span title={row.attentionReasons.join('\n')}>
          <StatusBadge status={row.flag} tone={flagTone(row.flag)} />
        </span>
      ),
    },
    {
      key: 'billing',
      header: 'Billing',
      render: (row) =>
        row.billing ? <StatusBadge status={row.billing} tone={billingTone(row.billing)} /> : '—',
    },
    { key: 'usage', header: 'Usage', render: (row) => row.aiUsageLabel },
  ];

  const renewalColumns: DataTableColumn<CompanySummary>[] = [
    { key: 'company', header: 'Company', render: (row) => <b>{row.name}</b> },
    { key: 'plan', header: 'Plan', render: (row) => row.plan ?? '—' },
    { key: 'seats', header: 'Seats', render: (row) => row.seatsLabel },
    {
      key: 'renewal',
      header: 'Renewal',
      render: (row) =>
        row.daysToRenewal === null ? (
          '—'
        ) : row.daysToRenewal < 0 ? (
          <StatusBadge status={`${Math.abs(row.daysToRenewal)}d overdue`} tone="danger" />
        ) : (
          <StatusBadge
            status={`${row.daysToRenewal}d`}
            tone={row.daysToRenewal <= 14 ? 'warn' : 'grey'}
          />
        ),
    },
  ];

  if (error) {
    return (
      <>
        <PageHeader title="Platform overview" description="Cross-company operational view." />
        <Banner tone="danger">{error}</Banner>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Platform overview" description="Cross-company operational view." />
        <Card>
          <CardBody>
            <SkeletonText lines={5} />
          </CardBody>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Platform overview" description="Cross-company operational view." />

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}
      >
        <MetricCard
          label="Active companies"
          value={data.kpis.activeCompanies.value}
          delta={`${data.kpis.activeCompanies.total} provisioned · ${provenanceWord(
            data.kpis.activeCompanies.provenance,
          )}`}
        />
        <MetricCard
          label="Platform seats"
          value={data.kpis.platformSeats.used}
          delta={
            data.kpis.platformSeats.utilisationPercent === null
              ? `of ${data.kpis.platformSeats.licensed} licensed`
              : `${data.kpis.platformSeats.utilisationPercent}% of ${data.kpis.platformSeats.licensed} licensed`
          }
        />
        <MetricCard
          label="AI allowance consumed"
          value={formatMinor(data.kpis.aiSpend.consumedMinor, data.kpis.aiSpend.currency)}
          // Named as demo on the tile itself. The reference calls this "AI spend (MTD)"; calling
          // it spend would imply a metered figure, and nothing here is metered yet.
          delta={`of ${formatMinor(data.kpis.aiSpend.allowanceMinor, data.kpis.aiSpend.currency)} · demo data`}
        />
        <MetricCard
          label="Open service alerts"
          value={data.kpis.openIncidents.value}
          delta={`${data.kpis.openIncidents.critical} critical · demo data`}
        />
      </div>

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))' }}
      >
        <Card>
          <CardHeader
            title="Companies needing attention"
            aside={
              <span className="uboss-muted-3">
                {data.companiesNeedingAttention.length} of {data.companies.length}
              </span>
            }
          />
          <CardBody>
            {data.companiesNeedingAttention.length === 0 ? (
              <EmptyState
                title="Nothing needs attention"
                description="No company is flagged for billing, budget, seats, renewal or security."
              />
            ) : (
              <DataTable
                caption="Companies flagged for attention, worst reason first"
                columns={attentionColumns}
                rows={data.companiesNeedingAttention}
                rowKey={(row) => row.tenantId}
                onRowSelect={(row) => router.push(`/master/companies/${row.tenantId}`)}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Security attention"
            aside={<StatusBadge status="Measured" tone="success" />}
          />
          <CardBody>
            {/*
              The one panel on this dashboard that is entirely real. Every figure comes from the
              Prompt 8 trails, which are append-only and hash-chained — so unlike the commercial
              panels, these numbers cannot have been quietly edited.
            */}
            <div className="uboss-kv">
              <span className="uboss-kv-key">Critical security events (30d)</span>
              <span className="uboss-kv-value">
                {data.securityAttention.criticalEventsLast30Days}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Break-glass grants active now</span>
              <span className="uboss-kv-value">
                {data.securityAttention.activeBreakGlassGrants}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Customers not yet notified of break-glass</span>
              <span className="uboss-kv-value">
                {data.securityAttention.pendingCustomerNotifications}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">People holding platform authority</span>
              <span className="uboss-kv-value">{data.securityAttention.platformRoleHolders}</span>
            </div>
            {data.securityAttention.pendingCustomerNotifications > 0 ? (
              <Banner tone="warn">
                {data.securityAttention.pendingCustomerNotifications} break-glass record(s) have not
                been notified to the customer. That is an outstanding obligation, not a backlog
                item.
              </Banner>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))' }}
      >
        <Card>
          <CardHeader
            title="Renewals due"
            aside={<span className="uboss-muted-3">next 30 days</span>}
          />
          <CardBody>
            {data.renewalsDue.length === 0 ? (
              <EmptyState
                title="No renewals in the next 30 days"
                description="Renewal dates come from each company's subscription."
              />
            ) : (
              <DataTable
                caption="Companies renewing within 30 days"
                columns={renewalColumns}
                rows={data.renewalsDue}
                rowKey={(row) => row.tenantId}
                onRowSelect={(row) => router.push(`/master/companies/${row.tenantId}`)}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Service alerts"
            aside={<StatusBadge status="Demo data" tone="warn" />}
          />
          <CardBody>
            {data.serviceAlerts.length === 0 ? (
              <EmptyState title="No open service alerts" />
            ) : (
              <DataTable
                caption="Open platform service alerts"
                columns={[
                  { key: 'service', header: 'Service', render: (row) => row.service },
                  {
                    key: 'severity',
                    header: 'Severity',
                    render: (row) => (
                      <StatusBadge status={row.severity} tone={severityTone(row.severity)} />
                    ),
                  },
                  { key: 'summary', header: 'Summary', render: (row) => row.summary },
                  { key: 'state', header: 'State', render: (row) => row.state },
                ]}
                rows={data.serviceAlerts}
                rowKey={(row) => row.id}
                onRowSelect={() => router.push('/master/health')}
              />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Where these numbers come from" />
        <CardBody>
          {/*
            Listed in full, not only as per-tile badges. A screen that forgets one badge still has
            to show this, so the caveat cannot be lost to a rendering oversight.
          */}
          <DataTable
            caption="Data provenance by panel"
            columns={[
              { key: 'panel', header: 'Panel', render: (row) => row.panel },
              {
                key: 'provenance',
                header: 'Source',
                render: (row) => (
                  <StatusBadge
                    status={provenanceWord(row.provenance)}
                    tone={provenanceTone(row.provenance)}
                  />
                ),
              },
              { key: 'note', header: 'What that means', render: (row) => row.note },
            ]}
            rows={data.provenanceNotes}
            rowKey={(row) => row.panel}
          />
          <p className="uboss-muted-3">
            Generated {new Date(data.generatedAt).toLocaleString()}. Measured figures are counted
            from data the product produces; configured figures were set deliberately by a platform
            operator; demo figures are seeded and no metering exists behind them yet.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

function provenanceWord(provenance: DataProvenance): string {
  return provenance === 'measured'
    ? 'Measured'
    : provenance === 'configured'
      ? 'Configured'
      : 'Demo';
}

function provenanceTone(provenance: DataProvenance): 'success' | 'blue' | 'warn' {
  return provenance === 'measured' ? 'success' : provenance === 'configured' ? 'blue' : 'warn';
}

/** Security outranks a commercial flag, and the colours have to agree with that ordering. */
export function flagTone(flag: string): 'grey' | 'warn' | 'danger' {
  return flag === 'None' ? 'grey' : flag === 'Security' ? 'danger' : 'warn';
}

export function billingTone(billing: string): 'success' | 'warn' | 'danger' {
  return billing === 'Current' ? 'success' : billing === 'Grace' ? 'warn' : 'danger';
}

export function severityTone(severity: string): 'grey' | 'warn' | 'danger' {
  return severity === 'Critical' ? 'danger' : severity === 'Warning' ? 'warn' : 'grey';
}
