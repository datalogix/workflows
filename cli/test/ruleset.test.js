import { expect, test } from 'vitest';
import {
  driftPhrases,
  keepsStaleApprovals,
  matchesDefaultBranch,
  mergeRuleset,
  rulesetBody,
  rulesetDrift,
} from '../lib/ruleset.js';
import { keepingStaleApprovals } from './helpers.js';

const CHECKS = ['pipeline / tests / tests', 'pipeline / security / security', 'pipeline / gate / gate'];

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

test('reads include and exclude patterns that match the default branch', () => {
  const body = rulesetBody(CHECKS);
  const on = (include, exclude = []) =>
    rulesetDrift({ ...body, conditions: { ref_name: { include, exclude } } }, { defaultBranch: 'main' }).defaultBranch;
  expect(on(['refs/heads/*'])).toBe(true);
  expect(on(['refs/heads/ma*'])).toBe(true);
  expect(on(['refs/heads/**'])).toBe(true);
  expect(on(['refs/heads/ma?n'])).toBe(true);
  expect(on(['refs/heads/[lm]ain'])).toBe(true);
  expect(on(['refs/heads/release/*'])).toBe(false);
  expect(on(['refs/heads/*/main'])).toBe(false);
  expect(on(['refs/heads/[!m]ain'])).toBe(false);
  // * stays within a segment, ** crosses them
  expect(
    rulesetDrift(
      { ...body, conditions: { ref_name: { include: ['refs/heads/*'], exclude: [] } } },
      {
        defaultBranch: 'team/main',
      },
    ).defaultBranch,
  ).toBe(false);
  expect(
    rulesetDrift(
      { ...body, conditions: { ref_name: { include: ['refs/heads/**'], exclude: [] } } },
      {
        defaultBranch: 'team/main',
      },
    ).defaultBranch,
  ).toBe(true);
  expect(on(['~DEFAULT_BRANCH'], ['refs/heads/m*'])).toBe(false);
  expect(on(['refs/heads/*'], ['refs/heads/**'])).toBe(false);
  expect(on(['~DEFAULT_BRANCH'], ['refs/heads/release/*'])).toBe(true);
  // Without the name, only ~DEFAULT_BRANCH and ~ALL are known to match
  expect(
    rulesetDrift({ ...body, conditions: { ref_name: { include: ['refs/heads/*'], exclude: [] } } }).defaultBranch,
  ).toBe(false);
});

test('merges a ruleset without the excludes of the default branch', () => {
  const existing = rulesetBody(CHECKS);
  existing.conditions.ref_name.exclude = ['~DEFAULT_BRANCH', 'refs/heads/main', 'refs/heads/m*', 'refs/heads/tmp'];
  const merged = (defaultBranch) =>
    mergeRuleset(existing, rulesetBody(CHECKS), { defaultBranch }).conditions.ref_name.exclude;
  expect(merged('main')).toStrictEqual(['refs/heads/tmp']);
  expect(merged(null)).toStrictEqual(['refs/heads/main', 'refs/heads/m*', 'refs/heads/tmp']);
  expect(
    rulesetDrift(mergeRuleset(existing, rulesetBody(CHECKS), { defaultBranch: 'main' }), { defaultBranch: 'main' })
      .defaultBranch,
  ).toBe(true);
});

test('keeps older approvals only when neither a push dismisses them nor the last push needs one', () => {
  const keeps = (dismiss, lastPush) => {
    const ruleset = rulesetBody(CHECKS, { codeOwners: true });
    Object.assign(ruleset.rules.find((rule) => rule.type === 'pull_request').parameters, {
      dismiss_stale_reviews_on_push: dismiss,
      require_last_push_approval: lastPush,
    });
    return keepsStaleApprovals(ruleset);
  };
  expect(keeps(true, true)).toBe(false);
  expect(keeps(true, false)).toBe(false);
  expect(keeps(false, true)).toBe(false);
  expect(keeps(false, false)).toBe(true);
});

test('matches the default branch with **/ as no directory at all, as fnmatch does', () => {
  expect(matchesDefaultBranch('refs/heads/**/*', 'main')).toBe(true);
  expect(matchesDefaultBranch('refs/heads/**/main', 'main')).toBe(true);
  expect(matchesDefaultBranch('refs/heads/**/*', 'team/main')).toBe(true);
  expect(matchesDefaultBranch('refs/heads/**/other', 'main')).toBe(false);
  expect(matchesDefaultBranch('refs/heads/release/**/*', 'main')).toBe(false);
});
