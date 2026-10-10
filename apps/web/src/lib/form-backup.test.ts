import { describe, expect, it } from 'vitest';

import { shouldRestoreFormBackup } from './form-backup';

/**
 * The rule that decides whether a tab's local copy goes back on screen.
 *
 * Reported from production: an administrator opened an objective he had filled in, and watched
 * it empty, under a line saying his unsaved work had been restored. The cause is the case in the
 * middle of this file — the backup held the untouched form, because the page had written it
 * there before the server's answer arrived, and "it differs from what loaded" was the whole of
 * the test.
 */
describe('restoring a form from this tab', () => {
  const SERVER = JSON.stringify({ content: { objectiveName: 'Quarterly close' }, steps: [1, 2] });
  const PRISTINE = JSON.stringify({ content: { objectiveName: '' }, steps: [] });

  it('puts back work the server never received', () => {
    const typed = JSON.stringify({
      content: { objectiveName: 'Quarterly close' },
      steps: [1, 2, 3],
    });

    expect(shouldRestoreFormBackup({ kept: typed, current: SERVER, pristine: PRISTINE })).toBe(
      true,
    );
  });

  it('does not restore the untouched form over a filled draft', () => {
    /*
     * The production failure, as one line.
     *
     * The page wrote its own empty starting state to storage before the draft arrived, so the
     * backup and the draft differed — which used to be the entire condition. A filled objective
     * was replaced by nothing and the page said it had recovered it.
     */
    expect(shouldRestoreFormBackup({ kept: PRISTINE, current: SERVER, pristine: PRISTINE })).toBe(
      false,
    );
  });

  it('does nothing when the backup is what the server already sent', () => {
    expect(shouldRestoreFormBackup({ kept: SERVER, current: SERVER, pristine: PRISTINE })).toBe(
      false,
    );
  });

  it('does nothing when this tab holds no backup', () => {
    expect(shouldRestoreFormBackup({ kept: null, current: SERVER, pristine: PRISTINE })).toBe(
      false,
    );
  });

  it('still restores a deliberately emptied form, because somebody emptied it', () => {
    /*
     * The edge the rule must not overreach on. Somebody clearing a draft they had filled is a
     * change they made, and it is only indistinguishable from the pristine form when the draft
     * on the server is *also* empty — in which case restoring it changes nothing anyway.
     */
    const emptiedOnPurpose = PRISTINE;
    const serverHasContent = SERVER;

    expect(
      shouldRestoreFormBackup({
        kept: emptiedOnPurpose,
        current: serverHasContent,
        pristine: 'a form with different defaults',
      }),
    ).toBe(true);
  });
});
