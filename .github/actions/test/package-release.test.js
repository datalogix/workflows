import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { callsTo, runScript, unmatchedReads } from './fakes.js';

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

const remotes = [];
afterEach(async () => {
  for (const dir of remotes.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * A package repository with an origin (kept after the run, to check nothing was pushed with git): `history` is a list of commits (a subject, or { subject, body, files }) and tags ({ tag }), oldest first.
 */
async function repository(history, files = {}) {
  const remote = await mkdtemp(join(tmpdir(), 'release-origin-'));
  remotes.push(remote);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = { remote };
  repo.setup = async (dir) => {
    const cwd = join(dir, 'package');
    execFileSync('git', ['init', '-q', '-b', 'main', cwd]);
    for (const [path, content] of Object.entries(files)) await writeFile(join(cwd, path), content);
    let n = 0;
    for (const entry of history) {
      if (entry.tag) {
        git(cwd, 'tag', entry.tag);
        continue;
      }
      const { subject, body = '' } = typeof entry === 'string' ? { subject: entry } : entry;
      await writeFile(join(cwd, `file${n++}.txt`), subject);
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', subject, ...(body ? ['-m', body] : []));
    }
    git(cwd, 'remote', 'add', 'origin', remote);
    git(cwd, 'push', '-q', 'origin', 'main');
    return cwd;
  };
  return repo;
}

async function release({ history, files, env = {}, pulls = [], openPull = null, branch = true }) {
  const repo = await repository(history, files);
  const result = await runScript('package-release/release.sh', {
    env: { MODE: 'release', BASE: 'main', SHA: 'f'.repeat(40), ...env },
    setup: repo.setup,
    gh: [
      { match: `commits/${'f'.repeat(40)}/pulls`, stdout: pulls },
      // The commit through the API: blobs, the pushed commit's tree, the new tree and commit, then the branch
      { match: 'git/blobs -f encoding=utf-8 -F content=@', stdout: { sha: 'b'.repeat(40) } },
      { match: `git/commits/${'f'.repeat(40)}$`, stdout: { tree: { sha: 'e'.repeat(40) } } },
      { match: 'git/trees -f base_tree=', stdout: { sha: 'd'.repeat(40) } },
      { match: 'git/commits -f message=', stdout: { sha: 'c'.repeat(40) } },
      branch
        ? { match: 'git/ref/heads/datalogix/release', stdout: { object: { sha: '9'.repeat(40) } } }
        : { match: 'git/ref/heads/datalogix/release', code: 1, stderr: 'gh: Not Found (HTTP 404)' },
      {
        match: 'pulls\\?state=open&base=main&head=datalogix%3Adatalogix%2Frelease$',
        stdout: openPull ? [{ number: openPull }] : [],
      },
      { match: '^api repos/datalogix/app/pulls -f', stdout: { number: 42 } },
      { match: '-X PATCH', stdout: {} },
    ],
  });
  expect(unmatchedReads(result)).toEqual([]);
  return { ...result, remote: repo.remote };
}

/** The content of a file the run committed through the API, as the fake gh recorded it with its blob. */
const pushed = (result, path) => {
  const call = result.calls.find(([name, ...args]) => name === 'gh' && args.includes(`content=@${path}`));
  return call?.[call.indexOf(`<file ${path}>`) + 1];
};
const gitCalls = (result, pattern) => callsTo(result, 'gh').filter((call) => pattern.test(call));

const field = (call, name) => call.split(` -f ${name}=`)[1]?.split(/ -f \w+=| --jq /)[0];
const createdPull = (result) =>
  callsTo(result, 'gh').find((call) => call.startsWith('api repos/datalogix/app/pulls -f'));

test('opens the release pull request with the next minor version and its changelog', async () => {
  const result = await release({
    history: ['feat: first', { tag: 'v1.2.0' }, 'feat(api): add export', 'fix: total', 'docs: readme'],
    env: { LANGUAGE: 'en' },
  });
  expect(result.code).toBe(0);
  const create = createdPull(result);
  expect(field(create, 'head')).toBe('datalogix/release');
  expect(field(create, 'base')).toBe('main');
  expect(field(create, 'title')).toBe('chore(release): v1.3.0');
  const body = field(create, 'body');
  expect(body).toContain('<!-- datalogix-release: v1.3.0 -->');
  expect(body).toContain('[v1.3.0](https://github.com/datalogix/app/compare/v1.2.0...v1.3.0)');
  expect(body).toContain('### Features');
  expect(body).toContain('- **api:** add export');
  expect(body).toContain('### Fixes');
  expect(body).toContain('### Other changes');
  expect(body).not.toContain('- first');
  expect(result.outputs.version).toBe('1.3.0');

  const changelog = pushed(result, 'CHANGELOG.md');
  expect(changelog).toMatch(/^# Changelog\n\n## \[v1\.3\.0\]/);
  // Committed through the API, so GitHub signs it: the changelog on top of the pushed commit, then the branch moved
  expect(gitCalls(result, /git\/blobs/)).toEqual([
    expect.stringMatching(
      /^api repos\/datalogix\/app\/git\/blobs -f encoding=utf-8 -F content=@CHANGELOG\.md --jq \.sha/,
    ),
  ]);
  expect(gitCalls(result, /git\/trees/)[0]).toContain(`base_tree=${'e'.repeat(40)} -f tree[][path]=CHANGELOG.md`);
  expect(gitCalls(result, /git\/commits -f/)).toEqual([
    `api repos/datalogix/app/git/commits -f message=chore(release): v1.3.0 -f tree=${'d'.repeat(40)} -f parents[]=${'f'.repeat(40)} --jq .sha`,
  ]);
  expect(gitCalls(result, /git\/refs/)).toEqual([
    `api -X PATCH repos/datalogix/app/git/refs/heads/datalogix/release -f sha=${'c'.repeat(40)} -F force=true --silent`,
  ]);
  // Nothing is pushed with git
  expect(() => git(result.remote, 'rev-parse', '--verify', '-q', 'datalogix/release')).toThrow();
});

test('creates the release branch when it does not exist yet', async () => {
  const result = await release({ history: ['feat: first'], branch: false });
  expect(result.code).toBe(0);
  expect(gitCalls(result, /git\/refs/)).toEqual([
    `api repos/datalogix/app/git/refs -f ref=refs/heads/datalogix/release -f sha=${'c'.repeat(40)} --silent`,
  ]);
});

test('bumps by the commit types: breaking is major, fix alone patch, and breaking is minor before 1.0.0', async () => {
  const title = async (history) => field(createdPull(await release({ history })), 'title');
  expect(await title(['feat: a', { tag: 'v1.2.3' }, 'feat!: drop php 8.1'])).toBe('chore(release): v2.0.0');
  expect(await title(['feat: a', { tag: 'v1.2.3' }, { subject: 'refactor: x', body: 'BREAKING CHANGE: gone' }])).toBe(
    'chore(release): v2.0.0',
  );
  expect(await title(['feat: a', { tag: '1.2.3' }, 'fix: total'])).toBe('chore(release): 1.2.4');
  expect(await title(['feat: a', { tag: 'v0.4.1' }, 'feat!: new api'])).toBe('chore(release): v0.5.0');
  // A Release-As footer sets the version, e.g. the first major
  expect(await title(['feat: a', { tag: 'v0.4.1' }, { subject: 'chore: stable', body: 'Release-As: 1.0.0' }])).toBe(
    'chore(release): v1.0.0',
  );
  // Five git repositories: slow when the whole suite runs in parallel
}, 30_000);

test('starts at 0.1.0, or at the version package.json declares for a js package', async () => {
  expect(field(createdPull(await release({ history: ['feat: first'] })), 'title')).toBe('chore(release): v0.1.0');
  const js = await release({
    history: ['feat: first'],
    files: { 'package.json': JSON.stringify({ name: '@acme/lib', version: '2.0.0' }) },
    env: { STACK: 'js' },
  });
  expect(field(createdPull(js), 'title')).toBe('chore(release): v2.0.0');
});

test('writes the version to package.json for a js package', async () => {
  const result = await release({
    history: ['feat: first', { tag: 'v1.0.0' }, 'fix: types'],
    files: { 'package.json': JSON.stringify({ name: '@acme/lib', version: '1.0.0' }) },
    env: { STACK: 'js' },
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(pushed(result, 'package.json')).version).toBe('1.0.1');
  expect(gitCalls(result, /git\/blobs/).map((call) => call.split('content=@')[1].split(' ')[0])).toEqual([
    'CHANGELOG.md',
    'package.json',
  ]);
  expect(field(createdPull(result), 'body')).toContain('publica no npm');
});

test('counts every commit as a patch in a project without type prefixes', async () => {
  const result = await release({ history: ['Primeira versão', { tag: 'v1.0.0' }, 'Corrige o total'] });
  expect(field(createdPull(result), 'title')).toBe('chore(release): v1.0.1');
  expect(field(createdPull(result), 'body')).toContain('### Outras mudanças');
});

test('updates the open release pull request, and says so when nothing is releasable', async () => {
  const update = await release({ history: ['feat: first', { tag: 'v1.0.0' }, 'feat: x'], openPull: 7 });
  const patch = callsTo(update, 'gh').find((call) => call.includes('-X PATCH') && call.includes('/pulls/'));
  expect(patch).toContain('pulls/7');
  expect(field(patch, 'title')).toBe('chore(release): v1.1.0');
  expect(createdPull(update)).toBe(undefined);

  const nothing = await release({
    history: ['feat: first', { tag: 'v1.0.0' }, 'docs: typo', 'chore(release): v1.0.0'],
    openPull: 7,
  });
  expect(nothing.code).toBe(0);
  const body = field(
    callsTo(nothing, 'gh').find((call) => call.includes('-X PATCH') && call.includes('/pulls/')),
    'body',
  );
  expect(body).toContain('Nada a lançar');
  expect(createdPull(nothing)).toBe(undefined);
  expect(nothing.outputs.version).toBe(undefined);
});

const mergedPull = (tag) => ({
  number: 9,
  head: { ref: 'datalogix/release' },
  merged_at: '2026-11-11T10:00:00Z',
  merge_commit_sha: 'a'.repeat(40),
  body: `<!-- datalogix-release: ${tag} -->\nIntro.\n\n<!-- datalogix-release-notes -->\n## ${tag} (2026-11-11)\n\n### Fixes\n\n- total\n<!-- /datalogix-release-notes -->\n\nOutro.`,
});

async function publishRun({ tagExists = false, releaseExists = false } = {}) {
  return runScript('package-release/release.sh', {
    env: { MODE: 'release', BASE: 'main', SHA: 'f'.repeat(40) },
    gh: [
      { match: `commits/${'f'.repeat(40)}/pulls`, stdout: [mergedPull('v1.0.1')] },
      tagExists
        ? { match: 'git/ref/tags/v1.0.1', stdout: { object: { sha: 'a'.repeat(40) } } }
        : { match: 'git/ref/tags/v1.0.1', code: 1, stderr: 'HTTP 404: Not Found' },
      releaseExists
        ? {
            match: 'releases/tags/v1.0.1',
            stdout: { html_url: 'https://github.com/datalogix/app/releases/tag/v1.0.1' },
          }
        : { match: 'releases/tags/v1.0.1', code: 1, stderr: 'HTTP 404: Not Found' },
      { match: 'git/refs -f', stdout: {} },
      { match: 'releases -f', stdout: { html_url: 'https://github.com/datalogix/app/releases/tag/v1.0.1' } },
    ],
  });
}

test('tags the merge commit of the release pull request and creates the release with its notes', async () => {
  const result = await publishRun();
  expect(result.code).toBe(0);
  const calls = callsTo(result, 'gh');
  const ref = calls.find((call) => call.includes('git/refs -f'));
  expect(field(ref, 'ref')).toBe('refs/tags/v1.0.1');
  expect(field(ref, 'sha')).toBe('a'.repeat(40));
  const created = calls.find((call) => call.includes('releases -f'));
  expect(field(created, 'tag_name')).toBe('v1.0.1');
  expect(field(created, 'body')).toBe('## v1.0.1 (2026-11-11)\n\n### Fixes\n\n- total');
  expect(result.outputs).toMatchObject({ tag: 'v1.0.1', version: '1.0.1' });
  // It never proposes on the merge push
  expect(calls.some((call) => call.includes('pulls?state=open'))).toBe(false);
});

test('creates neither the tag nor the release again on a re-run', async () => {
  const result = await publishRun({ tagExists: true, releaseExists: true });
  expect(result.code).toBe(0);
  const calls = callsTo(result, 'gh');
  expect(calls.some((call) => call.includes('git/refs -f') || call.includes('releases -f'))).toBe(false);
  expect(result.outputs.tag).toBe('v1.0.1');
});

test('fails on an API error instead of taking it for a missing tag', async () => {
  const result = await runScript('package-release/release.sh', {
    env: { MODE: 'release', BASE: 'main', SHA: 'f'.repeat(40) },
    gh: [
      { match: `commits/${'f'.repeat(40)}/pulls`, stdout: [mergedPull('v1.0.1')] },
      { match: 'git/ref/tags/v1.0.1', code: 1, stderr: 'HTTP 502: Bad Gateway' },
    ],
  });
  expect(result.code).not.toBe(0);
  expect(result.stdout).toContain('Cannot read the tag v1.0.1');
});

// A fake npm that records its arguments and the token it got; `npm view` finds the version when published
const FAKE_NPM = (published) => `#!/usr/bin/env bash
jq -cn --arg args "$*" --arg token "\${NODE_AUTH_TOKEN:-}" '["npm", $args, $token]' >> "$FAKE_DIR/calls.jsonl"
[ "$1" != view ] || exit ${published ? 0 : 1}
`;

/** Publishes in npm mode, with package.json `manifest` and a fake npm. */
async function publishNpm(manifest, { tag = 'v1.0.1', published = false, npmToken = '' } = {}) {
  return runScript('package-release/release.sh', {
    env: { MODE: 'npm', TAG: tag, NPM_TOKEN: npmToken },
    setup: async (dir) => {
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
      await writeFile(join(dir, 'npm'), FAKE_NPM(published));
      await chmod(join(dir, 'npm'), 0o755);
    },
  });
}

const npmCalls = (result) =>
  result.calls.filter(([name]) => name === 'npm').map(([, args, token]) => `${args}${token ? ` token=${token}` : ''}`);

test('publishes to npm with trusted publishing, or with provenance and NPM_TOKEN', async () => {
  const manifest = { name: '@acme/lib', version: '1.0.1' };
  const oidc = await publishNpm(manifest);
  expect(oidc.code).toBe(0);
  expect(npmCalls(oidc)).toStrictEqual(['view @acme/lib@1.0.1 version', 'publish --access public --tag latest']);
  const token = await publishNpm(manifest, { npmToken: 'npm_x' });
  expect(npmCalls(token).at(-1)).toBe('publish --access public --provenance --tag latest token=npm_x');
  // A prerelease goes to the next dist-tag
  const next = await publishNpm({ name: '@acme/lib', version: '2.0.0-beta.1' }, { tag: 'v2.0.0-beta.1' });
  expect(npmCalls(next).at(-1)).toBe('publish --access public --tag next');
});

test('publishes nothing for a private package, a version npm has, or a package.json of another version', async () => {
  expect(npmCalls(await publishNpm({ name: 'app', version: '1.0.1', private: true }))).toStrictEqual([]);
  const published = await publishNpm({ name: '@acme/lib', version: '1.0.1' }, { published: true });
  expect(published.code).toBe(0);
  expect(npmCalls(published).some((call) => call.startsWith('publish'))).toBe(false);
  const mismatch = await publishNpm({ name: '@acme/lib', version: '1.0.0' });
  expect(mismatch.code).not.toBe(0);
  expect(mismatch.stdout).toContain('package.json has version 1.0.0, but the release is v1.0.1');
});
