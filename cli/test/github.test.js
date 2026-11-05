import { expect, test } from 'vitest';
import { createGitHub, createOrganization } from '../lib/github.js';

/** A gh runner whose `gh api` calls all end with the given result. */
const runner = (result) => ({
  run: async () => ({ code: 0, stdout: '', stderr: '', ...result }),
  runOrThrow: async () => expect.unreachable('runOrThrow'),
});

test('reads the rulesets, and null when the plan does not offer them', async () => {
  const rulesets = (result) => createGitHub('datalogix/app', runner(result)).rulesets();

  expect(await rulesets({ stdout: '[{"id":1,"name":"datalogix"}]' })).toStrictEqual([{ id: 1, name: 'datalogix' }]);
  expect(await rulesets({ code: 1, stderr: 'gh: Not Found (HTTP 404)' })).toStrictEqual([]);
  expect(
    await rulesets({
      code: 1,
      stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)',
    }),
  ).toBe(null);
  await expect(rulesets({ code: 1, stderr: 'gh: Bad credentials (HTTP 401)' })).rejects.toThrow(
    'gh api repos/datalogix/app/rulesets?per_page=100&includes_parents=false: gh: Bad credentials (HTTP 401)',
  );
});

test('fails on a plan limit outside the rulesets', async () => {
  const github = createGitHub(
    'datalogix/app',
    runner({ code: 1, stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature.' }),
  );
  await expect(github.ruleset(1)).rejects.toThrow(/Upgrade to GitHub Pro/);
});

test('encodes a branch name in the API path, keeping its slashes', async () => {
  const paths = [];
  const github = createGitHub('datalogix/app', {
    run: async (command, args) => {
      paths.push(args.at(-1));
      return { code: 0, stdout: '{}', stderr: '' };
    },
    runOrThrow: async () => expect.unreachable('runOrThrow'),
  });
  await github.branch('release/1.0#2');
  expect(paths).toStrictEqual(['repos/datalogix/app/branches/release/1.0%232']);
});

/** A gh runner that records every call and answers `gh api <path>` from `answers` ({ path: result }). */
function recorder(answers = {}) {
  const calls = [];
  const answer = (args) => {
    const path = args.find((arg) => /^(repos|orgs|user)(\/|$)/.test(arg));
    return { code: 0, stdout: '', stderr: '', ...(answers[path] ?? {}) };
  };
  return {
    calls,
    run: async (command, args, options) => (calls.push([command, args, options]), answer(args)),
    runOrThrow: async (command, args, options) => (calls.push([command, args, options]), answer(args).stdout),
  };
}

test('sends secrets on stdin, never as an argument', async () => {
  const gh = recorder();
  const github = createGitHub('datalogix/app', gh);
  await github.setSecret('DEPLOY_HOOK', 'https://hook/s3cret', 'production');
  await github.setSecret('CLAUDE_CODE_OAUTH_TOKEN', 'token');
  expect(gh.calls).toStrictEqual([
    [
      'gh',
      ['secret', 'set', 'DEPLOY_HOOK', '--repo', 'github.com/datalogix/app', '--env', 'production'],
      { input: 'https://hook/s3cret' },
    ],
    ['gh', ['secret', 'set', 'CLAUDE_CODE_OAUTH_TOKEN', '--repo', 'github.com/datalogix/app'], { input: 'token' }],
  ]);
});

test('sends a request body as JSON on stdin, to the ruleset endpoints protect uses', async () => {
  const gh = recorder();
  const github = createGitHub('datalogix/app', gh);
  await github.createRuleset({ name: 'datalogix' });
  await github.updateRuleset(7, { name: 'datalogix' });
  expect(gh.calls).toStrictEqual([
    [
      'gh',
      ['api', '--hostname', 'github.com', '--method', 'POST', 'repos/datalogix/app/rulesets', '--input', '-'],
      { input: '{"name":"datalogix"}' },
    ],
    [
      'gh',
      ['api', '--hostname', 'github.com', '--method', 'PUT', 'repos/datalogix/app/rulesets/7', '--input', '-'],
      { input: '{"name":"datalogix"}' },
    ],
  ]);
});

test('reads the checks of the latest pull request from its head commit', async () => {
  const pulls = 'repos/datalogix/app/pulls?state=all&per_page=1&sort=created&direction=desc';
  const github = (pull) =>
    createGitHub(
      'datalogix/app',
      recorder({
        [pulls]: { stdout: JSON.stringify(pull ? [pull] : []) },
        'repos/datalogix/app/commits/abc/check-runs?per_page=100': {
          stdout: '{"name":"pipeline / tests / tests"}\n{"name":"pipeline / tests / all-checks"}\n',
        },
      }),
    );
  expect(await github({ number: 4, head: { sha: 'abc' } }).latestPullRequestChecks()).toStrictEqual({
    number: 4,
    names: ['pipeline / tests / tests', 'pipeline / tests / all-checks'],
  });
  expect(await github(null).latestPullRequestChecks()).toBe(null);
});

test('reads the organization secrets once per command, none when it cannot see them', async () => {
  const path = 'repos/datalogix/app/actions/organization-secrets?per_page=100';
  const gh = recorder({ [path]: { stdout: '{"name":"CODECOV_TOKEN"}\n{"name":"RELEASE_APP_ID"}\n' } });
  const github = createGitHub('datalogix/app', gh);
  expect(await github.hasOrganizationSecret('CODECOV_TOKEN')).toBe(true);
  expect(await github.hasOrganizationSecret('RELEASE_APP_ID')).toBe(true);
  expect(await github.hasOrganizationSecret('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
  expect(gh.calls).toStrictEqual([
    ['gh', ['api', '--hostname', 'github.com', '--paginate', path, '--jq', '.secrets[]'], undefined],
  ]);

  const hidden = createGitHub('datalogix/app', recorder({ [path]: { code: 1, stderr: 'gh: Not Found (HTTP 404)' } }));
  expect(await hidden.hasOrganizationSecret('CODECOV_TOKEN')).toBe(false);

  // A failed read is not kept, so the next call tries again
  let attempts = 0;
  const flaky = createGitHub('datalogix/app', {
    run: async () =>
      ++attempts === 1
        ? { code: 1, stdout: '', stderr: 'HTTP 502' }
        : { code: 0, stdout: '{"name":"CODECOV_TOKEN"}\n', stderr: '' },
    runOrThrow: async () => expect.unreachable('runOrThrow'),
  });
  await expect(flaky.hasOrganizationSecret('CODECOV_TOKEN')).rejects.toThrow('HTTP 502');
  expect(await flaky.hasOrganizationSecret('CODECOV_TOKEN')).toBe(true);
});

test('reads the rulesets of the repository it was created for', async () => {
  const gh = recorder({ 'repos/datalogix/app/rulesets?per_page=100&includes_parents=false': { stdout: '[]' } });
  expect(await createGitHub('datalogix/app', gh).rulesets()).toStrictEqual([]);
  expect(gh.calls).toStrictEqual([
    [
      'gh',
      ['api', '--hostname', 'github.com', 'repos/datalogix/app/rulesets?per_page=100&includes_parents=false'],
      undefined,
    ],
  ]);
});

test('reads the apps of an organization, null when gh cannot see them', async () => {
  const apps = (result) => createOrganization('datalogix', runner(result)).installedApps();
  expect(
    await apps({
      stdout:
        '{"app_slug":"claude","repository_selection":"all"}\n{"app_slug":"codecov","repository_selection":"all"}\n',
    }),
  ).toStrictEqual(['claude', 'codecov']);
  expect(await apps({ code: 1, stderr: 'This API operation needs the "admin:org" scope.' })).toBe(null);
  expect(await apps({ code: 1, stderr: 'gh: Must have admin rights (HTTP 403)' })).toBe(null);
  await expect(apps({ code: 1, stderr: 'gh: Bad credentials (HTTP 401)' })).rejects.toThrow('Bad credentials');
});

test('reads and writes the files of an organization repository as base64', async () => {
  const path = 'repos/datalogix/.github/contents/workflows/relay.json';
  const content = Buffer.from('{"url":"x"}').toString('base64');
  const read = recorder({ [path]: { stdout: JSON.stringify({ sha: 'abc', content }) } });
  expect(await createOrganization('datalogix', read).file('.github', 'workflows/relay.json')).toStrictEqual({
    sha: 'abc',
    content: '{"url":"x"}',
  });

  const write = recorder();
  await createOrganization('datalogix', write).putFile('.github', 'workflows/relay.json', 'hi', 'chore: x', 'abc');
  const [[, args, { input }]] = write.calls;
  expect(args).toStrictEqual(['api', '--hostname', 'github.com', '--method', 'PUT', path, '--input', '-']);
  expect(JSON.parse(input)).toStrictEqual({
    message: 'chore: x',
    content: Buffer.from('hi').toString('base64'),
    sha: 'abc',
  });
});

test('tells how the Claude GitHub App reaches the repositories, and null when gh cannot see it', async () => {
  const claudeApp = (result) => createGitHub('datalogix/app', runner(result)).claudeApp();

  expect(await claudeApp({ stdout: '{"app_slug":"claude","repository_selection":"selected"}\n' })).toBe('selected');
  expect(await claudeApp({ stdout: '{"app_slug":"codecov","repository_selection":"all"}\n' })).toBe('none');
  expect(await claudeApp({ code: 1, stderr: 'gh: Must have admin rights (HTTP 403)' })).toBe(null);
  expect(await claudeApp({ code: 1, stderr: 'gh: Not Found (HTTP 404)' })).toBe(null);
  // Another failure is not taken for a missing app
  await expect(claudeApp({ code: 1, stderr: 'gh: Bad credentials (HTTP 401)' })).rejects.toThrow('Bad credentials');
});

test('reads the organization and the role of the gh login in it', async () => {
  const organization = (answers) => createOrganization('datalogix', recorder(answers));
  const membership = 'user/memberships/orgs/datalogix';
  const answers = (state, role) => ({ [membership]: { stdout: JSON.stringify({ state, role }) } });
  expect(await organization(answers('active', 'admin')).role()).toBe('admin');
  expect(await organization(answers('active', 'member')).role()).toBe('member');
  expect(await organization(answers('pending', 'admin')).role()).toBe(null);
  expect(await organization({ [membership]: { code: 1, stderr: 'gh: Not Found (HTTP 404)' } }).role()).toBe(null);
  expect(
    await organization({ 'orgs/datalogix': { stdout: '{"login":"datalogix","plan":{"name":"team"}}' } }).details(),
  ).toStrictEqual({ login: 'datalogix', plan: { name: 'team' } });
});

test('calls github.com whatever host gh would pick by default (GH_HOST)', async () => {
  const gh = recorder();
  const github = createGitHub('datalogix/app', gh);
  await github.repo();
  await github.labels();
  await github.setVariable('HEALTH_URL', 'https://app.test/up', 'production');
  await github.deleteSecret('NIGHTWATCH_TOKEN', 'production');
  await createOrganization('datalogix', gh).installedApps();
  for (const [, args] of gh.calls) {
    if (args[0] === 'api') expect(args.slice(0, 3)).toStrictEqual(['api', '--hostname', 'github.com']);
    else expect(args[args.indexOf('--repo') + 1]).toBe('github.com/datalogix/app');
  }
  expect(gh.calls).toHaveLength(5);
});

test('reads the repository secrets once, again after storing one, and fails when they cannot be read', async () => {
  const path = 'repos/datalogix/app/actions/secrets?per_page=100';
  const gh = recorder({ [path]: { stdout: '{"name":"CLAUDE_CODE_OAUTH_TOKEN"}\n' } });
  const github = createGitHub('datalogix/app', gh);
  expect(await github.hasRepositorySecret('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
  expect(await github.hasRepositorySecret('RELEASE_APP_CLIENT_ID')).toBe(false);
  const lists = () => gh.calls.filter(([, args]) => args.includes(path)).length;
  expect(lists()).toBe(1);

  // An environment secret leaves the repository's as read
  await github.setSecret('DEPLOY_HOOK', 'https://hook', 'production');
  await github.hasRepositorySecret('CLAUDE_CODE_OAUTH_TOKEN');
  expect(lists()).toBe(1);
  await github.setSecret('RELEASE_APP_CLIENT_ID', 'id');
  await github.hasRepositorySecret('RELEASE_APP_CLIENT_ID');
  expect(lists()).toBe(2);

  const forbidden = createGitHub('datalogix/app', recorder({ [path]: { code: 1, stderr: 'HTTP 403' } }));
  await expect(forbidden.hasRepositorySecret('CLAUDE_CODE_OAUTH_TOKEN')).rejects.toThrow('HTTP 403');
  const missing = createGitHub('datalogix/app', recorder({ [path]: { code: 1, stderr: 'HTTP 404' } }));
  expect(await missing.hasRepositorySecret('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
});

test('writes the branches, settings, variables, secrets, labels and environments setup changes', async () => {
  const gh = recorder();
  const github = createGitHub('datalogix/app', gh);
  await github.createBranch('develop', 'abc');
  await github.setDefaultBranch('develop');
  await github.allowMergeCommits();
  await github.allowActionsPullRequests('read');
  await github.setVariable('HEALTH_URL', 'https://app.test/up', 'production');
  await github.deleteSecret('NIGHTWATCH_TOKEN', 'staging');
  await github.createLabel('env:production', 'b60205', 'Deploys production');
  await github.setLabelDescription('env:production', 'Deploys production');
  await github.createEnvironment('production');
  const api = (method, path) => ['api', '--hostname', 'github.com', '--method', method, path, '--input', '-'];
  expect(gh.calls).toStrictEqual([
    ['gh', api('POST', 'repos/datalogix/app/git/refs'), { input: '{"ref":"refs/heads/develop","sha":"abc"}' }],
    ['gh', api('PATCH', 'repos/datalogix/app'), { input: '{"default_branch":"develop"}' }],
    ['gh', api('PATCH', 'repos/datalogix/app'), { input: '{"allow_merge_commit":true}' }],
    [
      'gh',
      api('PUT', 'repos/datalogix/app/actions/permissions/workflow'),
      { input: '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":true}' },
    ],
    [
      'gh',
      [
        'variable',
        'set',
        'HEALTH_URL',
        '--repo',
        'github.com/datalogix/app',
        '--env',
        'production',
        '--body',
        'https://app.test/up',
      ],
      undefined,
    ],
    [
      'gh',
      ['secret', 'delete', 'NIGHTWATCH_TOKEN', '--repo', 'github.com/datalogix/app', '--env', 'staging'],
      undefined,
    ],
    [
      'gh',
      api('POST', 'repos/datalogix/app/labels'),
      { input: '{"name":"env:production","color":"b60205","description":"Deploys production"}' },
    ],
    [
      'gh',
      api('PATCH', 'repos/datalogix/app/labels/env%3Aproduction'),
      { input: '{"description":"Deploys production"}' },
    ],
    ['gh', api('PUT', 'repos/datalogix/app/environments/production'), { input: '{}' }],
  ]);
});

test('reads the labels with their descriptions, and the secrets and variables of an environment', async () => {
  const gh = recorder({
    'repos/datalogix/app/labels?per_page=100': { stdout: '{"name":"claude","description":"Claude works on it"}\n' },
    'repos/datalogix/app/environments/production/secrets/DEPLOY_HOOK': { stdout: '{"name":"DEPLOY_HOOK"}' },
    'repos/datalogix/app/environments/production/variables/HEALTH_URL': {
      stdout: '{"name":"HEALTH_URL","value":"https://app.test/up"}',
    },
  });
  const github = createGitHub('datalogix/app', gh);
  expect(await github.labels()).toStrictEqual([{ name: 'claude', description: 'Claude works on it' }]);
  expect(await github.hasEnvironmentSecret('production', 'DEPLOY_HOOK')).toBe(true);
  expect(await github.environmentVariable('production', 'HEALTH_URL')).toBe('https://app.test/up');
  const find = (path) => ['gh', ['api', '--hostname', 'github.com', path], undefined];
  expect(gh.calls).toStrictEqual([
    [
      'gh',
      ['api', '--hostname', 'github.com', '--paginate', 'repos/datalogix/app/labels?per_page=100', '--jq', '.[]'],
      undefined,
    ],
    find('repos/datalogix/app/environments/production/secrets/DEPLOY_HOOK'),
    find('repos/datalogix/app/environments/production/variables/HEALTH_URL'),
  ]);
  const missing = createGitHub(
    'datalogix/app',
    recorder({
      'repos/datalogix/app/environments/production/variables/HEALTH_URL': {
        code: 1,
        stderr: 'gh: Not Found (HTTP 404)',
      },
    }),
  );
  expect(await missing.environmentVariable('production', 'HEALTH_URL')).toBe(null);
});

test('creates a public repository with a first commit, and a file without a sha', async () => {
  const gh = recorder();
  const organization = createOrganization('datalogix', gh);
  await organization.createPublicRepo('.github', 'Settings of datalogix');
  await organization.putFile('.github', 'workflows/relay.json', 'hi', 'chore: add the relay settings');
  const api = (path) => ['api', '--hostname', 'github.com', '--method', 'PUT', path, '--input', '-'];
  expect(gh.calls).toStrictEqual([
    [
      'gh',
      ['api', '--hostname', 'github.com', '--method', 'POST', 'orgs/datalogix/repos', '--input', '-'],
      {
        input: JSON.stringify({
          name: '.github',
          description: 'Settings of datalogix',
          visibility: 'public',
          auto_init: true,
        }),
      },
    ],
    [
      'gh',
      api('repos/datalogix/.github/contents/workflows/relay.json'),
      {
        input: JSON.stringify({
          message: 'chore: add the relay settings',
          content: Buffer.from('hi').toString('base64'),
        }),
      },
    ],
  ]);
});
