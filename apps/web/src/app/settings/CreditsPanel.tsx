'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Icon,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  creditsApi,
  type CreditGrantView,
  type CreditPolicyView,
  type CreditRequestView,
  type CreditsMetaView,
} from '../../lib/api-client';

/**
 * Credits — the company's half of Prompt 31, inside Settings › Tokens & Cost.
 *
 * ## Why it sits under the budget panel rather than on its own screen
 *
 * The reference's `setTokens()` already has "Request top-up", "Reallocate budget" and "Credit
 * history" as actions on the Tokens & Cost card. This is what those three buttons do — putting
 * credits on a separate screen would have made a second place a reader looks for the same
 * subject.
 *
 * ## What this screen cannot do, and says so
 *
 * **It cannot approve anything.** The company asks and UBoss Finance decides; a company
 * approving its own credit request would be setting its own commercial terms. The panel shows
 * the request's state and Finance's reason, and offers no decision control at all — not a
 * disabled one, because a disabled approve button implies the permission exists somewhere in
 * this workspace.
 *
 * **It takes no payment.** No payment provider is integrated or approved. The request records an
 * amount, a reason and a billing *intent*; Finance records the invoice reference when the
 * credits are added. The panel says this rather than leaving somebody to discover it.
 */
export function CreditsPanel({ tenantId }: { tenantId: string | null }) {
  const [meta, setMeta] = useState<CreditsMetaView | null>(null);
  const [policy, setPolicy] = useState<CreditPolicyView | null>(null);
  const [requests, setRequests] = useState<CreditRequestView[] | null>(null);
  const [grants, setGrants] = useState<CreditGrantView[] | null>(null);
  const [blocked, setBlocked] = useState<{ blocks: boolean; reason: string } | null>(null);

  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [billingChoice, setBillingChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (tenantId === null) return;
    try {
      const [loadedMeta, loadedPolicy, loadedRequests, loadedGrants, negative] = await Promise.all([
        creditsApi.meta(tenantId),
        creditsApi.policy(tenantId),
        creditsApi.requests(tenantId),
        creditsApi.grants(tenantId),
        creditsApi.negativeBalance(tenantId),
      ]);
      setMeta(loadedMeta);
      setPolicy(loadedPolicy);
      setRequests(loadedRequests);
      setGrants(loadedGrants);
      setBlocked(negative);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load credits.');
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (minor: number, currency: string) => {
    const sign = minor < 0 ? '-' : '';
    const absolute = Math.abs(minor);
    return `${sign}${currency} ${Math.floor(absolute / 100).toLocaleString()}.${String(
      absolute % 100,
    ).padStart(2, '0')}`;
  };

  const submit = async () => {
    if (tenantId === null) return;
    // Entered in major units because that is how somebody thinks about money; converted here so
    // the API only ever sees integers (the money rule everywhere in this codebase).
    const major = Number.parseFloat(amount);
    if (!Number.isFinite(major) || major <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }

    setBusy(true);
    try {
      await creditsApi.request(tenantId, {
        amountMinor: Math.round(major * 100),
        reason,
        ...(billingChoice === '' ? {} : { billingChoice }),
      });
      setAsking(false);
      setAmount('');
      setReason('');
      setBillingChoice('');
      setNote('Sent to UBoss Finance. They decide the amount and when it becomes effective.');
      setError(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The request was not sent.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (requestId: string) => {
    if (tenantId === null) return;
    setBusy(true);
    try {
      await creditsApi.cancel(tenantId, requestId, 'Withdrawn by the requester.');
      await load();
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not withdraw it.');
    } finally {
      setBusy(false);
    }
  };

  const stateTone = (state: CreditRequestView['state']): StatusTone =>
    state === 'Approved'
      ? 'success'
      : state === 'Rejected'
        ? 'danger'
        : state === 'Submitted'
          ? 'warn'
          : 'grey';

  return (
    <>
      {error !== null && <Banner tone="warn">{error}</Banner>}
      {note !== null && <Banner tone="ok">{note}</Banner>}

      {blocked?.blocks === true && (
        <Banner tone="danger">
          <Icon name="alert" size={16} />
          New AI work is blocked: {blocked.reason}
        </Banner>
      )}

      <Card>
        <CardBody>
          <div className="uboss-spread">
            <div className="uboss-section-label">Credits</div>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => setAsking(true)}>
              <Icon name="plus" size={16} />
              Request more credits
            </Button>
          </div>

          <p className="uboss-muted">
            {meta?.note ??
              'Requesting credits does not take a payment. UBoss Finance reviews the request.'}
          </p>

          {policy !== null && (
            <>
              <div className="uboss-section-label">Commercial terms</div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Allowance</span>
                <span className="uboss-kv-value">
                  {policy.resetPolicy === 'MonthlyReset'
                    ? `Resets monthly${policy.nextResetAt === null ? '' : ` — next on ${policy.nextResetAt}`}`
                    : 'A running balance that does not reset'}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Unused allowance</span>
                <span className="uboss-kv-value">
                  {policy.carryForwardPolicy === 'Forfeit'
                    ? 'Forfeited at each reset'
                    : policy.carryForwardPolicy === 'CarryForward'
                      ? 'Carried forward in full'
                      : `Carried forward up to ${policy.carryForwardCapMinor ?? 0} minor units`}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Purchased credit</span>
                <span className="uboss-kv-value">
                  {policy.defaultTopUpExpiryDays === null
                    ? 'Does not expire'
                    : `Expires ${policy.defaultTopUpExpiryDays} days after it becomes effective`}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">If the balance goes negative</span>
                <span className="uboss-kv-value">
                  {policy.negativeBalancePolicy === 'BlockImmediately'
                    ? 'New AI work is blocked immediately'
                    : `Up to ${policy.negativeBalanceGraceMinor} minor units is tolerated`}
                </span>
              </div>
              {/* Read-only on purpose: these are contract terms, set by UBoss, not company
                  preferences. A company that could change its own carry-forward policy could
                  grant itself credit it had not bought. */}
              <p className="uboss-notice uboss-notice-min">
                <Icon name="shield" size={14} />
                These are contract terms set by UBoss. Ask your account manager to change them.
              </p>
            </>
          )}
        </CardBody>

        <DataTable
          caption="Credit requests"
          rows={requests ?? []}
          rowKey={(row) => row.id}
          loading={requests === null}
          emptyTitle="No credit requests"
          emptyDescription="Ask for more when the allowance is running low."
          columns={[
            {
              key: 'amount',
              header: 'Requested',
              numeric: true,
              render: (row) => (
                <>
                  {money(row.requestedMinor, row.currency)}
                  {row.approvedMinor !== null && row.approvedMinor !== row.requestedMinor && (
                    <>
                      <br />
                      {/* Finance adjusted it. Shown plainly rather than replacing the figure,
                          so the difference is visible. */}
                      <small className="uboss-muted-3">
                        approved {money(row.approvedMinor, row.currency)}
                      </small>
                    </>
                  )}
                </>
              ),
            },
            {
              key: 'state',
              header: 'State',
              render: (row) => <StatusBadge status={row.state} tone={stateTone(row.state)} dot />,
            },
            {
              key: 'reason',
              header: 'Reason',
              render: (row) => (
                <>
                  {row.reason}
                  {row.decisionNote !== null && row.decisionNote !== '' && (
                    <>
                      <br />
                      <small className="uboss-muted-3">Finance: {row.decisionNote}</small>
                    </>
                  )}
                </>
              ),
            },
            {
              key: 'effective',
              header: 'Effective',
              render: (row) => (
                <small className="uboss-muted-3">
                  {row.effectiveFrom ?? '—'}
                  {row.expiresAt === null ? '' : ` · expires ${row.expiresAt}`}
                </small>
              ),
            },
            {
              key: 'reference',
              header: 'Reference',
              render: (row) => <span className="uboss-mono">{row.reference ?? '—'}</span>,
            },
            {
              key: 'act',
              header: '',
              render: (row) =>
                row.state === 'Submitted' ? (
                  <Button size="sm" disabled={busy} onClick={() => void cancel(row.id)}>
                    Withdraw
                  </Button>
                ) : (
                  // Deliberately nothing. There is no approve control on the company plane at
                  // all — not even a disabled one, which would imply the permission exists here.
                  <span className="uboss-muted-3">—</span>
                ),
            },
          ]}
        />

        <DataTable
          caption="Credit grants"
          rows={grants ?? []}
          rowKey={(row) => row.id}
          loading={grants === null}
          emptyTitle="No credit granted yet"
          emptyDescription="The plan allowance and any top-ups will appear here."
          columns={[
            {
              key: 'source',
              header: 'Source',
              render: (row) => (
                <>
                  <b>{row.source}</b>
                  <br />
                  <small className="uboss-muted-3">{row.reason}</small>
                </>
              ),
            },
            {
              key: 'amount',
              header: 'Amount',
              numeric: true,
              render: (row) => money(row.amountMinor, row.currency),
            },
            {
              key: 'life',
              header: 'Life',
              render: (row) => (
                <small className="uboss-muted-3">
                  from {row.effectiveFrom}
                  <br />
                  {row.expiresAt === null ? 'does not expire' : `expires ${row.expiresAt}`}
                </small>
              ),
            },
            {
              key: 'state',
              header: 'State',
              render: (row) =>
                row.revokedAt !== null ? (
                  <>
                    <StatusBadge status="Withdrawn" tone="danger" />
                    <br />
                    <small className="uboss-muted-3">{row.revokeReason}</small>
                  </>
                ) : row.writtenOffAt !== null ? (
                  <StatusBadge status="Expired" tone="grey" />
                ) : row.live ? (
                  <StatusBadge status="Live" tone="success" dot />
                ) : (
                  <StatusBadge status="Not yet effective" tone="blue" />
                ),
            },
          ]}
        />
      </Card>

      <Drawer
        open={asking}
        onClose={() => setAsking(false)}
        title="Request more credits"
        footer={
          <div className="uboss-actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={submit}>
              Send to Finance
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        }
      >
        <CardBody>
          <Banner tone="info">
            <Icon name="shield" size={16} />
            This does not take a payment. UBoss Finance reviews the request, decides the amount, and
            records the invoice reference when the credits are added.
          </Banner>

          <div className="uboss-field">
            <label htmlFor="credit-amount">Amount</label>
            <input
              id="credit-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="40000"
            />
            <small className="uboss-field-hint">
              In whole currency units. Finance may approve a different amount.
            </small>
          </div>

          <div className="uboss-field">
            <label htmlFor="credit-reason">Reason</label>
            <textarea
              id="credit-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why the credits are needed"
            />
            <small className="uboss-field-hint">
              Required. Finance records this as the reason the credits were added.
            </small>
          </div>

          {policy?.billingChoiceEnabled === true && (
            <div className="uboss-field">
              <label htmlFor="credit-billing">How it should be billed</label>
              <select
                id="credit-billing"
                value={billingChoice}
                onChange={(event) => setBillingChoice(event.target.value)}
              >
                <option value="">Not specified — Finance will decide</option>
                {(meta?.billingChoices ?? [])
                  .filter((choice) => choice.choice !== 'Unspecified')
                  .map((choice) => (
                    <option key={choice.choice} value={choice.choice}>
                      {choice.label}
                    </option>
                  ))}
              </select>
              <small className="uboss-field-hint">An intent, not a payment instruction.</small>
            </div>
          )}
        </CardBody>
      </Drawer>
    </>
  );
}
