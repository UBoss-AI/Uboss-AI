import { AccountState, TenantLifecycleState } from '../generated/prisma/enums.js';

export { AccountState, TenantLifecycleState };

/** What a lifecycle state permits inside a company workspace. */
export interface LifecycleCapability {
  /** May the workspace be opened at all? */
  readonly canAccess: boolean;
  /** May data be modified? */
  readonly canWrite: boolean;
  /** Honest, specific explanation shown when access is refused or writes are blocked. */
  readonly reason: string;
}

/**
 * Lifecycle rules for a customer company.
 *
 * Each blocked state gets its own message rather than one generic denial, because "your company
 * has not finished setup" and "your company has been suspended" need completely different
 * actions from the person reading them.
 */
export const LIFECYCLE_CAPABILITIES: Record<TenantLifecycleState, LifecycleCapability> = {
  [TenantLifecycleState.Provisioning]: {
    canAccess: false,
    canWrite: false,
    reason: 'This company is still being provisioned and cannot be opened yet.',
  },
  [TenantLifecycleState.PendingActivation]: {
    canAccess: false,
    canWrite: false,
    reason: 'This company has been provisioned but not yet activated.',
  },
  [TenantLifecycleState.Active]: {
    canAccess: true,
    canWrite: true,
    reason: 'Active.',
  },
  [TenantLifecycleState.Suspended]: {
    canAccess: false,
    canWrite: false,
    reason: 'This company is suspended. Contact your UBoss administrator.',
  },
  [TenantLifecycleState.ReadOnly]: {
    canAccess: true,
    canWrite: false,
    reason: 'This company is in read-only mode, so changes cannot be saved.',
  },
  [TenantLifecycleState.Closed]: {
    canAccess: false,
    canWrite: false,
    reason: 'This company is closed.',
  },
};

export function lifecycleCapability(state: TenantLifecycleState): LifecycleCapability {
  return LIFECYCLE_CAPABILITIES[state];
}

// ---------------------------------------------------------------------------
// Why a company is where it is
// ---------------------------------------------------------------------------

/**
 * The closed set of reasons a company's state is worth explaining in words.
 *
 * A code, never the recorded reason itself. `TenantLifecycleTransition.reason` is free text a
 * platform operator wrote, and it can contain a fraud suspicion, a legal hold or a complainant's
 * name — none of which an employee may read. The guard refuses writes on every request, so what
 * it prints is printed to everybody in the company.
 */
export const ACCESS_REASON_CODES = ['PaymentOverdue'] as const;
export type AccessReasonCode = (typeof ACCESS_REASON_CODES)[number];

export function isAccessReasonCode(value: string | null): value is AccessReasonCode {
  return value !== null && (ACCESS_REASON_CODES as readonly string[]).includes(value);
}

/**
 * What each code says to the person who hit the wall, in the product's own words.
 *
 * Written to be acted on rather than merely understood: it names the cause, says what is and is
 * not lost, and points at the one screen that fixes it. "Read-only mode" on its own is a sentence
 * somebody takes to support; this is one they can take to their administrator.
 */
const ACCESS_REASON_MESSAGES: Record<AccessReasonCode, string> = {
  PaymentOverdue:
    'This company is read-only because its subscription has not been paid. Nothing has been ' +
    'deleted and everything is still here to read. An administrator can settle it under ' +
    'Settings → Billing, and work resumes as soon as the payment goes through.',
};

/**
 * The refusal to show, given the state and whatever is recorded about why.
 *
 * Falls back to the state's own sentence whenever there is no code, the code is one this build
 * does not know, or the state is not one a code explains. A stored value that no longer validates
 * must not produce a blank or a crash: it produces the generic message, which was the behaviour
 * before any of this existed.
 */
export function refusalFor(state: TenantLifecycleState, accessReasonCode: string | null): string {
  const capability = LIFECYCLE_CAPABILITIES[state];
  if (state !== TenantLifecycleState.ReadOnly) return capability.reason;
  if (!isAccessReasonCode(accessReasonCode)) return capability.reason;
  return ACCESS_REASON_MESSAGES[accessReasonCode];
}

/**
 * HTTP methods treated as writes.
 *
 * `GET` and `HEAD` are the only ones assumed safe. Anything else — including `POST`, which is
 * often used for read-shaped queries — counts as a write, because guessing wrong in the
 * permissive direction would let a read-only company be modified.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isWriteMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

// ---------------------------------------------------------------------------
// Account state (Prompt 5) — the person's state inside one company.
// ---------------------------------------------------------------------------

/**
 * What an account state permits.
 *
 * Deliberately parallel in shape to `LifecycleCapability`, because the guard applies both and
 * takes the **more restrictive** of the two: an Active person in a ReadOnly company still cannot
 * write, and an InvitePending person in an Active company still cannot enter.
 */
export const ACCOUNT_CAPABILITIES: Record<AccountState, LifecycleCapability> = {
  NotInvited: {
    canAccess: false,
    canWrite: false,
    reason: 'Your account for this company has not been invited yet.',
  },
  InvitePending: {
    canAccess: false,
    canWrite: false,
    reason:
      'Your invitation has not been activated yet. Use the activation link sent to you, or ask ' +
      'your administrator to resend it.',
  },
  Active: { canAccess: true, canWrite: true, reason: 'Active.' },
  Suspended: {
    canAccess: false,
    canWrite: false,
    reason: 'Your access to this company is suspended. Contact your administrator.',
  },
  Offboarded: {
    canAccess: false,
    canWrite: false,
    reason: 'You no longer have access to this company.',
  },
};

export function accountCapability(state: AccountState): LifecycleCapability {
  return ACCOUNT_CAPABILITIES[state];
}

/**
 * Combine the company's state and the person's state, taking the more restrictive of each.
 *
 * The reason returned is whichever one actually blocked, so the message a person sees explains
 * the real cause rather than a generic denial.
 */
export function effectiveCapability(
  lifecycle: TenantLifecycleState,
  account: AccountState,
): LifecycleCapability {
  const companyCapability = lifecycleCapability(lifecycle);
  const personCapability = accountCapability(account);

  if (!companyCapability.canAccess) {
    return companyCapability;
  }
  if (!personCapability.canAccess) {
    return personCapability;
  }

  // Both permit access; a write is blocked if either forbids it.
  if (!companyCapability.canWrite) {
    return companyCapability;
  }
  if (!personCapability.canWrite) {
    return personCapability;
  }

  return companyCapability;
}
