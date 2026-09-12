import { Injectable, NotImplementedException } from '@nestjs/common';

import type { FederatedIdentity } from './oidc.provider.js';

/**
 * SAML 2.0 — the abstraction, with no implementation.
 *
 * ## Why this ships as an abstraction and not as code
 *
 * SAML's security rests entirely on XML Digital Signature verification, and XML DSig is one of
 * the few places in applied cryptography where a *plausible-looking* implementation is reliably
 * exploitable. The failure modes are specific and well documented:
 *
 *   * **XML Signature Wrapping.** The signature is valid — over a fragment the parser is not the
 *     one that produced the assertion actually consumed. An implementation that verifies "a"
 *     signature and then reads "the" assertion is bypassed by an attacker who supplies both.
 *   * **Canonicalisation mismatches.** Exclusive vs inclusive C14N, comment handling, namespace
 *     inheritance. Get any of it wrong and either valid assertions are rejected or altered ones
 *     are accepted. The `NameID` comment-truncation bug that hit multiple SAML libraries at once
 *     in 2018 was exactly this.
 *   * **Entity expansion and external entities.** A SAML response is attacker-supplied XML
 *     posted to an unauthenticated endpoint, which makes XXE and billion-laughs live concerns
 *     before any signature is even checked.
 *
 * Writing that from scratch alongside everything else in this step, without the review time it
 * needs, would produce the worst possible outcome: an authentication path that *appears* to
 * federate and can be forged. A working OIDC path plus an honest "SAML is not implemented" is
 * strictly better than two paths where one is quietly broken.
 *
 * ## What this file is for
 *
 * The data model already carries SAML's configuration — `entity_id`, `sso_url`, `slo_url`,
 * `signing_certificate` and the attribute mapping are columns on `sso_connections`, and
 * `SsoProtocol.Saml` is a real enum value. A company's connection can be recorded and inspected
 * now. What cannot happen is a sign-in through it: the service refuses to create an enabled SAML
 * connection, and every method here throws.
 *
 * ## What implementing it will require
 *
 * Not just "add the methods". Specifically: a hardened XML parser with DTD and external entities
 * disabled; signature verification that resolves the signed reference and confirms it is the
 * same element as the assertion being read (not merely that some signature validated); exclusive
 * canonicalisation; `Conditions`/`NotBefore`/`NotOnOrAfter`, `AudienceRestriction`,
 * `InResponseTo`, `Destination` and `Recipient` all checked; assertion-id replay tracking; and
 * IdP certificate rotation. Each of those is a test case, not a line of code.
 */
@Injectable()
export class SamlProvider {
  static readonly NOT_IMPLEMENTED_REASON =
    'SAML sign-in is not implemented. The connection model and configuration exist, but ' +
    'assertion verification requires hardened XML signature handling that has not been built ' +
    'or reviewed. Use an OIDC connection, which is fully implemented. See ' +
    'docs/SECURITY_DECISIONS.md S-033.';

  /**
   * Metadata a company would give its identity provider.
   *
   * Implemented, because it is inert descriptive XML with no security decision in it, and having
   * it lets a company complete its side of the configuration before UBoss can consume the
   * assertions. It deliberately advertises no signing or encryption certificate of our own,
   * because we have none — an administrator reading it will see that this is incomplete.
   */
  serviceProviderMetadata(input: {
    entityId: string;
    assertionConsumerServiceUrl: string;
  }): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"',
      `  entityID="${escapeXml(input.entityId)}">`,
      '  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"',
      '    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
      '    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>',
      '    <md:AssertionConsumerService',
      '      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"',
      `      Location="${escapeXml(input.assertionConsumerServiceUrl)}" index="0" isDefault="true"/>`,
      '  </md:SPSSODescriptor>',
      '</md:EntityDescriptor>',
    ].join('\n');
  }

  /** Not implemented — see the class comment. */
  beginAuthorization(): never {
    throw new NotImplementedException(SamlProvider.NOT_IMPLEMENTED_REASON);
  }

  /** Not implemented — see the class comment. */
  completeAuthorization(): Promise<FederatedIdentity> {
    throw new NotImplementedException(SamlProvider.NOT_IMPLEMENTED_REASON);
  }

  /** Not implemented — see the class comment. */
  singleLogoutUrl(): never {
    throw new NotImplementedException(SamlProvider.NOT_IMPLEMENTED_REASON);
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
