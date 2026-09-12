'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  FilterSelect,
  FormField,
  Modal,
  OrgChart,
  type OrgChartNode,
  PageHeader,
  ProgressStep,
  SearchField,
  SegmentedControl,
  SkeletonText,
  StatusBadge,
  type StatusTone,
  VisionMission,
} from '@uboss/ui';

import {
  type AddEmployeeResult,
  ApiError,
  authApi,
  type DepartmentRow,
  type HierarchyView,
  type MeResponse,
  organizationApi,
  photosApi,
  type PhotoView,
} from '../../lib/api-client';

import { useNotificationBell } from '../../lib/use-notification-bell';
import { EmployeePhoto } from '../../components/EmployeePhoto';
import { AccessPermissionsStep } from '../../components/AccessPermissionsStep';
import { useCompanyNavigation } from '../../lib/use-company-navigation';
import { can, useMyAccess } from '../../lib/use-my-access';

/** Account state is never colour alone; the badge always carries its text. */
function accountTone(state: string | null): StatusTone {
  switch (state) {
    case 'Active':
      return 'success';
    case 'InvitePending':
      return 'blue';
    case 'Suspended':
      return 'warn';
    case 'Offboarded':
      return 'grey';
    default:
      // `NotInvited` — known to the company, cannot sign in. The normal state for somebody who
      // has been added to the hierarchy and not yet invited.
      return 'grey';
  }
}

interface EmployeeForm {
  employeeName: string;
  employeeId: string;
  designation: string;
  departmentId: string;
  reportingManagerUserId: string;
  aadhaarNumber: string;
  workEmail: string;
  workPhone: string;
  joinedOn: string;
}

const EMPTY_FORM: EmployeeForm = {
  employeeName: '',
  employeeId: '',
  designation: '',
  departmentId: '',
  reportingManagerUserId: '',
  aadhaarNumber: '',
  workEmail: '',
  workPhone: '',
  joinedOn: '',
};

/**
 * Organization Hierarchy — the client's approved screen, built against the real API.
 *
 * ## Matched to the reference, section by section
 *
 * | Reference               | Here                                                          |
 * | ----------------------- | ------------------------------------------------------------- |
 * | `vmStrip()`             | `<VisionMission>` — same gradients, labels and corner glow    |
 * | `.seg` Tree/List        | `<SegmentedControl>`, Tree view default                        |
 * | search + dept filter    | `<SearchField>` "Search people" + `<FilterSelect>`             |
 * | Add Department          | a modal, `hierarchy:Administer` only                           |
 * | Add Employee (primary)  | the six mandatory fields, then optional, then the result panel |
 * | `orgChart()`            | `<OrgChart>` — the same SVG layout and node actions            |
 * | list table              | the reference's seven columns, in order                        |
 * | `empProgress()`         | the three-step stepper while saving                            |
 * | `empResult()`           | the permanent UBoss Unique ID panel with Copy ID               |
 *
 * ## Two reference controls are deliberately not here
 *
 * **Full screen** and **Download** appear on the reference's tree toolbar. Both are presentation
 * features over a chart that now comes from real data; they are listed in `docs/UX_MAP.md` as
 * not built rather than shipped as buttons that do nothing. Everything that touches data is real.
 *
 * ## And one control that must never be here
 *
 * There is **no Invite button on a hierarchy node**, and none in the toolbar. The client's rule
 * is explicit: the invitation source is Settings → Users & Access. Adding an employee here
 * creates somebody the company knows about who cannot sign in, and the result panel says so.
 */
export default function HierarchyPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const myAccess = useMyAccess();
  const mayManageAccess = can(myAccess, 'users', 'ManageAccess');
  const [photos, setPhotos] = useState<Record<string, PhotoView | null>>({});
  const router = useRouter();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [view, setView] = useState<HierarchyView | null>(null);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [mode, setMode] = useState<'tree' | 'list'>('tree');
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('all');

  const [employeeOpen, setEmployeeOpen] = useState(false);
  const [form, setForm] = useState<EmployeeForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<AddEmployeeResult | null>(null);
  const [copied, setCopied] = useState(false);

  const [departmentOpen, setDepartmentOpen] = useState(false);
  const [departmentName, setDepartmentName] = useState('');
  const [departmentCode, setDepartmentCode] = useState('');

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
    void Promise.all([organizationApi.hierarchy(tenantId), organizationApi.departments(tenantId)])
      .then(([hierarchy, departmentResult]) => {
        setView(hierarchy);
        setDepartments(departmentResult.departments);

        /*
         * Prompt 40A (CR-03) §3 — every avatar in one request.
         *
         * Chained rather than run alongside, because the ids come from the hierarchy. Its failure
         * is swallowed: a page that refused to show the company because nobody could read the
         * photos would be a worse page, and initials are a correct rendering of "no picture"
         * whatever the reason there is not one.
         */
        const userIds = hierarchy.list.map((row) => row.userId);
        if (userIds.length === 0) return;
        void photosApi
          .viewMany(tenantId, userIds)
          .then((result) => {
            const byUser: Record<string, PhotoView | null> = {};
            for (const id of userIds) byUser[id] = null;
            for (const photo of result.photos) byUser[photo.userId] = photo;
            setPhotos(byUser);
          })
          .catch(() => undefined);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load the hierarchy.'),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  /** Everybody who could be a reporting manager: currently-employed people. */
  const managerOptions = useMemo(
    () =>
      (view?.list ?? [])
        .filter((row) => row.employmentState === 'Active')
        .map((row) => ({
          value: row.userId,
          label: `${row.displayName} — ${row.designation}`,
        })),
    [view],
  );

  const filteredList = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (view?.list ?? []).filter((row) => {
      const matchesDepartment =
        departmentFilter === 'all' || row.departmentName === departmentFilter;
      const matchesSearch =
        term === '' ||
        row.displayName.toLowerCase().includes(term) ||
        row.employeeId.toLowerCase().includes(term) ||
        row.designation.toLowerCase().includes(term) ||
        row.ubossUniqueId.toLowerCase().includes(term);
      return matchesDepartment && matchesSearch;
    });
  }, [departmentFilter, search, view]);

  /** The API's tree, mapped to the chart's shape and narrowed by the department filter. */
  const chartRoot = useMemo<OrgChartNode | null>(() => {
    if (!view) {
      return null;
    }

    const toChart = (node: HierarchyView['tree']): OrgChartNode => ({
      kind: node.kind,
      id: node.id,
      name: node.name,
      subtitle:
        node.kind === 'company'
          ? `Company · ${node.children.length} department${node.children.length === 1 ? '' : 's'}`
          : node.kind === 'department'
            ? `Department · ${node.headcount ?? 0} ${node.headcount === 1 ? 'person' : 'people'}`
            : (node.person?.designation ?? ''),
      children: node.children.map(toChart),
    });

    const root = toChart(view.tree);
    if (departmentFilter === 'all') {
      return root;
    }
    return {
      ...root,
      children: root.children.filter((child) => child.name === departmentFilter),
    };
  }, [departmentFilter, view]);

  // Hiding a control the server would refuse is a courtesy, not the enforcement — every route
  // checks the permission again regardless of what this screen renders.
  const mayAdminister = view?.mayAdminister ?? false;

  const submitEmployee = useCallback(() => {
    if (!tenantId) {
      return;
    }
    setSaving(true);
    setError(null);

    organizationApi
      .addEmployee(tenantId, {
        employeeName: form.employeeName,
        employeeId: form.employeeId,
        designation: form.designation,
        departmentId: form.departmentId,
        ...(form.reportingManagerUserId === ''
          ? {}
          : { reportingManagerUserId: form.reportingManagerUserId }),
        aadhaarNumber: form.aadhaarNumber,
        ...(form.workEmail === '' ? {} : { workEmail: form.workEmail }),
        ...(form.workPhone === '' ? {} : { workPhone: form.workPhone }),
        ...(form.joinedOn === '' ? {} : { joinedOn: new Date(form.joinedOn).toISOString() }),
      })
      .then((added) => {
        setResult(added);
        setForm(EMPTY_FORM);
        load();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not add that employee.'),
      )
      .finally(() => setSaving(false));
  }, [form, load, tenantId]);

  const submitDepartment = useCallback(() => {
    if (!tenantId) {
      return;
    }
    organizationApi
      .createDepartment(tenantId, {
        name: departmentName,
        ...(departmentCode === '' ? {} : { code: departmentCode }),
      })
      .then(() => {
        setNotice(`Added the department "${departmentName}".`);
        setDepartmentName('');
        setDepartmentCode('');
        setDepartmentOpen(false);
        load();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not add that department.'),
      );
  }, [departmentCode, departmentName, load, tenantId]);

  const set = <K extends keyof EmployeeForm>(key: K, value: EmployeeForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const requiredComplete =
    form.employeeName.trim() !== '' &&
    form.employeeId.trim() !== '' &&
    form.designation.trim() !== '' &&
    form.departmentId !== '' &&
    form.aadhaarNumber.replace(/\D/g, '').length === 12;

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
        title="Organization Hierarchy"
        description="Reporting structure and company identity."
        breadcrumbs={[{ label: 'Hierarchy' }]}
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
          {/* The Vision/Mission strip, above the structure — the client's requirement. */}
          <VisionMission vision={view.company.vision} mission={view.company.mission} />

          <Card>
            <CardBody>
              <div className="uboss-actions" style={{ marginBottom: 14 }}>
                <SegmentedControl
                  label="Hierarchy view"
                  value={mode}
                  onChange={(next) => setMode(next as 'tree' | 'list')}
                  options={[
                    { value: 'tree', label: 'Tree view' },
                    { value: 'list', label: 'List view' },
                  ]}
                />
                <SearchField
                  label="Search people"
                  placeholder="Search people"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <FilterSelect
                  label="Department"
                  value={departmentFilter}
                  onChange={setDepartmentFilter}
                  options={[
                    { value: 'all', label: 'All departments' },
                    ...departments.map((department) => ({
                      value: department.name,
                      label: department.name,
                    })),
                  ]}
                />
                {mayAdminister ? (
                  <>
                    <Button icon="panel" onClick={() => setDepartmentOpen(true)}>
                      Add Department
                    </Button>
                    <Button
                      variant="primary"
                      icon="plus"
                      onClick={() => {
                        setResult(null);
                        setEmployeeOpen(true);
                      }}
                    >
                      Add Employee
                    </Button>
                  </>
                ) : null}
              </div>

              {mode === 'tree' ? (
                chartRoot === null ? null : (
                  <OrgChart
                    root={chartRoot}
                    onSelectPerson={(userId) => router.push(`/hierarchy/${userId}`)}
                    // The `+` and pencil actions are omitted for a viewer who cannot administer,
                    // rather than rendered disabled: a control that cannot act should not be on
                    // the node at all. The server refuses either way.
                    {...(mayAdminister
                      ? {
                          onAddReport: (userId: string) => {
                            setResult(null);
                            setForm({ ...EMPTY_FORM, reportingManagerUserId: userId });
                            setEmployeeOpen(true);
                          },
                          onEditPerson: (userId: string) => router.push(`/hierarchy/${userId}`),
                        }
                      : {})}
                    emptyMessage={
                      view.employeeCount === 0
                        ? 'No employees recorded yet. Use Add Employee to build the reporting structure — nobody is invited by adding them here.'
                        : 'No people match this filter.'
                    }
                  />
                )
              ) : (
                <DataTable
                  caption="Everybody recorded in this company"
                  columns={[
                    {
                      key: 'employee',
                      header: 'Employee',
                      render: (row) => (
                        <div className="employee-photo-row">
                          {/*
                            Prompt 40A (CR-03) §3. Read-only here — the Hierarchy shows photos, the
                            profile is where one is set — and fed from the single bulk read above
                            rather than one request per row.
                          */}
                          <EmployeePhoto
                            tenantId={tenantId ?? ''}
                            userId={row.userId}
                            displayName={row.displayName}
                            size="sm"
                            prefetched={photos[row.userId] ?? null}
                          />
                          <div>
                            <b>{row.displayName}</b>
                            <br />
                            <small className="uboss-muted-3">{row.departmentName}</small>
                          </div>
                        </div>
                      ),
                    },
                    {
                      key: 'employeeId',
                      header: 'Employee ID',
                      render: (row) => <span className="uboss-mono">{row.employeeId}</span>,
                    },
                    { key: 'designation', header: 'Designation', render: (row) => row.designation },
                    {
                      key: 'department',
                      header: 'Department',
                      render: (row) => row.departmentName,
                    },
                    {
                      key: 'manager',
                      header: 'Reporting Manager',
                      render: (row) => row.reportingManagerName ?? '—',
                    },
                    {
                      key: 'uboss',
                      header: 'UBoss ID',
                      render: (row) => <span className="uboss-mono">{row.ubossUniqueId}</span>,
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      render: (row) => (
                        <StatusBadge
                          status={row.accountState ?? 'Not invited'}
                          tone={accountTone(row.accountState)}
                        />
                      ),
                    },
                  ]}
                  rows={filteredList}
                  rowKey={(row) => row.userId}
                  emptyTitle="Nobody recorded yet"
                  emptyDescription="Use Add Employee to build the structure. Adding somebody does not invite them."
                />
              )}
            </CardBody>
          </Card>

          {/*
            Stated on the screen rather than left to be discovered: the hierarchy is structure,
            and access is granted somewhere else. This is the client's rule about where the
            Invite button lives, made visible instead of merely obeyed.
          */}
          <p className="uboss-notice">
            Adding somebody here records them in the company and <b>does not invite them</b>.
            Invitations, suspension and offboarding are managed in Settings → Users &amp; Access,
            separately from the structure. Permissions are enforced by the server.
          </p>
        </>
      )}

      {/* ---- Add Department ---- */}
      <Modal
        open={departmentOpen}
        onClose={() => setDepartmentOpen(false)}
        title="Add Department"
        footer={
          <>
            <Button onClick={() => setDepartmentOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={submitDepartment}
              disabled={departmentName.trim().length < 2}
            >
              Save Department
            </Button>
          </>
        }
      >
        <FormField label="Department name" required>
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={departmentName}
              onChange={(event) => setDepartmentName(event.target.value)}
              placeholder="e.g. Regulatory Affairs"
            />
          )}
        </FormField>
        <FormField label="Short code" hint="Optional. Appears on the department node.">
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input uboss-mono"
              value={departmentCode}
              onChange={(event) => setDepartmentCode(event.target.value.toUpperCase())}
              placeholder="REG"
            />
          )}
        </FormField>
      </Modal>

      {/* ---- Add Employee: form → progress → result ---- */}
      <Modal
        open={employeeOpen}
        onClose={() => {
          setEmployeeOpen(false);
          setResult(null);
        }}
        title={result ? 'Employee added' : saving ? 'Saving employee…' : 'Add Employee'}
        wide
        footer={
          result ? (
            <>
              <Button
                onClick={() => {
                  setEmployeeOpen(false);
                  setResult(null);
                }}
              >
                Done
              </Button>
              <Button variant="primary" onClick={() => router.push(`/hierarchy/${result.userId}`)}>
                View profile
              </Button>
            </>
          ) : saving ? null : (
            <>
              <Button onClick={() => setEmployeeOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={submitEmployee} disabled={!requiredComplete}>
                Save Employee
              </Button>
            </>
          )
        }
      >
        {result ? (
          <>
            <Banner tone="ok">
              {result.matchedExistingPerson
                ? 'Linked to an existing UBoss person and added to this company.'
                : 'New UBoss person created and linked to this company.'}
            </Banner>

            {/* The reference's centred permanent-ID panel. */}
            <div
              style={{
                textAlign: 'center',
                padding: 18,
                background: 'var(--uboss-blue-050)',
                border: '1px dashed #B9CFF6',
                borderRadius: 14,
                marginTop: 18,
              }}
            >
              <div className="uboss-muted-3" style={{ fontSize: 12, letterSpacing: 1 }}>
                PERMANENT UBOSS UNIQUE ID
              </div>
              <div
                className="uboss-mono"
                style={{
                  fontSize: 30,
                  fontWeight: 800,
                  color: 'var(--uboss-navy)',
                  letterSpacing: 1,
                  margin: '6px 0',
                }}
              >
                {result.ubossUniqueId}
              </div>
              <Button
                icon="file"
                onClick={() => {
                  void navigator.clipboard?.writeText(result.ubossUniqueId).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? 'Copied' : 'Copy ID'}
              </Button>
            </div>

            <div className="uboss-kv" style={{ marginTop: 16 }}>
              <span className="uboss-kv-key">Company Employee ID</span>
              <span className="uboss-kv-value uboss-mono">{result.employeeId}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Aadhaar</span>
              <span className="uboss-kv-value uboss-mono">
                {result.aadhaarMasked ?? '—'} · masked
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Seats in use</span>
              <span className="uboss-kv-value">
                {result.seats.used}
                {result.seats.ceiling === null ? '' : ` / ${result.seats.ceiling}`}
              </span>
            </div>

            <p className="uboss-notice">
              One permanent UBoss ID links this person across companies, with a separate employment
              record per company. The Aadhaar number is <b>not stored</b> — only these four digits
              and a keyed match value — and it is <b>not marked verified</b>.
              <br />
              <b>No invitation was sent and no password exists.</b> Invite them from Settings →
              Users &amp; Access when they are ready to sign in.
            </p>

            {/*
              Prompt 40A (CR-03) §1 — "User add/invite/edit gets a business-friendly Access &
              Permissions step".

              After the save rather than before it, and that ordering is forced: a capability is
              granted to a person, and until this point there is no person. The step is the same
              component the Invite flow and Users & Access use, so an administrator meets one
              control in three places rather than three that could drift.

              The six mandatory fields above are untouched.
            */}
            {mayManageAccess && tenantId !== null ? (
              <AccessPermissionsStep
                tenantId={tenantId}
                userId={result.userId}
                subjectLabel={form.employeeName.trim()}
              />
            ) : null}
          </>
        ) : saving ? (
          /* The reference's three-step progress, with honest labels for what is happening. */
          <ProgressStep
            label="Saving employee"
            items={[
              {
                id: 'match',
                label: 'Checking existing UBoss identity',
                sub: 'Matching the entered identifier against the person registry',
                state: 'running',
              },
              {
                id: 'identity',
                label: 'Resolving the permanent UBoss ID',
                sub: 'An existing person keeps theirs; a new one gets a fresh permanent ID',
                state: 'todo',
              },
              {
                id: 'employment',
                label: 'Creating the employment record',
                sub: `Linked to ${activeWorkspace?.tenantName ?? 'this company'}`,
                state: 'todo',
              },
            ]}
          />
        ) : (
          <>
            <div className="uboss-section-label">Required</div>

            <FormField label="Employee Name" required>
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  value={form.employeeName}
                  onChange={(event) => set('employeeName', event.target.value)}
                  placeholder="e.g. Kavya Reddy"
                />
              )}
            </FormField>

            <FormField label="Employee ID" required hint="Unique inside this company only.">
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input uboss-mono"
                  value={form.employeeId}
                  onChange={(event) => set('employeeId', event.target.value)}
                  placeholder="E-1130"
                />
              )}
            </FormField>

            <FormField label="Designation" required>
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  value={form.designation}
                  onChange={(event) => set('designation', event.target.value)}
                  placeholder="Regulatory Associate"
                />
              )}
            </FormField>

            <FormField label="Department" required>
              {(wiring) => (
                <select
                  {...wiring}
                  className="uboss-input"
                  value={form.departmentId}
                  onChange={(event) => set('departmentId', event.target.value)}
                >
                  <option value="">Choose a department…</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <FormField
              label="Reporting Manager"
              required={managerOptions.length > 0}
              hint={
                managerOptions.length === 0
                  ? 'This is the first person in the company, so they sit at the top of the reporting tree and have no manager.'
                  : 'Who this person reports to. Separate from their department — a reporting line may cross departments.'
              }
            >
              {(wiring) => (
                <select
                  {...wiring}
                  className="uboss-input"
                  value={form.reportingManagerUserId}
                  onChange={(event) => set('reportingManagerUserId', event.target.value)}
                  disabled={managerOptions.length === 0}
                >
                  <option value="">
                    {managerOptions.length === 0
                      ? 'Top of the reporting tree'
                      : 'Choose a reporting manager…'}
                  </option>
                  {managerOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <FormField
              label="Aadhaar Number"
              required
              hint="Entered-only matching input. No OTP, no verification, and the number itself is never stored."
            >
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input uboss-mono"
                  inputMode="numeric"
                  value={form.aadhaarNumber}
                  onChange={(event) => set('aadhaarNumber', event.target.value)}
                  placeholder="0000 0000 0000"
                />
              )}
            </FormField>

            {/*
              The client's rule in both directions: exactly six fields are mandatory, and every
              other profile field is optional and must not show an asterisk.
            */}
            <div className="uboss-section-label">Optional details</div>

            <FormField label="Email">
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  value={form.workEmail}
                  onChange={(event) => set('workEmail', event.target.value)}
                  placeholder="name@company.com"
                />
              )}
            </FormField>

            <FormField label="Phone">
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  value={form.workPhone}
                  onChange={(event) => set('workPhone', event.target.value)}
                  placeholder="+91"
                />
              )}
            </FormField>

            <FormField label="Joining Date">
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  type="date"
                  value={form.joinedOn}
                  onChange={(event) => set('joinedOn', event.target.value)}
                />
              )}
            </FormField>

            <p className="uboss-notice">
              Saving records this person in the company. <b>It does not invite them</b> and no
              password is created — invitations come from Settings → Users &amp; Access.
            </p>
          </>
        )}
      </Modal>
    </AppShell>
  );
}
