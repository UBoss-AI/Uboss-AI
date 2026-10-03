/**
 * Turn a server validation failure into something a person can act on.
 *
 * ## The problem this solves
 *
 * The API has two kinds of refusal and they do not read alike. A domain refusal is written for
 * people — "You cannot approve something you created. UBoss requires a different person to approve
 * it." — and must be shown exactly as it arrives; paraphrasing it would put this screen's guess at
 * the rule in front of the rule itself.
 *
 * A DTO validation failure is not written for people at all. It arrives as
 * `content.objectiveName must be longer than or equal to 1 characters`, and the objective form was
 * showing that, verbatim, in a banner — with no field marked wrong. The person is told a property
 * path and a character count and left to work out which box on a forty-column form it means.
 *
 * ## What this does
 *
 * Recognises the shape of a generated message, lifts the field out of it, and says the thing the
 * message was trying to say. Anything it does not recognise is passed through untouched with no
 * field attached, because an unrecognised message is more likely to be a hand-written domain
 * refusal than something to be rewritten by a pattern.
 *
 * It deliberately does not invent guidance. "Objective name is required" is what
 * `must be longer than or equal to 1 characters` means; it is not advice about what to call the
 * objective, which this module has no basis for.
 */

export interface ValidationProblem {
  /**
   * The form field it belongs to, when the message named one — `objectiveName`, or
   * `steps.0.whatExactWork`. Null when the message is not about a specific field.
   */
  field: string | null;
  /** What to show. A sentence. */
  text: string;
  /** The message exactly as the server sent it, for a title attribute or a bug report. */
  raw: string;
}

/** Field names as the form knows them, from the paths the DTOs use. */
const FIELD_LABELS: Record<string, string> = {
  objectiveName: 'Objective name',
  departmentId: 'Department',
  objectiveOwnerUserId: 'Objective owner',
  responsibleOwnerUserId: 'Responsible owner / send to',
  expectedFinalResult: 'Expected final result',
  currentWorkload: 'Current workload',
  unit: 'Unit',
  targetCompletionTime: 'Target completion time',
  timeUnit: 'Time unit',
  preparedBy: 'Prepared by',
  whatExactWork: 'Exact work',
  whoPersonName: 'Person name',
  whoDesignation: 'Designation',
};

/**
 * The generated phrasings this recognises, and what each one actually means.
 *
 * Ordered: the first match wins, so the more specific patterns come first.
 */
const PHRASES: { pattern: RegExp; say: (label: string, match: RegExpMatchArray) => string }[] = [
  {
    pattern: /must be longer than or equal to 1 characters?$/,
    say: (label) => `${label} is required.`,
  },
  {
    pattern: /must be longer than or equal to (\d+) characters?$/,
    say: (label, m) => `${label} needs at least ${m[1]} characters.`,
  },
  {
    pattern: /must be shorter than or equal to (\d+) characters?$/,
    say: (label, m) => `${label} cannot be longer than ${m[1]} characters.`,
  },
  {
    // A UUID field is always a choice from a list in this product, never something to type.
    pattern: /must be a UUID(?: v?\d)?$/,
    say: (label) => `${label} must be chosen from the list.`,
  },
  { pattern: /should not be empty$/, say: (label) => `${label} is required.` },
  { pattern: /must be a string$/, say: (label) => `${label} is required.` },
  { pattern: /must be a number.*$/, say: (label) => `${label} must be a number.` },
  {
    pattern: /must be one of the following values: (.+)$/,
    say: (label, m) => `${label} must be one of: ${m[1]}.`,
  },
  { pattern: /must be an email$/, say: (label) => `${label} must be an email address.` },
  {
    pattern: /must not be less than (\d+)$/,
    say: (label, m) => `${label} cannot be below ${m[1]}.`,
  },
  {
    pattern: /must not be greater than (\d+)$/,
    say: (label, m) => `${label} cannot be above ${m[1]}.`,
  },
];

/** `content.objectiveName` -> objectiveName; `steps.0.whatExactWork` -> steps.0.whatExactWork */
function fieldFrom(path: string): { field: string; label: string } | null {
  const parts = path.split('.');
  const last = parts[parts.length - 1];
  if (last === undefined) return null;
  const label = FIELD_LABELS[last];
  if (label === undefined) return null;

  // Step paths keep their index, because "Step 2" is how the grid numbers them for a person.
  const stepIndex = parts.find((part) => /^\d+$/.test(part));
  if (parts[0] === 'steps' && stepIndex !== undefined) {
    return {
      field: `steps.${stepIndex}.${last}`,
      label: `Step ${Number(stepIndex) + 1}: ${label.toLowerCase()}`,
    };
  }
  return { field: last, label };
}

/**
 * Read a server message into problems.
 *
 * Nest flattens a validation array into one string, so several problems can arrive joined. They
 * are split on the property paths rather than on punctuation: the messages contain no reliable
 * separator, and splitting on "." would cut sentences in half.
 */
export function parseValidationProblems(message: string): ValidationProblem[] {
  const trimmed = message.trim();
  if (trimmed === '') return [];

  /*
   * Each generated message begins with a dotted property path, so the joined string is cut at
   * every path it contains. The first attempt required the character before the path to be
   * lowercase, which silently lost any problem that followed one ending in "UUID" — two of the
   * four real problems never appeared. Matching the path itself, wherever it is, has no such hole.
   */
  const boundaries = [...trimmed.matchAll(/(?:content|steps|body)\.[A-Za-z0-9.]+(?= )/g)];
  if (boundaries.length === 0) {
    // Not a generated message. A hand-written refusal is shown exactly as it arrived.
    return [{ field: null, text: trimmed, raw: trimmed }];
  }

  const problems: ValidationProblem[] = [];
  for (const [index, boundary] of boundaries.entries()) {
    const start = boundary.index ?? 0;
    const end =
      index + 1 < boundaries.length
        ? (boundaries[index + 1]?.index ?? trimmed.length)
        : trimmed.length;
    const piece = trimmed.slice(start, end).trim();
    const path = boundary[0];
    const rest = piece.slice(piece.indexOf(path) + path.length).trim();

    const named = fieldFrom(path);
    const label = named?.label ?? path;
    const phrase = PHRASES.find((candidate) => candidate.pattern.test(rest));
    const match = phrase === undefined ? null : rest.match(phrase.pattern);

    problems.push({
      field: named?.field ?? null,
      text: phrase !== undefined && match !== null ? phrase.say(label, match) : `${label}: ${rest}`,
      raw: piece,
    });
  }
  return problems;
}

/** Whether a message is a generated validation failure rather than a written refusal. */
export function isValidationMessage(message: string): boolean {
  return /(?:content|steps|body)\.[A-Za-z0-9.]+ /.test(message);
}
