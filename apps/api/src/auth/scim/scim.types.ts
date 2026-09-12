/**
 * SCIM 2.0 wire types and helpers (RFC 7643 schemas, RFC 7644 protocol).
 *
 * ## Scope of this implementation
 *
 * A standards-compliant **subset**, chosen so an identity provider's SCIM connector works
 * against it rather than so the RFC is exhaustively covered. What is here:
 *
 *   * `/ServiceProviderConfig`, `/ResourceTypes` and `/Schemas` — discovery, which every
 *     connector fetches first and several refuse to proceed without;
 *   * `/Users` — list with `filter` on `userName` and `externalId`, get, create, replace, patch
 *     (`active` and `displayName`), and delete;
 *   * `/Groups` — list, get, create, replace (including membership), patch, delete;
 *   * the SCIM list-response and error envelopes, with SCIM's own status codes and `scimType`.
 *
 * What is deliberately **not** here, and is advertised as unsupported in
 * `/ServiceProviderConfig` rather than silently missing: `PATCH` with arbitrary filter paths,
 * bulk operations, sorting, ETags, and `/Me`. A connector reads that document and adapts; one
 * that finds an endpoint present but subtly wrong does not.
 *
 * ## Provisioning cannot create a person's platform identity
 *
 * A SCIM `POST /Users` creates or activates a **membership** for a person who already exists on
 * the platform, or creates the platform identity *and* the membership together for a brand-new
 * email — but only ever inside the one company the credential belongs to, and only when that
 * company has verified the email's domain. That last condition is what keeps SCIM from being a
 * way to mint arbitrary UBoss identities: a company can provision the people whose domain it
 * controls, and nobody else.
 */

export const SCIM_SCHEMAS = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  listResponse: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  patchOp: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  serviceProviderConfig: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  schema: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
} as const;

export interface ScimMeta {
  resourceType: 'User' | 'Group';
  created: string;
  lastModified: string;
  location: string;
}

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  displayName?: string;
  name?: { formatted?: string };
  emails?: { value: string; primary: boolean; type?: string }[];
  active: boolean;
  groups?: { value: string; display: string; $ref?: string }[];
  meta: ScimMeta;
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members?: { value: string; display?: string; $ref?: string }[];
  meta: ScimMeta;
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  /** SCIM pagination is **1-based**, unlike almost everything else. */
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ScimErrorBody {
  schemas: string[];
  status: string;
  scimType?: string;
  detail: string;
}

/**
 * SCIM's error envelope.
 *
 * `status` is a **string** in SCIM, and `scimType` carries the machine-readable reason. Getting
 * either wrong produces a connector that reports "unknown error" for every failure, which is why
 * this is a helper rather than an inline object at each call site.
 */
export function scimError(status: number, detail: string, scimType?: string): ScimErrorBody {
  return {
    schemas: [SCIM_SCHEMAS.error],
    status: String(status),
    ...(scimType === undefined ? {} : { scimType }),
    detail,
  };
}

export function scimList<T>(
  resources: T[],
  totalResults: number,
  startIndex: number,
  itemsPerPage: number,
): ScimListResponse<T> {
  return {
    schemas: [SCIM_SCHEMAS.listResponse],
    totalResults,
    startIndex,
    itemsPerPage,
    Resources: resources,
  };
}

export interface ParsedFilter {
  attribute: string;
  value: string;
}

/**
 * Parse the small slice of SCIM filter syntax that connectors actually send.
 *
 * Every mainstream connector emits exactly `userName eq "value"` or `externalId eq "value"` or
 * `displayName eq "value"` to check whether a resource exists before creating it. The full
 * grammar in RFC 7644 §3.4.2.2 includes `and`, `or`, `not`, `co`, `sw`, `pr` and grouping.
 *
 * Implementing that grammar properly means writing a parser and translating it into SQL, which
 * is both a real amount of work and a genuine injection surface. Implementing it *badly* —
 * pattern-matching a few more operators and hoping — is worse than not implementing it, because
 * a connector would get plausible-looking wrong answers.
 *
 * So this handles the `eq` case exactly and returns `undefined` for anything else, and the
 * caller answers an unsupported filter with SCIM's own `400 invalidFilter`. That is a response a
 * connector understands and can act on.
 */
export function parseEqualityFilter(filter: string | undefined): ParsedFilter | undefined {
  if (!filter) {
    return undefined;
  }

  const match = /^\s*([A-Za-z][A-Za-z0-9_.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(filter);
  if (!match) {
    return undefined;
  }

  return {
    attribute: match[1] as string,
    // Unescape the two sequences SCIM's JSON-string values can contain.
    value: (match[2] as string).replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
  };
}

/** A single operation from a SCIM `PATCH` request. */
export interface ScimPatchOperation {
  op: string;
  path?: string;
  value?: unknown;
}

/** The subset of `PATCH` this implementation understands. */
export type UnderstoodPatch =
  | { kind: 'set-active'; active: boolean }
  | { kind: 'set-display-name'; displayName: string }
  | { kind: 'add-members'; userIds: string[] }
  | { kind: 'remove-members'; userIds: string[] }
  | { kind: 'replace-members'; userIds: string[] };

/**
 * Interpret one PATCH operation.
 *
 * Returns `undefined` for anything outside the understood set, so the caller can refuse with
 * `invalidPath` instead of appearing to apply a change it ignored — a silent no-op on a
 * deprovisioning PATCH would leave a departed employee with access while the identity provider
 * reported success.
 */
export function understandPatch(operation: ScimPatchOperation): UnderstoodPatch | undefined {
  const op = operation.op?.toLowerCase();
  // Connectors write the path in every case combination, and some omit it entirely for a
  // whole-object replace.
  const path = operation.path?.toLowerCase().trim();

  if ((op === 'replace' || op === 'add') && path === 'active') {
    const active = coerceBoolean(operation.value);
    return active === undefined ? undefined : { kind: 'set-active', active };
  }

  // Azure AD sends `{ op: 'replace', value: { active: false } }` with no path at all.
  if ((op === 'replace' || op === 'add') && path === undefined) {
    const value = operation.value;
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      if ('active' in record) {
        const active = coerceBoolean(record['active']);
        return active === undefined ? undefined : { kind: 'set-active', active };
      }
      if (typeof record['displayName'] === 'string') {
        return { kind: 'set-display-name', displayName: record['displayName'] };
      }
    }
    return undefined;
  }

  if ((op === 'replace' || op === 'add') && path === 'displayname') {
    return typeof operation.value === 'string'
      ? { kind: 'set-display-name', displayName: operation.value }
      : undefined;
  }

  if (path === 'members') {
    const userIds = memberIds(operation.value);
    if (userIds === undefined) {
      return undefined;
    }
    if (op === 'add') {
      return { kind: 'add-members', userIds };
    }
    if (op === 'remove') {
      return { kind: 'remove-members', userIds };
    }
    if (op === 'replace') {
      return { kind: 'replace-members', userIds };
    }
  }

  // `remove` with a filtered path, e.g. `members[value eq "x"]`. Common enough to be worth
  // handling, and unambiguous.
  if (op === 'remove' && path?.startsWith('members[')) {
    const match = /value\s+eq\s+"([^"]+)"/i.exec(operation.path as string);
    return match ? { kind: 'remove-members', userIds: [match[1] as string] } : undefined;
  }

  return undefined;
}

/** SCIM booleans arrive as `true`, `"True"` and `"false"` depending on the connector. */
function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered === 'true') {
      return true;
    }
    if (lowered === 'false') {
      return false;
    }
  }
  return undefined;
}

function memberIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'object' && entry !== null) {
      const candidate = (entry as Record<string, unknown>)['value'];
      if (typeof candidate === 'string' && candidate !== '') {
        ids.push(candidate);
        continue;
      }
    }
    return undefined;
  }
  return ids;
}
