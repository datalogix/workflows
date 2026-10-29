import { expect, test } from 'vitest';
import { callsTo, runScript, unmatchedReads } from './fakes.js';

const ENV = { ENVIRONMENTS: '["production", "staging"]', TYPES: '["exception"]', LABEL: 'incident' };

const MARKER = '<!-- incident:nightwatch:42 -->';

const payload = (overrides = {}) => ({
  event: 'opened',
  provider: { id: 'nightwatch', name: 'Nightwatch' },
  issue: {
    id: '42',
    type: 'exception',
    title: 'Division by zero',
    priority: 'high',
    url: 'https://nightwatch.test/issues/42',
    details: { class: 'DivisionByZeroError', file: 'app/Services/Report.php', line: 10, message: 'Division by zero' },
  },
  environment: { name: 'Production' },
  actor: null,
  ...overrides,
});

async function sync(client_payload, { issues = [], comments = [], deploys = [], env = {}, gh = [] } = {}) {
  const result = await runScript('incident/sync.sh', {
    env: { ...ENV, ...env },
    event: { action: 'incident', client_payload },
    gh: [
      ...gh,
      // No live ref yet (GitHub answers 404) and no release rolled back by hand
      { match: 'git/ref/datalogix/live/production$', code: 1, stderr: 'HTTP 404: Not Found' },
      { match: 'matching-refs/datalogix/rolled-back/production/', stdout: [] },
      { match: '^api --paginate --method GET repos/datalogix/app/issues ', stdout: issues },
      // The search by the marker, for an issue that lost its label
      { match: '^api --method GET search/issues ', stdout: { items: issues } },
      { match: '^issue create', stdout: 'https://github.com/datalogix/app/issues/9\n' },
      { match: 'issues/\\d+/comments', stdout: comments },
      {
        match: 'matching-refs/datalogix/deploys/production/',
        stdout: deploys.map(([time, sha]) => ({ ref: `refs/datalogix/deploys/production/${time}`, object: { sha } })),
      },
    ],
  });
  expect(unmatchedReads(result)).toStrictEqual([]);
  return result;
}

test('a new problem becomes an issue with the deploy that is live', async () => {
  const result = await sync(payload(), {
    deploys: [
      [100, 'a'.repeat(40)],
      [200, 'b'.repeat(40)],
    ],
  });
  expect(result.code).toBe(0);
  expect(result.outputs).toStrictEqual({
    number: '9',
    analyze: 'true',
    live: 'b'.repeat(40),
    previous: 'a'.repeat(40),
  });

  const create = callsTo(result, 'gh').find((call) => call.startsWith('issue create'));
  expect(create).toMatch(/--title \[Nightwatch production\] Division by zero/);
  expect(create).toMatch(/\| Exceção \| `DivisionByZeroError` \|/);
  expect(create).toMatch(/\| Mudanças do último deploy \| \[`aaaaaaa\.\.\.bbbbbbb`\]/);
  expect(create).toMatch(/--label incident --label env:production$/);
  expect(create).toContain(MARKER);
  expect(create).toMatch(/\n<!-- incident-live:b{40} -->\n<!-- incident:nightwatch:42 --> --label incident/);
  expect(create).toMatch(/adicione o label `rollback` para reverter \*\*production\*\*/);
});

test('writes the issue in English when the language is English', async () => {
  const result = await sync(payload(), {
    deploys: [
      [100, 'a'.repeat(40)],
      [200, 'b'.repeat(40)],
    ],
    env: { LANGUAGE: 'en' },
  });
  const gh = callsTo(result, 'gh');
  expect(gh).toContainEqual(expect.stringMatching(/^label create incident .*--description Problem detected/));
  const create = gh.find((call) => call.startsWith('issue create'));
  expect(create).toContain('Nightwatch detected a new problem in **Production**.');
  expect(create).toMatch(/\| Exception \| `DivisionByZeroError` \|/);
  expect(create).toMatch(/add the `rollback` label to roll \*\*production\*\* back/);
  expect(create).toContain(MARKER);
});

test('does not suggest a rollback without a previous release', async () => {
  const result = await sync(payload(), { deploys: [[100, 'a'.repeat(40)]] });
  const create = callsTo(result, 'gh').find((call) => call.startsWith('issue create'));
  expect(create).toContain('label `claude`');
  expect(create).not.toContain('label `rollback`');
});

test('a problem that comes back with its issue still open only comments', async () => {
  const result = await sync(payload({ event: 'reopened' }), {
    issues: [{ number: 5, state: 'open', body: `...\n${MARKER}` }],
  });
  const gh = callsTo(result, 'gh');
  expect(gh).toContainEqual(expect.stringMatching(/^issue comment 5 /));
  expect(gh).not.toContainEqual(expect.stringMatching(/^issue reopen/));
  expect(result.outputs.number).toBe('5');
});

test('a repeated delivery for an open issue changes nothing and asks for no analysis', async () => {
  const result = await sync(payload({ event: 'opened' }), {
    issues: [{ number: 5, state: 'open', body: `...\n${MARKER}` }],
  });
  expect(result.code).toBe(0);
  expect(result.outputs).toStrictEqual({});
  expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringMatching(/^issue /));
});

test('the previous release skips the ones rolled back by hand', async () => {
  const result = await sync(payload(), {
    deploys: [
      [100, 'a'.repeat(40)],
      [200, 'b'.repeat(40)],
      [300, 'c'.repeat(40)],
    ],
    gh: [
      { match: 'git/ref/datalogix/live/production$', stdout: { object: { sha: 'a'.repeat(40) } } },
      {
        match: 'matching-refs/datalogix/rolled-back/production/',
        stdout: [{ ref: `refs/datalogix/rolled-back/production/${'c'.repeat(40)}`, object: { sha: 'c'.repeat(40) } }],
      },
    ],
  });
  expect(result.outputs.live).toBe('a'.repeat(40));
  expect(result.outputs.previous).toBe('b'.repeat(40));
});

test('a problem that comes back reopens its issue', async () => {
  const result = await sync(payload({ event: 'reopened' }), {
    issues: [{ number: 5, state: 'CLOSED', body: `...\n${MARKER}` }],
    deploys: [
      [100, 'a'.repeat(40)],
      [200, 'b'.repeat(40)],
    ],
  });
  // The analysis compares with the release live now, maybe deployed after the issue was opened
  expect(result.outputs).toStrictEqual({
    number: '5',
    analyze: 'true',
    live: 'b'.repeat(40),
    previous: 'a'.repeat(40),
  });
  const gh = callsTo(result, 'gh');
  expect(gh).toContain('issue reopen 5 --repo datalogix/app');
  expect(gh).toContain(
    `issue comment 5 --repo datalogix/app --body O problema voltou a ocorrer, segundo o Nightwatch: https://nightwatch.test/issues/42\n\n<!-- incident-live:${'b'.repeat(40)} -->`,
  );
  expect(gh).not.toContainEqual(expect.stringMatching(/^issue create/));
  expect(result.outputs.number).toBe('5');
});

const bot = (body) => ({ user: { login: 'github-actions[bot]', type: 'Bot' }, body });
const RECORDED = (sha) => `...\n<!-- incident-live:${sha} -->\n${MARKER}`;

test('a problem that comes back finds its issue with text added after the marker', async () => {
  const result = await sync(payload({ event: 'reopened' }), {
    issues: [{ number: 5, state: 'OPEN', body: `${RECORDED('b'.repeat(40))}\r\n\r\nNotes from the team` }],
    deploys: [[200, 'b'.repeat(40)]],
  });
  expect(result.outputs).toMatchObject({ number: '5', analyze: 'false' });
  expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringMatching(/^issue create/));
});

test('a problem that comes back with the release of its last analysis is not analyzed again', async () => {
  const deploys = [
    [100, 'a'.repeat(40)],
    [200, 'b'.repeat(40)],
  ];
  // Recorded in the body when the issue was opened
  const body = await sync(payload({ event: 'reopened' }), {
    issues: [{ number: 5, state: 'CLOSED', body: RECORDED('b'.repeat(40)) }],
    deploys,
  });
  expect(body.outputs).toMatchObject({ number: '5', analyze: 'false' });
  expect(callsTo(body, 'gh')).toContainEqual(
    expect.stringMatching(/^issue comment 5 .*\n\nA versão em production é a mesma da última análise/),
  );

  // Recorded by the comment of a later analysis, newer than the body
  const comment = await sync(payload({ event: 'reopened' }), {
    issues: [{ number: 5, state: 'OPEN', body: RECORDED('a'.repeat(40)) }],
    comments: [bot(`O problema voltou a ocorrer\n\n<!-- incident-live:${'b'.repeat(40)} -->`)],
    deploys,
  });
  expect(comment.outputs.analyze).toBe('false');
});

test('a problem that comes back with another release live is analyzed again', async () => {
  const result = await sync(payload({ event: 'reopened' }), {
    issues: [{ number: 5, state: 'OPEN', body: RECORDED('b'.repeat(40)) }],
    // Only comments of the workflow count
    comments: [
      bot(`O problema voltou a ocorrer\n\n<!-- incident-live:${'a'.repeat(40)} -->`),
      { user: { login: 'ana', type: 'User' }, body: `<!-- incident-live:${'b'.repeat(40)} -->` },
    ],
    deploys: [
      [100, 'a'.repeat(40)],
      [200, 'b'.repeat(40)],
    ],
  });
  expect(result.outputs).toMatchObject({ analyze: 'true', live: 'b'.repeat(40) });
});

test('a problem that comes back is analyzed again when its comments cannot be read', async () => {
  const result = await sync(payload({ event: 'reopened' }), {
    issues: [{ number: 5, state: 'OPEN', body: RECORDED('b'.repeat(40)) }],
    gh: [{ match: 'issues/5/comments', code: 1, stderr: 'HTTP 502' }],
    deploys: [[200, 'b'.repeat(40)]],
  });
  expect(result.outputs.analyze).toBe('true');
});

test('a problem that comes back comments in English when the language is English', async () => {
  const result = await sync(payload({ event: 'reopened' }), {
    issues: [{ number: 5, state: 'CLOSED', body: `...\n${MARKER}` }],
    env: { LANGUAGE: 'en' },
  });
  const gh = callsTo(result, 'gh');
  expect(gh).toContain('issue reopen 5 --repo datalogix/app');
  // No release recorded yet: an empty one, so the next time without a deploy is not analyzed again
  expect(gh).toContain(
    'issue comment 5 --repo datalogix/app --body The problem happened again, according to Nightwatch: https://nightwatch.test/issues/42\n\n<!-- incident-live: -->',
  );
  expect(result.outputs.number).toBe('5');
});

test('environments and types that are not handled are skipped', async () => {
  const local = await sync(payload({ environment: { name: 'local' } }));
  const performance = await sync(payload({ issue: { ...payload().issue, type: 'performance' } }));
  for (const result of [local, performance]) {
    expect(result.code).toBe(0);
    expect(result.outputs).toStrictEqual({});
    expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringMatching(/^issue create/));
  }
});

test('a resolved problem closes its open issue', async () => {
  const result = await sync(payload({ event: 'resolved', actor: { name: 'Ana' } }), {
    issues: [{ number: 5, state: 'OPEN', body: MARKER }],
  });
  expect(callsTo(result, 'gh')).toContain(
    'issue close 5 --repo datalogix/app --reason completed --comment Marcado como resolvido no Nightwatch por Ana.',
  );
  expect(result.outputs).toStrictEqual({});
});

test('a resolved problem closes its open issue in English when the language is English', async () => {
  const result = await sync(payload({ event: 'resolved', actor: { name: 'Ana' } }), {
    issues: [{ number: 5, state: 'OPEN', body: MARKER }],
    env: { LANGUAGE: 'en' },
  });
  expect(callsTo(result, 'gh')).toContain(
    'issue close 5 --repo datalogix/app --reason completed --comment Marked as resolved in Nightwatch by Ana.',
  );
  expect(result.outputs).toStrictEqual({});
});

test('a resolved problem without an open issue closes nothing', async () => {
  for (const issues of [[{ number: 5, state: 'closed', body: MARKER }], []]) {
    const result = await sync(payload({ event: 'resolved' }), { issues });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No open GitHub issue for this problem/);
    expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringMatching(/^issue close/));
  }
});

test('a performance issue shows its route and duration', async () => {
  const issue = {
    ...payload().issue,
    type: 'performance',
    details: { methods: ['GET', 'HEAD'], path: '/reports', duration: 4200, threshold: 1000 },
  };
  const result = await sync(payload({ issue }), { env: { TYPES: '["performance"]' } });
  expect(result.code).toBe(0);
  const create = callsTo(result, 'gh').find((call) => call.startsWith('issue create'));
  expect(create).toMatch(/\| Rota \| `GET,HEAD` `\/reports` \|/);
  expect(create).toMatch(/\| Duração \| 4200 \(limite 1000\) \|/);
});

test('a payload without a problem id fails', async () => {
  const result = await sync(payload({ issue: { type: 'exception' } }));
  expect(result.code).toBe(1);
  expect(result.stdout).toMatch(/::error::The payload has no provider or problem id/);

  const noProvider = await sync(payload({ provider: { name: 'Nightwatch' } }));
  expect(noProvider.code).toBe(1);
  expect(noProvider.stdout).toMatch(/::error::The payload has no provider or problem id/);
  expect(callsTo(noProvider, 'gh')).toStrictEqual([]);
});

test('finds the issue only by the marker at the end of its body', async () => {
  const result = await sync(payload({ event: 'resolved' }), {
    issues: [
      { number: 3, state: 'open', body: `Message quoting ${MARKER}\n<!-- incident:nightwatch:7 -->` },
      { number: 5, state: 'open', body: `...\n${MARKER}\n` },
    ],
  });
  expect(callsTo(result, 'gh')).toContainEqual(expect.stringMatching(/^issue close 5 /));
  expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringMatching(/^issue close 3 /));
});

test('a message cannot close the code block it is shown in', async () => {
  const message = 'before ```` after\n[link](https://evil.test) @someone';
  const result = await sync(payload({ issue: { ...payload().issue, details: { message } } }));
  const create = callsTo(result, 'gh').find((call) => call.startsWith('issue create'));
  expect(create).toContain(`\`\`\`\`\`text\n${message}\n\`\`\`\`\`\n`);
});

test('keeps the mark of a message the relay truncated', async () => {
  const message = 'x'.repeat(2000) + '…';
  const result = await sync(payload({ issue: { ...payload().issue, details: { message } } }));
  const create = callsTo(result, 'gh').find((call) => call.startsWith('issue create'));
  expect(create).toContain(`${message}\n\`\`\`\``);
});

test('fails on environments or types that are not JSON lists', async () => {
  const result = await sync(payload(), { env: { ENVIRONMENTS: 'production' } });
  expect(result.code).toBe(1);
  expect(result.stdout).toMatch(/environments and types must be JSON lists/);

  const notList = await sync(payload(), { env: { TYPES: '"exception"' } });
  expect(notList.code).toBe(1);
  expect(notList.stdout).toMatch(/environments and types must be JSON lists/);
});

test('an ignored problem closes its issue as not planned', async () => {
  const result = await sync(payload({ event: 'ignored' }), { issues: [{ number: 5, state: 'open', body: MARKER }] });
  expect(callsTo(result, 'gh')).toContain(
    'issue close 5 --repo datalogix/app --reason not planned --comment Marcado como ignorado no Nightwatch.',
  );
});

test('an ignored problem closes its issue as not planned in English when the language is English', async () => {
  const result = await sync(payload({ event: 'ignored' }), {
    issues: [{ number: 5, state: 'open', body: MARKER }],
    env: { LANGUAGE: 'en' },
  });
  expect(callsTo(result, 'gh')).toContain(
    'issue close 5 --repo datalogix/app --reason not planned --comment Marked as ignored in Nightwatch.',
  );
});

test('shows the live release even when it failed and stayed', async () => {
  const result = await sync(payload(), {
    deploys: [[200, 'b'.repeat(40)]],
    gh: [{ match: 'git/ref/datalogix/live/production$', stdout: { object: { sha: 'x'.repeat(40) } } }],
  });
  expect(result.outputs).toStrictEqual({
    number: '9',
    analyze: 'true',
    live: 'x'.repeat(40),
    previous: 'b'.repeat(40),
  });
});

test('finds the issue by its marker when someone removed the label', async () => {
  const issue = { number: 5, state: 'closed', body: `Problem\n${MARKER}\n` };
  const result = await sync(payload({ event: 'reopened' }), {
    issues: [issue],
    // Only the lookup by label misses it
    gh: [{ match: '^api --paginate --method GET repos/datalogix/app/issues -f labels=incident ', stdout: [] }],
  });
  expect(result.code).toBe(0);
  const gh = callsTo(result, 'gh');
  expect(gh).not.toContainEqual(expect.stringMatching(/^issue create/));
  expect(gh).toContainEqual(expect.stringMatching(/^issue reopen 5 /));
  // The label comes back, so the next event finds the issue without a search
  expect(gh).toContain('issue edit 5 --repo datalogix/app --add-label incident');
});

test('opens the issue without the releases when the history cannot be read', async () => {
  const result = await sync(payload(), {
    gh: [{ match: 'matching-refs/datalogix/deploys/production/', code: 1, stderr: 'HTTP 502: Bad Gateway' }],
  });
  expect(result.code).toBe(0);
  expect(result.outputs.number).toBe('9');
  expect(result.stdout).toMatch(/::warning::Could not read the release history of production/);
});

test('gives an untitled problem the default title, also when the title is empty', async () => {
  for (const title of [null, '']) {
    const result = await sync(payload({ issue: { ...payload().issue, title } }));
    const create = callsTo(result, 'gh').find((call) => call.startsWith('issue create'));
    expect(create).toMatch(/--title \[Nightwatch production\] Problema sem título/);
  }
});

test('searches for an issue without the label only for a problem the project handles', async () => {
  const searches = (result) =>
    callsTo(result, 'gh').filter((call) => call.startsWith('api --method GET search/issues'));
  // Handled: the issues with the label, then one search by the marker's text
  const opened = await sync(payload());
  expect(searches(opened)).toStrictEqual([
    'api --method GET search/issues -f q=repo:datalogix/app is:issue in:body "incident:nightwatch:42" -f per_page=100 --jq .items[]',
  ]);
  expect(searches(await sync(payload({ event: 'resolved' })))).toHaveLength(1);
  // Not handled (performance is not in TYPES): it never got an issue
  const performance = { ...payload().issue, type: 'performance' };
  expect(searches(await sync(payload({ issue: performance })))).toHaveLength(0);
  expect(searches(await sync(payload({ event: 'resolved', issue: performance })))).toHaveLength(0);
});

test('a repeated opened finds the open issue that lost its label and opens no second one', async () => {
  const issue = { number: 5, state: 'open', body: `Problem\n${MARKER}\n` };
  const result = await sync(payload(), {
    issues: [issue],
    gh: [{ match: '^api --paginate --method GET repos/datalogix/app/issues -f labels=incident ', stdout: [] }],
  });
  expect(result.code).toBe(0);
  expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringMatching(/^issue create/));
});

test('opens the issue when the search for one without the label keeps failing', async () => {
  const result = await sync(payload(), {
    gh: [{ match: '^api --method GET search/issues ', code: 1, stderr: 'HTTP 403: API rate limit exceeded' }],
  });
  expect(result.code).toBe(0);
  expect(callsTo(result, 'gh')).toContainEqual(expect.stringMatching(/^issue create/));
  expect(result.stdout).toMatch(/::warning::Could not search for an issue of this problem without the incident label/);
  // Its rate limit is low: tried three times, 20 seconds apart
  expect(callsTo(result, 'gh').filter((call) => call.startsWith('api --method GET search/issues'))).toHaveLength(3);
  expect(callsTo(result, 'sleep')).toStrictEqual(['20', '20']);
});

test('does not guess the live release when it cannot be read, as the deploy does not', async () => {
  const result = await sync(payload(), {
    deploys: [
      [100, 'a'.repeat(40)],
      [200, 'b'.repeat(40)],
    ],
    gh: [{ match: 'git/ref/datalogix/live/production$', code: 1, stderr: 'HTTP 502: Bad Gateway' }],
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/::warning::Could not read the live release of production/);
  expect(result.outputs).toMatchObject({ number: '9', live: '', previous: '' });
  // No release recorded: an empty one would make the next time look like the same release
  const create = callsTo(result, 'gh').find((call) => call.startsWith('issue create'));
  expect(create).toContain(MARKER);
  expect(create).not.toContain('incident-live');
});

test('a problem that comes back is analyzed again when the live release cannot be read', async () => {
  const result = await sync(payload({ event: 'reopened' }), {
    // Opened before any release was recorded: its empty release is not taken as the one live now
    issues: [{ number: 5, state: 'CLOSED', body: RECORDED('') }],
    deploys: [
      [100, 'a'.repeat(40)],
      [200, 'b'.repeat(40)],
    ],
    gh: [{ match: 'git/ref/datalogix/live/production$', code: 1, stderr: 'HTTP 502: Bad Gateway' }],
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/::warning::Could not read the live release of production/);
  expect(result.outputs).toStrictEqual({ number: '5', analyze: 'true', live: '', previous: '' });
  const gh = callsTo(result, 'gh');
  expect(gh).toContain('issue reopen 5 --repo datalogix/app');
  // Without the marker of a release, the next time is analyzed again too
  expect(gh).toContain(
    'issue comment 5 --repo datalogix/app --body O problema voltou a ocorrer, segundo o Nightwatch: https://nightwatch.test/issues/42',
  );
});

test('creates the labels of a new issue before the issue', async () => {
  const result = await sync(payload());
  const gh = callsTo(result, 'gh');
  const incident = gh.indexOf(
    'label create incident --repo datalogix/app --color 5319e7 --force --description Problema detectado pelo monitoramento',
  );
  const environment = gh.indexOf(
    'label create env:production --repo datalogix/app --color c5def5 --force --description Ambiente do problema; o label rollback reverte este ambiente',
  );
  const create = gh.findIndex((call) => call.startsWith('issue create'));
  expect(incident).not.toBe(-1);
  expect(environment).not.toBe(-1);
  expect(create).toBeGreaterThan(Math.max(incident, environment));
  expect(gh[create]).toMatch(/ --label incident --label env:production$/);
});

test('an open pull request with the label and the marker is not taken as the issue', async () => {
  const result = await sync(payload(), {
    issues: [
      {
        number: 4,
        state: 'open',
        body: `...\n${MARKER}`,
        pull_request: { url: 'https://api.github.com/repos/datalogix/app/pulls/4' },
      },
    ],
  });
  expect(result.code).toBe(0);
  expect(result.outputs.number).toBe('9');
  const gh = callsTo(result, 'gh');
  expect(gh).toContainEqual(expect.stringMatching(/^issue create/));
  expect(gh).not.toContainEqual(expect.stringMatching(/^(issue|pr) \w+ 4 /));
});

test('an event it does not handle changes nothing', async () => {
  const result = await sync(payload({ event: 'commented' }), { issues: [{ number: 5, state: 'open', body: MARKER }] });
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/Unhandled event 'commented', skipping/);
  expect(result.outputs).toStrictEqual({});
  expect(callsTo(result, 'gh')).not.toContainEqual(expect.stringMatching(/^(issue|label|pr) /));
});
