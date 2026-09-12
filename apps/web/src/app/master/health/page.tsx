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
  PageHeader,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import { ApiError, platformApi, type ServiceAlertRow } from '../../../lib/api-client';
import { useMasterConsole } from '../layout';
import { severityTone } from '../dashboard/page';

/**
 * System Health.
 *
 * Asked for as a shell, and shipped as slightly more than one — deliberately. The service-alert
 * table and its acknowledge/resolve endpoints had to exist for the dashboard's "service alerts"
 * panel, so a shell here would have been a screen hiding data the console already displays two
 * clicks away, with the two write endpoints reachable from nothing.
 *
 * What is **not** here is everything the reference's four KPIs show — uptime, API p95, agent run
 * success, queue depth. Those need probes that observe the running system, and nothing observes
 * anything yet. They are listed as unbuilt rather than filled with plausible numbers: a health
 * screen showing "99.98% uptime" that no probe measured is the single most dangerous kind of
 * fake data in an operations console.
 *
 * The alerts themselves are seeded rows in a real table, labelled as such.
 */
export default function MasterSystemHealthPage() {
  const router = useRouter();
  const { can } = useMasterConsole();

  const [alerts, setAlerts] = useState<ServiceAlertRow[] | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(() => {
    platformApi
      .serviceAlerts(!showResolved)
      .then((result) => {
        setAlerts(result.alerts);
        setNote(result.note);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load service alerts.'),
      );
  }, [showResolved]);

  useEffect(load, [load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That action failed.');
    } finally {
      setBusy(false);
    }
  };

  const mayWrite = can('system-health', 'EditDraft');

  return (
    <>
      <PageHeader
        title="System Health"
        description="Live platform health."
        breadcrumbs={[
          { label: 'Master Console', onSelect: () => router.push('/master/dashboard') },
          { label: 'System Health' },
        ]}
        actions={
          <Button onClick={() => setShowResolved((value) => !value)}>
            {showResolved ? 'Open alerts only' : 'Include resolved'}
          </Button>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Card>
        <CardHeader title="Service alerts" aside={<StatusBadge status="Demo data" tone="warn" />} />
        <CardBody>
          <p className="uboss-muted-3">{note}</p>

          {alerts === null ? (
            <SkeletonText lines={4} />
          ) : alerts.length === 0 ? (
            <EmptyState
              title={showResolved ? 'No alerts at all' : 'No open service alerts'}
              description="Alerts are written by hand today. Health checks that raise them are not built."
            />
          ) : (
            <DataTable
              caption="Platform service alerts"
              columns={[
                { key: 'service', header: 'Service', render: (row) => <b>{row.service}</b> },
                {
                  key: 'severity',
                  header: 'Severity',
                  render: (row) => (
                    <StatusBadge status={row.severity} tone={severityTone(row.severity)} />
                  ),
                },
                {
                  key: 'state',
                  header: 'State',
                  render: (row) => <StatusBadge status={row.state} />,
                },
                { key: 'summary', header: 'Summary', render: (row) => row.summary },
                {
                  key: 'opened',
                  header: 'Opened',
                  render: (row) => new Date(row.openedAt).toLocaleString(),
                },
                {
                  key: 'actions',
                  header: 'Action',
                  // Only rendered when the role permits it. The API refuses either way — this is
                  // the courtesy of not offering a button that 403s.
                  render: (row) =>
                    !mayWrite ? (
                      <span className="uboss-muted-3">—</span>
                    ) : row.state === 'Open' ? (
                      <Button
                        disabled={busy}
                        onClick={() => void act(() => platformApi.acknowledgeAlert(row.id))}
                      >
                        Acknowledge
                      </Button>
                    ) : row.state === 'Acknowledged' ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            // A resolution note is required by the API, and asking for it in a
                            // prompt is honest about this being an operations screen rather than
                            // pretending a click is a resolution.
                            platformApi.resolveAlert(
                              row.id,
                              window.prompt('What was done to resolve this?') ?? '',
                            ),
                          )
                        }
                      >
                        Resolve
                      </Button>
                    ) : (
                      <span className="uboss-muted-3">Resolved</span>
                    ),
                },
              ]}
              rows={alerts}
              rowKey={(row) => row.id}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Not measured yet" />
        <CardBody>
          {/*
            The reference's four health KPIs. Named and left empty rather than filled in: a
            fabricated uptime figure is worse than a missing one, because an operator would act
            on it.
          */}
          <Banner tone="info">
            Uptime, API latency, Engine Agent run success and queue depth all need probes that
            observe the running system. Nothing observes anything yet, so these are listed rather
            than shown — a health screen with numbers no probe measured is the most dangerous kind
            of fake data in an operations console.
          </Banner>
          <div className="uboss-kv">
            <span className="uboss-kv-key">Uptime (30d)</span>
            <span className="uboss-kv-value uboss-muted-3">no probe</span>
          </div>
          <div className="uboss-kv">
            <span className="uboss-kv-key">API p95 latency</span>
            <span className="uboss-kv-value uboss-muted-3">no probe</span>
          </div>
          <div className="uboss-kv">
            <span className="uboss-kv-key">Engine Agent run success</span>
            <span className="uboss-kv-value uboss-muted-3">no Runs exist yet</span>
          </div>
          <div className="uboss-kv">
            <span className="uboss-kv-key">Queue depth</span>
            <span className="uboss-kv-value uboss-muted-3">no queue yet</span>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
