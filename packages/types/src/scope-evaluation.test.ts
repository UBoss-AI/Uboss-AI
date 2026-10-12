import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkSeparationOfDuties } from './scope-evaluation.js';

/**
 * Separation of duties, and the one hole the company asked for.
 *
 * `checkSeparationOfDuties` had no test of its own — it was exercised only through the API
 * suite, which is a long way from the rule it is enforcing. It is worth one here now, because
 * `NoSelfApproval` has gained an exemption and an exemption nobody tests is an exemption that
 * widens.
 */
describe('separation of duties', () => {
  const base = {
    action: 'Approve' as const,
    module: 'approvals',
    resource: { id: 'req-1', createdByUserId: 'asha' },
  };

  const noSelfApproval = [
    {
      action: 'Approve' as const,
      module: null,
      rule: 'NoSelfApproval' as const,
      mandatory: true,
      reason: 'You cannot approve work you raised yourself.',
    },
  ];

  it('refuses the person who raised the request', () => {
    const outcome = checkSeparationOfDuties({
      ...base,
      policies: noSelfApproval,
      actorUserId: 'asha',
    });

    assert.equal(outcome.satisfied, false);
    assert.equal(outcome.rule, 'NoSelfApproval');
  });

  it('allows anybody else', () => {
    const outcome = checkSeparationOfDuties({
      ...base,
      policies: noSelfApproval,
      actorUserId: 'rajiv',
    });

    assert.equal(outcome.satisfied, true);
  });

  it('exempts the company administrator from no-self-approval', () => {
    /*
     * Asked for explicitly: an administrator has every authority inside their own company,
     * including over work they raised. The cost was stated before it was built — one person can
     * now both raise and settle — and the audit trail is what carries it, with `selfApproved` on
     * every decision rather than only the ones somebody thought to flag.
     */
    const outcome = checkSeparationOfDuties({
      ...base,
      policies: noSelfApproval,
      actorUserId: 'asha',
      actorHoldsCompanyAdmin: true,
    });

    assert.equal(outcome.satisfied, true);
  });

  it('refuses the raiser when the flag is absent, so the default is the old behaviour', () => {
    // The exemption is opt-in. A caller that does not know about it cannot switch it on by
    // accident, which is the property that keeps this from spreading.
    const outcome = checkSeparationOfDuties({
      ...base,
      policies: noSelfApproval,
      actorUserId: 'asha',
    });

    assert.equal(outcome.satisfied, false);
  });

  it('does not exempt the administrator from four eyes', () => {
    /*
     * The two rules answer different questions. `NoSelfApproval` asks whether *this* person
     * wrote the thing; `FourEyes` asks how many distinct people must act. An administrator is
     * one of the two eyes, never both, and nothing here was asked to change that.
     */
    const fourEyes = [
      {
        action: 'Approve' as const,
        module: null,
        rule: 'FourEyes' as const,
        mandatory: true,
        reason: 'Two distinct people must act.',
      },
    ];

    const outcome = checkSeparationOfDuties({
      policies: fourEyes,
      action: 'Approve',
      module: 'approvals',
      actorUserId: 'asha',
      resource: { id: 'req-1', createdByUserId: 'asha', priorActorUserIds: ['asha'] },
      actorHoldsCompanyAdmin: true,
    });

    assert.equal(outcome.satisfied, false, 'an administrator may be one eye, not two');
  });
});
