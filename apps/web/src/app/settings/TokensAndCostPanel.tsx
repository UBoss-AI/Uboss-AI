'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Icon,
  SegmentedControl,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  costApi,
  formatSpend,
  type CostLedgerEntryView,
  type CostMetaView,
  type UsageBreakdownView,
  type WalletView,
} from '../../lib/api-client';
import { formatDay, formatSpan } from '../../lib/when';

/** The column heading for each grouping. `user` is handled separately — "User" reads as a login. */
const usageLabel: Record<UsageBreakdownView['by'], string> = {
  department: 'Department',
  objective: 'Objective',
  agent: 'Agent',
  user: 'Person',
};

/**
 * Tokens & Cost — the reference's `setTokens()`, inside Settings.
 *
 * ## Why it is here and not on the dashboard
 *
 * The reference says so in its own words, and the panel repeats it: "These budget widgets belong
 * here in Settings — never duplicated on the Dashboard." The Company Dashboard stays the
 * two-slice donut. That note is kept verbatim because it is the rule, not a caption.
 *
 * ## What the reference shows and what §20 requires
 *
 * The reference's layout is Total allowance / Remaining / a progress bar / a department table /
 * three actions. §20's "Credit / allowance display" asks for more than that — **Total, Used,
 * Reserved, Remaining, percentage, next reset/expiry, and projected exhaustion** — so the layout
 * is the reference's and the figures are §20's.
 *
 * **Reserved is the one a reader will not expect**, and it is the one that explains the others:
 * remaining is the allowance minus what has been spent *and* what is currently set aside for runs
 * in flight. Without it the numbers look like they do not add up.
 *
 * ## Nothing here is projected when it cannot be
 *
 * Projected exhaustion is absent — not zero, not "never" — when nothing has been spent, when the
 * period is less than an hour old, or when the allowance is already gone. A date extrapolated
 * from twenty minutes of data would be quoted in a meeting.
 */
export function TokensAndCostPanel({ tenantId }: { tenantId: string | null }) {
  const [meta, setMeta] = useState<CostMetaView | null>(null);
  const [wallets, setWallets] = useState<WalletView[] | null>(null);
  const [ledger, setLedger] = useState<CostLedgerEntryView[] | null>(null);
  const [showLedger, setShowLedger] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<string | null>(null);
  const [usageBy, setUsageBy] = useState<UsageBreakdownView['by']>('department');
  const [usage, setUsage] = useState<UsageBreakdownView | null>(null);

  const load = useCallback(async () => {
    if (tenantId === null) return;
    try {
      const [loadedMeta, loadedWallets] = await Promise.all([
        costApi.meta(tenantId),
        costApi.wallets(tenantId),
      ]);
      setMeta(loadedMeta);
      setWallets(loadedWallets);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the budget.');
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Reloaded when the grouping changes, because the grouping happens on the server.
   *
   * Fetching every dimension once and regrouping here would mean sending the whole ledger to a
   * browser to add it up — and the ledger is the one table that only ever grows.
   */
  useEffect(() => {
    if (tenantId === null) return;
    let current = true;
    setUsage(null);
    costApi
      .usage(tenantId, usageBy)
      .then((loaded) => {
        if (current) setUsage(loaded);
      })
      .catch((caught: unknown) => {
        if (current) {
          setError(
            caught instanceof ApiError ? caught.message : 'Could not load where the spend went.',
          );
        }
      });
    return () => {
      current = false;
    };
  }, [tenantId, usageBy]);

  const openLedger = async () => {
    if (tenantId === null) return;
    setBusy(true);
    try {
      setLedger(await costApi.ledger(tenantId));
      setShowLedger(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the credit history.');
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async () => {
    if (tenantId === null) return;
    setBusy(true);
    try {
      const result = await costApi.reconcile(tenantId);
      setReconciliation(
        result.findings.length === 0
          ? `${result.checked} budget(s) checked. The running balance matches the ledger exactly.`
          : `${result.findings.length} drift(s) found across ${result.checked} budget(s). ` +
              'The ledger is the source of truth; a stored balance that disagrees means a write ' +
              'outside the cost engine.',
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The reconciliation did not run.');
    } finally {
      setBusy(false);
    }
  };

  const company = (wallets ?? []).find((wallet) => wallet.scope === 'Company') ?? null;
  const others = (wallets ?? []).filter((wallet) => wallet.scope !== 'Company');

  /**
   * Minor units to a readable amount. Integer arithmetic all the way to the string.
   *
   * Shared with the Engine Agents Cost column rather than kept here, so one agent's spend cannot
   * be rendered one way on this panel and another way on that list.
   */
  const money = formatSpend;

  const thresholdTone = (threshold: WalletView['threshold']): StatusTone =>
    threshold === 'HardStop' || threshold === 'Critical'
      ? 'danger'
      : threshold === 'Warning'
        ? 'warn'
        : threshold === 'Information'
          ? 'blue'
          : 'success';

  return (
    <>
      {error !== null && <Banner tone="warn">{error}</Banner>}
      {reconciliation !== null && (
        <Banner tone={reconciliation.includes('drift') ? 'danger' : 'ok'}>{reconciliation}</Banner>
      )}

      <Card>
        <CardBody>
          {company === null ? (
            <Banner tone="info">
              No AI budget is configured for this company yet. Nothing can be spent until one is.
            </Banner>
          ) : (
            <>
              <div className="uboss-spread">
                <div className="uboss-section-label">Tokens &amp; Usage</div>
                <StatusBadge
                  status={`${company.percent}% committed`}
                  tone={thresholdTone(company.threshold)}
                />
              </div>

              {/*
                Tokens, not rupees.

                These four tiles read the company's AI wallet, which the engine keeps in money —
                allowance, remaining, used, reserved. A company is quoted a plan price in money
                and counts everything it consumes in tokens, so the money figures do not belong
                on a company's screen: the two together are what divide into a per-million rate.

                What survives the change is the part that answers the question an admin actually
                has. "How much have we used" is the token count. "Are we about to be stopped" is
                the percentage and the bar below, which name no amount and need none.
              */}
              <div className="uboss-grid uboss-row-2">
                <div>
                  <div className="uboss-muted-3">Tokens used</div>
                  <div className="uboss-kv-value">
                    {usage === null ? '—' : usage.totals.tokens.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="uboss-muted-3">AI calls</div>
                  <div className="uboss-kv-value">
                    {usage === null ? '—' : usage.totals.calls.toLocaleString()}
                  </div>
                </div>
              </div>

              {/* The reference's progress bar. Capped at 100% width so an overspend does not
                  overflow the card, with the real percentage stated in the badge above. */}
              <div
                style={{
                  height: 12,
                  background: 'var(--uboss-bg-2)',
                  borderRadius: 8,
                  margin: '14px 0',
                  overflow: 'hidden',
                }}
                role="img"
                aria-label={`${company.percent}% of the AI allowance is committed`}
              >
                <div
                  style={{
                    width: `${Math.min(company.percent, 100)}%`,
                    height: '100%',
                    background:
                      company.threshold === 'HardStop' || company.threshold === 'Critical'
                        ? 'var(--uboss-danger)'
                        : 'var(--uboss-blue)',
                  }}
                />
              </div>

              <div className="uboss-kv">
                <span className="uboss-kv-key">Next reset</span>
                <span className="uboss-kv-value">
                  {formatDay(company.resetsAt) ?? 'This allowance does not reset.'}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Expires</span>
                <span className="uboss-kv-value">
                  {formatDay(company.expiresAt) ?? 'This allowance does not expire.'}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Projected exhaustion</span>
                <span className="uboss-kv-value">
                  {company.projectedExhaustion === null ? (
                    <span className="uboss-muted-3">
                      {/* Absent rather than invented: a date extrapolated from too little
                          spending would be quoted anyway. */}
                      Not enough spending yet to project one.
                    </span>
                  ) : (
                    /*
                      This read `2034-01-10T06:02:05.809Z — about 2659.1 days away`.

                      A machine timestamp with milliseconds and a UTC marker, and a span carrying a
                      tenth of a day of precision on a number that is a projection. Seven years out,
                      nobody wants 2,659 of anything — they want to know it is years away, which is
                      the only thing the estimate can honestly support.
                    */
                    `${formatDay(company.projectedExhaustion.at) ?? company.projectedExhaustion.at}${
                      formatSpan(company.projectedExhaustion.daysAway) === null
                        ? ''
                        : ` — ${formatSpan(company.projectedExhaustion.daysAway)} away`
                    }`
                  )}
                </span>
              </div>
            </>
          )}
        </CardBody>

        <DataTable
          caption="Budgets below the company level"
          rows={others}
          rowKey={(row) => row.id}
          loading={wallets === null}
          emptyTitle="No department or objective budgets"
          emptyDescription="Every spend is checked against the company budget alone until one is set."
          columns={[
            {
              key: 'scope',
              header: 'Budget',
              render: (row) => (
                <>
                  <b>{row.scopeLabel}</b>
                  <br />
                  <small className="uboss-muted-3 uboss-mono">
                    {row.subjectId?.slice(0, 8) ?? '—'}
                  </small>
                </>
              ),
            },
            {
              key: 'allowance',
              header: 'Budget',
              numeric: true,
              render: (row) => money(row.allowanceMinor, row.currency),
            },
            {
              key: 'used',
              header: 'Used',
              numeric: true,
              render: (row) => money(row.usedMinor, row.currency),
            },
            {
              key: 'reserved',
              header: 'Reserved',
              numeric: true,
              render: (row) => money(row.reservedMinor, row.currency),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => (
                <StatusBadge
                  status={row.threshold ?? 'On track'}
                  tone={thresholdTone(row.threshold)}
                  dot
                />
              ),
            },
          ]}
        />

        <CardBody>
          <div className="uboss-actions">
            {/* Neither has an endpoint: cost.controller.ts exposes allowance, reconcile and
                sweep-reservations, and credit is granted platform-side. Shown disabled with the
                reason rather than hidden, so the absence is legible instead of mysterious — and
                with no click handler at all, because a handler that does nothing is a lie the
                next reader has to disprove. */}
            <Button
              size="sm"
              disabled
              title="Credit is added platform-side today. Ask UBoss support for a top-up; there is no request flow from a company yet."
            >
              Request top-up
            </Button>
            <Button
              size="sm"
              disabled
              title="The company budget is a single pool today. Splitting it per department is not supported yet."
            >
              Reallocate budget
            </Button>
            <Button size="sm" disabled={busy} onClick={openLedger}>
              <Icon name="list" size={16} />
              Credit history
            </Button>
            <Button size="sm" disabled={busy} onClick={reconcile}>
              <Icon name="check" size={16} />
              Reconcile
            </Button>
          </div>

          {meta !== null && (
            <p className="uboss-notice uboss-notice-min">
              <Icon name="shield" size={14} />
              {meta.note}
            </p>
          )}

          {/* The reference's own words, kept verbatim because they are the rule. */}
          <p className="uboss-notice uboss-notice-min">
            <Icon name="shield" size={14} />
            These budget widgets belong here in Settings — never duplicated on the Dashboard.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="uboss-spread">
            <div className="uboss-section-label">Where the spend went</div>
            <SegmentedControl
              label="Group the spend by"
              value={usageBy}
              onChange={(next) => setUsageBy(next as UsageBreakdownView['by'])}
              options={[
                { value: 'department', label: 'Department' },
                { value: 'objective', label: 'Objective' },
                { value: 'agent', label: 'Agent' },
                { value: 'user', label: 'Person' },
              ]}
            />
          </div>
          <p className="uboss-muted-3">
            Only work that finished — capacity set aside for a call that has not happened yet is not
            counted, because reporting it would report consumption that never occurred.
          </p>
        </CardBody>
        <DataTable
          caption="Spend by dimension"
          rows={usage?.rows ?? []}
          rowKey={(row) => row.key ?? 'unattributed'}
          loading={usage === null}
          emptyTitle="No AI used yet"
          emptyDescription="No agent or assistant has consumed tokens for this company yet."
          columns={[
            {
              key: 'key',
              header: usageBy === 'user' ? 'Person' : usageLabel[usageBy],
              render: (row) => (
                <span className="uboss-mono">
                  {/* An engine settle is written on the engine's own behalf and names nobody.
                      Said plainly rather than shown as a blank cell somebody has to interpret. */}
                  {row.key === null ? 'Not attributed' : row.key.slice(0, 8)}
                </span>
              ),
            },
            {
              key: 'tokens',
              header: 'Tokens',
              numeric: true,
              render: (row) => row.tokens.toLocaleString(),
            },
            {
              key: 'calls',
              header: 'Calls',
              numeric: true,
              /*
               * Just the count. "N unpriced" used to hang under it, which was a money idea —
               * whether UBoss had published a rate for the model that answered. In a token
               * reading it says nothing: an unpriced model consumed exactly as many tokens as a
               * priced one, so the figure beside it is not understated and the warning that used
               * to sit above this table does not apply.
               */
              render: (row) => row.calls.toLocaleString(),
            },
          ]}
        />
      </Card>

      {showLedger && (
        <Card>
          <CardBody>
            <div className="uboss-spread">
              <div className="uboss-section-label">Credit history</div>
              <Button size="sm" onClick={() => setShowLedger(false)}>
                Hide
              </Button>
            </div>
            <p className="uboss-muted-3">
              Every movement, append-only. A reserve and its release both appear even though they
              net to zero — without them the balance would be unexplainable while a run is in
              flight.
            </p>
          </CardBody>
          <DataTable
            caption="Cost ledger"
            rows={ledger ?? []}
            rowKey={(row) => row.id}
            loading={ledger === null}
            emptyTitle="Nothing recorded yet"
            emptyDescription="No AI spend has been reserved or charged."
            columns={[
              {
                key: 'kind',
                header: 'Movement',
                render: (row) => (
                  <>
                    <b>{row.kind}</b>
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
                key: 'balance',
                header: 'Balance after',
                numeric: true,
                render: (row) => (
                  <>
                    {money(
                      row.balanceAfterAllowanceMinor -
                        row.balanceAfterUsedMinor -
                        row.balanceAfterReservedMinor,
                      row.currency,
                    )}
                    <br />
                    <small className="uboss-muted-3">remaining</small>
                  </>
                ),
              },
              {
                key: 'profile',
                header: 'Profile',
                render: (row) => (
                  // The logical model profile, never a provider name.
                  <span className="uboss-mono">{row.logicalProfile ?? '—'}</span>
                ),
              },
              {
                key: 'when',
                header: 'When',
                render: (row) => <small className="uboss-muted-3">{row.occurredAt}</small>,
              },
            ]}
          />
        </Card>
      )}
    </>
  );
}
