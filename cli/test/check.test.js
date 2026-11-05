import { expect, test } from 'vitest';
import { evaluate } from '../commands/check.js';
import { PACKAGE_CHECKS } from '../kinds/package/index.js';
import { PACKAGE_REF, packageAnswers, renderPackageWorkflow } from '../kinds/package/workflow.js';
import { PROJECT_CHECKS } from '../kinds/project/index.js';
import { labelsFor } from '../kinds/project/state.js';
import { PROJECT_REF, projectAnswers, renderProjectWorkflow } from '../kinds/project/workflow.js';
import { ORG, PROTECT, SETUP } from '../lib/evaluate.js';
import { rulesetBody } from '../lib/ruleset.js';
import { parseInputs, WORKFLOW_PATH } from '../lib/workflow-file.js';
import { APP_STATE, environment, keepingStaleApprovals, onPlatform, PACKAGE_STATE, RELAY as relay } from './helpers.js';

const rulesetOf = (checks = Object.values(PROJECT_CHECKS), options) => rulesetBody(checks, options);

const LABELS = labelsFor(['production', 'staging']).map((label) => label.name);
const PACKAGE_CHECK = PACKAGE_CHECKS.tests;

/** State of a project whose workflow file setup wrote for the answers; `current` is read back from that file. */
async function stateFor(answers, overrides = {}, edit = (content) => content) {
  // Pushes to the default branch run the workflow, as setup writes it
  const workflow = edit(await renderProjectWorkflow(answers, '', overrides.defaultBranch ?? 'main'));
  return { ...APP_STATE, workflow, current: projectAnswers(parseInputs(workflow)), ...overrides };
}

const titles = (items, level) => items.filter((item) => item.level === level).map((item) => item.title);

/**
 * Evaluates with fakes that fail the test if a check reads the network or the relay without the test saying so. They
 * throw at the call, not in a promise, which evaluate would set aside until it awaits it.
 */
const run = (state, options = {}) =>
  evaluate(state, {
    relay,
    probe: () => expect.unreachable('probe'),
    relayLookup: () => expect.unreachable('relay'),
    relayRead: () => expect.unreachable('relay'),
    ...options,
  });

// A project that deploys production from main and staging from develop, set up as setup leaves it
const PRODUCTION = { deploy: 'forge', staging: true, productionBranch: 'main', solo: true, incidents: false };
const READY = {
  labels: LABELS,
  defaultBranch: 'develop',
  environments: {
    production: environment(),
    staging: environment({ healthUrl: 'https://staging.app.example.com/up' }),
  },
  claudeToken: { repository: true, organization: false },
  releaseApp: true,
  productionBranchStatus: { name: 'main', exists: true },
  ruleset: rulesetOf(undefined, { productionBranch: 'main' }),
  health: { laravel: true, route: '/up', databaseCheck: true },
  codeOwners: ['@ana'],
};
const WITHOUT_APP = { ...READY, releaseApp: false, actionsPullRequests: { allowed: true, defaultPermissions: 'read' } };

/** Evaluates the production branch project with the overrides, the workflow file edited as given. */
const production = async (overrides = {}, edit) =>
  run(await stateFor(PRODUCTION, { ...READY, ...overrides }, edit), {
    repository: 'datalogix/app',
    probe: async () => 200,
  });

test('reports what a new project is missing', async (t) => {
  onPlatform(t, 'linux');
  const items = await run(APP_STATE, { repository: 'datalogix/app', relayLookup: async () => false });
  const errors = titles(items, 'error');
  expect(errors).toContainEqual(expect.stringContaining('datalogix.yml is missing'));
  expect(errors).toContainEqual(expect.stringMatching(/^Missing labels/));
  expect(errors).toContainEqual(expect.stringContaining('CLAUDE_CODE_OAUTH_TOKEN'));
  expect(titles(items, 'warn')).toContainEqual(expect.stringContaining('has no "datalogix" ruleset'));
  expect(titles(items, 'warn')).toContain('.github/CODEOWNERS has no owner for /.github/');
  expect(items).toContainEqual({ level: 'error', title: expect.stringMatching(/^Missing labels/), hint: SETUP });
  expect(items).toContainEqual({ level: 'warn', title: '.github/CODEOWNERS has no owner for /.github/', hint: SETUP });
  // Without a workflow file there is no trigger to look for
  expect(titles(items, 'warn')).not.toContainEqual(expect.stringContaining('repository_dispatch'));
});

test('warns about missing code owners only when their approval is needed', async () => {
  const warns = async (answers, ruleset = null) =>
    titles(await run({ ...(await stateFor(answers)), codeOwners: null, ruleset }), 'warn');
  const warning = '.github/CODEOWNERS has no owner for /.github/';
  expect(await warns({ deploy: 'none', solo: true, incidents: false })).not.toContain(warning);
  expect(await warns({ deploy: 'none', solo: false, incidents: false })).toContain(warning);
  // A ruleset that requires their approval has no one to give it
  const ruleset = rulesetBody([], { codeOwners: true });
  expect(await warns({ deploy: 'none', solo: true, incidents: false }, ruleset)).toContain(warning);
});

test('passes a fully set up project', async (t) => {
  onPlatform(t, 'linux');
  const state = await stateFor(
    { deploy: 'forge', staging: true, solo: true, incidents: true },
    {
      labels: LABELS,
      environments: {
        production: environment(),
        staging: environment({ healthUrl: 'https://staging.app.example.com/up' }),
      },
      claudeToken: { repository: true, organization: false },
      ruleset: rulesetOf(),
      health: { laravel: true, route: '/up', databaseCheck: true },
      nightwatch: true,
      codeOwners: ['@ana'],
    },
  );

  const items = await run(state, {
    repository: 'datalogix/app',
    probe: async () => 200,
    relayLookup: async () => true,
  });
  expect(items.filter((item) => item.level !== 'ok')).toStrictEqual([]);
});

test('reports a workflow file that does not call the project workflow', async () => {
  const items = await run({ ...APP_STATE, workflow: 'on: push\n' }, { relayLookup: async () => true });
  expect(titles(items, 'error')).toContainEqual(expect.stringContaining('does not call datalogix/workflows'));
  // Nor is a trigger asked of a file that calls something else
  expect(titles(items, 'warn')).not.toContainEqual(expect.stringContaining('repository_dispatch'));
});

test('tells to update a workflow file still on an older major', async () => {
  const items = await run(
    await stateFor({ deploy: 'none', incidents: false }, {}, (content) =>
      content.replace('project.yml@v2', 'project.yml@v1'),
    ),
  );
  const older = PROJECT_REF.replace('@v2', '@v1');
  expect(titles(items, 'error')).toContain(`${WORKFLOW_PATH} calls ${older}: change it to ${PROJECT_REF}`);
});

test('accepts a tag of the major, and warns about a workflow file on a branch or a commit', async () => {
  const on = async (version) =>
    run(
      await stateFor({ deploy: 'none', incidents: false }, {}, (content) =>
        content.replace('project.yml@v2', `project.yml@${version}`),
      ),
    );
  const tagged = await on('v2.3.0');
  expect(titles(tagged, 'ok')).toContain(`${WORKFLOW_PATH} calls the project workflow`);
  expect(titles(tagged, 'warn')).not.toContainEqual(expect.stringContaining(WORKFLOW_PATH));
  for (const version of ['fix-gate', '0123abc']) {
    const items = await on(version);
    const at = PROJECT_REF.replace('@v2', `@${version}`);
    expect(titles(items, 'warn')).toContain(`${WORKFLOW_PATH} calls ${at}, not a release of v2`);
    expect(titles(items, 'error')).not.toContainEqual(expect.stringContaining(WORKFLOW_PATH));
  }
  for (const version of ['v3', 'v1.2.0']) {
    const items = await on(version);
    const at = PROJECT_REF.replace('@v2', `@${version}`);
    expect(titles(items, 'error')).toContain(`${WORKFLOW_PATH} calls ${at}: change it to ${PROJECT_REF}`);
  }
});

test('accepts the Claude token as an organization secret', async () => {
  const items = await run(
    { ...APP_STATE, claudeToken: { repository: false, organization: true } },
    { relayLookup: async () => true },
  );
  expect(titles(items, 'ok')).toContain('CLAUDE_CODE_OAUTH_TOKEN (organization secret)');
  expect(titles(items, 'error')).not.toContainEqual(expect.stringContaining('CLAUDE_CODE_OAUTH_TOKEN'));
});

test('warns when the health URL would roll every deploy back', async () => {
  const state = await stateFor(
    { deploy: 'forge', staging: false, solo: true, incidents: false },
    {
      environments: { production: environment(), staging: APP_STATE.environments.staging },
      health: { laravel: true, route: '/up', databaseCheck: true },
    },
  );
  const items = await run(state, { repository: 'datalogix/app', probe: async () => 401 });
  expect(titles(items, 'warn')).toContainEqual(expect.stringContaining('answers 401'));
  expect(items.map((item) => item.title)).not.toContainEqual(expect.stringContaining('staging'));
});

test('warns when a health URL answers nothing at all', async () => {
  const state = await stateFor(PRODUCTION, READY);
  const items = await run(state, { repository: 'datalogix/app', probe: async () => null });
  expect(titles(items, 'warn')).toContain(
    'production: https://app.example.com/up answers nothing, so every deploy would be rolled back',
  );
});

test('warns about a health check that cannot be read, has no route or does not check the database', async () => {
  const warnings = async (health) => {
    const state = await stateFor(
      { deploy: 'forge', staging: false, solo: true, incidents: false },
      { environments: { production: environment(), staging: APP_STATE.environments.staging }, health },
    );
    return titles(await run(state, { probe: async () => 200 }), 'warn');
  };

  expect(await warnings({ laravel: false, route: null, databaseCheck: false })).toContain(
    'Could not read bootstrap/app.php from this folder',
  );
  const incomplete = await warnings({ laravel: true, route: null, databaseCheck: false });
  expect(incomplete).toContain('bootstrap/app.php has no health route');
  expect(incomplete).toContain('The health check does not check the database');
});

test('a team project needs code owner approval in the ruleset', async () => {
  const state = await stateFor(
    { deploy: 'none', solo: false, incidents: false },
    { ruleset: rulesetOf(), codeOwners: ['@datalogix/devs'] },
  );
  const warning = expect.stringContaining('code owner approval');
  expect(titles(await run(state), 'warn')).toContainEqual(warning);
  expect(await run(state)).toContainEqual({
    level: 'warn',
    title: 'The ruleset does not require code owner approval, so a pull request can lower its own checks',
    hint: PROTECT,
  });
  expect(
    titles(await run({ ...state, ruleset: rulesetOf(undefined, { codeOwners: true }) }), 'warn'),
  ).not.toContainEqual(warning);
  expect(titles(await run({ ...state, current: { ...state.current, solo: true } }), 'warn')).not.toContainEqual(
    warning,
  );
});

test('warns without reading the relay when it is not configured', async () => {
  const state = await stateFor({ deploy: 'none', solo: true, incidents: true });
  const unconfigured = { configured: false, url: '', namespaceId: '', owner: '' };
  const items = await run(state, { relay: unconfigured, repository: 'datalogix/app' });
  expect(titles(items, 'warn')).toContain('The monitoring relay is not set up for datalogix');
  expect(items).toContainEqual({ level: 'warn', title: 'The monitoring relay is not set up for datalogix', hint: ORG });
});

test('reports missing environments, hooks and health URLs', async () => {
  const state = await stateFor(
    { deploy: 'forge', staging: true, solo: true, incidents: false },
    {
      environments: {
        production: environment({ deployHook: false, healthUrl: null }),
        staging: APP_STATE.environments.staging,
      },
    },
  );
  const items = await run(state, { probe: async () => 200 });
  const errors = titles(items, 'error');
  expect(errors).toContain('Environment production has no DEPLOY_HOOK secret');
  expect(errors).toContain('Environment production has no HEALTH_URL variable');
  expect(errors).toContain('Environment staging is missing');
  // Nothing more about either: a missing environment has nothing else to check, nor a missing HEALTH_URL to probe
  expect(errors).toStrictEqual([
    `Missing labels: ${LABELS.filter((name) => name !== 'task').join(', ')}`,
    'CLAUDE_CODE_OAUTH_TOKEN is not available to this repository',
    'Environment production has no DEPLOY_HOOK secret',
    'Environment production has no HEALTH_URL variable',
    'Environment staging is missing',
  ]);
  expect(titles(items, 'warn')).not.toContainEqual(expect.stringMatching(/^(production|staging):/));
  // Nor is an environment that does not exist probed, whatever HEALTH_URL is read for it
  const gone = { ...state.environments.staging, healthUrl: 'https://staging.app.example.com/up' };
  await run(
    { ...state, environments: { ...state.environments, staging: gone } },
    { probe: (url) => (url.includes('staging') ? expect.unreachable('staging probe') : 200) },
  );
});

test('shows the Nightwatch token of a Forge environment and accepts labels in any case', async () => {
  const state = await stateFor(
    { deploy: 'forge', staging: false, solo: true, incidents: false },
    {
      labels: LABELS.map((name, index) => (index % 2 ? name.toUpperCase() : name)),
      environments: { production: environment({ monitoringToken: true }), staging: APP_STATE.environments.staging },
    },
  );
  const ok = titles(await run(state, { probe: async () => 200 }), 'ok');
  expect(ok).toContain('production: NIGHTWATCH_TOKEN (deploy markers)');
  expect(ok).toContain('Labels');
  // Only Forge sites send deploy markers
  const cloud = await stateFor(
    { deploy: 'cloud', staging: false, solo: true, incidents: false },
    { labels: state.labels, environments: state.environments },
  );
  expect(titles(await run(cloud, { probe: async () => 200 }), 'ok')).not.toContain(
    'production: NIGHTWATCH_TOKEN (deploy markers)',
  );
});

test('requires only the checks of the layers that are on', async () => {
  const answers = { deploy: 'none', solo: true, incidents: false };
  const riskGateOff = (content) => content.replace('    with:\n', '    with:\n      risk-gate: false\n');
  const rulesetTitles = async (state) =>
    (await run(state))
      .filter((item) => item.level !== 'ok' && item.title.startsWith('The ruleset'))
      .map((item) => item.title);

  const missing = await stateFor(answers, { ruleset: rulesetOf(Object.values(PROJECT_CHECKS).slice(0, 2)) });
  expect(await rulesetTitles(missing)).toStrictEqual(['The ruleset does not require pipeline / gate / gate']);
  expect(await run(missing)).toContainEqual({
    level: 'warn',
    title: 'The ruleset does not require pipeline / gate / gate',
    hint: PROTECT,
  });
  const stale = await stateFor(answers, { ruleset: rulesetOf() }, riskGateOff);
  expect(await rulesetTitles(stale)).toStrictEqual([
    'The ruleset requires pipeline / gate / gate, but that layer is off: every pull request waits for it',
  ]);
  expect(await run(stale)).toContainEqual({
    level: 'error',
    title: 'The ruleset requires pipeline / gate / gate, but that layer is off: every pull request waits for it',
    hint: PROTECT,
  });
  const off = await run(
    await stateFor(answers, { ruleset: rulesetOf(Object.values(PROJECT_CHECKS).slice(0, 2)) }, riskGateOff),
  );
  expect(titles(off, 'ok')).toContain('Default branch protected');
});

test('warns about a workflow without the repository_dispatch trigger and about the relay', async (t) => {
  onPlatform(t, 'linux');
  const state = await stateFor({ deploy: 'none', solo: true, incidents: true }, {}, (content) =>
    content.replace(/repository_dispatch:/, 'workflow_dispatch:'),
  );
  const warnings = async (registered) =>
    titles(await run(state, { repository: 'datalogix/app', relayLookup: async () => registered }), 'warn');

  expect(await warnings(true)).toContainEqual(expect.stringContaining('no repository_dispatch trigger'));
  expect(await warnings(false)).toContainEqual(expect.stringMatching(/^Not registered in the monitoring relay/));
  expect(await warnings(null)).toContain('Could not read the monitoring relay');

  // A commented trigger does not count
  const commented = await stateFor({ deploy: 'none', solo: true, incidents: true }, {}, (content) =>
    content.replace(/^(\s*)repository_dispatch:/m, '$1# repository_dispatch:'),
  );
  expect(
    titles(await run(commented, { repository: 'datalogix/app', relayLookup: async () => true }), 'warn'),
  ).toContainEqual(expect.stringContaining('no repository_dispatch trigger'));

  // Without incidents the trigger is not needed
  const off = await stateFor({ deploy: 'none', solo: true, incidents: false }, {}, (content) =>
    content.replace(/repository_dispatch:/, 'workflow_dispatch:'),
  );
  expect(titles(await run(off), 'warn')).not.toContainEqual(expect.stringContaining('repository_dispatch'));
});

test('warns about a repository the monitoring relay does not accept', async () => {
  const state = await stateFor({ deploy: 'none', solo: true, incidents: true });
  const warnings = titles(await run(state, { repository: 'other/app' }), 'warn');
  expect(warnings).toContain(
    'The monitoring relay only accepts repositories of datalogix: problems of other/app are rejected',
  );
});

test('a team project needs code owner approvals given after the last push', async () => {
  const state = await stateFor(
    { deploy: 'none', solo: false, incidents: false },
    { ruleset: rulesetOf(undefined, { codeOwners: true }), codeOwners: ['@datalogix/devs'] },
  );
  const stale = expect.stringContaining('approvals of older commits');
  expect(titles(await run(state), 'warn')).not.toContainEqual(stale);

  expect(titles(await run({ ...state, ruleset: keepingStaleApprovals(state.ruleset) }), 'warn')).toContainEqual(stale);
  // One person maintaining it: the code owner approval the ruleset still requires is reported, as setup does, and
  // protect drops it with the older approvals
  const solo = { ...state, current: { ...state.current, solo: true }, ruleset: keepingStaleApprovals(state.ruleset) };
  expect(titles(await run(solo), 'warn')).toContainEqual(
    'The ruleset requires code owner approval, but the project is maintained alone',
  );
});

test('reports a code owner approval a solo project cannot give, like setup, and not the branch as protected', async () => {
  const state = await stateFor(
    { deploy: 'none', solo: true, incidents: false },
    { ruleset: rulesetOf(undefined, { codeOwners: true }), codeOwners: ['@ana'] },
  );
  const items = await run(state);
  expect(items).toContainEqual({
    level: 'warn',
    title: 'The ruleset requires code owner approval, but the project is maintained alone',
    hint: PROTECT,
  });
  expect(titles(items, 'ok')).not.toContain('Default branch protected');
  // Without it, the branch is protected
  expect(titles(await run({ ...state, ruleset: rulesetOf() }), 'ok')).toContain('Default branch protected');
  // A team project with it is protected
  const team = await stateFor(
    { deploy: 'none', solo: false, incidents: false },
    { ruleset: rulesetOf(undefined, { codeOwners: true }), codeOwners: ['@ana'] },
  );
  expect(titles(await run(team), 'ok')).toContain('Default branch protected');
});

test('warns without reading the relay on Windows', async (t) => {
  onPlatform(t, 'win32');

  const state = await stateFor({ deploy: 'none', solo: true, incidents: true });
  const items = await run(state, { repository: 'datalogix/app' });
  expect(titles(items, 'warn')).toContain('Cannot read the monitoring relay on Windows');
});

test('passes a project with a production branch, both branches protected', async () => {
  const items = await production();
  expect(items.filter((item) => item.level !== 'ok')).toStrictEqual([]);
  expect(titles(items, 'ok')).toEqual(
    expect.arrayContaining(['develop deploys staging, main deploys production', 'Default branch and main protected']),
  );
});

test('reports a production branch that is the default branch, once', async () => {
  const error = 'main is the production branch and the default branch: staging and production deploy the same pushes';
  const broken = await production({ defaultBranch: 'main', ruleset: rulesetOf() });
  expect(titles(broken, 'error')).toStrictEqual([error]);
  expect(titles(broken, 'warn')).toStrictEqual([]);
  // Without release pull requests, the App is not needed and the same mistake is not reported twice
  expect(
    titles(await production({ defaultBranch: 'main', ruleset: rulesetOf(), releaseApp: false }), 'error'),
  ).toStrictEqual([error]);
});

test('reports a branch the push trigger does not run on', async () => {
  // Merging the release pull request would deploy nothing
  const notPushed = await production({}, (content) =>
    content.replace('branches: [develop, main]', 'branches: [develop]'),
  );
  expect(titles(notPushed, 'error')).toStrictEqual([
    '.github/workflows/datalogix.yml does not run on pushes to main (push.branches), so production is never deployed',
  ]);
  const stagingNotPushed = await production({}, (content) =>
    content.replace('branches: [develop, main]', 'branches: [main]'),
  );
  expect(titles(stagingNotPushed, 'error')).toStrictEqual([
    '.github/workflows/datalogix.yml does not run on pushes to develop (push.branches), so staging is never deployed',
  ]);
});

test('matches the push branches like GitHub filters', async () => {
  const globs = await production({}, (content) => content.replace('branches: [develop, main]', "branches: ['**']"));
  expect(titles(globs, 'ok')).toContain('develop deploys staging, main deploys production');
});

test('warns about a production branch without staging, where the default branch deploys nothing', async () => {
  const noStaging = await production({}, (content) =>
    content.replace('production-branch: main', 'staging: false\n      production-branch: main'),
  );
  expect(titles(noStaging, 'warn')).toStrictEqual([
    'main deploys production, but staging is off: develop, the default branch, deploys nothing',
  ]);
});

test('reports a production branch that no longer exists', async () => {
  const missing = await production({ productionBranchStatus: { name: 'main', exists: false } });
  expect(titles(missing, 'error')).toStrictEqual(['Branch main does not exist, so production is never deployed']);
});

test('warns about a production branch the ruleset leaves out while the App runs its checks', async () => {
  const items = await production({ ruleset: rulesetOf() });
  expect(titles(items, 'warn')).toStrictEqual(['The ruleset does not protect main: anyone can push to production']);
});

test('accepts release pull requests opened by GitHub Actions, leaving main unprotected', async () => {
  // Without the App, the release pull requests run no checks, so main cannot require them
  const actions = await production({ ...WITHOUT_APP, ruleset: rulesetOf() });
  expect(titles(actions, 'error')).toStrictEqual([]);
  expect(titles(actions, 'ok')).toContainEqual(expect.stringContaining('opened by GitHub Actions'));
  expect(titles(actions, 'warn')).toStrictEqual([expect.stringContaining('without the release GitHub App')]);
});

test('reports a ruleset that protects main without the App: every release waits', async () => {
  const items = await production(WITHOUT_APP);
  expect(titles(items, 'error')).toStrictEqual([expect.stringContaining('every release waits')]);
  expect(titles(items, 'ok')).not.toContainEqual(expect.stringContaining('protected'));
});

test('reports a repository where GitHub Actions cannot open pull requests', async () => {
  const denied = await production({ ...WITHOUT_APP, actionsPullRequests: { allowed: false }, ruleset: rulesetOf() });
  expect(titles(denied, 'error')).toStrictEqual([expect.stringContaining('GitHub Actions cannot open pull requests')]);
});

test('warns when it cannot read whether GitHub Actions can open pull requests', async () => {
  // Without admin access the setting cannot be read: not reported as fine
  const unknown = await production({ ...WITHOUT_APP, actionsPullRequests: null, ruleset: rulesetOf() });
  expect(titles(unknown, 'ok')).not.toContainEqual(expect.stringContaining('opened by GitHub Actions'));
  expect(titles(unknown, 'warn')).toContainEqual(expect.stringContaining('Could not read whether GitHub Actions'));
});

test('explains that a private repository on GitHub Free cannot be protected', async () => {
  const state = await stateFor(
    { deploy: 'none', solo: true, incidents: false },
    { labels: LABELS, claudeToken: { repository: true, organization: false }, codeOwners: ['@ana'], canProtect: false },
  );
  const items = await run(state, { repository: 'datalogix/app' });
  expect(titles(items, 'warn')).toStrictEqual([expect.stringContaining('Private repository on GitHub Free')]);
  expect(titles(items, 'error')).toStrictEqual([]);
});

const PACKAGE_WORKFLOW = await renderPackageWorkflow('', 'main');

/** A package set up as setup leaves it; `current` is read back from its workflow file, as collectState does. */
const packageState = (overrides = {}) => {
  const workflow = overrides.workflow === undefined ? PACKAGE_WORKFLOW : overrides.workflow;
  return {
    ...PACKAGE_STATE,
    codeOwners: ['@ana'],
    codecovToken: true,
    ...overrides,
    workflow,
    current: workflow ? packageAnswers(parseInputs(workflow)) : null,
  };
};

test('checks the workflow file, the ruleset, the Codecov token and the code owners of a package', async () => {
  const items = await run(packageState({ ruleset: rulesetOf([PACKAGE_CHECK]) }));
  expect(titles(items, 'error')).toStrictEqual([]);
  expect(titles(items, 'warn')).toStrictEqual([]);
  expect(titles(items, 'ok')).toStrictEqual([
    '.github/workflows/datalogix.yml calls the package workflow',
    'Default branch protected',
    'CODECOV_TOKEN (coverage reports)',
    'Code owners of .github/: @ana',
  ]);
});

test('reports a package without a workflow file, or with the project one', async () => {
  expect(titles(await run(packageState({ workflow: null })), 'error')).toContain(
    '.github/workflows/datalogix.yml is missing',
  );
  const projectFile = await run(packageState({ workflow: await renderProjectWorkflow({ deploy: 'none' }) }));
  expect(titles(projectFile, 'error')).toStrictEqual([`${WORKFLOW_PATH} does not call ${PACKAGE_REF}`]);
});

test('reports a package ruleset that requires the checks of its tests turned off', async () => {
  const workflow = `${PACKAGE_WORKFLOW}    with:\n      tests: false\n`;
  const items = await run(packageState({ workflow, ruleset: rulesetOf([PACKAGE_CHECK]) }));
  expect(titles(items, 'error')).toStrictEqual([
    'The ruleset requires pipeline / tests / all-checks, but that layer is off: every pull request waits for it',
  ]);
});

test('warns about a package without code owners', async () => {
  const items = await run(packageState({ ruleset: rulesetOf([PACKAGE_CHECK]), codeOwners: null }));
  expect(titles(items, 'warn')).toStrictEqual(['.github/CODEOWNERS has no owner for /.github/']);
});

test('reports a ruleset that is not enforced, leaves out the default branch or does not require pull requests', async () => {
  const state = await stateFor({ deploy: 'none', solo: true, incidents: false });
  const problems = async (ruleset) =>
    (await run({ ...state, ruleset }))
      .filter((item) => item.level !== 'ok' && /ruleset/.test(item.title))
      .map((item) => `${item.level}: ${item.title}`);
  expect(await problems(rulesetOf())).toStrictEqual([]);
  expect(await problems({ ...rulesetOf(), enforcement: 'disabled' })).toStrictEqual([
    'error: The "datalogix" ruleset is disabled: nothing is enforced',
  ]);
  expect(await run({ ...state, ruleset: { ...rulesetOf(), enforcement: 'disabled' } })).toContainEqual({
    level: 'error',
    title: 'The "datalogix" ruleset is disabled: nothing is enforced',
    hint: PROTECT,
  });
  expect(await problems({ ...rulesetOf(), enforcement: 'evaluate' })).toStrictEqual([
    'error: The "datalogix" ruleset is evaluate: nothing is enforced',
  ]);
  const elsewhere = rulesetOf();
  elsewhere.conditions.ref_name.include = ['refs/heads/release'];
  expect(await problems(elsewhere)).toStrictEqual([
    'warn: The "datalogix" ruleset does not apply to the default branch',
  ]);
  const noPullRequests = rulesetOf();
  noPullRequests.rules = noPullRequests.rules.filter((rule) => rule.type !== 'pull_request');
  expect(await problems(noPullRequests)).toStrictEqual([
    'warn: The ruleset does not require pull requests, so anyone with write access can push',
  ]);
});

test('warns about a package whose default branch is not protected', async () => {
  expect(titles(await run(packageState()), 'warn')).toStrictEqual([
    'The default branch has no "datalogix" ruleset, so its checks may be only advice',
  ]);
});

test('warns about a package ruleset that keeps code owner approvals of older commits', async () => {
  // A later push could lower the checks
  const ruleset = rulesetOf([PACKAGE_CHECK], { codeOwners: true });
  expect(titles(await run(packageState({ ruleset: keepingStaleApprovals(ruleset) })), 'warn')).toStrictEqual([
    'The ruleset keeps code owner approvals of older commits, so a later push can lower the checks',
  ]);
  expect(titles(await run(packageState({ ruleset })), 'warn')).toStrictEqual([]);
});

test('warns about a missing Codecov token only when the package uploads coverage', async () => {
  const warns = async (inputs) =>
    titles(
      await run(
        packageState({
          ruleset: rulesetOf([PACKAGE_CHECK]),
          codecovToken: false,
          workflow: inputs ? `${PACKAGE_WORKFLOW}    with:\n      ${inputs}\n` : PACKAGE_WORKFLOW,
        }),
      ),
      'warn',
    );
  expect(await warns()).toStrictEqual(['No CODECOV_TOKEN: the coverage report is not uploaded']);
  expect(await run(packageState({ ruleset: rulesetOf([PACKAGE_CHECK]), codecovToken: false }))).toContainEqual({
    level: 'warn',
    title: 'No CODECOV_TOKEN: the coverage report is not uploaded',
    hint: `${SETUP}, or coverage: false`,
  });
  // Coverage off, read by its value
  for (const value of ['false', "'false'", 'false # no codecov'])
    expect(await warns(`coverage: ${value}`)).toStrictEqual([]);
  expect(await warns('tests: false')).toStrictEqual([]);
});

test('only warns about the task label, which no workflow reads', async () => {
  const others = LABELS.filter((name) => name !== 'task');
  const state = await stateFor({ deploy: 'forge', solo: true, incidents: false }, { labels: others });
  const items = await run(state, { repository: 'datalogix/app' });
  expect(titles(items, 'error').filter((title) => title.startsWith('Missing labels'))).toStrictEqual([]);
  expect(items).toContainEqual({
    level: 'warn',
    title: 'Missing label: task (only the task manager uses it)',
    hint: SETUP,
  });
  expect(titles(items, 'ok')).not.toContain('Labels');
});

test('requires the env label of each deployed environment only', async () => {
  const missing = async (current) => {
    const state = await stateFor(current, { labels: labelsFor([]).map((label) => label.name) });
    return titles(await run(state, { repository: 'datalogix/app' }), 'error').find((title) =>
      title.startsWith('Missing labels'),
    );
  };
  expect(await missing({ deploy: 'none', solo: true, incidents: false })).toBeUndefined();
  expect(await missing({ deploy: 'forge', staging: false, solo: true, incidents: false })).toBe(
    'Missing labels: env:production',
  );
});

test('reports how the Claude GitHub App reaches the repository', async () => {
  const level = async (claudeApp) =>
    (await run({ ...APP_STATE, claudeApp }, { relayLookup: async () => true })).find((item) =>
      item.title.includes('Claude GitHub App'),
    )?.level;
  expect(await level('all')).toBe('ok');
  expect(await level('selected')).toBe('warn');
  expect(await level('none')).toBe('error');
  expect(await run({ ...APP_STATE, claudeApp: 'none' }, { relayLookup: async () => true })).toContainEqual({
    level: 'error',
    title: 'The Claude GitHub App is not installed',
    hint: 'https://github.com/apps/claude/installations/new',
  });
  expect(await level(null)).toBe('warn');
});

test('reports merge commits turned off with a production branch', async () => {
  const answers = { deploy: 'forge', staging: true, productionBranch: 'main', solo: true, incidents: false };
  const items = async (allow) =>
    run(await stateFor(answers, { defaultBranch: 'develop', repo: { allow_merge_commit: allow } }), {
      probe: async () => 200,
    });
  expect(titles(await items(false), 'error')).toContainEqual(expect.stringContaining('Merge commits are off'));
  expect(titles(await items(true), 'ok')).toContain('Merge commits allowed, for the release pull requests');
  expect((await items(undefined)).some((item) => item.title.includes('Merge commits'))).toBe(false);
});

test('warns when Nightwatch is on and the app does not require its agent', async () => {
  const warns = async (answers, overrides) =>
    titles(
      await run(
        { ...(await stateFor(answers)), health: { laravel: true, route: '/up', databaseCheck: true }, ...overrides },
        {
          relayLookup: async () => true,
        },
      ),
      'warn',
    );
  const warning = 'composer.json does not require laravel/nightwatch, so nothing reaches Nightwatch';
  expect(await warns({ deploy: 'none', solo: true, incidents: true }, { nightwatch: false })).toContain(warning);
  expect(await warns({ deploy: 'none', solo: true, incidents: true }, { nightwatch: true })).not.toContain(warning);
  expect(await warns({ deploy: 'none', solo: true, incidents: false }, { nightwatch: false })).not.toContain(warning);
  // Deploy markers also need the agent, with incidents off
  const markers = { production: environment({ monitoringToken: true }), staging: APP_STATE.environments.staging };
  expect(
    await warns({ deploy: 'none', solo: true, incidents: false }, { nightwatch: false, environments: markers }),
  ).toContain(warning);
});

test('reports the Inspector keys missing in the relay, by environment', async () => {
  const answers = { deploy: 'forge', staging: true, solo: true, monitoring: 'inspector' };
  const relayTitles = async (secret, overrides = {}) => {
    const read = [];
    const items = await run(await stateFor({ ...answers, ...overrides }), {
      repository: 'datalogix/app',
      probe: async () => 200,
      relayLookup: async () => expect.unreachable('hasSecret'),
      relayRead: async (_relay, provider) => (read.push(provider), secret),
    });
    expect(read).toStrictEqual(['inspector']);
    return items.filter((item) => /monitoring relay/.test(item.title)).map((item) => item.title);
  };

  const both = JSON.stringify({ production: 'p', staging: 's' });
  expect(await relayTitles(both)).toStrictEqual(['Registered in the monitoring relay']);
  expect(await relayTitles(JSON.stringify({ production: 'p' }))).toStrictEqual([
    'Inspector key of staging missing in the monitoring relay: its problems are rejected',
  ]);
  expect(await relayTitles('')).toStrictEqual([
    'Not registered in the monitoring relay: Inspector problems are rejected',
  ]);
  expect(await relayTitles(null)).toStrictEqual(['Could not read the monitoring relay']);
  // Staging problems off, or no staging: only production needs a key
  expect(await relayTitles(JSON.stringify({ production: 'p' }), { incidentStaging: false })).toStrictEqual([
    'Registered in the monitoring relay',
  ]);
  expect(await relayTitles(JSON.stringify({ production: 'p' }), { staging: false })).toStrictEqual([
    'Registered in the monitoring relay',
  ]);
});

test('warns when Inspector is on and the app does not require its SDK', async () => {
  const state = async (overrides) => ({
    ...(await stateFor({ deploy: 'none', solo: true, monitoring: 'inspector' })),
    health: { laravel: true, route: '/up', databaseCheck: true },
    ...overrides,
  });
  const warning = 'composer.json does not require inspector-apm/inspector-laravel, so nothing reaches Inspector';
  const warns = async (overrides) =>
    titles(await run(await state(overrides), { relayRead: async () => JSON.stringify({ production: 'p' }) }), 'warn');
  expect(await warns({ inspector: false })).toContain(warning);
  expect(await warns({ inspector: true })).not.toContain(warning);
});

test('looks the repository up in the relay under its monitoring service', async () => {
  const providers = [];
  const lookup = async (_relay, provider) => {
    providers.push(provider);
    return false;
  };
  for (const [monitoring, name] of [
    ['nightwatch', 'Nightwatch'],
    ['sentry', 'Sentry'],
  ]) {
    const items = await run(await stateFor({ deploy: 'none', monitoring }), {
      repository: 'datalogix/app',
      relayLookup: lookup,
    });
    expect(titles(items, 'warn')).toContainEqual(
      `Not registered in the monitoring relay: ${name} problems are rejected`,
    );
  }
  expect(providers).toStrictEqual(['nightwatch', 'sentry']);
});

test("checks a JavaScript app: Sentry's SDK and the relay, nothing of Laravel or deploys", async () => {
  const workflow = await renderProjectWorkflow({ stack: 'js', monitoring: 'sentry', incidents: true });
  const state = {
    ...APP_STATE,
    stack: 'js',
    workflow,
    current: projectAnswers(parseInputs(workflow)),
    framework: 'next',
    sentry: false,
  };
  const providers = [];
  const items = await run(state, {
    repository: 'datalogix/app',
    relayLookup: async (_relay, provider) => (providers.push(provider), true),
  });
  expect(providers).toStrictEqual(['sentry']);
  const titles = items.map((item) => item.title);
  expect(titles).toContainEqual('package.json does not require @sentry/nextjs, so nothing reaches Sentry');
  expect(titles.join('\n')).not.toMatch(/nightwatch|DEPLOY_HOOK|HEALTH_URL|bootstrap\/app\.php/i);
});

test('checks the Vercel token and project of a JavaScript app that deploys, not a deploy hook', async () => {
  const workflow = await renderProjectWorkflow({
    stack: 'js',
    deploy: 'vercel',
    staging: true,
    monitoring: 'none',
    incidents: false,
  });
  const state = {
    ...APP_STATE,
    stack: 'js',
    workflow,
    current: projectAnswers(parseInputs(workflow)),
    framework: 'next',
    healthFile: 'app/api/health/route.ts',
    healthRoute: false,
    environments: {
      production: environment({ deployHook: false, variables: { VERCEL_PROJECT: 'prj_1' } }),
      staging: environment({ variables: { VERCEL_PROJECT: null } }),
    },
  };
  const items = await run(state, { repository: 'datalogix/app', probe: async () => 200 });
  const errors = titles(items, 'error');
  expect(errors).toContainEqual('Environment production has no VERCEL_TOKEN secret');
  expect(errors).toContainEqual('Environment staging has no VERCEL_PROJECT variable');
  expect(errors.join('\n')).not.toContain('DEPLOY_HOOK');
  expect(titles(items, 'warn')).toContainEqual(expect.stringContaining('No health route at app/api/health/route.ts'));
});

test('probes every health URL and looks up the relay together, reporting them in order', async (t) => {
  onPlatform(t, 'linux');
  const state = await stateFor({ ...PRODUCTION, incidents: true }, READY);
  const started = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = (name, value) => async () => {
    started.push(name);
    await gate;
    return value;
  };
  const evaluated = run(state, {
    repository: 'datalogix/app',
    probe: async (url) => slow(url, url.includes('staging') ? null : 200)(),
    relayLookup: slow('relay', true),
  });
  // Every slow read started before any of them answered
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toStrictEqual(['https://app.example.com/up', 'https://staging.app.example.com/up', 'relay']);
  release();

  const items = (await evaluated).map((item) => item.title);
  const production = items.indexOf('production: https://app.example.com/up answers 200');
  const staging = items.findIndex((title) => title.startsWith('staging: https://staging.app.example.com/up answers'));
  expect(production).toBeGreaterThan(-1);
  expect(staging).toBeGreaterThan(production);
  expect(items.indexOf('Registered in the monitoring relay')).toBeGreaterThan(staging);
});
