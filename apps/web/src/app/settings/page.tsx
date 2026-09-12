'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  FormField,
  PageHeader,
  SETTINGS_SECTIONS,
  SettingsShell,
  SkeletonText,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import { ConnectionsPanel } from '../../components/ConnectionsPanel';
import { NotificationPreferences } from '../../components/NotificationPreferences';
import { SkillsPanel } from '../../components/SkillsPanel';
import {
  ApiError,
  authApi,
  settingsApi,
  type MeResponse,
  type ResolvedSetting,
  type SettingsView,
} from '../../lib/api-client';
import { CreditsPanel } from './CreditsPanel';
import { KnowledgeAndDataPanel } from './KnowledgeAndDataPanel';
import { MemoryAndFeedbackPanel } from './MemoryAndFeedbackPanel';
import { SecurityCenterPanel } from './SecurityCenterPanel';
import { SupportPanel } from './SupportPanel';
import { TokensAndCostPanel } from './TokensAndCostPanel';

import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/** The source badge. A default is not a decision, and the screen must not imply it was. */
function sourceTone(source: string): StatusTone {
  return source === 'company' ? 'success' : source === 'platform' ? 'blue' : 'grey';
}

function sourceLabel(source: string): string {
  return source === 'company'
    ? 'Set by this company'
    : source === 'platform'
      ? 'Platform default'
      : 'Default';
}

/**
 * Company Settings — the full information architecture, with left navigation and a right panel.
 *
 * ## Matched to the reference
 *
 * `SettingsShell` is the Prompt 2 primitive built from `index.html`: left settings navigation,
 * right detail panel, which is a locked UI rule. The section list is `SETTINGS_SECTIONS` — the
 * client's **19** categories in the approved order, including the two later amendments (UBoss
 * Profile Search Policy and Performance & Reward Policy) that the original Prompt 14 list of 17
 * predates. The personal labels (My Profile, Login & Security, My Connections, My Agent
 * Preferences) are used for a caller who cannot administer, per the reference.
 *
 * ## Every category is shown; the server decides what is inside
 *
 * A category the caller may not read comes back withheld, and the banner says **how many** —
 * because a shorter sidebar with no explanation reads as a bug rather than as a permission
 * boundary. A category with no settings of its own shows where its configuration actually lives
 * ("Managed on Settings → Users & Access") instead of an empty panel.
 *
 * ## Authorization is not the sidebar
 *
 * `editable` comes from the server, per setting, and the write path checks again. Disabling a
 * control here is a courtesy; hiding a category is not the enforcement.
 *
 * ## The unsaved-change warning
 *
 * A dirty panel blocks navigation between categories and warns on page close. Settings are the
 * screen people edit and then get distracted on, and losing a half-typed governance change with
 * no warning is the kind of small betrayal that makes people distrust a tool.
 */
export default function CompanySettingsPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const router = useRouter();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [active, setActive] = useState('general');
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({});
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<{
    key: string;
    changes: {
      previousValue: string | null;
      newValue: string;
      reason: string;
      changedAt: string;
    }[];
  } | null>(null);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const bell = useNotificationBell(tenantId);

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your workspaces.'),
      );
  }, []);

  const load = useCallback(() => {
    if (!tenantId) {
      return;
    }
    settingsApi
      .view(tenantId)
      .then((result) => {
        setView(result);
        setDraft({});
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load Settings.'),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  const dirty = Object.keys(draft).length > 0;

  // The browser-level half of the unsaved-change warning. The in-app half is the guard on
  // switching categories, below — a browser dialog cannot be shown for an in-app navigation.
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const category = useMemo(
    () => view?.categories.find((candidate) => candidate.key === active) ?? null,
    [active, view],
  );

  /** Only the categories the server returned — a withheld one is not in the sidebar either. */
  const sections = useMemo(() => {
    const permitted = new Set((view?.categories ?? []).map((candidate) => candidate.key));
    return SETTINGS_SECTIONS.filter((section) => permitted.has(section.key));
  }, [view]);

  const mayAdministerAnything = (view?.categories ?? []).some((candidate) => candidate.anyEditable);

  const materialDirty = useMemo(
    () =>
      (category?.settings ?? []).some(
        (setting) => setting.material && draft[setting.key] !== undefined,
      ),
    [category, draft],
  );

  const save = useCallback(() => {
    if (!tenantId) {
      return;
    }
    setSaving(true);
    setError(null);

    settingsApi
      .update(tenantId, {
        values: draft,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      })
      .then(() => {
        setNotice('Saved.');
        setReason('');
        load();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not save those settings.'),
      )
      .finally(() => setSaving(false));
  }, [draft, load, reason, tenantId]);

  const switchCategory = useCallback(
    (key: string) => {
      if (
        dirty &&
        !window.confirm(
          'You have unsaved changes on this panel. Leaving now discards them. Continue?',
        )
      ) {
        return;
      }
      setDraft({});
      setReason('');
      setHistory(null);
      setActive(key);
    },
    [dirty],
  );

  const control = (setting: ResolvedSetting) => {
    const current = draft[setting.key] ?? setting.value;

    if (setting.type.kind === 'boolean') {
      return (
        <label className="uboss-checkbox">
          <input
            type="checkbox"
            checked={Boolean(current)}
            disabled={!setting.editable}
            onChange={(event) => setDraft({ ...draft, [setting.key]: event.target.checked })}
          />
          <span>{setting.label}</span>
        </label>
      );
    }

    return (
      <FormField label={setting.label} hint={setting.description}>
        {(wiring) =>
          setting.type.kind === 'enum' ? (
            <select
              {...wiring}
              className="uboss-input"
              value={String(current)}
              disabled={!setting.editable}
              onChange={(event) => setDraft({ ...draft, [setting.key]: event.target.value })}
            >
              {setting.type.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : setting.type.kind === 'integer' ? (
            <input
              {...wiring}
              className="uboss-input uboss-mono"
              inputMode="numeric"
              value={String(current)}
              disabled={!setting.editable}
              onChange={(event) => setDraft({ ...draft, [setting.key]: event.target.value })}
            />
          ) : (
            <input
              {...wiring}
              className="uboss-input"
              value={String(current)}
              disabled={!setting.editable}
              onChange={(event) => setDraft({ ...draft, [setting.key]: event.target.value })}
            />
          )
        }
      </FormField>
    );
  };

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
  const activeSection = SETTINGS_SECTIONS.find((section) => section.key === active);

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="settings"
      onNavigate={() => undefined}
      {...bell.shellProps}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Settings' }}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Settings"
        description="Company configuration, scoped to what your role permits."
        breadcrumbs={[{ label: 'Settings' }, { label: activeSection?.label ?? '' }]}
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      {!view ? (
        <Card>
          <CardBody>
            <SkeletonText lines={8} />
          </CardBody>
        </Card>
      ) : (
        <>
          {view.withheldCategories > 0 ? (
            <Banner tone="info">
              {view.withheldCategories} categor
              {view.withheldCategories === 1 ? 'y is' : 'ies are'} not shown because your role
              cannot read {view.withheldCategories === 1 ? 'it' : 'them'}. Every setting carries its
              own permission and the server enforces it — a shorter list here is a permission
              boundary, not a missing feature.
            </Banner>
          ) : null}

          <SettingsShell
            sections={sections}
            activeKey={active}
            onSelect={switchCategory}
            // The reference's personal labels for a caller who administers nothing.
            personalLabels={!mayAdministerAnything}
          >
            <Card>
              <CardHeader
                title={activeSection?.label ?? ''}
                aside={
                  category?.anyEditable ? null : <StatusBadge status="Read only" tone="grey" />
                }
              />
              <CardBody>
                <p className="uboss-muted-3">{activeSection?.description}</p>

                {/* Tokens & Cost is the reference's `setTokens()`: a bespoke panel rather than
                    a list of generic setting controls — an allowance bar, the per-level budgets
                    and the credit history. Rendered above whatever generic settings the
                    category also carries. */}
                {active === 'tokens' && <TokensAndCostPanel tenantId={tenantId} />}
                {/* Prompt 31 sits under the budget rather than on its own screen: the
                    reference's Tokens & Cost card already offers Request top-up, Reallocate and
                    Credit history, and a second screen would be a second place a reader looks
                    for the same subject. */}
                {active === 'tokens' && <CreditsPanel tenantId={tenantId} />}

                {category === null ? (
                  <SkeletonText lines={3} />
                ) : category.settings.length === 0 ? (
                  <Banner tone="info">
                    {category.note ??
                      'Nothing is configured in this category yet. It appears here because the ' +
                        'full settings structure is fixed; its controls arrive with the prompt ' +
                        'that owns them.'}
                  </Banner>
                ) : (
                  <>
                    {category.settings.map((setting) => (
                      <div key={setting.key} style={{ marginBottom: 18 }}>
                        {control(setting)}
                        <div className="uboss-actions" style={{ marginTop: 6 }}>
                          <StatusBadge
                            status={sourceLabel(setting.source)}
                            tone={sourceTone(setting.source)}
                          />
                          {setting.material ? (
                            <>
                              <StatusBadge status="Governance" tone="purple" />
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  if (!tenantId) {
                                    return;
                                  }
                                  settingsApi
                                    .history(tenantId, setting.key)
                                    .then(setHistory)
                                    .catch((caught: unknown) =>
                                      setError(
                                        caught instanceof ApiError
                                          ? caught.message
                                          : 'Could not load the history.',
                                      ),
                                    );
                                }}
                              >
                                Change history
                              </Button>
                            </>
                          ) : null}
                          {setting.source !== 'default' &&
                          String(setting.value) !== String(setting.defaultValue) ? (
                            <span className="uboss-muted-3" style={{ fontSize: 12 }}>
                              Default is {String(setting.defaultValue)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}

                    {materialDirty ? (
                      <FormField
                        label="Why is this changing?"
                        required
                        hint="Required for a governance setting, and kept in its change history."
                      >
                        {(wiring) => (
                          <textarea
                            {...wiring}
                            className="uboss-input"
                            rows={2}
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                          />
                        )}
                      </FormField>
                    ) : null}

                    {dirty ? (
                      <Banner tone="warn">
                        You have unsaved changes on this panel. Leaving without saving discards
                        them.
                      </Banner>
                    ) : null}

                    <div className="uboss-actions">
                      <Button
                        variant="primary"
                        disabled={!dirty || saving || (materialDirty && reason.trim().length < 5)}
                        onClick={save}
                      >
                        {saving ? 'Saving…' : 'Save changes'}
                      </Button>
                      <Button
                        disabled={!dirty || saving}
                        onClick={() => {
                          setDraft({});
                          setReason('');
                        }}
                      >
                        Discard
                      </Button>
                    </div>
                  </>
                )}

                {history !== null ? (
                  <Card>
                    <CardHeader
                      title={`Change history — ${history.key}`}
                      aside={
                        <Button variant="ghost" onClick={() => setHistory(null)}>
                          Close
                        </Button>
                      }
                    />
                    <CardBody>
                      <DataTable
                        caption="Every change to this governance setting, newest first"
                        columns={[
                          {
                            key: 'when',
                            header: 'When',
                            render: (row) => new Date(row.changedAt).toLocaleString(),
                          },
                          {
                            key: 'from',
                            header: 'From',
                            render: (row) => row.previousValue ?? 'the default',
                          },
                          { key: 'to', header: 'To', render: (row) => row.newValue },
                          { key: 'why', header: 'Why', render: (row) => row.reason },
                        ]}
                        rows={history.changes}
                        rowKey={(row) => row.changedAt}
                        emptyTitle="No changes yet"
                        emptyDescription="This setting still has its inherited value."
                      />
                    </CardBody>
                  </Card>
                ) : null}

                {/*
                  Personal notification preferences sit in this category because the reference
                  puts the Digest and Acknowledgement controls here, alongside the company's
                  alert and escalation-chain configuration. Somebody looking for "how often do I
                  hear about this" looks where the alerts are described.
                */}
                {/*
                  Integrations & Connections lives in its own category, matching the reference's
                  `setIntegrations()` panel. The company-level actions appear only when the server
                  says this caller may administer — and the server refuses them regardless.
                */}
                {/*
                  Skills & AI, matching the reference panel. A platform Skill is shown as not
                  editable here; the only path to your own version is Clone.
                */}
                {active === 'skills' && tenantId !== null ? (
                  <SkillsPanel tenantId={tenantId} mayAdminister={mayAdministerAnything} />
                ) : null}

                {active === 'integrations' && tenantId !== null ? (
                  <ConnectionsPanel
                    tenantId={tenantId}
                    mayAdminister={category?.anyEditable ?? mayAdministerAnything}
                  />
                ) : null}

                {active === 'notifications' && tenantId !== null ? (
                  <NotificationPreferences tenantId={tenantId} />
                ) : null}

                {/* The two categories that are real screens elsewhere, linked rather than duplicated. */}
                {active === 'users' ? (
                  <div className="uboss-actions">
                    <Button variant="navy" onClick={() => router.push('/settings/users')}>
                      Open Users &amp; Access
                    </Button>
                  </div>
                ) : null}
                {active === 'billing' ? (
                  <div className="uboss-actions">
                    <Button variant="navy" onClick={() => router.push('/settings/billing')}>
                      Open Billing
                    </Button>
                  </div>
                ) : null}
                {active === 'agent' ? <MemoryAndFeedbackPanel tenantId={tenantId} /> : null}
                {active === 'knowledge' ? <KnowledgeAndDataPanel tenantId={tenantId} /> : null}
                {active === 'organization' ? (
                  <div className="uboss-actions">
                    <Button variant="navy" onClick={() => router.push('/hierarchy')}>
                      Open the Organization Hierarchy
                    </Button>
                  </div>
                ) : null}
                {active === 'audit' ? (
                  <div className="uboss-actions">
                    <Button variant="navy" onClick={() => router.push('/internal/audit')}>
                      Open the audit trail
                    </Button>
                  </div>
                ) : null}
                {active === 'security' ? (
                  <>
                    {/* The company's posture. "Login & Security" below it is the *person's* own
                        settings — their factors and their devices — which is a different
                        question from the company's security history and stays a separate
                        screen. */}
                    <SecurityCenterPanel tenantId={tenantId} />
                    {/* Prompt 36. On the Security screen rather than a category of its own: a
                        company authorizing UBoss to enter their workspace is a security decision,
                        and the approved sidebar has no Support category. */}
                    <SupportPanel tenantId={tenantId} />
                    <div className="uboss-actions">
                      <Button variant="navy" onClick={() => router.push('/sessions')}>
                        Open my own Login &amp; Security
                      </Button>
                    </div>
                  </>
                ) : null}
              </CardBody>
            </Card>
          </SettingsShell>
        </>
      )}
    </AppShell>
  );
}
