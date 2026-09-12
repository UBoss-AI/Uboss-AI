'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  PageHeader,
  StatusBadge,
  type DataTableColumn,
} from '@uboss/ui';

import { TwoStepSignInCard } from '../../components/TwoStepSignInCard';
import { ApiError, authApi, type MeResponse, type SessionRow } from '../../lib/api-client';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/**
 * Active Sessions — every device currently holding a session for the signed-in identity, with
 * per-session revoke and Log Out All Devices.
 *
 * Sessions are server-side and opaque, so revoking one takes effect on that device's very next
 * request. Nothing here can read a session token: the cookie is HttpOnly and the server stores
 * only its hash, so a session is identified by its id alone.
 *
 * The network column shows a coarse hint (a /16 or /48 prefix), never a full client address —
 * enough to recognise "not me", not enough to be a tracking record.
 */
export default function SessionsPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const [me, setMe] = useState<MeResponse | null>(null);
  // Above the signed-out early return: a hook after one runs in a different order on the render
  // that takes it, which React forbids.
  const bell = useNotificationBell(me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);

    try {
      const [identity, list] = await Promise.all([authApi.me(), authApi.sessions()]);
      setMe(identity);
      setSessions(list.sessions);
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 401) {
        setSignedOut(true);
        return;
      }
      setError(cause instanceof ApiError ? cause.message : 'Your sessions could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeOne = async (session: SessionRow) => {
    setBusyId(session.id);
    setNotice(null);

    try {
      await authApi.revokeSession(session.id);

      if (session.isCurrent) {
        // Revoking the session you are using signs this browser out too.
        setSignedOut(true);
        return;
      }

      setNotice('That session was signed out.');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That session could not be revoked.');
    } finally {
      setBusyId(null);
    }
  };

  const logoutEverywhere = async () => {
    setConfirmAll(false);
    setNotice(null);

    try {
      const result = await authApi.logoutAll();
      setNotice(
        result.keptCurrentSession
          ? `${result.revoked} other session(s) were signed out. This device stays signed in.`
          : `${result.revoked} session(s) were signed out.`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Sign-out everywhere failed.');
    }
  };

  if (signedOut) {
    return (
      <main className="uboss-content">
        <Card>
          <CardBody>
            <h1>You are signed out</h1>
            <p className="uboss-notice">
              This device&rsquo;s session has ended. Sign in again to manage your sessions.
            </p>
            <div style={{ marginTop: 14 }}>
              <Button variant="primary" onClick={() => window.location.assign('/login')}>
                Go to sign in
              </Button>
            </div>
          </CardBody>
        </Card>
      </main>
    );
  }

  const columns: DataTableColumn<SessionRow>[] = [
    {
      key: 'device',
      header: 'Device',
      render: (row) => (
        <span className="uboss-stack">
          <b>{row.deviceLabel ?? 'Unrecognised client'}</b>
          {row.isCurrent ? <StatusBadge status="This device" tone="blue" /> : null}
        </span>
      ),
    },
    {
      key: 'network',
      header: 'Network',
      render: (row) => row.clientHint ?? '—',
      width: '160px',
    },
    {
      key: 'lastSeen',
      header: 'Last used',
      render: (row) => formatWhen(row.lastSeenAt),
      width: '190px',
    },
    {
      key: 'expires',
      header: 'Ends by',
      render: (row) => formatWhen(row.absoluteExpiresAt),
      width: '190px',
    },
    {
      key: 'actions',
      header: 'Action',
      width: '130px',
      render: (row) => (
        <Button variant="danger" onClick={() => void revokeOne(row)} disabled={busyId === row.id}>
          {busyId === row.id ? 'Signing out…' : row.isCurrent ? 'Sign out here' : 'Sign out'}
        </Button>
      ),
    },
  ];

  const activeWorkspace = me?.workspaces.find(
    (workspace) => workspace.tenantId === me.activeWorkspaceId,
  );

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? me?.workspaces[0]?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="settings"
      onNavigate={() => undefined}
      {...bell.shellProps}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Login & Security' }}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Login & Security"
        description="How you sign in, and every device currently signed in as you."
        breadcrumbs={[{ label: 'Settings' }, { label: 'Login & Security' }]}
        actions={
          <Button
            variant="danger"
            onClick={() => setConfirmAll(true)}
            disabled={sessions === null || sessions.length === 0}
          >
            Log Out All Devices
          </Button>
        }
      />

      {notice ? (
        <div style={{ marginBottom: 16 }}>
          <Banner tone="ok">{notice}</Banner>
        </div>
      ) : null}

      <div style={{ marginBottom: 16 }}>
        <TwoStepSignInCard />
      </div>

      <Card>
        <CardHeader title="Sessions" />
        <CardBody>
          <p className="uboss-notice">
            Signing a session out takes effect on that device&rsquo;s next request.
          </p>
          <DataTable
            caption="Your active sessions"
            columns={columns}
            rows={sessions ?? []}
            rowKey={(row) => row.id}
            loading={sessions === null && error === null}
            {...(error === null ? {} : { error })}
            onRetry={() => void load()}
            emptyTitle="No active sessions"
            emptyDescription="Nothing is signed in as you right now."
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <p className="uboss-notice">
            Your password is stored only as a one-way hash and is never shown to anyone, including
            your administrator. If you suspect someone else has it, change it from Access Help —
            that signs out every session automatically.
          </p>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={confirmAll}
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => void logoutEverywhere()}
        title="Log out all devices?"
        description="Every other device signed in as you will be signed out immediately. This device stays signed in."
        impact={[
          { label: 'Sessions signed out', value: String(Math.max((sessions?.length ?? 1) - 1, 0)) },
          { label: 'This device', value: 'Stays signed in' },
        ]}
        confirmLabel="Log out all devices"
        destructive
      />
    </AppShell>
  );
}

/** Absolute local time — a session list is a security record, so "2 hours ago" is not enough. */
function formatWhen(iso: string): string {
  const at = new Date(iso);

  return Number.isNaN(at.getTime())
    ? '—'
    : at.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
}
