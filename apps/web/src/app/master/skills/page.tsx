'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  FormField,
  PageHeader,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  platformSkillsApi,
  type PlatformSkillFacets,
  type PlatformSkillRow,
} from '../../../lib/api-client';

/**
 * Skill Catalog — the platform's four hundred governed Skills.
 *
 * ## The two layers are separated because they are different promises
 *
 * A **UBoss Verified** Skill is available to every company: publishing one is a promise to all of
 * them at once. An **Industry Pack** Skill reaches only the companies entitled to that pack, and
 * the row says how many hold it — because "withdraw this pack" and "change this Skill" have very
 * different blast radii, and an operator should be able to see which they are about to do.
 *
 * So the layer is a tab rather than a column filter. A single mixed list would make the two look
 * like one catalogue with a label on it.
 *
 * ## What the filters are, and why they are these
 *
 * The catalogue arrived classified by department (fifty of them) and archetype (twelve) — the
 * dimensions it was written along — and governed by status and autonomy. Those are what somebody
 * looking for a Skill actually has in mind. The filter values and their counts come from the
 * server, so a filter never offers something that would return nothing.
 *
 * ## Autonomy is shown twice, deliberately
 *
 * The enum the product enforces, and beside it the word the source catalogue used. The mapping is
 * lossy and fails closed — "A1 — Read / analyze" and "A2 — Draft / recommend" both become
 * `SuggestOnly` — and showing only the enum would quietly discard a distinction the client drew.
 */

const PAGE_SIZE = 50;

const LAYER_TABS = [
  { key: 'UbossVerified', label: 'UBoss Verified' },
  { key: 'IndustryPack', label: 'Industry Packs' },
] as const;

/** Status is governance, so the tone follows what the status permits rather than looking pretty. */
function statusTone(status: string | null): StatusTone {
  switch (status) {
    case 'Published':
      return 'success';
    case 'Approved':
      return 'blue';
    case 'Draft':
    case 'Test':
    case 'Review':
      return 'warn';
    case 'Deprecated':
    case 'Archived':
      return 'danger';
    default:
      return 'grey';
  }
}

export default function Page() {
  const [layer, setLayer] = useState<string>('UbossVerified');
  const [facets, setFacets] = useState<PlatformSkillFacets | null>(null);
  const [rows, setRows] = useState<PlatformSkillRow[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);

  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [archetype, setArchetype] = useState('');
  const [industry, setIndustry] = useState('');
  const [autonomy, setAutonomy] = useState('');
  const [status, setStatus] = useState('');

  const [selected, setSelected] = useState<PlatformSkillRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    platformSkillsApi
      .facets()
      .then((result) => {
        if (live) setFacets(result);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof ApiError ? cause.message : 'Could not read the filters.');
      });
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await platformSkillsApi.catalogue({
        layer,
        skip,
        take: PAGE_SIZE,
        ...(search === '' ? {} : { search }),
        ...(department === '' ? {} : { department }),
        ...(archetype === '' ? {} : { archetype }),
        ...(industry === '' ? {} : { industry }),
      });
      setRows(result.skills);
      setTotal(result.total);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof ApiError ? cause.message : 'Could not read the catalogue.');
    } finally {
      setLoading(false);
    }
  }, [layer, skip, search, department, archetype, industry]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Autonomy and status narrow what has already been fetched rather than the query.
   *
   * Both live on the version, not the Skill, so filtering them server-side would mean a join per
   * page for two values a reader flips between. The page is fifty rows; narrowing those in the
   * browser is honest as long as the count says what it is counting — which is why the caption
   * below distinguishes "shown" from "matching".
   */
  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          (autonomy === '' || row.autonomy === autonomy) &&
          (status === '' || row.status === status),
      ),
    [rows, autonomy, status],
  );

  const resetPaging = <T,>(set: (value: T) => void) => (value: T) => {
    setSkip(0);
    set(value);
  };

  const autonomyValues = useMemo(
    () => [...new Set(rows.map((row) => row.autonomy).filter((v): v is string => v !== null))].sort(),
    [rows],
  );
  const statusValues = useMemo(
    () => [...new Set(rows.map((row) => row.status).filter((v): v is string => v !== null))].sort(),
    [rows],
  );

  const industriesForLayer = facets?.industries ?? [];

  return (
    <>
      <PageHeader
        title="Skill Catalog"
        description="The governed Skills UBoss publishes. A Verified Skill reaches every company; an Industry Pack reaches only the companies entitled to it."
        breadcrumbs={[{ label: 'Master Console' }, { label: 'Skill Catalog' }]}
      />

      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      <div className="uboss-seg" style={{ marginBottom: 14 }}>
        {LAYER_TABS.map((tab) => {
          const count = facets?.layers.find((row) => row.value === tab.key)?.count ?? null;
          return (
            <button
              key={tab.key}
              type="button"
              className={layer === tab.key ? 'on' : undefined}
              onClick={() => {
                setSkip(0);
                setIndustry('');
                setLayer(tab.key);
              }}
            >
              {tab.label}
              {count === null ? '' : ` · ${count}`}
            </button>
          );
        })}
      </div>

      <Card>
        <CardBody>
          <div className="uboss-grid-3">
            <FormField label="Search" hint="Name or key">
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  type="search"
                  value={search}
                  placeholder="reconciliation, U-001…"
                  onChange={(event) => resetPaging(setSearch)(event.target.value)}
                />
              )}
            </FormField>

            <FormField label="Department">
              {(wiring) => (
                <select
                  {...wiring}
                  className="uboss-input"
                  value={department}
                  onChange={(event) => resetPaging(setDepartment)(event.target.value)}
                >
                  <option value="">All departments</option>
                  {(facets?.departments ?? []).map((row) => (
                    <option key={row.value} value={row.value}>
                      {row.value} ({row.count})
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <FormField label="Archetype">
              {(wiring) => (
                <select
                  {...wiring}
                  className="uboss-input"
                  value={archetype}
                  onChange={(event) => resetPaging(setArchetype)(event.target.value)}
                >
                  <option value="">All archetypes</option>
                  {(facets?.archetypes ?? []).map((row) => (
                    <option key={row.value} value={row.value}>
                      {row.value} ({row.count})
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            {layer === 'IndustryPack' ? (
              <FormField label="Industry">
                {(wiring) => (
                  <select
                    {...wiring}
                    className="uboss-input"
                    value={industry}
                    onChange={(event) => resetPaging(setIndustry)(event.target.value)}
                  >
                    <option value="">All industries</option>
                    {industriesForLayer.map((row) => (
                      <option key={row.value} value={row.value}>
                        {row.value} ({row.count})
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            ) : null}

            <FormField label="Autonomy" hint="On this page">
              {(wiring) => (
                <select
                  {...wiring}
                  className="uboss-input"
                  value={autonomy}
                  onChange={(event) => setAutonomy(event.target.value)}
                >
                  <option value="">Any autonomy</option>
                  {autonomyValues.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              )}
            </FormField>

            <FormField label="Status" hint="On this page">
              {(wiring) => (
                <select
                  {...wiring}
                  className="uboss-input"
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                >
                  <option value="">Any status</option>
                  {statusValues.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          </div>
        </CardBody>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <CardHeader
          title={`${total} ${layer === 'IndustryPack' ? 'Industry Pack' : 'UBoss Verified'} Skill${total === 1 ? '' : 's'}`}
          aside={
            <span className="uboss-muted">
              {loading
                ? 'Loading…'
                : `Showing ${visible.length} of ${rows.length} on this page${
                    visible.length === rows.length ? '' : ' after the page filters'
                  }`}
            </span>
          }
        />
        <CardBody>
          <DataTable
            caption="Every governed Skill UBoss publishes, with the version work would reference"
            rows={visible}
            rowKey={(row) => row.id}
            onRowSelect={(row) => setSelected(row)}
            loading={loading}
            columns={[
              { key: 'name', header: 'Skill', render: (row) => row.name },
              { key: 'key', header: 'Key', render: (row) => <code>{row.key}</code> },
              {
                key: 'department',
                header: 'Department',
                render: (row) => row.department ?? '—',
              },
              { key: 'archetype', header: 'Archetype', render: (row) => row.archetype ?? '—' },
              ...(layer === 'IndustryPack'
                ? [
                    {
                      key: 'industry',
                      header: 'Industry',
                      render: (row: PlatformSkillRow) => row.industry ?? '—',
                    },
                    {
                      key: 'entitled',
                      header: 'Companies',
                      render: (row: PlatformSkillRow) =>
                        row.entitledCompanies < 0 ? 'All' : String(row.entitledCompanies),
                    },
                  ]
                : []),
              {
                key: 'version',
                header: 'Version',
                render: (row) => (row.versionNumber === null ? '—' : `v${row.versionNumber}`),
              },
              {
                key: 'status',
                header: 'Status',
                render: (row) => (
                  <StatusBadge status={row.status ?? 'No version'} tone={statusTone(row.status)} />
                ),
              },
              {
                key: 'autonomy',
                header: 'Autonomy',
                render: (row) => (
                  <span title={row.sourceAutonomy ?? undefined}>{row.autonomy ?? '—'}</span>
                ),
              },
              { key: 'rules', header: 'Rules', render: (row) => String(row.ruleCount) },
            ]}
          />

          {total > PAGE_SIZE ? (
            <div className="uboss-actions" style={{ marginTop: 12 }}>
              <Button disabled={skip === 0 || loading} onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}>
                Previous
              </Button>
              <span className="uboss-muted">
                {skip + 1}–{Math.min(skip + PAGE_SIZE, total)} of {total}
              </span>
              <Button
                disabled={skip + PAGE_SIZE >= total || loading}
                onClick={() => setSkip(skip + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? 'Skill'}
      >
        {selected === null ? null : (
          <>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Key</span>
              <span className="uboss-kv-value">
                <code>{selected.key}</code>
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Layer</span>
              <span className="uboss-kv-value">{selected.layer}</span>
            </div>
            {selected.industry === null ? null : (
              <div className="uboss-kv">
                <span className="uboss-kv-key">Industry</span>
                <span className="uboss-kv-value">{selected.industry}</span>
              </div>
            )}
            <div className="uboss-kv">
              <span className="uboss-kv-key">Department</span>
              <span className="uboss-kv-value">{selected.department ?? '—'}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Archetype</span>
              <span className="uboss-kv-value">{selected.archetype ?? '—'}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Category</span>
              <span className="uboss-kv-value">{selected.category ?? '—'}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Version</span>
              <span className="uboss-kv-value">
                {selected.versionNumber === null ? '—' : `v${selected.versionNumber}`} ·{' '}
                {selected.status ?? 'No version'}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Autonomy</span>
              <span className="uboss-kv-value">
                {selected.autonomy ?? '—'}
                {selected.sourceAutonomy === null ? '' : ` (catalogue: ${selected.sourceAutonomy})`}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">IF/THEN rules</span>
              <span className="uboss-kv-value">{selected.ruleCount}</span>
            </div>

            <p className="uboss-notice-min" style={{ marginTop: 14 }}>
              {selected.purpose ?? 'This Skill has no published version.'}
            </p>

            <Banner tone="info">
              A published version is immutable. Changing this Skill creates a new draft that must
              be approved before any work references it, and agents stay on the version they were
              pinned to until somebody upgrades them.
            </Banner>
          </>
        )}
      </Drawer>
    </>
  );
}
