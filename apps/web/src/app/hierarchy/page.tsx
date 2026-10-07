'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
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
  RichTextEditor,
  VisionMission,
} from '@uboss/ui';

import {
  type AddEmployeeResult,
  ApiError,
  accessApi,
  authApi,
  type DepartmentRow,
  type HierarchyView,
  type MeResponse,
  organizationApi,
  photoContentUrl,
  photosApi,
  type PhotoView,
} from '../../lib/api-client';

import { useAccountMenu } from '../../lib/use-account-menu';
import { useSignedInUser } from '../../lib/use-signed-in-user';
import { EmployeeDrawer } from '../../components/EmployeeDrawer';
import { HierarchyImport } from '../../components/HierarchyImport';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
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
  specialization: string;
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
  specialization: '',
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
 * ## One reference control is deliberately not here
 *
 * **Download** appears on the reference's tree toolbar and is still listed in `docs/UX_MAP.md` as
 * not built, rather than shipped as a button that does nothing.
 *
 * **Full screen** is built, along with zoom, pan and Fit: the chart is given a frame it can be
 * moved around in. A real company does not fit in a window — this one is 5,700px wide — and a
 * horizontal scrollbar makes a reader hunt for a branch by dragging a bar and guessing.
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
  const [importOpen, setImportOpen] = useState(false);
  /** Its own flag rather than a shared one: nothing else on this screen should grey out while a
   *  blank spreadsheet is being fetched. */
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);

  /*
   * Who the side panel is showing, or null.
   *
   * Held here rather than in the URL so the chart keeps its zoom and pan while somebody looks
   * through three people in a department — which is the whole reason the panel exists rather than
   * a page.
   */
  const [inspecting, setInspecting] = useState<string | null>(null);
  /**
   * True when the panel should open straight into the edit form.
   *
   * The pencil on a person's card used to open their full profile — a page, showing everything,
   * read-only. Somebody pressing a pencil is telling you they want to change something, and
   * making them read a profile first and find the edit afterwards is two steps for one intent.
   */
  const [editingPerson, setEditingPerson] = useState(false);

  /*
   * The Vision & Mission editor.
   *
   * Draft state is held here rather than inside the modal so that closing and reopening does not
   * silently discard what somebody had typed — and so the fields start from what is recorded
   * rather than from empty, which would read as "type it again" to anybody editing one of the two.
   */
  const [identityOpen, setIdentityOpen] = useState(false);
  const [visionDraft, setVisionDraft] = useState('');
  const [missionDraft, setMissionDraft] = useState('');
  const [savingIdentity, setSavingIdentity] = useState(false);
  /*
    Null means the department form is adding; an id means it is editing that one.

    One form for both, because the fields are the same two and a second modal would be the same
    markup with a different submit — which is how the two drift apart.
  */
  const [editingDepartmentId, setEditingDepartmentId] = useState<string | null>(null);
  /*
    Archiving is its own dialog rather than a mode of the edit form.

    It asks for something the edit form never does — a reason, which the server requires and keeps
    — and it is the one action here that changes what the company looks like to everybody else. A
    confirm step that shares a form with "rename this" is how somebody archives a department while
    meaning to correct its spelling.
  */
  const [archivingDepartment, setArchivingDepartment] = useState<DepartmentRow | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [departmentName, setDepartmentName] = useState('');
  const [departmentCode, setDepartmentCode] = useState('');

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const signedInUser = useSignedInUser(me);

  const accountMenu = useAccountMenu(me);
  const bell = useNotificationBell(tenantId);

  /**
   * Store a picture for the Vision or Mission, and hand back the path to draw it from -- PRD 2.3.
   *
   * It goes into the same file store as everything else, through the same scan and the same
   * quota, and is marked `CompanyIdentityImage` by the API. That mark is what lets it be read by
   * everybody who can open the Hierarchy: a knowledge document needs `settings:Export`, and the
   * Mission is written for the whole company.
   *
   * The path that comes back is relative and goes through `/api`. An absolute one would bake in
   * whichever host it was written on, and these rows outlive deployments.
   */
  const uploadIdentityImage = useCallback(
    async (file: File): Promise<string> => {
      if (tenantId === null) throw new Error('No workspace is active.');
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('That picture could not be read.'));
        reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
        reader.readAsDataURL(file);
      });

      const stored = await organizationApi.uploadCompanyImage(tenantId, {
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        contentBase64,
      });
      return stored.path;
    },
    [tenantId],
  );

  /**
   * Put a picture in the company's file store and hand back the path to draw it from.
   *
   * `Internal` rather than `Public`: this is drawn on a screen only members of the company can
   * open, and a classification is a statement about the data, not about which screen happens to
   * show it. The upload is scanned on arrival like every other file here — the same pipeline, the
   * same quota, the same audit trail — because a second way to store a file would be a second
   * place for all of that to be forgotten.
   *
   * The path returned is relative and goes through `/api`, which the web app proxies to the API
   * in every environment. An absolute one would bake in whichever host it was written on and
   * break the moment the same row is read from another, and these rows outlive deployments.
   */

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

    /*
     * Whether this person has a photograph the chart may draw.
     *
     * The same three conditions the photo component applies, asked here for the same reason: a
     * stored file whose malware scan has not cleared shows `viewable: false`, and that has to
     * render as no photo rather than as a broken image. `photos` is keyed by user id, and a
     * person node's id *is* their user id — the node actions already rely on that.
     */
    const photoFor = (userId: string): string | undefined => {
      const photo = photos[userId];
      if (photo === undefined || photo === null) return undefined;
      if (!photo.viewable || photo.storedFileId === null) return undefined;
      return tenantId === null ? undefined : photoContentUrl(tenantId, userId, photo.storedFileId);
    };

    const toChart = (node: HierarchyView['tree']): OrgChartNode => ({
      kind: node.kind,
      id: node.id,
      name: node.name,
      ...(node.kind === 'person' && photoFor(node.id) !== undefined
        ? { photoUrl: photoFor(node.id) as string }
        : {}),
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
  }, [departmentFilter, photos, tenantId, view]);

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
        specialization: form.specialization,
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

  const closeDepartmentForm = useCallback(() => {
    setDepartmentOpen(false);
    setEditingDepartmentId(null);
    setDepartmentName('');
    setDepartmentCode('');
  }, []);

  /** Opens the department form on an existing department, with its current values in it. */
  const editDepartment = useCallback(
    (departmentId: string) => {
      const department = departments.find((row) => row.id === departmentId);
      if (department === undefined) {
        // The chart is drawn from the same load as this list, so this means the two have gone out
        // of step. Saying so beats opening a blank form that would rename it to nothing.
        setError('That department is no longer in this view. Reload and try again.');
        return;
      }
      setError(null);
      setEditingDepartmentId(department.id);
      setDepartmentName(department.name);
      setDepartmentCode(department.code ?? '');
      setDepartmentOpen(true);
    },
    [departments],
  );

  const askToArchive = useCallback(
    (departmentId: string) => {
      const department = departments.find((row) => row.id === departmentId);
      if (department === undefined) {
        setError('That department is no longer in this view. Reload and try again.');
        return;
      }
      setError(null);
      setArchiveReason('');
      setArchivingDepartment(department);
    },
    [departments],
  );

  const submitArchive = useCallback(() => {
    if (!tenantId || archivingDepartment === null) {
      return;
    }
    organizationApi
      .archiveDepartment(tenantId, archivingDepartment.id, archiveReason)
      .then(() => {
        setNotice(`Archived "${archivingDepartment.name}". Nothing was deleted.`);
        setArchivingDepartment(null);
        setArchiveReason('');
        load();
      })
      .catch((caught: unknown) =>
        /*
          The server's own words. It refuses a department that still employs somebody, one with
          child departments, and one already archived — three rules this screen would otherwise
          have to restate and keep in step, and its message names which one applied.
        */
        setError(
          caught instanceof ApiError ? caught.message : 'Could not archive that department.',
        ),
      );
  }, [archiveReason, archivingDepartment, load, tenantId]);

  const submitDepartment = useCallback(() => {
    if (!tenantId) {
      return;
    }

    const body = {
      name: departmentName,
      ...(departmentCode === '' ? {} : { code: departmentCode }),
    };

    const request =
      editingDepartmentId === null
        ? organizationApi.createDepartment(tenantId, body)
        : organizationApi.updateDepartment(tenantId, editingDepartmentId, body);

    request
      .then(() => {
        setNotice(
          editingDepartmentId === null
            ? `Added the department "${departmentName}".`
            : `Saved the department "${departmentName}".`,
        );
        closeDepartmentForm();
        load();
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError
            ? caught.message
            : editingDepartmentId === null
              ? 'Could not add that department.'
              : 'Could not save that department.',
        ),
      );
  }, [closeDepartmentForm, departmentCode, departmentName, editingDepartmentId, load, tenantId]);

  const set = <K extends keyof EmployeeForm>(key: K, value: EmployeeForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const requiredComplete =
    form.employeeName.trim() !== '' &&
    form.employeeId.trim() !== '' &&
    form.designation.trim() !== '' &&
    form.specialization.trim() !== '' &&
    form.departmentId !== '' &&
    // CR-04, which the service enforces and this form did not: a hierarchy of people nobody can
    // contact is what being lax here produced.
    form.workEmail.trim() !== '' &&
    form.workPhone.trim() !== '' &&
    /*
     * The same condition the asterisk beside the field already uses.
     *
     * The star was conditional and correct — required once this company has somebody to report
     * to — and this check simply did not include it, so Save Employee was enabled and the server
     * refused afterwards with "Reporting Manager is required. This company already has somebody
     * at the top of the reporting tree". The rule was right in two places out of three.
     *
     * Still conditional: the very first employee has nobody to pick, and demanding a manager
     * there would make a new company's first person impossible to add.
     */
    (managerOptions.length === 0 || form.reportingManagerUserId !== '') &&
    form.aadhaarNumber.replace(/\D/g, '').length === 12;

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);

  return (
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="hierarchy"
      {...bell.shellProps}
      user={signedInUser}
      accountMenu={accountMenu}
      onSignOut={() => {
        forgetWorkspace();
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
          <VisionMission
            vision={view.company.vision}
            mission={view.company.mission}
            {...(view.mayEditIdentity
              ? {
                  onEdit: () => {
                    setVisionDraft(view.company.vision ?? '');
                    setMissionDraft(view.company.mission ?? '');
                    setIdentityOpen(true);
                  },
                }
              : {})}
          />

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
                    {/*
                      Download sits beside Import, not inside it.

                      It used to be one click deep: press Import, and the dialog that opens offers
                      the template. Somebody who came here to fetch the blank file had to open
                      something called Import to find it, which reads as the wrong door — reported
                      by the client in those words. The two belong side by side because they are
                      the two halves of one job: take the file away, bring it back.

                      The dialog keeps its own copy, for anybody who opened Import first and then
                      realised they needed the file.
                    */}
                    <Button
                      icon="arrow-down"
                      disabled={downloadingTemplate || tenantId === null}
                      onClick={() => {
                        if (tenantId === null) return;
                        setError(null);
                        setDownloadingTemplate(true);
                        accessApi
                          .downloadHierarchyTemplate(tenantId)
                          .catch((caught: unknown) =>
                            setError(
                              caught instanceof ApiError
                                ? caught.message
                                : 'The template could not be downloaded.',
                            ),
                          )
                          .finally(() => setDownloadingTemplate(false));
                      }}
                    >
                      Download template
                    </Button>
                    <Button icon="arrow-up" onClick={() => setImportOpen(true)}>
                      Import
                    </Button>
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
                    // The frame: zoom, pan, fit and full screen. This chart is the screen rather
                    // than an illustration in one, and a real company does not fit in a window.
                    controls
                    onSelectPerson={(userId) => setInspecting(userId)}
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
                          onEditPerson: (userId: string) => {
                            setEditingPerson(true);
                            setInspecting(userId);
                          },
                          /*
                            The same Add Employee form the toolbar opens, with the department
                            already chosen. Nothing new is invented here: it is one field of the
                            existing form, filled in from the node that was pressed.
                          */
                          onAddToDepartment: (departmentId: string) => {
                            setResult(null);
                            setForm({ ...EMPTY_FORM, departmentId });
                            setEmployeeOpen(true);
                          },
                          onEditDepartment: editDepartment,
                          onArchiveDepartment: askToArchive,
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
        onClose={closeDepartmentForm}
        title={editingDepartmentId === null ? 'Add Department' : 'Edit Department'}
        footer={
          <>
            <Button onClick={closeDepartmentForm}>Cancel</Button>
            <Button
              variant="primary"
              onClick={submitDepartment}
              disabled={departmentName.trim().length < 2}
            >
              {editingDepartmentId === null ? 'Save Department' : 'Save changes'}
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

      {/* ---- Archive a department ---- */}
      <Modal
        open={archivingDepartment !== null}
        onClose={() => setArchivingDepartment(null)}
        title={`Archive ${archivingDepartment?.name ?? 'department'}`}
        footer={
          <>
            <Button onClick={() => setArchivingDepartment(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={submitArchive}
              disabled={archiveReason.trim().length < 5}
            >
              Archive department
            </Button>
          </>
        }
      >
        {/*
          Said plainly, because "archive" and "delete" are not the same thing and somebody reaching
          for one may mean the other. The department stops being offered for new people; every
          record that already names it goes on resolving to it.
        */}
        <Banner tone="info">
          Nothing is deleted. The department is put away, so past employment and history keep
          pointing at a department that still exists. It can hold nobody and no sub-department when
          it is archived.
        </Banner>
        <FormField label="Reason" required hint="Kept with the record. At least five characters.">
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={archiveReason}
              onChange={(event) => setArchiveReason(event.target.value)}
              placeholder="e.g. Merged into Operations"
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
                border: '1px dashed var(--uboss-blue-100)',
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

            {/*
              What this person covers, beyond the title.

              The client's example is the one that explains it: a manager over two or three
              sub-departments and a manager over one carry the same designation, and the chart
              could not tell them apart. Asked here, next to the title it qualifies.

              Marked required, which is the client's call and a change from the six-asterisk rule
              recorded on the employment record. It is enforced here and not in the importer: a
              spreadsheet of people who already work here was correct before this field existed,
              and refusing it now would be this screen's decision applied to somebody else's data.
            */}
            <FormField
              label="Specialization"
              required
              hint="Areas or sub-departments they cover — e.g. Quality, Packaging and Dispatch."
            >
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  value={form.specialization}
                  maxLength={300}
                  onChange={(event) => set('specialization', event.target.value)}
                  placeholder="Quality, Packaging and Dispatch"
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

            {/*
              Starred, because the server has refused an employee without one since CR-04.

              The form asked for neither and blocked on neither, so pressing Add employee without
              an email produced a refusal from the API after everything else had been typed —
              the rule existed, and the only place it was not stated was the place people fill in.
              The service keeps the rule; this stops the screen hiding it.
            */}
            <FormField label="Email" required>
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

            <FormField label="Phone" required>
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
      {/*
        The company's Vision and Mission.

        A plain pair of text areas, because that is what these are: two sentences somebody writes.
        Both are saved together in one call — they are one statement of purpose, and saving half of
        it is how a company ends up with a Vision that contradicts its Mission.
      */}
      <Modal
        open={identityOpen}
        title="Company Vision & Mission"
        onClose={() => setIdentityOpen(false)}
        footer={
          <>
            <Button onClick={() => setIdentityOpen(false)} disabled={savingIdentity}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={savingIdentity || tenantId === null}
              onClick={() => {
                if (tenantId === null) return;
                setSavingIdentity(true);
                setError(null);
                organizationApi
                  .updateIdentity(tenantId, {
                    // Markup now, not a sentence: the API sanitises it and measures its words.
                    vision: visionDraft,
                    mission: missionDraft,
                  })
                  .then(() => {
                    setIdentityOpen(false);
                    load();
                  })
                  .catch((caught: unknown) =>
                    setError(
                      caught instanceof ApiError
                        ? caught.message
                        : 'The Vision and Mission could not be saved.',
                    ),
                  )
                  .finally(() => setSavingIdentity(false));
              }}
            >
              {savingIdentity ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {/*
          Mission first here too, so the editor is in the order the strip draws them.

          A dialog that asks for the Vision first and then shows the Mission on top is a small
          thing that makes somebody check whether they typed them the wrong way round.
        */}
        <FormField label="Company Mission" hint="What it does every day to get there.">
          {() => (
            <RichTextEditor
              label="Company Mission"
              value={missionDraft}
              onChange={setMissionDraft}
              placeholder="The work this company does, and for whom."
              disabled={savingIdentity}
              uploadImage={uploadIdentityImage}
            />
          )}
        </FormField>

        <FormField
          label="Company Vision"
          hint="Where this company is going. Shown above the chart to everybody."
        >
          {() => (
            <RichTextEditor
              label="Company Vision"
              value={visionDraft}
              onChange={setVisionDraft}
              placeholder="The company we intend to become."
              disabled={savingIdentity}
              uploadImage={uploadIdentityImage}
            />
          )}
        </FormField>

        <p className="uboss-muted-3">
          Both are visible to everybody in this company. Leaving one empty removes it from the strip
          rather than showing a blank panel.
        </p>
      </Modal>

      {/*
        Importing a hierarchy from a spreadsheet.

        Mounted here rather than on its own route: the person doing it is looking at the chart they
        are about to change, and sending them to another page to come back and find out what
        happened is the navigation this brief asks to remove.
      */}
      {/*
        The person, beside the chart rather than instead of it.

        Rendered inside the same workspace, so the tree stays on screen and its zoom survives.
      */}
      {tenantId === null ? null : (
        <EmployeeDrawer
          tenantId={tenantId}
          userId={inspecting}
          openEditing={editingPerson}
          me={me?.user.userId ?? null}
          mayAdminister={mayAdminister}
          /*
           * Who could take over: the company's own List View, which this screen already has.
           * Fetching a second roster would be a second answer to "who works here".
           */
          candidates={(view?.list ?? []).map((person) => ({
            userId: person.userId,
            displayName: person.displayName,
            designation: person.designation,
          }))}
          onClose={() => setInspecting(null)}
          onChanged={load}
        />
      )}

      {tenantId === null ? null : (
        <HierarchyImport
          tenantId={tenantId}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={load}
        />
      )}
    </RoutedAppShell>
  );
}
