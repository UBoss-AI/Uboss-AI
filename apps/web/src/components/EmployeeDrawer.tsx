'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  DataTable,
  FormField,
  Icon,
  SkeletonText,
  StatusBadge,
  Tabs,
  type StatusTone,
} from '@uboss/ui';

import {
  accessApi,
  ApiError,
  chatApi,
  engineAgentsApi,
  organizationApi,
  todoApi,
  type EmployeeProfile,
  type EngineAgentView,
  type HumanTaskView,
} from '../lib/api-client';

/**
 * A person, inside the Hierarchy rather than instead of it.
 *
 * ## Why a panel and not the page that already exists
 *
 * There is a profile page, and clicking a card used to go to it. That is one navigation to see who
 * somebody is, another to come back, and the chart — the thing that gave the question its meaning
 * — is gone while you read the answer. An administrator checking three people in a department did
 * that six times. The panel keeps the chart on screen, so "who reports to them" is answered by
 * looking left rather than by going back.
 *
 * The full page stays. It is the right thing for a link somebody was sent, and this panel offers
 * a way to it.
 *
 * ## Offboarding is a handover, not a removal
 *
 * The client's rule is explicit: offboarding must show what will be affected and let the
 * administrator choose who picks it up. So the control does not offboard — it asks the server what
 * would happen, shows that, and only then offers to do it.
 *
 * Two things are deliberately **not** claimed:
 *
 *   * direct reports **do** move to the successor, because a team with no manager is a broken
 *     reporting tree and the server enforces that a successor is named when there are any;
 *   * objectives, agents and approvals **do not** move, and the panel says so. Handing somebody
 *     else's accountability to whoever happened to be the successor would be inventing a decision
 *     that belongs to a person, and quietly doing it is how an agent ends up owned by somebody who
 *     has never seen it.
 */

const TASK_TONE: Record<string, StatusTone> = {
  Assigned: 'blue',
  InProgress: 'teal',
  Blocked: 'danger',
  NeedsInput: 'warn',
  WaitingApproval: 'warn',
  Submitted: 'purple',
  Completed: 'success',
  Cancelled: 'grey',
  Overdue: 'danger',
};

interface OffboardingImpact {
  directReports: number;
  roleAssignments: number;
  openTasks: number;
  objectivesOwned: number;
  agentsOwned: number;
  approvalsPending: number;
  successorRequired: boolean;
  note: string;
}

export function EmployeeDrawer({
  tenantId,
  userId,
  me,
  mayAdminister,
  candidates,
  onClose,
  onChanged,
}: {
  tenantId: string;
  userId: string | null;
  /** The signed-in person, who is the other half of a direct conversation started from here. */
  me: string | null;
  /** Whether this viewer may offboard. The server decides again; this only hides the control. */
  mayAdminister: boolean;
  /** Who could take over, from the chart already loaded. Excludes the person themselves. */
  candidates: { userId: string; displayName: string; designation: string }[];
  onClose: () => void;
  /** Called after an offboarding, so the chart reloads. */
  onChanged: () => void;
}) {
  const router = useRouter();

  const [tab, setTab] = useState('overview');
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [tasks, setTasks] = useState<HumanTaskView[] | null>(null);
  const [agents, setAgents] = useState<EngineAgentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [offboarding, setOffboarding] = useState(false);
  const [impact, setImpact] = useState<OffboardingImpact | null>(null);
  const [successor, setSuccessor] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // A different person means a different panel: nothing from the last one may survive.
  useEffect(() => {
    setTab('overview');
    setProfile(null);
    setTasks(null);
    setAgents(null);
    setError(null);
    setOffboarding(false);
    setImpact(null);
    setSuccessor('');
    setReason('');
  }, [userId]);

  useEffect(() => {
    if (userId === null) return;

    void organizationApi
      .employee(tenantId, userId)
      .then(setProfile)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load this person.'),
      );

    /*
     * Their work and their agents are loaded separately and their refusals are swallowed.
     *
     * A viewer who may see the chart may not be able to read somebody else's To-do, and that is a
     * correct refusal rather than an error on this panel. An empty tab that says nothing is better
     * than a red banner over a profile that loaded perfectly well.
     */
    void todoApi
      .list(tenantId, { filter: 'team' })
      .then((result) => setTasks(result.tasks.filter((task) => task.assignedToUserId === userId)))
      .catch(() => setTasks([]));

    void engineAgentsApi
      .list(tenantId, false)
      .then((result) => setAgents(result.agents.filter((agent) => agent.ownerUserId === userId)))
      .catch(() => setAgents([]));
  }, [tenantId, userId]);

  /**
   * Open the direct conversation with this person, creating it the first time.
   *
   * A failure is reported rather than navigated through: arriving at Workshop Chat with nothing
   * selected, after pressing a button that said Chat, reads as the chat being broken.
   */
  const openChat = useCallback(async () => {
    if (tenantId === null || userId === null || me === null) return;
    setBusy(true);
    try {
      const conversation = await chatApi.start(tenantId, {
        kind: 'Direct',
        participantUserIds: [me, userId],
      });
      router.push(`/chat?conversation=${encodeURIComponent(conversation.id)}`);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'That conversation could not be opened.',
      );
    } finally {
      setBusy(false);
    }
  }, [me, router, tenantId, userId]);

  const startOffboarding = useCallback(() => {
    if (userId === null) return;
    setBusy(true);
    setError(null);
    accessApi
      .offboardingImpact(tenantId, userId)
      .then((result) => {
        setImpact(result);
        setOffboarding(true);
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not work out what offboarding would affect.',
        ),
      )
      .finally(() => setBusy(false));
  }, [tenantId, userId]);

  const confirmOffboarding = useCallback(() => {
    if (userId === null) return;
    setBusy(true);
    setError(null);
    accessApi
      .offboard(tenantId, userId, {
        reason: reason.trim(),
        ...(successor === '' ? {} : { successorUserId: successor }),
      })
      .then(() => {
        setOffboarding(false);
        onChanged();
        onClose();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'The offboarding was refused.'),
      )
      .finally(() => setBusy(false));
  }, [onChanged, onClose, reason, successor, tenantId, userId]);

  if (userId === null) return null;

  const others = candidates.filter((person) => person.userId !== userId);

  return (
    <aside className="uboss-emp-drawer" role="dialog" aria-label="Employee detail">
      <header className="uboss-emp-drawer-head">
        <div>
          <b>{profile?.displayName ?? 'Loading…'}</b>
          <br />
          <small className="uboss-muted-3">
            {profile === null
              ? ''
              : `${profile.designation} · ${profile.departmentName}`}
          </small>
        </div>
        <button
          type="button"
          className="uboss-emp-drawer-close"
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="close" size={15} />
        </button>
      </header>

      <div className="uboss-emp-drawer-body">
        {error !== null ? <Banner tone="danger">{error}</Banner> : null}

        {offboarding && impact !== null ? (
          /*
           * The handover.
           *
           * Everything the server said would happen, before anything happens. The successor is
           * required only when the server says it is — when this person has direct reports — and
           * the rest is stated rather than silently transferred.
           */
          <>
            <Banner tone="warn">{impact.note}</Banner>

            <DataTable
              caption="What offboarding affects"
              columns={[
                { key: 'what', header: 'What', render: (row) => row.label },
                { key: 'count', header: '', render: (row) => <b>{row.count}</b> },
                {
                  key: 'fate',
                  header: 'Happens to it',
                  render: (row) => <small className="uboss-muted-3">{row.fate}</small>,
                },
              ]}
              rows={[
                {
                  label: 'Direct reports',
                  count: impact.directReports,
                  fate:
                    impact.directReports === 0
                      ? '—'
                      : 'Moves to the successor. A team cannot be left without a manager.',
                },
                {
                  label: 'Role assignments',
                  count: impact.roleAssignments,
                  fate: 'Revoked. A role is permission to act, and is never inherited.',
                },
                {
                  label: 'Unfinished tasks',
                  count: impact.openTasks,
                  fate: 'Stay assigned to them. Reassign each one deliberately.',
                },
                {
                  label: 'Objectives owned',
                  count: impact.objectivesOwned,
                  fate: 'Keep this owner until somebody chooses a new one.',
                },
                {
                  label: 'Agents owned',
                  count: impact.agentsOwned,
                  fate: 'Keep this owner. An agent nobody answers for is worse than a paused one.',
                },
                {
                  label: 'Approvals waiting on them',
                  count: impact.approvalsPending,
                  fate: 'Stay pending. Re-address each, or they wait forever.',
                },
              ]}
              rowKey={(row) => row.label}
            />

            <FormField
              label="Who takes over"
              required={impact.successorRequired}
              hint={
                impact.successorRequired
                  ? 'Required: this person has direct reports, and they must report to somebody.'
                  : 'Optional. They have no direct reports to move.'
              }
            >
              {(field) => (
                <select
                  {...field}
                  className="uboss-select"
                  value={successor}
                  onChange={(event) => setSuccessor(event.target.value)}
                >
                  <option value="">No successor</option>
                  {others.map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.displayName} — {person.designation}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <FormField label="Reason" required hint="Recorded on the offboarding, permanently.">
              {(field) => (
                <textarea
                  {...field}
                  className="uboss-textarea"
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Why this person is leaving the company."
                />
              )}
            </FormField>

            <div className="uboss-row-actions">
              <Button onClick={() => setOffboarding(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={confirmOffboarding}
                disabled={
                  busy ||
                  reason.trim().length < 10 ||
                  (impact.successorRequired && successor === '')
                }
                title={
                  reason.trim().length < 10
                    ? 'A reason is required, and it has to say something.'
                    : impact.successorRequired && successor === ''
                      ? 'This person has direct reports — name who takes them.'
                      : undefined
                }
              >
                {busy ? 'Offboarding…' : 'Offboard and hand over'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Tabs
              activeId={tab}
              onChange={setTab}
              label="Employee detail"
              items={[
                { id: 'overview', label: 'Overview' },
                { id: 'work', label: 'Work' },
                { id: 'agents', label: 'Agents' },
              ]}
            />

            {tab === 'overview' ? (
              profile === null ? (
                <SkeletonText lines={5} />
              ) : (
                <>
                  <dl className="uboss-kv">
                    <dt>Employee ID</dt>
                    <dd className="uboss-mono">{profile.employeeId}</dd>
                    <dt>UBoss ID</dt>
                    <dd className="uboss-mono">{profile.ubossUniqueId}</dd>
                    <dt>Department</dt>
                    <dd>{profile.departmentName}</dd>
                    <dt>Reports to</dt>
                    <dd>{profile.reportingManagerName ?? '—'}</dd>
                    <dt>Employment</dt>
                    <dd>
                      <StatusBadge
                        status={profile.employmentState}
                        tone={profile.employmentState === 'Active' ? 'success' : 'grey'}
                      />
                    </dd>
                    <dt>Account</dt>
                    <dd>
                      <StatusBadge
                        status={profile.accountState ?? 'Unknown'}
                        tone={profile.accountState === 'Active' ? 'success' : 'grey'}
                      />
                    </dd>
                  </dl>

                  <div className="uboss-row-actions">
                    {/*
                      Straight into the conversation with this person.

                      The server returns the existing direct conversation when there is one and
                      creates it when there is not — both answer the same request, so pressing
                      this twice cannot leave two conversations between the same pair. That rule
                      lives in `startConversation`, keyed on the pair, rather than here: a screen
                      that checked first would still race another screen doing the same.
                    */}
                    <Button onClick={() => void openChat()} disabled={busy}>
                      <Icon name="chat" size={16} />
                      Chat
                    </Button>
                    <Button onClick={() => router.push(`/hierarchy/${userId}`)}>
                      Open full profile
                    </Button>
                    <Button onClick={() => router.push(`/performance?userId=${userId}`)}>
                      Performance
                    </Button>
                    {mayAdminister && profile.employmentState === 'Active' ? (
                      <Button variant="danger" onClick={startOffboarding} disabled={busy}>
                        {busy ? 'Checking…' : 'Offboard'}
                      </Button>
                    ) : null}
                  </div>
                </>
              )
            ) : null}

            {tab === 'work' ? (
              tasks === null ? (
                <SkeletonText lines={3} />
              ) : tasks.length === 0 ? (
                <p className="uboss-muted-3">No work is assigned to them, or it is not yours to see.</p>
              ) : (
                <DataTable
                  caption="Work assigned to this person"
                  columns={[
                    {
                      key: 'title',
                      header: 'Work',
                      render: (task: HumanTaskView) => (
                        <>
                          <b>{task.title}</b>
                          <br />
                          <small className="uboss-muted-3">{task.objectiveName}</small>
                        </>
                      ),
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      render: (task: HumanTaskView) => (
                        <StatusBadge
                          status={task.displayStatus}
                          tone={TASK_TONE[task.displayStatus] ?? 'grey'}
                        />
                      ),
                    },
                  ]}
                  rows={tasks}
                  rowKey={(task) => task.id}
                />
              )
            ) : null}

            {tab === 'agents' ? (
              agents === null ? (
                <SkeletonText lines={3} />
              ) : agents.length === 0 ? (
                <p className="uboss-muted-3">They own no agents.</p>
              ) : (
                <DataTable
                  caption="Agents this person owns"
                  columns={[
                    {
                      key: 'name',
                      header: 'Agent',
                      render: (agent: EngineAgentView) => <b>{agent.name}</b>,
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      render: (agent: EngineAgentView) => (
                        <StatusBadge
                          status={agent.status}
                          tone={agent.status === 'Active' ? 'success' : 'grey'}
                        />
                      ),
                    },
                  ]}
                  rows={agents}
                  rowKey={(agent) => agent.id}
                />
              )
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
