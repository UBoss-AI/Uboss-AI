/**
 * The integration surface, said the way a customer needs it.
 *
 * ## What is left out, on purpose
 *
 * The product has more surface than this: a platform plane that administers companies, a
 * machine-readable document at `/docs-json`, row-level security in the database, a per-route
 * permission annotation, hash-chained audit rows. All of it is true and none of it is a customer's
 * business. A buyer arriving here is asking three questions —
 *
 *   * can I connect it to what we already run,
 *   * will it keep our people in step without somebody maintaining a list,
 *   * do our own sign-on rules apply
 *
 * — and a page that answers those three, and stops, is worth more than one that recites the
 * architecture. The platform plane in particular is how UBoss administers its customers; putting
 * it on a customer's page describes somebody else's software.
 *
 * ## What is claimed, and where it comes from
 *
 *   * The API and its reference — `apps/api/src/main.ts`, which builds the OpenAPI document from
 *     the routes that are actually running.
 *   * Directory sync — `apps/api/src/auth/scim/scim.controller.ts`: SCIM 2.0, Users and Groups.
 *   * Sign-on — `apps/api/src/auth/enterprise-identity.controller.ts`: SAML 2.0 and OIDC.
 *
 * ## What is not claimed
 *
 * There are **no customer API keys**: a program authenticates as a person, with that person's
 * permissions. So there is no invitation here to "generate a key and start building", because that
 * product does not exist. There is no published rate limit, no uptime figure and no SDK either,
 * for the same reason.
 */

export const API_FACTS = [
  { value: 'Documented', label: 'A live API reference, generated from the running product' },
  { value: 'SCIM 2.0', label: 'Your directory stays the source of truth for people' },
  { value: 'SAML · OIDC', label: 'Your own sign-on, configured by you' },
] as const;

export interface ApiCapability {
  title: string;
  body: string;
  points: readonly string[];
}

export const API_CAPABILITIES: readonly ApiCapability[] = [
  {
    title: 'Connect it to what you already run',
    body: 'Everything the screens do, your systems can do. The reference is generated from the product itself, so what it lists is what answers.',
    points: [
      'A browsable API reference, kept in step because it is built from the code',
      'Objectives, tasks, approvals and reports, reachable as data',
      'Versioned with the product rather than beside it',
    ],
  },
  {
    title: 'A program cannot do more than the person behind it',
    body: 'There are no API keys to leak and no service account with a key to the building. An integration acts as somebody, with exactly the access that somebody holds.',
    points: [
      'The same roles and permissions that govern the interface',
      'Refused with a reason when the grant is missing',
      'Revoking a person revokes everything built on them',
    ],
  },
  {
    title: 'People stay in step with your directory',
    body: 'Joiners appear, movers change, leavers lose access — without anybody remembering to do it in a second place.',
    points: [
      'SCIM 2.0, so your identity platform stays in charge',
      'Users and groups, synced on your schedule',
      'Every change recorded, like any other change',
    ],
  },
  {
    title: 'Your sign-on, not another password',
    body: 'Connect the identity provider your company already uses. UBoss never becomes another place where credentials live.',
    points: [
      'SAML 2.0 and OpenID Connect',
      'Set up by your company, for your company',
      'A secret you give it is never shown back to anyone',
    ],
  },
];
