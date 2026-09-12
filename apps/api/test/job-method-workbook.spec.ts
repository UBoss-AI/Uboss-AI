import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import ExcelJS from 'exceljs';

import { JOB_METHOD_COLUMNS, JOB_METHOD_FORM_VERSION, type JobMethodForm } from '@uboss/types';

import { JobMethodWorkbook } from '../src/agents/job-method-workbook.js';

const form = (rows: JobMethodForm['rows'] = []): JobMethodForm => ({
  context: {
    formVersion: JOB_METHOD_FORM_VERSION,
    objectiveId: 'obj-1',
    objectiveVersionId: 'ver-1',
    objectiveName: 'Monthly VAT return',
    aiWorkAssignmentId: 'asn-1',
    assignmentTitle: 'Reconcile the ledger',
    assignedToEmployeeRef: 'EMP-0042',
    downloadedAt: '2026-09-16T09:00:00.000Z',
  },
  columns: JOB_METHOD_COLUMNS,
  rows,
});

/**
 * The Job Method workbook — Prompt 40A (CR-03) §4.
 *
 * A real file has to survive a real journey: downloaded, opened in a spreadsheet, filled in by
 * somebody who was not thinking about parsers, saved, emailed, and uploaded. So the weight here is
 * on the **round trip** and on the ways a returned file differs from the one that was sent — a
 * renamed tab, a mangled heading, a formula where a sentence was expected, rows left blank.
 */
describe('the Job Method workbook', () => {
  it('produces a file a spreadsheet can open, with both sheets', async () => {
    const bytes = await JobMethodWorkbook.toBuffer(form([{ step: 1, whatExactWork: 'Reconcile' }]));

    // The magic number of a ZIP, which is what an .xlsx is. A file that fails this is not a
    // spreadsheet whatever its extension says.
    assert.equal(bytes.subarray(0, 2).toString('utf8'), 'PK');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    assert.notEqual(workbook.getWorksheet('Job Method'), undefined);
    assert.notEqual(workbook.getWorksheet('UBoss'), undefined);
  });

  it('writes the thirteen headings exactly as the client spelled them', async () => {
    const bytes = await JobMethodWorkbook.toBuffer(form());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

    const sheet = workbook.getWorksheet('Job Method');
    const headings: string[] = [];
    sheet?.getRow(1).eachCell((cell) => headings.push(String(cell.value)));

    assert.deepEqual(headings, JOB_METHOD_COLUMNS.map((column) => column.heading));
  });

  it('round-trips a filled form back to the same answers', async () => {
    const original = form([
      {
        step: 1,
        whatExactWork: 'Reconcile the ledger',
        toolSystemWorkplace: 'SAP',
        howExactMethod: 'Match each line by reference and amount',
        agentMustNeverDo: 'Never post an adjusting entry',
      },
    ]);

    const read = await JobMethodWorkbook.fromBuffer(await JobMethodWorkbook.toBuffer(original));

    assert.equal(read.unreadable, null);
    assert.equal(read.envelope.formVersion, JOB_METHOD_FORM_VERSION);
    assert.equal(read.envelope.aiWorkAssignmentId, 'asn-1');
    assert.equal(read.envelope.objectiveVersionId, 'ver-1');
    assert.equal(read.rows.length, 1);
    assert.equal(read.rows[0]?.['WHAT - Exact Work'], 'Reconcile the ledger');
    assert.equal(read.rows[0]?.['TOOL / SYSTEM / WORKPLACE'], 'SAP');
  });

  it('carries the linkage the import needs, and no UBoss Unique ID', async () => {
    // The file is emailed around. A portable cross-company identifier in it would travel with it,
    // which is exactly what Prompt 37A was careful about.
    const bytes = await JobMethodWorkbook.toBuffer(form());
    const text = bytes.toString('binary');
    assert.equal(/UB-[A-Z0-9]{4}-/.test(text), false, 'a UBoss Unique ID reached the file');
  });

  it('ignores the blank rows it added for writing in', async () => {
    // The writer adds spare rows carrying only a step number. Importing them would flag twenty
    // spurious "not filled in" problems against a form somebody completed correctly.
    const read = await JobMethodWorkbook.fromBuffer(
      await JobMethodWorkbook.toBuffer(form([{ step: 1, whatExactWork: 'Only one real step' }])),
    );
    assert.equal(read.rows.length, 1);
  });

  it('still reads a file whose tab was renamed', async () => {
    // People rename tabs. Refusing a correct file over a tab name would cost somebody a round trip
    // for nothing.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await JobMethodWorkbook.toBuffer(form([{ step: 1, whatExactWork: 'Reconcile' }]))) as unknown as ArrayBuffer,
    );
    const sheet = workbook.getWorksheet('Job Method');
    if (sheet !== undefined) sheet.name = 'Sheet1 (2)';

    const read = await JobMethodWorkbook.fromBuffer(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    assert.equal(read.unreadable, null);
    assert.equal(read.rows.length, 1);
  });

  it('still reads headings a spreadsheet round trip mangled', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Job Method');
    // Case changed, spacing collapsed, the dash replaced by an em dash. All of that happens.
    sheet.addRow(['step', 'what — exact  work', 'TOOL/SYSTEM/WORKPLACE']);
    sheet.addRow([1, 'Reconcile', 'SAP']);

    const context = workbook.addWorksheet('UBoss');
    context.addRow(['Form version', 1]);
    context.addRow(['Objective version ID', 'ver-1']);
    context.addRow(['Assignment ID', 'asn-1']);

    const read = await JobMethodWorkbook.fromBuffer(Buffer.from(await workbook.xlsx.writeBuffer()));

    assert.equal(read.unreadable, null);
    assert.equal(read.rows.length, 1);
    // Keyed by the company's own spelling; the service maps it through `normaliseHeading`.
    assert.equal(JobMethodWorkbook.keyFor('what — exact  work'), 'whatExactWork');
    assert.equal(JobMethodWorkbook.keyFor('TOOL/SYSTEM/WORKPLACE'), 'toolSystemWorkplace');
  });

  it('reads a formula cell as the value the person can see', async () => {
    // Somebody builds the time column from a calculation. Reading `cell.value` directly would give
    // an object, and an object reaching the importer becomes an `Invalid` flag on a correct cell.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Job Method');
    sheet.addRow(['Step', 'WHAT - Exact Work', 'TIME']);
    const row = sheet.addRow([1, 'Reconcile', null]);
    row.getCell(3).value = { formula: 'CONCATENATE("2"," hours")', result: '2 hours' };

    const context = workbook.addWorksheet('UBoss');
    context.addRow(['Form version', 1]);
    context.addRow(['Objective version ID', 'ver-1']);
    context.addRow(['Assignment ID', 'asn-1']);

    const read = await JobMethodWorkbook.fromBuffer(Buffer.from(await workbook.xlsx.writeBuffer()));
    assert.equal(read.rows[0]?.['TIME'], '2 hours');
  });

  it('reads rich text as its words', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Job Method');
    sheet.addRow(['Step', 'WHAT - Exact Work']);
    const row = sheet.addRow([1, null]);
    row.getCell(2).value = {
      richText: [
        { text: 'Reconcile ' },
        { text: 'carefully', font: { bold: true } },
      ],
    };

    const context = workbook.addWorksheet('UBoss');
    context.addRow(['Form version', 1]);
    context.addRow(['Objective version ID', 'ver-1']);
    context.addRow(['Assignment ID', 'asn-1']);

    const read = await JobMethodWorkbook.fromBuffer(Buffer.from(await workbook.xlsx.writeBuffer()));
    assert.equal(read.rows[0]?.['WHAT - Exact Work'], 'Reconcile carefully');
  });

  it('refuses something that is not a spreadsheet, in words a person can act on', async () => {
    const read = await JobMethodWorkbook.fromBuffer(Buffer.from('this is a PDF, honestly'));
    assert.notEqual(read.unreadable, null);
    assert.match(read.unreadable ?? '', /could not be opened as a spreadsheet/i);
    // "That is not a spreadsheet" and "that spreadsheet has no headings" are different problems.
    assert.match(read.unreadable ?? '', /rather than a PDF/i);
  });

  it('refuses a spreadsheet with no Job Method headings, differently', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Budget');
    sheet.addRow(['Month', 'Spend']);
    sheet.addRow(['January', 1000]);

    const read = await JobMethodWorkbook.fromBuffer(Buffer.from(await workbook.xlsx.writeBuffer()));
    assert.match(read.unreadable ?? '', /no sheet in that file has the Job Method column headings/i);
  });

  it('reports a missing linkage block rather than inventing one', async () => {
    // Somebody deletes the UBoss sheet because it looked like clutter. The import must refuse and
    // say so, not guess which work the answers belong to.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Job Method');
    sheet.addRow(['Step', 'WHAT - Exact Work']);
    sheet.addRow([1, 'Reconcile']);

    const read = await JobMethodWorkbook.fromBuffer(Buffer.from(await workbook.xlsx.writeBuffer()));
    assert.equal(read.unreadable, null);
    assert.equal(read.envelope.aiWorkAssignmentId, null);
    assert.equal(read.envelope.objectiveVersionId, null);
  });

  it('names the file after the work, safely', () => {
    const name = JobMethodWorkbook.filenameFor(form());
    assert.equal(name, 'job-method-Reconcile-the-ledger.xlsx');

    const nasty = JobMethodWorkbook.filenameFor({
      ...form(),
      context: { ...form().context, assignmentTitle: '../../etc/passwd; rm -rf /' },
    });
    // No separators, no punctuation that a shell or a path would read.
    assert.equal(/[/\\;.]/.test(nasty.replace('.xlsx', '')), false);
    assert.match(nasty, /\.xlsx$/);
  });
});
