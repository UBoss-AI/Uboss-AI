'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  StatusBadge,
  type DataTableColumn,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  filesApi,
  knowledgeApi,
  type FileMeta,
  type KnowledgeMeta,
  type KnowledgePolicyView,
  type KnowledgeSourceView,
  type StoredFileView,
} from '../../lib/api-client';

/**
 * Settings › Knowledge & Data — Prompt 35.
 *
 * §Settings asks for *"approved knowledge sources, classification / retention policy where
 * available"*, and this is those three, in that order, on one screen.
 *
 * ## What the screen says out loud
 *
 * **That the scanner is a mock.** Every file's scan column carries it, and the banner at the top
 * names both adapters. A green "Clean" tick that came from a mock and did not say so would be the
 * single most misleading thing in this product: a company would answer a compliance question with
 * it.
 *
 * **That nothing redacts.** The redaction stance comes from the server verbatim rather than being
 * written here, so the screen cannot drift from what the engine actually does.
 *
 * ## Why upload is a plain file input and not a drop zone
 *
 * Because a drop zone is a component, and this is a settings panel that has to work. The input
 * reads the bytes, base64-encodes them and posts them — the same request a script would make. When
 * the approved UI asks for a richer upload experience it will be a `packages/ui` primitive rather
 * than a second upload path built here.
 */

const SCAN_TONE: Record<string, StatusTone> = {
  Pending: 'grey',
  Scanning: 'blue',
  Clean: 'success',
  Infected: 'danger',
  Quarantined: 'warn',
};

const CLASSIFICATION_TONE: Record<string, StatusTone> = {
  Public: 'grey',
  Internal: 'blue',
  Confidential: 'warn',
  Restricted: 'danger',
};

const SOURCE_TONE: Record<string, StatusTone> = {
  Draft: 'grey',
  Approved: 'success',
  Retired: 'warn',
};

function when(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function KnowledgeAndDataPanel({ tenantId }: { tenantId: string | null }): React.JSX.Element {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [knowledgeMeta, setKnowledgeMeta] = useState<KnowledgeMeta | null>(null);
  const [policy, setPolicy] = useState<KnowledgePolicyView | null>(null);
  const [files, setFiles] = useState<StoredFileView[]>([]);
  const [sources, setSources] = useState<KnowledgeSourceView[]>([]);
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [openFile, setOpenFile] = useState<StoredFileView | null>(null);
  const [reason, setReason] = useState('');

  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    if (tenantId === null) return;
    setError(null);

    Promise.all([
      filesApi.meta(tenantId),
      knowledgeApi.meta(tenantId),
      filesApi.policy(tenantId),
      filesApi.list(tenantId, includeDeleted),
      knowledgeApi.list(tenantId),
    ])
      .then(([fileMeta, sourceMeta, current, listed, listedSources]) => {
        setMeta(fileMeta);
        setKnowledgeMeta(sourceMeta);
        setPolicy(current);
        setFiles(listed.files);
        setSources(listedSources.sources);
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not load this company’s knowledge and files.',
        ),
      );
  }, [includeDeleted, tenantId]);

  useEffect(load, [load]);

  const upload = useCallback(
    async (chosen: File) => {
      if (tenantId === null) return;
      setBusy(true);
      setError(null);
      setNotice(null);

      try {
        const buffer = await chosen.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        // Chunked, because `String.fromCharCode(...bytes)` on a multi-megabyte array overflows the
        // call stack — the kind of failure that only appears on a real document.
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        }

        const created = await filesApi.upload(tenantId, {
          filename: chosen.name,
          contentType: chosen.type === '' ? 'application/octet-stream' : chosen.type,
          contentBase64: btoa(binary),
        });

        setNotice(
          created.scanState === 'Clean'
            ? `${created.filename} uploaded and scanned clean.`
            : `${created.filename} uploaded — the scan said ${created.scanState}. Nothing may read it.`,
        );
        load();
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'That upload was refused.');
      } finally {
        setBusy(false);
        if (fileInput.current !== null) fileInput.current.value = '';
      }
    },
    [load, tenantId],
  );

  const act = useCallback(
    (work: () => Promise<unknown>, success: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      work()
        .then(() => {
          setNotice(success);
          setReason('');
          setOpenFile(null);
          load();
        })
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'That did not work.'),
        )
        .finally(() => setBusy(false));
    },
    [load],
  );

  const fileColumns: DataTableColumn<StoredFileView>[] = [
    {
      key: 'filename',
      header: 'File',
      render: (file) => (
        <button type="button" className="uboss-linkish" onClick={() => setOpenFile(file)}>
          {file.filename}
        </button>
      ),
    },
    { key: 'size', header: 'Size', render: (file) => size(file.sizeBytes) },
    {
      key: 'classification',
      header: 'Classification',
      render: (file) => (
        <StatusBadge
          status={file.classification}
          tone={CLASSIFICATION_TONE[file.classification] ?? 'grey'}
        />
      ),
    },
    {
      key: 'scan',
      header: 'Scan',
      render: (file) => (
        <span className="uboss-inline">
          <StatusBadge status={file.scanState} tone={SCAN_TONE[file.scanState] ?? 'grey'} />
          {/* The honesty flag, on every row rather than once at the top: a reader scanning this
              column must not have to remember a banner. */}
          {file.scannedByRealScanner === false ? (
            <small className="uboss-muted"> mock scanner</small>
          ) : null}
        </span>
      ),
    },
    {
      key: 'hold',
      header: 'Hold',
      render: (file) =>
        file.onLegalHold ? <StatusBadge status="Legal hold" tone="danger" /> : <span>—</span>,
    },
    { key: 'uploaded', header: 'Uploaded', render: (file) => when(file.uploadedAt) },
    {
      key: 'state',
      header: 'State',
      render: (file) =>
        file.deletedAt !== null ? (
          <StatusBadge status="Deleted" tone="grey" />
        ) : file.usable ? (
          <StatusBadge status="Usable" tone="success" />
        ) : (
          <StatusBadge status="Not usable" tone="warn" />
        ),
    },
  ];

  const sourceColumns: DataTableColumn<KnowledgeSourceView>[] = [
    { key: 'name', header: 'Source', render: (source) => source.name },
    {
      key: 'kind',
      header: 'Kind',
      render: (source) =>
        knowledgeMeta?.kinds.find((kind) => kind.key === source.kind)?.label ?? source.kind,
    },
    {
      key: 'state',
      header: 'State',
      render: (source) => (
        <StatusBadge status={source.state} tone={SOURCE_TONE[source.state] ?? 'grey'} />
      ),
    },
    {
      key: 'scope',
      header: 'Who may consult it',
      render: (source) =>
        knowledgeMeta?.accessScopes.find((scope) => scope.key === source.accessScope)?.label ??
        source.accessScope,
    },
    {
      key: 'classification',
      header: 'Approved to hold',
      render: (source) => (
        <StatusBadge
          status={source.classification}
          tone={CLASSIFICATION_TONE[source.classification] ?? 'grey'}
        />
      ),
    },
    {
      key: 'files',
      header: 'Files',
      render: (source) => (
        <span>
          {source.fileCount}
          {source.unusableFileCount > 0 ? (
            <small className="uboss-muted"> · {source.unusableFileCount} not usable</small>
          ) : null}
        </span>
      ),
    },
    {
      key: 'approve',
      header: '',
      render: (source) =>
        source.state === 'Draft' ? (
          <Button
            variant="primary"
            disabled={busy || tenantId === null}
            onClick={() =>
              act(
                () => knowledgeApi.approve(tenantId as string, source.id),
                `"${source.name}" approved.`,
              )
            }
          >
            Approve
          </Button>
        ) : (
          <span className="uboss-muted">—</span>
        ),
    },
  ];

  return (
    <div className="uboss-stack">
      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      {notice !== null ? <Banner tone="ok">{notice}</Banner> : null}

      {meta !== null ? (
        <Banner tone="info">
          {/* Both facts, from the server. A company reading this screen is entitled to know what
              actually examined its files and what happens to sensitive content. */}
          Storage: {meta.adapters.storage}. Scanner: {meta.adapters.scanner} — no antivirus product
          examined these files, and nothing in UBoss claims one did. {meta.redactionStance}
        </Banner>
      ) : null}

      <Card>
        <CardBody>
          <h3>Data controls</h3>
          {policy === null ? (
            <p className="uboss-muted">Loading the company’s policy…</p>
          ) : (
            <dl className="uboss-definitions">
              <dt>Largest upload</dt>
              <dd>{size(policy.maxUploadBytes)}</dd>
              <dt>Accepted types</dt>
              <dd>{policy.allowedContentTypes.length} formats</dd>
              <dt>Retention</dt>
              <dd>
                {policy.defaultRetentionDays === null
                  ? 'Kept until somebody deletes them'
                  : `${policy.defaultRetentionDays} days, then ${policy.defaultRetentionAction}`}
              </dd>
              <dt>May be exported inside the company up to</dt>
              <dd>
                <StatusBadge
                  status={policy.exportCeiling}
                  tone={CLASSIFICATION_TONE[policy.exportCeiling] ?? 'grey'}
                />
              </dd>
              <dt>May leave the company up to</dt>
              <dd>
                <StatusBadge
                  status={policy.externalEgressCeiling}
                  tone={CLASSIFICATION_TONE[policy.externalEgressCeiling] ?? 'grey'}
                />
              </dd>
            </dl>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="uboss-row uboss-row--between">
            <h3>Files</h3>
            <div className="uboss-actions">
              <label className="uboss-checkbox">
                <input
                  type="checkbox"
                  checked={includeDeleted}
                  onChange={(event) => setIncludeDeleted(event.target.checked)}
                />
                <span>Show deleted</span>
              </label>
              <input
                ref={fileInput}
                type="file"
                disabled={busy || tenantId === null}
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  if (chosen !== undefined) void upload(chosen);
                }}
              />
            </div>
          </div>

          <DataTable
            caption="Files this company holds"
            columns={fileColumns}
            rows={files}
            rowKey={(file) => file.id}
            emptyTitle="No files yet"
            emptyDescription="Upload a document and UBoss will scan it before anything may read it."
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3>Approved knowledge sources</h3>
          <p className="uboss-muted">
            Nothing consults a source that has not been approved. Approving is a separate grant from
            assembling one, so the person who built it is not, by default, the person who signs it
            off.
          </p>
          <DataTable
            caption="Knowledge sources"
            columns={sourceColumns}
            rows={sources}
            rowKey={(source) => source.id}
            emptyTitle="No knowledge sources"
            emptyDescription="A knowledge source is a named, approved, scoped collection an Engine Agent may consult."
          />
        </CardBody>
      </Card>

      <Drawer
        open={openFile !== null}
        onClose={() => {
          setOpenFile(null);
          setReason('');
        }}
        title={openFile?.filename ?? 'File'}
        footer={
          openFile === null || tenantId === null ? null : (
            <div className="uboss-actions">
              <Button
                variant="danger"
                disabled={busy || openFile.deletedAt !== null || reason.trim().length < 4}
                onClick={() =>
                  act(
                    () => filesApi.remove(tenantId, openFile.id, reason.trim()),
                    `${openFile.filename} deleted.`,
                  )
                }
              >
                Delete the content
              </Button>
              <Button
                variant="navy"
                disabled={busy || reason.trim().length < 4}
                onClick={() =>
                  act(
                    () =>
                      filesApi.legalHold(tenantId, openFile.id, {
                        onHold: !openFile.onLegalHold,
                        reason: reason.trim(),
                      }),
                    openFile.onLegalHold ? 'Legal hold lifted.' : 'Legal hold placed.',
                  )
                }
              >
                {openFile.onLegalHold ? 'Lift the legal hold' : 'Place a legal hold'}
              </Button>
            </div>
          )
        }
      >
        {openFile === null ? null : (
          <div className="uboss-stack">
            <dl className="uboss-definitions">
              <dt>Type</dt>
              <dd>{openFile.contentType}</dd>
              <dt>Size</dt>
              <dd>{size(openFile.sizeBytes)}</dd>
              <dt>Classification</dt>
              <dd>{openFile.classification}</dd>
              <dt>Scan</dt>
              <dd>
                {meta?.scanStates.find((state) => state.key === openFile.scanState)?.description ??
                  openFile.scanState}
              </dd>
              <dt>Scanned by a real product</dt>
              <dd>{openFile.scannedByRealScanner === true ? 'Yes' : 'No — the mock scanner'}</dd>
              <dt>Retention</dt>
              <dd>
                {openFile.retentionExpiresAt === null
                  ? 'None set'
                  : `${when(openFile.retentionExpiresAt)} · ${openFile.retentionAction}`}
              </dd>
              {openFile.onLegalHold ? (
                <>
                  <dt>Legal hold</dt>
                  <dd>{openFile.legalHoldReason ?? 'Held'}</dd>
                </>
              ) : null}
              {openFile.deletedAt === null ? null : (
                <>
                  <dt>Deleted</dt>
                  <dd>
                    {when(openFile.deletedAt)} · {openFile.deletedReason}
                  </dd>
                </>
              )}
            </dl>

            <label className="uboss-field">
              <span>Why</span>
              <textarea
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="A legal hold or a deletion is a decision somebody may be asked about."
              />
            </label>
          </div>
        )}
      </Drawer>
    </div>
  );
}
