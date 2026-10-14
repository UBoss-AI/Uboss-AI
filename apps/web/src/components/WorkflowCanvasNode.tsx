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
          {node.ownerUserId === null ? (
            <span className="uboss-muted-3">No owner assigned</span>
          ) : (
            <>{subtitle(`Owner: ${node.ownerDesignation ?? 'assigned'}`)}</>
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
