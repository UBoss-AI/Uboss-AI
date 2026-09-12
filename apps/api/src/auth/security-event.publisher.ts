import { Injectable, Logger } from '@nestjs/common';

import type {
  SecurityCategory,
  SecurityEventInput as ServiceInput,
  SecurityOutcome,
  SecuritySeverity,
} from '../audit/security-event.service.js';
import { SecurityEventService } from '../audit/security-event.service.js';

/**
 * Canonical security action keys.
 *
 * Kept as a closed set so the audit trail is queryable: a screen filtering for "sign-in
 * failures" must not have to guess at ad-hoc strings sprinkled through the code.
 */
export const SECURITY_ACTIONS = {
  invitationIssued: 'security.invitation_issued',
  invitationResent: 'security.invitation_resent',
  invitationCancelled: 'security.invitation_cancelled',
  invitationAccepted: 'security.invitation_accepted',
  invitationRejected: 'security.invitation_rejected',
  loginSucceeded: 'security.login_succeeded',
  loginFailed: 'security.login_failed',
  loginBlockedLockout: 'security.login_blocked_lockout',
  loginBlockedPolicy: 'security.login_blocked_policy',
  accountLocked: 'security.account_locked',
  logout: 'security.logout',
  logoutAllDevices: 'security.logout_all_devices',
  sessionRevoked: 'security.session_revoked',
  sessionRevokedByAdmin: 'security.session_revoked_by_admin',
  sessionExpired: 'security.session_expired',
  passwordResetRequested: 'security.password_reset_requested',
  passwordResetCompleted: 'security.password_reset_completed',
  passwordResetRejected: 'security.password_reset_rejected',
  passwordChanged: 'security.password_changed',
  newDeviceSignIn: 'security.new_device_sign_in',

  // ---- Prompt 6: enterprise identity ----
  authPolicyChanged: 'security.auth_policy_changed',
  mfaEnrolmentStarted: 'security.mfa_enrolment_started',
  mfaEnrolled: 'security.mfa_enrolled',
  mfaFactorRevoked: 'security.mfa_factor_revoked',
  mfaChallengeIssued: 'security.mfa_challenge_issued',
  mfaSucceeded: 'security.mfa_succeeded',
  mfaFailed: 'security.mfa_failed',
  mfaReplayRejected: 'security.mfa_replay_rejected',
  mfaRecoveryCodesGenerated: 'security.mfa_recovery_codes_generated',
  mfaRecoveryCodeUsed: 'security.mfa_recovery_code_used',
  ssoConnectionCreated: 'security.sso_connection_created',
  ssoConnectionUpdated: 'security.sso_connection_updated',
  ssoConnectionDeleted: 'security.sso_connection_deleted',
  ssoLoginStarted: 'security.sso_login_started',
  ssoLoginSucceeded: 'security.sso_login_succeeded',
  ssoLoginFailed: 'security.sso_login_failed',
  ssoBackchannelLogout: 'security.sso_backchannel_logout',
  ssoProviderLogoutRequested: 'security.sso_provider_logout_requested',
  domainClaimCreated: 'security.domain_claim_created',
  domainVerified: 'security.domain_verified',
  domainVerificationFailed: 'security.domain_verification_failed',
  domainClaimRemoved: 'security.domain_claim_removed',
  scimClientCreated: 'security.scim_client_created',
  scimClientRevoked: 'security.scim_client_revoked',
  scimAuthFailed: 'security.scim_auth_failed',
  scimUserProvisioned: 'security.scim_user_provisioned',
  scimUserDeprovisioned: 'security.scim_user_deprovisioned',
  scimGroupChanged: 'security.scim_group_changed',

  // ---- Prompt 7: authorization ----
  separationOfDutiesBlocked: 'security.separation_of_duties_blocked',
  permissionDenied: 'security.permission_denied',
  roleAssigned: 'security.role_assigned',
  roleRevoked: 'security.role_revoked',
  customRoleCreated: 'security.custom_role_created',
  customRoleUpdated: 'security.custom_role_updated',
  policyRuleCreated: 'security.policy_rule_created',
  policyRuleDeleted: 'security.policy_rule_deleted',
  sodPolicyCreated: 'security.sod_policy_created',
  sodPolicyDeleted: 'security.sod_policy_deleted',
  tcsionMappingLoaded: 'security.tcsion_mapping_loaded',
  tcsionMappingMissing: 'security.tcsion_mapping_missing',
  userTypeChanged: 'security.user_type_changed',

  // ---- Prompt 8: audit and security foundations ----
  breakGlassRequested: 'security.break_glass_requested',
  breakGlassIdentityVerified: 'security.break_glass_identity_verified',
  breakGlassIdentityVerificationFailed: 'security.break_glass_identity_verification_failed',
  breakGlassApproved: 'security.break_glass_approved',
  breakGlassDenied: 'security.break_glass_denied',
  breakGlassActivated: 'security.break_glass_activated',
  breakGlassUsed: 'security.break_glass_used',
  breakGlassRevoked: 'security.break_glass_revoked',
  breakGlassExpired: 'security.break_glass_expired',
  breakGlassSelfApprovalBlocked: 'security.break_glass_self_approval_blocked',
  breakGlassCustomerNotified: 'security.break_glass_customer_notified',
  breakGlassNotificationFailed: 'security.break_glass_notification_failed',
  breakGlassNotificationSuppressed: 'security.break_glass_notification_suppressed',
  auditTrailExported: 'security.audit_trail_exported',
  securityTrailExported: 'security.security_trail_exported',
  auditChainVerified: 'security.audit_chain_verified',
  auditChainBroken: 'security.audit_chain_broken',
  auditChainCheckpointSealed: 'security.audit_chain_checkpoint_sealed',
  // ---- Prompt 9: the Master Console and platform roles ----
  platformRoleGranted: 'security.platform_role_granted',
  platformRoleRevoked: 'security.platform_role_revoked',
  platformRoleSelfGrantBlocked: 'security.platform_role_self_grant_blocked',
  platformRoleDenied: 'security.platform_role_denied',
  platformLockoutPrevented: 'security.platform_lockout_prevented',
  platformSettingChanged: 'security.platform_setting_changed',
  featureFlagChanged: 'security.feature_flag_changed',

  // ---- Prompt 10: company provisioning ----
  companyProvisioned: 'security.company_provisioned',
  companyBootstrapAdminGranted: 'security.company_bootstrap_admin_granted',
  companyActivationInvitationQueued: 'security.company_activation_invitation_queued',

  // ---- Prompt 11: plans, seats and lifecycle ----
  companyLifecycleChanged: 'security.company_lifecycle_changed',
  commercialSelfDecisionBlocked: 'security.commercial_self_decision_blocked',
  seatCeilingReached: 'security.seat_ceiling_reached',

  // ---- Prompt 12 ----
  /**
   * A new permanent UBoss identity was created from an entered identifier.
   *
   * Security-relevant because it mints an identifier that will follow a real person across
   * employers, and it happened because one company's administrator typed a number that UBoss
   * has not verified and does not claim to have verified.
   */
  personIdentityCreated: 'security.person_identity_created',
  /** A reporting-manager change was refused because it would have closed a loop in the tree. */
  reportingCycleBlocked: 'security.reporting_cycle_blocked',

  // ---- Prompt 13 ----
  /** Somebody's access to a company was suspended. Reversible; nothing was deleted. */
  accountSuspended: 'security.account_suspended',
  /** A suspended account was reinstated. */
  accountReinstated: 'security.account_reinstated',
  /** Somebody was offboarded: access revoked, employment ended, history preserved. */
  accountOffboarded: 'security.account_offboarded',
  /** A guest was granted resource-specific access with a mandatory expiry. */
  guestAccessGranted: 'security.guest_access_granted',
  /**
   * A bulk operation attempted to grant something the requester does not hold.
   *
   * Its own action because a bulk import is the most attractive route to privilege escalation in
   * any admin console: one file, hundreds of rows, and nobody reads row 214.
   */
  bulkEscalationBlocked: 'security.bulk_escalation_blocked',
  /** A bulk operation was applied. The per-row outcomes are on the operation itself. */
  bulkOperationApplied: 'security.bulk_operation_applied',

  // ---- Prompt 32: the Security Center ----
  /**
   * Somebody exported evidence out of the Security Center.
   *
   * Its own action, separate from `auditTrailExported` and `securityTrailExported`, because the
   * Security Center's exports are *composed* views — a list of guests, a list of live sessions —
   * and an investigation into a leak needs to know which shape of evidence left, not only that
   * something did. It is also what makes the Data Exports view able to show its own exports.
   */
  securityCenterExported: 'security.security_center_exported',
  /**
   * A company administrator revoked somebody's session.
   *
   * Distinct from `sessionRevokedByAdmin`, which is the platform doing it. The difference matters
   * to an investigation: one is UBoss acting on a customer's tenancy and the other is the
   * customer acting on their own people, and a single action for both would make the trail unable
   * to tell them apart.
   *
   * A session belongs to a *person*, not to a company, so this signs them out of UBoss entirely —
   * including any other company they belong to. The event records how many memberships were
   * affected so that consequence is visible afterwards rather than inferred.
   */
  sessionRevokedByCompanyAdmin: 'security.session_revoked_by_company_admin',

  // ---- Prompt 35: files, knowledge and safe uploads ----
  /**
   * An upload was refused by validation.
   *
   * A security action rather than only a validation failure, because the interesting case is not
   * the person who attached a 60 MB video — it is the one attempting `invoice.exe`. Both land
   * here, and the metadata says which.
   */
  fileUploadRefused: 'security.file_upload_refused',
  /** A scanner found malware in an uploaded file. */
  fileScanFoundMalware: 'security.file_scan_found_malware',
  /** A scan did not complete, so the file is held. Nothing is known about it either way. */
  fileQuarantined: 'security.file_quarantined',
  /**
   * A file's content left UBoss to somebody's machine.
   *
   * Recorded so the Security Center's Data Exports view can show it beside the audit- and
   * security-trail exports: "what left, and who took it" is one question, not three.
   */
  fileDownloaded: 'security.file_downloaded',

  // ---- Prompt 36: support sessions ----
  /** The company authorized a support session their policy required them to authorize. */
  breakGlassCustomerAuthorized: 'security.break_glass_customer_authorized',
  /** The company declined one. Terminal for that session: support does not ask a second admin. */
  breakGlassCustomerDeclined: 'security.break_glass_customer_declined',
  /**
   * An activation was refused because the company had not authorized it.
   *
   * Its own action because this is the control working, and a control that works invisibly is one
   * nobody can show a regulator.
   */
  breakGlassCustomerAuthorizationBlocked: 'security.break_glass_customer_authorization_blocked',

  // ---- Prompt 38: company exit ----
  /** A contract end was requested. The beginning of an irreversible sequence. */
  companyExitRequested: 'security.company_exit_requested',
  /** Approved by a second person, which fixes the schedule. */
  companyExitApproved: 'security.company_exit_approved',
  /** An approval was refused because the approver raised the request. */
  companyExitSelfApprovalBlocked: 'security.company_exit_self_approval_blocked',
  /** A deletion was refused because the typed confirmation did not match the company. */
  companyExitConfirmationFailed: 'security.company_exit_confirmation_failed',
  /**
   * Company content was deleted.
   *
   * The one genuinely irreversible act in UBoss, and therefore the single most important row in
   * the security trail. The audit trail carries the manifest; this says it happened.
   */
  companyExitContentDeleted: 'security.company_exit_content_deleted',
  /** An exit was stopped before the destructive point. */
  companyExitCancelled: 'security.company_exit_cancelled',

  // ---- Prompt 40: rate limits and abuse protection ----
  /**
   * A rate limit refused a request.
   *
   * **Not recorded on every refusal.** A throttled script produces thousands of 429s a minute,
   * and writing one row each would bury the rest of the security trail under the noisiest client
   * in the product — the trail would become less useful the more it was needed. One row per
   * identity per cooldown window instead, which is enough to answer "who was throttled, when,
   * and how hard" while the metric carries the volume.
   */
  apiRateLimitTripped: 'security.api_rate_limit_tripped',
  /**
   * An idempotency key was replayed with different content.
   *
   * Worth a row precisely because it is *not* a retry. Either a client is generating keys wrongly
   * — in which case somebody's requests are being silently discarded somewhere — or somebody is
   * probing what a replay does. Neither is visible from a request count.
   */
  idempotencyKeyReused: 'security.idempotency_key_reused',
} as const;

/**
 * How each action is classified when it is written to `security_events`.
 *
 * Kept as one table rather than at 106 call sites, for two reasons. It means "which events are
 * critical" is a question with one answer in one place — the thing an alert rule is built on —
 * and it means adding a security action to the set above without classifying it is a **type
 * error**, because this record is keyed by the same union. A new action cannot slip in
 * unclassified and quietly land in whatever the default happened to be.
 *
 * Severity is editorial and worth arguing about, so here is the argument:
 *
 *   * `Critical` is reserved for the handful of things that should page somebody — deleting a
 *     separation-of-duties policy, and every break-glass step that grants or withholds.
 *   * `Warning` means a human should look at it eventually: a lockout, a replayed code, a
 *     permission grant, an SSO connection change.
 *   * A failed sign-in is `Notice`, not `Warning`. People mistype passwords all day, and
 *     making that a warning trains everyone to ignore warnings.
 *   * `mfaRecoveryCodeUsed` is `Warning` even though it succeeded, because a recovery code is
 *     the path a person takes when they have lost their factor — and also the path an attacker
 *     takes when they have stolen one.
 */
const CLASSIFICATION: Record<
  keyof typeof SECURITY_ACTIONS,
  { category: SecurityCategory; severity?: SecuritySeverity; outcome?: SecurityOutcome }
> = {
  invitationIssued: { category: 'Access' },
  invitationResent: { category: 'Access' },
  invitationCancelled: { category: 'Access', severity: 'Notice' },
  invitationAccepted: { category: 'Access' },
  invitationRejected: { category: 'Access', severity: 'Notice', outcome: 'Blocked' },
  loginSucceeded: { category: 'Login' },
  loginFailed: { category: 'Login', severity: 'Notice', outcome: 'Failed' },
  loginBlockedLockout: { category: 'Login', severity: 'Warning', outcome: 'Blocked' },
  loginBlockedPolicy: { category: 'Login', severity: 'Notice', outcome: 'Blocked' },
  accountLocked: { category: 'Risk', severity: 'Warning', outcome: 'Blocked' },
  logout: { category: 'Session' },
  logoutAllDevices: { category: 'Session', severity: 'Notice' },
  sessionRevoked: { category: 'Session' },
  sessionRevokedByAdmin: { category: 'Session', severity: 'Notice' },
  sessionExpired: { category: 'Session' },
  passwordResetRequested: { category: 'Login', severity: 'Notice' },
  passwordResetCompleted: { category: 'Login', severity: 'Notice' },
  passwordResetRejected: { category: 'Login', severity: 'Warning', outcome: 'Blocked' },
  passwordChanged: { category: 'Login', severity: 'Notice' },
  newDeviceSignIn: { category: 'Risk', severity: 'Warning' },
  authPolicyChanged: { category: 'Access', severity: 'Warning' },
  mfaEnrolmentStarted: { category: 'Login' },
  mfaEnrolled: { category: 'Login', severity: 'Notice' },
  mfaFactorRevoked: { category: 'Login', severity: 'Warning' },
  mfaChallengeIssued: { category: 'Login' },
  mfaSucceeded: { category: 'Login' },
  mfaFailed: { category: 'Login', severity: 'Notice', outcome: 'Failed' },
  mfaReplayRejected: { category: 'Risk', severity: 'Warning', outcome: 'Blocked' },
  mfaRecoveryCodesGenerated: { category: 'Login', severity: 'Notice' },
  mfaRecoveryCodeUsed: { category: 'Risk', severity: 'Warning' },
  ssoConnectionCreated: { category: 'Access', severity: 'Warning' },
  ssoConnectionUpdated: { category: 'Access', severity: 'Warning' },
  ssoConnectionDeleted: { category: 'Access', severity: 'Warning' },
  ssoLoginStarted: { category: 'Login' },
  ssoLoginSucceeded: { category: 'Login' },
  ssoLoginFailed: { category: 'Login', severity: 'Notice', outcome: 'Failed' },
  ssoBackchannelLogout: { category: 'Session' },
  ssoProviderLogoutRequested: { category: 'Session' },
  domainClaimCreated: { category: 'Access', severity: 'Notice' },
  domainVerified: { category: 'Access', severity: 'Notice' },
  domainVerificationFailed: { category: 'Access', severity: 'Notice', outcome: 'Failed' },
  domainClaimRemoved: { category: 'Access', severity: 'Notice' },
  scimClientCreated: { category: 'Access', severity: 'Warning' },
  scimClientRevoked: { category: 'Access', severity: 'Warning' },
  scimAuthFailed: { category: 'Risk', severity: 'Warning', outcome: 'Blocked' },
  scimUserProvisioned: { category: 'Access' },
  scimUserDeprovisioned: { category: 'Access', severity: 'Notice' },
  scimGroupChanged: { category: 'Access' },
  separationOfDutiesBlocked: { category: 'Risk', severity: 'Warning', outcome: 'Blocked' },
  permissionDenied: { category: 'Access', severity: 'Notice', outcome: 'Blocked' },
  roleAssigned: { category: 'Access', severity: 'Warning' },
  roleRevoked: { category: 'Access', severity: 'Warning' },
  customRoleCreated: { category: 'Access', severity: 'Warning' },
  customRoleUpdated: { category: 'Access', severity: 'Warning' },
  policyRuleCreated: { category: 'Access', severity: 'Warning' },
  policyRuleDeleted: { category: 'Access', severity: 'Warning' },
  sodPolicyCreated: { category: 'Access', severity: 'Critical' },
  sodPolicyDeleted: { category: 'Access', severity: 'Critical' },
  tcsionMappingLoaded: { category: 'Access', severity: 'Notice' },
  tcsionMappingMissing: { category: 'Access', severity: 'Warning', outcome: 'Blocked' },
  userTypeChanged: { category: 'Access', severity: 'Warning' },
  breakGlassRequested: { category: 'Support', severity: 'Critical' },
  breakGlassIdentityVerified: { category: 'Support', severity: 'Warning' },
  breakGlassIdentityVerificationFailed: {
    category: 'Support',
    severity: 'Critical',
    outcome: 'Blocked',
  },
  breakGlassApproved: { category: 'Support', severity: 'Critical' },
  breakGlassDenied: { category: 'Support', severity: 'Warning', outcome: 'Blocked' },
  breakGlassActivated: { category: 'Support', severity: 'Critical' },
  breakGlassUsed: { category: 'Support', severity: 'Critical' },
  breakGlassRevoked: { category: 'Support', severity: 'Warning' },
  breakGlassExpired: { category: 'Support', severity: 'Notice' },
  breakGlassSelfApprovalBlocked: { category: 'Support', severity: 'Critical', outcome: 'Blocked' },
  breakGlassCustomerNotified: { category: 'Support', severity: 'Notice' },
  breakGlassNotificationFailed: { category: 'Support', severity: 'Warning', outcome: 'Failed' },
  breakGlassNotificationSuppressed: { category: 'Support', severity: 'Critical' },
  auditTrailExported: { category: 'Support', severity: 'Notice' },
  securityTrailExported: { category: 'Support', severity: 'Notice' },
  auditChainVerified: { category: 'Support', severity: 'Notice' },
  auditChainBroken: { category: 'Risk', severity: 'Critical', outcome: 'Failed' },
  auditChainCheckpointSealed: { category: 'Support', severity: 'Notice' },
  platformRoleGranted: { category: 'Access', severity: 'Critical' },
  platformRoleRevoked: { category: 'Access', severity: 'Warning' },
  platformRoleSelfGrantBlocked: { category: 'Access', severity: 'Critical', outcome: 'Blocked' },
  platformRoleDenied: { category: 'Access', severity: 'Notice', outcome: 'Blocked' },
  platformLockoutPrevented: { category: 'Risk', severity: 'Critical', outcome: 'Blocked' },
  platformSettingChanged: { category: 'Access', severity: 'Critical' },
  featureFlagChanged: { category: 'Access', severity: 'Warning' },
  companyProvisioned: { category: 'Access', severity: 'Warning' },
  // Critical: the one authority in the product created with no human grantor.
  companyBootstrapAdminGranted: { category: 'Access', severity: 'Critical' },
  companyActivationInvitationQueued: { category: 'Access', severity: 'Notice' },
  // Suspending or closing a customer is a Warning, not Critical: it is a normal commercial act
  // that somebody should see, not one that should page anybody at 3am.
  companyLifecycleChanged: { category: 'Access', severity: 'Warning' },
  commercialSelfDecisionBlocked: { category: 'Access', severity: 'Critical', outcome: 'Blocked' },
  seatCeilingReached: { category: 'Access', severity: 'Notice', outcome: 'Blocked' },
  personIdentityCreated: { category: 'Access', severity: 'Notice' },
  reportingCycleBlocked: { category: 'Access', severity: 'Warning', outcome: 'Blocked' },
  accountSuspended: { category: 'Access', severity: 'Warning' },
  accountReinstated: { category: 'Access', severity: 'Notice' },
  accountOffboarded: { category: 'Access', severity: 'Warning' },
  guestAccessGranted: { category: 'Access', severity: 'Warning' },
  bulkEscalationBlocked: { category: 'Access', severity: 'Critical', outcome: 'Blocked' },
  bulkOperationApplied: { category: 'Access', severity: 'Warning' },
  // An export is the one read that leaves the building, so it is a `Warning` even though it
  // succeeded — the same reasoning the two Prompt 8 export actions already use.
  securityCenterExported: { category: 'Access', severity: 'Warning' },
  sessionRevokedByCompanyAdmin: { category: 'Session', severity: 'Warning' },
  // `Notice`, not `Warning`: most refused uploads are somebody attaching the wrong thing, and
  // making that a warning trains everyone to ignore warnings. The executable case is visible in
  // the metadata rather than by promoting the whole class.
  fileUploadRefused: { category: 'Risk', severity: 'Notice', outcome: 'Blocked' },
  // Malware in a company's own knowledge store is one of the few things worth waking somebody for.
  fileScanFoundMalware: { category: 'Risk', severity: 'Critical', outcome: 'Blocked' },
  // A scan that did not finish is a `Warning`, not `Critical`: nothing was found, and nothing was
  // cleared either. Somebody should look; nobody should be paged.
  fileQuarantined: { category: 'Risk', severity: 'Warning', outcome: 'Failed' },
  fileDownloaded: { category: 'Access', severity: 'Warning' },
  // Critical, like every other break-glass step: a customer's decision about who may see their
  // data is the highest-stakes consent in the product.
  breakGlassCustomerAuthorized: { category: 'Support', severity: 'Critical' },
  breakGlassCustomerDeclined: { category: 'Support', severity: 'Warning', outcome: 'Blocked' },
  breakGlassCustomerAuthorizationBlocked: {
    category: 'Support',
    severity: 'Critical',
    outcome: 'Blocked',
  },
  // Every step of an exit is Critical. This is the sequence that ends with a customer's data
  // gone, and an alert rule that filtered for Critical should see all of it.
  companyExitRequested: { category: 'Access', severity: 'Critical' },
  companyExitApproved: { category: 'Access', severity: 'Critical' },
  companyExitSelfApprovalBlocked: { category: 'Access', severity: 'Critical', outcome: 'Blocked' },
  companyExitConfirmationFailed: { category: 'Risk', severity: 'Warning', outcome: 'Blocked' },
  companyExitContentDeleted: { category: 'Access', severity: 'Critical' },
  companyExitCancelled: { category: 'Access', severity: 'Warning' },
  // `Notice`, not `Warning`: a rate limit refusing a request is the control working. The
  // interesting signal is volume, and volume is the metric's job — see `abuse-suspected`.
  apiRateLimitTripped: { category: 'Risk', severity: 'Notice', outcome: 'Blocked' },
  // `Warning`, because a reused key with new content means one of two requests was going to be
  // silently discarded. Blocked: neither was applied.
  idempotencyKeyReused: { category: 'Risk', severity: 'Warning', outcome: 'Blocked' },
};

/**
 * Reverse lookup, so a call site can keep passing the action *value* it always passed.
 */
const ACTION_KEY_BY_VALUE = new Map<string, keyof typeof SECURITY_ACTIONS>(
  Object.entries(SECURITY_ACTIONS).map(([key, value]) => [
    value,
    key as keyof typeof SECURITY_ACTIONS,
  ]),
);

export type SecurityAction = (typeof SECURITY_ACTIONS)[keyof typeof SECURITY_ACTIONS];

export interface SecurityEventInput {
  action: SecurityAction;
  /** Null for a failed sign-in where the account could not be identified. */
  actorUserId?: string | undefined;
  /** Set when the event belongs to one company; omitted for platform-plane identity events. */
  tenantId?: string | undefined;
  /**
   * Who the event is *about*, when that differs from who did it.
   *
   * Added at Prompt 12: creating a permanent UBoss identity is an act by an administrator on
   * behalf of a person who is not the actor, and `SecurityEvent` has carried the column and its
   * index since Prompt 8 — the façade simply never exposed it. Without this, an access review
   * asking 'what was done to this person' has to infer the answer from a resource id.
   */
  subjectUserId?: string | undefined;
  resourceType?: string;
  resourceId?: string | undefined;
  summary?: string | undefined;
  /**
   * Structured detail. **Never** a password, token, plaintext credential or full client address —
   * only coarse hints. Enforced by review and by the `redact` pass below.
   */
  metadata?: Record<string, string | number | boolean | null> | undefined;
}

/**
 * The metadata redaction pass moved to `audit/audit-event.service.ts` at Prompt 8, so that one
 * list guards both trails. It is re-exported nowhere: callers should not be reaching for it.
 */
/**
 * The façade every service already calls to record a security event.
 *
 * ## What changed at Prompt 8, and why the old reasoning was wrong
 *
 * This class used to write into `audit_events`, and its comment said a separate
 * `security_events` table "was considered and rejected" because two trails would mean two
 * things to query. That is now reversed, and the reversal is recorded rather than quietly
 * applied — ADR-045 has the full argument, and `SecurityEventService` carries the short
 * version. Briefly: the two trails want different columns, different retention and different
 * audiences, and the one thing the old reasoning got right — that an investigator should not
 * have to join them by hand — is served by the correlation id both trails carry.
 *
 * ## Why the façade survived the change
 *
 * 106 call sites across Prompts 5, 6 and 7 call `securityEvents.record({ action, ... })`, and
 * every one of them still does. Rewriting them to pass a category and a severity would have put
 * an editorial judgement — "is a failed sign-in a warning?" — at each call site, where it would
 * drift. Classification lives in `CLASSIFICATION` above instead, and the call sites keep saying
 * only what happened.
 */
@Injectable()
export class SecurityEventPublisher {
  private readonly logger = new Logger(SecurityEventPublisher.name);

  constructor(private readonly securityEvents: SecurityEventService) {}

  /**
   * Record a security event.
   *
   * Classification is derived from the action key. An action that is not in `SECURITY_ACTIONS`
   * — a caller passing a raw string — is classified `Risk`/`Warning` rather than dropped or
   * defaulted to `Info`: an unrecognised security event is more suspicious than a recognised
   * one, not less.
   */
  async record(input: SecurityEventInput): Promise<void> {
    await this.securityEvents.record(this.classify(input));
  }

  /**
   * Record inside a platform transaction the caller has already opened.
   *
   * `runAsPlatformOperation` refuses to nest inside a tenant transaction, so a service already
   * holding one cannot call `record`. This is that path, and it deliberately does **not**
   * swallow failures: the caller owns the transaction, so the caller decides.
   */
  async recordWithinCurrentScope(input: SecurityEventInput): Promise<void> {
    await this.securityEvents.appendWithinCurrentScope(this.classify(input));
  }

  /** Subscribe to suspicious activity — a new-device sign-in, a lockout, a replayed code. */
  onSuspiciousActivity(handler: (event: SecurityEventInput) => void): void {
    this.securityEvents.onSuspiciousActivity((event) => {
      handler({
        action: event.action as SecurityAction,
        actorUserId: event.actorUserId,
        tenantId: event.tenantId,
        ...(event.resourceType === undefined ? {} : { resourceType: event.resourceType }),
        resourceId: event.resourceId,
        summary: event.reason,
      });
    });
  }

  /** Record the event and notify subscribers that it warrants attention. */
  async recordSuspicious(input: SecurityEventInput): Promise<void> {
    await this.securityEvents.recordSuspicious(this.classify(input));
  }

  /**
   * Map a call site's `{ action, ... }` onto the security trail's shape.
   *
   * `summary` becomes `reason`: the existing call sites pass human-readable text explaining the
   * event, which is exactly what `reason` is for. `summary` stays in this interface because
   * renaming a field across 106 call sites would be churn with no reader benefit.
   */
  private classify(input: SecurityEventInput): ServiceInput {
    const key = ACTION_KEY_BY_VALUE.get(input.action);
    // Typed as the table's value shape rather than inferred, so the union does not lose the
    // optional `outcome` key that the literal happens not to set.
    const fallback: (typeof CLASSIFICATION)[keyof typeof CLASSIFICATION] = {
      category: 'Risk',
      severity: 'Warning',
    };
    const classification = key ? CLASSIFICATION[key] : fallback;

    if (!key) {
      this.logger.warn(
        `Security action "${input.action}" is not in SECURITY_ACTIONS. Recorded as Risk/Warning; ` +
          'add it to the closed set and to CLASSIFICATION.',
      );
    }

    return {
      action: input.action,
      category: classification.category,
      ...(classification.severity === undefined ? {} : { severity: classification.severity }),
      ...(classification.outcome === undefined ? {} : { outcome: classification.outcome }),
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      subjectUserId: input.subjectUserId,
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
      resourceId: input.resourceId,
      reason: input.summary,
      metadata: input.metadata,
    };
  }
}
