'use client';

import { useState } from 'react';

import {
  ApprovalCard,
  BADGE_LADDER,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  CreditMeter,
  DataTable,
  DonutDashboard,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterSelect,
  FormField,
  MedalBadge,
  MetricCard,
  Modal,
  PageHeader,
  ProgressStep,
  SearchField,
  SecurityMetric,
  SkeletonText,
  StatusBadge,
  TabPanel,
  Tabs,
} from '@uboss/ui';

interface ObjectiveRow {
  id: string;
  name: string;
  department: string;
  manager: string;
  status: string;
  version: string;
}

const OBJECTIVES: ObjectiveRow[] = [
  {
    id: 'OBJ-503',
    name: 'GSPR checklist generation for IV Cannula range',
    department: 'Regulatory Affairs',
    manager: 'Pranav Kulkarni',
    status: 'Live',
    version: 'V1',
  },
  {
    id: 'OBJ-504',
    name: 'Distributor lead qualification — West',
    department: 'Exports & Tenders',
    manager: 'Divya Rao',
    status: 'In Review',
    version: 'V2',
  },
  {
    id: 'OBJ-505',
    name: 'Post-market surveillance digest',
    department: 'Quality Assurance',
    manager: 'Sourav Ghosh',
    status: 'Draft',
    version: 'V1',
  },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="uboss-section-label">{title}</div>
      {children}
    </>
  );
}

export default function ComponentsShowcase() {
  const [tab, setTab] = useState('states');
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmResult, setConfirmResult] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');

  return (
    <div className="uboss-content">
      <PageHeader
        title="Components & states"
        description="Every shared primitive, with the states each screen is required to handle."
        breadcrumbs={[{ label: 'Design system', href: '/design-system' }, { label: 'Components' }]}
      />

      <Tabs
        label="Component groups"
        items={[
          { id: 'states', label: 'States' },
          { id: 'data', label: 'Data & tables' },
          { id: 'forms', label: 'Forms & actions' },
          { id: 'domain', label: 'Domain primitives' },
          { id: 'overlays', label: 'Overlays' },
        ]}
        activeId={tab}
        onChange={setTab}
      />

      <TabPanel id="states" activeId={tab}>
        <Section title="Loading">
          <Card>
            <CardBody>
              <SkeletonText lines={3} />
            </CardBody>
          </Card>
        </Section>

        <Section title="Empty — always offers a way forward">
          <Card>
            <EmptyState
              title="No objectives yet"
              description="Create your first objective to get started."
              actions={<Button variant="primary">Create Objective</Button>}
            />
          </Card>
        </Section>

        <Section title="Error, permission denied, blocked, degraded">
          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}
          >
            <Card>
              <ErrorState
                kind="error"
                description="Couldn't load Engine Agent runs."
                actions={<Button size="sm">Retry</Button>}
              />
            </Card>
            <Card>
              <ErrorState
                kind="permission-denied"
                description="Your role can't open this module. Ask a Company Admin to grant access."
                actions={
                  <Button variant="primary" size="sm">
                    Go to my dashboard
                  </Button>
                }
              />
            </Card>
            <Card>
              <ErrorState kind="blocked" description="Waiting on a connection reauthorization." />
            </Card>
            <Card>
              <ErrorState
                kind="degraded"
                description="Showing cached data — one provider is degraded."
              />
            </Card>
          </div>
        </Section>

        <Section title="Inline banners">
          <div className="uboss-grid">
            <Banner tone="info">This will assign work to 4 people. Confirm to proceed.</Banner>
            <Banner tone="ok">Published — V2 is now live.</Banner>
            <Banner tone="warn">You have unsaved changes. Save or discard before leaving.</Banner>
            <Banner tone="danger">This action cannot be undone.</Banner>
          </div>
        </Section>
      </TabPanel>

      <TabPanel id="data" activeId={tab}>
        <Section title="MetricCard">
          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}
          >
            <MetricCard label="Engine Agents" value={8} delta="+2 this month" trend="up" />
            <MetricCard label="Pending jobs" value={12} delta="-4 this week" trend="down" />
            <MetricCard label="Skills approved" value={17} />
            <MetricCard label="Runs today" value="1,204" delta="+6%" trend="up" />
          </div>
        </Section>

        <Section title="StatusBadge — status is never colour-only">
          <Card>
            <CardBody>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  'Live',
                  'Draft',
                  'In Review',
                  'Running',
                  'Waiting Approval',
                  'Overdue',
                  'Blocked',
                  'Failed',
                  'Settled',
                  'New',
                ].map((status) => (
                  <StatusBadge key={status} status={status} />
                ))}
              </div>

              <div className="uboss-section-label">Badge ladder</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {BADGE_LADDER.map((tier) => (
                  <MedalBadge key={tier} tier={tier} />
                ))}
              </div>
            </CardBody>
          </Card>
        </Section>

        <Section title="FilterBar + DataTable">
          <Card>
            <FilterBar
              actions={
                <Button variant="primary" size="sm" icon="plus">
                  Create Objective
                </Button>
              }
            >
              <SearchField mini label="Search objectives" placeholder="Search objectives" />
              <FilterSelect
                label="Status"
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: 'all', label: 'All statuses' },
                  { value: 'live', label: 'Live' },
                  { value: 'draft', label: 'Draft' },
                  { value: 'review', label: 'In Review' },
                ]}
              />
            </FilterBar>

            <DataTable
              caption="Objectives"
              rowKey={(row) => row.id}
              rows={OBJECTIVES.filter((row) =>
                statusFilter === 'all'
                  ? true
                  : row.status.toLowerCase().replace(' ', '') === statusFilter.replace(' ', ''),
              )}
              columns={[
                {
                  key: 'name',
                  header: 'Objective',
                  render: (row) => (
                    <>
                      <b>{row.name}</b>
                      <br />
                      <small className="uboss-muted-3 uboss-mono">{row.id}</small>
                    </>
                  ),
                },
                { key: 'department', header: 'Department', render: (row) => row.department },
                { key: 'manager', header: 'Responsible manager', render: (row) => row.manager },
                {
                  key: 'status',
                  header: 'Status',
                  render: (row) => <StatusBadge status={row.status} />,
                },
                { key: 'version', header: 'Version', render: (row) => row.version, numeric: true },
              ]}
              onRowSelect={() => setDrawerOpen(true)}
              emptyTitle="No objectives match this filter"
              emptyDescription="Clear the filter to see all objectives."
              emptyActions={
                <Button size="sm" onClick={() => setStatusFilter('all')}>
                  Clear filter
                </Button>
              }
            />
          </Card>
          <p className="uboss-notice">
            Rows are keyboard-activatable: Tab to a row and press Enter or Space.
          </p>
        </Section>

        <Section title="DataTable — loading and error">
          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}
          >
            <Card>
              <DataTable
                caption="Objectives loading"
                loading
                rowKey={(row: ObjectiveRow) => row.id}
                rows={[]}
                columns={[
                  { key: 'name', header: 'Objective', render: (row) => row.name },
                  { key: 'status', header: 'Status', render: (row) => row.status },
                ]}
              />
            </Card>
            <Card>
              <DataTable
                caption="Objectives error"
                error="The service did not respond in time."
                onRetry={() => undefined}
                rowKey={(row: ObjectiveRow) => row.id}
                rows={[]}
                columns={[
                  { key: 'name', header: 'Objective', render: (row) => row.name },
                  { key: 'status', header: 'Status', render: (row) => row.status },
                ]}
              />
            </Card>
          </div>
        </Section>
      </TabPanel>

      <TabPanel id="forms" activeId={tab}>
        <Section title="Buttons">
          <Card>
            <CardBody>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button variant="primary">Approve &amp; Assign</Button>
                <Button>Save Draft</Button>
                <Button variant="navy">Open Master Console</Button>
                <Button variant="danger" icon="alert">
                  Suspend company
                </Button>
                <Button variant="ghost">Cancel</Button>
                <Button size="sm" icon="plus">
                  Add node
                </Button>
                <Button disabled>Disabled</Button>
              </div>
            </CardBody>
          </Card>
        </Section>

        <Section title="FormField — label association, hint and error">
          <Card>
            <CardBody>
              <div className="uboss-row-2">
                <FormField label="Employee Name" required>
                  {(props) => <input {...props} defaultValue="Meera Iyer" />}
                </FormField>
                <FormField label="Employee ID" required hint="Unique within this company.">
                  {(props) => <input {...props} defaultValue="E-1102" />}
                </FormField>
              </div>
              <div className="uboss-row-2">
                <FormField label="Department" required>
                  {(props) => (
                    <select {...props} defaultValue="Regulatory Affairs">
                      <option>Regulatory Affairs</option>
                      <option>Exports &amp; Tenders</option>
                      <option>Quality Assurance</option>
                    </select>
                  )}
                </FormField>
                <FormField
                  label="Aadhaar Number"
                  required
                  error="Enter the 12-digit number."
                  hint="Used for internal person matching only. UBoss does not verify Aadhaar."
                >
                  {(props) => <input {...props} defaultValue="1234" />}
                </FormField>
              </div>
              <FormField label="Expected Final Result" required>
                {(props) => (
                  <textarea
                    {...props}
                    defaultValue="A complete Annex I GSPR checklist per IV Cannula variant, each applicable requirement traced to a named evidence document."
                  />
                )}
              </FormField>
            </CardBody>
          </Card>
        </Section>

        <Section title="SearchField">
          <Card>
            <CardBody>
              <SearchField
                label="Search people, objectives, agents"
                placeholder="Search people, objectives, agents"
              />
            </CardBody>
          </Card>
        </Section>
      </TabPanel>

      <TabPanel id="domain" activeId={tab}>
        <Section title="DonutDashboard — the Company Workspace Dashboard contract">
          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}
          >
            <Card>
              <DonutDashboard
                agents={8}
                pendingJobs={12}
                onSelectAgents={() => undefined}
                onSelectPendingJobs={() => undefined}
              />
            </Card>
            <Card>
              <DonutDashboard agents={0} pendingJobs={0} />
            </Card>
          </div>
          <p className="uboss-notice">
            Exactly two slices — Agents and Pending Jobs. The component takes two named counts
            rather than a slice array, so a third category cannot be introduced.
          </p>
        </Section>

        <Section title="ProgressStep — real progress only">
          <Card>
            <CardBody>
              <ProgressStep
                label="Objective analysis"
                items={[
                  { id: '1', label: 'Understanding objective', state: 'done' },
                  { id: '2', label: 'Reading team structure + business rules', state: 'done' },
                  { id: '3', label: 'Detecting human work', state: 'done' },
                  {
                    id: '4',
                    label: 'Identifying AI work',
                    state: 'running',
                    sub: 'Matching approved Skills',
                  },
                  { id: '5', label: 'Assigning owners', state: 'todo' },
                  { id: '6', label: 'Building dependencies & approval gates', state: 'todo' },
                ]}
              />
            </CardBody>
          </Card>
        </Section>

        <Section title="ApprovalCard — the Executor Agent never bypasses a Human approval">
          <div className="uboss-grid">
            <ApprovalCard
              title="Head sign-off — GSPR checklist V2"
              meta="Raised 2h ago by Pranav Kulkarni"
              status="Waiting Approval"
              humanApprovalRequired
              actions={
                <>
                  <Button variant="primary" size="sm">
                    Approve
                  </Button>
                  <Button size="sm">Request changes</Button>
                  <Button variant="ghost" size="sm">
                    Reject
                  </Button>
                </>
              }
            />
            <ApprovalCard
              title="Engine Agent run completed — Spain tender miner"
              meta="Today 09:04"
              status="Completed"
            />
          </div>
        </Section>

        <Section title="CreditMeter — Estimate, Reserve, Execute, Settle/Reconcile">
          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}
          >
            <Card>
              <CardHeader title="Regulatory Affairs — monthly AI budget" />
              <CardBody>
                <CreditMeter
                  label="Regulatory Affairs monthly AI budget"
                  budget={500}
                  unit="USD"
                  lifecycle={{ settled: 180, executing: 24, reserved: 60, estimated: 42 }}
                />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Exports & Tenders — over budget" />
              <CardBody>
                <CreditMeter
                  label="Exports and Tenders monthly AI budget"
                  budget={200}
                  unit="USD"
                  lifecycle={{ settled: 150, executing: 30, reserved: 40, estimated: 25 }}
                />
              </CardBody>
            </Card>
          </div>
        </Section>

        <Section title="SecurityMetric">
          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}
          >
            <SecurityMetric
              label="MFA enrolment"
              value="92%"
              level="ok"
              detail="Policy: required"
            />
            <SecurityMetric
              label="Stale sessions"
              value={3}
              level="attention"
              icon="clock"
              detail="Older than 30 days"
            />
            <SecurityMetric
              label="Secrets past rotation"
              value={1}
              level="critical"
              icon="key"
              detail="Metadata only — values are never shown"
            />
          </div>
        </Section>
      </TabPanel>

      <TabPanel id="overlays" activeId={tab}>
        <Section title="Modal, Drawer and the dangerous-action gate">
          <Card>
            <CardBody>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button onClick={() => setModalOpen(true)}>Open modal</Button>
                <Button onClick={() => setDrawerOpen(true)}>Open drawer</Button>
                <Button variant="danger" onClick={() => setConfirmOpen(true)}>
                  Suspend company…
                </Button>
              </div>
              {confirmResult ? (
                <div style={{ marginTop: 14 }}>
                  <Banner tone="ok">Confirmed with reason: &ldquo;{confirmResult}&rdquo;</Banner>
                </div>
              ) : null}
              <p className="uboss-notice">
                Overlays trap focus, close on Escape, restore focus on close, and prevent the page
                behind from scrolling.
              </p>
            </CardBody>
          </Card>
        </Section>
      </TabPanel>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Node properties"
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setModalOpen(false)}>
              Save
            </Button>
          </>
        }
      >
        <FormField label="Selected node">
          {(props) => <input {...props} readOnly defaultValue="Engine: GSPR Drafter" />}
        </FormField>
        <FormField label="Approved skill" hint="Skills are governed and versioned.">
          {(props) => <input {...props} readOnly defaultValue="gspr-checklist v6" />}
        </FormField>
      </Modal>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Objective detail"
        footer={<Button onClick={() => setDrawerOpen(false)}>Close</Button>}
      >
        <div className="uboss-kv">
          <span className="uboss-kv-key">Objective</span>
          <span className="uboss-kv-value">GSPR checklist generation</span>
        </div>
        <div className="uboss-kv">
          <span className="uboss-kv-key">Department</span>
          <span className="uboss-kv-value">Regulatory Affairs</span>
        </div>
        <div className="uboss-kv">
          <span className="uboss-kv-key">Status</span>
          <span className="uboss-kv-value">
            <StatusBadge status="Live" />
          </span>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={(reason) => {
          setConfirmResult(reason ?? null);
          setConfirmOpen(false);
        }}
        title="Suspend SPM Medicare?"
        description="Suspending a company blocks sign-in for every member and pauses all Engine Agent runs."
        impact={[
          { label: 'Members affected', value: '148' },
          { label: 'Engine Agents paused', value: '8' },
          { label: 'Scheduled runs cancelled', value: '23' },
        ]}
        requireReason
        confirmPhrase="SPM Medicare"
        confirmLabel="Suspend company"
        destructive
      />
    </div>
  );
}
