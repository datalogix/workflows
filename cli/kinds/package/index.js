import { codeOwnerItems, createReport, rulesetItems, SETUP, workflowItems } from '../../lib/evaluate.js';
import { checksOn } from '../../lib/state.js';
import { codeOwnersStep, repositoryStep, soloStep } from '../../lib/steps.js';
import { NO_TESTS } from '../../lib/tools.js';
import { changedFiles, codeOwnersTask, TASK_FILES, workflowFileTask, workflowWarnings } from '../../lib/tasks.js';
import { clack, cyan, dim, orExit, question } from '../../lib/ui.js';
import { PACKAGE_REF, packageAnswers, packageTemplate, renderPackageWorkflow } from './workflow.js';

// What package.yml needs from a package, whatever its stack: the workflow file, the Codecov token, the ruleset and the
// code owners. A stack's package module (cli/stacks/<stack>/package.js) calls packageKind with what only it knows.

// Check of each layer that can be required (package.yml), keyed by its answer in packageAnswers; the tests end in
// the all-checks job of the stack's package tests
export const PACKAGE_CHECKS = {
  tests: 'pipeline / tests / all-checks',
};

// What the kind reads (readPackage), before it is read
const PACKAGE_STATE = { codecovToken: false };

/** Whether the package uploads a coverage report, so it needs a Codecov token: tests and coverage on. */
const uploadsCoverage = ({ current }) =>
  current?.tests !== false && current?.coverage !== false && current?.testCommand !== NO_TESTS;

function setupSteps(stack) {
  return [
    repositoryStep(),
    {
      id: 'codecovToken',
      when: (a, ctx) => stack.coverage !== false && !ctx.state.codecovToken && uploadsCoverage(ctx.state),
      ask: async ({ header }) =>
        orExit(
          await clack.password({
            message: question(
              header,
              `Codecov token${dim('  optional; an organization secret also works')}`,
              'Empty: the tests run, but the coverage report is not uploaded',
            ),
          }),
        ),
    },
    ...(stack.steps?.() ?? []),
    soloStep({ subject: 'package' }),
    codeOwnersStep(),
  ];
}

/** The changes the answers lead to, as tasks for the progress bar. */
function setupTasks(answers, { github, root, state }) {
  const tasks = [
    workflowFileTask(() => renderPackageWorkflow(state.workflow ?? '', state.defaultBranch, answers), { root, state }),
    codeOwnersTask(answers, { root, state }),
  ];
  if (answers.codecovToken?.trim()) {
    tasks.push({
      title: 'Codecov token',
      run: async () => {
        await github.setSecret('CODECOV_TOKEN', answers.codecovToken.trim());
        return 'stored as a repository secret';
      },
    });
  }
  return tasks;
}

/** Warnings shown before applying: what the template replaces in the existing workflow file. */
async function setupWarnings(answers, ctx) {
  const { workflow, defaultBranch } = ctx.state;
  return workflowWarnings(
    ctx.state,
    await packageTemplate(defaultBranch),
    await renderPackageWorkflow(workflow ?? '', defaultBranch, answers),
  );
}

/** What is left to do by hand after the tasks ran: commit, then protect. */
function nextSteps(answers, { results, state }) {
  const steps = [];
  const changed = changedFiles(results, TASK_FILES);
  if (changed.length) {
    const commit = `git add ${changed.join(' ')} && git commit -m "ci: use the Datalogix package workflow"`;
    // A protected default branch rejects a push
    steps.push(
      state.ruleset
        ? `Commit and open a pull request:\n  ${cyan(`git switch -c ci/datalogix-workflows && ${commit} && git push -u origin HEAD && gh pr create --fill`)}`
        : `Commit and push:\n  ${cyan(`${commit} && git push`)}`,
    );
  }
  steps.push(
    `After the first pull request shows its checks, protect the default branch:\n  ${cyan(`npx --allow-git=root github:datalogix/workflows#v2 protect ${answers.solo ? '--solo' : '--no-solo'}`)}`,
  );
  return steps;
}

/** A package needs only its workflow file, the ruleset, the Codecov token and the code owners. */
async function evaluate(stack, checks, state) {
  const report = createReport();
  workflowItems(report, state, { ref: PACKAGE_REF, kind: 'package', fix: SETUP });
  rulesetItems(report, state, {
    expected: checksOn(checks, state.current),
    known: Object.values(checks),
  });
  // Optional: without it the tests run, only no coverage report is uploaded
  if (stack.coverage !== false && uploadsCoverage(state)) {
    if (state.codecovToken) report.ok('CODECOV_TOKEN (coverage reports)');
    else report.warn('No CODECOV_TOKEN: the coverage report is not uploaded', `${SETUP}, or coverage: false`);
  }
  // The workflow file does not say whether one person maintains the package (protect asks): a missing approval rule
  // is not reported, only one that keeps older approvals
  codeOwnerItems(report, state, { requireApproval: null, hint: SETUP });
  return report.items;
}

/**
 * The module of a stack's package (package.yml): what every package needs, with the stack's part. `stack` gives
 * optionally id (the stack input the workflow file passes, laravel by default), coverage (false when its tests upload
 * no coverage report, so no Codecov token is asked), checks (PACKAGE_CHECKS by default), steps() (its own questions),
 * inspect(root) and empty (its part of the state before it is read).
 */
export function packageKind(stack) {
  const checks = stack.checks ?? PACKAGE_CHECKS;
  // The workflow file names the stack, so package.yml runs its tests
  const withStack = (answers) => ({ ...answers, stack: stack.id ?? 'laravel' });
  return {
    ref: PACKAGE_REF,
    checks,
    empty: { ...PACKAGE_STATE, ...stack.empty },
    inspect: stack.inspect,
    answers: packageAnswers,
    /** What collectState reads from GitHub for a package: whether it can read a Codecov token. */
    read: async (github, read) => ({
      codecovToken:
        (await read('secrets', github.hasRepositorySecret('CODECOV_TOKEN'))) ||
        (await github.hasOrganizationSecret('CODECOV_TOKEN').catch(() => false)),
    }),
    setup: {
      steps: () => setupSteps(stack),
      tasks: (answers, ctx) => setupTasks(withStack(answers), ctx),
      warnings: (answers, ctx) => setupWarnings(withStack(answers), ctx),
      nextSteps,
    },
    evaluate: (state) => evaluate(stack, checks, state),
    /** Checks to require, from the workflow answers (state.current). */
    requiredChecks: (state) => checksOn(checks, state.current),
    /**
     * Whether code owners must approve changes to .github/: a package's workflow file does not say whether one person
     * maintains it, so --solo or a question does.
     */
    async needsCodeOwners(current, flags) {
      if (flags.solo !== undefined) return !flags.solo;
      // Without a question, the safe choice: nobody can lower the checks without a code owner
      if (flags.yes) return true;
      return !orExit(await clack.confirm({ message: 'Do you work alone on this package?', initialValue: true }));
    },
  };
}
