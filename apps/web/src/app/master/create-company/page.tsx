'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  FormField,
  PageHeader,
  ProgressStep,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import {
  ApiError,
  formatMinor,
  platformApi,
  provisioningApi,
  type CreateCompanyPrerequisites,
  type ProvisionCompanyRequest,
  type ProvisionCompanyResponse,
} from '../../../lib/api-client';
import { useMasterConsole } from '../layout';

/**
 * Create Company — the ten-step provisioning wizard.
 *
 * The steps, their order and their names are the client's, from the approved wizard table in
 * `UBoss_Final_1`: Company Identity, Initial Company Super Admin, Commercial Plan, Modules,
 * AI Mode, Skill Packs, AI Budget Policy, Security Defaults, Review & Provision, Send Secure
 * Activation Invitation.
 *
 * ## One submit, at the end
 *
 * The wizard holds all ten steps in local state and posts **once**. Provisioning is one database
 * transaction, and a step-by-step API would leave a half-provisioned company behind every time
 * somebody closed the tab at step 4 — a company with no administrator cannot be recovered
 * through the product.
 *
 * The cost is that nothing is saved until the end, so the wizard warns before a navigation that
 * would lose the work. That is the right side of the trade: losing a form is recoverable, and a
 * broken tenant is not.
 *
 * ## Step 9 shows impact, not a summary
 *
 * The client asks for a "complete impact summary before provisioning". A list of the values just
 * typed would be a summary. What step 9 shows instead is what *provisioning will do* — which
 * modules become available, what the guardrails will refuse, that an invitation will be queued
 * and no password created, and that a bootstrap Company Admin will be granted with no human
 * grantor. Those are the consequences somebody should read before clicking.
 *
 * ## Never a password, never a credential
 *
 * There is no password field on any step, and step 5 takes a *masked hint* rather than a key.
 * The API refuses a payload carrying either — `forbidNonWhitelisted` rejects fields that do not
 * exist rather than dropping them silently — so the rule is enforced by the server and not only
 * by this form's shape.
 */

const STEPS = [
  'Company Identity',
  'Initial Company Super Admin',
  'Commercial Plan',
  'Modules / Entitlements',
  'AI Mode',
  'Skill Packs',
  'AI Budget Policy',
  'Security Defaults',
  'Review & Provision',
  'Send Secure Activation Invitation',
] as const;

interface WizardState {
  legalName: string;
  displayName: string;
  code: string;
  countryRegion: string;
  timezone: string;
  currency: string;
  adminName: string;
  adminEmail: string;
  adminTitle: string;
  adminContact: string;
  planCode: string;
  seats: number;
  startDate: string;
  renewalDate: string;
  billingCycle: 'Monthly' | 'Quarterly' | 'Annual';
  commercialAllowance: number;
  extraModules: string[];
  removedModules: string[];
  aiMode: 'UBossManaged' | 'CompanyByok' | 'CustomEnterpriseProvider';
  providerCredentialHint: string;
  customProviderEndpoint: string;
  universalPackEnabled: boolean;
  industryPacks: string[];
  customSkillCapability: boolean;
  monthlyAllowance: number;
  warningPercent: number;
  approvalThreshold: number;
  hardStop: number;
  primaryDomain: string;
  requireMfa: boolean;
  requireSso: boolean;
  guestExpiryDays: number;
  supportAccessAllowed: boolean;
  supportAccessRequiresCustomerApproval: boolean;
}

function initialState(): WizardState {
  const today = new Date();
  const nextYear = new Date(today.getTime() + 365 * 86_400_000);
  return {
    legalName: '',
    displayName: '',
    code: '',
    countryRegion: 'IN',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    adminName: '',
    adminEmail: '',
    adminTitle: '',
    adminContact: '',
    planCode: '',
    seats: 10,
    startDate: today.toISOString().slice(0, 10),
    renewalDate: nextYear.toISOString().slice(0, 10),
    billingCycle: 'Annual',
    commercialAllowance: 0,
    extraModules: [],
    removedModules: [],
    aiMode: 'UBossManaged',
    providerCredentialHint: '',
    customProviderEndpoint: '',
    universalPackEnabled: true,
    industryPacks: [],
    customSkillCapability: false,
    monthlyAllowance: 0,
    warningPercent: 80,
    approvalThreshold: 0,
    hardStop: 0,
    primaryDomain: '',
    requireMfa: true,
    requireSso: false,
    guestExpiryDays: 30,
    supportAccessAllowed: true,
    supportAccessRequiresCustomerApproval: false,
  };
}

export default function MasterCreateCompanyPage() {
  const router = useRouter();
  const { can } = useMasterConsole();

  const [prerequisites, setPrerequisites] = useState<CreateCompanyPrerequisites | null>(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<WizardState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProvisionCompanyResponse | null>(null);

  /**
   * One idempotency key per wizard session, generated once.
   *
   * Not per submit — that is the whole point. A double-clicked Provision button and a retry
   * after a network wobble both carry the *same* key, so the second attempt returns the first
   * result instead of creating a second company.
   */
  const [idempotencyKey] = useState(
    () => `wizard-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );

  const mayCreate = can('create-company', 'Create');

  useEffect(() => {
    platformApi
      .createCompanyPrerequisites()
      .then((value) => {
        setPrerequisites(value);
        const defaultPlan = value.defaults.planCode;
        if (typeof defaultPlan === 'string') {
          const plan = value.plans.find((candidate) => candidate.code === defaultPlan);
          setForm((previous) => ({
            ...previous,
            planCode: defaultPlan,
            seats: plan?.seatLimit ?? previous.seats,
            currency: plan?.currency ?? previous.currency,
          }));
        }
        if (typeof value.defaults.timezone === 'string') {
          setForm((previous) => ({ ...previous, timezone: value.defaults.timezone as string }));
        }
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load the prerequisites.'),
      );
  }, []);

  const set = useCallback(<K extends keyof WizardState>(key: K, value: WizardState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  const selectedPlan = useMemo(
    () => prerequisites?.plans.find((plan) => plan.code === form.planCode) ?? null,
    [prerequisites, form.planCode],
  );

  /**
   * The modules this company will actually have.
   *
   * Computed the same way the server does — plan modules, plus extras, minus withheld — and
   * **withheld wins**, so an entitlement explicitly taken away cannot be restored by also
   * listing it as an extra. Shown on step 4 and again in the step-9 impact summary.
   */
  const effectiveModules = useMemo(() => {
    const base = selectedPlan?.entitledModules ?? [];
    return [...new Set([...base, ...form.extraModules])].filter(
      (module) => !form.removedModules.includes(module),
    );
  }, [selectedPlan, form.extraModules, form.removedModules]);

  /**
   * Per-step validation, so Continue is disabled rather than the server refusing at step 9.
   *
   * The server validates all of it again — this is a courtesy, not the enforcement — but a
   * wizard that lets somebody reach step 9 with an invalid step 1 has wasted nine screens of
   * their time.
   */
  const stepProblem = useMemo((): string | null => {
    switch (step) {
      case 0:
        if (form.legalName.trim().length < 2) return 'The legal name is required.';
        if (form.displayName.trim().length < 2) return 'The display name is required.';
        if (!/^[A-Z0-9][A-Z0-9-]{1,18}[A-Z0-9]$/.test(form.code))
          return 'The company code is 3–20 upper-case letters, digits or hyphens.';
        if (!/^[A-Z]{2}$/.test(form.countryRegion)) return 'Country is a two-letter code.';
        if (!/^[A-Z]{3}$/.test(form.currency)) return 'Currency is a three-letter code.';
        return null;
      case 1:
        if (form.adminName.trim().length < 2) return 'The administrator’s name is required.';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.adminEmail))
          return 'A valid work email is required — the activation invitation goes there.';
        return null;
      case 2:
        if (!form.planCode) return 'Choose a plan.';
        if (form.seats < 1) return 'A company needs at least one seat — its first administrator.';
        if (new Date(form.renewalDate) <= new Date(form.startDate))
          return 'The renewal date must be after the start date.';
        return null;
      case 4:
        if (form.aiMode === 'CustomEnterpriseProvider' && !form.customProviderEndpoint.trim())
          return 'A Custom Enterprise Provider needs its endpoint.';
        return null;
      case 6:
        if (form.approvalThreshold > form.hardStop)
          return 'The approval threshold cannot be above the hard stop — the approval step would be unreachable.';
        if (form.warningPercent < 1 || form.warningPercent > 100)
          return 'The warning threshold is a percentage: 1 to 100.';
        return null;
      case 7:
        if (form.guestExpiryDays < 1 || form.guestExpiryDays > 365)
          return 'A guest window must be between 1 and 365 days.';
        return null;
      default:
        return null;
    }
  }, [step, form]);

  const provision = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: ProvisionCompanyRequest = {
        legalName: form.legalName.trim(),
        displayName: form.displayName.trim(),
        code: form.code.trim(),
        countryRegion: form.countryRegion,
        timezone: form.timezone,
        currency: form.currency,
        admin: {
          name: form.adminName.trim(),
          workEmail: form.adminEmail.trim().toLowerCase(),
          ...(form.adminTitle.trim() ? { title: form.adminTitle.trim() } : {}),
          ...(form.adminContact.trim() ? { contactNumber: form.adminContact.trim() } : {}),
        },
        planCode: form.planCode,
        seats: form.seats,
        startDate: new Date(form.startDate).toISOString(),
        renewalDate: new Date(form.renewalDate).toISOString(),
        billingCycle: form.billingCycle,
        commercialAllowanceMinor: form.commercialAllowance,
        ...(form.extraModules.length ? { extraModules: form.extraModules } : {}),
        ...(form.removedModules.length ? { removedModules: form.removedModules } : {}),
        aiMode: form.aiMode,
        ...(form.providerCredentialHint.trim()
          ? { providerCredentialHint: form.providerCredentialHint.trim() }
          : {}),
        ...(form.customProviderEndpoint.trim()
          ? { customProviderEndpoint: form.customProviderEndpoint.trim() }
          : {}),
        universalPackEnabled: form.universalPackEnabled,
        ...(form.industryPacks.length ? { industryPacks: form.industryPacks } : {}),
        customSkillCapability: form.customSkillCapability,
        budget: {
          monthlyAllowanceMinor: form.monthlyAllowance,
          warningPercent: form.warningPercent,
          approvalThresholdMinor: form.approvalThreshold,
          hardStopMinor: form.hardStop,
        },
        security: {
          ...(form.primaryDomain.trim()
            ? { primaryDomain: form.primaryDomain.trim().toLowerCase() }
            : {}),
          requireMfa: form.requireMfa,
          requireSso: form.requireSso,
          guestExpiryDays: form.guestExpiryDays,
          supportAccessAllowed: form.supportAccessAllowed,
          supportAccessRequiresCustomerApproval: form.supportAccessRequiresCustomerApproval,
        },
        idempotencyKey,
      };

      setResult(await provisioningApi.provisionCompany(body));
      setStep(9);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Provisioning failed.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Warn before losing the work.
   *
   * The consequence of one-transaction provisioning: nothing is saved until step 9, so a
   * navigation away loses everything typed. A warning rather than silence, because the
   * alternative to this trade — saving each step — is a half-created tenant nobody can recover.
   */
  useEffect(() => {
    if (result || step === 0) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [result, step]);

  if (!mayCreate) {
    return (
      <>
        <PageHeader
          title="Create Company"
          description="Provision a new workspace and invite its first admin."
        />
        <Banner tone="danger">
          Creating a company needs <b>create-company:Create</b>, which Platform Owner and Platform
          Admin hold. There is no public company signup, so this is the only path — and it is
          deliberately narrow.
        </Banner>
        <Button onClick={() => router.push('/master/companies')}>Back to Companies</Button>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Create Company"
        description="Provision a new workspace and invite its first admin."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'Create Company' },
        ]}
        actions={
          <Button onClick={() => router.push('/master/companies')}>
            {result ? 'Back to Companies' : 'Cancel'}
          </Button>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <ProgressStep
        label="Provisioning steps"
        items={STEPS.map((label, index) => ({
          id: label,
          label,
          state: result ? 'done' : index < step ? 'done' : index === step ? 'running' : 'todo',
        }))}
      />

      {!prerequisites ? (
        <Card>
          <CardBody>
            <SkeletonText lines={4} />
          </CardBody>
        </Card>
      ) : result ? (
        <Card>
          <CardHeader
            title="Company provisioned"
            aside={<StatusBadge status={result.lifecycleState} tone="blue" />}
          />
          <CardBody>
            <Banner tone="ok">
              {result.name} was provisioned
              {result.replayed
                ? ' (a replay of an earlier submit — no second company was created)'
                : ''}
              . A secure activation invitation is queued for {form.adminEmail}.
            </Banner>

            <div className="uboss-kv">
              <span className="uboss-kv-key">Company code</span>
              <span className="uboss-kv-value uboss-mono">{result.code}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Workspace key</span>
              <span className="uboss-kv-value uboss-mono">{result.slug}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Administrator’s UBoss Unique ID</span>
              <span className="uboss-kv-value uboss-mono">{result.admin.ubossUniqueId}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Setup checklist</span>
              <span className="uboss-kv-value">{result.setupTaskCount} steps created</span>
            </div>

            <Banner tone="info">
              <b>{result.admin.activation}</b> UBoss never generates, displays, emails or stores a
              password — the administrator sets their own during activation, and the one-time token
              is stored only as a hash.
            </Banner>

            <Banner tone="warn">
              The invitation is <b>queued, not sent</b>: no dispatcher runs yet, because email
              delivery is the notifications module. The queued message is visible on the outbox
              view. Saying it had been sent would be the alternative.
            </Banner>

            <div className="uboss-actions">
              <Button
                variant="navy"
                onClick={() => router.push(`/master/companies/${result.tenantId}`)}
              >
                Open company detail
              </Button>
              <Button
                onClick={() => {
                  setResult(null);
                  setForm(initialState());
                  setStep(0);
                }}
              >
                Provision another
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title={`Step ${step + 1} of 10 — ${STEPS[step]}`}
              aside={stepProblem ? <StatusBadge status="Incomplete" tone="warn" /> : undefined}
            />
            <CardBody>
              {step === 0 ? (
                <>
                  <FormField label="Legal name" required>
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        value={form.legalName}
                        onChange={(event) => set('legalName', event.target.value)}
                        placeholder="e.g. MedNova Healthcare Private Limited"
                      />
                    )}
                  </FormField>
                  <FormField
                    label="Display name"
                    required
                    hint="Shown as UBOSS AI AMS | {name} in the company workspace."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        value={form.displayName}
                        onChange={(event) => set('displayName', event.target.value)}
                        placeholder="MedNova Healthcare"
                      />
                    )}
                  </FormField>
                  <FormField
                    label="Company / workspace code"
                    required
                    hint="Human-facing and unique — it appears on invoices. Upper case, 3–20 characters."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input uboss-mono"
                        value={form.code}
                        onChange={(event) => set('code', event.target.value.toUpperCase())}
                        placeholder="MEDNOVA"
                      />
                    )}
                  </FormField>
                  <FormField label="Country / region" required hint="ISO 3166-1 alpha-2, e.g. IN.">
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input uboss-mono"
                        maxLength={2}
                        value={form.countryRegion}
                        onChange={(event) => set('countryRegion', event.target.value.toUpperCase())}
                      />
                    )}
                  </FormField>
                  <FormField
                    label="Business timezone"
                    required
                    hint="Every schedule and due date is computed against this — a Monday deadline means the company's Monday."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        value={form.timezone}
                        onChange={(event) => set('timezone', event.target.value)}
                        placeholder="Asia/Kolkata"
                      />
                    )}
                  </FormField>
                  <FormField label="Currency" required hint="ISO 4217, e.g. INR.">
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input uboss-mono"
                        maxLength={3}
                        value={form.currency}
                        onChange={(event) => set('currency', event.target.value.toUpperCase())}
                      />
                    )}
                  </FormField>
                  <p className="uboss-muted-3">
                    A logo is optional and is uploaded from Settings → Appearance after activation.
                    Only its metadata is stored in the database; the file lives in object storage.
                  </p>
                </>
              ) : null}

              {step === 1 ? (
                <>
                  <FormField label="Administrator name" required>
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        value={form.adminName}
                        onChange={(event) => set('adminName', event.target.value)}
                      />
                    )}
                  </FormField>
                  <FormField
                    label="Official work email"
                    required
                    hint="The activation invitation goes here and nowhere else."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="email"
                        value={form.adminEmail}
                        onChange={(event) => set('adminEmail', event.target.value)}
                      />
                    )}
                  </FormField>
                  <FormField label="Title">
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        value={form.adminTitle}
                        onChange={(event) => set('adminTitle', event.target.value)}
                        placeholder="Chief Operating Officer"
                      />
                    )}
                  </FormField>
                  <FormField label="Contact number">
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        value={form.adminContact}
                        onChange={(event) => set('adminContact', event.target.value)}
                      />
                    )}
                  </FormField>

                  <Banner tone="info">
                    This person receives an <b>activation invitation</b>, not a password. There is
                    no password field on this wizard, and the API refuses a payload containing one —
                    UBoss must never know a customer&apos;s password.
                  </Banner>
                </>
              ) : null}

              {step === 2 ? (
                <>
                  <FormField label="Plan" required>
                    {(wiring) => (
                      <select
                        {...wiring}
                        className="uboss-input"
                        value={form.planCode}
                        onChange={(event) => {
                          const plan = prerequisites.plans.find(
                            (candidate) => candidate.code === event.target.value,
                          );
                          set('planCode', event.target.value);
                          if (plan?.seatLimit) set('seats', plan.seatLimit);
                          if (plan?.currency) set('currency', plan.currency);
                        }}
                      >
                        <option value="">Choose a plan</option>
                        {prerequisites.plans.map((plan) => (
                          <option key={plan.code} value={plan.code}>
                            {plan.name} · {plan.seatLimit ?? 'custom'} seats ·{' '}
                            {plan.priceMinor === null
                              ? 'custom price'
                              : formatMinor(plan.priceMinor, plan.currency)}
                          </option>
                        ))}
                      </select>
                    )}
                  </FormField>
                  <FormField
                    label="Contracted seats"
                    required
                    hint="The ceiling. Nothing may silently exceed it."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="number"
                        min={1}
                        value={form.seats}
                        onChange={(event) => set('seats', Number(event.target.value))}
                      />
                    )}
                  </FormField>
                  <FormField label="Start date" required>
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="date"
                        value={form.startDate}
                        onChange={(event) => set('startDate', event.target.value)}
                      />
                    )}
                  </FormField>
                  <FormField label="Renewal date" required>
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="date"
                        value={form.renewalDate}
                        onChange={(event) => set('renewalDate', event.target.value)}
                      />
                    )}
                  </FormField>
                  <FormField label="Billing cycle" required>
                    {(wiring) => (
                      <select
                        {...wiring}
                        className="uboss-input"
                        value={form.billingCycle}
                        onChange={(event) =>
                          set('billingCycle', event.target.value as WizardState['billingCycle'])
                        }
                      >
                        <option value="Monthly">Monthly</option>
                        <option value="Quarterly">Quarterly</option>
                        <option value="Annual">Annual</option>
                      </select>
                    )}
                  </FormField>
                  <FormField
                    label={`Commercial AI allowance (minor units of ${form.currency})`}
                    hint="Integer minor units — money in a float becomes an invoice dispute."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="number"
                        min={0}
                        value={form.commercialAllowance}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          set('commercialAllowance', value);
                          // Step 7 starts consistent with step 3 rather than at zero: the
                          // guardrails default to the commercial term they are guarding.
                          set('monthlyAllowance', value);
                          set('approvalThreshold', value);
                          set('hardStop', Math.round(value * 1.2));
                        }}
                      />
                    )}
                  </FormField>
                </>
              ) : null}

              {step === 3 ? (
                <>
                  <Banner tone="info">
                    Entitlement is <b>not</b> authorization. This decides what the company has
                    bought; who inside it may use a module is decided separately by role, scope and
                    allowed actions.
                  </Banner>

                  {selectedPlan ? (
                    <>
                      <div className="uboss-section-label">Included in {selectedPlan.name}</div>
                      <p className="uboss-muted-3">{selectedPlan.entitledModules.join(' · ')}</p>

                      <div className="uboss-section-label">Add beyond the plan</div>
                      <div className="uboss-actions" style={{ flexWrap: 'wrap' }}>
                        {[...new Set(prerequisites.plans.flatMap((plan) => plan.entitledModules))]
                          .filter((module) => !selectedPlan.entitledModules.includes(module))
                          .map((module) => (
                            <Button
                              key={module}
                              variant={form.extraModules.includes(module) ? 'primary' : 'default'}
                              onClick={() =>
                                set(
                                  'extraModules',
                                  form.extraModules.includes(module)
                                    ? form.extraModules.filter((item) => item !== module)
                                    : [...form.extraModules, module],
                                )
                              }
                            >
                              {module}
                            </Button>
                          ))}
                      </div>

                      <div className="uboss-section-label">Withhold despite the plan</div>
                      <div className="uboss-actions" style={{ flexWrap: 'wrap' }}>
                        {selectedPlan.entitledModules.map((module) => (
                          <Button
                            key={module}
                            variant={form.removedModules.includes(module) ? 'danger' : 'default'}
                            onClick={() =>
                              set(
                                'removedModules',
                                form.removedModules.includes(module)
                                  ? form.removedModules.filter((item) => item !== module)
                                  : [...form.removedModules, module],
                              )
                            }
                          >
                            {module}
                          </Button>
                        ))}
                      </div>

                      <div className="uboss-section-label">Effective modules</div>
                      <p>{effectiveModules.join(' · ') || '—'}</p>
                      <p className="uboss-muted-3">
                        Withheld wins over added: an entitlement explicitly taken away is not
                        restored by also adding it.
                      </p>
                    </>
                  ) : (
                    <Banner tone="warn">Choose a plan on step 3 first.</Banner>
                  )}
                </>
              ) : null}

              {step === 4 ? (
                <>
                  <FormField label="AI mode" required>
                    {(wiring) => (
                      <select
                        {...wiring}
                        className="uboss-input"
                        value={form.aiMode}
                        onChange={(event) =>
                          set('aiMode', event.target.value as WizardState['aiMode'])
                        }
                      >
                        <option value="UBossManaged">UBoss Managed</option>
                        <option value="CompanyByok">Company BYOK</option>
                        <option value="CustomEnterpriseProvider">Custom Enterprise Provider</option>
                      </select>
                    )}
                  </FormField>

                  {form.aiMode === 'CompanyByok' ? (
                    <>
                      <FormField
                        label="Credential hint (display only)"
                        hint="A masked fragment such as sk-…4f2a, for recognising which key is in use."
                      >
                        {(wiring) => (
                          <input
                            {...wiring}
                            className="uboss-input uboss-mono"
                            maxLength={40}
                            value={form.providerCredentialHint}
                            onChange={(event) => set('providerCredentialHint', event.target.value)}
                            placeholder="sk-…4f2a"
                          />
                        )}
                      </FormField>
                      <Banner tone="warn">
                        <b>Do not paste a key here.</b> This field is a masked hint, capped at 40
                        characters so a real key cannot fit. The credential itself is stored later
                        through the encrypted secret box from Settings → AI Providers, by an
                        explicitly-authorised call — so a wizard payload cannot carry one even by
                        mistake.
                      </Banner>
                    </>
                  ) : null}

                  {form.aiMode === 'CustomEnterpriseProvider' ? (
                    <FormField
                      label="Provider endpoint"
                      required
                      hint="A hostname is configuration, not a secret."
                    >
                      {(wiring) => (
                        <input
                          {...wiring}
                          className="uboss-input"
                          value={form.customProviderEndpoint}
                          onChange={(event) => set('customProviderEndpoint', event.target.value)}
                          placeholder="https://models.internal.example/v1"
                        />
                      )}
                    </FormField>
                  ) : null}

                  <Banner tone="info">
                    Logical model profiles and fallback order are a <b>policy placeholder</b> at
                    this stage: the real vocabulary belongs to the model gateway, and inventing a
                    schema now would be guessing at a module that does not exist yet.
                  </Banner>
                </>
              ) : null}

              {step === 5 ? (
                <>
                  <FormField label="UBoss Universal core pack">
                    {(wiring) => (
                      <select
                        {...wiring}
                        className="uboss-input"
                        value={form.universalPackEnabled ? 'on' : 'off'}
                        onChange={(event) =>
                          set('universalPackEnabled', event.target.value === 'on')
                        }
                      >
                        <option value="on">Enabled</option>
                        <option value="off">Disabled</option>
                      </select>
                    )}
                  </FormField>
                  <FormField label="Industry packs" hint="Comma-separated codes, e.g. healthcare.">
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        value={form.industryPacks.join(', ')}
                        onChange={(event) =>
                          set(
                            'industryPacks',
                            event.target.value
                              .split(',')
                              .map((value) => value.trim().toLowerCase())
                              .filter(Boolean),
                          )
                        }
                        placeholder="healthcare"
                      />
                    )}
                  </FormField>
                  <FormField
                    label="Company custom-skill capability"
                    hint="Whether this company may author its own skills."
                  >
                    {(wiring) => (
                      <select
                        {...wiring}
                        className="uboss-input"
                        value={form.customSkillCapability ? 'on' : 'off'}
                        onChange={(event) =>
                          set('customSkillCapability', event.target.value === 'on')
                        }
                      >
                        <option value="off">Not enabled</option>
                        <option value="on">Enabled</option>
                      </select>
                    )}
                  </FormField>

                  <Banner tone="info">
                    A capability flag, not a catalogue — and explicitly <b>not</b> a Templates
                    Library, which is out of scope for this baseline.
                  </Banner>
                </>
              ) : null}

              {step === 6 ? (
                <>
                  <Banner tone="info">
                    Four ordered guardrails: <b>warn → require approval → stop</b>. Cost controls
                    must exist before any AI work starts.
                  </Banner>

                  <FormField label={`Monthly allowance (minor units of ${form.currency})`} required>
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="number"
                        min={0}
                        value={form.monthlyAllowance}
                        onChange={(event) => set('monthlyAllowance', Number(event.target.value))}
                      />
                    )}
                  </FormField>
                  <FormField label="Warning threshold (%)" required>
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="number"
                        min={1}
                        max={100}
                        value={form.warningPercent}
                        onChange={(event) => set('warningPercent', Number(event.target.value))}
                      />
                    )}
                  </FormField>
                  <FormField
                    label="Approval threshold (minor units)"
                    required
                    hint="Above this, a spend needs a human approval before it runs."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="number"
                        min={0}
                        value={form.approvalThreshold}
                        onChange={(event) => set('approvalThreshold', Number(event.target.value))}
                      />
                    )}
                  </FormField>
                  <FormField
                    label="Hard stop (minor units)"
                    required
                    hint="Above this, nothing runs."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="number"
                        min={0}
                        value={form.hardStop}
                        onChange={(event) => set('hardStop', Number(event.target.value))}
                      />
                    )}
                  </FormField>

                  <p className="uboss-muted-3">
                    Optional per-department allocations are set from Settings → Tokens &amp; Cost
                    once departments exist — a department cannot be allocated a budget before it has
                    been created.
                  </p>
                </>
              ) : null}

              {step === 7 ? (
                <>
                  <FormField
                    label="Primary domain"
                    hint="Claimed, not verified — a domain grants nothing until its DNS record is checked."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        value={form.primaryDomain}
                        onChange={(event) => set('primaryDomain', event.target.value)}
                        placeholder="mednova.example"
                      />
                    )}
                  </FormField>
                  <FormField label="Require MFA">
                    {(wiring) => (
                      <select
                        {...wiring}
                        className="uboss-input"
                        value={form.requireMfa ? 'on' : 'off'}
                        onChange={(event) => set('requireMfa', event.target.value === 'on')}
                      >
                        <option value="on">Required</option>
                        <option value="off">Not required</option>
                      </select>
                    )}
                  </FormField>
                  <FormField
                    label="Require enterprise SSO"
                    hint="Leave off until a connection is configured, or nobody can sign in."
                  >
                    {(wiring) => (
                      <select
                        {...wiring}
                        className="uboss-input"
                        value={form.requireSso ? 'on' : 'off'}
                        onChange={(event) => set('requireSso', event.target.value === 'on')}
                      >
                        <option value="off">Not required</option>
                        <option value="on">Required</option>
                      </select>
                    )}
                  </FormField>
                  <FormField
                    label="Default guest expiry (days)"
                    required
                    hint="A guest with no expiry is a permanent external account."
                  >
                    {(wiring) => (
                      <input
                        {...wiring}
                        className="uboss-input"
                        type="number"
                        min={1}
                        max={365}
                        value={form.guestExpiryDays}
                        onChange={(event) => set('guestExpiryDays', Number(event.target.value))}
                      />
                    )}
                  </FormField>
                  <FormField label="Platform support access">
                    {(wiring) => (
                      <select
                        {...wiring}
                        className="uboss-input"
                        value={form.supportAccessAllowed ? 'on' : 'off'}
                        onChange={(event) =>
                          set('supportAccessAllowed', event.target.value === 'on')
                        }
                      >
                        <option value="on">Allowed, subject to break-glass approval</option>
                        <option value="off">Refused entirely</option>
                      </select>
                    )}
                  </FormField>
                  <FormField label="Support access needs this company’s approval too">
                    {(wiring) => (
                      <select
                        {...wiring}
                        className="uboss-input"
                        value={form.supportAccessRequiresCustomerApproval ? 'on' : 'off'}
                        onChange={(event) =>
                          set('supportAccessRequiresCustomerApproval', event.target.value === 'on')
                        }
                      >
                        <option value="off">No — platform four-eyes approval is enough</option>
                        <option value="on">Yes — also require customer approval</option>
                      </select>
                    )}
                  </FormField>
                </>
              ) : null}

              {step === 8 ? (
                <>
                  <div className="uboss-section-label">What provisioning will do</div>
                  <DataTable
                    caption="Impact summary"
                    columns={[
                      { key: 'what', header: 'What', render: (row) => row.what },
                      { key: 'effect', header: 'Effect', render: (row) => row.effect },
                    ]}
                    rows={[
                      {
                        what: 'Company',
                        effect: `${form.displayName} (${form.code}) created in state Provisioning · ${form.countryRegion} · ${form.timezone} · ${form.currency}.`,
                      },
                      {
                        what: 'Commercial',
                        effect: `${selectedPlan?.name ?? form.planCode}, ${form.seats} contracted seats, ${form.billingCycle.toLowerCase()} billing, renewing ${form.renewalDate}.`,
                      },
                      {
                        what: 'Modules available',
                        effect: effectiveModules.join(', ') || 'none',
                      },
                      {
                        what: 'AI',
                        effect: `${
                          form.aiMode === 'UBossManaged'
                            ? 'UBoss Managed'
                            : form.aiMode === 'CompanyByok'
                              ? 'Company BYOK'
                              : 'Custom Enterprise Provider'
                        }; universal pack ${form.universalPackEnabled ? 'on' : 'off'}${
                          form.industryPacks.length
                            ? `; industry packs: ${form.industryPacks.join(', ')}`
                            : ''
                        }.`,
                      },
                      {
                        what: 'Budget guardrails',
                        effect: `Warn at ${form.warningPercent}%; approval needed above ${formatMinor(form.approvalThreshold, form.currency)}; nothing runs above ${formatMinor(form.hardStop, form.currency)}.`,
                      },
                      {
                        what: 'Security',
                        effect: `MFA ${form.requireMfa ? 'required' : 'not required'}; SSO ${form.requireSso ? 'required' : 'not required'}; guests expire after ${form.guestExpiryDays} days; support access ${form.supportAccessAllowed ? 'allowed subject to break-glass' : 'refused entirely'}.`,
                      },
                      {
                        what: 'Authority',
                        effect: `${form.adminName} becomes Company Admin at whole-company scope. This grant has no human grantor — provisioning creates it, marks it as a bootstrap grant, and audits it into the company's own trail.`,
                      },
                      {
                        what: 'Activation',
                        effect: `A secure invitation is queued for ${form.adminEmail}. No password is generated, displayed, emailed or stored.`,
                      },
                      {
                        what: 'Setup',
                        effect:
                          'A ten-step first-login checklist is created for the administrator.',
                      },
                    ]}
                    rowKey={(row) => row.what}
                  />

                  <Banner tone="warn">
                    Provisioning is <b>one transaction</b>: everything above commits together or
                    nothing does. It is also idempotent for this wizard session, so a double-click
                    cannot create two companies.
                  </Banner>
                </>
              ) : null}

              {stepProblem ? <Banner tone="warn">{stepProblem}</Banner> : null}
            </CardBody>
          </Card>

          <div className="uboss-actions">
            <Button disabled={step === 0 || busy} onClick={() => setStep((value) => value - 1)}>
              Back
            </Button>
            {step < 8 ? (
              <Button
                variant="navy"
                disabled={stepProblem !== null || busy}
                onClick={() => setStep((value) => value + 1)}
              >
                Continue
              </Button>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => void provision()}>
                {busy ? 'Provisioning…' : 'Create & provision company'}
              </Button>
            )}
          </div>
        </>
      )}
    </>
  );
}
