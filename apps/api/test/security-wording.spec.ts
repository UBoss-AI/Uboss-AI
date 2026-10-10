import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Every security event that emails somebody says what happened.
 *
 * ## The failure this exists to prevent
 *
 * The product has 117 security actions; 22 of them are recorded as *suspicious*, which is what
 * sends the person an email. Six of those 22 had wording. The other sixteen arrived as:
 *
 *   > A security event on your account — something security-relevant happened on your account in
 *   > this workspace. The details are in Settings → Security.
 *
 * A real administrator received one of those for **granting somebody a role**, which is the most
 * ordinary act an administrator performs, and it reads like a breach. That is worse than sending
 * nothing: an alarming sentence with no content cannot be acted on, and somebody who gets three
 * of them stops reading the fourth — which is the one that matters.
 *
 * ## Why it reads the source
 *
 * The claim crosses two files that have no reason to import each other: the services decide what
 * is suspicious, and the bridge decides what it is called. Nothing connects them at runtime, so
 * nothing can drift at runtime either — it drifts when somebody adds a `recordSuspicious` call
 * and does not think about the message. That is a fact about the source, and this is where it is
 * checked.
 *
 * It fails loudly if it finds nothing to check, because a scan that silently matches zero rows
 * is the way this kind of test rots into decoration.
 */
describe('every security alert that reaches somebody says what it is about', () => {
  const SRC = path.join(process.cwd(), 'src');
  const BRIDGE = path.join(SRC, 'notifications', 'security-notification.bridge.ts');
  const PUBLISHER = path.join(SRC, 'auth', 'security-event.publisher.ts');

  /** `SECURITY_ACTIONS.someKey` → `'security.some_key'`. */
  const actionValues = (): Record<string, string> => {
    const source = readFileSync(PUBLISHER, 'utf8');
    const values: Record<string, string> = {};
    // Two shapes, because prettier wraps the long ones onto their own line.
    for (const match of source.matchAll(/^\s{2}([a-zA-Z]+):\s*\n?\s*'(security\.[a-z_]+)'/gm)) {
      values[match[1]!] = match[2]!;
    }
    return values;
  };

  /** The actions some service records as suspicious, which is what raises a notification. */
  const notifyingActions = (): string[] => {
    const values = actionValues();
    const files = execSync('grep -rl recordSuspicious src --include=*.ts', { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((file) => file !== '' && !file.includes('generated'));

    const actions = new Set<string>();
    for (const file of files) {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      for (const match of source.matchAll(
        /recordSuspicious\(\{[\s\S]{0,200}?SECURITY_ACTIONS\.([a-zA-Z]+)/g,
      )) {
        const value = values[match[1]!];
        if (value !== undefined) actions.add(value);
      }
    }
    return [...actions].sort();
  };

  const wordedActions = (): string[] => [
    ...new Set(
      [...readFileSync(BRIDGE, 'utf8').matchAll(/'(security\.[a-z_]+)':/g)].map(
        (match) => match[1]!,
      ),
    ),
  ];

  it('finds the actions and the wording it claims to be checking', () => {
    assert.ok(notifyingActions().length >= 15, 'no notifying security actions found');
    assert.ok(wordedActions().length >= 15, 'no wording entries found');
  });

  it('has words for every one of them', () => {
    const worded = new Set(wordedActions());
    const missing = notifyingActions().filter((action) => !worded.has(action));

    assert.deepEqual(
      missing,
      [],
      'these email somebody and fall back to "something security-relevant happened": ' +
        `${missing.join(', ')}. A notification that cannot be acted on teaches people to ` +
        'ignore the ones that can.',
    );
  });

  it('keeps the fallback, because an unwritten action must still say something', () => {
    // Removing it would mean an action added tomorrow raises a notification with no title at
    // all. The fallback is the floor, not the plan.
    assert.match(readFileSync(BRIDGE, 'utf8'), /A security event on your account/);
  });
});
