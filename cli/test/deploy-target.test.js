import { afterEach, expect, test, vi } from 'vitest';
import { apiClient, repositoryOf } from '../providers/deploy/api.js';
import { cloudApi, cloudEnvironments, cloudEnvironmentTask } from '../providers/deploy/cloud.js';
import {
  forgeApi,
  forgeDeployHook,
  forgeNightwatchTask,
  forgeSites,
  forgeSiteTask,
  STANDARD_SNIPPET,
  withCommitCheckout,
  ZERO_DOWNTIME_SNIPPET,
} from '../providers/deploy/forge.js';
import app from '../stacks/laravel/app.js';
import { APP_STATE, askedSteps, fakeGitHub, RELAY as relay } from './helpers.js';

const { steps: setupSteps, tasks: setupTasks, nextSteps } = app.setup;

const FORGE = 'https://forge.laravel.com/api';
const CLOUD = 'https://cloud.laravel.com/api';

/**
 * A fake fetch: `routes` maps 'METHOD url' to the JSON body it answers (or { status, body }); every request is
 * recorded in `calls` ({ method, url, headers, body }), and one no route matches fails the test.
 */
function fakeFetch(routes) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, { method, headers, body }) => {
      calls.push({ method, url, headers, body: body ? JSON.parse(body) : undefined });
      const key = `${method} ${url}`;
      if (!(key in routes)) throw new Error(`No fake route for ${key}`);
      const route = routes[key];
      const { status = 200, body: answer = null } = route && 'status' in route ? route : { body: route };
      return new Response(answer === null ? null : JSON.stringify(answer), { status });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const ZERO_DOWNTIME_SCRIPT = `$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY

$FORGE_COMPOSER install --no-dev
$ACTIVATE_RELEASE()
`;

const STANDARD_SCRIPT = `cd /home/forge/app.example.com
git pull origin $FORGE_SITE_BRANCH

$FORGE_COMPOSER install --no-dev
`;

test('makes a zero-downtime deploy script check out the commit right after it enters the release', () => {
  expect(withCommitCheckout(ZERO_DOWNTIME_SCRIPT)).toBe(`$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY
${ZERO_DOWNTIME_SNIPPET}

$FORGE_COMPOSER install --no-dev
$ACTIVATE_RELEASE()
`);
});

test('replaces the git pull of a standard deploy script, keeping its indentation', () => {
  expect(withCommitCheckout(STANDARD_SCRIPT)).toBe(`cd /home/forge/app.example.com
${STANDARD_SNIPPET}

$FORGE_COMPOSER install --no-dev
`);
  expect(withCommitCheckout('  git pull origin "$FORGE_SITE_BRANCH"\r\n')).toBe(
    `${STANDARD_SNIPPET.replace(/^/gm, '  ').replace(/\n/g, '\r\n')}\r\n`,
  );
});

test('leaves a deploy script that already uses the commit, and gives up on one it cannot place the checkout in', () => {
  const fixed = withCommitCheckout(ZERO_DOWNTIME_SCRIPT);
  expect(withCommitCheckout(fixed)).toBe(fixed);
  expect(withCommitCheckout('cd /home/forge/app\nphp artisan migrate\n')).toBeNull();
});

test('reads owner/repo from every form Forge stores a repository in', () => {
  for (const value of [
    'datalogix/App',
    'git@github.com:datalogix/App.git',
    'https://github.com/datalogix/App',
    'https://github.com/datalogix/App.git/',
  ]) {
    expect(repositoryOf(value)).toBe('datalogix/app');
  }
  expect(repositoryOf(null)).toBeNull();
});

test('sends the token only to its API, following the next links of a list', async () => {
  const calls = fakeFetch({
    [`GET ${FORGE}/orgs`]: { data: [{ id: 1 }], links: { next: `${FORGE}/orgs?page[cursor]=2` } },
    [`GET ${FORGE}/orgs?page[cursor]=2`]: { data: [{ id: 2 }], links: { next: 'https://evil.test/orgs' } },
  });
  const api = apiClient(FORGE, 'secret', 'Forge');
  await expect(api.all('/orgs')).rejects.toThrow('The Forge API pointed to another site: evil.test');
  expect(calls.map((call) => call.url)).toStrictEqual([`${FORGE}/orgs`, `${FORGE}/orgs?page[cursor]=2`]);
  expect(calls[0].headers.Authorization).toBe('Bearer secret');
});

test('tells a refused token apart from a token without the permission', async () => {
  fakeFetch({
    [`GET ${FORGE}/orgs`]: { status: 401 },
    [`DELETE ${FORGE}/x`]: { status: 403 },
    [`GET ${FORGE}/y`]: { status: 500 },
  });
  const api = forgeApi('token');
  await expect(api.get('/orgs')).rejects.toThrow('The Forge API token was refused');
  await expect(api.delete('/x')).rejects.toThrow('The Forge API token is not allowed to DELETE /api/x');
  await expect(api.get('/y')).rejects.toThrow('The Forge API answered HTTP 500 to GET /api/y');
});

const forgeSite = (id, name, url, branch, quickDeploy = true) => ({
  id,
  attributes: { name, repository: { url, branch }, quick_deploy: quickDeploy },
  relationships: { server: { data: { id: 7 } } },
});

test('finds the Forge sites of the repository in every organization', async () => {
  fakeFetch({
    [`GET ${FORGE}/orgs`]: { data: [{ attributes: { slug: 'datalogix' } }, { attributes: { slug: 'other' } }] },
    [`GET ${FORGE}/orgs/datalogix/sites`]: {
      data: [
        forgeSite(1, 'app.example.com', 'git@github.com:datalogix/app.git', 'main'),
        forgeSite(2, 'blog.example.com', 'datalogix/blog', 'main'),
      ],
    },
    [`GET ${FORGE}/orgs/other/sites`]: {
      data: [forgeSite(3, 'dev.app.example.com', 'datalogix/app', 'develop', false)],
    },
    [`GET ${FORGE}/orgs/datalogix/servers/7/sites/1/deployments/deploy-hook`]: {
      data: { attributes: { url: 'https://forge.laravel.com/hook/1' } },
    },
  });
  const api = forgeApi('token');
  const sites = await forgeSites(api, 'datalogix/App');
  expect(sites).toStrictEqual([
    { organization: 'datalogix', server: 7, id: 1, name: 'app.example.com', branch: 'main', pushToDeploy: true },
    { organization: 'other', server: 7, id: 3, name: 'dev.app.example.com', branch: 'develop', pushToDeploy: false },
  ]);
  expect(await forgeDeployHook(api, sites[0])).toBe('https://forge.laravel.com/hook/1');
});

const SITE = {
  organization: 'datalogix',
  server: 7,
  id: 1,
  name: 'app.example.com',
  branch: 'main',
  pushToDeploy: true,
};
const SCRIPT_URL = `${FORGE}/orgs/datalogix/servers/7/sites/1/deployments/script`;

test('fixes the deploy script of a Forge site and turns off its Push to deploy', async () => {
  const calls = fakeFetch({
    [`GET ${SCRIPT_URL}`]: { data: { attributes: { content: STANDARD_SCRIPT, auto_source: true } } },
    [`PUT ${SCRIPT_URL}`]: { data: {} },
    [`DELETE ${FORGE}/orgs/datalogix/servers/7/sites/1/deployments/push-to-deploy`]: { status: 202 },
  });
  const task = forgeSiteTask(forgeApi('token'), SITE, 'production');
  expect(task).toMatchObject({ id: 'deploySite:production', title: 'Forge site app.example.com (production)' });
  expect(await task.run()).toBe('deploy script checks out the commit, Push to deploy off');
  expect(calls[1].body).toStrictEqual({ content: withCommitCheckout(STANDARD_SCRIPT), auto_source: true });
});

test('changes nothing in a Forge site already set up, and fails on a script it cannot change', async () => {
  const content = withCommitCheckout(ZERO_DOWNTIME_SCRIPT);
  fakeFetch({ [`GET ${SCRIPT_URL}`]: { data: { attributes: { content, auto_source: false } } } });
  expect(await forgeSiteTask(forgeApi('token'), { ...SITE, pushToDeploy: false }, 'production').run()).toBe(
    'unchanged',
  );

  fakeFetch({
    [`GET ${SCRIPT_URL}`]: { data: { attributes: { content: 'php artisan migrate', auto_source: false } } },
  });
  await expect(forgeSiteTask(forgeApi('token'), SITE, 'production').run()).rejects.toThrow('change it by hand');
});

test('finds the Laravel Cloud environments of the repository with their branch', async () => {
  fakeFetch({
    [`GET ${CLOUD}/applications`]: {
      data: [
        { id: 'app-1', attributes: { name: 'App', repository: { full_name: 'datalogix/app' } } },
        { id: 'app-2', attributes: { name: 'Blog', repository: { full_name: 'datalogix/blog' } } },
      ],
    },
    [`GET ${CLOUD}/applications/app-1/environments?include=branch`]: {
      data: [
        {
          id: 'env-1',
          attributes: { name: 'production', uses_push_to_deploy: true },
          relationships: { branch: { data: { type: 'branches', id: 'b1' } } },
        },
      ],
      included: [{ type: 'branches', id: 'b1', attributes: { name: 'main' } }],
    },
  });
  expect(await cloudEnvironments(cloudApi('token'), 'datalogix/app')).toStrictEqual([
    { application: 'App', id: 'env-1', name: 'production', branch: 'main', pushToDeploy: true },
  ]);
});

test('turns off Push to deploy of a Laravel Cloud environment and sets its branch', async () => {
  const environment = { application: 'App', id: 'env-2', name: 'staging', branch: 'main', pushToDeploy: true };
  const calls = fakeFetch({ [`PATCH ${CLOUD}/environments/env-2`]: { data: {} } });
  const task = cloudEnvironmentTask(cloudApi('token'), environment, 'staging', 'develop');
  expect(task.title).toBe('Laravel Cloud environment App staging (staging)');
  expect(await task.run()).toBe('Push to deploy off, branch develop, from the next deploy');
  expect(calls[0].body).toStrictEqual({ uses_push_to_deploy: false, branch: 'develop' });

  expect(
    await cloudEnvironmentTask(cloudApi('token'), { ...environment, pushToDeploy: false }, 'staging', 'main').run(),
  ).toBe('unchanged');
});

const forgeAnswers = {
  repository: 'datalogix/app',
  deploy: 'forge',
  domain: 'app.example.com',
  staging: true,
  stagingDomain: 'dev.app.example.com',
  healthPath: '/up',
  deployToken: 'token',
  productionSite: SITE,
  stagingSite: { ...SITE, id: 3, name: 'dev.app.example.com' },
  deployHooks: { production: 'https://forge.laravel.com/hook/1', staging: 'https://forge.laravel.com/hook/3' },
  incidents: false,
  solo: true,
  codeOwners: '@ana',
};

test('asks for the deploy hooks only when the API did not give them', () => {
  const ctx = { deployTargets: [SITE] };
  const asked = askedSteps(setupSteps(), forgeAnswers, ctx);
  expect(asked).toEqual(expect.arrayContaining(['deployToken', 'productionSite', 'stagingSite']));
  expect(asked).not.toContain('productionHook');
  expect(asked).not.toContain('stagingHook');

  const withoutStaging = { ...forgeAnswers, deployHooks: { production: forgeAnswers.deployHooks.production } };
  expect(askedSteps(setupSteps(), withoutStaging, ctx)).toContain('stagingHook');
  // Without a token, nothing is read from Forge
  expect(askedSteps(setupSteps(), { ...forgeAnswers, deployToken: '', deployHooks: undefined }, ctx)).not.toContain(
    'productionSite',
  );
});

test('stores the deploy hooks from Forge and sets up each site it chose', async () => {
  const github = fakeGitHub();
  const tasks = setupTasks(forgeAnswers, { github, root: '', state: APP_STATE, relay });
  const titles = tasks.map((task) => task.title);
  expect(titles).toEqual(
    expect.arrayContaining(['Forge site app.example.com (production)', 'Forge site dev.app.example.com (staging)']),
  );
  await tasks.find((task) => task.title === 'Environment production').run();
  expect(github.calls).toContainEqual(['secret', 'DEPLOY_HOOK', 'https://forge.laravel.com/hook/1', 'production']);
});

test('leaves to do by hand only the sites setup did not set up', () => {
  const done = { id: 'deploySite:production', ok: true, detail: 'unchanged' };
  const failed = { id: 'deploySite:staging', ok: false, detail: 'change it by hand' };
  const forge = (results) =>
    nextSteps(forgeAnswers, { relay, results, state: APP_STATE }).find((step) => step.includes('In Forge'));
  expect(forge([done, { ...failed, ok: true }])).toBeUndefined();
  expect(forge([done, failed])).toContain('In Forge, for the staging site:');
  expect(forge([done, failed])).toContain('Setup could not do it through the API (staging: change it by hand).');
  expect(forge([])).not.toContain('Setup could not do it');
  expect(forge([])).toContain('In Forge, for both sites:');

  const cloud = nextSteps({ ...forgeAnswers, deploy: 'cloud' }, { relay, results: [failed], state: APP_STATE }).find(
    (step) => step.includes('In Laravel Cloud'),
  );
  expect(cloud).toContain('for both environments');

  // The token or the search failed: no task ran, and the reason goes along
  const refused = nextSteps(
    { ...forgeAnswers, deployToken: '', deployProblem: 'The Forge API token was refused' },
    { relay, results: [], state: APP_STATE },
  ).find((step) => step.includes('In Forge'));
  expect(refused).toContain('In Forge, for both sites:');
  expect(refused).toContain('Setup could not do it through the API (The Forge API token was refused).');
});

const ENV_URL = `${FORGE}/orgs/datalogix/servers/7/sites/1/environment`;

test("puts the Nightwatch token in a Forge site's .env only when it has none", async () => {
  fakeFetch({
    [`GET ${ENV_URL}`]: { data: { attributes: { content: 'APP_ENV=production\nNIGHTWATCH_TOKEN=abc\n' } } },
  });
  expect(await forgeNightwatchTask(forgeApi('token'), SITE, 'production', 'new').run()).toBe('unchanged');

  fakeFetch({ [`GET ${ENV_URL}`]: { data: { attributes: { content: 'APP_ENV=production' } } } });
  expect(await forgeNightwatchTask(forgeApi('token'), SITE, 'production', undefined).run()).toStrictEqual({
    detail: 'not in .env',
    data: { missing: true },
  });

  const calls = fakeFetch({
    [`GET ${ENV_URL}`]: { data: { attributes: { content: 'APP_ENV=production\nNIGHTWATCH_TOKEN=\n' } } },
    [`PUT ${ENV_URL}`]: { data: {} },
  });
  expect(await forgeNightwatchTask(forgeApi('token'), SITE, 'production', 'n$1w').run()).toBe(
    'added to .env, from the next deploy',
  );
  expect(calls[1].body).toStrictEqual({ environment: 'APP_ENV=production\nNIGHTWATCH_TOKEN=n$1w\n' });
});

test('sets up Nightwatch in each chosen Forge site, and tells what is left of it', () => {
  const answers = { ...forgeAnswers, incidents: true, productionMonitoringToken: 'nw' };
  const titles = setupTasks(answers, { github: fakeGitHub(), root: '', state: APP_STATE, relay }).map(
    (task) => task.title,
  );
  expect(titles).toEqual(
    expect.arrayContaining([
      'NIGHTWATCH_TOKEN of Forge site app.example.com (production)',
      'NIGHTWATCH_TOKEN of Forge site dev.app.example.com (staging)',
    ]),
  );

  const nightwatch = (results, state = APP_STATE) =>
    nextSteps(answers, { relay, results, state }).filter((step) => /laravel\/nightwatch|NIGHTWATCH_TOKEN/.test(step));
  const set = { id: 'nightwatchEnv:production', ok: true, detail: 'unchanged' };
  const missing = { id: 'nightwatchEnv:staging', ok: true, detail: 'not in .env', data: { missing: true } };
  expect(nightwatch([set, missing], { ...APP_STATE, nightwatch: true })).toStrictEqual([
    expect.stringContaining('in the environment of the Forge site of staging'),
  ]);
  expect(nightwatch([set, { ...missing, data: undefined }], { ...APP_STATE, nightwatch: true })).toStrictEqual([]);
  expect(nightwatch([set, { ...missing, ok: false, detail: 'HTTP 403' }])).toStrictEqual([
    expect.stringContaining('composer require laravel/nightwatch'),
    expect.stringContaining('(staging: HTTP 403)'),
  ]);
  // Nothing done yet: the agent, and the token of both sites; with Nightwatch off, nothing about it
  expect(nightwatch([], APP_STATE).length).toBe(2);
  expect(
    nextSteps({ ...forgeAnswers, incidents: false }, { relay, results: [], state: APP_STATE }).join('\n'),
  ).not.toContain('NIGHTWATCH_TOKEN');
});
