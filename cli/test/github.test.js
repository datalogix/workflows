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
      paths.push(args[1]);
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
    const path = args.find((arg) => arg.startsWith('repos/') || arg === 'user');
    return { code: 0, stdout: '', stderr: '', ...(answers[path] ?? {}) };
  };
  return {
    calls,
    run: async (command, args, options) => (calls.push([command, args, options]), answer(args)),
    runOrThrow: async (command, args, options) => (calls.push([command, args, options]), answer(args).stdout),
  };
}

test('sends secrets on stdin, never as an argument', async () => {
  const runner = recorder();
  const github = createGitHub('datalogix/app', runner);
  await github.setSecret('DEPLOY_HOOK', 'https://hook/s3cret', 'production');
  await github.setSecret('CLAUDE_CODE_OAUTH_TOKEN', 'token');
  expect(runner.calls).toStrictEqual([
    [
      'gh',
      ['secret', 'set', 'DEPLOY_HOOK', '--repo', 'datalogix/app', '--env', 'production'],
      { input: 'https://hook/s3cret' },
    ],
    ['gh', ['secret', 'set', 'CLAUDE_CODE_OAUTH_TOKEN', '--repo', 'datalogix/app'], { input: 'token' }],
  ]);
});

test('sends a request body as JSON on stdin, to the ruleset endpoints protect uses', async () => {
  const runner = recorder();
  const github = createGitHub('datalogix/app', runner);
  await github.createRuleset({ name: 'datalogix' });
  await github.updateRuleset(7, { name: 'datalogix' });
  expect(runner.calls).toStrictEqual([
    [
      'gh',
      ['api', '--method', 'POST', 'repos/datalogix/app/rulesets', '--input', '-'],
      { input: '{"name":"datalogix"}' },
    ],
    [
      'gh',
      ['api', '--method', 'PUT', 'repos/datalogix/app/rulesets/7', '--input', '-'],
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
  const runner = recorder({ [path]: { stdout: '{"name":"CODECOV_TOKEN"}\n{"name":"RELEASE_APP_ID"}\n' } });
  const github = createGitHub('datalogix/app', runner);
  expect(await github.hasOrganizationSecret('CODECOV_TOKEN')).toBe(true);
  expect(await github.hasOrganizationSecret('RELEASE_APP_ID')).toBe(true);
  expect(await github.hasOrganizationSecret('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
  expect(runner.calls).toStrictEqual([['gh', ['api', '--paginate', path, '--jq', '.secrets[]'], undefined]]);

  const hidden = createGitHub('datalogix/app', recorder({ [path]: { code: 1, stderr: 'gh: Not Found (HTTP 404)' } }));
  expect(await hidden.hasOrganizationSecret('CODECOV_TOKEN')).toBe(false);
});

test('reads the rulesets of the repository it was created for', async () => {
  const runner = recorder({ 'repos/datalogix/app/rulesets?per_page=100&includes_parents=false': { stdout: '[]' } });
  expect(await createGitHub('datalogix/app', runner).rulesets()).toStrictEqual([]);
  expect(runner.calls).toStrictEqual([
    ['gh', ['api', 'repos/datalogix/app/rulesets?per_page=100&includes_parents=false'], undefined],
  ]);
});

test('reads the apps of an organization, null when gh cannot see them', async () => {
  const apps = (result) => createOrganization('datalogix', runner(result)).installedApps();
  expect(await apps({ stdout: 'claude\ncodecov\n' })).toStrictEqual(['claude', 'codecov']);
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
  expect(args).toStrictEqual(['api', '--method', 'PUT', path, '--input', '-']);
  expect(JSON.parse(input)).toStrictEqual({
    message: 'chore: x',
    content: Buffer.from('hi').toString('base64'),
    sha: 'abc',
  });
});
