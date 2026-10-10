'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import type { PrePublishSummary } from '@uboss/types';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  Icon,
  MetricCard,
  PageHeader,
  StatusBadge,
} from '@uboss/ui';

import {
  ApiError,
  assignmentApi,
  authApi,
  workflowEditorApi,
  type AssignmentResultView,
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
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

/** One row of the reference's Readiness table. */
interface ReadinessRow {
  check: string;
  ready: 'Ready' | 'Blocked' | 'Review';
  detail: string;
}

/**
 * The reference's readiness checks, answered from the summary.
 *
 * The prototype hard-codes five rows with fixture detail ("Drive + Gmail healthy",
 * "$0.42/run · dept budget OK"). These are the same five *checks*, each answered from what the
 * server computed — so a row that says Ready means the server found nothing, not that a fixture
 * said so.
 */
function readinessRows(summary: PrePublishSummary): ReadinessRow[] {
  const unassigned = summary.findings.filter((finding) =>
    finding.summary.includes('no owner'),
  ).length;
  const highRiskUngated = summary.findings.filter(
    (finding) => finding.severity === 'Blocker' && finding.summary.includes('high-risk'),
  ).length;
  /*
   * Defaulted, because the API and the web app are separate containers and a deploy restarts them
   * one at a time. For the minute in between, this page can be the new build reading a summary the
   * old one wrote, and that summary has neither of these two fields. Reading `.includes` off
   * `undefined` would throw and the manager would get a blank readiness screen — which is a worse
   * failure than the absent nicety. Empty is also the honest reading of a server that does not
   * know the difference yet: nothing is marked unconfirmed, so every finding keeps the severity
   * that server gave it.
   */
  const inferredMissing = summary.inferredMissingConnections ?? [];
  const inferredHighRisk = summary.inferredHighRiskNodes ?? [];
  const confirmedMissing = summary.missingConnections.filter(
    (category) => !inferredMissing.includes(category),
  );

  return [
    {
      check: 'All nodes assigned',
      ready: unassigned === 0 ? 'Ready' : 'Blocked',
      detail:
        unassigned === 0
          ? `${summary.affectedUserIds.length} owner${
              summary.affectedUserIds.length === 1 ? '' : 's'
            } set across ${summary.humanNodeCount} human step${
              summary.humanNodeCount === 1 ? '' : 's'
            }`
          : `${unassigned} human step${unassigned === 1 ? '' : 's'} with no owner`,
    },
    {
      check: 'Skills approved',
      ready: summary.nodesNeedingNewSkill.length === 0 ? 'Ready' : 'Blocked',
      detail:
        summary.nodesNeedingNewSkill.length === 0
          ? `${summary.skillVersionIds.length} approved Skill version${
              summary.skillVersionIds.length === 1 ? '' : 's'
            } reused`
          : `${summary.nodesNeedingNewSkill.length} AI step${
              summary.nodesNeedingNewSkill.length === 1 ? '' : 's'
            } need a Skill that does not exist yet`,
    },
    {
      check: 'Connections valid',
      // A category wanted only by steps whose tools the analysis inferred is a suggestion nobody
      // has confirmed, so it reads as Review. The server grades it the same way and Approve &
      // Assign no longer refuses on it; showing "Blocked" here would contradict both.
      ready:
        confirmedMissing.length > 0 ? 'Blocked' : inferredMissing.length > 0 ? 'Review' : 'Ready',
      detail:
        confirmedMissing.length > 0
          ? `No live connection provides: ${confirmedMissing.join(', ')}`
          : inferredMissing.length > 0
            ? `The analysis thinks a step needs ${inferredMissing.join(
                ', ',
              )}, which no connection provides. Nobody has confirmed that`
            : 'Every tool the plan needs has a live grant',
    },
    {
      check: 'Estimated AI usage',
      // Deliberately not a pass/fail. The prototype asserts "dept budget OK" against a fabricated
      // dollar figure; no budget check exists yet, so this reports the range and says so.
      ready: 'Review',
      detail: `${summary.estimatedUsage.minTokens.toLocaleString()}–${summary.estimatedUsage.maxTokens.toLocaleString()} tokens per run · no budget limit is configured to check it against`,
    },
    {
      check: 'High-impact actions',
      ready:
        highRiskUngated > 0 ? 'Blocked' : summary.highRiskNodes.length > 0 ? 'Review' : 'Ready',
      /*
       * Three sentences, because there are now three situations and the old two-way text lied in
       * the third. A step the analysis read as high-risk and that has no gate used to be
       * impossible; it is reported, it does not block, and saying "all behind an approval" about
       * it would be false on the one row a reader relies on most.
       */
      detail:
        summary.highRiskNodes.length === 0
          ? 'No high-risk tool categories in this plan'
          : highRiskUngated > 0
            ? `${highRiskUngated} high-risk step${
                highRiskUngated === 1 ? '' : 's'
              } with no approval gate`
            : inferredHighRisk.length > 0
              ? `${inferredHighRisk.length} step${
                  inferredHighRisk.length === 1 ? '' : 's'
                } the analysis reads as high-risk, not confirmed by anybody yet`
              : `${summary.highRiskNodes.length} high-risk step${
                  summary.highRiskNodes.length === 1 ? '' : 's'
                }, all behind an approval`,
    },
  ];
}

/**
 * Pre-Publish Summary — the reference's `objPrepublish()`.
 *
 * Its shape: a row of stat cards, a Readiness table with a "Ready to assign" badge, a closing
 * banner, and Back / Publish objective in the action row.
 *
 * ## Three recorded departures from the prototype
 *
 *   1. **No fabricated cost.** The prototype's seventh stat card is `Est. AI cost / run $0.42`
 *      and its budget row asserts "dept budget OK". Nothing in the product computes a currency
 *      cost or holds a departmental budget, so the card shows the **token range** the server
 *      estimated and the row says plainly that there is no limit configured to check against.
 *      Inventing a dollar figure next to an approval button is the worst version of the
 *      fixture-as-truth mistake.
 *   2. **Test Workflow is present and disabled.** The client lists it; nothing can execute a
 *      workflow yet. A button that appeared to test and did nothing would be worse than one that
 *      says why it cannot.
 *   3. **Approve & Assign is enabled even when the summary reports blockers.** The server is the
 *      authority on readiness and revalidates everything inside its transaction; a button
 *      disabled by a client-side copy of that judgement is how a manager ends up unable to
 *      publish a plan that is actually fine. Pressing it either assigns everything or refuses and
 *      names every reason — which is more useful than a button that will not say why.
 */
function PrePublishInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const params = useSearchParams();
  const objectiveId = params.get('objectiveId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [summary, setSummary] = useState<PrePublishSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [assigned, setAssigned] = useState<AssignmentResultView | null>(null);
  const [confirmPublishOpen, setConfirmPublishOpen] = useState(false);

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
    if (!tenantId || objectiveId === null) return;
    setError(null);

    void workflowEditorApi
      .prePublish(tenantId, objectiveId)
      .then(setSummary)
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load the readiness summary.',
        ),
      );
  }, [objectiveId, tenantId]);

  useEffect(load, [load]);

  const rows = summary === null ? [] : readinessRows(summary);
  const blockers = summary?.findings.filter((finding) => finding.severity === 'Blocker') ?? [];
  const warnings = summary?.findings.filter((finding) => finding.severity === 'Warning') ?? [];

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
        title="Pre-Publish Summary"
        description="Final impact and readiness before work becomes actionable."
        breadcrumbs={[
          { label: 'Objective Optimization', href: '/objective' },
          { label: 'Pre-Publish' },
        ]}
        actions={
          <>
            <Link href={`/objective/workflow?objectiveId=${encodeURIComponent(objectiveId ?? '')}`}>
              <Button size="sm">
                <Icon name="back" size={16} />
                Back
              </Button>
            </Link>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || summary === null}
              onClick={() => setConfirmPublishOpen(true)}
            >
              Publish objective
            </Button>
          </>
        }
      />

      {assigned === null ? null : (
        <Banner tone="ok">
          V{assigned.versionNumber} is live. {assigned.humanTaskIds.length} human task(s) assigned,{' '}
          {assigned.aiAssignmentIds.length} AI step(s) awaiting Agent Builder setup,{' '}
          {assigned.approvalRequestIds.length} approval(s) queued. {assigned.note}
        </Banner>
      )}

      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      {summary === null ? (
        <p className="uboss-muted">Loading the readiness summary…</p>
      ) : (
        <>
          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 16 }}
          >
            <MetricCard label="Employees affected" value={String(summary.affectedUserIds.length)} />
            <MetricCard label="Human steps" value={String(summary.humanNodeCount)} />
            <MetricCard label="AI steps" value={String(summary.aiNodeCount)} />
            <MetricCard label="Approvals" value={String(summary.approvalGateCount)} />
            <MetricCard label="Skills reused" value={String(summary.skillVersionIds.length)} />
            <MetricCard
              label="Skills still needed"
              value={String(summary.nodesNeedingNewSkill.length)}
            />
            <MetricCard
              label="Missing connections"
              value={String(summary.missingConnections.length)}
            />
            {/*
              Where the prototype shows a fabricated "$0.42 / run". A range in tokens is what the
              server actually derived; a single currency figure would read as a quote, and no
              provider is priced yet.
            */}
            <MetricCard
              label="Est. AI usage / run (tokens)"
              value={`${summary.estimatedUsage.minTokens.toLocaleString()}–${summary.estimatedUsage.maxTokens.toLocaleString()}`}
              delta={summary.estimatedUsage.basis}
            />
          </div>

          <Card>
            <CardHeader
              title="Readiness"
              aside={
                <StatusBadge
                  tone={summary.readyToAssign ? 'success' : 'danger'}
                  status={summary.readyToAssign ? 'Ready to assign' : `${blockers.length} blocking`}
                />
              }
            />
            <DataTable
              caption="Readiness checks"
              rowKey={(row: ReadinessRow) => row.check}
              rows={rows}
              emptyTitle="No checks"
              emptyDescription="The readiness summary produced no checks."
              columns={[
                { key: 'check', header: 'Check', render: (row: ReadinessRow) => row.check },
                {
                  key: 'status',
                  header: 'Status',
                  render: (row: ReadinessRow) => (
                    <StatusBadge
                      tone={
                        row.ready === 'Ready'
                          ? 'success'
                          : row.ready === 'Review'
                            ? 'warn'
                            : 'danger'
                      }
                      status={row.ready}
                    />
                  ),
                },
                {
                  key: 'detail',
                  header: 'Detail',
                  render: (row: ReadinessRow) => <span className="uboss-muted">{row.detail}</span>,
                },
              ]}
            />
          </Card>

          {summary.incompleteNodes.length === 0 ? null : (
            <Card>
              <CardBody>
                <div className="uboss-section-label" style={{ marginTop: 0 }}>
                  Incomplete Definition of Done
                </div>
                {summary.incompleteNodes.map((entry) => (
                  <div className="uboss-kv" key={entry.nodeId}>
                    <span className="uboss-kv-key uboss-mono">{entry.nodeId}</span>
                    <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                      missing {entry.missing.join(', ')}
                    </span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {summary.workloadConflicts.length === 0 ? null : (
            <Card>
              <CardBody>
                <div className="uboss-section-label" style={{ marginTop: 0 }}>
                  Workload conflicts
                </div>
                {summary.workloadConflicts.map((conflict) => (
                  <div className="uboss-kv" key={conflict.userId}>
                    <span className="uboss-kv-key uboss-mono">{conflict.userId.slice(0, 8)}</span>
                    <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                      {conflict.nodeIds.length} steps set to run at the same time:{' '}
                      {conflict.nodeIds.join(', ')}
                    </span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {blockers.length === 0 ? null : (
            <Card>
              <CardBody>
                <div className="uboss-section-label" style={{ marginTop: 0 }}>
                  What is blocking
                </div>
                {blockers.map((finding, index) => (
                  <p className="uboss-notice-min" key={index}>
                    <Icon name="alert" size={14} />
                    {finding.nodeId === null ? '' : `${finding.nodeId}: `}
                    {finding.summary}
                  </p>
                ))}
              </CardBody>
            </Card>
          )}

          {warnings.length === 0 ? null : (
            <Card>
              <CardBody>
                <div className="uboss-section-label" style={{ marginTop: 0 }}>
                  Worth knowing
                </div>
                {warnings.map((finding, index) => (
                  <p className="uboss-notice-min" key={index}>
                    <Icon name="file" size={14} />
                    {finding.nodeId === null ? '' : `${finding.nodeId}: `}
                    {finding.summary}
                  </p>
                ))}
              </CardBody>
            </Card>
          )}

          <Banner tone={summary.readyToAssign ? 'ok' : 'warn'} className="uboss-mt-4">
            <Icon name={summary.readyToAssign ? 'check' : 'alert'} size={18} />
            {summary.note}
          </Banner>
        </>
      )}
      <ConfirmDialog
        open={confirmPublishOpen}
        onCancel={() => setConfirmPublishOpen(false)}
        onConfirm={() => {
          if (!tenantId || objectiveId === null) return;
          setConfirmPublishOpen(false);
          setBusy(true);
          setError(null);
          setAssigned(null);

          void assignmentApi
            .approveAndAssign(tenantId, objectiveId, { acceptWarnings: true })
            .then((result) => {
              setAssigned(result);
              setBusy(false);
              load();
            })
            .catch((caught: unknown) => {
              setError(
                caught instanceof ApiError ? caught.message : 'That could not be published.',
              );
              setBusy(false);
            });
        }}
        title="Publish this objective?"
        description="The objective will go live and its work steps will be assigned now. You can’t edit this published workflow; changes will start a new version."
        impact={
          summary === null
            ? []
            : [
                {
                  label: 'Employees receiving work',
                  value: String(summary.affectedUserIds.length),
                },
                { label: 'Human steps', value: String(summary.humanNodeCount) },
                { label: 'AI steps', value: String(summary.aiNodeCount) },
              ]
        }
        confirmLabel="Publish objective"
        cancelLabel="Go back and review"
      />
    </RoutedAppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function PrePublishPage() {
  return (
    <Suspense fallback={null}>
      <PrePublishInner />
    </Suspense>
  );
}
