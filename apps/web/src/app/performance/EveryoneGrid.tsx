'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  departmentColour,
  EmptyState,
  FilterBar,
  MedalBadge,
  MetricCard,
  SearchField,
  SegmentedControl,
  SkeletonText,
} from '@uboss/ui';

import {
  accessApi,
  ApiError,
  performanceApi,
  type TrackerCard,
  type TrackerGrid,
} from '../../lib/api-client';
import { initialsOf, needsAttention, type Lens, LENS_LABELS, LENS_OPTIONS } from './people-shared';

/**
 * Performance for everybody, rather than for the person reading it.
 *
 * ## Why this is a view of Performance and not a screen of its own
 *
 * It was one — "Task & Tracker", its own sidebar entry, its own route. That was a third place
 * showing people and their work, beside Performance and the Hierarchy, and the client's answer
 * was the obvious one: Performance already shows an employee, it was simply only ever showing
 * *one*. So this is the same screen with the audience changed, the way Hierarchy is one screen
 * with Tree and List. One destination, one set of filters, one thing to learn.
 *
 * ## Who sees it
 *
 * `performance:Administer`, which the CompanyAdmin template holds alone — Manager and Head have
 * `View` and `Export`, which is their own record and their team's, not a grid of everybody's
 * account state. The toggle is not offered without it, and the route behind it refuses on its own.
 *
 * ## Why the card carries only the password
 *
 * It carried whichever account action applied — invite, resend or reset — which put "Send
 * invitation" on the face of a hundred cards and turned a read-only grid into a place where
 * accounts get administered in bulk. Inviting somebody claims a seat and is refused unless they
 * already have a department, a manager and a role: that is a paragraph, not a tile. An
 * administrator never sees a token or a password here; every action sends a link to the person.
 */
export function EveryoneGrid({ tenantId }: { tenantId: string | null }) {
  const router = useRouter();

  const [grid, setGrid] = useState<TrackerGrid | null>(null);
  const cards = grid?.cards ?? null;
  const [error, setError] = useState<string | null>(null);

  const [sending, setSending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const [query, setQuery] = useState('');
  const [lens, setLens] = useState<Lens>('all');

  const load = useCallback(() => {
    if (!tenantId) return;
    setError(null);

    performanceApi
      .tracker(tenantId)
      .then(setGrid)
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load everybody’s performance.',
        ),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  /**
   * Send the reset link.
   *
   * Reloads afterwards rather than patching the card: an administrator who presses it twice
   * should see the answer the server would give, not one this screen remembered.
   */
  const sendReset = async (card: TrackerCard) => {
    if (!tenantId) return;
    setSending(card.userId);
    setNotice(null);

    try {
      const answer = await accessApi.sendPasswordReset(tenantId, card.userId);
      setNotice({
        tone: 'ok',
        text: `A reset link is on its way to ${answer.email}. You will not see it — ${card.name} sets their own password from it.`,
      });
      load();
    } catch (caught: unknown) {
      // The server's own words. A refusal here is usually actionable, and "something went wrong"
      // throws away the only useful part of it.
      setNotice({
        tone: 'danger',
        text: caught instanceof ApiError ? caught.message : 'That did not go through.',
      });
    } finally {
      setSending(null);
    }
  };

  /*
   * Counted from every card rather than from the filtered list: the strip says what is true of
   * the company, and a filter that hides the two people with overdue work must not also make the
   * number reporting them go to zero.
   */
  const summary = useMemo(() => {
    const all = cards ?? [];
    return {
      people: all.length,
      attention: all.filter(needsAttention).length,
      waiting: all.filter(
        (card) => card.account.action === 'Invite' || card.account.action === 'Resend',
      ).length,
      unreachable: all.filter((card) => card.account.action === 'None').length,
    };
  }, [cards]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (cards ?? [])
      .filter((card) => matchesLens(card, lens) && matchesSearch(card, needle))
      .sort(byUrgency);
  }, [cards, lens, query]);

  if (error !== null) return <Banner tone="danger">{error}</Banner>;

  if (cards === null) {
    return (
      <Card>
        <CardBody>
          <SkeletonText lines={6} />
        </CardBody>
      </Card>
    );
  }

  if (cards.length === 0) {
    /*
      Not "nobody here".

      A card is made for somebody who has been given access, and on a company that has just
      imported its org chart that is nobody at all. Saying so and stopping would be a dead end;
      the useful sentence is how many are waiting for an invitation and how many cannot be sent
      one until an address is recorded.
    */
    return (
      <EmptyState
        icon="users"
        title="Nobody has been given access yet"
        description={
          grid === null || grid.notInvited === 0
            ? 'People appear here once they have a UBoss account — invited or active.'
            : `${grid.notInvited} ${grid.notInvited === 1 ? 'person is' : 'people are'} in the hierarchy without an account. ` +
              (grid.invitable === 0
                ? 'None of them has a work address, so none can be invited until one is recorded.'
                : `${grid.invitable} ${grid.invitable === 1 ? 'has' : 'have'} a work address and can be invited today; the rest need one first.`)
        }
        actions={
          <>
            <Button variant="primary" onClick={() => router.push('/settings/users')}>
              Open Users &amp; Access
            </Button>
            <Button variant="default" onClick={() => router.push('/hierarchy')}>
              Open Hierarchy
            </Button>
          </>
        }
      />
    );
  }

  return (
    <>
      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}

      {/*
        The answer before the grid. Each figure is also the filter for itself, so reading
        "2 need attention" and seeing those two is one press rather than two.
      */}
      <div className="uboss-tracker-summary">
        <MetricCard
          label="People"
          value={summary.people}
          onSelect={() => setLens('all')}
          className={lens === 'all' ? 'uboss-tracker-metric--on' : ''}
        />
        <MetricCard
          label="Need attention"
          value={summary.attention}
          {...(summary.attention > 0 ? { delta: 'overdue or failed', trend: 'down' as const } : {})}
          onSelect={() => setLens('attention')}
          className={lens === 'attention' ? 'uboss-tracker-metric--on' : ''}
        />
        <MetricCard
          label="Not signed in yet"
          value={summary.waiting}
          onSelect={() => setLens('notInvited')}
          className={lens === 'notInvited' ? 'uboss-tracker-metric--on' : ''}
        />
        <MetricCard
          label="No work address"
          value={summary.unreachable}
          onSelect={() => setLens('noAddress')}
          className={lens === 'noAddress' ? 'uboss-tracker-metric--on' : ''}
        />
      </div>

      <FilterBar
        actions={
          lens === 'all' && query === '' ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setLens('all');
                setQuery('');
              }}
            >
              Clear
            </Button>
          )
        }
      >
        <SearchField
          label="Search people"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, employee ID, designation or department"
        />
        <SegmentedControl
          label="Who to show"
          value={lens}
          onChange={(value) => setLens(value as Lens)}
          options={LENS_OPTIONS}
        />
      </FilterBar>

      {shown.length === 0 ? (
        <EmptyState
          icon="search"
          title="Nobody matches that"
          description={
            lens === 'all'
              ? 'No name, employee ID, designation or department contains what you typed.'
              : `No one under “${LENS_LABELS[lens]}”${query === '' ? '' : ' also matches that search'}.`
          }
          actions={
            <Button
              variant="default"
              onClick={() => {
                setLens('all');
                setQuery('');
              }}
            >
              Show everybody
            </Button>
          }
        />
      ) : (
        <div className="uboss-tracker-grid">
          {shown.map((card) => (
            <PersonCard
              key={card.userId}
              card={card}
              busy={sending === card.userId}
              /*
                Their performance screen, which is this same screen with a person named — not a
                second detail page showing the same person over again.
              */
              onOpen={() => router.push(`/performance?userId=${encodeURIComponent(card.userId)}`)}
              onReset={() => void sendReset(card)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function matchesLens(card: TrackerCard, lens: Lens): boolean {
  if (lens === 'all') return true;
  if (lens === 'attention') return needsAttention(card);
  if (lens === 'noAddress') return card.account.action === 'None';
  return card.account.action === 'Invite' || card.account.action === 'Resend';
}

/** Name, employee id, designation or department — whatever somebody has in mind when they type. */
function matchesSearch(card: TrackerCard, query: string): boolean {
  if (query === '') return true;
  const hay = [card.name, card.employeeId, card.designation, card.department]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  return hay.includes(query);
}

/**
 * Who comes first.
 *
 * Alphabetical is the wrong default for a screen somebody opens to find a problem: it buries the
 * two people with failed runs behind forty with nothing to report. Overdue and failures lead,
 * then the busiest, then by name so the order is stable and a second visit looks the same.
 */
function byUrgency(a: TrackerCard, b: TrackerCard): number {
  const weight = (card: TrackerCard) => card.tasks.overdue * 10 + card.runs.failed * 5;
  const difference = weight(b) - weight(a);
  if (difference !== 0) return difference;
  if (b.tasks.open !== a.tasks.open) return b.tasks.open - a.tasks.open;
  return a.name.localeCompare(b.name);
}

/**
 * One person's card.
 *
 * The rail and the disc take their colour from `departmentColour`, the same function the org
 * chart uses — so Production is the same colour on both screens, and somebody who has learnt the
 * chart can read this grid without learning it again.
 */
function PersonCard({
  card,
  busy,
  onOpen,
  onReset,
}: {
  card: TrackerCard;
  busy: boolean;
  onOpen: () => void;
  onReset: () => void;
}) {
  const colour = departmentColour(card.department ?? '');
  const canReset = card.account.action === 'Reset';
  const blocked = canReset
    ? null
    : card.account.action === 'None'
      ? card.account.reason
      : 'No password to reset yet — open them to send an invitation.';

  return (
    <Card className="uboss-tracker-card">
      <span
        className="uboss-tracker-card__rail"
        style={{ background: colour }}
        aria-hidden="true"
      />
      <CardBody>
        {/*
          The body opens the person; the button inside does not. Two controls rather than a card
          that is entirely a button, because a card that is a button has nowhere to put a second
          action — and the password is the one thing asked to be reachable without going in.
        */}
        <button type="button" className="uboss-tracker-card__open" onClick={onOpen}>
          <span className="uboss-tracker-card__person">
            <span
              className="uboss-tracker-card__disc"
              style={{ background: colour }}
              aria-hidden="true"
            >
              {initialsOf(card.name)}
            </span>
            <span className="uboss-tracker-card__who">
              <span className="uboss-tracker-card__name">{card.name}</span>
              <span className="uboss-tracker-card__role">
                {card.designation ?? 'No designation'}
              </span>
              <span className="uboss-tracker-card__dept">
                {card.department ?? 'No department'}
                {card.employeeId === null ? '' : ` · ${card.employeeId}`}
              </span>
            </span>
          </span>

          <span className="uboss-tracker-card__stats">
            <Figure value={card.tasks.open} label="open" />
            <Figure value={card.tasks.overdue} label="overdue" warn />
            <Figure value={card.runs.total} label="runs" />
            <Figure value={card.runs.failed} label="failed" warn />
          </span>

          <span className="uboss-tracker-card__foot">
            {/*
              The badge the product already awards — but only once there is one. At zero every
              person reads "Starter", which is accurate and says nothing; a badge on a hundred
              identical cards is decoration somebody learns to ignore.
            */}
            {card.performance.score === 0 ? (
              <span className="uboss-tracker-noscore">No score yet</span>
            ) : (
              <span className="uboss-tracker-score">
                <MedalBadge tier={card.performance.level as 'Bronze'} />
                <span>{card.performance.score}</span>
              </span>
            )}
            <span className="uboss-muted">
              {card.runs.lastStartedAt === null
                ? 'No runs'
                : `Last run ${new Date(card.runs.lastStartedAt).toLocaleDateString()}`}
            </span>
          </span>
        </button>

        <div className="uboss-tracker-card__action">
          <Button
            variant="default"
            size="sm"
            disabled={!canReset || busy}
            onClick={onReset}
            /* Why it is off, on the control itself, so nobody has to guess. */
            title={canReset ? (card.account.email ?? undefined) : (blocked ?? undefined)}
          >
            {busy ? 'Sending…' : 'Send reset link'}
          </Button>
          {canReset ? null : <p className="uboss-tracker-card__reason">{blocked}</p>}
        </div>
      </CardBody>
    </Card>
  );
}

/** One count. Dimmed at zero, because four bold zeros is four things to read and nothing to know. */
function Figure({ value, label, warn }: { value: number; label: string; warn?: boolean }) {
  const tone = value === 0 ? 'uboss-tracker-stat--zero' : warn ? 'uboss-tracker-stat--warn' : '';
  return (
    <span className={`uboss-tracker-stat ${tone}`.trim()}>
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
}
