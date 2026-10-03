// Server-rendered: the flow beside the copy is CSS, so nothing here needs the client. The hero
// is the first thing a visitor sees and it now ships as HTML with no JavaScript in its path.

import Link from 'next/link';

import { ArrowRight, ShieldCheck } from 'lucide-react';

import { CATALOG } from '@/lib/catalog';
import { ObjectiveFlow } from './ObjectiveFlow';
import './hero.css';

/**
 * The hero.
 *
 * ## What it is modelled on, and what it refuses to copy
 *
 * The structure comes from the reference the client supplied: a full-bleed moving field, copy held
 * hard left and riding high, a display headline with one word set in an italic serif, a pill call
 * to action with a white arrow disc, glass cards below the fold line, and a foot strip carrying a
 * watermark and a row of marks.
 *
 * What it does **not** copy is that hero's content. The reference sells its own credibility with
 * "150+ projects delivered", "98% client satisfaction" and "650+ happy clients" beside a row of
 * partner logos. Those are the easiest thing in the world to retype and the one thing this site
 * must not carry: a number a customer can ask about in the first demo and find is not real is
 * worth less than no number at all.
 *
 * So the same slots hold facts that can be checked. The three figures are read from the running
 * Skill Catalogue — see `lib/catalog.ts`, which records the queries — and the strip along the
 * bottom names what the product does rather than who is supposed to have bought it.
 *
 * ## The name
 *
 * **Chief Agent, powered by UBoss AI.** The product is Chief Agent; UBoss is the platform under it.
 * Both appear, and in that order, everywhere the name is set.
 */

/** Read from the catalogue, not written for effect. `lib/catalog.ts` carries the queries. */
const proof = [
  { value: CATALOG.skills.toLocaleString(), label: 'Governed Skills in the catalogue' },
  { value: CATALOG.rules.toLocaleString(), label: 'IF-THEN rules those Skills carry' },
  { value: String(CATALOG.industries), label: 'Industries with a pack of their own' },
] as const;

/** What the product does. Not partner logos: there are none to show, so none are shown. */
const marks = [
  'Objectives',
  'Agent Builder',
  'Governed Skills',
  'Human approval',
  'Audit trail',
] as const;

export function ChiefAgentHero(): React.JSX.Element {
  return (
    <section className="hero" aria-labelledby="hero-title">
      {/*
        The field of points is gone, and the flow took its place.

        Both at once was two moving things behind one headline, and the points were the half that
        said nothing — the flow on the right is the same idea with the product's own shapes on it.
        What is left here is the wash and the hairlines: the ground the flow sits on.
      */}
      <div className="hero__media" aria-hidden="true">
        <div className="hero__scrim" />
        <div className="hero__rules">
          <span />
          <span />
          <span />
        </div>
      </div>

      <div className="hero__inner">
        <div className="hero__lead">
          <p className="hero__note">
            <ShieldCheck className="hero__note-icon" aria-hidden="true" />
            <span>
              Chief Agent
              <br />
              powered by UBoss AI
            </span>
          </p>

          {/*
            Three lines, not four.

            At four the block ran past the fold on a 900px screen and took the figures and the foot
            strip with it — the whole point of a full-height hero is that what it holds is what you
            see without scrolling. Three lines of this length also break where the sense breaks,
            which four did not.
          */}
          <h1 className="hero__title" id="hero-title">
            You set
            <br />
            the objective.
            <br />
            It builds the <em>team</em>.
          </h1>

          <p className="hero__sub">
            Business intent becomes a working system of agents, governed skills and people — each
            with a role it was given, a boundary it cannot cross, and an owner who signs the work
            off.
          </p>

          <div className="hero__cta">
            <Link className="hero__go" href="/demo">
              Book a demo
              <span className="hero__go-dot" aria-hidden="true">
                <ArrowRight />
              </span>
            </Link>

            <Link className="hero__second" href="/how-it-works">
              See how it works
            </Link>
          </div>

          <ul className="hero__stats">
            {proof.map((item) => (
              <li key={item.label} className="stat">
                <span className="stat__mark" aria-hidden="true">
                  *
                </span>
                <span className="stat__value">{item.value}</span>
                <span className="stat__label">{item.label}</span>
                <span className="stat__rule" aria-hidden="true" />
              </li>
            ))}
          </ul>
        </div>

        {/*
          The product's own flow, on the right.

          This was a field of abstract points — pleasant, and it could have sat behind any software
          in the world. The shapes here are the ones the product actually draws, so somebody who
          opens it later recognises them.
        */}
        <ObjectiveFlow />
      </div>

      <div className="hero__foot">
        <span className="hero__watermark" aria-hidden="true">
          UBOSS
        </span>
        <div className="hero__marks">
          <span className="hero__marks-label">What it runs on</span>
          <ul>
            {marks.map((mark) => (
              <li key={mark}>{mark}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
