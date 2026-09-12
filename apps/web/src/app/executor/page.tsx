'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  EXCEPTION_KIND_LABELS,
  EXCEPTION_SEVERITY_TONES,
  EXCEPTION_STATE_LABELS,
  EXCEPTION_STATE_TONES,
  RESOLUTION_ACTION_LABELS,
  type ExceptionKind,
  type ResolutionAction,
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
  authApi,
  executorApi,
  type ExceptionView,
  type ExecutorMetaView,
  type MeResponse,
} from '../../lib/api-client';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { DiscussButton } from '../../components/DiscussButton';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/**
 * The Exception Center — the reference's `SCR.executor`.
 *
 * Its layout: the warning banner explaining what the Executor is, a card whose toolbar carries a
 * chip per exception kind, then the table — Work item, Type, Owner, Reason, Severity, Age, State.
 * Selecting a row opens the detail, which is the reference's `exceptionDetail()`.
 *
 * ## What this screen exists to make visible
 *
 * The banner is not decoration. "It does not do the work — it validates, escalates and resolves"
 * is the client's own wording, and the whole screen is arranged around the boundary it states:
 * every action offered comes from the server's `availableActions`, and the Executor's own
 * permitted actions are shown separately so a person can see what the machine did on its own and
 * what it could not.
 *
 * A resolved exception shows who closed it and why. An unowned one shows the source document's
 * default owner for its kind, which is an honest "we know whose kind of problem this is" rather
 * than an empty cell.
 */
export default function ExecutorPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meta, setMeta] = useState<ExecutorMetaView | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionView[]>([]);
  const [selected, setSelected] = useState<ExceptionView | null>(null);
  const [kindFilter, setKindFilter] = useState<ExceptionKind | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
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
    if (!tenantId) return;
    setLoading(true);

    void executorApi
      .meta(tenantId)
      .then(setMeta)
      .catch(() => undefined);

    void executorApi
      .list(tenantId, {
        ...(kindFilter === null ? {} : { kind: kindFilter }),
        openOnly: !showClosed,
      })
      .then((result) => {
        setExceptions(result.exceptions);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not load exceptions.');
        setLoading(false);
      });
  }, [kindFilter, showClosed, tenantId]);

  useEffect(load, [load]);

  const act = (action: ResolutionAction, note: string, toUserId?: string) => {
    if (!tenantId || selected === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    void executorApi
      .act(tenantId, selected.id, { action, note, ...(toUserId === undefined ? {} : { toUserId }) })
      .then((updated) => {
        setSelected(updated);
        setNotice(`${RESOLUTION_ACTION_LABELS[action]} recorded.`);
        setBusy(false);
        load();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That did not work.');
        setBusy(false);
      });
  };

  const sweep = () => {
    if (!tenantId) return;
    setBusy(true);
    void executorApi
      .sweep(tenantId)
      .then((result) => {
        setNotice(
          `Swept: ${result.raised} raised, ${result.escalated} escalated, ${result.cleared} cleared.`,
        );
        setBusy(false);
        load();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'The sweep did not run.');
        setBusy(false);
      });
  };

  const age = (openedAt: string) => {
    const hours = (Date.now() - new Date(openedAt).getTime()) / 3_600_000;
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 48) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  };

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="executor"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Executor Agent' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Executor — Exception Center"
        description="Monitor execution and route exceptions."
        breadcrumbs={[{ label: 'Executor Agent' }]}
        actions={
          <Button size="sm" disabled={busy} onClick={sweep}>
            <Icon name="bolt" size={16} />
            Sweep now
          </Button>
        }
      />

      {/* The client's own wording. It states the boundary the whole screen is arranged around. */}
      <Banner tone="warn">
        <Icon name="shield" size={18} />
        The Executor monitors human and Engine Agent execution and routes exceptions. It does not do
        the work — it validates, escalates and resolves. It never closes its own findings, and it
        never stands in for a required human approval.
      </Banner>

      {error === null ? null : (
        <Banner tone="danger">
          <Icon name="shield" size={16} />
          {error}
        </Banner>
      )}
      {notice === null ? null : (
        <Banner tone="ok">
          <Icon name="check" size={16} />
          {notice}
        </Banner>
      )}

      <Card>
        <CardBody>
          <div className="uboss-toolbar" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="uboss-chip"
              aria-pressed={kindFilter === null}
              onClick={() => setKindFilter(null)}
            >
              All
            </button>
            {(meta?.kinds ?? []).map((entry) => (
              <button
                type="button"
                className="uboss-chip"
                key={entry.kind}
                aria-pressed={kindFilter === entry.kind}
                onClick={() => setKindFilter(entry.kind)}
                title={`Default owner: ${entry.defaultOwner}`}
              >
                {entry.label}
              </button>
            ))}
            <label className="uboss-checkbox" style={{ marginLeft: 'auto' }}>
              <input
                type="checkbox"
                checked={showClosed}
                onChange={(event) => setShowClosed(event.target.checked)}
              />
              Include closed
            </label>
          </div>

          <DataTable
            caption="Exceptions"
            rows={exceptions}
            rowKey={(row) => row.id}
            loading={loading}
            columns={[
              {
                key: 'item',
                header: 'Work item',
                render: (row) => (
                  <>
                    <b>{row.detail.slice(0, 80)}</b>
                    <br />
                    <small className="uboss-mono uboss-muted-3">
                      {row.sourceType} · {row.sourceId.slice(0, 8)}
                    </small>
                  </>
                ),
              },
              {
                key: 'type',
                header: 'Type',
                render: (row) => (
                  <StatusBadge tone="cyan" status={EXCEPTION_KIND_LABELS[row.kind]} />
                ),
              },
              {
                key: 'owner',
                header: 'Owner',
                render: (row) =>
                  row.ownerUserId === null ? (
                    // Not an empty cell: the document's default owner for the kind is an honest
                    // answer to "whose is this?" when routing could not name an individual.
                    <span className="uboss-muted-3" title={row.defaultOwner}>
                      Unassigned — {row.defaultOwner}
                    </span>
                  ) : (
                    <span className="uboss-mono uboss-muted-3">{row.ownerUserId.slice(0, 8)}</span>
                  ),
              },
              {
                key: 'severity',
                header: 'Severity',
                render: (row) => (
                  <StatusBadge
                    tone={EXCEPTION_SEVERITY_TONES[row.severity] as StatusTone}
                    status={row.severity}
                  />
                ),
              },
              {
                key: 'age',
                header: 'Age',
                render: (row) => (
                  <span className={row.escalation.due ? 'uboss-mono' : 'uboss-mono uboss-muted-3'}>
                    {age(row.openedAt)}
                    {row.escalation.due ? ' · overdue' : ''}
                  </span>
                ),
              },
              {
                key: 'state',
                header: 'State',
                render: (row) => (
                  <StatusBadge
                    tone={EXCEPTION_STATE_TONES[row.state] as StatusTone}
                    status={EXCEPTION_STATE_LABELS[row.state]}
                  />
                ),
              },
              {
                key: 'open',
                header: '',
                render: (row) => (
                  <Button size="sm" onClick={() => setSelected(row)}>
                    Open
                  </Button>
                ),
              },
            ]}
            emptyTitle="Nothing needs attention"
            emptyDescription="The Executor raises an exception here when it finds something. Sweep to check now."
          />
        </CardBody>
      </Card>

      {/* ---- Detail: the reference's exceptionDetail() ---- */}
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected === null ? '' : EXCEPTION_KIND_LABELS[selected.kind]}
        footer={<Button onClick={() => setSelected(null)}>Close</Button>}
      >
        {selected === null ? null : (
          <>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Severity</span>
              <span className="uboss-kv-value">
                <StatusBadge
                  tone={EXCEPTION_SEVERITY_TONES[selected.severity] as StatusTone}
                  status={selected.severity}
                />
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">State</span>
              <span className="uboss-kv-value">
                <StatusBadge
                  tone={EXCEPTION_STATE_TONES[selected.state] as StatusTone}
                  status={EXCEPTION_STATE_LABELS[selected.state]}
                />
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Age</span>
              <span className="uboss-kv-value">{selected.escalation.reason}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Attempts</span>
              <span className="uboss-kv-value">{selected.attempts}</span>
            </div>

            <div className="uboss-section-label">What happened</div>
            <p>{selected.detail}</p>

            {selected.evidence === null || selected.evidence === undefined ? null : (
              <>
                <div className="uboss-section-label">Evidence</div>
                <pre className="uboss-mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(selected.evidence, null, 2)}
                </pre>
              </>
            )}

            {selected.closedAt === null ? null : (
              <>
                <div className="uboss-section-label">Closed</div>
                <p>{selected.closeReason}</p>
              </>
            )}

            <div className="uboss-section-label">Resolution history</div>
            {selected.history.map((event, index) => (
              <div className="uboss-kv" key={index}>
                <span className="uboss-kv-key">
                  {event.action ?? event.state}
                  <br />
                  <small className="uboss-muted-3">
                    {/* Who did it — the machine and nobody are different answers. */}
                    {event.byExecutor ? 'Executor Agent' : 'A person'}
                  </small>
                </span>
                <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                  {event.note}
                </span>
              </div>
            ))}

            {selected.availableActions.length === 0 ? (
              <p className="uboss-notice-min">
                <Icon name="check" size={14} />
                This exception is closed. Reopening it would rewrite a resolution somebody recorded
                — if the condition recurs, the sweep raises a new one.
              </p>
            ) : (
              <>
                <div className="uboss-section-label">What you can do</div>
                <div className="uboss-actions">
                  {/*
                    Prompt 40A (CR-03) §6 — an exception is the case most likely to need a
                    conversation, because the person who can resolve it is often not the person
                    who found it.
                  */}
                  <DiscussButton
                    tenantId={tenantId}
                    contextType="ExecutorException"
                    resourceId={selected.id}
                  />
                  {selected.availableActions.map((action) => (
                    <Button
                      size="sm"
                      key={action}
                      disabled={busy}
                      {...(action === 'Resolve' ? { variant: 'primary' as const } : {})}
                      onClick={() => {
                        const note = window.prompt(
                          `${RESOLUTION_ACTION_LABELS[action]} — what should the record say?`,
                        );
                        if (note === null || note.trim() === '') return;
                        if (action === 'Reassign' || action === 'Escalate') {
                          const toUserId = window.prompt('Which user id should this go to?');
                          if (toUserId === null || toUserId.trim() === '') return;
                          act(action, note, toUserId.trim());
                          return;
                        }
                        act(action, note);
                      }}
                    >
                      {RESOLUTION_ACTION_LABELS[action]}
                    </Button>
                  ))}
                </div>
              </>
            )}

            <p className="uboss-notice-min">
              <Icon name="shield" size={14} />
              {selected.note}
            </p>
          </>
        )}
      </Drawer>
    </AppShell>
  );
}
