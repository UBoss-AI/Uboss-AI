'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import {
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
  billingApi,
  commercialApi,
  formatMinor,
  SEAT_RULE_LABELS,
  type BillingConnection,
  type BillingInvoiceRow,
  type CommercialPosition,
  type CommercialRequestRow,
  type MeResponse,
  type TokenPurchaseRow,
  type TokenQuote,
  type UpgradeOptions,
} from '../../../lib/api-client';

import { AccessRefused, isRefusal } from '../../../components/AccessRefused';
import { useAccountMenu } from '../../../lib/use-account-menu';
import { useSignedInUser } from '../../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../../lib/active-workspace';
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
 *
 * ## Paying is here; what was charged is the provider's
 *
 * Payment is taken on the provider's own hosted page rather than on a card form built here, so
 * card details never reach this product. Every figure in the invoice list is the provider's,
 * copied verbatim — nothing on this screen computes money.
 *
 * And nothing here grants anything. Returning from the payment page shows "waiting to hear",
 * because the redirect is not evidence: it can be opened by hand and it can be missed. The
 * subscription changes when the provider tells the server so.
 */
export default function CompanyBillingSettingsPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [position, setPosition] = useState<CommercialPosition | null>(null);
  const [requests, setRequests] = useState<CommercialRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* A 403 here means this is somebody else's screen, not a broken one u2014 see the catch in `load`. */
  const [refused, setRefused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [kind, setKind] = useState<string>('MoreSeats');
  const [amount, setAmount] = useState('');
  const [planCode, setPlanCode] = useState('');
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);

  const [connection, setConnection] = useState<BillingConnection | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoiceRow[] | null>(null);
  const [paying, setPaying] = useState(false);

  const [upgradeOptions, setUpgradeOptions] = useState<UpgradeOptions | null>(null);
  const [tokenPurchases, setTokenPurchases] = useState<TokenPurchaseRow[] | null>(null);
  const [tokenAmount, setTokenAmount] = useState('50000');
  const [tokenQuote, setTokenQuote] = useState<TokenQuote | null>(null);

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const signedInUser = useSignedInUser(me);

  const accountMenu = useAccountMenu(me);
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
    void Promise.all([
      commercialApi.position(tenantId),
      commercialApi.requests(tenantId),
      billingApi.connection(tenantId),
      billingApi.invoices(tenantId),
      billingApi.plans(tenantId),
      billingApi.tokenPurchases(tenantId),
    ])
      .then(
        ([
          positionResult,
          requestResult,
          connectionResult,
          invoiceResult,
          planResult,
          purchaseResult,
        ]) => {
          setPosition(positionResult);
          setRequests(requestResult.requests);
          setConnection(connectionResult);
          setInvoices(invoiceResult.invoices);
          setUpgradeOptions(planResult);
          setTokenPurchases(purchaseResult.purchases);
        },
      )
      .catch((caught: unknown) => {
        /*
         * A refusal is not a failure, and must not be shown as one.
         *
         * Billing is `settings: Administer` — the same permission the Settings screen already
         * used to decide whether to offer the Billing tile at all. Somebody who reaches this URL
         * without it is not looking at a broken screen; they are looking at something that is not
         * theirs, and a red "could not load" banner would send them to support over a working
         * product. Every other gated screen in this product answers that case the same way.
         */
        setRefused(isRefusal(caught));
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load this company’s plan and seats.',
        );
      });
  }, [tenantId]);

  useEffect(load, [load]);

  /**
   * Send the browser to the provider's own payment page.
   *
   * A full navigation, not a fetch: the provider has to own the next page. A card form rendered
   * inside somebody else's application is how a customer learns not to trust one, and it would
   * put this product inside the cardholder-data boundary for no benefit.
   */
  const pay = useCallback(
    (cycle: 'Monthly' | 'Annual') => {
      if (!tenantId) return;
      setPaying(true);
      setError(null);
      billingApi
        .checkout(tenantId, cycle)
        .then(({ url }) => window.location.assign(url))
        .catch((caught: unknown) => {
          setError(caught instanceof ApiError ? caught.message : 'Could not start the payment.');
          setPaying(false);
        });
    },
    [tenantId],
  );

  /**
   * Buy a different plan.
   *
   * The same full navigation as paying the existing bill, and for the same reason: the provider
   * owns the next page. Monthly only from this screen — a company choosing annual is choosing a
   * year's commitment, which belongs in a conversation rather than behind a button they might
   * press by accident.
   */
  const upgradeTo = useCallback(
    (planCode: string) => {
      if (!tenantId) return;
      setPaying(true);
      setError(null);
      billingApi
        .upgrade(tenantId, planCode, 'Monthly')
        .then(({ url }) => window.location.assign(url))
        .catch((caught: unknown) => {
          setError(caught instanceof ApiError ? caught.message : 'Could not start the payment.');
          setPaying(false);
        });
    },
    [tenantId],
  );

  /**
   * Price the number in the box, as it is typed.
   *
   * Asked of the server rather than multiplied here. The rate is a platform setting and it is
   * deliberately not published to a company — a screen that could compute the price would be a
   * screen that knows the rate, and anybody reading its source would too.
   */
  useEffect(() => {
    if (!tenantId) return;
    const tokens = Number(tokenAmount);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      setTokenQuote(null);
      return;
    }

    let current = true;
    const timer = setTimeout(() => {
      billingApi
        .quoteTokens(tenantId, tokens)
        .then((quote) => {
          if (current) setTokenQuote(quote);
        })
        .catch(() => {
          if (current) setTokenQuote(null);
        });
    }, 300);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [tenantId, tokenAmount]);

  const buyTokens = useCallback(() => {
    if (!tenantId) return;
    const tokens = Number(tokenAmount);
    setPaying(true);
    setError(null);
    billingApi
      .buyTokens(tenantId, tokens)
      .then(({ url }) => window.location.assign(url))
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not start the payment.');
        setPaying(false);
      });
  }, [tenantId, tokenAmount]);

  const manageBilling = useCallback(() => {
    if (!tenantId) return;
    setPaying(true);
    setError(null);
    billingApi
      .portal(tenantId)
      .then(({ url }) => window.location.assign(url))
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError ? caught.message : 'Could not open the billing portal.',
        );
        setPaying(false);
      });
  }, [tenantId]);

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
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="settings"
      {...bell.shellProps}
      user={signedInUser}
      accountMenu={accountMenu}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Billing"
        description="Your plan, what it entitles this company to, and how many seats are in use."
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Billing' }]}
      />

      {refused ? (
        <AccessRefused what="Billing" message={error} />
      ) : error ? (
        <Banner tone="danger">{error}</Banner>
      ) : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      {refused ? null : !position ? (
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
            {/*
              The plan, with what it costs.

              This is the one money figure a company is shown, and it is shown because it is
              theirs: it is what they agreed to pay and what an invoice will say. The card used to
              carry the billing state instead — "Current" — which is a word about a payment nobody
              had asked about, in the place where the price belongs.

              A negotiated Enterprise plan has no list price, so it falls back to the state rather
              than printing a made-up figure or an empty line.
            */}
            <MetricCard
              label="Plan"
              value={position.plan.name ?? 'No plan'}
              {...(position.plan.priceMinor !== null && position.plan.priceCurrency !== null
                ? {
                    delta:
                      `${formatMinor(position.plan.priceMinor, position.plan.priceCurrency)} ${position.plan.billingCycleLabel ?? ''}`.trim(),
                  }
                : position.plan.billingState
                  ? { delta: position.plan.billingState }
                  : {})}
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
            {/*
              AI work in UBoss Tokens, never in rupees.

              What a company pays is the plan price beside this card — that is their money and
              they can see it. What an individual AI call cost is not: a charge and a token count
              together are enough to divide out a per-million rate, match it to a public price
              list, and read off both the provider's name and UBoss's margin. Tokens are a UBoss
              unit and divide into neither.

              This card also used to read 0% for every company however much they had run, because
              it was built on a column nothing writes. It now reads the same wallet the hard stop
              refuses calls against, so the number on screen is the limit actually being applied.
            */}
            <MetricCard
              label="AI use this period"
              value={
                position.allowance.percentConsumed === null
                  ? '—'
                  : `${position.allowance.percentConsumed}%`
              }
              delta={`${position.allowance.aiConsumedTokens.toLocaleString()} of ${position.allowance.aiAllowanceTokens.toLocaleString()} UBoss Tokens`}
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

          {/*
            Buying a bigger plan, which needs nobody's approval.

            Deliberately above "Ask for a change": a published plan at a published price is bought,
            not requested. The request form below is for the things that genuinely need a decision —
            more seats on the plan you are on, a bigger allowance, a module. Putting the two the
            other way round would teach a customer to raise a ticket for something they can do
            themselves in a minute.
          */}
          <Card>
            <CardHeader
              title="Move to a different plan"
              aside={
                upgradeOptions === null ? null : (
                  <StatusBadge status={`Priced in ${upgradeOptions.currency}`} tone="grey" />
                )
              }
            />
            <CardBody>
              {/*
                The list is shown whenever there is anything besides the current plan — not only
                when something is buyable.

                The first version hid the whole list the moment nothing could be bought, so a
                company whose other plans were simply not published yet was told "nothing to move
                to". That is the wrong sentence: the plan exists, it has a price, and what they
                need to know is that it is not on sale online yet and who to ask. Each card says
                that for itself, which is why the list is worth showing even when no button is.
              */}
              {upgradeOptions === null ? (
                <p className="uboss-muted-3">Loading…</p>
              ) : upgradeOptions.plans.filter((plan) => !plan.current).length === 0 ? (
                <EmptyState
                  title="Nothing else is sold in your currency yet"
                  description={
                    'Every other plan is priced in a different currency. We do not convert ' +
                    'prices — a converted figure is not what your card would be charged — so ' +
                    'talk to us and we will price them for you.'
                  }
                />
              ) : (
                <div className="uboss-plan-choices">
                  {upgradeOptions.plans.map((plan) => (
                    <div
                      key={plan.code}
                      className={`uboss-plan-choice${plan.current ? ' uboss-plan-choice--current' : ''}`}
                    >
                      <div className="uboss-row uboss-row--between">
                        <b>{plan.name}</b>
                        {plan.current ? <StatusBadge status="Current" tone="success" /> : null}
                      </div>

                      <p className="uboss-plan-choice__price">
                        {/*
                          A price or nothing — never a converted one.

                          A plan with no price in this company's currency is not sold to them, and
                          showing another currency's figure would put a number on the screen that
                          the invoice will not match.
                        */}
                        {plan.priceMinor === null ? (
                          <span className="uboss-muted-3">
                            Not priced in {upgradeOptions.currency}
                          </span>
                        ) : (
                          <>
                            {formatMinor(plan.priceMinor, upgradeOptions.currency)}
                            <small className="uboss-muted-3"> a month</small>
                          </>
                        )}
                      </p>

                      <p className="uboss-muted-3 uboss-plan-choice__seats">
                        {plan.seatLimit === null
                          ? 'Seats agreed with you'
                          : `${plan.seatLimit} seats`}
                      </p>

                      {plan.buyable ? (
                        <button
                          type="button"
                          className="uboss-button"
                          disabled={paying}
                          onClick={() => upgradeTo(plan.code)}
                        >
                          {paying ? 'Opening…' : `Move to ${plan.name}`}
                        </button>
                      ) : (
                        <small className="uboss-muted-3">{plan.unavailableReason}</small>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <p className="uboss-muted-3">
                Payment is taken on the provider’s own page. The plan changes when they confirm it,
                not when the browser comes back — so nothing is granted on a page that could have
                been opened by hand.
              </p>
            </CardBody>
          </Card>

          {/*
            Buying tokens, which is a different thing from buying a plan.

            A plan is bought once a month and changes what the company is. A top-up is bought when
            the month's allowance runs out and changes nothing else — it does not move next month's
            allowance, and saying so here stops the obvious misreading.
          */}
          <Card>
            <CardHeader title="Buy more UBoss Tokens" />
            <CardBody>
              <p className="uboss-muted-3">
                A one-off top-up, added to this month’s allowance. It does not change your plan or
                what next month gives you.
              </p>

              <FormField label="How many tokens?">
                {(wiring) => (
                  <input
                    {...wiring}
                    type="number"
                    min={10000}
                    step={10000}
                    value={tokenAmount}
                    onChange={(event) => setTokenAmount(event.target.value)}
                    placeholder="50000"
                  />
                )}
              </FormField>

              {tokenQuote === null ? null : tokenQuote.ok ? (
                <p>
                  <b>{formatMinor(tokenQuote.amountMinor, tokenQuote.currency)}</b>{' '}
                  <span className="uboss-muted-3">
                    for {tokenQuote.tokens.toLocaleString('en-IN')} tokens
                  </span>
                </p>
              ) : (
                <p className="uboss-muted-3">{tokenQuote.reason}</p>
              )}

              <button
                type="button"
                className="uboss-button"
                disabled={paying || tokenQuote === null || !tokenQuote.ok}
                onClick={buyTokens}
              >
                {paying ? 'Opening…' : 'Buy tokens'}
              </button>

              {tokenPurchases !== null && tokenPurchases.length > 0 ? (
                <ul className="uboss-topup-history">
                  {tokenPurchases.slice(0, 5).map((purchase) => (
                    <li key={purchase.id} className="uboss-row uboss-row--between">
                      <span>
                        {purchase.tokens.toLocaleString('en-IN')} tokens —{' '}
                        {formatMinor(purchase.amountMinor, purchase.currency)}
                      </span>
                      <span>
                        <StatusBadge
                          status={purchase.status}
                          tone={
                            purchase.status === 'Paid'
                              ? 'success'
                              : purchase.status === 'Failed'
                                ? 'danger'
                                : 'grey'
                          }
                        />
                        {/* An unfinished purchase keeps its page, so a closed tab is not a dead end. */}
                        {purchase.checkoutUrl === null ? null : (
                          <>
                            {' '}
                            <a href={purchase.checkoutUrl}>Finish paying</a>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardBody>
          </Card>

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

          {/*
            Payment.

            Shown to everybody who can see this screen, and actionable only by somebody who can
            administer it — the server decides that, and a refusal here is the server's message
            rather than a guess made in the browser.
          */}
          <Card>
            <CardHeader
              title="Payment"
              aside={
                connection === null ? null : (
                  <StatusBadge
                    status={
                      !connection.connected
                        ? 'Not available'
                        : connection.mode === 'live'
                          ? 'Live'
                          : 'Test mode'
                    }
                    tone={
                      !connection.connected
                        ? 'grey'
                        : connection.mode === 'live'
                          ? 'success'
                          : 'warn'
                    }
                  />
                )
              }
            />
            <CardBody>
              {connection === null ? (
                <SkeletonText lines={2} />
              ) : !connection.connected ? (
                <Banner tone="info">
                  Paying online is not available on this deployment yet. Your plan and seats are
                  unaffected — invoicing is arranged with UBoss directly.
                </Banner>
              ) : (
                <>
                  {connection.mode === 'test' ? (
                    <Banner tone="warn">
                      This deployment is in the payment provider’s test mode. No real money moves
                      and only the provider’s test cards will work.
                    </Banner>
                  ) : null}

                  <p className="uboss-muted">
                    Payment is taken on the provider’s own secure page. Card details never reach
                    UBoss.
                  </p>

                  <div className="uboss-row-actions">
                    <Button variant="primary" onClick={() => pay('Monthly')} disabled={paying}>
                      Pay monthly
                    </Button>
                    <Button onClick={() => pay('Annual')} disabled={paying}>
                      Pay annually
                    </Button>
                    <Button onClick={manageBilling} disabled={paying}>
                      Manage billing
                    </Button>
                  </div>

                  <p className="uboss-muted-3">
                    Manage billing opens the provider’s portal, where a card can be changed, an
                    invoice downloaded, or the subscription cancelled.
                  </p>
                </>
              )}
            </CardBody>
          </Card>

          {/*
            Invoices.

            Every figure here is the provider’s, stored as it issued them. Nothing on this screen
            adds anything up — a second opinion about what was charged is an invoice dispute.
          */}
          <Card>
            <CardHeader title="Invoices" />
            <CardBody>
              {invoices === null ? (
                <SkeletonText lines={3} />
              ) : invoices.length === 0 ? (
                <p className="uboss-muted-3">No invoice has been issued to this company yet.</p>
              ) : (
                <DataTable
                  caption="Invoices issued by the payment provider"
                  columns={[
                    {
                      key: 'number',
                      header: 'Invoice',
                      render: (row) => (
                        <span className="uboss-mono">{row.number ?? 'Not yet issued'}</span>
                      ),
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      render: (row) => (
                        <StatusBadge
                          status={row.status}
                          tone={
                            row.status === 'paid'
                              ? 'success'
                              : row.status === 'open'
                                ? 'warn'
                                : row.status === 'void' || row.status === 'uncollectible'
                                  ? 'danger'
                                  : 'grey'
                          }
                        />
                      ),
                    },
                    {
                      key: 'amount',
                      header: 'Amount',
                      render: (row) => formatMinor(row.amountDueMinor, row.currency),
                    },
                    {
                      key: 'period',
                      header: 'Period',
                      render: (row) =>
                        row.periodStart === null || row.periodEnd === null
                          ? '—'
                          : `${new Date(row.periodStart).toLocaleDateString()} – ${new Date(
                              row.periodEnd,
                            ).toLocaleDateString()}`,
                    },
                    {
                      key: 'open',
                      header: '',
                      render: (row) =>
                        row.hostedInvoiceUrl === null ? null : (
                          <a
                            href={row.hostedInvoiceUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="uboss-link"
                          >
                            View
                          </a>
                        ),
                    },
                  ]}
                  rows={invoices}
                  rowKey={(row) => row.id}
                />
              )}

              {invoices !== null && invoices.some((row) => row.lastPaymentError !== null) ? (
                <Banner tone="danger">
                  {invoices.find((row) => row.lastPaymentError !== null)?.lastPaymentError}
                </Banner>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            {/*
              This card used to say the per-run breakdown "arrives with AI usage metering".

              The metering arrived. The figure above is now read from the same wallet the hard stop
              enforces, and the run-by-run detail is a screen of its own. A "not built yet" note
              that outlives the thing it was waiting for is worse than no note: it tells a customer
              a feature they are already using does not exist, and it is the last thing anybody
              thinks to delete.
            */}
            <CardHeader title="Where the detail is" />
            <CardBody>
              <p className="uboss-muted-3" style={{ margin: 0 }}>
                The figure above is this period as a whole. For the run-by-run breakdown — which
                agent, which objective, and what each one used — open{' '}
                <Link className="uboss-link" href="/settings?section=tokens">
                  Tokens &amp; Cost
                </Link>
                .
              </p>
            </CardBody>
          </Card>
        </>
      )}
    </RoutedAppShell>
  );
}
