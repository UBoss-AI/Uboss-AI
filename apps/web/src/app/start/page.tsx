'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { REGISTRATION_WINDOW_DAYS } from '@uboss/types';
import { Banner, Button, Icon, LoginPresentation, Modal, SkeletonText } from '@uboss/ui';

import { TermsSummary } from '../../components/TermsSummary';
import { ApiError, registrationApi, type RegistrationView } from '../../lib/api-client';

import './start.css';

/**
 * A company signing itself up — the way in that was missing.
 *
 * ## Why this screen exists
 *
 * The whole self-serve flow was built and tested on the server and nothing on any screen reached
 * it. A visitor who read the pricing page, decided on the Pilot plan and wanted to start could
 * not: every route on the marketing site ends at a demo request, and the product's sign-in screen
 * says nothing about creating a workspace. The feature was reachable only with a tool like curl.
 *
 * ## Three steps, and the screen only ever shows the one you are on
 *
 * 1. **Who you are and where you work.** Name, work email, company, domain.
 * 2. **Prove the address.** A link arrives by mail. Opening it proves the mailbox is yours, and
 *    only then does the DNS record appear — a signup that never confirmed its address never
 *    learns the token, so this cannot be used to make the product run DNS lookups for anybody.
 * 3. **Prove the domain.** Publish one TXT record. The company is created the moment it is found.
 *
 * Each step is a separate state on the server, and this screen reads that state rather than
 * remembering its own: somebody who closes the tab and comes back to the link tomorrow lands
 * exactly where they left off, because the link carries the id and the token and the server knows
 * the rest.
 *
 * ## There is no plan to choose
 *
 * The server refuses a `planCode` outright. A signup lands on Pilot, and moving to a paid plan
 * happens inside the workspace, where there is a company to bill and somebody with the authority
 * to agree to it. Asking here would be asking a stranger to pick a price.
 *
 * The website's plan cards now all lead here and carry `?plan=` with them. That is read and said
 * back, not acted on: somebody who pressed **Growth** should not arrive at a page that behaves as
 * though they pressed nothing, wonder whether the click registered, and go back to check. Naming
 * their choice and stating plainly where it gets applied is the honest version of a parameter the
 * server will not honour.
 */
function StartInner() {
  const params = useSearchParams();
  const id = params.get('id');
  /*
   * The plan the website's card carried, as a plan name rather than as a URL fragment.
   *
   * It arrives lowercase because that is how the plan codes are written, and printing it raw put
   * "You chose growth" on the first screen a buyer sees. Capitalised here and nowhere else: this
   * is the only place the value is ever shown, and the server never sees it at all.
   */
  const planParam = params.get('plan');
  const chosenPlan =
    planParam === null || planParam.trim() === ''
      ? null
      : planParam.trim().charAt(0).toUpperCase() + planParam.trim().slice(1).toLowerCase();
  const token = params.get('token');

  const [fullName, setFullName] = useState('');
  const [workEmail, setWorkEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [domain, setDomain] = useState('');

  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showTerms, setShowTerms] = useState(false);

  const [registration, setRegistration] = useState<RegistrationView | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);

  /*
   * Returning to the link: read where this got to, and confirm the address if it has not been.
   *
   * `confirm` is idempotent on the server — somebody opening the link twice, or a mail client
   * pre-fetching it, must not break the signup — so this can call it on arrival without having to
   * know whether it has already been done.
   */
  useEffect(() => {
    if (id === null || token === null) return;
    setBusy(true);
    void registrationApi
      .confirm(id, token)
      .then(setRegistration)
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'This link could not be opened. Ask for a new one.',
        ),
      )
      .finally(() => setBusy(false));
  }, [id, token]);

  const start = useCallback(() => {
    setBusy(true);
    setError(null);
    void registrationApi
      .start({
        fullName: fullName.trim(),
        workEmail: workEmail.trim(),
        companyName: companyName.trim(),
        // Typed as a domain, pasted as a URL more often than not.
        domain: domain
          .trim()
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, ''),
      })
      .then((created) => setStartedId(created.id))
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'That could not be submitted. Try again.',
        ),
      )
      .finally(() => setBusy(false));
  }, [companyName, domain, fullName, workEmail]);

  const checkDomain = useCallback(() => {
    if (id === null || token === null) return;
    setChecking(true);
    setError(null);
    void registrationApi
      .checkDomain(id, token)
      .then(setRegistration)
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'The record could not be checked just now. Try again in a moment.',
        ),
      )
      .finally(() => setChecking(false));
  }, [id, token]);

  /*
   * The same front door as signing in, with a different form in it.
   *
   * This screen used to be a narrow card centred on an empty page with a small wordmark above it:
   * correct, and nothing like the product. The two screens are the only two things a stranger
   * ever sees, they are one click apart, and a visitor who went from the website to registration
   * and then to sign-in met three different compositions on the way to one workspace.
   *
   * So registration renders inside `LoginPresentation` — the same panel, the same mind-map, the
   * same assurance strip, the same card on the right. Not a copy of it: the component, so the
   * two cannot drift. The only thing that differs is what the right column is called, which
   * matters to a screen reader and to nobody else.
   */
  const shell = (children: React.ReactNode) => (
    <LoginPresentation formLabel="Start a workspace">
      <div className="start">
        {children}
        <p className="start__foot">
          Already have a workspace? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </LoginPresentation>
  );

  // ---- Step 3 and the end: returning on the link ----
  if (id !== null && token !== null) {
    if (registration === null) {
      return shell(
        <>{error === null ? <SkeletonText lines={4} /> : <Banner tone="danger">{error}</Banner>}</>,
      );
    }

    if (registration.tenantId !== null) {
      return shell(
        <>
          <h1>{registration.companyName} is ready.</h1>
          <p className="uboss-login-card-sub">
            The workspace exists and you are its first administrator. Sign in with the address you
            registered — you will be asked to set a password the first time.
          </p>
          <Link href="/login">
            <Button variant="primary">
              Sign in to {registration.companyName}
              <Icon name="arrow" size={16} />
            </Button>
          </Link>
        </>,
      );
    }

    return shell(
      <>
        <h1>One record, and {registration.companyName} is yours.</h1>
        <p className="uboss-login-card-sub">
          Publish this TXT record on <b>{registration.domain}</b>. It proves the domain belongs to
          your company, which is what makes this workspace yours and not somebody else&rsquo;s.
        </p>

        {error === null ? null : <Banner tone="danger">{error}</Banner>}
        {registration.failureReason === null ? null : (
          <Banner tone="warn">{registration.failureReason}</Banner>
        )}

        {registration.dns === null ? (
          <Banner tone="info">
            The record appears once your email address is confirmed. Open the link we sent you.
          </Banner>
        ) : (
          <dl className="start__dns">
            <div>
              <dt>Type</dt>
              <dd>{registration.dns.recordType}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd className="uboss-mono">{registration.dns.recordName}</dd>
            </div>
            <div>
              <dt>Value</dt>
              <dd className="uboss-mono">{registration.dns.recordValue}</dd>
            </div>
          </dl>
        )}

        <Button variant="primary" onClick={checkDomain} disabled={checking}>
          {checking ? 'Looking for it…' : 'I have published it — check now'}
        </Button>

        <p className="start__note">
          {/*
              DNS is not instant and nobody should be left wondering whether they got it wrong.
              The window is the server's own constant, not a number repeated here.
            */}
          A new record can take a few minutes to reach us, and sometimes an hour. This page can be
          closed — the link in your inbox brings you back, and the signup stays open for{' '}
          {REGISTRATION_WINDOW_DAYS} days.
        </p>
      </>,
    );
  }

  // ---- Step 2: submitted, waiting on the mail ----
  if (startedId !== null) {
    return shell(
      <>
        <h1>Check {workEmail.trim()}.</h1>
        <p className="uboss-login-card-sub">
          We have sent a link to confirm the address. Opening it proves the mailbox is yours and
          brings you back here for the last step.
        </p>
        <p className="start__note">
          Nothing has been created yet, and nothing will be until the domain is proved. If the mail
          does not arrive, check that <b>{domain.trim()}</b> is the right domain for your work
          address.
        </p>
      </>,
    );
  }

  // ---- Step 1: who you are ----
  //
  // The tick is part of `ready` rather than checked at submit, so the button is visibly
  // unavailable instead of refusing after a press. Sign-in treats its own tick the same way.
  const ready =
    fullName.trim().length >= 2 &&
    companyName.trim().length >= 2 &&
    domain.trim() !== '' &&
    acceptedTerms &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workEmail.trim());

  return shell(
    <>
      <h1>Start a workspace.</h1>
      <p className="uboss-login-card-sub">
        On the Pilot plan, free to begin. You prove your work address and your company&rsquo;s
        domain, and the workspace is yours — nobody has to approve it.
      </p>

      {/*
          Said here rather than discovered later.

          Every plan card on the website leads to this screen, so somebody who chose Growth is
          about to get a Pilot workspace. Letting them find that out afterwards would be a bait,
          and dropping their choice silently would make them think the button missed.
        */}
      {chosenPlan !== null && chosenPlan.toLowerCase() !== 'pilot' && (
        <Banner tone="info">
          You chose <b>{chosenPlan}</b>. Every workspace opens on Pilot while your domain is
          verified — once you are in, an admin moves to {chosenPlan} under Settings, and nothing is
          charged before that.
        </Banner>
      )}

      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      <form
        className="start__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) start();
        }}
      >
        <label className="uboss-field">
          <span className="uboss-field-label">Your name *</span>
          <input
            className="uboss-input"
            value={fullName}
            autoComplete="name"
            onChange={(event) => setFullName(event.target.value)}
          />
        </label>

        <label className="uboss-field">
          <span className="uboss-field-label">Work email *</span>
          <input
            className="uboss-input"
            type="email"
            value={workEmail}
            placeholder="you@company.com"
            autoComplete="email"
            onChange={(event) => setWorkEmail(event.target.value)}
          />
          <span className="uboss-field-hint">
            Your company&rsquo;s own address. A free mailbox cannot prove which company it speaks
            for, so those are refused.
          </span>
        </label>

        <label className="uboss-field">
          <span className="uboss-field-label">Company name *</span>
          <input
            className="uboss-input"
            value={companyName}
            autoComplete="organization"
            onChange={(event) => setCompanyName(event.target.value)}
          />
        </label>

        <label className="uboss-field">
          <span className="uboss-field-label">Company domain *</span>
          <input
            className="uboss-input"
            value={domain}
            placeholder="company.com"
            onChange={(event) => setDomain(event.target.value)}
          />
          <span className="uboss-field-hint">
            You will publish one TXT record on it at the last step.
          </span>
        </label>

        {/*
            The acknowledgement, on the screen that creates a company.

            Sign-in has carried this tick since it shipped, and the one place a *stranger* brings
            a company into existence had none at all — the person with the most to agree to was
            asked for the least. The dialog opens over the form so that reading it does not
            discard four typed fields.
          */}
        <label className="uboss-consent">
          <input
            type="checkbox"
            checked={acceptedTerms}
            onChange={(event) => setAcceptedTerms(event.target.checked)}
          />
          <span>
            I am authorised to start a workspace for this company, and I accept the{' '}
            <button type="button" className="uboss-link" onClick={() => setShowTerms(true)}>
              Terms &amp; Conditions
            </button>
            .
          </span>
        </label>

        <Button
          type="submit"
          variant="primary"
          disabled={busy || !ready}
          title={
            ready ? undefined : 'Fill in all four, with a work email address, and accept the terms.'
          }
        >
          {busy ? 'Sending…' : 'Send me the link'}
          <Icon name="arrow" size={16} />
        </Button>
      </form>

      <Modal open={showTerms} onClose={() => setShowTerms(false)} title="Terms &amp; Conditions">
        <TermsSummary context="start" />
        <div className="uboss-actions" style={{ marginTop: 14 }}>
          <Button
            variant="primary"
            onClick={() => {
              setAcceptedTerms(true);
              setShowTerms(false);
            }}
          >
            I agree
          </Button>
          <Button onClick={() => setShowTerms(false)}>Close</Button>
        </div>
      </Modal>
    </>,
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function StartPage() {
  return (
    <Suspense fallback={null}>
      <StartInner />
    </Suspense>
  );
}
