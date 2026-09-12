'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Icon,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  costApi,
  type CostLedgerEntryView,
  type CostMetaView,
  type WalletView,
} from '../../lib/api-client';

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

  /** Minor units to a readable amount. Integer arithmetic all the way to the string. */
  const money = (minor: number, currency: string) => {
    const sign = minor < 0 ? '-' : '';
    const absolute = Math.abs(minor);
    return `${sign}${currency} ${Math.floor(absolute / 100).toLocaleString()}.${String(
      absolute % 100,
    ).padStart(2, '0')}`;
  };

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
                <div className="uboss-section-label">Tokens &amp; Cost</div>
                <StatusBadge
                  status={`${company.percent}% committed`}
                  tone={thresholdTone(company.threshold)}
                />
              </div>

              <div className="uboss-grid uboss-row-2">
                <div>
                  <div className="uboss-muted-3">Total allowance</div>
                  <div className="uboss-kv-value">
                    {money(company.allowanceMinor, company.currency)}
                  </div>
                </div>
                <div>
                  <div className="uboss-muted-3">Remaining</div>
                  <div className="uboss-kv-value">
                    {money(company.remainingMinor, company.currency)}
                  </div>
                </div>
                <div>
                  <div className="uboss-muted-3">Used</div>
                  <div className="uboss-kv-value">{money(company.usedMinor, company.currency)}</div>
                </div>
                <div>
                  {/* The figure a reader will not expect, and the one that explains the others. */}
                  <div className="uboss-muted-3">Reserved for runs in flight</div>
                  <div className="uboss-kv-value">
                    {money(company.reservedMinor, company.currency)}
                  </div>
                </div>
              </div>

              {/* The reference's progress bar. Capped at 100% width so an overspend does not
                  overflow the card, with the real percentage stated in the badge above. */}
              <div
                style={{
                  height: 12,
                  background: 'var(--uboss-bg-2, #eef1f5)',
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
                        ? 'var(--uboss-danger, #c0392b)'
                        : 'var(--uboss-blue, #2f6fed)',
                  }}
                />
              </div>

              <div className="uboss-kv">
                <span className="uboss-kv-key">Next reset</span>
                <span className="uboss-kv-value">
                  {company.resetsAt ?? 'This allowance does not reset.'}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Expires</span>
                <span className="uboss-kv-value">
                  {company.expiresAt ?? 'This allowance does not expire.'}
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
                    `${company.projectedExhaustion.at} — about ${company.projectedExhaustion.daysAway} days away`
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
            {/* Prompt 31 owns the request/purchase and reallocation flows. The buttons are not
                rendered as working controls here, because a button that does nothing is worse
                than one that is honestly absent. */}
            <Button size="sm" disabled onClick={() => undefined} title="Arrives with Prompt 31.">
              Request top-up
            </Button>
            <Button size="sm" disabled onClick={() => undefined} title="Arrives with Prompt 31.">
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
