'use client';

import { SignInFlow } from '../../components/SignInFlow';

/**
 * The customer sign-in page.
 *
 * This is the front door for the people who use UBoss to run their company. It is deliberately
 * thin: the authentication itself — the methods lookup, password, MFA, enrolment, recovery codes,
 * the SSO-only answer — lives in `SignInFlow`, which the platform console's front door uses too.
 * Two copies of an authentication flow is two things to keep correct, and they would not stay that
 * way.
 *
 * What this page does not contain is as deliberate as what it does. There is no link to the
 * Master Console, no mention of the platform or of development, no environment selector and no
 * tenant or workspace id to type. A customer should not have to understand that UBoss has an
 * inside. A platform account that signs in here is told only that no company workspace is
 * available to it, which is true, and nothing about where else it might go.
 */
export default function CustomerLoginPage() {
  return <SignInFlow plane="company" />;
}
