'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Banner, Button, Drawer, FormField, StatusBadge } from '@uboss/ui';

import { ApiError, skillsApi, type BuilderSkillRow } from '../lib/api-client';

export interface SkillPickerProps {
  tenantId: string;
  /** The versions currently attached, so the picker opens on what is already true. */
  attached: string[];
  open: boolean;
  onClose: () => void;
  /** The whole list, because add and replace are the same write. */
  onSave: (skillVersionIds: string[]) => Promise<void>;
}

/**
 * Add or replace the Skills attached to a piece of assigned AI work.
 *
 * ## This does not replace the automatic matching
 *
 * The objective analysis proposes Skills and the builder opens on what it proposed. This is the
 * override for somebody who knows the work better than the matcher did — swap one, add one it
 * missed, drop one that does not belong. What it cannot do is reach past a control.
 *
 * ## Every list here has already been through the server's rules
 *
 * The picker calls `for-builder`, which is a different route from the administrator's catalogue
 * and gated on Agent Builder rather than on Settings. What comes back is **published only**,
 * **entitled only** and **this company only** — so there is no filtering to get wrong here, and
 * nothing this component could do would widen it. The server checks all of it again on save.
 *
 * ## The version is what gets pinned
 *
 * Each row shows `v3`, and choosing it attaches *that version*. When a newer one is published
 * the agent keeps running this one, which is the point: an upgrade is a separate decision with
 * its own impact analysis rather than something that happens to a live agent overnight.
 */
export function SkillPicker({ tenantId, attached, open, onClose, onSave }: SkillPickerProps) {
  const [rows, setRows] = useState<BuilderSkillRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [chosen, setChosen] = useState<string[]>(attached);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reopening starts from what is attached now, not from the last edit that was abandoned.
  useEffect(() => {
    if (open) {
      setChosen(attached);
      setError(null);
    }
  }, [open, attached]);

  const load = useCallback(() => {
    if (!open) return;
    setError(null);
    void skillsApi
      .forBuilder(tenantId, {
        ...(search.trim() === '' ? {} : { search: search.trim() }),
        ...(department === '' ? {} : { department }),
      })
      .then((result) => setRows(result.skills))
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load the Skills.'),
      );
  }, [tenantId, open, search, department]);

  useEffect(load, [load]);

  const departments = useMemo(
    () =>
      [
        ...new Set(
          (rows ?? [])
            .map((row) => row.department)
            .filter((value): value is string => value !== null && value !== ''),
        ),
      ].sort(),
    [rows],
  );

  const toggle = (versionId: string) =>
    setChosen((current) =>
      current.includes(versionId)
        ? current.filter((id) => id !== versionId)
        : [...current, versionId],
    );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(chosen);
      onClose();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setSaving(false);
    }
  };

  const changed = chosen.length !== attached.length || chosen.some((id) => !attached.includes(id));

  return (
    <Drawer open={open} onClose={onClose} title="Add or replace Skills">
      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      <Banner tone="info">
        Published Skills this company is entitled to. Choosing one pins the version shown — the
        agent keeps running it when a newer version is published, until somebody upgrades it
        deliberately.
      </Banner>

      <div style={{ marginTop: 12 }}>
        <FormField label="Search" hint="Skill name">
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              type="search"
              value={search}
              placeholder="reconciliation, forecast…"
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </FormField>

        <FormField label="Department">
          {(wiring) => (
            <select
              {...wiring}
              className="uboss-input"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
            >
              <option value="">All departments</option>
              {departments.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </div>

      <p className="uboss-muted" style={{ marginTop: 12 }}>
        {rows === null ? 'Loading…' : `${rows.length} available · ${chosen.length} attached`}
      </p>

      <div style={{ maxHeight: '48vh', overflowY: 'auto', marginTop: 6 }}>
        {(rows ?? []).map((row) => {
          const isChosen = chosen.includes(row.versionId);
          return (
            <label
              key={row.versionId}
              className="uboss-pick-row"
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                padding: '10px 4px',
                borderBottom: '1px solid var(--uboss-border, rgba(128,128,128,0.2))',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={isChosen}
                onChange={() => toggle(row.versionId)}
                style={{ marginTop: 4 }}
              />
              <span style={{ flex: 1 }}>
                <b>{row.name}</b> <StatusBadge status={`v${row.versionNumber}`} tone="grey" />{' '}
                <StatusBadge
                  status={
                    row.layer === 'CompanyCustom'
                      ? 'Ours'
                      : row.layer === 'IndustryPack'
                        ? (row.industry ?? 'Pack')
                        : 'UBoss Verified'
                  }
                  tone={row.layer === 'CompanyCustom' ? 'teal' : 'blue'}
                />
                <span className="uboss-muted" style={{ display: 'block', fontSize: 12.5 }}>
                  {row.department ?? '—'}
                  {row.archetype === null ? '' : ` · ${row.archetype}`} · {row.autonomy}
                </span>
                <span className="uboss-muted-3" style={{ display: 'block', fontSize: 12.5 }}>
                  {row.purpose}
                </span>
                {/* Why it would match: the trigger the catalogue wrote for it. */}
                <span className="uboss-muted-3" style={{ display: 'block', fontSize: 12 }}>
                  Use when: {row.whenToUse}
                </span>
              </span>
            </label>
          );
        })}

        {rows !== null && rows.length === 0 ? (
          <p className="uboss-muted" style={{ padding: '14px 4px' }}>
            Nothing matches. Only published Skills this company is entitled to appear here — a draft
            cannot be attached, and an Industry Pack the company does not hold is not shown.
          </p>
        ) : null}
      </div>

      <div className="uboss-actions" style={{ marginTop: 14 }}>
        <Button variant="primary" disabled={!changed || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save attached Skills'}
        </Button>
        <Button disabled={saving} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Drawer>
  );
}
