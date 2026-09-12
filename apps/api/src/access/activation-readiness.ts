import type { AccountState, UserType } from '../generated/prisma/client.js';

/** What must be true before an internal employee's account may be activated. */
export interface ActivationReadiness {
  ready: boolean;
  /** Every missing prerequisite, not just the first — an administrator wants one pass. */
  missing: readonly string[];
  /** Shown on the Users & Access screen next to a pending invitation. */
  summary: string;
}

export interface ActivationSubject {
  userType: UserType;
  accountState: AccountState;
  /** Present when the person has an employment record in this company. */
  employment: { departmentId: string | null; reportingManagerUserId: string | null } | null;
  /** How many live role assignments they hold in this company. */
  roleCount: number;
  /** Whether this company has anybody at the top of its reporting tree yet. */
  companyHasReportingRoot: boolean;
}

/**
 * The client's rule: **"New Internal Employee requires department + manager + role before
 * activation."**
 *
 * A pure function, so the same answer serves three callers that must not disagree: the Users &
 * Access screen showing why an invitation is not ready, the invitation flow refusing to send one,
 * and activation itself refusing to complete.
 *
 * ## Why a gate at activation rather than only at invitation
 *
 * An invitation can be sent and then the prerequisites removed — somebody's role revoked, their
 * department archived — between the email going out and the link being clicked. Checking only at
 * invitation time would let an account activate into a company where it has no department, no
 * manager and no permissions, which is an account that can sign in and do nothing while looking
 * like a working one. Checking at both points costs one query and closes the window.
 *
 * ## Why the manager requirement has an exception
 *
 * The **first** person in a company has nobody to report to. `companyHasReportingRoot` is false
 * only then, and the requirement is waived for exactly that case — the same structural exception
 * Add Employee makes, for the same reason, and it stops applying the moment a root exists.
 *
 * ## Guests are not subject to it
 *
 * A guest has no department, no manager and no employment record **by definition** — the client's
 * rule is that guests stay outside the hierarchy. Requiring hierarchy placement before a guest
 * could activate would make guests impossible, so the gate applies to internal users only.
 */
export function activationReadiness(subject: ActivationSubject): ActivationReadiness {
  if (subject.userType === 'ExternalGuest') {
    return {
      ready: true,
      missing: [],
      summary:
        'Guest access. Guests stay outside the hierarchy, so no department, manager or company ' +
        'role is required — their access comes from resource-specific grants with an expiry.',
    };
  }

  if (subject.userType === 'PlatformUser') {
    return {
      ready: false,
      missing: ['a company membership'],
      summary:
        'A platform actor has no company role and cannot activate a workspace account. Platform ' +
        'capability comes from the platform plane.',
    };
  }

  const missing: string[] = [];

  if (!subject.employment) {
    missing.push('an employment record (department and reporting manager)');
  } else {
    if (!subject.employment.departmentId) {
      missing.push('a department');
    }
    if (!subject.employment.reportingManagerUserId && subject.companyHasReportingRoot) {
      missing.push('a reporting manager');
    }
  }

  if (subject.roleCount === 0) {
    missing.push('at least one company role');
  }

  return {
    ready: missing.length === 0,
    missing,
    summary:
      missing.length === 0
        ? 'Ready to activate: department, reporting manager and a company role are all in place.'
        : `Not ready to activate — still needs ${formatList(missing)}. An account that could ` +
          'sign in with none of these would look like it works and reach nothing.',
  };
}

function formatList(items: readonly string[]): string {
  if (items.length === 1) {
    return items[0] as string;
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
