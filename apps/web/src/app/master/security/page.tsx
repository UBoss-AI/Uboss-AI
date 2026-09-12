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
  MetricCard,
  PageHeader,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import {
  ApiError,
  platformApi,
  type PlatformDashboard,
  type PlatformRoleReview,
  type SecurityEventRow,
} from '../../../lib/api-client';
import { useMasterConsole } from '../layout';
import { severityTone } from '../dashboard/page';

/**
 * Security & Audit.
 *
 * The one Master Console module whose data is entirely **real**. Everything here comes from
 * Prompt 8's append-only, hash-chained trails and from the platform-role table — no seeded
 * figures, so unlike the commercial screens nothing on this one carries a "demo" caveat.
 *
 * ## Three questions, in the order a reviewer asks them
 *
 *  1. **Who holds platform authority?** The access review. This is the question that has had no
 *     answer until this prompt, because platform access was one boolean.
 *  2. **Which platform staff hold nothing?** The row a list of assignments cannot show, and the
 *     most useful one on the screen: those accounts are either an offboarding half-finished or a
 *     person locked out and about to raise a ticket.
 *  3. **What has been happening?** Cross-tenant security events, worst first.
 *
 * ## Reading is separated from granting, deliberately
 *
 * This screen needs `security:Audit`, which **Platform Security** holds — so a security reviewer
 * can see everything and change nothing. Granting a role needs
 * `platform-settings:Administer`, which only **Platform Owner** holds. A reviewer who could also
 * grant would be reviewing their own decisions.
 */
export default function MasterSecurityPage() {
  const router = useRouter();
  const { can } = useMasterConsole();

  const [review, setReview] = useState<PlatformRoleReview | null>(null);
  const [dashboard, setDashboard] = useState<PlatformDashboard | null>(null);
  const [events, setEvents] = useState<SecurityEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void platformApi
      .platformRoles()
      .then(setReview)
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load the platform role review.',
        ),
      );

    // The security KPIs come from the dashboard aggregate rather than a second endpoint: they
    // are the same figures, and computing them twice would let the two screens disagree.
    void platformApi
      .dashboard()
      .then(setDashboard)
      .catch(() => undefined);

    // Cross-tenant security events. A separate call because it needs the platform plane, which
    // is a different controller from the tenant-scoped trail (S-050).
    void fetchPlatformSecurityEvents()
      .then(setEvents)
      .catch(() => setEvents([]));
  }, []);

  useEffect(load, [load]);

  const mayGrant = can('platform-settings', 'Administer');

  const revoke = async (assignmentId: string, label: string) => {
    const reason = window.prompt(`Why is the ${label} role being revoked?`);
    if (reason === null) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await platformApi.revokePlatformRole(assignmentId, reason);
      load();
    } catch (caught) {
      // The interesting failure: revoking the last Platform Owner is refused, because Owner is
      // the only role that can grant roles. The API's message says so in full.
      setError(caught instanceof ApiError ? caught.message : 'Could not revoke that role.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Security & Audit"
        description="Platform security posture and audit."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'Security' },
        ]}
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}
      >
        <MetricCard
          label="Platform authority holders"
          value={dashboard?.securityAttention.platformRoleHolders ?? '—'}
          delta="people with a live platform role"
        />
        <MetricCard
          label="Critical events (30d)"
          value={dashboard?.securityAttention.criticalEventsLast30Days ?? '—'}
          delta="from the append-only trail"
        />
        <MetricCard
          label="Break-glass active"
          value={dashboard?.securityAttention.activeBreakGlassGrants ?? '—'}
          delta="grants in force right now"
        />
        <MetricCard
          label="Customers not notified"
          value={dashboard?.securityAttention.pendingCustomerNotifications ?? '—'}
          delta="outstanding obligation"
        />
      </div>

      {dashboard && dashboard.securityAttention.pendingCustomerNotifications > 0 ? (
        <Banner tone="warn">
          {dashboard.securityAttention.pendingCustomerNotifications} break-glass record(s) have not
          been notified to the affected customer. Suppressing a notification is allowed and requires
          a written reason; leaving it Pending is neither.
        </Banner>
      ) : null}

      <Card>
        <CardHeader
          title="Who holds platform authority"
          aside={<StatusBadge status="Measured" tone="success" />}
        />
        <CardBody>
          {review === null ? (
            <SkeletonText lines={4} />
          ) : review.assignments.length === 0 ? (
            <EmptyState
              title="Nobody holds a platform role"
              description="Every Master Console module would refuse every caller. That is a lockout, not a clean slate."
            />
          ) : (
            <DataTable
              caption="Live platform role assignments"
              columns={[
                {
                  key: 'who',
                  header: 'Person',
                  render: (row) => <span className="uboss-mono">{row.ubossUniqueId}</span>,
                },
                {
                  key: 'role',
                  header: 'Role',
                  render: (row) => (
                    <StatusBadge
                      status={row.label}
                      tone={row.role === 'PlatformOwner' ? 'purple' : 'blue'}
                    />
                  ),
                },
                { key: 'why', header: 'Justification', render: (row) => row.justification ?? '—' },
                {
                  key: 'granted',
                  header: 'Granted by',
                  render: (row) =>
                    row.backfilled ? (
                      // A backfilled grant had no granting human — the Prompt 9 migration
                      // preserved existing access. Flagged so a review narrows it rather than
                      // treating it as a considered decision.
                      <StatusBadge status="Migration backfill" tone="warn" />
                    ) : (
                      <span className="uboss-mono uboss-muted-3">
                        {row.grantedByUserId?.slice(0, 8) ?? '—'}
                      </span>
                    ),
                },
                {
                  key: 'expiry',
                  header: 'Expiry',
                  render: (row) =>
                    row.expiresAt === null ? (
                      'Standing'
                    ) : row.effective ? (
                      new Date(row.expiresAt).toLocaleDateString()
                    ) : (
                      <StatusBadge status="Expired" tone="grey" />
                    ),
                },
                {
                  key: 'actions',
                  header: 'Action',
                  render: (row) =>
                    !mayGrant ? (
                      <span className="uboss-muted-3">—</span>
                    ) : (
                      <Button disabled={busy} onClick={() => void revoke(row.id, row.label)}>
                        Revoke
                      </Button>
                    ),
                },
              ]}
              rows={review.assignments}
              rowKey={(row) => row.id}
            />
          )}

          {!mayGrant ? (
            <Banner tone="info">
              You can review platform authority but not change it. Granting and revoking is held by{' '}
              <b>Platform Owner alone</b> — a reviewer who could also grant would be reviewing their
              own decisions.
            </Banner>
          ) : null}
        </CardBody>
      </Card>

      {review && review.platformActorsWithoutRoles.length > 0 ? (
        <Card>
          <CardHeader
            title="Platform staff who reach nothing"
            aside={<StatusBadge status="Review" tone="warn" />}
          />
          <CardBody>
            <p className="uboss-muted-3">
              These accounts are platform staff and hold no platform role, so every Master Console
              module refuses them. That is either an offboarding half-finished or somebody locked
              out — both worth resolving.
            </p>
            <DataTable
              caption="Platform actors with no platform role"
              columns={[
                { key: 'name', header: 'Person', render: (row) => row.displayName },
                {
                  key: 'id',
                  header: 'UBoss ID',
                  render: (row) => <span className="uboss-mono">{row.ubossUniqueId}</span>,
                },
              ]}
              rows={review.platformActorsWithoutRoles}
              rowKey={(row) => row.userId}
            />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Platform security events"
          aside={<StatusBadge status="Measured" tone="success" />}
        />
        <CardBody>
          {events === null ? (
            <SkeletonText lines={4} />
          ) : events.length === 0 ? (
            <EmptyState
              title="No platform-plane security events"
              description="Tenant-less events — a failed sign-in before a workspace was chosen — appear here."
            />
          ) : (
            <DataTable
              caption="Cross-tenant and tenant-less security events"
              columns={[
                {
                  key: 'severity',
                  header: 'Severity',
                  render: (row) => (
                    <StatusBadge status={row.severity} tone={severityTone(row.severity)} />
                  ),
                },
                { key: 'category', header: 'Category', render: (row) => row.category },
                { key: 'action', header: 'Event', render: (row) => row.action },
                { key: 'outcome', header: 'Outcome', render: (row) => row.outcome },
                {
                  key: 'when',
                  header: 'When',
                  render: (row) => new Date(row.occurredAt).toLocaleString(),
                },
              ]}
              rows={events}
              rowKey={(row) => row.id}
            />
          )}
          <p className="uboss-muted-3">
            These rows are append-only and hash-chained: the application database role cannot update
            or delete one, and any alteration is detectable by recomputing the chain. A
            company&apos;s own trail is separate and is shown on its Company Detail screen.
          </p>
        </CardBody>
      </Card>
    </>
  );
}

/**
 * Cross-tenant security events, from the platform security plane.
 *
 * Not on `platformApi` because it belongs to the Prompt 8 `/platform/security` controller rather
 * than the Master Console one — a separate controller precisely so no tenant-scoped route can
 * reach cross-tenant data by passing a parameter (S-050). Fetched directly here to keep that
 * boundary visible rather than blurring it into the console's own API surface.
 */
async function fetchPlatformSecurityEvents(): Promise<SecurityEventRow[]> {
  const base = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:4000';
  const response = await fetch(`${base}/platform/security/events?limit=25`, {
    credentials: 'include',
  });
  if (!response.ok) {
    return [];
  }
  const body = (await response.json()) as { rows?: SecurityEventRow[] };
  return body.rows ?? [];
}
