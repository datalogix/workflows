import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { callsTo, runScript, unmatchedReads } from './fakes.js';

const MARKER = '<!-- claude-security-review -->';
const LIMIT = '<!-- claude-fix-security:limit -->';
const kept = (findings) =>
  `<!-- claude-security-review-findings: ${Buffer.from(JSON.stringify(findings)).toString('base64')} -->`;
const review = (findings) => ({ user: { login: 'github-actions[bot]' }, body: `review\n${kept(findings)}\n${MARKER}` });
const FINDINGS = [
  { id: 1, severity: 'high', status: 'open', title: 'SQL injection' },
  { id: 2, severity: 'medium', status: 'open', title: 'Mass assignment' },
  { id: 3, severity: 'high', status: 'resolved', title: 'Open redirect' },
];

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
    },
  );

const out = await mkdtemp(join(tmpdir(), 'fix-security-'));
afterAll(() => rm(out, { recursive: true, force: true }));

// A claude/ branch with the given commit subjects on top of main. The reviewed commit (HEAD_SHA) is HEAD by default;
// main stands for an older one
async function check({ comments = [review(FINDINGS)], subjects = ['feat: x'], env = {} } = {}) {
  const findings = join(out, `${Math.random()}.json`);
  const result = await runScript('fix-security/check.sh', {
    env: {
      PR_NUMBER: '7',
      FIX_ON: 'high',
      MAX: '2',
      BASE: 'main',
      FINDINGS: findings,
      HEAD_SHA: 'HEAD',
      LANGUAGE: 'en',
      ...env,
    },
    gh: [{ match: 'issues/7/comments', stdout: comments }],
    setup: async (dir) => {
      const repo = join(dir, 'repo');
      await mkdir(repo);
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
      git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
      git(repo, 'checkout', '-q', '-b', 'claude/1-fix');
      for (const subject of subjects) git(repo, 'commit', '-q', '--allow-empty', '-m', subject);
      return repo;
    },
  });
  expect(unmatchedReads(result)).toStrictEqual([]);
  const written = async () => JSON.parse(await readFile(findings, 'utf8'));
  return { ...result, written };
}

test('fixes the open findings at fix-on or above, and writes only those', async () => {
  const high = await check();
  expect(high.outputs.fix).toBe('true');
  expect((await high.written()).map((finding) => finding.id)).toEqual([1]);

  const medium = await check({ env: { FIX_ON: 'medium' } });
  expect((await medium.written()).map((finding) => finding.id)).toEqual([1, 2]);
});

test('does not fix without open findings at fix-on, or without a review comment', async () => {
  expect((await check({ comments: [review([FINDINGS[1], FINDINGS[2]])] })).outputs.fix).toBe('false');
  expect((await check({ comments: [] })).outputs.fix).toBe('false');
  // A comment someone else wrote with the marker is not read
  const forged = { ...review(FINDINGS), user: { login: 'dev' } };
  expect((await check({ comments: [forged] })).outputs.fix).toBe('false');
});

test('leaves a commit the branch moved past to the newer run', async () => {
  const result = await check({ env: { HEAD_SHA: 'main' } });
  expect(result.outputs.fix).toBe('false');
  expect(result.stdout).toContain('moved past the reviewed commit');
  expect(result.calls).toEqual([]);
});

test('stops after max-attempts fix commits, and says so once', async () => {
  const subjects = ['feat: x', 'fix: a [security-fix]', 'fix: b [security-fix]'];
  const limit = await check({ subjects });
  expect(limit.outputs.fix).toBe('false');
  const comment = callsTo(limit, 'gh').find((call) => call.startsWith('pr comment 7'));
  expect(comment).toContain('still open after 2 automatic fix attempts');
  expect(comment).toContain(LIMIT);

  const told = await check({
    subjects,
    comments: [review(FINDINGS), { user: { login: 'github-actions[bot]' }, body: LIMIT }],
  });
  expect(told.outputs.fix).toBe('false');
  expect(callsTo(told, 'gh').some((call) => call.startsWith('pr comment'))).toBe(false);

  // One attempt left
  expect((await check({ subjects: subjects.slice(0, 2) })).outputs.fix).toBe('true');
});

test('rejects an invalid fix-on or max-attempts', async () => {
  const fixOn = await check({ env: { FIX_ON: 'critical' } });
  expect(fixOn.code).toBe(1);
  expect(fixOn.stdout).toContain('Invalid fix-security-on value: critical');
  expect((await check({ env: { MAX: '1.5' } })).code).toBe(1);
});
