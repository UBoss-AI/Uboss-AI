'use client';

import { useCallback, useEffect, useState } from 'react';

import { Banner, Card, CardBody } from '@uboss/ui';

import {
  ApiError,
  accessLevelsApi,
  type AccessLevelSection,
  type AccessLevelView,
} from '../lib/api-client';

export interface AccessPermissionsStepProps {
  tenantId: string;
  /** Whose access is being set. */
  userId: string;
  /** Shown above the list, so an administrator knows who they are editing. */
  subjectLabel: string;
  onChanged?: () => void;
}

/**
 * Access & Permissions — a section, then a level.
 *
 * ## What this replaced, and why
 *
 * It showed eight capabilities under three headings — "Run work assigned to them", "Manage people
 * and assigned work", "Design objectives and build agents" — each with a paragraph beneath it, and
 * a further paragraph above the lot saying what a new employee starts with. The client's objection
 * was that those are sentences rather than names, and that four lines of prose stood between an
 * administrator and the first control. Somebody deciding whether a colleague may open Agent
 * Builder should be able to find that out by reading two words.
 *
 * So the question is asked the way the client asked for it: the fourteen sections of the sidebar,
 * and under each the levels it offers. The four level names never change — Viewer, Creator,
 * Approver, Admin — because an administrator comparing two colleagues should be comparing one
 * vocabulary. What changes is the single line underneath, which says what that level means *here*:
 * a Creator writes objectives, and on Engine Agents a Creator runs them.
 *
 * ## Why boxes and not a radio
 *
 * A level includes every level below it, so somebody with Approver also has Viewer and Creator —
 * and a row of boxes showing all three ticked is the truth. A radio would show one and hide the
 * rest. Ticking a box therefore sets the level *to* that box, and the server answers with what the
 * person now holds; unticking the only remaining box is how "no access" is said.
 *
 * That also makes the incoherent grant unreachable. Four independent ticks would let a company
 * grant Approve to somebody who may not open the thing they are approving, which is not a
 * permission anybody means to hand out.
 *
 * ## It decides nothing
 *
 * Every box is a request the server evaluates against the same delegation rule the capabilities
 * screen used: an administrator cannot grant a section they hold nothing on, nor a level above
 * their own. A level they may not hand out arrives disabled **and** carrying `whyNot`, because a
 * greyed control with no reason is the thing that generates support tickets.
 */
export function AccessPermissionsStep({
  tenantId,
  userId,
  subjectLabel,
  onChanged,
}: AccessPermissionsStepProps) {
  const [view, setView] = useState<AccessLevelView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await accessLevelsApi.view(tenantId, userId));
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Access and permissions could not be loaded.',
      );
    }
  }, [tenantId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Set a section to a level, or clear it.
   *
   * Ticking a box that is already held means "come down to this level" — which is how somebody
   * steps an Approver back to Creator without first removing everything. Unticking the lowest
   * held box clears the section.
   */
  const choose = async (section: AccessLevelSection, level: string, held: boolean) => {
    const lowest = section.levels.find((entry) => entry.held)?.level;
    const next = held && level === lowest ? null : level;

    setBusy(`${section.module}:${level}`);
    setError(null);
    setNotice(null);

    try {
      setView(await accessLevelsApi.set(tenantId, userId, section.module, next));
      setNotice(
        next === null ? `Removed access to ${section.label}.` : `${section.label} is now ${level}.`,
      );
      onChanged?.();
    } catch (caught) {
      // The server's refusal, word for word. It names the section and the level and says why;
      // paraphrasing it would lose the only sentence that helps.
      setError(caught instanceof ApiError ? caught.message : 'That change could not be saved.');
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (view === null) {
    return (
      <Card>
        <CardBody>{error ?? 'Loading access and permissions…'}</CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <h2 className="access-step-title">Access &amp; Permissions</h2>
        <p className="access-step-subject">For {subjectLabel}</p>

        {error !== null ? <Banner tone="danger">{error}</Banner> : null}
        {notice !== null ? <Banner tone="ok">{notice}</Banner> : null}

        <ul className="access-sections">
          {view.sections.map((section) => (
            <li
              key={section.module}
              className="access-section"
              data-testid={`section-${section.module}`}
            >
              <h3 className="access-section-title">{section.label}</h3>

              <div className="access-section-levels">
                {section.levels.map((option) => (
                  <label
                    key={option.level}
                    className={`access-level${option.canGrant ? '' : ' access-level--refused'}`}
                    title={option.whyNot ?? option.line}
                  >
                    <input
                      type="checkbox"
                      checked={option.held}
                      disabled={!option.canGrant || busy !== null}
                      onChange={() => void choose(section, option.level, option.held)}
                      data-testid={`level-${section.module}-${option.level}`}
                    />
                    <span className="access-level-name">{option.label}</span>
                    <span className="access-level-line">{option.line}</span>
                    {option.canGrant ? null : (
                      <span className="access-level-why">{option.whyNot}</span>
                    )}
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
