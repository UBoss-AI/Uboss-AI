import { Banner } from '@uboss/ui';

/**
 * The acknowledgement a person ticks, in one place.
 *
 * ## Why this is a component and not two copies
 *
 * Two screens ask for it — signing in, and starting a workspace — and they ask for different
 * reasons. Sign-in is somebody your company already invited. `/start` is a stranger creating a
 * company. Two copies of the same four paragraphs would drift the first time one of them was
 * edited, and the drift would be invisible: nobody reads both dialogs on the same day.
 *
 * ## What this is not
 *
 * Not an agreement. A real one is a legal document the client supplies and a lawyer writes. What
 * belongs here is the acknowledgement and a place to put it; inventing clauses would be worse
 * than leaving a short summary visible, because an invented clause reads as though somebody
 * approved it. The last paragraph says so outright, so a reader is never left thinking this is
 * the contract.
 *
 * `context` changes one paragraph, because the two readers are not in the same position: an
 * employee is bound by an agreement their company already signed, and a founder on `/start` is
 * the person who will sign it.
 */
export function TermsSummary({ context }: { context: 'sign-in' | 'start' }) {
  return (
    <>
      <p>
        UBoss is an enterprise workforce and operations platform licensed to your company. By
        {context === 'start' ? ' starting a workspace ' : ' signing in '}
        you acknowledge that you are using it on your company&rsquo;s behalf and under its policies.
      </p>
      <p>
        <b>Acceptable use.</b> Your account is yours alone. Do not share your password, and do not
        attempt to reach data, objectives, agents or people outside the access your role grants you.
        Every action you take is recorded against your name in an audit trail your company can read.
      </p>
      <p>
        <b>AI-assisted work.</b> UBoss drafts, analyses and proposes. A draft is not a decision:
        work that commits your company is approved by a person, and you remain accountable for what
        you approve.
      </p>
      {context === 'start' ? (
        <p>
          <b>You are acting for your company.</b> Starting a workspace means confirming you are
          authorised to accept a service on its behalf, and that the domain you are about to verify
          belongs to it. A signed agreement follows and takes precedence over this summary.
        </p>
      ) : (
        <p>
          <b>Your company&rsquo;s terms govern.</b> This acknowledgement does not replace the
          agreement between your company and UBoss, or your own employment terms. Where they differ,
          they take precedence over this summary.
        </p>
      )}
      <Banner tone="info">
        {context === 'start'
          ? 'The Pilot plan is free to begin, and nothing is charged until somebody in your workspace chooses a paid plan.'
          : 'Your company administrator can tell you which policies apply to your account.'}
      </Banner>
    </>
  );
}
