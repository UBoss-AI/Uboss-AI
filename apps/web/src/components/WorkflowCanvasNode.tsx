'use client';

import type { AnalysisNode } from '@uboss/types';
import { Icon } from '@uboss/ui';

/**
 * What drawing a node actually needs.
 *
 * Narrower than `AnalysisNode` on purpose. The canvas carries its own `CanvasNode` — the five
 * fields a diagram needs and nothing else — and asking for the full analysis node here would make
 * every caller supply a definition of done, a dependency list and a Skill version to draw a box.
 * Structural, so an `AnalysisNode` still satisfies it and nothing at the call sites changes.
 */
export interface DrawableNode {
  kind: AnalysisNode['kind'];
  label: string;
  shape: AnalysisNode['shape'];
  skillName?: string | null;
  ownerUserId?: string | null;
  ownerDesignation?: string | null;
  /**
   * The owner's name, which is the thing a reader is actually looking for.
   *
   * Not on the analysis node — that stores the id — so the screen drawing the canvas resolves it
   * from the people list it already loads for the owner dropdown. Optional, because the agent
   * canvas has no such list and a designation is still better than an id.
   */
  ownerName?: string | null;
  /** The plan's own name for this step's owner, when it matched nobody employed here. */
  unmatchedOwnerName?: string | null;
}

export interface WorkflowCanvasNodeProps {
  node: DrawableNode;
  /** Opens the node's editor drawer. */
  onOpen: () => void;
  /** An assigned plan is read-only, so its nodes are not editable. */
  editable?: boolean;
  /**
   * What this step is doing right now, in words, or null when it is idle.
   *
   * A string rather than the activity object, because the sentence — "working — 40%", "waiting",
   * the failure's own message — is already decided by the canvas, which knows when a percentage
   * can honestly be shown and when it cannot. Passing the object would move that judgement here
   * and give the product two places that decide what a running step may claim.
   */
  activityLabel?: string | null;
}

/**
 * One node on the workflow canvas, drawn in the shape its kind requires.
 *
 * ## Why this is a component of its own
 *
 * The client's locked rule is that a Human node is a rectangle, an AI node is a diamond, and the
 * Goal is visually distinct. That rule is worth a test, and a test needs something smaller than a
 * page to render — the same reason `WorkflowGrid` was extracted.
 *
 * The shape comes from `node.shape`, which the server stores and validates against `node.kind`.
 * This component deliberately does **not** decide the shape from the kind itself: two places
 * deciding one thing is how a renderer ends up disagreeing with the schema.
 */
export function WorkflowCanvasNode({
  node,
  onOpen,
  editable = true,
  activityLabel = null,
}: WorkflowCanvasNodeProps) {
  /*
   * What is happening now takes the place of what the step is for.
   *
   * A node has one quiet line under its title, and while the step is running that line is the
   * only thing on the canvas saying so. The Skill name is still true then, and still less useful
   * than "working — 40%" to somebody watching a plan execute.
   */
  const subtitle = (fallback: string) => activityLabel ?? fallback;

  /*
   * Who the step belongs to, in the order a reader wants it.
   *
   * The name first, because "Meera Iyer" is what somebody is scanning the canvas for and
   * "Field Operations Supervisor" is not. The designation is the fallback rather than the
   * headline — the node used to print it alone, so a plan of nine steps read as a list of job
   * titles and the question "who is doing this" needed a click on every box to answer.
   */
  const ownerLine =
    node.ownerUserId === null || node.ownerUserId === undefined
      ? null
      : (node.ownerName ?? node.ownerDesignation ?? 'Assigned');

  const body =
    node.shape === 'goal' ? (
      <div className="uboss-wf-goal" data-shape="goal">
        {node.label}
      </div>
    ) : node.shape === 'diamond' ? (
      <div className="uboss-wf-ai" data-shape="diamond">
        <div className="uboss-wf-ai-diamond" />
        <div className="uboss-wf-ai-label">
          <b>{node.label}</b>
          {/* Named honestly: an AI step with no approved Skill cannot run, and the Pre-Publish
              Summary reports it as a blocker. Hiding that here would make the canvas look ready. */}
          <small>{subtitle(node.skillName ?? 'No approved Skill')}</small>
          {/*
            Who answers for the agent.

            An AI step has nobody performing the work and somebody accountable for it, and the
            grid names them on the Engine row for exactly that reason. The canvas drew the Skill
            and stopped, so the one question a reader has about an agent — whose is it — could
            only be answered by opening the node.

            Its own line rather than appended to the Skill: an unowned agent is a different
            problem from an agent with no Skill, and running them together hides whichever is
            missing.
          */}
          {/*
            The reason gets a second line; a name does not need one.

            `.uboss-wf-ai-owner` is clamped to one line because "Meera Iyer" is one line. The
            sentence that replaces it when nobody is on the step is not a name — it is
            "Nikhil Narwal is not an employee on record" — and at one line the diamond cut it to
            "Nikhil Narwa… not an…", which says less than the bare "Nobody accountable" it
            replaced. The modifier is on the reason only, so an owned node keeps the room.
          */}
          <small
            className={`uboss-wf-ai-owner${ownerLine === null ? ' uboss-wf-ai-owner--reason' : ''}`}
          >
            {ownerLine === null ? unownedReason(node) : `Accountable: ${ownerLine}`}
          </small>
        </div>
      </div>
    ) : node.shape === 'gate' ? (
      <div className="uboss-wf-approve" data-shape="gate">
        <Icon name="shield" size={15} /> {node.label}
      </div>
    ) : (
      <div className="uboss-wf-node uboss-wf-node--human" data-shape="rectangle">
        <div className="uboss-wf-node-head">
          <Icon name="users" size={15} />
          {node.label}
          <span className="uboss-wf-node-tag">HUMAN</span>
        </div>
        <div className="uboss-wf-node-body">
          {ownerLine === null ? (
            <span className="uboss-muted-3">{unownedReason(node)}</span>
          ) : (
            <>{subtitle(`Owner: ${ownerLine}`)}</>
          )}
        </div>
      </div>
    );

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
      aria-label={`${editable ? 'Edit' : 'Open'} ${node.label}`}
    >
      {body}
    </button>
  );
}

/**
 * Why nobody is on this step — the cause, not the symptom.
 *
 * "Nobody accountable" is what a reader already knows by looking; what they cannot know is
 * which of two completely different problems they have. A plan that named six people and came
 * back with nobody on it is a Hierarchy problem — those names are not employees on record — and
 * the fix is adding them. A plan whose form left the column blank is a form problem, and the fix
 * is filling it in. Both used to read identically here, with the distinguishing sentence in a
 * list of gaps under the canvas that nobody scrolls to.
 *
 * Deliberately names the person. "A named person is not an employee" sends somebody hunting
 * through twenty steps; "Nikhil Narwal is not an employee on record" is a thing they can act on
 * without leaving the diagram.
 */
function unownedReason(node: DrawableNode): string {
  const named = node.unmatchedOwnerName?.trim() ?? '';
  return named === '' ? 'Nobody named in the plan' : `${named} is not an employee on record`;
}
