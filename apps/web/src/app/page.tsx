import { redirect } from 'next/navigation';

/**
 * The front door.
 *
 * There is no public landing page and no public company signup, so the only thing "/" can
 * sensibly do is take somebody to the sign-in screen. Anyone already signed in is sent on to their
 * workspace from there, which is the same path the rest of the product uses — this route does not
 * need to know about sessions to do its one job.
 *
 * ## What this replaced
 *
 * A Prompt 1 bootstrap page that said "Repository foundation is in place. Product screens are
 * added one prompt at a time." and offered three links: Sign in, **the design system gallery**,
 * and a platform health check. It survived forty-four prompts because nothing navigates to "/" —
 * every screen links to a real route — so it was only ever seen by somebody typing the bare host,
 * which is exactly what a customer or an evaluator does first.
 *
 * The design-system link is the part that mattered: it advertised an internal development surface
 * on the one page an anonymous visitor is most likely to reach. Those pages hold no real data —
 * they are static previews with hardcoded sample props — but a development gallery is not
 * something to put a signpost to on the front door.
 */
export default function HomePage() {
  redirect('/login');
}
