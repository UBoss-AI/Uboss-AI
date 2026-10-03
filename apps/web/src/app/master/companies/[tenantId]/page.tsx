'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  MetricCard,
  PageHeader,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import {
  ApiError,
  formatMinor,
  platformApi,
  type CompanyDetail,
  type PlatformEconomics,
} from '../../../../lib/api-client';
import { useMasterConsole } from '../../layout';
import { billingTone, flagTone, severityTone } from '../../dashboard/page';

/**
 * Company Detail — one customer company, as the platform sees it.
 *
 * The reference's layout: KPIs across the top, then Profile and Modules & entitlements side by
 * side, then the actions.
 *
 * ## Two reference actions are deliberately not here
 *
 * The prototype offers **"Impersonate (audited)"** and **"Suspend tenant"** as buttons on this
 * screen. Neither is built, and neither is rendered as a dead control:
 *
 *   * **Impersonate** is break-glass by another name, and break-glass already exists properly
 *     (Prompt 8): identity verification, a second approver, a bounded scope, an expiry and the
 *     customer notified. A one-click "impersonate" button beside a company would route around
 *     all of it, and the whole point of that design is that there is no such route. The panel
 *     below links to the break-glass flow instead.
 *   * **Suspend tenant** is a lifecycle transition with real consequences for everybody signed
 *     in, and it needs a reason, a confirmation and a notification path. It is listed as
 *     unbuilt rather than shipped as a button that would work but shouldn't yet.
 *
 * Recorded in `docs/UX_MAP.md` as a deliberate divergence from the reference rather than an
 * oversight.
 */
export default function MasterCompanyDetailPage() {
  const router = useRouter();
  const params = useParams<{ tenantId: string }>();
  const { can } = useMasterConsole();

  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [economics, setEconomics] = useState<PlatformEconomics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenantId = params.tenantId;
  const mine = economics?.companies.find((row) => row.tenantId === tenantId) ?? null;
  const economicsCurrency = economics?.currency ?? 'INR';

  const load = useCallback(() => {
    platformApi
      .company(tenantId)
      .then(setDetail)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load the company.'),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  /*
   * The commercial position, fetched separately.
   *
   * It is guarded by `billing:View` while the rest of this screen is not, so somebody who may
   * administer a company but not read its margin gets the screen rather than an error. A failure
   * here leaves the panel out entirely, which is the honest rendering of "you cannot see this".
   */
  useEffect(() => {
    platformApi
      .economics()
      .then(setEconomics)
      .catch(() => setEconomics(null));
  }, []);

  if (error) {
    return (
      <>
        <PageHeader title="Company" description="Tenant detail and administration." />
        <Banner tone="danger">{error}</Banner>
        <Button variant="navy" icon="back" onClick={() => router.push('/master/companies')}>
          Back to Companies
        </Button>
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <PageHeader title="Company" description="Tenant detail and administration." />
        <Card>
          <CardBody>
            <SkeletonText lines={5} />
          </CardBody>
        </Card>
      </>
    );
  }

  const { company, entitlements, subscription } = detail;

  return (
    <>
      <PageHeader
        title={company.name}
        description="Tenant detail and administration."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'Companies', onSelect: () => router.push('/master/companies') },
          { label: 'Detail' },
        ]}
        actions={
          <Button variant="navy" icon="back" onClick={() => router.push('/master/companies')}>
            Back
          </Button>
        }
      />

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}
      >
        <MetricCard label="Plan" value={company.plan ?? 'No plan'} />
        <MetricCard label="Seats" value={company.seatsLabel} delta="active members / licensed" />
        <MetricCard
          label="AI allowance used"
          value={company.aiUsageLabel}
          delta={
            subscription
              ? `${formatMinor(subscription.aiConsumedMinor, subscription.currency)} of ${formatMinor(
                  subscription.aiAllowanceMinor,
                  subscription.currency,
                )} · demo`
              : 'no subscription'
          }
        />
        <MetricCard
          label="Attention"
          value={company.flag === 'None' ? 'None' : company.flag}
          delta={`${company.attentionReasons.length} signal(s)`}
        />
      </div>

      {/*
        What this one company is worth.

        The detail screen could say what they were allowed to spend and never what UBoss made on
        them. Charged and cost come from different tables: the ledger holds the sell price, and
        `model_gateway_calls` holds the buy price. `providerCostMinor` is platform-plane and never
        reaches a company workspace.
      */}
      {mine === null ? null : (
        <Card>
          <CardHeader
            title="What this company is worth"
            aside={
              mine.costIsComplete ? null : (
                <span className="uboss-muted-3">
                  {mine.uncostedCalls.toLocaleString()} calls unpriced — the cost is understated
                </span>
              )
            }
          />
          <CardBody>
            <div
              className="uboss-grid"
              style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}
            >
              <MetricCard
                label="AI charged"
                value={formatMinor(mine.aiChargedMinor, economicsCurrency)}
                delta={`${mine.calls.toLocaleString()} call(s)`}
              />
              <MetricCard
                label="Paid to the provider"
                value={formatMinor(mine.providerCostMinor, economicsCurrency)}
                delta="never shown to this company"
              />
              <MetricCard
                label="AI margin"
                value={formatMinor(mine.aiMarginMinor, economicsCurrency)}
                delta={
                  mine.aiChargedMinor === 0
                    ? 'nothing charged yet'
                    : `${Math.round((mine.aiMarginMinor / mine.aiChargedMinor) * 100)}% of what was charged`
                }
              />
              <MetricCard
                label="Subscription paid"
                // Null, not zero — nobody paying is not the same as breaking even.
                value={
                  mine.paidMinor === 0 ? 'Not yet' : formatMinor(mine.paidMinor, economicsCurrency)
                }
                delta={`of ${formatMinor(mine.invoicedMinor, economicsCurrency)} invoiced`}
              />
            </div>
          </CardBody>
        </Card>
      )}

      {company.attentionReasons.length > 0 ? (
        <Card>
          <CardHeader
            title="Why this company is flagged"
            aside={<StatusBadge status={company.flag} tone={flagTone(company.flag)} />}
          />
          <CardBody>
            {/*
              Every reason, not just the winning flag. The list column on Companies shows one
              badge because a cell with four is unreadable; this is where the rest belong.
            */}
            <ul>
              {company.attentionReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))' }}
      >
        <Card>
          <CardHeader title="Profile" />
          <CardBody>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Reference</span>
              <span className="uboss-kv-value uboss-mono">{company.reference}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Legal name</span>
              <span className="uboss-kv-value">{company.legalName ?? '—'}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Status</span>
              <span className="uboss-kv-value">
                <StatusBadge status={company.status} />
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Provisioned</span>
              <span className="uboss-kv-value">
                {new Date(company.createdAt).toLocaleDateString()}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Billing</span>
              <span className="uboss-kv-value">
                {company.billing ? (
                  <StatusBadge status={company.billing} tone={billingTone(company.billing)} />
                ) : (
                  '—'
                )}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Renews</span>
              <span className="uboss-kv-value">
                {company.renewsAt
                  ? `${new Date(company.renewsAt).toLocaleDateString()} (${company.daysToRenewal}d)`
                  : '—'}
              </span>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Modules & entitlements"
            aside={
              <StatusBadge
                status={detail.provenance.entitlements === 'configured' ? 'Configured' : 'Demo'}
                tone="blue"
              />
            }
          />
          <CardBody>
            {subscription === null ? (
              <EmptyState
                title="No subscription"
                description="This company is not on a plan, so it has no entitlements from one."
              />
            ) : (
              <>
                <div className="uboss-section-label">Effective modules</div>
                <p>{entitlements.effectiveModules.join(' · ') || '—'}</p>

                <div className="uboss-section-label">From the plan</div>
                <p className="uboss-muted-3">{entitlements.planModules.join(' · ') || '—'}</p>

                {entitlements.extraModules.length > 0 ? (
                  <>
                    <div className="uboss-section-label">Extras added for this company</div>
                    <p>{entitlements.extraModules.join(' · ')}</p>
                  </>
                ) : null}

                {entitlements.removedModules.length > 0 ? (
                  <>
                    <div className="uboss-section-label">Withheld despite the plan</div>
                    {/*
                      Removed wins over extra. Stated on the screen because two columns that could
                      disagree need a visible precedence, not one buried in a service.
                    */}
                    <p>{entitlements.removedModules.join(' · ')}</p>
                  </>
                ) : null}
              </>
            )}
          </CardBody>
        </Card>
      </div>

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))' }}
      >
        <Card>
          <CardHeader
            title="Recent activity in this company"
            aside={<StatusBadge status="Measured" tone="success" />}
          />
          <CardBody>
            {detail.recentAudit.length === 0 ? (
              <EmptyState title="No audit events" />
            ) : (
              <DataTable
                caption="The company's own audit trail, newest first"
                columns={[
                  { key: 'action', header: 'Action', render: (row) => row.action },
                  {
                    key: 'what',
                    header: 'What',
                    render: (row) => row.summary ?? row.resourceType,
                  },
                  { key: 'why', header: 'Why', render: (row) => row.reason ?? '—' },
                  {
                    key: 'when',
                    header: 'When',
                    render: (row) => new Date(row.occurredAt).toLocaleString(),
                  },
                ]}
                rows={detail.recentAudit}
                rowKey={(row) => `${row.action}-${row.occurredAt}`}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Security position"
            aside={<StatusBadge status="Measured" tone="success" />}
          />
          <CardBody>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Critical security events (30d)</span>
              <span className="uboss-kv-value">{company.security.criticalEvents}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Break-glass grants active</span>
              <span className="uboss-kv-value">{company.security.activeBreakGlass}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Customer not yet notified</span>
              <span className="uboss-kv-value">
                {company.security.breakGlassPendingNotification}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Open service alerts</span>
              <span className="uboss-kv-value">{company.openServiceAlerts}</span>
            </div>

            {detail.recentSecurity.length > 0 ? (
              <DataTable
                caption="Recent security events for this company"
                columns={[
                  {
                    key: 'severity',
                    header: 'Severity',
                    render: (row) => (
                      <StatusBadge status={row.severity} tone={severityTone(row.severity)} />
                    ),
                  },
                  { key: 'action', header: 'Event', render: (row) => row.action },
                  { key: 'outcome', header: 'Outcome', render: (row) => row.outcome },
                  {
                    key: 'when',
                    header: 'When',
                    render: (row) => new Date(row.occurredAt).toLocaleString(),
                  },
                ]}
                rows={detail.recentSecurity}
                rowKey={(row) => `${row.action}-${row.occurredAt}`}
              />
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Platform actions on this company" />
        <CardBody>
          {/*
            The two reference buttons that are NOT here, and why. See the file comment — this is
            the honest version of "Impersonate (audited)" and "Suspend tenant".
          */}
          <Banner tone="info">
            Accessing this company&apos;s data is <b>break-glass</b>, not impersonation: it needs
            identity verification, a second approver, a named scope, an expiry and a customer
            notification, and every step is written into this company&apos;s own audit trail. There
            is deliberately no one-click route around that.
          </Banner>

          {/*
            Both of the placeholders that stood here at Prompt 9 — "Suspend company" and "Change
            commercial terms" — are built. They arrived in the shape the placeholder note
            predicted: a reason, an impact preview and a confirmation, on their own screen rather
            than as a button on a page somebody opened to read a number.
          */}
          <div className="uboss-actions">
            <Button
              variant="navy"
              onClick={() => router.push(`/master/companies/${tenantId}/commercial`)}
            >
              Plan, seats &amp; lifecycle
            </Button>
          </div>
          <p className="uboss-muted-3">
            Contracted seats, the operating state and this company&apos;s commercial requests.
            {can('companies', 'Administer')
              ? ' Your role can change them; each change records a reason.'
              : ' Your role can read them but not change them — changing a customer’s contract or operating state needs companies: Administer.'}
          </p>
        </CardBody>
      </Card>
    </>
  );
}
