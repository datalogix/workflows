import { expect, test } from 'vitest';
import { evaluate } from '../commands/check.js';
import { PACKAGE_CHECKS } from '../kinds/package/index.js';
import { packageAnswers, renderPackageWorkflow } from '../kinds/package/workflow.js';
import { PROJECT_CHECKS } from '../kinds/project/index.js';
import { labelsFor } from '../kinds/project/state.js';
import { projectAnswers, renderProjectWorkflow } from '../kinds/project/workflow.js';
import { rulesetBody } from '../lib/ruleset.js';
import { parseInputs } from '../lib/workflow-file.js';
import { APP_STATE, environment, onPlatform, PACKAGE_STATE, RELAY as relay } from './helpers.js';

const rulesetOf = (checks = Object.values(PROJECT_CHECKS), options) => rulesetBody(checks, options);

/** The ruleset, keeping the code owner approvals of older commits (as rulesets made before protect did). */
const keepingStaleApprovals = (ruleset) => {
  const copy = structuredClone(ruleset);
  Object.assign(copy.rules.find((rule) => rule.type === 'pull_request').parameters, {
    dismiss_stale_reviews_on_push: false,
    require_last_push_approval: false,
  });
  return copy;
};

const LABELS = labelsFor(['production', 'staging']).map((label) => label.name);
const PACKAGE_CHECK = PACKAGE_CHECKS.tests;

/** State of a project whose workflow file setup wrote for the answers; `current` is read back from that file. */
async function stateFor(answers, overrides = {}, edit = (content) => content) {
  // Pushes to the default branch run the workflow, as setup writes it
  const workflow = edit(await renderProjectWorkflow(answers, '', overrides.defaultBranch ?? 'main'));
  return { ...APP_STATE, workflow, current: projectAnswers(parseInputs(workflow)), ...overrides };
}

const titles = (items, level) => items.filter((item) => item.level === level).map((item) => item.title);

/** Evaluates with fakes that fail the test if a check reads the network or the relay without the test saying so. */
const run = (state, options = {}) =>
  evaluate(state, {
    relay,
    probe: async () => expect.unreachable('probe'),
    relayLookup: async () => expect.unreachable('relay'),
    ...options,
  });

test('reports what a new project is missing', async () => {
  const items = await run(APP_STATE, { repository: 'datalogix/app', relayLookup: async () => false });
  const errors = titles(items, 'error');
  expect(errors).toContainEqual(expect.stringContaining('datalogix.yml is missing'));
  expect(errors).toContainEqual(expect.stringMatching(/^Missing labels/));
  expect(errors).toContainEqual(expect.stringContaining('CLAUDE_CODE_OAUTH_TOKEN'));
  expect(titles(items, 'warn')).toContainEqual(expect.stringContaining('not protected'));
  expect(titles(items, 'warn')).toContain('.github/CODEOWNERS has no owner for /.github/');
});

test('asks for code owners only when their approval is needed', async () => {
  const warns = async (answers, ruleset = null) =>
    titles(await run({ ...(await stateFor(answers)), codeOwners: null, ruleset }), 'warn');
  const warning = '.github/CODEOWNERS has no owner for /.github/';
  expect(await warns({ deploy: 'none', solo: true, incidents: false })).not.toContain(warning);
  expect(await warns({ deploy: 'none', solo: false, incidents: false })).toContain(warning);
  // A ruleset that requires their approval has no one to give it
  const ruleset = rulesetBody([], { codeOwners: true });
  expect(await warns({ deploy: 'none', solo: true, incidents: false }, ruleset)).toContain(warning);
});

test('passes a fully set up project', async () => {
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
});

test('tells to update a workflow file still on an older major', async () => {
  const items = await run(
    await stateFor({ deploy: 'none', incidents: false }, {}, (content) =>
      content.replace('project.yml@v2', 'project.yml@v1'),
    ),
  );
  expect(titles(items, 'error')).toContain(
    '.github/workflows/datalogix.yml calls datalogix/workflows/.github/workflows/project.yml@v1: change it to datalogix/workflows/.github/workflows/project.yml@v2',
  );
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
  expect(titles(items, 'warn')).toContainEqual('The monitoring relay is not set up for datalogix');
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
  const errors = titles(await run(state, { probe: async () => 200 }), 'error');
  expect(errors).toContain('Environment production has no DEPLOY_HOOK secret');
  expect(errors).toContain('Environment production has no HEALTH_URL variable');
  expect(errors).toContain('Environment staging is missing');
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
});

test('requires only the checks of the layers that are on', async () => {
  const answers = { deploy: 'none', solo: true, incidents: false };
  const riskGateOff = (content) => content.replace('    with:\n', '    with:\n      risk-gate: false\n');
  const rulesetTitles = async (state) =>
    (await run(state))
      .filter((item) => item.level !== 'ok' && item.title.startsWith('The ruleset'))
      .map((item) => item.title);

  expect(
    await rulesetTitles(await stateFor(answers, { ruleset: rulesetOf(Object.values(PROJECT_CHECKS).slice(0, 2)) })),
  ).toStrictEqual(['The ruleset does not require pipeline / gate / gate']);
  expect(await rulesetTitles(await stateFor(answers, { ruleset: rulesetOf() }, riskGateOff))).toStrictEqual([
    'The ruleset requires pipeline / gate / gate, but that layer is off: every pull request waits for it',
  ]);
  const off = await run(
    await stateFor(answers, { ruleset: rulesetOf(Object.values(PROJECT_CHECKS).slice(0, 2)) }, riskGateOff),
  );
  expect(titles(off, 'ok')).toContain('Default branch protected');
});

test('warns about a workflow without the repository_dispatch trigger and about the relay', async () => {
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
});

test('warns without reading the relay on Windows', async (t) => {
  onPlatform(t, 'win32');

  const state = await stateFor({ deploy: 'none', solo: true, incidents: true });
  const items = await run(state, { repository: 'datalogix/app' });
  expect(titles(items, 'warn')).toContain('Cannot read the monitoring relay on Windows');
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
  expect(titles(await production(WITHOUT_APP), 'error')).toStrictEqual([
    expect.stringContaining('every release waits'),
  ]);
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
  expect(titles(projectFile, 'error')).toStrictEqual([
    '.github/workflows/datalogix.yml does not call datalogix/workflows/.github/workflows/package.yml@v2',
  ]);
});

test('warns about a package whose default branch is not protected', async () => {
  expect(titles(await run(packageState()), 'warn')).toStrictEqual([
    'The default branch is not protected: the checks are only advice',
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
  // Coverage off, read by its value
  for (const value of ['false', "'false'", 'false # no codecov'])
    expect(await warns(`coverage: ${value}`)).toStrictEqual([]);
  expect(await warns('tests: false')).toStrictEqual([]);
});

test('asks for the env label of each deployed environment only', async () => {
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
