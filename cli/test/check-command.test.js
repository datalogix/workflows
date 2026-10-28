import { beforeEach, expect, test, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { check, evaluate } from '../commands/check.js';
import { PACKAGE_CHECKS } from '../kinds/package/index.js';
import { renderPackageWorkflow } from '../kinds/package/workflow.js';
import { hasSecret } from '../kinds/project/relay.js';
import { renderProjectWorkflow } from '../kinds/project/workflow.js';
import { rulesetBody } from '../lib/ruleset.js';
import { WORKFLOW_PATH } from '../lib/workflow-file.js';
import { APP_STATE, fakeGitHub, folder, onPlatform, RELAY } from './helpers.js';

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  spinner: vi.fn(() => ({ start() {}, stop: vi.fn(), error: vi.fn(), message() {} })),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), message: vi.fn() },
  outro: vi.fn(),
}));
// The relay's KV is read through npx wrangler: the test answers instead
vi.mock('../kinds/project/relay.js', async (importOriginal) => ({
  ...(await importOriginal()),
  hasSecret: vi.fn(async () => true),
}));

beforeEach(() => vi.clearAllMocks());

const LARAVEL_PACKAGE = JSON.stringify({ require: { 'illuminate/support': '^12.0' } });

/** A package folder set up as setup leaves it, and the GitHub it is checked against. */
async function packageFolder(t) {
  return folder(
    t,
    {
      'composer.json': LARAVEL_PACKAGE,
      [WORKFLOW_PATH]: await renderPackageWorkflow('', 'main'),
      '.github/CODEOWNERS': '/.github/ @ana\n',
    },
    'check-',
  );
}

const packageGitHub = (methods = {}) =>
  fakeGitHub({
    repo: async () => ({ full_name: 'datalogix/package', default_branch: 'main' }),
    rulesets: async () => [{ id: 1, name: 'datalogix' }],
    ruleset: async () => rulesetBody([PACKAGE_CHECKS.tests]),
    login: async () => 'ana',
    hasRepositorySecret: async () => true,
    hasOrganizationSecret: async () => false,
    ...methods,
  });

const run = (root, github, { repository = 'datalogix/package', folderRepository = repository } = {}) =>
  check({ root, repository, folderRepository, relay: RELAY, createGitHub: () => github });

test('passes a package set up by setup, warns about nothing', async (t) => {
  expect(await run(await packageFolder(t), packageGitHub())).toBe(0);
  expect(clack.outro).toHaveBeenCalledWith('Everything is set up');
  expect(clack.log.warn).not.toHaveBeenCalled();
});

test('exits with 0 on warnings only and with 1 on errors', async (t) => {
  // No ruleset: a warning
  const unprotected = packageGitHub({ rulesets: async () => [] });
  expect(await run(await packageFolder(t), unprotected)).toBe(0);
  expect(clack.outro).toHaveBeenCalledWith('0 error(s), 1 warning(s)');

  // No workflow file: an error
  const bare = await folder(
    t,
    { 'composer.json': LARAVEL_PACKAGE, '.github/CODEOWNERS': '/.github/ @ana\n' },
    'check-',
  );
  expect(await run(bare, packageGitHub())).toBe(1);
  expect(clack.log.error).toHaveBeenCalledWith(expect.stringContaining('.github/workflows/datalogix.yml is missing'));
});

test('warns when the folder is another repository, ignoring the case of the names', async (t) => {
  const root = await packageFolder(t);
  await run(root, packageGitHub(), { folderRepository: 'Datalogix/Package' });
  expect(clack.log.warn).not.toHaveBeenCalledWith(expect.stringContaining('This folder is not'));
  await run(root, packageGitHub(), { folderRepository: 'datalogix/other' });
  expect(clack.log.warn).toHaveBeenCalledWith('This folder is not datalogix/package: its local files are checked');
});

test('exits with 1 when the repository cannot be seen, and stops on a read error', async (t) => {
  const root = await packageFolder(t);
  expect(await run(root, packageGitHub({ repo: async () => null }))).toBe(1);

  const denied = packageGitHub({
    rulesets: async () => {
      throw new Error('HTTP 403');
    },
  });
  await expect(run(root, denied)).rejects.toThrow('Cannot read the rulesets of datalogix/app: HTTP 403');
});

test('looks up the relay with the spelling GitHub gives the repository', async (t) => {
  onPlatform(t, 'linux');
  const root = await folder(
    t,
    {
      artisan: '',
      [WORKFLOW_PATH]: await renderProjectWorkflow({ deploy: 'none' }),
      '.github/CODEOWNERS': '/.github/ @ana\n',
    },
    'check-',
  );
  const github = fakeGitHub({
    repo: async () => ({ full_name: 'datalogix/App', default_branch: 'main' }),
    rulesets: async () => [],
    login: async () => 'ana',
    labels: async () => [],
    environment: async () => null,
    hasRepositorySecret: async () => true,
    hasOrganizationSecret: async () => false,
  });
  await run(root, github, { repository: 'datalogix/app' });
  expect(hasSecret).toHaveBeenCalledWith(RELAY, 'nightwatch', 'datalogix/App');
});

test('refuses to evaluate a state of a stack it does not know', async () => {
  await expect(evaluate({ ...APP_STATE, stack: 'nuxt' }, { relay: RELAY })).rejects.toThrow('Unknown stack: nuxt');
});
