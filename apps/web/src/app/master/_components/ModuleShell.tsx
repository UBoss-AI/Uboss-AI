'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import { ApiError, platformApi, type ModuleStatusRow } from '../../../lib/api-client';

/**
 * The shell used by the seven Master Console modules this prompt does not build.
 *
 * ## Why one component and not seven near-identical pages
 *
 * The client asked for these as shells. Seven separate files saying the same thing would drift —
 * one would get a stale caption, one would lose its back link — and the interesting content is
 * per-module anyway, so it comes from the API's `module-status` endpoint rather than being copied
 * into each page.
 *
 * ## Why it says what it is blocked on
 *
 * The reference's own stub reads "This Master Console module is wired and permission-scoped. Full
 * tables and controls are built in the next delivery batch." That tells a reader nothing they can
 * act on. Each shell here names the specific thing missing — no payment provider, no AI metering,
 * no provider adapters — and, where some of the module *does* work, says which part and where to
 * find it. A shell that admits what it cannot do is more useful than one that implies it is
 * nearly finished.
 *
 * The navigation item is real and permission-scoped: reaching this screen means the caller's
 * platform role includes `View` on the module, and a role that does not would not see the item.
 */
export function ModuleShell({ navKey, title }: { navKey: string; title: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<ModuleStatusRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    platformApi
      .moduleStatus()
      .then((result) => {
        setStatus(result.modules.find((module) => module.navKey === navKey) ?? null);
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load this module’s status.',
        ),
      )
      .finally(() => setLoading(false));
  }, [navKey]);

  return (
    <>
      <PageHeader
        title={title}
        description="Platform-level administration."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: title },
        ]}
        actions={
          <Button variant="navy" onClick={() => router.push('/master/dashboard')}>
            Master Dashboard
          </Button>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Card>
        <CardHeader title={title} aside={<StatusBadge status="Not built yet" tone="grey" />} />
        <CardBody>
          {loading ? (
            <SkeletonText lines={3} />
          ) : status ? (
            <>
              <div className="uboss-section-label">What this module is waiting for</div>
              <p>{status.blockedOn}</p>

              {status.available ? (
                <>
                  <div className="uboss-section-label">What does work today</div>
                  <Banner tone="info">{status.available}</Banner>
                </>
              ) : null}

              {status.note ? <p className="uboss-muted-3">{status.note}</p> : null}
            </>
          ) : (
            <p className="uboss-muted-3">
              This module is navigable and permission-scoped. Its screens arrive with the prompt
              that owns them.
            </p>
          )}

          <p className="uboss-muted-3">
            The navigation item you followed is real: reaching this screen means your platform role
            includes read access to this module. A role without it would not see the item at all.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
