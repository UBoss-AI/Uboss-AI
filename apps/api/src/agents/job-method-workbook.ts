import ExcelJS from 'exceljs';

import {
  JOB_METHOD_COLUMNS,
  JOB_METHOD_KEY_BY_HEADING,
  JOB_METHOD_MAX_ROWS,
  normaliseHeading,
  type JobMethodColumnKey,
  type JobMethodForm,
} from '@uboss/types';

/** A row as it came out of a spreadsheet: headings exactly as typed, values as read. */
export type IncomingSheetRow = Record<string, unknown>;

/** What the context sheet is called, and the labels it uses. */
const CONTEXT_SHEET = 'UBoss';
const METHOD_SHEET = 'Job Method';

/**
 * The Job Method as a real spreadsheet — Prompt 40A (CR-03) §4.
 *
 * ## Why a workbook and not JSON
 *
 * Because the person this is for does not have an API client. CR-03 describes an employee who fills
 * the form in **offline** and sends it back, and that only works if the thing they receive opens in
 * Excel. A JSON contract with "an adapter is a client concern" written next to it is a feature that
 * exists for developers.
 *
 * ## Two sheets, and the second one is not decoration
 *
 * **`Job Method`** is the thirteen columns. **`UBoss`** carries the linkage — form version,
 * objective, assignment — and is what makes an upload verifiable at all. Without it a returned file
 * is thirteen columns of text with no way to know which work it describes, and the import would
 * have to trust whoever uploaded it.
 *
 * The context sheet is written as label/value pairs rather than a header row, so a person who opens
 * it sees "Assignment: Reconcile the ledger" rather than a row of ids. It is deliberately **not**
 * hidden: a file that carries invisible metadata is a file people are right to distrust, and the
 * values in it are ones the employee already knows.
 */
export class JobMethodWorkbook {
  /**
   * Build the downloadable file.
   *
   * Column widths and a wrapped, frozen header exist because thirteen columns of prose in an
   * unformatted sheet is unusable — and an unusable form comes back empty, which is a data problem
   * rather than a cosmetic one.
   */
  static async toBuffer(form: JobMethodForm): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'UBoss';
    workbook.created = new Date(form.context.downloadedAt);

    // ---- the context sheet ----
    const context = workbook.addWorksheet(CONTEXT_SHEET);
    context.columns = [
      { key: 'label', width: 26 },
      { key: 'value', width: 60 },
    ];

    context.addRow(['UBoss Job Method form', '']).font = { bold: true, size: 14 };
    context.addRow([]);
    context.addRow(['Objective', form.context.objectiveName]);
    context.addRow(['Assigned work', form.context.assignmentTitle]);
    context.addRow(['For employee', form.context.assignedToEmployeeRef ?? '—']);
    context.addRow(['Downloaded', form.context.downloadedAt]);
    context.addRow([]);
    context.addRow([
      'Please do not change',
      'The four rows below identify this form. Editing them means UBoss cannot match your ' +
        'answers back to the right work, and the upload will be refused.',
    ]).font = { italic: true };
    context.addRow(['Form version', form.context.formVersion]);
    context.addRow(['Objective ID', form.context.objectiveId]);
    context.addRow(['Objective version ID', form.context.objectiveVersionId]);
    context.addRow(['Assignment ID', form.context.aiWorkAssignmentId]);

    // ---- the method sheet ----
    const sheet = workbook.addWorksheet(METHOD_SHEET);
    sheet.columns = JOB_METHOD_COLUMNS.map((column) => ({
      header: column.heading,
      key: column.key,
      // `Step` is a number and stays narrow; everything else holds a sentence.
      width: column.key === 'step' ? 8 : 34,
    }));

    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle', wrapText: true };
    header.height = 40;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const row of form.rows) {
      sheet.addRow(
        Object.fromEntries(JOB_METHOD_COLUMNS.map((column) => [column.key, row[column.key] ?? ''])),
      );
    }

    /**
     * Blank rows to write in.
     *
     * A form prefilled with three steps and no room for a fourth invites somebody to squeeze two
     * steps into one cell. Twenty spare rows is enough for the jobs this describes and well under
     * the import ceiling.
     */
    const spare = Math.min(20, JOB_METHOD_MAX_ROWS - form.rows.length);
    for (let index = 0; index < spare; index += 1) {
      sheet.addRow({ step: form.rows.length + index + 1 });
    }

    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      if (number === 1) return;
      row.alignment = { vertical: 'top', wrapText: true };
    });

    const written = await workbook.xlsx.writeBuffer();
    return Buffer.from(written);
  }

  /**
   * Read a returned file back.
   *
   * ## Tolerant about shape, strict about identity
   *
   * The headings are matched through `normaliseHeading`, so a file that has been through Excel,
   * Google Sheets, a paste into Word and back still imports — case, spacing and punctuation all get
   * mangled by that journey and none of it changes what a column means.
   *
   * The **context** is read strictly. A missing or edited linkage block means the file cannot be
   * matched to work, and the import refuses rather than guessing — which is the whole point of
   * writing it in the first place.
   *
   * A sheet named `Job Method` is preferred, but the **first sheet that has recognisable headings**
   * is accepted: people rename tabs, and refusing a correct file over a tab name would be pedantry
   * that costs somebody a second round trip.
   */
  static async fromBuffer(bytes: Buffer): Promise<{
    envelope: { formVersion: unknown; objectiveVersionId: unknown; aiWorkAssignmentId: unknown };
    rows: IncomingSheetRow[];
    /** Set when the file could not be read as a workbook at all. */
    unreadable: string | null;
  }> {
    const workbook = new ExcelJS.Workbook();

    try {
      await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    } catch {
      return {
        envelope: { formVersion: null, objectiveVersionId: null, aiWorkAssignmentId: null },
        rows: [],
        unreadable:
          'That file could not be opened as a spreadsheet. Upload the .xlsx you downloaded, ' +
          'rather than a PDF, a CSV or a copy pasted into another format.',
      };
    }

    const envelope = JobMethodWorkbook.readContext(workbook);
    const sheet = JobMethodWorkbook.findMethodSheet(workbook);

    if (sheet === null) {
      return {
        envelope,
        rows: [],
        unreadable:
          'No sheet in that file has the Job Method column headings. Check you uploaded the right ' +
          'workbook, and that the header row was not deleted.',
      };
    }

    const headings = JobMethodWorkbook.headingRow(sheet);
    const rows: IncomingSheetRow[] = [];

    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      if (number === 1) return;
      if (rows.length >= JOB_METHOD_MAX_ROWS + 1) return;

      const record: IncomingSheetRow = {};
      let hasContent = false;

      headings.forEach((heading, index) => {
        if (heading === null) return;
        const cell = row.getCell(index + 1);
        const value = JobMethodWorkbook.cellText(cell);
        if (value === '') return;
        record[heading] = value;
        // The step number alone is not content: the blank rows this writer adds carry one, and
        // importing twenty empty steps would flag twenty spurious "not filled in" problems.
        if (normaliseHeading(heading) !== normaliseHeading('Step')) hasContent = true;
      });

      if (hasContent) rows.push(record);
    });

    return { envelope, rows, unreadable: null };
  }

  /** The linkage block, by label, from the context sheet. */
  private static readContext(workbook: ExcelJS.Workbook): {
    formVersion: unknown;
    objectiveVersionId: unknown;
    aiWorkAssignmentId: unknown;
  } {
    const sheet = workbook.getWorksheet(CONTEXT_SHEET);
    const found = new Map<string, string>();

    if (sheet !== undefined) {
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const label = JobMethodWorkbook.cellText(row.getCell(1));
        const value = JobMethodWorkbook.cellText(row.getCell(2));
        if (label !== '') found.set(normaliseHeading(label), value);
      });
    }

    const version = found.get(normaliseHeading('Form version'));

    return {
      // A version that is not a number stays as it arrived, so `formVersionIsReadable` refuses it
      // and the person is told the file is from an unreadable version — rather than it silently
      // becoming `NaN` and failing somewhere less explicable.
      formVersion: version === undefined ? null : Number.parseInt(version, 10),
      objectiveVersionId: found.get(normaliseHeading('Objective version ID')) ?? null,
      aiWorkAssignmentId: found.get(normaliseHeading('Assignment ID')) ?? null,
    };
  }

  /** The sheet that looks like the method: the named one, or the first with known headings. */
  private static findMethodSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet | null {
    const named = workbook.getWorksheet(METHOD_SHEET);
    if (named !== undefined && JobMethodWorkbook.looksLikeMethod(named)) return named;

    let candidate: ExcelJS.Worksheet | null = null;
    workbook.eachSheet((sheet) => {
      if (candidate === null && JobMethodWorkbook.looksLikeMethod(sheet)) candidate = sheet;
    });
    return candidate;
  }

  /** Two recognised headings is enough to call it the method sheet, and few enough to be robust. */
  private static looksLikeMethod(sheet: ExcelJS.Worksheet): boolean {
    const known = JobMethodWorkbook.headingRow(sheet).filter(
      (heading) =>
        heading !== null && JOB_METHOD_KEY_BY_HEADING[normaliseHeading(heading)] !== undefined,
    );
    return known.length >= 2;
  }

  /** The header row as written, so the caller can key rows by the company's own spelling. */
  private static headingRow(sheet: ExcelJS.Worksheet): (string | null)[] {
    const headings: (string | null)[] = [];
    const row = sheet.getRow(1);
    row.eachCell({ includeEmpty: true }, (cell, index) => {
      const text = JobMethodWorkbook.cellText(cell);
      headings[index - 1] = text === '' ? null : text;
    });
    return headings;
  }

  /**
   * A cell's text, whatever the cell turned out to be.
   *
   * Spreadsheets produce rich text, formula results, hyperlinks, dates and numbers where a person
   * typed what they thought was a sentence. Reading `cell.value` directly gives an object for
   * several of those, and an object reaching the importer becomes an `Invalid` flag on a cell the
   * person filled in correctly.
   */
  private static cellText(cell: ExcelJS.Cell): string {
    const value: unknown = cell.value;

    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString();

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // A formula cell: the result is what the person sees, so it is what they meant.
      if ('result' in record) return JobMethodWorkbook.plain(record['result']);
      // Rich text: concatenate the runs.
      if (Array.isArray(record['richText'])) {
        return (record['richText'] as { text?: string }[])
          .map((run) => run.text ?? '')
          .join('')
          .trim();
      }
      if ('text' in record) return JobMethodWorkbook.plain(record['text']);
      if ('hyperlink' in record)
        return JobMethodWorkbook.plain(record['text'] ?? record['hyperlink']);
    }

    return '';
  }

  private static plain(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString();
    return '';
  }

  /** The filename a browser should save it as. */
  static filenameFor(form: JobMethodForm): string {
    const safe = form.context.assignmentTitle
      .replace(/[^A-Za-z0-9 _-]/g, '')
      .trim()
      .slice(0, 60)
      .replace(/\s+/g, '-');
    return `job-method-${safe || 'assignment'}.xlsx`;
  }

  /** Which column a heading maps to, for the review screen. */
  static keyFor(heading: string): JobMethodColumnKey | undefined {
    return JOB_METHOD_KEY_BY_HEADING[normaliseHeading(heading)];
  }
}
