export { DEPENDENCY_STATUSES, HEALTH_STATUSES, isHealthResponse } from './health.js';
export type { DependencyHealth, DependencyStatus, HealthResponse, HealthStatus } from './health.js';

// ---- Authorization vocabulary (Prompt 7) ----
//
// Shared with the web application on purpose: a permission the server enforces and one the UI
// renders must be the same value, or the two drift and the UI offers controls the server refuses.
export {
  ACTION_LABELS,
  ACTIONS,
  COMPANY_MODULES,
  HIGH_RISK_ACTIONS,
  isAction,
  isCompanyModule,
  isModuleKey,
  isPlatformModule,
  isPolicyLayer,
  isRoleKind,
  isScopeKind,
  isScopeNoWiderThan,
  isSodRule,
  isUserType,
  isWriteAction,
  MODULE_KEYS,
  narrowerScope,
  PLATFORM_MODULES,
  POLICY_LAYER_LABELS,
  POLICY_LAYER_ORDER,
  POLICY_LAYERS,
  ROLE_KIND_LABELS,
  ROLE_KINDS,
  sanitisePermissionSet,
  SCOPE_BREADTH,
  SCOPE_KIND_LABELS,
  SCOPE_KINDS,
  SOD_RULE_LABELS,
  SOD_RULES,
  USER_TYPE_CEILINGS,
  USER_TYPE_LABELS,
  USER_TYPES,
  WRITE_ACTIONS,
} from './authorization.js';
export type {
  Action,
  AuthorizationDecision,
  AuthorizationTraceStep,
  CompanyModuleKey,
  DenialReason,
  ModuleKey,
  ModulePermission,
  PermissionSet,
  PlatformModuleKey,
  PolicyEffect,
  PolicyLayer,
  RoleKind,
  ScopeKind,
  SodRule,
  UserType,
} from './authorization.js';

export {
  PLATFORM_PERMISSIONS,
  ROLE_TEMPLATES,
  templateActions,
  templateModules,
  unrestrictedPermissionSet,
} from './role-templates.js';
export type { RoleTemplate } from './role-templates.js';

export { effectiveScopeFor, evaluatePrecedence, permittedActions } from './policy-precedence.js';
export type { PolicyRule, PrecedenceInput, PrecedenceResult } from './policy-precedence.js';

export {
  checkSeparationOfDuties,
  governingSodPolicy,
  isInScope,
  isInScopeAsync,
  widestGrant,
} from './scope-evaluation.js';
export type {
  HierarchyResolver,
  ResourceDescriptor,
  ScopeGrant,
  ScopeOutcome,
  SodOutcome,
  SodPolicy,
} from './scope-evaluation.js';

// ---- Platform roles (Prompt 9) ----
//
// The Master Console filters its own navigation from these, and the server enforces the same
// values — one vocabulary, so the console cannot offer a module the API refuses.
export {
  MASTER_NAV_MODULE,
  moduleForMasterNavKey,
  PLATFORM_ROLE_KINDS,
  PLATFORM_ROLE_TEMPLATES,
  unionPlatformPermissions,
} from './platform-roles.js';
export type { PlatformRoleKind, PlatformRoleTemplate } from './platform-roles.js';

// ---- Company settings (Prompt 14) ----
//
// The catalogue is code and the values are data: a setting's meaning, default and governing
// permission must be identical everywhere, and per-company values must not be able to invent a
// setting that does nothing. See `company-settings.ts`.
export {
  SETTING_DEFINITIONS,
  SETTINGS_CATEGORIES,
  settingDefinition,
  settingsInCategory,
  validateSetting,
  validateSettingCombination,
} from './company-settings.js';
export type {
  SettingDefinition,
  SettingType,
  SettingValidation,
  SettingValue,
  SettingsCategory,
} from './company-settings.js';

// ---- Notifications and escalation (Prompt 15) ----
//
// The catalogue is code for the same reason as company settings: whether an alert can be muted is
// a security property, and a preference screen that offered to mute something the engine will
// send anyway would be a lie told by the UI. `isMandatoryNotification` is the single answer both
// the engine and the screen ask.
export {
  ALWAYS_MANDATORY_KINDS,
  isMandatoryNotification,
  NOTIFICATION_DIGESTS,
  NOTIFICATION_KIND_DEFINITIONS,
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
  notificationDedupeKey,
  notificationKind,
  SEVERITY_LABELS,
  SEVERITY_TONES,
  utcDay,
} from './notifications.js';
export type {
  NotificationDigest,
  NotificationKind,
  NotificationKindDefinition,
  NotificationSeverity,
} from './notifications.js';

// ---- Integrations and connections (Prompt 16) ----
//
// `TOOL_ACTION_CATEGORIES` is deliberately **not** the human `ACTIONS` vocabulary. A person needs
// `settings:Administer` to configure a connection; an Engine Agent needs a tool grant to use one.
// Merging the two lists would let "administer the Integrations module" silently become "let an
// agent delete records in the connected ERP" — the client's rule is that they stay separate, and
// this is the file where a future change could break it by accident.
export {
  CONNECTION_ENVIRONMENTS,
  CONNECTION_SCOPES,
  CONNECTION_STATE_LABELS,
  CONNECTION_STATE_TONES,
  CONNECTION_STATES,
  CONNECTOR_DEFINITIONS,
  connectorDefinition,
  CREDENTIAL_EXPIRY_WARNING_DAYS,
  derivedConnectionState,
  HIGH_RISK_TOOL_CATEGORIES,
  isCredentialExpiringSoon,
  isHighRiskToolCategory,
  TOOL_ACTION_CATEGORIES,
  TOOL_CATEGORY_DESCRIPTIONS,
  TOOL_CATEGORY_LABELS,
  USABLE_CONNECTION_STATES,
} from './connections.js';
export type {
  ConnectionEnvironment,
  ConnectionScope,
  ConnectionState,
  ConnectorDefinition,
  ToolActionCategory,
} from './connections.js';

// ---- Skills (Prompt 17) ----
//
// **A Skill is not a Template.** The locked rule is that there is no Objective, Workflow or Agent
// Template and no Templates Library — and the difference is structural, not naming: a Skill has
// versions, statuses, approvals, owners, autonomy limits and impact analysis, none of which a
// copy-me starting point would need. That is why this file has all of them.
export {
  ALLOWED_SKILL_TRANSITIONS,
  AUTONOMY_REQUIRING_APPROVAL,
  autonomyPermittedWithHighRiskTools,
  IMMUTABLE_SKILL_STATUSES,
  isPlatformLayer,
  isSkillContentFrozen,
  mayTransitionSkill,
  PLATFORM_SKILL_LAYERS,
  SKILL_AUTONOMY_LABELS,
  SKILL_AUTONOMY_LEVELS,
  SKILL_CATEGORIES,
  SKILL_CREATION_MODE_LABELS,
  SKILL_CREATION_MODES,
  SKILL_IMPACT_DOMAINS,
  SKILL_LAYER_DESCRIPTIONS,
  SKILL_LAYER_LABELS,
  SKILL_LAYERS,
  SKILL_STATUS_LABELS,
  SKILL_STATUS_TONES,
  SKILL_STATUSES,
  USABLE_SKILL_STATUSES,
  validateSkillContent,
  validateSkillGovernance,
} from './skills.js';
export type {
  SkillAutonomy,
  SkillCategory,
  SkillContent,
  SkillCreationMode,
  SkillInput,
  SkillLayer,
  SkillRule,
  SkillStatus,
  SkillStep,
} from './skills.js';

// ---- Skill Router and evaluation (Prompt 18) ----
//
// Two client rules are absolute here and the code shape enforces both: the router **never**
// returns an unapproved version for production work, and when nothing applies it records a
// **Skill Candidate** for governance rather than inventing a capability. There is no path from
// Candidate to Published.
export {
  ALLOWED_CANDIDATE_TRANSITIONS,
  CANDIDATE_STATUS_LABELS,
  CANDIDATE_STATUSES,
  compareVersions,
  EVALUATION_ASSERTION_LABELS,
  EVALUATION_ASSERTIONS,
  evaluateOutput,
  mayTransitionCandidate,
  meaningfulWords,
  REGRESSION_VERDICTS,
  ROUTER_MAX_RESULTS,
  ROUTER_MIN_CONFIDENCE,
  routeSkills,
  scoreSkillForContext,
} from './skill-router.js';
export type {
  CandidateStatus,
  CaseOutcome,
  EvaluationAssertion,
  RegressionVerdict,
  RoutableSkillVersion,
  SkillMatch,
  SkillRejection,
  SkillRouterContext,
  SkillRoutingResult,
} from './skill-router.js';

// ---- Objective Builder / Form 2 (Prompt 19) ----
//
// The client's locked instruction is that Form 2 is preserved **exactly**: no source field
// dropped, renamed, merged or reordered, and the fifteen-column workflow grid kept whole. That is
// why the field list is code rather than markup — `FORM2_OBJECTIVE_FIELDS` and
// `FORM2_WORKFLOW_COLUMNS` are what the migration, the DTOs, the grid header and the validation
// all derive from, so losing a field fails a test instead of quietly shipping. The Performance &
// Reward panel is deliberately outside that list, and outside the version tables entirely.
export {
  ALLOWED_OBJECTIVE_TRANSITIONS,
  EDITABLE_OBJECTIVE_STATUSES,
  form2Field,
  FORM2_OBJECTIVE_FIELDS,
  FORM2_SECTION_LABELS,
  FORM2_SECTIONS,
  FORM2_SOURCE_FIELD_KEYS,
  FORM2_WORKFLOW_COLUMN_COUNT,
  FORM2_WORKFLOW_COLUMNS,
  FROZEN_OBJECTIVE_STATUSES,
  isObjectiveContentFrozen,
  isObjectiveDraftEditable,
  mayTransitionObjective,
  OBJECTIVE_STATUS_LABELS,
  OBJECTIVE_STATUS_TONES,
  OBJECTIVE_STATUSES,
  REWARD_TYPE_LABELS,
  REWARD_TYPES,
  STEP_APPROVAL_KINDS,
  STEP_APPROVAL_LABELS,
  STEP_ENGINE_KINDS,
  STEP_ENGINE_LABELS,
  TIME_UNIT_LABELS,
  TIME_UNITS,
  validateForm2Objective,
  validateForm2WorkflowSteps,
  validateObjectiveForSubmission,
  validateRewardPanel,
  WORKFLOW_COLUMN_GROUPS,
} from './objectives.js';
export type {
  Form2FieldDefinition,
  Form2FieldKind,
  Form2Objective,
  Form2Section,
  Form2WorkflowStep,
  ObjectiveRewardPanel,
  ObjectiveStatus,
  RewardType,
  StepApprovalKind,
  StepEngineKind,
  TimeUnit,
  WorkflowColumnDefinition,
  WorkflowColumnGroup,
} from './objectives.js';

// ---- Reward rules and awards (Prompt 19A) ----
//
// Two client rules are absolute here and the shapes enforce both. **Cash is never auto-paid:**
// `Approved` is a decision, the only exit for a cash award is `Settled`, and `settlementRouteFor`
// is what makes that a function rather than a comment. **Approved points reach performance only
// through policy:** the gate lives on the performance policy and defaults to refusing, so a
// company that has not decided has not agreed.
export {
  ALLOWED_AWARD_TRANSITIONS,
  isAwardOpen,
  isAwardTerminal,
  mayTransitionAward,
  OPEN_AWARD_STATUSES,
  REWARD_AWARD_STATUS_LABELS,
  REWARD_AWARD_STATUS_TONES,
  REWARD_AWARD_STATUSES,
  SETTLEMENT_ROUTE_LABELS,
  SETTLEMENT_ROUTES,
  settlementRouteFor,
  TERMINAL_AWARD_STATUSES,
  terminalStatusFor,
  validatePayout,
  validateRuleForAssignment,
} from './rewards.js';
export type { PayoutRequest, PayoutResult, RewardAwardStatus, SettlementRoute } from './rewards.js';

// ---- Objective review routing and strict versioning (Prompt 20) ----
//
// `isObjectiveWorkAssignable` is the single answer to the client's "employees receive no
// actionable work during review", so the To-do module, the agent runner and any later assigner
// ask one question rather than each deciding for itself. `diffObjectiveVersions` is the compare
// view's logic, shared so the screen and the server cannot disagree about what changed.
export {
  diffObjectiveVersions,
  isObjectiveWorkAssignable,
  VERSION_ORIGIN_LABELS,
  VERSION_ORIGINS,
} from './objectives.js';
export type {
  Form2FieldChange,
  ObjectiveVersionDiff,
  StepChangeKind,
  VersionOrigin,
  WorkflowStepChange,
} from './objectives.js';

// ---- Objective AI analysis (Prompt 21) ----
//
// `NODE_SHAPE_BY_KIND` is the client's locked UI rule as data: Human is a rectangle, AI is a
// diamond, and the Goal is visually distinct. Keeping it here rather than in one component's CSS
// means every renderer reads the same answer and an invariant test can assert it — a restyle
// cannot quietly make an AI node a rectangle. `ANALYSIS_SCHEMA_VERSION` is stamped into every
// stored draft and checked on read, so a draft is never mis-interpreted by a later build.
export {
  ANALYSIS_NODE_KINDS,
  ANALYSIS_RUN_STATUS_LABELS,
  ANALYSIS_RUN_STATUS_TONES,
  ANALYSIS_RUN_STATUSES,
  ANALYSIS_SCHEMA_VERSION,
  ANALYSIS_STAGE_LABELS,
  ANALYSIS_STAGES,
  analysisStageIndex,
  isAnalysisRunFinished,
  isReadableSchemaVersion,
  mayCancelAnalysis,
  NODE_SHAPE_BY_KIND,
  NODE_SHAPES,
  nodeShapeFor,
  TERMINAL_ANALYSIS_STATUSES,
  validateWorkflowDraft,
} from './objective-analysis.js';
export type {
  AiUsageEstimate,
  AnalysisEdge,
  AnalysisNode,
  AnalysisNodeKind,
  AnalysisRisk,
  AnalysisRunStatus,
  AnalysisStage,
  NodeShape,
  WorkflowDraft,
} from './objective-analysis.js';

// ---- The manager-editable workflow (Prompt 22) ----
//
// `mayConvertNode` is the client's "Human ↔ AI conversion **where allowed**", as a function: only
// work nodes convert, AI → Human is always allowed, and Human → AI needs an approved published
// Skill — otherwise the conversion would create a step nothing can perform. `PrePublishSummary`
// is computed and never stored: a stored readiness check goes stale the moment somebody edits a
// node, and a reviewer trusting a stale one is worse off than one reading none.
export {
  incompleteDodFields,
  mayConvertNode,
  READABLE_SCHEMA_VERSIONS,
  upgradeWorkflowDraft,
  WORKFLOW_EDGE_KIND_LABELS,
  WORKFLOW_EDGE_KINDS,
} from './objective-analysis.js';
export type {
  DefinitionOfDone,
  PrePublishSummary,
  ReadinessFinding,
  WorkflowEdgeKind,
} from './objective-analysis.js';

// ---- Assignments: what a published workflow becomes (Prompt 23) ----
//
// One approval table, not one per module — the client's own words. `APPROVAL_REQUEST_TYPES`
// therefore carries the Approval Engine prompt's full list at the prompt that first needs a
// queue, so that prompt extends this table rather than introducing a second one.
//
// `Overdue` is not a stored task status. It is derived from the due time, because a task can be
// both waiting on somebody else and late, and one status column would lose the real state.
export {
  AI_ASSIGNMENT_STATUS_LABELS,
  AI_ASSIGNMENT_STATUSES,
  ALLOWED_APPROVAL_TRANSITIONS,
  ALLOWED_HUMAN_TASK_TRANSITIONS,
  APPROVAL_REQUEST_STATUS_LABELS,
  APPROVAL_REQUEST_STATUS_TONES,
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_TYPE_LABELS,
  APPROVAL_REQUEST_TYPES,
  ASSIGNMENT_CHECK_LABELS,
  ASSIGNMENT_CHECKS,
  EXECUTOR_EXPECTATION_KINDS,
  EXECUTOR_EXPECTATION_LABELS,
  HUMAN_TASK_STATUS_LABELS,
  HUMAN_TASK_STATUS_TONES,
  HUMAN_TASK_STATUSES,
  humanTaskDisplayStatus,
  isHumanTaskFinished,
  isHumanTaskOverdue,
  mayMoveApproval,
  mayMoveHumanTask,
  TASK_NOTE_KINDS,
  TERMINAL_HUMAN_TASK_STATUSES,
  validateTaskSubmission,
  WORK_ITEM_TYPES,
} from './assignments.js';
export type {
  AgentSetupPrefill,
  AiAssignmentStatus,
  ApprovalRequestStatus,
  ApprovalRequestType,
  AssignmentCheck,
  AssignmentRefusal,
  HumanTaskStatus,
  TaskNoteKind,
  WorkItemType,
} from './assignments.js';

// ---- Agent Builder and Engine Agent identity (Prompt 24) ----
//
// Every vocabulary here is transcribed from the approved source document — run types, missing-data
// behaviours, Engine Agent statuses, and Form 3's eight job-level field groups and seventeen
// action columns. None of it is chosen for implementation convenience, because a value the client
// never named would be a product decision made in a type file.
//
// `missingSetupFields` is the ZERO-QUESTION RULE expressed once, so the Agent Builder screen and
// the server cannot disagree about whether a question still needs asking. An empty result is the
// client's requirement met exactly: show Ready to Test / Activate and ask nothing extra.
//
// Form 3 is a **view**, never a form to fill in — the document is explicit that it "is not a blank
// form every employee must re-enter". It composes Form 2, the edited workflow node, the Skill and
// the agent's execution setup, and says which record each part came from.
export {
  AGENT_RUN_TYPE_LABELS,
  AGENT_RUN_TYPES,
  ALLOWED_ENGINE_AGENT_TRANSITIONS,
  behaviourContinuesPastBadData,
  BEHAVIOURS_THAT_CONTINUE,
  emptyAgentExecutionSetup,
  ENGINE_AGENT_STATUS_LABELS,
  ENGINE_AGENT_STATUS_TONES,
  ENGINE_AGENT_STATUSES,
  FORM3_ACTION_COLUMNS,
  FORM3_JOB_LEVEL_FIELDS,
  mayMoveEngineAgent,
  MISSING_DATA_BEHAVIOUR_LABELS,
  MISSING_DATA_BEHAVIOURS,
  missingSetupFields,
  runTypeNeedsSchedule,
  setupIsComplete,
} from './agents.js';
export type {
  AgentExecutionSetup,
  AgentRunType,
  EngineAgentStatus,
  Form3ActionColumn,
  Form3ActionRow,
  Form3JobLevelFieldKey,
  Form3View,
  MissingDataBehaviour,
  MissingSetupField,
} from './agents.js';

// ---- Engine Agent registry, memory mode and versioning (Prompt 25) ----
//
// The four memory modes are the Technical Architecture's, with its technical rule for each. Prompt
// 25 records which mode an agent declares; Prompt 33 enforces retention, visibility, deletion and
// sharing limits — so the default is `CurrentRunOnly`, the only mode that persists nothing and
// therefore cannot leak anything before the governance exists.
//
// `engineAgentActionsFor` derives the action set from the status lifecycle rather than restating
// it, so a screen cannot offer a button the service will refuse. `versionActivationNeedsApproval`
// makes the prompt's "approval before activation **where required**" concrete: reach that widens,
// or an agent several objectives depend on. A narrowing change needs no approval.
export {
  AGENT_MEMORY_MODE_LABELS,
  AGENT_MEMORY_MODE_RULES,
  AGENT_MEMORY_MODES,
  DEFAULT_AGENT_MEMORY_MODE,
  emptyEngineAgentHealth,
  ENGINE_AGENT_ACTION_LABELS,
  ENGINE_AGENT_ACTIONS,
  engineAgentActionsFor,
  memoryModePersistsBeyondRun,
  versionActivationNeedsApproval,
} from './agents.js';
export type {
  AgentMemoryMode,
  AgentVersionImpact,
  EngineAgentAction,
  EngineAgentHealth,
} from './agents.js';

// ---- Engine Agent Runs (Prompt 26) ----
//
// Thirteen states, transcribed from the architecture's diagram and made total. The four
// "Blocked by" variants stay four separate states rather than one with a reason code, because
// they are resolved by four different people — `BLOCK_OWNER` records who.
//
// Two transition rules the tests pin: `Queued` cannot reach `Running` without passing through
// `Reserved`, where budget is set aside; and a terminal state leads nowhere, so a retry is a new
// run with its own idempotency key rather than a resurrection of the old one.
//
// Missed-run and overlap policies both default to `Skip`. Neither default is obvious, and the
// reasoning is on the constant: catching up every missed occurrence after an outage can flood a
// provider and spend a budget in minutes, and concurrent runs can have two agents writing the
// same output.
//
// The calendar helpers work in the company's timezone throughout, because "Monday" and "the 26th"
// mean the company's, not the server's — and holidays are stored as dates rather than instants
// for the same reason.
export {
  ALLOWED_RUN_TRANSITIONS,
  BLOCK_OWNER,
  BLOCKED_RUN_STATES,
  dateIn,
  DEFAULT_MAX_RUN_ATTEMPTS,
  DEFAULT_MISSED_RUN_POLICY,
  DEFAULT_OVERLAP_POLICY,
  DEFAULT_WORKING_DAYS,
  isRunBlocked,
  isRunFinished,
  isWorkingMoment,
  mayCancelRun,
  mayMoveRun,
  mayRetryRun,
  MISSED_RUN_POLICIES,
  MISSED_RUN_POLICY_LABELS,
  nextWorkingMoment,
  overlapDecision,
  OVERLAP_POLICIES,
  OVERLAP_POLICY_LABELS,
  RETRYABILITY,
  retryDelayMs,
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
  RUN_STATES,
  RUN_TRIGGER_LABELS,
  RUN_TRIGGERS,
  runIdempotencyKey,
  TERMINAL_RUN_STATES,
  weekdayIn,
  WEEKDAYS,
} from './runs.js';
export type {
  BlockedRunState,
  BusinessCalendar,
  MissedRunPolicy,
  OverlapPolicy,
  Retryability,
  RunProgressEvent,
  RunState,
  RunTrigger,
  Weekday,
} from './runs.js';

// ---- The Executor Agent and Exception Center (Prompt 27) ----
//
// Ten exception types, each with the source document's default owner, transcribed. Two look alike
// and stay separate: `ValidationFailed` means the work produced the wrong thing, `MissingEvidence`
// means it produced nothing to check — different conversations with different people.
//
// The locked rule is a data structure here rather than a comment. `EXECUTOR_PERMITTED_ACTIONS`
// omits `Resolve` and `Dismiss` entirely, and `executorMayResolve` additionally refuses a retry or
// a pause on a `PermissionDenied` or `BudgetOrTokenLimit` exception — acting on those would be the
// Executor pressing on past a control that has just refused the work.
//
// `concludeValidation` is the client's validation order as a pure function: a failed deterministic
// check ends it without consulting the AI evaluator, and a configured high-risk action is
// `Deferred` rather than `Passed` until a person decides, however confidently the earlier stages
// agreed.
export {
  ALLOWED_EXCEPTION_TRANSITIONS,
  concludeValidation,
  DEFAULT_ESCALATION_HOURS,
  escalationDue,
  EXCEPTION_DEFAULT_OWNER,
  EXCEPTION_DEFAULT_SEVERITY,
  EXCEPTION_KIND_LABELS,
  EXCEPTION_KINDS,
  EXCEPTION_SEVERITIES,
  EXCEPTION_SEVERITY_TONES,
  EXCEPTION_STATE_LABELS,
  EXCEPTION_STATE_TONES,
  EXCEPTION_STATES,
  exceptionClearsItself,
  EXECUTOR_PERMITTED_ACTIONS,
  executorMayResolve,
  isExceptionClosed,
  mayMoveException,
  RESOLUTION_ACTION_LABELS,
  RESOLUTION_ACTIONS,
  resolutionsFor,
  SELF_CLEARING_EXCEPTIONS,
  TERMINAL_EXCEPTION_STATES,
  VALIDATION_STAGE_LABELS,
  VALIDATION_STAGES,
} from './executor.js';
export type {
  ExceptionKind,
  ExceptionSeverity,
  ExceptionState,
  ResolutionAction,
  ValidationOutcome,
  ValidationStage,
  ValidationStageResult,
} from './executor.js';

// ---- The Approval Engine (Prompt 28) ----
//
// One table across every domain: `APPROVAL_REQUEST_TYPES` in `assignments.js` was declared in
// full at Prompt 23 so that this prompt extends one row shape rather than adding a second
// approval table per module.
//
// **Separation of duties is not here.** `checkSeparationOfDuties` already owns it, and the
// Prompt 7 migration seeds a mandatory platform-wide `NoSelfApproval` control on `Approve` that
// applies to every module. The approval service feeds that engine the requester as
// `createdByUserId` and the decision history as `priorActorUserIds`, which is what makes both
// `NoSelfApproval` and `FourEyes` bite on an approval request without either rule being restated.
// `isAddressedTo` answers only the question the authorization engine has no opinion on: is this
// request still open, and is this person one of the people it was sent to.
//
// `APPROVAL_TYPE_MODULE` is the join between the two: an agent activation is decided by somebody
// with `agents:Approve`, not by a single blanket `approvals` grant.
export {
  AGING_BUCKET_LABELS,
  AGING_BUCKET_TONES,
  AGING_BUCKETS,
  agingBucketFor,
  APPROVAL_RISK_TONES,
  APPROVAL_RISKS,
  APPROVAL_TYPE_RISK,
  APPROVAL_DECISION_LABELS,
  APPROVAL_DECISIONS,
  APPROVAL_TYPE_MODULE,
  approvalEscalationDue,
  DECISION_RESULT,
  DEFAULT_APPROVAL_AGING_HOURS,
  decisionNeedsReason,
  decisionSettlesRequest,
  delegationCovers,
  everyApprovalTypeIsDecidable,
  FOUR_EYES_APPROVAL_KIND,
  isAddressedTo,
  MAX_DELEGATION_DAYS,
  requiredSodRule,
  routingFor,
  validateDelegation,
} from './approvals.js';
export type {
  AgingBucket,
  ApprovalDecision,
  ApprovalRisk,
  ApprovalDelegation,
  ApprovalRouting,
} from './approvals.js';

// ---- AI Provider Profiles and the Model Gateway (Prompt 29) ----
//
// The locked rule made structural: **provider names are configuration, not business object
// identity** (Technical Architecture §18). Business code names a `LogicalModelProfile` — one of
// the five §18 defines — and never a provider or a model. `PROVIDER_KINDS` exists so the platform
// can register an adapter and the Master Console can name what it configures; it must never reach
// a tenant-facing response, and a test asserts the two vocabularies are disjoint.
//
// `LOGICAL_MODEL_PROFILE_SPEC` transcribes §18's table. The machine-readable defaults beside each
// sentence are a reading of it: "conservative fallback" becomes `SameCapabilityOnly`, and
// "explicit budget/approval guardrail" becomes `NoFallback`, because a silently substituted model
// would mean the guardrail measured a call that did not happen.
export {
  acceptsNewWork,
  authTypeNeedsSecret,
  customProviderProblems,
  emptyProviderUsage,
  FALLBACK_POLICIES,
  FALLBACK_POLICY_LABELS,
  isLogicalModelProfile,
  LOGICAL_MODEL_PROFILE_SPEC,
  LOGICAL_MODEL_PROFILES,
  MAX_PROVIDER_TIMEOUT_MS,
  mayMoveLifecycle,
  MIN_PROVIDER_TIMEOUT_MS,
  modeUsesCompanyCredentials,
  PROVIDER_AUTH_TYPE_LABELS,
  PROVIDER_AUTH_TYPES,
  PROVIDER_KIND_LABELS,
  PROVIDER_KINDS,
  PROVIDER_LIFECYCLE_LABELS,
  PROVIDER_LIFECYCLE_STATES,
  PROVIDER_LIFECYCLE_TONES,
  PROVIDER_MODE_DESCRIPTIONS,
  PROVIDER_MODE_LABELS,
  PROVIDER_MODES,
  routeLogicalProfile,
  usageCostMinorUnits,
} from './providers.js';
export type {
  CustomProviderConfig,
  FallbackPolicy,
  LogicalModelProfile,
  LogicalModelProfileSpec,
  PricingVersion,
  ProviderAuthType,
  ProviderKind,
  ProviderLifecycleState,
  ProviderMode,
  ProviderTestResult,
  ProviderUsage,
  RoutingCandidate,
  RoutingOutcome,
} from './providers.js';

// ---- Tokens, credits, budgets and the reserve/settle ledger (Prompt 30) ----
//
// Section 20's flow, as code: Check -> Estimate -> Reserve -> Execute -> Provider actual usage ->
// Settle -> Release unused reserve -> Reconcile. The step carrying the weight is Reserve, and the
// document says why in its own words: an estimate is set aside "so concurrent Agents cannot
// overspend the same remaining balance".
//
// Two records rather than one. A **reservation** is mutable state (held, then settled or
// released); a **ledger entry** is immutable and append-only. Collapsing them would make "what
// has ever happened to this budget" unanswerable the moment a reservation was released. The
// ledger is the source of truth, a running balance is maintained beside it so the concurrency
// check can lock one row, and `reconcileBalance` is what proves the two still agree.
//
// `scopesToCheck` returns the levels outermost first, which is both the reporting order (a
// refusal should name the company budget rather than one agent's limit) and the lock order (two
// concurrent reservations taking the same rows in opposite orders would deadlock).
export {
  applyLedgerEntry,
  BUDGET_SCOPE_LABELS,
  BUDGET_SCOPE_ORDER,
  BUDGET_SCOPES,
  combineLevels,
  committedPercent,
  COST_THRESHOLD_LABELS,
  COST_THRESHOLD_TONES,
  COST_THRESHOLDS,
  crossedThreshold,
  decideLevel,
  DEFAULT_COST_THRESHOLD_PERCENTS,
  estimateMinor,
  LEDGER_EFFECT,
  LEDGER_ENTRY_KIND_LABELS,
  LEDGER_ENTRY_KINDS,
  mayMoveReservation,
  projectedExhaustion,
  reconcileBalance,
  remainingMinor,
  replayLedger,
  RESERVATION_EXPIRY_MINUTES,
  RESERVATION_STATE_LABELS,
  RESERVATION_STATES,
  reservationHasExpired,
  reservationIsOpen,
  scopesToCheck,
  SPEND_DECISIONS,
  thresholdsAreOrdered,
} from './cost.js';
export type {
  BudgetScope,
  CostThreshold,
  LedgerEntryKind,
  ReconciliationFinding,
  ReservationState,
  SpendCheckLevel,
  SpendCheckOutcome,
  SpendDecision,
  WalletSnapshot,
} from './cost.js';

// ---- Credit top-up, reallocation and the commercial edge cases (Prompt 31) ----
//
// UBoss_Final_1 line 1048 asks for these to be **defined** — "monthly reset, carry-forward
// policy, top-up expiry, refunds/promotional/manual adjustments, plan change mid-cycle, payment
// failure after top-up and negative-balance policy" — and states no value for any of them. So
// each is a configured policy with a documented default rather than a rule compiled into the
// product, and `DEFAULT_CREDIT_POLICY` explains why each default is the conservative reading.
//
// The one that matters most: **a purchased top-up does not expire unless somebody says it
// does.** Expiring money a customer paid for, unasked, is the one default that could not be
// defended.
//
// Credit arrives in **lots** (`CreditGrant`) rather than as a single number, because top-up
// expiry forces it: expiring "the forty thousand from March" means knowing which part of the
// allowance it was. Carry-forward and plan changes reuse the same shape.
export {
  allowanceAfterPlanChange,
  BILLING_CHOICE_LABELS,
  BILLING_CHOICES,
  carryForwardMinor,
  CARRY_FORWARD_POLICIES,
  CARRY_FORWARD_POLICY_LABELS,
  CREDIT_REQUEST_STATE_LABELS,
  CREDIT_REQUEST_STATE_TONES,
  CREDIT_REQUEST_STATES,
  creditRequestIsOpen,
  DEFAULT_CREDIT_POLICY,
  GRANT_LEDGER_KIND,
  GRANT_SOURCE_LABELS,
  GRANT_SOURCES,
  grantIsLive,
  grantsToExpire,
  liveAllowanceMinor,
  mayMoveCreditRequest,
  mayResumeAfterTopUp,
  MIN_CREDIT_REQUEST_MINOR,
  negativeBalanceBlocks,
  NEGATIVE_BALANCE_POLICIES,
  NEGATIVE_BALANCE_POLICY_LABELS,
  PLAN_CHANGE_POLICIES,
  PLAN_CHANGE_POLICY_LABELS,
  RESET_POLICIES,
  RESET_POLICY_LABELS,
  validateCreditDecision,
  validateCreditPolicy,
  validateCreditRequest,
  validateReallocation,
} from './credits.js';
export type {
  BillingChoice,
  CarryForwardPolicy,
  CreditGrant,
  CreditPolicy,
  CreditRequestState,
  GrantSource,
  NegativeBalancePolicy,
  PlanChangePolicy,
  ResetPolicy,
} from './credits.js';

// ---------------------------------------------------------------------------
// The Security Center — Prompt 32
// ---------------------------------------------------------------------------
export {
  countTone,
  DEFAULT_SECURITY_TIME_RANGE,
  everySecurityCategoryIsReachable,
  everyViewIsReachable,
  guestExpiry,
  guestTone,
  mfaCoverage,
  mfaCoverageTone,
  rangeStart,
  SECURITY_CENTER_EXPORT_ACTION,
  SECURITY_CENTER_MODULE,
  SECURITY_CENTER_READ_ACTION,
  SECURITY_CENTER_REVOKE_ACTION,
  SECURITY_CENTER_VIEW_LABELS,
  SECURITY_CENTER_VIEW_PURPOSE,
  SECURITY_CENTER_VIEW_SOURCE,
  SECURITY_CENTER_VIEWS,
  SECURITY_EVENT_CATEGORIES,
  SECURITY_EXPORT_ACTIONS,
  SECURITY_METRIC_DRILLDOWN,
  SECURITY_METRIC_LABELS,
  SECURITY_METRICS,
  SECURITY_PERMISSION_ACTIONS,
  SECURITY_TIME_RANGE_HOURS,
  SECURITY_TIME_RANGE_LABELS,
  SECURITY_TIME_RANGES,
  SSO_STATUS_LABELS,
  ssoStatus,
  supportAccessTone,
  viewHasCorrelationIds,
  type SecurityCenterSource,
  type SecurityCenterView,
  type SecurityEventCategory,
  type SecurityMetric,
  type SecurityMetricReading,
  type SecurityMetricTone,
  type SecurityTimeRange,
  type SsoStatus,
} from './security-center.js';

// ---------------------------------------------------------------------------
// Data classification — introduced at Prompt 33, owned by Prompt 35
// ---------------------------------------------------------------------------
export {
  classificationAllowed,
  classificationRank,
  DATA_CLASSIFICATION_DESCRIPTIONS,
  DATA_CLASSIFICATION_LABELS,
  DATA_CLASSIFICATIONS,
  DEFAULT_DATA_CLASSIFICATION,
  isSensitiveClassification,
  strictestClassification,
  type DataClassification,
} from './classification.js';

// ---------------------------------------------------------------------------
// Engine Agent memory — Prompt 33
// ---------------------------------------------------------------------------
export {
  decideMemoryWrite,
  DEFAULT_MEMORY_CLASSIFICATION,
  DEFAULT_MEMORY_POLICIES,
  everyModeHasACoherentDefault,
  expiredMemoryIds,
  MAX_MEMORY_RETENTION_DAYS,
  MEMORY_MODE_MAX_VISIBILITY,
  MEMORY_OFFBOARDING_BEHAVIOURS,
  MEMORY_OFFBOARDING_LABELS,
  MEMORY_VISIBILITIES,
  MEMORY_VISIBILITY_LABELS,
  memoryPolicyProblems,
  memoryReadable,
  offboardingOutcome,
  visibilityRank,
  visibilityWithinMode,
  type MemoryOffboardingBehaviour,
  type MemoryPolicy,
  type MemoryReadContext,
  type MemoryRecordScope,
  type MemoryVisibility,
  type MemoryWriteDecision,
  type MemoryWriteRequest,
  type OffboardingOutcome,
} from './memory.js';

// ---------------------------------------------------------------------------
// AI output feedback — Prompt 33
// ---------------------------------------------------------------------------
export {
  evaluationEligibility,
  FEEDBACK_GIVE_ACTION,
  FEEDBACK_PROMOTE_ACTION,
  FEEDBACK_PROMOTE_MODULE,
  FEEDBACK_RATING_DESCRIPTIONS,
  FEEDBACK_RATING_LABELS,
  FEEDBACK_RATINGS,
  FEEDBACK_TRAINING_STANCE,
  feedbackEligibility,
  feedbackProblems,
  MIN_CORRECTION_LENGTH,
  ratingIsPositive,
  ratingRequiresCorrection,
  summariseQuality,
  type EvaluationCandidacy,
  type EvaluationEligibility,
  type FeedbackEligibility,
  type FeedbackRating,
  type FeedbackRefusal,
  type FeedbackSubmission,
  type QualitySummary,
} from './feedback.js';

// ---------------------------------------------------------------------------
// Objective closure and Outcome Review — Prompt 34
// ---------------------------------------------------------------------------
export {
  CLOSED_OBJECTIVE_STATUSES,
  CLOSURE_SIGN_OFF_LABELS,
  CLOSURE_SIGN_OFF_POLICIES,
  DEFAULT_CLOSURE_SIGN_OFF_POLICY,
  decideClosure,
  isObjectiveFinished,
  MIN_OUTCOME_EXPLANATION_LENGTH,
  OUTCOME_VERDICT_DESCRIPTIONS,
  OUTCOME_VERDICT_LABELS,
  OUTCOME_VERDICTS,
  PAUSE_EFFECT,
  PAUSE_REASON_LABELS,
  PAUSE_REASONS,
  readinessForReview,
  SLA_OUTCOME_LABELS,
  SLA_OUTCOMES,
  slaOutcome,
  statusStartsNewWork,
  verdictRequiresExplanation,
  type ClosureAttempt,
  type ClosureDecision,
  type ClosureSignOffPolicy,
  type OutcomeComparison,
  type OutcomeVerdict,
  type PauseReason,
  type ReadinessForReview,
  type SlaOutcome,
} from './objective-closure.js';

// ---------------------------------------------------------------------------
// Knowledge, files and safe uploads — Prompt 35
// ---------------------------------------------------------------------------
export {
  ALLOWED_KNOWLEDGE_TRANSITIONS,
  ALLOWED_SCAN_TRANSITIONS,
  ALWAYS_REFUSED_EXTENSIONS,
  decideDeletion,
  decideEgress,
  decideKnowledgeRead,
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_EXPORT_CEILING,
  DEFAULT_EXTERNAL_EGRESS_CEILING,
  DEFAULT_FILE_CLASSIFICATION,
  DEFAULT_KNOWLEDGE_ACCESS_SCOPE,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_RETENTION_ACTION,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_UPLOAD_POLICY,
  FILE_SCAN_STATE_DESCRIPTIONS,
  FILE_SCAN_STATE_LABELS,
  FILE_SCAN_STATES,
  fileIsUsable,
  filesDueForRetention,
  KNOWLEDGE_ACCESS_SCOPE_LABELS,
  KNOWLEDGE_ACCESS_SCOPES,
  KNOWLEDGE_SOURCE_KIND_LABELS,
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_SOURCE_STATES,
  MAX_CONFIGURABLE_UPLOAD_BYTES,
  MAX_RETENTION_DAYS,
  mayMoveKnowledgeSource,
  mayMoveScan,
  onlyCleanFilesAreUsable,
  REDACTION_STANCE,
  RETENTION_ACTION_DESCRIPTIONS,
  RETENTION_ACTION_LABELS,
  RETENTION_ACTIONS,
  retentionExpiry,
  retentionProblems,
  uploadProblems,
  type DeletionDecision,
  type EgressDecision,
  type FileScanState,
  type KnowledgeAccessScope,
  type KnowledgeReadDecision,
  type KnowledgeReadRequest,
  type KnowledgeSourceKind,
  type KnowledgeSourceState,
  type RetentionAction,
  type RetentionPolicy,
  type UploadPolicy,
  type UploadRequest,
} from './knowledge.js';

// ---------------------------------------------------------------------------
// Support, authorized support sessions and system health — Prompt 36
// ---------------------------------------------------------------------------
export {
  ALLOWED_INCIDENT_TRANSITIONS,
  ALLOWED_TICKET_TRANSITIONS,
  CUSTOMER_AUTHORIZATION_STATE_LABELS,
  CUSTOMER_AUTHORIZATION_STATES,
  CUSTOMER_STATUS_STANCE,
  decideSessionStart,
  DEFAULT_NOTE_IS_INTERNAL,
  DEFAULT_SUPPORT_AUTHORIZATION_MODE,
  DEFAULT_SUPPORT_PRIORITY,
  HEALTH_COMPONENT_LABELS,
  HEALTH_COMPONENTS,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATE_LABELS,
  INCIDENT_STATES,
  INCIDENT_WORKFLOW_BOUNDARY,
  incidentIsActive,
  initialAuthorizationState,
  mayMoveIncident,
  mayMoveTicket,
  OPEN_TICKET_STATES,
  overallStatus,
  statusFromIncidents,
  SUPPORT_ACCESS_STANCE,
  SUPPORT_AUTHORIZATION_MODE_DESCRIPTIONS,
  SUPPORT_AUTHORIZATION_MODE_LABELS,
  SUPPORT_AUTHORIZATION_MODES,
  SUPPORT_PRIORITIES,
  SUPPORT_TICKET_KIND_LABELS,
  SUPPORT_TICKET_KINDS,
  SUPPORT_TICKET_STATE_LABELS,
  SUPPORT_TICKET_STATES,
  ticketIsOpen,
  worstStatus,
  type ComponentHealth,
  type CustomerAuthorizationState,
  type CustomerVisibleStatus,
  type HealthComponent,
  type IncidentSeverity,
  type IncidentState,
  type SessionStartDecision,
  type SupportAuthorizationMode,
  type SupportPriority,
  type SupportTicketKind,
  type SupportTicketState,
} from './support.js';

// ---------------------------------------------------------------------------
// Reporting and management dashboards — Prompt 37
// ---------------------------------------------------------------------------
export {
  csvCell,
  DASHBOARD_ALLOWED_KEYS,
  DASHBOARD_CONTRACT,
  DASHBOARD_SLICE_DESTINATIONS,
  DASHBOARD_SLICE_LABELS,
  DASHBOARD_SLICES,
  DEFAULT_REPORT_RANGE,
  EXPORT_FORMATS,
  MAX_REPORT_RANGE_DAYS,
  permissionsForReport,
  REPORT_EXPORT_PERMISSION,
  REPORT_KEYS,
  REPORT_RANGE_DAYS,
  REPORT_RANGE_LABELS,
  REPORT_RANGES,
  REPORT_ROW_LIMIT,
  REPORT_SCOPE_STANCE,
  reportDefinition,
  REPORTS,
  resolveWindow,
  SCOPE_DESCRIPTIONS,
  scopeIsEmpty,
  toCsv,
  type DashboardCounts,
  type DashboardSlice,
  type ExportFormat,
  type ReportDefinition,
  type ReportKey,
  type ReportRange,
  type ReportScope,
  type ReportWindow,
  type WindowResolution,
} from './reports.js';

// ---------------------------------------------------------------------------
// Portable UBoss Profile Search — Prompt 37A
// ---------------------------------------------------------------------------
export {
  decideProfileSearch,
  DEFAULT_PERFORMANCE_SHARING,
  DEFAULT_PROFILE_SEARCH_ENABLED,
  NEVER_IN_A_PORTABLE_PROFILE,
  onTimePercent,
  PERFORMANCE_SHARING_DESCRIPTIONS,
  PERFORMANCE_SHARING_LABELS,
  PERFORMANCE_SHARING_MODES,
  APPROVED_REWARD_STATES,
  PORTABLE_EMPLOYMENT_FIELDS,
  PORTABLE_PERFORMANCE_FIELDS,
  PORTABLE_PROFILE_FIELDS,
  PORTABLE_PROFILE_STANCE,
  PROFILE_SEARCH_INPUT,
  PROFILE_SEARCH_INPUT_STANCE,
  shareablePerformance,
  type PerformanceSharingMode,
  type PortableEmployment,
  type PortablePerformance,
  type PortableProfile,
  type ProfileSearchDecision,
} from './profile-search.js';

// ---------------------------------------------------------------------------
// Company exit and data portability — Prompt 38
// ---------------------------------------------------------------------------
export {
  ALLOWED_EXIT_TRANSITIONS,
  confirmationIsCorrect,
  decideCancellation,
  DEFAULT_READ_ONLY_DAYS,
  DEFAULT_RETENTION_DAYS,
  deletionConfirmationFor,
  DESTRUCTIVE_CONFIRMATION_STANCE,
  DETACH_BEFORE_DELETE,
  DISPOSITION_DESCRIPTIONS,
  DISPOSITION_LABELS,
  DISPOSITIONS,
  dispositionOf,
  EXIT_STATE_DESCRIPTIONS,
  EXIT_STATE_LABELS,
  EXIT_STATES,
  exitIsCancellable,
  exitIsFinished,
  exitSchedule,
  EXPORT_EXCLUSIONS,
  EXPORT_SECTION_LABELS,
  EXPORT_SECTIONS,
  EXPORT_STANCE,
  MAX_EXIT_WINDOW_DAYS,
  mayMoveExit,
  TABLE_DISPOSITION,
  tablesWithDisposition,
  windowProblems,
  type CancellationDecision,
  type Disposition,
  type ExitSchedule,
  type ExitState,
  type ExportSection,
} from './company-exit.js';

// ---------------------------------------------------------------------------
// Observability, metrics, tracing and the incident workflow — Prompt 39
// ---------------------------------------------------------------------------
export {
  ALERT_RULES,
  CORRECTIVE_ACTION_STANCE,
  CORRECTIVE_ACTION_STATE_LABELS,
  CORRECTIVE_ACTION_STATES,
  CORRELATION_CHAIN,
  CORRELATION_STANCE,
  evaluateRule,
  FORBIDDEN_LOG_FIELDS,
  FORBIDDEN_METRIC_LABELS,
  LATENCY_BUCKETS_MS,
  logFieldIsForbidden,
  METRIC_CARDINALITY_STANCE,
  METRIC_KEYS,
  METRIC_KIND,
  METRIC_KINDS,
  METRIC_LABELS,
  METRIC_LABELS_ALLOWED,
  METRIC_QUESTIONS,
  metricLabelsArePermitted,
  postmortemIsRequired,
  postmortemReadiness,
  redactLogFields,
  SEVERITIES_REQUIRING_POSTMORTEM,
  TIMELINE_KIND_LABELS,
  TIMELINE_KINDS,
  TRACING_STANCE,
  type AlertEvaluation,
  type AlertRule,
  type CorrectiveActionState,
  type CorrelationStage,
  type MetricKey,
  type MetricKind,
  type PostmortemReadiness,
  type TimelineKind,
} from './observability.js';

export {
  concurrencySlotsFor,
  consumeToken,
  decideIdempotency,
  DEFAULT_LIMITS,
  fairOrder,
  FAIRNESS_STANCE,
  freshBucket,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_STANCE,
  IDEMPOTENCY_WINDOW_HOURS,
  IDEMPOTENT_METHODS,
  LIMIT_MESSAGES,
  LIMIT_SCOPE_LABELS,
  LIMIT_SCOPES,
  limitProblems,
  MAX_CONFIGURABLE_LIMIT,
  PROVIDER_BACKOFF_BASE_MS,
  PROVIDER_BACKOFF_CEILING_MS,
  providerBackoffMs,
  providerFailureIsRetryable,
  refusalFor,
  RETRYABLE_PROVIDER_REASONS,
  routeIsUnlimited,
  UNLIMITED_ROUTES,
  WAF_ASSUMPTIONS,
  type BucketState,
  type IdempotencyOutcome,
  type LimitDecision,
  type LimitRefusal,
  type LimitScope,
  type PendingJob,
  type RateLimit,
} from './rate-limits.js';

export {
  AGENT_BOUNDARY_FACTORS,
  AUTOMATION_STANCE,
  BUILD_FLOW_LABELS,
  BUILD_FLOW_STAGES,
  COLUMNS_THE_EMPLOYEE_MUST_ANSWER,
  CONDITIONAL_STAGES,
  EXPORTABLE_CONTEXT_FIELDS,
  exportLeaks,
  FORM2_PREFILL,
  formVersionIsReadable,
  IMPORT_PROBLEM_KINDS,
  IMPORT_PROBLEM_LABELS,
  IMPORT_STAGE_LABELS,
  IMPORT_STAGES,
  JOB_METHOD_CELL_MAX,
  JOB_METHOD_COLUMN_KEYS,
  JOB_METHOD_COLUMNS,
  JOB_METHOD_FORM_VERSION,
  JOB_METHOD_KEY_BY_HEADING,
  JOB_METHOD_MAX_ROWS,
  JOB_METHOD_READABLE_VERSIONS,
  looksLikeApprovalRequired,
  mayMerge,
  NEVER_IN_AN_EXPORTED_FORM,
  normaliseHeading,
  provenanceKey,
  readRow,
  stageIsRequired,
  suggestAgentGroups,
  validateFormEnvelope,
  VALUE_SOURCES,
  type AgentBoundaryFactorKey,
  type BuildFlowStage,
  type ExportableContextField,
  type ImportOutcome,
  type ImportProblem,
  type ImportProblemKind,
  type ImportStage,
  type JobMethodColumnKey,
  type JobMethodForm,
  type JobMethodFormContext,
  type JobMethodRow,
  type ValueSource,
} from './job-method.js';

export {
  ATTACHMENT_STANCE,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_CONTEXT_LABELS,
  CHAT_CONTEXT_TYPES,
  CONTEXT_PERMISSION,
  CONTEXT_STANCE,
  CONVERSATION_KIND_LABELS,
  CONVERSATION_KINDS,
  directConversationKey,
  EXCLUDED_BY_DESIGN,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CONVERSATION_TITLE,
  MAX_GROUP_PARTICIPANTS,
  MAX_MESSAGE_BODY,
  MAX_SEARCH_RESULTS,
  mentionHandles,
  mentionsOutsideConversation,
  messageProblems,
  MIN_SEARCH_TERM,
  participantProblems,
  REALTIME_STANCE,
  RESTRICTED_PREVIEW_REASON,
  restrictedPreview,
  SEARCH_STANCE,
  searchProblems,
  unreadCount,
  type ChatContextPreview,
  type ChatContextRef,
  type ChatContextType,
  type ChatMessage,
  type ConversationKind,
  type ConversationParticipant,
} from './workspace-chat.js';

export {
  AGENT_ROLES,
  BUILDER_ONLY_MODULES,
  CAPABILITIES,
  CAPABILITY_KEYS,
  CAPABILITY_TIER_DESCRIPTIONS,
  CAPABILITY_TIER_LABELS,
  CAPABILITY_TIERS,
  capabilitiesHideBuilderScreens,
  capabilityDefinition,
  capabilityRank,
  DELEGATION_STANCE,
  delegationProblems,
  expandCapabilities,
  firstUnmetPrecondition,
  NEVER_IN_AN_OPERATOR_VIEW,
  OPERATOR_GRANTS_NOTHING,
  OPERATOR_VIEW_FIELDS,
  POWER_EMPLOYEE_CAPABILITIES,
  RUN_PRECONDITIONS,
  STANDARD_EMPLOYEE_CAPABILITIES,
  visibleModulesFor,
  type AgentRoleKey,
  type CapabilityKey,
  type CapabilityTier,
  type RunPreconditionKey,
} from './operating-model.js';

export { EXCEPTION_KINDS_ADDED_SINCE, SOURCE_DOCUMENT_EXCEPTION_KINDS } from './executor.js';

export {
  BACKUP_KIND_LABELS,
  BACKUP_KIND_PURPOSE,
  BACKUP_KINDS,
  BACKUP_STATE_LABELS,
  BACKUP_STATES,
  DECISION_TREE,
  DEFAULT_RECOVERY_TARGETS,
  DEPLOYMENT_RESPONSIBILITIES,
  DRILL_CADENCE_DAYS,
  DRILL_CADENCE_RATIONALE,
  DRILL_STEPS,
  drillIsOverdue,
  environmentIsSafeForRestore,
  mayBeReliedOn,
  missingChecks,
  RECOVERY_CLAIM_STANCE,
  RECOVERY_TARGET_SETTING_KEYS,
  REDIS_STANCE,
  rpoStatus,
  SECRETS_RECOVERY_ASSUMPTIONS,
  targetForTier,
  treeNeverRestoresBlind,
  VERIFICATION_CHECKS,
  VERIFICATION_ENVIRONMENTS,
  verificationPassed,
  type BackupKind,
  type BackupState,
  type DrillStepKey,
  type RecoveryTarget,
  type VerificationCheckKey,
  type VerificationEnvironment,
  type VerificationResult,
} from './disaster-recovery.js';

// ---------------------------------------------------------------------------
// Performance and scale validation — Prompt 43
//
// The pure half of the benchmark: what is measured, what counts as a pass, and how a percentile is
// computed. The measuring needs a database and a clock and lives in `apps/api/perf`.
// ---------------------------------------------------------------------------

export {
  NOT_MEASURED_HERE,
  percentile,
  planSeqScansLargeTable,
  SCALE_CLAIM_STANCE,
  SCALE_SCENARIOS,
  scenarioFor,
  summarise,
  UNBOUNDED_TABLES,
  type ScaleScenarioKey,
  type ScenarioMeasurement,
  type ScenarioResult,
} from './scale-validation.js';

// ---------------------------------------------------------------------------
// Release flags — Prompt 44
//
// A flag makes one change safe to deploy and is deleted once that change is everywhere. The
// registry ships empty, which is the correct state; its rules are what stop it filling up.
// ---------------------------------------------------------------------------

export {
  flagIsOn,
  flagStates,
  RELEASE_FLAG_STANCE,
  RELEASE_FLAGS,
  registryProblems,
  type FlagEnvironment,
  type ReleaseFlag,
  type ReleaseFlagKey,
} from './release-flags.js';
