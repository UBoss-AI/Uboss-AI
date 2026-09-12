'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Icon,
  PageHeader,
  StatusBadge,
} from '@uboss/ui';

import {
  agentBuilderApi,
  type AgentBuilderMetaView,
  type AgentBuilderView,
  type AgentExecutionSetupView,
  ApiError,
  authApi,
  type MeResponse,
  organizationApi,
} from '../../lib/api-client';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { JobMethodImportExport } from '../../components/JobMethodImportExport';
import { useCompanyNavigation } from '../../lib/use-company-navigation';
import { can, useMyAccess } from '../../lib/use-my-access';

/**
 * Agent Builder — the reference's `agentBuilder()`.
 *
 * Its layout: a `1fr 320px` grid. Left is a card carrying the "Ready to test" banner, the
 * "Inherited from objective (read-only)" list and "Missing setup (only what's needed)". Right is
 * the Readiness card with *Test agent* and *Activate agent*.
 *
 * ## The screen's whole job is to ask as little as possible
 *
 * The ZERO-QUESTION RULE is answered by the server, not decided here: `missing` arrives already
 * computed, and this page renders exactly those controls. When it is empty the page says so and
 * offers Test / Activate, which is the client's requirement — "show Ready to Test / Activate and
 * ask nothing extra". The employee never re-enters the job method.
 *
 * ## What it deliberately does not show
 *
 * No credential, ever. A connection is chosen by identity and the server judges it; there is no
 * field here that could hold a key. The prototype's own "Destination Monday board" select is
 * rendered from the company's real answer rather than a hard-coded option, and the prototype's
 * invented cost figure is not carried forward.
 */
function AgentBuilderInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const myAccess = useMyAccess();
  // CR-03 §5 asks the import review to name the assigned employee, and the builder view carries
  // only an id. Resolved from the hierarchy, which every role that can open this screen may read.
  const [people, setPeople] = useState<Record<string, string>>({});
  const params = useSearchParams();
  const assignmentId = params.get('assignmentId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [meta, setMeta] = useState<AgentBuilderMetaView | null>(null);
  const [assignments, setAssignments] = useState<AgentBuilderView[]>([]);
  const [selected, setSelected] = useState<AgentBuilderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    if (!tenantId) return;

    void agentBuilderApi
      .meta(tenantId)
      .then(setMeta)
      .catch(() => undefined);

    void agentBuilderApi
      .list(tenantId)
      .then((result) => {
        setAssignments(result.assignments);
        const wanted =
          assignmentId === null
            ? result.assignments[0]
            : result.assignments.find((entry) => entry.assignmentId === assignmentId);
        setSelected(wanted ?? null);
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load your assigned AI work.',
        ),
      );
  }, [assignmentId, tenantId]);

  useEffect(load, [load]);

  useEffect(() => {
    if (tenantId === null) return;
    void organizationApi
      .hierarchy(tenantId)
      .then((view) => {
        const byId: Record<string, string> = {};
        for (const row of view.list) byId[row.userId] = row.displayName;
        setPeople(byId);
      })
      // A name that will not load shows as a dash rather than as an error: the import still
      // works, and the review still names the objective it landed in.
      .catch(() => undefined);
  }, [tenantId]);

  /** Every mutation funnels through here, so the busy flag and error handling are never skipped. */
  const run = useCallback(
    (work: (tenantId: string, assignmentId: string) => Promise<AgentBuilderView>) => () => {
      if (!tenantId || selected === null) return;
      setBusy(true);
      setError(null);
      setNotice(null);

      void work(tenantId, selected.assignmentId)
        .then((updated) => {
          setSelected(updated);
          setAssignments((current) =>
            current.map((entry) => (entry.assignmentId === updated.assignmentId ? updated : entry)),
          );
          setBusy(false);
        })
        .catch((caught: unknown) => {
          setError(caught instanceof ApiError ? caught.message : 'That did not work.');
          setBusy(false);
        });
    },
    [selected, tenantId],
  );

  const save = (patch: Partial<AgentExecutionSetupView>) =>
    run((tenant, assignment) => agentBuilderApi.saveSetup(tenant, assignment, patch))();

  /** One control per remaining question, in the order the server reported them. */
  const controlFor = (field: keyof AgentExecutionSetupView, label: string, why: string) => {
    if (selected === null) return null;

    if (field === 'runType') {
      return (
        <div className="uboss-field" key={field}>
          <label htmlFor={field}>{label}</label>
          <select
            id={field}
            defaultValue=""
            disabled={busy}
            onChange={(event) =>
              save({ runType: event.target.value as AgentExecutionSetupView['runType'] })
            }
          >
            <option value="" disabled>
              Choose…
            </option>
            {(meta?.runTypes ?? []).map((entry) => (
              <option key={entry.runType} value={entry.runType}>
                {entry.label}
              </option>
            ))}
          </select>
          <span className="uboss-field-hint">{why}</span>
        </div>
      );
    }

    if (field === 'missingDataBehaviour') {
      return (
        <div className="uboss-field" key={field}>
          <label htmlFor={field}>{label}</label>
          <select
            id={field}
            defaultValue=""
            disabled={busy}
            onChange={(event) =>
              save({
                missingDataBehaviour: event.target
                  .value as AgentExecutionSetupView['missingDataBehaviour'],
              })
            }
          >
            <option value="" disabled>
              Choose…
            </option>
            {(meta?.missingDataBehaviours ?? []).map((entry) => (
              <option key={entry.behaviour} value={entry.behaviour}>
                {entry.label}
              </option>
            ))}
          </select>
          <span className="uboss-field-hint">{why}</span>
        </div>
      );
    }

    // The remaining questions are free text, including the connection id. A picker over the
    // company's approved connections belongs to the connections module's own list; until this
    // screen reads it, an id typed here is still validated by the server against the company's
    // grants, so a wrong one is refused rather than accepted.
    return (
      <div className="uboss-field" key={field}>
        <label htmlFor={field}>{label}</label>
        <input
          id={field}
          defaultValue=""
          disabled={busy}
          onBlur={(event) => {
            if (event.target.value.trim() !== '') {
              save({ [field]: event.target.value } as Partial<AgentExecutionSetupView>);
            }
          }}
        />
        <span className="uboss-field-hint">{why}</span>
      </div>
    );
  };

  const assignedToLabel =
    selected?.prefill.ownerUserId == null ? null : (people[selected.prefill.ownerUserId] ?? null);
  const askingNothing = selected !== null && selected.missing.length === 0;

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="agent-builder"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Agent Builder' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Agent Builder"
        description="Ask only for missing execution setup — never re-enter the whole method."
        breadcrumbs={[{ label: 'Engine Agent' }, { label: 'Builder' }]}
      />

      {error === null ? null : (
        <Banner tone="danger">
          <Icon name="shield" size={16} />
          {error}
        </Banner>
      )}
      {notice === null ? null : (
        <Banner tone="ok">
          <Icon name="check" size={16} />
          {notice}
        </Banner>
      )}

      {assignments.length === 0 ? (
        <Card>
          <CardBody>
            <p className="uboss-muted">
              You have no assigned AI work awaiting setup. Work appears here once a manager approves
              and assigns an objective&apos;s workflow.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {assignments.length > 1 ? (
        <Card style={{ marginBottom: 14 }}>
          <CardBody>
            <DataTable
              caption="Assigned AI work"
              rows={assignments}
              rowKey={(row) => row.assignmentId}
              columns={[
                {
                  key: 'work',
                  header: 'AI work',
                  render: (row) => row.prefill.assignedWork,
                },
                {
                  key: 'objective',
                  header: 'Objective',
                  render: (row) => row.prefill.objectiveName,
                },
                {
                  key: 'state',
                  header: 'State',
                  render: (row) =>
                    row.engineAgent === null ? (
                      <StatusBadge
                        tone={row.missing.length === 0 ? 'blue' : 'warn'}
                        status={row.missing.length === 0 ? 'Ready to test' : 'Needs setup'}
                      />
                    ) : (
                      <StatusBadge tone="success" status={row.engineAgent.status} />
                    ),
                },
                {
                  key: 'open',
                  header: '',
                  render: (row) => (
                    <Button size="sm" onClick={() => setSelected(row)}>
                      Open
                    </Button>
                  ),
                },
              ]}
              emptyTitle="Nothing assigned"
              emptyDescription="Assigned AI work appears here."
            />
          </CardBody>
        </Card>
      ) : null}

      {selected === null ? null : (
        <div className="uboss-grid" style={{ gridTemplateColumns: '1fr 320px' }}>
          {/* ---- Left: inherited context, then only what is missing ---- */}
          <Card>
            <CardBody>
              {selected.engineAgent !== null ? (
                <Banner tone="ok">
                  <Icon name="check" size={16} />
                  Active as <b>{selected.engineAgent.name}</b> (version{' '}
                  {selected.engineAgent.versionNumber}). Recurring work creates Runs on this agent —
                  never another agent.
                </Banner>
              ) : askingNothing ? (
                <Banner tone="ok">
                  <Icon name="check" size={16} />
                  Ready to test. Only missing execution setup is requested — the job method is
                  inherited from the objective.
                </Banner>
              ) : (
                <Banner tone="info">
                  <Icon name="bolt" size={16} />
                  {selected.missing.length} question
                  {selected.missing.length === 1 ? '' : 's'} left. Everything else is inherited from
                  the objective and policy.
                </Banner>
              )}

              <div className="uboss-section-label">Inherited from objective (read-only)</div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Agent name</span>
                <span className="uboss-kv-value">
                  {selected.engineAgent?.name ?? selected.prefill.suggestedAgentName}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Assigned objective</span>
                <span className="uboss-kv-value">
                  {selected.prefill.objectiveCode} · {selected.prefill.objectiveName}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Assigned AI work</span>
                <span className="uboss-kv-value">{selected.prefill.assignedWork}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Owner</span>
                <span className="uboss-kv-value uboss-mono uboss-muted-3">
                  {selected.prefill.ownerUserId === null
                    ? 'Not named by the plan'
                    : selected.prefill.ownerUserId.slice(0, 8)}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Attached Skills</span>
                <span className="uboss-kv-value uboss-mono">
                  {selected.prefill.skillVersionIds.length === 0 ? (
                    <span className="uboss-muted-3">None approved yet</span>
                  ) : (
                    selected.prefill.skillVersionIds.map((id) => id.slice(0, 8)).join(', ')
                  )}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Approval required</span>
                <span className="uboss-kv-value">
                  {selected.prefill.approvalRequired ? 'Yes — derived from policy' : 'No'}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Completion evidence</span>
                <span className="uboss-kv-value">{selected.prefill.completionEvidence}</span>
              </div>

              {selected.engineAgent !== null ? null : (
                <>
                  <div className="uboss-section-label">Missing setup (only what&apos;s needed)</div>
                  {askingNothing ? (
                    <p className="uboss-notice-min">
                      <Icon name="check" size={14} />
                      Nothing to ask. The objective, the workflow, policy and your approved
                      connections already answer everything this agent needs.
                    </p>
                  ) : (
                    selected.missing.map((entry) => controlFor(entry.field, entry.label, entry.why))
                  )}
                </>
              )}
            </CardBody>
          </Card>

          {/* ---- Right: readiness, test, activate ---- */}
          <Card>
            <CardBody>
              <div className="uboss-section-label" style={{ marginTop: 0 }}>
                Readiness
              </div>

              <div className="uboss-kv">
                <span className="uboss-kv-key">Connection</span>
                <span className="uboss-kv-value">
                  {selected.readiness.connection === null ? (
                    <span className="uboss-muted-3">
                      {selected.needsConnection ? 'Not chosen' : 'Not needed'}
                    </span>
                  ) : (
                    <StatusBadge
                      tone={
                        selected.readiness.connection.state === 'Connected' ? 'success' : 'warn'
                      }
                      status={selected.readiness.connection.state}
                    />
                  )}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Schedule</span>
                <span className="uboss-kv-value">
                  {selected.setup.triggerOrFrequency ??
                    (selected.setup.runType === null ? '—' : 'Not required')}
                </span>
              </div>

              {selected.lastTest.at === null ? (
                <p className="uboss-notice-min">
                  <Icon name="alert" size={14} />
                  Not tested yet.
                </p>
              ) : (
                <>
                  <div className="uboss-kv">
                    <span className="uboss-kv-key">Last test</span>
                    <span className="uboss-kv-value">
                      <StatusBadge
                        tone={selected.lastTest.passed ? 'success' : 'danger'}
                        status={selected.lastTest.passed ? 'Passed' : 'Failed'}
                      />
                    </span>
                  </div>
                  {/* Never presented as a real provider result when it was not one. */}
                  <p className="uboss-notice-min">
                    <Icon name="shield" size={14} />
                    {selected.lastTest.wasReal
                      ? 'Ran against a live model provider.'
                      : 'Ran against the built-in mock model, not a live provider.'}{' '}
                    {selected.lastTest.summary}
                  </p>
                </>
              )}

              {selected.readiness.findings.length > 0 ? (
                <>
                  <div className="uboss-section-label">What is standing in the way</div>
                  {selected.readiness.findings.map((finding, index) => (
                    <p className="uboss-notice-min" key={index}>
                      <Icon name={finding.severity === 'Blocker' ? 'shield' : 'alert'} size={14} />
                      {finding.summary}
                    </p>
                  ))}
                </>
              ) : null}

              {selected.engineAgent === null ? (
                <>
                  <Button
                    size="sm"
                    disabled={busy || !selected.readiness.readyToTest}
                    onClick={run((tenant, assignment) => agentBuilderApi.test(tenant, assignment))}
                    style={{ marginTop: 12, width: '100%' }}
                  >
                    <Icon name="bolt" size={16} />
                    Test agent
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || !selected.readiness.readyToActivate}
                    onClick={run((tenant, assignment) =>
                      agentBuilderApi.activate(tenant, assignment),
                    )}
                    style={{ marginTop: 8, width: '100%' }}
                  >
                    Activate agent
                  </Button>
                </>
              ) : (
                <p className="uboss-notice-min">
                  <Icon name="bot" size={14} />
                  This work runs on a reusable Engine Agent. Changing how it runs is a new version
                  of that agent, not an edit here.
                </p>
              )}

              <p className="uboss-notice-min">
                <Icon name="key" size={14} />A connection is chosen by identity. No credential is
                ever shown on this screen.
              </p>
            </CardBody>
          </Card>
        </div>
      )}

      {/*
        Prompt 40A (CR-03) §4 — Download Job Method Form / Upload Completed Job Method.

        Added *after* the approved two-column layout rather than inside it. The client approved A.
        Skill / Job Overview and B. One-time Job Method + Skill Design with Save Draft, Test Agent,
        Activate Agent and View Objective Form; CR-03 adds two controls and does not license moving
        any of that, so nothing above this line changed.

        `canImport` is the real grant, read from `/my-access`. Download deliberately needs none: the
        person who knows how the work is done is often exactly the person who cannot open this screen.
      */}
      {selected === null || tenantId === null ? null : (
        <JobMethodImportExport
          tenantId={tenantId}
          assignmentId={selected.assignmentId}
          assignmentTitle={selected.prefill.assignedWork}
          objectiveName={selected.prefill.objectiveName}
          assignedToLabel={assignedToLabel}
          canImport={can(myAccess, 'agent-builder', 'EditDraft')}
          onImported={() => void load()}
        />
      )}
    </AppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function AgentBuilderPage() {
  return (
    <Suspense fallback={null}>
      <AgentBuilderInner />
    </Suspense>
  );
}
