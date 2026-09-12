'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
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
  formatMinor,
  platformApi,
  SEAT_RULE_LABELS,
  type LifecycleView,
  type PendingCommercialRequest,
  type SeatPosition,
  type SeatReductionAssessment,
} from '../../../../../lib/api-client';
import { useMasterConsole } from '../../../layout';

/** Colour follows meaning: a company that cannot be reached is not a neutral fact. */
export function lifecycleTone(state: string): StatusTone {
  switch (state) {
    case 'Active':
      return 'success';
    case 'ReadOnly':
      return 'warn';
    case 'Suspended':
      return 'danger';
    case 'Closed':
      return 'grey';
    default:
      return 'blue';
  }
}

function requestKindLabel(kind: string): string {
  switch (kind) {
    case 'MoreSeats':
      return 'More seats';
    case 'FewerSeats':
      return 'Fewer seats';
    case 'PlanUpgrade':
      return 'Plan upgrade';
    case 'PlanDowngrade':
      return 'Plan downgrade';
    case 'MoreAiAllowance':
      return 'More AI allowance';
    case 'ModuleEntitlement':
      return 'Module entitlement';
    default:
      return kind;
  }
}

/**
 * Plan, seats and lifecycle for one company — the platform side.
 *
 * ## Why this is its own screen
 *
 * Company Detail answers "what is this customer's position". This screen is where the position
 * is *changed*, and the two want different things: changing a contracted ceiling or an operating
 * state needs a reason, a preview of the consequence and a confirmation, none of which belongs
 * on a page somebody opens to read a number.
 *
 * ## The three rules this screen is built around
 *
 *   1. **Nothing silently exceeds the contracted ceiling.** The seat panel shows the number in
 *      force, the number contracted, and which account states count — because "31 seats used
 *      when 28 people work here" needs an answer on the screen, not in a support ticket.
 *   2. **Reducing seats deletes nothing.** The reduction preview says so in the API's own words
 *      before the operator agrees, and the confirmation repeats it. There is no control here
 *      that removes anybody.
 *   3. **A plan is not a permission.** Nothing on this screen grants authority, and the panel
 *      says so where an operator might otherwise assume a bigger plan widens access.
 *
 * ## Every control is a real one
 *
 * The Prompt 9 version of Company Detail listed "Suspend company" and "Change commercial terms"
 * under *Not built yet*, rather than shipping buttons that looked live. Both are built now, and
 * the reason those placeholders existed — a lifecycle change needs a reason and a confirmation —
 * is the shape they arrived in.
 */
export default function MasterCompanyCommercialPage() {
  const router = useRouter();
  const params = useParams<{ tenantId: string }>();
  const { can } = useMasterConsole();

  const tenantId = params.tenantId;

  const [seats, setSeats] = useState<SeatPosition | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleView | null>(null);
  const [requests, setRequests] = useState<PendingCommercialRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Seat editing: the typed number, the API's assessment of it, and the confirmation gate.
  const [seatDraft, setSeatDraft] = useState('');
  const [assessment, setAssessment] = useState<SeatReductionAssessment | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [seatConfirm, setSeatConfirm] = useState(false);

  const [lifecycleTarget, setLifecycleTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mayAdminister = can('companies', 'Administer');

  const load = useCallback(() => {
    setError(null);
    void Promise.all([
      platformApi.companySeats(tenantId),
      platformApi.lifecycle(tenantId),
      platformApi.commercialRequests(),
    ])
      .then(([seatPosition, lifecycleView, queue]) => {
        setSeats(seatPosition);
        setLifecycle(lifecycleView);
        // The queue endpoint is the whole platform's; narrowed here rather than server-side so
        // the decider sees the same rows and the same ordering wherever they work them.
        setRequests(queue.requests.filter((row) => row.tenantId === tenantId));
        setSeatDraft(String(seatPosition.contractedCeiling ?? ''));
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load this company’s position.',
        ),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  /** Ask what the typed number would mean before offering to apply it. */
  const assess = useCallback(() => {
    const seats = Number(seatDraft);
    if (!Number.isInteger(seats) || seats < 1) {
      setError('A contracted ceiling has to be a whole number of at least one seat.');
      return;
    }
    setAssessing(true);
    setError(null);
    platformApi
      .assessSeatReduction(tenantId, seats)
      .then((result) => {
        setAssessment(result);
        setSeatConfirm(true);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not assess that seat count.'),
      )
      .finally(() => setAssessing(false));
  }, [seatDraft, tenantId]);

  const applySeats = useCallback(
    (reason?: string) => {
      setSeatConfirm(false);
      setBusy(true);
      platformApi
        .setContractedSeats(tenantId, { seats: Number(seatDraft), reason: reason ?? '' })
        .then((seats) => {
          setNotice(
            `Contracted seats set to ${seats.contractedCeiling}. ` +
              (seats.grace
                ? `A grace window holds ${seats.grace.heldCeiling} seats until ` +
                  `${new Date(seats.grace.until).toLocaleDateString()}. Nobody was removed.`
                : 'Nobody was removed.'),
          );
          load();
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'Could not set the seat count.'),
        )
        .finally(() => setBusy(false));
    },
    [load, seatDraft, tenantId],
  );

  const applyLifecycle = useCallback(
    (reason?: string) => {
      const toState = lifecycleTarget;
      setLifecycleTarget(null);
      if (!toState) {
        return;
      }
      setBusy(true);
      platformApi
        .transitionLifecycle(tenantId, { toState, reason: reason ?? '' })
        .then((view) => {
          setLifecycle(view);
          setNotice(
            `This company is now ${view.state}. Nothing was deleted — every user, employment ` +
              'record and audit row is intact.',
          );
        })
        .catch((caught: unknown) =>
          setError(
            caught instanceof ApiError ? caught.message : 'Could not change the company’s state.',
          ),
        )
        .finally(() => setBusy(false));
    },
    [lifecycleTarget, tenantId],
  );

  const decide = useCallback(
    (requestId: string, decision: 'approve' | 'decline') => {
      setBusy(true);
      platformApi
        .decideCommercialRequest(requestId, {
          decision,
          ...(decision === 'approve' ? { apply: 'now' as const } : {}),
        })
        .then(() => {
          setNotice(
            decision === 'approve'
              ? 'Approved and applied. An increase takes effect at once; a reduction opens a grace window instead of removing anybody.'
              : 'Declined. The company can see the decision on its own Billing screen.',
          );
          load();
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'Could not decide that request.'),
        )
        .finally(() => setBusy(false));
    },
    [load],
  );

  if (error && (!lifecycle || !seats)) {
    return (
      <>
        <PageHeader
          title="Plan, seats & lifecycle"
          description="Contracted terms and operating state."
        />
        <Banner tone="danger">{error}</Banner>
        <Button variant="navy" icon="back" onClick={() => router.push('/master/companies')}>
          Back to Companies
        </Button>
      </>
    );
  }

  if (!lifecycle || !seats) {
    return (
      <>
        <PageHeader
          title="Plan, seats & lifecycle"
          description="Contracted terms and operating state."
        />
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
      <PageHeader
        title="Plan, seats & lifecycle"
        description="Contracted terms and operating state, with the reason recorded for each change."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'Companies', onSelect: () => router.push('/master/companies') },
          {
            label: 'Detail',
            onSelect: () => router.push(`/master/companies/${tenantId}`),
          },
          { label: 'Plan & seats' },
        ]}
        actions={
          <Button
            variant="navy"
            icon="back"
            onClick={() => router.push(`/master/companies/${tenantId}`)}
          >
            Back to detail
          </Button>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}
      >
        <MetricCard
          label="Operating state"
          value={lifecycle.state}
          delta={lifecycle.capability.reason}
        />
        <MetricCard
          label="Seats in use"
          value={`${seats.used} / ${seats.ceiling ?? '—'}`}
          delta={
            seats.grace
              ? `contracted ${seats.grace.contractedCeiling}, grace holds ${seats.grace.heldCeiling}`
              : 'counted against the ceiling in force'
          }
        />
        <MetricCard
          label="Seats available"
          value={seats.available === null ? 'No plan' : seats.available}
          delta={
            seats.atCeiling
              ? 'at the ceiling'
              : seats.nearCeiling
                ? 'near the ceiling'
                : 'room to add people'
          }
        />
        <MetricCard
          label="Scheduled change"
          value={lifecycle.scheduled ? lifecycle.scheduled.toState : 'None'}
          delta={
            lifecycle.scheduled
              ? `from ${new Date(lifecycle.scheduled.effectiveAt).toLocaleDateString()}`
              : 'no future transition recorded'
          }
        />
        <MetricCard label="Open commercial requests" value={requests.length} />
      </div>

      {seats.grace ? (
        <Banner tone="warn">
          A downgrade grace window is open: the contract now says{' '}
          <b>{seats.grace.contractedCeiling}</b> seats, and <b>{seats.grace.heldCeiling}</b> are
          still enforced until {new Date(seats.grace.until).toLocaleDateString()}. Nobody was
          removed by the reduction — the window exists so the company can get under the new number
          by offboarding, which is a separate deliberate act that itself keeps employment history.
        </Banner>
      ) : null}

      {lifecycle.scheduled ? (
        <Banner tone="info">
          A transition to <b>{lifecycle.scheduled.toState}</b> is recorded for{' '}
          {new Date(lifecycle.scheduled.effectiveAt).toLocaleString()} and has{' '}
          <b>not been applied</b>. The company is still {lifecycle.state} until it is — a scheduled
          restriction that has not happened yet must not be shown as though it had.
        </Banner>
      ) : null}

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(380px,1fr))' }}
      >
        <Card>
          <CardHeader
            title="Contracted seats"
            aside={<StatusBadge status="Measured" tone="success" />}
          />
          <CardBody>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Ceiling in force</span>
              <span className="uboss-kv-value">{seats.ceiling ?? 'No plan assigned'}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Contracted ceiling</span>
              <span className="uboss-kv-value">{seats.contractedCeiling ?? '—'}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Counting rule</span>
              <span className="uboss-kv-value">{SEAT_RULE_LABELS[seats.rule]}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">May request more</span>
              <span className="uboss-kv-value">
                {seats.mayRequestMore
                  ? 'Yes — this plan allows seat requests'
                  : 'No — the plan itself has to change'}
              </span>
            </div>

            {/*
              The per-state breakdown, because "31 seats used when 28 people work here" needs an
              answer on the screen. Every state is shown, counted or not, and the counted ones are
              named — a number nobody can reconstruct is a number nobody trusts.
            */}
            <div className="uboss-section-label">Where the count comes from</div>
            {Object.entries(seats.breakdown).length === 0 ? (
              <p className="uboss-muted-3">This company has no memberships yet.</p>
            ) : (
              Object.entries(seats.breakdown).map(([state, count]) => (
                <div className="uboss-kv" key={state}>
                  <span className="uboss-kv-key">
                    {state}{' '}
                    {seats.countedStates.includes(state) ? (
                      <StatusBadge status="Counted" tone="blue" />
                    ) : (
                      <StatusBadge status="Free" tone="grey" />
                    )}
                  </span>
                  <span className="uboss-kv-value">{count}</span>
                </div>
              ))
            )}

            <p className="uboss-muted-3">
              A contracted ceiling is a contract, not a preference: there is no company-side control
              that changes it. Reducing it <b>removes nobody</b> — no user, employment record, task,
              Agent history or audit row is deleted, and a grace window holds the old number while
              the company gets under the new one.
            </p>

            {mayAdminister ? (
              <>
                <FormField
                  label="Contracted seats"
                  hint="Checked against the company's current count before anything is applied."
                >
                  {(wiring) => (
                    <input
                      {...wiring}
                      className="uboss-input uboss-mono"
                      inputMode="numeric"
                      value={seatDraft}
                      onChange={(event) => setSeatDraft(event.target.value)}
                    />
                  )}
                </FormField>
                <div className="uboss-actions">
                  <Button variant="primary" onClick={assess} disabled={assessing || busy}>
                    {assessing ? 'Checking…' : 'Preview the change'}
                  </Button>
                </div>
              </>
            ) : (
              <Banner tone="info">
                Your platform role can read this company but not change its contracted terms.
                Changing a customer&apos;s contract needs <b>companies: Administer</b>, which
                Commercial, Support, Security and Engineer roles deliberately do not hold.
              </Banner>
            )}

            {assessment && !seatConfirm ? (
              <Banner tone={assessment.needsGrace ? 'warn' : 'info'}>{assessment.note}</Banner>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Operating state"
            aside={<StatusBadge status={lifecycle.state} tone={lifecycleTone(lifecycle.state)} />}
          />
          <CardBody>
            <div className="uboss-kv">
              <span className="uboss-kv-key">What this state permits</span>
              <span className="uboss-kv-value">{lifecycle.capability.reason}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Sign-in and read</span>
              <span className="uboss-kv-value">
                {lifecycle.capability.canAccess ? 'Permitted' : 'Blocked'}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Writes</span>
              <span className="uboss-kv-value">
                {lifecycle.capability.canWrite ? 'Permitted' : 'Blocked'}
              </span>
            </div>

            <div className="uboss-section-label">Where it can go from here</div>
            {lifecycle.allowedNext.length === 0 ? (
              <p className="uboss-muted-3">
                <b>{lifecycle.state}</b> is terminal through this route. Bringing a closed company
                back would restore access to data whose retention decision has already been made, so
                it is a deliberate operation with its own review rather than a button.
              </p>
            ) : mayAdminister ? (
              <div className="uboss-actions">
                {lifecycle.allowedNext.map((state) => (
                  <Button
                    key={state}
                    variant={state === 'Closed' || state === 'Suspended' ? 'danger' : 'navy'}
                    disabled={busy}
                    onClick={() => setLifecycleTarget(state)}
                  >
                    Move to {state}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="uboss-muted-3">
                Permitted from here: {lifecycle.allowedNext.join(', ')}. Your role cannot make the
                change.
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Commercial requests from this company"
          aside={<StatusBadge status="Measured" tone="success" />}
        />
        <CardBody>
          {requests.length === 0 ? (
            <EmptyState
              title="Nothing awaiting a decision"
              description="Requests a Company Admin raises from their own Billing screen appear here."
            />
          ) : (
            <DataTable
              caption="Open commercial requests, oldest first"
              columns={[
                {
                  key: 'kind',
                  header: 'Asking for',
                  render: (row) => requestKindLabel(row.kind),
                },
                {
                  key: 'what',
                  header: 'Detail',
                  render: (row) =>
                    row.requestedSeats !== null
                      ? `${row.requestedSeats} seats`
                      : row.requestedPlanCode !== null
                        ? `Plan: ${row.requestedPlanCode}`
                        : row.requestedAllowanceMinor !== null
                          ? formatMinor(row.requestedAllowanceMinor)
                          : row.requestedModules.join(' · '),
                },
                { key: 'why', header: 'Why', render: (row) => row.justification },
                {
                  key: 'when',
                  header: 'Raised',
                  render: (row) => new Date(row.requestedAt).toLocaleString(),
                },
                {
                  key: 'decide',
                  header: 'Decision',
                  render: (row) =>
                    mayAdminister ? (
                      <span className="uboss-actions">
                        <Button
                          variant="primary"
                          disabled={busy}
                          onClick={() => decide(row.id, 'approve')}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() => decide(row.id, 'decline')}
                        >
                          Decline
                        </Button>
                      </span>
                    ) : (
                      <span className="uboss-muted">Read-only</span>
                    ),
                },
              ]}
              rows={requests}
              rowKey={(row) => row.id}
            />
          )}

          {/*
            The separation this screen must not blur. Stated where an operator approving a bigger
            plan might otherwise assume it widens what the customer's people can do.
          */}
          <Banner tone="info">
            Approving a plan or seat change grants <b>nobody any authority</b>. What a company has
            bought and what a person inside it may do are separate questions with separate answers:
            roles are granted inside the company and are never derived from a plan.
          </Banner>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Lifecycle history"
          aside={<StatusBadge status="Measured" tone="success" />}
        />
        <CardBody>
          <p className="uboss-muted-3">
            Kept as its own record rather than reconstructed from the audit trail, so &ldquo;what
            state was this company in on the 14th&rdquo; is a query.
          </p>
          {lifecycle.history.length === 0 ? (
            <EmptyState title="No transitions recorded" />
          ) : (
            <DataTable
              caption="Every lifecycle transition, newest first"
              columns={[
                {
                  key: 'change',
                  header: 'Change',
                  render: (row) => `${row.fromState} → ${row.toState}`,
                },
                { key: 'why', header: 'Why', render: (row) => row.reason },
                {
                  key: 'effective',
                  header: 'Effective',
                  render: (row) => new Date(row.effectiveAt).toLocaleString(),
                },
                {
                  key: 'applied',
                  header: 'Applied',
                  render: (row) =>
                    row.appliedAt ? (
                      new Date(row.appliedAt).toLocaleString()
                    ) : (
                      <StatusBadge status="Scheduled" tone="blue" />
                    ),
                },
                {
                  key: 'who',
                  header: 'By',
                  render: (row) => (row.actorUserId ? 'A platform decision' : 'The schedule'),
                },
              ]}
              rows={lifecycle.history}
              rowKey={(row) => `${row.toState}-${row.effectiveAt}`}
            />
          )}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={seatConfirm}
        title="Change the contracted seat ceiling"
        description={assessment?.note ?? ''}
        impact={[
          { label: 'Seats in use now', value: String(assessment?.used ?? 0) },
          { label: 'New contracted ceiling', value: String(assessment?.newCeiling ?? 0) },
          {
            label: 'People removed by this change',
            value: 'None — this change deletes nothing',
          },
          {
            label: 'Grace window',
            value: assessment?.needsGrace
              ? 'Opened: the current ceiling holds while the company offboards'
              : 'Not needed',
          },
        ]}
        requireReason
        reasonLabel="Why is the contracted ceiling changing?"
        confirmLabel="Apply the new ceiling"
        onCancel={() => setSeatConfirm(false)}
        onConfirm={applySeats}
      />

      <ConfirmDialog
        open={lifecycleTarget !== null}
        title={`Move this company to ${lifecycleTarget ?? ''}`}
        description={
          lifecycleTarget === 'Closed'
            ? 'Closing is terminal through this route: the company cannot be reopened from here. Nothing is deleted — every user, employment record, task, Agent history and audit row is kept.'
            : lifecycleTarget === 'Suspended'
              ? 'Everybody in this company loses access immediately, including anybody signed in right now. Nothing is deleted.'
              : lifecycleTarget === 'ReadOnly'
                ? 'People can sign in and read, and every write is refused. Nothing is deleted.'
                : 'The company returns to normal operation.'
        }
        impact={[
          { label: 'From', value: lifecycle.state },
          { label: 'To', value: lifecycleTarget ?? '' },
          { label: 'Data removed', value: 'None' },
        ]}
        requireReason
        reasonLabel="Why is this company changing state?"
        confirmLabel={`Move to ${lifecycleTarget ?? ''}`}
        destructive={lifecycleTarget === 'Closed' || lifecycleTarget === 'Suspended'}
        onCancel={() => setLifecycleTarget(null)}
        onConfirm={applyLifecycle}
      />
    </>
  );
}
