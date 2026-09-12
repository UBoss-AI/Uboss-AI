'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Icon,
  StatusBadge,
  type DataTableColumn,
  type StatusTone,
} from '@uboss/ui';

import {
  agentRunsApi,
  ApiError,
  engineAgentsApi,
  feedbackApi,
  memoryApi,
  type AgentRunSummaryView,
  type FeedbackMeta,
  type FeedbackView,
  type MemoryPolicyView,
  type MemoryRecordView,
  type MemoryVocabulary,
  type QualitySummaryView,
} from '../../lib/api-client';

/**
 * Settings › Agent Policy — memory governance and AI output feedback (Prompt 33).
 *
 * ## Why both are on one screen
 *
 * They are the two halves of one question: what an Engine Agent is allowed to keep, and whether
 * what it produced was any good. The reference's Settings sidebar has one category for this —
 * "Agent Policy" — and splitting memory from feedback across two would make a reader visit two
 * places to answer "should we trust this agent".
 *
 * ## What the memory section cannot do
 *
 * **It cannot write a memory record.** Remembering is something an agent does during a run, under
 * the mode its published version declares; a person writing one directly would be memory with no
 * provenance, and no route exists for it. So this section reads the policies, changes them,
 * shows what the agents are holding, and deletes.
 *
 * ## What the feedback section says out loud
 *
 * The stance on provider training, verbatim from the server. Prompt 33's instruction is not to
 * assume or automatically enable provider training on company data, and the strongest form of
 * that is a product with nothing to disable and a screen that says so.
 */

const CLASSIFICATION_TONE: Record<string, StatusTone> = {
  Public: 'grey',
  Internal: 'blue',
  Confidential: 'warn',
  Restricted: 'danger',
};

const RATING_TONE: Record<string, StatusTone> = {
  Correct: 'success',
  NeedsCorrection: 'warn',
  Incorrect: 'danger',
  Incomplete: 'warn',
};

function when(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

export function MemoryAndFeedbackPanel({
  tenantId,
}: {
  tenantId: string | null;
}): React.JSX.Element {
  const [vocabulary, setVocabulary] = useState<MemoryVocabulary | null>(null);
  const [policies, setPolicies] = useState<MemoryPolicyView[]>([]);
  const [records, setRecords] = useState<MemoryRecordView[]>([]);
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [meta, setMeta] = useState<FeedbackMeta | null>(null);
  const [quality, setQuality] = useState<QualitySummaryView | null>(null);

  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRunSummaryView[]>([]);
  const [runFeedback, setRunFeedback] = useState<Record<string, FeedbackView[]>>({});

  const [rating, setRating] = useState<AgentRunSummaryView | null>(null);
  const [chosenRating, setChosenRating] = useState('Correct');
  const [correction, setCorrection] = useState('');
  const [evidence, setEvidence] = useState('');

  const [editing, setEditing] = useState<MemoryPolicyView | null>(null);
  const [editReason, setEditReason] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (tenantId === null) return;
    setError(null);
    try {
      const [vocab, policyList, recordList, feedbackMeta, qualitySummary, agentList] =
        await Promise.all([
          memoryApi.vocabulary(tenantId),
          memoryApi.policies(tenantId),
          memoryApi.records(tenantId, { includeDeleted }),
          feedbackApi.meta(tenantId),
          feedbackApi.quality(tenantId),
          engineAgentsApi.list(tenantId),
        ]);

      setVocabulary(vocab);
      setPolicies(policyList.policies);
      setRecords(recordList.records);
      setMeta(feedbackMeta);
      setQuality(qualitySummary);
      setAgents(agentList.agents.map((row) => ({ id: row.id, name: row.name })));
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'Memory and feedback settings could not be loaded.',
      );
    }
  }, [tenantId, includeDeleted]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRuns = useCallback(
    async (id: string) => {
      if (tenantId === null) return;
      setError(null);
      try {
        const page = await agentRunsApi.list(tenantId, id);
        setRuns(page.runs);

        const entries = await Promise.all(
          page.runs.map(async (run) => {
            const existing = await feedbackApi.forRun(tenantId, run.id);
            return [run.id, existing.feedback] as const;
          }),
        );
        setRunFeedback(Object.fromEntries(entries));
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : 'Those runs could not be loaded.');
      }
    },
    [tenantId],
  );

  const submitRating = async () => {
    if (tenantId === null || rating === null) return;
    setBusy(true);
    try {
      await feedbackApi.submit(tenantId, rating.id, {
        rating: chosenRating,
        ...(correction.trim() === '' ? {} : { correction: correction.trim() }),
        ...(evidence.trim() === '' ? {} : { evidence: evidence.trim() }),
      });
      setNotice('Recorded. It counts towards this agent’s quality figures.');
      setRating(null);
      setCorrection('');
      setEvidence('');
      if (agentId !== null) await loadRuns(agentId);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That rating could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    if (tenantId === null || editing === null) return;
    setBusy(true);
    try {
      const { mode, ...rest } = editing;
      await memoryApi.setPolicy(tenantId, mode, { ...rest, reason: editReason.trim() });
      setNotice(`The ${mode} policy has been changed.`);
      setEditing(null);
      setEditReason('');
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'That policy change could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const forget = async (record: MemoryRecordView) => {
    if (tenantId === null) return;
    const reason = window.prompt('Why is this memory being deleted?');
    if (reason === null || reason.trim().length < 4) return;
    setBusy(true);
    try {
      await memoryApi.forget(tenantId, record.id, reason.trim());
      setNotice('Deleted. The record of the deletion is kept; the content is gone.');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That record could not be deleted.');
    } finally {
      setBusy(false);
    }
  };

  if (tenantId === null) {
    return (
      <Banner tone="info">
        Choose a workspace to govern its Engine Agent memory. Memory belongs to a company&rsquo;s
        own agents and never crosses between companies.
      </Banner>
    );
  }

  const ruleFor = (mode: string) =>
    vocabulary?.modes.find((candidate) => candidate.mode === mode)?.rule ?? '';
  const labelFor = (mode: string) =>
    vocabulary?.modes.find((candidate) => candidate.mode === mode)?.label ?? mode;

  const policyColumns: DataTableColumn<MemoryPolicyView>[] = [
    {
      key: 'mode',
      header: 'Mode',
      render: (row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{labelFor(row.mode)}</div>
          <div className="uboss-muted" style={{ fontSize: 12 }}>
            {ruleFor(row.mode)}
          </div>
        </div>
      ),
    },
    {
      key: 'retention',
      header: 'Kept for',
      render: (row) => (
        <span className="uboss-mono">
          {row.retentionDays === null ? 'Until deleted' : `${row.retentionDays} days`}
        </span>
      ),
    },
    {
      key: 'visibility',
      header: 'Visible to',
      render: (row) => (
        <span>
          {vocabulary?.visibilities.find((v) => v.visibility === row.visibility)?.label ??
            row.visibility}
        </span>
      ),
    },
    {
      key: 'classification',
      header: 'Up to',
      render: (row) => (
        <StatusBadge
          tone={CLASSIFICATION_TONE[row.maxClassification] ?? 'grey'}
          status={row.maxClassification}
        />
      ),
    },
    {
      key: 'sharing',
      header: 'Sharing',
      render: (row) => (
        <span className="uboss-muted" style={{ fontSize: 12 }}>
          {row.allowCrossUser ? 'Across people' : 'One person only'}
          {row.allowCrossObjective ? ' · across Objectives' : ''}
          {row.requiresApproval ? ' · needs an approval' : ''}
        </span>
      ),
    },
    {
      key: 'offboarding',
      header: 'When somebody leaves',
      render: (row) => (
        <span className="uboss-muted" style={{ fontSize: 12 }}>
          {vocabulary?.offboardingBehaviours.find((b) => b.behaviour === row.offboardingBehaviour)
            ?.label ?? row.offboardingBehaviour}
        </span>
      ),
    },
    {
      key: 'action',
      header: '',
      render: (row) => (
        <Button
          onClick={() => {
            setEditing({ ...row });
            setEditReason('');
          }}
        >
          Change
        </Button>
      ),
    },
  ];

  const recordColumns: DataTableColumn<MemoryRecordView>[] = [
    {
      key: 'label',
      header: 'Remembered',
      render: (row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.label}</div>
          <div className="uboss-muted" style={{ fontSize: 12 }}>
            {labelFor(row.mode)} · {row.visibility}
          </div>
        </div>
      ),
    },
    {
      key: 'classification',
      header: 'Class',
      render: (row) => (
        <StatusBadge
          tone={CLASSIFICATION_TONE[row.classification] ?? 'grey'}
          status={row.classification}
        />
      ),
    },
    {
      key: 'expires',
      header: 'Expires',
      render: (row) => (
        <span className="uboss-mono">{row.expiresAt === null ? 'Never' : when(row.expiresAt)}</span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (row) =>
        row.deletedAt === null ? (
          <StatusBadge tone="success" status="Held" />
        ) : (
          <div>
            <StatusBadge tone="grey" status="Deleted" />
            <div className="uboss-muted" style={{ fontSize: 12 }}>
              {row.deletedReason}
            </div>
          </div>
        ),
    },
    {
      key: 'action',
      header: '',
      render: (row) =>
        row.deletedAt === null ? (
          <Button variant="danger" disabled={busy} onClick={() => void forget(row)}>
            Delete
          </Button>
        ) : null,
    },
  ];

  const runColumns: DataTableColumn<AgentRunSummaryView>[] = [
    {
      key: 'run',
      header: 'Run',
      render: (row) => (
        <div>
          <div className="uboss-mono">{row.id.slice(0, 8)}</div>
          <div className="uboss-muted" style={{ fontSize: 12 }}>
            {row.trigger} · {when(row.finishedAt ?? row.startedAt)}
          </div>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (row) => (
        <StatusBadge
          tone={row.state === 'Completed' ? 'success' : row.state === 'Failed' ? 'danger' : 'blue'}
          status={row.state}
        />
      ),
    },
    {
      key: 'provenance',
      header: 'Produced by',
      render: (row) =>
        row.producedByRealModel === true ? (
          <StatusBadge tone="blue" status="A real provider" />
        ) : (
          // Never presented as a provider result. Prompt 29's rule, on the screen.
          <StatusBadge tone="grey" status="The mock model" />
        ),
    },
    {
      key: 'feedback',
      header: 'Feedback',
      render: (row) => {
        const given = runFeedback[row.id] ?? [];
        if (given.length === 0) return <span className="uboss-muted">None yet</span>;
        return (
          <div>
            {given.map((entry) => (
              <div key={entry.id}>
                <StatusBadge tone={RATING_TONE[entry.rating] ?? 'grey'} status={entry.rating} />
                {entry.promotedAt === null ? null : (
                  <span className="uboss-muted" style={{ fontSize: 12 }}>
                    {' '}
                    · an evaluation case
                  </span>
                )}
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: 'action',
      header: '',
      render: (row) =>
        row.output === null || row.output === undefined ? (
          <span className="uboss-muted" style={{ fontSize: 12 }}>
            Nothing to judge
          </span>
        ) : (
          <Button
            onClick={() => {
              setRating(row);
              setChosenRating('Correct');
              setCorrection('');
              setEvidence('');
            }}
          >
            Rate this output
          </Button>
        ),
    },
  ];

  const chosen = meta?.ratings.find((candidate) => candidate.rating === chosenRating);
  const needsCorrection = chosen?.requiresCorrection === true;

  return (
    <div className="uboss-grid">
      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {notice === null ? null : <Banner tone="info">{notice}</Banner>}

      <Card>
        <CardBody>
          <div className="uboss-section-label">Engine Agent memory</div>
          <p className="uboss-muted">
            What each memory mode is allowed to keep, for how long, and who can see it. A mode can
            be narrowed and never widened past what the approved architecture sets for it.
          </p>
          <DataTable
            caption="Memory policy by mode"
            columns={policyColumns}
            rows={policies}
            rowKey={(row) => row.mode}
            emptyTitle="No policies yet"
            emptyDescription="They are created from the documented defaults the first time this screen is opened."
          />
          <p className="uboss-notice-min">
            <Icon name="shield" size={14} />
            {vocabulary?.note ?? ''}
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="uboss-spread">
            <div className="uboss-section-label">What the agents are holding</div>
            <div className="uboss-seg">
              <button
                type="button"
                className={includeDeleted ? '' : 'is-on'}
                onClick={() => setIncludeDeleted(false)}
              >
                Held
              </button>
              <button
                type="button"
                className={includeDeleted ? 'is-on' : ''}
                onClick={() => setIncludeDeleted(true)}
              >
                Including deleted
              </button>
            </div>
          </div>
          <DataTable
            caption="Memory records"
            columns={recordColumns}
            rows={records}
            rowKey={(row) => row.id}
            emptyTitle="Nothing remembered yet"
            emptyDescription="A record appears here when an agent keeps something during a run."
          />
          <p className="uboss-notice-min">
            <Icon name="alert" size={14} />
            Deleting clears the content and keeps the record of the deletion, so &ldquo;was our data
            deleted?&rdquo; stays answerable.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="uboss-section-label">AI output quality</div>
          {quality === null || quality.total === 0 ? (
            <p className="uboss-muted">
              Nobody has rated an AI output yet, so there is no quality figure. One appears as soon
              as somebody does.
            </p>
          ) : (
            <>
              <div className="uboss-row-2">
                <div className="uboss-kv">
                  <span>Rated correct</span>
                  <strong>{quality.correctPercent}%</strong>
                </div>
                <div className="uboss-kv">
                  <span>Ratings</span>
                  <strong>{quality.total}</strong>
                </div>
              </div>
              <p className="uboss-notice-min">
                <Icon name="bot" size={14} />
                {quality.onRealModelOutput === 0
                  ? 'None of this feedback is on output a real provider produced, so the ' +
                    'percentage says nothing about a provider’s quality yet.'
                  : `${quality.onRealModelOutput} of ${quality.total} rating(s) are on output a real provider produced.`}
              </p>
            </>
          )}

          <div className="uboss-section-label" style={{ marginTop: 12 }}>
            Rate an output
          </div>
          <div className="uboss-row-2">
            <label>
              <span className="uboss-section-label">Agent</span>
              <select
                value={agentId ?? ''}
                onChange={(event) => {
                  const next = event.target.value === '' ? null : event.target.value;
                  setAgentId(next);
                  setRuns([]);
                  if (next !== null) void loadRuns(next);
                }}
              >
                <option value="">Choose an agent</option>
                {agents.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {agentId === null ? null : (
            <DataTable
              caption="Runs and their feedback"
              columns={runColumns}
              rows={runs}
              rowKey={(row) => row.id}
              emptyTitle="No runs yet"
              emptyDescription="This agent has not run, so there is no output to judge."
            />
          )}

          <p className="uboss-notice-min">
            <Icon name="shield" size={14} />
            {meta?.stance ?? ''}
          </p>
        </CardBody>
      </Card>

      {/* ---- rating drawer ---- */}
      <Drawer
        open={rating !== null}
        onClose={() => setRating(null)}
        title="Rate this AI output"
        footer={
          <div className="uboss-actions">
            <Button variant="ghost" onClick={() => setRating(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                (needsCorrection && correction.trim().length < (meta?.minCorrectionLength ?? 20))
              }
              onClick={() => void submitRating()}
            >
              Record it
            </Button>
          </div>
        }
      >
        {rating === null ? null : (
          <>
            <div className="uboss-section-label">What it produced</div>
            <pre
              className="uboss-mono"
              style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}
            >
              {JSON.stringify(rating.output, null, 2)}
            </pre>

            {rating.producedByRealModel === true ? null : (
              <Banner tone="info">
                A mock model produced this. Your rating is still recorded and counted, and it is
                marked as mock so no report can present it as a provider&rsquo;s quality.
              </Banner>
            )}

            <div className="uboss-section-label">Your judgement</div>
            <div className="uboss-grid">
              {(meta?.ratings ?? []).map((candidate) => (
                <label key={candidate.rating} className="uboss-kv">
                  <input
                    type="radio"
                    name="rating"
                    value={candidate.rating}
                    checked={chosenRating === candidate.rating}
                    onChange={() => setChosenRating(candidate.rating)}
                  />
                  <span>
                    <strong>{candidate.label}</strong>
                    <span className="uboss-muted" style={{ fontSize: 12 }}>
                      {' '}
                      — {candidate.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            {needsCorrection ? (
              <label>
                <span className="uboss-section-label">
                  What is wrong, and what it should have said
                </span>
                <textarea
                  value={correction}
                  onChange={(event) => setCorrection(event.target.value)}
                  rows={4}
                  placeholder="It quoted the draft contract instead of the signed one."
                />
              </label>
            ) : null}

            <label>
              <span className="uboss-section-label">Evidence (optional)</span>
              <textarea
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                rows={2}
                placeholder="Where your answer comes from — a document, a record, a rule."
              />
            </label>

            <p className="uboss-notice-min">
              <Icon name="shield" size={14} />
              {meta?.stance ?? ''}
            </p>
          </>
        )}
      </Drawer>

      {/* ---- policy drawer ---- */}
      <Drawer
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === null ? '' : `Change the ${labelFor(editing.mode)} policy`}
        footer={
          <div className="uboss-actions">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || editReason.trim().length < 4}
              onClick={() => void savePolicy()}
            >
              Save
            </Button>
          </div>
        }
      >
        {editing === null ? null : (
          <>
            <p className="uboss-muted">{ruleFor(editing.mode)}</p>

            <label>
              <span className="uboss-section-label">Kept for, in days</span>
              <input
                type="number"
                min={1}
                max={vocabulary?.maxRetentionDays ?? 3650}
                value={editing.retentionDays ?? ''}
                placeholder={
                  editing.mode === 'ApprovedLongTermMemory' ? 'Blank means until deleted' : ''
                }
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    retentionDays: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
            </label>

            <label>
              <span className="uboss-section-label">Visible to</span>
              <select
                value={editing.visibility}
                onChange={(event) => setEditing({ ...editing, visibility: event.target.value })}
              >
                {(vocabulary?.visibilities ?? [])
                  // Only what this mode may be narrowed to. The server refuses anything wider,
                  // so offering it would be offering a refusal.
                  .filter((candidate) => {
                    const order = ['SameRun', 'SameObjective', 'SameAgent', 'CompanyWide'];
                    const ceiling =
                      vocabulary?.modes.find((m) => m.mode === editing.mode)?.maxVisibility ??
                      'SameRun';
                    return order.indexOf(candidate.visibility) <= order.indexOf(ceiling);
                  })
                  .map((candidate) => (
                    <option key={candidate.visibility} value={candidate.visibility}>
                      {candidate.label}
                    </option>
                  ))}
              </select>
            </label>

            <label>
              <span className="uboss-section-label">Most sensitive class it may keep</span>
              <select
                value={editing.maxClassification}
                onChange={(event) =>
                  setEditing({ ...editing, maxClassification: event.target.value })
                }
              >
                {(vocabulary?.classifications ?? []).map((candidate) => (
                  <option key={candidate.classification} value={candidate.classification}>
                    {candidate.classification} — {candidate.description}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="uboss-section-label">When somebody leaves</span>
              <select
                value={editing.offboardingBehaviour}
                onChange={(event) =>
                  setEditing({ ...editing, offboardingBehaviour: event.target.value })
                }
              >
                {(vocabulary?.offboardingBehaviours ?? []).map((candidate) => (
                  <option key={candidate.behaviour} value={candidate.behaviour}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="uboss-section-label">Why</span>
              <textarea
                value={editReason}
                onChange={(event) => setEditReason(event.target.value)}
                rows={3}
                placeholder="Tighter retention agreed with legal."
              />
            </label>

            <p className="uboss-notice-min">
              <Icon name="alert" size={14} />
              The change is recorded against your name with both the old and the new value.
            </p>
          </>
        )}
      </Drawer>
    </div>
  );
}
