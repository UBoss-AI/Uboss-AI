'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  AGING_BUCKET_TONES,
  APPROVAL_RISK_TONES,
  APPROVAL_TYPE_RISK,
  type ApprovalRequestType,
} from '@uboss/types';
import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Icon,
  PageHeader,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  approvalsApi,
  authApi,
  type ApprovalRequestDetailView,
  type ApprovalSummaryView,
  type ApprovalsMetaView,
  type MeResponse,
} from '../../lib/api-client';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { DiscussButton } from '../../components/DiscussButton';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/**
 * The Approval Queue — the reference's `SCR.approvals` and `approvalDetail()`.
 *
 * Its layout is the reference's, not a redesign: a card whose toolbar carries the
 * Pending / Delegated / Decided segmented control and an "Aging shown" chip, then the table —
 * Subject, Decision type, Requester, Risk, Age. Selecting a row opens the decision view, which is
 * the reference's two-column `1fr 320px`: the request and its impact on the left, the decision
 * panel on the right with Approve, Send back, Reject and a reason box.
 *
 * ## Every button comes from the server
 *
 * The decision buttons are rendered from `available`, which the server computes by running the
 * *real* routing and authorization checks against the loaded row. So a disabled button and a
 * refused request can never disagree, and the tooltip explaining why is the sentence the server
 * would have returned — including "you cannot approve something you created", which is the
 * mandatory platform separation-of-duties control talking, not this screen guessing.
 *
 * That is why there is no local permission logic here at all. A screen that decides for itself
 * what a person may approve is a second authorization engine with no tests.
 *
 * ## Risk is presentation
 *
 * The Risk column comes from `APPROVAL_TYPE_RISK`, transcribed from the reference's own sample
 * rows. Nothing authorizes off it.
 */
export default function ApprovalsPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meta, setMeta] = useState<ApprovalsMetaView | null>(null);
  const [requests, setRequests] = useState<ApprovalSummaryView[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<'Pending' | 'Delegated' | 'Decided'>('Pending');
  const [selected, setSelected] = useState<ApprovalRequestDetailView | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
  const bell = useNotificationBell(tenantId);

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch((cause: unknown) =>
        setError(cause instanceof ApiError ? cause.message : 'Could not load your session.'),
      );
  }, []);

  const load = useCallback(async () => {
    if (tenantId === null) return;
    setLoading(true);
    try {
      const [loadedMeta, listed] = await Promise.all([
        approvalsApi.meta(tenantId),
        approvalsApi.list(tenantId, {
          // "Decided" is every settled status, which the server expresses as "not Pending" — so
          // the tab filters client-side rather than sending a status it has no word for.
          ...(tab === 'Pending' ? { status: 'Pending' } : {}),
          ...(tab === 'Delegated' ? { mineOnly: true, status: 'Pending' } : {}),
        }),
      ]);
      setMeta(loadedMeta);
      setCounts(listed.counts);
      setRequests(
        tab === 'Decided'
          ? listed.requests.filter((row) => row.status !== 'Pending')
          : listed.requests,
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load the approval queue.');
    } finally {
      setLoading(false);
    }
  }, [tenantId, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (approvalId: string) => {
    if (tenantId === null) return;
    try {
      setSelected(await approvalsApi.view(tenantId, approvalId));
      setNote('');
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not open that request.');
    }
  };

  const decide = async (decision: string) => {
    if (tenantId === null || selected === null) return;
    setBusy(true);
    try {
      const updated = await approvalsApi.decide(tenantId, selected.id, { decision, note });
      setSelected(updated);
      setNote('');
      setError(null);
      await load();
      await bell.refresh();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That decision was refused.');
    } finally {
      setBusy(false);
    }
  };

  const escalate = async () => {
    if (tenantId === null) return;
    setBusy(true);
    try {
      const outcome = await approvalsApi.escalate(tenantId);
      setError(
        outcome.escalated === 0
          ? 'Nothing was overdue. Nothing was decided either — escalation only moves attention.'
          : `${outcome.escalated} overdue request(s) escalated to a manager. None were decided.`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not run the sweep.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="approvals"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Approvals' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Approval Queue"
        description="Decisions from objective, agent, output, budget and guest flows."
        breadcrumbs={[{ label: 'Approvals' }]}
        actions={
          <Button size="sm" onClick={escalate} disabled={busy}>
            <Icon name="clock" size={16} />
            Sweep overdue
          </Button>
        }
      />

      {error !== null && (
        <Banner tone={error.startsWith('Nothing') || error.includes('escalated') ? 'info' : 'warn'}>
          {error}
        </Banner>
      )}

      {meta !== null && (
        <Banner tone="info">
          <Icon name="shield" size={16} />
          {meta.note}
        </Banner>
      )}

      <Card>
        <div className="uboss-toolbar">
          <div className="uboss-seg">
            {(['Pending', 'Delegated', 'Decided'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={tab === option ? 'is-on' : undefined}
                onClick={() => setTab(option)}
              >
                {option}
                {option === 'Pending' && counts.Pending !== undefined && (
                  <StatusBadge status={String(counts.Pending)} tone="blue" />
                )}
                {option === 'Delegated' && counts.Mine !== undefined && (
                  <StatusBadge status={String(counts.Mine)} tone="blue" />
                )}
              </button>
            ))}
          </div>
          <span className="uboss-chip">
            <Icon name="clock" size={14} />
            Aging shown
          </span>
        </div>

        <DataTable
          caption="Approval requests"
          rows={requests}
          rowKey={(row) => row.id}
          loading={loading}
          emptyTitle="Nothing waiting"
          emptyDescription={
            tab === 'Delegated'
              ? 'No requests are named to you or to somebody who has delegated to you.'
              : 'No approval requests match this view.'
          }
          columns={[
            {
              key: 'subject',
              header: 'Subject',
              render: (row) => (
                <>
                  <b>{row.title}</b>
                  <br />
                  <small className="uboss-muted-3 uboss-mono">{row.id.slice(0, 8)}</small>
                </>
              ),
            },
            {
              key: 'type',
              header: 'Decision type',
              render: (row) => <StatusBadge status={row.typeLabel} tone="purple" />,
            },
            {
              key: 'requester',
              header: 'Requester',
              render: (row) => (
                <span className="uboss-mono uboss-muted-3">
                  {row.requestedByUserId.slice(0, 8)}
                </span>
              ),
            },
            {
              key: 'risk',
              header: 'Risk',
              render: (row) => {
                const risk = APPROVAL_TYPE_RISK[row.type as ApprovalRequestType];
                return (
                  <StatusBadge
                    status={risk ?? 'Medium'}
                    tone={(APPROVAL_RISK_TONES[risk ?? 'Medium'] ?? 'grey') as StatusTone}
                  />
                );
              },
            },
            {
              key: 'age',
              header: 'Age',
              render: (row) => (
                <>
                  <StatusBadge
                    status={row.bucketLabel}
                    tone={(AGING_BUCKET_TONES[row.bucket] ?? 'grey') as StatusTone}
                    dot
                  />
                  <br />
                  <small className="uboss-muted-3">{row.hoursOpen}h</small>
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => (
                <>
                  <StatusBadge
                    status={row.status}
                    tone={
                      row.status === 'Approved'
                        ? 'success'
                        : row.status === 'Pending'
                          ? 'warn'
                          : 'grey'
                    }
                  />
                  {row.escalatedAt !== null && (
                    <>
                      <br />
                      <small className="uboss-muted-3">escalated</small>
                    </>
                  )}
                </>
              ),
            },
            {
              key: 'open',
              header: '',
              render: (row) => (
                <Button size="sm" onClick={() => void open(row.id)}>
                  Review
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected === null ? 'Approval decision' : selected.title}
        footer={
          selected === null ? null : (
            <div className="uboss-actions">
              {/*
                Prompt 40A (CR-03) §6 — Discuss, beside the decision rather than instead of it.
                An approver who needs to ask something should not have to decide first.
              */}
              <DiscussButton
                tenantId={tenantId}
                contextType="ApprovalRequest"
                resourceId={selected.id}
              />
              {selected.available.map((option) => (
                <Button
                  key={option.decision}
                  size="sm"
                  variant={
                    option.decision === 'Approve'
                      ? 'primary'
                      : option.decision === 'Reject'
                        ? 'danger'
                        : 'default'
                  }
                  disabled={!option.allowed || busy}
                  // The server's own sentence. Not a paraphrase, and not this screen's guess at
                  // what the rule is.
                  title={option.reason}
                  onClick={() => void decide(option.decision)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          )
        }
      >
        {selected !== null && (
          <CardBody>
            <p className="uboss-muted">
              Requested by{' '}
              <span className="uboss-mono">{selected.requestedByUserId.slice(0, 8)}</span>
              {' · '}
              {selected.typeLabel}
              {' · '}
              {selected.bucketLabel}, open {selected.hoursOpen}h
            </p>

            {selected.actingUnderDelegationFrom !== null && (
              <Banner tone="info">
                <Icon name="users" size={16} />
                You are deciding this as a delegate for{' '}
                <span className="uboss-mono">{selected.actingUnderDelegationFrom.slice(0, 8)}</span>
                . The record will say so.
              </Banner>
            )}

            {selected.approverRoleKind === 'FourEyes' && (
              <Banner tone="warn">
                <Icon name="shield" size={16} />
                Four-eyes: this gate needs two distinct people. Whoever raised it cannot decide it.
              </Banner>
            )}

            <div className="uboss-section-label">Detail</div>
            <p>{selected.detail === '' ? 'No detail was recorded.' : selected.detail}</p>

            <div className="uboss-kv">
              <span className="uboss-kv-key">Governed by</span>
              <span className="uboss-kv-value uboss-mono">{selected.module}:Approve</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Addressed to</span>
              <span className="uboss-kv-value">
                {selected.namedApproverUserId !== null
                  ? `A named approver (${selected.namedApproverUserId.slice(0, 8)})`
                  : selected.approverRoleKind === null
                    ? 'Nobody — this request is misconfigured'
                    : selected.approverRoleKind === 'FourEyes'
                      ? 'Any authorized approver, two of them'
                      : `The ${selected.approverRoleKind} role`}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Due</span>
              <span className="uboss-kv-value">
                {selected.dueAt === null ? 'No due date set' : selected.dueAt}
              </span>
            </div>
            {selected.escalatedAt !== null && (
              <div className="uboss-kv">
                <span className="uboss-kv-key">Escalated</span>
                <span className="uboss-kv-value">
                  {selected.escalatedAt} to{' '}
                  <span className="uboss-mono">
                    {selected.escalatedToUserId?.slice(0, 8) ?? '—'}
                  </span>
                  {' — attention only; nothing was decided.'}
                </span>
              </div>
            )}
            {selected.supersedesId !== null && (
              <div className="uboss-kv">
                <span className="uboss-kv-key">Replaces</span>
                <span className="uboss-kv-value uboss-mono">
                  {selected.supersedesId.slice(0, 8)}
                </span>
              </div>
            )}
            {selected.supersededById !== null && (
              <div className="uboss-kv">
                <span className="uboss-kv-key">Replaced by</span>
                <span className="uboss-kv-value uboss-mono">
                  {selected.supersededById.slice(0, 8)}
                </span>
              </div>
            )}

            {selected.status !== 'Pending' && (
              <>
                <div className="uboss-section-label">Decision</div>
                <p>
                  <StatusBadge
                    status={selected.status}
                    tone={selected.status === 'Approved' ? 'success' : 'grey'}
                  />{' '}
                  by <span className="uboss-mono">{selected.decidedByUserId?.slice(0, 8)}</span>
                  {selected.decidedOnBehalfOfUserId !== null && (
                    <>
                      {' on behalf of '}
                      <span className="uboss-mono">
                        {selected.decidedOnBehalfOfUserId.slice(0, 8)}
                      </span>
                    </>
                  )}
                </p>
                <p className="uboss-muted">{selected.decisionNote}</p>
                <div className="uboss-notice uboss-notice-min">
                  This decision is final. A correction is a new request that points back at this one
                  — the record is never rewritten.
                </div>
              </>
            )}

            <div className="uboss-section-label">History</div>
            {selected.history.length === 0 ? (
              <p className="uboss-muted-3">Nobody has acted on this yet.</p>
            ) : (
              <ul>
                {selected.history.map((entry) => (
                  <li key={entry.id}>
                    <b>{entry.decisionLabel}</b> by{' '}
                    <span className="uboss-mono">{entry.actorUserId.slice(0, 8)}</span>
                    {entry.onBehalfOfUserId !== null && (
                      <>
                        {' for '}
                        <span className="uboss-mono">{entry.onBehalfOfUserId.slice(0, 8)}</span>
                      </>
                    )}
                    {entry.note === '' ? null : <> — {entry.note}</>}
                    <br />
                    <small className="uboss-muted-3">{entry.occurredAt}</small>
                  </li>
                ))}
              </ul>
            )}

            {selected.status === 'Pending' && (
              <div className="uboss-field">
                <label htmlFor="approval-note">Reason</label>
                <textarea
                  id="approval-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Add a reason"
                />
                <small className="uboss-field-hint">
                  Required to reject or send back. The person who submitted the work cannot act on
                  &quot;no&quot;.
                </small>
              </div>
            )}
          </CardBody>
        )}
      </Drawer>
    </AppShell>
  );
}
