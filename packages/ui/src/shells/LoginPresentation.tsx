import type { ReactNode } from 'react';

import { LOGIN_CAPABILITIES, LOGIN_ASSURANCES } from '../navigation/navigation-model';
import { Icon } from '../primitives/Icon';

export interface LoginPresentationProps {
  /** The sign-in form, activation form or access-help form. */
  children?: ReactNode;
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
 * There is NO public company signup anywhere in UBoss: the Master Console provisions customer
 * companies, and "Activate" only enables an already-invited identity. This component therefore
 * offers no sign-up affordance, by design.
 */
export function LoginPresentation({ children }: LoginPresentationProps) {
  const left = LOGIN_CAPABILITIES.filter((capability) => capability.side === 'left');
  const right = LOGIN_CAPABILITIES.filter((capability) => capability.side === 'right');

  return (
    <div className="uboss-login">
      <section className="uboss-login-left" aria-label="About UBoss">
        <div className="uboss-login-brand">
          <div className="uboss-side-logo" aria-hidden="true">
            U
          </div>
          <div>
            <b>UBOSS AI AMS</b>
            <span>Enterprise AI Workforce &amp; Operations</span>
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

          <svg
            className="uboss-mm-links"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M50,50 C42,50 40,17 33,17"
              stroke="#38bdf8"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
              opacity={0.85}
            />
            <path
              d="M50,50 C44,50 41,50 33,50"
              stroke="#6366f1"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
              opacity={0.85}
            />
            <path
              d="M50,50 C42,50 40,83 33,83"
              stroke="#f59e0b"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
              opacity={0.85}
            />
            <path
              d="M50,50 C58,50 60,17 67,17"
              stroke="#2dd4bf"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
              opacity={0.85}
            />
            <path
              d="M50,50 C56,50 59,50 67,50"
              stroke="#38bdf8"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
              opacity={0.85}
            />
            <path
              d="M50,50 C58,50 60,83 67,83"
              stroke="#fb7185"
              strokeWidth={1.4}
              vectorEffect="non-scaling-stroke"
              opacity={0.85}
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

      <section className="uboss-login-right" aria-label="Sign in">
        <div className="uboss-login-card">{children}</div>
      </section>
    </div>
  );
}

/**
 * The provisioning notice shown beneath the sign-in form, worded exactly as the UI reference.
 * Kept as a component so it cannot drift between the login, activation and access-help screens.
 */
export function NoPublicSignupNotice() {
  return (
    <p className="uboss-auth-note">
      <Icon name="shield" size={16} />
      <span>
        No public company signup. Tenants are provisioned from the UBoss Master Console;
        &ldquo;Activate&rdquo; only enables an already-invited identity.
      </span>
    </p>
  );
}
