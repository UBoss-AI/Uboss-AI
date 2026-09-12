'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  Icon,
  PageHeader,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  todoApi,
  type HumanTaskView,
  type MeResponse,
} from '../../../lib/api-client';
import { useNotificationBell } from '../../../lib/use-notification-bell';
import { DiscussButton } from '../../../components/DiscussButton';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

/**
 * Task detail — the reference's `todoDetail()`, with the actions the client's list requires.
 *
 * The reference shows the task, its objective, who assigned it, the due time, "What to do",
 * "Expected output", "Evidence", an Activity panel naming the dependency, approval and blocker,
 * then "Submit & complete" and "Mark blocked".
 *
 * The client's own list for this screen adds three the reference omits — **Start**,
 * **Comment/Clarify** and **Add Evidence** — so they are here, in the reference's idiom. The
 * numbered prompt and the UI reference are both approved; where the prompt names a required
 * action the screen has to offer it.
 *
 * ## Why Submit is sometimes disabled with a reason
 *
 * A step whose Definition of Done required evidence cannot be submitted without any. The server
 * refuses it, and refusing on the screen too — with the requirement quoted — means the person
 * finds out while they still have the file to hand, rather than after a round trip.
 */
function TaskDetailInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const params = useSearchParams();
  const taskId = params.get('taskId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [task, setTask] = useState<HumanTaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [blockReason, setBlockReason] = useState('');
  const [evidenceText, setEvidenceText] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [noteText, setNoteText] = useState('');

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
    if (!tenantId || taskId === null) return;
    void todoApi
      .view(tenantId, taskId)
      .then(setTask)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load this task.'),
      );
  }, [taskId, tenantId]);

  useEffect(load, [load]);

  /** Every action goes through here, so error handling is never skipped on one of them. */
  const act = (run: (tenantId: string, taskId: string) => Promise<HumanTaskView>) => () => {
    if (!tenantId || taskId === null) return;
    setBusy(true);
    setError(null);

    void run(tenantId, taskId)
      .then((updated) => {
        setTask(updated);
        setBusy(false);
        setBlockReason('');
        setEvidenceText('');
        setEvidenceRef('');
        setNoteText('');
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That could not be done.');
        setBusy(false);
      });
  };

  const needsEvidence =
    task !== null && task.evidenceRequirement.trim() !== '' && task.evidence.length === 0;
  const canStart = task?.nextStatuses.includes('InProgress') ?? false;
  const canSubmit = (task?.nextStatuses.includes('Submitted') ?? false) && !needsEvidence;
  const canBlock = task?.nextStatuses.includes('Blocked') ?? false;
  const finished = task?.status === 'Completed' || task?.status === 'Cancelled';

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="todo"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'To-do List' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Task detail"
        breadcrumbs={[{ label: 'To-do List', href: '/todo' }, { label: 'Task' }]}
        actions={
          <>
            {/* Prompt 40A (CR-03) §6 — the person doing the work, asking about the work. */}
            {taskId === null ? null : (
              <DiscussButton tenantId={tenantId} contextType="HumanTask" resourceId={taskId} />
            )}
            <Link href="/todo">
              <Button size="sm">
                <Icon name="back" size={16} />
                Back
              </Button>
            </Link>
          </>
        }
      />

      {error === null ? null : (
        <Banner tone="danger">
          <Icon name="shield" size={16} />
          {error}
        </Banner>
      )}

      {task === null ? (
        <p className="uboss-muted">Loading…</p>
      ) : (
        <div className="uboss-grid" style={{ gridTemplateColumns: '1fr 340px' }}>
          {/* ---- Left: what the work is ---- */}
          <Card>
            <CardBody>
              <div className="uboss-spread">
                <h3 style={{ margin: 0 }}>{task.title}</h3>
                <StatusBadge
                  tone={task.displayTone as StatusTone}
                  status={task.displayStatus}
                  dot
                />
              </div>

              <p className="uboss-muted" style={{ margin: '8px 0 14px' }}>
                Objective: {task.objectiveName} ({task.objectiveCode}) · Assigned by{' '}
                <span className="uboss-mono">{task.assignedByUserId.slice(0, 8)}</span>
                {task.dueAt === null
                  ? task.triggerDescription.trim() === ''
                    ? ''
                    : ` · Triggered by ${task.triggerDescription}`
                  : ` · Due ${new Date(task.dueAt).toLocaleString()}`}
              </p>

              <div className="uboss-section-label">What to do</div>
              <p>{task.title}</p>

              <div className="uboss-section-label">Input</div>
              <p>{task.inputDescription.trim() === '' ? '—' : task.inputDescription}</p>

              <div className="uboss-section-label">Expected output</div>
              <p>{task.expectedOutput.trim() === '' ? '—' : task.expectedOutput}</p>

              <div className="uboss-section-label">Evidence</div>
              {task.evidenceRequirement.trim() === '' ? (
                <p className="uboss-muted-3">This step requires no evidence.</p>
              ) : (
                <Banner tone={needsEvidence ? 'warn' : 'ok'}>
                  <Icon name="file" size={16} />
                  {task.evidenceRequirement}
                </Banner>
              )}

              {task.evidence.length === 0 ? null : (
                <>
                  {task.evidence.map((entry) => (
                    <div className="uboss-kv" key={entry.id}>
                      <span className="uboss-kv-key">{entry.description}</span>
                      <span className="uboss-kv-value uboss-mono uboss-muted-3">
                        {entry.reference.trim() === '' ? '—' : entry.reference}
                      </span>
                    </div>
                  ))}
                </>
              )}

              {finished ? null : (
                <>
                  <hr className="uboss-sep" />
                  <div className="uboss-section-label" style={{ marginTop: 0 }}>
                    Add evidence
                  </div>
                  <div className="uboss-field">
                    <label htmlFor="evidenceText">What proves the work happened</label>
                    <input
                      id="evidenceText"
                      value={evidenceText}
                      onChange={(event) => setEvidenceText(event.target.value)}
                      placeholder="e.g. Evidence index v3"
                    />
                  </div>
                  <div className="uboss-field">
                    <label htmlFor="evidenceRef">Where it is</label>
                    <input
                      id="evidenceRef"
                      value={evidenceRef}
                      onChange={(event) => setEvidenceRef(event.target.value)}
                      placeholder="A document id, a run id, a system of record"
                    />
                    <span className="uboss-field-hint">
                      A reference, not an upload. UBoss does not store the file — it records where
                      the evidence actually lives.
                    </span>
                  </div>
                  <div className="uboss-actions">
                    <Button
                      size="sm"
                      disabled={busy || evidenceText.trim() === ''}
                      onClick={act((tenant, id) =>
                        todoApi.addEvidence(
                          tenant,
                          id,
                          evidenceText,
                          evidenceRef.trim() === '' ? undefined : evidenceRef,
                        ),
                      )}
                    >
                      <Icon name="plus" size={16} />
                      Add evidence
                    </Button>
                  </div>
                </>
              )}

              <hr className="uboss-sep" />
              <div className="uboss-section-label" style={{ marginTop: 0 }}>
                Comments and clarifications ({task.notes.length})
              </div>
              {task.notes.map((note) => (
                <div className="uboss-kv" key={note.id}>
                  <span className="uboss-kv-key">
                    <StatusBadge
                      tone={note.kind === 'Clarification' ? 'warn' : 'grey'}
                      status={note.kind}
                    />
                  </span>
                  <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                    {note.body}
                  </span>
                </div>
              ))}

              {finished ? null : (
                <>
                  <div className="uboss-field">
                    <label htmlFor="noteText">Comment or ask for clarification</label>
                    <textarea
                      id="noteText"
                      rows={2}
                      value={noteText}
                      onChange={(event) => setNoteText(event.target.value)}
                    />
                  </div>
                  <div className="uboss-actions">
                    <Button
                      size="sm"
                      disabled={busy || noteText.trim() === ''}
                      onClick={act((tenant, id) =>
                        todoApi.addNote(tenant, id, 'Comment', noteText),
                      )}
                    >
                      Comment
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || noteText.trim() === ''}
                      onClick={act((tenant, id) =>
                        todoApi.addNote(tenant, id, 'Clarification', noteText),
                      )}
                      title="Asking for clarification marks this task as needing input"
                    >
                      Clarify
                    </Button>
                  </div>
                </>
              )}
            </CardBody>
          </Card>

          {/* ---- Right: the reference's Activity panel, then the actions ---- */}
          <Card>
            <CardBody>
              <div className="uboss-section-label" style={{ marginTop: 0 }}>
                Activity
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Dependency</span>
                <span className="uboss-kv-value">
                  {task.dependsOnNodeIds.length === 0 ? 'None' : task.dependsOnNodeIds.join(', ')}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Approval</span>
                <span className="uboss-kv-value">
                  {task.approvalKind === null || task.approvalKind === 'NotRequired'
                    ? 'Not required'
                    : `${task.approvalKind} decision`}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Blocker</span>
                <span className="uboss-kv-value">
                  {task.blockedReason === null || task.blockedReason.trim() === ''
                    ? 'None'
                    : task.blockedReason}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Started</span>
                <span className="uboss-kv-value uboss-muted-3">
                  {task.startedAt === null ? 'Not yet' : new Date(task.startedAt).toLocaleString()}
                </span>
              </div>

              {finished ? (
                <p className="uboss-notice-min">
                  <Icon name="check" size={14} />
                  This task has finished. A completed task that turns out to be wrong is re-assigned
                  rather than re-opened — its evidence and timestamps are what a performance record
                  reads.
                </p>
              ) : (
                <>
                  {canStart ? (
                    <Button
                      variant="primary"
                      style={{ marginTop: 14, width: '100%' }}
                      disabled={busy}
                      onClick={act((tenant, id) => todoApi.start(tenant, id))}
                    >
                      {task.startedAt === null ? 'Start' : 'Resume'}
                    </Button>
                  ) : null}

                  <Button
                    {...(canStart ? {} : ({ variant: 'primary' } as const))}
                    style={{ marginTop: 8, width: '100%' }}
                    disabled={busy || !canSubmit}
                    title={
                      needsEvidence
                        ? `Attach evidence first: ${task.evidenceRequirement}`
                        : undefined
                    }
                    onClick={act((tenant, id) => todoApi.submit(tenant, id))}
                  >
                    Submit &amp; complete
                  </Button>

                  {needsEvidence ? (
                    <p className="uboss-notice-min">
                      <Icon name="alert" size={14} />
                      This step requires evidence and none is attached yet.
                    </p>
                  ) : null}

                  {task.approvalKind !== null && task.approvalKind !== 'NotRequired' ? (
                    <p className="uboss-notice-min">
                      <Icon name="shield" size={14} />
                      Submitting sends this for a {task.approvalKind} decision rather than
                      completing it.
                    </p>
                  ) : null}

                  {canBlock ? (
                    <>
                      <hr className="uboss-sep" />
                      <div className="uboss-field">
                        <label htmlFor="blockReason">Blocked reason</label>
                        <textarea
                          id="blockReason"
                          rows={2}
                          value={blockReason}
                          onChange={(event) => setBlockReason(event.target.value)}
                          placeholder="What is stopping you?"
                        />
                        <span className="uboss-field-hint">
                          Required. Without a reason nobody can unblock it.
                        </span>
                      </div>
                      <Button
                        style={{ width: '100%' }}
                        disabled={busy || blockReason.trim() === ''}
                        onClick={act((tenant, id) => todoApi.block(tenant, id, blockReason))}
                      >
                        Mark blocked
                      </Button>
                    </>
                  ) : null}
                </>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </AppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function TaskDetailPage() {
  return (
    <Suspense fallback={null}>
      <TaskDetailInner />
    </Suspense>
  );
}
