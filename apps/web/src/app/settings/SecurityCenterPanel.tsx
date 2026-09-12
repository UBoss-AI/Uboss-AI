'use client';

import { useRouter } from 'next/navigation';
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
  type DataTableColumn,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  securityCenterApi,
  type SecurityCenterPageView,
  type SecurityCenterRowView,
  type SecurityCenterVocabulary,
  type SecurityMetricReadingView,
  type SecurityPostureView,
} from '../../lib/api-client';

/**
 * Settings › Security — the Security Center, Prompt 32.
 *
 * ## The reference's screen, extended rather than replaced
 *
 * `index.html`'s `setSecurity()` is four KPI cards — MFA coverage, Active sessions, Admin
 * accounts, Guests — above a "Recent security events" table, and that shape is kept exactly:
 * the same four cards in the same order on the first row. §27.1 and the Technical Architecture
 * require seven more figures and seven named views, so the remaining cards sit on a second row
 * and the views become tabs under them. Nothing the client approved has been redesigned; what
 * the client also asked for has been added where it fits.
 *
 * ## Why every card is a link
 *
 * A security figure nobody can open is decoration. Each card drills into the view that explains
 * it — the server says which, so the screen cannot disagree with the API about where "Failed
 * logins" leads.
 *
 * ## What this screen deliberately cannot do
 *
 * **It cannot change anything it shows.** There is no acknowledge, no dismiss, no clear and no
 * delete, because the client's requirement is that important audit and security records cannot be
 * edited or deleted by a company's own administrators — and the store enforces that below the
 * application. The one act on the screen is revoking a session, which changes a session rather
 * than a record.
 */

const TONE_FOR_METRIC: Record<SecurityMetricReadingView['tone'], StatusTone> = {
  neutral: 'grey',
  good: 'success',
  watch: 'warn',
  bad: 'danger',
};

/**
 * What the badge says, since a tone is a colour and the text must carry the meaning on its own —
 * a screen read without colour has to be as informative as one read with it.
 */
const TONE_WORDS: Record<SecurityMetricReadingView['tone'], string> = {
  neutral: 'For information',
  good: 'Healthy',
  watch: 'Worth a look',
  bad: 'Needs attention',
};

const TONE_FOR_STATE: Record<string, StatusTone> = {
  Succeeded: 'success',
  Failed: 'danger',
  Blocked: 'danger',
  Live: 'blue',
  Lapsed: 'danger',
  Expiring: 'warn',
  Revoked: 'grey',
  Active: 'success',
  'No end date': 'danger',
};

const RANGE_LABELS: Record<string, string> = {
  Last24Hours: 'Last 24 hours',
  Last7Days: 'Last 7 days',
  Last30Days: 'Last 30 days',
  Last90Days: 'Last 90 days',
};

/** An action name reads better than `security.login_failed` on a screen a person is reading. */
function humanise(action: string): string {
  if (!action.startsWith('security.')) return action;
  const words = action.slice('security.'.length).split('_');
  const first = words[0] ?? '';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/**
 * Where a resource type can be opened, if anywhere.
 *
 * Deliberately a short list rather than a guess. A row about a session, a policy or a credit
 * grant has no screen of its own, and inventing a destination for it would send an investigator
 * to a page that cannot answer their question. Those rows show the identifier, which is what an
 * API request or a support conversation needs anyway.
 */
function resourceHref(resourceType: string | null, resourceId: string | null): string | null {
  if (resourceType === null || resourceId === null) return null;
  if (resourceType === 'user') return '/settings/users';
  if (resourceType === 'engine-agent') return `/agents?agent=${encodeURIComponent(resourceId)}`;
  if (resourceType === 'objective') return `/objective?objective=${encodeURIComponent(resourceId)}`;
  return null;
}

function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

export function SecurityCenterPanel({ tenantId }: { tenantId: string | null }): React.JSX.Element {
  const router = useRouter();
  const [vocabulary, setVocabulary] = useState<SecurityCenterVocabulary | null>(null);
  const [posture, setPosture] = useState<SecurityPostureView | null>(null);
  const [page, setPage] = useState<SecurityCenterPageView | null>(null);

  const [view, setView] = useState('AuthenticationEvents');
  const [range, setRange] = useState('Last7Days');
  const [correlationId, setCorrelationId] = useState('');
  const [appliedCorrelationId, setAppliedCorrelationId] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [revoking, setRevoking] = useState<SecurityCenterRowView | null>(null);
  const [revokeReason, setRevokeReason] = useState('');

  const load = useCallback(async () => {
    if (tenantId === null) return;
    setError(null);
    try {
      const [vocab, postureView] = await Promise.all([
        securityCenterApi.vocabulary(tenantId),
        securityCenterApi.posture(tenantId, { range }),
      ]);
      setVocabulary(vocab);
      setPosture(postureView);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'The Security Center could not be loaded. Try again.',
      );
    }
  }, [tenantId, range]);

  const loadView = useCallback(async () => {
    if (tenantId === null) return;
    setError(null);
    try {
      setPage(
        await securityCenterApi.view(tenantId, view, {
          range,
          ...(appliedCorrelationId === '' ? {} : { correlationId: appliedCorrelationId }),
        }),
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That view could not be loaded.');
    }
  }, [tenantId, view, range, appliedCorrelationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadView();
  }, [loadView]);

  const activeView = vocabulary?.views.find((candidate) => candidate.view === view);

  const exportView = async () => {
    if (tenantId === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const exported = await securityCenterApi.exportView(tenantId, view, { range });
      setNotice(
        `${exported.rows.length} row(s) exported. The export is itself recorded, and appears ` +
          'under Data exports.',
      );
      // The export changed the trail it came from, so the figures are stale.
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The export could not be taken.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (tenantId === null || revoking?.revocableSessionId == null) return;
    setBusy(true);
    try {
      const result = await securityCenterApi.revokeSession(
        tenantId,
        revoking.revocableSessionId,
        revokeReason,
      );
      setNotice(
        `${result.personDisplayName} has been signed out` +
          (result.signedOutOfCompanies > 1
            ? ` of UBoss, including ${result.signedOutOfCompanies - 1} other compan${
                result.signedOutOfCompanies - 1 === 1 ? 'y' : 'ies'
              } they belong to.`
            : '.'),
      );
      setRevoking(null);
      setRevokeReason('');
      await Promise.all([load(), loadView()]);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That session could not be revoked.');
    } finally {
      setBusy(false);
    }
  };

  if (tenantId === null) {
    return (
      <Banner tone="info">
        Choose a workspace to see its security posture. The Security Center is a company&rsquo;s own
        view of its own history.
      </Banner>
    );
  }

  const columns: DataTableColumn<SecurityCenterRowView>[] = [
    {
      key: 'when',
      header: 'When',
      render: (row: SecurityCenterRowView) => (
        <span className="uboss-mono">{when(row.occurredAt)}</span>
      ),
    },
    {
      key: 'what',
      header: 'Event',
      render: (row: SecurityCenterRowView) => (
        <div>
          <div style={{ fontWeight: 600 }}>{humanise(row.title)}</div>
          {row.detail === null ? null : (
            <div className="uboss-muted" style={{ fontSize: 12 }}>
              {row.detail}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'actor',
      header: 'Who',
      render: (row: SecurityCenterRowView) => (
        <div>
          <div>{row.actor ?? '—'}</div>
          {row.subject === null || row.subject === row.actor ? null : (
            <div className="uboss-muted" style={{ fontSize: 12 }}>
              about {row.subject}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'resource',
      header: 'Resource',
      render: (row: SecurityCenterRowView) => {
        if (row.resourceType === null) return <span className="uboss-muted">—</span>;
        const href = resourceHref(row.resourceType, row.resourceId);
        const label = `${row.resourceType}${row.resourceId === null ? '' : ` · ${row.resourceId.slice(0, 8)}`}`;
        return href === null ? (
          <span className="uboss-mono">{label}</span>
        ) : (
          <button
            type="button"
            className="uboss-seg"
            onClick={() => router.push(href)}
            title="Open this resource"
          >
            <span className="uboss-mono">{label}</span>
          </button>
        );
      },
    },
    {
      key: 'state',
      header: 'State',
      render: (row: SecurityCenterRowView) => (
        <StatusBadge tone={TONE_FOR_STATE[row.state] ?? 'grey'} status={row.state} />
      ),
    },
    {
      key: 'trace',
      header: 'Correlation',
      render: (row: SecurityCenterRowView) =>
        row.correlationId === null ? (
          <span className="uboss-muted">—</span>
        ) : (
          <button
            type="button"
            className="uboss-seg"
            onClick={() => {
              setCorrelationId(row.correlationId ?? '');
              setAppliedCorrelationId(row.correlationId ?? '');
            }}
            title="Show everything from this request"
          >
            <span className="uboss-mono">{row.correlationId.slice(0, 8)}</span>
          </button>
        ),
    },
    {
      key: 'action',
      header: '',
      render: (row: SecurityCenterRowView) =>
        row.revocableSessionId === null || posture?.mayRevokeSessions !== true ? null : (
          <Button
            variant="danger"
            onClick={() => {
              setRevoking(row);
              setRevokeReason('');
            }}
          >
            Sign out
          </Button>
        ),
    },
  ];

  return (
    <div className="uboss-grid">
      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {notice === null ? null : <Banner tone="info">{notice}</Banner>}

      {/* The reference's four cards, in the reference's order, first. */}
      <div className="uboss-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {(posture?.metrics ?? []).slice(0, 4).map((reading) => (
          <MetricCard key={reading.metric} reading={reading} onOpen={setView} />
        ))}
      </div>

      {/* The seven §27.1 requires beyond the reference's four. */}
      <div className="uboss-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {(posture?.metrics ?? []).slice(4).map((reading) => (
          <MetricCard key={reading.metric} reading={reading} onOpen={setView} />
        ))}
      </div>

      <Card>
        <CardBody>
          <div className="uboss-spread">
            <div className="uboss-seg">
              {(vocabulary?.views ?? []).map((candidate) => (
                <button
                  key={candidate.view}
                  type="button"
                  className={candidate.view === view ? 'is-on' : ''}
                  onClick={() => setView(candidate.view)}
                >
                  {candidate.label}
                </button>
              ))}
            </div>

            <div className="uboss-actions">
              <div className="uboss-seg">
                {(vocabulary?.ranges ?? []).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    className={candidate === range ? 'is-on' : ''}
                    onClick={() => setRange(candidate)}
                  >
                    {RANGE_LABELS[candidate] ?? candidate}
                  </button>
                ))}
              </div>
              {posture?.mayExport === true ? (
                <Button variant="navy" onClick={() => void exportView()} disabled={busy}>
                  Export this view
                </Button>
              ) : null}
            </div>
          </div>

          <p className="uboss-muted" style={{ marginTop: 8 }}>
            {page?.purpose ?? activeView?.purpose ?? ''}
          </p>

          {activeView?.hasCorrelationIds === true ? (
            <div className="uboss-row-2" style={{ marginTop: 8 }}>
              <label>
                <span className="uboss-section-label">Correlation ID</span>
                <input
                  value={correlationId}
                  onChange={(event) => setCorrelationId(event.target.value)}
                  placeholder="Everything from one request"
                />
              </label>
              <div className="uboss-actions">
                <Button onClick={() => setAppliedCorrelationId(correlationId.trim())}>Apply</Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCorrelationId('');
                    setAppliedCorrelationId('');
                  }}
                >
                  Clear
                </Button>
              </div>
            </div>
          ) : null}

          {page?.limitation === undefined ? null : <Banner tone="info">{page.limitation}</Banner>}

          <DataTable
            caption={`${page?.label ?? 'Security'} — ${page?.total ?? 0} matching row(s)`}
            columns={columns}
            rows={page?.rows ?? []}
            rowKey={(row) => row.id}
            emptyTitle="Nothing in this window"
            emptyDescription="Widen the time range, or there is genuinely nothing to see — which is the answer a security screen should be able to give."
          />

          <p className="uboss-notice-min" style={{ marginTop: 8 }}>
            <Icon name="shield" size={14} />
            {page === null
              ? ''
              : `${page.rows.length} of ${page.total} matching row(s). ` + (vocabulary?.note ?? '')}
          </p>
        </CardBody>
      </Card>

      <Drawer
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Sign this person out"
        footer={
          <div className="uboss-actions">
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void revoke()}
              disabled={busy || revokeReason.trim().length < 4}
            >
              Sign out
            </Button>
          </div>
        }
      >
        <p>
          {revoking?.title ?? 'This person'} will be signed out immediately.{' '}
          <strong>
            A session belongs to a person rather than to a company, so this ends their UBoss session
            everywhere — including any other company they belong to.
          </strong>
        </p>
        <label>
          <span className="uboss-section-label">Why</span>
          <textarea
            value={revokeReason}
            onChange={(event) => setRevokeReason(event.target.value)}
            rows={3}
            placeholder="Laptop reported stolen."
          />
        </label>
        <p className="uboss-notice-min">
          <Icon name="alert" size={14} />
          The reason is recorded against your name in the security trail, which you cannot later
          edit or delete.
        </p>
      </Drawer>
    </div>
  );
}

function MetricCard({
  reading,
  onOpen,
}: {
  reading: SecurityMetricReadingView;
  onOpen: (view: string) => void;
}): React.JSX.Element {
  return (
    <Card>
      <CardBody>
        <button
          type="button"
          onClick={() => onOpen(reading.drillsInto)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            display: 'block',
            width: '100%',
            textAlign: 'left',
          }}
          title={`Open ${reading.label}`}
        >
          <div className="uboss-spread">
            <span className="uboss-section-label">{reading.label}</span>
            <StatusBadge tone={TONE_FOR_METRIC[reading.tone]} status={TONE_WORDS[reading.tone]} />
          </div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{reading.value}</div>
          <div className="uboss-muted" style={{ fontSize: 12 }}>
            {reading.caption}
          </div>
        </button>
      </CardBody>
    </Card>
  );
}
