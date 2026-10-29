import { expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectState } from '../lib/state.js';
import { labelDescription, LABELS } from '../kinds/project/state.js';
import { renderProjectWorkflow } from '../kinds/project/workflow.js';
import { WORKFLOW_PATH } from '../lib/workflow-file.js';
import laravelApp from '../stacks/laravel/app.js';
import { fakeGitHub, folder, tempRoot } from './helpers.js';

const app = { stack: 'laravel', kind: 'project', module: laravelApp };

/** The GitHub collectState reads for an app; the helper's fake fails on anything else, and records no change. */
function stateGitHub(overrides = {}) {
  return fakeGitHub({
    repo: async () => ({ name: 'app' }),
    labels: async () => [{ name: 'claude', description: 'Claude implementa e abre um pull request' }],
    environment: async () => null,
    hasEnvironmentSecret: async () => false,
    environmentVariable: async () => null,
    hasRepositorySecret: async () => false,
    hasOrganizationSecret: async () => false,
    claudeApp: async () => 'all',
    rulesets: async () => [],
    ruleset: async () => null,
    login: async () => 'ana',
    workflowPermissions: async () => ({
      default_workflow_permissions: 'read',
      can_approve_pull_request_reviews: false,
    }),
    branch: async () => null,
    ...overrides,
  });
}

test('reads the state of the project', async (t) => {
  const root = await tempRoot(t, 'state-');
  const state = await collectState(stateGitHub(), root, { detected: app });
  expect(state.labels).toStrictEqual(['claude']);
  expect(state.labelDescriptions).toStrictEqual({ claude: 'Claude implementa e abre um pull request' });
  expect(state.ruleset).toBe(null);
  expect(state.login).toBe('ana');
  expect(state.workflow).toBe(null);
  expect(state.current).toBe(null);
  expect(state.defaultBranch).toBe('main');
  expect(
    (await collectState(stateGitHub({ repo: async () => ({ default_branch: 'master' }) }), root, { detected: app }))
      .defaultBranch,
  ).toBe('master');
});

test('returns null when the repository is not reachable', async (t) => {
  const root = await tempRoot(t, 'state-');
  expect(await collectState(stateGitHub({ repo: async () => null }), root, { detected: app })).toBe(null);
});

test('reads the datalogix ruleset by id and the environments that exist', async (t) => {
  const root = await tempRoot(t, 'state-');
  const state = await collectState(
    stateGitHub({
      rulesets: async () => [
        { id: 1, name: 'other' },
        { id: 7, name: 'datalogix' },
      ],
      ruleset: async (id) => ({ id }),
      environment: async (name) => (name === 'production' ? {} : null),
      hasEnvironmentSecret: async (_environment, secret) => secret === 'DEPLOY_HOOK',
      environmentVariable: async () => 'https://app.example.com/up',
    }),
    root,
    { detected: app },
  );
  expect(state.ruleset).toStrictEqual({ id: 7 });
  expect(state.environments.production).toStrictEqual({
    exists: true,
    deployHook: true,
    healthUrl: 'https://app.example.com/up',
    monitoringToken: false,
  });
  // The literal shape: the code reads monitoringToken, so the empty environment must have it too
  expect(state.environments.staging).toStrictEqual({
    exists: false,
    deployHook: false,
    healthUrl: null,
    monitoringToken: false,
  });
});

test('reads the workflow file and the code owners of the folder', async (t) => {
  const root = await tempRoot(t, 'state-');
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(
    join(root, WORKFLOW_PATH),
    await renderProjectWorkflow({ deploy: 'cloud', staging: false, solo: true }),
  );
  await writeFile(join(root, '.github/CODEOWNERS'), '/.github/ @ana @datalogix/devs\n');

  const state = await collectState(stateGitHub(), root, { detected: app });
  expect(state.current.deploy).toBe('cloud');
  expect(state.current.staging).toBe(false);
  expect(state.current.solo).toBe(true);
  expect(state.codeOwners).toStrictEqual(['@ana', '@datalogix/devs']);
  expect(state.codeOwnersFile).toBe('/.github/ @ana @datalogix/devs\n');
});

test('stops when a read fails instead of reporting it as missing', async (t) => {
  const root = await tempRoot(t, 'state-');
  const denied = async () => {
    throw new Error('gh api repos/datalogix/app/rulesets: HTTP 403\nmore');
  };

  await expect(collectState(stateGitHub({ rulesets: denied }), root, { detected: app })).rejects.toThrow(
    /^Cannot read the rulesets of datalogix\/app: gh api repos\/datalogix\/app\/rulesets: HTTP 403$/,
  );
  await expect(collectState(stateGitHub({ labels: denied }), root, { detected: app })).rejects.toThrow(
    /Cannot read the labels/,
  );
});

test('treats optional reads it cannot do as not set', async (t) => {
  const root = await tempRoot(t, 'state-');
  const fail = async () => {
    throw new Error('HTTP 403');
  };
  const state = await collectState(stateGitHub({ hasOrganizationSecret: fail, login: fail }), root, { detected: app });
  expect(state.claudeToken.organization).toBe(false);
  expect(state.login).toBe(null);
});

test('reads what a production branch needs, on a plan without rulesets', async (t) => {
  const root = await tempRoot(t, 'state-');
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(
    join(root, WORKFLOW_PATH),
    await renderProjectWorkflow(
      { deploy: 'forge', staging: true, productionBranch: 'main', solo: true },
      '',
      'develop',
    ),
  );

  const state = await collectState(
    stateGitHub({
      branch: async (name) => (name === 'main' ? { commit: { sha: 'a' } } : null),
      // One secret in the repository, the other one shared by the organization
      hasRepositorySecret: async (name) => name === 'RELEASE_APP_CLIENT_ID',
      hasOrganizationSecret: async (name) => name === 'RELEASE_APP_PRIVATE_KEY',
      rulesets: async () => null,
    }),
    root,
    { detected: app },
  );
  expect(state.productionBranchStatus).toStrictEqual({ name: 'main', exists: true, sha: 'a' });
  expect(state.releaseApp).toBe(true);
  expect(state.actionsPullRequests).toStrictEqual({ allowed: false, defaultPermissions: 'read' });
  expect(state.canProtect).toBe(false);
  expect(state.ruleset).toBe(null);

  const plain = await collectState(
    stateGitHub({ workflowPermissions: async () => Promise.reject(new Error('403')) }),
    root,
    { detected: app, options: { release: true } },
  );
  expect(plain.releaseApp).toBe(false);
  expect(plain.actionsPullRequests).toBe(null);
  expect(plain.canProtect).toBe(true);
});

test('reads the release GitHub App only for a production branch, or when setup asks', async (t) => {
  const root = await tempRoot(t, 'state-');
  const unread = async () => expect.unreachable('release reads');
  const state = await collectState(
    stateGitHub({
      workflowPermissions: unread,
      hasRepositorySecret: async (name) => (name.startsWith('RELEASE_APP_') ? unread() : false),
    }),
    root,
    { detected: app },
  );
  expect(state.releaseApp).toBe(false);
  expect(state.actionsPullRequests).toBe(null);
  expect(
    (await collectState(stateGitHub(), root, { detected: app, options: { release: true } })).actionsPullRequests,
  ).toStrictEqual({
    allowed: false,
    defaultPermissions: 'read',
  });
});

test('describes the labels in English only for languages that start with en', () => {
  const [label] = LABELS;
  for (const language of ['en', 'en-US', 'EN', ' en']) {
    expect(labelDescription(label, language)).toBe(label.description.en);
  }
  for (const language of ['pt-BR', 'es', '', undefined]) {
    expect(labelDescription(label, language)).toBe(label.description.pt);
  }
});

test('takes the workflow file detection read, and the stack and kind it found', async (t) => {
  // Another content on disk: collectState does not read it again
  const root = await folder(t, { [WORKFLOW_PATH]: 'on disk\n' }, 'state-');
  const workflow = await renderProjectWorkflow({ deploy: 'cloud' });
  const state = await collectState(stateGitHub(), root, { detected: { ...app, workflow } });
  expect(state.workflow).toBe(workflow);
  expect(state.current.deploy).toBe('cloud');
  expect([state.stack, state.kind]).toStrictEqual(['laravel', 'project']);
});

test('reads only the stack of a workflow file without a detected kind', async (t) => {
  const root = await folder(t, { [WORKFLOW_PATH]: 'jobs:\n  pipeline:\n    with:\n      stack: laravel\n' }, 'state-');
  const state = await collectState(stateGitHub(), root);
  expect(state.current).toStrictEqual({ stack: 'laravel' });
  expect([state.stack, state.kind]).toStrictEqual([null, null]);
});

test('stops when it cannot read the datalogix ruleset', async (t) => {
  const root = await tempRoot(t, 'state-');
  const github = stateGitHub({
    rulesets: async () => [{ id: 7, name: 'datalogix' }],
    ruleset: async () => {
      throw new Error('HTTP 500');
    },
  });
  await expect(collectState(github, root, { detected: app })).rejects.toThrow(
    'Cannot read the ruleset of datalogix/app: HTTP 500',
  );
});

test('only reads, never changes anything on GitHub', async (t) => {
  const github = stateGitHub();
  await collectState(github, await tempRoot(t, 'state-'), { detected: app });
  expect(github.calls).toStrictEqual([]);
});
