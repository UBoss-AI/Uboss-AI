'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  FEEDBACK_RATING_DESCRIPTIONS,
  FEEDBACK_RATING_LABELS,
  FEEDBACK_RATINGS,
  isRunFinished,
  MIN_CORRECTION_LENGTH,
  ratingRequiresCorrection,
  RUN_STATES,
  type FeedbackRating,
} from '@uboss/types';
import { Banner, Button, Card, CardBody, Icon, StatusBadge } from '@uboss/ui';

import { DiscussButton } from './DiscussButton';
import {
  agentOperatorApi,
  ApiError,
  feedbackApi,
  type OperatorAgentView,
  type OperatorRunView,
} from '../lib/api-client';

export interface MyEngineAgentsProps {
  tenantId: string;
  /**
   * Whether to explain an empty list.
   *
   * True for somebody whose whole screen this is; false when a populated registry sits underneath,
   * where "nothing has been shared with you" is noise rather than an explanation. The screen
   * decides, because only the screen can see what else is on it.
   */
  showEmptyState?: boolean;
}

/** Which panel, if any, is open under one agent. */
type OpenPanel = { agentId: string; mode: 'result' | 'history' | 'issue' };

/**
 * Has this run ended?
 *
 * Asked of the run state machine rather than answered with a list here. A second copy of "which
 * states are terminal" is the kind that stops agreeing with the first the moment a state is added,
 * and this screen would then show a stale "latest result" without anything failing.
 *
 * The state arrives as a string because `OperatorRunView` is deliberately narrow, so it is
 * checked against the declared set before being treated as one.
 */
function hasEnded(state: string): boolean {
  const known = RUN_STATES.find((entry) => entry === state);
  return known !== undefined && isRunFinished(known);
}

/**
 * "My Engine Agents" — what an operator sees after an agent is activated for them.
 *
 * Prompt 40A (CR-03) §5.
 *
 * ## The simplicity is the requirement, not a shortcut
 *
 * Agent Name, the Objective and assigned work, status, last and next run, and four actions. **No
 * prompts, no JSON, no model names, no API keys, no configuration.** That is enforced by the shape
 * the server sends — `OperatorAgentView` and `OperatorRunView` have no field to put them in — and
 * this component deliberately reads only those two endpoints and never the builder's, because a
 * screen can honour the rule and the next screen can forget it.
 *
 * ## A disabled Run button always says why
 *
 * `cannotRunBecause` is one sentence naming the **first** unmet condition of seven, in an order
 * chosen so a refusal reveals nothing: somebody with no share is told only that, and learns nothing
 * about approval, connections or budget. The screen prints it as it arrives and adds nothing.
 *
 * An agent that cannot run right now is still **listed**. An operator whose agent vanished because
 * a connection expired would conclude the work had been taken away from them.
 *
 * ## View Result and History read one list
 *
 * Both open the same `my-runs` response — Result showing the newest finished run, History showing
 * all of them. Two endpoints would let a "latest result" disagree with the top row of the history
 * beneath it, which is the kind of contradiction an operator cannot resolve and should never see.
 */
export function MyEngineAgents({ tenantId, showEmptyState = true }: MyEngineAgentsProps) {
  const [agents, setAgents] = useState<OperatorAgentView[]>([]);
  const [stance, setStance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const [runs, setRuns] = useState<Record<string, OperatorRunView[]>>({});

  const [rating, setRating] = useState<FeedbackRating>('Incorrect');
  const [correction, setCorrection] = useState('');

  const load = useCallback(async () => {
    try {
      const [mine, meta] = await Promise.all([
        agentOperatorApi.mine(tenantId),
        agentOperatorApi.meta(tenantId).catch(() => null),
      ]);
      setAgents(mine.agents);
      setStance(meta?.operatorStance ?? null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Your agents could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRuns = useCallback(
    async (agentId: string): Promise<OperatorRunView[]> => {
      const response = await agentOperatorApi.myRuns(tenantId, agentId);
      setRuns((current) => ({ ...current, [agentId]: response.runs }));
      return response.runs;
    },
    [tenantId],
  );

  const openPanel = async (agentId: string, mode: OpenPanel['mode']) => {
    setError(null);
    if (panel?.agentId === agentId && panel.mode === mode) {
      setPanel(null);
      return;
    }
    setPanel({ agentId, mode });
    if (mode === 'issue') {
      setRating('Incorrect');
      setCorrection('');
    }
    try {
      await loadRuns(agentId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Those runs could not be loaded.');
    }
  };

  const run = async (agentId: string) => {
    setBusyId(agentId);
    setError(null);
    setNotice(null);
    try {
      await agentOperatorApi.run(tenantId, agentId);
      // A run is durable before it is finished, so the honest message is that it started.
      setNotice('The run has started. Its result appears under View Result when it finishes.');
      await load();
      if (runs[agentId] !== undefined) await loadRuns(agentId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That run could not be started.');
    } finally {
      setBusyId(null);
    }
  };

  const reportIssue = async (agentId: string) => {
    const latest = runs[agentId]?.[0];
    if (latest === undefined) return;

    setBusyId(agentId);
    setError(null);
    setNotice(null);
    try {
      await feedbackApi.submit(tenantId, latest.runId, { rating, correction });
      setNotice('Thank you — that has been recorded against the run for the agent’s owner.');
      setPanel(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That could not be sent.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardBody>Loading your agents…</CardBody>
      </Card>
    );
  }

  if (agents.length === 0 && !showEmptyState) return null;

  return (
    <div data-testid="my-engine-agents">
      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      {notice !== null ? <Banner tone="ok">{notice}</Banner> : null}

      {agents.length === 0 ? (
        <Card>
          <CardBody>
            <p>
              No agents have been shared with you yet. When somebody builds one for your work and
              shares it, it will appear here.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {agents.map((agent) => {
        const mine = runs[agent.agentId] ?? [];
        const finished = mine.find((entry) => hasEnded(entry.state)) ?? null;
        const latest = mine[0] ?? null;
        const open = panel?.agentId === agent.agentId ? panel.mode : null;
        const needsCorrection = ratingRequiresCorrection(rating);
        const correctionTooShort =
          needsCorrection && correction.trim().length < MIN_CORRECTION_LENGTH;

        return (
          <Card key={agent.agentId}>
            <CardBody>
              <div className="operator-agent-head">
                <h3 className="operator-agent-name" data-testid="operator-agent-name">
                  {agent.agentName}
                </h3>
                <StatusBadge status={agent.status} />
              </div>

              <dl className="operator-agent-facts">
                <div>
                  <dt>Objective</dt>
                  <dd data-testid="operator-objective">{agent.linkedObjectiveName ?? '—'}</dd>
                </div>
                <div>
                  <dt>Assigned work</dt>
                  <dd>{agent.assignedWorkTitle ?? '—'}</dd>
                </div>
                <div>
                  <dt>Last run</dt>
                  <dd>
                    {agent.lastRunAt === null
                      ? 'Never'
                      : new Date(agent.lastRunAt).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>Next run</dt>
                  <dd>
                    {agent.nextRunAt === null
                      ? 'Not scheduled'
                      : new Date(agent.nextRunAt).toLocaleString()}
                  </dd>
                </div>
              </dl>

              <div className="operator-agent-actions">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!agent.canRun || busyId === agent.agentId}
                  onClick={() => void run(agent.agentId)}
                  data-testid="operator-run"
                >
                  <Icon name="play" size={16} />
                  Run Agent
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => void openPanel(agent.agentId, 'result')}
                  data-testid="operator-view-result"
                >
                  View Result
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => void openPanel(agent.agentId, 'history')}
                  data-testid="operator-history"
                >
                  History
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void openPanel(agent.agentId, 'issue')}
                  data-testid="operator-report-issue"
                >
                  Report Issue
                </Button>
              </div>

              {agent.canRun ? null : (
                // The server's sentence, unchanged. Rewording it here would risk saying more than
                // the ordered precondition list deliberately says.
                <p className="operator-agent-blocked" data-testid="operator-cannot-run">
                  {agent.cannotRunBecause}
                </p>
              )}

              {open === 'result' ? (
                <div className="operator-panel" data-testid="operator-result-panel">
                  <h4>Latest result</h4>
                  {finished === null ? (
                    <p className="operator-panel-empty">This agent has not finished a run yet.</p>
                  ) : finished.failureReason !== null ? (
                    <p className="operator-panel-failure">{finished.failureReason}</p>
                  ) : finished.resultText === null ? (
                    <p className="operator-panel-empty">
                      That run produced no text to show here. Its outcome went to the work it was
                      assigned to.
                    </p>
                  ) : (
                    <p className="operator-panel-result">{finished.resultText}</p>
                  )}
                </div>
              ) : null}

              {open === 'history' ? (
                <div className="operator-panel" data-testid="operator-history-panel">
                  <h4>History</h4>
                  {mine.length === 0 ? (
                    <p className="operator-panel-empty">This agent has not run yet.</p>
                  ) : (
                    <ul className="operator-run-list">
                      {mine.map((entry) => (
                        <li key={entry.runId}>
                          <StatusBadge status={entry.state} />
                          <span className="operator-run-when">
                            {entry.startedAt === null
                              ? 'Not started'
                              : new Date(entry.startedAt).toLocaleString()}
                          </span>
                          <span className="operator-run-trigger">{entry.trigger}</span>
                          {entry.failureReason === null ? null : (
                            <span className="operator-run-why">{entry.failureReason}</span>
                          )}
                          {/*
                            Prompt 40A (CR-03) §6 — the sixth work-context type. A run that went
                            wrong is the thing an operator most often needs to ask about, and
                            Report Issue records a judgement rather than starting a conversation.
                          */}
                          <DiscussButton
                            tenantId={tenantId}
                            contextType="AgentRun"
                            resourceId={entry.runId}
                            label="Discuss"
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}

              {open === 'issue' ? (
                <div className="operator-panel" data-testid="operator-issue-panel">
                  <h4>Report an issue</h4>
                  {mine.length === 0 ? (
                    <p className="operator-panel-empty">
                      An issue is reported against a run, and this agent has not run yet.
                    </p>
                  ) : (
                    <>
                      <p className="operator-panel-hint">
                        {latest?.startedAt == null
                          ? 'About the most recent run.'
                          : `About the most recent run, of ${new Date(
                              latest.startedAt,
                            ).toLocaleString()}.`}
                      </p>
                      <label className="operator-field">
                        <span>What was wrong?</span>
                        <select
                          value={rating}
                          onChange={(event) => setRating(event.target.value as FeedbackRating)}
                          data-testid="operator-issue-rating"
                        >
                          {FEEDBACK_RATINGS.filter((entry) => entry !== 'Correct').map((entry) => (
                            <option key={entry} value={entry}>
                              {FEEDBACK_RATING_LABELS[entry]}
                            </option>
                          ))}
                        </select>
                        <small>{FEEDBACK_RATING_DESCRIPTIONS[rating]}</small>
                      </label>
                      <label className="operator-field">
                        <span>What should it have done?</span>
                        <textarea
                          rows={3}
                          value={correction}
                          onChange={(event) => setCorrection(event.target.value)}
                          data-testid="operator-issue-correction"
                        />
                        <small>
                          {`At least ${MIN_CORRECTION_LENGTH} characters — "wrong" tells the owner nothing they can act on.`}
                        </small>
                      </label>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={correctionTooShort || busyId === agent.agentId}
                        onClick={() => void reportIssue(agent.agentId)}
                        data-testid="operator-issue-send"
                      >
                        Send
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
            </CardBody>
          </Card>
        );
      })}

      {stance !== null ? (
        <p className="operator-stance" data-testid="operator-stance">
          {stance}
        </p>
      ) : null}
    </div>
  );
}
