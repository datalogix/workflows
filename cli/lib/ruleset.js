export const RULESET_NAME = 'datalogix';

/**
 * Ruleset for the default branch (and the production branch, when given): pull requests required, the pipeline checks
 * required and up to date, no force pushes or deletion. No fixed number of approvals: the risk gate decides per pull
 * request. Repository admins can still merge a pull request whose checks fail (false positives, emergencies). With
 * codeOwners, changes to .github/ need their approval given after the last push, so an approval of an earlier commit
 * cannot let a later push lower the checks.
 */
export function rulesetBody(checks, { codeOwners = false, productionBranch = null } = {}) {
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['~DEFAULT_BRANCH', ...(productionBranch ? [`refs/heads/${productionBranch}`] : [])],
        exclude: [],
      },
    },
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: codeOwners,
          require_code_owner_review: codeOwners,
          require_last_push_approval: codeOwners,
          required_review_thread_resolution: false,
        },
      },
      // GitHub rejects the rule with no checks, which happens when every required layer is off
      ...(checks.length
        ? [
            {
              type: 'required_status_checks',
              parameters: {
                strict_required_status_checks_policy: true,
                required_status_checks: checks.map((context) => ({ context })),
              },
            },
          ]
        : []),
    ],
  };
}

// The rules rulesetBody writes; others added to the ruleset (signed commits, a linear history) are kept
const MANAGED_RULES = ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'];

/**
 * The ruleset body with what was added to the existing ruleset outside setup: other rules, the parameters of the pull
 * request rule it does not set, required checks other than the pipeline's (a pipeline check of a layer turned off is
 * dropped), other bypass actors and branches. The branches in unprotect (a production branch that can no longer be
 * protected) leave it.
 */
export function mergeRuleset(existing, body, { unprotect = [] } = {}) {
  if (!existing) return body;
  const rule = (ruleset, type) => ruleset.rules?.find((candidate) => candidate.type === type);
  const other = (existing.rules ?? []).filter((candidate) => !MANAGED_RULES.includes(candidate.type));
  const pullRequest = rule(body, 'pull_request');
  const before = rule(existing, 'pull_request')?.parameters ?? {};
  // Approvals required, stale approvals dismissed or conversations resolved by hand are stricter than what setup
  // writes, and stay. The last push approval does not: protect sets it with the code owners, and it would block a
  // project that one person now maintains
  const stricter = (parameters) => ({
    ...parameters,
    required_approving_review_count: Math.max(
      parameters.required_approving_review_count,
      before.required_approving_review_count ?? 0,
    ),
    dismiss_stale_reviews_on_push:
      parameters.dismiss_stale_reviews_on_push || before.dismiss_stale_reviews_on_push === true,
    required_review_thread_resolution:
      parameters.required_review_thread_resolution || before.required_review_thread_resolution === true,
  });
  const merged = body.rules
    .filter((candidate) => candidate.type !== 'required_status_checks')
    .map((candidate) =>
      candidate === pullRequest
        ? { ...candidate, parameters: stricter({ ...before, ...candidate.parameters }) }
        : candidate,
    );
  const statusRule = rule(existing, 'required_status_checks');
  const extraChecks = (statusRule?.parameters?.required_status_checks ?? []).filter(
    (check) => !check.context.startsWith('pipeline / '),
  );
  const checks = [...(rule(body, 'required_status_checks')?.parameters.required_status_checks ?? []), ...extraChecks];
  if (checks.length) {
    merged.push({
      type: 'required_status_checks',
      parameters: {
        ...statusRule?.parameters,
        strict_required_status_checks_policy: true,
        required_status_checks: checks,
      },
    });
  }
  const actor = (candidate) => `${candidate.actor_type}:${candidate.actor_id}`;
  const actors = new Set(body.bypass_actors.map(actor));
  const { include = [], exclude = [] } = existing.conditions?.ref_name ?? {};
  return {
    ...body,
    conditions: {
      ref_name: {
        include: includedRefs(include, { add: body.conditions.ref_name.include, remove: unprotect }),
        exclude: [...new Set([...body.conditions.ref_name.exclude, ...exclude])],
      },
    },
    bypass_actors: [
      ...body.bypass_actors,
      ...(existing.bypass_actors ?? []).filter((candidate) => !actors.has(actor(candidate))),
    ],
    rules: [...merged, ...other],
  };
}

/** The refs in add, then the refs a ruleset includes without the branches in remove, without repeats. */
export function includedRefs(include, { add = [], remove = [] } = {}) {
  const left = remove.map((branch) => `refs/heads/${branch}`);
  return [...new Set([...add, ...include.filter((ref) => !left.includes(ref))])];
}

/** Whether a ruleset requires the approval of the code owners. */
export function requiresCodeOwners(ruleset) {
  const rule = ruleset?.rules?.find((candidate) => candidate.type === 'pull_request');
  return rule?.parameters?.require_code_owner_review === true;
}

/** Whether a ruleset keeps approvals given before the last push, so a later push could change approved files. */
export function keepsStaleApprovals(ruleset) {
  const parameters = ruleset?.rules?.find((candidate) => candidate.type === 'pull_request')?.parameters;
  return Boolean(parameters) && !parameters.dismiss_stale_reviews_on_push && !parameters.require_last_push_approval;
}

/** Whether a ruleset applies to a branch other than the default one, which ~DEFAULT_BRANCH covers. */
export function protectsBranch(ruleset, branch) {
  return Boolean(ruleset?.conditions?.ref_name?.include?.includes(`refs/heads/${branch}`));
}

/** Status checks a ruleset requires. */
export function requiredChecks(ruleset) {
  const rule = ruleset?.rules?.find((candidate) => candidate.type === 'required_status_checks');
  return rule?.parameters?.required_status_checks?.map((check) => check.context) ?? [];
}

/**
 * What protect would change in an existing ruleset, for check and setup to say the same: whether it is enforced on the
 * default branch and requires pull requests, the `expected` checks it lacks, the checks of `known` (every check of the
 * stack) it requires although their layer is off, and the code owner approval: `codeOwners` true or false is what
 * protect would write (null leaves it as it is), and a required one that keeps older approvals is reported too.
 * `defaultBranch` is its name, so a ruleset that names it rather than ~DEFAULT_BRANCH applies to it.
 */
export function rulesetDrift(ruleset, { expected = [], known = [], codeOwners = null, defaultBranch = null } = {}) {
  const required = requiredChecks(ruleset);
  const owners = requiresCodeOwners(ruleset);
  const { include = [], exclude = [] } = ruleset?.conditions?.ref_name ?? {};
  // The default branch by any name a ruleset gives it: ~DEFAULT_BRANCH, ~ALL or its own ref
  const names = ['~DEFAULT_BRANCH', ...(defaultBranch ? [`refs/heads/${defaultBranch}`] : [])];
  return {
    enforcement: ruleset?.enforcement === 'active' ? null : (ruleset?.enforcement ?? 'disabled'),
    defaultBranch:
      (include.includes('~ALL') || names.some((name) => include.includes(name))) &&
      !names.some((name) => exclude.includes(name)),
    pullRequests: Boolean(ruleset?.rules?.some((rule) => rule.type === 'pull_request')),
    missing: expected.filter((check) => !required.includes(check)),
    stale: known.filter((check) => required.includes(check) && !expected.includes(check)),
    codeOwners: codeOwners === true && !owners ? 'missing' : codeOwners === false && owners ? 'extra' : null,
    staleApprovals: owners && codeOwners !== false && keepsStaleApprovals(ruleset),
  };
}

/**
 * The drift as phrases after "the ruleset", for the next steps of setup (empty when protect would change nothing).
 * `emphasis` marks the check names.
 */
export function driftPhrases(drift, emphasis = (text) => text) {
  const checks = (list) => list.map(emphasis).join(', ');
  return [
    drift.enforcement && `is ${drift.enforcement}, so nothing is enforced`,
    !drift.defaultBranch && 'does not apply to the default branch',
    !drift.pullRequests && 'does not require pull requests',
    drift.stale.length &&
      `still requires ${checks(drift.stale)}, which no longer runs, so every pull request would wait`,
    drift.missing.length && `does not require ${checks(drift.missing)} yet`,
    drift.codeOwners === 'missing' && 'does not require code owner approval yet',
    drift.codeOwners === 'extra' && 'requires code owner approval, but you work alone',
    drift.staleApprovals && 'keeps code owner approvals of older commits',
  ].filter(Boolean);
}
