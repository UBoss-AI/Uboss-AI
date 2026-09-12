/**
 * Browser-side API client.
 *
 * `credentials: 'include'` on every call, because authentication is a session **cookie**, not a
 * bearer token in JavaScript-readable storage. The cookie is HttpOnly, so this code cannot read
 * it — which is the point: an XSS bug cannot exfiltrate the session.
 */

import type {
  Form2FieldDefinition,
  Form2Objective,
  Form2Section,
  Form2WorkflowStep,
  ObjectiveRewardPanel,
  AnalysisNodeKind,
  AnalysisRunStatus,
  AnalysisStage,
  DefinitionOfDone,
  ObjectiveStatus,
  ObjectiveVersionDiff,
  RewardType,
  TimeUnit,
  HumanTaskStatus,
  PrePublishSummary,
  VersionOrigin,
  WorkflowColumnDefinition,
  WorkflowDraft,
  WorkflowEdgeKind,
  AgentMemoryMode,
  AgentRunType,
  AgentVersionImpact,
  EngineAgentAction,
  EngineAgentHealth,
  EngineAgentStatus,
  ExceptionKind,
  ExceptionSeverity,
  ExceptionState,
  ResolutionAction,
  Form3View,
  MissingDataBehaviour,
  AgingBucket,
  ApprovalRequestType,
} from '@uboss/types';
const API_BASE_URL = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:4000';

export interface ApiProblem {
  /** Message safe to show the person. The API writes these deliberately. */
  message: string;
  statusCode: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Extract a displayable message from an error body.
 *
 * The API's messages are written for people ("That email address and password do not match."),
 * so they are shown as-is. Nest returns an array for validation failures, which is flattened
 * rather than rendered as `["..."]`.
 */
function messageFrom(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const { message } = body as { message: unknown };
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message) && typeof message[0] === 'string') {
      return message.join(' ');
    }
  }
  return fallback;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    // A network failure is not a credential failure, and must not be reported as one.
    throw new ApiError('Could not reach UBoss. Check your connection and try again.', 0);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After');
    throw new ApiError(
      messageFrom(body, 'Something went wrong. Please try again.'),
      response.status,
      retryAfter ? Number(retryAfter) : undefined,
    );
  }

  return body as T;
}

export interface Workspace {
  tenantId: string;
  tenantName: string;
  lifecycleState: string;
}

export interface LoginResponse {
  user: { ubossUniqueId: string; displayName: string; isPlatformActor: boolean };
  workspaces: Workspace[];
  newDevice: boolean;
}

export interface InvitationPreviewResponse {
  valid: boolean;
  displayName?: string;
  email?: string;
  tenantName?: string;
  /** When true the person already has a UBoss password and must not be asked for a new one. */
  hasExistingPassword?: boolean;
}

export interface MeResponse {
  user: { ubossUniqueId: string; isPlatformActor: boolean };
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export interface SessionRow {
  id: string;
  /** e.g. "Chrome on Windows". Null when the client sent nothing usable. */
  deviceLabel: string | null;
  /** A coarse network hint such as "203.0.113.0/16" — never the full address. */
  clientHint: string | null;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  isCurrent: boolean;
}

export interface SsoConnectionSummary {
  id: string;
  displayName: string;
  protocol: 'Oidc' | 'Saml';
}

export interface SignInMethods {
  allowPassword: boolean;
  requireSso: boolean;
  ssoConnections: SsoConnectionSummary[];
  mfaExpected: boolean;
}

/**
 * A login attempt has three shapes now: signed in, second factor needed, or "use SSO instead".
 * Modelled as a union so the screen cannot render a session it does not have.
 */
export type LoginOutcome =
  | ({ kind: 'signed-in' } & LoginResponse)
  | {
      kind: 'mfa-required';
      enrolmentRequired: boolean;
      expiresAt: string;
      graceUntil: string | null;
      recoveryCodesAccepted: boolean;
      message: string;
    }
  | {
      kind: 'sso-required';
      tenantName: string;
      ssoConnections: SsoConnectionSummary[];
      message: string;
    };

export interface MfaFactor {
  id: string;
  method: string;
  state: string;
  label: string | null;
  confirmedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface EnrolmentStart {
  factorId: string;
  /** Contains the shared secret. Returned once, and never stored by the browser. */
  secret: string;
  otpauthUri: string;
  accountName: string;
}

export interface AuthorizationVocabulary {
  userTypes: { value: string; label: string; forbiddenActions: string[] }[];
  roles: { value: string; label: string }[];
  scopes: { value: string; label: string }[];
  modules: { company: string[]; platform: string[] };
  actions: { value: string; label: string; highRisk: boolean }[];
  policyLayers: { value: string; label: string }[];
  sodRules: { value: string; label: string }[];
  precedenceNote: string;
}

export interface PermissionTraceStep {
  layer: string;
  outcome: 'allow' | 'deny' | 'narrow' | 'noop';
  detail: string;
}

export interface PermissionEvaluation {
  subject: {
    userId: string;
    userType: string;
    roles: { roleKind: string; customRoleName?: string; scopeKind: string }[];
    assignedScope: string;
  };
  question: { module: string; action: string; resource: unknown; actingAsAgent: boolean };
  decision: {
    allowed: boolean;
    reason: string | null;
    message: string;
    decidedBy: string | null;
    effectiveScope: string | null;
  };
  trace: PermissionTraceStep[];
  separationOfDuties: { rule: string; mandatory: boolean; reason: string } | null;
  listingScope: string;
}

export interface PermissionMatrix {
  userId: string;
  userType: string;
  roles: { roleKind: string; scopeKind: string }[];
  assignedScope: string;
  visibleModules: string[];
  matrix: Record<string, string[]>;
  note: string;
  appliedRules: number;
  appliedSodPolicies: number;
}

/**
 * The authorization endpoints.
 *
 * Platform-only, and used by the internal permission test page. Every path takes a tenant id
 * because authorization is always evaluated inside one company.
 */
export const authorizationApi = {
  vocabulary: (tenantId: string) =>
    call<AuthorizationVocabulary>(
      `/tenants/${encodeURIComponent(tenantId)}/authorization/vocabulary`,
    ),

  roleCatalogue: (tenantId: string) =>
    call<{
      roles: {
        kind: string;
        label: string;
        summary: string;
        maxScope: string;
        defaultScope: string;
        modules: string[];
        permissions: Record<string, string[]>;
      }[];
    }>(`/tenants/${encodeURIComponent(tenantId)}/authorization/role-catalogue`),

  evaluate: (tenantId: string, body: Record<string, unknown>) =>
    call<PermissionEvaluation>(`/tenants/${encodeURIComponent(tenantId)}/authorization/evaluate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  matrix: (tenantId: string, userId: string) =>
    call<PermissionMatrix>(
      `/tenants/${encodeURIComponent(tenantId)}/authorization/matrix/${encodeURIComponent(userId)}`,
    ),

  assignments: (tenantId: string) =>
    call<{
      assignments: {
        id: string;
        userId: string;
        roleKind: string;
        customRoleName: string | null;
        scopeKind: string;
        expiresAt: string | null;
        expired: boolean;
        justification: string | null;
      }[];
    }>(`/tenants/${encodeURIComponent(tenantId)}/authorization/assignments`),

  separationOfDuties: (tenantId: string) =>
    call<{
      platformBaseline: {
        action: string;
        module: string | null;
        rule: string;
        mandatory: boolean;
        reason: string;
      }[];
      companyPolicies: unknown[];
      candidateActions: string[];
      note: string;
    }>(`/tenants/${encodeURIComponent(tenantId)}/authorization/separation-of-duties`),

  tcsionMappings: (tenantId: string) =>
    call<{
      loaded: number;
      externalUserTypes: string[];
      note: string;
      mappings: unknown[];
    }>(`/tenants/${encodeURIComponent(tenantId)}/authorization/tcsion-mappings`),
};

// ---------------------------------------------------------------------------
// Prompt 8 — the audit and security trails
// ---------------------------------------------------------------------------

/**
 * A trail row's chain position.
 *
 * `sequence` is a **string**, not a number, and that is not laziness: a chain position is a
 * PostgreSQL `int8` that can exceed `Number.MAX_SAFE_INTEGER`, and a position that silently
 * lost precision on the way through JSON would make the row impossible to verify.
 *
 * `sequence` and `rowHash` are null on a row written before Prompt 8. Those rows are
 * deliberately not retro-chained — see the verification note.
 */
export interface TrailChainPosition {
  key: string | null;
  sequence: string | null;
  prevHash: string | null;
  rowHash: string | null;
}

export interface AuditEventRow {
  id: string;
  tenantId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  summary: string | null;
  /** Why it happened, in words, as distinct from `summary` which says what happened. */
  reason: string | null;
  resourceVersion: number | null;
  resourceRef: string | null;
  correlationId: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
  chain: TrailChainPosition;
}

export interface SecurityEventRow {
  id: string;
  tenantId: string | null;
  category: string;
  severity: string;
  outcome: string;
  action: string;
  actorUserId: string | null;
  subjectUserId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  reason: string | null;
  deviceLabel: string | null;
  clientHint: string | null;
  correlationId: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
  chain: TrailChainPosition;
}

export interface TrailPage<TRow> {
  rows: TRow[];
  /** Pass back as `before` to fetch the next page. Absent on the last page. */
  nextCursor?: string;
  total: number;
  chainVersion: string;
}

export interface ChainBreak {
  kind: string;
  rowId: string;
  sequence: string | null;
  detail: string;
}

export interface ChainVerification {
  chainKey: string;
  trail: string;
  intact: boolean;
  verifiedCount: number;
  /** Rows written before Prompt 8, which carry no chain data and are therefore not covered. */
  unchainedCount: number;
  headSequence: string | null;
  headHash: string | null;
  breaks: ChainBreak[];
}

export interface ChainVerificationResponse {
  audit: ChainVerification;
  security: ChainVerification;
  /**
   * The guarantee in words, returned by the server rather than written here.
   *
   * It is not a constant: the strength of the guarantee changes depending on whether a checkpoint
   * has been anchored outside the database, and a screen showing a green "intact" has no other
   * way to tell the reader which of the two situations they are in.
   */
  guarantee: string;
}

export interface AuditCheckpoint {
  id: string;
  chainKey: string;
  trail: string;
  sequence: string;
  rowHash: string;
  rowCount: string;
  externalAnchorRef: string | null;
  anchoredAt: string | null;
  sealedByUserId: string | null;
  sealedAt: string;
  anchored: boolean;
}

export interface AuditVocabulary {
  chainVersion: string;
  securityCategories: string[];
  securitySeverities: string[];
  securityOutcomes: string[];
  guarantee: string;
}

/** Drop undefined entries so an unset filter is absent rather than the literal "undefined". */
function queryString(filter: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export const auditApi = {
  vocabulary: (tenantId: string) =>
    call<AuditVocabulary>(`/tenants/${encodeURIComponent(tenantId)}/audit/vocabulary`),

  events: (tenantId: string, filter: Record<string, string | number | undefined> = {}) =>
    call<TrailPage<AuditEventRow>>(
      `/tenants/${encodeURIComponent(tenantId)}/audit/events${queryString(filter)}`,
    ),

  securityEvents: (tenantId: string, filter: Record<string, string | number | undefined> = {}) =>
    call<TrailPage<SecurityEventRow>>(
      `/tenants/${encodeURIComponent(tenantId)}/audit/security-events${queryString(filter)}`,
    ),

  /** A POST, because it records who took a copy of the company's history. */
  exportEvents: (tenantId: string, filter: Record<string, string | number | undefined> = {}) =>
    call<TrailPage<AuditEventRow>>(
      `/tenants/${encodeURIComponent(tenantId)}/audit/events/export${queryString(filter)}`,
      { method: 'POST' },
    ),

  exportSecurityEvents: (
    tenantId: string,
    filter: Record<string, string | number | undefined> = {},
  ) =>
    call<TrailPage<SecurityEventRow>>(
      `/tenants/${encodeURIComponent(tenantId)}/audit/security-events/export${queryString(filter)}`,
      { method: 'POST' },
    ),

  /** A POST, because verifying writes a security event either way. */
  verify: (tenantId: string) =>
    call<ChainVerificationResponse>(`/tenants/${encodeURIComponent(tenantId)}/audit/verify`, {
      method: 'POST',
    }),

  checkpoints: (tenantId: string) =>
    call<{ checkpoints: AuditCheckpoint[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/audit/checkpoints`,
    ),
};

// ---------------------------------------------------------------------------
// Prompt 9 — the UBoss Master Console
// ---------------------------------------------------------------------------

/**
 * Where a number came from.
 *
 * The Master Console renders this next to every panel. A dashboard that presents a seeded
 * billing figure identically to a measured one teaches its operator to trust both equally, and
 * the first time that matters is an incident — so the distinction is on the wire and on the
 * screen, not in a comment.
 */
export type DataProvenance = 'measured' | 'configured' | 'demo';

export type AttentionFlag = 'None' | 'Billing' | 'Budget' | 'Security' | 'Seats' | 'Renewal';

export interface CompanySummary {
  tenantId: string;
  /** The reference's `C-001`-style identifier is the slug. */
  reference: string;
  name: string;
  legalName: string | null;
  status: string;
  plan: string | null;
  planTier: string | null;
  seatsUsed: number;
  seatsLicensed: number | null;
  /** Pre-formatted `42 / 60`, or `42 / —` when no plan is assigned. */
  seatsLabel: string;
  aiUsagePercent: number | null;
  aiUsageLabel: string;
  billing: string | null;
  renewsAt: string | null;
  daysToRenewal: number | null;
  flag: AttentionFlag;
  /** Every reason the company is flagged, so a screen can explain rather than only warn. */
  attentionReasons: string[];
  security: {
    criticalEvents: number;
    activeBreakGlass: number;
    breakGlassPendingNotification: number;
  };
  openServiceAlerts: number;
  createdAt: string;
}

export interface PlatformDashboard {
  kpis: {
    activeCompanies: { value: number; total: number; provenance: DataProvenance };
    platformSeats: {
      used: number;
      licensed: number;
      utilisationPercent: number | null;
      provenance: DataProvenance;
    };
    aiSpend: {
      consumedMinor: number;
      allowanceMinor: number;
      currency: string;
      provenance: DataProvenance;
    };
    openIncidents: { value: number; critical: number; provenance: DataProvenance };
  };
  companiesNeedingAttention: CompanySummary[];
  companies: CompanySummary[];
  renewalsDue: CompanySummary[];
  serviceAlerts: {
    id: string;
    service: string;
    severity: string;
    state: string;
    summary: string;
    affectedTenantId: string | null;
    openedAt: string;
  }[];
  securityAttention: {
    criticalEventsLast30Days: number;
    activeBreakGlassGrants: number;
    pendingCustomerNotifications: number;
    platformRoleHolders: number;
    provenance: DataProvenance;
  };
  provenanceNotes: { panel: string; provenance: DataProvenance; note: string }[];
  generatedAt: string;
}

export interface PlatformMe {
  userId: string;
  roles: { kind: string; label: string; expiresAt: string | null }[];
  /** Module → permitted actions. Empty when the caller holds no platform role. */
  matrix: Record<string, string[]>;
  /**
   * Which navigation items this caller may see.
   *
   * The console renders its sidebar from this rather than from a local copy of `MASTER_NAV`, so
   * it never offers a module the API would refuse. A **rendering hint**, not the enforcement —
   * every route carries its own server-side check.
   */
  navigation: { navKey: string; module: string; visible: boolean; actions: string[] }[];
  roleCatalogue: {
    kind: string;
    label: string;
    summary: string;
    modules: string[];
    administers: string[];
  }[];
  ceiling: Record<string, string[]>;
}

export interface PlanRow {
  id: string;
  code: string;
  tier: string;
  name: string;
  description: string | null;
  seatLimit: number | null;
  entitledModules: string[];
  aiAllowanceMinor: number | null;
  priceMinor: number | null;
  currency: string;
  active: boolean;
  sortOrder: number;
  /** Companies on this plan. A plan with subscribers cannot be retired. */
  subscribers: number;
}

export interface FeatureFlagRow {
  id: string;
  key: string;
  description: string | null;
  stage: string;
  state: string;
  audience: string;
  rolloutPercent: number;
  enabledCompanies: number;
  rationale: string | null;
  updatedAt: string;
  version: number;
}

export interface PlatformSettingRow {
  key: string;
  value: unknown;
  description: string | null;
  section: string;
  /** A locked setting is a product rule. Shown, and refused on write. */
  locked: boolean;
  updatedAt: string;
  version: number;
}

export interface ServiceAlertRow {
  id: string;
  service: string;
  severity: string;
  state: string;
  summary: string;
  detail: string | null;
  affectedTenantId: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface ModuleStatusRow {
  navKey: string;
  module: string;
  title: string;
  state: string;
  /** What this module needs before it can be built. Shown on the shell screen. */
  blockedOn: string;
  /** What of it does work today, if anything. */
  available: string | null;
  note?: string;
}

export interface CompanyDetail {
  company: CompanySummary;
  entitlements: {
    planModules: string[];
    extraModules: string[];
    removedModules: string[];
    effectiveModules: string[];
  };
  subscription: {
    planCode: string | null;
    state: string | null;
    billingState: string | null;
    startedAt: string | null;
    renewsAt: string | null;
    aiAllowanceMinor: number;
    aiConsumedMinor: number;
    currency: string;
    notes: string | null;
  } | null;
  recentAudit: {
    action: string;
    resourceType: string;
    summary: string | null;
    reason: string | null;
    occurredAt: string;
  }[];
  recentSecurity: {
    action: string;
    category: string;
    severity: string;
    outcome: string;
    occurredAt: string;
  }[];
  provenance: { entitlements: DataProvenance; activity: DataProvenance };
}

export interface PlatformRoleReview {
  assignments: {
    id: string;
    userId: string;
    ubossUniqueId: string;
    role: string;
    label: string;
    justification: string | null;
    expiresAt: string | null;
    effective: boolean;
    grantedByUserId: string | null;
    /** A grant with no granting human — the migration backfill. Worth narrowing. */
    backfilled: boolean;
    createdAt: string;
  }[];
  /** Platform staff who currently reach nothing. The most useful row on an access review. */
  platformActorsWithoutRoles: { userId: string; ubossUniqueId: string; displayName: string }[];
}

export interface CreateCompanyPrerequisites {
  steps: string[];
  plans: {
    code: string;
    name: string;
    tier: string;
    seatLimit: number | null;
    entitledModules: string[];
    priceMinor: number | null;
    currency: string;
  }[];
  defaults: { planCode: unknown; timezone: unknown; currency: unknown };
  constraints: { companyCreation: unknown; note: string };
  /** `wizardImplemented: false` — the five-step wizard is the next prompt. */
  readiness: { wizardImplemented: boolean; note: string };
}

export const platformApi = {
  me: () => call<PlatformMe>('/platform/console/me'),
  dashboard: () => call<PlatformDashboard>('/platform/console/dashboard'),
  companies: () => call<{ companies: CompanySummary[] }>('/platform/console/companies'),
  company: (tenantId: string) =>
    call<CompanyDetail>(`/platform/console/companies/${encodeURIComponent(tenantId)}`),

  setSubscription: (tenantId: string, body: Record<string, unknown>) =>
    call<{ id: string }>(
      `/platform/console/companies/${encodeURIComponent(tenantId)}/subscription`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  createCompanyPrerequisites: () =>
    call<CreateCompanyPrerequisites>('/platform/console/create-company/prerequisites'),

  plans: (includeRetired = false) =>
    call<{ plans: PlanRow[] }>(
      `/platform/console/plans${includeRetired ? '?includeRetired=true' : ''}`,
    ),
  createPlan: (body: Record<string, unknown>) =>
    call<{ id: string; code: string }>('/platform/console/plans', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePlan: (planId: string, body: Record<string, unknown>) =>
    call<{ id: string }>(`/platform/console/plans/${encodeURIComponent(planId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  featureFlags: () => call<{ flags: FeatureFlagRow[] }>('/platform/console/feature-flags'),
  createFeatureFlag: (body: Record<string, unknown>) =>
    call<{ key: string }>('/platform/console/feature-flags', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateFeatureFlag: (key: string, body: Record<string, unknown>) =>
    call<{ key: string; state: string; rolloutPercent: number }>(
      `/platform/console/feature-flags/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  settings: () =>
    call<{ settings: PlatformSettingRow[]; sections: string[] }>('/platform/console/settings'),
  updateSetting: (key: string, value: unknown, reason: string) =>
    call<{ key: string; version: number }>(
      `/platform/console/settings/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify({ value, reason }) },
    ),

  platformRoles: () => call<PlatformRoleReview>('/platform/console/platform-roles'),
  grantPlatformRole: (body: Record<string, unknown>) =>
    call<{ id: string }>('/platform/console/platform-roles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revokePlatformRole: (assignmentId: string, reason?: string) =>
    call<{ id: string }>(
      `/platform/console/platform-roles/${encodeURIComponent(assignmentId)}/revoke`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  serviceAlerts: (openOnly = true) =>
    call<{ alerts: ServiceAlertRow[]; provenance: DataProvenance; note: string }>(
      `/platform/console/service-alerts?openOnly=${openOnly ? 'true' : 'false'}`,
    ),
  acknowledgeAlert: (alertId: string) =>
    call<{ id: string; state: string }>(
      `/platform/console/service-alerts/${encodeURIComponent(alertId)}/acknowledge`,
      { method: 'POST' },
    ),
  resolveAlert: (alertId: string, resolution: string) =>
    call<{ id: string; state: string }>(
      `/platform/console/service-alerts/${encodeURIComponent(alertId)}/resolve`,
      { method: 'POST', body: JSON.stringify({ resolution }) },
    ),

  moduleStatus: () => call<{ modules: ModuleStatusRow[] }>('/platform/console/module-status'),

  // Prompt 11 — the platform side of the commercial plane.
  commercialRequests: () =>
    call<{ requests: PendingCommercialRequest[] }>('/platform/commercial/requests'),
  decideCommercialRequest: (
    requestId: string,
    body: {
      decision: 'approve' | 'decline';
      note?: string;
      apply?: 'now' | 'later';
      effectiveAt?: string;
    },
  ) =>
    call<{ id: string; state: string; appliedAt: string | null }>(
      `/platform/commercial/requests/${encodeURIComponent(requestId)}/decide`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** One company's seat position, computed by the code that does the enforcing. */
  companySeats: (tenantId: string) =>
    call<SeatPosition>(`/platform/commercial/companies/${encodeURIComponent(tenantId)}/seats`),

  /** What a proposed reduction would mean, asked *before* agreeing to it. */
  assessSeatReduction: (tenantId: string, seats: number) =>
    call<SeatReductionAssessment>(
      `/platform/commercial/companies/${encodeURIComponent(tenantId)}/seat-reduction/${seats}`,
    ),
  setContractedSeats: (tenantId: string, body: { seats: number; reason: string }) =>
    call<SeatPosition>(`/platform/commercial/companies/${encodeURIComponent(tenantId)}/seats`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  lifecycle: (tenantId: string) =>
    call<LifecycleView>(`/platform/commercial/companies/${encodeURIComponent(tenantId)}/lifecycle`),
  transitionLifecycle: (
    tenantId: string,
    body: { toState: string; reason: string; effectiveAt?: string },
  ) =>
    call<LifecycleView>(
      `/platform/commercial/companies/${encodeURIComponent(tenantId)}/lifecycle`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  applyDueCommercial: () =>
    call<{ lifecycleTransitionsApplied: number; planChangesApplied: number }>(
      '/platform/commercial/apply-due',
      { method: 'POST' },
    ),
};

// ---------------------------------------------------------------------------
// Prompt 11 — plans, entitlements, seats and company lifecycle
// ---------------------------------------------------------------------------

/**
 * A company's seat position.
 *
 * `ceiling` is the number **in force**, which during a downgrade grace window is the *old,
 * higher* one; `contractedCeiling` is what the contract now says. Both are sent because a screen
 * that showed only one of them would either understate what the company can do today or hide
 * that the contract has already changed.
 */
export interface SeatPosition {
  ceiling: number | null;
  contractedCeiling: number | null;
  used: number;
  available: number | null;
  rule: 'ActiveOnly' | 'ActiveAndInvited' | 'ActiveInvitedAndSuspended';
  countedStates: string[];
  breakdown: Record<string, number>;
  nearCeiling: boolean;
  atCeiling: boolean;
  grace: { until: string; heldCeiling: number; contractedCeiling: number } | null;
  mayRequestMore: boolean;
}

/** What a proposed seat reduction would mean. Nobody is ever removed by one. */
export interface SeatReductionAssessment {
  used: number;
  newCeiling: number;
  overBy: number;
  needsGrace: boolean;
  note: string;
}

/**
 * The five commercial concepts, as five separate groups.
 *
 * There is deliberately no role or permission field here: `rbacNote` says so in words, and the
 * shape says so by construction. See `CommercialService`.
 */
export interface CommercialPosition {
  plan: {
    code: string | null;
    name: string | null;
    tier: string | null;
    state: string | null;
    billingState: string | null;
    billingCycle: string | null;
    startedAt: string | null;
    renewsAt: string | null;
    daysToRenewal: number | null;
  };
  entitlements: {
    planModules: string[];
    extraModules: string[];
    removedModules: string[];
    effectiveModules: string[];
  };
  release: { channel: string; fromPlan: string; overridden: boolean };
  allowance: {
    aiAllowanceMinor: number;
    aiConsumedMinor: number;
    currency: string;
    percentConsumed: number | null;
  };
  seats: SeatPosition;
  pendingChange: {
    planCode: string | null;
    seats: number | null;
    effectiveAt: string;
    reason: string | null;
  } | null;
  rbacNote: string;
}

export type CommercialChangeKind =
  | 'MoreSeats'
  | 'FewerSeats'
  | 'PlanUpgrade'
  | 'PlanDowngrade'
  | 'MoreAiAllowance'
  | 'ModuleEntitlement';

export interface CommercialRequestRow {
  id: string;
  kind: CommercialChangeKind;
  state: 'Requested' | 'Approved' | 'Declined' | 'Withdrawn' | 'Applied';
  requestedSeats: number | null;
  requestedPlanCode: string | null;
  requestedAllowanceMinor: number | null;
  requestedModules: string[];
  justification: string;
  requestedByUserId: string;
  requestedAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedAt: string | null;
}

/** The platform queue's row: the same request, with the customer named. */
export interface PendingCommercialRequest {
  id: string;
  tenantId: string;
  companyName: string;
  companySlug: string;
  companyCode: string | null;
  kind: CommercialChangeKind;
  requestedSeats: number | null;
  requestedPlanCode: string | null;
  requestedAllowanceMinor: number | null;
  requestedModules: string[];
  justification: string;
  requestedByUserId: string;
  requestedAt: string;
}

export interface LifecycleView {
  state: string;
  capability: { canAccess: boolean; canWrite: boolean; reason: string };
  allowedNext: string[];
  history: {
    fromState: string;
    toState: string;
    reason: string;
    effectiveAt: string;
    appliedAt: string | null;
    actorUserId: string | null;
  }[];
  scheduled: { toState: string; effectiveAt: string; reason: string } | null;
}

/**
 * The company's own side of the commercial plane: read and request, never set.
 *
 * There is no method here that changes a contracted number, and that is not an omission — a
 * company that could set its own ceiling would make the ceiling a preference rather than a
 * contract. The platform methods live on `platformApi`.
 */
export const commercialApi = {
  position: (tenantId: string) =>
    call<CommercialPosition>(`/tenants/${encodeURIComponent(tenantId)}/commercial/position`),
  seats: (tenantId: string) =>
    call<SeatPosition>(`/tenants/${encodeURIComponent(tenantId)}/commercial/seats`),
  requests: (tenantId: string) =>
    call<{ requests: CommercialRequestRow[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/commercial/requests`,
    ),
  requestChange: (tenantId: string, body: Record<string, unknown>) =>
    call<{ id: string; kind: string; state: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/commercial/requests`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  withdraw: (tenantId: string, requestId: string) =>
    call<{ id: string; state: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/commercial/requests/${encodeURIComponent(requestId)}/withdraw`,
      { method: 'POST' },
    ),
};

/** The counting rule, in the words a customer would use. */
export const SEAT_RULE_LABELS: Record<SeatPosition['rule'], string> = {
  ActiveOnly: 'Active accounts only — an outstanding invitation is free',
  ActiveAndInvited: 'Active accounts and outstanding invitations',
  ActiveInvitedAndSuspended: 'Active, invited and suspended — suspending does not free a seat',
};

/**
 * Minor units to a readable amount.
 *
 * In the client rather than the API on purpose: the API sends integers in minor units so nothing
 * is lost to rounding, and formatting is a presentation decision that depends on the reader's
 * locale. `null` renders as an em dash, because "no price" and "zero" are different things — an
 * Enterprise plan with a negotiated price is not free.
 */
export function formatMinor(minor: number | null | undefined, currency = 'USD'): string {
  if (minor === null || minor === undefined) {
    return '—';
  }
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}

// ---------------------------------------------------------------------------
// Prompt 10 — company provisioning and the first-login setup checklist
// ---------------------------------------------------------------------------

/**
 * The Create Company wizard payload.
 *
 * Submitted **once**, after the tenth step. That is not a UI preference: provisioning is one
 * database transaction, and a step-by-step API would leave a half-provisioned company behind
 * every time somebody closed the tab at step 4 — a company that cannot be recovered through the
 * product.
 *
 * Note what is absent. **No password field** — the administrator receives a secure activation
 * invitation. **No provider credential field** — step 5 takes an AI *mode* and, for BYOK, a
 * masked hint for display only. The API refuses a payload carrying either, because
 * `forbidNonWhitelisted` rejects fields that do not exist rather than silently dropping them.
 */
export interface ProvisionCompanyRequest {
  legalName: string;
  displayName: string;
  code: string;
  countryRegion: string;
  timezone: string;
  currency: string;
  logo?: { fileName: string; mimeType: string; sizeBytes: number; storageKey: string };
  admin: { name: string; workEmail: string; title?: string; contactNumber?: string };
  planCode: string;
  seats: number;
  startDate: string;
  renewalDate: string;
  billingCycle: 'Monthly' | 'Quarterly' | 'Annual';
  commercialAllowanceMinor: number;
  extraModules?: string[];
  removedModules?: string[];
  aiMode: 'UBossManaged' | 'CompanyByok' | 'CustomEnterpriseProvider';
  modelProfilePolicy?: Record<string, unknown>;
  /** A masked hint for display, never a key. Length-capped server-side so one cannot fit. */
  providerCredentialHint?: string;
  customProviderEndpoint?: string;
  universalPackEnabled?: boolean;
  industryPacks?: string[];
  customSkillCapability?: boolean;
  budget: {
    monthlyAllowanceMinor: number;
    warningPercent: number;
    approvalThresholdMinor: number;
    hardStopMinor: number;
    departmentAllocations?: Record<string, number>;
  };
  security: {
    primaryDomain?: string;
    requireMfa: boolean;
    requireSso: boolean;
    guestExpiryDays: number;
    supportAccessAllowed: boolean;
    supportAccessRequiresCustomerApproval: boolean;
  };
  /** Retry safety: the Provision button is exactly the button somebody double-clicks. */
  idempotencyKey: string;
}

export interface ProvisionCompanyResponse {
  tenantId: string;
  slug: string;
  code: string | null;
  name: string;
  lifecycleState: string;
  admin: {
    userId: string;
    /** The permanent UBoss Unique ID, which follows this person across companies. */
    ubossUniqueId: string;
    /** Stated so a client does not look for a token that deliberately is not there. */
    activation: string;
  };
  bootstrapRoleAssignmentId: string;
  outboxMessageId: string;
  setupTaskCount: number;
  /** True when this reused an earlier provisioning with the same idempotency key. */
  replayed: boolean;
}

export interface SetupChecklistTask {
  key: string;
  position: number;
  title: string;
  /** The client's "why it comes here". Shown — a checklist without reasons is chores. */
  rationale: string;
  targetRoute: string | null;
  state: 'NotStarted' | 'InProgress' | 'Done' | 'Skipped';
  skipReason: string | null;
  completedAt: string | null;
}

export interface SetupChecklist {
  tasks: SetupChecklistTask[];
  /** Done **or deliberately skipped**, over the total. See the service for why. */
  resolved: number;
  total: number;
  percentComplete: number;
  /** The client's "next recommended action". */
  nextTask: { key: string; title: string; targetRoute: string | null } | null;
  complete: boolean;
}

export interface OutboxView {
  counts: Record<string, number>;
  messages: {
    id: string;
    topic: string;
    tenantId: string | null;
    state: string;
    attempts: number;
    lastError: string | null;
    availableAt: string;
    deliveredAt: string | null;
    createdAt: string;
    payload: Record<string, unknown>;
  }[];
  /** `running: false` — no dispatcher exists yet, and the API says so rather than implying one. */
  dispatcher: { running: boolean; note: string };
}

export const provisioningApi = {
  provisionCompany: (body: ProvisionCompanyRequest) =>
    call<ProvisionCompanyResponse>('/platform/provisioning/companies', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  outbox: (state?: string) =>
    call<OutboxView>(
      `/platform/provisioning/outbox${state ? `?state=${encodeURIComponent(state)}` : ''}`,
    ),

  checklist: (tenantId: string) =>
    call<SetupChecklist>(`/tenants/${encodeURIComponent(tenantId)}/setup/checklist`),

  updateChecklistTask: (
    tenantId: string,
    key: string,
    state: SetupChecklistTask['state'],
    skipReason?: string,
  ) =>
    call<SetupChecklist>(
      `/tenants/${encodeURIComponent(tenantId)}/setup/checklist/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify({ state, skipReason }) },
    ),
};

export const authApi = {
  /**
   * Sign in with a password.
   *
   * Discriminates the three possible successful responses. The API returns 200 for all of them —
   * a company requiring SSO is not a credential error, and a 401 would make the browser show one.
   */
  login: async (email: string, password: string): Promise<LoginOutcome> => {
    const body = await call<
      | LoginResponse
      | {
          mfaRequired: true;
          enrolmentRequired: boolean;
          expiresAt: string;
          graceUntil: string | null;
          recoveryCodesAccepted: boolean;
          message: string;
        }
      | {
          ssoRequired: true;
          tenantName: string;
          ssoConnections: SsoConnectionSummary[];
          message: string;
        }
    >('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

    if ('mfaRequired' in body) {
      return { kind: 'mfa-required', ...body };
    }
    if ('ssoRequired' in body) {
      return { kind: 'sso-required', ...body };
    }
    return { kind: 'signed-in', ...body };
  },

  signInMethods: (email: string) =>
    call<SignInMethods>(`/auth/sign-in-methods?email=${encodeURIComponent(email)}`),

  verifyMfa: (code: string) =>
    call<LoginResponse & { secondFactor: string; remainingRecoveryCodes?: number }>(
      '/auth/mfa/verify',
      { method: 'POST', body: JSON.stringify({ code }) },
    ),

  startEnrolmentDuringSignIn: () =>
    call<EnrolmentStart>('/auth/mfa/challenge/enroll/start', { method: 'POST' }),

  confirmEnrolmentDuringSignIn: (factorId: string, code: string) =>
    call<LoginResponse & { secondFactor: string; recoveryCodes: string[] }>(
      '/auth/mfa/challenge/enroll/confirm',
      { method: 'POST', body: JSON.stringify({ factorId, code }) },
    ),

  startSso: (connectionId: string, redirectAfter?: string) =>
    call<{ authorizationUrl: string }>('/auth/sso/start', {
      method: 'POST',
      body: JSON.stringify(
        redirectAfter === undefined ? { connectionId } : { connectionId, redirectAfter },
      ),
    }),

  mfaFactors: () =>
    call<{
      factors: MfaFactor[];
      remainingRecoveryCodes: number;
      recoveryCodeBatchSize: number;
    }>('/auth/mfa/factors'),

  startEnrolment: (label?: string) =>
    call<EnrolmentStart>('/auth/mfa/enroll/start', {
      method: 'POST',
      body: JSON.stringify(label === undefined ? {} : { label }),
    }),

  confirmEnrolment: (factorId: string, code: string) =>
    call<{ confirmed: true; recoveryCodes: string[] | null }>('/auth/mfa/enroll/confirm', {
      method: 'POST',
      body: JSON.stringify({ factorId, code }),
    }),

  revokeFactor: (factorId: string) =>
    call<void>(`/auth/mfa/factors/${encodeURIComponent(factorId)}`, { method: 'DELETE' }),

  regenerateRecoveryCodes: () =>
    call<{ codes: string[]; generatedAt: string; message: string }>('/auth/mfa/recovery-codes', {
      method: 'POST',
    }),

  logout: () => call<void>('/auth/logout', { method: 'POST' }),

  me: () => call<MeResponse>('/auth/me'),

  sessions: () => call<{ sessions: SessionRow[] }>('/auth/sessions'),

  revokeSession: (sessionId: string) =>
    call<void>(`/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),

  logoutAll: () =>
    call<{ revoked: number; keptCurrentSession: boolean }>('/auth/logout-all', { method: 'POST' }),

  previewInvitation: (token: string) =>
    call<InvitationPreviewResponse>('/auth/invitations/preview', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  activateInvitation: (token: string, password?: string) =>
    call<{ activated: boolean; activeWorkspaceId: string }>('/auth/invitations/activate', {
      method: 'POST',
      body: JSON.stringify(password === undefined ? { token } : { token, password }),
    }),

  requestPasswordReset: (email: string) =>
    call<{ accepted: boolean; message: string }>('/auth/password-reset/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  confirmPasswordReset: (token: string, password: string) =>
    call<{ reset: boolean; sessionsRevoked: number; message: string }>(
      '/auth/password-reset/confirm',
      { method: 'POST', body: JSON.stringify({ token, password }) },
    ),
};

// ---------------------------------------------------------------------------
// Prompt 12 — hierarchy, departments and reporting relationships
// ---------------------------------------------------------------------------

export interface DepartmentRow {
  id: string;
  name: string;
  code: string | null;
  parentDepartmentId: string | null;
  headUserId: string | null;
  description: string | null;
  sortOrder: number;
  archivedAt: string | null;
}

export interface HierarchyNode {
  kind: 'company' | 'department' | 'person';
  id: string;
  name: string;
  person?: {
    userId: string;
    ubossUniqueId: string;
    employeeId: string;
    designation: string;
    departmentName: string;
    reportingManagerName: string | null;
    employmentState: string;
    accountState: string | null;
  };
  headcount?: number;
  children: HierarchyNode[];
}

export interface HierarchyListRow {
  userId: string;
  displayName: string;
  employeeId: string;
  designation: string;
  departmentName: string;
  reportingManagerName: string | null;
  ubossUniqueId: string;
  accountState: string | null;
  employmentState: string;
  /**
   * Present **only** when the caller may see it — somebody who can administer the hierarchy, or
   * the person themselves. Absent, not null, when withheld: a screen must not render a blank as
   * "no identifier on record", which is a different and false statement.
   */
  aadhaarMasked?: string | null;
}

export interface HierarchyView {
  company: { name: string; vision: string | null; mission: string | null };
  departments: {
    id: string;
    name: string;
    code: string | null;
    parentDepartmentId: string | null;
    description: string | null;
    headcount: number;
    archived: boolean;
  }[];
  /** Tree View — the client's default. Company → departments → reporting tree. */
  tree: HierarchyNode;
  /** List View — the secondary view, the reference's seven columns. */
  list: HierarchyListRow[];
  employeeCount: number;
  /** Whether this caller was given the masked identifier fragments. */
  identifiersVisible: boolean;
  /** Whether this caller may change the structure. The server is still authoritative. */
  mayAdminister: boolean;
}

export interface AddEmployeeResult {
  userId: string;
  ubossUniqueId: string;
  matchedExistingPerson: boolean;
  employeeId: string;
  aadhaarMasked: string | null;
  /** Always `EnteredOnly`. There is no verified state in the system. */
  aadhaarAssurance: 'EnteredOnly';
  seats: { used: number; ceiling: number | null; available: number | null };
  /** Always false. Adding somebody to the hierarchy does not invite them. */
  invitationSent: false;
}

export interface EmployeeProfile {
  userId: string;
  displayName: string;
  ubossUniqueId: string;
  employeeId: string;
  designation: string;
  departmentId: string;
  departmentName: string;
  reportingManagerUserId: string | null;
  reportingManagerName: string | null;
  employmentState: string;
  accountState: string | null;
  joinedOn: string | null;
  employmentType: string | null;
  workEmail: string | null;
  workPhone: string | null;
  aadhaarMasked?: string | null;
  aadhaarAssurance?: 'EnteredOnly' | null;
  identifierVisible: boolean;
  identityNote: string;
}

export interface MandatoryEmployeeFields {
  mandatory: { key: string; label: string }[];
  note: string;
}

/**
 * The Organization Hierarchy endpoints.
 *
 * There is deliberately **no invite method here**. The client's rule is that the invitation
 * source is Settings → Users & Access and a hierarchy node must not carry the primary Invite
 * button; the API has no such route to call.
 */
export const organizationApi = {
  hierarchy: (tenantId: string) =>
    call<HierarchyView>(`/tenants/${encodeURIComponent(tenantId)}/organization/hierarchy`),

  /** The six mandatory field keys, served so the form cannot drift from the API. */
  mandatoryFields: (tenantId: string) =>
    call<MandatoryEmployeeFields>(
      `/tenants/${encodeURIComponent(tenantId)}/organization/employee-fields`,
    ),

  departments: (tenantId: string, includeArchived = false) =>
    call<{ departments: DepartmentRow[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/organization/departments${
        includeArchived ? '?includeArchived=true' : ''
      }`,
    ),
  createDepartment: (tenantId: string, body: Record<string, unknown>) =>
    call<{ id: string; name: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/organization/departments`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  updateDepartment: (tenantId: string, departmentId: string, body: Record<string, unknown>) =>
    call<{ id: string; name: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/organization/departments/${encodeURIComponent(departmentId)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  /** Archive, never delete: historical employment keeps resolving to a named department. */
  archiveDepartment: (tenantId: string, departmentId: string, reason: string) =>
    call<{ id: string; archived: boolean; nothingDeleted: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/organization/departments/${encodeURIComponent(departmentId)}/archive`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  addEmployee: (tenantId: string, body: Record<string, unknown>) =>
    call<AddEmployeeResult>(`/tenants/${encodeURIComponent(tenantId)}/organization/employees`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  employee: (tenantId: string, userId: string) =>
    call<EmployeeProfile>(
      `/tenants/${encodeURIComponent(tenantId)}/organization/employees/${encodeURIComponent(userId)}`,
    ),
  updateEmployee: (tenantId: string, userId: string, body: Record<string, unknown>) =>
    call<{ userId: string; updated: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/organization/employees/${encodeURIComponent(userId)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  changeReportingManager: (
    tenantId: string,
    userId: string,
    body: { newManagerUserId?: string | null; reason?: string },
  ) =>
    call<{ userId: string; reportingManagerUserId: string | null }>(
      `/tenants/${encodeURIComponent(tenantId)}/organization/employees/${encodeURIComponent(userId)}/reporting-manager`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Vision and Mission. `settings:Administer` — company identity, not structure. */
  updateIdentity: (tenantId: string, body: { vision?: string; mission?: string }) =>
    call<{ vision: string | null; mission: string | null }>(
      `/tenants/${encodeURIComponent(tenantId)}/organization/identity`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
};

// ---------------------------------------------------------------------------
// Prompt 13 — Users & Access, guests and bulk enterprise lifecycle
// ---------------------------------------------------------------------------

export interface ActivationReadiness {
  ready: boolean;
  /** Every missing prerequisite, so a screen can list them all in one pass. */
  missing: string[];
  summary: string;
}

export interface AccessPerson {
  userId: string;
  ubossUniqueId: string;
  displayName: string;
  /** Empty when the person is in the hierarchy with no work address yet. */
  email: string;
  userType: string;
  accountState: string;
  employeeId: string | null;
  designation: string | null;
  departmentName: string | null;
  reportingManagerName: string | null;
  employmentState: string | null;
  roleCount: number;
  /** Guests only. Their access to the company ends on this date. */
  guestAccessExpiresAt: string | null;
  guestExpired: boolean;
  invitation: { id: string; sentAt: string; expiresAt: string; expired: boolean } | null;
  /** Why this person can or cannot activate yet. */
  readiness: ActivationReadiness;
}

export interface AccessView {
  /** The client's three tabs, split server-side so the screen cannot disagree about who is what. */
  employees: AccessPerson[];
  guests: AccessPerson[];
  pendingInvitations: AccessPerson[];
  seats: { used: number; ceiling: number | null; available: number | null; atCeiling: boolean };
  counts: { employees: number; guests: number; pendingInvitations: number };
}

export interface BulkPreviewRow {
  rowNumber: number;
  state: string;
  input: Record<string, unknown>;
  errors: string[];
}

export interface BulkPreview {
  operationId: string;
  kind: string;
  state: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  rows: BulkPreviewRow[];
  note: string;
}

export interface OffboardingOutcome {
  offboardingId: string;
  subjectUserId: string;
  successorUserId: string | null;
  handover: Record<string, { status: string; detail: string; moved?: number }>;
  nothingDeleted: true;
}

/**
 * Settings → Users & Access.
 *
 * Two shapes worth noting, both of which are the client's rules made structural:
 *
 *   * `inviteExisting` takes a **`subjectUserId`**, never an email. Somebody already in the
 *     hierarchy has a permanent UBoss identity, and inviting them by email would create a second
 *     one — the duplication the rule forbids.
 *   * `validateBulk` and `applyBulk` are **two calls**. Validating applies nothing; the preview
 *     is what the operator agrees to before anything changes.
 */
export const accessApi = {
  view: (tenantId: string) => call<AccessView>(`/tenants/${encodeURIComponent(tenantId)}/access`),

  inviteExisting: (tenantId: string, body: { subjectUserId: string; workEmail?: string }) =>
    call<{
      userId: string;
      ubossUniqueId: string;
      resent: boolean;
      seats: { used: number; ceiling: number | null; available: number | null };
      tokenReturned: false;
    }>(`/tenants/${encodeURIComponent(tenantId)}/access/invitations`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  inviteGuest: (
    tenantId: string,
    body: {
      email: string;
      displayName: string;
      resourceIds: string[];
      accessDays: number;
      reason: string;
    },
  ) =>
    call<{ userId: string; ubossUniqueId: string; expiresAt: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/guests`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  cancelInvitation: (tenantId: string, invitationId: string) =>
    call<{ invitationId: string; cancelled: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/invitations/${encodeURIComponent(invitationId)}/cancel`,
      { method: 'POST' },
    ),

  suspend: (tenantId: string, userId: string, reason: string) =>
    call<{ userId: string; accountState: string; nothingDeleted: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/people/${encodeURIComponent(userId)}/suspend`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  reinstate: (tenantId: string, userId: string, reason: string) =>
    call<{ userId: string; accountState: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/people/${encodeURIComponent(userId)}/reinstate`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  /** What an offboarding would move, asked before committing to it. */
  offboardingImpact: (tenantId: string, userId: string) =>
    call<{
      directReports: number;
      roleAssignments: number;
      successorRequired: boolean;
      domains: { key: string; label: string; status: string; arrivesWith?: string }[];
      note: string;
    }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/people/${encodeURIComponent(userId)}/offboarding-impact`,
    ),

  offboard: (
    tenantId: string,
    userId: string,
    body: { successorUserId?: string; reason: string },
  ) =>
    call<OffboardingOutcome>(
      `/tenants/${encodeURIComponent(tenantId)}/access/people/${encodeURIComponent(userId)}/offboard`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Validate a bulk operation. **Applies nothing.** */
  validateBulk: (
    tenantId: string,
    body: { kind: string; content: string; sourceFileName?: string; reason?: string },
  ) =>
    call<BulkPreview>(`/tenants/${encodeURIComponent(tenantId)}/access/bulk/validate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  applyBulk: (tenantId: string, operationId: string) =>
    call<{ applied: number; failed: number; skipped: number }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/bulk/${encodeURIComponent(operationId)}/apply`,
      { method: 'POST' },
    ),

  cancelBulk: (tenantId: string, operationId: string) =>
    call<{ operationId: string; cancelled: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/bulk/${encodeURIComponent(operationId)}/cancel`,
      { method: 'POST' },
    ),

  bulkOperations: (tenantId: string) =>
    call<{ operations: Record<string, unknown>[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/bulk`,
    ),

  offboardings: (tenantId: string) =>
    call<{ offboardings: Record<string, unknown>[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/offboardings`,
    ),
};

// ---------------------------------------------------------------------------
// Prompt 14 — company settings
// ---------------------------------------------------------------------------

export type SettingSource = 'company' | 'platform' | 'default';

export type SettingType =
  | { kind: 'string'; maxLength: number }
  | { kind: 'text'; maxLength: number }
  | { kind: 'boolean' }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'enum'; options: { value: string; label: string }[] };

export interface ResolvedSetting {
  key: string;
  category: string;
  label: string;
  description: string;
  type: SettingType;
  value: string | number | boolean;
  /**
   * Which layer supplied the value: this company's row, a platform default, or the code default.
   *
   * On the wire because "we chose 24 hours" and "nobody has chosen, so it is 24 hours" are
   * different facts, and a screen showing only the number invites somebody to believe the first.
   */
  source: SettingSource;
  defaultValue: string | number | boolean;
  /** Governance setting: a change needs a reason and keeps a version history. */
  material: boolean;
  /** Whether **this caller** may change it. The server's answer, not the screen's guess. */
  editable: boolean;
}

export interface SettingsCategoryView {
  key: string;
  settings: ResolvedSetting[];
  anyEditable: boolean;
  /** Where a category with no settings of its own is actually configured. */
  note?: string;
}

export interface SettingsView {
  categories: SettingsCategoryView[];
  /** How many the caller may not read. Stated, so a shorter sidebar is explicable. */
  withheldCategories: number;
}

/**
 * Company Settings.
 *
 * `update` takes **several values at once** because a settings panel has one Save button and
 * cross-setting rules exist — validating one field at a time cannot see them. A payload mixing a
 * setting the caller may change with one they may not is refused whole.
 */
export const settingsApi = {
  view: (tenantId: string) =>
    call<SettingsView>(`/tenants/${encodeURIComponent(tenantId)}/settings`),

  categories: (tenantId: string) =>
    call<{ categories: string[]; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/settings/categories`,
    ),

  update: (
    tenantId: string,
    body: { values: Record<string, string | number | boolean>; reason?: string },
  ) =>
    call<{ changed: ResolvedSetting[] }>(`/tenants/${encodeURIComponent(tenantId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /** The version history for a material setting. Needs `settings:Audit`. */
  history: (tenantId: string, key: string) =>
    call<{
      key: string;
      changes: {
        previousValue: string | null;
        newValue: string;
        reason: string;
        changedByUserId: string;
        changedAt: string;
      }[];
    }>(`/tenants/${encodeURIComponent(tenantId)}/settings/history?key=${encodeURIComponent(key)}`),

  value: (tenantId: string, key: string) =>
    call<{ key: string; value: string | number | boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/settings/value/${encodeURIComponent(key)}`,
    ),
};

// ---------------------------------------------------------------------------
// Performance and badges (Prompt 12B)
// ---------------------------------------------------------------------------

export type BadgeTier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';

export interface PerformanceEventRow {
  kind: string;
  points: number;
  sourceKind: string;
  sourceId: string;
  reason: string | null;
  occurredAt: string;
  /** True when an approved blocker cancelled this outcome. It still happened. */
  neutralised: boolean;
}

export interface BadgePeriod {
  level: BadgeTier;
  scoreAtChange: number;
  startedAt: string;
  endedAt: string | null;
  /** The final period written when employment ended. Read-only for ever after. */
  isExitSnapshot: boolean;
}

export interface PerformanceView {
  subjectUserId: string;
  /** The sum of the events below. Derived, never stored. */
  score: number;
  level: BadgeTier;
  nextLevel: { level: BadgeTier; pointsAway: number } | null;
  /** Null with nothing completed — different from zero. */
  onTimePercent: number | null;
  counts: Record<string, number>;
  policyVersion: number;
  badgeHistory: BadgePeriod[];
  recentEvents: PerformanceEventRow[];
  note: string;
}

export interface PerformancePolicyView {
  version: number;
  points: {
    onTimeAccepted: number;
    lateCompletion: number;
    missed: number;
    qualityRejected: number;
  };
  thresholds: Record<BadgeTier, number>;
  blockersNeutraliseFully: boolean;
  reason: string;
  note: string;
}

/**
 * Performance score and badges.
 *
 * There is deliberately **no client call that awards points for delivered work**. The four
 * derived outcomes are recorded by the modules that own the work; only a manual adjustment and
 * an approved blocker's neutralisation can be posted, and both need `performance:Administer`
 * and a reason.
 */
export const performanceApi = {
  /** The signed-in person's own. Always permitted to themselves. */
  mine: (tenantId: string) =>
    call<PerformanceView>(`/tenants/${encodeURIComponent(tenantId)}/performance/me`),

  /** Somebody else's. Scoped: a manager sees their team, an admin the company. */
  forUser: (tenantId: string, userId: string) =>
    call<PerformanceView>(
      `/tenants/${encodeURIComponent(tenantId)}/performance/${encodeURIComponent(userId)}`,
    ),

  /** The active policy, so a screen can show the rules next to the score. */
  policy: (tenantId: string) =>
    call<PerformancePolicyView>(`/tenants/${encodeURIComponent(tenantId)}/performance/policy`),
};

// ---------------------------------------------------------------------------
// Notifications and escalation (Prompt 15)
// ---------------------------------------------------------------------------

export interface NotificationCounts {
  unread: number;
  /** Not cleared by reading. A critical alert needs somebody to say they have seen it. */
  awaitingAcknowledgement: number;
  assignedToMeUnread: number;
}

export interface NotificationItem {
  id: string;
  kind: string;
  kindLabel: string;
  severity: 'Info' | 'Warning' | 'Critical';
  title: string;
  body: string;
  /** Workspace-relative path to the exact resource. */
  deepLink: string;
  resourceType: string;
  resourceId: string | null;
  isAssignedToRecipient: boolean;
  isMandatory: boolean;
  requiresAcknowledgement: boolean;
  read: boolean;
  acknowledged: boolean;
  escalated: boolean;
  escalatedFromId: string | null;
  occurredAt: string;
}

export interface NotificationCenter {
  counts: NotificationCounts;
  items: NotificationItem[];
  /** Pass as `before` for the next page. Null at the end. */
  nextBefore: string | null;
}

export interface NotificationPreferenceRow {
  kind: string;
  label: string;
  description: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  digest: 'Off' | 'Daily' | 'Weekly';
  /** False for a kind nobody may mute. The screen disables it; the server refuses anyway. */
  mutable: boolean;
  source: 'chosen' | 'default';
  /** Which prompt brings the module that raises this kind, or "live". */
  producedBy: string;
}

/**
 * The Notification Center, the bell and one person's preferences.
 *
 * Every call is about the **caller's own** notifications. There is no client call that reads
 * somebody else's, because there is no such endpoint — a "read anybody's notifications"
 * permission would be a surveillance feature nobody asked for.
 */
export const notificationsApi = {
  center: (
    tenantId: string,
    filter: {
      unread?: boolean;
      assignedToMe?: boolean;
      awaitingAcknowledgement?: boolean;
      kind?: string;
      take?: number;
      before?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) {
        query.set(key, String(value));
      }
    }
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return call<NotificationCenter>(
      `/tenants/${encodeURIComponent(tenantId)}/notifications${suffix}`,
    );
  },

  /** Just the three numbers, for the bell. It is on every screen and does not need the rows. */
  counts: (tenantId: string) =>
    call<NotificationCounts>(`/tenants/${encodeURIComponent(tenantId)}/notifications/counts`),

  markRead: (tenantId: string, ids: string[]) =>
    call<{ marked: number }>(`/tenants/${encodeURIComponent(tenantId)}/notifications/read`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  markAllRead: (tenantId: string) =>
    call<{ marked: number; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/notifications/read-all`,
      { method: 'POST' },
    ),

  acknowledge: (tenantId: string, id: string) =>
    call<{ id: string; acknowledgedAt: string | null }>(
      `/tenants/${encodeURIComponent(tenantId)}/notifications/${encodeURIComponent(
        id,
      )}/acknowledge`,
      { method: 'POST' },
    ),

  preferences: (tenantId: string) =>
    call<{ preferences: NotificationPreferenceRow[]; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/notifications/preferences`,
    ),

  setPreference: (
    tenantId: string,
    body: {
      kind: string;
      inAppEnabled: boolean;
      emailEnabled: boolean;
      digest: 'Off' | 'Daily' | 'Weekly';
    },
  ) =>
    call<{ kind: string; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/notifications/preferences`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
};

// ---------------------------------------------------------------------------
// Integrations and connections (Prompt 16)
// ---------------------------------------------------------------------------

export interface ConnectionToolGrantRow {
  id: string;
  agentId: string;
  category: string;
  highRisk: boolean;
  reason: string | null;
  grantedByUserId: string;
  grantedAt: string;
}

export interface ConnectionRow {
  id: string;
  scope: 'Company' | 'User';
  connectorKind: string;
  connectorLabel: string;
  label: string;
  ownerUserId: string;
  environment: 'Test' | 'Production' | null;
  state: 'Connected' | 'NeedsReauthorization' | 'Expired' | 'Disabled' | 'Error';
  /** The handle. **Never the credential** — no endpoint returns one. */
  secretRef: string | null;
  hasSecret: boolean;
  allowedDepartmentIds: string[];
  credentialExpiresAt: string | null;
  expiringSoon: boolean;
  lastSuccessfulCheckAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  disabledReason: string | null;
  /** Distinct Engine Agents holding a live grant, not the number of grants. */
  affectedAgentCount: number;
  grants: ConnectionToolGrantRow[];
}

export interface ConnectionsView {
  connections: ConnectionRow[];
  /** What the secrets store actually is. Never a claim about a provider it is not. */
  vault: { name: string; isExternalProvider: boolean; note: string };
  note: string;
}

export interface ConnectorCatalogue {
  connectors: {
    kind: string;
    label: string;
    summary: string;
    scopes: ('Company' | 'User')[];
    hasEnvironments: boolean;
    supportedCategories: string[];
    credentialExpires: boolean;
    isMock: boolean;
  }[];
  toolCategories: {
    category: string;
    label: string;
    description: string;
    highRisk: boolean;
  }[];
  note: string;
}

/**
 * Integrations & Connections.
 *
 * **There is no client call that reads a credential**, because there is no such endpoint. Every
 * response carries the `secretRef` handle and `hasSecret`; `secret` appears only in request
 * bodies, on its way to the vault.
 */
export const connectionsApi = {
  catalogue: (tenantId: string) =>
    call<ConnectorCatalogue>(`/tenants/${encodeURIComponent(tenantId)}/connections/catalogue`),

  list: (tenantId: string) =>
    call<ConnectionsView>(`/tenants/${encodeURIComponent(tenantId)}/connections`),

  create: (
    tenantId: string,
    body: {
      scopeKind: 'Company' | 'User';
      connectorKind: string;
      label: string;
      environment?: 'Test' | 'Production';
      secret: string;
      allowedDepartmentIds?: string[];
    },
  ) =>
    call<ConnectionRow>(`/tenants/${encodeURIComponent(tenantId)}/connections`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** *Test Connection*. Uses the credential once; returns no part of it. */
  check: (tenantId: string, id: string) =>
    call<{ succeeded: boolean; detail: string; state: ConnectionRow['state'] }>(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(id)}/check`,
      { method: 'POST' },
    ),

  rotateSecret: (
    tenantId: string,
    id: string,
    body: { secret: string; credentialExpiresAt?: string },
  ) =>
    call<ConnectionRow>(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(
        id,
      )}/rotate-secret`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  reauthorize: (tenantId: string, id: string, body: { secret?: string } = {}) =>
    call<ConnectionRow>(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(id)}/reauthorize`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  disable: (tenantId: string, id: string, reason: string) =>
    call<ConnectionRow>(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(id)}/disable`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  enable: (tenantId: string, id: string) =>
    call<ConnectionRow>(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(id)}/enable`,
      { method: 'POST' },
    ),

  transferOwner: (tenantId: string, id: string, body: { newOwnerUserId: string; reason: string }) =>
    call<ConnectionRow>(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(
        id,
      )}/transfer-owner`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Grant an Engine Agent one category. A high-risk category needs a reason. */
  grantToolPermission: (
    tenantId: string,
    id: string,
    body: { agentId: string; category: string; reason?: string },
  ) =>
    call<{ id: string; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(
        id,
      )}/tool-permissions`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  revokeToolPermission: (tenantId: string, grantId: string, reason: string) =>
    call<{ revoked: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/connections/tool-permissions/${encodeURIComponent(
        grantId,
      )}`,
      { method: 'DELETE', body: JSON.stringify({ reason }) },
    ),
};

// ---------------------------------------------------------------------------
// Skills (Prompt 17)
// ---------------------------------------------------------------------------

export interface SkillVersionRow {
  id: string;
  versionNumber: number;
  status: string;
  content: {
    purpose: string;
    category: string;
    whenToUse: string;
    whenNotToUse: string;
    inputs: { name: string; description: string; required: boolean }[];
    rules: { when: string; then: string }[];
    steps: { order: number; instruction: string }[];
    allowedToolCategories: string[];
    outputSchema: string;
    validation: string;
    failureHandling: string;
    requiresApproval: boolean;
    autonomy: string;
    evidenceRequirement: string;
  };
  creationMode: string;
  sourceReference: string | null;
  clonedFromVersionId: string | null;
  /** Frozen at Approved, not merely Published. */
  contentFrozen: boolean;
  reviewedByUserId: string | null;
  approvedByUserId: string | null;
  publishedByUserId: string | null;
  publishedAt: string | null;
  retirementReason: string | null;
  /** Exactly the moves the server will accept, so the screen cannot offer one it will refuse. */
  nextStatuses: string[];
}

export interface SkillRow {
  id: string;
  layer: string;
  layerLabel: string;
  key: string;
  name: string;
  industry: string | null;
  ownerUserId: string | null;
  /** False for a platform Skill: it can be used or cloned here, never edited. */
  editableHere: boolean;
  clonedFromSkillId: string | null;
  publishedVersion: SkillVersionRow | null;
  openDraft: SkillVersionRow | null;
  versions: SkillVersionRow[];
}

export interface SkillImpact {
  skillId: string;
  fromVersion: number | null;
  toVersion: number;
  domains: { key: string; label: string; status: string; count: number | null; detail: string }[];
  /** True when at least one domain cannot be counted. The screen must say so. */
  incomplete: boolean;
  note: string;
}

/**
 * Skills.
 *
 * **There is no `instantiate` and no template call**, because there is no such endpoint. The
 * locked rule is that Skills are governed capabilities, not Templates: the only way to get your
 * own version of a platform Skill is `clone`, which produces a draft under this company's own
 * approval.
 */
export const skillsApi = {
  meta: (tenantId: string) =>
    call<{
      layers: { layer: string; label: string; description: string }[];
      categories: string[];
      autonomyLevels: string[];
      creationModes: string[];
      statuses: string[];
      toolCategories: string[];
      impactDomains: { key: string; label: string; status: string }[];
      note: string;
    }>(`/tenants/${encodeURIComponent(tenantId)}/skills/catalogue-meta`),

  catalogue: (
    tenantId: string,
    filter: { layer?: string; category?: string; publishedOnly?: boolean } = {},
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) {
        query.set(key, String(value));
      }
    }
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return call<{ skills: SkillRow[]; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/skills${suffix}`,
    );
  },

  clone: (
    tenantId: string,
    body: { sourceSkillId: string; sourceVersionId?: string; key: string; name: string },
  ) =>
    call<SkillRow>(`/tenants/${encodeURIComponent(tenantId)}/skills/clone`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  transition: (tenantId: string, versionId: string, body: { to: string; reason?: string }) =>
    call<SkillVersionRow>(
      `/tenants/${encodeURIComponent(tenantId)}/skills/versions/${encodeURIComponent(
        versionId,
      )}/transition`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  impact: (tenantId: string, versionId: string) =>
    call<SkillImpact>(
      `/tenants/${encodeURIComponent(tenantId)}/skills/versions/${encodeURIComponent(
        versionId,
      )}/impact`,
    ),

  history: (tenantId: string, versionId: string) =>
    call<{
      transitions: {
        from: string;
        to: string;
        reason: string | null;
        actorUserId: string | null;
        occurredAt: string;
      }[];
    }>(
      `/tenants/${encodeURIComponent(tenantId)}/skills/versions/${encodeURIComponent(
        versionId,
      )}/history`,
    ),
};

// ---------------------------------------------------------------------------
// Objective Builder / Form 2 (Prompt 19)
// ---------------------------------------------------------------------------

export interface ObjectiveStepView extends Form2WorkflowStep {
  id: string;
}

export interface ObjectiveVersionView {
  id: string;
  versionNumber: number;
  status: ObjectiveStatus;
  statusLabel: string;
  content: Form2Objective;
  steps: ObjectiveStepView[];
  contentFrozen: boolean;
  submittedAt: string | null;
  submittedByUserId: string | null;
  publishedAt: string | null;
  nextStatuses: ObjectiveStatus[];
}

export interface ObjectiveRewardView extends ObjectiveRewardPanel {
  id: string;
  note: string;
}

export interface ObjectiveView {
  id: string;
  code: string;
  departmentId: string;
  objectiveOwnerUserId: string;
  activeVersion: ObjectiveVersionView | null;
  openDraft: ObjectiveVersionView | null;
  versions: ObjectiveVersionView[];
  reward: ObjectiveRewardView | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectiveListRow {
  id: string;
  code: string;
  objectiveName: string;
  departmentId: string;
  status: ObjectiveStatus;
  statusLabel: string;
  versionNumber: number;
  live: boolean;
  responsibleOwnerUserId: string | null;
  targetCompletionTime: number | null;
  timeUnit: TimeUnit | null;
  updatedAt: string;
}

/**
 * The form's own definition, served by the API.
 *
 * Fetched rather than imported so the screen and the server cannot disagree about what Form 2
 * is. The shared package is still the source — the API derives this response from it — but a
 * screen that renders whatever the server says about the form is a screen that cannot quietly
 * fall a field behind.
 */
export interface Form2DefinitionView {
  sections: { section: Form2Section; label: string }[];
  fields: Form2FieldDefinition[];
  workflow: {
    groups: string[];
    columns: WorkflowColumnDefinition[];
    columnCount: number;
    rowCountFixed: boolean;
  };
  vocabularies: {
    timeUnits: { value: TimeUnit; label: string }[];
    engineKinds: { value: string; label: string }[];
    approvalKinds: { value: string; label: string }[];
    rewardTypes: { value: RewardType; label: string }[];
    statuses: { value: ObjectiveStatus; label: string; tone: string }[];
  };
  note: string;
}

export const objectivesApi = {
  form2: (tenantId: string) =>
    call<Form2DefinitionView>(`/tenants/${encodeURIComponent(tenantId)}/objectives/form2`),

  list: (
    tenantId: string,
    filter: { status?: string; departmentId?: string; search?: string } = {},
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    return call<{ objectives: ObjectiveListRow[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives${suffix}`,
    );
  },

  view: (tenantId: string, objectiveId: string) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(objectiveId)}`,
    ),

  create: (
    tenantId: string,
    body: { code?: string; content: Form2Objective; steps: Form2WorkflowStep[] },
  ) =>
    call<ObjectiveView>(`/tenants/${encodeURIComponent(tenantId)}/objectives`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  saveDraft: (
    tenantId: string,
    objectiveId: string,
    body: { versionId?: string; content: Form2Objective; steps: Form2WorkflowStep[] },
  ) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/draft`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  submit: (tenantId: string, objectiveId: string, versionId?: string) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/submit`,
      { method: 'POST', body: JSON.stringify(versionId === undefined ? {} : { versionId }) },
    ),

  reward: (tenantId: string, objectiveId: string) =>
    call<{ reward: ObjectiveRewardView | null }>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/reward`,
    ),

  /** The client's Version History. Exact version ids come back on the wire. */
  versionHistory: (tenantId: string, objectiveId: string) =>
    call<ObjectiveHistoryView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/versions`,
    ),

  /** The client's Compare view. */
  compareVersions: (tenantId: string, objectiveId: string, from: string, to: string) =>
    call<ObjectiveCompareView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/versions/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  /** Opens the next draft copied from the live version, before any typing. */
  newDraft: (tenantId: string, objectiveId: string, fromVersionId?: string) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/versions/new-draft`,
      {
        method: 'POST',
        body: JSON.stringify(fromVersionId === undefined ? {} : { fromVersionId }),
      },
    ),

  /** A rollback creates a **new** draft from an older version. A reason is required. */
  rollback: (tenantId: string, objectiveId: string, versionId: string, reason: string) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/versions/rollback`,
      { method: 'POST', body: JSON.stringify({ versionId, reason }) },
    ),

  /** Approve. Does **not** publish — the two are separate acts. */
  approve: (tenantId: string, objectiveId: string, versionId?: string, reason?: string) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(versionId === undefined ? {} : { versionId }),
          ...(reason === undefined ? {} : { reason }),
        }),
      },
    ),

  /** Publish an approved version. Archives the one it supersedes. */
  publish: (tenantId: string, objectiveId: string, versionId?: string) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/publish`,
      { method: 'POST', body: JSON.stringify(versionId === undefined ? {} : { versionId }) },
    ),

  /** The analysis stages, the node shapes, and whether a real model is reachable. */
  analysisMeta: (tenantId: string) =>
    call<AnalysisMetaView>(`/tenants/${encodeURIComponent(tenantId)}/objectives/analysis/meta`),

  /** Start an analysis. The output is always a draft. */
  startAnalysis: (tenantId: string, objectiveId: string, versionId?: string) =>
    call<AnalysisRunView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/analysis`,
      { method: 'POST', body: JSON.stringify(versionId === undefined ? {} : { versionId }) },
    ),

  /** The latest run, so a reopened screen shows where it got to. */
  latestAnalysis: (tenantId: string, objectiveId: string) =>
    call<{ run: AnalysisRunView | null }>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/analysis`,
    ),

  analysisRun: (tenantId: string, objectiveId: string, runId: string) =>
    call<AnalysisRunView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/analysis/${encodeURIComponent(runId)}`,
    ),

  /** Cancel a run. Takes effect at the next stage boundary. */
  cancelAnalysis: (tenantId: string, objectiveId: string, runId: string) =>
    call<AnalysisRunView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/analysis/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /** Needs `objective:Assign` — promising a bonus is part of assigning work, not drafting it. */
  saveReward: (tenantId: string, objectiveId: string, panel: ObjectiveRewardPanel) =>
    call<ObjectiveRewardView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/reward`,
      { method: 'PUT', body: JSON.stringify(panel) },
    ),
};

// ---- Objective review routing and strict versioning (Prompt 20) ----

export interface ObjectiveHistoryEntry {
  /** The exact version id. The client requires historical records to keep it. */
  versionId: string;
  versionNumber: number;
  status: ObjectiveStatus;
  statusLabel: string;
  /** Derived: "Awaiting approval" and "Approved — awaiting publish" are different things. */
  reviewStage: string;
  origin: VersionOrigin;
  originLabel: string;
  copiedFromVersionId: string | null;
  copiedFromVersionNumber: number | null;
  live: boolean;
  submittedAt: string | null;
  submittedByUserId: string | null;
  sentBackAt: string | null;
  sentBackByUserId: string | null;
  sentBackReason: string | null;
  executionTeamConfirmedAt: string | null;
  executionTeamConfirmedByUserId: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  publishedAt: string | null;
  stepCount: number;
  createdAt: string;
  createdByUserId: string | null;
}

export interface ObjectiveHistoryView {
  code: string;
  entries: ObjectiveHistoryEntry[];
  note: string;
}

export interface ObjectiveCompareView {
  from: { versionId: string; versionNumber: number; statusLabel: string };
  to: { versionId: string; versionNumber: number; statusLabel: string };
  diff: ObjectiveVersionDiff;
}

// ---- Objective AI analysis (Prompt 21) ----

export interface AnalysisStageView {
  stage: AnalysisStage;
  label: string;
  state: 'done' | 'running' | 'todo';
}

export interface AnalysisRunView {
  id: string;
  objectiveId: string;
  objectiveVersionId: string;
  status: AnalysisRunStatus;
  statusLabel: string;
  stage: AnalysisStage | null;
  stagesCompleted: number;
  /** The seven stages with their state, so the panel renders real progress. */
  stages: AnalysisStageView[];
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  failureReason: string | null;
  /** Null until the run completes, or when this build cannot read its schema version. */
  draft: WorkflowDraft | null;
  schemaVersion: number;
  unreadableReason: string | null;
  /** An opaque capability label. **Never a provider or model name.** */
  modelCapability: string | null;
  /** **Whether a real model produced this.** False for every adapter that ships today. */
  producedByRealModel: boolean;
  promptTokens: number;
  completionTokens: number;
  note: string;
}

export interface AnalysisMetaView {
  stages: { stage: AnalysisStage; label: string }[];
  /** The locked UI rule, served so a renderer cannot disagree with it. */
  nodeShapes: Record<string, string>;
  schemaVersion: number;
  model: { capability: string; usesRealModel: boolean };
  note: string;
}

// ---- The manager-editable workflow (Prompt 22) ----

export interface WorkflowDraftView {
  id: string;
  objectiveId: string;
  objectiveVersionId: string;
  /** The analysis run this was seeded from. That run stays frozen as the AI's proposal. */
  seededFromRunId: string | null;
  graph: WorkflowDraft;
  schemaVersion: number;
  /** Send this back with every edit. A stale revision is refused rather than overwriting. */
  revision: number;
  assignedAt: string | null;
  assignedByUserId: string | null;
  editable: boolean;
  note: string;
}

export interface WorkflowMetaView {
  nodeKinds: { kind: AnalysisNodeKind; shape: string }[];
  edgeKinds: { kind: WorkflowEdgeKind; label: string }[];
  dodFields: string[];
  approvalKinds: string[];
  schemaVersion: number;
  note: string;
}

export const objectiveReviewApi = {
  confirmExecutionTeam: (
    tenantId: string,
    objectiveId: string,
    body: { versionId?: string; executionTeam?: string } = {},
  ) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/review/confirm-team`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** A reason is required — the author cannot act on a send-back without one. */
  sendBack: (tenantId: string, objectiveId: string, reason: string, versionId?: string) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/review/send-back`,
      {
        method: 'POST',
        body: JSON.stringify(versionId === undefined ? { reason } : { reason, versionId }),
      },
    ),

  completeReview: (tenantId: string, objectiveId: string, versionId?: string) =>
    call<ObjectiveView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/review/complete`,
      { method: 'POST', body: JSON.stringify(versionId === undefined ? {} : { versionId }) },
    ),
};

/**
 * The workflow editor.
 *
 * Every mutating call carries the `revision` it was made against, so a concurrent edit is
 * reported rather than silently losing somebody's work.
 */
export const workflowEditorApi = {
  meta: (tenantId: string) =>
    call<WorkflowMetaView>(`/tenants/${encodeURIComponent(tenantId)}/objectives/workflow/meta`),

  /** Opens the editable draft, seeding it from the analysis on first open. */
  open: (tenantId: string, objectiveId: string, versionId?: string) =>
    call<WorkflowDraftView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/workflow`,
      { method: 'POST', body: JSON.stringify(versionId === undefined ? {} : { versionId }) },
    ),

  view: (tenantId: string, objectiveId: string) =>
    call<WorkflowDraftView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/workflow`,
    ),

  editNode: (
    tenantId: string,
    objectiveId: string,
    nodeId: string,
    body: {
      revision: number;
      label?: string;
      ownerUserId?: string | null;
      ownerDesignation?: string | null;
      triggerEvent?: string | null;
      dod?: Partial<DefinitionOfDone>;
    },
  ) =>
    call<WorkflowDraftView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/workflow/nodes/${encodeURIComponent(nodeId)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  /** Human ↔ AI, where allowed. Human → AI needs an approved published Skill. */
  convertNode: (
    tenantId: string,
    objectiveId: string,
    nodeId: string,
    to: AnalysisNodeKind,
    revision: number,
  ) =>
    call<WorkflowDraftView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/workflow/nodes/${encodeURIComponent(nodeId)}/convert`,
      { method: 'POST', body: JSON.stringify({ to, revision }) },
    ),

  addNode: (
    tenantId: string,
    objectiveId: string,
    body: { revision: number; kind: AnalysisNodeKind; label: string; afterNodeId?: string },
  ) =>
    call<WorkflowDraftView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/workflow/nodes`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  deleteNode: (tenantId: string, objectiveId: string, nodeId: string, revision: number) =>
    call<WorkflowDraftView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/workflow/nodes/${encodeURIComponent(nodeId)}?revision=${revision}`,
      { method: 'DELETE' },
    ),

  /** Reorder / reconnect: the edge list is replaced whole. */
  setEdges: (
    tenantId: string,
    objectiveId: string,
    revision: number,
    edges: {
      fromNodeId: string;
      toNodeId: string;
      kind: WorkflowEdgeKind;
      condition?: string | null;
    }[],
  ) =>
    call<WorkflowDraftView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/workflow/edges`,
      { method: 'PUT', body: JSON.stringify({ revision, edges }) },
    ),

  setDependencies: (
    tenantId: string,
    objectiveId: string,
    nodeId: string,
    revision: number,
    dependsOn: string[],
  ) =>
    call<WorkflowDraftView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/workflow/nodes/${encodeURIComponent(nodeId)}/dependencies`,
      { method: 'PUT', body: JSON.stringify({ revision, dependsOn }) },
    ),

  /** The Pre-Publish Summary. A readiness report, not permission. */
  prePublish: (tenantId: string, objectiveId: string) =>
    call<PrePublishSummary>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/workflow/pre-publish`,
    ),
};

// ---- The Human To-do list and Approve & Assign (Prompt 23) ----

export interface HumanTaskView {
  id: string;
  title: string;
  objectiveId: string;
  objectiveCode: string;
  objectiveName: string;
  objectiveVersionId: string;
  nodeId: string;
  assignedToUserId: string;
  assignedByUserId: string;
  inputDescription: string;
  dueAt: string | null;
  triggerDescription: string;
  expectedOutput: string;
  evidenceRequirement: string;
  dependsOnNodeIds: string[];
  approvalKind: string | null;
  status: HumanTaskStatus;
  /** `Overdue` when late, otherwise the stored status. Derived by the server, not stored. */
  displayStatus: string;
  displayTone: string;
  overdue: boolean;
  startedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  blockedReason: string | null;
  evidence: {
    id: string;
    description: string;
    reference: string;
    addedByUserId: string;
    addedAt: string;
  }[];
  notes: { id: string; kind: string; body: string; authorUserId: string; createdAt: string }[];
  /** What this task can become now, so a screen never offers a move that will be refused. */
  nextStatuses: HumanTaskStatus[];
}

export interface TaskListView {
  tasks: HumanTaskView[];
  counts: { total: number; overdue: number; blocked: number; mine: number };
  note: string;
}

export interface AssignmentResultView {
  objectiveId: string;
  objectiveVersionId: string;
  versionNumber: number;
  workflowDraftId: string;
  humanTaskIds: string[];
  aiAssignmentIds: string[];
  approvalRequestIds: string[];
  executorExpectationIds: string[];
  nodesAwaitingAgentSetup: string[];
  notificationsRaised: number;
  note: string;
}

/**
 * The To-do list.
 *
 * Its own path (`/todo`), not a branch of objectives: an employee has `todo` access at `OwnWork`
 * scope and no right to browse objectives at all.
 */
export const todoApi = {
  meta: (tenantId: string) =>
    call<{
      statuses: { status: HumanTaskStatus; label: string; tone: string }[];
      noteKinds: string[];
      note: string;
    }>(`/tenants/${encodeURIComponent(tenantId)}/todo/meta`),

  list: (
    tenantId: string,
    query: { filter?: 'mine' | 'team' | 'blocked'; status?: HumanTaskStatus; search?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.filter !== undefined) params.set('filter', query.filter);
    if (query.status !== undefined) params.set('status', query.status);
    if (query.search !== undefined && query.search.trim() !== '') {
      params.set('search', query.search.trim());
    }
    const suffix = params.toString() === '' ? '' : `?${params.toString()}`;
    return call<TaskListView>(`/tenants/${encodeURIComponent(tenantId)}/todo${suffix}`);
  },

  view: (tenantId: string, taskId: string) =>
    call<HumanTaskView>(
      `/tenants/${encodeURIComponent(tenantId)}/todo/${encodeURIComponent(taskId)}`,
    ),

  start: (tenantId: string, taskId: string) =>
    call<HumanTaskView>(
      `/tenants/${encodeURIComponent(tenantId)}/todo/${encodeURIComponent(taskId)}/start`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  block: (tenantId: string, taskId: string, reason: string) =>
    call<HumanTaskView>(
      `/tenants/${encodeURIComponent(tenantId)}/todo/${encodeURIComponent(taskId)}/block`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  addEvidence: (tenantId: string, taskId: string, description: string, reference?: string) =>
    call<HumanTaskView>(
      `/tenants/${encodeURIComponent(tenantId)}/todo/${encodeURIComponent(taskId)}/evidence`,
      {
        method: 'POST',
        body: JSON.stringify(
          reference === undefined ? { description } : { description, reference },
        ),
      },
    ),

  addNote: (tenantId: string, taskId: string, kind: 'Comment' | 'Clarification', body: string) =>
    call<HumanTaskView>(
      `/tenants/${encodeURIComponent(tenantId)}/todo/${encodeURIComponent(taskId)}/notes`,
      { method: 'POST', body: JSON.stringify({ kind, body }) },
    ),

  /** Submit & complete: one action, two outcomes, depending on whether an approval is required. */
  submit: (tenantId: string, taskId: string) =>
    call<HumanTaskView>(
      `/tenants/${encodeURIComponent(tenantId)}/todo/${encodeURIComponent(taskId)}/submit`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
};

/** Approve & Assign. It publishes and assigns, or it refuses and says why — never half. */
export const assignmentApi = {
  approveAndAssign: (
    tenantId: string,
    objectiveId: string,
    body: { versionId?: string; acceptWarnings?: boolean } = {},
  ) =>
    call<AssignmentResultView>(
      `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(
        objectiveId,
      )}/assign`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};

// ---- Agent Builder (Prompt 24) ----

export interface AgentSetupPrefillView {
  suggestedAgentName: string;
  objectiveCode: string;
  objectiveName: string;
  assignedWork: string;
  ownerUserId: string | null;
  skillVersionIds: string[];
  toolCategories: string[];
  approvalRequired: boolean;
  completionEvidence: string;
}

export interface AgentExecutionSetupView {
  runType: AgentRunType | null;
  triggerOrFrequency: string | null;
  inputConnectionId: string | null;
  whereWorkHappens: string | null;
  outputDestination: string | null;
  missingDataBehaviour: MissingDataBehaviour | null;
}

export interface AgentBuilderView {
  assignmentId: string;
  status: string;
  prefill: AgentSetupPrefillView;
  setup: AgentExecutionSetupView;
  /** Empty means the builder asks nothing — Ready to Test / Activate. */
  missing: { field: keyof AgentExecutionSetupView; label: string; why: string }[];
  needsConnection: boolean;
  readiness: {
    connection: { connectionId: string | null; state: string; reason: string } | null;
    findings: { severity: 'Blocker' | 'Warning'; summary: string }[];
    readyToTest: boolean;
    readyToActivate: boolean;
  };
  lastTest: {
    at: string | null;
    passed: boolean | null;
    summary: string | null;
    /** False for a mock run. Never rendered as a real provider result. */
    wasReal: boolean | null;
  };
  engineAgent: { id: string; name: string; status: string; versionNumber: number } | null;
  vocabulary: { runTypes: string[]; missingDataBehaviours: string[] };
  note: string;
}

export interface AgentBuilderMetaView {
  runTypes: { runType: AgentRunType; label: string }[];
  missingDataBehaviours: { behaviour: MissingDataBehaviour; label: string }[];
  engineAgentStatuses: string[];
  form3: {
    jobLevelFields: { key: string; label: string; required: boolean }[];
    actionColumns: string[];
    note: string;
  };
  note: string;
}

/**
 * Agent Builder.
 *
 * Note what is absent: there is no endpoint that returns a credential. The builder chooses a
 * *connection* by id and the server answers whether it may be used, so "do not expose raw API
 * keys" holds structurally rather than by the screen remembering not to ask.
 */
export const agentBuilderApi = {
  meta: (tenantId: string) =>
    call<AgentBuilderMetaView>(`/tenants/${encodeURIComponent(tenantId)}/agent-builder/meta`),

  list: (tenantId: string) =>
    call<{ assignments: AgentBuilderView[]; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/agent-builder`,
    ),

  view: (tenantId: string, assignmentId: string) =>
    call<AgentBuilderView>(
      `/tenants/${encodeURIComponent(tenantId)}/agent-builder/${encodeURIComponent(assignmentId)}`,
    ),

  /** One answer at a time; a patch never blanks a field it does not carry. */
  saveSetup: (tenantId: string, assignmentId: string, patch: Partial<AgentExecutionSetupView>) =>
    call<AgentBuilderView>(
      `/tenants/${encodeURIComponent(tenantId)}/agent-builder/${encodeURIComponent(
        assignmentId,
      )}/setup`,
      { method: 'PUT', body: JSON.stringify({ patch }) },
    ),

  test: (tenantId: string, assignmentId: string) =>
    call<AgentBuilderView>(
      `/tenants/${encodeURIComponent(tenantId)}/agent-builder/${encodeURIComponent(
        assignmentId,
      )}/test`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  activate: (tenantId: string, assignmentId: string, agentName?: string) =>
    call<AgentBuilderView>(
      `/tenants/${encodeURIComponent(tenantId)}/agent-builder/${encodeURIComponent(
        assignmentId,
      )}/activate`,
      {
        method: 'POST',
        body: JSON.stringify(agentName === undefined ? {} : { agentName }),
      },
    ),

  /** The canonical Form 3 read. Authorized users only; never a form to fill in. */
  form3: (tenantId: string, assignmentId: string) =>
    call<Form3View>(
      `/tenants/${encodeURIComponent(tenantId)}/agent-builder/${encodeURIComponent(
        assignmentId,
      )}/form3`,
    ),
};

// ---- The Engine Agent registry (Prompt 25) ----

export interface EngineAgentVersionView {
  id: string;
  versionNumber: number;
  status: string;
  isCurrent: boolean;
  memoryMode: AgentMemoryMode;
  skillVersionIds: string[];
  toolCategories: string[];
  setup: AgentExecutionSetupView | null;
  impact: AgentVersionImpact | null;
  approvalRequired: boolean;
  test: { at: string | null; passed: boolean | null; wasReal: boolean | null };
  publishedAt: string | null;
  createdAt: string;
}

export interface EngineAgentView {
  id: string;
  name: string;
  ownerUserId: string;
  status: EngineAgentStatus;
  memoryMode: AgentMemoryMode;
  pausedReason: string | null;
  objectiveIds: string[];
  currentVersion: EngineAgentVersionView | null;
  openDraft: EngineAgentVersionView | null;
  versions: EngineAgentVersionView[];
  scheduleOrTrigger: string | null;
  skillVersionIds: string[];
  toolCategories: string[];
  connectionId: string | null;
  health: EngineAgentHealth;
  /** Null throughout until the cost ledger exists — a zero would be a claim, not an absence. */
  usage: {
    hasData: boolean;
    promptTokens: number | null;
    completionTokens: number | null;
    note: string;
  };
  actions: EngineAgentAction[];
  activatedAt: string | null;
  archivedAt: string | null;
  note: string;
}

/**
 * The registry.
 *
 * No `runNow` and no `runs`: the run engine is the next prompt, and a client method that posted to
 * a route which queued nothing would make a silent no-op indistinguishable from a real start.
 */
export const engineAgentsApi = {
  meta: (tenantId: string) =>
    call<{
      statuses: { status: EngineAgentStatus; label: string; tone: string }[];
      actions: { action: EngineAgentAction; label: string }[];
      memoryModes: { mode: AgentMemoryMode; label: string; rule: string }[];
      note: string;
    }>(`/tenants/${encodeURIComponent(tenantId)}/agents/meta`),

  list: (tenantId: string, includeArchived = false) =>
    call<{ agents: EngineAgentView[]; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/agents${
        includeArchived ? '?includeArchived=true' : ''
      }`,
    ),

  view: (tenantId: string, agentId: string) =>
    call<EngineAgentView>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}`,
    ),

  pause: (tenantId: string, agentId: string, reason: string) =>
    call<EngineAgentView>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/pause`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  resume: (tenantId: string, agentId: string) =>
    call<EngineAgentView>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/resume`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  archive: (tenantId: string, agentId: string, reason: string) =>
    call<EngineAgentView>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/archive`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),

  createVersion: (
    tenantId: string,
    agentId: string,
    body: {
      setup?: Partial<AgentExecutionSetupView>;
      memoryMode?: AgentMemoryMode;
      skillVersionIds?: string[];
      toolCategories?: string[];
    },
  ) =>
    call<EngineAgentVersionView>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/versions`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  testVersion: (tenantId: string, agentId: string, versionId: string) =>
    call<EngineAgentVersionView>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(
        agentId,
      )}/versions/${encodeURIComponent(versionId)}/test`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /** `approvedByUserId` must be somebody other than the caller where an approval is required. */
  activateVersion: (
    tenantId: string,
    agentId: string,
    versionId: string,
    approvedByUserId?: string,
  ) =>
    call<EngineAgentView>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(
        agentId,
      )}/versions/${encodeURIComponent(versionId)}/activate`,
      {
        method: 'POST',
        body: JSON.stringify(approvedByUserId === undefined ? {} : { approvedByUserId }),
      },
    ),
};

// ---- The Executor Agent and Exception Center (Prompt 27) ----

export interface ExceptionView {
  id: string;
  kind: ExceptionKind;
  kindLabel: string;
  severity: ExceptionSeverity;
  state: ExceptionState;
  sourceType: string;
  sourceId: string;
  objectiveId: string | null;
  engineAgentId: string | null;
  detail: string;
  evidence: unknown;
  ownerUserId: string | null;
  /** The source document's default owner for this kind, shown when routing named nobody. */
  defaultOwner: string;
  attempts: number;
  escalationHours: number;
  openedAt: string;
  escalatedAt: string | null;
  escalatedToUserId: string | null;
  closedAt: string | null;
  closeReason: string | null;
  escalation: { due: boolean; hoursOpen: number; reason: string };
  availableActions: ResolutionAction[];
  history: {
    action: string | null;
    state: string;
    actorUserId: string | null;
    /** True when the Executor Agent did it. Never conflated with "nobody". */
    byExecutor: boolean;
    note: string;
    at: string;
  }[];
  note: string;
}

export interface ExecutorMetaView {
  kinds: {
    kind: ExceptionKind;
    label: string;
    defaultOwner: string;
    defaultSeverity: ExceptionSeverity;
  }[];
  severities: { severity: ExceptionSeverity; tone: string }[];
  states: { state: ExceptionState; label: string; tone: string }[];
  /** `executorMayTakeItAlone` publishes the boundary rather than leaving it implicit. */
  actions: { action: ResolutionAction; label: string; executorMayTakeItAlone: boolean }[];
  validationOrder: { position: number; stage: string; label: string }[];
  note: string;
}

/**
 * The Exception Center.
 *
 * There is deliberately no way to act *as* the Executor from a client: `act` always attributes the
 * action to the authenticated person, because a route that could act as the Executor would be a
 * way around the rule that it never closes its own findings.
 */
export const executorApi = {
  meta: (tenantId: string) =>
    call<ExecutorMetaView>(`/tenants/${encodeURIComponent(tenantId)}/executor/meta`),

  list: (
    tenantId: string,
    filters: {
      kind?: ExceptionKind;
      severity?: ExceptionSeverity;
      state?: ExceptionState;
      engineAgentId?: string;
      openOnly?: boolean;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (filters.kind !== undefined) query.set('kind', filters.kind);
    if (filters.severity !== undefined) query.set('severity', filters.severity);
    if (filters.state !== undefined) query.set('state', filters.state);
    if (filters.engineAgentId !== undefined) query.set('engineAgentId', filters.engineAgentId);
    if (filters.openOnly !== undefined) query.set('openOnly', String(filters.openOnly));
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;

    return call<{ exceptions: ExceptionView[]; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/executor/exceptions${suffix}`,
    );
  },

  view: (tenantId: string, exceptionId: string) =>
    call<ExceptionView>(
      `/tenants/${encodeURIComponent(tenantId)}/executor/exceptions/${encodeURIComponent(
        exceptionId,
      )}`,
    ),

  act: (
    tenantId: string,
    exceptionId: string,
    body: { action: ResolutionAction; note: string; toUserId?: string },
  ) =>
    call<ExceptionView>(
      `/tenants/${encodeURIComponent(tenantId)}/executor/exceptions/${encodeURIComponent(
        exceptionId,
      )}/act`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  sweep: (tenantId: string) =>
    call<{
      raised: number;
      escalated: number;
      cleared: number;
      byKind: Record<string, number>;
      note: string;
    }>(`/tenants/${encodeURIComponent(tenantId)}/executor/sweep`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
};

// ---------------------------------------------------------------------------
// Approvals (Prompt 28)
// ---------------------------------------------------------------------------

export interface ApprovalDecisionView {
  id: string;
  decision: 'Approve' | 'Reject' | 'SendBack' | 'Comment';
  decisionLabel: string;
  actorUserId: string;
  onBehalfOfUserId: string | null;
  note: string;
  occurredAt: string;
}

export interface ApprovalSummaryView {
  id: string;
  type: ApprovalRequestType;
  typeLabel: string;
  status: string;
  title: string;
  subjectType: string;
  subjectId: string | null;
  objectiveId: string | null;
  requestedByUserId: string;
  namedApproverUserId: string | null;
  approverRoleKind: string | null;
  module: string;
  submittedAt: string;
  dueAt: string | null;
  bucket: AgingBucket;
  bucketLabel: string;
  bucketTone: string;
  hoursOpen: number;
  escalatedAt: string | null;
  escalatedToUserId: string | null;
}

export interface ApprovalRequestDetailView extends ApprovalSummaryView {
  detail: string;
  decidedByUserId: string | null;
  decidedOnBehalfOfUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  history: ApprovalDecisionView[];
  available: { decision: string; label: string; allowed: boolean; reason: string }[];
  actingUnderDelegationFrom: string | null;
  version: number;
}

export interface ApprovalDelegationView {
  id: string;
  fromUserId: string;
  toUserId: string;
  types: ApprovalRequestType[];
  startsAt: string;
  endsAt: string;
  reason: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  active: boolean;
}

export interface ApprovalsMetaView {
  types: { type: ApprovalRequestType; label: string; module: string }[];
  statuses: { status: string; label: string }[];
  decisions: { decision: string; label: string; settles: boolean; needsReason: boolean }[];
  buckets: { bucket: string; label: string; tone: string }[];
  separationOfDuties: { rule: string; label: string }[];
  agingAfterHours: number;
  maxDelegationDays: number;
  note: string;
}

export const approvalsApi = {
  meta: (tenantId: string) =>
    call<ApprovalsMetaView>(`/tenants/${encodeURIComponent(tenantId)}/approvals/meta`),

  list: (
    tenantId: string,
    filters: { status?: string; type?: ApprovalRequestType; mineOnly?: boolean } = {},
  ) => {
    const query = new URLSearchParams();
    if (filters.status !== undefined) query.set('status', filters.status);
    if (filters.type !== undefined) query.set('type', filters.type);
    if (filters.mineOnly !== undefined) query.set('mineOnly', String(filters.mineOnly));
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;

    return call<{ requests: ApprovalSummaryView[]; counts: Record<string, number> }>(
      `/tenants/${encodeURIComponent(tenantId)}/approvals${suffix}`,
    );
  },

  view: (tenantId: string, approvalId: string) =>
    call<ApprovalRequestDetailView>(
      `/tenants/${encodeURIComponent(tenantId)}/approvals/${encodeURIComponent(approvalId)}`,
    ),

  decide: (tenantId: string, approvalId: string, body: { decision: string; note: string }) =>
    call<ApprovalRequestDetailView>(
      `/tenants/${encodeURIComponent(tenantId)}/approvals/${encodeURIComponent(approvalId)}/decide`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  delegations: (tenantId: string, userId?: string) =>
    call<ApprovalDelegationView[]>(
      `/tenants/${encodeURIComponent(tenantId)}/approvals/delegations` +
        (userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`),
    ),

  delegate: (
    tenantId: string,
    body: {
      toUserId: string;
      types: ApprovalRequestType[];
      startsAt: string;
      endsAt: string;
      reason: string;
    },
  ) =>
    call<ApprovalDelegationView>(`/tenants/${encodeURIComponent(tenantId)}/approvals/delegations`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  revokeDelegation: (tenantId: string, delegationId: string) =>
    call<ApprovalDelegationView>(
      `/tenants/${encodeURIComponent(tenantId)}/approvals/delegations/${encodeURIComponent(
        delegationId,
      )}`,
      { method: 'DELETE' },
    ),

  escalate: (tenantId: string) =>
    call<{ escalated: number; skipped: { id: string; reason: string }[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/approvals/escalate`,
      { method: 'POST' },
    ),
};

// ---------------------------------------------------------------------------
// Providers & Models (Prompt 29) — platform-plane only
// ---------------------------------------------------------------------------
//
// There is deliberately no company-facing counterpart. Section 19: "employees do not manage
// provider keys", and Technical Architecture §18 keeps provider names behind the gateway — so a
// company workspace has no route that could enumerate them.

export interface ProviderModelView {
  id: string;
  providerModelRef: string;
  capability: string;
  lifecycle: 'Active' | 'Deprecated' | 'MigrationRequired';
  enabled: boolean;
  lifecycleChangedAt: string | null;
  lifecycleNote: string | null;
  currentPricing: {
    id: string;
    versionNumber: number;
    currency: string;
    inputPerMillionMinorUnits: number;
    outputPerMillionMinorUnits: number;
    cachedInputPerMillionMinorUnits: number | null;
    effectiveFrom: string;
  } | null;
}

export interface ProviderProfileView {
  id: string;
  tenantId: string | null;
  kind: string;
  kindLabel: string;
  mode: string;
  label: string;
  lifecycle: 'Active' | 'Deprecated' | 'MigrationRequired';
  enabled: boolean;
  custom: {
    baseUrl: string;
    authType: string;
    authHeaderName: string | null;
    /** Whether a secret is stored. Never the value. */
    hasSecret: boolean;
    timeoutMs: number;
    usageMapping: { inputPath: string; outputPath: string; cachedInputPath: string | null };
    requestIdPath: string | null;
  } | null;
  adapterCanReachProvider: boolean;
  lastTest: { at: string; ok: boolean; reachedProvider: boolean; detail: string } | null;
  models: ProviderModelView[];
  version: number;
}

export interface LogicalProfileRoutingView {
  profile: string;
  typicalUse: string;
  gatewayBehaviour: string;
  fallbackPolicy: string;
  schemaConstrained: boolean;
  needsExplicitGuardrail: boolean;
  routes: {
    providerModelId: string;
    capability: string;
    preference: number;
    lifecycle: string;
    enabled: boolean;
    wouldAnswer: boolean;
  }[];
  unroutableReason: string | null;
}

export interface ProvidersMetaView {
  kinds: { kind: string; adapterRegistered: boolean; canReachProvider: boolean }[];
  modes: string[];
  authTypes: string[];
  lifecycleStates: string[];
  profiles: {
    profile: string;
    typicalUse: string;
    gatewayBehaviour: string;
    fallbackPolicy: string;
    schemaConstrained: boolean;
    needsExplicitGuardrail: boolean;
  }[];
  note: string;
}

export interface ProviderTestResultView {
  ok: boolean;
  reachedProvider: boolean;
  providerRequestId: string | null;
  latencyMs: number | null;
  detail: string;
}

export const providersApi = {
  meta: () => call<ProvidersMetaView>('/platform/providers/meta'),
  profiles: () => call<ProviderProfileView[]>('/platform/providers/profiles'),
  routing: (tenantId?: string) =>
    call<LogicalProfileRoutingView[]>(
      '/platform/providers/routing' +
        (tenantId === undefined ? '' : `?tenantId=${encodeURIComponent(tenantId)}`),
    ),
  testConnection: (profileId: string) =>
    call<ProviderTestResultView>(
      `/platform/providers/profiles/${encodeURIComponent(profileId)}/test`,
      { method: 'POST' },
    ),
  setLifecycle: (modelId: string, body: { lifecycle: string; note: string }) =>
    call<ProviderModelView>(`/platform/providers/models/${encodeURIComponent(modelId)}/lifecycle`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ---------------------------------------------------------------------------
// Tokens & Cost (Prompt 30)
// ---------------------------------------------------------------------------

export interface WalletView {
  id: string;
  scope: 'Company' | 'Department' | 'Objective' | 'Agent';
  scopeLabel: string;
  subjectId: string | null;
  currency: string;
  allowanceMinor: number;
  usedMinor: number;
  reservedMinor: number;
  remainingMinor: number;
  percent: number;
  threshold: 'Information' | 'Warning' | 'Critical' | 'HardStop' | null;
  periodStart: string;
  resetsAt: string | null;
  expiresAt: string | null;
  projectedExhaustion: { at: string; daysAway: number } | null;
}

export interface CostLedgerEntryView {
  id: string;
  kind: string;
  amountMinor: number;
  currency: string;
  reason: string;
  reference: string | null;
  actorUserId: string | null;
  balanceAfterAllowanceMinor: number;
  balanceAfterUsedMinor: number;
  balanceAfterReservedMinor: number;
  agentRunId: string | null;
  objectiveId: string | null;
  logicalProfile: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  occurredAt: string;
}

export interface CostMetaView {
  scopes: { scope: string; label: string }[];
  thresholds: { threshold: string; label: string; tone: string; defaultPercent: number }[];
  ledgerKinds: { kind: string; label: string }[];
  reservationStates: { state: string; label: string }[];
  note: string;
}

export const costApi = {
  meta: (tenantId: string) =>
    call<CostMetaView>(`/tenants/${encodeURIComponent(tenantId)}/cost/meta`),
  wallets: (tenantId: string) =>
    call<WalletView[]>(`/tenants/${encodeURIComponent(tenantId)}/cost/wallets`),
  ledger: (tenantId: string, filters: { walletId?: string; agentRunId?: string } = {}) => {
    const query = new URLSearchParams();
    if (filters.walletId !== undefined) query.set('walletId', filters.walletId);
    if (filters.agentRunId !== undefined) query.set('agentRunId', filters.agentRunId);
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    return call<CostLedgerEntryView[]>(
      `/tenants/${encodeURIComponent(tenantId)}/cost/ledger${suffix}`,
    );
  },
  reconcile: (tenantId: string) =>
    call<{ checked: number; findings: unknown[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/cost/reconcile`,
      { method: 'POST' },
    ),
};

// ---------------------------------------------------------------------------
// Credits (Prompt 31)
// ---------------------------------------------------------------------------
//
// The company asks; Finance decides. There is deliberately no company-side approve call — a
// company approving its own credit request would be setting its own commercial terms.

export interface CreditRequestView {
  id: string;
  state: 'Submitted' | 'Approved' | 'Rejected' | 'Cancelled';
  requestedMinor: number;
  approvedMinor: number | null;
  currency: string;
  reason: string;
  billingChoice: string | null;
  requestedByUserId: string;
  requestedAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  effectiveFrom: string | null;
  expiresAt: string | null;
  reference: string | null;
  grantId: string | null;
}

export interface CreditGrantView {
  id: string;
  source: string;
  amountMinor: number;
  currency: string;
  effectiveFrom: string;
  expiresAt: string | null;
  writtenOffAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  reason: string;
  reference: string | null;
  live: boolean;
}

export interface CreditsMetaView {
  requestStates: { state: string; label: string; tone: string }[];
  billingChoices: { choice: string; label: string }[];
  grantSources: { source: string; label: string }[];
  policies: {
    reset: { value: string; label: string }[];
    carryForward: { value: string; label: string }[];
    negativeBalance: { value: string; label: string }[];
    planChange: { value: string; label: string }[];
  };
  defaults: Record<string, unknown>;
  note: string;
}

export interface CreditPolicyView {
  resetPolicy: string;
  carryForwardPolicy: string;
  carryForwardCapMinor: number | null;
  defaultTopUpExpiryDays: number | null;
  negativeBalancePolicy: string;
  negativeBalanceGraceMinor: number;
  planChangePolicy: string;
  billingChoiceEnabled: boolean;
  periodStart: string;
  nextResetAt: string | null;
}

export const creditsApi = {
  meta: (tenantId: string) =>
    call<CreditsMetaView>(`/tenants/${encodeURIComponent(tenantId)}/credits/meta`),
  policy: (tenantId: string) =>
    call<CreditPolicyView>(`/tenants/${encodeURIComponent(tenantId)}/credits/policy`),
  requests: (tenantId: string) =>
    call<CreditRequestView[]>(`/tenants/${encodeURIComponent(tenantId)}/credits/requests`),
  grants: (tenantId: string) =>
    call<CreditGrantView[]>(`/tenants/${encodeURIComponent(tenantId)}/credits/grants`),
  request: (
    tenantId: string,
    body: { amountMinor: number; reason: string; billingChoice?: string },
  ) =>
    call<CreditRequestView>(`/tenants/${encodeURIComponent(tenantId)}/credits/requests`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancel: (tenantId: string, requestId: string, reason: string) =>
    call<CreditRequestView>(
      `/tenants/${encodeURIComponent(tenantId)}/credits/requests/${encodeURIComponent(
        requestId,
      )}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  reallocate: (
    tenantId: string,
    body: {
      fromScope: string;
      fromSubjectId?: string;
      toScope: string;
      toSubjectId?: string;
      amountMinor: number;
      reason: string;
    },
  ) =>
    call<{ fromRemainingMinor: number; toAllowanceMinor: number }>(
      `/tenants/${encodeURIComponent(tenantId)}/credits/reallocate`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  negativeBalance: (tenantId: string) =>
    call<{ blocks: boolean; reason: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/credits/negative-balance`,
    ),
};

// ---------------------------------------------------------------------------
// The Security Center — Prompt 32
// ---------------------------------------------------------------------------

export interface SecurityMetricReadingView {
  metric: string;
  label: string;
  value: string;
  caption: string;
  tone: 'neutral' | 'good' | 'watch' | 'bad';
  drillsInto: string;
}

export interface SecurityPostureView {
  range: string;
  metrics: SecurityMetricReadingView[];
  /** Whether to offer the export button at all, rather than offering it and refusing. */
  mayExport: boolean;
  mayRevokeSessions: boolean;
}

export interface SecurityCenterRowView {
  id: string;
  occurredAt: string;
  title: string;
  actor: string | null;
  subject: string | null;
  state: string;
  severity: string | null;
  detail: string | null;
  correlationId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  /** Non-null only on a live session, so the screen offers the action where it exists. */
  revocableSessionId: string | null;
}

export interface SecurityCenterPageView {
  view: string;
  label: string;
  purpose: string;
  rows: SecurityCenterRowView[];
  total: number;
  nextCursor?: string;
  /** What this view cannot show. Rendered, not hidden. */
  limitation?: string;
}

export interface SecurityCenterVocabulary {
  views: { view: string; label: string; purpose: string; hasCorrelationIds: boolean }[];
  metrics: string[];
  ranges: string[];
  note: string;
}

export const securityCenterApi = {
  vocabulary: (tenantId: string) =>
    call<SecurityCenterVocabulary>(
      `/tenants/${encodeURIComponent(tenantId)}/security-center/vocabulary`,
    ),

  posture: (tenantId: string, filter: Record<string, string | number | undefined> = {}) =>
    call<SecurityPostureView>(
      `/tenants/${encodeURIComponent(tenantId)}/security-center/posture${queryString(filter)}`,
    ),

  view: (
    tenantId: string,
    view: string,
    filter: Record<string, string | number | undefined> = {},
  ) =>
    call<SecurityCenterPageView>(
      `/tenants/${encodeURIComponent(tenantId)}/security-center/views/${encodeURIComponent(
        view,
      )}${queryString(filter)}`,
    ),

  /** A POST, because it records who took a copy — and shows up in the Data Exports view. */
  exportView: (
    tenantId: string,
    view: string,
    filter: Record<string, string | number | undefined> = {},
  ) =>
    call<SecurityCenterPageView>(
      `/tenants/${encodeURIComponent(tenantId)}/security-center/views/${encodeURIComponent(
        view,
      )}/export${queryString(filter)}`,
      { method: 'POST' },
    ),

  revokeSession: (tenantId: string, sessionId: string, reason: string) =>
    call<{ revoked: true; signedOutOfCompanies: number; personDisplayName: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/security-center/sessions/${encodeURIComponent(
        sessionId,
      )}/revoke${queryString({ reason })}`,
      { method: 'POST' },
    ),
};

// ---------------------------------------------------------------------------
// Engine Agent memory and AI output feedback — Prompt 33
// ---------------------------------------------------------------------------

export interface MemoryPolicyView {
  mode: string;
  /** Null means it does not expire. Only legitimate for the approved long-term mode. */
  retentionDays: number | null;
  visibility: string;
  maxClassification: string;
  allowCrossUser: boolean;
  allowCrossObjective: boolean;
  offboardingBehaviour: string;
  requiresApproval: boolean;
}

export interface MemoryRecordView {
  id: string;
  mode: string;
  visibility: string;
  classification: string;
  label: string;
  runId: string;
  objectiveId: string | null;
  engineAgentId: string;
  ownerUserId: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
  deletedReason: string | null;
  createdAt: string;
  /** False once deleted or expired — the row survives so a deletion is verifiable. */
  hasContent: boolean;
}

export interface MemoryVocabulary {
  modes: { mode: string; label: string; rule: string; maxVisibility: string }[];
  visibilities: { visibility: string; label: string }[];
  classifications: { classification: string; description: string }[];
  offboardingBehaviours: { behaviour: string; label: string }[];
  maxRetentionDays: number;
  note: string;
}

export const memoryApi = {
  vocabulary: (tenantId: string) =>
    call<MemoryVocabulary>(`/tenants/${encodeURIComponent(tenantId)}/memory/vocabulary`),

  policies: (tenantId: string) =>
    call<{ policies: MemoryPolicyView[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/memory/policies`,
    ),

  setPolicy: (
    tenantId: string,
    mode: string,
    body: Omit<MemoryPolicyView, 'mode'> & { reason: string },
  ) =>
    call<MemoryPolicyView>(
      `/tenants/${encodeURIComponent(tenantId)}/memory/policies/${encodeURIComponent(mode)}`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  records: (tenantId: string, filter: Record<string, string | number | boolean | undefined> = {}) =>
    call<{ records: MemoryRecordView[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/memory/records${queryString(filter)}`,
    ),

  forget: (tenantId: string, recordId: string, reason: string) =>
    call<MemoryRecordView>(
      `/tenants/${encodeURIComponent(tenantId)}/memory/records/${encodeURIComponent(
        recordId,
      )}${queryString({ reason })}`,
      { method: 'DELETE' },
    ),
};

export interface FeedbackView {
  id: string;
  runId: string;
  rating: string;
  correction: string | null;
  evidence: string | null;
  reviewerUserId: string;
  /** False for a mock-model result. Shown, so no figure implies it was real. */
  producedByRealModel: boolean | null;
  evaluationEligible: boolean;
  evaluationReason: string | null;
  promotedCaseId: string | null;
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackMeta {
  /** What UBoss will and will not do with a correction. Rendered, not paraphrased. */
  stance: string;
  promoteAction: string;
  promoteModule: string;
  ratings: { rating: string; label: string; description: string; requiresCorrection: boolean }[];
  minCorrectionLength: number;
}

export interface QualitySummaryView {
  total: number;
  correct: number;
  needsCorrection: number;
  incorrect: number;
  incomplete: number;
  correctPercent: number | null;
  /** How much of the feedback was on real provider output. Never omitted. */
  onRealModelOutput: number;
}

export const feedbackApi = {
  meta: (tenantId: string) =>
    call<FeedbackMeta>(`/tenants/${encodeURIComponent(tenantId)}/feedback/meta`),

  forRun: (tenantId: string, runId: string) =>
    call<{ feedback: FeedbackView[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/feedback/runs/${encodeURIComponent(runId)}`,
    ),

  submit: (
    tenantId: string,
    runId: string,
    body: { rating: string; correction?: string; evidence?: string },
  ) =>
    call<FeedbackView>(
      `/tenants/${encodeURIComponent(tenantId)}/feedback/runs/${encodeURIComponent(runId)}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  amend: (
    tenantId: string,
    feedbackId: string,
    body: { rating: string; correction?: string; evidence?: string },
  ) =>
    call<FeedbackView>(
      `/tenants/${encodeURIComponent(tenantId)}/feedback/${encodeURIComponent(feedbackId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  quality: (tenantId: string, engineAgentId?: string) =>
    call<QualitySummaryView>(
      `/tenants/${encodeURIComponent(tenantId)}/feedback/quality${queryString(
        engineAgentId === undefined ? {} : { engineAgentId },
      )}`,
    ),

  promote: (tenantId: string, feedbackId: string, body: { skillVersionId: string; name: string }) =>
    call<{ caseId: string; feedback: FeedbackView }>(
      `/tenants/${encodeURIComponent(tenantId)}/feedback/${encodeURIComponent(feedbackId)}/promote`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};

export interface AgentRunSummaryView {
  id: string;
  state: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  output: unknown;
  failureReason: string | null;
  producedByRealModel: boolean | null;
}

/**
 * One agent's runs.
 *
 * Added at Prompt 33 because the feedback control has to be attached to something: Prompt 26 built
 * the run engine and its routes and no screen ever read them, so "feedback on permitted AI
 * outputs" had nothing to hang from. This is the minimum needed — a list of an agent's runs — not
 * the Runs screen, which is a prompt of its own.
 */
export const agentRunsApi = {
  list: (tenantId: string, agentId: string, limit = 20) =>
    call<{ runs: AgentRunSummaryView[]; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(
        agentId,
      )}/runs${queryString({ limit })}`,
    ),
};

// ---------------------------------------------------------------------------
// Objective closure and Outcome Review — Prompt 34
// ---------------------------------------------------------------------------

export interface ObjectivePauseView {
  id: string;
  reasonKind: string;
  reason: string;
  pausedByUserId: string;
  pausedAt: string;
  resumedByUserId: string | null;
  resumedAt: string | null;
  resumeNote: string | null;
  /** Whole days stopped. Null while it is still paused. */
  daysStopped: number | null;
}

/** The figures §27.1 asks the review to compare, each from the module that owns it. */
export interface OutcomeComparisonView {
  expectedFinalResult: string;
  targetDate: string | null;
  completedAt: string | null;
  humanTasksTotal: number;
  humanTasksCompleted: number;
  /** Wall-clock, **not** effort — UBoss records no effort. See the closure types. */
  humanElapsedMinutes: number | null;
  aiCostMinor: number;
  aiCostCurrency: string;
  agentRunsTotal: number;
  exceptionsTotal: number;
  exceptionsUnresolved: number;
}

export interface OutcomeReviewView {
  id: string;
  objectiveId: string;
  objectiveVersionId: string;
  verdict: string;
  actualResult: string;
  explanation: string | null;
  slaOutcome: string;
  daysLate: number | null;
  comparison: OutcomeComparisonView;
  /** The policy in force when the review was written, not the company's current one. */
  signOffPolicy: string;
  reviewedByUserId: string;
  reviewedAt: string;
  signedOffByUserId: string | null;
  signedOffAt: string | null;
  approvalRequestId: string | null;
  closedAt: string | null;
  closedByUserId: string | null;
}

export interface ClosureReadinessView {
  comparison: OutcomeComparisonView;
  readiness: { ready: boolean; outstanding: string[]; blocking: string[] };
}

export interface ClosureMetaView {
  pauseReasons: string[];
  /** What a pause does and does not stop. Rendered, not paraphrased. */
  pauseEffect: string;
  signOffPolicy: string;
  minExplanationLength: number;
  note: string;
}

const closureBase = (tenantId: string, objectiveId: string) =>
  `/tenants/${encodeURIComponent(tenantId)}/objectives/${encodeURIComponent(objectiveId)}/closure`;

export const objectiveClosureApi = {
  meta: (tenantId: string, objectiveId: string) =>
    call<ClosureMetaView>(`${closureBase(tenantId, objectiveId)}/meta`),

  readiness: (tenantId: string, objectiveId: string) =>
    call<ClosureReadinessView>(`${closureBase(tenantId, objectiveId)}/readiness`),

  review: (tenantId: string, objectiveId: string) =>
    call<{ review: OutcomeReviewView | null }>(`${closureBase(tenantId, objectiveId)}/review`),

  pauses: (tenantId: string, objectiveId: string) =>
    call<{ pauses: ObjectivePauseView[] }>(`${closureBase(tenantId, objectiveId)}/pauses`),

  pause: (tenantId: string, objectiveId: string, body: { reasonKind: string; reason: string }) =>
    call<ObjectivePauseView>(`${closureBase(tenantId, objectiveId)}/pause`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resume: (tenantId: string, objectiveId: string, note?: string) =>
    call<ObjectivePauseView>(`${closureBase(tenantId, objectiveId)}/resume`, {
      method: 'POST',
      body: JSON.stringify(note === undefined ? {} : { note }),
    }),

  complete: (tenantId: string, objectiveId: string) =>
    call<{ status: string; readiness: ClosureReadinessView['readiness'] }>(
      `${closureBase(tenantId, objectiveId)}/complete`,
      { method: 'POST' },
    ),

  writeReview: (
    tenantId: string,
    objectiveId: string,
    body: { verdict: string; actualResult: string; explanation?: string },
  ) =>
    call<OutcomeReviewView>(`${closureBase(tenantId, objectiveId)}/review`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  signOff: (tenantId: string, objectiveId: string) =>
    call<OutcomeReviewView>(`${closureBase(tenantId, objectiveId)}/sign-off`, { method: 'POST' }),

  close: (tenantId: string, objectiveId: string, approvalRequestId?: string) =>
    call<OutcomeReviewView>(`${closureBase(tenantId, objectiveId)}/close`, {
      method: 'POST',
      body: JSON.stringify(approvalRequestId === undefined ? {} : { approvalRequestId }),
    }),

  archive: (tenantId: string, objectiveId: string) =>
    call<{ status: string }>(`${closureBase(tenantId, objectiveId)}/archive`, { method: 'POST' }),
};

// ---------------------------------------------------------------------------
// Knowledge, files and data classification — Prompt 35
// ---------------------------------------------------------------------------

export interface StoredFileView {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  classification: string;
  scanState: string;
  scanResult: string | null;
  /** False for the mock scanner. Shown, so no tick implies a real antivirus product. */
  scannedByRealScanner: boolean | null;
  usable: boolean;
  retentionAction: string;
  retentionExpiresAt: string | null;
  onLegalHold: boolean;
  legalHoldReason: string | null;
  uploadedByUserId: string;
  uploadedAt: string;
  deletedAt: string | null;
  deletedReason: string | null;
  hasContent: boolean;
}

export interface KnowledgePolicyView {
  maxUploadBytes: number;
  allowedContentTypes: string[];
  defaultRetentionDays: number | null;
  defaultRetentionAction: string;
  exportCeiling: string;
  externalEgressCeiling: string;
}

export interface FileMeta {
  scanStates: { key: string; label: string; description: string }[];
  classifications: readonly string[];
  retentionActions: { key: string; label: string; description: string }[];
  redactionStance: string;
  adapters: { storage: string; storageCanStore: boolean; scanner: string };
}

export interface KnowledgeSourceView {
  id: string;
  name: string;
  description: string;
  kind: string;
  state: string;
  accessScope: string;
  departmentId: string | null;
  namedAgentIds: string[];
  classification: string;
  connectionId: string | null;
  fileCount: number;
  unusableFileCount: number;
  approvedAt: string | null;
  approvedByUserId: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  createdByUserId: string;
  createdAt: string;
  version: number;
}

export interface KnowledgeMeta {
  kinds: { key: string; label: string }[];
  states: readonly string[];
  accessScopes: { key: string; label: string }[];
  classifications: readonly string[];
}

const filesBase = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/files`;

export const filesApi = {
  meta: (tenantId: string) => call<FileMeta>(`${filesBase(tenantId)}/meta`),

  policy: (tenantId: string) => call<KnowledgePolicyView>(`${filesBase(tenantId)}/policy`),

  setPolicy: (tenantId: string, body: KnowledgePolicyView & { reason: string }) =>
    call<KnowledgePolicyView>(`${filesBase(tenantId)}/policy`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  list: (tenantId: string, includeDeleted = false) =>
    call<{ files: StoredFileView[] }>(
      `${filesBase(tenantId)}${queryString({ includeDeleted: includeDeleted || undefined })}`,
    ),

  /**
   * Upload a file.
   *
   * Base64 in a JSON body, not multipart — the whole API is JSON and one request pipeline means
   * one place the size limit is enforced. The caller reads the bytes; this only encodes them.
   */
  upload: (
    tenantId: string,
    body: {
      filename: string;
      contentType: string;
      contentBase64: string;
      classification?: string;
    },
  ) => call<StoredFileView>(filesBase(tenantId), { method: 'POST', body: JSON.stringify(body) }),

  scan: (tenantId: string, fileId: string) =>
    call<StoredFileView>(`${filesBase(tenantId)}/${encodeURIComponent(fileId)}/scan`, {
      method: 'POST',
    }),

  download: (tenantId: string, fileId: string) =>
    call<{ file: StoredFileView; contentBase64: string }>(
      `${filesBase(tenantId)}/${encodeURIComponent(fileId)}/content`,
    ),

  classify: (tenantId: string, fileId: string, body: { classification: string; reason: string }) =>
    call<StoredFileView>(`${filesBase(tenantId)}/${encodeURIComponent(fileId)}/classification`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  legalHold: (tenantId: string, fileId: string, body: { onHold: boolean; reason: string }) =>
    call<StoredFileView>(`${filesBase(tenantId)}/${encodeURIComponent(fileId)}/legal-hold`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  remove: (tenantId: string, fileId: string, reason: string) =>
    call<StoredFileView>(`${filesBase(tenantId)}/${encodeURIComponent(fileId)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  sweepRetention: (tenantId: string) =>
    call<{ deleted: number; heldBack: number }>(`${filesBase(tenantId)}/retention/sweep`, {
      method: 'POST',
    }),
};

const sourcesBase = (tenantId: string) =>
  `/tenants/${encodeURIComponent(tenantId)}/knowledge-sources`;

export const knowledgeApi = {
  meta: (tenantId: string) => call<KnowledgeMeta>(`${sourcesBase(tenantId)}/meta`),

  list: (tenantId: string, includeRetired = false) =>
    call<{ sources: KnowledgeSourceView[] }>(
      `${sourcesBase(tenantId)}${queryString({ includeRetired: includeRetired || undefined })}`,
    ),

  create: (
    tenantId: string,
    body: {
      name: string;
      kind: string;
      description?: string;
      accessScope?: string;
      departmentId?: string;
      namedAgentIds?: string[];
      classification?: string;
      connectionId?: string;
    },
  ) =>
    call<KnowledgeSourceView>(sourcesBase(tenantId), {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  approve: (tenantId: string, sourceId: string, note?: string) =>
    call<KnowledgeSourceView>(`${sourcesBase(tenantId)}/${encodeURIComponent(sourceId)}/approve`, {
      method: 'POST',
      body: JSON.stringify(note === undefined ? {} : { note }),
    }),

  retire: (tenantId: string, sourceId: string, reason: string) =>
    call<KnowledgeSourceView>(`${sourcesBase(tenantId)}/${encodeURIComponent(sourceId)}/retire`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  addFile: (tenantId: string, sourceId: string, fileId: string) =>
    call<{ added: true }>(`${sourcesBase(tenantId)}/${encodeURIComponent(sourceId)}/files`, {
      method: 'POST',
      body: JSON.stringify({ fileId }),
    }),

  removeFile: (tenantId: string, sourceId: string, fileId: string) =>
    call<{ removed: true }>(
      `${sourcesBase(tenantId)}/${encodeURIComponent(sourceId)}/files/remove`,
      { method: 'POST', body: JSON.stringify({ fileId }) },
    ),
};

// ---------------------------------------------------------------------------
// Support, support sessions and system health — Prompt 36
// ---------------------------------------------------------------------------

export interface SupportTicketView {
  id: string;
  reference: number;
  subject: string;
  body: string;
  kind: string;
  priority: string;
  state: string;
  isOpen: boolean;
  raisedByUserId: string;
  assignedOperatorUserId: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  closedAt: string | null;
  serviceAlertId: string | null;
  createdAt: string;
  version: number;
}

export interface SupportTicketNoteView {
  id: string;
  body: string;
  isInternal: boolean;
  authorUserId: string;
  authorIsOperator: boolean;
  createdAt: string;
}

export interface SupportMeta {
  kinds: { key: string; label: string }[];
  priorities: readonly string[];
  states: { key: string; label: string }[];
  authorizationModes: { key: string; label: string; description: string }[];
  /** What UBoss support can and cannot do, in the server's own words. */
  accessStance: string;
}

export interface SupportAccessRequestView {
  id: string;
  reason: string;
  externalReference: string | null;
  allowedModules: string[];
  allowedActions: string[];
  state: string;
  expiresAt: string | null;
  requestedAt: string;
  customerAuthorizationState: string;
}

/** What a company is told about UBoss's own health. Carries no internal detail by construction. */
export interface ServiceStatusView {
  status: string;
  summary: string;
  incidents: {
    id: string;
    severity: string;
    state: string;
    startedAt: string;
    customerImpact: string;
  }[];
  stance: string;
}

const supportBase = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/support`;

export const supportApi = {
  meta: (tenantId: string) => call<SupportMeta>(`${supportBase(tenantId)}/meta`),

  tickets: (tenantId: string, includeClosed = false) =>
    call<{ tickets: SupportTicketView[] }>(
      `${supportBase(tenantId)}/tickets${queryString({
        includeClosed: includeClosed || undefined,
      })}`,
    ),

  raise: (
    tenantId: string,
    body: { subject: string; body: string; kind: string; priority?: string },
  ) =>
    call<SupportTicketView>(`${supportBase(tenantId)}/tickets`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  ticket: (tenantId: string, ticketId: string) =>
    call<{ ticket: SupportTicketView; notes: SupportTicketNoteView[] }>(
      `${supportBase(tenantId)}/tickets/${encodeURIComponent(ticketId)}`,
    ),

  reply: (tenantId: string, ticketId: string, body: string) =>
    call<SupportTicketNoteView>(
      `${supportBase(tenantId)}/tickets/${encodeURIComponent(ticketId)}/reply`,
      { method: 'POST', body: JSON.stringify({ body }) },
    ),

  accessRequests: (tenantId: string) =>
    call<{ mode: string; requests: SupportAccessRequestView[] }>(
      `${supportBase(tenantId)}/access-requests`,
    ),

  decideAccess: (
    tenantId: string,
    requestId: string,
    body: { authorized: boolean; note?: string },
  ) =>
    call<{ id: string; customerAuthorizationState: string; decidedAt: string | null }>(
      `${supportBase(tenantId)}/access-requests/${encodeURIComponent(requestId)}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  serviceStatus: (tenantId: string) =>
    call<ServiceStatusView>(`/tenants/${encodeURIComponent(tenantId)}/service-status`),
};

// ---------------------------------------------------------------------------
// Reporting and the locked dashboard — Prompt 37
// ---------------------------------------------------------------------------

/**
 * The Company Workspace Dashboard payload.
 *
 * **Three fields, and that is the locked contract.** Two counts and a sentence saying what they
 * cover. No KPI cards, no cost, no notifications — if a future field appears here, the server has
 * broken a rule a test already asserts.
 */
export interface DashboardView {
  agents: number;
  pendingJobs: number;
  scope: string;
}

export interface DashboardMeta {
  slices: { key: string; label: string; href: string }[];
  contract: string;
}

export interface ReportDefinitionView {
  key: string;
  label: string;
  question: string;
  sourcePermission: { module: string; action: string } | null;
  scoped: boolean;
}

export interface ReportCatalogue {
  reports: ReportDefinitionView[];
  ranges: { key: string; label: string }[];
  defaultRange: string;
  mayExport: boolean;
  scope: string;
  stance: string;
}

export interface ReportRunView {
  report: ReportDefinitionView;
  scope: string;
  window: { from: string; to: string };
  columns: string[];
  rows: Record<string, unknown>[];
  summary: Record<string, number | string>;
  truncated: boolean;
}

export const dashboardApi = {
  counts: (tenantId: string) =>
    call<DashboardView>(`/tenants/${encodeURIComponent(tenantId)}/dashboard`),

  meta: (tenantId: string) =>
    call<DashboardMeta>(`/tenants/${encodeURIComponent(tenantId)}/dashboard/meta`),
};

export const reportsApi = {
  catalogue: (tenantId: string) =>
    call<ReportCatalogue>(`/tenants/${encodeURIComponent(tenantId)}/reports`),

  run: (
    tenantId: string,
    key: string,
    filter: { range?: string; from?: string; to?: string } = {},
  ) =>
    call<ReportRunView>(
      `/tenants/${encodeURIComponent(tenantId)}/reports/${encodeURIComponent(key)}${queryString(
        filter,
      )}`,
    ),

  /**
   * The export URL, for the browser to follow.
   *
   * Returned rather than fetched, so the download is an ordinary navigation the browser handles —
   * fetching a CSV into memory to re-offer it as a blob would buffer a whole report for no reason.
   */
  exportHref: (
    tenantId: string,
    key: string,
    filter: { range?: string; from?: string; to?: string } = {},
  ) =>
    `${API_BASE_URL}/tenants/${encodeURIComponent(tenantId)}/reports/${encodeURIComponent(
      key,
    )}/export${queryString(filter)}`,
};

// ---------------------------------------------------------------------------
// Portable UBoss Profile Search — Prompt 37A
// ---------------------------------------------------------------------------

export interface PortablePerformanceView {
  score: number | null;
  badge: string | null;
  onTimePercent: number | null;
  achievements: { count: number; mostRecentAt: string | null };
}

export interface PortableEmploymentView {
  companyName: string;
  designation: string;
  joinedOn: string | null;
  endedAt: string | null;
  isCurrent: boolean;
  /** Null when that company does not share performance in portable search. */
  performance: PortablePerformanceView | null;
}

/**
 * A portable profile.
 *
 * **Four fields, and that is the whole contract.** No email, no phone, no employee number, no
 * department, no reporting manager, and never Aadhaar — the server's projection is a whitelist and
 * a test greps its response for every forbidden word.
 */
export interface PortableProfileView {
  ubossUniqueId: string;
  displayName: string;
  employments: PortableEmploymentView[];
  searchedAt: string;
}

export interface ProfileSearchMeta {
  inputStance: string;
  profileStance: string;
  sharingModes: { key: string; label: string; description: string }[];
  /** False when this company has not switched portable search on. */
  enabled: boolean;
}

export const profileSearchApi = {
  meta: (tenantId: string) =>
    call<ProfileSearchMeta>(`/tenants/${encodeURIComponent(tenantId)}/profile-search/meta`),

  search: (tenantId: string, ubossUniqueId: string) =>
    call<PortableProfileView>(
      `/tenants/${encodeURIComponent(tenantId)}/profile-search${queryString({ ubossUniqueId })}`,
    ),
};

// ===========================================================================
// CR-03 (Prompt 40A)
// ===========================================================================

export interface CapabilityRow {
  key: string;
  label: string;
  tier: 'Operate' | 'Manage' | 'Build';
  help: string;
  held: boolean;
  canGrant: boolean;
  whyNot?: string;
  grants: Record<string, string[]>;
}

export interface CapabilityStep {
  tiers: { key: string; label: string; description: string }[];
  capabilities: CapabilityRow[];
  defaultForNewEmployee: string[];
  delegationStance: string;
}

export const capabilitiesApi = {
  step: (tenantId: string, userId: string) =>
    call<CapabilityStep>(
      `/tenants/${encodeURIComponent(tenantId)}/access/capabilities/${encodeURIComponent(userId)}`,
    ),

  grant: (tenantId: string, userId: string, capabilities: string[]) =>
    call<{ granted: string[]; alreadyHeld: string[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/capabilities/${encodeURIComponent(userId)}`,
      { method: 'POST', body: JSON.stringify({ capabilities }) },
    ),

  revoke: (tenantId: string, userId: string, capability: string) =>
    call<{ revoked: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/access/capabilities/${encodeURIComponent(
        userId,
      )}/${encodeURIComponent(capability)}`,
      { method: 'DELETE' },
    ),
};

export interface PhotoView {
  userId: string;
  storedFileId: string | null;
  contentType: string | null;
  uploadedAt: string | null;
  /** False while a scan has not cleared it — the screen shows initials, as for no photo at all. */
  viewable: boolean;
  initials: string;
}

export const photosApi = {
  meta: (tenantId: string) =>
    call<{ contentTypes: string[]; maxBytes: number; optional: boolean; note: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/photos/meta`,
    ),

  view: (tenantId: string, userId: string) =>
    call<PhotoView>(
      `/tenants/${encodeURIComponent(tenantId)}/photos/${encodeURIComponent(userId)}`,
    ),

  viewMany: (tenantId: string, userIds: string[]) =>
    call<{ photos: PhotoView[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/photos${queryString({ userIds: userIds.join(',') })}`,
    ),

  upload: (
    tenantId: string,
    userId: string,
    body: { filename: string; contentType: string; contentBase64: string },
  ) =>
    call<PhotoView>(
      `/tenants/${encodeURIComponent(tenantId)}/photos/${encodeURIComponent(userId)}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  remove: (tenantId: string, userId: string) =>
    call<{ removed: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/photos/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
};

export interface ImportProblemRow {
  kind: 'Missing' | 'Invalid' | 'Ambiguous' | 'Unmapped';
  row: number | null;
  column: string | null;
  detail: string;
}

export interface ImportOutcomeView {
  accepted: boolean;
  stage: string;
  problems: ImportProblemRow[];
  rows: Record<string, unknown>[];
  refusedBecause: string | null;
  agentSuggestion: { groups: { key: string; steps: number[]; because: string }[] } | null;
}

export interface JobMethodMeta {
  formVersion: number;
  maxRows: number;
  columns: { key: string; heading: string }[];
  columnsTheEmployeeMustAnswer: string[];
  importStages: { key: string; label: string }[];
  problemKinds: { key: string; label: string }[];
  buildFlow: { key: string; label: string; required: boolean }[];
  agentBoundaryFactors: { key: string; label: string; why: string }[];
  automationStance: string;
}

export const jobMethodApi = {
  meta: (tenantId: string) =>
    call<JobMethodMeta>(`/tenants/${encodeURIComponent(tenantId)}/job-methods/meta`),

  view: (tenantId: string, assignmentId: string) =>
    call<{
      captured: boolean;
      rows: Record<string, unknown>[];
      imports: {
        filename: string;
        stage: string;
        accepted: boolean;
        refusedBecause: string | null;
        rowsRead: number;
        rowsAccepted: number;
        importedAt: string;
      }[];
      agentSuggestion: { groups: { key: string; steps: number[]; because: string }[] } | null;
      automationStance: string;
    }>(`/tenants/${encodeURIComponent(tenantId)}/job-methods/${encodeURIComponent(assignmentId)}`),

  /**
   * The real spreadsheet.
   *
   * Not `call`: that parses JSON, and this is binary. A blob plus an object URL is what makes the
   * browser save a file the employee can open — which is the entire point of CR-03 §4, and the
   * thing a JSON endpoint could not do.
   */
  downloadWorkbook: async (tenantId: string, assignmentId: string): Promise<void> => {
    const response = await fetch(
      `${API_BASE_URL}/tenants/${encodeURIComponent(tenantId)}/job-methods/${encodeURIComponent(
        assignmentId,
      )}/form.xlsx`,
      { credentials: 'include' },
    );

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw new ApiError(
        messageFrom(body, 'The Job Method form could not be produced.'),
        response.status,
      );
    }

    const blob = await response.blob();
    // The server names the file after the work; fall back only if the header is missing.
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const named = /filename="([^"]+)"/.exec(disposition);
    const filename = named?.[1] ?? 'job-method.xlsx';

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked, or every download leaks a blob for the life of the tab.
    URL.revokeObjectURL(url);
  },

  importWorkbook: (
    tenantId: string,
    assignmentId: string,
    body: { filename: string; contentBase64: string },
  ) =>
    call<ImportOutcomeView>(
      `/tenants/${encodeURIComponent(tenantId)}/job-methods/${encodeURIComponent(
        assignmentId,
      )}/import-workbook`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};

export interface OperatorAgentView {
  agentId: string;
  agentName: string;
  linkedObjectiveName: string | null;
  assignedWorkTitle: string | null;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  canRun: boolean;
  cannotRunBecause: string | null;
}

/**
 * One run as its operator sees it.
 *
 * Deliberately narrower than `AgentRunSummaryView`: no `producedByRealModel`, no raw
 * `output` document. The server projects it that way (CR-03 forbids showing an operator
 * prompts, JSON or model internals), and this type is the same shape so a screen cannot reach for a
 * field the server declined to send and then quietly read it from somewhere else.
 */
export interface OperatorRunView {
  runId: string;
  state: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultText: string | null;
  failureReason: string | null;
}

export const agentOperatorApi = {
  meta: (tenantId: string) =>
    call<{
      runPreconditions: { key: string; label: string; ifMissing: string }[];
      operatorStance: string;
    }>(`/tenants/${encodeURIComponent(tenantId)}/agents/operator-meta`),

  mine: (tenantId: string) =>
    call<{ agents: OperatorAgentView[] }>(`/tenants/${encodeURIComponent(tenantId)}/agents/mine`),
  /** View Result and History are the same list, read once. */
  myRuns: (tenantId: string, agentId: string) =>
    call<{ runs: OperatorRunView[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/my-runs`,
    ),

  /**
   * Run now.
   *
   * The Prompt 26 route, unchanged — an operator reaches it because a live share is a second way
   * to reach the agent, not because operators were given a route of their own.
   */
  run: (tenantId: string, agentId: string) =>
    call<{ id: string; state: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/runs`,
      { method: 'POST' },
    ),

  operatorView: (tenantId: string, agentId: string) =>
    call<OperatorAgentView>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(
        agentId,
      )}/operator-view`,
    ),

  operators: (tenantId: string, agentId: string) =>
    call<{ operatorUserIds: string[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}/operators`,
    ),

  share: (tenantId: string, agentId: string, operatorUserId: string) =>
    call<{ shared: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(
        agentId,
      )}/operators/${encodeURIComponent(operatorUserId)}`,
      { method: 'POST' },
    ),

  revokeShare: (tenantId: string, agentId: string, operatorUserId: string) =>
    call<{ revoked: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(
        agentId,
      )}/operators/${encodeURIComponent(operatorUserId)}`,
      { method: 'DELETE' },
    ),
};

export interface ChatConversationSummary {
  id: string;
  kind: 'Direct' | 'Group';
  title: string | null;
  participantUserIds: string[];
  lastMessageAt: string | null;
  unread: number;
}

export type ChatContextPreviewView =
  | {
      accessible: true;
      type: string;
      id: string;
      title: string;
      status: string | null;
      deepLink: string;
    }
  | { accessible: false; type: string; id: string; reason: string };

export interface ChatMessageView {
  id: string;
  authorUserId: string;
  /** Null when the author deleted it — the row stays so the conversation keeps its shape. */
  body: string | null;
  deleted: boolean;
  mentionedUserIds: string[];
  sentAt: string;
  attachments: {
    storedFileId: string;
    filename: string;
    sizeBytes: number;
    downloadable: boolean;
    scanState: string;
  }[];
}

export interface ChatConversationView {
  id: string;
  kind: 'Direct' | 'Group';
  title: string | null;
  participantUserIds: string[];
  context: ChatContextPreviewView[];
  messages: ChatMessageView[];
}

export const chatApi = {
  meta: (tenantId: string) =>
    call<{
      kinds: { key: string; label: string }[];
      contextTypes: { key: string; label: string }[];
      limits: {
        maxGroupParticipants: number;
        maxMessageBody: number;
        maxAttachmentsPerMessage: number;
        maxAttachmentBytes: number;
      };
      contextStance: string;
      attachmentStance: string;
      searchStance: string;
      realtimeStance: string;
      excludedByDesign: { feature: string; why: string }[];
    }>(`/tenants/${encodeURIComponent(tenantId)}/chat/meta`),

  conversations: (tenantId: string) =>
    call<{ conversations: ChatConversationSummary[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/chat/conversations`,
    ),

  start: (
    tenantId: string,
    body: { kind: 'Direct' | 'Group'; participantUserIds: string[]; title?: string },
  ) =>
    call<{ id: string; created: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/chat/conversations`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  read: (tenantId: string, conversationId: string) =>
    call<ChatConversationView>(
      `/tenants/${encodeURIComponent(tenantId)}/chat/conversations/${encodeURIComponent(
        conversationId,
      )}`,
    ),

  send: (
    tenantId: string,
    conversationId: string,
    body: { body: string; attachmentIds?: string[]; mentionResolutions?: Record<string, string> },
  ) =>
    call<{ id: string; mentionedUserIds: string[]; ignoredMentions: string[] }>(
      `/tenants/${encodeURIComponent(tenantId)}/chat/conversations/${encodeURIComponent(
        conversationId,
      )}/messages`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  remove: (tenantId: string, conversationId: string, messageId: string) =>
    call<{ deleted: true }>(
      `/tenants/${encodeURIComponent(tenantId)}/chat/conversations/${encodeURIComponent(
        conversationId,
      )}/messages/${encodeURIComponent(messageId)}`,
      { method: 'DELETE' },
    ),

  markRead: (tenantId: string, conversationId: string) =>
    call<{ lastReadAt: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/chat/conversations/${encodeURIComponent(
        conversationId,
      )}/read`,
      { method: 'POST' },
    ),

  addContext: (
    tenantId: string,
    conversationId: string,
    body: { contextType: string; resourceId: string },
  ) =>
    call<{ added: boolean }>(
      `/tenants/${encodeURIComponent(tenantId)}/chat/conversations/${encodeURIComponent(
        conversationId,
      )}/context`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  search: (tenantId: string, term: string) =>
    call<{ messages: Record<string, unknown>[]; stance: string }>(
      `/tenants/${encodeURIComponent(tenantId)}/chat/search${queryString({ q: term })}`,
    ),
};

/**
 * What the signed-in person may see — the source of truth for the sidebar.
 *
 * Separate from `authorizationApi`, which is platform-only and answers the same question about
 * *other* people. This one every signed-in person may ask about themselves, which is the only way
 * a standard Employee's own navigation can be rendered.
 */
export const myAccessApi = {
  mine: (tenantId: string) =>
    call<{
      userId: string;
      userType: string;
      assignedScope: string;
      visibleModules: string[];
      granted: Record<string, string[]>;
      note: string;
    }>(`/tenants/${encodeURIComponent(tenantId)}/my-access`),
};

/**
 * The URL an `<img>` uses for somebody's photo.
 *
 * A URL builder rather than a `call`, because the browser fetches this itself: an image element
 * needs an address, not a parsed response. Credentials ride on the cookie exactly as they do for
 * every other request.
 *
 * It points at the photo's **own** content route, not the generic file download — that one needs
 * `settings:Export`, which a standard Employee does not hold, so every avatar in the Hierarchy
 * would be a broken image for most of the company.
 */
export function photoContentUrl(tenantId: string, userId: string): string {
  return (
    `${API_BASE_URL}/tenants/${encodeURIComponent(tenantId)}` +
    `/photos/${encodeURIComponent(userId)}/content`
  );
}
