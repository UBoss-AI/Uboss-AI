/**
 * Whether a tab's local copy of a form is work worth putting back on screen.
 *
 * ## Why this is a function and not three lines inside the page
 *
 * It got the answer wrong in production and emptied a filled objective. The rule is short, the
 * consequence is somebody's afternoon, and the failure is silent — the page announced that it
 * had *recovered* the work it had just destroyed. A decision like that belongs somewhere it can
 * be stated once and checked.
 *
 * ## What went wrong
 *
 * The objective form renders before it has anything to render: its state starts as an empty
 * `Form2Objective` and one blank row, and for the width of one network round trip that pristine
 * nothing is what the page holds. A backup effect wrote it to session storage on every change,
 * including that first one. When the server's answer arrived, the restore read the key, found
 * the empty form written milliseconds earlier, saw that it differed from what had just loaded —
 * and restored the emptiness over the draft. Anything typed afterwards autosaved it back.
 *
 * ## The rule
 *
 * Restore only what somebody typed. A backup qualifies when it is **readable**, **not what the
 * server just sent** (nothing to put back), and **not the untouched form** (nobody typed it).
 * Anything else stays where it is and the server's version keeps the screen.
 *
 * The page also refuses to *write* a backup until what is on screen is the objective's own
 * content, which is the first lock on the same door. Both exist because one of them failing
 * costs a person their work and tells them it saved it.
 */
export function shouldRestoreFormBackup(input: {
  /** What session storage holds for this form, or null when it holds nothing. */
  kept: string | null;
  /** What the server just put on screen, serialised the same way. */
  current: string;
  /** The form as it renders before anybody touches it, serialised the same way. */
  pristine: string;
}): boolean {
  if (input.kept === null) return false;
  if (input.kept === input.current) return false;
  if (input.kept === input.pristine) return false;
  return true;
}
