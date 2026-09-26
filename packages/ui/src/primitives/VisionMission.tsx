import { cn } from '../lib/class-names';
import { Icon } from './Icon';

export interface VisionMissionProps {
  vision: string | null;
  mission: string | null;
  /**
   * Open the editor. Omit to render the strip read-only.
   *
   * Omitted rather than disabled, because a control somebody cannot use is noise on a panel whose
   * whole job is to state the company's purpose in two sentences.
   */
  onEdit?: () => void;
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
 * purpose above it, it is an answer to "who does what, and towards what".
 *
 * ## And why it is now editable here too
 *
 * It is still editable in Settings — this adds a second door, not a second source of truth. The
 * reason is where the thought happens: somebody looking at their company's structure is the
 * person who notices the Vision is missing or wrong, and sending them to another screen to fix
 * it is how it stays missing. The empty state used to end with "a Company Admin can set it in
 * Settings", which is a screen telling somebody to go elsewhere to do the thing they are looking
 * at.
 *
 * ## The unset state is designed, not left blank
 *
 * A company that has not written a Vision yet gets a muted italic prompt rather than an empty
 * gradient panel. An empty panel reads as a failed load, which is the one thing it must not do.
 */
export function VisionMission({ vision, mission, onEdit, className }: VisionMissionProps) {
  return (
    <div className={cn('uboss-vm-strip', className)}>
      {onEdit === undefined ? null : (
        <button type="button" className="uboss-vm-edit" onClick={onEdit}>
          <Icon name="build" size={13} />
          {vision === null && mission === null ? 'Set Vision & Mission' : 'Edit'}
        </button>
      )}
      <div className={cn('uboss-vm', vision === null && 'uboss-vm--empty')}>
        <div className="uboss-vm-glow" aria-hidden="true" />
        <div className="uboss-vm-label">Company Vision</div>
        <p>{vision ?? 'No Vision recorded yet.'}</p>
      </div>
      <div className={cn('uboss-vm', 'uboss-vm--mission', mission === null && 'uboss-vm--empty')}>
        <div className="uboss-vm-glow" aria-hidden="true" />
        <div className="uboss-vm-label">Company Mission</div>
        <p>{mission ?? 'No Mission recorded yet.'}</p>
      </div>
    </div>
  );
}
