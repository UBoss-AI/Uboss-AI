'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import {
  AppShell,
  BadgeProgression,
  Banner,
  Card,
  CardBody,
  Icon,
  MedalBadge,
  PageHeader,
  SkeletonText,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  performanceApi,
  type MeResponse,
  type PerformancePolicyView,
  type PerformanceView,
} from '../../lib/api-client';

import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/** A person-readable label per event kind. The enum is the contract; this is the wording. */
const EVENT_LABELS: Record<string, string> = {
  OnTimeAccepted: 'Completed in time and accepted',
  LateCompletion: 'Completed after its required time',
  Missed: 'Not completed',
  QualityRejected: 'Completed in time but rejected on review',
  BlockerNeutralised: 'Approved blocker — earlier outcome neutralised',
  ManualAdjustment: 'Manual adjustment',
};

function pointsClass(points: number): string {
  if (points > 0) {
    return 'uboss-points--positive';
  }
  if (points < 0) {
    return 'uboss-points--negative';
  }
  return 'uboss-points--neutral';
}

function signed(points: number): string {
  return points > 0 ? `+${points}` : String(points);
}

/**
 * Performance — one person's score movement and badge progression.
 *
 * ## Matched to the reference's `SCR.performance`
 *
 * Two columns, `1fr 340px`. The left card carries **Badge progression** (the five-medal ladder
 * with a link to badge history) and the **Event timeline (governed events)** as key-value rows
 * with signed points and who recorded them, closing with the reference's notice. The right card
 * carries the current score as one large figure with its medal, then On-time delivery, Positive
 * events, Approved exceptions and Next threshold.
 *
 * ## Every number here is real or absent
 *
 * The prototype shows a score of 84 and "Platinum @ 88". Those came from a fixture. This screen
 * shows the score the server derived, the thresholds the company actually configured, and
 * **nothing** where there is nothing — an on-time percentage is omitted rather than shown as 0%
 * for somebody who has not completed anything, because zero is a different claim.
 *
 * ## Whose performance
 *
 * `?userId=` for somebody else, nothing for your own. The server decides: a person always reads
 * their own, a manager reads their team, an admin reads the company. A refusal is shown as a
 * refusal rather than an empty screen, so a permission boundary never looks like missing data.
 */
function PerformancePageBody() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const search = useSearchParams();
  const subjectUserId = search.get('userId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [view, setView] = useState<PerformanceView | null>(null);
  const [policy, setPolicy] = useState<PerformancePolicyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
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
    if (!tenantId) {
      return;
    }
    setError(null);

    void Promise.all([
      subjectUserId === null
        ? performanceApi.mine(tenantId)
        : performanceApi.forUser(tenantId, subjectUserId),
      performanceApi.policy(tenantId),
    ])
      .then(([performance, active]) => {
        setView(performance);
        setPolicy(active);
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load that performance record.',
        ),
      );
  }, [subjectUserId, tenantId]);

  useEffect(load, [load]);

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);

  const positiveEvents = view?.counts['OnTimeAccepted'] ?? 0;
  const neutralised = view?.counts['BlockerNeutralised'] ?? 0;

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="performance"
      onNavigate={() => undefined}
      {...bell.shellProps}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Performance' }}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Performance"
        description="Transparent score movement and badge progression."
        breadcrumbs={[{ label: 'Performance' }]}
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {view === null || policy === null ? (
        error === null ? (
          <Card>
            <CardBody>
              <SkeletonText lines={6} />
            </CardBody>
          </Card>
        ) : null
      ) : (
        <div className="uboss-grid" style={{ gridTemplateColumns: '1fr 340px' }}>
          <Card>
            <CardBody>
              <div className="uboss-actions" style={{ justifyContent: 'space-between' }}>
                <b>Badge progression</b>
                <Link
                  href={
                    subjectUserId === null
                      ? '/performance/badges'
                      : `/performance/badges?userId=${encodeURIComponent(subjectUserId)}`
                  }
                >
                  View badge history
                </Link>
              </div>

              <BadgeProgression current={view.level} thresholds={policy.thresholds} />

              <div className="uboss-section-label">Event timeline (governed events)</div>

              {view.recentEvents.length === 0 ? (
                <p className="uboss-muted">
                  No governed events yet. A score appears here as work is completed, accepted,
                  delivered late or missed — every point traceable to the work that produced it.
                </p>
              ) : (
                view.recentEvents.map((event) => (
                  <div
                    key={`${event.sourceKind}:${event.sourceId}:${event.kind}`}
                    className={`uboss-kv${event.neutralised ? ' uboss-event--neutralised' : ''}`}
                  >
                    <span className="uboss-kv-key">
                      {new Date(event.occurredAt).toLocaleDateString()} ·{' '}
                      <b className={pointsClass(event.points)}>{signed(event.points)}</b>{' '}
                      {EVENT_LABELS[event.kind] ?? event.kind}
                      {event.neutralised ? ' — neutralised by an approved blocker' : ''}
                      {event.reason === null ? '' : ` — ${event.reason}`}
                    </span>
                    <span className="uboss-kv-value uboss-muted-3">
                      {event.sourceKind}/{event.sourceId}
                    </span>
                  </div>
                ))
              )}

              <p className="uboss-notice">
                <Icon name="shield" size={14} /> Score is explainable, not a black box. Badge
                thresholds are policy-configured, not hard-coded — this record was scored under
                policy version {view.policyVersion}, and a later policy change re-derives the level
                without rewriting points already earned.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardBody>
              <div className="uboss-score">
                <div className="uboss-muted-3" style={{ fontSize: 12 }}>
                  Current score
                </div>
                <div className="uboss-score-figure">{view.score}</div>
                <MedalBadge tier={view.level} />
              </div>

              <div className="uboss-kv">
                <span className="uboss-kv-key">On-time delivery</span>
                <span className="uboss-kv-value">
                  {view.onTimePercent === null ? (
                    <span className="uboss-muted-3">Nothing completed yet</span>
                  ) : (
                    `${view.onTimePercent}%`
                  )}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Positive events</span>
                <span className="uboss-kv-value">{positiveEvents}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Approved exceptions</span>
                <span className="uboss-kv-value">
                  {neutralised === 0
                    ? 'None'
                    : `${neutralised} (${
                        policy.blockersNeutraliseFully ? 'no penalty' : 'penalty reduced'
                      })`}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Next threshold</span>
                <span className="uboss-kv-value">
                  {view.nextLevel === null ? (
                    <>
                      <MedalBadge tier="Diamond" /> — the top of the ladder
                    </>
                  ) : (
                    `${view.nextLevel.level} @ ${policy.thresholds[view.nextLevel.level]} · ${
                      view.nextLevel.pointsAway
                    } to go`
                  )}
                </span>
              </div>

              <div className="uboss-section-label">The policy behind this score</div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">In time and accepted</span>
                <span className="uboss-kv-value uboss-points--positive">
                  {signed(policy.points.onTimeAccepted)}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Completed late</span>
                <span className="uboss-kv-value uboss-points--negative">
                  {signed(policy.points.lateCompletion)}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Rejected on review</span>
                <span className="uboss-kv-value uboss-points--negative">
                  {signed(policy.points.qualityRejected)}
                </span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Not completed</span>
                <span className="uboss-kv-value uboss-points--negative">
                  {signed(policy.points.missed)}
                </span>
              </div>
            </CardBody>
          </Card>
        </div>
      )}
    </AppShell>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary: Next.js has to be able to render the shell before
 * the request's query string is known. Without one the production build fails outright rather
 * than degrading, so the boundary is the page and the screen is its child.
 */
export default function PerformancePage() {
  return (
    <Suspense fallback={null}>
      <PerformancePageBody />
    </Suspense>
  );
}
