import { Global, Module } from '@nestjs/common';

import { AUTH_CONFIG, loadAuthConfig } from './auth.config.js';
import { AuthController } from './auth.controller.js';
import { AuthenticationPolicyService } from './authentication-policy.service.js';
import {
  DNS_TXT_RESOLVER,
  DomainVerificationService,
  NodeDnsTxtResolver,
} from './domain-verification.service.js';
import { EnterpriseIdentityController } from './enterprise-identity.controller.js';
import { InvitationController } from './invitation.controller.js';
import { InvitationService } from './invitation.service.js';
import { LoginService } from './login.service.js';
import { MfaLoginService } from './mfa-login.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
import { ScimController } from './scim/scim.controller.js';
import { ScimService } from './scim/scim.service.js';
import { keyProviderFromEnv, SecretBox } from './secret-box.js';
import { SecurityEventPublisher } from './security-event.publisher.js';
// CompositeActorResolver is intentionally absent from the providers below: TenancyModule
// constructs it directly, because its fallback resolver is optional and conditional.
import { SessionActorResolver } from './session-actor.resolver.js';
import { SessionService } from './session.service.js';
import { OidcProvider } from './sso/oidc.provider.js';
import { SamlProvider } from './sso/saml.provider.js';
import { SsoService } from './sso/sso.service.js';

/**
 * Authentication, session management and enterprise identity.
 *
 * Global because `TenancyModule` needs `SessionActorResolver` and `SecurityEventPublisher` to
 * build the application's `ActorResolver`, and because `AuthConfig` is read in several services.
 *
 * `AuthConfig` is provided as a value rather than read from `process.env` at each use site, so
 * a misconfigured value fails once at startup instead of intermittently at request time. The
 * same applies to `SecretBox`: its factory throws if `AUTH_ENCRYPTION_KEYS` is missing or
 * malformed, so a deployment that cannot decrypt a TOTP secret or an OIDC client secret fails to
 * start rather than failing at someone's first sign-in.
 */
@Global()
@Module({
  controllers: [AuthController, InvitationController, EnterpriseIdentityController, ScimController],
  providers: [
    { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
    {
      // The key provider is the seam a KMS/Vault implementation replaces (Prompt 20). Everything
      // downstream depends on `SecretBox`, not on where the key came from.
      provide: SecretBox,
      useFactory: () => new SecretBox(keyProviderFromEnv(process.env['AUTH_ENCRYPTION_KEYS'])),
    },
    {
      // Injected rather than constructed inline so a test can verify a domain without needing
      // real DNS — a test that depends on a live TXT record is a test that fails on a train.
      provide: DNS_TXT_RESOLVER,
      useFactory: () => new NodeDnsTxtResolver(),
    },
    PasswordService,
    SecurityEventPublisher,
    SessionService,
    SessionActorResolver,
    LoginService,
    InvitationService,
    PasswordResetService,
    MfaService,
    MfaLoginService,
    AuthenticationPolicyService,
    DomainVerificationService,
    OidcProvider,
    SamlProvider,
    SsoService,
    ScimService,
  ],
  exports: [
    AUTH_CONFIG,
    SecretBox,
    PasswordService,
    SecurityEventPublisher,
    SessionService,
    SessionActorResolver,
    LoginService,
    InvitationService,
    PasswordResetService,
    MfaService,
    MfaLoginService,
    AuthenticationPolicyService,
    DomainVerificationService,
    OidcProvider,
    SamlProvider,
    SsoService,
    ScimService,
  ],
})
export class AuthModule {}
