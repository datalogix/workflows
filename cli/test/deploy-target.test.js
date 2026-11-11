import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as clack from '@clack/prompts';
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
import { suggestedTarget } from '../providers/deploy/sites.js';
import app from '../stacks/laravel/app.js';
import { APP_STATE, askedSteps, fakeGitHub, RELAY as relay } from './helpers.js';

const { steps: setupSteps, tasks: setupTasks, nextSteps } = app.setup;

// The site questions are answered by each test; a warning is recorded
vi.mock('@clack/prompts', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, log: { ...original.log, warn: vi.fn() }, select: vi.fn() };
});

beforeEach(() => vi.clearAllMocks());

const FORGE = 'https://forge.laravel.com/api';
const CLOUD = 'https://cloud.laravel.com/api';

/**
 * A fake fetch: `routes` maps 'METHOD url' to the JSON body it answers (or { status, body }); every request is
 * recorded in `calls` ({ method, url, headers, body }), and one no route matches fails the test.
 * `limit` is the most requests it answers.
 */
function fakeFetch(routes, { limit = Infinity } = {}) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, { method, headers, body }) => {
      calls.push({ method, url, headers, body: body ? JSON.parse(body) : undefined });
      // A client that never stops fails here, not by running out of memory
      if (calls.length > limit) throw new Error(`More than ${limit} requests`);
      const key = `${method} ${url}`;
      if (!(key in routes)) throw new Error(`No fake route for ${key}`);
      const route = routes[key];
      // { error } fails like fetch does without an answer; { raw } answers a body that is not JSON
      if (route?.error) throw route.error;
      if (route && 'raw' in route) return new Response(route.raw, { status: route.status ?? 200 });
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

test.each([
  ['in quotes and braces', '', 'cd "${FORGE_RELEASE_DIRECTORY}"', '\n'],
  ['indented', '    ', 'cd $FORGE_RELEASE_DIRECTORY', '\n'],
  ['with CRLF line endings', '', 'cd $FORGE_RELEASE_DIRECTORY', '\r\n'],
])('places the checkout after the cd of a zero-downtime release %s', (_, indent, cd, eol) => {
  const script = ['$CREATE_RELEASE()', `${indent}${cd}`, '$ACTIVATE_RELEASE()', ''].join(eol);
  const snippet = ZERO_DOWNTIME_SNIPPET.replace(/^/gm, indent).replace(/\n/g, eol);
  expect(withCommitCheckout(script)).toBe(
    ['$CREATE_RELEASE()', `${indent}${cd}`, snippet, '$ACTIVATE_RELEASE()', ''].join(eol),
  );
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
  await expect(api.delete('/x')).rejects.toThrow(/DELETE \/api\/x: check its permissions$/);
});

test('sends JSON with the token, and gives up on a list of more than 50 pages', async () => {
  const calls = fakeFetch(
    {
      [`GET ${FORGE}/loop`]: { data: [{ id: 1 }], links: { next: `${FORGE}/loop` } },
      [`PUT ${FORGE}/a`]: { data: {} },
      [`PATCH ${FORGE}/b`]: { data: {} },
    },
    { limit: 60 },
  );
  const api = forgeApi('secret');
  await api.put('/a', { x: 1 });
  await api.patch('/b', { y: 2 });
  await expect(api.all('/loop')).rejects.toThrow('The Forge API list /loop has more than 50 pages');
  expect(calls.length).toBe(52);
  const json = { Authorization: 'Bearer secret', Accept: 'application/json', 'Content-Type': 'application/json' };
  expect(calls[0].headers).toStrictEqual(json);
  expect(calls[1].headers).toStrictEqual(json);
  expect(calls[2].headers).toStrictEqual({ Authorization: 'Bearer secret', Accept: 'application/json' });
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

test('skips a Forge site without a server, and reads a site without a branch as null', async () => {
  const serverless = { ...forgeSite(1, 'old.example.com', 'datalogix/app', 'main'), relationships: undefined };
  fakeFetch({
    [`GET ${FORGE}/orgs`]: { data: [{ attributes: { slug: 'datalogix' } }] },
    [`GET ${FORGE}/orgs/datalogix/sites`]: {
      data: [serverless, forgeSite(2, 'app.example.com', 'datalogix/app', undefined)],
    },
  });
  expect(await forgeSites(forgeApi('token'), 'datalogix/app')).toStrictEqual([
    { organization: 'datalogix', server: 7, id: 2, name: 'app.example.com', branch: null, pushToDeploy: true },
  ]);
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
  expect(await task.run()).toBe('Push to deploy off, deploy script checks out the commit');
  expect(calls.find(({ method }) => method === 'PUT').body).toStrictEqual({
    content: withCommitCheckout(STANDARD_SCRIPT),
    auto_source: true,
  });
});

test('changes nothing in a Forge site already set up, and fails on a script it cannot change', async () => {
  const content = withCommitCheckout(ZERO_DOWNTIME_SCRIPT);
  fakeFetch({ [`GET ${SCRIPT_URL}`]: { data: { attributes: { content, auto_source: false } } } });
  expect(await forgeSiteTask(forgeApi('token'), { ...SITE, pushToDeploy: false }, 'production').run()).toBe(
    'unchanged',
  );

  // Push to deploy goes off anyway, before the task fails on the script
  const calls = fakeFetch({
    [`GET ${SCRIPT_URL}`]: { data: { attributes: { content: 'git pull origin master', auto_source: false } } },
    [`DELETE ${FORGE}/orgs/datalogix/servers/7/sites/1/deployments/push-to-deploy`]: { status: 202 },
  });
  await expect(forgeSiteTask(forgeApi('token'), SITE, 'production').run()).rejects.toThrow(
    /^Push to deploy off; the deploy script has neither .*: change it by hand$/,
  );
  expect(calls.map(({ method }) => method)).toStrictEqual(['DELETE', 'GET']);
});

test('says Push to deploy went off when the deploy script cannot be read or written', async () => {
  const pushToDeploy = {
    [`DELETE ${FORGE}/orgs/datalogix/servers/7/sites/1/deployments/push-to-deploy`]: { status: 202 },
  };
  fakeFetch({ ...pushToDeploy, [`GET ${SCRIPT_URL}`]: { status: 500, body: { message: 'Server Error' } } });
  await expect(forgeSiteTask(forgeApi('token'), SITE, 'production').run()).rejects.toThrow(/^Push to deploy off; /);

  const calls = fakeFetch({
    ...pushToDeploy,
    [`GET ${SCRIPT_URL}`]: { data: { attributes: { content: STANDARD_SCRIPT, auto_source: true } } },
    [`PUT ${SCRIPT_URL}`]: { status: 422, body: { message: 'Invalid' } },
  });
  await expect(forgeSiteTask(forgeApi('token'), SITE, 'production').run()).rejects.toThrow(/^Push to deploy off; /);
  expect(calls.map(({ method }) => method)).toStrictEqual(['DELETE', 'GET', 'PUT']);

  // Without Push to deploy to turn off, the error is the request's own
  fakeFetch({ [`GET ${SCRIPT_URL}`]: { status: 500, body: { message: 'Server Error' } } });
  await expect(forgeSiteTask(forgeApi('token'), { ...SITE, pushToDeploy: false }, 'production').run()).rejects.toThrow(
    /^(?!Push to deploy off)/,
  );
});

test('fails on a Forge site without a deploy script', async () => {
  fakeFetch({ [`GET ${SCRIPT_URL}`]: { data: { attributes: { content: null, auto_source: false } } } });
  await expect(forgeSiteTask(forgeApi('token'), { ...SITE, pushToDeploy: false }, 'production').run()).rejects.toThrow(
    /^the deploy script has neither /,
  );
});

test('tells why the API failed: the network error, the validation message, the rate limit or a body not JSON', async () => {
  const api = apiClient(FORGE, 'token', 'Forge');
  const fails = (route) => {
    fakeFetch({ [`GET ${FORGE}/user`]: route });
    return api.get('/user');
  };
  const network = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND forge.laravel.com') });
  await expect(fails({ error: network })).rejects.toThrow(
    'Could not reach the Forge API: getaddrinfo ENOTFOUND forge.laravel.com',
  );
  await expect(fails({ status: 422, body: { errors: [{ detail: 'The branch does not exist.' }] } })).rejects.toThrow(
    'The Forge API answered HTTP 422 to GET /api/user: The branch does not exist.',
  );
  await expect(fails({ status: 422, body: { message: 'Invalid.' } })).rejects.toThrow(': Invalid.');
  await expect(fails({ status: 422, raw: 'Unprocessable' })).rejects.toThrow(/answered HTTP 422 to GET \/api\/user$/);
  await expect(fails({ status: 500, body: { message: 'Server error' } })).rejects.toThrow(
    /answered HTTP 500 to GET \/api\/user$/,
  );
  await expect(fails({ status: 429 })).rejects.toThrow('The Forge API limits the requests: try again in a minute');
  await expect(fails({ raw: '<html>Down for maintenance</html>' })).rejects.toThrow(
    'The Forge API answered something other than JSON to GET /api/user',
  );
});

test('suggests for production a site on its branch that is not named after staging', () => {
  const staging = { name: 'staging.example.com', branch: 'main' };
  const production = { name: 'example.com', branch: 'main' };
  expect(suggestedTarget([staging, production], 'production', 'main')).toBe(production);
  expect(suggestedTarget([staging, production], 'staging', 'main')).toBe(staging);
  expect(suggestedTarget([{ name: 'app-production', branch: 'other' }], 'production', 'main')).toStrictEqual({
    name: 'app-production',
    branch: 'other',
  });
});

test('suggests first a site on the branch named after the environment', () => {
  const other = { name: 'example.com', branch: 'main' };
  const named = { name: 'production.example.com', branch: 'main' };
  expect(suggestedTarget([other, named], 'production', 'main')).toBe(named);
});

test('keeps the token and the sites it finds', async () => {
  const step = setupSteps().find((candidate) => candidate.id === 'deployToken');
  fakeFetch({
    [`GET ${FORGE}/orgs`]: { data: [{ attributes: { slug: 'datalogix' } }] },
    [`GET ${FORGE}/orgs/datalogix/sites`]: { data: [forgeSite(1, 'app.example.com', 'datalogix/app', 'main')] },
  });
  const answers = { ...forgeAnswers, deployToken: ' token ' };
  const ctx = { state: APP_STATE };
  await step.then(answers, ctx);
  expect(answers.deployToken).toBe(' token ');
  expect(answers.deployProblem).toBeUndefined();
  expect(ctx.deployTargets).toStrictEqual([SITE]);

  // A token of spaces is no token: nothing is read
  const calls = fakeFetch({});
  const blank = { state: APP_STATE };
  await step.then({ ...forgeAnswers, deployToken: '  ' }, blank);
  expect(blank.deployTargets).toStrictEqual([]);
  expect(calls).toStrictEqual([]);
});

test('does not offer for staging the site chosen for production', async () => {
  const step = setupSteps().find((candidate) => candidate.id === 'stagingSite');
  const staging = forgeAnswers.stagingSite;
  clack.select.mockResolvedValueOnce(0);
  const ctx = { state: APP_STATE, deployTargets: [SITE, staging] };
  expect(await step.ask({ header: '1/1', answers: forgeAnswers, ctx })).toBe(staging);
  expect(clack.select.mock.calls[0][0].options.map((option) => option.label)).toStrictEqual([
    'dev.app.example.com',
    'None of these',
  ]);
});

test('warns and asks for the deploy hook when Forge does not give it', async () => {
  const step = setupSteps().find((candidate) => candidate.id === 'stagingSite');
  fakeFetch({ [`GET ${FORGE}/orgs/datalogix/servers/7/sites/3/deployments/deploy-hook`]: { status: 403 } });
  const answers = { ...forgeAnswers, deployHooks: { production: forgeAnswers.deployHooks.production } };
  await step.then(answers, { state: APP_STATE });
  expect(answers.deployHooks).toStrictEqual({ production: forgeAnswers.deployHooks.production });
  expect(clack.log.warn).toHaveBeenCalledWith(
    'Could not read the deploy hook of dev.app.example.com: The Forge API token is not allowed to GET /api/orgs/datalogix/servers/7/sites/3/deployments/deploy-hook: check its permissions',
  );
});

test('goes on without the token when the deploy target cannot be read or deploys nothing of the repository', async () => {
  const step = setupSteps().find((candidate) => candidate.id === 'deployToken');
  const run = async (route) => {
    fakeFetch({ [`GET ${FORGE}/orgs`]: route });
    const answers = { ...forgeAnswers, deployToken: 'token', deployProblem: undefined };
    const ctx = { state: APP_STATE };
    await step.then(answers, ctx);
    return { answers, ctx };
  };

  const refused = await run({ status: 401 });
  expect(refused.answers).toMatchObject({ deployToken: '', deployProblem: 'The Forge API token was refused' });
  expect(refused.ctx.deployTargets).toStrictEqual([]);

  const none = await run({ data: [] });
  expect(none.answers).toMatchObject({
    deployToken: '',
    deployProblem: 'no Forge site deploys datalogix/app',
  });
  expect(none.ctx.deployTargets).toStrictEqual([]);
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

test('changes only the branch of a Laravel Cloud environment without Push to deploy, and nothing for no branch', async () => {
  const environment = { application: 'App', id: 'env-2', name: 'staging', branch: 'main', pushToDeploy: false };
  const calls = fakeFetch({ [`PATCH ${CLOUD}/environments/env-2`]: { data: {} } });
  expect(await cloudEnvironmentTask(cloudApi('token'), environment, 'staging', 'develop').run()).toBe(
    'branch develop, from the next deploy',
  );
  expect(calls[0].body).toStrictEqual({ branch: 'develop' });

  expect(await cloudEnvironmentTask(cloudApi('token'), environment, 'staging', null).run()).toBe('unchanged');
  expect(calls.length).toBe(1);
});

const cloudEnvironment = (id, name) => ({ application: 'App', id, name, branch: 'main', pushToDeploy: true });

test('sets up the chosen Laravel Cloud environments, without Nightwatch in them', async () => {
  const answers = {
    ...forgeAnswers,
    deploy: 'cloud',
    incidents: true,
    productionSite: cloudEnvironment('env-1', 'production'),
    stagingSite: cloudEnvironment('env-2', 'staging'),
  };
  const state = { ...APP_STATE, defaultBranch: 'trunk' };
  const tasks = setupTasks(answers, { github: fakeGitHub(), root: '', state, relay });
  const titles = tasks.map((task) => task.title);
  expect(titles).toEqual(
    expect.arrayContaining([
      'Laravel Cloud environment App production (production)',
      'Laravel Cloud environment App staging (staging)',
    ]),
  );
  expect(titles.filter((title) => title.includes('NIGHTWATCH_TOKEN of'))).toStrictEqual([]);

  // With one branch, production keeps its branch and staging tracks the default one
  const calls = fakeFetch({
    [`PATCH ${CLOUD}/environments/env-1`]: { data: {} },
    [`PATCH ${CLOUD}/environments/env-2`]: { data: {} },
  });
  for (const task of tasks.filter((candidate) => candidate.id?.startsWith('deploySite:'))) await task.run();
  expect(calls.map(({ url, body }) => [url, body])).toStrictEqual([
    [`${CLOUD}/environments/env-1`, { uses_push_to_deploy: false }],
    [`${CLOUD}/environments/env-2`, { uses_push_to_deploy: false, branch: 'trunk' }],
  ]);
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

test("reads a quoted Nightwatch token in a Forge site's .env, and adds one on a line of its own", async () => {
  fakeFetch({ [`GET ${ENV_URL}`]: { data: { attributes: { content: 'NIGHTWATCH_TOKEN="abc"\n' } } } });
  expect(await forgeNightwatchTask(forgeApi('token'), SITE, 'production', 'new').run()).toBe('unchanged');

  const calls = fakeFetch({
    [`GET ${ENV_URL}`]: { data: { attributes: { content: 'APP_ENV=production' } } },
    [`PUT ${ENV_URL}`]: { data: {} },
  });
  await forgeNightwatchTask(forgeApi('token'), SITE, 'production', 'new').run();
  expect(calls[1].body).toStrictEqual({ environment: 'APP_ENV=production\nNIGHTWATCH_TOKEN=new\n' });
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
