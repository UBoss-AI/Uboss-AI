'use client';

import { useCallback, useRef, useState } from 'react';

import {
  AGENT_RUN_TYPE_LABELS,
  AGENT_RUN_TYPES,
  AGENT_SYNC_FIELD_LABELS,
  MISSING_DATA_BEHAVIOUR_LABELS,
  MISSING_DATA_BEHAVIOURS,
  type AgentRunType,
  type AgentSyncEnvelope,
  type MissingDataBehaviour,
} from '@uboss/types';
import { Banner, Button, FormField, Icon, Modal } from '@uboss/ui';

import { agentBuilderApi, ApiError } from '../lib/api-client';

/** What a dropped file may be called. Everything an agent is exported as is one of these. */
const ACCEPTED = '.md,.markdown,.json,.yaml,.yml,.txt';

/**
 * Bringing in an agent that was built somewhere else — CR-05.
 *
 * The client's words: *"kahin cloud me unke agent chal rahe hain… jo file milega agent ke liye,
 * bas yahan drag and drop kare, uske baad agent ban ke taiyar ho jaye."*
 *
 * ## Why it is two steps and not one
 *
 * Dropping a file could create the agent outright, and it would feel faster. It would also mean
 * a company's first sight of what UBoss understood is an agent that already exists — and every
 * export format in the field is somebody else's shape, read by a model, so the understanding is
 * exactly the part that deserves a look. So: read, show, confirm. The server has no route that
 * goes from a file to an agent without a person in between.
 *
 * ## Why every field is editable here
 *
 * What gets created is what is on this screen, not what was in the file. A file read imperfectly
 * and corrected in these boxes produces the right agent, and nothing has to be edited anywhere
 * else afterwards. Fields the file did not mention are left blank and *named* as absent below —
 * "the file did not say" and "it was read wrong" are different problems, and somebody looking at
 * an empty box cannot tell them apart unless the screen says which it is.
 */
export function SyncAgentDialog({
  tenantId,
  onClose,
  onCreated,
}: {
  tenantId: string;
  onClose: () => void;
  onCreated: (assignmentId: string) => void;
}) {
  const [envelope, setEnvelope] = useState<AgentSyncEnvelope | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [usedModel, setUsedModel] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const patch = (change: Partial<AgentSyncEnvelope>) =>
    setEnvelope((current) => (current === null ? current : { ...current, ...change }));

  const readFile = useCallback(
    (file: File) => {
      setBusy(true);
      setError(null);
      setFilename(file.name);

      void file
        .text()
        .then((content) =>
          agentBuilderApi.readAgentFile(tenantId, { filename: file.name, content }),
        )
        .then((answer) => {
          setEnvelope(answer.envelope);
          setUsedModel(answer.usedModel);
          setNote(answer.note);
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'That file could not be read.'),
        )
        .finally(() => setBusy(false));
    },
    [tenantId],
  );

  const create = () => {
    if (envelope === null) return;
    setBusy(true);
    setError(null);

    void agentBuilderApi
      .createSyncedAgent(tenantId, envelope)
      .then((created) => onCreated(created.assignmentId))
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'That agent could not be created.'),
      )
      .finally(() => setBusy(false));
  };

  const creatable =
    envelope !== null && envelope.name.trim() !== '' && envelope.purpose.trim() !== '';

  return (
    <Modal
      open
      onClose={onClose}
      title="Sync an agent"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {envelope === null ? null : (
            <Button variant="primary" onClick={create} disabled={busy || !creatable}>
              {busy ? 'Creating…' : 'Create agent'}
            </Button>
          )}
        </>
      }
    >
      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      {envelope === null ? (
        <>
          <p className="uboss-muted">
            Drop the file your agent was exported as — from a Custom GPT, n8n, CrewAI, Claude, or
            anywhere else. Markdown, JSON, YAML or plain text. Nothing is created until you have
            seen what it says.
          </p>

          {/*
            A drop target that is also a button.

            Drag and drop is what was asked for and is what most people will do, but a target
            that *only* accepts a drag excludes anybody working from a keyboard — and loses the
            person who clicks it expecting a file picker. Both open the same chooser.
          */}
          <button
            type="button"
            className={over ? 'uboss-dropzone is-over' : 'uboss-dropzone'}
            onClick={() => fileInput.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setOver(false);
              const dropped = event.dataTransfer.files[0];
              if (dropped) readFile(dropped);
            }}
            disabled={busy}
          >
            <Icon name="file" size={24} />
            <span>{busy ? `Reading ${filename ?? 'the file'}…` : 'Drop the agent file here'}</span>
            <span className="uboss-muted">or choose one</span>
          </button>

          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED}
            hidden
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) readFile(chosen);
              // Cleared so choosing the same file twice fires a change both times — otherwise a
              // person who fixes their file and re-picks it sees nothing happen.
              event.target.value = '';
            }}
          />
        </>
      ) : (
        <>
          <Banner tone={usedModel ? 'warn' : 'info'}>
            {note ?? 'Check what was read before creating the agent.'}
          </Banner>

          {envelope.notFound.length === 0 ? null : (
            <p className="uboss-muted">
              <strong>Not in the file:</strong>{' '}
              {envelope.notFound.map((field) => AGENT_SYNC_FIELD_LABELS[field]).join(', ')}. Fill in
              what matters now, or answer it on the builder screen afterwards.
            </p>
          )}

          <FormField label={AGENT_SYNC_FIELD_LABELS.name} required>
            {(wiring) => (
              <input
                {...wiring}
                className="uboss-input"
                value={envelope.name}
                maxLength={200}
                onChange={(event) => patch({ name: event.target.value })}
              />
            )}
          </FormField>

          <FormField label={AGENT_SYNC_FIELD_LABELS.purpose} required>
            {(wiring) => (
              <textarea
                {...wiring}
                className="uboss-input"
                rows={2}
                maxLength={2000}
                value={envelope.purpose}
                onChange={(event) => patch({ purpose: event.target.value })}
              />
            )}
          </FormField>

          <FormField label={AGENT_SYNC_FIELD_LABELS.runType}>
            {(wiring) => (
              <select
                {...wiring}
                className="uboss-input"
                value={envelope.runType ?? ''}
                onChange={(event) =>
                  patch({ runType: (event.target.value || null) as AgentRunType | null })
                }
              >
                <option value="">Not said in the file</option>
                {AGENT_RUN_TYPES.map((kind) => (
                  <option key={kind} value={kind}>
                    {AGENT_RUN_TYPE_LABELS[kind]}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          <FormField label={AGENT_SYNC_FIELD_LABELS.triggerOrFrequency}>
            {(wiring) => (
              <input
                {...wiring}
                className="uboss-input"
                value={envelope.triggerOrFrequency ?? ''}
                maxLength={300}
                onChange={(event) => patch({ triggerOrFrequency: event.target.value || null })}
              />
            )}
          </FormField>

          <FormField label={AGENT_SYNC_FIELD_LABELS.whereWorkHappens}>
            {(wiring) => (
              <input
                {...wiring}
                className="uboss-input"
                value={envelope.whereWorkHappens ?? ''}
                maxLength={300}
                onChange={(event) => patch({ whereWorkHappens: event.target.value || null })}
              />
            )}
          </FormField>

          <FormField label={AGENT_SYNC_FIELD_LABELS.outputDestination}>
            {(wiring) => (
              <input
                {...wiring}
                className="uboss-input"
                value={envelope.outputDestination ?? ''}
                maxLength={300}
                onChange={(event) => patch({ outputDestination: event.target.value || null })}
              />
            )}
          </FormField>

          <FormField label={AGENT_SYNC_FIELD_LABELS.missingDataBehaviour}>
            {(wiring) => (
              <select
                {...wiring}
                className="uboss-input"
                value={envelope.missingDataBehaviour ?? ''}
                onChange={(event) =>
                  patch({
                    missingDataBehaviour: (event.target.value ||
                      null) as MissingDataBehaviour | null,
                  })
                }
              >
                <option value="">Not said in the file</option>
                {MISSING_DATA_BEHAVIOURS.map((kind) => (
                  <option key={kind} value={kind}>
                    {MISSING_DATA_BEHAVIOUR_LABELS[kind]}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          {/*
            The steps, read-only here.

            They are editable — on the Job Method grid, which has twelve columns and exists for
            exactly this. Reproducing a narrow version of it inside a modal would be a second
            editor to keep in step with the first, and the one here would be the worse of the
            two. What this has to answer is "did it read my procedure", and a list answers that.
          */}
          <FormField label={`${AGENT_SYNC_FIELD_LABELS.steps} (${envelope.steps.length})`}>
            {() =>
              envelope.steps.length === 0 ? (
                <p className="uboss-muted">
                  No steps were found in the file. You can write them on the Job Method grid.
                </p>
              ) : (
                <ol className="uboss-sync-steps">
                  {envelope.steps.map((step, index) => (
                    <li key={`${index}-${step.what}`}>
                      <span>{step.what}</span>
                      {step.how === null ? null : <em className="uboss-muted"> — {step.how}</em>}
                    </li>
                  ))}
                </ol>
              )
            }
          </FormField>

          {envelope.tools.length === 0 ? null : (
            <p className="uboss-muted">
              <strong>{AGENT_SYNC_FIELD_LABELS.tools}:</strong> {envelope.tools.join(', ')}. These
              are not connected by this import — an administrator grants a connection separately,
              and the agent asks for one when it needs it.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
