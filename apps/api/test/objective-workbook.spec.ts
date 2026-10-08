import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import ExcelJS from 'exceljs';

import {
  FORM2_OBJECTIVE_FIELDS,
  FORM2_WORKFLOW_COLUMNS,
  STEP_APPROVAL_KINDS,
  SELECTABLE_STEP_ENGINE_KINDS,
} from '@uboss/types';

import { ObjectiveWorkbook } from '../src/objectives/objective-workbook.js';

/**
 * The Objective workbook — download, fill in, upload.
 *
 * ## Why this file exists
 *
 * It did not, and that is how the bug below survived. `parse` checks two closed vocabularies the
 * same way: a word outside the engine list is refused, and so is a word outside the approval list.
 * The engine check read the right key. The approval check read `approvalKind`, which no column
 * writes — so it compared an empty string every time, never fired, and let any word through as an
 * approval. The two blocks sit next to each other and look identical, which is exactly why reading
 * them proved nothing and running one did.
 *
 * So the weight here is on the round trip and on what a returned file gets wrong — because that is
 * the file this parser actually receives: filled in offline, by somebody who was not thinking
 * about closed lists.
 */
describe('the Objective workbook', () => {
  /** Fill the label/value sheet the download writes, the way a person filling it in would. */
  const fill = async (
    objective: Record<string, string>,
    steps: Record<string, string>[],
  ): Promise<Buffer> => {
    const bytes = await ObjectiveWorkbook.toBuffer({});
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

    const sheet = workbook.getWorksheet('Objective')!;
    sheet.eachRow((row, index) => {
      if (index === 1) return;
      // The download marks a required field with a star; the label is what is left.
      const label = String(row.getCell(1).value ?? '')
        .replace(' *', '')
        .trim();
      if (objective[label] !== undefined) row.getCell(2).value = objective[label];
    });

    const stepSheet = workbook.getWorksheet('Steps')!;
    const columnFor = (label: string): number =>
      FORM2_WORKFLOW_COLUMNS.findIndex((column) => column.label === label) + 1;
    // Row 1 is the heading and row 2 is the legend of accepted words, so the first step is row 3.
    steps.forEach((step, offset) => {
      const row = stepSheet.getRow(3 + offset);
      row.getCell(1).value = offset + 1;
      for (const [label, value] of Object.entries(step))
        row.getCell(columnFor(label)).value = value;
      row.commit();
    });

    return Buffer.from(await workbook.xlsx.writeBuffer());
  };

  const COMPLETE: Record<string, string> = {
    'Objective Name': 'Quarterly collections clean-up',
    Department: 'Finance',
    'Objective Owner': 'Aditi Sharma',
    'Expected Final Result': 'Every invoice older than 90 days is collected or written off.',
    'Current Workload': '120',
    Unit: 'invoices',
    'Execution Team': 'Collections desk',
  };

  const STEP = {
    'Person Name': 'Kavya Nair',
    'Engine / Sub-Engine / Executor': 'Human',
    'Exact Work': 'Pull the ageing report',
    Approval: 'Manager',
  };

  it('writes a file a spreadsheet can open, with both sheets', async () => {
    const bytes = await ObjectiveWorkbook.toBuffer({});

    // The magic number of a ZIP, which is what an .xlsx is.
    assert.equal(bytes.subarray(0, 2).toString('utf8'), 'PK');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    assert.ok(workbook.getWorksheet('Objective'), 'no Objective sheet');
    assert.ok(workbook.getWorksheet('Steps'), 'no Steps sheet');
  });

  it('sends out every field the form has, so none can be filled in nowhere', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await ObjectiveWorkbook.toBuffer({})) as unknown as ArrayBuffer);

    const labels: string[] = [];
    workbook.getWorksheet('Objective')!.eachRow((row, index) => {
      if (index > 1) {
        labels.push(
          String(row.getCell(1).value ?? '')
            .replace(' *', '')
            .trim(),
        );
      }
    });

    for (const field of FORM2_OBJECTIVE_FIELDS) {
      assert.ok(labels.includes(field.label), `${field.label} is not in the downloaded file`);
    }
  });

  it('reads back what was filled in, field for field', async () => {
    const parsed = await ObjectiveWorkbook.parse(await fill(COMPLETE, [STEP]));

    assert.equal(parsed.objective['objectiveName'], 'Quarterly collections clean-up');
    assert.equal(
      parsed.objective['expectedFinalResult'],
      'Every invoice older than 90 days is collected or written off.',
    );
    // A number typed into a spreadsheet comes back as a number; the parser hands over text either
    // way, because the form it feeds is text.
    assert.equal(parsed.objective['currentWorkload'], '120');
    assert.equal(parsed.objective['executionTeam'], 'Collections desk');
    assert.deepEqual(
      parsed.problems.filter((problem) => problem.where === 'Objective'),
      [],
      'a complete file reported problems',
    );
  });

  it('reads a step back whole', async () => {
    const parsed = await ObjectiveWorkbook.parse(await fill(COMPLETE, [STEP]));

    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0]!.whoPersonName, 'Kavya Nair');
    assert.equal(parsed.steps[0]!.whatExactWork, 'Pull the ageing report');
    assert.equal(parsed.steps[0]!.approval, 'Manager');
    assert.equal(parsed.steps[0]!.position, 1);
  });

  it('refuses a word outside the engine list', async () => {
    const parsed = await ObjectiveWorkbook.parse(
      await fill(COMPLETE, [{ ...STEP, 'Engine / Sub-Engine / Executor': 'Robot' }]),
    );

    const problem = parsed.problems.find((entry) => entry.kind === 'Invalid');
    assert.ok(problem, 'nothing said "Robot" is not an engine');
    assert.match(problem.detail, /Robot/);
    // The three a person may choose. `Human` is accepted but not offered, so naming it here
    // would tell somebody to write the one value the form and the template no longer have.
    for (const kind of SELECTABLE_STEP_ENGINE_KINDS) assert.match(problem.detail, new RegExp(kind));
    assert.doesNotMatch(problem.detail, /Human/);
    assert.equal(parsed.steps[0]!.whoEngine, undefined, 'the refused word was kept anyway');
  });

  /*
   * A workbook downloaded before `Human` stopped being offered is one somebody is entitled to
   * upload today, and refusing it would be this release's decision applied to their file.
   */
  it('still accepts "Human" from a workbook saved before it was withdrawn', async () => {
    const parsed = await ObjectiveWorkbook.parse(
      await fill(COMPLETE, [{ ...STEP, 'Engine / Sub-Engine / Executor': 'Human' }]),
    );

    assert.equal(parsed.steps[0]!.whoEngine, 'Human');
    assert.equal(
      parsed.problems.find((entry) => entry.field === 'Engine / Sub-Engine / Executor'),
      undefined,
      'an older file should import without being told its own value is wrong',
    );
  });

  /**
   * The bug this file was written for.
   *
   * `"Maybe"` is not an approval kind. Before the fix it was accepted in silence and handed to the
   * caller as though the file had said `Manager` — an approval rule read off a spreadsheet nobody
   * had checked. Deleting the `approval` key from `parse` makes this fail; nothing else does.
   */
  it('refuses a word outside the approval list', async () => {
    const parsed = await ObjectiveWorkbook.parse(
      await fill(COMPLETE, [{ ...STEP, Approval: 'Maybe' }]),
    );

    const problem = parsed.problems.find(
      (entry) => entry.kind === 'Invalid' && entry.field === 'Approval',
    );
    assert.ok(problem, 'a word outside the approval list went through unreported');
    assert.match(problem.detail, /Maybe/);
    for (const kind of STEP_APPROVAL_KINDS) assert.match(problem.detail, new RegExp(kind));
    assert.equal(parsed.steps[0]!.approval, undefined, 'the refused word was kept anyway');
  });

  it('says which required fields the file left blank', async () => {
    const parsed = await ObjectiveWorkbook.parse(await fill({ Unit: 'invoices' }, [STEP]));

    const missing = parsed.problems.filter(
      (entry) => entry.kind === 'Missing' && entry.where === 'Objective',
    );
    const required = FORM2_OBJECTIVE_FIELDS.filter((field) => field.required === true);
    assert.equal(missing.length, required.length);
    for (const field of required) {
      assert.ok(
        missing.some((entry) => entry.field === field.label),
        `${field.label} is required and blank, and nothing said so`,
      );
    }
  });

  it('calls a step with no work described what it is', async () => {
    const parsed = await ObjectiveWorkbook.parse(
      await fill(COMPLETE, [{ ...STEP, 'Exact Work': '' }]),
    );

    assert.ok(
      parsed.problems.some((entry) => entry.kind === 'Missing' && entry.where === 'Step 1'),
      'a step with nothing to do was accepted',
    );
  });

  it('ignores the blank rows the file is filled in around', async () => {
    // The download writes one empty step row so the sheet is fillable. Reading it back as a step
    // would invent a problem for a row nobody wrote in.
    const parsed = await ObjectiveWorkbook.parse(await ObjectiveWorkbook.toBuffer({}));

    assert.deepEqual(parsed.steps, []);
    assert.deepEqual(
      parsed.problems.filter((entry) => entry.where.startsWith('Step')),
      [],
    );
  });

  it('says so when the file has a row UBoss has no field for', async () => {
    const bytes = await ObjectiveWorkbook.toBuffer({});
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    workbook.getWorksheet('Objective')!.addRow(['Budget owner', 'Ravi Menon', '']);

    const parsed = await ObjectiveWorkbook.parse(Buffer.from(await workbook.xlsx.writeBuffer()));

    const unmapped = parsed.problems.find((entry) => entry.kind === 'Unmapped');
    assert.ok(unmapped, 'an invented row was read as though UBoss knew it');
    assert.equal(unmapped.field, 'Budget owner');
  });

  it('refuses a file that is not the Objective workbook, by name', async () => {
    const other = new ExcelJS.Workbook();
    other.addWorksheet('Sheet1').addRow(['nothing', 'to', 'do with it']);
    const bytes = Buffer.from(await other.xlsx.writeBuffer());

    await assert.rejects(() => ObjectiveWorkbook.parse(bytes), /Objective/);
  });

  /**
   * The steps on their own — the client's second report.
   *
   * "Download button par click karne par poore Objective ki jagah sirf Workflow Steps ka Excel
   * download hona chahiye." The button above the grid handed back the whole workbook, so the
   * person who was sent the steps to fill in received the Objective's own fields as well, theirs
   * to edit by accident. These assert the two halves of it: the file has one sheet, and that file
   * can come back through the same reader.
   */
  describe('the steps on their own', () => {
    it('writes one sheet, and it is the steps', async () => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        (await ObjectiveWorkbook.stepsOnly(undefined)) as unknown as ArrayBuffer,
      );

      assert.deepEqual(
        workbook.worksheets.map((sheet) => sheet.name),
        ['Steps'],
        'the steps download carried more than the steps',
      );
    });

    it('carries the steps that are filled in, and a blank grid when none are', async () => {
      const blank = new ExcelJS.Workbook();
      await blank.xlsx.load((await ObjectiveWorkbook.stepsOnly([])) as unknown as ArrayBuffer);
      const blankSheet = blank.getWorksheet('Steps');
      assert.ok(blankSheet, 'no Steps sheet');
      // Heading, legend, and one empty row to fill in.
      assert.equal(blankSheet.rowCount, 3, 'an empty grid is not fillable');

      const filled = new ExcelJS.Workbook();
      await filled.xlsx.load(
        (await ObjectiveWorkbook.stepsOnly([
          {
            position: 1,
            whoPersonName: 'Aman Singh',
            whoDesignation: null,
            whoEngine: 'Human',
            whenTrigger: null,
            whenFrequency: null,
            whatExactWork: 'Pull the ageing report.',
            inputWhatIsUsed: null,
            inputReceivedFrom: null,
            whereWorkIsDone: null,
            outputWhatIsProduced: null,
            outputSentTo: null,
            timeTaken: null,
            currentProblem: null,
            approval: 'NotRequired',
          },
        ])) as unknown as ArrayBuffer,
      );
      const text = JSON.stringify(filled.getWorksheet('Steps')?.getRow(3).values ?? []);
      assert.match(text, /Pull the ageing report\./);
      assert.match(text, /Aman Singh/);
    });

    it('can be read back, which is the half that was refused', async () => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        (await ObjectiveWorkbook.stepsOnly(undefined)) as unknown as ArrayBuffer,
      );
      const sheet = workbook.getWorksheet('Steps');
      assert.ok(sheet);

      const headings: string[] = [];
      sheet.getRow(1).eachCell((cell, index) => {
        headings[index] = String(cell.value ?? '').trim();
      });
      const columnOf = (label: string): number => headings.findIndex((h) => h === label);
      const row = sheet.getRow(3);
      row.getCell(columnOf('Step')).value = 1;
      row.getCell(columnOf('Exact Work')).value = 'Reconcile the branch sheets.';
      row.commit();

      const parsed = await ObjectiveWorkbook.parse(Buffer.from(await workbook.xlsx.writeBuffer()));

      assert.equal(parsed.steps.length, 1);
      assert.equal(parsed.steps[0]?.whatExactWork, 'Reconcile the branch sheets.');
      /*
       * And it does not invent complaints about an Objective the file never claimed to carry.
       * Before this, a steps-only file was refused outright — "that file has no Objective sheet" —
       * on a file the product had just produced.
       */
      assert.equal(
        parsed.problems.filter((problem) => problem.kind === 'Missing').length,
        0,
        'a steps-only file was marked as missing the Objective fields it never carried',
      );
    });

    it('still refuses a file that carries neither sheet', async () => {
      const other = new ExcelJS.Workbook();
      other.addWorksheet('Sheet1').addRow(['nothing', 'to', 'do with it']);
      const bytes = Buffer.from(await other.xlsx.writeBuffer());
      await assert.rejects(() => ObjectiveWorkbook.parse(bytes), /Steps/);
    });
  });
});
