import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { vercelProjects, vercelStagingTask } from '../providers/deploy/vercel.js';
import jsApp from '../stacks/js/app.js';
import { APP_STATE, fakeGitHub, folder, RELAY as relay, runResults } from './helpers.js';

// Quiet progress bars: the tests read the results, not the terminal
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal()),
  progress: () => ({ start() {}, message() {}, advance() {}, stop() {} }),
}));

/** A fake API: answers each GET or POST path with the first rule whose pattern matches, and records the calls. */
function fakeApi(rules) {
  const calls = [];
  const answer = (method) => async (path, body) => {
    calls.push([method, path, ...(body ? [body] : [])]);
    const rule = rules.find(([pattern]) => new RegExp(pattern).test(`${method} ${path}`));
    if (!rule) throw new Error(`No answer for ${method} ${path}`);
    return typeof rule[1] === 'function' ? rule[1](path, body) : rule[1];
  };
  return { calls, get: answer('GET'), post: answer('POST') };
}

const project = (id, org, repo, extra = {}) => ({
  id,
  name: id,
  accountId: 'user_1',
  link: { type: 'github', org, repo, productionBranch: 'main' },
  ...extra,
});

test('finds the projects linked to the repository in the account and its teams', async () => {
  const api = fakeApi([
    ['GET /v2/teams', { teams: [{ id: 'team_1', slug: 'datalogix' }] }],
    [
      'teamId=team_1',
      { projects: [project('prj_team', 'datalogix', 'app'), project('prj_other', 'datalogix', 'site')] },
    ],
    ['GET /v10/projects', [project('prj_mine', 'Datalogix', 'App')]],
  ]);
  expect(await vercelProjects(api, 'datalogix/app')).toStrictEqual([
    { id: 'prj_mine', name: 'prj_mine', teamId: null, team: null, branch: 'main' },
    { id: 'prj_team', name: 'prj_team', teamId: 'team_1', team: 'datalogix', branch: 'main' },
  ]);
  expect(api.calls[1][1]).toContain(`repoUrl=${encodeURIComponent('https://github.com/datalogix/app')}`);
});

test('creates the staging custom environment when the project has none', async () => {
  const created = fakeApi([
    ['GET .*/custom-environments', { environments: [] }],
    ['POST .*/custom-environments', {}],
  ]);
  const task = vercelStagingTask(created, { id: 'prj_1', name: 'app', teamId: 'team_1' });
  expect(await task.run()).toStrictEqual({ detail: 'created, without a domain', data: { domain: false } });
  expect(created.calls[1]).toStrictEqual([
    'POST',
    '/v9/projects/prj_1/custom-environments?teamId=team_1',
    { slug: 'staging', description: 'Deployed by the Datalogix workflows' },
  ]);

  const ready = fakeApi([['GET', { environments: [{ slug: 'staging', domains: [{ name: 'dev.example.com' }] }] }]]);
  expect((await vercelStagingTask(ready, { id: 'prj_1', name: 'app' }).run()).detail).toBe('unchanged');
});

const answers = {
  repository: 'datalogix/app',
  deploy: 'vercel',
  staging: true,
  domain: 'example.com',
  stagingDomain: 'dev.example.com',
  healthPath: '/api/health',
  deployToken: ' vercel-token ',
  vercelProject: { id: 'prj_1', name: 'app', teamId: 'team_1' },
  vercelBypass: 'bypass-secret',
  monitoring: 'none',
  incidents: false,
  codeOwners: '@ana',
};

test('stores the token, the project and the bypass in each environment, with no deploy hook', async (t) => {
  const root = await folder(t, {}, 'vercel-');
  const github = fakeGitHub();
  const state = { ...APP_STATE, framework: 'next', healthFile: 'app/api/health/route.ts', vercelJson: null };
  const tasks = jsApp.setup
    .tasks(answers, { github, root, state, relay })
    .filter((task) => task.title.startsWith('Environment'));
  await runResults(tasks);
  for (const environment of ['production', 'staging']) {
    expect(github.calls).toContainEqual(['secret', 'VERCEL_TOKEN', 'vercel-token', environment]);
    expect(github.calls).toContainEqual(['secret', 'VERCEL_AUTOMATION_BYPASS_SECRET', 'bypass-secret', environment]);
    expect(github.calls).toContainEqual(['variable', 'VERCEL_PROJECT', 'prj_1', environment]);
    expect(github.calls).toContainEqual(['variable', 'VERCEL_TEAM_ID', 'team_1', environment]);
  }
  expect(github.calls.map((call) => call[1])).not.toContain('DEPLOY_HOOK');
  // No deploy hook question either
  const hook = jsApp.setup.steps().find((step) => step.id === 'productionHook');
  expect(hook.when(answers, { state })).toBe(false);
});

test('turns off Vercel deploys of the deployed branches in vercel.json, keeping the rest', async (t) => {
  const existing = { framework: 'nextjs', git: { deploymentEnabled: { 'experiment-*': false } } };
  const root = await folder(t, { 'vercel.json': JSON.stringify(existing) }, 'vercel-');
  const state = { ...APP_STATE, defaultBranch: 'develop', vercelJson: JSON.stringify(existing), healthFile: null };
  const twoBranches = { ...answers, branches: true, developmentBranch: 'develop', productionBranch: 'main' };
  const task = jsApp.setup
    .tasks(twoBranches, { github: fakeGitHub(), root, state, relay })
    .find((candidate) => candidate.id === 'file:vercel.json');
  expect(await task.run()).toBe('updated: no automatic deploys of develop, main');
  expect(JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'))).toStrictEqual({
    framework: 'nextjs',
    git: { deploymentEnabled: { 'experiment-*': false, develop: false, main: false } },
  });

  // Already off, or off for everything: nothing to change
  const again = { ...state, vercelJson: await readFile(join(root, 'vercel.json'), 'utf8') };
  const rerun = jsApp.setup.tasks(twoBranches, { github: fakeGitHub(), root, state: again, relay });
  expect(await rerun.find((candidate) => candidate.id === 'file:vercel.json').run()).toBe('unchanged');
  const off = { ...state, vercelJson: '{"git": {"deploymentEnabled": false}}' };
  const none = jsApp.setup.tasks(twoBranches, { github: fakeGitHub(), root, state: off, relay });
  expect(await none.find((candidate) => candidate.id === 'file:vercel.json').run()).toBe('unchanged');
});

test('creates the health route of the framework and router', async (t) => {
  const route = async (files, manifest) => {
    const root = await folder(t, { 'package.json': JSON.stringify(manifest), ...files }, 'vercel-');
    const state = await jsApp.inspect(root);
    const task = jsApp.setup
      .tasks(
        { ...answers, healthRoute: true },
        { github: fakeGitHub(), root, state: { ...APP_STATE, ...state }, relay },
      )
      .find((candidate) => candidate.title === 'Health route /api/health');
    await task.run();
    return [state.healthFile, await readFile(join(root, state.healthFile), 'utf8')];
  };
  const next = { dependencies: { next: '^16' } };
  const [appRouter, appContent] = await route({ 'tsconfig.json': '{}', 'src/app/page.tsx': '' }, next);
  expect(appRouter).toBe('src/app/api/health/route.ts');
  expect(appContent).toContain('export function GET()');
  expect((await route({ 'pages/index.js': '' }, next))[0]).toBe('pages/api/health.js');
  const [nuxt, nuxtContent] = await route({ 'tsconfig.json': '{}' }, { devDependencies: { nuxt: '^4' } });
  expect(nuxt).toBe('server/api/health.get.ts');
  expect(nuxtContent).toContain('defineEventHandler');
});

test('does not offer the health route when the app has one, in either language', async (t) => {
  const root = await folder(
    t,
    { 'package.json': '{"dependencies": {"next": "^16"}}', 'tsconfig.json': '{}' },
    'vercel-',
  );
  await mkdir(join(root, 'app/api/health'), { recursive: true });
  await writeFile(join(root, 'app/api/health/route.js'), '');
  const state = await jsApp.inspect(root);
  expect(state).toMatchObject({ healthFile: 'app/api/health/route.ts', healthRoute: true });
  const step = jsApp.setup.steps().find((candidate) => candidate.id === 'healthRoute');
  expect(step.when({ deploy: 'vercel', healthPath: '/api/health' }, { state })).toBe(false);
});

test('lists what Vercel still needs by hand', () => {
  const steps = jsApp.setup.nextSteps(
    { ...answers, deployToken: '', vercelProject: null, vercelBypass: '' },
    { relay, results: [{ id: 'vercelStaging', ok: true, data: { domain: false } }], state: APP_STATE },
  );
  expect(steps).toContainEqual(expect.stringContaining('VERCEL_TOKEN'));
  expect(steps).toContainEqual(expect.stringContaining('VERCEL_AUTOMATION_BYPASS_SECRET'));
  expect(steps).toContainEqual(expect.stringContaining('needs the domain'));
});
