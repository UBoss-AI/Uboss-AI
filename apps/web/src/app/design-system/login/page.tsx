'use client';

// FormField takes its control through a render prop, which guarantees label/error wiring but
// cannot cross the server-to-client boundary. Any screen using it must be a client component —
// no loss here, since real forms need state anyway. See ADR-012.
import { Button, FormField, LoginPresentation, NoPublicSignupNotice } from '@uboss/ui';

/**
 * Login presentation preview.
 *
 * The left panel carries the six locked sections. The right panel is presentation only —
 * the working sign-in, invitation activation and access-help flows are built at Prompt 5,
 * which is why the controls here are inert.
 *
 * There is deliberately NO sign-up affordance: UBoss has no public company signup. Customer
 * companies are provisioned from the Master Console, and activation only enables an identity
 * that has already been invited.
 */
export default function LoginPreviewPage() {
  return (
    <LoginPresentation>
      <h1>Welcome back</h1>
      <p className="uboss-login-card-sub">Sign in to your UBoss workspace.</p>

      <FormField label="Work email">
        {(props) => <input {...props} type="email" placeholder="you@company.com" readOnly />}
      </FormField>

      <FormField label="Password">
        {/* No default value: a password field must never carry a prefilled credential. */}
        {(props) => <input {...props} type="password" placeholder="Your password" readOnly />}
      </FormField>

      <Button variant="primary" block disabled>
        Sign In
      </Button>

      <div className="uboss-or">or</div>

      <Button block icon="shield" disabled>
        Continue with enterprise SSO
      </Button>

      <div className="uboss-auth-links">
        <span className="uboss-muted-3">Forgot password / Access help</span>
        <span className="uboss-muted-3">Activate invitation</span>
      </div>

      <NoPublicSignupNotice />
    </LoginPresentation>
  );
}
