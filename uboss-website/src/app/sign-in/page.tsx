import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Section } from '@/components/site/Section';
import { RouteIntro } from '@/components/RouteIntro';
import {
  PRODUCT_LOGIN_URL,
  PRODUCT_LOGIN_IS_CONFIGURED,
  PRODUCT_START_URL,
} from '@/lib/product-login';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to Chief Agent, powered by UBoss AI.',
};

/**
 * Sign in.
 *
 * ## The 404 this replaces
 *
 * This page redirected to `PRODUCT_LOGIN_URL`, which falls back to `/login` when nothing is
 * configured — an address on *this* site, which has no such page. So every deployment that had not
 * set the variable answered the Sign In button, in the header of every page, with a 404. The
 * fallback was written for a reverse-proxy setup that routes the product under the same domain;
 * everywhere else it was a dead end, and a dead end reached from the header is the first thing a
 * visitor concludes about the software.
 *
 * Now the redirect happens only when there is somewhere real to send them. Where there is not, the
 * page says so and offers the two things that are actually useful: ask your own administrator, or
 * talk to us. Authentication still never happens on this site — the marketing website has no
 * business holding anybody's credentials.
 */
export default function SignInPage() {
  if (PRODUCT_LOGIN_IS_CONFIGURED) {
    redirect(PRODUCT_LOGIN_URL);
  }

  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="SIGN IN"
        title="Chief Agent runs at"
        accent="your company's address."
        description="Each company's workspace is its own. This website never asks for a password and never holds one — sign-in happens on your own workspace, with whatever your company uses to sign in everywhere else."
        primary="Ask us for your workspace address"
        secondary={{ label: 'How sign-on works', href: '/connect' }}
      />

      <Section
        kicker="Two ways in"
        title={
          <>
            Somebody at your company already <em>has</em> it.
          </>
        }
        lead="A workspace address is given out when the company is set up. If you do not have it, the person who administers UBoss at your company does."
      >
        <div className="card-grid" style={{ ['--card-min' as string]: '320px' }}>
          <div className="card">
            <p className="card__eyebrow">If you already use Chief Agent</p>
            <h3 className="card__title">Ask your administrator</h3>
            <p className="card__body">
              They set up the workspace and can invite you or resend the link. If your company signs
              in through its own identity provider, that is where your access comes from — not from
              a password kept here.
            </p>
          </div>

          {/*
            This card used to say a workspace is created by UBoss rather than by filling in a
            form, "which is why there is no sign-up button anywhere on this site". That stopped
            being true: the product registers a company itself — you prove your work address, you
            prove your domain, and the workspace exists on the Pilot plan with nobody to approve
            it. Leaving the old sentence up would have been the site telling a visitor they cannot
            do something the product does.

            Where this deployment has not been told the product's address, it falls back to the
            demo form rather than linking into the dark.
          */}
          <div className="card">
            <p className="card__eyebrow">If your company does not yet</p>
            <h3 className="card__title">Start one yourself</h3>
            <p className="card__body">
              Prove your work email and your company&rsquo;s domain, and the workspace is yours on
              the Pilot plan — free, one seat, nobody to wait for. Moving to a paid plan happens
              inside it, once you have seen the product with your own company in it.
            </p>
            <Link
              className="plan__cta"
              href={PRODUCT_START_URL === '' ? '/demo' : PRODUCT_START_URL}
            >
              {PRODUCT_START_URL === '' ? 'Book a demo' : 'Start a workspace'}
            </Link>
          </div>
        </div>
      </Section>
    </div>
  );
}
