'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  FormField,
  PageHeader,
  SkeletonText,
  StatusBadge,
  type DataTableColumn,
} from '@uboss/ui';

import {
  ApiError,
  authorizationApi,
  type AuthorizationVocabulary,
  type PermissionEvaluation,
  type PermissionMatrix,
  type PermissionTraceStep,
} from '../../../lib/api-client';

/**
 * The internal permission test page.
 *
 * The one screen Prompt 7 permits, and it is here because a five-dimension, five-layer
 * authorization engine is close to undebuggable from the outside. "Why can this Manager not
 * approve this?" should be answerable in one place, and the answer should name the layer that
 * decided rather than saying "forbidden".
 *
 * ## It is a diagnostic, not a feature
 *
 * No navigation links here, and it is deliberately not in `COMPANY_NAV`: it is reached by typing
 * the URL, by whoever is debugging. It shows the decision **trace**, which describes a company's
 * policy configuration — the endpoint behind it is platform-only for exactly that reason, and a
 * normal 403 never carries it.
 *
 * ## It renders from the server's vocabulary
 *
 * Every dropdown is populated from `GET .../authorization/vocabulary`, which serves
 * `@uboss/types`. Hard-coding the module or action lists here would let this page drift from what
 * the server enforces, which would make it worse than useless — a debugging tool that lies.
 */
export default function InternalPermissionsPage() {
  const [tenantId, setTenantId] = useState('');
  const [userId, setUserId] = useState('');
  const [module, setModule] = useState('objective');
  const [action, setAction] = useState('Approve');

  const [resourceId, setResourceId] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [createdByUserId, setCreatedByUserId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [actingAsAgent, setActingAsAgent] = useState(false);

  const [vocabulary, setVocabulary] = useState<AuthorizationVocabulary | null>(null);
  const [evaluation, setEvaluation] = useState<PermissionEvaluation | null>(null);
  const [matrix, setMatrix] = useState<PermissionMatrix | null>(null);
  const [sod, setSod] = useState<Awaited<
    ReturnType<typeof authorizationApi.separationOfDuties>
  > | null>(null);
  const [tcsion, setTcsion] = useState<Awaited<
    ReturnType<typeof authorizationApi.tcsionMappings>
  > | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCompany = useCallback(async (id: string) => {
    setError(null);
    try {
      const [loadedVocabulary, loadedSod, loadedTcsion] = await Promise.all([
        authorizationApi.vocabulary(id),
        authorizationApi.separationOfDuties(id),
        authorizationApi.tcsionMappings(id),
      ]);
      setVocabulary(loadedVocabulary);
      setSod(loadedSod);
      setTcsion(loadedTcsion);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not load the authorization vocabulary for that company.',
      );
    }
  }, []);

  useEffect(() => {
    const candidate = tenantId.trim();
    if (candidate.length < 20) {
      return;
    }
    const timer = setTimeout(() => void loadCompany(candidate), 400);
    return () => clearTimeout(timer);
  }, [tenantId, loadCompany]);

  const evaluate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await authorizationApi.evaluate(tenantId.trim(), {
        ...(userId.trim() === '' ? {} : { userId: userId.trim() }),
        module,
        action,
        ...(resourceId.trim() === '' ? {} : { resourceId: resourceId.trim() }),
        ...(ownerUserId.trim() === '' ? {} : { resourceOwnerUserId: ownerUserId.trim() }),
        ...(createdByUserId.trim() === ''
          ? {}
          : { resourceCreatedByUserId: createdByUserId.trim() }),
        ...(departmentId.trim() === '' ? {} : { resourceDepartmentId: departmentId.trim() }),
        ...(actingAsAgent ? { actingAsAgent: true } : {}),
      });
      setEvaluation(result);

      if (userId.trim() !== '') {
        setMatrix(await authorizationApi.matrix(tenantId.trim(), userId.trim()));
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The evaluation failed.');
      setEvaluation(null);
    } finally {
      setBusy(false);
    }
  };

  const traceColumns: DataTableColumn<PermissionTraceStep & { index: number }>[] = [
    { key: 'step', header: '#', render: (row) => String(row.index + 1), width: '48px' },
    { key: 'layer', header: 'Layer', render: (row) => row.layer, width: '170px' },
    {
      key: 'outcome',
      header: 'Outcome',
      width: '120px',
      render: (row) => (
        <StatusBadge
          status={row.outcome}
          tone={
            row.outcome === 'deny'
              ? 'danger'
              : row.outcome === 'allow'
                ? 'success'
                : row.outcome === 'narrow'
                  ? 'warn'
                  : 'grey'
          }
        />
      ),
    },
    { key: 'detail', header: 'Detail', render: (row) => row.detail },
  ];

  return (
    <main className="uboss-content">
      <PageHeader
        title="Permission test"
        description="Ask the authorization engine one question and see the whole reasoning."
        breadcrumbs={[{ label: 'Internal' }, { label: 'Permission test' }]}
      />

      <Banner tone="info">
        Internal diagnostic. It is not linked from anywhere and is not part of the product
        navigation. The endpoint behind it is platform-only, because the decision trace describes a
        company&rsquo;s own policy configuration.
      </Banner>

      {error ? (
        <div style={{ marginTop: 16 }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      ) : null}

      <Card className="uboss-mt-16">
        <CardHeader title="The question" />
        <CardBody>
          <form onSubmit={evaluate} noValidate>
            <FormField
              label="Company (tenant id)"
              required
              hint="Authorization is always evaluated inside one company."
            >
              {(props) => (
                <input
                  {...props}
                  value={tenantId}
                  onChange={(event) => setTenantId(event.target.value)}
                  placeholder="01a0…"
                />
              )}
            </FormField>

            <FormField
              label="Person (user id)"
              hint="Leave blank to evaluate your own permissions."
            >
              {(props) => (
                <input
                  {...props}
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                  placeholder="01a0…"
                />
              )}
            </FormField>

            {vocabulary === null ? (
              <p className="uboss-notice">
                Enter a company id to load its modules, actions and policy vocabulary from the
                server.
              </p>
            ) : (
              <>
                <div className="uboss-row-2">
                  <FormField label="Module" required>
                    {(props) => (
                      <select
                        {...props}
                        value={module}
                        onChange={(event) => setModule(event.target.value)}
                      >
                        <optgroup label="Company">
                          {vocabulary.modules.company.map((key) => (
                            <option key={key} value={key}>
                              {key}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Platform">
                          {vocabulary.modules.platform.map((key) => (
                            <option key={key} value={key}>
                              {key}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    )}
                  </FormField>

                  <FormField label="Action" required>
                    {(props) => (
                      <select
                        {...props}
                        value={action}
                        onChange={(event) => setAction(event.target.value)}
                      >
                        {vocabulary.actions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                            {option.highRisk ? ' — high risk' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </FormField>
                </div>

                <div className="uboss-section-label">
                  The resource (optional — needed for scope and separation of duties)
                </div>

                <div className="uboss-row-2">
                  <FormField label="Resource id">
                    {(props) => (
                      <input
                        {...props}
                        value={resourceId}
                        onChange={(event) => setResourceId(event.target.value)}
                        placeholder="obj-1"
                      />
                    )}
                  </FormField>
                  <FormField label="Department id">
                    {(props) => (
                      <input
                        {...props}
                        value={departmentId}
                        onChange={(event) => setDepartmentId(event.target.value)}
                      />
                    )}
                  </FormField>
                </div>

                <div className="uboss-row-2">
                  <FormField label="Owner user id" hint="Drives Own Work and Team/Subtree.">
                    {(props) => (
                      <input
                        {...props}
                        value={ownerUserId}
                        onChange={(event) => setOwnerUserId(event.target.value)}
                      />
                    )}
                  </FormField>
                  <FormField
                    label="Created by user id"
                    hint="Drives separation of duties — the author, not the owner."
                  >
                    {(props) => (
                      <input
                        {...props}
                        value={createdByUserId}
                        onChange={(event) => setCreatedByUserId(event.target.value)}
                      />
                    )}
                  </FormField>
                </div>

                <label className="uboss-checkbox">
                  <input
                    type="checkbox"
                    checked={actingAsAgent}
                    onChange={(event) => setActingAsAgent(event.target.checked)}
                  />
                  <span>
                    Ask as an Engine Agent / the Executor Agent — an automated actor can never
                    satisfy a four-eyes control.
                  </span>
                </label>

                <div style={{ marginTop: 16 }}>
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy ? 'Evaluating…' : 'Evaluate'}
                  </Button>
                </div>
              </>
            )}
          </form>
        </CardBody>
      </Card>

      {busy && evaluation === null ? <SkeletonText lines={4} /> : null}

      {evaluation ? (
        <>
          <Card className="uboss-mt-16">
            <CardHeader
              title="Decision"
              aside={
                <StatusBadge
                  status={evaluation.decision.allowed ? 'Permitted' : 'Refused'}
                  tone={evaluation.decision.allowed ? 'success' : 'danger'}
                />
              }
            />
            <CardBody>
              <p className="uboss-login-card-sub">{evaluation.decision.message}</p>

              <div className="uboss-kv">
                <span className="uboss-kv-key">Reason code</span>
                <span className="uboss-kv-value">{evaluation.decision.reason ?? '—'}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Decided by layer</span>
                <span className="uboss-kv-value">{evaluation.decision.decidedBy ?? '—'}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Effective scope</span>
                <span className="uboss-kv-value">{evaluation.decision.effectiveScope ?? '—'}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">A list query could cover</span>
                <span className="uboss-kv-value">{evaluation.listingScope}</span>
              </div>

              <div className="uboss-section-label">The person</div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">User type</span>
                <span className="uboss-kv-value">{evaluation.subject.userType}</span>
              </div>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Roles</span>
                <span className="uboss-kv-value">
                  {evaluation.subject.roles.length === 0
                    ? 'none'
                    : evaluation.subject.roles
                        .map(
                          (role) => `${role.customRoleName ?? role.roleKind} @ ${role.scopeKind}`,
                        )
                        .join(', ')}
                </span>
              </div>

              {evaluation.separationOfDuties ? (
                <>
                  <div className="uboss-section-label">Separation of duties</div>
                  <Banner tone={evaluation.separationOfDuties.mandatory ? 'warn' : 'info'}>
                    <b>{evaluation.separationOfDuties.rule}</b>
                    {evaluation.separationOfDuties.mandatory
                      ? ' (mandatory — no lower layer can lift it)'
                      : ' (advisory — a lower layer may grant an exception)'}
                    : {evaluation.separationOfDuties.reason}
                  </Banner>
                </>
              ) : null}
            </CardBody>
          </Card>

          <Card className="uboss-mt-16">
            <CardHeader title="The reasoning, in order" />
            <CardBody>
              <p className="uboss-notice">
                Outermost first: user type, then role and module visibility, then each policy layer,
                then scope, then separation of duties.
              </p>
              <DataTable
                caption="Authorization decision trace"
                columns={traceColumns}
                rows={evaluation.trace.map((step, index) => ({ ...step, index }))}
                rowKey={(row) => `${row.index}`}
                emptyTitle="No trace"
                emptyDescription="The decision was made before any layer was consulted."
              />
            </CardBody>
          </Card>
        </>
      ) : null}

      {matrix ? (
        <Card className="uboss-mt-16">
          <CardHeader title="Full permission matrix" />
          <CardBody>
            <p className="uboss-notice">{matrix.note}</p>
            <p className="uboss-notice">
              {matrix.appliedRules} policy rule(s) and {matrix.appliedSodPolicies}{' '}
              separation-of-duties control(s) apply to this person.
            </p>
            {Object.entries(matrix.matrix).map(([moduleKey, actions]) => (
              <div key={moduleKey} className="uboss-kv">
                <span className="uboss-kv-key">{moduleKey}</span>
                <span className="uboss-kv-value">{actions.join(', ')}</span>
              </div>
            ))}
            {Object.keys(matrix.matrix).length === 0 ? (
              <Banner tone="warn">
                This person can do nothing in this company — no role assignment, or every action is
                denied by policy.
              </Banner>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {sod ? (
        <Card className="uboss-mt-16">
          <CardHeader title="Separation-of-duties configuration" />
          <CardBody>
            <p className="uboss-notice">{sod.note}</p>
            <div className="uboss-section-label">Platform baseline (inherited)</div>
            {sod.platformBaseline.map((policy) => (
              <div key={`${policy.action}-${policy.rule}`} className="uboss-kv">
                <span className="uboss-kv-key">
                  {policy.action} · {policy.module ?? 'every module'}
                </span>
                <span className="uboss-kv-value">
                  {policy.rule}
                  {policy.mandatory ? ' · mandatory' : ''}
                </span>
              </div>
            ))}
            <div className="uboss-section-label">This company&rsquo;s own controls</div>
            {sod.companyPolicies.length === 0 ? (
              <p className="uboss-notice">None configured; the baseline still applies.</p>
            ) : (
              <p className="uboss-notice">{sod.companyPolicies.length} configured.</p>
            )}
          </CardBody>
        </Card>
      ) : null}

      {tcsion ? (
        <Card className="uboss-mt-16">
          <CardHeader
            title="TCSiON mapping"
            aside={
              <StatusBadge
                status={tcsion.loaded === 0 ? 'Not supplied' : `${tcsion.loaded} loaded`}
                tone={tcsion.loaded === 0 ? 'grey' : 'success'}
              />
            }
          />
          <CardBody>
            {/* The note is the point: an empty table must read as "not supplied yet", not a bug. */}
            <Banner tone={tcsion.loaded === 0 ? 'info' : 'ok'}>{tcsion.note}</Banner>
            {tcsion.externalUserTypes.length > 0 ? (
              <div className="uboss-kv">
                <span className="uboss-kv-key">External user types mapped</span>
                <span className="uboss-kv-value">{tcsion.externalUserTypes.join(', ')}</span>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
    </main>
  );
}
