import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { callsTo, runScript, unmatchedReads } from './fakes.js';

const MARKER = '<!-- claude-security-review -->';
const COMMENTS = 'issues/7/comments';

const bot = (body, id = 11) => ({ id, user: { login: 'github-actions[bot]' }, body });
const state = (digest, failOn = 'high') => `<!-- claude-security-review-state: diff=${digest} fail-on=${failOn} -->`;

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

async function write(repo, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(repo, file, '..'), { recursive: true });
    await writeFile(join(repo, file), content);
  }
}

// A repository whose main branch has `base` and whose pull request branch (checked out) adds `pr` on top of it.
// `steps` then run on the repository (to move main or update the pull request) before origin/main is set.
function repository({ base = { 'app/User.php': 'user\n' }, pr = {}, steps = [] } = {}) {
  return async (dir) => {
    const repo = join(dir, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await write(repo, base);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'pr');
    await write(repo, pr);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'pr');
    for (const step of steps) await step(repo);
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    return repo;
  };
}

// Commits `files` to main and merges main into the pull request, like the Update branch button
const updateBranch = (files) => async (repo) => {
  git(repo, 'checkout', '-q', 'main');
  await write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'main moves');
  git(repo, 'checkout', '-q', 'pr');
  git(repo, 'merge', '-q', '--no-edit', 'main');
};

const check = ({ env = {}, gh = [], ...options } = {}) =>
  runScript('security-review/check.sh', {
    env: { PR_NUMBER: '7', BASE: 'main', FAIL_ON: 'high', RUN_ATTEMPT: '1', ...env },
    gh: [...gh, { match: COMMENTS, stdout: [] }],
    ...options,
  });

describe('check', () => {
  test('rejects an invalid fail-on before anything else', async () => {
    const result = await check({ env: { FAIL_ON: 'critical' } });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Invalid fail-on value: critical');
    expect(result.outputs).toEqual({});
  });

  test.each([
    ['high', '["high"]'],
    ['medium', '["high", "medium"]'],
    ['low', '["high", "medium", "low"]'],
    ['none', '[]'],
  ])('fail-on %s fails on %s', async (failOn, levels) => {
    const result = await check({ env: { FAIL_ON: failOn, WORKFLOW_CHANGED: 'true' } });

    expect(result.outputs.levels).toBe(levels);
  });

  test('does not review a pull request that changes the workflow file', async () => {
    const result = await check({ env: { WORKFLOW_CHANGED: 'true' } });

    expect(result.code).toBe(0);
    expect(result.outputs.review).toBe('false');
    expect(result.calls).toEqual([]);
  });

  test('does not review a pull request that changes only documentation', async () => {
    const result = await check({ setup: repository({ pr: { 'README.md': 'docs\n', 'docs/setup.md': 'more\n' } }) });

    expect(result.code).toBe(0);
    expect(result.outputs).toMatchObject({ 'docs-only': 'true', review: 'false' });
    expect(result.calls).toEqual([]);
  });

  test.each(['.github/security-review.md', 'CLAUDE.md', 'resources/views/help.md', 'app/README.md/x.php'])(
    'reviews %s as code',
    async (file) => {
      const result = await check({ setup: repository({ pr: { 'README.md': 'docs\n', [file]: 'text\n' } }) });

      expect(result.outputs).toMatchObject({ 'docs-only': 'false', review: 'true' });
    },
  );

  test('reviews code renamed to a Markdown file as code', async () => {
    const rename = (repo) => {
      git(repo, 'mv', 'app/notes.php', 'notes.md');
      git(repo, 'commit', '-q', '-m', 'rename');
    };
    const setup = repository({ base: { 'app/User.php': 'user\n', 'app/notes.php': 'notes\n' }, steps: [rename] });

    const result = await check({ setup });

    expect(result.outputs).toMatchObject({ 'docs-only': 'false', review: 'true' });
  });

  test('treats the deletion of a Markdown file as documentation', async () => {
    const remove = (repo) => {
      git(repo, 'rm', '-q', 'SECURITY.md');
      git(repo, 'commit', '-q', '-m', 'remove');
    };
    const setup = repository({ base: { 'app/User.php': 'user\n', 'SECURITY.md': 'x\n' }, steps: [remove] });

    const result = await check({ setup });

    expect(result.outputs).toMatchObject({ 'docs-only': 'true', review: 'false' });
  });

  test('reviews code without an earlier review and outputs the digest of its changes', async () => {
    const result = await check({ setup: repository({ pr: { 'app/User.php': 'changed\n' } }) });

    expect(result.code).toBe(0);
    expect(result.outputs.review).toBe('true');
    expect(result.outputs.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.outputs.reused).toBeUndefined();
    expect(unmatchedReads(result)).toEqual([]);
  });

  test('keeps the last passing review of the same changes', async () => {
    const setup = repository({ pr: { 'app/User.php': 'changed\n' } });
    const { outputs } = await check({ setup });

    const result = await check({
      setup,
      gh: [
        {
          match: COMMENTS,
          stdout: [bot('earlier', 10), bot(`## Security review\n\n${state(outputs.digest)}\n${MARKER}`)],
        },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.outputs).toMatchObject({ reused: 'true', review: 'false', digest: outputs.digest });
  });

  test('ignores a state line written by someone else than the bot', async () => {
    const setup = repository({ pr: { 'app/User.php': 'changed\n' } });
    const { outputs } = await check({ setup });

    const result = await check({
      setup,
      gh: [
        { match: COMMENTS, stdout: [{ id: 1, user: { login: 'dev' }, body: `${state(outputs.digest)}\n${MARKER}` }] },
      ],
    });

    expect(result.outputs.review).toBe('true');
  });

  test('reviews again when fail-on changed', async () => {
    const setup = repository({ pr: { 'app/User.php': 'changed\n' } });
    const { outputs } = await check({ setup });

    const result = await check({
      setup,
      env: { FAIL_ON: 'medium' },
      gh: [{ match: COMMENTS, stdout: [bot(`${state(outputs.digest, 'high')}\n${MARKER}`)] }],
    });

    expect(result.outputs.review).toBe('true');
  });

  test('reviews again on a manual re-run without reading the comments', async () => {
    const result = await check({
      setup: repository({ pr: { 'app/User.php': 'changed\n' } }),
      env: { RUN_ATTEMPT: '2' },
    });

    expect(result.outputs.review).toBe('true');
    expect(callsTo(result, 'gh')).toEqual([]);
  });

  test('keeps the digest when the branch is updated with a base change to another file', async () => {
    const before = await check({ setup: repository({ pr: { 'app/User.php': 'changed\n' } }) });
    const after = await check({
      setup: repository({ pr: { 'app/User.php': 'changed\n' }, steps: [updateBranch({ 'app/Order.php': 'order\n' })] }),
    });

    expect(after.outputs.digest).toBe(before.outputs.digest);
  });

  test('changes the digest when the base changes a file the pull request also changes', async () => {
    const base = { 'app/User.php': 'a\nb\nc\nd\ne\n' };
    const before = await check({ setup: repository({ base, pr: { 'app/User.php': 'a\nb\nc\nd\nchanged\n' } }) });
    const after = await check({
      setup: repository({
        base,
        pr: { 'app/User.php': 'a\nb\nc\nd\nchanged\n' },
        steps: [updateBranch({ 'app/User.php': 'base\nb\nc\nd\ne\n' })],
      }),
    });

    expect(after.outputs.digest).not.toBe(before.outputs.digest);
  });

  test('changes the digest when a push changes the code', async () => {
    const before = await check({ setup: repository({ pr: { 'app/User.php': 'changed\n' } }) });
    const after = await check({ setup: repository({ pr: { 'app/User.php': 'changed again\n' } }) });

    expect(after.outputs.digest).not.toBe(before.outputs.digest);
  });

  test('fails without skipping when git cannot compare with the base, after writing the levels', async () => {
    const result = await check({
      setup: repository({ pr: { 'app/User.php': 'changed\n' } }),
      env: { BASE: 'missing' },
    });

    expect(result.code).not.toBe(0);
    expect(result.outputs.levels).toBe('["high"]');
    expect(result.outputs.review).toBeUndefined();
  });

  test('fails when the comments cannot be read', async () => {
    const result = await check({
      setup: repository({ pr: { 'app/User.php': 'changed\n' } }),
      gh: [{ match: COMMENTS, code: 1, stderr: 'HTTP 502' }],
    });

    expect(result.code).not.toBe(0);
    expect(result.outputs.review).toBeUndefined();
  });
});

const FINDING = {
  severity: 'medium',
  title: 'Mass assignment',
  file: 'app/User.php',
  line: 3,
  category: 'mass-assignment',
  description: 'Every attribute is fillable.',
  recommendation: 'List the fillable attributes.',
};

// findings: the content of the findings file (an object is written as JSON; undefined writes none)
async function publish({ env = {}, gh = [], findings } = {}) {
  return runScript('security-review/publish.sh', {
    env: {
      PR_NUMBER: '7',
      FAIL_ON: 'high',
      LEVELS: '["high"]',
      GITHUB_RUN_ID: '99',
      FINDINGS: 'findings.json',
      DIGEST: 'f'.repeat(64),
      ...env,
    },
    gh: [...gh, { match: COMMENTS, stdout: [] }],
    setup: async (dir) => {
      if (findings !== undefined)
        await writeFile(join(dir, 'findings.json'), typeof findings === 'string' ? findings : JSON.stringify(findings));
    },
  });
}

// The body of the comment the run created or updated
function posted(result) {
  const call = result.calls.find(
    ([, ...args]) => (args[0] === 'pr' && args[1] === 'comment') || args.includes('PATCH'),
  );
  if (!call) return undefined;
  const args = call.slice(1);
  const body = args.includes('--body') ? args[args.indexOf('--body') + 1] : args.find((arg) => arg.startsWith('body='));
  return body.replace(/^body=/, '');
}

describe('publish', () => {
  test('fails a pull request that changes the workflow file and says so', async () => {
    const result = await publish({
      env: { WORKFLOW_CHANGED: 'true', WORKFLOW_FILE: '.github/workflows/datalogix.yml' },
    });

    expect(result.code).toBe(1);
    expect(posted(result)).toContain('Este PR altera `.github/workflows/datalogix.yml`');
    expect(posted(result)).toContain('[Ver execução](https://github.com/datalogix/app/actions/runs/99)');
    expect(posted(result)).toContain(MARKER);
  });

  test('passes a pull request that changes only documentation', async () => {
    const result = await publish({ env: { DOCS_ONLY: 'true' } });

    expect(result.code).toBe(0);
    expect(posted(result)).toContain('altera só documentação');
    expect(result.summary).toContain('Only documentation changed');
  });

  test('passes a kept review without touching the comment', async () => {
    const result = await publish({ env: { REUSED: 'true' } });

    expect(result.code).toBe(0);
    expect(callsTo(result, 'gh')).toEqual([]);
    expect(result.summary).toContain('same as in the last passing review');
  });

  test.each([
    ['without a findings file', undefined],
    ['with an invalid findings file', '{"findings": "none"}'],
  ])('fails %s and says the review did not finish', async (_, findings) => {
    const result = await publish({ findings });

    expect(result.code).toBe(1);
    expect(posted(result)).toContain('A revisão de segurança não terminou');
    expect(posted(result)).not.toContain('claude-security-review-state');
  });

  test('passes findings below fail-on, writes the state line and updates the existing comment', async () => {
    const result = await publish({
      findings: { summary: 'One problem.', findings: [FINDING] },
      gh: [{ match: COMMENTS, stdout: [bot('other comment', 5), bot(`old\n${MARKER}`, 12)] }],
    });

    expect(result.code).toBe(0);
    expect(result.outputs.blocking).toBe('0');
    expect(
      callsTo(result, 'gh').some((call) => call.includes('--method PATCH repos/datalogix/app/issues/comments/12')),
    ).toBe(true);
    const body = posted(result);
    expect(body).toContain('### 🟠 Mass assignment');
    expect(body).toContain('`app/User.php:3` · medium · mass-assignment');
    expect(body).toContain(`${state('f'.repeat(64))}\n${MARKER}`);
    expect(body).not.toContain('bloqueado');
    expect(result.summary).toContain('1 finding(s), 0 at or above `high`.');
  });

  test('fails findings at fail-on without a state line', async () => {
    const result = await publish({
      env: { FAIL_ON: 'medium', LEVELS: '["high", "medium"]' },
      findings: { summary: 'One problem.', findings: [FINDING] },
    });

    expect(result.code).toBe(1);
    expect(result.outputs.blocking).toBe('1');
    expect(posted(result)).toContain('Este PR está bloqueado');
    expect(posted(result)).not.toContain('claude-security-review-state');
  });

  test('counts an unknown severity as high', async () => {
    const result = await publish({ findings: { summary: 'S.', findings: [{ ...FINDING, severity: 'Critical' }] } });

    expect(result.code).toBe(1);
    expect(posted(result)).toContain('### 🔴 Mass assignment');
  });

  test('writes no state line without a digest', async () => {
    const result = await publish({ env: { DIGEST: '' }, findings: { summary: 'Fine.', findings: [] } });

    expect(result.code).toBe(0);
    expect(posted(result)).toContain('Nenhum problema de segurança encontrado');
    expect(posted(result)).not.toContain('claude-security-review-state');
  });

  test('writes the fixed texts in English for an English team', async () => {
    const result = await publish({ env: { LANGUAGE: 'en' }, findings: { summary: 'Fine.', findings: [] } });

    expect(posted(result)).toContain('## Security review');
    expect(posted(result)).toContain('No security problems found');
    expect(posted(result)).toContain('[View run](https://github.com/datalogix/app/actions/runs/99)');
  });
});
