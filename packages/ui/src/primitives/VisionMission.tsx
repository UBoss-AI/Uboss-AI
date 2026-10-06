import { cn } from '../lib/class-names';
import { hasWords, sanitiseRichText } from './rich-text';
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
      <Panel label="Company Mission" value={mission} mission />
      <Panel label="Company Vision" value={vision} />
    </div>
  );
}

/**
 * One panel, and the only place in the product that draws markup somebody typed.
 *
 * The API sanitises before it stores, so nothing dangerous should arrive here. It is sanitised
 * again anyway: a row written before the API knew how, a restore from an old backup, or a future
 * endpoint that forgets, each puts unfiltered markup on the first screen every employee opens.
 * Checking twice costs a parse and removes a whole class of "the other end already did it".
 *
 * `hasWords` rather than a null check, because a Vision that has been cleared in the editor comes
 * back as empty markup — `<p></p>` would draw a blank panel, and a blank panel reads as a failed
 * load, which is the one thing this must never do.
 */
function Panel({
  label,
  value,
  mission = false,
}: {
  label: string;
  value: string | null;
  mission?: boolean;
}) {
  const written = hasWords(value);
  return (
    <div className={cn('uboss-vm', mission && 'uboss-vm--mission', !written && 'uboss-vm--empty')}>
      <div className="uboss-vm-glow" aria-hidden="true" />
      <div className="uboss-vm-label">{label}</div>
      {written ? (
        <div
          className="uboss-vm-rich"
          // Sanitised on the line above, against the same list the API enforces.
          dangerouslySetInnerHTML={{ __html: sanitiseRichText(value as string) }}
        />
      ) : (
        <p>{`No ${label.replace('Company ', '')} recorded yet.`}</p>
      )}
    </div>
  );
}
