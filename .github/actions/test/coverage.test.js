import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runScript } from './fakes.js';

// A Clover report with project metrics and one entry per file: [name, covered, elements]
function clover(files, { root = '' } = {}) {
  const covered = files.reduce((sum, [, c]) => sum + c, 0);
  const elements = files.reduce((sum, [, , e]) => sum + e, 0);
  const entries = files
    .map(([name, c, e]) => `<file name="${root}${name}"><metrics coveredelements="${c}" elements="${e}"/></file>`)
    .join('');
  return `<?xml version="1.0"?><coverage><project><package name="app">${entries}</package><metrics elements="${elements}" coveredelements="${covered}"/></project></coverage>`;
}

/** Runs the script in a project folder holding `files` ({ path: content }); `old` files are dated before the tests. */
async function coverage(minimum, files = {}, { since = true, old = [], env = {} } = {}) {
  // SINCE is the marker written by setup, which runs before the script reads the environment
  const vars = { MIN_COVERAGE: String(minimum), ...env };
  return runScript('coverage/coverage.sh', {
    env: vars,
    setup: async (dir) => {
      const project = join(dir, 'project');
      await mkdir(project);
      const marker = join(dir, 'tests-started');
      await writeFile(marker, '');
      const past = new Date(Date.now() - 60_000);
      await utimes(marker, past, past);
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(project, path)), { recursive: true });
        await writeFile(join(project, path), content);
        if (old.includes(path)) {
          const older = new Date(Date.now() - 120_000);
          await utimes(join(project, path), older, older);
        }
      }
      if (since) vars.SINCE = marker;
      return project;
    },
  });
}

describe('coverage', () => {
  test('passes at the minimum', async () => {
    const result = await coverage(100, { 'clover.xml': clover([['src/A.php', 10, 10]]) });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'Coverage is 100.00% (10 of 10 statements, methods and conditionals), minimum 100%',
    );
  });

  test('passes above a lower minimum', async () => {
    const result = await coverage(80, { 'coverage/clover.xml': clover([['src/a.ts', 9, 10]]) });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Coverage is 90.00%');
  });

  test('fails below the minimum, rounding down, and lists the files not fully covered', async () => {
    const result = await coverage(
      100,
      {
        'build/logs/clover.xml': clover(
          [
            ['src/A.php', 10, 10],
            ['src/B.php', 1, 3],
            ['src/C.php', 9998, 9998],
          ],
          { root: '/home/runner/work/app/app/' },
        ),
      },
      { env: { GITHUB_WORKSPACE: '/home/runner/work/app/app' } },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      '::error::Coverage is 99.98% (10009 of 10011 statements, methods and conditionals), below the minimum of 100%',
    );
    expect(result.stdout).toContain('Files not fully covered (1):\n  src/B.php: 1 of 3\n');
  });

  test('lists at most 50 files', async () => {
    const files = Array.from({ length: 52 }, (_, i) => [`src/F${i}.php`, 0, 1]);
    const result = await coverage(100, { 'clover.xml': clover(files) });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Files not fully covered (52):');
    expect(result.stdout).toContain('  src/F49.php: 0 of 1\n  ... and 2 more');
    expect(result.stdout).not.toContain('F50.php');
  });

  test('checks nothing with 0', async () => {
    const result = await coverage(0);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('min-coverage is 0: coverage is not checked');
  });

  test.each(['', '101', '50.5', 'abc', '-1'])('rejects min-coverage %j', async (minimum) => {
    const result = await coverage(minimum, { 'clover.xml': clover([['a', 1, 1]]) });

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/::error::min-coverage must be/);
  });

  test('fails without a report', async () => {
    const result = await coverage(100);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      '::error::The tests wrote no Clover report (looked for clover.xml build/logs/clover.xml build/clover.xml coverage/clover.xml): configure the test runner to write one, or set min-coverage: 0',
    );
  });

  test('ignores a report older than the tests and takes the next one', async () => {
    const files = {
      'clover.xml': clover([['stale', 1, 1]]),
      'coverage/clover.xml': clover([['fresh', 1, 2]]),
    };

    const stale = await coverage(100, { 'clover.xml': files['clover.xml'] }, { old: ['clover.xml'] });
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain('::error::The tests wrote no Clover report');

    const fresh = await coverage(100, files, { old: ['clover.xml'] });
    expect(fresh.stdout).toContain('Coverage is 50.00%');

    // Without since, any report counts
    const any = await coverage(100, { 'clover.xml': files['clover.xml'] }, { since: false, old: ['clover.xml'] });
    expect(any.code).toBe(0);
  });

  test('fails when no tests ran, even with a report in the project', async () => {
    const result = await coverage(
      100,
      { 'clover.xml': clover([['a', 1, 1]]) },
      { env: { SINCE: '/nonexistent/tests-started' }, since: false },
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      '::error::No tests ran, so there is no coverage to check: add tests, or set min-coverage: 0',
    );
  });

  test('fails on a file that is not a Clover report', async () => {
    const result = await coverage(100, { 'clover.xml': '<coverage><project/></coverage>' });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('::error::clover.xml is not a Clover report with project metrics');
  });

  test('fails on a report that measures no code', async () => {
    const result = await coverage(100, { 'clover.xml': clover([]) });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('::error::clover.xml measures no code: check which files the coverage includes');
  });
});
