import { expect, test } from 'vitest';
import { callsTo, runScript, unmatchedReads } from './fakes.js';

const commit = (sha, message, parents = 1) => ({
  sha: sha.repeat(40),
  commit: { message },
  parents: Array.from({ length: parents }, () => ({ sha: 'f'.repeat(40) })),
});

const comparison = (commits, files = commits.length ? [{ filename: 'app/User.php' }] : []) => ({
  total_commits: commits.length,
  commits,
  files,
});

// compares: { 'base...head': comparison }; pulls: { 'head>base': number } for the open pull requests
async function release(mode, { compares = {}, pulls = {}, env = {} } = {}) {
  const result = await runScript('release-pr/release-pr.sh', {
    env: { MODE: mode, DEVELOPMENT: 'develop', PRODUCTION: 'main', ...env },
    gh: [
      ...Object.entries(compares).map(([range, stdout]) => ({ match: `compare/${range}$`, stdout })),
      ...Object.entries(pulls).map(([key, number]) => {
        const [head, base] = key.split('>');
        return {
          match: `pulls\\?state=open&base=${base}&head=datalogix%3A${head}$`,
          stdout: number ? [{ number }] : [],
        };
      }),
      { match: '^api repos/datalogix/app/pulls -f', stdout: { number: 42 } },
      { match: '-X PATCH', stdout: {} },
    ],
  });
  expect(unmatchedReads(result)).toEqual([]);
  return result;
}

const field = (call, name) => call.split(` -f ${name}=`)[1]?.split(/ -f \w+=| --jq /)[0];

test('opens the release pull request with the pending commits, without merge commits', async () => {
  const result = await release('release', {
    compares: {
      'main...develop': comparison([
        commit('a', 'feat: adiciona exportação\n\ncorpo'),
        commit('b', 'Merge branch main into develop', 2),
      ]),
    },
    pulls: { 'develop>main': null },
  });
  expect(result.code).toBe(0);
  const [create] = callsTo(result, 'gh').filter((call) => call.startsWith('api repos/datalogix/app/pulls -f'));
  expect(field(create, 'head')).toBe('develop');
  expect(field(create, 'base')).toBe('main');
  expect(field(create, 'title')).toBe('Release: develop → main');
  expect(field(create, 'body')).toContain(`- feat: adiciona exportação (${'a'.repeat(7)})`);
  expect(field(create, 'body')).not.toContain('Merge branch');
  expect(result.stdout).toContain('Opened pull request #42');
});

test('updates the body of the open release pull request', async () => {
  const result = await release('release', {
    compares: { 'main...develop': comparison([commit('a', 'fix: corrige total')]) },
    pulls: { 'develop>main': 7 },
  });
  expect(result.code).toBe(0);
  const calls = callsTo(result, 'gh');
  expect(calls.some((call) => call.startsWith('api repos/datalogix/app/pulls -f'))).toBe(false);
  const patch = calls.find((call) => call.includes('-X PATCH'));
  expect(patch).toContain('repos/datalogix/app/pulls/7');
  expect(field(patch, 'body')).toContain('- fix: corrige total');
});

test('notes the commits left out when the comparison has more than it lists', async () => {
  const result = await release('release', {
    compares: { 'main...develop': { ...comparison([commit('a', 'feat: um')]), total_commits: 300 } },
    pulls: { 'develop>main': null },
  });
  const create = callsTo(result, 'gh').find((call) => call.startsWith('api repos/datalogix/app/pulls -f'));
  expect(field(create, 'body')).toContain('outros commits');
});

test('opens nothing when the production branch has every change, even with merge commits pending', async () => {
  const result = await release('release', {
    compares: { 'main...develop': comparison([commit('b', 'Merge branch main into develop', 2)], []) },
    pulls: { 'develop>main': null },
  });
  expect(result.code).toBe(0);
  expect(callsTo(result, 'gh').filter((call) => /pulls -f|-X PATCH/.test(call))).toEqual([]);
  expect(result.stdout).toContain('Nothing to release');
});

test('says nothing is pending on an open release pull request with no changes left', async () => {
  const result = await release('release', {
    compares: { 'main...develop': comparison([], []) },
    pulls: { 'develop>main': 7 },
  });
  const patch = callsTo(result, 'gh').find((call) => call.includes('-X PATCH'));
  expect(field(patch, 'body')).toContain('Nada pendente');
});

test('opens a pull request back to the development branch with the hotfixes it lacks', async () => {
  const result = await release('sync', {
    compares: { 'develop...main': comparison([commit('c', 'fix: corrige login em produção')]) },
    pulls: { 'main>develop': null },
  });
  expect(result.code).toBe(0);
  const create = callsTo(result, 'gh').find((call) => call.startsWith('api repos/datalogix/app/pulls -f'));
  expect(field(create, 'head')).toBe('main');
  expect(field(create, 'base')).toBe('develop');
  expect(field(create, 'title')).toBe('Sync: main → develop');
  expect(field(create, 'body')).toContain('- fix: corrige login em produção');
});

test('syncs nothing after a release, when the production branch only has the merge commit', async () => {
  const result = await release('sync', {
    compares: { 'develop...main': comparison([commit('d', 'Merge pull request #42', 2)], []) },
    pulls: { 'main>develop': null },
  });
  expect(result.code).toBe(0);
  expect(callsTo(result, 'gh').filter((call) => /pulls -f|-X PATCH/.test(call))).toEqual([]);
  expect(result.stdout).toContain('Nothing to sync');
});

test('says nothing is pending on an open sync pull request with no changes left', async () => {
  const result = await release('sync', {
    compares: { 'develop...main': comparison([], []) },
    pulls: { 'main>develop': 8 },
  });
  expect(result.code).toBe(0);
  const patch = callsTo(result, 'gh').find((call) => call.includes('-X PATCH'));
  expect(patch).toContain('repos/datalogix/app/pulls/8');
  expect(field(patch, 'body')).toContain('Nada pendente');
});

test('updates the body of the open sync pull request', async () => {
  const result = await release('sync', {
    compares: { 'develop...main': comparison([commit('c', 'fix: corrige login em produção')]) },
    pulls: { 'main>develop': 8 },
  });
  expect(result.code).toBe(0);
  const calls = callsTo(result, 'gh');
  expect(calls.some((call) => call.startsWith('api repos/datalogix/app/pulls -f'))).toBe(false);
  const patch = calls.find((call) => call.includes('-X PATCH'));
  expect(patch).toContain('repos/datalogix/app/pulls/8');
  expect(field(patch, 'body')).toContain('- fix: corrige login em produção');
});

test('says only merge commits are pending even when the comparison has more than it lists', async () => {
  const result = await release('release', {
    compares: {
      'main...develop': { ...comparison([commit('b', 'Merge branch main into develop', 2)]), total_commits: 300 },
    },
    pulls: { 'develop>main': null },
  });
  const create = callsTo(result, 'gh').find((call) => call.startsWith('api repos/datalogix/app/pulls -f'));
  expect(field(create, 'body')).toMatch(/\n\n- Só merge commits; veja a aba Commits\n- … e outros commits/);
});

test('writes the pull request in English when the language is English', async () => {
  const result = await release('release', {
    compares: { 'main...develop': comparison([commit('a', 'feat: add export')]) },
    pulls: { 'develop>main': null },
    env: { LANGUAGE: 'en-US' },
  });
  const [create] = callsTo(result, 'gh').filter((call) => call.startsWith('api repos/datalogix/app/pulls -f'));
  expect(field(create, 'body')).toMatch(/^Changes of `develop` not yet in production:/);
  expect(field(create, 'body')).toContain('Use **Create a merge commit**, not squash');
});

test('says only merge commits are pending in English, even when the comparison has more than it lists', async () => {
  const result = await release('release', {
    compares: {
      'main...develop': { ...comparison([commit('b', 'Merge branch main into develop', 2)]), total_commits: 300 },
    },
    pulls: { 'develop>main': null },
    env: { LANGUAGE: 'en' },
  });
  const create = callsTo(result, 'gh').find((call) => call.startsWith('api repos/datalogix/app/pulls -f'));
  expect(field(create, 'body')).toMatch(
    /\n\n- Only merge commits; see the Commits tab\n- … and more commits, in the Commits tab\n/,
  );
});

test('says nothing is pending in English on an open release pull request with no changes left', async () => {
  const result = await release('release', {
    compares: { 'main...develop': comparison([], []) },
    pulls: { 'develop>main': 7 },
    env: { LANGUAGE: 'en' },
  });
  expect(result.code).toBe(0);
  const patch = callsTo(result, 'gh').find((call) => call.includes('-X PATCH'));
  expect(patch).toContain('repos/datalogix/app/pulls/7');
  expect(field(patch, 'body')).toBe('Nothing pending: `main` already has every change of `develop`.');
});

test('says nothing is pending in English on an open sync pull request with no changes left', async () => {
  const result = await release('sync', {
    compares: { 'develop...main': comparison([], []) },
    pulls: { 'main>develop': 8 },
    env: { LANGUAGE: 'en' },
  });
  expect(result.code).toBe(0);
  const patch = callsTo(result, 'gh').find((call) => call.includes('-X PATCH'));
  expect(patch).toContain('repos/datalogix/app/pulls/8');
  expect(field(patch, 'body')).toBe('Nothing pending: `develop` already has every change of `main`.');
});

test('writes the sync pull request in English when the language is English', async () => {
  const result = await release('sync', {
    compares: { 'develop...main': comparison([commit('c', 'fix: login in production')]) },
    pulls: { 'main>develop': null },
    env: { LANGUAGE: 'en' },
  });
  expect(result.code).toBe(0);
  const create = callsTo(result, 'gh').find((call) => call.startsWith('api repos/datalogix/app/pulls -f'));
  expect(field(create, 'title')).toBe('Sync: main → develop');
  expect(field(create, 'body')).toMatch(/^Changes of `main` that `develop` does not have yet \(hotfix\):\n\n/);
  expect(field(create, 'body')).toContain(`- fix: login in production (${'c'.repeat(7)})`);
  expect(field(create, 'body')).toContain(
    'Use **Create a merge commit**, not squash. Until the merge, the release pull request is out of date with `main`.',
  );
});

test('writes the pull request in Portuguese when the language has no fixed texts', async () => {
  const result = await release('sync', {
    compares: { 'develop...main': comparison([]) },
    pulls: { 'main>develop': 7 },
    env: { LANGUAGE: 'es' },
  });
  const patch = callsTo(result, 'gh').find((call) => call.includes('-X PATCH'));
  expect(patch).toContain('Nada pendente: a `develop` já tem todas as mudanças da `main`.');
});

test('fails when the comparison cannot be read', async () => {
  const result = await runScript('release-pr/release-pr.sh', {
    env: { MODE: 'release', DEVELOPMENT: 'develop', PRODUCTION: 'main' },
    gh: [{ match: 'compare/', code: 1, stderr: 'HTTP 502' }],
  });
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain('::error::Cannot compare main with develop: check that both branches exist');
  expect(callsTo(result, 'gh').filter((call) => /pulls/.test(call))).toEqual([]);
});

test('fails when the pull request cannot be opened', async () => {
  const result = await runScript('release-pr/release-pr.sh', {
    env: { MODE: 'release', DEVELOPMENT: 'develop', PRODUCTION: 'main' },
    gh: [
      { match: 'compare/main...develop$', stdout: comparison([commit('a', 'feat: um')]) },
      { match: 'pulls\\?state=open', stdout: [] },
      { match: '^api repos/datalogix/app/pulls -f', code: 1, stderr: 'HTTP 403: GitHub Actions is not permitted' },
    ],
  });
  expect(result.code).not.toBe(0);
  expect(result.stdout).not.toContain('Opened pull request');
});

test('fails on an unknown mode', async () => {
  const result = await runScript('release-pr/release-pr.sh', {
    env: { MODE: 'deploy', DEVELOPMENT: 'develop', PRODUCTION: 'main' },
    gh: [],
  });
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("::error::Unknown mode 'deploy'");
  expect(callsTo(result, 'gh')).toEqual([]);
});
