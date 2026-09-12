'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Banner, Button, Card, CardBody, Icon, StatusBadge } from '@uboss/ui';

import {
  ApiError,
  jobMethodApi,
  type ImportOutcomeView,
  type ImportProblemRow,
} from '../lib/api-client';

export interface JobMethodImportExportProps {
  tenantId: string;
  assignmentId: string;
  /** Shown on the review so a builder can see they imported into the right work. */
  assignmentTitle: string;
  objectiveName: string;
  assignedToLabel: string | null;
  /** True when this person holds `agent-builder:EditDraft`. Download needs no builder grant. */
  canImport: boolean;
  onImported?: () => void;
}

const PROBLEM_TONE: Record<ImportProblemRow['kind'], 'danger' | 'warn' | 'blue' | 'grey'> = {
  // Only one of these is a mistake in the data, and the colours say so.
  Invalid: 'danger',
  Missing: 'warn',
  Ambiguous: 'warn',
  // Feedback about the *form* rather than about the person who filled it in.
  Unmapped: 'blue',
};

/**
 * Download the Job Method form, fill it in offline, upload it back — Prompt 40A (CR-03) §4 and §5.
 *
 * ## Why this is a compact panel and not a redesign
 *
 * The approved Agent Builder is **A. Skill / Job Overview** and **B. One-time Job Method + Skill
 * Design**, with Save Draft, Test Agent, Activate Agent and View Objective Form. CR-03 adds two
 * controls; it does not license moving anything. So this is one Import / Export card that sits
 * beside the existing form — no new sidebar, no reflow of section B, no second Assigned AI Work
 * block.
 *
 * ## The two halves need different permissions, and the screen shows that
 *
 * **Download** needs no builder access at all — that is the whole point, since the person who knows
 * how the work is done is often the one who cannot open this screen. **Upload** needs
 * `agent-builder:EditDraft`, because bringing somebody's answers into a draft is building.
 *
 * ## The review is what stops this being dangerous
 *
 * An upload never saves silently. It shows what matched, what will be saved, and every flagged
 * problem by kind — and then waits. `Save Draft` is the only thing that writes, and it **cannot**
 * test or activate: a spreadsheet must not be able to put an agent into production.
 */
export function JobMethodImportExport({
  tenantId,
  assignmentId,
  assignmentTitle,
  objectiveName,
  assignedToLabel,
  canImport,
  onImported,
}: JobMethodImportExportProps) {
  const [outcome, setOutcome] = useState<ImportOutcomeView | null>(null);
  const [automationStance, setAutomationStance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadMeta = useCallback(async () => {
    try {
      const meta = await jobMethodApi.meta(tenantId);
      setAutomationStance(meta.automationStance);
    } catch {
      // The stance is reassurance, not function. Its absence must not block the panel.
      setAutomationStance(null);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await jobMethodApi.downloadWorkbook(tenantId, assignmentId);
      setNotice('The form has been downloaded. Send it to whoever does this work.');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The form could not be downloaded.');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const buffer = await file.arrayBuffer();
      // Chunked, because `String.fromCharCode(...bytes)` on a multi-megabyte array overflows the
      // argument limit and throws — a failure that looks like a corrupt file rather than a bug.
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      }

      setOutcome(
        await jobMethodApi.importWorkbook(tenantId, assignmentId, {
          filename: file.name,
          contentBase64: btoa(binary),
        }),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That file could not be read.');
    } finally {
      setBusy(false);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  };

  const problemsOf = (kind: ImportProblemRow['kind']) =>
    (outcome?.problems ?? []).filter((problem) => problem.kind === kind);

  return (
    <Card>
      <CardBody>
        <h3 className="jm-title">Import / Export</h3>

        {error !== null ? <Banner tone="danger">{error}</Banner> : null}
        {notice !== null ? <Banner tone="ok">{notice}</Banner> : null}

        <div className="jm-actions">
          <Button variant="default" size="sm" onClick={() => void download()} disabled={busy}>
            <Icon name="file" size={16} />
            Download Job Method Form
          </Button>

          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="jm-file"
            aria-label="Choose a completed Job Method form"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void upload(file);
            }}
          />
          <Button
            variant="default"
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={busy || !canImport}
            data-testid="upload-job-method"
          >
            <Icon name="build" size={16} />
            Upload Completed Job Method
          </Button>
        </div>

        {canImport ? null : (
          // Disabled and explained. The asymmetry is the feature, so the screen says what it is
          // rather than leaving a greyed button somebody has to ask about.
          <p className="jm-note" data-testid="jm-cannot-import">
            You can download this form and send it to whoever does the work. Uploading a completed
            form into the draft needs Agent Builder access.
          </p>
        )}

        {/* ---- the import review ---- */}
        {outcome !== null ? (
          <section className="jm-review" data-testid="jm-review">
            <h4 className="jm-review-title">Import review</h4>

            <dl className="jm-matched">
              <div>
                <dt>Objective</dt>
                <dd data-testid="jm-objective">{objectiveName}</dd>
              </div>
              <div>
                <dt>Assigned work</dt>
                <dd>{assignmentTitle}</dd>
              </div>
              <div>
                <dt>For</dt>
                <dd>{assignedToLabel ?? 'Not assigned to a person'}</dd>
              </div>
              <div>
                <dt>Steps read</dt>
                <dd data-testid="jm-step-count">{outcome.rows.length}</dd>
              </div>
            </dl>

            {outcome.accepted ? (
              <Banner tone="ok">
                Saved into the draft. Nothing has been tested and nothing has been activated.
              </Banner>
            ) : (
              <Banner tone="danger">{outcome.refusedBecause ?? 'Nothing was saved.'}</Banner>
            )}

            {(['Missing', 'Invalid', 'Ambiguous', 'Unmapped'] as const).map((kind) => {
              const rows = problemsOf(kind);
              if (rows.length === 0) return null;
              return (
                <div key={kind} className="jm-problems" data-testid={`jm-problems-${kind}`}>
                  <h5>
                    <StatusBadge status={kind} tone={PROBLEM_TONE[kind]} /> {rows.length}
                  </h5>
                  <ul>
                    {rows.map((problem, index) => (
                      <li key={`${kind}-${index}`}>
                        {problem.row !== null ? <strong>Row {problem.row}: </strong> : null}
                        {problem.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}

            {outcome.agentSuggestion !== null ? (
              <div className="jm-suggestion" data-testid="jm-suggestion">
                <h5>
                  This looks like {outcome.agentSuggestion.groups.length} Engine Agent
                  {outcome.agentSuggestion.groups.length === 1 ? '' : 's'}
                </h5>
                {outcome.agentSuggestion.groups.map((group) => (
                  <p key={group.key}>
                    <strong>Steps {group.steps.join(', ')}</strong> — {group.because}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="jm-review-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOutcome(null)}
                data-testid="jm-cancel"
              >
                Cancel Import
              </Button>
              {outcome.accepted ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setOutcome(null);
                    onImported?.();
                  }}
                  data-testid="jm-review-method"
                >
                  Review Job Method
                </Button>
              ) : null}
            </div>

            {automationStance !== null ? (
              // Verbatim from the server: an upload saves a draft and does nothing else.
              <p className="jm-stance" data-testid="jm-automation-stance">
                {automationStance}
              </p>
            ) : null}
          </section>
        ) : null}
      </CardBody>
    </Card>
  );
}
