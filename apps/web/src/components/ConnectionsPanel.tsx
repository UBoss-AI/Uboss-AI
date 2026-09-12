'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  FormField,
  Icon,
  SkeletonText,
  StatusBadge,
  type DataTableColumn,
} from '@uboss/ui';

import { CONNECTION_STATE_LABELS, CONNECTION_STATE_TONES } from '@uboss/types';

import {
  ApiError,
  connectionsApi,
  type ConnectionRow,
  type ConnectorCatalogue,
  type ConnectionsView,
} from '../lib/api-client';

export interface ConnectionsPanelProps {
  tenantId: string;
  /** From the server. Controls whether the company-level actions appear at all. */
  mayAdminister: boolean;
}

/**
 * Integrations & Connections, inside Settings.
 *
 * ## Matched to the reference's `setIntegrations()`
 *
 * The same card with an **Add connection** action and the same table columns — Connection, Owner,
 * Environment, Health, Affected agents, and a **Test** button per row. The reference's `Health`
 * column becomes the client's five real states, which is more than the prototype's three; that is
 * the pack's list, not an embellishment.
 *
 * ## The credential is never on this screen
 *
 * There is no field that shows one, no route that returns one, and the *Add* and *Rotate* forms
 * are the only places a secret is typed. The table shows the `secret_ref` handle, because that is
 * what a connection actually stores.
 *
 * ## What a high-risk grant looks like
 *
 * A tool grant is shown per Engine Agent with its category, and a high-risk category carries a
 * red badge and its reason. This is the screen where somebody has to be able to see, at a glance,
 * that an agent can delete from the company's ERP — so the reason is displayed rather than hidden
 * behind a detail view.
 */
export function ConnectionsPanel({ tenantId, mayAdminister }: ConnectionsPanelProps) {
  const [view, setView] = useState<ConnectionsView | null>(null);
  const [catalogue, setCatalogue] = useState<ConnectorCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<ConnectionRow | null>(null);

  // Add-connection form.
  const [connectorKind, setConnectorKind] = useState('');
  const [label, setLabel] = useState('');
  const [environment, setEnvironment] = useState<'Test' | 'Production'>('Test');
  const [secret, setSecret] = useState('');

  // Detail-drawer forms.
  const [rotateSecret, setRotateSecret] = useState('');
  const [disableReason, setDisableReason] = useState('');
  const [grantAgentId, setGrantAgentId] = useState('');
  const [grantCategory, setGrantCategory] = useState('Read');
  const [grantReason, setGrantReason] = useState('');

  const load = useCallback(() => {
    setError(null);
    void Promise.all([connectionsApi.list(tenantId), connectionsApi.catalogue(tenantId)])
      .then(([connections, cat]) => {
        setView(connections);
        setCatalogue(cat);
        if (connectorKind === '' && cat.connectors[0]) {
          setConnectorKind(cat.connectors[0].kind);
        }
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load connections.'),
      );
    // `connectorKind` is deliberately not a dependency: it is seeded once from the catalogue, and
    // including it would re-fetch on every change of the chooser.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(load, [load]);

  const run = useCallback(
    (id: string, work: () => Promise<{ note?: string } | unknown>, success: string) => {
      setBusyId(id);
      setError(null);
      void work()
        .then((result) => {
          const note = (result as { note?: string } | null)?.note;
          setNotice(note ?? success);
          load();
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'That did not work.'),
        )
        .finally(() => setBusyId(null));
    },
    [load],
  );

  const selected = catalogue?.connectors.find((row) => row.kind === connectorKind);
  const categoryInfo = catalogue?.toolCategories.find((row) => row.category === grantCategory);

  const columns: DataTableColumn<ConnectionRow>[] = [
    {
      key: 'connection',
      header: 'Connection',
      render: (row) => (
        <>
          <b>{row.label}</b>
          <br />
          <span className="uboss-muted-3" style={{ fontSize: 12 }}>
            {row.connectorLabel}
          </span>
        </>
      ),
    },
    {
      key: 'owner',
      header: 'Owner',
      render: (row) => (
        <>
          {row.scope === 'User' ? 'User' : 'Company'}
          <br />
          <span className="uboss-mono uboss-muted-3" style={{ fontSize: 11 }}>
            {row.ownerUserId.slice(0, 8)}
          </span>
        </>
      ),
    },
    {
      key: 'environment',
      header: 'Environment',
      render: (row) =>
        row.environment === null ? (
          <span className="uboss-muted-3">—</span>
        ) : (
          <StatusBadge
            status={row.environment}
            tone={row.environment === 'Production' ? 'purple' : 'cyan'}
            dot={false}
          />
        ),
    },
    {
      key: 'health',
      header: 'Health',
      render: (row) => (
        <>
          <StatusBadge
            status={CONNECTION_STATE_LABELS[row.state]}
            tone={CONNECTION_STATE_TONES[row.state]}
          />
          {row.expiringSoon ? (
            <>
              <br />
              <span className="uboss-muted-3" style={{ fontSize: 11 }}>
                Credential expires soon
              </span>
            </>
          ) : null}
        </>
      ),
    },
    {
      key: 'agents',
      header: 'Affected agents',
      render: (row) => (
        <span className="uboss-muted">
          {row.affectedAgentCount === 0
            ? 'None'
            : `${row.affectedAgentCount} agent${row.affectedAgentCount === 1 ? '' : 's'}`}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <span className="uboss-actions">
          <Button
            variant="ghost"
            disabled={busyId === row.id}
            onClick={() =>
              run(
                row.id,
                () =>
                  connectionsApi.check(tenantId, row.id).then((result) => ({
                    note: result.succeeded
                      ? `Reachable. ${result.detail}`
                      : `Failed: ${result.detail}`,
                  })),
                'Tested.',
              )
            }
          >
            {busyId === row.id ? 'Testing…' : 'Test'}
          </Button>
          <Button variant="ghost" onClick={() => setDetail(row)}>
            Manage
          </Button>
        </span>
      ),
    },
  ];

  if (view === null) {
    return error === null ? <SkeletonText lines={4} /> : <Banner tone="danger">{error}</Banner>;
  }

  return (
    <>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {notice ? <Banner tone="ok">{notice}</Banner> : null}

      <Card>
        <CardHeader
          title="Integrations & Connections"
          aside={
            mayAdminister ? (
              <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
                Add connection
              </Button>
            ) : null
          }
        />
        <CardBody>
          <DataTable
            caption="Every connection in this company, with its health and affected agents"
            columns={columns}
            rows={view.connections}
            rowKey={(row) => row.id}
            emptyTitle="No connections yet"
            emptyDescription={
              mayAdminister
                ? 'Add one to let an Engine Agent reach an outside system.'
                : 'Nothing is connected, or nothing you may see.'
            }
          />

          <p className="uboss-notice">
            <Icon name="shield" size={14} /> {view.note}
          </p>

          <div className="uboss-kv">
            <span className="uboss-kv-key">Secrets are held by</span>
            <span className="uboss-kv-value">
              {view.vault.name}
              {view.vault.isExternalProvider ? null : (
                <>
                  {' '}
                  <StatusBadge status="No external provider" tone="warn" dot={false} />
                </>
              )}
            </span>
          </div>
          <p className="uboss-muted-3" style={{ fontSize: 12 }}>
            {view.vault.note}
          </p>
        </CardBody>
      </Card>

      {/* ---- Add ---- */}
      <Drawer open={addOpen} onClose={() => setAddOpen(false)} title="Add a connection">
        <FormField label="Connector" required>
          {(wiring) => (
            <select
              {...wiring}
              className="uboss-input"
              value={connectorKind}
              onChange={(event) => setConnectorKind(event.target.value)}
            >
              {(catalogue?.connectors ?? []).map((row) => (
                <option key={row.kind} value={row.kind}>
                  {row.label}
                </option>
              ))}
            </select>
          )}
        </FormField>

        {selected ? (
          <p className="uboss-muted-3" style={{ fontSize: 12 }}>
            {selected.summary}
          </p>
        ) : null}

        <FormField label="Name" required hint="How this connection is referred to in this company.">
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          )}
        </FormField>

        {selected?.hasEnvironments ? (
          <FormField
            label="Environment"
            required
            hint="Test and Production are separate connections, so nothing points at production by accident."
          >
            {(wiring) => (
              <select
                {...wiring}
                className="uboss-input"
                value={environment}
                onChange={(event) => setEnvironment(event.target.value as 'Test' | 'Production')}
              >
                <option value="Test">Test</option>
                <option value="Production">Production</option>
              </select>
            )}
          </FormField>
        ) : null}

        <FormField
          label="Credential"
          required
          hint="Stored as a reference. It is never shown again, here or anywhere else."
        >
          {(wiring) => (
            <input
              {...wiring}
              type="password"
              className="uboss-input"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          )}
        </FormField>

        {selected?.isMock ? (
          <Banner tone="info">
            This is a mock connector: it talks to nothing. It accepts <code>mock:ok</code>,{' '}
            <code>mock:reauthorize</code>, <code>mock:expires:&lt;date&gt;</code> or{' '}
            <code>mock:fail:&lt;message&gt;</code>, so every state this screen can show is reachable
            before a real vendor is integrated.
          </Banner>
        ) : null}

        <div className="uboss-actions">
          <Button
            variant="primary"
            disabled={label.trim().length < 2 || secret.trim() === ''}
            onClick={() =>
              run(
                'new',
                () =>
                  connectionsApi
                    .create(tenantId, {
                      scopeKind: selected?.scopes.includes('Company') ? 'Company' : 'User',
                      connectorKind,
                      label: label.trim(),
                      ...(selected?.hasEnvironments ? { environment } : {}),
                      secret,
                    })
                    .then(() => {
                      setAddOpen(false);
                      setLabel('');
                      setSecret('');
                      return { note: 'Connection added. Test it to confirm it works.' };
                    }),
                'Added.',
              )
            }
          >
            Add connection
          </Button>
          <Button onClick={() => setAddOpen(false)}>Cancel</Button>
        </div>
      </Drawer>

      {/* ---- Manage ---- */}
      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail === null ? '' : `Manage — ${detail.label}`}
      >
        {detail === null ? null : (
          <>
            <div className="uboss-kv">
              <span className="uboss-kv-key">State</span>
              <span className="uboss-kv-value">
                <StatusBadge
                  status={CONNECTION_STATE_LABELS[detail.state]}
                  tone={CONNECTION_STATE_TONES[detail.state]}
                />
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Secret reference</span>
              {/* The handle, which is all a connection stores. */}
              <span className="uboss-kv-value uboss-mono">{detail.secretRef ?? 'none'}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Last worked</span>
              <span className="uboss-kv-value">
                {detail.lastSuccessfulCheckAt === null
                  ? 'never'
                  : new Date(detail.lastSuccessfulCheckAt).toLocaleString()}
              </span>
            </div>
            {detail.lastError === null ? null : <Banner tone="danger">{detail.lastError}</Banner>}
            {detail.disabledReason === null ? null : (
              <Banner tone="warn">Disabled: {detail.disabledReason}</Banner>
            )}

            <div className="uboss-section-label">Agent Tool Permissions</div>
            <p className="uboss-muted-3" style={{ fontSize: 12 }}>
              What an <b>Engine Agent</b> may do through this connection. Separate from any
              person&apos;s permission — nobody&apos;s role grants these.
            </p>

            {detail.grants.length === 0 ? (
              <p className="uboss-muted">
                No agent may use this connection yet. A grant names the agent and the category.
              </p>
            ) : (
              detail.grants.map((grant) => (
                <div key={grant.id} className="uboss-kv">
                  <span className="uboss-kv-key">
                    <span className="uboss-mono">{grant.agentId.slice(0, 8)}</span> —{' '}
                    {grant.category}
                    {grant.highRisk ? (
                      <>
                        {' '}
                        <StatusBadge status="High risk" tone="danger" dot={false} />
                      </>
                    ) : null}
                    {grant.reason === null ? null : (
                      <>
                        <br />
                        <span className="uboss-muted-3" style={{ fontSize: 11 }}>
                          {grant.reason}
                        </span>
                      </>
                    )}
                  </span>
                  {mayAdminister ? (
                    <span className="uboss-kv-value">
                      <Button
                        variant="ghost"
                        onClick={() =>
                          run(
                            detail.id,
                            () =>
                              connectionsApi
                                .revokeToolPermission(
                                  tenantId,
                                  grant.id,
                                  'Revoked from the Integrations screen.',
                                )
                                .then(() => {
                                  setDetail(null);
                                  return { note: 'Tool permission revoked.' };
                                }),
                            'Revoked.',
                          )
                        }
                      >
                        Revoke
                      </Button>
                    </span>
                  ) : null}
                </div>
              ))
            )}

            {mayAdminister ? (
              <>
                <FormField label="Grant to Engine Agent" hint="The agent's id.">
                  {(wiring) => (
                    <input
                      {...wiring}
                      className="uboss-input"
                      value={grantAgentId}
                      onChange={(event) => setGrantAgentId(event.target.value)}
                    />
                  )}
                </FormField>

                <FormField label="Category">
                  {(wiring) => (
                    <select
                      {...wiring}
                      className="uboss-input"
                      value={grantCategory}
                      onChange={(event) => setGrantCategory(event.target.value)}
                    >
                      {(catalogue?.toolCategories ?? [])
                        .filter((row) =>
                          (
                            catalogue?.connectors.find(
                              (connector) => connector.kind === detail.connectorKind,
                            )?.supportedCategories ?? []
                          ).includes(row.category),
                        )
                        .map((row) => (
                          <option key={row.category} value={row.category}>
                            {row.label}
                            {row.highRisk ? ' — high risk' : ''}
                          </option>
                        ))}
                    </select>
                  )}
                </FormField>

                {categoryInfo ? (
                  <p className="uboss-muted-3" style={{ fontSize: 12 }}>
                    {categoryInfo.description}
                  </p>
                ) : null}

                {categoryInfo?.highRisk ? (
                  <FormField
                    label="Why does this agent need it?"
                    required
                    hint="Required for a high-risk category. Kept on the grant and in the audit trail."
                  >
                    {(wiring) => (
                      <textarea
                        {...wiring}
                        className="uboss-input"
                        rows={2}
                        value={grantReason}
                        onChange={(event) => setGrantReason(event.target.value)}
                      />
                    )}
                  </FormField>
                ) : null}

                <div className="uboss-actions">
                  <Button
                    variant="primary"
                    disabled={
                      grantAgentId.trim() === '' ||
                      (categoryInfo?.highRisk === true && grantReason.trim().length < 5)
                    }
                    onClick={() =>
                      run(
                        detail.id,
                        () =>
                          connectionsApi
                            .grantToolPermission(tenantId, detail.id, {
                              agentId: grantAgentId.trim(),
                              category: grantCategory,
                              ...(grantReason.trim() === '' ? {} : { reason: grantReason.trim() }),
                            })
                            .then((result) => {
                              setDetail(null);
                              setGrantAgentId('');
                              setGrantReason('');
                              return result;
                            }),
                        'Granted.',
                      )
                    }
                  >
                    Grant
                  </Button>
                </div>

                <div className="uboss-section-label">The credential</div>

                <FormField
                  label="Replace it"
                  hint="The reference is kept, so every tool grant survives the rotation."
                >
                  {(wiring) => (
                    <input
                      {...wiring}
                      type="password"
                      className="uboss-input"
                      value={rotateSecret}
                      onChange={(event) => setRotateSecret(event.target.value)}
                    />
                  )}
                </FormField>

                <div className="uboss-actions">
                  <Button
                    disabled={rotateSecret.trim() === ''}
                    onClick={() =>
                      run(
                        detail.id,
                        () =>
                          connectionsApi
                            .rotateSecret(tenantId, detail.id, { secret: rotateSecret })
                            .then(() => {
                              setDetail(null);
                              setRotateSecret('');
                              return { note: 'Credential replaced. Test it to confirm.' };
                            }),
                        'Rotated.',
                      )
                    }
                  >
                    Rotate credential
                  </Button>

                  {detail.state === 'NeedsReauthorization' ? (
                    <Button
                      onClick={() =>
                        run(
                          detail.id,
                          () =>
                            connectionsApi.reauthorize(tenantId, detail.id).then(() => {
                              setDetail(null);
                              return { note: 'Reauthorized.' };
                            }),
                          'Reauthorized.',
                        )
                      }
                    >
                      Reauthorize
                    </Button>
                  ) : null}
                </div>

                <div className="uboss-section-label">Availability</div>

                {detail.state === 'Disabled' ? (
                  <Button
                    onClick={() =>
                      run(
                        detail.id,
                        () =>
                          connectionsApi.enable(tenantId, detail.id).then(() => {
                            setDetail(null);
                            return { note: 'Enabled. Its next test decides whether it works.' };
                          }),
                        'Enabled.',
                      )
                    }
                  >
                    Enable
                  </Button>
                ) : (
                  <>
                    <FormField
                      label="Why is it being disabled?"
                      required
                      hint="Every Engine Agent using it stops working, and whoever finds that out needs to know why."
                    >
                      {(wiring) => (
                        <textarea
                          {...wiring}
                          className="uboss-input"
                          rows={2}
                          value={disableReason}
                          onChange={(event) => setDisableReason(event.target.value)}
                        />
                      )}
                    </FormField>
                    <Button
                      variant="danger"
                      disabled={disableReason.trim().length < 5}
                      onClick={() =>
                        run(
                          detail.id,
                          () =>
                            connectionsApi
                              .disable(tenantId, detail.id, disableReason.trim())
                              .then(() => {
                                setDetail(null);
                                setDisableReason('');
                                return {
                                  note:
                                    'Disabled. Tool grants are kept, so enabling it restores the ' +
                                    'configuration rather than requiring it to be rebuilt.',
                                };
                              }),
                          'Disabled.',
                        )
                      }
                    >
                      Disable connection
                    </Button>
                  </>
                )}
              </>
            ) : null}
          </>
        )}
      </Drawer>
    </>
  );
}
