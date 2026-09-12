/**
 * Release flags — Prompt 44.
 *
 * ## Why these exist at all
 *
 * The promotion pipeline applies migrations **before** it releases the new code, which means there
 * is always a window where the new schema is live and the old application is still serving. That
 * only works if the new behaviour can be held back independently of the deploy — which is what a
 * release flag is for.
 *
 * They are not product configuration. A company setting belongs in `CompanySettings`, is edited by
 * a person, and lives forever. A release flag is edited by whoever is deploying, exists to make one
 * change safe to ship, and is **meant to be deleted**.
 *
 * ## A registry rather than scattered `process.env` reads
 *
 * Every flag is declared here, with what it gates and the condition under which it should be
 * removed. Three things follow that a bare `process.env.SOMETHING === 'true'` cannot give:
 *
 *   * somebody can list what is currently gated without grepping the codebase;
 *   * a flag with no removal condition cannot be added, so the set cannot quietly become permanent;
 *   * a typo in a flag name is a type error rather than a silently-off feature.
 *
 * ## Default off, and why that direction
 *
 * An unset flag is **off**. A flag exists because something is not yet safe everywhere, so the
 * failure mode of a missing environment variable should be "the new thing did not switch on", not
 * "the new thing switched on in production before anyone approved it".
 */

export interface ReleaseFlag {
  /** The environment variable that sets it. */
  key: string;
  /** What is held back while this is off. */
  gates: string;
  /**
   * When this flag should be deleted.
   *
   * Required. A flag without a removal condition is a permanent branch in the product, and two
   * permanent branches are two products.
   */
  removeWhen: string;
}

/**
 * Every release flag in the product.
 *
 * Empty is the correct state, and it is the state now: nothing is currently gated. The registry
 * exists so the first flag has somewhere to be declared, and so the rules above apply to it from
 * the moment it is added rather than being retrofitted to a `process.env` read somebody buried in a
 * service.
 *
 * The shape is exercised by the tests with example flags, so "empty" does not mean "untested".
 */
export const RELEASE_FLAGS: readonly ReleaseFlag[] = [];

export type ReleaseFlagKey = string;

/** How a flag's value is read from an environment. Narrow on purpose — no file, no network. */
export type FlagEnvironment = Record<string, string | undefined>;

/**
 * Is this flag on?
 *
 * Only the exact strings `true`, `1` and `on` turn a flag on, case-insensitively. Anything else —
 * including the empty string, `yes`, `enabled`, or a typo — leaves it off.
 *
 * That strictness is deliberate. A permissive reader turns `FLAG=false` into "on", which is the
 * kind of mistake that is invisible in a dashboard and obvious only in an incident.
 */
export function flagIsOn(
  flag: ReleaseFlag,
  environment: FlagEnvironment,
  registry: readonly ReleaseFlag[] = RELEASE_FLAGS,
): boolean {
  if (!registry.some((entry) => entry.key === flag.key)) {
    // A flag that is not declared cannot be read. Otherwise the registry is documentation rather
    // than a constraint, and the guarantees above evaporate.
    throw new Error(
      `Release flag '${flag.key}' is not in RELEASE_FLAGS. Declare it, with a removeWhen.`,
    );
  }

  const raw = environment[flag.key];
  if (raw === undefined) return false;

  return ['true', '1', 'on'].includes(raw.trim().toLowerCase());
}

/** Every flag and its current state, for a status endpoint or a deployment log. */
export function flagStates(
  environment: FlagEnvironment,
  registry: readonly ReleaseFlag[] = RELEASE_FLAGS,
): { key: string; on: boolean; gates: string; removeWhen: string }[] {
  return registry.map((flag) => ({
    key: flag.key,
    on: flagIsOn(flag, environment, registry),
    gates: flag.gates,
    removeWhen: flag.removeWhen,
  }));
}

/**
 * Problems with the registry itself.
 *
 * Run in CI rather than trusted. The rules it enforces are the ones that stop a temporary
 * mechanism becoming a permanent one.
 */
export function registryProblems(registry: readonly ReleaseFlag[] = RELEASE_FLAGS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const flag of registry) {
    if (seen.has(flag.key)) problems.push(`'${flag.key}' is declared twice.`);
    seen.add(flag.key);

    if (!/^UBOSS_FLAG_[A-Z0-9_]+$/.test(flag.key)) {
      // A prefix so a flag is recognisable as one in a list of thirty environment variables.
      problems.push(`'${flag.key}' must be named UBOSS_FLAG_SOMETHING.`);
    }
    if (flag.gates.trim().length < 10) {
      problems.push(`'${flag.key}' does not say what it gates.`);
    }
    if (flag.removeWhen.trim().length < 10) {
      problems.push(`'${flag.key}' does not say when it should be removed.`);
    }
  }

  return problems;
}

/**
 * What the product says about flags, served verbatim so nobody has to infer it.
 */
export const RELEASE_FLAG_STANCE =
  'A release flag makes one change safe to deploy and is deleted once that change is everywhere. ' +
  'It is not a product setting, it is not a licence tier, and it is not a way to keep two ' +
  'behaviours alive indefinitely — every flag carries the condition under which it is removed, and ' +
  'a flag that is not declared in the registry cannot be read at all.';
