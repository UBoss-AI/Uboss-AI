'use client';

import { useCallback, useEffect, useState } from 'react';

import { Banner, Button, Card, CardBody, Icon, StatusBadge } from '@uboss/ui';

import { accessApi, ApiError } from '../lib/api-client';

/**
 * Roles & Permissions, as a screen rather than a sentence.
 *
 * ## What was here
 *
 * One paragraph, a *Read only* badge, and nothing else: "the role catalogue is built-in and
 * identical in every deployment, so it is deliberately not editable here." Every word of that is
 * true, and as the whole content of a settings section it is useless — an administrator opened
 * the one place named after permissions and could not see a single permission.
 *
 * ## What is here now
 *
 * The catalogue itself, spelled out: every role, every module it reaches, and every action it
 * allows. That is the thing an administrator actually needs, and it was never shown anywhere.
 *
 * And below it, the roles a company writes for itself. The built-in ones stay fixed — they are
 * the product's vocabulary, and a company that edited `Manager` would be running a different
 * product from the one its support contract describes. A company that needs a different
 * combination makes its own role, which is the supported way to change what somebody may read,
 * and it is done here rather than on another screen.
 */
export function RolesPanel({
  tenantId,
  mayAdminister,
}: {
  tenantId: string;
  /** Whether this viewer may write a role. The server decides again; this only hides the form. */
  mayAdminister: boolean;
}): React.JSX.Element {
  const [builtIn, setBuiltIn] = useState<
    { kind: string; label: string; summary: string; maxScope: string; permissions: Record<string, string[]> }[]
  >([]);
  const [own, setOwn] = useState<
    { id: string; displayName: string; description: string | null; permissions: Record<string, string[]>; maxScope: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void accessApi
      .roleCatalogue(tenantId)
      .then((view) => setBuiltIn(view.roles))
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'The role catalogue did not load.'),
      );

    // Best effort and separate: a company with no roles of its own is the ordinary case, and a
    // refusal here must not take the catalogue down with it.
    void accessApi
      .customRoles(tenantId)
      .then((view) => setOwn(view.roles))
      .catch(() => setOwn([]));
  }, [tenantId]);

  useEffect(load, [load]);

  return (
    <>
      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {note === null ? null : <Banner tone="ok">{note}</Banner>}

      <div className="uboss-section-label" style={{ marginTop: 0 }}>
        The roles UBoss provides
      </div>
      <p className="uboss-muted-3">
        Built in and the same in every company, so support and documentation describe the same
        thing everywhere. Open one to see exactly what it allows.
      </p>

      <ul className="uboss-role-list">
        {builtIn.map((role) => (
          <li key={role.kind}>
            <button
              type="button"
              className="uboss-role-head"
              onClick={() => setOpen(open === role.kind ? null : role.kind)}
              aria-expanded={open === role.kind}
            >
              <span>
                <b>{role.label}</b>
                <br />
                <small className="uboss-muted-3">{role.summary}</small>
              </span>
              <span className="uboss-role-meta">
                <StatusBadge status={`${Object.keys(role.permissions).length} modules`} tone="grey" />
                <StatusBadge status={role.maxScope} tone="blue" />
                <Icon name={open === role.kind ? 'arrow-up' : 'arrow-down'} size={16} />
              </span>
            </button>

            {open === role.kind ? (
              <div className="uboss-role-grants">
                {Object.entries(role.permissions).map(([module, actions]) => (
                  <div key={module} className="uboss-role-grant">
                    <span className="uboss-role-module">{module}</span>
                    <span className="uboss-role-actions">{actions.join(', ')}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="uboss-section-label">Roles this company wrote</div>
      {own.length === 0 ? (
        <p className="uboss-muted-3">
          None yet. A role of your own is how you give somebody a combination the built-in roles do
          not offer — a different set of modules, or read where a built-in role allows editing.
        </p>
      ) : (
        <ul className="uboss-role-list">
          {own.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                className="uboss-role-head"
                onClick={() => setOpen(open === role.id ? null : role.id)}
                aria-expanded={open === role.id}
              >
                <span>
                  <b>{role.displayName}</b>
                  {role.description === null ? null : (
                    <>
                      <br />
                      <small className="uboss-muted-3">{role.description}</small>
                    </>
                  )}
                </span>
                <span className="uboss-role-meta">
                  <StatusBadge status={role.maxScope} tone="blue" />
                  <Icon name={open === role.id ? 'arrow-up' : 'arrow-down'} size={16} />
                </span>
              </button>

              {open === role.id ? (
                <div className="uboss-role-grants">
                  {Object.entries(role.permissions).map(([module, actions]) => (
                    <div key={module} className="uboss-role-grant">
                      <span className="uboss-role-module">{module}</span>
                      <span className="uboss-role-actions">{actions.join(', ')}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {mayAdminister ? (
        <NewRole
          tenantId={tenantId}
          builtIn={builtIn}
          busy={busy}
          setBusy={setBusy}
          onCreated={(name) => {
            setNote(`"${name}" is now one of this company's roles. Assign it in Users & Access.`);
            load();
          }}
          onError={setError}
        />
      ) : (
        <p className="uboss-muted-3">
          Writing a role needs the Settings administration permission. What each role allows is
          above, and who holds one is in Users &amp; Access.
        </p>
      )}
    </>
  );
}

/**
 * A new role, started from an existing one.
 *
 * Nobody builds a permission matrix from an empty grid — they mean "a Manager who cannot approve"
 * or "an Employee who can also read reports". So it copies a built-in role and lets the
 * administrator take things away or add them, which is also the shape that makes the result
 * reviewable: the difference from a known role is a sentence, and a bare matrix is not.
 */
function NewRole({
  tenantId,
  builtIn,
  busy,
  setBusy,
  onCreated,
  onError,
}: {
  tenantId: string;
  builtIn: { kind: string; label: string; maxScope: string; permissions: Record<string, string[]> }[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  onCreated: (displayName: string) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [writing, setWriting] = useState(false);
  const [basedOn, setBasedOn] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [grants, setGrants] = useState<Record<string, string[]>>({});

  const template = builtIn.find((role) => role.kind === basedOn) ?? null;

  const start = (kind: string): void => {
    const source = builtIn.find((role) => role.kind === kind);
    setBasedOn(kind);
    // A copy, so unticking something here cannot reach the template it came from.
    setGrants(
      source === undefined
        ? {}
        : Object.fromEntries(Object.entries(source.permissions).map(([m, a]) => [m, [...a]])),
    );
  };

  const toggle = (module: string, action: string): void => {
    setGrants((current) => {
      const actions = current[module] ?? [];
      const next = actions.includes(action)
        ? actions.filter((entry) => entry !== action)
        : [...actions, action];
      const copy = { ...current };
      // A module with nothing ticked is a module the role does not reach, not a module with an
      // empty list — the server narrows it the same way.
      if (next.length === 0) delete copy[module];
      else copy[module] = next;
      return copy;
    });
  };

  const problems: string[] = [];
  if (displayName.trim().length < 2) problems.push('A role needs a name.');
  if (Object.keys(grants).length === 0) problems.push('A role that allows nothing is not a role.');

  const create = async (): Promise<void> => {
    if (template === null) return;
    setBusy(true);
    try {
      await accessApi.createCustomRole(tenantId, {
        displayName: displayName.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        permissions: grants,
        maxScope: template.maxScope,
      });
      onCreated(displayName.trim());
      setWriting(false);
      setDisplayName('');
      setDescription('');
      setBasedOn('');
      setGrants({});
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'That role could not be created.');
    } finally {
      setBusy(false);
    }
  };

  if (!writing) {
    return (
      <Button variant="primary" onClick={() => setWriting(true)} data-testid="write-role">
        <Icon name="plus" size={16} />
        Write a role
      </Button>
    );
  }

  return (
    <Card>
      <CardBody>
        <div className="uboss-spread">
          <h3 className="uboss-subhead">A role of your own</h3>
          <Button variant="ghost" size="sm" onClick={() => setWriting(false)}>
            Cancel
          </Button>
        </div>

        <label className="uboss-field">
          <span className="uboss-field-label">Start from *</span>
          <select className="uboss-input" value={basedOn} onChange={(e) => start(e.target.value)}>
            <option value="">Choose a role to copy</option>
            {builtIn.map((role) => (
              <option key={role.kind} value={role.kind}>
                {role.label}
              </option>
            ))}
          </select>
          <span className="uboss-field-note">
            Nobody writes a permission matrix from nothing. Copy the closest role, then take away
            what this one should not have.
          </span>
        </label>

        {template === null ? null : (
          <>
            <label className="uboss-field">
              <span className="uboss-field-label">Name *</span>
              <input
                className="uboss-input"
                value={displayName}
                placeholder="Manager without approval"
                onChange={(event) => setDisplayName(event.target.value)}
                data-testid="role-name"
              />
            </label>

            <label className="uboss-field">
              <span className="uboss-field-label">What it is for</span>
              <input
                className="uboss-input"
                value={description}
                placeholder="Runs a team but does not sign anything off."
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>

            <div className="uboss-section-label">What it allows</div>
            <div className="uboss-role-grants">
              {Object.entries(template.permissions).map(([module, actions]) => (
                <div key={module} className="uboss-role-grant">
                  <span className="uboss-role-module">{module}</span>
                  <span className="uboss-role-actions">
                    {actions.map((action) => (
                      <label key={action} className="uboss-role-action">
                        <input
                          type="checkbox"
                          checked={(grants[module] ?? []).includes(action)}
                          onChange={() => toggle(module, action)}
                        />
                        {action}
                      </label>
                    ))}
                  </span>
                </div>
              ))}
            </div>

            {problems.length > 0 && displayName !== '' ? (
              <Banner tone="warn">{problems.join(' ')}</Banner>
            ) : null}

            <Button
              variant="primary"
              disabled={busy || problems.length > 0}
              onClick={() => void create()}
              data-testid="create-role"
            >
              {busy ? 'Creating…' : 'Create this role'}
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}
