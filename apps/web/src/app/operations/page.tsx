import { redirect } from 'next/navigation';

/**
 * Operations is a group in the sidebar, not a screen.
 *
 * It was a screen, and it was a third place showing what two others already showed: the human
 * work waiting on somebody, and the agent work they may run. Those are To-do List and Engine
 * Agents. An admin who opened it saw two empty panels, because an admin defines work rather than
 * being assigned it — which made the duplication obvious and the screen useless at the same time.
 *
 * The route stays and redirects, rather than being deleted, because links to it exist — in
 * notifications, in somebody's bookmarks, in a message a colleague sent. A dead route that 404s
 * would turn those into a fault the reader cannot explain.
 *
 * The company-wide version of the same question — who is working, on what, and what is stuck —
 * is the Dashboard's "Where the work is". That is a different question asked by a different
 * person, and it has its own screen for that reason.
 */
export default function OperationsPage(): never {
  redirect('/todo');
}
