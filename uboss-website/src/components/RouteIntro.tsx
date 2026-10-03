'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';

import './route-intro.css';

/**
 * The opening of every page that is not the home page.
 *
 * ## What it replaces
 *
 * The same block on all seven: the same kicker, the same two links — one of which was "Explore the
 * platform", shown to somebody already on the platform page — and, beside it, the *same diagram*,
 * with the same example objective about returning repairs within five working days. Security,
 * Skills, Solutions and Pricing all opened with an identical illustration of a repair workflow.
 *
 * That is what made the site feel like a template. Not any single page: the fact that arriving at
 * a different one showed you the same thing.
 *
 * ## What it does instead
 *
 * The hero's composition at a smaller scale — the same field behind it, the same asymmetric wash,
 * the same display type with one word in an italic serif — and then the part that differs: each
 * page passes its own `facts`, so what sits under the headline is about *that* page. The Skills
 * page opens with the catalogue's size; Security opens with what actually enforces it.
 *
 * Pages with nothing true to put there pass none, and the block is simply absent. A row of
 * invented figures is what this component existed to stop.
 */

/*
 * The same field as the hero, loaded the same way and turned down.
 *
 * Reusing it rather than writing a second scene keeps one idea in one file — and a page that
 * opened with a *different* animation from the home page would undo the point of the change.
 */
const AgentField = dynamic(() => import('./hero/AgentField').then((m) => m.AgentField), {
  ssr: false,
  loading: () => null,
});

export interface IntroFact {
  value: string;
  label: string;
}

export function RouteIntro({
  eyebrow,
  title,
  accent,
  description,
  primary = 'Book a demo',
  href = '/demo',
  /** Two to four figures about *this* page. Omitted where there is nothing true to show. */
  facts,
  /** The second link. Defaults to nothing rather than to a link back to where you already are. */
  secondary,
}: {
  eyebrow: string;
  title: string;
  accent: string;
  description: string;
  primary?: string;
  href?: string;
  facts?: readonly IntroFact[];
  secondary?: { label: string; href: string };
}) {
  const [showField, setShowField] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setTimeout(() => setShowField(true), 140);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <header className="intro">
      <div className="intro__media" aria-hidden="true">
        {showField ? <AgentField /> : null}
        <div className="intro__scrim" />
      </div>

      <div className="intro__inner">
        <p className="intro__kicker">{eyebrow}</p>

        <h1 className="intro__title">
          {title}
          <br />
          <em>{accent}</em>
        </h1>

        <p className="intro__lead">{description}</p>

        <div className="intro__actions">
          <Link className="intro__go" href={href}>
            {primary}
            <span className="intro__go-dot" aria-hidden="true">
              <ArrowRight />
            </span>
          </Link>

          {/*
            Absent unless a page has somewhere else worth sending you.

            Every page used to carry "Explore the platform", including the platform page — a link
            to where the reader already was, on a third of the site.
          */}
          {secondary === undefined ? null : (
            <Link className="intro__second" href={secondary.href}>
              {secondary.label}
            </Link>
          )}
        </div>

        {facts === undefined || facts.length === 0 ? null : (
          <ul className="intro__facts">
            {facts.map((fact) => (
              <li key={fact.label}>
                <span className="intro__fact-value">{fact.value}</span>
                <span className="intro__fact-label">{fact.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </header>
  );
}
