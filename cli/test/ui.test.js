import { stripVTControlCharacters as plain } from 'node:util';
import { beforeEach, expect, test, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { askSteps, confirmFolder, logResults, orExit, question, runTasks, stepBar, taskOutcome } from '../lib/ui.js';

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  progress: vi.fn(() => ({ start() {}, message() {}, advance() {}, stop: vi.fn() })),
  log: { warn: vi.fn(), success: vi.fn(), error: vi.fn() },
  confirm: vi.fn(),
  cancel: vi.fn(),
  // What a question returns when it is cancelled (Ctrl+C)
  isCancel: (value) => value === 'cancelled',
}));

beforeEach(() => vi.clearAllMocks());

/** Makes process.exit throw, so a test can see it was called and go on. */
function trapExit(t) {
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  t.onTestFinished(() => exit.mockRestore());
  return exit;
}

test('draws the progress of the questions', () => {
  expect(stepBar(0, 4)).toBe('□□□□□□□□□□  0/4');
  expect(stepBar(2, 4)).toBe('■■■■■□□□□□  2/4');
  expect(stepBar(4, 4)).toBe('■■■■■■■■■■  4/4');
  expect(stepBar(0, 0)).toBe('□□□□□□□□□□  0/0');
});

test('asks only the steps that apply, counting them as answers change', async () => {
  const headers = [];
  const ask =
    (value) =>
    async ({ header }) => {
      headers.push(header.split('  ')[1]);
      return value;
    };
  const steps = [
    { id: 'deploy', ask: ask('forge') },
    { id: 'staging', when: (a) => a.deploy !== 'none', ask: ask(false) },
    { id: 'stagingDomain', when: (a) => a.staging, ask: ask('staging.example.com') },
    { id: 'solo', flag: 'solo', ask: ask(false) },
    { id: 'done', ask: ask(true), then: (answers) => (answers.after = true) },
  ];

  const answers = await askSteps(steps, { flags: { solo: true } });
  expect(answers).toStrictEqual({ deploy: 'forge', staging: false, solo: true, done: true, after: true });
  // stagingDomain counted while staging was unknown, then dropped; solo came from the flag
  expect(headers).toStrictEqual(['1/3', '2/3', '3/3']);
});

test('checks values given as flags like the question would', async () => {
  const validate = (value) => (value.startsWith('https://') ? 'Type only the domain' : undefined);
  const steps = [{ id: 'domain', flag: 'domain', validate, ask: async () => 'asked' }];

  expect(await askSteps(steps, { flags: { domain: 'app.example.com' } })).toStrictEqual({ domain: 'app.example.com' });
  await expect(askSteps(steps, { flags: { domain: 'https://app.example.com' } })).rejects.toThrow(
    /--domain: Type only the domain/,
  );
  // parse turns the flag's text into the answer the question gives
  const parsed = [{ id: 'lint', flag: 'lint', parse: (value) => value.split(','), ask: async () => 'asked' }];
  expect(await askSteps(parsed, { flags: { lint: 'pint,phpstan' } })).toStrictEqual({ lint: ['pint', 'phpstan'] });
});

test('exits with 1 when a question is cancelled, and passes an answer through', (t) => {
  trapExit(t);
  expect(orExit('forge')).toBe('forge');
  expect(() => orExit('cancelled')).toThrow('exit 1');
  expect(prompts.cancel).toHaveBeenCalledWith('Cancelled. Nothing was changed.');
});

test('asks before using a folder of another repository', async (t) => {
  trapExit(t);
  const ctx = (folderRepository, flags = {}) => ({ folderRepository, flags });
  // The same repository, whatever the case of the names: nothing asked
  await confirmFolder(ctx('Datalogix/App'), 'datalogix/app');
  expect(prompts.confirm).not.toHaveBeenCalled();

  prompts.confirm.mockResolvedValueOnce(true);
  await confirmFolder(ctx(null), 'datalogix/app');
  expect(prompts.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      message:
        'This folder has no GitHub remote, not datalogix/app: its files are the ones read and written. Go on anyway?',
    }),
  );

  prompts.confirm.mockResolvedValueOnce(false);
  await expect(confirmFolder(ctx('datalogix/other'), 'datalogix/app')).rejects.toThrow('exit 1');
  expect(prompts.cancel).toHaveBeenCalledWith('Nothing was changed. Run it from the project folder.');

  // --yes only warns
  await confirmFolder(ctx('datalogix/other', { yes: true }), 'datalogix/app');
  expect(prompts.log.warn).toHaveBeenCalledWith(
    'This folder is datalogix/other, not datalogix/app: its files are the ones read and written',
  );
});

test('runs every task, keeping the first line of a failure', async () => {
  const results = await runTasks([
    {
      title: 'A',
      run: async () => {
        throw new Error('first\nsecond');
      },
    },
    { title: 'B', run: async () => undefined },
    { id: 'c', title: 'C', run: async () => ({ detail: 'created', data: { x: 1 } }) },
  ]);
  // The id, when the task has one, is what later steps look the result up by
  expect(results).toStrictEqual([
    { title: 'A', ok: false, detail: 'first' },
    { title: 'B', ok: true, detail: 'done' },
    { id: 'c', title: 'C', ok: true, detail: 'created', data: { x: 1 } },
  ]);
  const bar = (index) => prompts.progress.mock.results[index].value;
  expect(bar(0).stop).toHaveBeenCalledWith('Applied with 1 problem(s)');
  expect(await runTasks([])).toStrictEqual([]);
  expect(bar(1).stop).toHaveBeenCalledWith('All applied');
  expect(taskOutcome(undefined)).toStrictEqual({ detail: 'done' });
  expect(taskOutcome({ data: { x: 1 } })).toStrictEqual({ detail: 'done', data: { x: 1 } });
});

test('shows each result, a failure as an error', () => {
  logResults([
    { title: 'A', ok: true, detail: 'created' },
    { title: 'B', ok: false, detail: 'HTTP 403' },
  ]);
  expect(prompts.log.success.mock.calls.map(([line]) => plain(line))).toStrictEqual(['A  created']);
  expect(prompts.log.error.mock.calls.map(([line]) => plain(line))).toStrictEqual(['B  HTTP 403']);
});

test('puts what a question turns on below it, one dimmed line each', () => {
  expect(plain(question('1/2', 'Turn it on?'))).toBe('1/2\nTurn it on?');
  expect(plain(question('1/2', 'Turn it on?', 'It does this'))).toBe('1/2\nTurn it on?\n  It does this');
  expect(plain(question('1/2', 'Pick', ['A: one', 'B: two']))).toBe('1/2\nPick\n  A: one\n  B: two');
});
