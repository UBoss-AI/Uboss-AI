'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { AppShell, Banner, Card, CardBody, CardHeader, MASTER_NAV, SkeletonText } from '@uboss/ui';

import { ApiError, authApi, platformApi, type PlatformMe } from '../../lib/api-client';

/**
 * What the console knows about the person using it.
 *
 * Fetched once in the layout and shared, rather than re-fetched per screen: every screen needs to
 * know which actions the caller holds in order to decide whether to render a control, and fifteen
 * screens each asking would be fifteen requests for one answer.
 */
interface MasterContextValue {
  me: PlatformMe | null;
  loading: boolean;
  /** True when this caller may perform `action` on `module`. */
  can: (module: string, action: string) => boolean;
  reload: () => void;
}

const MasterContext = createContext<MasterContextValue>({
  me: null,
  loading: true,
  can: () => false,
  reload: () => undefined,
});

/**
 * Read the console's permission context.
 *
 * `can` is a **rendering** decision, never the enforcement. Every Master Console route carries
 * its own `@RequirePermission` server-side, and hiding a button is a courtesy that stops somebody
 * clicking into a 403 — it is not what stops them doing it. The same standing property as the
 * company navigation since Prompt 7 (UX_MAP defect 7).
 */
export function useMasterConsole(): MasterContextValue {
  return useContext(MasterContext);
}

/**
 * The UBoss Master Console shell.
 *
 * ## Navigation comes from the server
 *
 * The sidebar is `MASTER_NAV` **filtered by** the `navigation` array the API returns, so a module
 * the caller's platform roles do not include is not offered. Two things follow from that being
 * server-driven rather than a local calculation:
 *
 *   * the console cannot drift from what the API enforces, because there is one source; and
 *   * a navigation key with no module mapping is hidden rather than shown, which fails closed —
 *     see `moduleForMasterNavKey` in `@uboss/types`.
 *
 * ## A platform actor with no platform role sees an explanation, not a wall of 403s
 *
 * `platformContext` fails closed as of Prompt 9: no assignment, no permissions. That is correct
 * and would be miserable to debug if the console simply refused everything, so the shell detects
 * the empty case and says what is wrong and who can fix it.
 */
export default function MasterLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [me, setMe] = useState<PlatformMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    platformApi
      .me()
      .then((value) => {
        setMe(value);
        setError(null);
      })
      .catch((caught: unknown) => {
        setMe(null);
        if (
          caught instanceof ApiError &&
          (caught.statusCode === 401 || caught.statusCode === 403)
        ) {
          // 403 here means "not platform staff", which is a different problem from holding no
          // platform role — the shell must not conflate them.
          setError(
            caught.statusCode === 401
              ? 'You are not signed in.'
              : 'The Master Console is for platform staff. Your account is not a platform actor.',
          );
        } else {
          setError(
            caught instanceof ApiError ? caught.message : 'Could not reach the Master Console.',
          );
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  /** `/master/companies/018f…` is still the Companies item. */
  const activeKey = useMemo(() => {
    const segment = pathname.replace(/^\/master\/?/, '').split('/')[0] ?? '';
    return segment || 'dashboard';
  }, [pathname]);

  const visibleKeys = useMemo(() => {
    if (!me) {
      return new Set<string>();
    }
    return new Set(me.navigation.filter((item) => item.visible).map((item) => item.navKey));
  }, [me]);

  const groups = useMemo(
    () =>
      MASTER_NAV.map((group) => ({
        ...group,
        items: group.items.filter((item) => visibleKeys.has(item.key)),
      })).filter((group) => group.items.length > 0),
    [visibleKeys],
  );

  const can = useCallback(
    (module: string, action: string) => (me?.matrix[module] ?? []).includes(action),
    [me],
  );

  const contextValue = useMemo<MasterContextValue>(
    () => ({ me, loading, can, reload: load }),
    [me, loading, can, load],
  );

  const roleLabels = me?.roles.map((role) => role.label).join(' · ');

  return (
    <MasterContext.Provider value={contextValue}>
      <AppShell
        variant="master"
        groups={groups}
        activeKey={activeKey}
        onNavigate={(key) => router.push(`/master/${key}`)}
        user={{
          name: me?.userId ? 'Platform staff' : 'Signing in…',
          role: roleLabels || 'No platform role',
        }}
        scopeLabel={
          roleLabels ? `${roleLabels} · All companies & platform` : 'No platform role assigned'
        }
        onSignOut={() => {
          void authApi.logout().finally(() => window.location.assign('/login'));
        }}
        hasNotifications={false}
      >
        {error ? (
          <Card>
            <CardHeader title="Master Console unavailable" />
            <CardBody>
              <Banner tone="danger">{error}</Banner>
            </CardBody>
          </Card>
        ) : loading && !me ? (
          <Card>
            <CardHeader title="Loading the Master Console" />
            <CardBody>
              <SkeletonText lines={4} />
            </CardBody>
          </Card>
        ) : me && me.roles.length === 0 ? (
          /*
           * The fail-closed case, explained.
           *
           * This account is platform staff and holds no platform role, so it reaches nothing. The
           * screen names the cause and who can fix it rather than showing an empty sidebar and
           * letting the operator conclude the console is broken.
           */
          <Card>
            <CardHeader title="No platform role assigned" />
            <CardBody>
              <Banner tone="warn">
                Your account is platform staff, but holds no platform role — so it currently reaches
                no Master Console module.
              </Banner>
              <p className="uboss-muted-3">
                Platform authority is granted per role (Owner, Admin, Commercial, Support, Security,
                Engineer) rather than being implied by being platform staff. A Platform Owner can
                grant you one from Security &amp; Audit → platform roles. Until then every module
                refuses, which is deliberate: an account that reaches everything because nobody
                chose what it should reach is the thing this design removes.
              </p>
            </CardBody>
          </Card>
        ) : (
          children
        )}
      </AppShell>
    </MasterContext.Provider>
  );
}
