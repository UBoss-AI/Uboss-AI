import type { ReactNode } from 'react';

import { LOGIN_CAPABILITIES, LOGIN_ASSURANCES } from '../navigation/navigation-model';
import { Icon } from '../primitives/Icon';

export interface LoginPresentationProps {
  /** The sign-in form, activation form or access-help form. */
  children?: ReactNode;
  /**
   * Which plane this is the front door to.
   *
   * `customer` is the product login: the radial mind-map, the six locked capability sections, the
   * assurance strip. `platform` is the front door UBoss's own staff use, and it is deliberately a
   * different composition rather than the same panel with different words — somebody who has both
   * pages open must be able to tell them apart at a glance, before reading anything.
   *
   * What they share is the visual system and every primitive inside the card. What they do not
   * share is identity: the customer page never mentions the platform, and the platform page never
   * offers a company workspace.
   */
  variant?: 'customer' | 'platform';
  /**
   * What the right-hand column is for, for a screen reader.
   *
   * It was the literal string "Sign in", which stopped being true when registration started using
   * this same panel: somebody arriving at `/start` with a screen reader was told they had reached
   * a sign-in. The default keeps every existing caller unchanged.
   */
  formLabel?: string;
}

/**
 * Login presentation area, transcribed from the client's approved `index.html`.
 *
 * The reference defines its login **twice** and the later definition wins. That later one is the
 * radial mind-map reproduced here — concentric rings, six curved connectors from a central `UB`
 * node, three capability cards on each side, and an assurance strip along the bottom. An earlier
 * version of this component used the *superseded* definition's plain list and copy; matching the
 * reference means matching the override.
 *
 * The left panel shows the six locked sections — MAP, Optimize, Build, Operate, Govern, Manage
 * Task. All six remain until the client approves a different grouping. They are presentation
 * only and grant no application access.
 *
 * This panel offers no sign-up affordance of its own, and that is still deliberate: a person who
 * arrives at `/login` is somebody their company already invited, and a "create an account" link
 * on a sign-in screen for an enterprise product invites people to try to make one who cannot.
 *
 * Self-serve registration does exist — `/start`, where a company proves its work address and its
 * domain — and it **renders inside this same panel**, so the two front doors are one composition
 * seen twice rather than two designs that drift apart. That is why `formLabel` exists: the right
 * column is not always a sign-in, and saying so to a screen reader costs one prop.
 */
export function LoginPresentation({
  children,
  variant = 'customer',
  formLabel = 'Sign in',
}: LoginPresentationProps) {
  const left = LOGIN_CAPABILITIES.filter((capability) => capability.side === 'left');
  const right = LOGIN_CAPABILITIES.filter((capability) => capability.side === 'right');

  if (variant === 'platform') {
    return <PlatformLoginPresentation formLabel={formLabel}>{children}</PlatformLoginPresentation>;
  }

  return (
    <div className="uboss-login">
      <section className="uboss-login-left" aria-label="About UBoss">
        {/*
          The signature curves, from the approved reference.

          Three long paths sweeping the whole panel, behind everything. They are what stops the
          gradient reading as a flat sheet, and they are a different layer from the connectors
          between the centre node and the capability cards — those are short and structural, these
          are atmosphere. The viewBox is stretched to the panel deliberately: the curves are
          composed for the shape they end up in, not for a square.
        */}
        <svg
          className="uboss-lg-sig"
          viewBox="0 0 600 900"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M-20,260 C140,180 220,420 380,330 C520,250 560,430 640,380"
            stroke="#C084FC"
            strokeWidth={1.6}
            opacity={0.9}
          />
          <path
            d="M-20,470 C120,400 240,640 400,540 C540,450 580,600 640,560"
            stroke="#A78BFA"
            strokeWidth={1.8}
            opacity={0.75}
          />
          <path
            d="M-20,700 C160,630 250,830 420,740 C540,680 580,790 640,760"
            stroke="#7C3AED"
            strokeWidth={1.2}
            opacity={0.6}
          />
        </svg>

        <div className="uboss-login-brand">
          <div className="uboss-side-logo" aria-hidden="true">
            U
          </div>
          <div>
            <b>Chief Agent</b>
            <span>Powered by UBoss AI</span>
          </div>
        </div>

        <span className="uboss-login-pill">
          <i aria-hidden="true" />
          Enterprise Agent Management System
        </span>

        <div className="uboss-mindmap">
          {/* Concentric rings and connectors are decoration; the cards below carry the meaning. */}
          <div className="uboss-mm-rings" aria-hidden="true">
            <span style={{ width: 260, height: 260 }} />
            <span style={{ width: 440, height: 440 }} />
            <span style={{ width: 620, height: 620 }} />
            <span style={{ width: 820, height: 820 }} />
          </div>

          {/*
            The connectors, exactly as the reference draws them.

            They are arcs sweeping out of the centre and past the cards, not links between two
            boxes — together they make the lens shape that is the composition. An attempt to
            "correct" them into short node-to-card links removed the part doing the work and left
            six stubs. The inner ends sit under the centre node on purpose; the curve emerges from
            behind it, which is what makes the node read as the source.
          */}
          <svg
            className="uboss-mm-links"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M50,50 C42,50 40,17 33,17"
              stroke="var(--uboss-login-link)"
              strokeWidth={1.8}
              pathLength={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.75}
            />
            <path
              d="M50,50 C44,50 41,50 33,50"
              stroke="var(--uboss-login-link)"
              strokeWidth={1.8}
              pathLength={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.9}
            />
            <path
              d="M50,50 C42,50 40,83 33,83"
              stroke="var(--uboss-login-link)"
              strokeWidth={1.8}
              pathLength={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.6}
            />
            <path
              d="M50,50 C58,50 60,17 67,17"
              stroke="var(--uboss-login-link)"
              strokeWidth={1.8}
              pathLength={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.75}
            />
            <path
              d="M50,50 C56,50 59,50 67,50"
              stroke="var(--uboss-login-link)"
              strokeWidth={1.8}
              pathLength={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.9}
            />
            <path
              d="M50,50 C58,50 60,83 67,83"
              stroke="var(--uboss-login-link)"
              strokeWidth={1.8}
              pathLength={1}
              vectorEffect="non-scaling-stroke"
              opacity={0.6}
            />
          </svg>

          <ul className="uboss-mm-grid">
            {left.map((capability, index) => (
              <li
                key={capability.key}
                className="uboss-mmc uboss-mmc--left"
                style={{ gridRow: index + 1 }}
              >
                <span className="uboss-mmc-icon" aria-hidden="true">
                  <Icon name={capability.icon} size={18} />
                </span>
                <span>
                  <b>{capability.title}</b>
                  <small>{capability.description}</small>
                </span>
              </li>
            ))}

            <li className="uboss-mm-center" aria-hidden="true">
              <b>UB</b>
            </li>

            {right.map((capability, index) => (
              <li
                key={capability.key}
                className="uboss-mmc uboss-mmc--right"
                style={{ gridRow: index + 1 }}
              >
                <span className="uboss-mmc-icon" aria-hidden="true">
                  <Icon name={capability.icon} size={18} />
                </span>
                <span>
                  <b>{capability.title}</b>
                  <small>{capability.description}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="uboss-mm-foot">
          {LOGIN_ASSURANCES.map((assurance) => (
            <span key={assurance.label} className="uboss-mm-foot-item">
              <Icon name={assurance.icon} size={16} />
              {assurance.label}
            </span>
          ))}
        </div>
      </section>

      <section className="uboss-login-right" aria-label={formLabel}>
        <div className="uboss-login-card">{children}</div>
      </section>
    </div>
  );
}

/**
 * The front door for UBoss's own staff.
 *
 * ## Why this is a second composition rather than a second set of words
 *
 * These two pages are opened by different people for different reasons, and the cost of confusing
 * them is not symmetrical: a customer who wanders into the platform console should meet a wall,
 * and a UBoss engineer who signs into the customer login wastes a minute. So the difference has to
 * be legible before anything is read — a different shape, not a different heading on the same
 * shape.
 *
 * ## What it says, and what it deliberately does not
 *
 * Four words — Platform, Governance, Operations, Security — because they are what this plane is
 * for. There is no status, no counter and no chart: this page is seen by someone who is not yet
 * authenticated, and anything that looked like monitoring data would either be invented or would
 * be telling an anonymous visitor about the state of the platform.
 *
 * The grid behind them is a motif and nothing more. It is drawn, not measured.
 */
function PlatformLoginPresentation({
  children,
  formLabel,
}: {
  children?: ReactNode;
  formLabel: string;
}) {
  return (
    <div className="uboss-login uboss-login--platform">
      <section className="uboss-login-left" aria-label="About the UBoss platform console">
        <div className="uboss-login-brand">
          <div className="uboss-side-logo" aria-hidden="true">
            U
          </div>
          <div>
            <b>UBoss AI</b>
            <span>Platform &amp; Development Console</span>
          </div>
        </div>

        <span className="uboss-login-pill">
          <i aria-hidden="true" />
          Authorized internal access only
        </span>

        {/*
          A motif, drawn rather than measured. Nothing on this panel reports the state of anything:
          an unauthenticated visitor is told what this console is for, and nothing about how it is
          doing.
        */}
        <div className="uboss-plat-grid" aria-hidden="true">
          <svg viewBox="0 0 400 260" preserveAspectRatio="none" fill="none">
            <defs>
              <linearGradient id="uboss-plat-line" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--uboss-ai-bright)" stopOpacity="0.55" />
                <stop offset="100%" stopColor="var(--uboss-ai)" stopOpacity="0.08" />
              </linearGradient>
            </defs>
            {[40, 90, 140, 190, 240].map((y) => (
              <line
                key={`h${y}`}
                x1="0"
                y1={y}
                x2="400"
                y2={y}
                stroke="url(#uboss-plat-line)"
                strokeWidth="1"
              />
            ))}
            {[60, 140, 220, 300, 360].map((x) => (
              <line
                key={`v${x}`}
                x1={x}
                y1="0"
                x2={x}
                y2="260"
                stroke="url(#uboss-plat-line)"
                strokeWidth="1"
              />
            ))}
            {[
              [60, 90],
              [140, 140],
              [220, 90],
              [300, 190],
              [360, 140],
            ].map(([cx, cy]) => (
              <circle key={`n${cx}-${cy}`} cx={cx} cy={cy} r="3.5" fill="var(--uboss-ai-bright)" />
            ))}
            <path
              d="M60,90 L140,140 L220,90 L300,190 L360,140"
              stroke="var(--uboss-ai-bright)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
              className="uboss-plat-path"
            />
          </svg>
        </div>

        <ul className="uboss-plat-words">
          {PLATFORM_CONSOLE_WORDS.map((word) => (
            <li key={word}>{word}</li>
          ))}
        </ul>

        <div className="uboss-mm-foot">
          {LOGIN_ASSURANCES.map((assurance) => (
            <span key={assurance.label} className="uboss-mm-foot-item">
              <Icon name={assurance.icon} size={16} />
              {assurance.label}
            </span>
          ))}
        </div>
      </section>

      <section className="uboss-login-right" aria-label={formLabel}>
        <div className="uboss-login-card">{children}</div>
      </section>
    </div>
  );
}

/** What this plane is for. Four, because a list long enough to scan is a list nobody reads. */
const PLATFORM_CONSOLE_WORDS = ['Platform', 'Governance', 'Operations', 'Security'] as const;

/**
 * Who can let you in, said plainly on every screen that could be mistaken for a signup.
 *
 * Kept as a component so it cannot drift between the login, activation and access-help screens.
 *
 * ## It used to say something that stopped being true
 *
 * The wording was "No public signup. A UBoss company account is set up for you." That was a fact
 * about the product for most of its life and stopped being one when self-serve registration
 * shipped: a company *can* now set itself up, by proving a work address and control of a domain.
 *
 * The two sentences never appeared on one screen — this notice renders on `/activate` and on the
 * sign-in flow's workspace step, neither of which offers `/start`. So nobody was reading a denial
 * directly above an invitation. It was simply a claim the product had outgrown, on a screen a
 * stranger reads.
 *
 * What is still true — and is the part worth saying — is the half about *people*. Nobody joins a
 * company that already exists by signing up; they are invited, and "Activate" only enables an
 * identity somebody already created. A company starting its own workspace is a different door
 * and lets nobody into somebody else's company.
 *
 * The wording avoids UBoss's own vocabulary on purpose. It used to read "Tenants are provisioned
 * from the UBoss Master Console", which is true and is written for us: a customer does not have a
 * word for a tenant, has never seen the Master Console, and does not need to learn that UBoss has
 * an inside in order to understand how they get in.
 */
export function NoPublicSignupNotice() {
  return (
    <p className="uboss-auth-note">
      <Icon name="shield" size={16} />
      <span>
        You cannot add yourself to a company. Someone there invites you, and &ldquo;Activate&rdquo;
        enables the identity they created.
      </span>
    </p>
  );
}
