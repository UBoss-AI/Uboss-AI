'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import {
  FORM2_SECTION_LABELS,
  FORM2_WORKFLOW_COLUMN_COUNT,
  REWARD_TYPE_LABELS,
  REWARD_TYPES,
  TIME_UNIT_LABELS,
  TIME_UNITS,
  type Form2Objective,
  type Form2WorkflowStep,
  type ObjectiveRewardPanel,
  type RewardType,
  type TimeUnit,
} from '@uboss/types';
import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  Drawer,
  Icon,
  PageHeader,
} from '@uboss/ui';

import { blankWorkflowStep, WorkflowGrid } from '../../../components/WorkflowGrid';
import {
  ApiError,
  authApi,
  objectivesApi,
  type MeResponse,
  type ObjectiveView,
} from '../../../lib/api-client';
import { useNotificationBell } from '../../../lib/use-notification-bell';
import { DiscussButton } from '../../../components/DiscussButton';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

/** An empty Form 2. The three reference fields with no sensible blank stay empty strings. */
function emptyForm2(): Form2Objective {
  return {
    objectiveName: '',
    departmentId: '',
    objectiveOwnerUserId: '',
    expectedFinalResult: '',
    currentWorkload: null,
    unit: null,
    targetCompletionTime: null,
    timeUnit: null,
    preparedBy: null,
    formDate: null,
    responsibleOwnerUserId: null,
    executionTeam: null,
  };
}

function emptyReward(): ObjectiveRewardPanel {
  return {
    applicable: false,
    rewardType: null,
    amountMinorUnits: null,
    eligibilityCondition: null,
    completionDeadline: null,
    evidence: null,
    approverUserId: null,
  };
}

/** `null` for a cleared optional field, so clearing it actually clears it on the server. */
function orNull(value: string): string | null {
  return value.trim() === '' ? null : value;
}

function numberOrNull(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Objective — Form 2. The reference's `objForm()`, element for element.
 *
 * Two cards, in the reference's order and with its captions: the source form, then the UBoss
 * routing controls in their own card so nobody mistakes a platform control for a source field.
 * Then the grid toolbar, the fifteen-column grid, and the footnote. The four page actions are the
 * reference's, in its order: Performance & Reward, Save Draft, Submit for Review, and Analyze &
 * Generate Workflow.
 *
 * ## What is deliberately different from the prototype
 *
 * Three things, each recorded in `docs/UX_MAP.md`:
 *
 *   1. **The prototype's fields are prefilled with a worked example.** A real screen starts
 *      empty. Carrying the fixture forward would show every new objective as a GSPR checklist.
 *   2. **The reward drawer has the seven fields the client's latest requirement names** —
 *      Applicable, Type, Amount/Points, Eligibility Condition, Completion Deadline, Evidence,
 *      Approver — where the prototype's drawer predates that amendment and has three. The latest
 *      client amendment wins over the earlier prototype.
 *   3. **Analyze & Generate Workflow is present but disabled**, because the AI analysis it opens
 *      is a later prompt. A button that silently did nothing would be worse than one that says
 *      why it is not available.
 */
function ObjectiveFormInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const params = useSearchParams();
  const objectiveId = params.get('objectiveId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [objective, setObjective] = useState<ObjectiveView | null>(null);
  const [content, setContent] = useState<Form2Objective>(emptyForm2());
  const [steps, setSteps] = useState<Form2WorkflowStep[]>([blankWorkflowStep(1)]);
  const [reward, setReward] = useState<ObjectiveRewardPanel>(emptyReward());
  const [rewardOpen, setRewardOpen] = useState(false);
  const [rewardNote, setRewardNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
  const bell = useNotificationBell(tenantId);

  const draft = objective?.openDraft ?? null;
  const readOnly = objective !== null && draft === null;

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your workspaces.'),
      );
  }, []);

  useEffect(() => {
    if (!tenantId || objectiveId === null) return;

    void objectivesApi
      .view(tenantId, objectiveId)
      .then((loaded) => {
        setObjective(loaded);
        const shown = loaded.openDraft ?? loaded.activeVersion ?? loaded.versions[0] ?? null;
        if (shown) {
          setContent(shown.content);
          setSteps(shown.steps.length === 0 ? [blankWorkflowStep(1)] : shown.steps);
        }
        if (loaded.reward) {
          setReward(loaded.reward);
          setRewardNote(loaded.reward.note);
        }
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load that objective.'),
      );
  }, [objectiveId, tenantId]);

  const field = useCallback(
    <K extends keyof Form2Objective>(key: K, value: Form2Objective[K]) =>
      setContent((current) => ({ ...current, [key]: value })),
    [],
  );

  const save = useCallback(() => {
    if (!tenantId) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    const done = (saved: ObjectiveView) => {
      setObjective(saved);
      setNotice(`Draft saved as ${saved.code}.`);
      setBusy(false);
    };
    const failed = (caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : 'Could not save this draft.');
      setBusy(false);
    };

    if (objective === null) {
      void objectivesApi.create(tenantId, { content, steps }).then(done).catch(failed);
      return;
    }
    void objectivesApi
      .saveDraft(tenantId, objective.id, {
        content,
        steps,
        ...(draft === null ? {} : { versionId: draft.id }),
      })
      .then(done)
      .catch(failed);
  }, [content, draft, objective, steps, tenantId]);

  const submit = useCallback(() => {
    if (!tenantId || objective === null) {
      setError('Save this draft before submitting it for review.');
      return;
    }
    setBusy(true);
    setError(null);

    void objectivesApi
      .submit(tenantId, objective.id, draft?.id)
      .then((saved) => {
        setObjective(saved);
        setNotice('Submitted for review.');
        setBusy(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not submit this objective.');
        setBusy(false);
      });
  }, [draft, objective, tenantId]);

  const saveReward = useCallback(() => {
    if (!tenantId || objective === null) {
      setError('Save the objective before attaching a reward to it.');
      return;
    }
    setBusy(true);

    void objectivesApi
      .saveReward(tenantId, objective.id, reward)
      .then((saved) => {
        setReward(saved);
        setRewardNote(saved.note);
        setRewardOpen(false);
        setNotice('Reward settings saved. Nothing is payable until the reward workflow approves.');
        setBusy(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not save the reward panel.');
        setBusy(false);
      });
  }, [objective, reward, tenantId]);

  const statusCrumb =
    objective === null
      ? 'Draft'
      : ((draft ?? objective.activeVersion ?? objective.versions[0])?.statusLabel ?? 'Draft');

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="objective"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Objective Builder' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Objective — Form 2"
        description="The original Form 2, field-for-field, before AI decomposition."
        breadcrumbs={[
          { label: 'Objective Optimization', href: '/objective' },
          { label: statusCrumb },
        ]}
        actions={
          <>
            {/* Fixing one of the seven prototype defects:  was orphaned,
                reachable by no link at all. */}
            {objective === null ? null : (
              <Link href={`/objective/versions?objectiveId=${encodeURIComponent(objective.id)}`}>
                <Button size="sm">
                  <Icon name="list" size={16} />
                  Versions
                </Button>
              </Link>
            )}
            {/* Prompt 40A (CR-03) §6 — discuss this objective with named colleagues. */}
            {objective === null ? null : (
              <DiscussButton
                tenantId={tenantId}
                contextType="Objective"
                resourceId={objective.id}
              />
            )}
            <Button size="sm" onClick={() => setRewardOpen(true)} disabled={objective === null}>
              <Icon name="medal" size={16} />
              Performance &amp; Reward
            </Button>
            <Button size="sm" onClick={save} disabled={busy || readOnly}>
              Save Draft
            </Button>
            <Button size="sm" onClick={submit} disabled={busy || readOnly}>
              Submit for Review
            </Button>
            {/* Live at Prompt 21. Disabled until the objective is saved, because there is nothing
                to analyse before that — the analysis reads the stored Form 2 grid. */}
            {objective === null ? (
              <Button variant="primary" size="sm" disabled title="Save the draft first">
                Analyze &amp; Generate Workflow
              </Button>
            ) : (
              <Link href={`/objective/analyze?objectiveId=${encodeURIComponent(objective.id)}`}>
                <Button variant="primary" size="sm">
                  Analyze &amp; Generate Workflow
                </Button>
              </Link>
            )}
          </>
        }
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
      {!readOnly ? null : (
        <Banner tone="info">
          <Icon name="shield" size={16} />
          This version is {statusCrumb.toLowerCase()} and cannot be edited. An authorised change
          creates a new draft version; it never rewrites the version that is live.
        </Banner>
      )}

      {/* ---- Card 1: the source form ---- */}
      <Card>
        <CardBody>
          <div className="uboss-section-label" style={{ marginTop: 0 }}>
            {FORM2_SECTION_LABELS.SourceForm2}
          </div>

          <div className="uboss-row-2">
            <div className="uboss-field">
              <label htmlFor="objectiveName">
                Objective Name <span className="uboss-field-required">*</span>
              </label>
              <input
                id="objectiveName"
                value={content.objectiveName}
                readOnly={readOnly}
                maxLength={200}
                onChange={(event) => field('objectiveName', event.target.value)}
              />
            </div>
            <div className="uboss-field">
              <label htmlFor="departmentId">
                Department <span className="uboss-field-required">*</span>
              </label>
              {/* An id field rather than a picker: the department list is the Hierarchy module's,
                  and inventing a second source for it here is how two lists come to disagree. */}
              <input
                id="departmentId"
                value={content.departmentId}
                readOnly={readOnly}
                placeholder="Department"
                onChange={(event) => field('departmentId', event.target.value)}
              />
            </div>
          </div>

          <div className="uboss-row-2">
            <div className="uboss-field">
              <label htmlFor="objectiveOwnerUserId">
                Objective Owner <span className="uboss-field-required">*</span>
              </label>
              <input
                id="objectiveOwnerUserId"
                value={content.objectiveOwnerUserId}
                readOnly={readOnly}
                placeholder="Objective Owner"
                onChange={(event) => field('objectiveOwnerUserId', event.target.value)}
              />
            </div>
            <div className="uboss-field">
              <label htmlFor="preparedBy">Prepared By</label>
              <input
                id="preparedBy"
                value={content.preparedBy ?? ''}
                readOnly={readOnly}
                maxLength={160}
                onChange={(event) => field('preparedBy', orNull(event.target.value))}
              />
            </div>
          </div>

          <div className="uboss-field">
            <label htmlFor="expectedFinalResult">
              Expected Final Result <span className="uboss-field-required">*</span>
            </label>
            <textarea
              id="expectedFinalResult"
              rows={3}
              value={content.expectedFinalResult}
              readOnly={readOnly}
              maxLength={4000}
              onChange={(event) => field('expectedFinalResult', event.target.value)}
            />
          </div>

          <div className="uboss-row-2">
            <div className="uboss-field">
              <label htmlFor="currentWorkload">Current Workload</label>
              <input
                id="currentWorkload"
                type="number"
                min={0}
                value={content.currentWorkload ?? ''}
                readOnly={readOnly}
                onChange={(event) => field('currentWorkload', numberOrNull(event.target.value))}
              />
            </div>
            <div className="uboss-field">
              <label htmlFor="unit">Unit</label>
              <input
                id="unit"
                value={content.unit ?? ''}
                readOnly={readOnly}
                maxLength={60}
                onChange={(event) => field('unit', orNull(event.target.value))}
              />
            </div>
          </div>

          <div className="uboss-row-2">
            <div className="uboss-field">
              <label htmlFor="targetCompletionTime">Target Completion Time</label>
              <input
                id="targetCompletionTime"
                type="number"
                min={0}
                value={content.targetCompletionTime ?? ''}
                readOnly={readOnly}
                onChange={(event) =>
                  field('targetCompletionTime', numberOrNull(event.target.value))
                }
              />
            </div>
            <div className="uboss-field">
              <label htmlFor="timeUnit">Time Unit</label>
              <select
                id="timeUnit"
                value={content.timeUnit ?? ''}
                disabled={readOnly}
                onChange={(event) =>
                  field(
                    'timeUnit',
                    event.target.value === '' ? null : (event.target.value as TimeUnit),
                  )
                }
              >
                <option value="">—</option>
                {TIME_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {TIME_UNIT_LABELS[unit]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="uboss-field" style={{ maxWidth: '50%' }}>
            <label htmlFor="formDate">Date</label>
            <input
              id="formDate"
              type="date"
              value={content.formDate ?? ''}
              readOnly={readOnly}
              onChange={(event) => field('formDate', orNull(event.target.value))}
            />
          </div>

          <p className="uboss-notice-min">
            <Icon name="file" size={14} />
            Unit and Time Unit are kept as separate source inputs — never collapsed. No source field
            is dropped, renamed or merged.
          </p>
        </CardBody>
      </Card>

      {/* ---- Card 2: UBoss routing controls, in their own card ---- */}
      <Card className="uboss-card--routing">
        <CardBody>
          <div className="uboss-section-label" style={{ marginTop: 0 }}>
            {FORM2_SECTION_LABELS.UbossRouting}
          </div>
          <div className="uboss-row-2">
            <div className="uboss-field">
              <label htmlFor="responsibleOwnerUserId">Responsible Owner / Send To</label>
              <input
                id="responsibleOwnerUserId"
                value={content.responsibleOwnerUserId ?? ''}
                readOnly={readOnly}
                onChange={(event) => field('responsibleOwnerUserId', orNull(event.target.value))}
              />
            </div>
            <div className="uboss-field">
              <label htmlFor="executionTeam">Execution Team</label>
              <input
                id="executionTeam"
                value={content.executionTeam ?? ''}
                readOnly={readOnly}
                maxLength={200}
                onChange={(event) => field('executionTeam', orNull(event.target.value))}
              />
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ---- The grid ---- */}
      <div className="uboss-wfg-toolbar">
        <div className="uboss-section-label" style={{ margin: 0, border: 0 }}>
          Workflow steps (source grid — {FORM2_WORKFLOW_COLUMN_COUNT} columns)
        </div>
        <Button
          size="sm"
          disabled={readOnly}
          onClick={() => setSteps((current) => [...current, blankWorkflowStep(current.length + 1)])}
        >
          <Icon name="plus" size={15} />
          Add Row
        </Button>
      </div>

      <WorkflowGrid steps={steps} onChange={setSteps} readOnly={readOnly} />

      <p className="uboss-notice-min">
        <Icon name="shield" size={14} />
        Grouped sticky headers, sticky Step column, horizontal scroll, per-row Insert / Duplicate /
        Delete / Reorder. Row count is not fixed. Save / Submit / Analyze and Reward stay outside
        the grid.
      </p>

      {/* ---- The Performance & Reward drawer ---- */}
      <Drawer
        open={rewardOpen}
        onClose={() => setRewardOpen(false)}
        title="Performance & Reward (optional)"
        footer={
          <>
            <Button onClick={() => setRewardOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveReward} disabled={busy}>
              Save reward settings
            </Button>
          </>
        }
      >
        <Banner tone="info">
          <Icon name="medal" size={16} />
          This panel is separate from the canonical Form 2 fields and never edits them. Recording a
          reward does not pay it: eligibility and approval are decided by the reward workflow.
        </Banner>

        <label className="uboss-checkbox" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={reward.applicable}
            onChange={(event) =>
              setReward((current) => ({ ...current, applicable: event.target.checked }))
            }
          />
          Reward / Bonus Applicable
        </label>

        <div className="uboss-field">
          <label htmlFor="rewardType">Reward Type</label>
          <select
            id="rewardType"
            value={reward.rewardType ?? ''}
            onChange={(event) =>
              setReward((current) => ({
                ...current,
                rewardType: event.target.value === '' ? null : (event.target.value as RewardType),
              }))
            }
          >
            <option value="">—</option>
            {REWARD_TYPES.map((type) => (
              <option key={type} value={type}>
                {REWARD_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>

        <div className="uboss-field">
          <label htmlFor="amountMinorUnits">Amount / Points</label>
          <input
            id="amountMinorUnits"
            type="number"
            min={0}
            value={reward.amountMinorUnits ?? ''}
            onChange={(event) =>
              setReward((current) => ({
                ...current,
                amountMinorUnits: numberOrNull(event.target.value),
              }))
            }
          />
          <p className="uboss-field-hint">
            Whole units — minor units for cash, whole points for points.
          </p>
        </div>

        <div className="uboss-field">
          <label htmlFor="eligibilityCondition">Eligibility Condition</label>
          <textarea
            id="eligibilityCondition"
            rows={2}
            maxLength={2000}
            value={reward.eligibilityCondition ?? ''}
            onChange={(event) =>
              setReward((current) => ({
                ...current,
                eligibilityCondition: orNull(event.target.value),
              }))
            }
          />
        </div>

        <div className="uboss-field">
          <label htmlFor="completionDeadline">Completion Deadline</label>
          <input
            id="completionDeadline"
            type="date"
            value={reward.completionDeadline ?? ''}
            onChange={(event) =>
              setReward((current) => ({
                ...current,
                completionDeadline: orNull(event.target.value),
              }))
            }
          />
        </div>

        <div className="uboss-field">
          <label htmlFor="evidence">Evidence</label>
          <textarea
            id="evidence"
            rows={2}
            maxLength={2000}
            value={reward.evidence ?? ''}
            onChange={(event) =>
              setReward((current) => ({ ...current, evidence: orNull(event.target.value) }))
            }
          />
        </div>

        <div className="uboss-field">
          <label htmlFor="approverUserId">Approver</label>
          <input
            id="approverUserId"
            value={reward.approverUserId ?? ''}
            onChange={(event) =>
              setReward((current) => ({ ...current, approverUserId: orNull(event.target.value) }))
            }
          />
        </div>

        {rewardNote === null ? null : <p className="uboss-notice-min">{rewardNote}</p>}
      </Drawer>
    </AppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function ObjectiveFormPage() {
  return (
    <Suspense fallback={null}>
      <ObjectiveFormInner />
    </Suspense>
  );
}
