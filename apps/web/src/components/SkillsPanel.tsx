'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  FormField,
  Icon,
  SegmentedControl,
  SkeletonText,
  StatusBadge,
  type DataTableColumn,
} from '@uboss/ui';

import {
  SKILL_AUTONOMY_LABELS,
  SKILL_LAYER_DESCRIPTIONS,
  SKILL_LAYER_LABELS,
  SKILL_STATUS_LABELS,
  SKILL_STATUS_TONES,
  type SkillAutonomy,
  type SkillLayer,
  type SkillStatus,
} from '@uboss/types';

import {
  ApiError,
  skillsApi,
  type SkillImpact,
  type SkillRow,
  type SkillVersionRow,
} from '../lib/api-client';

export interface SkillsPanelProps {
  tenantId: string;
  mayAdminister: boolean;
}

/** The reference's sub-navigation: Library / Governance / Custom skills. */
const TABS = [
  { value: 'library', label: 'Library' },
  { value: 'governance', label: 'Governance' },
  { value: 'custom', label: 'Custom skills' },
];

/**
 * Settings → Skills & AI.
 *
 * ## Matched to the reference's `skills` panel
 *
 * Its sub-navigation (Library / Governance / Custom skills), its table — Skill, Version,
 * Lifecycle, Impact — and its action row. The reference offers *Add skill / Create with UBoss AI /
 * From SOP / Clone*; **Clone** is live here and the other three are shown with what they need,
 * because a button that opens a form the server will refuse is worse than one that says why.
 *
 * The reference's `Corrections` column is not built: corrections are evaluation data, which is
 * Prompt 18's ("saved evaluation cases"), and a column of zeroes would read as "nothing has ever
 * been corrected".
 *
 * ## What this screen is careful never to imply
 *
 * There is **no Templates Library** and no "use this as a starting point". Every row shows its
 * lifecycle status and its layer, a platform Skill is explicitly not editable, and the only path
 * to your own version is **Clone**, which the drawer describes as producing a draft under this
 * company's own approval. That is the locked rule made visible rather than merely obeyed.
 *
 * ## Impact analysis says what it cannot see
 *
 * The upgrade panel shows unknown, not zero, for the three domains whose modules do not exist
 * yet, with a banner saying the analysis is incomplete. An analysis that under-reports is worse
 * than one that admits its limits, because somebody would publish on the strength of it.
 */
export function SkillsPanel({ tenantId, mayAdminister }: SkillsPanelProps) {
  const [tab, setTab] = useState('library');
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [note, setNote] = useState('');
  const [metaNote, setMetaNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [detail, setDetail] = useState<SkillRow | null>(null);
  const [impact, setImpact] = useState<SkillImpact | null>(null);
  const [history, setHistory] = useState<
    { from: string; to: string; reason: string | null; occurredAt: string }[] | null
  >(null);

  const [cloneOf, setCloneOf] = useState<SkillRow | null>(null);
  const [cloneKey, setCloneKey] = useState('');
  const [cloneName, setCloneName] = useState('');

  const [transitionReason, setTransitionReason] = useState('');

  const load = useCallback(() => {
    setError(null);
    void Promise.all([skillsApi.catalogue(tenantId), skillsApi.meta(tenantId)])
      .then(([catalogue, meta]) => {
        setSkills(catalogue.skills);
        setNote(catalogue.note);
        setMetaNote(meta.note);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load the Skills.'),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  const run = useCallback(
    (work: () => Promise<unknown>, success: string) => {
      setBusy(true);
      setError(null);
      void work()
        .then(() => {
          setNotice(success);
          load();
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'That did not work.'),
        )
        .finally(() => setBusy(false));
    },
    [load],
  );

  const openDetail = useCallback(
    (skill: SkillRow) => {
      setDetail(skill);
      setImpact(null);
      setHistory(null);
      setTransitionReason('');

      const version = skill.openDraft ?? skill.publishedVersion;
      if (version) {
        void skillsApi
          .impact(tenantId, version.id)
          .then(setImpact)
          .catch(() => undefined);
        void skillsApi
          .history(tenantId, version.id)
          .then((result) => setHistory(result.transitions))
          .catch(() => undefined);
      }
    },
    [tenantId],
  );

  const rows = (skills ?? []).filter((skill) => {
    if (tab === 'custom') {
      return skill.layer === 'CompanyCustom';
    }
    if (tab === 'governance') {
      // Everything with an open draft: the queue somebody has to move.
      return skill.openDraft !== null;
    }
    return true;
  });

  /** The version a row is really about: the draft if there is one, otherwise the live version. */
  const leading = (skill: SkillRow): SkillVersionRow | null =>
    skill.openDraft ?? skill.publishedVersion ?? skill.versions[0] ?? null;

  const columns: DataTableColumn<SkillRow>[] = [
    {
      key: 'skill',
      header: 'Skill',
      render: (skill) => (
        <>
          <b>{skill.name}</b>
          <br />
          <span className="uboss-mono uboss-muted-3" style={{ fontSize: 11 }}>
            {skill.key}
          </span>
          <br />
          <StatusBadge
            status={SKILL_LAYER_LABELS[skill.layer as SkillLayer] ?? skill.layerLabel}
            tone={skill.layer === 'CompanyCustom' ? 'blue' : 'purple'}
            dot={false}
          />
        </>
      ),
    },
    {
      key: 'version',
      header: 'Version',
      render: (skill) => {
        const version = leading(skill);
        return version === null ? (
          <span className="uboss-muted-3">—</span>
        ) : (
          <>
            v{version.versionNumber}
            {skill.publishedVersion !== null && skill.openDraft !== null ? (
              <>
                <br />
                <span className="uboss-muted-3" style={{ fontSize: 11 }}>
                  v{skill.publishedVersion.versionNumber} is live
                </span>
              </>
            ) : null}
          </>
        );
      },
    },
    {
      key: 'lifecycle',
      header: 'Lifecycle',
      render: (skill) => {
        const version = leading(skill);
        return version === null ? (
          <span className="uboss-muted-3">—</span>
        ) : (
          <StatusBadge
            status={SKILL_STATUS_LABELS[version.status as SkillStatus] ?? version.status}
            tone={SKILL_STATUS_TONES[version.status as SkillStatus] ?? 'grey'}
          />
        );
      },
    },
    {
      key: 'autonomy',
      header: 'Autonomy',
      render: (skill) => {
        const version = leading(skill);
        return version === null ? (
          <span className="uboss-muted-3">—</span>
        ) : (
          <>
            {SKILL_AUTONOMY_LABELS[version.content.autonomy as SkillAutonomy] ??
              version.content.autonomy}
            {version.content.allowedToolCategories.some((category) =>
              [
                'Delete',
                'ExternalBulkSend',
                'SensitiveExport',
                'FinancialChange',
                'ProductionChange',
              ].includes(category),
            ) ? (
              <>
                <br />
                <StatusBadge status="High-risk tools" tone="danger" dot={false} />
              </>
            ) : null}
          </>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      render: (skill) => (
        <span className="uboss-actions">
          <Button variant="ghost" onClick={() => openDetail(skill)}>
            Open
          </Button>
          {mayAdminister ? (
            <Button
              variant="ghost"
              disabled={skill.publishedVersion === null}
              onClick={() => {
                setCloneOf(skill);
                setCloneKey('');
                setCloneName(`${skill.name} (ours)`);
              }}
            >
              Clone
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  if (skills === null) {
    return error === null ? <SkeletonText lines={4} /> : <Banner tone="danger">{error}</Banner>;
  }

  const detailVersion = detail === null ? null : leading(detail);

  return (
    <>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      <Card>
        <CardHeader title="Skill library & governance" />
        <CardBody>
          <SegmentedControl label="Skill views" options={TABS} value={tab} onChange={setTab} />

          <DataTable
            caption="Every Skill this company can use, with its lifecycle status"
            columns={columns}
            rows={rows}
            rowKey={(skill) => skill.id}
            emptyTitle={
              tab === 'custom'
                ? 'No Skills of your own yet'
                : tab === 'governance'
                  ? 'Nothing is waiting'
                  : 'No Skills yet'
            }
            emptyDescription={
              tab === 'custom'
                ? 'Clone a UBoss Verified Skill or an Industry Pack to make a version of your own.'
                : tab === 'governance'
                  ? 'Every Skill is either published or archived. A draft appears here while it is being written, tested or reviewed.'
                  : 'UBoss Verified Skills and Industry Packs appear here once published.'
            }
          />

          <p className="uboss-notice">
            <Icon name="shield" size={14} /> {note}
          </p>

          {/*
            The reference's action row. Clone is live; the other three say what they need, because
            a button that opens a form the server will refuse is worse than one that explains.
          */}
          {mayAdminister ? (
            <>
              <div className="uboss-section-label">Creating a Skill of your own</div>
              <ul className="uboss-muted-3">
                <li>
                  <b>Clone</b> — live. Use the Clone action on any published Skill. The result is a
                  draft under this company&apos;s own approval, with its provenance recorded.
                </li>
                <li>
                  <b>Add skill</b> (manual) and <b>From SOP</b> — the API accepts both today; the
                  authoring form is a long governance document (purpose, when to use, when
                  <i> not </i>to use, inputs, IF/THEN rules, steps, allowed tools, output schema,
                  validation, failure handling, approval, autonomy, evidence) and it is built with
                  the Agent Builder screen that consumes it.
                </li>
                <li>
                  <b>Create with UBoss AI</b> — needs the Model Gateway, which arrives with the AI
                  provider prompts. The creation mode is already recorded on a version, so a
                  reviewer will be able to see that a model drafted it.
                </li>
              </ul>
            </>
          ) : null}

          <p className="uboss-muted-3" style={{ fontSize: 12 }}>
            {metaNote}
          </p>
        </CardBody>
      </Card>

      {/* ---- Detail ---- */}
      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail === null ? '' : detail.name}
      >
        {detail === null || detailVersion === null ? null : (
          <>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Layer</span>
              <span className="uboss-kv-value">{detail.layerLabel}</span>
            </div>
            <p className="uboss-muted-3" style={{ fontSize: 12 }}>
              {SKILL_LAYER_DESCRIPTIONS[detail.layer as SkillLayer]}
            </p>

            {detail.editableHere ? null : (
              <Banner tone="info">
                Published by UBoss. It can be used or cloned here, never edited — a clone has its
                own approval trail, which is what makes it different from copying a template.
              </Banner>
            )}

            <div className="uboss-kv">
              <span className="uboss-kv-key">Version</span>
              <span className="uboss-kv-value">
                v{detailVersion.versionNumber} ·{' '}
                <StatusBadge
                  status={SKILL_STATUS_LABELS[detailVersion.status as SkillStatus]}
                  tone={SKILL_STATUS_TONES[detailVersion.status as SkillStatus]}
                />
                {detailVersion.contentFrozen ? (
                  <>
                    {' '}
                    <StatusBadge status="Content frozen" tone="grey" dot={false} />
                  </>
                ) : null}
              </span>
            </div>

            <div className="uboss-section-label">What it is for</div>
            <p>{detailVersion.content.purpose}</p>

            <div className="uboss-kv">
              <span className="uboss-kv-key">When to use it</span>
              <span className="uboss-kv-value">{detailVersion.content.whenToUse}</span>
            </div>
            <div className="uboss-kv">
              {/* Its own row, because it is the field people skip and the one that stops a Skill
                  being used for the wrong work. */}
              <span className="uboss-kv-key">When not to use it</span>
              <span className="uboss-kv-value">{detailVersion.content.whenNotToUse}</span>
            </div>

            <div className="uboss-section-label">Steps</div>
            <ol>
              {[...detailVersion.content.steps]
                .sort((left, right) => left.order - right.order)
                .map((step) => (
                  <li key={step.order}>{step.instruction}</li>
                ))}
            </ol>

            {detailVersion.content.rules.length === 0 ? null : (
              <>
                <div className="uboss-section-label">Rules</div>
                {detailVersion.content.rules.map((rule, index) => (
                  <div className="uboss-kv" key={index}>
                    <span className="uboss-kv-key">If {rule.when}</span>
                    <span className="uboss-kv-value">then {rule.then}</span>
                  </div>
                ))}
              </>
            )}

            <div className="uboss-section-label">Governance</div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Autonomy</span>
              <span className="uboss-kv-value">
                {SKILL_AUTONOMY_LABELS[detailVersion.content.autonomy as SkillAutonomy]}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Needs approval to run</span>
              <span className="uboss-kv-value">
                {detailVersion.content.requiresApproval ? 'Yes' : 'No'}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Tools it may use</span>
              <span className="uboss-kv-value">
                {detailVersion.content.allowedToolCategories.join(', ') || 'none'}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Evidence it must record</span>
              <span className="uboss-kv-value">{detailVersion.content.evidenceRequirement}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">How it fails</span>
              <span className="uboss-kv-value">{detailVersion.content.failureHandling}</span>
            </div>

            {impact === null ? null : (
              <>
                <div className="uboss-section-label">
                  Impact of publishing v{impact.toVersion}
                  {impact.fromVersion === null ? '' : ` over v${impact.fromVersion}`}
                </div>
                {impact.incomplete ? (
                  <Banner tone="warn">
                    This analysis is incomplete. The domains below marked <i>unknown</i> cannot be
                    counted until the modules that reference a Skill exist — they are reported as
                    unknown rather than zero, because a zero would read as &ldquo;nothing is
                    affected&rdquo;.
                  </Banner>
                ) : null}
                {impact.domains.map((domain) => (
                  <div className="uboss-kv" key={domain.key}>
                    <span className="uboss-kv-key">{domain.label}</span>
                    <span className="uboss-kv-value">
                      {domain.count === null ? (
                        <StatusBadge status="Unknown" tone="warn" dot={false} />
                      ) : (
                        domain.count
                      )}
                      <br />
                      <span className="uboss-muted-3" style={{ fontSize: 11 }}>
                        {domain.detail}
                      </span>
                    </span>
                  </div>
                ))}
              </>
            )}

            {history === null || history.length === 0 ? null : (
              <>
                <div className="uboss-section-label">Governance trail</div>
                {history.map((row, index) => (
                  <div className="uboss-kv" key={index}>
                    <span className="uboss-kv-key">
                      {row.from} → {row.to}
                      {row.reason === null ? null : (
                        <>
                          <br />
                          <span className="uboss-muted-3" style={{ fontSize: 11 }}>
                            {row.reason}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="uboss-kv-value uboss-muted-3">
                      {new Date(row.occurredAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </>
            )}

            {/* The lifecycle actions the **server** says are available for this version. */}
            {detail.editableHere && mayAdminister && detailVersion.nextStatuses.length > 0 ? (
              <>
                <div className="uboss-section-label">Move it on</div>

                {detailVersion.nextStatuses.some((status) =>
                  ['Draft', 'Deprecated', 'Archived'].includes(status),
                ) ? (
                  <FormField
                    label="Reason"
                    hint="Required to send back, deprecate or archive: somebody has to know why."
                  >
                    {(wiring) => (
                      <textarea
                        {...wiring}
                        className="uboss-input"
                        rows={2}
                        value={transitionReason}
                        onChange={(event) => setTransitionReason(event.target.value)}
                      />
                    )}
                  </FormField>
                ) : null}

                <div className="uboss-actions">
                  {detailVersion.nextStatuses.map((status) => {
                    const needsReason = ['Draft', 'Deprecated', 'Archived'].includes(status);
                    return (
                      <Button
                        key={status}
                        variant={status === 'Published' ? 'primary' : 'default'}
                        disabled={busy || (needsReason && transitionReason.trim().length < 5)}
                        onClick={() =>
                          run(
                            () =>
                              skillsApi
                                .transition(tenantId, detailVersion.id, {
                                  to: status,
                                  ...(transitionReason.trim() === ''
                                    ? {}
                                    : { reason: transitionReason.trim() }),
                                })
                                .then(() => setDetail(null)),
                            `Moved to ${SKILL_STATUS_LABELS[status as SkillStatus] ?? status}.`,
                          )
                        }
                      >
                        {SKILL_STATUS_LABELS[status as SkillStatus] ?? status}
                      </Button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </>
        )}
      </Drawer>

      {/* ---- Clone ---- */}
      <Drawer
        open={cloneOf !== null}
        onClose={() => setCloneOf(null)}
        title={cloneOf === null ? '' : `Clone — ${cloneOf.name}`}
      >
        {cloneOf === null ? null : (
          <>
            <Banner tone="info">
              A clone is <b>not</b> a copy that stops mattering. It becomes a Company Custom Skill
              with its own draft, its own approval and a recorded link back to {cloneOf.name} — so
              this catalogue can still answer &ldquo;who cloned this&rdquo;. It starts as a{' '}
              <b>draft</b>: nothing here is live until somebody in this company approves and
              publishes it.
            </Banner>

            <FormField
              label="Handle"
              required
              hint="Lower-kebab, so it can appear in a URL and be typed by a person."
            >
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  value={cloneKey}
                  onChange={(event) => setCloneKey(event.target.value)}
                  placeholder="our-tender-screen"
                />
              )}
            </FormField>

            <FormField label="Name" required>
              {(wiring) => (
                <input
                  {...wiring}
                  className="uboss-input"
                  value={cloneName}
                  onChange={(event) => setCloneName(event.target.value)}
                />
              )}
            </FormField>

            <div className="uboss-actions">
              <Button
                variant="primary"
                disabled={busy || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(cloneKey)}
                onClick={() =>
                  run(
                    () =>
                      skillsApi
                        .clone(tenantId, {
                          sourceSkillId: cloneOf.id,
                          ...(cloneOf.publishedVersion === null
                            ? {}
                            : { sourceVersionId: cloneOf.publishedVersion.id }),
                          key: cloneKey,
                          name: cloneName.trim(),
                        })
                        .then(() => setCloneOf(null)),
                    'Cloned as a draft. Review and approve it before anything uses it.',
                  )
                }
              >
                Clone as a draft
              </Button>
              <Button onClick={() => setCloneOf(null)}>Cancel</Button>
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}
