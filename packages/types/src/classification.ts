/**
 * Data classification — the company's sensitivity labels.
 *
 * ## Why this is its own module, introduced at Prompt 33
 *
 * Prompt 33 needs it because §19 states the rule plainly: *"Sensitive data classification controls
 * whether a memory record can be persisted."* A memory policy cannot enforce a sensitive-data
 * restriction without a vocabulary of sensitivity.
 *
 * But classification is not memory's property. **Prompt 35 owns Knowledge, Files and Data
 * Classification**, and §23 names the four classes for the whole product: *"Company can classify
 * data such as Public / Internal / Confidential / Restricted and apply stricter AI/tool policies
 * to sensitive classes."* So the vocabulary lives here, on its own, where files, knowledge sources,
 * connections and exports will all reach it — rather than inside `memory.ts`, which would make
 * Prompt 35 either import from memory or declare a second set of labels.
 *
 * A second set of labels is the specific failure this module exists to prevent. Two orderings of
 * "Confidential" and "Restricted" in one product means a policy that is stricter in one module
 * than another for no reason anybody can explain.
 */

/**
 * The four classes, in **increasing sensitivity**, exactly as §23 names them.
 *
 * The order is the contract. Everything else in this module is a comparison against it, so a
 * caller never hard-codes "Confidential or higher" as a list that could fall out of step.
 */
export const DATA_CLASSIFICATIONS = ['Public', 'Internal', 'Confidential', 'Restricted'] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const DATA_CLASSIFICATION_LABELS: Record<DataClassification, string> = {
  Public: 'Public',
  Internal: 'Internal',
  Confidential: 'Confidential',
  Restricted: 'Restricted',
};

/**
 * What each class means, shown wherever somebody has to choose one.
 *
 * Written as "who may see this" rather than as an abstract definition, because a person labelling
 * a document is deciding about an audience, and a label nobody can apply consistently is worse
 * than no label.
 */
export const DATA_CLASSIFICATION_DESCRIPTIONS: Record<DataClassification, string> = {
  Public: 'Safe outside the company. No harm if it were published.',
  Internal: 'For people in this company. Ordinary business information.',
  Confidential: 'For people who need it. Commercially or personally sensitive.',
  Restricted: 'For named people only. Regulated, legally privileged or gravely damaging if leaked.',
};

/**
 * The default for anything unlabelled.
 *
 * `Internal`, not `Public`. An unlabelled document is one nobody has thought about, and treating
 * it as safe to leave the company is the wrong way to be wrong. It is deliberately not
 * `Restricted` either: defaulting to the strictest class would block ordinary work and teach
 * people to override the label without reading it, which is how a classification scheme dies.
 */
export const DEFAULT_DATA_CLASSIFICATION: DataClassification = 'Internal';

/** Position in the order above. Higher is more sensitive. */
export function classificationRank(classification: DataClassification): number {
  return DATA_CLASSIFICATIONS.indexOf(classification);
}

/**
 * Whether `candidate` is at most as sensitive as `ceiling`.
 *
 * The one comparison every policy in the product should use. Written as "at most" rather than "at
 * least" because every rule that reads it is a *ceiling*: the highest class a memory may persist,
 * the highest an export may carry, the highest a connection may read.
 */
export function classificationAllowed(
  candidate: DataClassification,
  ceiling: DataClassification,
): boolean {
  return classificationRank(candidate) <= classificationRank(ceiling);
}

/** The stricter of two classes. Used where two policies both apply and neither may be weakened. */
export function strictestClassification(
  first: DataClassification,
  second: DataClassification,
): DataClassification {
  return classificationRank(first) >= classificationRank(second) ? first : second;
}

/**
 * Classes a company should treat as sensitive.
 *
 * `Confidential` and `Restricted`, from §23's "apply stricter AI/tool policies to sensitive
 * classes". Exposed as a predicate rather than a list so a caller cannot accidentally test
 * membership of a stale copy.
 */
export function isSensitiveClassification(classification: DataClassification): boolean {
  return classificationRank(classification) >= classificationRank('Confidential');
}
