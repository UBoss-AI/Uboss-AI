/**
 * Run every workspace's test script, and fail if any of them failed.
 *
 * ## Why this exists
 *
 * `npm run test --workspaces --if-present` does not stop at a failing workspace and does not
 * propagate its exit code. During a stabilization pass `npm run verify` exited **0** while
 * `@uboss/types` had a failing test inside it — the failure was printed, npm moved on to the next
 * workspace, and the gate reported success. A verification gate that can pass while a suite fails
 * is worse than no gate, because it is trusted.
 *
 * So each workspace is run on its own, its exit code is kept, and the summary at the end names
 * every suite that failed. The list of workspaces is read from the root `package.json` rather than
 * written out here, so a workspace added later is covered without anybody remembering to add it.
 *
 * Sequential on purpose: the API suite talks to Postgres and the browser-driven checks share it,
 * and running suites concurrently against one database has already produced failures that were
 * nothing to do with the code under test.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Expand the `workspaces` globs the way npm does for this repository: one level of `dir/*`. */
function workspaceDirectories() {
  const found = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      found.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    if (!existsSync(join(root, parent))) continue;
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(`${parent}/${entry.name}`);
    }
  }
  return found;
}

const suites = [];
for (const directory of workspaceDirectories()) {
  const manifestPath = join(root, directory, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // `--if-present` semantics: a workspace with no test script is not a failure.
  if (manifest.scripts?.test === undefined) continue;
  suites.push({ name: manifest.name ?? directory, directory });
}

if (suites.length === 0) {
  console.error('No workspace declares a test script. That is not a pass — check the manifests.');
  process.exit(1);
}

console.log(`Running ${suites.length} workspace test suites, one at a time.`);

const failed = [];
for (const suite of suites) {
  console.log(`\n──────── ${suite.name} (${suite.directory})\n`);
  const result = spawnSync('npm', ['run', 'test', '--workspace', suite.name], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: root,
  });
  const code = result.status ?? 1;
  if (code !== 0) failed.push({ ...suite, code });
}

console.log('\n════════ workspace test summary');
for (const suite of suites) {
  const bad = failed.find((entry) => entry.name === suite.name);
  console.log(`  ${bad === undefined ? 'pass' : `FAIL (exit ${bad.code})`}  ${suite.name}`);
}

if (failed.length > 0) {
  console.error(
    `\n${failed.length} of ${suites.length} suites failed: ${failed.map((s) => s.name).join(', ')}`,
  );
  process.exit(1);
}

console.log(`\nall ${suites.length} suites passed`);
