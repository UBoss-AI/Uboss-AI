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
  PageHeader,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import { ApiError, formatMinor, platformApi, type PlanRow } from '../../../lib/api-client';
import { useMasterConsole } from '../layout';
import { planTone } from '../companies/page';

/**
 * Plans & Entitlements.
 *
 * The reference's columns — Plan, Seats, Modules, AI allowance, Price / mo — plus two the
 * reference does not have and this screen needs:
 *
 *   * **Subscribers**, because a plan with companies on it cannot be retired, and an operator
 *     about to try should be able to see why before the API refuses.
 *   * **Active**, because retiring a plan is not deleting it: the companies on it keep their
 *     entitlements and the plan simply stops being available for a new one.
 *
 * ## Money is displayed here and stored elsewhere
 *
 * The API sends integers in minor units and this screen formats them. That split is deliberate:
 * a float would lose precision on the way through JSON, and the reader's locale is a
 * presentation concern. `null` renders as "Custom" rather than as a zero — the reference's
 * Enterprise row is exactly this case, and an Enterprise plan with a negotiated price is not
 * free.
 */
export default function MasterPlansPage() {
  const router = useRouter();
  const { can } = useMasterConsole();

  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeRetired, setIncludeRetired] = useState(false);

  const load = useCallback(() => {
    platformApi
      .plans(includeRetired)
      .then((result) => setPlans(result.plans))
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load plans.'),
      );
  }, [includeRetired]);

  useEffect(load, [load]);

  const mayAdminister = can('plans', 'Administer');

  return (
    <>
      <PageHeader
        title="Plans & Entitlements"
        description="Commercial plans and module entitlements."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'Plans' },
        ]}
        actions={
          <>
            <Button onClick={() => setIncludeRetired((value) => !value)}>
              {includeRetired ? 'Active plans only' : 'Include retired'}
            </Button>
            {mayAdminister ? (
              <Button variant="navy" icon="plus" disabled title="Plan authoring is a later prompt.">
                New plan
              </Button>
            ) : null}
          </>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {!mayAdminister ? (
        <Banner tone="info">
          You can read plans but not change them. Administering plans is held by Platform Owner,
          Platform Admin and Platform Commercial.
        </Banner>
      ) : null}

      <Card>
        <CardHeader title="Plans" aside={<StatusBadge status="Configured" tone="blue" />} />
        <CardBody>
          {plans === null ? (
            <SkeletonText lines={4} />
          ) : (
            <DataTable
              caption="Commercial plans and what each entitles"
              columns={[
                {
                  key: 'plan',
                  header: 'Plan',
                  render: (row) => (
                    <>
                      <b>{row.name}</b>
                      <br />
                      <small className="uboss-muted-3 uboss-mono">{row.code}</small>
                    </>
                  ),
                },
                {
                  key: 'tier',
                  header: 'Tier',
                  render: (row) => <StatusBadge status={row.tier} tone={planTone(row.tier)} />,
                },
                {
                  key: 'seats',
                  header: 'Seats',
                  // The reference shows "Custom" for Enterprise. A null seat limit means
                  // negotiated per company and read from the subscription.
                  render: (row) => row.seatLimit ?? 'Custom',
                },
                {
                  key: 'modules',
                  header: 'Modules',
                  render: (row) => (
                    <span title={row.entitledModules.join(', ')}>
                      {row.entitledModules.length} module(s)
                    </span>
                  ),
                },
                {
                  key: 'allowance',
                  header: 'AI allowance',
                  render: (row) =>
                    row.aiAllowanceMinor === null
                      ? 'Custom'
                      : formatMinor(row.aiAllowanceMinor, row.currency),
                },
                {
                  key: 'price',
                  header: 'Price / mo',
                  render: (row) =>
                    row.priceMinor === null ? 'Custom' : formatMinor(row.priceMinor, row.currency),
                },
                {
                  key: 'subscribers',
                  header: 'Companies',
                  render: (row) => row.subscribers,
                  numeric: true,
                },
                {
                  key: 'active',
                  header: 'State',
                  render: (row) =>
                    row.active ? (
                      <StatusBadge status="Active" tone="success" />
                    ) : (
                      <StatusBadge status="Retired" tone="grey" />
                    ),
                },
              ]}
              rows={plans}
              rowKey={(row) => row.id}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="How entitlements resolve" />
        <CardBody>
          {/*
            Worth stating on the screen rather than only in the API: two columns that can disagree
            need a visible precedence, and an operator debugging "why can this company not see
            Reports" needs the order in front of them.
          */}
          <ol>
            <li>The plan&apos;s entitled modules are the starting point.</li>
            <li>
              A company&apos;s <b>extra modules</b> are added on top — the reference&apos;s
              &quot;Master extras&quot;.
            </li>
            <li>
              A company&apos;s <b>withheld modules</b> are removed, and{' '}
              <b>withheld wins over extra</b>: an entitlement explicitly taken away must not be
              restorable by also being listed as an extra.
            </li>
          </ol>
          <p className="uboss-muted-3">
            A plan cannot entitle a platform module. A plan sells a company access to company
            modules; naming <code>platform-settings</code> in one would be selling access to the
            platform&apos;s own control plane, so the API refuses it.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
