import { expect, test } from 'vitest';
import { driftPhrases, rulesetBody, rulesetDrift } from '../lib/ruleset.js';

const CHECKS = ['pipeline / tests / tests', 'pipeline / security / security', 'pipeline / gate / gate'];

const keepingStaleApprovals = (ruleset) => {
  const copy = structuredClone(ruleset);
  Object.assign(copy.rules.find((rule) => rule.type === 'pull_request').parameters, {
    dismiss_stale_reviews_on_push: false,
    require_last_push_approval: false,
  });
  return copy;
};

test('finds nothing to change in the ruleset protect writes', () => {
  const drift = rulesetDrift(rulesetBody(CHECKS, { codeOwners: true }), {
    expected: CHECKS,
    known: CHECKS,
    codeOwners: true,
  });
  expect(drift).toStrictEqual({
    enforcement: null,
    defaultBranch: true,
    pullRequests: true,
    missing: [],
    stale: [],
    codeOwners: null,
    staleApprovals: false,
  });
  expect(driftPhrases(drift)).toStrictEqual([]);
});

test('finds the checks missing, the checks of layers turned off and the code owner approval', () => {
  const [tests, security, gate] = CHECKS;
  const drift = rulesetDrift(rulesetBody([tests, security]), {
    expected: [tests, gate],
    known: CHECKS,
    codeOwners: true,
  });
  expect(drift).toMatchObject({ missing: [gate], stale: [security], codeOwners: 'missing' });
  expect(driftPhrases(drift, (check) => `*${check}*`)).toStrictEqual([
    `still requires *${security}*, which no longer runs, so every pull request would wait`,
    `does not require *${gate}* yet`,
    'does not require code owner approval yet',
  ]);
  // Checks the stack does not know (added by hand) are not stale
  expect(rulesetDrift(rulesetBody(['lint']), { expected: [], known: CHECKS }).stale).toStrictEqual([]);
});

test('tells a code owner approval to drop, and older approvals kept only while it stays', () => {
  const team = keepingStaleApprovals(rulesetBody(CHECKS, { codeOwners: true }));
  expect(rulesetDrift(team, { codeOwners: false })).toMatchObject({ codeOwners: 'extra', staleApprovals: false });
  expect(rulesetDrift(team, { codeOwners: true })).toMatchObject({ codeOwners: null, staleApprovals: true });
  // Unknown (null): what protect would do with the code owners is not known, the older approvals are
  expect(rulesetDrift(team)).toMatchObject({ codeOwners: null, staleApprovals: true });
  expect(driftPhrases(rulesetDrift(team, { codeOwners: false }))).toStrictEqual([
    'requires code owner approval, but you work alone',
  ]);
});

test('finds a ruleset that is not enforced on the default branch, or without pull requests', () => {
  const body = rulesetBody(CHECKS);
  expect(rulesetDrift({ ...body, enforcement: 'disabled' }).enforcement).toBe('disabled');
  expect(rulesetDrift({ ...body, enforcement: undefined }).enforcement).toBe('disabled');
  const all = { ...body, conditions: { ref_name: { include: ['~ALL'], exclude: [] } } };
  expect(rulesetDrift(all).defaultBranch).toBe(true);
  const other = { ...body, conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } } };
  expect(rulesetDrift(other).defaultBranch).toBe(false);
  // Named by its ref, it applies; excluded, it does not
  expect(rulesetDrift(other, { defaultBranch: 'main' }).defaultBranch).toBe(true);
  const excluded = { ...body, conditions: { ref_name: { include: ['~ALL'], exclude: ['~DEFAULT_BRANCH'] } } };
  expect(rulesetDrift(excluded, { defaultBranch: 'main' }).defaultBranch).toBe(false);
  const excludedByName = {
    ...body,
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['refs/heads/main'] } },
  };
  expect(rulesetDrift(excludedByName, { defaultBranch: 'main' }).defaultBranch).toBe(false);
  const drift = rulesetDrift({ ...body, rules: [] });
  expect(drift.pullRequests).toBe(false);
  expect(driftPhrases(drift)).toContain('does not require pull requests');
});
