'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Icon,
  PageHeader,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  providersApi,
  type LogicalProfileRoutingView,
  type ProviderProfileView,
  type ProvidersMetaView,
  type ProviderTestResultView,
} from '../../../lib/api-client';
import { useMasterConsole } from '../layout';

/**
 * Providers & Models — the reference's `MSCR.providers`.
 *
 * Its layout: the four KPIs, then the provider table — Provider, Status, Models, Fallback role.
 * Selecting a provider opens its models; a second card shows what each of the five logical model
 * profiles currently resolves to.
 *
 * ## Every number here is measured, and the ones that cannot be are absent
 *
 * The reference's KPIs are Providers, Models, p95 latency and Fallbacks. The first two are counts.
 * The second two come from recorded gateway calls — and with no provider configured, every call is
 * answered by the mock adapter in zero milliseconds. So **the latency and fallback figures are
 * shown as unavailable rather than as zero**, because a dashboard reading "p95 240ms" from mock
 * calls is worse than one reading "—": the first is a number somebody will quote.
 *
 * ## Status is not health
 *
 * The reference's Status column reads "Healthy". Nothing here can say that: health means a
 * provider answering, and none has ever been contacted. The column shows the lifecycle state and
 * what the last Test Connection actually established — with `reachedProvider` distinguished from
 * `ok`, because a configuration that validates is not a provider that answered.
 */
export default function MasterProvidersPage() {
  const { can } = useMasterConsole();

  const [meta, setMeta] = useState<ProvidersMetaView | null>(null);
  const [profiles, setProfiles] = useState<ProviderProfileView[] | null>(null);
  const [routing, setRouting] = useState<LogicalProfileRoutingView[] | null>(null);
  const [selected, setSelected] = useState<ProviderProfileView | null>(null);
  const [testResult, setTestResult] = useState<ProviderTestResultView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [loadedMeta, loadedProfiles, loadedRouting] = await Promise.all([
        providersApi.meta(),
        providersApi.profiles(),
        providersApi.routing(),
      ]);
      setMeta(loadedMeta);
      setProfiles(loadedProfiles);
      setRouting(loadedRouting);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load providers.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const modelCount = useMemo(
    () => (profiles ?? []).reduce((total, profile) => total + profile.models.length, 0),
    [profiles],
  );

  const anythingCanReachAProvider = useMemo(
    () => (meta?.kinds ?? []).some((kind) => kind.canReachProvider),
    [meta],
  );

  const test = async (profileId: string) => {
    setBusy(true);
    try {
      setTestResult(await providersApi.testConnection(profileId));
      await load();
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The test did not run.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Providers & Models"
        description="Provider health and model gateway."
        breadcrumbs={[{ label: 'Providers' }]}
      />

      {error !== null && <Banner tone="warn">{error}</Banner>}

      {meta !== null && (
        <Banner tone="info">
          <Icon name="shield" size={16} />
          {meta.note}
        </Banner>
      )}

      {!anythingCanReachAProvider && (
        <Banner tone="warn">
          <Icon name="alert" size={16} />
          No provider credential is configured, so every AI call is answered by the mock adapter and
          recorded as <span className="uboss-mono">producedByRealModel = false</span>. The Anthropic
          and OpenAI adapters are implemented and have never reached a provider.
        </Banner>
      )}

      <div className="uboss-grid uboss-row-2">
        <Card>
          <CardBody>
            <div className="uboss-section-label">Providers</div>
            <p className="uboss-kv-value">{(profiles ?? []).length}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="uboss-section-label">Models</div>
            <p className="uboss-kv-value">{modelCount}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="uboss-section-label">p95 latency</div>
            {/* Absent rather than zero: mock calls answer instantly, and a latency figure taken
                from them is a number somebody will quote. */}
            <p className="uboss-muted-3">— needs real provider calls</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="uboss-section-label">Fallbacks</div>
            <p className="uboss-muted-3">— needs real provider calls</p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <DataTable
          caption="Provider profiles"
          rows={profiles ?? []}
          rowKey={(row) => row.id}
          loading={profiles === null}
          emptyTitle="No provider profiles"
          emptyDescription="Register one to route logical model profiles through it."
          columns={[
            {
              key: 'provider',
              header: 'Provider',
              render: (row) => (
                <>
                  <b>{row.label}</b>
                  <br />
                  <small className="uboss-muted-3">
                    {row.mode}
                    {row.tenantId === null ? ' · platform' : ' · one company'}
                  </small>
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => (
                <>
                  <StatusBadge
                    status={row.lifecycle}
                    tone={
                      (row.lifecycle === 'Active'
                        ? 'success'
                        : row.lifecycle === 'Deprecated'
                          ? 'warn'
                          : 'danger') as StatusTone
                    }
                  />
                  <br />
                  <small className="uboss-muted-3">
                    {row.lastTest === null
                      ? 'never tested'
                      : row.lastTest.reachedProvider
                        ? 'provider answered'
                        : 'tested — no provider reached'}
                  </small>
                </>
              ),
            },
            {
              key: 'models',
              header: 'Models',
              numeric: true,
              render: (row) => <span className="uboss-mono">{row.models.length}</span>,
            },
            {
              key: 'reach',
              header: 'Adapter',
              render: (row) => (
                <StatusBadge
                  status={row.adapterCanReachProvider ? 'Can reach' : 'No credential'}
                  tone={(row.adapterCanReachProvider ? 'success' : 'grey') as StatusTone}
                />
              ),
            },
            {
              key: 'open',
              header: '',
              render: (row) => (
                <Button
                  size="sm"
                  onClick={() => {
                    setSelected(row);
                    setTestResult(null);
                  }}
                >
                  Models
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card>
        <CardBody>
          <div className="uboss-section-label">Logical model profiles</div>
          <p className="uboss-muted">
            A business object names one of these five and never a provider. The gateway behaviour
            beside each is the approved architecture&apos;s own sentence.
          </p>
        </CardBody>
        <DataTable
          caption="Logical model profile routing"
          rows={routing ?? []}
          rowKey={(row) => row.profile}
          loading={routing === null}
          emptyTitle="No routing configured"
          emptyDescription="Nothing would answer an AI call."
          columns={[
            {
              key: 'profile',
              header: 'Profile',
              render: (row) => (
                <>
                  <b className="uboss-mono">{row.profile}</b>
                  <br />
                  <small className="uboss-muted-3">{row.typicalUse}</small>
                </>
              ),
            },
            {
              key: 'behaviour',
              header: 'Gateway behaviour',
              render: (row) => <span className="uboss-muted">{row.gatewayBehaviour}</span>,
            },
            {
              key: 'fallback',
              header: 'Fallback',
              render: (row) => (
                <StatusBadge
                  status={row.fallbackPolicy}
                  tone={(row.fallbackPolicy === 'NoFallback' ? 'danger' : 'blue') as StatusTone}
                />
              ),
            },
            {
              key: 'answers',
              header: 'Would answer',
              render: (row) => {
                const answering = row.routes.find((route) => route.wouldAnswer);
                if (row.unroutableReason !== null) {
                  return (
                    <>
                      <StatusBadge status="Unroutable" tone="danger" dot />
                      <br />
                      <small className="uboss-muted-3">{row.unroutableReason}</small>
                    </>
                  );
                }
                return (
                  <>
                    {/* The capability, not the provider or model name. */}
                    <span className="uboss-mono">{answering?.capability}</span>
                    <br />
                    <small className="uboss-muted-3">
                      {row.routes.length} candidate{row.routes.length === 1 ? '' : 's'}
                    </small>
                  </>
                );
              },
            },
          ]}
        />
      </Card>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.label ?? 'Provider'}
        footer={
          selected === null ? null : (
            <div className="uboss-actions">
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !can('providers', 'Administer')}
                onClick={() => void test(selected.id)}
              >
                Test Connection
              </Button>
            </div>
          )
        }
      >
        {selected !== null && (
          <CardBody>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Mode</span>
              <span className="uboss-kv-value">{selected.mode}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Scope</span>
              <span className="uboss-kv-value">
                {selected.tenantId === null
                  ? 'Platform — every company may be routed through it'
                  : 'One company'}
              </span>
            </div>

            {selected.custom !== null && (
              <>
                <div className="uboss-section-label">Custom endpoint</div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Endpoint</span>
                  <span className="uboss-kv-value uboss-mono">{selected.custom.baseUrl}</span>
                </div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Auth</span>
                  <span className="uboss-kv-value">
                    {selected.custom.authType}
                    {selected.custom.authHeaderName === null
                      ? ''
                      : ` · ${selected.custom.authHeaderName}`}
                  </span>
                </div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Secret</span>
                  {/* Whether one is stored, never the value. */}
                  <span className="uboss-kv-value">
                    {selected.custom.hasSecret ? 'Stored in the vault' : 'None'}
                  </span>
                </div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Usage mapping</span>
                  <span className="uboss-kv-value uboss-mono">
                    {selected.custom.usageMapping.inputPath} /{' '}
                    {selected.custom.usageMapping.outputPath}
                  </span>
                </div>
              </>
            )}

            {(testResult ?? selected.lastTest) !== null && (
              <Banner
                tone={
                  (testResult?.reachedProvider ?? selected.lastTest?.reachedProvider)
                    ? 'ok'
                    : 'warn'
                }
              >
                <Icon name="bolt" size={16} />
                {testResult?.detail ?? selected.lastTest?.detail}
              </Banner>
            )}

            <div className="uboss-section-label">Models</div>
            {selected.models.length === 0 ? (
              <p className="uboss-muted-3">
                No model is registered, so nothing can be routed here.
              </p>
            ) : (
              <ul>
                {selected.models.map((model) => (
                  <li key={model.id}>
                    <span className="uboss-mono">{model.capability}</span>{' '}
                    <StatusBadge
                      status={model.lifecycle}
                      tone={
                        (model.lifecycle === 'Active'
                          ? 'success'
                          : model.lifecycle === 'Deprecated'
                            ? 'warn'
                            : 'danger') as StatusTone
                      }
                    />
                    <br />
                    <small className="uboss-muted-3">
                      {model.currentPricing === null
                        ? 'no pricing version — calls through it record no cost'
                        : `pricing v${model.currentPricing.versionNumber}, ` +
                          `${model.currentPricing.currency} ` +
                          `${model.currentPricing.inputPerMillionMinorUnits}/` +
                          `${model.currentPricing.outputPerMillionMinorUnits} per million`}
                    </small>
                    {model.lifecycleNote !== null && (
                      <>
                        <br />
                        <small className="uboss-muted-3">{model.lifecycleNote}</small>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="uboss-notice uboss-notice-min">
              A model marked <b>Migration required</b> is refused for new work, so it stops being
              selected while there is still time to move rather than on the day it disappears.
            </div>
          </CardBody>
        )}
      </Drawer>
    </>
  );
}
