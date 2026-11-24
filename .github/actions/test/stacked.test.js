import { expect, test } from 'vitest';
import { callsTo, runScript, unmatchedReads } from './fakes.js';

const MARKER = '<!-- datalogix-update-stacked -->';
const pull = (number, ref, repo = 'datalogix/app') => ({ number, head: { ref, repo: { full_name: repo } } });

// children: the open pull requests based on the branch; merges: { ref: rule } answers the merge into that branch
// (a sha, null for nothing to merge, or a gh rule); comments: { number: [comment] }
async function update({ children = [], merges = {}, comments = {}, env = {} }) {
  const result = await runScript('stacked/update.sh', {
    env: { BRANCH: 'feat/base', PR: '10', LANGUAGE: 'en', ...env },
    gh: [
      { match: 'pulls\\?state=open&base=feat%2Fbase', stdout: children },
      ...Object.entries(comments).map(([number, list]) => ({ match: `issues/${number}/comments\\?`, stdout: list })),
      { match: 'issues/[0-9]+/comments\\?', stdout: [] },
      ...Object.entries(merges).map(([ref, answer]) =>
        typeof answer === 'object' && answer !== null
          ? { match: `merges -f base=${ref} `, ...answer }
          : { match: `merges -f base=${ref} `, stdout: answer === null ? '' : { sha: answer } },
      ),
    ],
  });
  expect(unmatchedReads(result)).toStrictEqual([]);
  return result;
}

test('merges the branch into each pull request based on it, with a regular merge', async () => {
  const result = await update({
    children: [pull(11, 'feat/middle'), pull(12, 'feat/other')],
    merges: { 'feat/middle': 'a'.repeat(40), 'feat/other': null },
  });

  expect(result.code).toBe(0);
  const merges = callsTo(result, 'gh').filter((call) => call.includes('merges'));
  expect(merges).toEqual([
    expect.stringContaining(
      "api --method POST repos/datalogix/app/merges -f base=feat/middle -f head=feat/base -f commit_message=Merge branch 'feat/base' into feat/middle",
    ),
    expect.stringContaining('-f base=feat/other -f head=feat/base'),
  ]);
  expect(result.stdout).toContain('Merged feat/base into feat/middle (#11): aaaaaaa');
  expect(result.stdout).toContain('feat/other (#12) already has the changes of feat/base');
  expect(result.summary).toContain('Updated with `feat/base`: #11');
  // No comment without an earlier conflict
  expect(callsTo(result, 'gh').some((call) => call.includes('--method POST') && call.includes('comments'))).toBe(false);
});

test('skips pull requests from forks', async () => {
  const result = await update({ children: [pull(11, 'feat/middle', 'someone/app')] });

  expect(result.code).toBe(0);
  expect(callsTo(result, 'gh').some((call) => call.includes('merges'))).toBe(false);
});

test('comments once on a conflict, and updates that comment when a later merge works', async () => {
  const conflict = await update({
    children: [pull(11, 'feat/middle')],
    merges: { 'feat/middle': { code: 1, stderr: 'gh: Merge conflict (HTTP 409)' } },
  });
  expect(conflict.code).toBe(0);
  expect(conflict.stdout).toContain('::warning::feat/base conflicts with feat/middle (#11)');
  const posted = callsTo(conflict, 'gh').find((call) =>
    call.includes('--method POST repos/datalogix/app/issues/11/comments'),
  );
  expect(posted).toContain('could not be merged into this pull request: they conflict');
  expect(posted).toContain(MARKER);

  const earlier = [{ id: 5, user: { type: 'Bot' }, body: `conflict\n\n${MARKER}` }];
  const again = await update({
    children: [pull(11, 'feat/middle')],
    merges: { 'feat/middle': { code: 1, stderr: 'gh: Merge conflict (HTTP 409)' } },
    comments: { 11: earlier },
  });
  expect(callsTo(again, 'gh')).toContainEqual(
    expect.stringContaining('--method PATCH repos/datalogix/app/issues/comments/5'),
  );
  expect(callsTo(again, 'gh').some((call) => call.includes('--method POST') && call.includes('comments'))).toBe(false);

  const fixed = await update({
    children: [pull(11, 'feat/middle')],
    merges: { 'feat/middle': 'b'.repeat(40) },
    comments: { 11: earlier },
    env: { LANGUAGE: 'pt-BR' },
  });
  const patched = callsTo(fixed, 'gh').find((call) => call.includes('--method PATCH'));
  expect(patched).toContain('foram trazidas para este PR em bbbbbbb');
});

test('fails on another merge error, after trying the other pull requests', async () => {
  const result = await update({
    children: [pull(11, 'feat/middle'), pull(12, 'feat/other')],
    merges: {
      'feat/middle': { code: 1, stderr: 'HTTP 403: refusing to allow a GitHub App to update workflow' },
      'feat/other': 'c'.repeat(40),
    },
  });

  expect(result.code).toBe(1);
  expect(result.stdout).toContain('::error::Could not merge feat/base into feat/middle (#11)');
  expect(result.stdout).toContain('Merged feat/base into feat/other (#12)');
});

test('says so when no pull request is based on the branch', async () => {
  const result = await update({});

  expect(result.code).toBe(0);
  expect(result.summary).toContain('No open pull request is based on `feat/base`.');
});
