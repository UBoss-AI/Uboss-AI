'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  FormField,
  PageHeader,
  SkeletonText,
  StatusBadge,
  type DataTableColumn,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  auditApi,
  type AuditCheckpoint,
  type AuditEventRow,
  type AuditVocabulary,
  type ChainVerificationResponse,
  type SecurityEventRow,
} from '../../../lib/api-client';

/**
 * The internal audit read page.
 *
 * ## Why this exists and the Security Center does not
 *
 * Prompt 8 asked for the services and APIs, and explicitly **not** the full Security Center UI.
 * So this is the same kind of thing as `/internal/permissions`: a diagnostic reached by typing
 * the URL, not linked from any navigation, deliberately plain. Its job is to make the trails and
 * the tamper-evidence guarantee visible to whoever is verifying that Prompt 8 works, so that
 * "the chain verifies" is something you can see rather than something a test asserts.
 *
 * The real screen is the `audit` section of Settings ("Audit & Activity" in the reference UI),
 * and it is a later prompt's work. Building a convincing-looking Security Center now, over
 * services whose retention, alerting and incident workflow do not exist yet, would make the
 * product look finished in the one area where looking finished is most dangerous.
 *
 * ## The guarantee is printed, not summarised
 *
 * `verify` returns the exact guarantee as prose, and this page shows it verbatim, including the
 * part that begins "NOT guaranteed". A screen that renders a green tick and drops the caveat
 * would be worse than showing nothing: somebody would rely on it.
 */
export default function InternalAuditPage() {
  const [tenantId, setTenantId] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const [vocabulary, setVocabulary] = useState<AuditVocabulary | null>(null);
  const [auditRows, setAuditRows] = useState<AuditEventRow[] | null>(null);
  const [auditTotal, setAuditTotal] = useState(0);
  const [securityRows, setSecurityRows] = useState<SecurityEventRow[] | null>(null);
  const [verification, setVerification] = useState<ChainVerificationResponse | null>(null);
  const [checkpoints, setCheckpoints] = useState<AuditCheckpoint[] | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Run one request and surface whatever the server said.
   *
   * The API's refusals are written for people — "Reading the audit trail requires whole-company
   * scope; this grant is Department" — so they are shown as-is rather than replaced with a
   * generic failure. On a diagnostic page the exact refusal *is* the diagnosis.
   */
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      );
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!tenantId) {
      setVocabulary(null);
      return;
    }
    void run(() => auditApi.vocabulary(tenantId)).then(setVocabulary);
  }, [tenantId, run]);

  const loadTrails = useCallback(async () => {
    if (!tenantId) {
      return;
    }
    const audit = await run(() =>
      auditApi.events(tenantId, { limit: 50, action: actionFilter || undefined }),
    );
    if (audit) {
      setAuditRows(audit.rows);
      setAuditTotal(audit.total);
    }
    const security = await run(() =>
      auditApi.securityEvents(tenantId, {
        limit: 50,
        category: categoryFilter || undefined,
      }),
    );
    if (security) {
      setSecurityRows(security.rows);
    }
  }, [tenantId, actionFilter, categoryFilter, run]);

  const verify = useCallback(async () => {
    if (!tenantId) {
      return;
    }
    const result = await run(() => auditApi.verify(tenantId));
    if (result) {
      setVerification(result);
    }
    const sealed = await run(() => auditApi.checkpoints(tenantId));
    if (sealed) {
      setCheckpoints(sealed.checkpoints);
    }
  }, [tenantId, run]);

  const auditColumns: DataTableColumn<AuditEventRow>[] = [
    {
      key: 'position',
      header: '#',
      // The chain position, shown because it is the thing that makes the row verifiable. A row
      // with no position predates Prompt 8 and is labelled rather than left blank.
      render: (row) => row.chain.sequence ?? <span title="Written before Prompt 8">unchained</span>,
    },
    { key: 'action', header: 'Action', render: (row) => row.action },
    {
      key: 'resource',
      header: 'Resource',
      render: (row) =>
        `${row.resourceType}${row.resourceId ? ` · ${row.resourceId}` : ''}` +
        (row.resourceRef ? ` (${row.resourceRef})` : ''),
    },
    { key: 'actor', header: 'Actor', render: (row) => row.actorUserId ?? '—' },
    // `reason` gets its own column rather than being folded into the summary: "why" is the field
    // a reviewer is actually looking for, and burying it makes the whole column pointless.
    { key: 'reason', header: 'Reason', render: (row) => row.reason ?? '—' },
    {
      key: 'when',
      header: 'When',
      render: (row) => new Date(row.occurredAt).toLocaleString(),
    },
  ];

  const securityColumns: DataTableColumn<SecurityEventRow>[] = [
    { key: 'position', header: '#', render: (row) => row.chain.sequence ?? '—' },
    {
      key: 'severity',
      header: 'Severity',
      render: (row) => <StatusBadge status={row.severity} tone={toneForSeverity(row.severity)} />,
    },
    { key: 'category', header: 'Category', render: (row) => row.category },
    { key: 'outcome', header: 'Outcome', render: (row) => row.outcome },
    { key: 'action', header: 'Action', render: (row) => row.action },
    {
      key: 'who',
      header: 'Actor → subject',
      render: (row) =>
        row.subjectUserId && row.subjectUserId !== row.actorUserId
          ? `${row.actorUserId ?? '—'} → ${row.subjectUserId}`
          : (row.actorUserId ?? '—'),
    },
    { key: 'when', header: 'When', render: (row) => new Date(row.occurredAt).toLocaleString() },
  ];

  return (
    <main className="uboss-page">
      <PageHeader
        title="Audit trail (internal)"
        description="A diagnostic for the Prompt 8 audit and security foundations. Not the Security Center."
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <Card>
        <CardHeader title="Company" />
        <CardBody>
          <FormField
            label="Company id"
            hint="A workspace id you are a member of. The server derives the trail scope from your verified membership, never from this field."
          >
            {(wiring) => (
              <input
                {...wiring}
                className="uboss-input"
                value={tenantId}
                onChange={(event) => setTenantId(event.target.value.trim())}
                placeholder="018f…"
              />
            )}
          </FormField>

          <FormField label="Audit action" hint="An exact action key, e.g. break_glass.approved.">
            {(wiring) => (
              <input
                {...wiring}
                className="uboss-input"
                value={actionFilter}
                onChange={(event) => setActionFilter(event.target.value.trim())}
                placeholder="objective.published"
              />
            )}
          </FormField>

          <FormField label="Security category">
            {(wiring) => (
              <select
                {...wiring}
                className="uboss-input"
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
              >
                <option value="">Any</option>
                {/* Rendered from the server's vocabulary, so this page cannot drift from what
                    the API actually accepts. */}
                {(vocabulary?.securityCategories ?? []).map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            )}
          </FormField>

          <div className="uboss-actions">
            <Button onClick={() => void loadTrails()} disabled={!tenantId || busy}>
              Load trails
            </Button>
            <Button variant="ghost" onClick={() => void verify()} disabled={!tenantId || busy}>
              Verify chains
            </Button>
          </div>
        </CardBody>
      </Card>

      {verification ? (
        <Card>
          <CardHeader
            title="Tamper evidence"
            aside={
              <span className="uboss-muted-3">{vocabulary?.chainVersion ?? 'unknown format'}</span>
            }
          />
          <CardBody>
            <div className="uboss-actions">
              <StatusBadge
                status={verification.audit.intact ? 'Intact' : 'Broken'}
                tone={verification.audit.intact ? 'success' : 'danger'}
              />
              <span>
                Audit chain: {verification.audit.verifiedCount} row(s) verified, head{' '}
                {verification.audit.headSequence ?? '—'}
                {verification.audit.unchainedCount > 0
                  ? `, ${verification.audit.unchainedCount} row(s) written before Prompt 8 and NOT covered`
                  : ''}
              </span>
            </div>
            <div className="uboss-actions">
              <StatusBadge
                status={verification.security.intact ? 'Intact' : 'Broken'}
                tone={verification.security.intact ? 'success' : 'danger'}
              />
              <span>
                Security chain: {verification.security.verifiedCount} row(s) verified, head{' '}
                {verification.security.headSequence ?? '—'}
              </span>
            </div>

            {/* Printed verbatim, caveat included. See the file comment. */}
            <p className="uboss-muted-3">{verification.guarantee}</p>

            {[...verification.audit.breaks, ...verification.security.breaks].map((broken) => (
              <Banner key={`${broken.rowId}-${broken.kind}`} tone="danger">
                <strong>{broken.kind}</strong> at position {broken.sequence ?? '—'}: {broken.detail}
              </Banner>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {checkpoints ? (
        <Card>
          <CardHeader title="Checkpoints" />
          <CardBody>
            <p className="uboss-muted-3">
              A checkpoint only proves anything once a copy of it lives outside this database.
            </p>
            {checkpoints.length === 0 ? (
              <EmptyState
                title="No checkpoints sealed"
                description="Without one, a wholesale rewrite with recomputed hashes would be undetectable."
              />
            ) : (
              <ul>
                {checkpoints.map((checkpoint) => (
                  <li key={checkpoint.id}>
                    {checkpoint.trail} · position {checkpoint.sequence} · {checkpoint.rowCount}{' '}
                    row(s) ·{' '}
                    {checkpoint.anchored ? (
                      <StatusBadge status="Anchored" tone="success" />
                    ) : (
                      <StatusBadge status="Not anchored" tone="warn" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Audit trail"
          aside={<span className="uboss-muted-3">{auditTotal} row(s)</span>}
        />
        <CardBody>
          {busy && auditRows === null ? (
            <SkeletonText lines={4} />
          ) : auditRows === null ? (
            <EmptyState title="Nothing loaded" description="Enter a company id and load." />
          ) : (
            <DataTable
              columns={auditColumns}
              rows={auditRows}
              rowKey={(row) => row.id}
              caption="What changed, who changed it, and why."
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Security trail" />
        <CardBody>
          <p className="uboss-muted-3">
            Login, session, risk, support and access events for this company.
          </p>
          {securityRows === null ? (
            <EmptyState title="Nothing loaded" description="Enter a company id and load." />
          ) : (
            <DataTable
              columns={securityColumns}
              rows={securityRows}
              rowKey={(row) => row.id}
              caption="Tenant-less platform events are deliberately not reachable here."
            />
          )}
        </CardBody>
      </Card>
    </main>
  );
}

/**
 * Severity to badge tone.
 *
 * `Notice` is grey rather than amber on purpose, matching the classification table on the server:
 * a failed sign-in is a notice, and colouring every notice amber would train the reader to
 * ignore amber.
 */
function toneForSeverity(severity: string): StatusTone {
  switch (severity) {
    case 'Critical':
      return 'danger';
    case 'Warning':
      return 'warn';
    case 'Notice':
      return 'grey';
    default:
      return 'blue';
  }
}
