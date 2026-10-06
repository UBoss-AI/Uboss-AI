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
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Icon,
  Modal,
  PageHeader,
  StatusBadge,
} from '@uboss/ui';

import { useAccountMenu } from '../../../lib/use-account-menu';
import { useSignedInUser } from '../../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../../lib/active-workspace';
import { blankWorkflowStep, toEditableStep, WorkflowGrid } from '../../../components/WorkflowGrid';
import { parseValidationProblems } from '../../../lib/validation-problems';
import {
  ApiError,
  authApi,
  objectivesApi,
  organizationApi,
  type MeResponse,
  type ObjectiveView,
  type ParsedObjectiveWorkbook,
  type WorkbookProblem,
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

  /*
   * The departments and people this company actually has.
   *
   * Three fields on this form — Department, Objective Owner and Responsible Owner — used to be
   * plain text inputs holding a raw id, with a comment explaining that a picker would mean a
   * second source for the department list. The list is not duplicated here: this reads the
   * Hierarchy module's own endpoints, which is the same source, shown. What it replaces is a form
   * that asked a Head to type a UUID and answered "must be chosen from the list" when they did
   * not — the approved flow is that the creator *selects* a department and a responsible manager.
   */
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<{ userId: string; label: string }[]>([]);
  /*
   * Who this objective may be sent to, which is not everybody.
   *
   * The server's rule is that the Responsible Owner must be an active member and — when both they
   * and the objective's owner have an employment record — in the same reporting line, either
   * above or below. Offering the whole company meant a Head could pick somebody and be refused on
   * save. This asks the server which people pass its own rule, so the list and the validation
   * cannot disagree, and it re-asks whenever the owner changes because the answer depends on them.
   */
  const [sendToOptions, setSendToOptions] = useState<{ userId: string; label: string }[]>([]);

  const [reward, setReward] = useState<ObjectiveRewardPanel>(emptyReward());
  const [rewardOpen, setRewardOpen] = useState(false);
  const [rewardNote, setRewardNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * The refusal, broken into things a person can act on. Derived rather than stored, so it cannot
   * drift from the message it came from.
   */
  const problems = error === null ? [] : parseValidationProblems(error);
  const problemFields = new Set(
    problems.map((problem) => problem.field).filter((field): field is string => field !== null),
  );
  const [notice, setNotice] = useState<string | null>(null);
  /* Whether the grid's free-text cells are showing their full content. See WorkflowGrid. */
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * What an uploaded workbook said, before any of it is applied.
   *
   * Held rather than applied on arrival, because the client's rule is that existing data is never
   * silently destroyed — the file is shown, the conflicts are named, and a person decides.
   */
  const [upload, setUpload] = useState<ParsedObjectiveWorkbook | null>(null);

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  useEffect(() => {
    if (tenantId === null) return;
    void organizationApi
      .departments(tenantId)
      .then((result) =>
        setDepartments(
          result.departments
            .filter((row) => row.archivedAt === null)
            .map((row) => ({ id: row.id, name: row.name })),
        ),
      )
      .catch(() => setDepartments([]));

    void organizationApi
      .hierarchy(tenantId)
      .then((view) =>
        setPeople(
          view.list.map((row) => ({
            userId: row.userId,
            label:
              row.designation === '' ? row.displayName : `${row.displayName} — ${row.designation}`,
          })),
        ),
      )
      .catch(() => setPeople([]));
  }, [tenantId]);

  useEffect(() => {
    const owner = content.objectiveOwnerUserId;
    if (tenantId === null || owner === '') {
      setSendToOptions([]);
      return;
    }
    void objectivesApi
      .responsibleOwnerCandidates(tenantId, owner)
      .then((result) =>
        setSendToOptions(
          result.candidates.map((candidate) => ({
            userId: candidate.userId,
            label:
              candidate.designation === null || candidate.designation === ''
                ? candidate.displayName
                : `${candidate.displayName} — ${candidate.designation}`,
          })),
        ),
      )
      .catch(() => setSendToOptions([]));
  }, [content.objectiveOwnerUserId, tenantId]);

  const signedInUser = useSignedInUser(me);

  const accountMenu = useAccountMenu(me);
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
          // Through toEditableStep: the view carries an `id` per step that the save refuses, so
          // feeding the view straight back made a second save of any existing draft impossible.
          setSteps(
            shown.steps.length === 0 ? [blankWorkflowStep(1)] : shown.steps.map(toEditableStep),
          );
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

  /** Download the Objective carrying whatever is filled in. */
  const downloadWorkbook = useCallback(() => {
    if (!tenantId) return;
    setBusy(true);
    setError(null);
    /*
     * The blank template when there is nothing saved yet.
     *
     * The client's rule has two halves: a blank objective downloads a blank form, and a filled
     * one downloads its current values. Refusing the first half until somebody saves a draft
     * asks them to do the work they were taking the form away to do.
     */
    void (
      objective === null
        ? objectivesApi.downloadWorkbookTemplate(tenantId)
        : objectivesApi.downloadWorkbook(tenantId, objective.id, objective.code)
    )
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'That Objective could not be downloaded.',
        ),
      )
      .finally(() => setBusy(false));
  }, [objective, tenantId]);

  /** Read a returned workbook. Applies nothing — it opens the review below. */
  const uploadWorkbook = useCallback(
    (file: File) => {
      if (!tenantId || objective === null) return;
      setBusy(true);
      setError(null);
      setNotice(null);

      const reader = new FileReader();
      reader.onerror = () => {
        setError('That file could not be read.');
        setBusy(false);
      };
      reader.onload = () => {
        const encoded = String(reader.result ?? '').split(',')[1] ?? '';
        void objectivesApi
          .parseWorkbook(tenantId, objective.id, encoded)
          .then(setUpload)
          .catch((caught: unknown) =>
            setError(caught instanceof ApiError ? caught.message : 'That file could not be read.'),
          )
          .finally(() => setBusy(false));
      };
      reader.readAsDataURL(file);
    },
    [objective, tenantId],
  );

  /**
   * Put the uploaded values into the form.
   *
   * Into the form, not into the database: the draft is saved by Save Draft as it always was, so an
   * upload is reviewed on screen exactly like typing would be. Fields the file did not carry keep
   * what they had — an absent cell is "not filled in", never "clear this".
   */
  const applyUpload = useCallback(() => {
    if (upload === null) return;

    setContent((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(upload.objective)) {
        if (value === undefined || value === '') continue;
        /*
         * The three fields the file carries as names rather than ids are skipped.
         *
         * Resolving "Regulatory Affairs" to a department id is a question about the company, and
         * guessing it here would silently point the objective at the wrong department. They stay
         * as they are and the review says so.
         */
        if (
          key === 'departmentId' ||
          key === 'objectiveOwnerUserId' ||
          key === 'responsibleOwnerUserId'
        ) {
          continue;
        }
        const numeric = key === 'currentWorkload' || key === 'targetCompletionTime';
        (next as Record<string, unknown>)[key] = numeric ? Number(value) : value;
      }
      return next;
    });

    if (upload.steps.length > 0) {
      setSteps(
        upload.steps.map((row, index) => ({
          ...blankWorkflowStep(index + 1),
          ...(row as Partial<Form2WorkflowStep>),
          position: index + 1,
        })),
      );
    }

    setUpload(null);
    setNotice('The file has been put into the form. Nothing is stored until you press Save Draft.');
  }, [upload]);

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

  /*
   * "Empty" is measured on Exact Work alone, because that is the one column the server will not
   * accept a step without. A row with a person's name and no work is still not a step.
   */
  const stepsAreEmpty = steps.every((step) => (step.whatExactWork ?? '').trim() === '');

  const statusCrumb =
    objective === null
      ? 'Draft'
      : ((draft ?? objective.activeVersion ?? objective.versions[0])?.statusLabel ?? 'Draft');

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
        title="Objective — Form 2"
        description="The original Form 2, field-for-field, before AI decomposition."
        breadcrumbs={[
          { label: 'Objective Optimization', href: '/objective' },
          { label: statusCrumb },
        ]}
        actions={
          <>
            {/*
              The status, which the breadcrumb used to carry.

              Inside the shell PageHeader draws only the actions — the top bar already names the
              section, and the client's words for the old arrangement were that it "looks double".
              What went with the trail, though, was the one word on it that was not a repetition:
              whether this objective is a Draft. `statusCrumb` survived in exactly one other
              place, a banner that appears only when a version *cannot* be edited, so an objective
              somebody could still change said nowhere what state it was in.

              It sits at the head of the action row rather than over the first card, because it
              describes the thing those buttons act on.
            */}
            <StatusBadge status={statusCrumb} className="uboss-page-status" />

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
            {/*
              Out of UBoss and back.

              Download carries whatever is filled in — the client's rule is that a partly filled
              objective comes down with its values, not as a blank template. Upload reads the file
              and shows what it found; it saves nothing until somebody agrees to it.
            */}
            <Button
              size="sm"
              onClick={downloadWorkbook}
              disabled={busy}
              title={objective === null ? 'Downloads the blank form, ready to fill in' : undefined}
            >
              <Icon name="arrow-down" size={16} />
              Download Excel
            </Button>

            {/*
              Greyed out says "not now"; it does not say why, and here that was a dead end.

              Download on a new Objective offers the blank form "ready to fill in". Somebody takes
              it, fills it in offline, comes back — and Upload is grey, with nothing on screen to
              explain it. It reads as the upload being broken, and that is how it was reported.
              The read-only case already has a banner; this one had neither banner nor tooltip.

              An upload is read against the Objective it belongs to, so there has to be one first.
              Saying so is the whole fix — the same sentence the Analyze button below already uses
              for the same reason.
            */}
            {/*
              When an upload is not allowed, this says so out loud rather than doing nothing.

              It used to be a label pointing at a disabled input, and a disabled input cannot be
              activated by its label — so pressing Upload Excel on a new Objective produced no
              file dialog, no message, nothing at all. There was a `title`, but a tooltip only
              exists for somebody already hovering and wondering; the person who has just filled
              the file in offline presses the button and concludes the upload is broken. It was
              reported exactly that way, twice.

              So: a label when the upload can happen, and a real button that states the reason
              when it cannot. The reason is the same sentence either way — it is now in the one
              place somebody will actually read it.
            */}
            {busy || readOnly || objective === null ? (
              <Button
                size="sm"
                onClick={() => {
                  setUpload(null);
                  setNotice(null);
                  setError(
                    objective === null
                      ? 'Save the draft first. A filled-in file is read against the Objective it belongs to, so there has to be one before it can be uploaded.'
                      : readOnly
                        ? 'This version is published and cannot be edited, so a file cannot be uploaded into it. An authorised change creates a new draft version to upload into.'
                        : 'Still working on the last request — try again in a moment.',
                  );
                }}
              >
                <Icon name="arrow-up" size={16} />
                Upload Excel
              </Button>
            ) : (
              <label
                className="uboss-btn uboss-btn--sm"
                htmlFor="objective-workbook-file"
                title="Reads a filled-in file and shows what it found; nothing is saved until you agree to it"
              >
                <Icon name="arrow-up" size={16} />
                Upload Excel
              </label>
            )}
            <input
              id="objective-workbook-file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="uboss-sr-only"
              disabled={busy || readOnly || objective === null}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) uploadWorkbook(file);
                // Cleared so re-picking the same file fires the event again.
                event.target.value = '';
              }}
            />

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
        /*
         * A refusal, said in sentences.
         *
         * The server's DTO failures arrive as "content.objectiveName must be longer than or equal
         * to 1 characters", and this banner used to show that verbatim — a property path and a
         * character count, with no field marked, on a form with forty columns. A written domain
         * refusal is passed through untouched; only the generated ones are translated.
         */
        <Banner tone="danger">
          {problems.length === 1 ? (
            problems[0]?.text
          ) : (
            <>
              {problems.length} things need fixing before this can be saved:
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {problems.map((problem) => (
                  // The original is kept on the element, so a bug report can still quote it.
                  <li key={problem.raw} title={problem.raw}>
                    {problem.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Banner>
      )}
      {notice === null ? null : <Banner tone="ok">{notice}</Banner>}
      {!readOnly ? null : (
        <Banner tone="info">
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
                aria-invalid={problemFields.has('objectiveName') || undefined}
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
              {/* The Hierarchy module's own list, shown rather than typed. */}
              <select
                id="departmentId"
                className="uboss-input"
                aria-invalid={problemFields.has('departmentId') || undefined}
                value={content.departmentId}
                disabled={readOnly}
                onChange={(event) => field('departmentId', event.target.value)}
              >
                <option value="">Choose a department…</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="uboss-row-2">
            <div className="uboss-field">
              <label htmlFor="objectiveOwnerUserId">
                Objective Owner <span className="uboss-field-required">*</span>
              </label>
              <select
                id="objectiveOwnerUserId"
                className="uboss-input"
                aria-invalid={problemFields.has('objectiveOwnerUserId') || undefined}
                value={content.objectiveOwnerUserId}
                disabled={readOnly}
                onChange={(event) => field('objectiveOwnerUserId', event.target.value)}
              >
                <option value="">Choose the owner…</option>
                {people.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.label}
                  </option>
                ))}
              </select>
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
              aria-invalid={problemFields.has('expectedFinalResult') || undefined}
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
              {/*
                Who the Objective is routed to for review, from the server's own eligibility rule
                rather than from the whole company. Empty until an owner is chosen, because the
                rule is about the owner's reporting line.
              */}
              <select
                id="responsibleOwnerUserId"
                className="uboss-input"
                aria-invalid={problemFields.has('responsibleOwnerUserId') || undefined}
                value={content.responsibleOwnerUserId ?? ''}
                disabled={readOnly || content.objectiveOwnerUserId === ''}
                onChange={(event) => field('responsibleOwnerUserId', orNull(event.target.value))}
              >
                <option value="">
                  {content.objectiveOwnerUserId === ''
                    ? 'Choose the objective owner first'
                    : 'Nobody yet'}
                </option>
                {sendToOptions.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.label}
                  </option>
                ))}
              </select>
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
        <div className="uboss-wfg-toolbar-actions">
          <Button
            size="sm"
            disabled={readOnly}
            onClick={() =>
              setSteps((current) => [...current, blankWorkflowStep(current.length + 1)])
            }
          >
            <Icon name="plus" size={15} />
            Add Row
          </Button>
          {/*
            A toggle, not a one-way door, and it says which way it is about to go. It stays
            enabled in read-only: reading a long cell is the one thing a reader most needs, and
            nothing here writes.
          */}
          <Button
            size="sm"
            aria-pressed={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? 'Collapse long text' : 'Expand long text'}
          </Button>
        </div>
      </div>

      <WorkflowGrid steps={steps} onChange={setSteps} readOnly={readOnly} expanded={expanded} />

      {/*
        Nothing typed yet, said plainly.

        The grid opens on one blank row because it cannot open on none — deleting the last row
        would leave nowhere to start typing. But a single row of empty boxes, each with the grey
        fill an editable cell carries, reads as a table that failed to load. The reference never
        showed this: it shipped four filled rows.

        The floor for "started" is the one column the server requires. Checking every column would
        make the line vanish the moment somebody typed a person's name and leave them with no
        guidance while the row was still unusable.
      */}
      {stepsAreEmpty ? (
        <p className="uboss-wfg-empty-note">
          {readOnly
            ? 'No workflow steps were recorded on this version.'
            : 'No steps yet. Describe the first one under Exact Work, then add a row for each step that follows.'}
        </p>
      ) : null}

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
      {/*
        The upload review.

        The whole point of the feature: an uploaded file is shown before it touches anything. Four
        different facts are kept apart rather than collapsed into "error" — Missing is a blank the
        form requires, Invalid is a value outside a closed list, Unmapped is a column UBoss has no
        field for, and a conflict is a value that would replace one already typed. Only the last of
        those is the person's decision; the first three are the file's.
      */}
      <Modal
        open={upload !== null}
        title="Review the uploaded Objective"
        wide
        onClose={() => setUpload(null)}
        footer={
          <>
            <Button onClick={() => setUpload(null)}>Discard</Button>
            <Button variant="primary" onClick={applyUpload}>
              Put it into the form
            </Button>
          </>
        }
      >
        {upload === null ? null : (
          <>
            <p className="uboss-muted">
              The file carries {Object.keys(upload.objective).length} Objective field
              {Object.keys(upload.objective).length === 1 ? '' : 's'} and {upload.steps.length} step
              {upload.steps.length === 1 ? '' : 's'}. Nothing is saved: pressing the button below
              puts these values into the form, and the draft is stored only when you press Save
              Draft.
            </p>

            {/*
              What would be replaced.

              Computed here rather than by the server, because the server has no idea what is
              currently typed into this form — the conflict is between the file and the screen.
            */}
            {(() => {
              const conflicts = Object.entries(upload.objective).filter(([key, value]) => {
                if (value === undefined || value === '') return false;
                const existing = (content as unknown as Record<string, unknown>)[key];
                return (
                  existing !== null &&
                  existing !== undefined &&
                  String(existing) !== '' &&
                  String(existing) !== value
                );
              });
              return conflicts.length === 0 ? null : (
                <Banner tone="warn">
                  {conflicts.length} field{conflicts.length === 1 ? '' : 's'} already filled in
                  would be replaced: {conflicts.map(([key]) => key).join(', ')}.
                </Banner>
              );
            })()}

            {upload.steps.length > 0 ? (
              <Banner tone="info">
                The {steps.length} step{steps.length === 1 ? '' : 's'} in the grid would be replaced
                by the {upload.steps.length} in the file. Steps are a list, not a merge — a partial
                overlay would leave rows nobody wrote.
              </Banner>
            ) : null}

            {upload.problems.length === 0 ? (
              <Banner tone="ok">Every column was understood.</Banner>
            ) : (
              <DataTable
                caption="What the file got wrong"
                columns={[
                  { key: 'where', header: 'Where', render: (row: WorkbookProblem) => row.where },
                  { key: 'field', header: 'Field', render: (row: WorkbookProblem) => row.field },
                  {
                    key: 'kind',
                    header: '',
                    render: (row: WorkbookProblem) => (
                      <StatusBadge
                        status={row.kind}
                        tone={
                          row.kind === 'Missing'
                            ? 'warn'
                            : row.kind === 'Invalid'
                              ? 'danger'
                              : 'grey'
                        }
                      />
                    ),
                  },
                  {
                    key: 'detail',
                    header: 'Detail',
                    render: (row: WorkbookProblem) => (
                      <small className="uboss-muted-3">{row.detail}</small>
                    ),
                  },
                ]}
                rows={upload.problems}
                // Where + field + kind is unique per problem: the same field is never reported
                // Missing and Invalid at once.
                rowKey={(row: WorkbookProblem) => `${row.where}-${row.field}-${row.kind}`}
              />
            )}

            <p className="uboss-muted-3">
              Department, Objective Owner and Responsible Owner are carried in the file as names and
              are <b>not</b> applied: matching a name to a person is a question about this company,
              and guessing it would point the Objective at the wrong one. Set those on the form.
            </p>
          </>
        )}
      </Modal>
    </RoutedAppShell>
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
