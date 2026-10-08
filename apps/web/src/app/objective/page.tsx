'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import {
  OBJECTIVE_STATUS_LABELS,
  OBJECTIVE_STATUS_TONES,
  OBJECTIVE_STATUSES,
  TIME_UNIT_LABELS,
} from '@uboss/types';
import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  FilterSelect,
  Icon,
  PageHeader,
  SearchField,
  StatusBadge,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  objectivesApi,
  type MeResponse,
  type ObjectiveListRow,
} from '../../lib/api-client';
import { useAccountMenu } from '../../lib/use-account-menu';
import { useSignedInUser } from '../../lib/use-signed-in-user';
import { AccessRefused, isRefusal } from '../../components/AccessRefused';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';
import { can, useMyAccess } from '../../lib/use-my-access';

/** The target, as the reference shows it: a number and its unit, or nothing. */
function targetOf(row: ObjectiveListRow): string {
  if (row.targetCompletionTime === null) return '—';
  const unit = row.timeUnit === null ? '' : ` ${TIME_UNIT_LABELS[row.timeUnit].toLowerCase()}`;
  return `${row.targetCompletionTime}${unit}`;
}

/**
 * Objectives — the reference's `objList()`.
 *
 * Its columns, in its order: Objective (name over its code), Department, Responsible manager,
 * Status, Version, Target, Updated. The toolbar is the reference's too — search, a status filter,
 * a department filter, and Create Objective on the right.
 *
 * ## The version cell is a badge, not a concatenated label
 *
 * The locked rule about counts applies here: `V2 Live` is a badge carrying the version and its
 * liveness, and it is green only when the version is actually live. The reference's fixture always
 * showed a version; a company with nothing published sees its draft's number instead, because
 * showing "V1 Live" for an unpublished draft would be the prototype's fixture leaking into a real
 * screen.
 */
export default function ObjectivesPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  // What this person may actually do here, so the toolbar offers nothing the server will refuse.
  const access = useMyAccess();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [rows, setRows] = useState<ObjectiveListRow[] | null>(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  /*
   * Refused, as opposed to failed. See `AccessRefused`: "you may not see this" and "there is
   * nothing here" are different answers, and the second one is what a page full of empty controls
   * says.
   */
  const [refused, setRefused] = useState(false);

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const signedInUser = useSignedInUser(me);

  const accountMenu = useAccountMenu(me);
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
    setError(null);

    void objectivesApi
      .list(tenantId, {
        ...(status === '' ? {} : { status }),
        ...(search.trim() === '' ? {} : { search: search.trim() }),
      })
      .then((result) => {
        setRows(result.objectives);
        setRefused(false);
      })
      .catch((caught: unknown) => {
        setRows([]);
        /*
         * A refusal is not an error, and the screen has to tell them apart.
         *
         * Both used to land in the same red banner over the same working page — search box,
         * filters, column headings and "No objectives yet" underneath. An Employee, who has no
         * `objective` grant at all, searched an empty table and concluded the company had none.
         */
        setRefused(isRefusal(caught));
        setError(caught instanceof ApiError ? caught.message : 'Could not load objectives.');
      });
  }, [search, status, tenantId]);

  useEffect(load, [load]);

  return (
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="objective"
      user={signedInUser}
      accountMenu={accountMenu}
      {...bell.shellProps}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Objectives"
        description="Find and manage objectives before AI decomposition."
        breadcrumbs={[{ label: 'Objective' }]}
        actions={
          /*
           * Only offered to somebody who may actually create one.
           *
           * A standard Employee has no `objective` grant at all -- CR-03 removed it deliberately --
           * so this button used to send them to Form 2 and let the server refuse the save with a
           * 403. `use-my-access` exists for exactly this: "a screen that offers an action the
           * route will refuse is a screen that teaches people their software is broken".
           *
           * `can()` leans shut while access is still loading, which is the right way round here:
           * a button that appears a moment late is better than one that fails when pressed.
           */
          can(access, 'objective', 'Create') ? (
            <Link href="/objective/form">
              <Button variant="primary" size="sm">
                <Icon name="plus" size={16} />
                Create Objective
              </Button>
            </Link>
          ) : null
        }
      />

      {/*
        Refused and broken look nothing alike, so they no longer render alike.

        A refusal replaces the working surface entirely — search, filters, headings and all — and
        says so once. A genuine failure keeps the surface and the red banner, because there the
        controls are still yours and retrying is the right thing to do.
      */}
      {refused ? (
        <Card>
          <CardBody>
            <AccessRefused what="Objectives" message={error} />
          </CardBody>
        </Card>
      ) : (
        <>
          {error === null ? null : <Banner tone="danger">{error}</Banner>}

          <Card>
            <div className="uboss-toolbar">
              <SearchField
                label="Search objectives"
                placeholder="Search objectives"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <FilterSelect
                label="Status"
                value={status}
                onChange={setStatus}
                options={[
                  { value: '', label: 'All statuses' },
                  /*
                The names the product already has, not the identifiers with spaces in them.

                Splitting on the capitals turned `AiAnalysis` into "Ai Analysis" — a word that is
                not a word, on a filter everybody uses — and `ReadyForApproval` into "Ready For
                Approval" with a capital F. `OBJECTIVE_STATUS_LABELS` has been sitting beside the
                status list the whole time with the right names in it; this filter simply never
                asked for them, so the dropdown and the table beside it disagreed about what the
                same status is called.
              */
                  ...OBJECTIVE_STATUSES.map((value) => ({
                    value,
                    label: OBJECTIVE_STATUS_LABELS[value],
                  })),
                ]}
              />
            </div>

            <DataTable
              caption="Objectives"
              rowKey={(row: ObjectiveListRow) => row.id}
              rows={rows ?? []}
              {...(rows === null ? { loading: true } : {})}
              emptyTitle="No objectives yet"
              /*
               * The empty state told everybody to "create an objective", including the roles that
               * hold no `objective:Create` — a Company Admin, for one, whose grants here are View,
               * Comment and Export by deliberate separation of duties (role-templates.ts). Since the
               * Create button is correctly hidden from them, that copy instructed an action with no
               * control to perform it and no route that would accept it. It now says what each reader
               * can actually do next.
               */
              emptyDescription={
                can(access, 'objective', 'Create')
                  ? 'Create an objective to record its business intent on the approved Form 2.'
                  : 'Objectives appear here once someone who authors them records one on the approved Form 2. Your role reads and comments on objectives rather than creating them.'
              }
              columns={[
                {
                  /*
                   * The row number, because a list of forty-five with no numbers cannot be talked
                   * about. "The third one down" is how people refer to a row on a call, and until
                   * now there was nothing on screen that made that mean anything.
                   *
                   * It numbers what is on screen, so it follows the search and the status filter.
                   * The objective's own identity is its code, which is already under its name —
                   * this is a position, and it does not pretend otherwise.
                   */
                  key: 'sr',
                  header: '#',
                  width: '56px',
                  numeric: true,
                  render: (_row: ObjectiveListRow, index: number) => (
                    <span className="uboss-muted-3">{index + 1}</span>
                  ),
                },
                {
                  key: 'objective',
                  header: 'Objective',
                  // The name sits over its code, so this cell is two lines and cannot live inside a
                  // fixed row height without looking crushed.
                  stacked: true,
                  render: (row: ObjectiveListRow) => (
                    <Link href={`/objective/form?objectiveId=${encodeURIComponent(row.id)}`}>
                      <b>{row.objectiveName}</b>
                      <br />
                      <small className="uboss-muted-3 uboss-mono">{row.code}</small>
                    </Link>
                  ),
                },
                {
                  key: 'department',
                  header: 'Department',
                  width: '170px',
                  // Both of these columns used to print the first eight characters of a UUID, which
                  // reads as "01a084c1" — noise a person cannot scan a list by, and identical-looking
                  // across departments that share a prefix. The API now returns the names.
                  render: (row: ObjectiveListRow) => <span>{row.departmentName}</span>,
                },
                {
                  key: 'responsible',
                  header: 'Responsible manager',
                  width: '180px',
                  render: (row: ObjectiveListRow) =>
                    row.responsibleOwnerUserId === null ? (
                      // Not yet routed. Said plainly rather than shown as a blank cell.
                      <span className="uboss-muted-3">Not yet sent to anyone</span>
                    ) : (
                      <span>{row.responsibleOwnerName ?? 'No longer in this company'}</span>
                    ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  width: '160px',
                  render: (row: ObjectiveListRow) => (
                    <StatusBadge
                      tone={OBJECTIVE_STATUS_TONES[row.status]}
                      status={row.statusLabel}
                    />
                  ),
                },
                {
                  key: 'version',
                  header: 'Version',
                  width: '110px',
                  render: (row: ObjectiveListRow) => (
                    <StatusBadge
                      tone={row.live ? 'success' : 'grey'}
                      status={`V${row.versionNumber}${row.live ? ' Live' : ''}`}
                    />
                  ),
                },
                {
                  key: 'target',
                  header: 'Target',
                  width: '130px',
                  render: (row: ObjectiveListRow) => targetOf(row),
                },
                {
                  key: 'updated',
                  header: 'Updated',
                  width: '110px',
                  render: (row: ObjectiveListRow) => (
                    <span className="uboss-muted">
                      {new Date(row.updatedAt).toLocaleDateString()}
                    </span>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}
    </RoutedAppShell>
  );
}
