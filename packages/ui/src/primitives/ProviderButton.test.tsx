import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProviderButton, providerKindFrom } from './ProviderButton';

/*
 * The mark has to match the provider, and the match has to come from something a person cannot
 * mistype. A company names its own connection, so "Apple SSO (via Google Workspace)" is a name
 * somebody will eventually write — and putting an Apple mark on a Google connection would send
 * people to the wrong place.
 */
describe('providerKindFrom — the issuer decides, not the label', () => {
  it.each([
    ['https://accounts.google.com', 'google'],
    ['https://login.microsoftonline.com/9188040d-6c67-4c5b/v2.0', 'microsoft'],
    ['https://sts.windows.net/72f988bf/', 'microsoft'],
    ['https://appleid.apple.com', 'apple'],
  ])('reads %s as %s', (issuer, kind) => {
    expect(providerKindFrom(issuer)).toBe(kind);
  });

  it('calls an unfamiliar provider generic rather than guessing', () => {
    // Okta, Ping, a self-hosted Keycloak — all real, none of them one of the three marks.
    expect(providerKindFrom('https://dev-12345.okta.com')).toBe('generic');
    expect(providerKindFrom('https://sso.acme-internal.example')).toBe('generic');
  });

  it('survives a connection with no issuer at all', () => {
    expect(providerKindFrom(null)).toBe('generic');
    expect(providerKindFrom(undefined)).toBe('generic');
    expect(providerKindFrom('')).toBe('generic');
  });
});

describe('ProviderButton', () => {
  it('says which provider it is in words, not only in the mark', () => {
    render(<ProviderButton kind="google" label="Continue with Google" />);

    // The mark is aria-hidden; the label is what a screen reader has to work with.
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
  });

  it('hides the mark from assistive technology', () => {
    const { container } = render(
      <ProviderButton kind="microsoft" label="Continue with Microsoft" />,
    );
    expect(container.querySelector('.uboss-provider-mark')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('starts the flow when pressed', () => {
    const onClick = vi.fn();
    render(<ProviderButton kind="apple" label="Continue with Apple" onClick={onClick} />);

    screen.getByRole('button', { name: 'Continue with Apple' }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does nothing when it cannot, and says why', () => {
    const onClick = vi.fn();
    render(
      <ProviderButton
        kind="generic"
        label="Acme SSO"
        onClick={onClick}
        disabled
        title="SAML sign-in is not available yet. Use an OIDC connection."
      />,
    );

    const button = screen.getByRole('button', { name: 'Acme SSO' });
    button.click();
    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute('title')).toMatch(/not available yet/);
  });

  it('draws a different mark for each provider', () => {
    // Guards against every button quietly rendering the same shape.
    const shapes = new Set<string>();
    for (const kind of ['google', 'microsoft', 'apple'] as const) {
      const { container, unmount } = render(<ProviderButton kind={kind} label={kind} />);
      shapes.add(container.querySelector('.uboss-provider-mark')?.innerHTML ?? '');
      unmount();
    }
    expect(shapes.size).toBe(3);
  });
});
