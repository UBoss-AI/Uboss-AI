'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  FormField,
  MedalBadge,
  Modal,
  PageHeader,
  SkeletonText,
  StatusBadge,
  Tabs,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  organizationApi,
  performanceApi,
  type EmployeeProfile,
  type HierarchyView,
  type MeResponse,
  type PerformanceView,
} from '../../../lib/api-client';

import { useNotificationBell } from '../../../lib/use-notification-bell';
import { EmployeePhoto } from '../../../components/EmployeePhoto';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';
import { can, useMyAccess } from '../../../lib/use-my-access';

function accountTone(state: string | null): StatusTone {
  switch (state) {
    case 'Active':
      return 'success';
    case 'InvitePending':
      return 'blue';
    case 'Suspended':
      return 'warn';
    default:
      return 'grey';
  }
}

/**
 * One person's employment and UBoss identity, as this company may see it.
 *
 * ## Matched to the reference's `SCR.employee`
 *
 * The left card carries the reference's key-value rows in its order: Department, Reporting
 * Manager, Company Employee ID, **UBoss Unique ID** (mono, blue, with a copy action), Aadhaar
 * (masked) and Status, then the identity notice. The right card carries the pill tabs and the
 * employment record.
 *
 * ## The performance panels, and the one tab still to come
 *
 * The reference's two mini cards — current performance and on-time delivery — now carry **real
 * numbers**, derived by the performance engine from that person's own event ledger. The
 * Performance and Achievements pills navigate to the performance screen and its badge history,
 * which is where the reference puts them (`data-nav="app/performance"`), rather than duplicating
 * either inside this card.
 *
 * `Access / Activity` is still marked as not built. The reference's on-time figure is labelled
 * "last 90 days"; ours is labelled for what it actually covers, because the engine scores the
 * whole employment and repeating the prototype's label would be a false claim about the number.
 *
 * ## The identity claims this screen makes, and the ones it refuses to
 *
 * The Company Employee ID and the UBoss Unique ID are shown as separate things, because they
 * are. The Aadhaar row shows four digits and the word **masked**, and the notice states it was
 * entered for matching only and is **not verified** — there is no state in the system that could
 * say otherwise. A viewer without `hierarchy:Administer` does not get the row at all.
 */
export default function EmployeeProfilePage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const router = useRouter();
  const params = useParams<{ userId: string }>();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [hierarchy, setHierarchy] = useState<HierarchyView | null>(null);
  const [performance, setPerformance] = useState<PerformanceView | null>(null);
  /** Why the performance panels are empty, when they are. A refusal is not a blank figure. */
  const [performanceNote, setPerformanceNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Move / Change Manager — the fourth node action the client's list requires.
  const [moveOpen, setMoveOpen] = useState(false);
  const [newManagerId, setNewManagerId] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [moving, setMoving] = useState(false);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const bell = useNotificationBell(tenantId);
  const userId = params.userId;
  const access = useMyAccess();
  // Your own photo is yours — the rule the photo service applies, asked here the same way.
  const isSelf = access?.userId === userId;

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your workspaces.'),
      );
  }, []);

  const load = useCallback(() => {
    if (!tenantId) {
      return;
    }
    // The hierarchy comes too, because Move / Change Manager needs the list of people who could
    // be a manager — and because `mayAdminister` decides whether that control appears at all.
    void Promise.all([
      organizationApi.employee(tenantId, userId),
      organizationApi.hierarchy(tenantId),
    ])
      .then(([employee, view]) => {
        setProfile(employee);
        setHierarchy(view);
        setNewManagerId(employee.reportingManagerUserId ?? '');
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load that person.'),
      );

    /*
     * Performance is fetched **separately and tolerantly.** Reading somebody's profile and
     * reading their performance are different permissions — a colleague may see the hierarchy
     * and not a person's score — so a refusal here must not empty the whole screen. The panel
     * says why instead, which is the difference between a permission boundary and a bug.
     */
    setPerformance(null);
    setPerformanceNote(null);
    performanceApi
      .forUser(tenantId, userId)
      .then(setPerformance)
      .catch((caught: unknown) =>
        setPerformanceNote(
          caught instanceof ApiError && caught.statusCode === 403
            ? 'Not shown — you do not have access to this person’s performance record.'
            : 'Could not load their performance record.',
        ),
      );
  }, [tenantId, userId]);

  useEffect(load, [load]);

  const changeManager = useCallback(() => {
    if (!tenantId) {
      return;
    }
    setMoving(true);
    setError(null);

    organizationApi
      .changeReportingManager(tenantId, userId, {
        newManagerUserId: newManagerId === '' ? null : newManagerId,
        ...(moveReason.trim() === '' ? {} : { reason: moveReason.trim() }),
      })
      .then(() => {
        setNotice(
          newManagerId === ''
            ? 'Detached from their reporting manager. They are now a root of their department.'
            : 'Reporting manager changed.',
        );
        setMoveOpen(false);
        setMoveReason('');
        load();
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not change the reporting manager.',
        ),
      )
      .finally(() => setMoving(false));
  }, [load, moveReason, newManagerId, tenantId, userId]);

  /**
   * Everybody who could be this person's manager.
   *
   * Excludes the person themselves. It deliberately does **not** exclude their own subordinates:
   * the server refuses that with an explanation naming the loop, which teaches the rule, whereas
   * silently omitting them from the list would leave the administrator wondering where somebody
   * went.
   */
  const managerOptions = (hierarchy?.list ?? [])
    .filter((row) => row.employmentState === 'Active' && row.userId !== userId)
    .map((row) => ({ value: row.userId, label: `${row.displayName} — ${row.designation}` }));

  const mayAdminister = hierarchy?.mayAdminister ?? false;

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="hierarchy"
      onNavigate={() => undefined}
      {...bell.shellProps}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Hierarchy' }}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title={profile?.displayName ?? 'Employee'}
        description="Employment identity, UBoss identity and permitted work information."
        breadcrumbs={[
          { label: 'Hierarchy', onSelect: () => router.push('/hierarchy') },
          { label: 'Profile' },
        ]}
        actions={
          <>
            <Button variant="navy" icon="back" onClick={() => router.push('/hierarchy')}>
              Back to Hierarchy
            </Button>
            {/*
              Move / Change Manager — the fourth of the client's four node actions. It lives here
              rather than on the node itself because it needs a target and a reason, and the node's
              Edit action is what navigates to this screen.
            */}
            {mayAdminister ? (
              <Button icon="tree" onClick={() => setMoveOpen(true)}>
                Change reporting manager
              </Button>
            ) : null}
          </>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      {!profile ? (
        <Card>
          <CardBody>
            <SkeletonText lines={6} />
          </CardBody>
        </Card>
      ) : (
        <div className="uboss-grid" style={{ gridTemplateColumns: '340px 1fr' }}>
          <Card>
            <CardBody>
              {/*
                Prompt 40A (CR-03) §3 — the optional photo.

                Editable when it is your own, or when you hold `users:EditDraft`, which is the rule
                the photo routes enforce. Asked of `/my-access` rather than inferred from a role
                label, and leaning shut while the answer is unknown: a Remove button that appears a
                moment late is better than one that appears and then fails.

                The six mandatory Add Employee fields are untouched. A photo is set here, after a
                person exists.
              */}
              <div className="employee-photo-row">
                <EmployeePhoto
                  tenantId={tenantId ?? ""}
                  userId={userId}
                  displayName={profile.displayName}
                  size="lg"
                  editable={isSelf || can(access, "users", "EditDraft")}
                  onChanged={() => void load()}
                />
                <div>
                  <h3 style={{ fontSize: 17, margin: 0 }}>{profile.displayName}</h3>
                  <div className="uboss-muted" style={{ fontSize: 12.5 }}>
                    {profile.designation}
                  </div>
                </div>
              </div>

              <div className="uboss-kv" style={{ marginTop: 14 }}>
                <span className="uboss-kv-key">Department</span>
                <span className="uboss-kv-value">{profile.departmentName}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Reporting Manager</span>
                <span className="uboss-kv-value">{profile.reportingManagerName ?? '—'}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Company Employee ID</span>
                <span className="uboss-kv-value uboss-mono">{profile.employeeId}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">UBoss Unique ID</span>
                <span className="uboss-kv-value uboss-mono" style={{ color: 'var(--uboss-blue)' }}>
                  {profile.ubossUniqueId}{' '}
                  <button
                    type="button"
                    className="uboss-btn uboss-btn--ghost uboss-btn--sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(profile.ubossUniqueId).then(
                        () => setCopied(true),
                        () => setCopied(false),
                      );
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </span>
              </div>

              {/*
                Present only when the server sent it. A viewer without `hierarchy:Administer`
                gets no row at all rather than a blank one — a blank would read as "this person
                has no identifier on record", which is a different and false statement.
              */}
              {profile.identifierVisible ? (
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Aadhaar (masked)</span>
                  <span className="uboss-kv-value uboss-mono">
                    {profile.aadhaarMasked ?? 'Not recorded'}
                  </span>
                </div>
              ) : null}

              <div className="uboss-kv">
                <span className="uboss-kv-key">Status</span>
                <span className="uboss-kv-value">
                  <StatusBadge
                    status={profile.accountState ?? 'Not invited'}
                    tone={accountTone(profile.accountState)}
                  />
                </span>
              </div>

              <p className="uboss-notice">{profile.identityNote}</p>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <Tabs
                label="Profile sections"
                items={[
                  { id: 'employment', label: 'Employment' },
                  { id: 'performance', label: 'Performance' },
                  { id: 'achievements', label: 'Achievements' },
                  { id: 'access', label: 'Access / Activity' },
                ]}
                activeId="employment"
                onChange={(id) => {
                  // Performance and Achievements are their own screens in the approved
                  // reference, reached from this pill — not panels inside this card.
                  if (id === 'performance') {
                    router.push(`/performance?userId=${encodeURIComponent(userId)}`);
                  }
                  if (id === 'achievements') {
                    router.push(`/performance/badges?userId=${encodeURIComponent(userId)}`);
                  }
                }}
              />

              {/*
                The reference's two mini cards. Real numbers now that the performance engine
                exists — and where the viewer may not read this person's performance, the panel
                says so rather than showing a blank figure that would read as a score of nothing.
              */}
              <div className="uboss-row-2">
                <Card>
                  <CardBody>
                    <div className="uboss-muted-3" style={{ fontSize: 12 }}>
                      Current performance
                    </div>
                    {performance === null ? (
                      <p className="uboss-muted-3">{performanceNote ?? 'Loading…'}</p>
                    ) : (
                      <>
                        <div style={{ fontSize: 30, fontWeight: 800 }}>{performance.score}</div>
                        <MedalBadge tier={performance.level} />
                      </>
                    )}
                  </CardBody>
                </Card>
                <Card>
                  <CardBody>
                    <div className="uboss-muted-3" style={{ fontSize: 12 }}>
                      On-time delivery
                    </div>
                    {performance === null ? (
                      <p className="uboss-muted-3">{performanceNote ?? 'Loading…'}</p>
                    ) : performance.onTimePercent === null ? (
                      <p className="uboss-muted-3">Nothing completed yet</p>
                    ) : (
                      <>
                        <div style={{ fontSize: 30, fontWeight: 800 }}>
                          {performance.onTimePercent}%
                        </div>
                        {/*
                          The reference says "last 90 days". The engine scores the whole
                          employment, and labelling an all-time figure as ninety days would be a
                          false claim about what the number covers.
                        */}
                        <div className="uboss-muted" style={{ fontSize: 12 }}>
                          across all recorded work
                        </div>
                      </>
                    )}
                  </CardBody>
                </Card>
              </div>

              <div className="uboss-section-label">
                Employment record — {activeWorkspace?.tenantName ?? 'this company'}
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Email</span>
                <span className="uboss-kv-value">{profile.workEmail ?? '—'}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Phone</span>
                <span className="uboss-kv-value">{profile.workPhone ?? '—'}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Joined</span>
                <span className="uboss-kv-value">
                  {profile.joinedOn ? new Date(profile.joinedOn).toLocaleDateString() : '—'}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Employment type</span>
                <span className="uboss-kv-value">{profile.employmentType ?? '—'}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Employment state</span>
                <span className="uboss-kv-value">{profile.employmentState}</span>
              </div>

              <Banner tone="info">
                This UBoss ID is portable across companies. A previous employer&apos;s confidential
                work is never exposed to another, and the entered identifier is never the lookup key
                — authorized cross-company search uses the UBoss Unique ID.
              </Banner>

              <div className="uboss-section-label">Not built yet</div>
              <ul className="uboss-muted-3">
                <li>
                  <b>Access / Activity</b> — arrives with Users &amp; Access, where account
                  lifecycle is managed.
                </li>
              </ul>
            </CardBody>
          </Card>
        </div>
      )}

      <Modal
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        title={`Change reporting manager — ${profile?.displayName ?? ''}`}
        footer={
          <>
            <Button onClick={() => setMoveOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={changeManager} disabled={moving}>
              {moving ? 'Moving…' : 'Apply the change'}
            </Button>
          </>
        }
      >
        <FormField
          label="New reporting manager"
          hint="Leave blank to detach them, making them a root of their department."
        >
          {(wiring) => (
            <select
              {...wiring}
              className="uboss-input"
              value={newManagerId}
              onChange={(event) => setNewManagerId(event.target.value)}
            >
              <option value="">No manager (top of their department)</option>
              {managerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </FormField>

        <FormField label="Why" hint="Recorded in this company's audit trail with the change.">
          {(wiring) => (
            <textarea
              {...wiring}
              className="uboss-input"
              rows={2}
              value={moveReason}
              onChange={(event) => setMoveReason(event.target.value)}
              placeholder="e.g. Interim reporting while the head is on leave"
            />
          )}
        </FormField>

        <p className="uboss-notice">
          A reporting line cannot be circular. If the person you choose already reports to this
          person — directly or through anybody else — the change is refused and the reason names the
          loop. Moving somebody changes what a team-scoped manager can reach, so the change is
          audited.
        </p>
      </Modal>
    </AppShell>
  );
}
