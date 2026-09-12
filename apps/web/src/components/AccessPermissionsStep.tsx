'use client';

import { useCallback, useEffect, useState } from 'react';

import { Banner, Card, CardBody, StatusBadge } from '@uboss/ui';

import {
  ApiError,
  capabilitiesApi,
  type CapabilityRow,
  type CapabilityStep,
} from '../lib/api-client';

export interface AccessPermissionsStepProps {
  tenantId: string;
  /** Whose access is being set. */
  userId: string;
  /** Shown above the list, so an administrator knows who they are editing. */
  subjectLabel: string;
  onChanged?: () => void;
}

/**
 * The Access & Permissions step — Prompt 40A (CR-03) §1.
 *
 * ## A step, not a permission grid
 *
 * An administrator adding a colleague chooses *"can build agents"*, not `agent-builder:EditDraft`
 * on a grid of fourteen modules by fourteen actions. The capabilities, their grouping and their
 * help text all come from the server, so the friendly words and the real grants cannot drift apart.
 *
 * ## Three things this screen has to get right
 *
 * **A new employee starts with the two Operate capabilities and nothing else.** That is CR-03's
 * central change made visible, and `defaultForNewEmployee` says so — the client does not re-derive
 * it.
 *
 * **A capability the administrator cannot grant is disabled with its reason shown, not hidden.**
 * Hiding it would make the form look complete while quietly withholding an option, and the
 * administrator would never learn why. `whyNot` is the server's own sentence.
 *
 * **The real grants are visible behind a disclosure.** Somebody who wants to know what "can build
 * agents" actually does should not have to ask an engineer.
 *
 * ## It decides nothing
 *
 * Every checkbox is a request the server evaluates against the delegation rule — an administrator
 * cannot grant what they do not hold, or grant above their own level, and cannot change their own
 * access at all. This screen renders that verdict; it does not compute it.
 */
export function AccessPermissionsStep({
  tenantId,
  userId,
  subjectLabel,
  onChanged,
}: AccessPermissionsStepProps) {
  const [step, setStep] = useState<CapabilityStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showGrants, setShowGrants] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStep(await capabilitiesApi.step(tenantId, userId));
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Access and permissions could not be loaded.',
      );
    }
  }, [tenantId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (capability: CapabilityRow) => {
    setBusy(capability.key);
    setError(null);
    setNotice(null);
    try {
      if (capability.held) {
        await capabilitiesApi.revoke(tenantId, userId, capability.key);
        setNotice(`Removed "${capability.label}".`);
      } else {
        await capabilitiesApi.grant(tenantId, userId, [capability.key]);
        setNotice(`Granted "${capability.label}".`);
      }
      await load();
      onChanged?.();
    } catch (caught) {
      // The server's refusal, verbatim. It names the capability and says why — paraphrasing it
      // into "not allowed" would send an administrator to support.
      setError(caught instanceof ApiError ? caught.message : 'That change could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  if (step === null) {
    return (
      <Card>
        <CardBody>{error ?? 'Loading access and permissions…'}</CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <h2 className="access-step-title">Access &amp; Permissions</h2>
        <p className="access-step-subject">For {subjectLabel}</p>

        {error !== null ? <Banner tone="danger">{error}</Banner> : null}
        {notice !== null ? <Banner tone="ok">{notice}</Banner> : null}

        <p className="access-step-default" data-testid="access-default">
          A new employee starts with{' '}
          <strong>{step.defaultForNewEmployee.length} operations capabilities</strong> and nothing
          else. Objective Optimization and Agent Builder are added deliberately, by somebody who
          holds them.
        </p>

        {step.tiers.map((tier) => {
          const inTier = step.capabilities.filter((capability) => capability.tier === tier.key);
          if (inTier.length === 0) return null;

          return (
            <section key={tier.key} className="access-tier" data-testid={`access-tier-${tier.key}`}>
              <h3 className="access-tier-title">{tier.label}</h3>
              <p className="access-tier-description">{tier.description}</p>

              <ul className="access-capabilities">
                {inTier.map((capability) => (
                  <li key={capability.key} className="access-capability">
                    <label className="access-capability-label">
                      <input
                        type="checkbox"
                        checked={capability.held}
                        // Disabled *and* explained. A greyed box with no reason is the thing that
                        // generates support tickets.
                        disabled={!capability.canGrant || busy !== null}
                        onChange={() => void toggle(capability)}
                        data-testid={`capability-${capability.key}`}
                      />
                      <span className="access-capability-name">{capability.label}</span>
                      {capability.held ? <StatusBadge status="Granted" tone="success" /> : null}
                    </label>

                    <p className="access-capability-help">{capability.help}</p>

                    {capability.canGrant ? null : (
                      <p
                        className="access-capability-why"
                        data-testid={`why-not-${capability.key}`}
                      >
                        {capability.whyNot}
                      </p>
                    )}

                    <button
                      type="button"
                      className="access-capability-disclose"
                      onClick={() =>
                        setShowGrants(showGrants === capability.key ? null : capability.key)
                      }
                    >
                      {showGrants === capability.key ? 'Hide' : 'What this allows'}
                    </button>

                    {showGrants === capability.key ? (
                      <dl
                        className="access-capability-grants"
                        data-testid={`grants-${capability.key}`}
                      >
                        {Object.entries(capability.grants).map(([module, actions]) => (
                          <div key={module}>
                            <dt>{module}</dt>
                            <dd>{actions.join(', ')}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {/* The delegation rule in the server's own words, so an administrator who cannot grant
            something understands the shape of the limit rather than only hitting it. */}
        <p className="access-step-stance" data-testid="delegation-stance">
          {step.delegationStance}
        </p>
      </CardBody>
    </Card>
  );
}
