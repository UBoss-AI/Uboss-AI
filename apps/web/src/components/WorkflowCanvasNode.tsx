'use client';

import type { AnalysisNode } from '@uboss/types';
import { Icon } from '@uboss/ui';

export interface WorkflowCanvasNodeProps {
  node: AnalysisNode;
  /** Opens the node's editor drawer. */
  onOpen: () => void;
  /** An assigned plan is read-only, so its nodes are not editable. */
  editable?: boolean;
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
export function WorkflowCanvasNode({ node, onOpen, editable = true }: WorkflowCanvasNodeProps) {
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
          <small>{node.skillName ?? 'No approved Skill'}</small>
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
            <>Owner: {node.ownerDesignation ?? 'assigned'}</>
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
