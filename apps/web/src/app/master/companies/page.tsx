'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  FilterBar,
  FilterSelect,
  PageHeader,
  SearchField,
  SkeletonText,
  StatusBadge,
  type DataTableColumn,
} from '@uboss/ui';

import { ApiError, platformApi, type CompanySummary } from '../../../lib/api-client';
import { useMasterConsole } from '../layout';
import { billingTone, flagTone } from '../dashboard/page';

/**
 * Companies — every provisioned workspace.
 *
 * The reference's columns exactly: Company (with its identifier beneath), Plan, Seats, Status,
 * Usage, Billing, Flag. Its toolbar too — a search field and two filters, plus the Create
 * Company action.
 *
 * ## Filtering is client-side, on purpose
 *
 * The whole list arrives in one aggregate because the dashboard needs it anyway, and a platform
 * with fifty companies does not need server-side pagination. When it does, the aggregate grows a
 * cursor — which is a change to one query rather than to this screen. Filtering here would be the
 * wrong call for the *audit* trail, where the result set is unbounded; a company list is bounded
 * by how many customers exist.
 *
 * ## The Create Company button leads to the entry screen, not to provisioning
 *
 * There is no provisioning call behind it. The wizard is the next prompt, and the entry screen
 * says so rather than the button appearing to work.
 */
export default function MasterCompaniesPage() {
  const router = useRouter();
  const { can } = useMasterConsole();

  const [companies, setCompanies] = useState<CompanySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    platformApi
      .companies()
      .then((result) => setCompanies(result.companies))
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load companies.'),
      );
  }, []);

  const plans = useMemo(
    () => [...new Set((companies ?? []).map((row) => row.plan).filter(Boolean))] as string[],
    [companies],
  );
  const statuses = useMemo(
    () => [...new Set((companies ?? []).map((row) => row.status))],
    [companies],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (companies ?? []).filter((row) => {
      if (planFilter && row.plan !== planFilter) {
        return false;
      }
      if (statusFilter && row.status !== statusFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      // Searches the identifier and the legal name too: an operator handed a reference from a
      // support ticket should be able to paste it, and a legal name is what appears on a contract.
      return (
        row.name.toLowerCase().includes(needle) ||
        row.reference.toLowerCase().includes(needle) ||
        (row.legalName ?? '').toLowerCase().includes(needle)
      );
    });
  }, [companies, search, planFilter, statusFilter]);

  const columns: DataTableColumn<CompanySummary>[] = [
    {
      key: 'company',
      header: 'Company',
      render: (row) => (
        <>
          <b>{row.name}</b>
          <br />
          <small className="uboss-muted-3 uboss-mono">{row.reference}</small>
        </>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      render: (row) =>
        row.plan ? (
          <StatusBadge status={row.plan} tone={planTone(row.planTier)} />
        ) : (
          // A company with no subscription is a real state — the demo company is one — and it is
          // shown as "No plan" rather than blank, because blank reads as a loading failure.
          <span className="uboss-muted-3">No plan</span>
        ),
    },
    { key: 'seats', header: 'Seats', render: (row) => row.seatsLabel },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'usage', header: 'Usage', render: (row) => row.aiUsageLabel },
    {
      key: 'billing',
      header: 'Billing',
      render: (row) =>
        row.billing ? (
          <StatusBadge status={row.billing} tone={billingTone(row.billing)} />
        ) : (
          <span className="uboss-muted-3">—</span>
        ),
    },
    {
      key: 'flag',
      header: 'Flag',
      render: (row) =>
        row.flag === 'None' ? (
          <span className="uboss-muted-3">—</span>
        ) : (
          <span title={row.attentionReasons.join('\n')}>
            <StatusBadge status={row.flag} tone={flagTone(row.flag)} />
          </span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Companies"
        description="All provisioned workspaces. There is no public company signup."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'Companies' },
        ]}
        actions={
          can('create-company', 'Create') ? (
            <Button
              variant="navy"
              icon="plus"
              onClick={() => router.push('/master/create-company')}
            >
              Create company
            </Button>
          ) : undefined
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Card>
        <FilterBar>
          <SearchField
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search companies"
            label="Search companies"
          />
          <FilterSelect
            label="Plan"
            value={planFilter}
            onChange={setPlanFilter}
            options={[
              { value: '', label: 'All plans' },
              ...plans.map((plan) => ({ value: plan, label: plan })),
            ]}
          />
          <FilterSelect
            label="Status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: '', label: 'All statuses' },
              ...statuses.map((status) => ({ value: status, label: status })),
            ]}
          />
        </FilterBar>

        <CardBody>
          {companies === null && !error ? (
            <SkeletonText lines={5} />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={companies?.length ? 'No company matches those filters' : 'No companies yet'}
              description={
                companies?.length
                  ? 'Clear the search or filters to see every company.'
                  : 'A company is created from the Master Console and its first administrator is invited.'
              }
              actions={
                companies?.length ? (
                  <Button
                    onClick={() => {
                      setSearch('');
                      setPlanFilter('');
                      setStatusFilter('');
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataTable
              caption="Every provisioned company"
              columns={columns}
              rows={filtered}
              rowKey={(row) => row.tenantId}
              onRowSelect={(row) => router.push(`/master/companies/${row.tenantId}`)}
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}

/** The reference tones Enterprise purple, Growth blue and everything else grey. */
export function planTone(tier: string | null): 'purple' | 'blue' | 'grey' {
  return tier === 'Enterprise' ? 'purple' : tier === 'Growth' ? 'blue' : 'grey';
}
