import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { netlifyLockTask, netlifySites } from '../providers/deploy/netlify.js';
import jsApp from '../stacks/js/app.js';
import { APP_STATE, askedSteps, fakeGitHub, folder, RELAY as relay, runResults } from './helpers.js';

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

const site = (id, repoPath, extra = {}) => ({
  id,
  name: id,
  ssl_url: `https://${id}.netlify.app`,
  build_settings: { repo_path: repoPath, repo_url: `https://github.com/${repoPath}`, repo_branch: 'main' },
  ...extra,
});

test('finds the sites linked to the repository, across pages', async () => {
  const first = [site('app', 'Datalogix/App'), ...Array.from({ length: 99 }, (_, i) => site(`other-${i}`, 'x/y'))];
  const api = fakeApi([
    ['page=1$', first],
    ['page=2$', [site('app-staging', 'datalogix/app'), site('docs', 'datalogix/docs')]],
  ]);
  expect(await netlifySites(api, 'datalogix/app')).toStrictEqual([
    { id: 'app', name: 'app', url: 'https://app.netlify.app', branch: 'main' },
    { id: 'app-staging', name: 'app-staging', url: 'https://app-staging.netlify.app', branch: 'main' },
  ]);
  expect(api.calls.map((call) => call[1])).toStrictEqual([
    '/sites?filter=all&per_page=100&page=1',
    '/sites?filter=all&per_page=100&page=2',
  ]);
});

test('locks auto publishing on the published deploy, once', async () => {
  const unlocked = fakeApi([
    ['GET /sites/site_1', { published_deploy: { id: 'dep_1', locked: false } }],
    ['POST /deploys/dep_1/lock', {}],
  ]);
  expect(await netlifyLockTask(unlocked, { id: 'site_1', name: 'app' }, 'production').run()).toBe('locked');
  expect(unlocked.calls[1]).toStrictEqual(['POST', '/deploys/dep_1/lock']);

  const locked = fakeApi([['GET', { published_deploy: { id: 'dep_1', locked: true } }]]);
  expect(await netlifyLockTask(locked, { id: 'site_1', name: 'app' }, 'production').run()).toBe('unchanged');
  const empty = fakeApi([['GET', { published_deploy: null }]]);
  expect(await netlifyLockTask(empty, { id: 'site_1', name: 'app' }, 'staging').run()).toMatch(/first deploy/);
});

const answers = {
  repository: 'datalogix/app',
  deploy: 'netlify',
  staging: true,
  domain: 'example.com',
  stagingDomain: 'dev.example.com',
  healthPath: '/api/health',
  deployToken: ' netlify-token ',
  netlifySite: { id: 'site_prod', name: 'app', branch: 'main' },
  netlifyStagingSite: { id: 'site_staging', name: 'app-staging', branch: 'main' },
  monitoring: 'none',
  incidents: false,
  codeOwners: '@ana',
};

test('stores the token and the site of each environment, with no deploy hook', async (t) => {
  const root = await folder(t, {}, 'netlify-');
  const github = fakeGitHub();
  const state = { ...APP_STATE, framework: 'next', healthFile: 'app/api/health/route.ts' };
  const tasks = jsApp.setup
    .tasks(answers, { github, root, state, relay })
    .filter((task) => task.title.startsWith('Environment'));
  await runResults(tasks);
  expect(github.calls).toContainEqual(['secret', 'NETLIFY_TOKEN', 'netlify-token', 'production']);
  expect(github.calls).toContainEqual(['secret', 'NETLIFY_TOKEN', 'netlify-token', 'staging']);
  expect(github.calls).toContainEqual(['variable', 'NETLIFY_SITE_ID', 'site_prod', 'production']);
  expect(github.calls).toContainEqual(['variable', 'NETLIFY_SITE_ID', 'site_staging', 'staging']);
  expect(github.calls.map((call) => call[1])).not.toContain('DEPLOY_HOOK');
  expect(github.calls.map((call) => call[1])).not.toContain('VERCEL_TOKEN');
});

test('asks the token and a site per environment, not the deploy hooks nor the Vercel questions', () => {
  const ids = askedSteps(jsApp.setup.steps(), answers, { netlifySites: [{ id: 'site_prod' }] });
  expect(ids).toEqual(expect.arrayContaining(['deployToken', 'netlifySite', 'netlifyStagingSite']));
  for (const id of ['productionHook', 'stagingHook', 'vercelProject', 'vercelBypass']) expect(ids).not.toContain(id);
  const production = askedSteps(jsApp.setup.steps(), { ...answers, staging: false }, { netlifySites: [{ id: 'a' }] });
  expect(production).not.toContain('netlifyStagingSite');
});

test('locks the sites with a token, and writes no vercel.json', async (t) => {
  const root = await folder(t, {}, 'netlify-');
  const state = { ...APP_STATE, framework: 'next', healthFile: null };
  const ids = jsApp.setup.tasks(answers, { github: fakeGitHub(), root, state, relay }).map((task) => task.id);
  expect(ids).toEqual(expect.arrayContaining(['netlifyLock:production', 'netlifyLock:staging']));
  expect(ids).not.toContain('file:vercel.json');
  const withoutToken = jsApp.setup.tasks({ ...answers, deployToken: '' }, { github: fakeGitHub(), root, state, relay });
  expect(withoutToken.map((task) => task.id)).not.toContain('netlifyLock:production');
});

test("redirects a single-page app's paths to index.html in netlify.toml, unless it redirects them already", async (t) => {
  const run = async (files, extra = {}) => {
    const root = await folder(t, files, 'netlify-');
    const netlifyToml = files['netlify.toml'] ?? null;
    const state = { ...APP_STATE, framework: 'vue', spaRouter: true, netlifyToml, healthFile: null, ...extra };
    const task = jsApp.setup
      .tasks(answers, { github: fakeGitHub(), root, state, relay })
      .find((candidate) => candidate.id === 'file:netlify.toml');
    if (!task) return [null, null];
    return [await task.run(), await readFile(join(root, 'netlify.toml'), 'utf8').catch(() => null)];
  };

  const [created, written] = await run({});
  expect(created).toBe('created: every path redirected to index.html');
  expect(written).toBe('[[redirects]]\n  from = "/*"\n  to = "/index.html"\n  status = 200\n');

  const [updated, kept] = await run({ 'netlify.toml': '[build]\n  command = "npm run build"\n' });
  expect(updated).toBe('updated: every path redirected to index.html');
  expect(kept).toMatch(/^\[build\]\n {2}command = "npm run build"\n\n\[\[redirects\]\]/);

  const own = '[[redirects]]\n  from = "/app/*"\n  to = "/app.html"\n  status = 200\n';
  expect(await run({ 'netlify.toml': own })).toStrictEqual(['unchanged', own]);
  expect((await run({}, { netlifyRedirects: true }))[0]).toBe('unchanged');
  // An app without a router gets none
  expect(await run({}, { spaRouter: false })).toStrictEqual([null, null]);
});

test('reads the Nitro preset of a Nuxt app', async (t) => {
  const root = await folder(
    t,
    {
      'package.json': JSON.stringify({ dependencies: { nuxt: 'latest' } }),
      'nuxt.config.ts': "export default defineNuxtConfig({ nitro: { preset: 'node-server' } });\n",
    },
    'netlify-',
  );
  expect(await jsApp.inspect(root)).toMatchObject({ framework: 'nuxt', nitroPreset: 'node-server' });
});

test('lists what Netlify still needs by hand, and a site that builds another branch', () => {
  const left = jsApp.setup.nextSteps(
    { ...answers, deployToken: '', netlifySite: null, netlifyStagingSite: null },
    { relay, results: [], state: APP_STATE },
  );
  expect(left).toContainEqual(expect.stringContaining('NETLIFY_SITE_ID'));
  expect(left).toContainEqual(expect.stringContaining('Lock to stop auto publishing'));

  const done = jsApp.setup.nextSteps(answers, { relay, results: [], state: { ...APP_STATE, defaultBranch: 'main' } });
  expect(done.join('\n')).not.toMatch(/NETLIFY_|Lock to stop|production branch of/);

  const twoBranches = { ...answers, branches: true, developmentBranch: 'develop', productionBranch: 'main' };
  const branch = jsApp.setup.nextSteps(twoBranches, { relay, results: [], state: APP_STATE });
  expect(branch).toContainEqual(expect.stringContaining('staging deploys develop'));
  expect(branch.join('\n')).not.toContain('production deploys main');
});
