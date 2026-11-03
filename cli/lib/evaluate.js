import { CODEOWNERS_PATH } from './codeowners.js';
import { requiresCodeOwners, RULESET_NAME, rulesetDrift } from './ruleset.js';
import { refVersion, unversioned, usesRef, WORKFLOW_PATH } from './workflow-file.js';

// What check suggests running to fix an item
export const SETUP = 'npx --allow-git=root github:datalogix/workflows#v2 setup';
export const PROTECT = 'npx --allow-git=root github:datalogix/workflows#v2 protect';
export const ORG = 'npx --allow-git=root github:datalogix/workflows#v2 org';

/** The items check lists, each { level: ok | warn | error, title, hint }, with a function to add each level. */
export function createReport() {
  const items = [];
  return {
    items,
    ok: (title) => items.push({ level: 'ok', title }),
    warn: (title, hint) => items.push({ level: 'warn', title, hint }),
    error: (title, hint) => items.push({ level: 'error', title, hint }),
  };
}

/** The workflow file calls the entry point (ref) of the project or package. Returns whether it does. */
export function workflowItems(report, state, { ref, kind, fix }) {
  if (!state.workflow) {
    report.error(`${WORKFLOW_PATH} is missing`, fix);
    return false;
  }
  const version = usesRef(state.workflow, ref);
  if (version !== refVersion(ref)) {
    // Another version of the same workflow: a major release (e.g. @v2 to @v3) needs the file updated
    report.error(
      version
        ? `${WORKFLOW_PATH} calls ${unversioned(ref)}${version}: change it to ${ref}`
        : `${WORKFLOW_PATH} does not call ${ref}`,
      fix,
    );
    return false;
  }
  report.ok(`${WORKFLOW_PATH} calls the ${kind} workflow`);
  return true;
}

/**
 * The ruleset requires the expected checks and none that never reports: `known` are every check of the stack.
 * `branches(report)` adds the items of other protected branches and returns { ok, label } for the final line.
 * Returns the drift (rulesetDrift, with `codeOwners`) for codeOwnerItems, or null without a ruleset to compare.
 */
export function rulesetItems(report, state, { expected, known, codeOwners = null, branches = () => ({ ok: true }) }) {
  if (!state.canProtect) {
    report.warn(
      'Private repository on GitHub Free: branches cannot be protected, so the checks are only advice and anyone with write access can push',
      'GitHub Team (or Pro), or a public repository',
    );
    return null;
  }
  if (!state.ruleset) {
    // Another ruleset, one of the organization or classic branch protection may still protect it
    report.warn(`The default branch has no "${RULESET_NAME}" ruleset, so its checks may be only advice`, PROTECT);
    return null;
  }
  const drift = rulesetDrift(state.ruleset, { expected, known, codeOwners, defaultBranch: state.defaultBranch });
  if (drift.enforcement)
    report.error(`The "${RULESET_NAME}" ruleset is ${drift.enforcement}: nothing is enforced`, PROTECT);
  if (!drift.defaultBranch) report.warn(`The "${RULESET_NAME}" ruleset does not apply to the default branch`, PROTECT);
  if (!drift.pullRequests)
    report.warn('The ruleset does not require pull requests, so anyone with write access can push', PROTECT);
  if (drift.missing.length) report.warn(`The ruleset does not require ${drift.missing.join(', ')}`, PROTECT);
  if (drift.stale.length) {
    report.error(
      `The ruleset requires ${drift.stale.join(', ')}, but that layer is off: every pull request waits for it`,
      PROTECT,
    );
  }
  const other = branches(report);
  const right =
    !drift.enforcement && drift.defaultBranch && drift.pullRequests && !drift.missing.length && !drift.stale.length;
  if (right && other.ok) report.ok(other.label ?? 'Default branch protected');
  return drift;
}

/**
 * Code owners of .github/: without their approval, a pull request could change its own workflow file to lower the
 * checks. `requireApproval`: true (a team project) reports a ruleset that does not require that approval, false (one
 * maintainer) needs no code owners unless the ruleset requires them, null when unknown. `drift` is what rulesetItems
 * returned, computed with the same requireApproval.
 */
export function codeOwnerItems(report, state, { requireApproval, hint, drift = null }) {
  if (state.codeOwners) report.ok(`Code owners of .github/: ${state.codeOwners.join(' ')}`);
  else if (requireApproval !== false || requiresCodeOwners(state.ruleset)) {
    report.warn(`${CODEOWNERS_PATH} has no owner for /.github/`, hint);
  }
  if (drift?.codeOwners === 'missing') {
    report.warn(
      'The ruleset does not require code owner approval, so a pull request can lower its own checks',
      PROTECT,
    );
  } else if (drift?.staleApprovals) {
    report.warn(
      'The ruleset keeps code owner approvals of older commits, so a later push can lower the checks',
      PROTECT,
    );
  }
}
