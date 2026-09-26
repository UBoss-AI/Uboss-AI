'use client';

import { useCallback, useEffect, useState } from 'react';

import { Banner, Button, Icon, Modal } from '@uboss/ui';

import {
  agentRunsApi,
  ApiError,
  type EngineAgentView,
  type RuntimeInputFieldView,
} from '../lib/api-client';

interface RunAgentPanelProps {
  tenantId: string;
  agent: EngineAgentView | null;
  onClose: () => void;
  /** Called once a run has really been queued, so the caller can refresh what it shows. */
  onStarted: (message: string) => void;
}

/**
 * Operating a published agent — the employee's whole involvement with AI work.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is not a builder. The person here does not choose a model, a connection, a prompt or a
 * schedule: all of that was decided once, by the Admin, when the agent was published, and asking
 * again would be the duplicate data entry the client's model exists to remove. What is left is the
 * handful of things that are genuinely different this time, and the server decides which those are
 * — it reads the agent's own published configuration and returns the questions. An agent whose
 * builder named a destination is not asked for one; the same screen asks two questions of one
 * agent and four of another without knowing anything about either.
 *
 * ## Why the fields are not rendered from a local list
 *
 * Because then there would be two lists. The server refuses a run whose required answers are
 * missing, using the same function that produced these fields, so a question this screen invented
 * would be one the server ignores and a question it dropped would be a refusal with no control to
 * fix it.
 */
export function RunAgentPanel({ tenantId, agent, onClose, onStarted }: RunAgentPanelProps) {
  const [fields, setFields] = useState<RuntimeInputFieldView[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (agent === null) return;
    setFields(null);
    setAnswers({});
    setError(null);

    void agentRunsApi
      .inputs(tenantId, agent.id)
      .then((result) => setFields(result.fields))
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not read what this run needs to be told.',
        ),
      );
  }, [agent, tenantId]);

  const missing = (fields ?? []).filter(
    (field) => field.required && (answers[field.key] ?? '').trim() === '',
  );

  const run = useCallback(() => {
    if (agent === null) return;
    setBusy(true);
    setError(null);

    void agentRunsApi
      .start(tenantId, agent.id, { runtimeInputs: answers })
      .then((result) => {
        /*
         * A queued run is reported as queued, and a refused one says why.
         *
         * The engine answers `created: false` with a reason when an overlap policy declines to
         * start another — telling somebody "started" in that case would be a small lie they would
         * discover later, looking for a run that does not exist.
         */
        onStarted(
          result.created
            ? `${agent.name} is running. It appears in this agent's run history as it works.`
            : `${agent.name} was not started: ${result.reason}`,
        );
        onClose();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'The run could not be started.'),
      )
      .finally(() => setBusy(false));
  }, [agent, answers, onClose, onStarted, tenantId]);

  return (
    <Modal
      open={agent !== null}
      title={agent === null ? 'Run' : `Run ${agent.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={run}
            disabled={busy || fields === null || missing.length > 0}
            title={
              missing.length === 0
                ? undefined
                : `Still needed: ${missing.map((field) => field.label).join(' ')}`
            }
          >
            <Icon name="bolt" size={16} />
            Run
          </Button>
        </>
      }
    >
      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      {fields === null ? (
        <p className="uboss-muted">Reading what this run needs…</p>
      ) : (
        <>
          <p className="uboss-muted-3">
            Everything about how this agent works was decided when it was published. These are the
            things that change each time it runs.
          </p>

          {fields.map((field) => (
            <div className="uboss-field" key={field.key}>
              <label htmlFor={`run-${field.key}`}>
                {field.label}
                {field.required ? null : <span className="uboss-muted-3"> — optional</span>}
              </label>
              <input
                id={`run-${field.key}`}
                value={answers[field.key] ?? ''}
                onChange={(event) =>
                  setAnswers((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
              <span className="uboss-field-hint">{field.hint}</span>
            </div>
          ))}

          <p className="uboss-notice-min">
            <Icon name="bot" size={14} />
            The published agent does the work. Nothing you type here changes how it is configured.
          </p>
        </>
      )}
    </Modal>
  );
}
