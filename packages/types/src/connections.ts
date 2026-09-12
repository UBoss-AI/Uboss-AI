/**
 * Integrations and Connections: the vocabulary.
 *
 * Shared between the API and the web app so a connection's state, its environment and — above all
 * — **what an Engine Agent is allowed to do with it** are one definition. The last of those is a
 * security boundary, and two definitions of a security boundary is one too many.
 */

/**
 * Who a connection belongs to.
 *
 * The client's two types. They differ in more than ownership: a Company Connection is company
 * infrastructure that survives its owner leaving, and a User Connection is one person's own
 * account that must **not** be transferred to anybody — offboarding disables it rather than
 * handing it over, because the credential is theirs.
 */
export const CONNECTION_SCOPES = ['Company', 'User'] as const;
export type ConnectionScope = (typeof CONNECTION_SCOPES)[number];

/**
 * The client's five states, in order of how much attention each needs.
 *
 * `NeedsReauthorization` and `Expired` are deliberately distinct: the first means the provider
 * has withdrawn consent and a person must approve again, the second means the credential simply
 * ran out. They look the same on a dashboard and have different fixes, and collapsing them would
 * send somebody to re-consent when all they needed was a new key.
 */
export const CONNECTION_STATES = [
  'Connected',
  'NeedsReauthorization',
  'Expired',
  'Disabled',
  'Error',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  Connected: 'Connected',
  NeedsReauthorization: 'Needs reauthorization',
  Expired: 'Expired',
  Disabled: 'Disabled',
  Error: 'Error',
};

/** `StatusTone` per state, so three screens cannot disagree about what red means. */
export const CONNECTION_STATE_TONES: Record<
  ConnectionState,
  'success' | 'warn' | 'danger' | 'grey'
> = {
  Connected: 'success',
  NeedsReauthorization: 'warn',
  Expired: 'danger',
  Disabled: 'grey',
  Error: 'danger',
};

/** States in which a connection may actually be used. */
export const USABLE_CONNECTION_STATES: readonly ConnectionState[] = ['Connected'];

export const CONNECTION_ENVIRONMENTS = ['Test', 'Production'] as const;
export type ConnectionEnvironment = (typeof CONNECTION_ENVIRONMENTS)[number];

// ---------------------------------------------------------------------------
// Agent Tool Permission — NOT a human permission
// ---------------------------------------------------------------------------

/**
 * What an Engine Agent may do through a connection.
 *
 * ## This is not the human authorization vocabulary, and must never become it
 *
 * `packages/types/authorization.ts` has `ACTIONS` — View, Approve, Publish, Administer and the
 * rest — which answer "what may this **person** do in this module". These answer "what may an
 * **agent** do to somebody else's system through this credential". They are different questions
 * about different subjects, and the client's rule is explicit that they are separate.
 *
 * Merging them would be the single most dangerous shortcut available in this codebase. A person
 * granted `Administer` on the Integrations module would silently gain the ability to make an
 * agent delete records in a connected ERP — because "administer" would appear in both lists and
 * one lookup would satisfy both. So: two vocabularies, two tables, and a comment in each saying
 * why.
 *
 * A human needs `settings:Administer` to *configure* a connection. An Engine Agent needs a
 * `ConnectionToolGrant` to *use* one. Holding the first grants nothing of the second.
 */
export const TOOL_ACTION_CATEGORIES = [
  /** Fetch data. The only category that is safe by default. */
  'Read',
  /** Create or update a single record. */
  'Write',
  /** Remove data in the connected system. */
  'Delete',
  /** Send to many external recipients at once — mail, messages, notifications. */
  'ExternalBulkSend',
  /** Export data classified as sensitive out of the connected system. */
  'SensitiveExport',
  /** Move money, raise an invoice, change a price or a payment instruction. */
  'FinancialChange',
  /** Change a production system's configuration or state. */
  'ProductionChange',
] as const;
export type ToolActionCategory = (typeof TOOL_ACTION_CATEGORIES)[number];

/**
 * The client's four high-risk categories, plus `Delete`, which the client names first.
 *
 * A high-risk category is **never granted by default** and always requires an explicit,
 * reasoned, audited grant naming the Engine Agent. The distinction is not decoration: it is what
 * makes "an agent can read our CRM" a different decision from "an agent can delete from our CRM".
 */
export const HIGH_RISK_TOOL_CATEGORIES: readonly ToolActionCategory[] = [
  'Delete',
  'ExternalBulkSend',
  'SensitiveExport',
  'FinancialChange',
  'ProductionChange',
];

export function isHighRiskToolCategory(category: ToolActionCategory): boolean {
  return HIGH_RISK_TOOL_CATEGORIES.includes(category);
}

export const TOOL_CATEGORY_LABELS: Record<ToolActionCategory, string> = {
  Read: 'Read data',
  Write: 'Create or update a record',
  Delete: 'Delete data',
  ExternalBulkSend: 'Send to many external recipients',
  SensitiveExport: 'Export sensitive data',
  FinancialChange: 'Financial change',
  ProductionChange: 'Production change',
};

export const TOOL_CATEGORY_DESCRIPTIONS: Record<ToolActionCategory, string> = {
  Read: 'Fetch records. Granted by default where the connector supports it.',
  Write: 'Create or update one record at a time.',
  Delete: 'Remove records in the connected system. Cannot be undone from UBoss.',
  ExternalBulkSend:
    'Send mail or messages to many external recipients in one action. The category most likely ' +
    'to be noticed by somebody outside the company.',
  SensitiveExport: 'Take data the connected system classifies as sensitive out of it.',
  FinancialChange: 'Move money, raise an invoice, or change a price or payment instruction.',
  ProductionChange: "Change a production system's configuration or its running state.",
};

// ---------------------------------------------------------------------------
// The connector catalogue
// ---------------------------------------------------------------------------

export interface ConnectorDefinition {
  kind: string;
  label: string;
  /** One sentence a chooser can show. */
  summary: string;
  /** Which scopes make sense. A personal mailbox is never a Company Connection. */
  scopes: readonly ConnectionScope[];
  /** Whether Test/Production is meaningful. A read-only public feed has one environment. */
  hasEnvironments: boolean;
  /** Every category this connector could ever offer. A grant outside it is refused. */
  supportedCategories: readonly ToolActionCategory[];
  /** Whether the credential expires and therefore needs rotation tracking. */
  credentialExpires: boolean;
  /** True for the mock connector: it talks to nothing. */
  isMock: boolean;
}

/**
 * The connectors that exist.
 *
 * **Deliberately just the two mocks.** The pack says "build a mock connector adapter plus tests;
 * do not yet integrate every vendor", and a catalogue listing Salesforce and SAP with no adapter
 * behind them would be a promise the product cannot keep — somebody would configure one, press
 * *Test Connection*, and get a failure that looks like their credential.
 *
 * A real connector adds an entry here and an adapter implementation. Nothing else changes: the
 * lifecycle, the secret handling, the tool grants, the expiry sweep and the notification are all
 * connector-agnostic.
 */
export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
  {
    kind: 'mock-erp',
    label: 'Mock ERP',
    summary:
      'A stand-in for a company system of record. Exercises every category including the ' +
      'high-risk ones, so the governance around them can be tested before a real ERP exists.',
    scopes: ['Company'],
    hasEnvironments: true,
    supportedCategories: [
      'Read',
      'Write',
      'Delete',
      'SensitiveExport',
      'FinancialChange',
      'ProductionChange',
    ],
    credentialExpires: true,
    isMock: true,
  },
  {
    kind: 'mock-mailbox',
    label: 'Mock Mailbox',
    summary:
      "A stand-in for one person's own mail account. A User Connection: the credential belongs " +
      'to them, so it is never transferred to a successor.',
    scopes: ['User'],
    hasEnvironments: false,
    supportedCategories: ['Read', 'Write', 'ExternalBulkSend'],
    credentialExpires: true,
    isMock: true,
  },
];

const BY_KIND = new Map(CONNECTOR_DEFINITIONS.map((definition) => [definition.kind, definition]));

export function connectorDefinition(kind: string): ConnectorDefinition | undefined {
  return BY_KIND.get(kind);
}

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

/**
 * The state a connection is **actually** in, derived rather than trusted.
 *
 * ## Why derived at read time
 *
 * A credential that expired an hour ago is expired now, whether or not a sweep has run. Storing
 * the state and relying on a job to update it would leave a window in which the database says
 * `Connected` and the provider says otherwise — and every Engine Agent run in that window would
 * be authorised against a stale answer. The same rule as break-glass expiry and platform-role
 * expiry (ADR-047): evaluate on read, sweep only to tidy state for reporting.
 *
 * ## The order of precedence is the whole logic
 *
 * `Disabled` first, because a disabled connection must not report `Error` and invite somebody to
 * fix it. `Expired` before `NeedsReauthorization`, because an expired credential cannot be
 * re-consented into working. `Error` last, because a transient failure on a valid credential is
 * the least of these.
 */
export function derivedConnectionState(input: {
  disabledAt: Date | string | null;
  credentialExpiresAt: Date | string | null;
  needsReauthorization: boolean;
  lastError: string | null;
  now?: Date;
}): ConnectionState {
  if (input.disabledAt !== null) {
    return 'Disabled';
  }

  const now = input.now ?? new Date();
  if (input.credentialExpiresAt !== null && new Date(input.credentialExpiresAt) <= now) {
    return 'Expired';
  }

  if (input.needsReauthorization) {
    return 'NeedsReauthorization';
  }

  if (input.lastError !== null && input.lastError.trim() !== '') {
    return 'Error';
  }

  return 'Connected';
}

/** How many days before expiry a connection is worth warning about. */
export const CREDENTIAL_EXPIRY_WARNING_DAYS = 14;

/**
 * Is this credential close enough to expiry to warrant telling its owner?
 *
 * Fourteen days because rotating a credential usually needs somebody else — a provider
 * administrator, a security review — and a warning that arrives the morning it expires is a
 * warning about an outage rather than a chance to avoid one.
 */
export function isCredentialExpiringSoon(
  credentialExpiresAt: Date | string | null,
  now: Date = new Date(),
): boolean {
  if (credentialExpiresAt === null) {
    return false;
  }
  const expiry = new Date(credentialExpiresAt).getTime();
  const horizon = now.getTime() + CREDENTIAL_EXPIRY_WARNING_DAYS * 86_400_000;
  return expiry > now.getTime() && expiry <= horizon;
}
