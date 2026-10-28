import { CODEOWNERS_PATH } from './codeowners.js';
import { keepsStaleApprovals, requiredChecks, requiresCodeOwners } from './ruleset.js';
import { unversioned, usesRef, WORKFLOW_PATH } from './workflow-file.js';

// What check suggests running to fix an item
export const SETUP = 'npx --allow-git=root github:datalogix/workflows#v2 setup';
export const PROTECT = 'npx --allow-git=root github:datalogix/workflows#v2 protect';

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
  if (version !== ref.slice(ref.indexOf('@') + 1)) {
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
 */
export function rulesetItems(report, state, { expected, known, branches = () => ({ ok: true }) }) {
  if (!state.canProtect) {
    report.warn(
      'Private repository on GitHub Free: branches cannot be protected, so the checks are only advice and anyone with write access can push',
      'GitHub Team (or Pro), or a public repository',
    );
    return;
  }
  if (!state.ruleset) {
    report.warn('The default branch is not protected: the checks are only advice', PROTECT);
    return;
  }
  const required = requiredChecks(state.ruleset);
  const missing = expected.filter((check) => !required.includes(check));
  const neverReported = known.filter((check) => required.includes(check) && !expected.includes(check));
  if (missing.length) report.warn(`The ruleset does not require ${missing.join(', ')}`, PROTECT);
  if (neverReported.length) {
    report.error(
      `The ruleset requires ${neverReported.join(', ')}, but that layer is off: every pull request waits for it`,
      PROTECT,
    );
  }
  const other = branches(report);
  if (!missing.length && !neverReported.length && other.ok) report.ok(other.label ?? 'Default branch protected');
}

/**
 * Code owners of .github/: without their approval, a pull request could change its own workflow file to lower the
 * checks. `requireApproval`: true (a team project) reports a ruleset that does not require that approval, false (one
 * maintainer) needs no code owners unless the ruleset requires them, null when unknown.
 */
export function codeOwnerItems(report, state, { requireApproval, hint }) {
  if (state.codeOwners) report.ok(`Code owners of .github/: ${state.codeOwners.join(' ')}`);
  else if (requireApproval !== false || requiresCodeOwners(state.ruleset)) {
    report.warn(`${CODEOWNERS_PATH} has no owner for /.github/`, hint);
  }
  if (state.ruleset && requireApproval && !requiresCodeOwners(state.ruleset)) {
    report.warn(
      'The ruleset does not require code owner approval, so a pull request can lower its own checks',
      PROTECT,
    );
  } else if (requiresCodeOwners(state.ruleset) && keepsStaleApprovals(state.ruleset)) {
    report.warn(
      'The ruleset keeps code owner approvals of older commits, so a later push can lower the checks',
      PROTECT,
    );
  }
}
