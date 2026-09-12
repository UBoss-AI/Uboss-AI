import { cn } from '../lib/class-names';

export interface VisionMissionProps {
  vision: string | null;
  mission: string | null;
  className?: string;
}

/**
 * The Company Vision and Mission strip that sits above the Organization Hierarchy.
 *
 * Taken from the client's approved reference (`vmStrip`): two panels, 1fr/1fr, the navy gradient
 * on the left and the darker one on the right, an uppercase label and a soft glow in each
 * top-right corner. The labels are **"Company Vision"** and **"Company Mission"**, verbatim.
 *
 * ## Why it belongs above the tree rather than in Settings
 *
 * The client's requirement is that the hierarchy *displays* the active company Vision and
 * Mission. A reporting structure with no stated purpose above it is an org chart; with the
 * purpose above it, it is an answer to "who does what, and towards what". Editing lives in
 * Settings → Organization.
 *
 * ## The unset state is designed, not left blank
 *
 * A company that has not written a Vision yet gets a muted italic prompt rather than an empty
 * gradient panel. An empty panel reads as a failed load, which is the one thing it must not do.
 */
export function VisionMission({ vision, mission, className }: VisionMissionProps) {
  return (
    <div className={cn('uboss-vm-strip', className)}>
      <div className={cn('uboss-vm', vision === null && 'uboss-vm--empty')}>
        <div className="uboss-vm-glow" aria-hidden="true" />
        <div className="uboss-vm-label">Company Vision</div>
        <p>{vision ?? 'No Vision recorded yet. A Company Admin can set it in Settings.'}</p>
      </div>
      <div className={cn('uboss-vm', 'uboss-vm--mission', mission === null && 'uboss-vm--empty')}>
        <div className="uboss-vm-glow" aria-hidden="true" />
        <div className="uboss-vm-label">Company Mission</div>
        <p>{mission ?? 'No Mission recorded yet. A Company Admin can set it in Settings.'}</p>
      </div>
    </div>
  );
}
