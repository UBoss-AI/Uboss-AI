'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  Modal,
  PageHeader,
  SearchField,
  SegmentedControl,
  SkeletonText,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  accessApi,
  ApiError,
  authApi,
  type AccessPerson,
  type AccessView,
  type BulkPreview,
  type MeResponse,
} from '../../../lib/api-client';

import { useNotificationBell } from '../../../lib/use-notification-bell';
import { AccessPermissionsStep } from '../../../components/AccessPermissionsStep';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';
import { can, useMyAccess } from '../../../lib/use-my-access';

function activationTone(person: AccessPerson): StatusTone {
  if (person.accountState === 'Active') {
    return 'success';
  }
  if (person.accountState === 'Suspended') {
    return 'warn';
  }
  if (person.accountState === 'Offboarded') {
    return 'grey';
  }
  return person.invitation ? 'blue' : 'grey';
}

function activationLabel(person: AccessPerson): string {
  if (person.accountState === 'InvitePending') {
    return person.invitation?.expired ? 'Invitation expired' : 'Invited';
  }
  if (person.accountState === 'NotInvited') {
    return 'Not invited';
  }
  return person.accountState;
}

type Tab = 'employees' | 'guests' | 'pendingInvitations';

/**
 * Settings → Users & Access — activation, account lifecycle and bulk administration.
 *
 * ## Matched to the reference
 *
 * | Reference                    | Here                                                     |
 * | ---------------------------- | -------------------------------------------------------- |
 * | `.seg` Employees/Guests/Pending | `<SegmentedControl>` with the server's own three splits |
 * | search                       | `<SearchField>` over name, email, Employee ID and UBoss ID |
 * | **Bulk import**              | validate-then-apply, with per-row errors                 |
 * | **Invite existing employee** | keyed on the person, never on an email — no duplicate    |
 * | table columns                | Identity, Role, Manager, Activation, Last access, action |
 * | the closing notice           | verbatim: lifecycle is managed here, separately from the hierarchy |
 *
 * **"Last access" is not shown**, and that is a deliberate divergence: session last-seen exists
 * per session, and rendering "Today 08:42" for everybody — as the prototype does — would be
 * inventing a figure. The column shows what the system actually knows: when the invitation was
 * sent, or nothing.
 *
 * ## Why the readiness reason is on the row
 *
 * The client's rule is that a new internal employee needs a department, a manager and a role
 * before activation. When one is missing, the row says which — because the administrator's next
 * question is always "why can I not invite this person", and making them guess is the difference
 * between a screen that helps and one that refuses.
 */
export default function UsersAccessPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const myAccess = useMyAccess();
  const mayManageAccess = can(myAccess, 'users', 'ManageAccess');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [view, setView] = useState<AccessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<Tab>('employees');
  const [search, setSearch] = useState('');

  // Prompt 40A (CR-03) §1 — whose Access & Permissions step is open.
  const [accessFor, setAccessFor] = useState<AccessPerson | null>(null);
  const [inviteFor, setInviteFor] = useState<AccessPerson | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');

  const [guestOpen, setGuestOpen] = useState(false);
  const [guest, setGuest] = useState({
    email: '',
    displayName: '',
    resourceIds: '',
    accessDays: '30',
    reason: '',
  });

  const [suspendFor, setSuspendFor] = useState<AccessPerson | null>(null);
  const [offboardFor, setOffboardFor] = useState<AccessPerson | null>(null);
  const [offboardImpact, setOffboardImpact] = useState<{
    directReports: number;
    roleAssignments: number;
    successorRequired: boolean;
    note: string;
  } | null>(null);
  const [successorId, setSuccessorId] = useState('');

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkKind, setBulkKind] = useState('ImportEmployees');
  const [bulkContent, setBulkContent] = useState('');
  const [bulkFileName, setBulkFileName] = useState('');
  const [preview, setPreview] = useState<BulkPreview | null>(null);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
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
    if (!tenantId) {
      return;
    }
    accessApi
      .view(tenantId)
      .then(setView)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load Users & Access.'),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  const run = useCallback(
    async (work: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      try {
        setNotice(await work());
        load();
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'That did not work.');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const rows = useMemo(() => {
    const list = view?.[tab] ?? [];
    const term = search.trim().toLowerCase();
    if (term === '') {
      return list;
    }
    return list.filter(
      (person) =>
        person.displayName.toLowerCase().includes(term) ||
        person.email.toLowerCase().includes(term) ||
        (person.employeeId ?? '').toLowerCase().includes(term) ||
        person.ubossUniqueId.toLowerCase().includes(term),
    );
  }, [search, tab, view]);

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);

  const openOffboard = useCallback(
    (person: AccessPerson) => {
      if (!tenantId) {
        return;
      }
      setOffboardFor(person);
      setSuccessorId('');
      setOffboardImpact(null);
      accessApi
        .offboardingImpact(tenantId, person.userId)
        .then(setOffboardImpact)
        .catch((caught: unknown) =>
          setError(
            caught instanceof ApiError ? caught.message : 'Could not assess that offboarding.',
          ),
        );
    },
    [tenantId],
  );

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="users"
      onNavigate={() => undefined}
      {...bell.shellProps}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Users & Access' }}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Users & Access"
        description="Activation and account lifecycle."
        breadcrumbs={[{ label: 'Settings' }, { label: 'Users & Access' }]}
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      {!view ? (
        <Card>
          <CardBody>
            <SkeletonText lines={6} />
          </CardBody>
        </Card>
      ) : (
        <>
          {view.seats.atCeiling ? (
            <Banner tone="warn">
              This company is at its contracted ceiling of {view.seats.ceiling} seat(s). Inviting
              another person will be refused rather than allowed and billed later — request more
              seats from Settings → Billing.
            </Banner>
          ) : null}

          <Card>
            <CardBody>
              <div className="uboss-actions" style={{ marginBottom: 14 }}>
                <SegmentedControl
                  label="Users & Access view"
                  value={tab}
                  onChange={(next) => setTab(next as Tab)}
                  options={[
                    { value: 'employees', label: `Employees (${view.counts.employees})` },
                    { value: 'guests', label: `Guests (${view.counts.guests})` },
                    {
                      value: 'pendingInvitations',
                      label: `Pending Invitations (${view.counts.pendingInvitations})`,
                    },
                  ]}
                />
                <SearchField
                  label="Search people"
                  placeholder="Search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Button icon="file" onClick={() => setBulkOpen(true)}>
                  Bulk import
                </Button>
                <Button variant="primary" icon="plus" onClick={() => setGuestOpen(true)}>
                  Invite guest
                </Button>
              </div>

              {rows.length === 0 ? (
                <EmptyState
                  title="Nobody here yet"
                  description={
                    tab === 'guests'
                      ? 'Guests are contractors and client contacts. They stay outside the hierarchy and their access has an end date.'
                      : tab === 'pendingInvitations'
                        ? 'Nobody is waiting to activate.'
                        : 'Add people from the Hierarchy screen, then invite them here.'
                  }
                />
              ) : (
                <DataTable
                  caption="Everybody with access to this company"
                  columns={[
                    {
                      key: 'identity',
                      header: 'Identity',
                      render: (person) => (
                        <div>
                          <b>{person.displayName}</b>
                          <br />
                          <small className="uboss-muted-3">
                            {person.email || 'No email address yet'}
                          </small>
                        </div>
                      ),
                    },
                    {
                      key: 'role',
                      header: 'Role',
                      render: (person) => (
                        <StatusBadge
                          status={
                            person.userType === 'ExternalGuest'
                              ? 'Guest'
                              : person.roleCount === 0
                                ? 'No role'
                                : `${person.roleCount} role${person.roleCount === 1 ? '' : 's'}`
                          }
                          tone={
                            person.userType === 'ExternalGuest'
                              ? 'purple'
                              : person.roleCount === 0
                                ? 'warn'
                                : 'grey'
                          }
                        />
                      ),
                    },
                    {
                      key: 'manager',
                      header: 'Manager',
                      render: (person) => person.reportingManagerName ?? '—',
                    },
                    {
                      key: 'activation',
                      header: 'Activation',
                      render: (person) => (
                        <div>
                          <StatusBadge
                            status={activationLabel(person)}
                            tone={activationTone(person)}
                          />
                          {person.readiness.ready ? null : (
                            <>
                              <br />
                              {/* Why they cannot be invited, on the row where the question arises. */}
                              <small className="uboss-muted-3">
                                Needs {person.readiness.missing.join(', ')}
                              </small>
                            </>
                          )}
                          {person.guestAccessExpiresAt ? (
                            <>
                              <br />
                              <small className="uboss-muted-3">
                                {person.guestExpired ? 'Access expired ' : 'Access until '}
                                {new Date(person.guestAccessExpiresAt).toLocaleDateString()}
                              </small>
                            </>
                          ) : null}
                        </div>
                      ),
                    },
                    {
                      key: 'invited',
                      header: 'Invitation',
                      render: (person) =>
                        person.invitation
                          ? new Date(person.invitation.sentAt).toLocaleDateString()
                          : '—',
                    },
                    {
                      key: 'actions',
                      header: '',
                      render: (person) => (
                        <span className="uboss-actions">
                          {/*
                            Prompt 40A (CR-03) §1 — Access & Permissions.

                            Shown only to somebody holding `users:ManageAccess`, because reading the
                            step is gated as tightly as writing it: the response describes the
                            caller's own authority. Asked of `/my-access` rather than a role label.
                          */}
                          {mayManageAccess && person.accountState !== 'Offboarded' ? (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setAccessFor(person)}
                              data-testid="open-access-step"
                            >
                              Access
                            </Button>
                          ) : null}

                          {person.accountState !== 'Active' &&
                          person.accountState !== 'Offboarded' &&
                          person.userType === 'InternalUser' ? (
                            <Button
                              variant="ghost"
                              disabled={busy || !person.readiness.ready}
                              onClick={() => {
                                setInviteFor(person);
                                setInviteEmail(person.email);
                              }}
                            >
                              {person.invitation ? 'Resend' : 'Invite'}
                            </Button>
                          ) : null}

                          {person.invitation ? (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await accessApi.cancelInvitation(
                                    tenantId as string,
                                    person.invitation!.id,
                                  );
                                  return 'Invitation cancelled. The link stops working immediately.';
                                })
                              }
                            >
                              Cancel
                            </Button>
                          ) : null}

                          {person.accountState === 'Active' ? (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setSuspendFor(person)}
                            >
                              Suspend
                            </Button>
                          ) : null}

                          {person.accountState === 'Suspended' ? (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await accessApi.reinstate(
                                    tenantId as string,
                                    person.userId,
                                    'Reinstated from Users & Access.',
                                  );
                                  return `${person.displayName} is active again.`;
                                })
                              }
                            >
                              Reinstate
                            </Button>
                          ) : null}

                          {person.accountState !== 'Offboarded' ? (
                            <Button
                              variant="danger"
                              disabled={busy}
                              onClick={() => openOffboard(person)}
                            >
                              Offboard
                            </Button>
                          ) : null}
                        </span>
                      ),
                    },
                  ]}
                  rows={rows}
                  rowKey={(person) => person.userId}
                />
              )}
            </CardBody>
          </Card>

          {/* The reference's closing notice, verbatim in substance. */}
          <p className="uboss-notice">
            Account lifecycle (invite, suspend, offboard, transfer ownership) is managed here —
            separately from the hierarchy. Permissions are backend-enforced. Suspending and
            offboarding <b>delete nothing</b>: the membership, the employment record and every audit
            event are kept.
          </p>

          <div className="uboss-kv">
            <span className="uboss-kv-key">Seats in use</span>
            <span className="uboss-kv-value">
              {view.seats.used}
              {view.seats.ceiling === null ? '' : ` / ${view.seats.ceiling}`}
              {view.seats.available === null ? '' : ` · ${view.seats.available} available`}
            </span>
          </div>
        </>
      )}

      {/* ---- Access & Permissions — Prompt 40A (CR-03) §1 ---- */}
      <Modal
        open={accessFor !== null}
        onClose={() => setAccessFor(null)}
        title={`Access & Permissions — ${accessFor?.displayName ?? ''}`}
        footer={<Button onClick={() => setAccessFor(null)}>Done</Button>}
      >
        {accessFor !== null && tenantId !== null ? (
          <AccessPermissionsStep
            tenantId={tenantId}
            userId={accessFor.userId}
            subjectLabel={accessFor.displayName}
            onChanged={() => void load()}
          />
        ) : null}
      </Modal>

      {/* ---- Invite an existing person ---- */}
      <Modal
        open={inviteFor !== null}
        onClose={() => setInviteFor(null)}
        title={`Invite ${inviteFor?.displayName ?? ''}`}
        footer={
          <>
            <Button onClick={() => setInviteFor(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || inviteEmail.trim() === ''}
              onClick={() =>
                void run(async () => {
                  const result = await accessApi.inviteExisting(tenantId as string, {
                    subjectUserId: inviteFor!.userId,
                    workEmail: inviteEmail.trim(),
                  });
                  setInviteFor(null);
                  return `Invitation ${result.resent ? 'resent' : 'sent'}. ${result.seats.used}${
                    result.seats.ceiling === null ? '' : ` of ${result.seats.ceiling}`
                  } seats now in use.`;
                })
              }
            >
              Send invitation
            </Button>
          </>
        }
      >
        <FormField
          label="Work email address"
          required
          hint="This becomes their sign-in address. It is set on their permanent UBoss identity."
        >
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="name@company.com"
            />
          )}
        </FormField>

        <p className="uboss-notice">
          This links to their <b>existing</b> UBoss identity — {inviteFor?.ubossUniqueId} — rather
          than creating a second one. Inviting consumes a seat, and no password is ever created or
          emailed: they set their own from the activation link.
        </p>

        {/*
          Prompt 40A (CR-03) §1 — Access & Permissions, in the Invite flow.

          Below the email rather than after it, because the two are independent: the invitation
          creates the sign-in and the capabilities decide what they can do once they have one.
          Saved immediately on toggle rather than on Send, so an administrator who closes this
          without inviting has still set the access they meant to — and so the step behaves
          identically here and on the Access button, which is the same component.
        */}
        {mayManageAccess && inviteFor !== null && tenantId !== null ? (
          <AccessPermissionsStep
            tenantId={tenantId}
            userId={inviteFor.userId}
            subjectLabel={inviteFor.displayName}
            onChanged={() => void load()}
          />
        ) : null}
      </Modal>

      {/* ---- Invite a guest ---- */}
      <Modal
        open={guestOpen}
        onClose={() => setGuestOpen(false)}
        title="Invite a guest"
        footer={
          <>
            <Button onClick={() => setGuestOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                guest.email.trim() === '' ||
                guest.displayName.trim() === '' ||
                guest.resourceIds.trim() === '' ||
                guest.reason.trim().length < 5
              }
              onClick={() =>
                void run(async () => {
                  const result = await accessApi.inviteGuest(tenantId as string, {
                    email: guest.email.trim(),
                    displayName: guest.displayName.trim(),
                    resourceIds: guest.resourceIds
                      .split(/[\s,]+/)
                      .map((id) => id.trim())
                      .filter(Boolean),
                    accessDays: Number(guest.accessDays),
                    reason: guest.reason.trim(),
                  });
                  setGuestOpen(false);
                  return `Guest invited. Access ends ${new Date(
                    result.expiresAt,
                  ).toLocaleDateString()}.`;
                })
              }
            >
              Invite guest
            </Button>
          </>
        }
      >
        <FormField label="Email address" required>
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={guest.email}
              onChange={(event) => setGuest({ ...guest, email: event.target.value })}
            />
          )}
        </FormField>
        <FormField label="Name" required>
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={guest.displayName}
              onChange={(event) => setGuest({ ...guest, displayName: event.target.value })}
            />
          )}
        </FormField>
        <FormField
          label="Resources they may reach"
          required
          hint="Identifiers, separated by commas. An empty list would mean company-wide access, which is not a scope anybody can review."
        >
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input uboss-mono"
              value={guest.resourceIds}
              onChange={(event) => setGuest({ ...guest, resourceIds: event.target.value })}
              placeholder="objective-1, objective-2"
            />
          )}
        </FormField>
        <FormField label="Access for (days)" required hint="Capped at 365 days.">
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input uboss-mono"
              inputMode="numeric"
              value={guest.accessDays}
              onChange={(event) => setGuest({ ...guest, accessDays: event.target.value })}
            />
          )}
        </FormField>
        <FormField label="Why they need access" required>
          {(wiring) => (
            <textarea
              {...wiring}
              className="uboss-input"
              rows={2}
              value={guest.reason}
              onChange={(event) => setGuest({ ...guest, reason: event.target.value })}
            />
          )}
        </FormField>

        <p className="uboss-notice">
          A guest stays <b>outside the hierarchy</b> — no department, no reporting manager, no
          employment record — and may only read, comment and produce draft work on the resources
          named above. They can never approve, publish, run or manage access, whatever role they are
          given. Their access ends automatically on the date above.
        </p>
      </Modal>

      {/* ---- Bulk ---- */}
      <Modal
        open={bulkOpen}
        onClose={() => {
          setBulkOpen(false);
          setPreview(null);
        }}
        title={preview ? 'Review before applying' : 'Bulk import'}
        wide
        footer={
          preview ? (
            <>
              <Button
                onClick={() =>
                  void run(async () => {
                    await accessApi.cancelBulk(tenantId as string, preview.operationId);
                    setPreview(null);
                    setBulkOpen(false);
                    return 'Cancelled. Nothing was applied, and the row outcomes are kept.';
                  })
                }
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || preview.validRows === 0}
                onClick={() =>
                  void run(async () => {
                    const result = await accessApi.applyBulk(
                      tenantId as string,
                      preview.operationId,
                    );
                    setPreview(null);
                    setBulkOpen(false);
                    return `Applied ${result.applied}, failed ${result.failed}, skipped ${result.skipped}.`;
                  })
                }
              >
                Apply {preview.validRows} valid row(s)
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setBulkOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={busy || bulkContent.trim() === ''}
                onClick={() =>
                  void run(async () => {
                    const result = await accessApi.validateBulk(tenantId as string, {
                      kind: bulkKind,
                      content: bulkContent,
                      ...(bulkFileName === '' ? {} : { sourceFileName: bulkFileName }),
                    });
                    setPreview(result);
                    return 'Validated. Nothing has been applied yet.';
                  })
                }
              >
                Validate
              </Button>
            </>
          )
        }
      >
        {preview ? (
          <>
            <Banner tone={preview.invalidRows === 0 ? 'ok' : 'warn'}>{preview.note}</Banner>

            <DataTable
              caption="Every row, with its own outcome"
              columns={[
                { key: 'row', header: 'Row', render: (row) => row.rowNumber },
                {
                  key: 'state',
                  header: 'Outcome',
                  render: (row) => (
                    <StatusBadge
                      status={row.state}
                      tone={row.state === 'Valid' ? 'success' : 'danger'}
                    />
                  ),
                },
                {
                  key: 'input',
                  header: 'Row',
                  render: (row) => (
                    <span className="uboss-mono" style={{ fontSize: 11 }}>
                      {Object.values(row.input as Record<string, string>)
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  ),
                },
                {
                  key: 'errors',
                  header: 'Problems',
                  render: (row) =>
                    row.errors.length === 0 ? (
                      '—'
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 16 }}>
                        {row.errors.map((problem) => (
                          <li key={problem}>{problem}</li>
                        ))}
                      </ul>
                    ),
                },
              ]}
              rows={preview.rows}
              rowKey={(row) => String(row.rowNumber)}
            />
          </>
        ) : (
          <>
            <FormField label="What are you doing?">
              {(wiring) => (
                <select
                  {...wiring}
                  className="uboss-input"
                  value={bulkKind}
                  onChange={(event) => setBulkKind(event.target.value)}
                >
                  <option value="ImportEmployees">Import employees</option>
                  <option value="InviteOrResend">Invite or resend</option>
                  <option value="ManagerOrDepartment">Move manager or department</option>
                  <option value="SuspendOrOffboard">Suspend or offboard</option>
                  <option value="RoleAndScope">Change role and scope</option>
                </select>
              )}
            </FormField>

            <FormField
              label="File"
              hint="A CSV file. Export an XLS to CSV first — the first row is the header."
            >
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) {
                      return;
                    }
                    setBulkFileName(file.name);
                    void file.text().then(setBulkContent);
                  }}
                />
              )}
            </FormField>

            <FormField
              label="Or paste the rows"
              hint="Header row first. Column names are matched loosely: Employee ID, employee_id and EmployeeID are all the same column."
            >
              {(wiring) => (
                <textarea
                  {...wiring}
                  className="uboss-input uboss-mono"
                  rows={6}
                  value={bulkContent}
                  onChange={(event) => setBulkContent(event.target.value)}
                  placeholder={
                    'Employee Name,Employee ID,Designation,Department,Reporting Manager,Aadhaar Number'
                  }
                />
              )}
            </FormField>

            <p className="uboss-notice">
              Validating <b>applies nothing</b>. You will see every row and its problems, and can
              then apply the valid ones. Each row is applied <b>as you</b>, with your permissions
              and against this company&apos;s seat ceiling — so a row asking for something you
              cannot grant fails on its own rather than taking the file with it.
            </p>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={suspendFor !== null}
        title={`Suspend ${suspendFor?.displayName ?? ''}`}
        description="They lose access immediately, including any session open right now. Nothing is deleted and it can be reversed."
        impact={[
          { label: 'Roles removed', value: 'None — they are kept' },
          { label: 'Employment record', value: 'Kept, unchanged' },
          { label: 'Reversible', value: 'Yes — Reinstate restores access' },
        ]}
        requireReason
        reasonLabel="Why is this account being suspended?"
        confirmLabel="Suspend"
        destructive
        onCancel={() => setSuspendFor(null)}
        onConfirm={(reason) => {
          const person = suspendFor;
          setSuspendFor(null);
          void run(async () => {
            await accessApi.suspend(tenantId as string, person!.userId, reason ?? '');
            return `${person!.displayName} is suspended. Nothing was deleted.`;
          });
        }}
      />

      <Modal
        open={offboardFor !== null}
        onClose={() => setOffboardFor(null)}
        title={`Offboard ${offboardFor?.displayName ?? ''}`}
        footer={
          <>
            <Button onClick={() => setOffboardFor(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={busy || (offboardImpact?.successorRequired === true && successorId === '')}
              onClick={() => {
                const person = offboardFor;
                setOffboardFor(null);
                void run(async () => {
                  const result = await accessApi.offboard(tenantId as string, person!.userId, {
                    ...(successorId === '' ? {} : { successorUserId: successorId }),
                    reason: 'Offboarded from Users & Access.',
                  });
                  return `${person!.displayName} was offboarded. ${
                    Object.values(result.handover).filter((entry) => entry.status === 'moved')
                      .length
                  } thing(s) handed over; nothing was deleted.`;
                });
              }}
            >
              Offboard
            </Button>
          </>
        }
      >
        {offboardImpact === null ? (
          <SkeletonText lines={3} />
        ) : (
          <>
            <Banner tone="warn">{offboardImpact.note}</Banner>

            <div className="uboss-kv">
              <span className="uboss-kv-key">Direct reports to move</span>
              <span className="uboss-kv-value">{offboardImpact.directReports}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Roles to revoke</span>
              <span className="uboss-kv-value">{offboardImpact.roleAssignments}</span>
            </div>

            {offboardImpact.successorRequired ? (
              <FormField
                label="Successor"
                required
                hint="Their direct reports move to this person. Roles are not transferred — copying them would silently widen the successor's authority."
              >
                {(wiring) => (
                  <select
                    {...wiring}
                    className="uboss-input"
                    value={successorId}
                    onChange={(event) => setSuccessorId(event.target.value)}
                  >
                    <option value="">Choose a successor…</option>
                    {(view?.employees ?? [])
                      .filter(
                        (person) =>
                          person.userId !== offboardFor?.userId &&
                          person.employmentState === 'Active',
                      )
                      .map((person) => (
                        <option key={person.userId} value={person.userId}>
                          {person.displayName} — {person.designation ?? 'no designation'}
                        </option>
                      ))}
                  </select>
                )}
              </FormField>
            ) : null}

            <p className="uboss-notice">
              Their UBoss Unique ID is <b>theirs, not the company&apos;s</b>, and follows them to
              their next employer. The membership, the employment record and every audit event are
              kept — the account state becomes Offboarded and the employment is marked Ended with a
              date. Any outstanding invitation is cancelled.
            </p>
          </>
        )}
      </Modal>
    </AppShell>
  );
}
