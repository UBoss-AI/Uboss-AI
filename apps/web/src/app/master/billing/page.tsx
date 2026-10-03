'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  PageHeader,
  SkeletonText,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  formatMinor,
  platformBillingApi,
  type BillingCompanyRow,
  type BillingConnection,
  type BillingDeliveryRow,
  type BillingPlanRow,
} from '../../../lib/api-client';
import { useMasterConsole } from '../layout';

/**
 * Billing & Payments.
 *
 * ## What this screen answers, and why those four things
 *
 * **Is a provider connected, and in which mode.** Everything else on this screen is meaningless
 * without it, and "which mode" is the first question asked when an invoice is missing. It is read
 * from the secret key's own prefix rather than configured, so a deployment cannot be pointed at
 * live keys while believing it is in test.
 *
 * **Which plans can actually be bought.** A plan that has never been published to the provider has
 * no price there, so a company choosing it gets a refusal at the moment it tries to pay. The
 * column says so before that happens — and says when a published price has gone stale, which is
 * the quieter failure: provider prices are immutable, so a plan whose price was edited after
 * publishing keeps charging the old one until somebody publishes it again.
 *
 * **What each company has paid.** The provider's own status word is shown beside this product's
 * translation of it, because when the two disagree that is the finding rather than a detail.
 *
 * **Whether the integration is still working.** A webhook that has quietly stopped arriving is the
 * failure this integration is most exposed to: nothing errors, and every company slowly drifts out
 * of date. The deliveries table is the only place that is visible.
 *
 * ## What this screen deliberately cannot do
 *
 * Charge a company, refund one, or edit an invoice. Those are the provider's own screens, they are
 * correct there, and rebuilding them here would mean this product holding a second opinion about
 * money. Nothing on this page is a figure this product computed — every amount is the provider's,
 * copied verbatim.
 */

const BILLING_TONE: Record<string, StatusTone> = {
  Current: 'success',
  Grace: 'warn',
  Overdue: 'danger',
};

const STATE_TONE: Record<string, StatusTone> = {
  Active: 'success',
  Pending: 'blue',
  Suspended: 'danger',
  Expired: 'grey',
  Cancelled: 'grey',
};

/**
 * The company's lifecycle state, in words a person running the platform would use.
 *
 * `ReadOnly` reads as a setting; "Read-only" reads as a condition the customer is in, which is
 * what this column is about.
 */
const ACCESS_LABEL: Record<string, string> = {
  Active: 'Working',
  ReadOnly: 'Read-only',
  Suspended: 'Locked out',
  Closed: 'Closed',
  Provisioning: 'Being set up',
  PendingActivation: 'Not activated',
};

/** Read-only is a warning, not a failure: the company is still there and can still pay. */
const ACCESS_TONE: Record<string, StatusTone> = {
  Active: 'success',
  ReadOnly: 'warn',
  Suspended: 'danger',
  Closed: 'grey',
  Provisioning: 'blue',
  PendingActivation: 'blue',
};

const OUTCOME_TONE: Record<string, StatusTone> = {
  applied: 'success',
  ignored: 'grey',
  failed: 'danger',
};

/** How long ago, in the shortest form that is still unambiguous. */
function ago(iso: string | null): string {
  if (iso === null) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function MasterBillingPage() {
  const router = useRouter();
  const { can } = useMasterConsole();

  const [connection, setConnection] = useState<BillingConnection | null>(null);
  const [plans, setPlans] = useState<BillingPlanRow[] | null>(null);
  const [companies, setCompanies] = useState<BillingCompanyRow[] | null>(null);
  const [deliveries, setDeliveries] = useState<BillingDeliveryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([
      platformBillingApi.connection(),
      platformBillingApi.plans(),
      platformBillingApi.companies(),
      platformBillingApi.deliveries(),
    ])
      .then(([loadedConnection, loadedPlans, loadedCompanies, loadedDeliveries]) => {
        setConnection(loadedConnection);
        setPlans(loadedPlans.plans);
        setCompanies(loadedCompanies.companies);
        setDeliveries(loadedDeliveries.deliveries);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load billing.'),
      );
  }, []);

  useEffect(load, [load]);

  const mayAdminister = can('billing', 'Administer');

  const publish = (plan: BillingPlanRow) => {
    setPublishing(plan.id);
    setError(null);
    setNotice(null);
    platformBillingApi
      .publishPlan(plan.id)
      .then(() => {
        setNotice(`${plan.name} is published. Companies can now buy it.`);
        load();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : `Could not publish ${plan.name}.`),
      )
      .finally(() => setPublishing(null));
  };

  const lastDelivery = deliveries?.[0] ?? null;

  return (
    <>
      <PageHeader
        title="Billing & Payments"
        description="The payment provider, what can be bought, and what each company has paid."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'Billing' },
        ]}
        actions={<Button onClick={load}>Refresh</Button>}
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      {/*
        The connection, first and unmissable.

        Everything below it is meaningless if this says no provider is connected, so it is stated
        rather than left to be inferred from empty tables.
      */}
      <Card>
        <CardHeader
          title="Payment provider"
          aside={
            connection === null ? null : (
              <StatusBadge
                status={
                  connection.connected
                    ? `Connected · ${connection.mode === 'live' ? 'LIVE' : 'Test mode'}`
                    : 'Not connected'
                }
                tone={
                  !connection.connected ? 'danger' : connection.mode === 'live' ? 'warn' : 'success'
                }
              />
            )
          }
        />
        <CardBody>
          {connection === null ? (
            <SkeletonText lines={2} />
          ) : connection.connected ? (
            <>
              <p className="uboss-muted">
                {connection.mode === 'live'
                  ? 'This deployment can take real money. Every payment made here is a real charge.'
                  : 'This deployment is in test mode. No real money moves, and test cards are the ' +
                    'only ones that will work.'}
              </p>
              <p className="uboss-muted-3">
                {lastDelivery === null
                  ? 'No delivery has ever arrived from the provider. Until one does, nothing here ' +
                    'updates on its own — check that the webhook endpoint is reachable.'
                  : `Last delivery ${ago(lastDelivery.receivedAt)} — ${lastDelivery.type}.`}
              </p>
            </>
          ) : (
            <Banner tone="warn">
              {connection.reason ??
                'No payment provider is connected, so nothing on this screen can change.'}
            </Banner>
          )}
        </CardBody>
      </Card>

      {/* What can be bought */}
      <Card>
        <CardHeader title="Plans at the provider" />
        <CardBody>
          {plans === null ? (
            <SkeletonText lines={4} />
          ) : (
            <DataTable
              caption="Which plans have a price at the payment provider"
              columns={[
                {
                  key: 'plan',
                  header: 'Plan',
                  render: (row) => (
                    <>
                      <b>{row.name}</b>
                      <br />
                      <small className="uboss-muted-3 uboss-mono">{row.code}</small>
                    </>
                  ),
                },
                {
                  key: 'price',
                  header: 'Price / mo',
                  // Null is a negotiated price, not free — and such a plan cannot be published,
                  // because there is no figure to charge.
                  render: (row) =>
                    row.priceMinor === null ? 'Custom' : formatMinor(row.priceMinor, row.currency),
                },
                {
                  key: 'published',
                  header: 'At the provider',
                  render: (row) =>
                    !row.published ? (
                      <StatusBadge status="Not published" tone="grey" />
                    ) : row.priceStale ? (
                      <StatusBadge status="Price stale" tone="warn" />
                    ) : (
                      <StatusBadge status="Published" tone="success" />
                    ),
                },
                {
                  key: 'detail',
                  header: '',
                  render: (row) =>
                    !row.published ? (
                      <small className="uboss-muted-3">
                        No company can buy this plan until it is published.
                      </small>
                    ) : row.priceStale ? (
                      <small className="uboss-muted-3">
                        Published at{' '}
                        {row.publishedPriceMinor === null
                          ? '—'
                          : formatMinor(row.publishedPriceMinor, row.currency)}
                        . Provider prices cannot be edited, so it still charges that. Publish again
                        to charge the current price.
                      </small>
                    ) : (
                      <small className="uboss-muted-3 uboss-mono">{row.stripeProductId}</small>
                    ),
                },
                {
                  key: 'action',
                  header: '',
                  render: (row) =>
                    !mayAdminister ? null : (
                      <Button
                        onClick={() => publish(row)}
                        disabled={
                          publishing !== null ||
                          row.priceMinor === null ||
                          !row.active ||
                          connection?.connected !== true
                        }
                        title={
                          row.priceMinor === null
                            ? 'A negotiated price has no figure to charge.'
                            : !row.active
                              ? 'A retired plan must not become buyable again.'
                              : connection?.connected !== true
                                ? 'No payment provider is connected.'
                                : undefined
                        }
                      >
                        {publishing === row.id
                          ? 'Publishing…'
                          : row.published
                            ? 'Publish again'
                            : 'Publish'}
                      </Button>
                    ),
                },
              ]}
              rows={plans}
              rowKey={(row) => row.id}
            />
          )}
        </CardBody>
      </Card>

      {/* Who has paid */}
      <Card>
        <CardHeader title="Companies" />
        <CardBody>
          {companies === null ? (
            <SkeletonText lines={4} />
          ) : companies.length === 0 ? (
            <EmptyState title="No companies" description="No company has a subscription yet." />
          ) : (
            <DataTable
              caption="Each company's plan and payment position"
              columns={[
                {
                  key: 'company',
                  header: 'Company',
                  render: (row) => (
                    <>
                      <b>{row.tenantName}</b>
                      <br />
                      <small className="uboss-muted-3">{row.planName}</small>
                    </>
                  ),
                },
                {
                  key: 'state',
                  header: 'Subscription',
                  render: (row) => (
                    <StatusBadge status={row.state} tone={STATE_TONE[row.state] ?? 'grey'} />
                  ),
                },
                {
                  key: 'billing',
                  header: 'Billing',
                  render: (row) => (
                    <StatusBadge
                      status={row.billingState}
                      tone={BILLING_TONE[row.billingState] ?? 'grey'}
                    />
                  ),
                },
                {
                  key: 'access',
                  header: 'Access',
                  /*
                   * What the company can actually do, beside what it has agreed to.
                   *
                   * The two columns to the left are the commercial record. This one is the column
                   * the request guard enforces, and the difference is not academic: a company can
                   * be Suspended under Subscription and still be working normally, which is
                   * exactly the condition that went unnoticed until the webhook began moving
                   * lifecycle too. Showing both is how a disagreement becomes visible.
                   */
                  render: (row) => (
                    <>
                      <StatusBadge
                        status={ACCESS_LABEL[row.lifecycleState] ?? row.lifecycleState}
                        tone={ACCESS_TONE[row.lifecycleState] ?? 'grey'}
                      />
                      {row.accessReasonCode === 'PaymentOverdue' ? (
                        <>
                          <br />
                          <small className="uboss-muted-3">stopped for non-payment</small>
                        </>
                      ) : null}
                    </>
                  ),
                },
                {
                  key: 'provider',
                  header: 'At the provider',
                  /*
                   * The provider's own word, beside our translation of it above. When the two
                   * disagree — "Active" here and "past_due" there — that is the thing worth
                   * seeing, and it is invisible if only one of them is shown.
                   */
                  render: (row) =>
                    row.stripeCustomerId === null ? (
                      <small className="uboss-muted-3">Never connected</small>
                    ) : (
                      <>
                        <span className="uboss-mono">{row.stripeStatus ?? 'no subscription'}</span>
                        <br />
                        <small className="uboss-muted-3">synced {ago(row.stripeSyncedAt)}</small>
                      </>
                    ),
                },
                {
                  key: 'paid',
                  header: 'Paid',
                  render: (row) =>
                    row.invoicesPaid === 0 ? (
                      <span className="uboss-muted-3">—</span>
                    ) : (
                      <>
                        {formatMinor(row.paidMinor, row.currency)}
                        <br />
                        <small className="uboss-muted-3">
                          {row.invoicesPaid} invoice{row.invoicesPaid === 1 ? '' : 's'}
                        </small>
                      </>
                    ),
                },
                {
                  key: 'open',
                  header: '',
                  render: (row) => (
                    <Button
                      onClick={() => router.push(`/master/companies/${row.tenantId}/commercial`)}
                    >
                      Open
                    </Button>
                  ),
                },
              ]}
              rows={companies}
              rowKey={(row) => row.tenantId}
            />
          )}
        </CardBody>
      </Card>

      {/* Whether it is still working */}
      <Card>
        <CardHeader
          title="Recent deliveries from the provider"
          aside={
            deliveries === null ? null : (
              <StatusBadge
                status={`${deliveries.length} recorded`}
                tone={deliveries.length === 0 ? 'grey' : 'blue'}
              />
            )
          }
        />
        <CardBody>
          {deliveries === null ? (
            <SkeletonText lines={4} />
          ) : deliveries.length === 0 ? (
            <EmptyState
              title="Nothing has arrived yet"
              description={
                'The provider has never sent this deployment a webhook. Until one arrives, no ' +
                'payment, invoice or cancellation can change anything here — the redirect back ' +
                'from a payment page is deliberately not treated as evidence.'
              }
            />
          ) : (
            <DataTable
              caption="What the provider sent, and what was done with it"
              columns={[
                {
                  key: 'type',
                  header: 'Event',
                  render: (row) => (
                    <>
                      <span className="uboss-mono">{row.type}</span>
                      {row.livemode ? null : (
                        <>
                          {' '}
                          <StatusBadge status="test" tone="grey" />
                        </>
                      )}
                    </>
                  ),
                },
                {
                  key: 'outcome',
                  header: 'Outcome',
                  render: (row) =>
                    row.outcome === null ? (
                      // Claimed and never finished: the process stopped between recording the
                      // delivery and applying it. Worth seeing rather than rendering as blank.
                      <StatusBadge status="Never finished" tone="warn" />
                    ) : (
                      <StatusBadge
                        status={row.outcome}
                        tone={OUTCOME_TONE[row.outcome] ?? 'grey'}
                      />
                    ),
                },
                {
                  key: 'detail',
                  header: 'Detail',
                  render: (row) => <small className="uboss-muted-3">{row.detail ?? '—'}</small>,
                },
                {
                  key: 'when',
                  header: 'Received',
                  render: (row) => ago(row.receivedAt),
                },
              ]}
              rows={deliveries}
              rowKey={(row) => row.id}
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}
