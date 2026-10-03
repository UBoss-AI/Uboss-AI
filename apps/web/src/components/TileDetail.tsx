'use client';

import { useEffect, useState } from 'react';

import {
  ENGINE_AGENT_STATUS_TONES,
  EXCEPTION_SEVERITY_TONES,
  HUMAN_TASK_STATUS_TONES,
  OBJECTIVE_STATUS_TONES,
  type DashboardTile,
} from '@uboss/types';
import {
  Button,
  Card,
  CardBody,
  Icon,
  SkeletonText,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  agentBuilderApi,
  approvalsApi,
  engineAgentsApi,
  executorApi,
  objectivesApi,
  todoApi,
} from '../lib/api-client';

import './tile-detail.css';

/** One line in the card: what it is, and how it stands. */
interface DetailRow {
  id: string;
  primary: string;
  secondary: string | null;
  status: string | null;
  tone: StatusTone;
}

export interface TileDetailProps {
  tile: DashboardTile;
  label: string;
  measure: string | null;
  href: string;
  tenantId: string;
  onOpen: (href: string) => void;
  onClose: () => void;
}

/**
 * What one work area actually holds, opened under the map.
 *
 * ## Why this exists
 *
 * Pressing a tile used to leave the dashboard immediately. The client's instruction is that it
 * should open **here**, under the map, so somebody can look at four areas in four clicks without
 * losing the screen they started on — and go in properly when they have found the one they want.
 *
 * So: one click to know, two to go. The **Open** button is the second click and it is always
 * present, because a preview that cannot be left is a worse dead end than a navigation.
 *
 * ## Why the rows are read from each section's own endpoint
 *
 * Because there is no such thing as a dashboard's version of an objective. Every row here comes
 * from the list the section itself renders, through the same route, with the same authorization —
 * so a row shown here is a row that screen would show, and a refusal here is the refusal that
 * screen would give. A summary assembled anywhere else is a second answer free to drift from the
 * first.
 *
 * Five rows, newest first. This is a glance, not the list.
 */
const PREVIEW_ROWS = 5;

export function TileDetail({
  tile,
  label,
  measure,
  href,
  tenantId,
  onOpen,
  onClose,
}: TileDetailProps) {
  const [rows, setRows] = useState<DetailRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setProblem(null);

    void loadRows(tile, tenantId)
      .then((loaded) => {
        if (live) setRows(loaded);
      })
      .catch(() => {
        /*
         * A preview that will not load says so and offers the way in anyway.
         *
         * The section itself is still reachable and will report its own failure properly. Turning
         * a failed glance into a red banner on the dashboard would be an error message about a
         * convenience, on a screen whose own data loaded fine.
         */
        if (live) {
          setRows([]);
          setProblem('This preview could not be loaded. Open the section to see it.');
        }
      });

    return () => {
      live = false;
    };
  }, [tenantId, tile]);

  return (
    <Card className="tile-detail">
      <CardBody>
        <div className="tile-detail__head">
          <div>
            <span className="tile-detail__label">{label}</span>
            {measure === null ? null : <span className="tile-detail__measure">{measure}</span>}
          </div>

          <div className="tile-detail__actions">
            <Button size="sm" variant="primary" onClick={() => onOpen(href)}>
              Open {label}
              <Icon name="arrow" size={15} />
            </Button>
            <Button size="sm" onClick={onClose} aria-label={`Close the ${label} preview`}>
              <Icon name="close" size={15} />
            </Button>
          </div>
        </div>

        {rows === null ? (
          <SkeletonText lines={3} />
        ) : rows.length === 0 ? (
          <p className="uboss-muted-3 tile-detail__empty">
            {problem ??
              /*
               * Nothing here is good news on a queue and neutral everywhere else, so it is said
               * plainly rather than dressed up. A preview that hid itself when empty would be one
               * people stop trusting when it is full.
               */
              `Nothing in ${label} right now.`}
          </p>
        ) : (
          <ul className="tile-detail__rows">
            {rows.map((row) => (
              <li key={row.id} className="tile-detail__row">
                <span className="tile-detail__row-text">
                  <span className="tile-detail__row-primary">{row.primary}</span>
                  {row.secondary === null ? null : (
                    <span className="tile-detail__row-secondary">{row.secondary}</span>
                  )}
                </span>
                {row.status === null ? null : <StatusBadge status={row.status} tone={row.tone} />}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The first few rows of a work area, from that area's own list route.
 *
 * A tile with no list — Hierarchy, Workspace Chat, Settings — returns none, and the card then says
 * so and offers the way in. Inventing a summary for a place that is not a queue would be making
 * something up, which is the one thing this screen may not do.
 */
async function loadRows(tile: DashboardTile, tenantId: string): Promise<DetailRow[]> {
  switch (tile) {
    case 'objectives': {
      const result = await objectivesApi.list(tenantId);
      return result.objectives.slice(0, PREVIEW_ROWS).map((row) => ({
        id: row.id,
        primary: row.objectiveName,
        secondary: `${row.code} · ${row.departmentName ?? '—'}`,
        status: row.statusLabel,
        tone: OBJECTIVE_STATUS_TONES[row.status] as StatusTone,
      }));
    }

    case 'tasks': {
      const result = await todoApi.list(tenantId, { filter: 'mine' });
      return result.tasks.slice(0, PREVIEW_ROWS).map((row) => ({
        id: row.id,
        primary: row.title,
        secondary: row.objectiveName ?? null,
        status: row.displayStatus,
        tone: HUMAN_TASK_STATUS_TONES[row.status] as StatusTone,
      }));
    }

    case 'agents': {
      const result = await engineAgentsApi.list(tenantId);
      return result.agents.slice(0, PREVIEW_ROWS).map((row) => ({
        id: row.id,
        primary: row.name,
        secondary: row.pausedReason ?? null,
        status: row.status,
        tone: ENGINE_AGENT_STATUS_TONES[row.status] as StatusTone,
      }));
    }

    case 'agent-builder': {
      const result = await agentBuilderApi.list(tenantId);
      return result.assignments
        .filter((row) => row.engineAgent === null)
        .slice(0, PREVIEW_ROWS)
        .map((row) => ({
          id: row.assignmentId,
          primary: row.prefill.suggestedAgentName,
          secondary: row.prefill.objectiveName,
          status: row.readiness.readyToTest ? 'Ready to test' : `${row.missing.length} to answer`,
          tone: row.readiness.readyToTest ? 'success' : 'warn',
        }));
    }

    case 'approvals': {
      const result = await approvalsApi.list(tenantId, { status: 'Pending' });
      return result.requests.slice(0, PREVIEW_ROWS).map((row) => ({
        id: row.id,
        primary: row.title,
        secondary: row.submittedAt ? new Date(row.submittedAt).toLocaleDateString() : null,
        status: row.bucket ?? null,
        tone: row.bucket === 'Overdue' ? 'danger' : 'warn',
      }));
    }

    case 'exceptions': {
      const result = await executorApi.list(tenantId, { openOnly: true });
      return result.exceptions.slice(0, PREVIEW_ROWS).map((row) => ({
        id: row.id,
        primary: row.kindLabel,
        secondary: row.detail,
        status: row.severity,
        tone: EXCEPTION_SEVERITY_TONES[row.severity] as StatusTone,
      }));
    }

    /*
     * No list, and the card says so rather than inventing one.
     *
     * These are places you go, not queues you work through — and `stage` has its own card
     * entirely, drawn by `StageOverview`, so it never reaches this function.
     */
    case 'hierarchy':
    case 'chat':
    case 'performance':
    case 'reports':
    case 'settings':
    case 'stage':
      return [];
  }
}
