import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The coverage the tests workflows read from the Clover report the tests write: packages fail below min-coverage, 100 by
// default; apps show it in the job summary and fail only below a min-coverage they set. Setup does not ask for it: a
// project that wants another minimum writes it by hand

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

/**
 * The minimum coverage the workflow file asks for: `fallback` (the workflow's default) without min-coverage, null when it
 * is not a number.
 */
export function minCoverageOf(current, fallback = 100) {
  const value = current?.minCoverage ?? String(fallback);
  return /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * Warns when the tests read the coverage but no configuration file asks for the Clover report: a minimum then fails, and
 * an app shows no coverage. Nothing when the folder was not read (state.clover null), or the tests are off, or a
 * package turns the check off. `app` is true for apps, whose minimum is 0 by default and whose coverage is always shown.
 */
export function coverageItems(report, state, { app = false } = {}) {
  const current = state.current;
  if (!current || state.clover == null) return;
  if (current.tests === false || current.testCommand === 'none') return;
  const minimum = minCoverageOf(current, app ? 0 : 100);
  const hint = 'have phpunit.xml, Vitest or Jest write clover.xml (see the test docs of the stack)';
  if (minimum === 0) {
    if (!app) return;
    if (state.clover) report.ok('Clover report for the coverage shown by the tests job');
    else report.warn('No Clover report configured, so the tests job shows no coverage', hint);
    return;
  }
  if (state.clover) {
    report.ok(`Clover report for the minimum coverage (${minimum ?? current.minCoverage}%)`);
    return;
  }
  report.warn(
    `No Clover report configured, so the minimum coverage (${minimum ?? current.minCoverage}%) fails the tests`,
    `${hint}, or set min-coverage: 0`,
  );
}
