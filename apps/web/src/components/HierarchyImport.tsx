'use client';

import { Banner, Button, DataTable, Modal, SkeletonText, StatusBadge } from '@uboss/ui';
import { useCallback, useEffect, useState } from 'react';

import { accessApi, ApiError, type BulkPreview } from '../lib/api-client';

/**
 * Importing a hierarchy from a spreadsheet.
 *
 * ## Three steps, and the middle one is the point
 *
 * Download a template, fill it in, upload it — and then **nothing happens** until somebody has
 * seen what would. The upload produces a preview: every row, its state, and the reason it was
 * refused. Only after that is there an Apply button.
 *
 * That order is the whole feature. A hierarchy import that ran immediately would create reporting
 * relationships nobody checked, and a wrong manager is not a typo — it decides who approves whose
 * work and who can see it. The client's own instruction is "do not silently create incorrect
 * reporting relationships", and a preview is the only thing that makes that true.
 *
 * ## Why it reuses the bulk pipeline rather than importing here
 *
 * Every row is applied through the same service that adds one employee by hand, so every rule that
 * applies to one person applies to four hundred. Nothing in this component writes anything.
 *
 * ## Why the template is downloaded rather than described
 *
 * It arrives carrying this company's own departments and people on two reference sheets, because
 * the two things that get an import rejected are a department that does not exist and a manager's
 * name spelt differently from the record. Both are unavoidable if somebody is typing from memory.
 */
export function HierarchyImport({
  tenantId,
  open,
  onClose,
  onImported,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
  /** Called after rows were applied, so the chart can be reloaded. */
  onImported: () => void;
}) {
  const [columns, setColumns] = useState<
    { heading: string; required: boolean; note: string }[] | null
  >(null);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  useEffect(() => {
    if (!open || columns !== null) return;
    accessApi
      .hierarchyTemplateColumns(tenantId)
      .then((result) => setColumns(result.columns))
      .catch(() => setColumns([]));
  }, [open, columns, tenantId]);

  const reset = useCallback(() => {
    setPreview(null);
    setFileName(null);
    setError(null);
    setApplied(null);
  }, []);

  const download = () => {
    setError(null);
    setBusy(true);
    accessApi
      .downloadHierarchyTemplate(tenantId)
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'The template could not be downloaded.',
        ),
      )
      .finally(() => setBusy(false));
  };

  const upload = (file: File) => {
    setError(null);
    setApplied(null);
    setBusy(true);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onerror = () => {
      setError('That file could not be read.');
      setBusy(false);
    };
    reader.onload = () => {
      // `readAsDataURL` gives `data:...;base64,XXXX`; the endpoint wants the payload alone.
      const encoded = String(reader.result ?? '').split(',')[1] ?? '';
      accessApi
        .validateHierarchyWorkbook(tenantId, { file: encoded, sourceFileName: file.name })
        .then(setPreview)
        .catch((caught: unknown) =>
          setError(caught instanceof ApiError ? caught.message : 'That file could not be read.'),
        )
        .finally(() => setBusy(false));
    };
    reader.readAsDataURL(file);
  };

  const apply = () => {
    if (preview === null) return;
    setBusy(true);
    setError(null);
    accessApi
      .applyBulk(tenantId, preview.operationId)
      .then((result) => {
        setApplied(
          `${result.applied} added` +
            (result.failed > 0 ? `, ${result.failed} failed` : '') +
            (result.skipped > 0 ? `, ${result.skipped} skipped` : '') +
            '.',
        );
        setPreview(null);
        onImported();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'The import could not be applied.'),
      )
      .finally(() => setBusy(false));
  };

  const discard = () => {
    if (preview === null) {
      reset();
      return;
    }
    setBusy(true);
    accessApi
      .cancelBulk(tenantId, preview.operationId)
      .catch(() => undefined)
      .finally(() => {
        reset();
        setBusy(false);
      });
  };

  return (
    <Modal
      open={open}
      title="Import hierarchy"
      onClose={() => {
        discard();
        onClose();
      }}
      footer={
        preview === null ? (
          <Button
            onClick={() => {
              discard();
              onClose();
            }}
          >
            Close
          </Button>
        ) : (
          <>
            <Button onClick={discard} disabled={busy}>
              Discard
            </Button>
            <Button
              variant="primary"
              onClick={apply}
              disabled={busy || preview.validRows === 0}
              title={
                preview.validRows === 0
                  ? 'No row passed validation, so there is nothing to apply.'
                  : undefined
              }
            >
              {busy
                ? 'Applying…'
                : `Add ${preview.validRows} employee${preview.validRows === 1 ? '' : 's'}`}
            </Button>
          </>
        )
      }
    >
      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      {applied !== null ? <Banner tone="ok">{applied}</Banner> : null}

      {preview === null ? (
        <>
          <p className="uboss-muted">
            Download the template, fill it in, and upload it. Nothing is created until you have seen
            exactly what would be.
          </p>

          <div className="uboss-row-actions">
            <Button icon="arrow-down" onClick={download} disabled={busy}>
              Download Excel template
            </Button>

            {/*
              A real file input, dressed as a button. A drag-and-drop zone with no input behind it
              is unreachable from a keyboard, and this is an administrator's screen.
            */}
            <label className="uboss-btn" htmlFor="hierarchy-import-file">
              Upload filled template
            </label>
            <input
              id="hierarchy-import-file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="uboss-sr-only"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) upload(file);
                // Cleared so re-picking the same file fires the event again.
                event.target.value = '';
              }}
            />
          </div>

          {busy ? <SkeletonText lines={2} /> : null}

          {columns === null ? null : columns.length === 0 ? null : (
            <>
              <p className="uboss-muted-3">
                The template carries these columns, plus two reference sheets listing this company’s
                departments and people — copy the values from those rather than typing them.
              </p>
              <ul className="uboss-muted-3">
                {columns.map((column) => (
                  <li key={column.heading}>
                    <b>{column.heading}</b>
                    {column.required ? ' *' : ''} — {column.note}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <>
          <p className="uboss-muted">
            {fileName === null ? 'That file' : fileName} has {preview.totalRows} row
            {preview.totalRows === 1 ? '' : 's'}: <b>{preview.validRows}</b> ready and{' '}
            <b>{preview.invalidRows}</b> refused. {preview.note}
          </p>

          {preview.invalidRows > 0 ? (
            <Banner tone="warn">
              Only the {preview.validRows} valid row{preview.validRows === 1 ? '' : 's'} will be
              added. Fix the refused ones in the spreadsheet and upload it again — nothing is
              created twice, because an Employee ID already in use is itself refused.
            </Banner>
          ) : null}

          <DataTable
            caption="Every row, and why it was refused"
            columns={[
              { key: 'row', header: 'Row', render: (row) => row.rowNumber },
              {
                key: 'name',
                header: 'Employee',
                render: (row) => (
                  <>
                    <b>{String(row.input['employeeName'] ?? '—')}</b>
                    <br />
                    <small className="uboss-muted-3">
                      {String(row.input['designation'] ?? '')}
                      {row.input['department'] ? ` · ${String(row.input['department'])}` : ''}
                    </small>
                  </>
                ),
              },
              {
                key: 'manager',
                header: 'Reports to',
                render: (row) => String(row.input['reportingManager'] ?? '—'),
              },
              {
                key: 'state',
                header: 'State',
                render: (row) => (
                  <StatusBadge
                    status={row.state}
                    tone={row.state === 'Valid' ? 'success' : 'danger'}
                  />
                ),
              },
              {
                key: 'why',
                header: 'Why',
                // Every reason, not the first: somebody fixing a spreadsheet wants one pass.
                render: (row) =>
                  row.errors.length === 0 ? (
                    <span className="uboss-muted-3">—</span>
                  ) : (
                    <ul className="uboss-muted-3">
                      {row.errors.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ),
              },
            ]}
            rows={preview.rows}
            rowKey={(row) => String(row.rowNumber)}
          />
        </>
      )}
    </Modal>
  );
}
