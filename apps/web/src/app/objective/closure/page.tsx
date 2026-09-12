'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import {
  OUTCOME_VERDICT_DESCRIPTIONS,
  OUTCOME_VERDICT_LABELS,
  OUTCOME_VERDICTS,
  PAUSE_REASON_LABELS,
  PAUSE_REASONS,
  SLA_OUTCOME_LABELS,
  type OutcomeVerdict,
  type PauseReason,
  type SlaOutcome,
} from '@uboss/types';
import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  Icon,
  PageHeader,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  objectiveClosureApi,
  type ClosureMetaView,
  type ClosureReadinessView,
  type MeResponse,
  type ObjectivePauseView,
  type OutcomeComparisonView,
  type OutcomeReviewView,
} from '../../../lib/api-client';
import { useNotificationBell } from '../../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

const VERDICT_TONE: Record<string, StatusTone> = {
  Met: 'success',
  PartiallyMet: 'warn',
  NotMet: 'danger',
  Superseded: 'grey',
};

const SLA_TONE: Record<string, StatusTone> = {
  OnTime: 'success',
  Late: 'danger',
  Unknown: 'grey',
};

function when(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/** Minor units to a readable amount. Money is always integer minor units in this product. */
function money(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Objective closure and Outcome Review — Prompt 34.
 *
 * ## Why this is a screen of its own
 *
 * §27.1 asks for a *formal* Completed → Outcome Review → Closed → Archived lifecycle, and a
 * formal closure is a document somebody signs. Putting the verdict, the comparison and the
 * signature into the versions screen — which is about what changed between drafts — would mix the
 * question "what did we plan" with "how did it turn out".
 *
 * ## The comparison is shown twice, on purpose
 *
 * Before a review is written the figures are **live**, so a reviewer sees the current state. Once
 * written they are the **snapshot** the review was signed against. Where the two differ the screen
 * says so rather than quietly showing the newer numbers, because a late cost settlement changing a
 * signed closure is exactly what the snapshot exists to prevent.
 */
function ObjectiveClosureInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const params = useSearchParams();
  const objectiveId = params.get('objectiveId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [meta, setMeta] = useState<ClosureMetaView | null>(null);
  const [readiness, setReadiness] = useState<ClosureReadinessView | null>(null);
  const [review, setReview] = useState<OutcomeReviewView | null>(null);
  const [pauses, setPauses] = useState<ObjectivePauseView[]>([]);

  const [verdict, setVerdict] = useState<OutcomeVerdict>('Met');
  const [actualResult, setActualResult] = useState('');
  const [explanation, setExplanation] = useState('');
  const [pauseReason, setPauseReason] = useState<PauseReason>('WaitingOnSomebody');
  const [pauseNote, setPauseNote] = useState('');

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
    if (!tenantId || objectiveId === null) return;
    setError(null);

    void Promise.all([
      objectiveClosureApi.meta(tenantId, objectiveId),
      objectiveClosureApi.review(tenantId, objectiveId),
      objectiveClosureApi.pauses(tenantId, objectiveId),
    ])
      .then(([loadedMeta, loadedReview, loadedPauses]) => {
        setMeta(loadedMeta);
        setReview(loadedReview.review);
        setPauses(loadedPauses.pauses);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load the closure.'),
      );

    // Readiness is separate: it is refused outright until there is a completed version, and that
    // is a normal state rather than an error on this screen.
    void objectiveClosureApi
      .readiness(tenantId, objectiveId)
      .then(setReadiness)
      .catch(() => setReadiness(null));
  }, [objectiveId, tenantId]);

  useEffect(load, [load]);

  const act =
    (run: (tenant: string, objective: string) => Promise<unknown>, message: string) => () => {
      if (!tenantId || objectiveId === null) return;
      setBusy(true);
      setError(null);
      setNotice(null);

      void run(tenantId, objectiveId)
        .then(() => {
          setNotice(message);
          setBusy(false);
          load();
        })
        .catch((caught: unknown) => {
          // The API client flattens Nest's validation array into the message, so a multi-problem
          // refusal arrives as one readable sentence rather than as `["...","..."]`.
          setError(caught instanceof ApiError ? caught.message : 'That could not be done.');
          setBusy(false);
        });
    };

  if (objectiveId === null) {
    return (
      <Banner tone="info">
        Open a closure from an objective. This screen needs to know which one.
      </Banner>
    );
  }

  const comparison: OutcomeComparisonView | null =
    review?.comparison ?? readiness?.comparison ?? null;
  const showingSnapshot = review !== null;
  const isClosed = review?.closedAt !== null && review !== null;
  const needsExplanation = verdict !== 'Met';
  const openPause = pauses.find((entry) => entry.resumedAt === null) ?? null;

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="objective"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Objective closure' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Outcome review & closure"
        description="How the work turned out, compared with what was planned. A closure is signed, not assumed."
        breadcrumbs={[
          { label: 'Objective Optimization', href: '/objective' },
          { label: 'Outcome review' },
        ]}
        actions={
          <>
            {openPause === null ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={act(
                  (tenant, objective) =>
                    objectiveClosureApi.pause(tenant, objective, {
                      reasonKind: pauseReason,
                      reason:
                        pauseNote.trim() === '' ? PAUSE_REASON_LABELS[pauseReason] : pauseNote,
                    }),
                  'Paused. No new work will be assigned until it is resumed.',
                )}
              >
                <Icon name="clock" size={16} />
                Pause
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={act(
                  (tenant, objective) => objectiveClosureApi.resume(tenant, objective),
                  'Resumed. Work is being assigned again.',
                )}
              >
                <Icon name="bolt" size={16} />
                Resume
              </Button>
            )}
            <Button
              size="sm"
              disabled={busy}
              onClick={act(
                (tenant, objective) => objectiveClosureApi.complete(tenant, objective),
                'Marked complete. The outcome review comes next.',
              )}
            >
              Mark complete
            </Button>
          </>
        }
      />

      {error === null ? null : (
        <Banner tone="danger">
          <Icon name="shield" size={16} />
          {error}
        </Banner>
      )}
      {notice === null ? null : <Banner tone="info">{notice}</Banner>}

      {openPause === null ? null : (
        <Banner tone="warn">
          <Icon name="clock" size={16} />
          Paused since {when(openPause.pausedAt)} — {openPause.reason}. {meta?.pauseEffect ?? ''}
        </Banner>
      )}

      <div className="uboss-grid">
        {/* ---- what is outstanding ---- */}
        {readiness === null || readiness.readiness.outstanding.length === 0 ? null : (
          <Card>
            <CardBody>
              <div className="uboss-section-label">Before this can be closed</div>
              {readiness.readiness.outstanding.map((problem, index) => (
                <p
                  key={index}
                  className="uboss-notice-min"
                  // Blocking problems read as problems; the rest are things a reviewer should see
                  // and may still decide to close over.
                  style={{
                    color: readiness.readiness.blocking.includes(problem) ? undefined : 'inherit',
                  }}
                >
                  <Icon
                    name={readiness.readiness.blocking.includes(problem) ? 'alert' : 'file'}
                    size={14}
                  />
                  {problem}
                </p>
              ))}
              {readiness.readiness.blocking.length === 0 ? (
                <p className="uboss-muted">
                  None of these prevent a closure. Closing anyway is a decision the review records.
                </p>
              ) : null}
            </CardBody>
          </Card>
        )}

        {/* ---- the comparison ---- */}
        <Card>
          <CardBody>
            <div className="uboss-spread">
              <div className="uboss-section-label">Expected against actual</div>
              <StatusBadge
                tone={showingSnapshot ? 'blue' : 'grey'}
                status={showingSnapshot ? 'As signed' : 'Live figures'}
              />
            </div>

            {comparison === null ? (
              <p className="uboss-muted">
                Nothing to compare yet. An objective has an outcome once it has been completed.
              </p>
            ) : (
              <>
                <div className="uboss-kv">
                  <span>Expected final result</span>
                  <strong>{comparison.expectedFinalResult}</strong>
                </div>
                {review === null ? null : (
                  <div className="uboss-kv">
                    <span>What actually happened</span>
                    <strong>{review.actualResult}</strong>
                  </div>
                )}

                <div className="uboss-row-2">
                  <div className="uboss-kv">
                    <span>Target</span>
                    <strong>{when(comparison.targetDate)}</strong>
                  </div>
                  <div className="uboss-kv">
                    <span>Finished</span>
                    <strong>{when(comparison.completedAt)}</strong>
                  </div>
                </div>

                <div className="uboss-row-2">
                  <div className="uboss-kv">
                    <span>Human tasks</span>
                    <strong>
                      {comparison.humanTasksCompleted} of {comparison.humanTasksTotal} finished
                    </strong>
                  </div>
                  <div className="uboss-kv">
                    <span>AI cost</span>
                    <strong>{money(comparison.aiCostMinor, comparison.aiCostCurrency)}</strong>
                  </div>
                </div>

                <div className="uboss-row-2">
                  <div className="uboss-kv">
                    <span>Agent runs</span>
                    <strong>{comparison.agentRunsTotal}</strong>
                  </div>
                  <div className="uboss-kv">
                    <span>Exceptions</span>
                    <strong>
                      {comparison.exceptionsUnresolved} unresolved of {comparison.exceptionsTotal}
                    </strong>
                  </div>
                </div>

                {comparison.humanElapsedMinutes === null ? null : (
                  <p className="uboss-notice-min">
                    <Icon name="clock" size={14} />
                    {Math.round(comparison.humanElapsedMinutes / 60)} hour(s) elapsed between tasks
                    starting and finishing. That is wall-clock time, <strong>not effort</strong> —
                    UBoss records no time log, so it is not comparable with the AI cost beside it.
                  </p>
                )}
              </>
            )}
          </CardBody>
        </Card>

        {/* ---- the verdict ---- */}
        <Card>
          <CardBody>
            <div className="uboss-section-label">The verdict</div>

            {review !== null ? (
              <>
                <div className="uboss-spread">
                  <StatusBadge
                    tone={VERDICT_TONE[review.verdict] ?? 'grey'}
                    status={OUTCOME_VERDICT_LABELS[review.verdict as OutcomeVerdict]}
                  />
                  <StatusBadge
                    tone={SLA_TONE[review.slaOutcome] ?? 'grey'}
                    status={
                      SLA_OUTCOME_LABELS[review.slaOutcome as SlaOutcome] +
                      (review.daysLate !== null && review.daysLate > 0
                        ? ` by ${review.daysLate} day(s)`
                        : '')
                    }
                  />
                </div>

                {review.explanation === null ? null : (
                  <p className="uboss-muted">{review.explanation}</p>
                )}

                <div className="uboss-row-2">
                  <div className="uboss-kv">
                    <span>Reviewed</span>
                    <strong>{when(review.reviewedAt)}</strong>
                  </div>
                  <div className="uboss-kv">
                    <span>Signed off</span>
                    <strong>
                      {review.signedOffAt === null ? 'Not yet' : when(review.signedOffAt)}
                    </strong>
                  </div>
                </div>

                <p className="uboss-notice-min">
                  <Icon name="shield" size={14} />
                  Judged under the &ldquo;{review.signOffPolicy}&rdquo; sign-off rule, which is the
                  one that was in force when the review was written.
                </p>

                <div className="uboss-actions">
                  {review.signedOffAt === null && !isClosed ? (
                    <Button
                      disabled={busy}
                      onClick={act(
                        (tenant, objective) => objectiveClosureApi.signOff(tenant, objective),
                        'Signed off. It can be closed now.',
                      )}
                    >
                      Sign off as the owner
                    </Button>
                  ) : null}
                  {isClosed ? (
                    <Button
                      variant="navy"
                      disabled={busy}
                      onClick={act(
                        (tenant, objective) => objectiveClosureApi.archive(tenant, objective),
                        'Archived. Nothing leaves the archive — reopening the work is a new draft.',
                      )}
                    >
                      Archive
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={act(
                        (tenant, objective) => objectiveClosureApi.close(tenant, objective),
                        'Closed.',
                      )}
                    >
                      Close this objective
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="uboss-muted">
                  Say how it turned out. The verdict and what actually happened are the only parts
                  of this review recorded nowhere else in UBoss.
                </p>

                <div className="uboss-grid">
                  {OUTCOME_VERDICTS.map((candidate) => (
                    <label key={candidate} className="uboss-kv">
                      <input
                        type="radio"
                        name="verdict"
                        value={candidate}
                        checked={verdict === candidate}
                        onChange={() => setVerdict(candidate)}
                      />
                      <span>
                        <strong>{OUTCOME_VERDICT_LABELS[candidate]}</strong>
                        <span className="uboss-muted" style={{ fontSize: 12 }}>
                          {' '}
                          — {OUTCOME_VERDICT_DESCRIPTIONS[candidate]}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>

                <label>
                  <span className="uboss-section-label">What actually happened</span>
                  <textarea
                    value={actualResult}
                    onChange={(event) => setActualResult(event.target.value)}
                    rows={3}
                    placeholder="Every supplier contract was reviewed and signed by the quarter end."
                  />
                </label>

                {needsExplanation ? (
                  <label>
                    <span className="uboss-section-label">
                      Why — at least {meta?.minExplanationLength ?? 40} characters
                    </span>
                    <textarea
                      value={explanation}
                      onChange={(event) => setExplanation(event.target.value)}
                      rows={3}
                      placeholder="Two of the eleven contracts were still with legal at the quarter end."
                    />
                  </label>
                ) : null}

                <div className="uboss-actions">
                  <Button
                    variant="primary"
                    disabled={
                      busy ||
                      actualResult.trim().length < 10 ||
                      (needsExplanation &&
                        explanation.trim().length < (meta?.minExplanationLength ?? 40))
                    }
                    onClick={act(
                      (tenant, objective) =>
                        objectiveClosureApi.writeReview(tenant, objective, {
                          verdict,
                          actualResult: actualResult.trim(),
                          ...(needsExplanation ? { explanation: explanation.trim() } : {}),
                        }),
                      'Reviewed. It needs a sign-off before it can be closed.',
                    )}
                  >
                    Record the review
                  </Button>
                </div>
              </>
            )}
          </CardBody>
        </Card>

        {/* ---- pause history ---- */}
        <Card>
          <CardBody>
            <div className="uboss-section-label">Pause history</div>

            {openPause === null ? (
              <div className="uboss-row-2">
                <label>
                  <span className="uboss-section-label">If you pause it, why</span>
                  <select
                    value={pauseReason}
                    onChange={(event) => setPauseReason(event.target.value as PauseReason)}
                  >
                    {PAUSE_REASONS.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {PAUSE_REASON_LABELS[candidate]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="uboss-section-label">In your own words</span>
                  <input
                    value={pauseNote}
                    onChange={(event) => setPauseNote(event.target.value)}
                    placeholder="Waiting on the supplier’s legal team."
                  />
                </label>
              </div>
            ) : null}

            {pauses.length === 0 ? (
              <p className="uboss-muted">This objective has never been paused.</p>
            ) : (
              pauses.map((entry) => (
                <div key={entry.id} className="uboss-kv">
                  <span>
                    {PAUSE_REASON_LABELS[entry.reasonKind as PauseReason] ?? entry.reasonKind} ·{' '}
                    {when(entry.pausedAt)}
                  </span>
                  <strong>
                    {entry.resumedAt === null
                      ? 'Still paused'
                      : `${entry.daysStopped ?? 0} day(s) stopped`}
                  </strong>
                </div>
              ))
            )}
            {openPause === null && pauses.length > 0 ? (
              <p className="uboss-notice-min">
                <Icon name="file" size={14} />
                Every pause is kept, not just the current one — &ldquo;how much of the quarter did
                this work spend stopped&rdquo; is a question a delivery review asks.
              </p>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <p className="uboss-notice-min">
              <Icon name="shield" size={14} />
              {meta?.note ?? ''}
            </p>
            <div className="uboss-actions">
              <Link href={`/objective/versions?objectiveId=${encodeURIComponent(objectiveId)}`}>
                <Button size="sm">Versions &amp; compare</Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      </div>
    </AppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function ObjectiveClosurePage() {
  return (
    <Suspense fallback={null}>
      <ObjectiveClosureInner />
    </Suspense>
  );
}
