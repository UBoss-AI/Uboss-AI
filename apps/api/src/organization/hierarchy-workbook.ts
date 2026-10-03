import ExcelJS from 'exceljs';

/**
 * The hierarchy as a spreadsheet: a template to fill in, and a reader for the one that comes back.
 *
 * ## Why this file is a converter and not an importer
 *
 * Bulk import already exists. `BulkOperationService` parses rows, validates each one against the
 * real rules, reports per-row errors, and applies through the same services a single-record change
 * uses — which is what stops a bulk path from becoming a way around the gates. Writing a second
 * importer for spreadsheets would mean two places where "a manager must be actively employed here"
 * has to be got right, and one of them would drift.
 *
 * So this does exactly two things: it writes a workbook whose columns are the ones that importer
 * already accepts, and it turns a returned workbook back into the delimited text that importer
 * already reads. Every rule, every error message and every write stays where it was.
 *
 * ## Why the template carries a second sheet
 *
 * The two mistakes that make a hierarchy import fail are a department that does not exist and a
 * manager's name spelt differently from the record. Both are unavoidable if the person filling the
 * form is typing from memory. The reference sheet lists the company's real departments and its
 * real people, so the values can be copied rather than recalled — and it is generated at download
 * time, so it cannot be stale.
 *
 * It is a plain visible sheet, not hidden metadata: a file that carries invisible information is
 * one people are right to distrust, and everything on it is already visible in the product.
 */

/** One column of the import sheet, in the order a person reads them. */
export interface HierarchyColumn {
  /** The heading written into the file. The importer accepts several spellings of each. */
  heading: string;
  /** Whether a row without it is refused. */
  required: boolean;
  /** Shown under the heading, because a column nobody understands comes back empty. */
  note: string;
  width: number;
}

/**
 * The columns, and which are genuinely required.
 *
 * Required means the importer refuses the row without it — not that it is merely expected. Marking
 * an optional column as required here would make the template lie about what the server will do.
 */
export const HIERARCHY_COLUMNS: readonly HierarchyColumn[] = [
  {
    heading: 'Employee Name',
    required: true,
    note: 'Full name, as it should appear in the chart.',
    width: 26,
  },
  {
    heading: 'Employee ID',
    required: true,
    note: 'Your own company payroll or staff number. Must be unique in this company.',
    width: 18,
  },
  {
    heading: 'Designation',
    required: true,
    note: 'Job title, e.g. Operations Executive.',
    width: 26,
  },
  {
    heading: 'Department',
    required: true,
    note: 'Must already exist. Copy it exactly from the Departments sheet.',
    width: 24,
  },
  {
    heading: 'Aadhaar Number',
    required: true,
    note: '12 digits. Stored encrypted and shown masked.',
    width: 20,
  },
  {
    heading: 'Reporting Manager',
    required: false,
    note: 'Their name, copied from the People sheet. Leave blank for the top of a department.',
    width: 26,
  },
  {
    heading: 'Email',
    required: false,
    note: 'Work email. Not an invitation — inviting stays in Users & Access.',
    width: 30,
  },
  { heading: 'Phone', required: false, note: 'Work contact number.', width: 18 },
];

const IMPORT_SHEET = 'Employees';
const DEPARTMENT_SHEET = 'Departments';
const PEOPLE_SHEET = 'People';

/** What the reference sheets are filled from. Read at download time, never cached. */
export interface HierarchyReference {
  departments: readonly { name: string; code: string | null }[];
  people: readonly { displayName: string; designation: string | null; department: string | null }[];
}

export class HierarchyWorkbook {
  /** The template, with this company's own departments and people beside it. */
  static async template(reference: HierarchyReference): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'UBoss';
    workbook.created = new Date();

    // ---- the sheet people fill in ----
    const sheet = workbook.addWorksheet(IMPORT_SHEET);
    sheet.columns = HIERARCHY_COLUMNS.map((column) => ({ width: column.width }));

    const headings = sheet.addRow(
      HIERARCHY_COLUMNS.map((column) => column.heading + (column.required ? ' *' : '')),
    );
    headings.font = { bold: true };
    headings.alignment = { vertical: 'middle' };
    headings.height = 22;

    /*
     * A note row under the headings.
     *
     * Not decoration: "Department must already exist" is the single most common reason an import
     * is rejected, and it is only useful where the person is typing. Written in grey and italic so
     * it reads as guidance rather than as the first record — and the reader below skips it by
     * looking for it, rather than by assuming a fixed row number.
     */
    const notes = sheet.addRow(HIERARCHY_COLUMNS.map((column) => column.note));
    notes.font = { italic: true, size: 9, color: { argb: 'FF767676' } };
    notes.alignment = { vertical: 'top', wrapText: true };
    notes.height = 30;

    sheet.views = [{ state: 'frozen', ySplit: 2 }];

    // ---- what the values have to match ----
    const departments = workbook.addWorksheet(DEPARTMENT_SHEET);
    departments.columns = [
      { key: 'name', width: 30 },
      { key: 'code', width: 14 },
    ];
    departments.addRow(['Department', 'Code']).font = { bold: true };
    for (const department of reference.departments) {
      departments.addRow([department.name, department.code ?? '']);
    }
    if (reference.departments.length === 0) {
      departments.addRow([
        'No departments exist yet. Create one before importing — an employee cannot belong to a ' +
          'department that is not there.',
      ]);
    }

    const people = workbook.addWorksheet(PEOPLE_SHEET);
    people.columns = [
      { key: 'name', width: 28 },
      { key: 'designation', width: 26 },
      { key: 'department', width: 24 },
    ];
    people.addRow(['Name', 'Designation', 'Department']).font = { bold: true };
    for (const person of reference.people) {
      people.addRow([person.displayName, person.designation ?? '', person.department ?? '']);
    }
    if (reference.people.length === 0) {
      people.addRow([
        'Nobody is recorded yet. Leave Reporting Manager blank on the first import, then fill it ' +
          'on a second one once these people exist.',
      ]);
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Turn a returned workbook into the delimited text the existing importer reads.
   *
   * ## What it does not do
   *
   * It does not validate anything. Not the departments, not the managers, not the Aadhaar numbers
   * — all of that belongs to the importer and happens next, against the live company. This decides
   * only which sheet holds the data, which row is the header, and which rows are blank.
   */
  static async toDelimited(buffer: Buffer): Promise<string> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheet = HierarchyWorkbook.findImportSheet(workbook);
    if (sheet === null) {
      throw new Error(
        `That file has no "${IMPORT_SHEET}" sheet and no sheet with an Employee Name column. ` +
          'Download the template and fill that in.',
      );
    }

    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = [];
      for (let column = 1; column <= HIERARCHY_COLUMNS.length; column += 1) {
        values.push(cellText(row.getCell(column)));
      }
      rows.push(values);
    });

    const headerIndex = rows.findIndex((row) => looksLikeHeader(row));
    if (headerIndex < 0) {
      throw new Error(
        'That file has no header row. The first row must name the columns, as the template does.',
      );
    }

    /*
     * The note row is skipped by recognising it, not by counting.
     *
     * Somebody who deletes the guidance row — which is a reasonable thing to do — would otherwise
     * lose their first employee, silently. A row is guidance if its first cell repeats the note
     * the template wrote there.
     */
    const noteText = HIERARCHY_COLUMNS[0]?.note ?? '';
    const body = rows
      .slice(headerIndex + 1)
      .filter((row) => row.some((value) => value !== ''))
      .filter((row) => row[0] !== noteText);

    if (body.length === 0) {
      throw new Error('That file has a header row and no employees. Nothing to import.');
    }

    // The heading cells are written back without the asterisk: it marks a required column for a
    // reader, and the importer matches on the name.
    const header = HIERARCHY_COLUMNS.map((column) => column.heading);
    return [header, ...body].map((row) => row.map(csvCell).join(',')).join('\n');
  }

  /**
   * The sheet the employees are on.
   *
   * By name first, then by shape. A workbook that has been renamed, or exported from another tool,
   * is still perfectly usable if one of its sheets has the columns — refusing it on the sheet name
   * alone would be refusing a file whose contents are right.
   */
  private static findImportSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet | null {
    const named = workbook.getWorksheet(IMPORT_SHEET);
    if (named !== undefined) return named;

    let found: ExcelJS.Worksheet | null = null;
    workbook.eachSheet((sheet) => {
      if (found !== null) return;
      const first = sheet.getRow(1);
      const cells: string[] = [];
      for (let column = 1; column <= 12; column += 1) cells.push(cellText(first.getCell(column)));
      if (looksLikeHeader(cells)) found = sheet;
    });
    return found;
  }
}

/** A header row is one that names the employee column, however it is spelt or punctuated. */
function looksLikeHeader(row: readonly string[]): boolean {
  const normalised = row.map((cell) => cell.toLowerCase().replace(/[^a-z0-9]/g, ''));
  return normalised.includes('employeename') || normalised.includes('name');
}

/** A cell as text, whatever Excel decided it was. */
function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  // A formula cell carries its result; a rich-text cell carries runs. Both are text to a person.
  const asObject = value as { result?: unknown; richText?: { text: string }[]; text?: string };
  if (Array.isArray(asObject.richText)) {
    return asObject.richText
      .map((run) => run.text)
      .join('')
      .trim();
  }
  if (typeof asObject.text === 'string') return asObject.text.trim();
  if (asObject.result !== undefined && asObject.result !== null)
    return String(asObject.result).trim();
  return '';
}

/**
 * One cell, quoted for the delimited format.
 *
 * A leading `=`, `+`, `-` or `@` is neutralised with a leading apostrophe. A person's designation
 * really can begin with a hyphen, and the text produced here is read back by a parser and can be
 * opened in a spreadsheet — where an unneutralised one is a formula.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
