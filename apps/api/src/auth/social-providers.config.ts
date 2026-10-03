/**
 * Google, Microsoft and Apple sign-in, configured from the environment.
 *
 * ## Why these are not `sso_connections`
 *
 * An `sso_connection` belongs to one company: a customer registers their own Google Workspace
 * application and their own users sign in through it. These three are the other arrangement —
 * UBoss registers one application per provider and every company's people may use it.
 *
 * Both are OIDC and both reuse the same provider machinery. The difference is only where the
 * credentials live and who they belong to, which is why these are read from the environment and
 * those are read from a row.
 *
 * ## What signing in this way does NOT do
 *
 * It never creates an account. There is no public signup anywhere in UBoss, and that does not stop
 * being true because the identity arrived from Google: after the provider confirms an email
 * address, that address must already belong to an invited, active identity or the sign-in is
 * refused. Anyone can obtain a Google account; that must not be a way into somebody's company.
 *
 * ## Absent by default
 *
 * A provider with no credentials is simply not offered. Nothing here invents a client id, and a
 * half-configured provider — an id with no secret — is treated as absent rather than being
 * offered and then failing at the redirect, which would look like the product is broken rather
 * than unconfigured.
 */

/**
 * Whether a person can actually complete a sign-in with Google, Microsoft or Apple.
 *
 * **True now.** It was false for the few hours between discovering that the flow did not exist
 * and building it: the configuration reader, the database columns and the three buttons were all
 * here, and the middle was missing — no route behind the button, and `complete` refusing a social
 * request outright. The screen advertised a provider the moment credentials appeared in the
 * environment, so setting `GOOGLE_CLIENT_ID` would have switched on a button that 404ed.
 *
 * The constant stays rather than being deleted, because the condition it expresses is real and
 * the next person needs it: a provider is offered when this deployment has credentials **and**
 * the product can finish the job. Holding one without the other is how a dead button gets shipped
 * looking alive.
 *
 * What was built: `beginSocial`, a callback that routes on `flowKind`, and `completeSocial`,
 * which matches a **verified** address to an **existing active** membership in whichever company
 * has **verified that domain** — never creating anything, because anybody can obtain a Google
 * account and that must not be a way into somebody's company.
 */
export const SOCIAL_SIGN_IN_IS_IMPLEMENTED = true;

export type SocialProviderKind = 'google' | 'microsoft' | 'apple';

export interface SocialProviderConfig {
  kind: SocialProviderKind;
  /** What the button says. */
  displayName: string;
  /** The provider's own issuer, used to fetch its discovery document. */
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/**
 * The issuer and discovery URL for each provider.
 *
 * Fixed here rather than taken from the environment: these are published, stable values, and a
 * deployment that could point "Google" at an arbitrary issuer would be a deployment where one
 * mistyped variable sends people's credentials somewhere else.
 *
 * Microsoft's issuer carries a tenant segment. `common` accepts both work and personal accounts;
 * a deployment that wants to restrict it sets MICROSOFT_TENANT_ID to its own directory id.
 */
const WELL_KNOWN: Record<
  SocialProviderKind,
  {
    displayName: string;
    issuer: (tenant: string) => string;
    discovery: (tenant: string) => string;
    scopes: string[];
  }
> = {
  google: {
    displayName: 'Continue with Google',
    issuer: () => 'https://accounts.google.com',
    discovery: () => 'https://accounts.google.com/.well-known/openid-configuration',
    scopes: ['openid', 'email', 'profile'],
  },
  microsoft: {
    displayName: 'Continue with Microsoft',
    issuer: (tenant) => `https://login.microsoftonline.com/${tenant}/v2.0`,
    discovery: (tenant) =>
      `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
    scopes: ['openid', 'email', 'profile'],
  },
  apple: {
    displayName: 'Continue with Apple',
    issuer: () => 'https://appleid.apple.com',
    discovery: () => 'https://appleid.apple.com/.well-known/openid-configuration',
    // Apple returns the name only on the very first authorization and only if asked.
    scopes: ['openid', 'email', 'name'],
  },
};

const ENV_PREFIX: Record<SocialProviderKind, string> = {
  google: 'GOOGLE',
  microsoft: 'MICROSOFT',
  apple: 'APPLE',
};

function readOne(kind: SocialProviderKind): SocialProviderConfig | null {
  const prefix = ENV_PREFIX[kind];
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim() ?? '';
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim() ?? '';

  // Half-configured is treated as absent: offering a button that cannot complete is worse than
  // not offering one, because the failure looks like a broken product rather than a missing key.
  if (clientId === '' || clientSecret === '') return null;

  const tenant = process.env['MICROSOFT_TENANT_ID']?.trim() || 'common';
  const shape = WELL_KNOWN[kind];

  return {
    kind,
    displayName: shape.displayName,
    issuer: shape.issuer(tenant),
    discoveryUrl: shape.discovery(tenant),
    clientId,
    clientSecret,
    scopes: shape.scopes,
  };
}

/** Every provider this deployment has credentials for, in a fixed order. */
export function configuredSocialProviders(): SocialProviderConfig[] {
  return (['google', 'microsoft', 'apple'] as const)
    .map(readOne)
    .filter((provider): provider is SocialProviderConfig => provider !== null);
}

/** One provider, or null when this deployment has no credentials for it. */
export function socialProvider(kind: SocialProviderKind): SocialProviderConfig | null {
  return readOne(kind);
}
