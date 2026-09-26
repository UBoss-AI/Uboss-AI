'use client';

import { useMemo, useState } from 'react';

import { EXECUTION_STAGE_LABELS } from '@uboss/types';
import { Button, Card, CardBody, EmptyState, Icon, StatusBadge, type StatusTone } from '@uboss/ui';

import type { AgentBuilderView } from '../lib/api-client';

/**
 * Agent Builder, organised by objective.
 *
 * ## Why this is not a list of AI work
 *
 * Somebody opens this screen with one question: *which objectives still need agents?* A flat list
 * of work items cannot answer it — four rows saying "Needs setup" might be four objectives one step
 * from ready or one objective nobody has started, and those call for completely different actions.
 * So the objective is the unit, and the work inside it is what the card counts.
 *
 * It is also the continuation the client asked for: the person arrives from Objective Builder
 * having already defined this work, and the first thing they should see is the objective they
 * defined it in.
 */

/** What one objective's worth of AI work adds up to. */
interface ObjectiveGroup {
  objectiveId: string;
  code: string;
  name: string;
  department: string | null;
  owner: string | null;
  status: string;
  updatedAt: string;
  items: AgentBuilderView[];
  published: number;
  draft: number;
  needsSetup: number;
}

/** The state of one piece of AI work, in the words the client uses. */
export function agentState(item: AgentBuilderView): 'Published' | 'Draft' | 'Needs setup' {
  // Published is the agent existing and being live; everything before that is either started or
  // not. "Draft" is the honest word for setup somebody has begun and not finished.
  if (item.engineAgent !== null) return 'Published';
  return item.missing.length === 0 ? 'Draft' : 'Needs setup';
}

const STATE_TONE: Record<string, StatusTone> = {
  Published: 'success',
  Draft: 'blue',
  'Needs setup': 'warn',
};

const FILTERS = ['All', 'Needs setup', 'Draft', 'Published'] as const;
type Filter = (typeof FILTERS)[number];

export interface AgentObjectiveListProps {
  assignments: readonly AgentBuilderView[];
  /** The objective whose agents are shown. Null shows the objective cards. */
  openObjectiveId: string | null;
  onOpenObjective: (objectiveId: string | null) => void;
  onOpenAgent: (assignment: AgentBuilderView) => void;
}

export function AgentObjectiveList({
  assignments,
  openObjectiveId,
  onOpenObjective,
  onOpenAgent,
}: AgentObjectiveListProps) {
  const [filter, setFilter] = useState<Filter>('All');

  const groups = useMemo(() => {
    const byObjective = new Map<string, ObjectiveGroup>();

    for (const item of assignments) {
      /*
       * Work whose objective can no longer be read is grouped under its own id.
       *
       * It still has to appear: it is real assigned work somebody may need to finish. Dropping it
       * because its context is missing would hide the one case most worth looking at.
       */
      const context = item.context;
      const key = context?.objectiveId ?? item.assignmentId;

      const group = byObjective.get(key) ?? {
        objectiveId: key,
        code: context?.objectiveCode ?? '—',
        name: context?.objectiveName ?? item.prefill.objectiveName,
        department: context?.departmentName ?? null,
        owner: context?.ownerName ?? null,
        status: context?.objectiveStatus ?? '—',
        updatedAt: context?.updatedAt ?? '',
        items: [],
        published: 0,
        draft: 0,
        needsSetup: 0,
      };

      group.items.push(item);
      const state = agentState(item);
      if (state === 'Published') group.published += 1;
      else if (state === 'Draft') group.draft += 1;
      else group.needsSetup += 1;

      // The objective's line is as recent as the most recently touched work in it.
      if ((context?.updatedAt ?? '') > group.updatedAt) group.updatedAt = context?.updatedAt ?? '';

      byObjective.set(key, group);
    }

    return [...byObjective.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }, [assignments]);

  const shown = useMemo(() => {
    if (filter === 'All') return groups;
    return groups.filter((group) =>
      group.items.some((item) => agentState(item) === filter),
    );
  }, [filter, groups]);

  const open = groups.find((group) => group.objectiveId === openObjectiveId) ?? null;

  // -------------------------------------------------------------------------
  // Screen 2 — one objective's agents
  // -------------------------------------------------------------------------
  if (open !== null) {
    const ready = open.published;
    const total = open.items.length;

    return (
      <>
        <Card style={{ marginBottom: 14 }}>
          <CardBody>
            <div className="uboss-spread" style={{ marginBottom: 10 }}>
              <div className="uboss-section-label" style={{ marginTop: 0 }}>
                Objective context
              </div>
              <Button size="sm" onClick={() => onOpenObjective(null)}>
                <Icon name="back" size={16} />
                All objectives
              </Button>
            </div>

            {/*
              Read-only, and not because editing is hard.

              These came from Objective Builder. Offering them here would mean the same fact has
              two screens that can change it, and the second one always wins by accident.
            */}
            <div className="uboss-kv">
              <span className="uboss-kv-key">Objective</span>
              <span className="uboss-kv-value">
                {open.code} · {open.name}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Department</span>
              <span className="uboss-kv-value">{open.department ?? '—'}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Owner</span>
              <span className="uboss-kv-value">{open.owner ?? '—'}</span>
            </div>
            {open.items[0]?.context?.expectedOutcome === null ||
            open.items[0]?.context?.expectedOutcome === undefined ? null : (
              <div className="uboss-kv">
                <span className="uboss-kv-key">Expected outcome</span>
                <span className="uboss-kv-value">{open.items[0].context.expectedOutcome}</span>
              </div>
            )}

            <div className="uboss-spread" style={{ marginTop: 14 }}>
              <div className="uboss-section-label" style={{ marginTop: 0 }}>
                Agents required for this objective
              </div>
              <StatusBadge
                status={`${ready} / ${total} ready`}
                tone={ready === total ? 'success' : 'warn'}
              />
            </div>

            {open.items.map((item, index) => {
              const state = agentState(item);
              return (
                <div className="uboss-listrow" key={item.assignmentId}>
                  <div>
                    <b>
                      {index + 1}. {item.context?.stepLabel ?? item.prefill.assignedWork}
                    </b>
                    <br />
                    <small className="uboss-muted-3">
                      Agent work
                      {item.context?.stage === null || item.context?.stage === undefined
                        ? ''
                        : ` · ${EXECUTION_STAGE_LABELS[item.context.stage]}`}
                      {item.context === null || item.context.comesAfter.length === 0
                        ? ''
                        : ` · after ${item.context.comesAfter.join(', ')}`}
                    </small>
                  </div>
                  <div className="uboss-actions">
                    <StatusBadge status={state} tone={STATE_TONE[state] ?? 'grey'} />
                    <Button
                      size="sm"
                      variant={state === 'Published' ? 'default' : 'primary'}
                      onClick={() => onOpenAgent(item)}
                    >
                      {state === 'Published'
                        ? 'View / Test'
                        : state === 'Draft'
                          ? 'Continue'
                          : 'Build Agent'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardBody>
        </Card>
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Screen 1 — the objectives that need agents
  // -------------------------------------------------------------------------
  return (
    <Card style={{ marginBottom: 14 }}>
      <CardBody>
        <div className="uboss-spread" style={{ marginBottom: 12 }}>
          <div className="uboss-section-label" style={{ marginTop: 0 }}>
            Objectives that need agents
          </div>
          <div className="uboss-actions">
            {FILTERS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={filter === option ? 'primary' : 'default'}
                onClick={() => setFilter(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        </div>

        {shown.length === 0 ? (
          <EmptyState
            title={filter === 'All' ? 'No objective needs an agent' : `Nothing is ${filter}`}
            description={
              filter === 'All'
                ? 'AI work appears here once an objective that needs it has been approved and assigned.'
                : 'Try another filter.'
            }
          />
        ) : (
          shown.map((group) => (
            <div className="uboss-listrow" key={group.objectiveId}>
              <div>
                <b>{group.name}</b>
                <br />
                <small className="uboss-muted-3">
                  {group.code}
                  {group.department === null ? '' : ` · ${group.department}`}
                  {group.owner === null ? '' : ` · ${group.owner}`}
                </small>
                <br />
                <small className="uboss-muted-3">
                  {group.items.length} agent{group.items.length === 1 ? '' : 's'} required
                  {group.published > 0 ? ` · ${group.published} published` : ''}
                  {group.draft > 0 ? ` · ${group.draft} draft` : ''}
                  {group.needsSetup > 0 ? ` · ${group.needsSetup} needs setup` : ''}
                </small>
              </div>
              <div className="uboss-actions">
                <StatusBadge
                  status={
                    group.published === group.items.length ? 'Ready' : `${group.needsSetup} to do`
                  }
                  tone={group.published === group.items.length ? 'success' : 'warn'}
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => onOpenObjective(group.objectiveId)}
                >
                  {group.published === group.items.length ? 'Open objective' : 'Build agents'}
                  <Icon name="arrow" size={16} />
                </Button>
              </div>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}
