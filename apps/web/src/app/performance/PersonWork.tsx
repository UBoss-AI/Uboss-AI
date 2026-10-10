'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  EmptyState,
  RunState,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import { accessApi, ApiError, performanceApi, type TrackerDetail } from '../../lib/api-client';
import { ACCOUNT_LABELS, ACCOUNT_STATES, elapsed, when } from './people-shared';

/**
 * What one person has actually been doing, under their score.
 *
 * ## Why this sits on the performance screen
 *
 * A score is a number somebody is asked to accept. The work behind it — what they ran, how long
 * it took, what is still on their desk — is the part that makes the number arguable, and it was
 * on no screen at all: a run is otherwise found through the agent that performed it or the
 * objective it served, never through the person who pressed the button.
 *
 * ## Only for somebody looking at another person
 *
 * The account section offers to invite somebody or to send them a reset link, which is an
 * administrator's action over a colleague. It is not rendered on one's own record — there is
 * nothing useful in being shown a button to invite yourself — and the routes behind it refuse
 * anybody without the grant regardless of what is drawn.
 */
export function PersonWork({ tenantId, userId }: { tenantId: string | null; userId: string }) {
  const [detail, setDetail] = useState<TrackerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const load = useCallback(() => {
    if (!tenantId) return;
    setError(null);

    performanceApi
      .trackerDetail(tenantId, userId)
      .then(setDetail)
      /*
       * Quietly, on purpose.
       *
       * This hangs under a record that has already loaded. A manager reading their own team
       * member's score has `performance:View` and not `performance:Administer`, so this request
       * is refused for them — and a red banner over a screen that is otherwise working would
       * report a fault where there is only a boundary.
       */
      .catch((caught: unknown) => {
        if (
          caught instanceof ApiError &&
          (caught.statusCode === 403 || caught.statusCode === 404)
        ) {
          setError(null);
          return;
        }
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load what they have run.',
        );
      });
  }, [tenantId, userId]);

  useEffect(load, [load]);

  /** Whichever account action applies: the invitation, a resend, or the reset link. */
  const act = async () => {
    if (!tenantId || detail === null) return;
    setBusy(true);
    setNotice(null);

    try {
      if (detail.account.action === 'Reset') {
        const answer = await accessApi.sendPasswordReset(tenantId, detail.userId);
        setNotice({
          tone: 'ok',
          text: `A reset link is on its way to ${answer.email}. You will not see it — ${detail.name} sets their own password from it.`,
        });
      } else {
        const answer = await accessApi.inviteExisting(tenantId, { subjectUserId: detail.userId });
        setNotice({
          tone: 'ok',
          text: answer.resent
            ? `The invitation to ${detail.name} has been sent again.`
            : `${detail.name} has been invited.`,
        });
      }
      load();
    } catch (caught: unknown) {
      // The server's own words: a refusal here is usually actionable — somebody with no
      // department cannot be invited at all — and "something went wrong" throws that away.
      setNotice({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.message : 'That did not go through.',
      });
    } finally {
      setBusy(false);
    }
  };

  if (error !== null) return <Banner tone="danger">{error}</Banner>;

  if (detail === null) {
    return (
      <Card>
        <CardBody>
          <SkeletonText lines={5} />
        </CardBody>
      </Card>
    );
  }

  return (
    <>
      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}

      {/*
        The account. Inviting somebody claims a seat and is refused unless they already have a
        department, a manager and a role — a decision with conditions attached, which is why it
        is a paragraph here rather than a button on the grid outside.
      */}
      <Card>
        <CardBody>
          <h3 className="uboss-tracker-h">Account</h3>
          <div className="uboss-tracker-account">
            <div>
              <StatusBadge status={ACCOUNT_STATES[detail.account.state] ?? detail.account.state} />
              <p className="uboss-muted">
                {detail.account.reason ??
                  (detail.account.action === 'Reset'
                    ? `${detail.name} has a password. A reset link lets them choose a new one — you will not see it.`
                    : 'An invitation claims a seat, and is refused unless they already have a department, a manager and a role.')}
              </p>
            </div>
            {detail.account.action === 'None' ? null : (
              <Button variant="default" disabled={busy} onClick={() => void act()}>
                {busy ? 'Sending…' : ACCOUNT_LABELS[detail.account.action]}
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3 className="uboss-tracker-h">Runs</h3>
          {detail.runs.length === 0 ? (
            <EmptyState
              icon="bolt"
              title="No runs started"
              description={`This counts what ${detail.name} started themselves, not work an agent did on a schedule.`}
            />
          ) : (
            <ul className="uboss-tracker-runs">
              {detail.runs.map((run) => (
                <li key={run.id}>
                  <div className="uboss-tracker-run__head">
                    <strong>{run.agent}</strong>
                    <RunState state={run.state} />
                  </div>
                  <div className="uboss-muted">
                    {when(run.startedAt)}
                    {run.elapsedMs === null
                      ? ''
                      : run.stillGoing
                        ? ` · running for ${elapsed(run.elapsedMs)}`
                        : ` · took ${elapsed(run.elapsedMs)}`}
                    {run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}
                  </div>
                  {run.failureReason === null ? null : (
                    <p className="uboss-tracker-run__why">{run.failureReason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3 className="uboss-tracker-h">Still on their desk</h3>
          {detail.openTasks.length === 0 ? (
            <EmptyState icon="check" title="Nothing outstanding" />
          ) : (
            <ul className="uboss-tracker-tasks">
              {detail.openTasks.map((task) => (
                <li key={task.id}>
                  <span>{task.title}</span>
                  <span
                    className={
                      task.overdue
                        ? 'uboss-tracker-due uboss-tracker-due--late'
                        : 'uboss-tracker-due'
                    }
                  >
                    {task.status}
                    {task.dueAt === null ? '' : ` · due ${when(task.dueAt)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
