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
 * ## Why the template is one sheet
 *
 * The two mistakes that make a hierarchy import fail are a department that does not exist and a
 * manager's name spelt differently from the record. Both are unavoidable if the person filling the
 * form is typing from memory.
 *
 * That used to be answered with reference sheets to copy from: Departments, People, and a third
 * explaining photographs. Four tabs for one job, and copying by hand is still typing — the exact
 * spelling could still be got wrong, and then the row was refused for a reason that looked like
 * the product's fault.
 *
 * So the lists are now the cells themselves. Department and Reporting Manager are dropdowns, built
 * at download time from the company's own records, so a value is chosen rather than recalled and
 * cannot be misspelt. The guidance that filled the other sheets sits on the headings as comments,
 * where somebody reads it at the moment they are typing into that column rather than on a tab they
 * have to think to open.
 *
 * What is left is one sheet, and a hidden one holding only the dropdown lists — nothing a person
 * has to read, nothing that is not already visible in the product, and unhideable in Excel for
 * anybody who wants to look.
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
    heading: 'Specialization',
    required: true,
    note: 'What they cover beyond the title — sub-departments, areas, disciplines. A manager over two or three sub-departments writes them here.',
    width: 34,
  },
  {
    heading: 'Department',
    required: true,
    note: 'Pick from the list in the cell. It must already exist — create the department first, then import.',
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
    required: true,
    note: 'Pick from the list in the cell. Blank is accepted only for the very first person in the company — after that somebody is already at the top and the row is refused.',
    width: 26,
  },
  /*
   * Starred, because the importer has refused a row without them since CR-04.
   *
   * They were marked optional here while `BulkOperationService` required both, so the template
   * promised something the server would not honour: somebody who left them blank — as the file
   * told them they could — had every row refused. That is the exact failure the note above this
   * list warns about, sitting two entries below it.
   */
  /*
   * Unstarred at the client's instruction, and the importer was changed to match.
   *
   * It was required from CR-04 until now, on the reasoning that an import is the fastest way to
   * build a hierarchy of people nobody can contact. The client's answer is that a company
   * importing its existing roster often has no work address for everybody yet, and refusing those
   * rows refuses the import — the person is reachable by phone, which is still required.
   *
   * The Add Employee form still asks for it: somebody filling a form has the person in front of
   * them. What must agree is this file and `BulkOperationService`, and they do.
   */
  {
    heading: 'Email',
    required: false,
    note: 'Work email, if you have one. Not an invitation — inviting stays in Users & Access.',
    width: 30,
  },
  { heading: 'Phone', required: true, note: 'Work contact number. Required.', width: 18 },
  /*
   * A column for the photograph, at the client's instruction.
   *
   * The picture is not a cell value — a spreadsheet image floats over the grid, anchored to the
   * row it was dropped on, and the reader has always matched it to a person by that row alone.
   * So this column holds nothing and the import works whether a picture lands in it or beside it.
   *
   * It exists because a feature nobody can find is a feature nobody uses. The instruction lived
   * on a sheet of its own, then on the Employee Name heading as a comment, and in both places it
   * had to be gone looking for. A column says where to put the thing at the moment somebody is
   * looking at the row.
   *
   * Unstarred, and genuinely optional: a row with no picture imports exactly as before.
   */
  {
    heading: 'Photo',
    required: false,
    note: 'Paste the photograph into this cell, on that person’s row. JPEG, PNG or WebP up to 2 MB, one per row. A picture that cannot be stored does not stop the import — the person is still created and the photo can be set from their profile.',
    width: 22,
  },
];

const IMPORT_SHEET = 'Employees';

/**
 * Where the dropdown lists are kept.
 *
 * Hidden, not `veryHidden`: it holds nothing a person needs to read, so showing it would be four
 * tabs again — but anybody who wants to see where a list came from can unhide it from Excel.
 */
const LIST_SHEET = 'Lists';

/**
 * How far down the dropdowns reach.
 *
 * Two hundred rows in one import is already far past any plan sold, and a row below it is not
 * refused — it simply has no list to pick from, and the server checks it exactly as it checks the
 * rest. The bound exists because a validation has to name a range, not because 201 people are a
 * problem.
 */
const VALIDATED_ROWS = 200;

/** What the dropdown lists are filled from. Read at download time, never cached. */
export interface HierarchyReference {
  departments: readonly { name: string; code: string | null }[];
  people: readonly { displayName: string; designation: string | null; department: string | null }[];
}

/**
 * Whether a column is required **of this company**, which is not always the same question.
 *
 * `Reporting Manager` is the one that moves. The server refuses a person with nobody above them
 * once somebody is already at the top — a chart with two disconnected roots has no top — so for a
 * company with staff the star is true. For a company with nobody in it yet, the first employee
 * *must* leave it blank, and starring it would demand the one value that cannot be given.
 *
 * The client asked for the star removed. This removes it exactly where it would be a lie and
 * keeps it where the server genuinely refuses the row, which is the only thing a star on this
 * template means. The file is generated per company at download time, so it can answer honestly
 * rather than picking one answer for everybody.
 *
 * Every other column's answer is the same for every company and comes straight off the definition.
 */
function requiredForThisCompany(column: HierarchyColumn, reference: HierarchyReference): boolean {
  if (column.heading === 'Reporting Manager') return reference.people.length > 0;
  return column.required;
}

export class HierarchyWorkbook {
  /** The template: one sheet to fill in, with this company's own departments and people in it. */
  static async template(reference: HierarchyReference): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'UBoss';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(IMPORT_SHEET);
    sheet.columns = HIERARCHY_COLUMNS.map((column) => ({ width: column.width }));

    /*
     * One header row, and a star on every heading.
     *
     * Every column here is now one the importer refuses the row without, so every star is true.
     * That is the whole rule: a star promises the server will reject the row, and a star on a
     * column the server shrugs at teaches people to ignore all of them.
     */
    const headings = sheet.addRow(
      HIERARCHY_COLUMNS.map(
        (column) => column.heading + (requiredForThisCompany(column, reference) ? ' *' : ''),
      ),
    );
    headings.font = { bold: true };
    headings.alignment = { vertical: 'middle' };
    headings.height = 22;

    /*
     * The guidance, on the headings rather than in a row beneath them.
     *
     * It was a second row — grey and italic, and still the second thing in the sheet that looked
     * like a header. People read two header rows and start typing on the third, or delete the one
     * they think is a duplicate. As comments it is attached to the column it describes and appears
     * when somebody is on that column, which is when it is worth anything.
     */
    HIERARCHY_COLUMNS.forEach((column, index) => {
      sheet.getRow(1).getCell(index + 1).note = column.note;
    });

    /*
     * The photographs sheet became a note on the Employee Name heading, and is now the `Photo`
     * column's own note — so the instruction sits on the thing it describes. Nothing is left to
     * add here.
     */

    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    /*
     * The dropdowns.
     *
     * A department spelt differently from the record and a manager's name typed from memory are
     * the two reasons a hierarchy import is rejected. Both stop being possible when the value is
     * chosen rather than written, which is the whole reason the reference sheets existed — they
     * just left the typing to the person.
     */
    const lists = workbook.addWorksheet(LIST_SHEET, { state: 'hidden' });
    lists.columns = [{ width: 32 }, { width: 30 }];
    lists.getRow(1).values = ['Departments', 'People'];
    reference.departments.forEach((department, index) => {
      lists.getRow(index + 2).getCell(1).value = department.name;
    });
    reference.people.forEach((person, index) => {
      lists.getRow(index + 2).getCell(2).value = person.displayName;
    });

    /*
     * A warning rather than a refusal, deliberately.
     *
     * Excel can stop a value that is not on the list outright. It should not: a file may name a
     * manager who is created by an earlier row of the same file, and a company that is about to
     * add a department has a legitimate reason to type one that is not there yet. The server
     * decides both, with a message that says which row and why. Excel's job here is to make the
     * right value easy, not to hold the gate.
     */
    const attachList = (heading: string, column: 'A' | 'B', count: number, warning: string) => {
      const index = HIERARCHY_COLUMNS.findIndex((entry) => entry.heading === heading);
      if (index < 0 || count === 0) return;
      const formula = `'${LIST_SHEET}'!$${column}$2:$${column}$${count + 1}`;
      for (let row = 2; row <= VALIDATED_ROWS + 1; row += 1) {
        sheet.getRow(row).getCell(index + 1).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [formula],
          showErrorMessage: true,
          errorStyle: 'warning',
          errorTitle: `${heading} is not one we know`,
          error: warning,
        };
      }
    };

    attachList(
      'Department',
      'A',
      reference.departments.length,
      'This company has no department by that name. Pick one from the list, or create the ' +
        'department first — the import will refuse the row otherwise.',
    );
    attachList(
      'Reporting Manager',
      'B',
      reference.people.length,
      'Nobody by that name works here yet. Pick one from the list, unless they are being created ' +
        'by an earlier row of this same file.',
    );

    /*
     * What the empty cases used to say on their own sheets.
     *
     * A company with no departments cannot import anybody, and a company with nobody in it is the
     * one case where Reporting Manager may be left blank. Both are on the heading they concern,
     * because there is no longer a sheet to put them on — and both replace the column's usual note
     * rather than joining it, since the usual note tells somebody to pick from a list that is
     * empty.
     */
    const headingCell = (heading: string): ExcelJS.Cell | null => {
      const index = HIERARCHY_COLUMNS.findIndex((entry) => entry.heading === heading);
      return index < 0 ? null : sheet.getRow(1).getCell(index + 1);
    };
    if (reference.departments.length === 0) {
      const cell = headingCell('Department');
      if (cell !== null) {
        cell.note =
          'No departments exist yet, so there is nothing to pick. Create one in the product ' +
          'first — an employee cannot belong to a department that is not there, and every row ' +
          'will be refused.';
      }
    }
    if (reference.people.length === 0) {
      const cell = headingCell('Reporting Manager');
      if (cell !== null) {
        cell.note =
          'Nobody is recorded yet, so there is nothing to pick. Leave this blank on the first ' +
          'import — that is the one case it is allowed — then fill it in on a second import once ' +
          'these people exist.';
      }
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
  /**
   * A returned workbook, as rows and as the pictures somebody pasted into them -- PRD 3.1.
   *
   * ## Why the pictures come out here
   *
   * The importer reads delimited text, and a spreadsheet's images are not in any cell: they float
   * over the sheet, anchored to a row and column. Turning the workbook into text discards them
   * entirely, which is why a photo pasted into the template used to vanish without a word.
   *
   * So the rows and the pictures are read in one pass, and each picture is reported with the
   * **body row it sits on** rather than its sheet row. The body is the header and the guidance
   * row removed and the blanks dropped, so a sheet row number means nothing to the importer that
   * receives this.
   *
   * ## What it does not do
   *
   * It does not store anything, check a size, or decide a content type beyond what the file says.
   * Those belong to whatever puts the picture somewhere, against that company's own limits.
   */
  static async read(buffer: Buffer): Promise<{
    content: string;
    /** Body row index (0-based, matching the data rows in `content`) to the picture on it. */
    photos: Map<number, { extension: string; bytes: Buffer }>;
  }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const sheet = HierarchyWorkbook.findImportSheet(workbook);
    if (sheet === null) {
      throw new Error(
        `That file has no "${IMPORT_SHEET}" sheet and no sheet with an Employee Name column. ` +
          'Download the template and fill that in.',
      );
    }

    /* Every row, with the sheet row number it came from, so the pictures can be matched to it. */
    const rows: { sheetRow: number; values: string[] }[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values: string[] = [];
      for (let column = 1; column <= HIERARCHY_COLUMNS.length; column += 1) {
        values.push(cellText(row.getCell(column)));
      }
      rows.push({ sheetRow: rowNumber, values });
    });

    const headerIndex = rows.findIndex((row) => looksLikeHeader(row.values));
    if (headerIndex < 0) {
      throw new Error(
        'That file has no header row. The first row must name the columns, as the template does.',
      );
    }

    /*
     * Templates downloaded before the guidance moved onto the headings still carry a note row,
     * and a file somebody saved last month is one they are entitled to upload today. The text is
     * the first column's note, unchanged for exactly that reason — change it and every one of
     * those files gains an employee whose name is a sentence about names.
     */
    const noteText = HIERARCHY_COLUMNS[0]?.note ?? '';
    const body = rows
      .slice(headerIndex + 1)
      .filter((row) => row.values.some((value) => value !== ''))
      .filter((row) => row.values[0] !== noteText);

    if (body.length === 0) {
      throw new Error('That file has a header row and no employees. Nothing to import.');
    }

    /*
     * The pictures, matched to the row each one sits on.
     *
     * `nativeRow` is zero-based and `eachRow` counts from one, so the sheet row is `nativeRow + 1`.
     * A picture anchored to a row that is not a body row -- over the header, or below the last
     * employee -- is dropped rather than guessed at: there is nobody for it to belong to.
     */
    const sheetRowToBody = new Map(body.map((row, index) => [row.sheetRow, index]));
    const photos = new Map<number, { extension: string; bytes: Buffer }>();
    for (const placed of sheet.getImages()) {
      const sheetRow = (placed.range?.tl?.nativeRow ?? -1) + 1;
      const bodyIndex = sheetRowToBody.get(sheetRow);
      if (bodyIndex === undefined) continue;

      const image = workbook.getImage(Number(placed.imageId));
      if (image?.buffer === undefined) continue;
      // One per row. A second picture on the same row is a question nobody has answered, and
      // taking the first is at least a rule somebody can predict.
      if (photos.has(bodyIndex)) continue;
      photos.set(bodyIndex, {
        extension: image.extension ?? 'png',
        bytes: Buffer.from(image.buffer as unknown as ArrayBuffer),
      });
    }

    const header = HIERARCHY_COLUMNS.map((column) => column.heading);
    const content = [header, ...body.map((row) => row.values)]
      .map((row) => row.map(csvCell).join(','))
      .join(String.fromCharCode(10));

    return { content, photos };
  }

  /**
   * The rows alone, as the importer has always read them.
   *
   * Delegates to `read` so there is one parser rather than two that can drift: the day somebody
   * changes how the guidance row is recognised, both callers change with it.
   */
  static async toDelimited(buffer: Buffer): Promise<string> {
    const { content } = await HierarchyWorkbook.read(buffer);
    return content;
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
