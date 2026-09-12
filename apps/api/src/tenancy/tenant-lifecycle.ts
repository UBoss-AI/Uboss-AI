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
