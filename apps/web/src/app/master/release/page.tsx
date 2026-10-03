'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  FormField,
  Modal,
  PageHeader,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import { ApiError, platformApi, type FeatureFlagRow } from '../../../lib/api-client';
import { useMasterConsole } from '../layout';

/**
 * Release & Feature Control.
 *
 * The reference's columns — Flag, Stage, Audience, State — plus the rollout percentage and how
 * many companies are explicitly enabled, because a flag's *state* alone does not tell you
 * whether it is actually on for anybody.
 *
 * ## Owner-only, and that is the point of the module
 *
 * `release:Administer` is held by **Platform Owner alone**. A feature flag decides what the
 * product is for every customer at once, which is a categorically different decision from
 * administering one company — so it is separated from `PlatformAdmin`, who can do almost
 * everything else. Somebody with a lesser role sees this screen read-only, with the reason
 * stated rather than the controls silently missing.
 *
 * ## Two combinations the system refuses
 *
 * Both are visible here because an operator will try them:
 *
 *   * A **paused flag with a live rollout percentage** — refused by a database check constraint.
 *     The state and the percentage would disagree about whether the feature is on, and whichever
 *     the consuming code read first would decide.
 *   * An **Active flag at 0% with no enabled companies** — refused by the service. It is off in
 *     effect but reads as on, which is how a feature comes to be believed live.
 */
const EMPTY_FLAG = { key: '', description: '', audience: '', rationale: '' };

export default function MasterReleasePage() {
  const router = useRouter();
  const { can } = useMasterConsole();

  const [flags, setFlags] = useState<FeatureFlagRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newFlagOpen, setNewFlagOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_FLAG);

  const load = useCallback(() => {
    platformApi
      .featureFlags()
      .then((result) => setFlags(result.flags))
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load feature flags.'),
      );
  }, []);

  useEffect(load, [load]);

  const mayControl = can('release', 'Administer');

  /**
   * Pause a flag.
   *
   * The *safe* direction, and the one an operator reaches for during an incident: a single
   * decision, one click and a reason. Turning a flag on is the deliberate one — a stage, an
   * audience and a percentage — and it stays a separate act with its own record.
   *
   * Creating a flag now lives in the dialog below. It arrives off, so nothing about the care
   * around turning one on has changed.
   */
  const pause = async (flag: FeatureFlagRow) => {
    const reason = window.prompt(`Why is ${flag.key} being paused?`);
    if (!reason) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The rollout goes to 0 in the same call: the database refuses a paused flag that still
      // carries a percentage, so sending the state alone would be rejected.
      await platformApi.updateFeatureFlag(flag.key, {
        state: 'Paused',
        rolloutPercent: 0,
        reason,
      });
      load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not pause that flag.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Release & Feature Control"
        description="Feature flags and staged rollout."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'Release' },
        ]}
        actions={
          mayControl ? (
            <Button variant="navy" icon="plus" onClick={() => setNewFlagOpen(true)}>
              New flag
            </Button>
          ) : undefined
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {!mayControl ? (
        <Banner tone="info">
          Read-only for your role. Controlling a release is held by <b>Platform Owner alone</b>,
          because a flag changes the product for every customer at once — a different decision from
          administering one company.
        </Banner>
      ) : null}

      <Card>
        <CardHeader title="Feature flags" />
        <CardBody>
          {flags === null ? (
            <SkeletonText lines={4} />
          ) : flags.length === 0 ? (
            <EmptyState
              title="No feature flags"
              description="A new flag starts in Dev, Paused, at 0% — it cannot be created already live."
            />
          ) : (
            <DataTable
              caption="Feature flags and their rollout"
              columns={[
                {
                  key: 'flag',
                  header: 'Flag',
                  render: (row) => (
                    <>
                      <b className="uboss-mono">{row.key}</b>
                      {row.description ? (
                        <>
                          <br />
                          <small className="uboss-muted-3">{row.description}</small>
                        </>
                      ) : null}
                    </>
                  ),
                },
                { key: 'stage', header: 'Stage', render: (row) => row.stage },
                { key: 'audience', header: 'Audience', render: (row) => row.audience },
                {
                  key: 'rollout',
                  header: 'Rollout',
                  render: (row) =>
                    row.enabledCompanies > 0
                      ? `${row.rolloutPercent}% + ${row.enabledCompanies} named`
                      : `${row.rolloutPercent}%`,
                },
                {
                  key: 'state',
                  header: 'State',
                  render: (row) => (
                    <StatusBadge status={row.state} tone={flagStateTone(row.state)} />
                  ),
                },
                {
                  key: 'actions',
                  header: 'Action',
                  render: (row) =>
                    !mayControl ? (
                      <span className="uboss-muted-3">—</span>
                    ) : row.state === 'Active' ? (
                      <Button disabled={busy} onClick={() => void pause(row)}>
                        Pause
                      </Button>
                    ) : (
                      <span className="uboss-muted-3">—</span>
                    ),
                },
              ]}
              rows={flags}
              rowKey={(row) => row.id}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Rules this module enforces" />
        <CardBody>
          <ul>
            <li>
              A new flag is created <b>Dev · Paused · 0%</b> and cannot be created live. Turning it
              on is a separate, separately audited decision.
            </li>
            <li>
              A <b>paused flag cannot carry a rollout percentage</b> — refused by a database check
              constraint, because the state and the percentage would disagree about whether the
              feature is on.
            </li>
            <li>
              An <b>Active flag at 0% with no named companies</b> is refused: it is off in effect
              and reads as on, which is how a feature comes to be believed live.
            </li>
            <li>
              Every change requires a <b>reason</b>, recorded in the platform audit trail and as a
              security event. A rollout nobody can explain during an incident is the problem this
              prevents.
            </li>
          </ul>
        </CardBody>
      </Card>
      {/*
        Writing a flag, on the screen that lists them.

        The button was disabled with the tooltip "Flag authoring is a later prompt" — a note from
        the build plan, shown to an operator, about a route that has existed and worked the whole
        time. `POST /platform/console/feature-flags` validates the key, refuses a duplicate and
        writes the audit row.

        A new flag arrives **off**. That is not a shortcut around the stage-and-percentage form the
        old comment described: a flag is created so that code can refer to it, and turning it on is
        a separate, deliberate act with its own reason — which is exactly the shape the update
        route already enforces.
      */}
      <Modal
        open={newFlagOpen}
        onClose={() => setNewFlagOpen(false)}
        title="New feature flag"
        footer={
          <>
            <Button onClick={() => setNewFlagOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || draft.key.trim() === '' || draft.rationale.trim() === ''}
              onClick={() => {
                setBusy(true);
                setError(null);
                platformApi
                  .createFeatureFlag({
                    key: draft.key.trim(),
                    ...(draft.description.trim() === ''
                      ? {}
                      : { description: draft.description.trim() }),
                    ...(draft.audience.trim() === '' ? {} : { audience: draft.audience.trim() }),
                    rationale: draft.rationale.trim(),
                  })
                  .then(() => {
                    setNewFlagOpen(false);
                    setDraft(EMPTY_FLAG);
                    load();
                  })
                  .catch((caught: unknown) =>
                    setError(
                      caught instanceof ApiError ? caught.message : 'Could not create that flag.',
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Create flag
            </Button>
          </>
        }
      >
        <FormField
          label="Key"
          required
          hint="Lower case letters, digits and hyphens. This is what the code checks, so it cannot be changed later."
        >
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input uboss-mono"
              value={draft.key}
              onChange={(event) => setDraft({ ...draft, key: event.target.value })}
              placeholder="workshop-chat-v2"
            />
          )}
        </FormField>

        <FormField label="What it controls">
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          )}
        </FormField>

        <FormField label="Audience" hint="Who it is for, when it is turned on. Optional.">
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={draft.audience}
              onChange={(event) => setDraft({ ...draft, audience: event.target.value })}
            />
          )}
        </FormField>

        <FormField
          label="What removing it would mean"
          required
          hint="Asked now, while the answer is still known. A flag with no stated purpose is the one nobody dares delete."
        >
          {(wiring) => (
            <textarea
              {...wiring}
              className="uboss-input"
              rows={3}
              value={draft.rationale}
              onChange={(event) => setDraft({ ...draft, rationale: event.target.value })}
            />
          )}
        </FormField>

        <p className="uboss-notice">
          The flag is created <b>off</b>. Turning it on is a separate decision with its own stage,
          audience and percentage — and its own reason in the trail.
        </p>
      </Modal>
    </>
  );
}

/** `InReview` is blue rather than amber: being reviewed is not a warning. */
function flagStateTone(state: string): 'success' | 'blue' | 'grey' {
  return state === 'Active' ? 'success' : state === 'InReview' ? 'blue' : 'grey';
}
