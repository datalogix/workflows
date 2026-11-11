import {
  CLAUDE_LABEL,
  CLAUDE_STATE,
  claudeAppNextSteps,
  claudeItems,
  claudeTokenStep,
  claudeTokenTasks,
  labelItems,
  labelsTask,
  languageStep,
  NO_REVIEW_LABEL,
  PLAN_LABEL,
  readClaude,
  readLabels,
} from '../../lib/claude.js';
import { coverageItems } from '../../lib/coverage.js';
import { codeOwnerItems, createReport, PROTECT, rulesetItems, SETUP, workflowItems } from '../../lib/evaluate.js';
import { driftPhrases, requiresCodeOwners, rulesetDrift } from '../../lib/ruleset.js';
import { checksOn } from '../../lib/state.js';
import { codeOwnersStep, repositoryStep, soloStep } from '../../lib/steps.js';
import { NO_TESTS } from '../../lib/tools.js';
import { changedFiles, codeOwnersTask, TASK_FILES, workflowFileTask, workflowWarnings } from '../../lib/tasks.js';
import { bold, clack, cyan, dim, orExit, question } from '../../lib/ui.js';
import { grantedPermissions, grants, jobPermissions, triggerEvents } from '../../lib/workflow-file.js';
import {
  CLAUDE_JOB,
  claudeOn,
  layersOn,
  PACKAGE_LAYERS,
  PACKAGE_REF,
  packageTemplate,
  renderPackageWorkflow,
  workflowAnswers,
} from './workflow.js';

// What package.yml needs from a package, whatever its stack: the workflow file, the Codecov token, the ruleset and the
// code owners, and with a Claude layer on, the Claude token, the Claude GitHub App and the labels. A stack's package
// module (cli/stacks/<stack>/package.js) calls packageKind with what only it knows.

// Check of each layer that can be required, keyed by its answer in packageAnswers: the tests (package.yml, the
// pipeline job) end in the all-checks job of the stack's package tests; the security review and the risk gate
// (package-claude.yml, the claude job) are off unless the workflow file turns them on
export const PACKAGE_CHECKS = {
  tests: 'pipeline / tests / all-checks',
  securityReview: `${CLAUDE_JOB} / security / security`,
  riskGate: `${CLAUDE_JOB} / gate / gate`,
};

/**
 * The checks the answers require: checksOn counts a layer as on unless its answer is false, as project.yml's layers
 * are, but the security review and the risk gate of a package are off unless the workflow file turns them on.
 */
const checksOfPackage = (checks, a) =>
  checksOn(checks, { ...a, securityReview: a?.securityReview === true, riskGate: a?.riskGate === true });

// What each layer needs of the workflow file: the events that run it and the permissions of the claude job (setup
// writes them from examples/package-claude.yml; a file edited by hand may lack them)
const LAYER_NEEDS = {
  claude: {
    name: '@claude',
    events: ['issues', 'issue_comment', 'pull_request_review_comment', 'pull_request_review'],
    permissions: { contents: 'write', 'pull-requests': 'write', issues: 'write', actions: 'read', 'id-token': 'write' },
  },
  review: {
    name: 'the code review',
    events: ['pull_request'],
    permissions: { 'pull-requests': 'read', issues: 'read', 'id-token': 'write' },
  },
  securityReview: {
    name: 'the security review',
    events: ['pull_request'],
    permissions: { 'pull-requests': 'write', issues: 'write', 'id-token': 'write' },
  },
  riskGate: {
    name: 'the risk gate',
    events: ['pull_request', 'pull_request_review'],
    permissions: { 'pull-requests': 'write', issues: 'write' },
  },
};

/** The events and permissions the layers that are on need and the workflow file lacks, as an error each. */
function layerNeedItems(report, state) {
  if (!state.workflow) return;
  const events = triggerEvents(state.workflow);
  // The claude job's own permissions, else the workflow's
  const granted = jobPermissions(state.workflow, CLAUDE_JOB) ?? grantedPermissions(state.workflow);
  for (const [answer, needs] of Object.entries(LAYER_NEEDS)) {
    if (state.current?.[answer] !== true) continue;
    const missing = [
      ...(events ? needs.events.filter((event) => !events.includes(event)).map((event) => `the ${event} event`) : []),
      ...Object.entries(needs.permissions)
        .filter(([scope, level]) => !grants(granted, scope, level))
        .map(([scope, level]) => `${scope}: ${level}`),
    ];
    if (missing.length)
      report.error(
        `The workflow file turns on ${needs.name} but lacks ${missing.join(', ')}, so its jobs do not run or fail`,
        SETUP,
      );
  }
}

// What the kind reads (read), before it is read
const PACKAGE_STATE = { codecovToken: false, ...CLAUDE_STATE };

// --layers claude,review,security-review, or none
const layerChoices = (value) => (value.trim() === 'none' ? [] : value.split(',').map((choice) => choice.trim()));
const validLayers = (value) =>
  layerChoices(value ?? '').every((choice) => Object.values(PACKAGE_LAYERS).includes(choice))
    ? undefined
    : `use ${Object.values(PACKAGE_LAYERS).join(', ')} separated by commas, or none`;

/** The labels the Claude layers of a package start or skip with: claude and claude-plan, no-review. */
const labelsOf = (a) => [...(a.claude ? [CLAUDE_LABEL, PLAN_LABEL] : []), ...(a.review ? [NO_REVIEW_LABEL] : [])];

/** The Claude layers of a package, all off unless the workflow file turns them on. */
const layersStep = {
  id: 'layers',
  flag: 'layers',
  validate: validLayers,
  parse: layerChoices,
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.multiselect({
        message: question(header, 'Claude on issues and pull requests', [
          '@claude: Claude answers @claude, implements issues labeled claude, plans those labeled claude-plan, and fixes the tests of its own pull requests',
          'Code review: Claude reviews the changes once per pull request and comments',
          'Security review: Claude looks for vulnerabilities on every push; a finding from high up fails the required check (pull requests from forks are not reviewed)',
          'Risk gate: labels each pull request by risk (dependencies, what the package installs in the app, its build and CI are high) and requires a human approval from medium up; no Claude',
          "Each Claude workflow uses the Claude token's usage limits, shared by every project",
        ]),
        options: [
          { value: 'claude', label: '@claude', hint: 'issues and comments, and fixes of its failed tests' },
          { value: 'review', label: 'Code review', hint: 'once per pull request' },
          { value: 'security-review', label: 'Security review', hint: 'on every push; a required check' },
          { value: 'risk-gate', label: 'Risk gate', hint: 'approvals by risk; a required check' },
        ],
        initialValues: Object.entries(PACKAGE_LAYERS)
          .filter(([answer]) => ctx.state.current?.[answer] === true)
          .map(([, input]) => input),
        required: false,
      }),
    ),
  then: (answers) => {
    for (const [answer, input] of Object.entries(PACKAGE_LAYERS)) answers[answer] = answers.layers.includes(input);
  },
};

/**
 * Whether the package uploads a coverage report, so it needs a Codecov token: tests and coverage on. A test suite
 * answered in setup (testRun) replaces the file's.
 */
const uploadsCoverage = ({ current }, answers = {}) =>
  current?.tests !== false && current?.coverage !== false && (answers.testRun ?? current?.testCommand) !== NO_TESTS;

/** Whether the tests check the public API: what breaks it (PHP), or what the library publishes (JavaScript). */
function apiCheckStep(stack) {
  const js = stack.id === 'js';
  return {
    id: 'apiCheck',
    flag: 'api-check',
    ask: async ({ header, ctx }) =>
      orExit(
        await clack.confirm({
          message: question(
            header,
            js ? 'Check what the library publishes?' : 'Check the public API on pull requests?',
            js
              ? 'publint and @arethetypeswrong/cli after the build: exports, files and the types of every entry point'
              : 'roave/backward-compatibility-check against the base branch: a removed method or a new required argument fails the tests',
          ),
          initialValue: ctx.state.current?.apiCheck ?? false,
        }),
      ),
  };
}

function setupSteps(stack) {
  return [
    // Setup reads what the Claude layers need, as it may turn them on
    repositoryStep({ readOptions: { claude: true } }),
    ...(stack.steps?.() ?? []),
    apiCheckStep(stack),
    {
      id: 'codecovToken',
      // After the stack's questions, which may turn the test suite off
      when: (a, ctx) => stack.coverage !== false && !ctx.state.codecovToken && uploadsCoverage(ctx.state, a),
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
    layersStep,
    languageStep({ when: claudeOn }),
    claudeTokenStep({
      when: claudeOn,
      about: 'Used by the Claude layers you turned on: @claude, the code review and the security review',
    }),
    // A ruleset that requires code owners tells a team; the question explains what a package changes
    soloStep({
      subject: 'package',
      initial: (ctx) => !requiresCodeOwners(ctx.state.ruleset),
      about: 'Changes to .github/ need no code owner approval',
    }),
    codeOwnersStep(),
  ];
}

/** The changes the answers lead to, as tasks for the progress bar. */
function setupTasks(answers, { github, root, state }) {
  const tasks = [
    workflowFileTask(() => renderPackageWorkflow(state.workflow ?? '', state.defaultBranch, answers), { root, state }),
  ];
  if (answers.codeOwners) tasks.push(codeOwnersTask(answers, { root, state }));
  if (claudeOn(answers)) {
    tasks.push(labelsTask(labelsOf(answers), { github, state, language: answers.language }));
    tasks.push(...claudeTokenTasks(answers, github));
  }
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
    await packageTemplate(defaultBranch, layersOn({ ...ctx.state.current, ...answers })),
    await renderPackageWorkflow(workflow ?? '', defaultBranch, answers),
  );
}

/** What is left to do by hand after the tasks ran: commit, then protect. */
function nextSteps(checks, answers, { results, state }) {
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
  if (claudeOn(answers)) steps.push(...claudeAppNextSteps(answers, state));
  const protect = cyan(`${PROTECT} ${answers.solo ? '--solo' : '--no-solo'}`);
  if (!state.ruleset) {
    steps.push(`After the first pull request shows its checks, protect the default branch:\n  ${protect}`);
    return steps;
  }
  // What protect would change, as check reports it: the code owner approval follows the solo answer, which protect
  // gets as --solo or --no-solo
  const phrases = driftPhrases(
    rulesetDrift(state.ruleset, {
      expected: checksOfPackage(checks, { ...state.current, ...answers }),
      known: Object.values(checks),
      codeOwners: !answers.solo,
      defaultBranch: state.defaultBranch,
    }),
    bold,
  );
  if (phrases.length) steps.push(`Run protect again: the ruleset ${phrases.join(', and ')}:\n  ${protect}`);
  return steps;
}

/**
 * A package needs its workflow file, the Clover report, the ruleset, the Codecov token and the code owners, and with a
 * Claude layer on, the labels, the Claude token and the Claude GitHub App.
 */
async function evaluate(stack, checks, state) {
  const report = createReport();
  if (workflowItems(report, state, { ref: PACKAGE_REF, kind: 'package', fix: SETUP })) coverageItems(report, state);
  const drift = rulesetItems(report, state, {
    expected: checksOfPackage(checks, state.current),
    known: Object.values(checks),
  });
  // Optional: without it the tests run, only no coverage report is uploaded
  if (stack.coverage !== false && uploadsCoverage(state)) {
    if (state.codecovToken) report.ok('CODECOV_TOKEN (coverage reports)');
    else report.warn('No CODECOV_TOKEN: the coverage report is not uploaded', `${SETUP}, or coverage: false`);
  }
  // Without them the Claude jobs that are on fail
  if (claudeOn(state.current)) {
    labelItems(report, state, labelsOf(state.current));
    claudeItems(report, state);
  }
  layerNeedItems(report, state);
  // The workflow file does not say whether one person maintains the package (protect asks): a missing approval rule
  // is not reported, only one that keeps older approvals, and a missing CODEOWNERS only when the ruleset requires it
  codeOwnerItems(report, state, { requireApproval: false, hint: SETUP, drift });
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
    answers: workflowAnswers,
    /**
     * What collectState reads from GitHub for a package: whether it can read a Codecov token and, in setup (claude) or
     * with a Claude layer on, its labels, the Claude token and the Claude GitHub App.
     */
    read: async (github, read, { current, claude = false } = {}) => {
      const codecov = async () => {
        // The organization's only when the repository has none: one that cannot be read counts as missing
        const repository = await read('secrets', github.hasRepositorySecret('CODECOV_TOKEN'));
        return repository || (await github.hasOrganizationSecret('CODECOV_TOKEN').catch(() => false));
      };
      const withClaude = claude || claudeOn(current);
      const [codecovToken, labels, claudeState] = await Promise.all([
        codecov(),
        withClaude ? readLabels(github, read) : {},
        withClaude ? readClaude(github, read) : {},
      ]);
      return { codecovToken, ...labels, ...claudeState };
    },
    setup: {
      steps: () => setupSteps(stack),
      tasks: (answers, ctx) => setupTasks(withStack(answers), ctx),
      warnings: (answers, ctx) => setupWarnings(withStack(answers), ctx),
      nextSteps: (answers, ctx) => nextSteps(checks, answers, ctx),
    },
    evaluate: (state) => evaluate(stack, checks, state),
    /** Checks to require, from the workflow answers (state.current). */
    requiredChecks: (state) => checksOfPackage(checks, state.current),
    /**
     * Whether code owners must approve changes to .github/: a package's workflow file does not say whether one person
     * maintains it, so --solo or a question does.
     */
    async needsCodeOwners(current, flags, ruleset = null) {
      if (flags.solo !== undefined) return !flags.solo;
      // Without a question, the safe choice: nobody can lower the checks without a code owner
      if (flags.yes) return true;
      // Like setup's question: a ruleset that requires code owners tells a team
      return !orExit(
        await clack.confirm({
          message: 'Do you work alone on this package?',
          initialValue: !requiresCodeOwners(ruleset),
        }),
      );
    },
  };
}
