import type { ReactNode } from 'react';

import { cn } from '../lib/class-names';
import { Icon } from './Icon';
import { StatusBadge } from './StatusBadge';

export interface ApprovalCardProps {
  title: string;
  /** Who or what raised it, and when. */
  meta: string;
  /** Business status, e.g. `'Waiting Approval'`. */
  status: string;
  /**
   * True when a Human approval is mandatory for this item.
   *
   * Locked rule: the Executor Agent monitors Human and Engine Agent work but must NEVER
   * silently bypass a required Human approval. When this is set, the card states that
   * explicitly so the requirement is visible in the UI, not just in policy.
   */
  humanApprovalRequired?: boolean;
  /** Approve / reject / request-changes actions. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function ApprovalCard({
  title,
  meta,
  status,
  humanApprovalRequired = false,
  actions,
  children,
  className,
}: ApprovalCardProps) {
  return (
    <div
      className={cn(
        'uboss-approval',
        humanApprovalRequired && 'uboss-approval--human-required',
        className,
      )}
    >
      <div className="uboss-approval-head">
        <span className="uboss-approval-title">{title}</span>
        <StatusBadge status={status} />
        <span className="uboss-approval-meta" style={{ marginLeft: 'auto' }}>
          {meta}
        </span>
      </div>

      {children}

      {humanApprovalRequired ? (
        <p className="uboss-approval-note">
          <Icon name="shield" size={13} />
          <span>
            Human approval is required. The Executor Agent can escalate or remind, but cannot
            approve this on your behalf.
          </span>
        </p>
      ) : null}

      {actions ? <div className="uboss-approval-actions">{actions}</div> : null}
    </div>
  );
}
