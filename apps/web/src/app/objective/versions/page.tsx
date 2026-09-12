'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import {
  FORM2_SECTION_LABELS,
  OBJECTIVE_STATUS_TONES,
  VERSION_ORIGIN_LABELS,
  type Form2Section,
  type ObjectiveStatus,
  type VersionOrigin,
} from '@uboss/types';
import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  Icon,
  PageHeader,
  ProgressStep,
  StatusBadge,
  type ProgressStepItem,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  objectivesApi,
  type MeResponse,
  type ObjectiveCompareView,
  type ObjectiveHistoryEntry,
  type ObjectiveHistoryView,
} from '../../../lib/api-client';
import { useNotificationBell } from '../../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

/** "V2 · Draft", the reference's timeline label. */
function timelineLabel(entry: ObjectiveHistoryEntry): string {
  return `V${entry.versionNumber} · ${entry.live ? 'Live' : entry.statusLabel}`;
}

/**
 * The sub-line under each timeline entry.
 *
 * Says where the version came from and what has happened to it. Where the prototype hard-coded
 * "You · today — new draft from live", this reports the actual provenance the API returns, because
 * with a rollback in the history "new draft from live" would simply be untrue.
 */
function timelineSub(entry: ObjectiveHistoryEntry): string {
  const parts: string[] = [];

  if (entry.copiedFromVersionNumber !== null) {
    parts.push(
      entry.origin === 'Rollback'
        ? `rolled back from V${entry.copiedFromVersionNumber}`
        : `copied from V${entry.copiedFromVersionNumber}`,
    );
  } else {
    parts.push(VERSION_ORIGIN_LABELS[entry.origin as VersionOrigin].toLowerCase());
  }

  if (entry.publishedAt !== null) {
    parts.push(`published ${new Date(entry.publishedAt).toLocaleDateString()}`);
  }
  if (entry.live) {
    parts.push('immutable');
  }
  if (entry.sentBackAt !== null && !entry.live) {
    parts.push('sent back for changes');
  }

  return parts.join(' · ');
}

/**
 * Objective versions and compare — the reference's `objVersions()`.
 *
 * Its layout: a 280px version timeline on the left, the detail on the right, the warn banner about
 * editing a live objective, and "Compare V1 ↔ V2" / "Publish" in the action row.
 *
 * ## Three deliberate departures from the prototype, all recorded in `docs/UX_MAP.md`
 *
 *   1. **This screen was orphaned** — one of the seven known prototype defects, reachable by no
 *      link. It is linked from the objective form and the list here.
 *   2. **"What changed" is the real diff**, computed by the API from the two versions, not the
 *      prototype's three hard-coded rows. The prototype's third row was "Cost impact +$0.06 /
 *      run", which nothing in this prompt computes — carrying a fabricated cost forward would be
 *      the fixture-as-truth mistake, and an invented number about money at that.
 *   3. **The compare is selectable.** The prototype's single "Compare V1 ↔ V2" button assumes two
 *      versions; a real objective can have any number, so the two ends are chosen.
 */
function ObjectiveVersionsInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const params = useSearchParams();
  const objectiveId = params.get('objectiveId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [history, setHistory] = useState<ObjectiveHistoryView | null>(null);
  const [fromId, setFromId] = useState<string>('');
  const [toId, setToId] = useState<string>('');
  const [compare, setCompare] = useState<ObjectiveCompareView | null>(null);
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

    void objectivesApi
      .versionHistory(tenantId, objectiveId)
      .then((loaded) => {
        setHistory(loaded);
        // Default the comparison to the two newest versions, which is what somebody looking at
        // this screen almost always wants.
        const newest = loaded.entries[0];
        const previous = loaded.entries[1];
        setToId(newest?.versionId ?? '');
        setFromId((previous ?? newest)?.versionId ?? '');
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load the version history.',
        ),
      );
  }, [objectiveId, tenantId]);

  useEffect(load, [load]);

  const runCompare = useCallback(() => {
    if (!tenantId || objectiveId === null || fromId === '' || toId === '') return;
    setBusy(true);
    setError(null);

    void objectivesApi
      .compareVersions(tenantId, objectiveId, fromId, toId)
      .then((result) => {
        setCompare(result);
        setBusy(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not compare those versions.');
        setBusy(false);
      });
  }, [fromId, objectiveId, tenantId, toId]);

  const publish = useCallback(() => {
    if (!tenantId || objectiveId === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    void objectivesApi
      .publish(tenantId, objectiveId)
      .then(() => {
        setNotice('Published. It is now the live version, and the one it supersedes is archived.');
        setBusy(false);
        load();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not publish that version.');
        setBusy(false);
      });
  }, [load, objectiveId, tenantId]);

  const entries = history?.entries ?? [];
  const approvedAwaitingPublish = entries.find(
    (entry) => entry.status === 'ReadyForApproval' && entry.approvedAt !== null,
  );

  const timeline: ProgressStepItem[] = entries.map((entry) => ({
    id: entry.versionId,
    label: timelineLabel(entry),
    sub: timelineSub(entry),
    // The live version is the one that counts as done; a draft is still in flight.
    state: entry.live ? 'done' : entry.status === 'Archived' ? 'done' : 'running',
  }));

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="objective"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Objective versions' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Objective versions & compare"
        description="Every version is kept with its exact id. An edit never rewrites one."
        breadcrumbs={[
          { label: 'Objective Optimization', href: '/objective' },
          { label: history === null ? 'Versions' : `${history.code} · Versions` },
        ]}
        actions={
          <>
            <Button size="sm" onClick={runCompare} disabled={busy || entries.length < 2}>
              <Icon name="list" size={16} />
              Compare
            </Button>
            {approvedAwaitingPublish === undefined ? null : (
              <Button variant="primary" size="sm" onClick={publish} disabled={busy}>
                Publish V{approvedAwaitingPublish.versionNumber}
              </Button>
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

      <div className="uboss-grid" style={{ gridTemplateColumns: '280px 1fr' }}>
        <Card>
          <CardBody>
            <div className="uboss-section-label" style={{ marginTop: 0 }}>
              Version timeline
            </div>
            {timeline.length === 0 ? (
              <p className="uboss-muted">No versions yet.</p>
            ) : (
              <ProgressStep label="Objective version timeline" items={timeline} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            {/* The reference's warn banner, in its words. */}
            <Banner tone="warn">
              <Icon name="alert" size={16} />
              Editing a Live objective never changes it in place. Your changes are captured as a new
              Draft version; publishing it supersedes the one that is live.
            </Banner>

            <div className="uboss-row-2" style={{ marginTop: 14 }}>
              <div className="uboss-field">
                <label htmlFor="fromVersion">Compare from</label>
                <select
                  id="fromVersion"
                  value={fromId}
                  onChange={(event) => setFromId(event.target.value)}
                >
                  {entries.map((entry) => (
                    <option key={entry.versionId} value={entry.versionId}>
                      {timelineLabel(entry)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="uboss-field">
                <label htmlFor="toVersion">Compare to</label>
                <select
                  id="toVersion"
                  value={toId}
                  onChange={(event) => setToId(event.target.value)}
                >
                  {entries.map((entry) => (
                    <option key={entry.versionId} value={entry.versionId}>
                      {timelineLabel(entry)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {compare === null ? (
              <p className="uboss-notice-min">
                <Icon name="file" size={14} />
                Choose two versions and press Compare.
              </p>
            ) : (
              <>
                <div className="uboss-section-label">
                  What changed between V{compare.from.versionNumber} and V{compare.to.versionNumber}
                </div>

                {compare.diff.identical ? (
                  // Reachable, and it matters: a minor edit still creates a version, so a version
                  // identical to its parent is a real record rather than a bug to hide.
                  <Banner tone="info">
                    <Icon name="file" size={16} />
                    {compare.diff.summary} The version still exists — a minor edit creates one too.
                  </Banner>
                ) : (
                  <>
                    <p className="uboss-muted">{compare.diff.summary}</p>

                    {compare.diff.fields.map((field) => (
                      <div className="uboss-kv" key={field.key}>
                        <span className="uboss-kv-key">
                          {field.label}
                          <br />
                          <small className="uboss-muted-3">
                            {FORM2_SECTION_LABELS[field.section as Form2Section]}
                          </small>
                        </span>
                        <span className="uboss-kv-value">
                          <s className="uboss-muted-3">{field.before ?? '—'}</s>{' '}
                          <Icon name="arrow" size={12} /> <b>{field.after ?? '—'}</b>
                        </span>
                      </div>
                    ))}

                    {compare.diff.steps.length === 0 ? null : (
                      <>
                        <div className="uboss-section-label">Workflow steps</div>
                        {compare.diff.steps.map((change) => (
                          <div className="uboss-kv" key={`${change.position}-${change.kind}`}>
                            <span className="uboss-kv-key">
                              Step {change.position}{' '}
                              <StatusBadge
                                tone={
                                  change.kind === 'Added'
                                    ? 'success'
                                    : change.kind === 'Removed'
                                      ? 'danger'
                                      : 'warn'
                                }
                                status={change.kind}
                              />
                            </span>
                            <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                              {change.cells.length === 0 ? (
                                <span className="uboss-muted-3">
                                  The whole row was {change.kind.toLowerCase()}.
                                </span>
                              ) : (
                                change.cells.map((cell) => (
                                  <span key={cell.key} style={{ display: 'block' }}>
                                    <small className="uboss-muted-3">{cell.label}: </small>
                                    <s className="uboss-muted-3">{cell.before ?? '—'}</s>{' '}
                                    <b>{cell.after ?? '—'}</b>
                                  </span>
                                ))
                              )}
                            </span>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </>
            )}

            <hr className="uboss-sep" />

            <div className="uboss-section-label">Every version</div>
            {entries.map((entry) => (
              <div className="uboss-kv" key={entry.versionId}>
                <span className="uboss-kv-key">
                  V{entry.versionNumber}{' '}
                  <StatusBadge
                    tone={OBJECTIVE_STATUS_TONES[entry.status as ObjectiveStatus] as StatusTone}
                    status={entry.reviewStage}
                  />
                </span>
                <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                  {/* The exact version id, because the client requires history to keep it. */}
                  <small className="uboss-mono uboss-muted-3">{entry.versionId}</small>
                  <br />
                  <small className="uboss-muted-3">
                    {entry.stepCount} step{entry.stepCount === 1 ? '' : 's'}
                    {entry.sentBackReason === null ? '' : ` · sent back: ${entry.sentBackReason}`}
                  </small>
                </span>
              </div>
            ))}

            {history === null ? null : <p className="uboss-notice-min">{history.note}</p>}

            <div className="uboss-actions" style={{ marginTop: 14 }}>
              <Link href={`/objective/form?objectiveId=${encodeURIComponent(objectiveId ?? '')}`}>
                <Button size="sm">Open the form</Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      </div>
    </AppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function ObjectiveVersionsPage() {
  return (
    <Suspense fallback={null}>
      <ObjectiveVersionsInner />
    </Suspense>
  );
}
