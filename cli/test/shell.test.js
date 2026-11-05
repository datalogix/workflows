import { expect, test } from 'vitest';
import { run, runOrThrow } from '../lib/shell.js';

const node = (script) => ['-e', script];

test('runs a command without a shell, with stdin only when given', async () => {
  expect(await run('node', node('process.stdin.pipe(process.stdout)'), { input: 'héllo' })).toStrictEqual({
    code: 0,
    stdout: 'héllo',
    stderr: '',
  });
  // No shell: the argument is not expanded
  expect((await run('node', [...node('console.log(process.argv[1])'), '$HOME'])).stdout).toBe('$HOME\n');
  expect(await run('node', node('process.exit(3)'))).toMatchObject({ code: 3 });
  // A command that exits without reading its input does not crash
  expect(await run('node', node('process.exit(0)'), { input: 'x'.repeat(1_000_000) })).toMatchObject({ code: 0 });
});

test('reports a missing command as code 127', async () => {
  expect(await run('datalogix-no-such-command', [])).toMatchObject({ code: 127 });
});

test('throws with the error output when the command fails', async () => {
  await expect(runOrThrow('node', node('console.error("boom"); process.exit(1)'))).rejects.toThrow(/boom$/);
  expect(await runOrThrow('node', node('process.stdout.write("ok")'))).toBe('ok');
});

test('throws with the standard output when the error output is empty, and runs in the folder given', async () => {
  await expect(runOrThrow('node', node('process.stdout.write("only stdout"); process.exit(2)'))).rejects.toThrow(
    /: only stdout$/,
  );
  expect((await run('node', node('process.stdout.write(process.cwd())'), { cwd: '/' })).stdout).toBe('/');
});
