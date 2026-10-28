import { beforeEach, expect, test, vi } from 'vitest';
import * as clack from '@clack/prompts';
import { protect } from '../commands/protect.js';
import { PACKAGE_CHECKS } from '../kinds/package/index.js';
import { renderPackageWorkflow } from '../kinds/package/workflow.js';
import { PROJECT_CHECKS } from '../kinds/project/index.js';
import { renderProjectWorkflow } from '../kinds/project/workflow.js';
import { keepsStaleApprovals, requiredChecks, requiresCodeOwners, rulesetBody } from '../lib/ruleset.js';
import { WORKFLOW_PATH } from '../lib/workflow-file.js';
import { fakeGitHub, folder } from './helpers.js';

// Quiet, and answers the questions as each test says: it reads what protect shows and returns
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  spinner: () => ({ start() {}, stop() {}, error() {}, message() {} }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), message: vi.fn() },
  confirm: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
}));

// Each test reads only what it made protect show
beforeEach(() => vi.clearAllMocks());

const ALL = Object.values(PROJECT_CHECKS);
const PACKAGE_CHECK = PACKAGE_CHECKS.tests;

/** The GitHub protect talks to: its rulesets, the checks of the latest pull request, the release App's secrets. */
const protectGitHub = ({ rulesets = [], latest = { number: 3, names: ALL }, releaseApp = false, ...methods } = {}) =>
  fakeGitHub({
    rulesets: async () => rulesets,
    ruleset: async (id) => rulesets.find((ruleset) => ruleset.id === id) ?? null,
    latestPullRequestChecks: async () => latest,
    hasRepositorySecret: async (name) => releaseApp && name.startsWith('RELEASE_APP_'),
    hasOrganizationSecret: async () => false,
    ...methods,
  });

/** An app folder whose workflow file setup wrote for the answers. */
const project = async (t, answers, edit = (content) => content) =>
  folder(t, { [WORKFLOW_PATH]: edit(await renderProjectWorkflow(answers)) }, 'protect-');

/** A package folder with the workflow file of examples/package.yml. */
const packageFolder = async (t, inputs = '') =>
  folder(t, { [WORKFLOW_PATH]: `${await renderPackageWorkflow('', 'main')}${inputs}` }, 'protect-');

const run = (
  root,
  github,
  { flags = { yes: true }, repository = 'datalogix/app', folderRepository = repository } = {},
) => protect({ root, repository, folderRepository, flags, createGitHub: () => github });

/** The body of the only ruleset protect wrote. */
const written = (github) => {
  expect(github.calls).toHaveLength(1);
  return github.calls[0].at(-1);
};

test('creates the ruleset with every check and code owner approval for a team', async (t) => {
  const github = protectGitHub();
  expect(await run(await project(t, { deploy: 'none', solo: false, incidents: true }), github)).toBe(0);
  expect(github.calls[0][0]).toBe('create ruleset');
  const body = written(github);
  expect(requiredChecks(body)).toStrictEqual(ALL);
  expect(requiresCodeOwners(body)).toBe(true);
  expect(keepsStaleApprovals(body)).toBe(false);
});

test('updates the existing ruleset without code owners for a solo maintainer', async (t) => {
  const github = protectGitHub({ rulesets: [{ id: 9, name: 'datalogix' }] });
  expect(await run(await project(t, { deploy: 'none', solo: true, incidents: true }), github)).toBe(0);
  expect(github.calls[0].slice(0, 2)).toStrictEqual(['ruleset', 9]);
  expect(requiresCodeOwners(written(github))).toBe(false);
});

test('keeps what was added to the existing ruleset by hand', async (t) => {
  const handEdited = rulesetBody([...ALL, 'deploy-preview'], { codeOwners: true });
  handEdited.rules.push({ type: 'required_signatures' });
  handEdited.rules.find((rule) => rule.type === 'pull_request').parameters.allowed_merge_methods = ['squash'];
  handEdited.bypass_actors.push({ actor_id: 1, actor_type: 'Team', bypass_mode: 'always' });
  handEdited.conditions.ref_name.include.push('refs/heads/release/*');
  const github = protectGitHub({ rulesets: [{ id: 9, ...handEdited }] });

  // Tests off: its pipeline check is dropped, the check added by hand stays
  const root = await project(t, { deploy: 'none', solo: true, incidents: true }, (content) =>
    content.replace('      count-author: true', '      count-author: true\n      tests: false'),
  );
  expect(await run(root, github)).toBe(0);
  const body = written(github);
  expect(requiredChecks(body)).toStrictEqual([
    ...ALL.filter((check) => check !== PROJECT_CHECKS.tests),
    'deploy-preview',
  ]);
  expect(requiresCodeOwners(body)).toBe(false);
  expect(body.rules.map((rule) => rule.type)).toContain('required_signatures');
  expect(body.rules.find((rule) => rule.type === 'pull_request').parameters.allowed_merge_methods).toStrictEqual([
    'squash',
  ]);
  expect(body.bypass_actors).toHaveLength(2);
  expect(body.conditions.ref_name.include).toStrictEqual(['~DEFAULT_BRANCH', 'refs/heads/release/*']);
});

test('keeps approvals required or stale approvals dismissed by hand', async (t) => {
  const handEdited = rulesetBody(ALL);
  Object.assign(handEdited.rules.find((rule) => rule.type === 'pull_request').parameters, {
    required_approving_review_count: 1,
    dismiss_stale_reviews_on_push: true,
  });
  const github = protectGitHub({ rulesets: [{ id: 9, ...handEdited }] });
  expect(await run(await project(t, { deploy: 'none', solo: true, incidents: true }), github)).toBe(0);
  const { parameters } = written(github).rules.find((rule) => rule.type === 'pull_request');
  expect(parameters.required_approving_review_count).toBe(1);
  expect(parameters.dismiss_stale_reviews_on_push).toBe(true);
});

test('requires every check and code owner approval without a workflow file', async (t) => {
  const github = protectGitHub();
  expect(await run(await folder(t, {}, 'protect-'), github)).toBe(0);
  const body = written(github);
  expect(requiredChecks(body)).toStrictEqual(ALL);
  expect(requiresCodeOwners(body)).toBe(true);
});

test('protects anyway with --yes when no pull request ran the checks yet', async (t) => {
  const github = protectGitHub({ latest: null });
  expect(await run(await project(t, { deploy: 'none', solo: true, incidents: true }), github)).toBe(0);
  expect(requiredChecks(written(github))).toStrictEqual(ALL);
  // It still says why the checks may never come
  expect(clack.log.warn).toHaveBeenCalledWith(expect.stringContaining('No pull request has run the checks yet:'));
});

test('protects a package folder without a workflow file with the package check', async (t) => {
  // The folder tells the kind: a composer.json of a Laravel package
  const root = await folder(
    t,
    { 'composer.json': JSON.stringify({ require: { 'illuminate/support': '^12.0' } }) },
    'protect-',
  );
  const github = protectGitHub({ latest: { number: 3, names: [PACKAGE_CHECK] } });
  expect(await run(root, github, { flags: { yes: true, solo: true } })).toBe(0);
  expect(requiredChecks(written(github))).toStrictEqual([PACKAGE_CHECK]);
});

test('asks before protecting when the latest pull request did not run the checks, and stops on no', async (t) => {
  const root = await project(t, { deploy: 'none', solo: true, incidents: true });
  clack.confirm.mockResolvedValueOnce(false);
  const declined = protectGitHub({ latest: { number: 4, names: ['pipeline / tests / tests'] } });
  expect(await run(root, declined, { flags: {} })).toBe(1);
  expect(declined.calls).toStrictEqual([]);
  expect(clack.log.warn).toHaveBeenCalledWith(expect.stringContaining('Pull request #4 did not run:'));

  clack.confirm.mockResolvedValueOnce(true);
  const accepted = protectGitHub({ latest: { number: 4, names: ['pipeline / tests / tests'] } });
  expect(await run(root, accepted, { flags: {} })).toBe(0);
  expect(requiredChecks(written(accepted))).toStrictEqual(ALL);
});

test('stops when it cannot read the latest pull request', async (t) => {
  const github = protectGitHub({
    latestPullRequestChecks: async () => {
      throw new Error('HTTP 502');
    },
  });
  await expect(run(await project(t, { deploy: 'none', solo: true, incidents: true }), github)).rejects.toThrow(
    'HTTP 502',
  );
  expect(github.calls).toStrictEqual([]);
});

test('does not require the checks of layers turned off', async (t) => {
  const github = protectGitHub({ latest: { number: 4, names: ['pipeline / tests / tests'] } });
  const root = await project(t, { deploy: 'none', solo: true, incidents: true }, (content) =>
    content.replace('    with:\n', '    with:\n      security-review: false\n      risk-gate: false\n'),
  );
  expect(await run(root, github)).toBe(0);
  expect(requiredChecks(written(github))).toStrictEqual(['pipeline / tests / tests']);
});

test('leaves out the status checks rule when every layer with a check is off', async (t) => {
  const github = protectGitHub({ latest: null });
  const root = await project(t, { deploy: 'none', solo: true, incidents: true }, (content) =>
    content.replace(
      '    with:\n',
      '    with:\n      tests: false\n      security-review: false\n      risk-gate: false\n',
    ),
  );
  expect(await run(root, github)).toBe(0);
  expect(written(github).rules).not.toContainEqual(expect.objectContaining({ type: 'required_status_checks' }));
});

const production = { deploy: 'forge', staging: true, productionBranch: 'main', solo: true, incidents: true };

test('protects the production branch with the default branch', async (t) => {
  const github = protectGitHub({ releaseApp: true });
  expect(await run(await project(t, production), github)).toBe(0);
  expect(written(github).conditions.ref_name.include).toStrictEqual(['~DEFAULT_BRANCH', 'refs/heads/main']);
});

test('leaves the production branch out without the release GitHub App', async (t) => {
  const github = protectGitHub();
  expect(await run(await project(t, production), github)).toBe(0);
  expect(written(github).conditions.ref_name.include).toStrictEqual(['~DEFAULT_BRANCH']);
  expect(clack.log.warn).toHaveBeenCalledWith(
    expect.stringMatching(/^main is left unprotected: without the release GitHub App/),
  );
});

test('takes the production branch out of the ruleset when the release GitHub App is gone', async (t) => {
  const protectedBefore = rulesetBody(ALL, { codeOwners: false, productionBranch: 'main' });
  protectedBefore.conditions.ref_name.include.push('refs/heads/release/*');
  const github = protectGitHub({ rulesets: [{ id: 9, ...protectedBefore }] });
  expect(await run(await project(t, production), github)).toBe(0);
  expect(github.calls[0].at(-1).conditions.ref_name.include).toStrictEqual(['~DEFAULT_BRANCH', 'refs/heads/release/*']);
});

test('keeps other branches in the ruleset with a warning, as it cannot tell a renamed production branch', async (t) => {
  const before = rulesetBody(ALL, { codeOwners: false, productionBranch: 'release' });
  before.conditions.ref_name.include.push('refs/heads/release/*');
  const github = protectGitHub({ rulesets: [{ id: 9, ...before }], releaseApp: true });
  expect(await run(await project(t, production), github)).toBe(0);
  expect(github.calls.at(-1).at(-1).conditions.ref_name.include).toStrictEqual([
    '~DEFAULT_BRANCH',
    'refs/heads/main',
    'refs/heads/release',
    'refs/heads/release/*',
  ]);
  expect(clack.log.warn).toHaveBeenCalledWith(
    expect.stringMatching(/^The "datalogix" ruleset also protects release, kept as added by hand\./),
  );
});

test('keeps branches added by hand when the production branch leaves the ruleset', async (t) => {
  const before = rulesetBody(ALL, { codeOwners: false, productionBranch: 'main' });
  before.conditions.ref_name.include.push('refs/heads/develop');
  const github = protectGitHub({ rulesets: [{ id: 9, ...before }] });
  expect(await run(await project(t, production), github)).toBe(0);
  expect(github.calls[0].at(-1).conditions.ref_name.include).toStrictEqual(['~DEFAULT_BRANCH', 'refs/heads/develop']);
});

test('stops when it cannot read the secrets of the release GitHub App', async (t) => {
  const github = protectGitHub({
    hasRepositorySecret: async () => {
      throw new Error('HTTP 403');
    },
  });
  await expect(run(await project(t, production), github)).rejects.toThrow(
    'Cannot read the secrets of datalogix/app: HTTP 403',
  );
  expect(github.calls).toStrictEqual([]);
});

test('leaves out a production branch the project does not deploy, like check', async (t) => {
  const github = protectGitHub({ releaseApp: true });
  const root = await project(t, { deploy: 'none', solo: true, incidents: true }, (content) =>
    content.replace(/^ {4}with:\n/m, '$&      production-branch: main\n'),
  );
  expect(await run(root, github)).toBe(0);
  expect(written(github).conditions.ref_name.include).toStrictEqual(['~DEFAULT_BRANCH']);
});

test('changes nothing on a plan without rulesets', async (t) => {
  const github = protectGitHub({ rulesets: null });
  expect(await run(await project(t, { deploy: 'none', solo: true, incidents: true }), github)).toBe(1);
  expect(github.calls).toStrictEqual([]);
});

test('asks before protecting another repository than the folder', async (t) => {
  const root = await project(t, { deploy: 'none', solo: true, incidents: true });
  clack.confirm.mockResolvedValueOnce(false);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  t.onTestFinished(() => exit.mockRestore());
  const github = protectGitHub();
  await expect(run(root, github, { flags: {}, folderRepository: 'datalogix/other' })).rejects.toThrow('exit');
  expect(exit).toHaveBeenCalledWith(1);
  expect(github.calls).toStrictEqual([]);
});

test('requires the package check, with code owner approval unless --solo', async (t) => {
  const latest = { number: 1, names: [PACKAGE_CHECK] };
  const root = await packageFolder(t);
  const options = (flags) => ({ flags, repository: 'datalogix/package' });

  const team = protectGitHub({ latest });
  expect(await run(root, team, options({ yes: true }))).toBe(0);
  // Without --solo and without a question (--yes), code owners must approve
  expect(requiredChecks(written(team))).toStrictEqual([PACKAGE_CHECK]);
  expect(requiresCodeOwners(written(team))).toBe(true);

  const solo = protectGitHub({ latest });
  expect(await run(root, solo, options({ yes: true, solo: true }))).toBe(0);
  expect(requiresCodeOwners(written(solo))).toBe(false);
});

test('asks whether one person maintains a package without --solo or --yes', async (t) => {
  const root = await packageFolder(t);
  const latest = { number: 1, names: [PACKAGE_CHECK] };
  clack.confirm.mockResolvedValueOnce(true);
  const github = protectGitHub({ latest });
  expect(await run(root, github, { flags: {}, repository: 'datalogix/package' })).toBe(0);
  expect(clack.confirm).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'Do you work alone on this package?' }),
  );
  expect(requiresCodeOwners(written(github))).toBe(false);
});

test('does not require the package check when its tests are off', async (t) => {
  const github = protectGitHub({ latest: { number: 1, names: [] } });
  const root = await packageFolder(t, '    with:\n      tests: false\n');
  expect(await run(root, github, { flags: { yes: true, solo: true }, repository: 'datalogix/package' })).toBe(0);
  expect(requiredChecks(written(github))).toStrictEqual([]);
});
