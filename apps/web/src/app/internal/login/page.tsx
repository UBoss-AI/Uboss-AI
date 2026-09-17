'use client';

import { SignInFlow } from '../../../components/SignInFlow';

/**
 * The UBoss Platform & Development Console sign-in page.
 *
 * ## Why this route exists
 *
 * Until now there was one door. Platform staff signed in at `/login` alongside customers and were
 * offered a Master Console button once the server said they were platform staff — which worked,
 * and meant the customer login carried a control most of the people looking at it must never see.
 *
 * These are two different audiences entering for two different reasons, so they now have two
 * addresses. `/internal/login` is canonical for the platform plane; `/platform/login` was the
 * alternative and would have read as a *customer-facing* plane name, which is the opposite of
 * what this is.
 *
 * ## What this page is not
 *
 * It is not a second authentication. `SignInFlow` is the same component the customer page renders,
 * with the same server calls — this route changes the composition around it and what happens after
 * the password is accepted, and nothing else.
 *
 * It is also not an authorization. Reaching this URL grants nothing: the server decides whether an
 * identity is a platform actor, every `/master` route enforces that again on its own, and a
 * company identity that signs in here is refused and signed out.
 */
export default function InternalLoginPage() {
  return <SignInFlow plane="platform" />;
}
