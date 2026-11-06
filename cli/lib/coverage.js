import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The minimum coverage the tests workflows check (min-coverage), read from the Clover report the tests write. Setup does
// not ask for it: 100 is the default, and a project that needs less writes it by hand

// Files that configure the coverage reports of PHPUnit, Pest, Vitest and Jest
const CONFIG = /^(phpunit(\.dist)?\.xml(\.dist)?|(vitest|vite|jest)\.config\.[cm]?[jt]s|package\.json)$/;

/**
 * Whether a configuration file of the folder asks for a Clover report (it mentions clover), which the coverage check
 * reads. False when none does.
 */
export async function writesClover(root) {
  let names;
  try {
    names = await readdir(root);
  } catch {
    return false;
  }
  for (const name of names.filter((candidate) => CONFIG.test(candidate))) {
    const content = await readFile(join(root, name), 'utf8').catch(() => '');
    if (/clover/i.test(content)) return true;
  }
  return false;
}

/** The minimum coverage the workflow file asks for: 100 without min-coverage, null when it is not a number. */
export function minCoverageOf(current) {
  const value = current?.minCoverage ?? '100';
  return /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * Warns when the tests check a minimum coverage but no configuration file asks for the Clover report, so the check
 * fails. Nothing when the folder was not read (state.clover null), or the tests or the check are off.
 */
export function coverageItems(report, state) {
  const current = state.current;
  if (!current || state.clover == null) return;
  if (current.tests === false || current.testCommand === 'none' || minCoverageOf(current) === 0) return;
  if (state.clover) {
    report.ok(`Clover report for the minimum coverage (${minCoverageOf(current) ?? current.minCoverage}%)`);
    return;
  }
  report.warn(
    `No Clover report configured, so the minimum coverage (${minCoverageOf(current) ?? current.minCoverage}%) fails the tests`,
    'have phpunit.xml, Vitest or Jest write clover.xml (see the test docs of the stack), or set min-coverage: 0',
  );
}
