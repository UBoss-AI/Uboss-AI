'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  FormField,
  MetricCard,
  PageHeader,
  SkeletonText,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  commercialApi,
  formatMinor,
  SEAT_RULE_LABELS,
  type CommercialPosition,
  type CommercialRequestRow,
  type MeResponse,
} from '../../../lib/api-client';

import { useNotificationBell } from '../../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

function requestStateTone(state: CommercialRequestRow['state']): StatusTone {
  switch (state) {
    case 'Requested':
      return 'blue';
    case 'Approved':
    case 'Applied':
      return 'success';
    case 'Declined':
      return 'danger';
    default:
      return 'grey';
  }
}

const REQUEST_KINDS = [
  { value: 'MoreSeats', label: 'More seats' },
  { value: 'MoreAiAllowance', label: 'More AI allowance' },
  { value: 'PlanUpgrade', label: 'A larger plan' },
  { value: 'PlanDowngrade', label: 'A smaller plan' },
] as const;

/**
 * Settings → Billing, from inside a company.
 *
 * ## Read and request, never set
 *
 * The client's rule: a Company Admin may *view* the permitted plan and seat position and may
 * *request* allowed commercial changes; the platform controls the contracted ceiling and the
 * entitlements. So every control here either shows a number or raises a request — there is
 * deliberately no field on this screen that changes what the company has bought. A ceiling a
 * company could set for itself would not be a contract.
 *
 * ## Why the seat count is explained rather than just displayed
 *
 * "31 seats used when 28 people work here" is the support ticket this panel exists to prevent.
 * The counting rule is named, the per-state breakdown is shown, and each state says whether it
 * costs a seat — so the number can be reconstructed by the person looking at it.
 *
 * ## What is deliberately absent
 *
 * No roles and no permissions. A plan is not authority: buying more seats or a larger plan grants
 * nobody any new ability, and the panel says so where somebody might reasonably assume otherwise.
 * Invoices and payment methods are the Billing & Payments work of a later prompt, and are listed
 * as not built rather than mocked up as though they worked.
 */
export default function CompanyBillingSettingsPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [position, setPosition] = useState<CommercialPosition | null>(null);
  const [requests, setRequests] = useState<CommercialRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kind, setKind] = useState<string>('MoreSeats');
  const [amount, setAmount] = useState('');
  const [planCode, setPlanCode] = useState('');
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const bell = useNotificationBell(tenantId);

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your workspaces.'),
      );
  }, []);

  const load = useCallback(() => {
    if (!tenantId) {
      return;
    }
    void Promise.all([commercialApi.position(tenantId), commercialApi.requests(tenantId)])
      .then(([positionResult, requestResult]) => {
        setPosition(positionResult);
        setRequests(requestResult.requests);
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load this company’s plan and seats.',
        ),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  const submit = useCallback(() => {
    if (!tenantId) {
      return;
    }
    setBusy(true);
    setError(null);

    const numeric = Number(amount);
    const body: Record<string, unknown> = { kind, justification };
    if (kind === 'MoreSeats') {
      body['requestedSeats'] = numeric;
    } else if (kind === 'MoreAiAllowance') {
      // Entered as a whole currency amount and sent in minor units: money is stored as integers
      // everywhere in UBoss, and a float would lose precision on the way through JSON.
      body['requestedAllowanceMinor'] = Math.round(numeric * 100);
    } else {
      body['requestedPlanCode'] = planCode.trim();
    }

    commercialApi
      .requestChange(tenantId, body)
      .then(() => {
        setNotice(
          'Request raised. A platform administrator decides it — the person who raises a request ' +
            'can never be the person who approves it.',
        );
        setAmount('');
        setPlanCode('');
        setJustification('');
        load();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not raise that request.'),
      )
      .finally(() => setBusy(false));
  }, [amount, justification, kind, load, planCode, tenantId]);

  const withdraw = useCallback(
    (requestId: string) => {
      if (!tenantId) {
        return;
      }
      setBusy(true);
      commercialApi
        .withdraw(tenantId, requestId)
        .then(() => {
          setNotice('Request withdrawn.');
          load();
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'Could not withdraw it.'),
        )
        .finally(() => setBusy(false));
    },
    [load, tenantId],
  );

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="settings"
      onNavigate={() => undefined}
      {...bell.shellProps}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Billing' }}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Billing"
        description="Your plan, what it entitles this company to, and how many seats are in use."
        breadcrumbs={[{ label: 'Settings' }, { label: 'Billing' }]}
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      {!position ? (
        <Card>
          <CardBody>
            <SkeletonText lines={5} />
          </CardBody>
        </Card>
      ) : (
        <>
          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}
          >
            <MetricCard
              label="Plan"
              value={position.plan.name ?? 'No plan'}
              {...(position.plan.billingState ? { delta: position.plan.billingState } : {})}
            />
            <MetricCard
              label="Seats in use"
              value={`${position.seats.used} / ${position.seats.ceiling ?? '—'}`}
              delta={
                position.seats.atCeiling
                  ? 'at the ceiling'
                  : position.seats.nearCeiling
                    ? 'near the ceiling'
                    : `${position.seats.available ?? 0} available`
              }
            />
            <MetricCard
              label="AI allowance used"
              value={
                position.allowance.percentConsumed === null
                  ? '—'
                  : `${position.allowance.percentConsumed}%`
              }
              delta={`${formatMinor(position.allowance.aiConsumedMinor, position.allowance.currency)} of ${formatMinor(position.allowance.aiAllowanceMinor, position.allowance.currency)}`}
            />
            <MetricCard
              label="Renews"
              value={
                position.plan.renewsAt
                  ? new Date(position.plan.renewsAt).toLocaleDateString()
                  : 'No renewal date'
              }
              {...(position.plan.daysToRenewal === null
                ? {}
                : { delta: `${position.plan.daysToRenewal} days` })}
            />
          </div>

          {position.seats.grace ? (
            <Banner tone="warn">
              Your contracted seats have been reduced to{' '}
              <b>{position.seats.grace.contractedCeiling}</b>, and{' '}
              <b>{position.seats.grace.heldCeiling}</b> remain available until{' '}
              {new Date(position.seats.grace.until).toLocaleDateString()} so you can get under the
              new number. <b>Nobody was removed</b> — no account, employment record, task, Engine
              Agent history or audit record was deleted by the change.
            </Banner>
          ) : position.seats.atCeiling ? (
            <Banner tone="warn">
              This company is at its contracted ceiling of {position.seats.ceiling} seat(s). Adding
              another person will be refused rather than allowed and billed later.
              {position.seats.mayRequestMore
                ? ' Request more seats below.'
                : ' This plan does not allow seat requests, so the plan itself has to change.'}
            </Banner>
          ) : position.seats.nearCeiling ? (
            /*
              The warning *near* the ceiling, not just at it. The whole point is to arrive before
              somebody has already been told they have an account: at the ceiling the only options
              are refusing a colleague or a same-day contract change, and neither is a good day.
            */
            <Banner tone="warn">
              {position.seats.available} of {position.seats.ceiling} seats remain. Requesting more
              now takes a platform decision, so it is worth doing before the next person is invited
              rather than at the moment an invitation is refused.
            </Banner>
          ) : null}

          {position.pendingChange ? (
            <Banner tone="info">
              A change to <b>{position.pendingChange.planCode}</b> takes effect on{' '}
              {new Date(position.pendingChange.effectiveAt).toLocaleDateString()}. Until then this
              company keeps the plan it has — capacity you have already paid for is not taken away
              early.
            </Banner>
          ) : null}

          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))' }}
          >
            <Card>
              <CardHeader
                title="Seats"
                aside={
                  <StatusBadge
                    status={position.seats.atCeiling ? 'At ceiling' : 'Within ceiling'}
                    tone={position.seats.atCeiling ? 'warn' : 'success'}
                  />
                }
              />
              <CardBody>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Seats in use</span>
                  <span className="uboss-kv-value">{position.seats.used}</span>
                </div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Contracted</span>
                  <span className="uboss-kv-value">
                    {position.seats.contractedCeiling ?? 'No plan'}
                  </span>
                </div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">What counts as a seat</span>
                  <span className="uboss-kv-value">{SEAT_RULE_LABELS[position.seats.rule]}</span>
                </div>

                <div className="uboss-section-label">Where the count comes from</div>
                {Object.entries(position.seats.breakdown).map(([state, count]) => (
                  <div className="uboss-kv" key={state}>
                    <span className="uboss-kv-key">
                      {state}{' '}
                      {position.seats.countedStates.includes(state) ? (
                        <StatusBadge status="Counted" tone="blue" />
                      ) : (
                        <StatusBadge status="Free" tone="grey" />
                      )}
                    </span>
                    <span className="uboss-kv-value">{count}</span>
                  </div>
                ))}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="What this plan includes" />
              <CardBody>
                <div className="uboss-section-label">Modules this company has</div>
                <p>{position.entitlements.effectiveModules.join(' · ') || 'None'}</p>

                {position.entitlements.extraModules.length > 0 ? (
                  <>
                    <div className="uboss-section-label">Added for this company</div>
                    <p>{position.entitlements.extraModules.join(' · ')}</p>
                  </>
                ) : null}

                {position.entitlements.removedModules.length > 0 ? (
                  <>
                    <div className="uboss-section-label">Withheld despite the plan</div>
                    <p>{position.entitlements.removedModules.join(' · ')}</p>
                  </>
                ) : null}

                <div className="uboss-kv">
                  <span className="uboss-kv-key">Release channel</span>
                  <span className="uboss-kv-value">
                    {position.release.channel}
                    {position.release.overridden
                      ? ` (set for this company; the plan's is ${position.release.fromPlan})`
                      : ''}
                  </span>
                </div>

                {/*
                  The separation, stated where a reader would otherwise assume the plan controls
                  who can do what. It is also structurally true: the response this screen renders
                  has no role field in it at all.
                */}
                <Banner tone="info">{position.rbacNote}</Banner>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Ask for a change" />
            <CardBody>
              <p className="uboss-muted-3">
                A request goes to a platform administrator, who decides it. Whoever raises a request
                can never be the person who approves it — that is enforced by the server and by the
                database, not by this screen.
              </p>

              <FormField label="What do you need?">
                {(wiring) => (
                  <select
                    {...wiring}
                    className="uboss-input"
                    value={kind}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    {REQUEST_KINDS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>

              {kind === 'MoreSeats' ? (
                <FormField label="Total seats needed" required>
                  {(wiring) => (
                    <input
                      {...wiring}
                      className="uboss-input uboss-mono"
                      inputMode="numeric"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                  )}
                </FormField>
              ) : kind === 'MoreAiAllowance' ? (
                <FormField
                  label={`Allowance needed (${position.allowance.currency})`}
                  required
                  hint="A whole amount — it is stored in minor units so nothing is lost to rounding."
                >
                  {(wiring) => (
                    <input
                      {...wiring}
                      className="uboss-input uboss-mono"
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                    />
                  )}
                </FormField>
              ) : (
                <FormField label="Plan code" required hint="e.g. growth, enterprise">
                  {(wiring) => (
                    <input
                      {...wiring}
                      className="uboss-input uboss-mono"
                      value={planCode}
                      onChange={(event) => setPlanCode(event.target.value)}
                    />
                  )}
                </FormField>
              )}

              <FormField
                label="Why this company needs it"
                required
                hint="At least ten characters. This is the record both sides refer back to."
              >
                {(wiring) => (
                  <textarea
                    {...wiring}
                    className="uboss-input"
                    rows={3}
                    value={justification}
                    onChange={(event) => setJustification(event.target.value)}
                  />
                )}
              </FormField>

              <div className="uboss-actions">
                <Button
                  variant="primary"
                  onClick={submit}
                  disabled={busy || justification.trim().length < 10}
                >
                  {busy ? 'Sending…' : 'Raise the request'}
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Requests from this company" />
            <CardBody>
              {requests === null ? (
                <SkeletonText lines={3} />
              ) : requests.length === 0 ? (
                <EmptyState
                  title="No requests yet"
                  description="Anything this company has asked for appears here with the decision."
                />
              ) : (
                <DataTable
                  caption="Commercial requests, newest first"
                  columns={[
                    { key: 'kind', header: 'Asked for', render: (row) => row.kind },
                    {
                      key: 'detail',
                      header: 'Detail',
                      render: (row) =>
                        row.requestedSeats !== null
                          ? `${row.requestedSeats} seats`
                          : row.requestedPlanCode !== null
                            ? row.requestedPlanCode
                            : row.requestedAllowanceMinor !== null
                              ? formatMinor(
                                  row.requestedAllowanceMinor,
                                  position.allowance.currency,
                                )
                              : row.requestedModules.join(' · '),
                    },
                    {
                      key: 'state',
                      header: 'State',
                      render: (row) => (
                        <StatusBadge status={row.state} tone={requestStateTone(row.state)} />
                      ),
                    },
                    {
                      key: 'decision',
                      header: 'Decision',
                      render: (row) => row.decisionNote ?? '—',
                    },
                    {
                      key: 'raised',
                      header: 'Raised',
                      render: (row) => new Date(row.requestedAt).toLocaleDateString(),
                    },
                    {
                      key: 'action',
                      header: '',
                      render: (row) =>
                        row.state === 'Requested' ? (
                          <Button variant="ghost" disabled={busy} onClick={() => withdraw(row.id)}>
                            Withdraw
                          </Button>
                        ) : null,
                    },
                  ]}
                  rows={requests}
                  rowKey={(row) => row.id}
                />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Not built yet" />
            <CardBody>
              {/*
                Named rather than mocked. An invoice list that looked real and was not would be
                worse than an empty panel saying so.
              */}
              <ul className="uboss-muted-3">
                <li>
                  <b>Invoices and payment methods</b> — Billing &amp; Payments is its own prompt.
                  What exists today is the plan, the entitlements, the allowance and the seats.
                </li>
                <li>
                  <b>Usage detail per Engine Agent run</b> — the allowance figure above is the
                  contracted amount and what has been consumed against it; the per-run breakdown
                  arrives with AI usage metering.
                </li>
              </ul>
            </CardBody>
          </Card>
        </>
      )}
    </AppShell>
  );
}
