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
  auditApi,
  chatApi,
  engineAgentsApi,
  organizationApi,
  performanceApi,
  type PerformanceView,
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

/**
 * One line of somebody's activity, from either trail.
 *
 * Two sources, one timeline: the audit trail says what this person did, and the security trail
 * says what was done to their account. Merged into a single shape so the table does not have to
 * know which half a row came from — except through `kind`, which is the part a reader wants.
 */
interface ActivityRow {
  id: string;
  action: string;
  summary: string | null;
  occurredAt: string;
  kind: 'did' | 'happened';
}

export function EmployeeDrawer({
  tenantId,
  userId,
  me,
  openEditing,
  mayAdminister,
  candidates,
  onClose,
  onChanged,
}: {
  tenantId: string;
  userId: string | null;
  /** The signed-in person, who is the other half of a direct conversation started from here. */
  me: string | null;
  /**
   * Open straight into the edit form rather than the read-only overview.
   *
   * Set when somebody arrived by pressing the pencil on a card, which is them saying they want to
   * change something — not that they want to read about it first.
   */
  openEditing?: boolean;
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

  /**
   * The edit, in place.
   *
   * Null when nobody is editing. Opening it copies the profile into a draft rather than binding
   * the inputs to the profile itself: a half-typed designation must not be what the rest of the
   * panel reads, and abandoning an edit has to leave the record as it was.
   */
  const [draft, setDraft] = useState<{
    displayName: string;
    employeeId: string;
    designation: string;
    workEmail: string;
    workPhone: string;
    reportingManagerUserId: string;
  } | null>(null);

  /**
   * What this person has done, and what has been done to them.
   *
   * Two queries against the audit trail rather than one: `actorUserId` is the work they did and
   * `subjectUserId` is what an administrator did to their account, and somebody asking "what has
   * happened with this person" means both. Merged and sorted, because the answer is a timeline.
   */
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [activityNote, setActivityNote] = useState<string | null>(null);

  /** That person's own performance, read here rather than on another screen. */
  const [performance, setPerformance] = useState<PerformanceView | null>(null);
  const [performanceNote, setPerformanceNote] = useState<string | null>(null);

  const [offboarding, setOffboarding] = useState(false);
  const [impact, setImpact] = useState<OffboardingImpact | null>(null);
  const [successor, setSuccessor] = useState('');
  /**
   * How many days they keep working.
   *
   * Thirty by default, because that is what a resignation usually is, and zero is right there for
   * the case where it is not. Kept as text so the field can be emptied while somebody retypes it
   * — a number input that snaps to 0 on backspace would offboard somebody today by accident.
   */
  const [noticeDays, setNoticeDays] = useState('30');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // A different person means a different panel: nothing from the last one may survive.
  useEffect(() => {
    setTab('overview');
    setProfile(null);
    setDraft(null);
    setPerformance(null);
    setPerformanceNote(null);
    setActivity(null);
    setActivityNote(null);
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
      .then((loaded) => {
        setProfile(loaded);
        /*
         * Straight into the form, when somebody arrived by pressing the pencil on a card.
         *
         * Filled here rather than when the panel opened, because the draft is a copy of the
         * record and the record had not arrived yet. Guarded by the same two conditions as the
         * Edit button — may administer, still employed — so the shortcut cannot reach a form the
         * button itself would not have offered.
         */
        if (openEditing === true && mayAdminister && loaded.employmentState === 'Active') {
          setDraft({
            displayName: loaded.displayName,
            employeeId: loaded.employeeId,
            designation: loaded.designation,
            workEmail: loaded.workEmail ?? '',
            workPhone: loaded.workPhone ?? '',
            reportingManagerUserId: loaded.reportingManagerUserId ?? '',
          });
        }
      })
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
    /*
     * `mayAdminister` and `openEditing` are read when the profile arrives, above.
     *
     * Listed because they are: a panel opened by the pencil for somebody who may administer has
     * to fill the form, and leaving them out would make that depend on which render happened to
     * run first. Neither changes while one person's panel is open, so this does not re-fetch.
     */
  }, [mayAdminister, openEditing, tenantId, userId]);

  /*
   * Their performance, beside their work rather than on a screen of its own.
   *
   * A refusal says so instead of showing a blank score: "no record" and "not yours to read" are
   * different facts, and a zero in place of the second is a lie about somebody's work.
   */
  useEffect(() => {
    if (tenantId === null || userId === null) return;
    let current = true;
    setPerformance(null);
    setPerformanceNote(null);

    void performanceApi
      .forUser(tenantId, userId)
      .then((view) => {
        if (current) setPerformance(view);
      })
      .catch((caught: unknown) => {
        if (!current) return;
        setPerformanceNote(
          caught instanceof ApiError && caught.statusCode === 403
            ? 'Not shown — you do not have access to this person’s performance record.'
            : 'Could not load their performance record.',
        );
      });

    return () => {
      current = false;
    };
  }, [tenantId, userId]);

  /*
   * Their activity, once somebody opens the tab.
   *
   * Deliberately not loaded with the panel: an audit query is heavier than the rest of this
   * screen, and most people opening a card want the overview. A refusal says so — reading a
   * company's audit trail needs `settings:Audit`, and most administrators do not hold it.
   */
  useEffect(() => {
    if (tenantId === null || userId === null || tab !== 'activity' || activity !== null) return;
    let current = true;

    void Promise.all([
      auditApi.events(tenantId, { actorUserId: userId, limit: 25 }),
      // What was done to their account, which is the security trail rather than the audit one:
      // `subjectUserId` is a filter there and nowhere else.
      auditApi.securityEvents(tenantId, { subjectUserId: userId, limit: 25 }),
    ])
      .then(([did, happened]) => {
        if (!current) return;
        const rows: ActivityRow[] = [
          ...did.rows.map((row) => ({
            id: row.id,
            action: row.action,
            summary: row.summary,
            occurredAt: row.occurredAt,
            kind: 'did' as const,
          })),
          ...happened.rows.map((row) => ({
            id: row.id,
            action: row.action,
            // A security event explains itself in `reason`; an audit event in `summary`.
            summary: row.reason,
            occurredAt: row.occurredAt,
            kind: 'happened' as const,
          })),
        ];
        rows.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
        setActivity(rows.slice(0, 40));
      })
      .catch((caught: unknown) => {
        if (!current) return;
        setActivityNote(
          caught instanceof ApiError && caught.statusCode === 403
            ? 'Not shown — reading the audit trail needs the Audit permission.'
            : 'Could not load their activity.',
        );
      });

    return () => {
      current = false;
    };
  }, [activity, tab, tenantId, userId]);

  /**
   * Save the edit.
   *
   * Two calls, because the company treats them as two acts: the employment record is a
   * correction, and moving somebody to a different manager is a change to the shape of the
   * company that carries its own reason and its own audit entry. Sent only when it actually
   * changed, so an untouched edit does not write a reporting change nobody made.
   */
  /**
   * What is wrong with the edit, in the words the panel shows.
   *
   * The same three fields the server requires. Kept shallow on purpose: an address is proven by
   * sending to it and a number by calling it, and neither happens here — so this refuses the
   * blank and the obviously-not-one, and nothing else.
   */
  const editProblems: string[] = [];
  if (draft !== null) {
    if (draft.displayName.trim().length < 2) editProblems.push('A name is required.');
    if (draft.employeeId.trim() === '') editProblems.push('An employee ID is required.');
    if (draft.designation.trim() === '') editProblems.push('A designation is required.');
    if (!draft.workEmail.includes('@')) editProblems.push('A work email is required.');
    if (draft.workPhone.replace(/[^0-9]/g, '').length < 7) {
      editProblems.push('A work phone is required.');
    }
  }

  const saveEdit = useCallback(async () => {
    if (tenantId === null || userId === null || draft === null || profile === null) return;
    setBusy(true);
    setError(null);
    try {
      await organizationApi.updateEmployee(tenantId, userId, {
        displayName: draft.displayName.trim(),
        employeeId: draft.employeeId.trim(),
        designation: draft.designation.trim(),
        workEmail: draft.workEmail.trim(),
        workPhone: draft.workPhone.trim(),
      });

      if (draft.reportingManagerUserId !== (profile.reportingManagerUserId ?? '')) {
        await organizationApi.changeReportingManager(tenantId, userId, {
          newManagerUserId:
            draft.reportingManagerUserId === '' ? null : draft.reportingManagerUserId,
          reason: 'Corrected from the employee panel.',
        });
      }

      setDraft(null);
      setProfile(await organizationApi.employee(tenantId, userId));
      // The chart shows designation and reporting lines, so it has to be told.
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That change could not be saved.');
    } finally {
      setBusy(false);
    }
  }, [draft, onChanged, profile, tenantId, userId]);

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
        noticeDays: Number(noticeDays) || 0,
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
  }, [noticeDays, onChanged, onClose, reason, successor, tenantId, userId]);

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

            {/*
              How long they keep working, asked after who takes over.

              That order matters: naming the successor is the decision, and the notice period is
              how long the two of them have to hand over. Zero is offered rather than hidden —
              a dismissal needs the access gone today, and pretending otherwise would make
              somebody type it into the reason field instead.
            */}
            <FormField
              label="Notice period (days)"
              hint={
                Number(noticeDays) > 0
                  ? `They keep working and keep their access until ${new Date(
                      Date.now() + Number(noticeDays) * 24 * 60 * 60 * 1000,
                    ).toDateString()}. The successor takes the reporting line today.`
                  : 'Zero ends the employment and their access today.'
              }
            >
              {(field) => (
                <input
                  {...field}
                  className="uboss-input"
                  inputMode="numeric"
                  value={noticeDays}
                  onChange={(event) =>
                    setNoticeDays(event.target.value.replace(/[^0-9]/g, '').slice(0, 3))
                  }
                  data-testid="notice-days"
                />
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
                { id: 'performance', label: 'Performance' },
                { id: 'activity', label: 'Activity' },
              ]}
            />

            {tab === 'overview' ? (
              profile === null ? (
                <SkeletonText lines={5} />
              ) : draft !== null ? (
                /*
                 * The edit, in the panel, over the record it is changing.
                 *
                 * Replacing the list rather than sitting beside it: two copies of the same six
                 * fields, one of them stale, is the state somebody saves the wrong version from.
                 *
                 * Department is not here. Moving somebody between departments is a transfer with
                 * its own consequences, and deliberately a different act from fixing a spelling.
                 *
                 * The name is here, and it is the one field that is not employment: it belongs to
                 * the person rather than the job, so correcting it corrects it everywhere they
                 * work. The alternative — a per-company name — would mean the same human under
                 * two spellings with no way to tell which is right.
                 */
                <div className="uboss-emp-edit" data-testid="employee-edit">
                  <label className="uboss-field">
                    <span className="uboss-field-label">Name *</span>
                    <input
                      className="uboss-input"
                      value={draft.displayName}
                      onChange={(event) =>
                        setDraft({ ...draft, displayName: event.target.value })
                      }
                      data-testid="edit-name"
                    />
                    <span className="uboss-field-note">
                      A person has one name across every company they work in, so correcting it
                      here corrects it everywhere. Their UBoss ID and history stay with them.
                    </span>
                  </label>

                  <label className="uboss-field">
                    <span className="uboss-field-label">Employee ID *</span>
                    <input
                      className="uboss-input"
                      value={draft.employeeId}
                      onChange={(event) =>
                        setDraft({ ...draft, employeeId: event.target.value })
                      }
                    />
                  </label>

                  <label className="uboss-field">
                    <span className="uboss-field-label">Designation *</span>
                    <input
                      className="uboss-input"
                      value={draft.designation}
                      onChange={(event) =>
                        setDraft({ ...draft, designation: event.target.value })
                      }
                    />
                  </label>

                  <label className="uboss-field">
                    <span className="uboss-field-label">Work email *</span>
                    <input
                      className="uboss-input"
                      type="email"
                      value={draft.workEmail}
                      onChange={(event) => setDraft({ ...draft, workEmail: event.target.value })}
                    />
                  </label>

                  <label className="uboss-field">
                    <span className="uboss-field-label">Work phone *</span>
                    <input
                      className="uboss-input"
                      value={draft.workPhone}
                      onChange={(event) => setDraft({ ...draft, workPhone: event.target.value })}
                    />
                  </label>

                  <label className="uboss-field">
                    <span className="uboss-field-label">Reporting manager *</span>
                    <select
                      className="uboss-input"
                      value={draft.reportingManagerUserId}
                      onChange={(event) =>
                        setDraft({ ...draft, reportingManagerUserId: event.target.value })
                      }
                    >
                      {/*
                        Empty is allowed, and it is not "no answer" — it is the top of the
                        company. The server refuses it for anybody who is not.
                      */}
                      <option value="">Nobody — top of the company</option>
                      {candidates.map((person) => (
                        <option key={person.userId} value={person.userId}>
                          {person.displayName} — {person.designation}
                        </option>
                      ))}
                    </select>
                  </label>

                  {/*
                    The same three the server requires. Checked here so the button says why it is
                    disabled rather than the person finding out after pressing it — the server
                    checks again regardless, which is what makes it a rule.
                  */}
                  {editProblems.length > 0 ? (
                    <Banner tone="warn">{editProblems.join(' ')}</Banner>
                  ) : null}

                  <div className="uboss-row-actions">
                    <Button
                      variant="primary"
                      onClick={() => void saveEdit()}
                      disabled={busy || editProblems.length > 0}
                      data-testid="save-employee"
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </Button>
                    <Button onClick={() => setDraft(null)} disabled={busy}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <dl className="uboss-kv">
                    <dt>Employee ID</dt>
                    <dd className="uboss-mono">{profile.employeeId}</dd>
                    <dt>UBoss ID</dt>
                    <dd className="uboss-mono">{profile.ubossUniqueId}</dd>
                    <dt>Designation</dt>
                    <dd>{profile.designation}</dd>
                    <dt>Department</dt>
                    <dd>{profile.departmentName}</dd>
                    <dt>Reports to</dt>
                    <dd>{profile.reportingManagerName ?? '—'}</dd>
                    {/*
                      How to reach them, on the first tab rather than behind one.

                      Required since CR-04, and the reason they are required is that this is what
                      somebody handing work over actually needs.
                    */}
                    <dt>Work email</dt>
                    <dd>{profile.workEmail ?? '—'}</dd>
                    <dt>Work phone</dt>
                    <dd>{profile.workPhone ?? '—'}</dd>
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
                    {/*
                      Edited here, not on another screen.

                      Opening a page to change a designation loses the chart, the drawer and the
                      place in it — and the person doing it came from the chart precisely because
                      that is what they were looking at.
                    */}
                    {/*
                      Still here, and deliberately.

                      Performance moved into this panel because it was a button pretending to be
                      a tab. The full profile is a different thing: it holds Achievements and
                      Access / Activity, which this panel does not, so taking the link away took
                      away the only route to them.
                    */}
                    <Button onClick={() => router.push(`/hierarchy/${userId}`)}>
                      Open full profile
                    </Button>
                    {mayAdminister && profile.employmentState === 'Active' ? (
                      <Button
                        onClick={() =>
                          setDraft({
                            displayName: profile.displayName,
                            employeeId: profile.employeeId,
                            designation: profile.designation,
                            workEmail: profile.workEmail ?? '',
                            workPhone: profile.workPhone ?? '',
                            reportingManagerUserId: profile.reportingManagerUserId ?? '',
                          })
                        }
                        disabled={busy}
                        data-testid="edit-employee"
                      >
                        <Icon name="build" size={16} />
                        Edit
                      </Button>
                    ) : null}
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

            {/*
              Their performance, here.

              It used to be a button that opened the Performance screen, and the Performance
              screen shows whoever the URL names inside a shell headed by the signed-in person —
              so an administrator checking somebody else's record read their own name at the top
              and reasonably concluded they were looking at themselves. Shown in place, there is
              nobody else's name on screen to confuse it with.
            */}
            {tab === 'performance' ? (
              performance === null ? (
                <p className="uboss-muted-3">{performanceNote ?? 'Loading…'}</p>
              ) : (
                <>
                  <div className="uboss-emp-score">
                    <div>
                      <div className="uboss-emp-score-value">{performance.score}</div>
                      <div className="uboss-muted-3">Score</div>
                    </div>
                    <div>
                      <StatusBadge status={performance.level} tone="blue" />
                      <div className="uboss-muted-3">
                        {performance.nextLevel === null
                          ? 'The top level'
                          : `${performance.nextLevel.pointsAway} to ${performance.nextLevel.level}`}
                      </div>
                    </div>
                    <div>
                      <div className="uboss-emp-score-value">
                        {/*
                          Null is not zero. Nothing completed yet means there is no percentage to
                          state, and printing 0% would report somebody as never on time when they
                          have simply not finished anything.
                        */}
                        {performance.onTimePercent === null ? '—' : `${performance.onTimePercent}%`}
                      </div>
                      <div className="uboss-muted-3">On time</div>
                    </div>
                  </div>

                  {performance.recentEvents.length === 0 ? (
                    <p className="uboss-muted-3">Nothing has been recorded for them yet.</p>
                  ) : (
                    <DataTable
                      caption="What their score is made of"
                      columns={[
                        {
                          key: 'kind',
                          header: 'Event',
                          render: (row: { kind: string }) => row.kind,
                        },
                        {
                          key: 'points',
                          header: 'Points',
                          render: (row: { points: number }) => String(row.points),
                        },
                        {
                          key: 'at',
                          header: 'When',
                          render: (row: { occurredAt: string }) =>
                            new Date(row.occurredAt).toLocaleDateString(),
                        },
                      ]}
                      rows={performance.recentEvents}
                      rowKey={(row) => `${row.sourceKind}:${row.sourceId}:${row.occurredAt}`}
                    />
                  )}

                  <p className="uboss-muted-3">{performance.note}</p>
                </>
              )
            ) : null}

            {/*
              What they have done, and what has been done to them.

              Straight from the audit trail, which is the only honest source for it — a second
              activity log written alongside would eventually disagree with the one the company
              is accountable for. Loaded when the tab is opened rather than with the panel,
              because an audit query is heavier than everything else here.
            */}
            {tab === 'activity' ? (
              activity === null ? (
                activityNote === null ? (
                  <SkeletonText lines={4} />
                ) : (
                  <p className="uboss-muted-3">{activityNote}</p>
                )
              ) : activity.length === 0 ? (
                <p className="uboss-muted-3">Nothing has been recorded about them yet.</p>
              ) : (
                <DataTable
                  caption="What this person did, and what was done to their account"
                  columns={[
                    {
                      key: 'when',
                      header: 'When',
                      render: (row: ActivityRow) =>
                        new Date(row.occurredAt).toLocaleString(),
                    },
                    {
                      key: 'what',
                      header: 'What',
                      render: (row: ActivityRow) => (
                        <>
                          <b>{row.action}</b>
                          {row.summary === null ? null : (
                            <>
                              <br />
                              <small className="uboss-muted-3">{row.summary}</small>
                            </>
                          )}
                        </>
                      ),
                    },
                    {
                      key: 'kind',
                      header: '',
                      // Which half of the story this line is. Without it, a password reset and a
                      // report they ran read as the same kind of event.
                      render: (row: ActivityRow) => (
                        <span className="uboss-muted-3">
                          {row.kind === 'did' ? 'they did this' : 'done to their account'}
                        </span>
                      ),
                    },
                  ]}
                  rows={activity}
                  rowKey={(row) => row.id}
                />
              )
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
