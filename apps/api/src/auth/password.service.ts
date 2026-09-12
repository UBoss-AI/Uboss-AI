import { hash, parseOptions, verify } from '@node-rs/argon2';
import { Inject, BadRequestException, Injectable, Logger } from '@nestjs/common';

import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';

/**
 * Argon2id parameters.
 *
 * Argon2id is the hybrid variant: it resists both GPU cracking (data-independent first pass) and
 * side-channel attacks (data-dependent second pass), which is why it is the recommended default
 * rather than Argon2i or Argon2d.
 *
 * 19 MiB / 2 passes / 1 lane is the OWASP-recommended baseline. Parameters are embedded in the
 * stored PHC string, so raising them later does not invalidate existing hashes — `needsRehash`
 * below detects a weaker hash and it is replaced on the next successful sign-in.
 *
 * The algorithm is the numeric literal `2` because `@node-rs/argon2` exports `Algorithm` as an
 * ambient `const enum`, which cannot be read under `isolatedModules`.
 */
const ARGON2ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * The only component that touches passwords.
 *
 * There is no method here that returns or decrypts a password, because none is possible: only a
 * one-way Argon2id hash is ever produced or stored. No administrator, and no database reader,
 * can recover a password — including through this service.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  /**
   * Reject passwords that policy forbids.
   *
   * Length is the check that actually correlates with strength, so it is the one enforced.
   * Composition rules ("one uppercase, one symbol") push people toward predictable
   * substitutions and are deliberately not imposed. A breached-password corpus check belongs
   * here later; it needs an external data source and is noted as future work.
   */
  assertAcceptable(password: string): void {
    if (typeof password !== 'string' || password.length < this.config.minPasswordLength) {
      throw new BadRequestException(
        `Password must be at least ${this.config.minPasswordLength} characters.`,
      );
    }
    // Argon2 has no practical upper bound, but an unbounded input is a cheap denial-of-service:
    // hashing a 10 MB "password" costs real CPU.
    if (password.length > 256) {
      throw new BadRequestException('Password must be at most 256 characters.');
    }
  }

  async hash(password: string): Promise<string> {
    this.assertAcceptable(password);
    return hash(password, ARGON2_OPTIONS);
  }

  /**
   * Verify a candidate password.
   *
   * Returns false rather than throwing on a malformed stored hash: a corrupt row must fail the
   * sign-in, not return a 500 that tells an attacker something unusual happened.
   *
   * No options are passed — the parameters come from the stored PHC string, which is what lets
   * an old hash keep verifying after policy is raised.
   */
  async verify(storedHash: string, candidate: string): Promise<boolean> {
    try {
      return await verify(storedHash, candidate);
    } catch (error) {
      this.logger.error(
        `Password verification failed against a stored hash: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return false;
    }
  }

  /**
   * True when the stored hash is weaker than current policy, or uses a different algorithm.
   *
   * `@node-rs/argon2` exposes no `needsRehash`, so this compares the parameters parsed out of
   * the PHC string. Only *weaker* parameters trigger a rehash: a hash that is already stronger
   * than policy is left alone, since replacing it would be a downgrade.
   */
  needsRehash(storedHash: string): boolean {
    try {
      const parsed = parseOptions(storedHash);
      return (
        (parsed.algorithm as number) !== ARGON2ID ||
        parsed.memoryCost < ARGON2_OPTIONS.memoryCost ||
        parsed.timeCost < ARGON2_OPTIONS.timeCost ||
        parsed.parallelism < ARGON2_OPTIONS.parallelism
      );
    } catch {
      // An unparseable hash cannot be assessed; treat it as stale so it is replaced on next use.
      return true;
    }
  }
}
