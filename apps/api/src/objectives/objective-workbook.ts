import ExcelJS from 'exceljs';

import {
  FORM2_OBJECTIVE_FIELDS,
  FORM2_WORKFLOW_COLUMNS,
  STEP_APPROVAL_KINDS,
  STEP_ENGINE_KINDS,
  type Form2Objective,
  type Form2WorkflowStep,
} from '@uboss/types';

/**
 * An Objective as a spreadsheet, and back again.
 *
 * ## Why a round trip and not an export
 *
 * The client's rule is that an Admin can send the file out of UBoss, have somebody fill it in, and
 * upload it again. That only works if the file that comes down is the file that goes back up — so
 * the download of a **partly filled** objective carries its current values, not a blank template.
 * A template that always came down empty would make every download a decision to retype
 * everything.
 *
 * ## The columns are not written here
 *
 * Both sheets are generated from `FORM2_OBJECTIVE_FIELDS` and `FORM2_WORKFLOW_COLUMNS`, which are
 * the same definitions the form, the DTOs and the validation read. A column added to Form 2 appears
 * in this workbook without anybody editing this file, and — more importantly — a column cannot be
 * quietly dropped from the spreadsheet while staying in the form.
 *
 * ## Reading it back changes nothing
 *
 * `parse` returns what the file says and what it could not understand. It does not write, does not
 * merge and does not decide: the caller shows it, and a person confirms. The client's rule is
 * explicit — "do NOT silently destroy existing data" — and the only way to honour that is for the
 * parser to have no opinion about the objective already in the database.
 */

const OBJECTIVE_SHEET = 'Objective';
const STEPS_SHEET = 'Steps';

/** One thing the file got wrong, in the words the person fixing the file needs. */
export interface WorkbookProblem {
  /** `Objective` or a step number, so the reader knows where to look. */
  where: string;
  field: string;
  /** Missing, Invalid, or Unmapped — three different facts, never merged. */
  kind: 'Missing' | 'Invalid' | 'Unmapped';
  detail: string;
}

export interface ParsedObjectiveWorkbook {
  /** Only the fields the file actually carried. Absent is not empty. */
  objective: Partial<Record<string, string>>;
  steps: Partial<Form2WorkflowStep>[];
  problems: WorkbookProblem[];
}

/** What a download needs to know. Every part optional: a blank objective downloads a template. */
export interface ObjectiveSnapshot {
  objective?: Partial<Form2Objective> | undefined;
  steps?: readonly Form2WorkflowStep[] | undefined;
  /** Resolved names, because an id in a spreadsheet is unreadable and unfillable. */
  departmentName?: string | undefined;
  ownerName?: string | undefined;
  responsibleOwnerName?: string | undefined;
}

export class ObjectiveWorkbook {
  /**
   * The file to send out: the objective's current values, or a template when there are none.
   *
   * The header is written as label/value pairs rather than a header row, because it is a form
   * rather than a table — somebody filling it in reads "Objective Name:" and types beside it.
   */
  static async toBuffer(snapshot: ObjectiveSnapshot): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'UBoss';
    workbook.created = new Date();

    // ---- the objective itself ----
    const sheet = workbook.addWorksheet(OBJECTIVE_SHEET);
    sheet.columns = [
      { key: 'field', width: 32 },
      { key: 'value', width: 64 },
      { key: 'note', width: 46 },
    ];

    const heading = sheet.addRow(['Field', 'Value', 'Notes']);
    heading.font = { bold: true };

    const objective = snapshot.objective ?? {};
    for (const field of FORM2_OBJECTIVE_FIELDS) {
      /*
       * A department and an owner are stored as ids and written as names.
       *
       * Sending a UUID out to be filled in by a person is sending something nobody can check and
       * nobody can correct. The name goes out; the name comes back; the caller resolves it against
       * the company, which is where the answer actually lives.
       */
      const value =
        field.key === 'departmentId'
          ? (snapshot.departmentName ?? '')
          : field.key === 'objectiveOwnerUserId'
            ? (snapshot.ownerName ?? '')
            : field.key === 'responsibleOwnerUserId'
              ? (snapshot.responsibleOwnerName ?? '')
              : ((objective as Record<string, unknown>)[field.key] ?? '');

      sheet.addRow([
        field.label + (field.required === true ? ' *' : ''),
        value === null ? '' : String(value),
        field.section === 'UbossRouting'
          ? 'UBoss routing — separate from the source Form 2 fields.'
          : '',
      ]);
    }

    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // ---- the steps ----
    const steps = workbook.addWorksheet(STEPS_SHEET);
    steps.columns = FORM2_WORKFLOW_COLUMNS.map((column) => ({
      width: Math.max(14, Math.round(column.width / 7)),
    }));

    const stepHeading = steps.addRow(FORM2_WORKFLOW_COLUMNS.map((column) => column.label));
    stepHeading.font = { bold: true };
    stepHeading.alignment = { wrapText: true, vertical: 'middle' };
    stepHeading.height = 30;

    /*
     * The vocabulary, written where it is typed.
     *
     * `Engine / Sub-Engine / Executor` and the approval kind are closed lists. A person filling
     * this offline has no way to know them, and a wrong word is a refused row — so the accepted
     * values are stated under the heading rather than left to be guessed.
     */
    const legend = steps.addRow(
      FORM2_WORKFLOW_COLUMNS.map((column) =>
        column.kind === 'engine'
          ? `One of: ${STEP_ENGINE_KINDS.join(', ')}`
          : column.kind === 'approval'
            ? `One of: ${STEP_APPROVAL_KINDS.join(', ')}`
            : '',
      ),
    );
    legend.font = { italic: true, size: 9, color: { argb: 'FF767676' } };
    legend.alignment = { wrapText: true, vertical: 'top' };

    for (const step of snapshot.steps ?? []) {
      steps.addRow(
        FORM2_WORKFLOW_COLUMNS.map((column) => {
          if (column.kind === 'step') return step.position;
          const value = (step as unknown as Record<string, unknown>)[column.key];
          return value === null || value === undefined ? '' : String(value);
        }),
      );
    }

    // A blank objective still gets one row, so the file is fillable rather than a bare header.
    if ((snapshot.steps ?? []).length === 0) {
      steps.addRow(FORM2_WORKFLOW_COLUMNS.map((column) => (column.kind === 'step' ? 1 : '')));
    }

    steps.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  /**
   * Read a returned file. **Writes nothing and decides nothing.**
   *
   * Values come back as text. Whether a department exists, whether an owner works here and whether
   * a required field is acceptable are questions about the company, not about the file — they are
   * the caller's, against the live company, exactly as a typed form is validated.
   */
  static async parse(buffer: Buffer): Promise<ParsedObjectiveWorkbook> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

    const problems: WorkbookProblem[] = [];
    const objective: Partial<Record<string, string>> = {};

    // ---- the objective sheet ----
    const sheet = workbook.getWorksheet(OBJECTIVE_SHEET);
    if (sheet === undefined) {
      throw new Error(
        `That file has no "${OBJECTIVE_SHEET}" sheet. Download the Objective Excel and fill that in.`,
      );
    }

    const byLabel = new Map(FORM2_OBJECTIVE_FIELDS.map((field) => [normalise(field.label), field]));

    sheet.eachRow((row, index) => {
      if (index === 1) return;
      const label = text(row.getCell(1));
      const value = text(row.getCell(2));
      if (label === '') return;

      const field = byLabel.get(normalise(label));
      if (field === undefined) {
        /*
         * A column UBoss has no field for. Feedback about the file, not a mistake by the person —
         * which is why it is its own kind and not an error.
         */
        problems.push({
          where: 'Objective',
          field: label,
          kind: 'Unmapped',
          detail: 'UBoss has no Objective field by that name, so this row was ignored.',
        });
        return;
      }
      if (value !== '') objective[field.key] = value;
    });

    for (const field of FORM2_OBJECTIVE_FIELDS) {
      if (field.required === true && (objective[field.key] ?? '') === '') {
        problems.push({
          where: 'Objective',
          field: field.label,
          kind: 'Missing',
          detail: 'Required, and the file left it blank.',
        });
      }
    }

    // ---- the steps sheet ----
    const stepSheet = workbook.getWorksheet(STEPS_SHEET);
    const steps: Partial<Form2WorkflowStep>[] = [];

    if (stepSheet !== undefined) {
      const headings: string[] = [];
      const headingRow = stepSheet.getRow(1);
      for (let column = 1; column <= FORM2_WORKFLOW_COLUMNS.length + 4; column += 1) {
        headings.push(text(headingRow.getCell(column)));
      }

      const columnFor = new Map(
        FORM2_WORKFLOW_COLUMNS.map((column) => [normalise(column.label), column]),
      );

      stepSheet.eachRow((row, index) => {
        // Row 1 is the header and row 2 is the legend the download wrote under it.
        if (index <= 2) return;

        const values: Record<string, unknown> = {};
        let empty = true;

        headings.forEach((heading, offset) => {
          if (heading === '') return;
          const column = columnFor.get(normalise(heading));
          const cell = text(row.getCell(offset + 1));
          if (column === undefined) {
            if (cell !== '') {
              problems.push({
                where: `Step ${index - 2}`,
                field: heading,
                kind: 'Unmapped',
                detail: 'UBoss has no step column by that name, so this cell was ignored.',
              });
            }
            return;
          }
          if (column.kind === 'step') return;
          if (cell !== '') empty = false;
          values[column.key] = cell === '' ? null : cell;
        });

        if (empty) return;

        const position = steps.length + 1;
        const engine = String(values['whoEngine'] ?? '');
        if (engine !== '' && !(STEP_ENGINE_KINDS as readonly string[]).includes(engine)) {
          problems.push({
            where: `Step ${position}`,
            field: 'Engine / Sub-Engine / Executor',
            kind: 'Invalid',
            detail: `"${engine}" is not one of: ${STEP_ENGINE_KINDS.join(', ')}.`,
          });
          delete values['whoEngine'];
        }

        /*
         * `approval`, not `approvalKind`.
         *
         * The cell is stored under the column's own key, and that key is `approval` — the same
         * name the step carries. This read `approvalKind`, which no column writes, so the check
         * below was always comparing an empty string: it never fired, and whatever the file said
         * went through untouched. A step could come back approved by "Maybe".
         *
         * It read as working because the engine check two blocks up is identical in shape and
         * does use the right key, so the two sat side by side looking like a matched pair.
         */
        const approval = String(values['approval'] ?? '');
        if (approval !== '' && !(STEP_APPROVAL_KINDS as readonly string[]).includes(approval)) {
          problems.push({
            where: `Step ${position}`,
            field: 'Approval',
            kind: 'Invalid',
            detail: `"${approval}" is not one of: ${STEP_APPROVAL_KINDS.join(', ')}.`,
          });
          delete values['approval'];
        }

        if (String(values['whatExactWork'] ?? '') === '') {
          problems.push({
            where: `Step ${position}`,
            field: 'What (exact work)',
            kind: 'Missing',
            detail: 'A step with no work described is not a step.',
          });
        }

        steps.push({ ...(values as Partial<Form2WorkflowStep>), position });
      });
    }

    return { objective, steps, problems };
  }
}

/** Compared with punctuation and case removed, so `What (exact work)` matches `what exact work`. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function text(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);

  const shaped = value as { result?: unknown; richText?: { text: string }[]; text?: string };
  if (Array.isArray(shaped.richText))
    return shaped.richText
      .map((run) => run.text)
      .join('')
      .trim();
  if (typeof shaped.text === 'string') return shaped.text.trim();
  if (shaped.result !== undefined && shaped.result !== null) return String(shaped.result).trim();
  return '';
}
