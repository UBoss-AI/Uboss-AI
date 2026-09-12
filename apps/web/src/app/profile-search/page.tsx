'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  EmptyState,
  Icon,
  PageHeader,
  SearchField,
  StatusBadge,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  profileSearchApi,
  type MeResponse,
  type PortableProfileView,
  type ProfileSearchMeta,
} from '../../lib/api-client';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/**
 * Portable UBoss Profile Search — Prompt 37A.
 *
 * ## The search box takes one thing
 *
 * A UBoss Unique ID. The placeholder says so, the server refuses anything else with a sentence
 * that says so, and there is deliberately **no** name field, email field or "advanced search" —
 * because a search that accepted those would be a way to enumerate people rather than to verify
 * one. `inputStance` is printed under the box in the server's own words.
 *
 * ## What this screen will not display, because it is never sent
 *
 * No email, no phone, no employee number, no department, no reporting manager, no task, no
 * objective, and never Aadhaar. The page could not show them if somebody wanted it to: the
 * server's projection is a whitelist and the response does not contain them.
 *
 * ## Why performance is sometimes missing, and says so
 *
 * Each employer decides whether its own performance record travels. A company that has not chosen
 * to share shows "This company does not share performance data" rather than an empty panel — an
 * absent number and a zero are different facts about a person's career, and a screen that blurred
 * them would be unfair to them.
 */
function when(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

export default function ProfileSearchPage(): React.JSX.Element {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meta, setMeta] = useState<ProfileSearchMeta | null>(null);
  const [query, setQuery] = useState('');
  const [profile, setProfile] = useState<PortableProfileView | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
  const bell = useNotificationBell(tenantId);

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch(() => window.location.assign('/login'));
  }, []);

  useEffect(() => {
    if (tenantId === null) return;
    profileSearchApi
      .meta(tenantId)
      .then(setMeta)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load profile search.'),
      );
  }, [tenantId]);

  const run = (): void => {
    if (tenantId === null || query.trim() === '') return;
    setSearching(true);
    setError(null);
    setProfile(null);

    profileSearchApi
      .search(tenantId, query.trim())
      .then(setProfile)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'That lookup did not work.'),
      )
      .finally(() => setSearching(false));
  };

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="profile-search"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Profile Search' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="UBoss Profile Search"
        description="Employment verification by UBoss Unique ID."
        breadcrumbs={[{ label: 'UBoss Profile Search' }]}
        actions={
          <Link href="/dashboard">
            <Button size="sm">
              <Icon name="back" size={16} />
              Dashboard
            </Button>
          </Link>
        }
      />

      {error !== null ? <Banner tone="danger">{error}</Banner> : null}

      {meta !== null && !meta.enabled ? (
        <Banner tone="warn">
          Portable profile search is switched off for this company. An administrator can turn it on
          in Settings · Users &amp; Access. It is off until somebody turns it on, because looking
          into other companies’ employment records is a capability a company should choose rather
          than inherit.
        </Banner>
      ) : null}

      <Card>
        <CardBody>
          {/* One field. There is deliberately no name or email search — see the page comment. */}
          <SearchField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') run();
            }}
            placeholder="UB-XXXX-XXXX"
            label="UBoss Unique ID"
          />

          <div className="uboss-actions">
            <Button
              variant="primary"
              disabled={searching || query.trim() === '' || meta?.enabled !== true}
              onClick={run}
            >
              Look up
            </Button>
          </div>

          {meta !== null ? (
            <p className="uboss-muted">
              <small>{meta.inputStance}</small>
            </p>
          ) : null}
        </CardBody>
      </Card>

      {profile === null ? (
        searching ? null : (
          <EmptyState
            icon="users"
            title="Nothing looked up yet"
            description="Enter a UBoss Unique ID. The person can read theirs from their own profile screen."
          />
        )
      ) : (
        <div className="uboss-stack">
          <Card>
            <CardBody>
              <h3>{profile.displayName}</h3>
              <p className="uboss-muted">{profile.ubossUniqueId}</p>
            </CardBody>
          </Card>

          {profile.employments.map((employment) => (
            <Card key={`${employment.companyName}-${employment.joinedOn ?? ''}`}>
              <CardBody>
                <div className="uboss-row uboss-row--between">
                  <div>
                    <h4>{employment.companyName}</h4>
                    <p className="uboss-muted">{employment.designation}</p>
                  </div>
                  <div>
                    {employment.isCurrent ? (
                      <StatusBadge status="Current" tone="success" />
                    ) : (
                      <StatusBadge status="Past" tone="grey" />
                    )}
                  </div>
                </div>

                <p>
                  {when(employment.joinedOn)} — {employment.isCurrent ? 'present' : when(employment.endedAt)}
                </p>

                {employment.performance === null ? (
                  /*
                    Said out loud rather than left blank. An absent number and a zero are
                    different facts about somebody's career, and blurring them would be unfair
                    to the person being verified.
                  */
                  <p className="uboss-muted">
                    <small>This company does not share performance data in portable search.</small>
                  </p>
                ) : (
                  <dl className="uboss-definitions">
                    {employment.performance.badge === null ? null : (
                      <>
                        <dt>Badge</dt>
                        <dd>
                          <StatusBadge status={employment.performance.badge} tone="blue" />
                        </dd>
                      </>
                    )}

                    {employment.performance.score === null ? null : (
                      <>
                        <dt>Score</dt>
                        <dd>{employment.performance.score}</dd>
                      </>
                    )}

                    <dt>Delivered on time</dt>
                    <dd>
                      {employment.performance.onTimePercent === null
                        ? /* Not 0%, which would read as "never on time". */
                          'Nothing with a due date to measure'
                        : `${employment.performance.onTimePercent}%`}
                    </dd>

                    <dt>Approved rewards</dt>
                    <dd>
                      {employment.performance.achievements.count}
                      {employment.performance.achievements.mostRecentAt === null
                        ? ''
                        : `, most recently ${when(employment.performance.achievements.mostRecentAt)}`}
                    </dd>
                  </dl>
                )}
              </CardBody>
            </Card>
          ))}

          {meta !== null ? (
            <p className="uboss-muted">
              <small>{meta.profileStance}</small>
            </p>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}
