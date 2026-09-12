/**
 * Extension interfaces for enterprise identity — **interfaces only**.
 *
 * Prompt 5 is explicit: do not implement SSO or MFA beyond extension interfaces. Prompt 6 owns
 * MFA policy and enrolment (TOTP, WebAuthn-ready), OIDC/SAML adapters, domain verification and
 * SCIM.
 *
 * These live here so the seams are visible now and Prompt 6 does not have to reshape the
 * authentication flow to fit them. Nothing in the codebase implements or calls them yet, and no
 * partial implementation is provided — a half-built MFA check is worse than none, because it
 * looks like protection.
 */

import type { ResolvedPrincipal } from '../request-context/actor-resolver.js';

/** How a principal proved who they are. Recorded on the session once MFA/SSO exist. */
export type AuthenticationMethod = 'password' | 'totp' | 'webauthn' | 'oidc' | 'saml';

/**
 * A second factor.
 *
 * `verify` returns a boolean rather than throwing so the caller controls the failure path —
 * a failed second factor must increment the same lockout counter as a failed password, not
 * surface as a distinct error a caller could use to tell the two apart.
 */
export interface SecondFactorProvider {
  readonly method: Extract<AuthenticationMethod, 'totp' | 'webauthn'>;
  /** Is this factor enrolled for the person? */
  isEnrolled(userId: string): Promise<boolean>;
  verify(userId: string, presentedCode: string): Promise<boolean>;
}

/**
 * Company policy for how members must authenticate.
 *
 * Evaluated **after** the password succeeds and **before** a session is issued, so a company
 * that requires MFA cannot be entered with a password alone.
 */
export interface AuthenticationPolicy {
  requiresSecondFactor(userId: string, tenantId: string): Promise<boolean>;
  requiresEnterpriseSso(tenantId: string): Promise<boolean>;
}

/**
 * An enterprise identity provider (OIDC or SAML).
 *
 * Deliberately shaped so an external identity maps onto the *existing* UBoss person rather than
 * creating a parallel one: `resolvePrincipal` returns a `ResolvedPrincipal`, the same type the
 * password path produces. A person keeps one permanent UBoss Unique ID however they sign in.
 */
export interface EnterpriseIdentityProvider {
  readonly method: Extract<AuthenticationMethod, 'oidc' | 'saml'>;
  readonly tenantId: string;
  /** Where to send the browser to begin authentication. */
  authorizationUrl(state: string): Promise<string>;
  /** Exchange the provider's response for a UBoss principal. */
  resolvePrincipal(callbackPayload: unknown): Promise<ResolvedPrincipal>;
  /**
   * End the provider-side session too.
   *
   * Required, not optional: signing out of UBoss while the IdP session stays live means the next
   * visit silently signs straight back in, which is not what "log out" means to anyone.
   */
  terminateProviderSession(userId: string): Promise<void>;
}

/** Verified control of an email domain, a prerequisite for domain-based SSO routing. */
export interface DomainVerification {
  readonly tenantId: string;
  readonly domain: string;
  readonly state: 'Pending' | 'Verified' | 'Failed';
  readonly verifiedAt?: Date;
}
