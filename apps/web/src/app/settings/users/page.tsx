'use client';

import { useSearchParams } from 'next/navigation';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { COMPANY_GRANTABLE_ROLES, ROLE_KIND_LABELS } from '@uboss/types';

import {
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
  RowMenu,
  type RowMenuItem,
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

import { useAccountMenu } from '../../../lib/use-account-menu';
import { useSignedInUser } from '../../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../../lib/active-workspace';
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
  // A refused activation email is the one state here somebody has to act on, so it is the one
  // that is not blue. Blue reads as "in progress", which is exactly what it is not.
  if (person.invitation?.mail.state === 'Failed') {
    return 'danger';
  }
  return person.invitation ? 'blue' : 'grey';
}

/**
 * The plain English for what somebody holds. `ROLE_KIND_LABELS` names them the same everywhere.
 *
 * Somebody with more than one used to read **"2 roles"**, which answers a question nobody asked.
 * The column is headed Role and exists so an administrator can see who can do what; a count tells
 * them only that they have to click to find out, on the one screen where the whole point is to see
 * it. Aman Singh holds Employee and Approver — two names, and they fit.
 *
 * Past three the names would out-run the column, so that is where a count belongs: the row still
 * leads with what they mostly are, and says how much else there is.
 */
function roleLabelFor(person: AccessPerson): string {
  if (person.userType === 'ExternalGuest') return 'Guest';
  if (person.roleKinds.length === 0) return 'No role';

  const named = person.roleKinds.map(
    (kind) => ROLE_KIND_LABELS[kind as keyof typeof ROLE_KIND_LABELS] ?? kind,
  );
  if (named.length <= 3) return named.join(' · ');
  return `${named.slice(0, 2).join(' · ')} +${named.length - 2} more`;
}

/**
 * What the roster says about somebody's activation — including whether the email actually went.
 *
 * "Invited" used to be the whole answer, and it was the same word whether the activation link had
 * been accepted by the mail provider or refused by it. An invitation commits before its mail is
 * attempted, so a provider failure left a perfectly valid invitation whose link nobody ever
 * received, and the only record was a log line inside the API container. It was reported as
 * "invitations are not arriving", and nothing on this screen could say otherwise.
 *
 * So a refused one now says so. "Invited" still means the provider took it, which is not proof it
 * reached an inbox — `invitationHint` says that in as many words rather than letting the badge
 * imply more than it knows.
 */
function activationLabel(person: AccessPerson): string {
  if (person.accountState === 'InvitePending') {
    if (person.invitation?.mail.state === 'Failed') return 'Email not sent';
    return person.invitation?.expired ? 'Invitation expired' : 'Invited';
  }
  if (person.accountState === 'NotInvited') {
    return 'Not invited';
  }
  return person.accountState;
}

/**
 * What still has to be done by hand before somebody can be invited.
 *
 * Readiness lists everything an account needs before it can activate, and a company role is one
 * of those things — but the invite form grants the role itself, as its first action, so the role
 * is not a reason to keep anybody out of that form. A department and a reporting manager are:
 * nothing in the invite flow supplies either.
 *
 * Shared by the row's hint and the Invite button so the two can never disagree, which is how a
 * greyed-out button ends up next to a sentence that no longer explains it.
 */
export function inviteBlockers(person: AccessPerson): string[] {
  return person.readiness.missing.filter((item) => item !== 'at least one company role');
}

/** The sentence under the badge: why it failed, or what "Invited" does and does not mean. */
function invitationHint(person: AccessPerson): string | null {
  const invitation = person.invitation;
  if (invitation === null || invitation === undefined) return null;
  if (invitation.mail.state === 'Failed') {
    return invitation.mail.error === null
      ? 'The activation email was refused and no reason was recorded. Press Resend.'
      : `The activation email was refused: ${invitation.mail.error}`;
  }
  if (invitation.mail.state === 'Sent') {
    return 'The activation email was accepted by the mail provider. That is not proof it reached their inbox.';
  }
  // Issued before the outcome was recorded. Saying nothing beats inventing a status.
  return null;
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
function UsersAccessInner() {
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
  /**
   * What this person will be, asked at the moment they are invited.
   *
   * Employee by default, because almost everybody is one and the alternative — an account that
   * arrives with no role — can sign in and reach nothing, which reads as the product being
   * broken rather than as a decision somebody forgot to make.
   *
   * Two choices, not a capability matrix. The matrix still exists below for the cases that need
   * it, but "is this person an administrator" is the question an administrator is actually
   * answering, and making them assemble the answer out of tiers and toggles is how the previous
   * version of this screen went wrong.
   */
  const [inviteAs, setInviteAs] = useState<'Employee' | 'CompanyAdmin'>('Employee');

  /*
   * Changing somebody's role after they are already in.
   *
   * The role was chosen once, in the invitation dialog, and there was no way to change it
   * afterwards from any screen. With two roles in the company model that left the most ordinary
   * administrative act in the product — promoting somebody to administrator, or standing one
   * down — with no route at all short of the platform console.
   */
  const [roleFor, setRoleFor] = useState<AccessPerson | null>(null);
  const [roleTo, setRoleTo] = useState<(typeof COMPANY_GRANTABLE_ROLES)[number]>('Employee');

  const [bulkKind, setBulkKind] = useState('ImportEmployees');
  const [bulkContent, setBulkContent] = useState('');
  const [bulkFileName, setBulkFileName] = useState('');
  const [preview, setPreview] = useState<BulkPreview | null>(null);

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const signedInUser = useSignedInUser(me);

  const accountMenu = useAccountMenu(me);
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

  /*
   * `?offboard=<userId>` opens this person's offboarding directly.
   *
   * The Hierarchy's employee cards offer "Offboard", and this is where that lands. The flow is not
   * duplicated over there: offboarding needs the impact assessment, a successor when the person has
   * direct reports, a reason, and `users:ManageAccess` — a second implementation of that would be
   * a second set of rules to keep in step, on the screen least likely to be kept in step.
   *
   * It fires once. `opened` is a ref rather than state so that reopening is impossible after the
   * person closes the dialog, without the effect having to depend on what it just did.
   */
  const requestedOffboard = useSearchParams().get('offboard');
  const offboardOpened = useRef(false);

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

  useEffect(() => {
    if (requestedOffboard === null || offboardOpened.current) return;
    const person = view?.employees.find((row) => row.userId === requestedOffboard);
    // Nothing until the list is here. A missing person once it is means a link to somebody this
    // viewer cannot see, and the screen says nothing rather than guessing.
    if (person === undefined) return;
    offboardOpened.current = true;
    openOffboard(person);
  }, [openOffboard, requestedOffboard, view]);

  return (
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      // This screen is reached through Settings -> Users & Access, and the sidebar no longer
      // carries a "users" item of its own, so Settings is the entry that should read as active.
      // Naming the removed key here would leave the whole sidebar unhighlighted.
      activeKey="settings"
      {...bell.shellProps}
      user={signedInUser}
      accountMenu={accountMenu}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Users & Access"
        description="Activation and account lifecycle."
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Users & Access' }]}
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
                {/*
                  Both write to company-wide access, so both are for somebody who holds
                  `users:ManageAccess`. They used to render for anybody who could open this screen,
                  which is anybody with `users:View` — a Manager could press Invite guest and get a
                  403 from a button that looked ready.
                */}
                {mayManageAccess ? (
                  <>
                    <Button icon="file" onClick={() => setBulkOpen(true)}>
                      Bulk import
                    </Button>
                    <Button variant="primary" icon="plus" onClick={() => setGuestOpen(true)}>
                      Invite guest
                    </Button>
                  </>
                ) : null}
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
                      /*
                       * The role, not a count of roles.
                       *
                       * This read "1 role", which answers a question nobody asks and made an
                       * administrator and an employee look identical in a list whose purpose is
                       * telling them apart. With two roles in the company model the name is the
                       * whole content of the column.
                       *
                       * More than one is still shown as a count, because that is a company with a
                       * custom role in play and naming three things in a table cell is worse than
                       * saying how many there are.
                       */
                      key: 'role',
                      header: 'Role',
                      render: (person) => (
                        <StatusBadge
                          status={roleLabelFor(person)}
                          tone={
                            person.userType === 'ExternalGuest'
                              ? 'purple'
                              : person.roleCount === 0
                                ? 'warn'
                                : person.roleKinds.includes('CompanyAdmin')
                                  ? 'blue'
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
                          {/*
                            What happened to the activation email, on the row where somebody asks.

                            The question this answers is "I invited them and they say nothing
                            arrived" — which until now had no answer anywhere in the product, for
                            anybody: the outcome was logged inside the API container, and the only
                            queue view is platform-only and not rendered by any screen.
                          */}
                          {invitationHint(person) === null ? null : (
                            <>
                              <br />
                              {/* The badge above carries the colour; this line carries the words,
                                  in the same muted style every other hint on this row uses. */}
                              <small className="uboss-muted-3">{invitationHint(person)}</small>
                            </>
                          )}
                          {inviteBlockers(person).length === 0 ? null : (
                            <>
                              <br />
                              {/* Why they cannot be invited, on the row where the question arises. */}
                              <small className="uboss-muted-3">
                                Needs {inviteBlockers(person).join(', ')}
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
                      render: (person) => {
                        /*
                          One primary action, and the rest behind ⋯.

                          This column used to render every action as its own button, so twenty-four
                          people made ninety-odd buttons on one screen. Two things were wrong with
                          that, and the second is the serious one:

                            * a wall of small grey words where the eye is looking for a name; and
                            * **Offboard sat next to Suspend** — a temporary hold beside the end of
                              somebody's employment, rendered alike, a few pixels apart, on a row
                              that scrolls. The confirm dialog is what stopped the mistake, and a
                              dialog should not be a product's only defence against a mis-click.

                          The primary action stays a real button, because putting the common case
                          behind a menu is how overflow menus earn their bad name. Which one is
                          primary depends on where the person is: somebody not yet in the company
                          needs inviting, everybody else needs their access.
                        */
                        const menu: RowMenuItem[] = [];

                        if (
                          mayManageAccess &&
                          person.userType === 'InternalUser' &&
                          person.accountState !== 'Offboarded'
                        ) {
                          menu.push({
                            key: 'role',
                            label: 'Change role',
                            onSelect: () => {
                              setRoleFor(person);
                              setRoleTo(
                                person.roleKinds.includes('CompanyAdmin')
                                  ? 'Employee'
                                  : 'CompanyAdmin',
                              );
                            },
                          });
                        }

                        if (person.invitation) {
                          menu.push({
                            key: 'cancel',
                            label: 'Cancel invitation',
                            detail: 'The link stops working immediately.',
                            onSelect: () =>
                              void run(async () => {
                                await accessApi.cancelInvitation(
                                  tenantId as string,
                                  person.invitation!.id,
                                );
                                return 'Invitation cancelled. The link stops working immediately.';
                              }),
                          });
                        }

                        if (mayManageAccess && person.accountState === 'Active') {
                          menu.push({
                            key: 'suspend',
                            label: 'Suspend',
                            detail: 'Reversible. Keeps everything.',
                            onSelect: () => setSuspendFor(person),
                          });
                        }

                        if (person.accountState === 'Suspended') {
                          menu.push({
                            key: 'reinstate',
                            label: 'Reinstate',
                            onSelect: () =>
                              void run(async () => {
                                await accessApi.reinstate(
                                  tenantId as string,
                                  person.userId,
                                  'Reinstated from Users & Access.',
                                );
                                return `${person.displayName} is active again.`;
                              }),
                          });
                        }

                        if (mayManageAccess && person.accountState !== 'Offboarded') {
                          menu.push({
                            key: 'offboard',
                            label: 'Offboard',
                            detail: 'Ends their employment. Deletes nothing.',
                            destructive: true,
                            onSelect: () => openOffboard(person),
                          });
                        }

                        const needsInvite =
                          person.accountState !== 'Active' &&
                          person.accountState !== 'Offboarded' &&
                          person.userType === 'InternalUser';

                        /*
                         * The role is not a reason to keep somebody out of the invite form.
                         *
                         * Readiness lists what an account needs before it can activate, and a
                         * company role is one of those things. But the invite form **grants the
                         * role** — it asks "this person will be Employee or Administrator" and
                         * calls `grantRole` before it sends, exactly so the choice made there is
                         * what clears the gate. Disabling the button on the same condition put
                         * the only thing that supplies a role behind the requirement for one.
                         *
                         * What that did in practice: somebody adds a person in Hierarchy, comes
                         * here, finds Invite greyed out, and the only control on the screen that
                         * still opens is **Invite guest** — which asks for resource identifiers
                         * and an access window, because a guest is an outsider rather than
                         * somebody's new employee. People filled that in for their own staff
                         * because it was the form that worked.
                         *
                         * A department and a reporting manager are different: nothing in the
                         * invite form supplies either, so they still hold the button shut and the
                         * tooltip names them.
                         */
                        const blockers = inviteBlockers(person);
                        const mayInvite = blockers.length === 0;

                        return (
                          <span className="uboss-actions">
                            {/*
                              Prompt 40A (CR-03) §1 — Access & Permissions.

                              Shown only to somebody holding `users:ManageAccess`, because reading
                              the step is gated as tightly as writing it: the response describes
                              the caller's own authority. Asked of `/my-access` rather than a role
                              label.
                            */}
                            {needsInvite ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy || !mayInvite}
                                /*
                                 * The same sentence the row already carries, on the control that
                                 * is dead because of it. The row says "Needs …" beside the status
                                 * badge; somebody whose eye is on the button does not necessarily
                                 * look left, and a disabled button with no reason reads as broken.
                                 */
                                title={
                                  mayInvite
                                    ? undefined
                                    : `Needs ${blockers.join(', ')} before an invitation can be sent.`
                                }
                                onClick={() => {
                                  setInviteFor(person);
                                  setInviteEmail(person.email);
                                }}
                              >
                                {person.invitation ? 'Resend' : 'Invite'}
                              </Button>
                            ) : mayManageAccess && person.accountState !== 'Offboarded' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => setAccessFor(person)}
                                data-testid="open-access-step"
                              >
                                Access
                              </Button>
                            ) : null}

                            {/*
                              Somebody waiting on an invitation still needs their access setting
                              up, so it moves into the menu rather than disappearing.
                            */}
                            <RowMenu
                              subject={person.displayName}
                              items={
                                needsInvite &&
                                mayManageAccess &&
                                person.accountState !== 'Offboarded'
                                  ? [
                                      {
                                        key: 'access',
                                        label: 'Access & permissions',
                                        onSelect: () => setAccessFor(person),
                                      },
                                      ...menu,
                                    ]
                                  : menu
                              }
                            />
                          </span>
                        );
                      },
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
                  /*
                   * The role first, then the invitation.
                   *
                   * That order matters: inviting is refused for somebody with no role at all —
                   * correctly, because activation would produce an account that signs in and
                   * reaches nothing. Granting first means the choice made here is the thing that
                   * clears the gate.
                   *
                   * A role they already hold is left alone: the server refuses a duplicate, and
                   * an administrator re-sending an invitation is not asking to change anybody's
                   * authority.
                   */
                  await accessApi
                    .grantRole(tenantId as string, inviteFor!.userId, {
                      roleKind: inviteAs,
                      scopeKind: inviteAs === 'CompanyAdmin' ? 'WholeCompany' : 'OwnWork',
                      justification: `Chosen when ${inviteFor!.displayName} was invited.`,
                    })
                    .catch(() => undefined);

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

        <FormField
          label="This person will be"
          required
          hint="An employee sees their own work. An administrator sees and configures the company."
        >
          {() => (
            <div className="uboss-invite-as">
              <label>
                <input
                  type="radio"
                  name="invite-as"
                  checked={inviteAs === 'Employee'}
                  onChange={() => setInviteAs('Employee')}
                />
                <span>
                  <b>Employee</b>
                  <br />
                  <small className="uboss-muted-3">
                    Their to-do list, the agents assigned to them, chat and their own performance.
                  </small>
                </span>
              </label>

              <label>
                <input
                  type="radio"
                  name="invite-as"
                  checked={inviteAs === 'CompanyAdmin'}
                  onChange={() => setInviteAs('CompanyAdmin')}
                  data-testid="invite-as-admin"
                />
                <span>
                  <b>Administrator</b>
                  <br />
                  <small className="uboss-muted-3">
                    Everything an employee sees, plus the hierarchy, objectives, agents, users and
                    company settings.
                  </small>
                </span>
              </label>
            </div>
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
                guest.resourceIds.trim() === ''
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
        {/*
          Four fields, and the last one already has an answer in it.

          This form had five required fields to let one person read two documents, and the fifth
          was a free-text box asking why. Nobody is approving this — an administrator has already
          decided — and the invitation records what it grants regardless: this person, these
          resources, until this date. A required "why" on a decision already taken collects the
          word "guest", and a compliance record made of the word "guest" is worse than none,
          because it looks like a reason somebody gave.

          Thirty days was already the value in the box; it is now stated as the default rather
          than presented as a question with a number pre-filled.
        */}
        <FormField
          label="Access for (days)"
          required
          hint="30 days unless you change it. 365 is the most anybody can be given."
        >
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

      {/*
        Change of role.

        A `ConfirmDialog` rather than a form, because the choice has already been made on the row —
        the button offers the one role the person does not hold — and what is left is whether the
        administrator meant it. Promoting somebody to administrator hands them every screen in the
        company, and standing one down takes those screens away; neither is a thing to do on a
        mis-click.
      */}
      <ConfirmDialog
        open={roleFor !== null}
        title={
          roleTo === 'CompanyAdmin'
            ? `Make ${roleFor?.displayName ?? ''} an administrator`
            : `Make ${roleFor?.displayName ?? ''} an employee`
        }
        description={
          roleTo === 'CompanyAdmin'
            ? 'They will be able to define objectives, build agents, manage people and change ' +
              'company settings — everything you can do.'
            : 'They keep their own work, their tasks and their performance record, and lose ' +
              'administration of the company.'
        }
        impact={[
          { label: 'New role', value: ROLE_KIND_LABELS[roleTo] },
          {
            label: 'Previous role',
            value:
              (roleFor?.roleKinds ?? [])
                .map((kind) => ROLE_KIND_LABELS[kind as keyof typeof ROLE_KIND_LABELS] ?? kind)
                .join(', ') || 'None',
          },
          // Said plainly, because it is the question an administrator asks before pressing it.
          { label: 'Their work', value: 'Untouched — tasks, evidence and history stay theirs' },
          { label: 'Reversible', value: 'Yes — change it back the same way' },
        ]}
        requireReason
        reasonLabel="Why is this role changing?"
        confirmLabel={roleTo === 'CompanyAdmin' ? 'Make administrator' : 'Make employee'}
        onCancel={() => setRoleFor(null)}
        onConfirm={(reason) => {
          const person = roleFor;
          const target = roleTo;
          setRoleFor(null);
          void run(async () => {
            await accessApi.grantRole(tenantId as string, person!.userId, {
              roleKind: target,
              scopeKind: target === 'CompanyAdmin' ? 'WholeCompany' : 'OwnWork',
              justification: reason ?? '',
            });

            /*
             * The old role is revoked after the new one is granted, never before.
             *
             * If the grant fails, they keep what they had. The other order would leave somebody
             * with no role at all on a failure, which is an account that signs in and reaches
             * nothing — and `activationReadiness` treats "no role" as not activatable, so it
             * would not be a state they could be rescued from on this screen.
             */
            const held = await accessApi.rolesOf(tenantId as string, person!.userId);
            for (const assignment of held.assignments) {
              if (assignment.expired) continue;
              if (assignment.roleKind === target) continue;
              // Only the built-in company roles. A custom role the company wrote for itself is
              // somebody's deliberate work and is not swept away by a change of the main one.
              if (!(COMPANY_GRANTABLE_ROLES as readonly string[]).includes(assignment.roleKind)) {
                continue;
              }
              await accessApi.revokeRole(tenantId as string, assignment.id);
            }

            return `${person!.displayName} is now ${ROLE_KIND_LABELS[target].toLowerCase()}.`;
          });
        }}
      />

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
    </RoutedAppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function UsersAccessPage() {
  return (
    <Suspense fallback={null}>
      <UsersAccessInner />
    </Suspense>
  );
}
