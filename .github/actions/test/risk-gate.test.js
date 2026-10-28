import { expect, test } from 'vitest';
import { callsTo, runScript, unmatchedReads } from './fakes.js';

const HEAD = 'a'.repeat(40);
const EARLIER = 'b'.repeat(40);

const SETTINGS = {
  PR: '7',
  HIGH_PATHS: 'database/migrations/*\ncomposer.json\n.github/*\n',
  LOW_PATHS: 'tests/*\n*.md\n',
  IGNORED_PATHS: 'composer.lock\npublic/build/*\n',
  HIGH_LINES: '600',
  APPROVALS_LOW: '0',
  APPROVALS_MEDIUM: '1',
  APPROVALS_HIGH: '1',
  COUNT_AUTHOR: 'false',
  PREFIX: 'risk:',
};

const pull = (overrides = {}) => ({
  head: { sha: HEAD },
  base: { ref: 'main' },
  user: { login: 'dev', type: 'User' },
  author_association: 'MEMBER',
  labels: [],
  ...overrides,
});

const review = (login, state, commit = HEAD, at = '2026-10-01T10:00:00Z') => ({
  user: { login, type: 'User' },
  state,
  commit_id: commit,
  submitted_at: at,
  author_association: 'MEMBER',
});

// A file changed by the pull request, as the files of the pull request and of a comparison list it
const change = (filename, patch, changes = 1, sha = 'c'.repeat(40)) => ({
  filename,
  status: 'modified',
  additions: changes,
  deletions: 0,
  changes,
  sha,
  ...(patch ? { patch } : {}),
});

// files: the pull request's files, as [filename, changes, previous filename] or as a change().
// permissions: { login: permission } for users without write access (everyone else has it); null makes the lookup fail,
// a rule ({ code, stderr, stdout }) answers it as given.
// compares: { sha: files } answers the comparison between the base and that commit; null makes it fail.
// trees: { sha: tree } answers the tree of that commit (by default an empty one); null makes it fail.
// base: the base branch of the pull request, which the comparisons are answered for (encoded, as in the API path).
async function gate({
  files,
  reviews = [],
  base = 'main',
  pr = pull({ base: { ref: base } }),
  env = {},
  permissions = {},
  compares = {},
  trees = {},
}) {
  const encodedBase = encodeURIComponent(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = await runScript('risk-gate/risk-gate.sh', {
    env: { ...SETTINGS, ...env },
    gh: [
      ...Object.entries(permissions).map(([login, permission]) =>
        permission === null
          ? { match: `collaborators/${login}/permission`, code: 1, stderr: 'HTTP 502' }
          : typeof permission === 'object'
            ? { match: `collaborators/${login}/permission`, ...permission }
            : { match: `collaborators/${login}/permission`, stdout: { permission } },
      ),
      { match: 'collaborators/.*/permission', stdout: { permission: 'write' } },
      {
        match: 'pulls/7/files',
        stdout: files.map((file) => {
          if (!Array.isArray(file)) return file;
          const [filename, changes, previous] = file;
          return { filename, additions: changes, deletions: 0, ...(previous ? { previous_filename: previous } : {}) };
        }),
      },
      { match: 'pulls/7/reviews', stdout: reviews },
      ...Object.entries(compares).map(([sha, changes]) =>
        changes === null
          ? { match: `compare/${encodedBase}\\.\\.\\.${sha}$`, code: 1, stderr: 'HTTP 404' }
          : { match: `compare/${encodedBase}\\.\\.\\.${sha}$`, stdout: { files: changes } },
      ),
      ...Object.entries(trees).map(([sha, tree]) =>
        tree === null
          ? { match: `git/trees/${sha}`, code: 1, stderr: 'HTTP 502' }
          : { match: `git/trees/${sha}`, stdout: tree },
      ),
      { match: 'git/trees/', stdout: { truncated: false, tree: [] } },
      { match: 'pulls/7$', stdout: pr },
    ],
  });
  expect(unmatchedReads(result)).toStrictEqual([]);
  return result;
}

test('a pull request that only touches low-risk paths needs no approval', async () => {
  const result = await gate({
    files: [
      ['tests/Feature/UserTest.php', 40],
      ['README.md', 3],
    ],
  });
  expect(result.code).toBe(0);
  expect(result.summary).toMatch(/### Risk: low/);
  expect(callsTo(result, 'gh')).toContain('pr edit 7 --repo datalogix/app --add-label risk:low');
});

test('application code is medium risk and needs one approval of the current changes', async () => {
  const files = [change('app/Models/User.php', '@@ -1,2 +1,3 @@\n a\n+b\n+c', 10)];
  expect((await gate({ files })).code).toBe(1);
  expect((await gate({ files, reviews: [review('ana', 'APPROVED')] })).code).toBe(0);

  const earlier = { [EARLIER]: [change('app/Models/User.php', '@@ -1,2 +1,2 @@\n a\n+b')] };
  expect((await gate({ files, reviews: [review('ana', 'APPROVED', EARLIER)], compares: earlier })).code).toBe(1);
});

test('a lock file alone is medium risk, but its lines are not counted', async () => {
  const result = await gate({ files: [['composer.lock', 5000]] });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/### Risk: medium/);
  expect(result.summary).toMatch(/Changed lines considered: 0/);
});

test('high-risk paths and large changes are high risk', async () => {
  const migration = await gate({ files: [['database/migrations/2026_10_01_create_orders.php', 20]] });
  expect(migration.summary).toMatch(/### Risk: high/);
  expect(migration.summary).toMatch(/`database\/migrations\/2026_10_01_create_orders.php` is a high-risk path/);

  const large = await gate({ files: [['app/Services/Billing.php', 650]] });
  expect(large.summary).toMatch(/### Risk: high/);
  expect(large.summary).toMatch(/650 changed lines \(limit 600\)/);
});

test('high-risk paths match without surrounding spaces or a Windows line ending', async () => {
  const result = await gate({
    env: { HIGH_PATHS: '  database/migrations/* \r\ncomposer.json\r\n' },
    files: [['database/migrations/2026_10_01_create_orders.php', 20]],
  });
  expect(result.summary).toMatch(/### Risk: high/);
});

test('only the latest human decision counts, and bots never count', async () => {
  const files = [['app/Models/User.php', 10]];
  const changed = [
    review('ana', 'APPROVED', HEAD, '2026-10-01T10:00:00Z'),
    review('ana', 'CHANGES_REQUESTED', HEAD, '2026-10-01T11:00:00Z'),
  ];
  expect((await gate({ files, reviews: changed })).code).toBe(1);

  const bot = { ...review('claude[bot]', 'APPROVED'), user: { login: 'claude[bot]', type: 'Bot' } };
  expect((await gate({ files, reviews: [bot] })).code).toBe(1);
});

test('rejects a number of approvals or lines that is not whole', async () => {
  const files = [['database/migrations/2026_10_01_create_orders.php', 20]];
  const approvals = await gate({ files, env: { APPROVALS_HIGH: '1.5' } });
  expect(approvals.code).toBe(1);
  expect(approvals.stdout).toMatch(/approvals-high must be a whole number of at least 0, got '1\.5'/);

  const lines = await gate({ files, env: { HIGH_LINES: '0' } });
  expect(lines.code).toBe(1);
  expect(lines.stdout).toMatch(/high-risk-lines must be a whole number of at least 1, got '0'/);
});

test('a reviewer who approves twice counts once', async () => {
  const result = await gate({
    files: [['database/migrations/2026_10_01_create_orders.php', 20]],
    env: { APPROVALS_HIGH: '2' },
    reviews: [
      review('ana', 'APPROVED', HEAD, '2026-10-01T10:00:00Z'),
      review('ana', 'APPROVED', HEAD, '2026-10-01T11:00:00Z'),
    ],
  });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/Human approvals of the current changes: 1 of 2 \(ana\)$/m);
});

test('a dismissed approval does not count', async () => {
  const result = await gate({ files: [['app/Models/User.php', 10]], reviews: [review('ana', 'DISMISSED')] });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/Human approvals of the current changes: 0 of 1$/m);
});

test('a later dismissed review cancels an earlier approval by the same user', async () => {
  const result = await gate({
    files: [['app/Models/User.php', 10]],
    reviews: [
      review('ana', 'APPROVED', HEAD, '2026-10-01T10:00:00Z'),
      review('ana', 'DISMISSED', HEAD, '2026-10-01T11:00:00Z'),
    ],
  });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/Human approvals of the current changes: 0 of 1$/m);
});

test('a comment after an approval does not withdraw it', async () => {
  const result = await gate({
    files: [['app/Models/User.php', 10]],
    reviews: [
      review('ana', 'APPROVED', HEAD, '2026-10-01T10:00:00Z'),
      review('ana', 'COMMENTED', HEAD, '2026-10-01T11:00:00Z'),
    ],
  });
  expect(result.code).toBe(0);
});

test('count-author counts a human author, never a bot', async () => {
  const files = [['app/Models/User.php', 10]];
  const env = { COUNT_AUTHOR: 'true' };
  const human = await gate({ files, env });
  expect(human.code).toBe(0);
  expect(human.summary).toMatch(/1 of 1 \(dev \(author\)\)/);

  const claude = await gate({ files, env, pr: pull({ user: { login: 'claude[bot]', type: 'Bot' } }) });
  expect(claude.code).toBe(1);
});

test('keeps exactly one risk label', async () => {
  const result = await gate({ files: [['app/Models/User.php', 10]], pr: pull({ labels: [{ name: 'risk:low' }] }) });
  const edits = callsTo(result, 'gh').filter((call) => call.startsWith('pr edit'));
  expect(edits).toStrictEqual([
    'pr edit 7 --repo datalogix/app --remove-label risk:low',
    'pr edit 7 --repo datalogix/app --add-label risk:medium',
  ]);
});

test('describes the risk label in the language of the project', async () => {
  const created = async (env) =>
    callsTo(await gate({ files: [['app/Models/User.php', 10]], env }), 'gh').find((call) =>
      call.startsWith('label create'),
    );
  expect(await created({})).toMatch(/^label create risk:medium .*--description Risco das mudanças: medium$/);
  expect(await created({ LANGUAGE: 'en' })).toMatch(/--description Risk of the changes: medium$/);
});

test('approvals and authors without write access do not count', async () => {
  const files = [['app/Models/User.php', 10]];
  const reader = await gate({
    files,
    reviews: [review('guest', 'APPROVED')],
    permissions: { guest: 'read' },
  });
  expect(reader.code).toBe(1);
  expect(reader.summary).toMatch(/Human approvals of the current changes: 0 of 1$/m);

  const author = await gate({ files, env: { COUNT_AUTHOR: 'true' }, permissions: { dev: 'triage' } });
  expect(author.code).toBe(1);
  expect((await gate({ files, env: { COUNT_AUTHOR: 'true' } })).code).toBe(0);
});

test('counts a member with write access whatever author_association GitHub shows', async () => {
  const files = [['app/Models/User.php', 10]];
  const reviewer = await gate({
    files,
    reviews: [{ ...review('ana', 'APPROVED'), author_association: 'CONTRIBUTOR' }],
  });
  expect(reviewer.code).toBe(0);
  expect(reviewer.summary).toMatch(/Human approvals of the current changes: 1 of 1 \(ana\)$/m);

  const author = await gate({ files, env: { COUNT_AUTHOR: 'true' }, pr: pull({ author_association: 'NONE' }) });
  expect(author.code).toBe(0);
});

test('an approval whose permission cannot be read does not count', async () => {
  const result = await gate({
    files: [['app/Models/User.php', 10]],
    reviews: [review('ana', 'APPROVED')],
    permissions: { ana: null },
  });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/Human approvals of the current changes: 0 of 1$/m);
  expect(result.summary).toMatch(/Not counted, GitHub did not answer their permission: ana \(run the gate again\)/);
  expect(result.stdout).toMatch(/::warning::Could not read the permission of ana: .*HTTP 502/);
});

test('an approver without access to the repository does not count and needs no new run', async () => {
  const result = await gate({
    files: [['app/Models/User.php', 10]],
    reviews: [review('former', 'APPROVED')],
    permissions: { former: { code: 1, stderr: 'gh: Not Found (HTTP 404)' } },
  });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/Human approvals of the current changes: 0 of 1$/m);
  expect(result.summary).not.toMatch(/run the gate again/);
  expect(result.stdout).not.toMatch(/::warning::/);
});

test('a notice gh prints with the permission does not change it', async () => {
  const result = await gate({
    files: [['app/Models/User.php', 10]],
    reviews: [review('ana', 'APPROVED')],
    permissions: { ana: { stdout: { permission: 'write' }, stderr: 'A new release of gh is available' } },
  });
  expect(result.code).toBe(0);
});

test('a high-risk file renamed to a low-risk path is still high risk', async () => {
  const result = await gate({ files: [['tests/old_migration.php', 0, 'database/migrations/2026_create_users.php']] });
  expect(result.summary).toMatch(/### Risk: high/);
  expect(result.summary).toMatch(
    /`database\/migrations\/2026_create_users.php → tests\/old_migration.php` is a high-risk path/,
  );
});

test('a medium-risk file renamed to a low-risk path is still medium risk', async () => {
  const result = await gate({ files: [['tests/Foo.php', 0, 'app/Foo.php']] });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/### Risk: medium/);
});

test('exactly the line limit is high risk', async () => {
  const result = await gate({ files: [['app/Services/Billing.php', 600]] });
  expect(result.summary).toMatch(/### Risk: high/);
  expect(result.summary).toMatch(/600 changed lines \(limit 600\)/);
});

test('a pull request with more files than the API lists is high risk', async () => {
  const result = await gate({ files: [['README.md', 1]], pr: pull({ changed_files: 3001 }) });
  expect(result.summary).toMatch(/### Risk: high/);
  expect(result.summary).toMatch(/3001 changed files/);
});

test('an approval of an earlier commit with other changes does not count', async () => {
  const result = await gate({
    files: [change('app/Models/User.php', '@@ -1,2 +1,3 @@\n a\n+b\n+c')],
    reviews: [review('ana', 'APPROVED', EARLIER)],
    compares: { [EARLIER]: [change('app/Models/User.php', '@@ -1,2 +1,2 @@\n a\n+b')] },
  });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/Human approvals of the current changes: 0 of 1$/m);
});

test('an approval survives a merge or rebase that keeps the changes in place', async () => {
  const same = [change('app/Models/User.php', '@@ -40,2 +40,3 @@ class User\n a\n+b')];
  const result = await gate({
    files: same,
    reviews: [review('ana', 'APPROVED', EARLIER)],
    compares: { [EARLIER]: same },
  });
  expect(result.code).toBe(0);
  expect(result.summary).toMatch(/1 of 1 \(ana \(bbbbbbb, same changes\)\)$/m);
});

test('an approval of an earlier commit does not count when the same lines are elsewhere', async () => {
  const moved = (position, header) =>
    gate({
      files: [change('app/Models/User.php', `@@ -40,2 +40,3 @@ ${header}\n a\n+b`)],
      reviews: [review('ana', 'APPROVED', EARLIER)],
      compares: {
        [EARLIER]: [change('app/Models/User.php', `@@ -${position},2 +${position},3 @@ class User\n a\n+b`)],
      },
    });
  // Another position in the same function (PHP's default diff driver often names only the class)
  expect((await moved(1, 'class User')).code).toBe(1);
  // Another function
  expect((await moved(40, 'public function update()')).code).toBe(1);
});

test('an approval of an earlier commit does not count when a file mode changed since', async () => {
  const script = [change('scripts/deploy.sh', '@@ -1,2 +1,3 @@\n a\n+b')];
  const tree = (mode) => ({ truncated: false, tree: [{ path: 'scripts/deploy.sh', mode, type: 'blob' }] });
  const result = await gate({
    files: script,
    reviews: [review('ana', 'APPROVED', EARLIER)],
    compares: { [EARLIER]: script },
    trees: { [HEAD]: tree('100755'), [EARLIER]: tree('100644') },
  });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/Human approvals of the current changes: 0 of 1$/m);
});

test('an approval of an earlier commit does not count when a binary file changed since', async () => {
  const result = await gate({
    files: [change('public/logo.png', null, 0, 'd'.repeat(40))],
    reviews: [review('ana', 'APPROVED', EARLIER)],
    compares: { [EARLIER]: [change('public/logo.png', null, 0, 'e'.repeat(40))] },
  });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/Human approvals of the current changes: 0 of 1$/m);
});

test('an approval of an earlier commit counts when a binary file is the same', async () => {
  const logo = [change('public/logo.png', null, 0)];
  const result = await gate({
    files: logo,
    reviews: [review('ana', 'APPROVED', EARLIER)],
    compares: { [EARLIER]: logo },
  });
  expect(result.code).toBe(0);
});

test('the base branch is encoded in the comparison', async () => {
  const same = [change('app/Models/User.php', '@@ -1,2 +1,3 @@\n a\n+b')];
  // Only the comparison with release%232 is answered: any other is a read no rule matched
  const result = await gate({
    base: 'release#2',
    files: same,
    reviews: [review('ana', 'APPROVED', EARLIER)],
    compares: { [EARLIER]: same },
  });
  expect(result.code).toBe(0);
  expect(callsTo(result, 'gh')).toContainEqual(expect.stringContaining(`/compare/release%232...${EARLIER} `));
});

test('each commit is compared once, and only when an approval is of an earlier commit', async () => {
  const same = [change('app/Models/User.php', '@@ -1,2 +1,3 @@\n a\n+b')];
  const result = await gate({
    env: { APPROVALS_MEDIUM: '2' },
    files: same,
    reviews: [review('ana', 'APPROVED', EARLIER), review('bia', 'APPROVED', EARLIER), review('caio', 'APPROVED')],
    compares: { [EARLIER]: same },
  });
  expect(result.code).toBe(0);
  const calls = callsTo(result, 'gh');
  // The current changes come from the pull request's files, which are read anyway
  expect(calls.filter((call) => call.includes('/compare/'))).toStrictEqual([
    `api repos/datalogix/app/compare/main...${EARLIER} --jq if (.files | length) >= 300 then empty else .files end`,
  ]);
  expect(calls.filter((call) => call.includes(`git/trees/${HEAD}`))).toHaveLength(1);
  expect(calls.filter((call) => call.includes(`git/trees/${EARLIER}`))).toHaveLength(1);

  const current = await gate({ files: same, reviews: [review('ana', 'APPROVED')] });
  expect(callsTo(current, 'gh').filter((call) => /\/compare\/|git\/trees/.test(call))).toStrictEqual([]);
});

test('an earlier approval does not count when the changes cannot be compared', async () => {
  const reviews = [review('ana', 'APPROVED', EARLIER)];
  const same = [change('app/Models/User.php', '@@ -1,2 +1,3 @@\n a\n+b')];

  // GitHub leaves out the patch of a large file
  const large = [change('app/Models/User.php', null, 5000)];
  expect((await gate({ files: large, reviews, compares: { [EARLIER]: large } })).code).toBe(1);

  const many = Array.from({ length: 300 }, (_, i) => change(`app/File${i}.php`, '@@ -1 +1 @@\n+x'));
  expect((await gate({ files: many, reviews, compares: { [EARLIER]: many } })).code).toBe(1);

  expect((await gate({ files: same, reviews, compares: { [EARLIER]: null } })).code).toBe(1);

  const truncated = { [HEAD]: { truncated: true, tree: [] }, [EARLIER]: { truncated: true, tree: [] } };
  expect((await gate({ files: same, reviews, compares: { [EARLIER]: same }, trees: truncated })).code).toBe(1);
  expect((await gate({ files: same, reviews, compares: { [EARLIER]: same }, trees: { [EARLIER]: null } })).code).toBe(
    1,
  );
});

test('an approval of an earlier commit does not count when a file was renamed since', async () => {
  const patch = '@@ -1,2 +1,3 @@\n a\n+b';
  const result = await gate({
    files: [
      { ...change('app/Models/Account.php', patch), status: 'renamed', previous_filename: 'app/Models/User.php' },
    ],
    reviews: [review('ana', 'APPROVED', EARLIER)],
    // The same name and patch, but the earlier commit did not remove app/Models/User.php
    compares: { [EARLIER]: [change('app/Models/Account.php', patch)] },
  });
  expect(result.code).toBe(1);
  expect(result.summary).toMatch(/Human approvals of the current changes: 0 of 1$/m);
});

test('exactly as many files as the API lists is not high risk for its size', async () => {
  const result = await gate({ files: [['README.md', 1]], pr: pull({ changed_files: 3000 }) });
  expect(result.code).toBe(0);
  expect(result.summary).toMatch(/### Risk: low/);
  expect(result.summary).not.toMatch(/changed files/);
});

test('a pending review does not withdraw an approval', async () => {
  const files = [['app/Models/User.php', 10]];
  const approved = review('ana', 'APPROVED', HEAD, '2026-10-01T10:00:00Z');
  // GitHub gives a pending review no submission time; one with a later time does not count either
  for (const at of [null, '2026-10-01T11:00:00Z']) {
    const result = await gate({ files, reviews: [approved, review('ana', 'PENDING', HEAD, at)] });
    expect(result.code).toBe(0);
    expect(result.summary).toMatch(/Human approvals of the current changes: 1 of 1 \(ana\)$/m);
  }
});
