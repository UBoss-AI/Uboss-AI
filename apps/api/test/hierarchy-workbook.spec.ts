import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import ExcelJS from 'exceljs';

import {
  HIERARCHY_COLUMNS,
  HierarchyWorkbook,
  type HierarchyReference,
} from '../src/organization/hierarchy-workbook.js';

/**
 * The hierarchy template — what somebody downloads, and what the reader makes of it coming back.
 *
 * ## Why this file exists
 *
 * It did not, and the template drifted away from the importer twice without anybody noticing:
 * Email and Phone were marked optional here while the service had refused a row without either
 * since CR-04, and Reporting Manager carried no star while the service refused a blank one the
 * moment a company had somebody at the top. Both were found by filling the file in, not by reading
 * it, and both had been wrong for weeks.
 *
 * So the star is the thing under test. A star on this template is a promise that the server will
 * refuse the row, and `importerRequires` below re-states the importer's own list so the two cannot
 * drift apart again in silence.
 *
 * The second thing under test is that the file is one sheet. It was four — the sheet to fill in,
 * two to copy values from and one explaining photographs — and the client's instruction was to
 * make it one. The lists did not disappear; they became dropdowns on the cells, which is why the
 * two columns that had reference sheets are checked for validation rather than for a neighbour.
 */

const reference: HierarchyReference = {
  departments: [
    { name: 'Quality Assurance', code: 'QA' },
    { name: 'Operations', code: 'OPS' },
  ],
  people: [
    { displayName: 'Meera Iyer', designation: 'QA Head', department: 'Quality Assurance' },
    { displayName: 'Rajiv Mehta', designation: 'Director', department: 'Operations' },
  ],
};

/**
 * What `BulkOperationService.validateRow` refuses an `ImportEmployees` row without.
 *
 * Written out rather than imported, deliberately. Importing the service's own list would make this
 * test agree with whatever that list says, including the day somebody drops a field from it — and
 * agreeing with the code is not the same as agreeing with the product's promise.
 */
const importerRequires = [
  'Employee Name',
  'Employee ID',
  'Designation',
  'Specialization',
  'Department',
  'Aadhaar Number',
  'Reporting Manager',
  'Phone',
];

/**
 * Columns the importer takes and does not insist on.
 *
 * `Email` is here at the client's instruction: a company importing its existing roster often has
 * no work address for everybody, and refusing those rows refuses the import. The Add Employee
 * form still asks for one, which is a different surface with a person in front of it.
 *
 * Listed rather than inferred, so that moving a column between the two lists is a deliberate edit
 * to this file and not a silent consequence of editing another.
 */
const importerAccepts = ['Email', 'Photo'];

const load = async (buffer: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
};

const headingsOf = (sheet: ExcelJS.Worksheet): string[] => {
  const headings: string[] = [];
  sheet.getRow(1).eachCell((cell, index) => {
    headings[index - 1] = String(cell.value ?? '').trim();
  });
  return headings.filter((heading) => heading !== '');
};

describe('the hierarchy import template', () => {
  it('is one sheet somebody fills in, and one hidden one holding the dropdown lists', async () => {
    const workbook = await load(await HierarchyWorkbook.template(reference));

    const visible: string[] = [];
    const hidden: string[] = [];
    workbook.eachSheet((sheet) => {
      (sheet.state === 'hidden' || sheet.state === 'veryHidden' ? hidden : visible).push(
        sheet.name,
      );
    });

    assert.deepEqual(visible, ['Employees'], 'exactly one sheet should be visible');
    assert.equal(hidden.length, 1, `expected one hidden sheet, got ${JSON.stringify(hidden)}`);
  });

  /*
   * A star means the server refuses the row without it. Both directions.
   *
   * This asserted that *every* heading carried one, which was true while every column was
   * required and became a lie the moment Email stopped being. The property worth keeping is not
   * "all starred" — it is that the starred set and the importer's own list are the same set, so
   * neither can move without the other.
   */
  it('stars exactly the columns the importer refuses a row without', async () => {
    const workbook = await load(await HierarchyWorkbook.template(reference));
    const headings = headingsOf(workbook.getWorksheet('Employees')!);

    const starred = headings
      .filter((heading) => heading.endsWith(' *'))
      .map((heading) => heading.replace(/ \*$/, ''));
    const unstarred = headings.filter((heading) => !heading.endsWith(' *'));

    assert.deepEqual(starred, importerRequires, 'a star promises the importer will refuse the row');
    assert.deepEqual(unstarred, importerAccepts, 'no star means the importer takes the row anyway');
  });

  /*
   * The one column whose answer depends on the company.
   *
   * The server refuses a person with nobody above them once somebody is already at the top, so
   * for a company with staff the star is true. A company with nobody in it is the opposite case:
   * its first employee *must* leave the column blank, and a star there would demand the one value
   * that cannot be given.
   *
   * Both directions are asserted. Testing only the empty company would let "never starred" pass,
   * and that is the version that lies to every company that has people in it.
   */
  it('stars Reporting Manager only for a company that has somebody to report to', async () => {
    const withPeople = await load(await HierarchyWorkbook.template(reference));
    const peopled = headingsOf(withPeople.getWorksheet('Employees')!);
    assert.ok(
      peopled.includes('Reporting Manager *'),
      `expected a star once the company has staff: ${JSON.stringify(peopled)}`,
    );

    const empty = await load(
      await HierarchyWorkbook.template({ departments: reference.departments, people: [] }),
    );
    const firstEver = headingsOf(empty.getWorksheet('Employees')!);
    assert.ok(
      firstEver.includes('Reporting Manager'),
      `the first employee has nobody to pick: ${JSON.stringify(firstEver)}`,
    );
    assert.ok(!firstEver.includes('Reporting Manager *'));
  });

  it('has no second header row — the data starts immediately under the headings', async () => {
    const workbook = await load(await HierarchyWorkbook.template(reference));
    const sheet = workbook.getWorksheet('Employees')!;

    const secondRow: string[] = [];
    sheet.getRow(2).eachCell((cell) => {
      const text = String(cell.value ?? '').trim();
      if (text !== '') secondRow.push(text);
    });

    assert.deepEqual(secondRow, [], 'row 2 is where a person types, not more headings');
  });

  it('puts each column’s guidance on its heading, where somebody typing will see it', async () => {
    const workbook = await load(await HierarchyWorkbook.template(reference));
    const sheet = workbook.getWorksheet('Employees')!;

    const noted: string[] = [];
    sheet.getRow(1).eachCell((cell, index) => {
      if (cell.note !== undefined && cell.note !== null) noted.push(String(index));
    });

    assert.equal(noted.length, HIERARCHY_COLUMNS.length, 'every heading explains its own column');

    // The photographs sheet is gone; its one instruction is on the column it describes.
    const photoIndex = HIERARCHY_COLUMNS.findIndex((column) => column.heading === 'Photo');
    assert.ok(photoIndex >= 0, 'the template should offer a column for the photograph');
    const photoNote = sheet.getRow(1).getCell(photoIndex + 1).note;
    const text = typeof photoNote === 'string' ? photoNote : JSON.stringify(photoNote);
    assert.match(text, /paste the photograph into this cell/i);
  });

  /*
   * The picture is matched by row, not by column — so the column is for the person, not the code.
   *
   * Worth a test anyway: the reader walks `1..HIERARCHY_COLUMNS.length` to build each row, so
   * adding a column changes what it reads, and a photograph that stopped arriving because a
   * column was added would be a silent loss of the feature the column was added to advertise.
   */
  it('still reads a photograph pasted on a person’s row', async () => {
    const workbook = await load(await HierarchyWorkbook.template(reference));
    const sheet = workbook.getWorksheet('Employees')!;

    const row = sheet.getRow(2);
    [
      'Ravi Deshmukh',
      'E-7801',
      'QA Manager',
      'Sterile packaging',
      'Quality Assurance',
      '345678901238',
      'Meera Iyer',
      'ravi@aarohan.uboss.local',
      '+91 98200 11223',
    ].forEach((value, index) => {
      row.getCell(index + 1).value = value;
    });
    row.commit();

    // A one-pixel PNG, anchored to that row in the Photo column.
    const photoColumn = HIERARCHY_COLUMNS.findIndex((column) => column.heading === 'Photo');
    const imageId = workbook.addImage({
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ) as unknown as ExcelJS.Buffer,
      extension: 'png',
    });
    sheet.addImage(imageId, {
      tl: { col: photoColumn, row: 1 },
      ext: { width: 64, height: 64 },
    });

    const { content, photos } = await HierarchyWorkbook.read(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );

    assert.equal(content.split('\n').length, 2, 'the picture must not become a second employee');
    assert.equal(photos.size, 1, 'the photograph should arrive with the row it sits on');
    // Body row 0 — the first employee, not the sheet row.
    assert.equal(photos.get(0)?.extension, 'png');
  });

  it('offers the company’s own departments and people as dropdowns', async () => {
    const workbook = await load(await HierarchyWorkbook.template(reference));
    const sheet = workbook.getWorksheet('Employees')!;

    const columnOf = (heading: string) =>
      HIERARCHY_COLUMNS.findIndex((column) => column.heading === heading) + 1;

    for (const heading of ['Department', 'Reporting Manager']) {
      const validation = sheet.getRow(2).getCell(columnOf(heading)).dataValidation;
      assert.ok(validation, `${heading} should offer a list`);
      assert.equal(validation!.type, 'list');
      // A warning, not a refusal: a manager may be created by an earlier row of the same file.
      assert.equal(validation!.errorStyle, 'warning');
      // Blank is allowed by Excel so the unused rows are not flagged. The server still refuses it.
      assert.equal(validation!.allowBlank, true);
    }
  });

  it('says so on the heading when there is nothing to pick from', async () => {
    const workbook = await load(await HierarchyWorkbook.template({ departments: [], people: [] }));
    const sheet = workbook.getWorksheet('Employees')!;
    const noteAt = (heading: string) => {
      const index = HIERARCHY_COLUMNS.findIndex((column) => column.heading === heading);
      const note = sheet.getRow(1).getCell(index + 1).note;
      return typeof note === 'string' ? note : JSON.stringify(note);
    };

    // A company with no departments cannot import anybody, and this is the only place left to
    // say it now that the reference sheets are gone.
    assert.match(noteAt('Department'), /No departments exist yet/i);
    assert.match(noteAt('Reporting Manager'), /Leave this blank on the first import/i);
  });
});

describe('reading a returned hierarchy workbook', () => {
  /** The template, filled in on row 2 as somebody would. */
  const filled = async (values: string[]): Promise<Buffer> => {
    const workbook = await load(await HierarchyWorkbook.template(reference));
    const row = workbook.getWorksheet('Employees')!.getRow(2);
    values.forEach((value, index) => {
      row.getCell(index + 1).value = value;
    });
    row.commit();
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };

  const employee = [
    'Ravi Deshmukh',
    'E-7801',
    'QA Manager',
    'Sterile packaging, Batch release',
    'Quality Assurance',
    '345678901238',
    'Meera Iyer',
    'ravi@aarohan.uboss.local',
    '+91 98200 11223',
  ];

  it('reads back exactly what was typed, and nothing else', async () => {
    const content = await HierarchyWorkbook.toDelimited(await filled(employee));
    const lines = content.split('\n');

    // Two hundred rows carry a dropdown and no value. An empty row that Excel knows about is
    // still an empty row, and reading them as people would import two hundred blanks.
    assert.equal(lines.length, 2, `expected a header and one employee, got ${lines.length} lines`);
    assert.match(lines[1]!, /Ravi Deshmukh/);
    assert.match(lines[1]!, /Sterile packaging, Batch release/);
  });

  /*
   * A template downloaded before the guidance moved off row 2 is one somebody is entitled to
   * upload today — and its note row has to keep being recognised as guidance rather than becoming
   * an employee whose name is a sentence about names.
   */
  it('still skips the guidance row in a template saved before it moved', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Employees');
    sheet.addRow(HIERARCHY_COLUMNS.map((column) => column.heading));
    sheet.addRow(HIERARCHY_COLUMNS.map((column) => column.note));
    sheet.addRow(employee);

    const content = await HierarchyWorkbook.toDelimited(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );

    const lines = content.split('\n');
    assert.equal(lines.length, 2, `the note row became a person: ${content}`);
    assert.match(lines[1]!, /Ravi Deshmukh/);
  });

  it('refuses a file with a header and no employees, rather than importing nothing quietly', async () => {
    const empty = Buffer.from(await HierarchyWorkbook.template(reference));
    await assert.rejects(() => HierarchyWorkbook.toDelimited(empty), /no employees/i);
  });
});
