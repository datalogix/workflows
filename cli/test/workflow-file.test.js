import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { packageAnswers, packageTemplate, renderPackageWorkflow } from '../kinds/package/workflow.js';
import { PROJECT_REF, projectAnswers, projectTemplate, renderProjectWorkflow } from '../kinds/project/workflow.js';
import {
  droppedInputComments,
  hasChangesOutsideInputs,
  hasInputComments,
  inputComment,
  lf,
  listOf,
  parseInputs,
  pushBranches,
  runsOnPush,
  scalar,
  refStatus,
  usesRef,
} from '../lib/workflow-file.js';

/** Whether setup would replace lines of a project's workflow file, against the project template. */
const changesOutside = async (content, branch = 'main') =>
  hasChangesOutsideInputs(content, await projectTemplate(content, branch));

test('renders the example with the chosen inputs', async () => {
  const content = await renderProjectWorkflow({
    deploy: 'forge',
    staging: true,
    solo: true,
    incidents: true,
    incidentStaging: true,
    incidentPerformance: false,
  });
  expect(content).toContain(PROJECT_REF);
  expect(content).toContain('repository_dispatch:');
  // The commented list of optional inputs comes before the with block
  expect(content).toMatch(/ {4}# All inputs are optional:\n(?: {4}#.*\n)+ {4}with:\n/);
  expect(hasInputComments(content)).toBe(false);
  expect(parseInputs(content)).toStrictEqual({
    deploy: 'forge',
    'count-author': 'true',
    'incident-types': `'["exception"]'`,
  });
});

test('omits the with block when every input keeps its default', async () => {
  const content = await renderProjectWorkflow({ deploy: 'none', solo: false, incidents: true });
  expect(content).not.toMatch(/^\s+with:/m);
  expect(content).toMatch(/secrets: inherit\n {4}# All inputs are optional:\n/);
  expect(content).toBe(
    `${(await readFile(new URL('../../examples/project.yml', import.meta.url), 'utf8')).trimEnd()}\n`,
  );
  expect(await changesOutside(content)).toBe(false);
  expect(await changesOutside(content.replace('secrets: inherit', 'secrets: {}'))).toBe(true);
});

test('writes the package example as it is, with its commented list of optional inputs', async () => {
  const example = await readFile(new URL('../../examples/package.yml', import.meta.url), 'utf8');
  expect(await renderPackageWorkflow('', 'main')).toBe(`${example.trimEnd()}\n`);
  expect(await renderPackageWorkflow(example, 'main')).toBe(example);
  expect(hasChangesOutsideInputs(example, await packageTemplate('main'))).toBe(false);
  expect(hasInputComments(example)).toBe(false);
});

test('takes a file written without the commented list of optional inputs as unchanged, and adds the list', async () => {
  const strip = (content) => content.replace(/ {4}# All inputs are optional:\n(?: {4}#.*\n)+/, '');
  const project = await renderProjectWorkflow({ deploy: 'forge' });
  expect(strip(project)).not.toContain('# All inputs are optional');
  expect(await changesOutside(strip(project))).toBe(false);
  expect(await renderProjectWorkflow({ deploy: 'forge' }, strip(project))).toBe(project);

  const pkg = await renderPackageWorkflow();
  expect(hasChangesOutsideInputs(strip(pkg), await packageTemplate('main'))).toBe(false);
  expect(await renderPackageWorkflow(strip(pkg))).toBe(pkg);
  // Another change to the list is a change outside the inputs
  const edited = pkg.replace('#   pint: false', '#   pint: true');
  expect(hasChangesOutsideInputs(edited, await packageTemplate('main'))).toBe(true);
});

test('keeps inputs it does not manage and reads answers back', async () => {
  const existing = await renderProjectWorkflow({ deploy: 'cloud', staging: false, solo: true, incidents: false });
  const withExtra = existing.replace('    with:\n', '    with:\n      php-version: "8.3"\n');
  const again = await renderProjectWorkflow({ deploy: 'forge', staging: true, solo: true, incidents: true }, withExtra);
  expect(parseInputs(again)).toStrictEqual({ deploy: 'forge', 'count-author': 'true', 'php-version': '"8.3"' });

  expect(projectAnswers(parseInputs(withExtra))).toStrictEqual({
    stack: null,
    monitoring: 'nightwatch',
    deploy: 'cloud',
    staging: false,
    productionBranch: null,
    solo: true,
    githubDeployments: undefined,
    production: 'auto',
    approvalsMedium: null,
    approvalsHigh: null,
    review: undefined,
    fixCi: undefined,
    js: undefined,
    e2e: undefined,
    database: 'none',
    incidents: false,
    incidentStaging: undefined,
    incidentPerformance: undefined,
    tests: undefined,
    securityReview: undefined,
    riskGate: undefined,
    language: 'pt-BR',
    pint: undefined,
    phpstan: undefined,
    rector: undefined,
    lintCommand: null,
    testCommand: null,
    minCoverage: null,
  });
  expect(
    projectAnswers({ tests: 'false', 'security-review': 'true', 'risk-gate': 'false # no approvals' }),
  ).toStrictEqual({
    ...projectAnswers({}),
    tests: false,
    securityReview: true,
    riskGate: false,
  });
});

test('keeps multi-line inputs and reads values with trailing comments', async () => {
  const existing = await renderProjectWorkflow({ deploy: 'forge', staging: true, solo: false, incidents: true });
  const edited = existing.replace(
    '      deploy: forge\n',
    '      extra-instructions: |\n        Use Livewire.\n\n        Prefer Pest.\n      php-version: "8.4" # pinned\n      deploy: forge # production\n',
  );

  expect(parseInputs(edited)).toStrictEqual({
    'extra-instructions': '|\n        Use Livewire.\n\n        Prefer Pest.',
    'php-version': '"8.4" # pinned',
    deploy: 'forge # production',
  });
  expect(projectAnswers(parseInputs(edited)).deploy).toBe('forge');

  const again = await renderProjectWorkflow({ deploy: 'forge', staging: true, solo: false, incidents: true }, edited);
  expect(again).toContain('      extra-instructions: |\n        Use Livewire.\n\n        Prefer Pest.\n');
  expect(again).toContain('      php-version: "8.4" # pinned\n');
});

test('reads booleans in any case, as GitHub does', () => {
  const answers = projectAnswers({
    tests: 'False',
    'security-review': 'FALSE # off',
    'risk-gate': 'true',
    'count-author': 'True',
  });
  expect(answers).toMatchObject({ tests: false, securityReview: false, riskGate: true, solo: true });
  expect(packageAnswers({ tests: 'FALSE' }).tests).toBe(false);
});

test('detects changes outside the inputs, which setup replaces', async () => {
  const existing = await renderProjectWorkflow({ deploy: 'forge', staging: true, solo: true, incidents: true });
  expect(await changesOutside(existing)).toBe(false);
  expect(await changesOutside(existing.replace('    with:', '    # note\n    with:'))).toBe(true);
});

test('runs on pushes to the default branch of the repository', async () => {
  const content = await renderProjectWorkflow(
    { deploy: 'forge', staging: true, solo: true, incidents: true },
    '',
    'master',
  );
  expect(content).toMatch(/push:\n {4}branches: \[master\]\n/);
  expect(content).not.toContain('branches: [main]');
  expect(await changesOutside(content, 'master')).toBe(false);
  expect(await changesOutside(content)).toBe(true);
});

test('writes the language only when it is not the default', async () => {
  const answers = { deploy: 'none', solo: true, incidents: true };
  expect(parseInputs(await renderProjectWorkflow({ ...answers, language: 'pt-BR' })).language).toBe(undefined);

  const english = await renderProjectWorkflow({ ...answers, language: ' en ' });
  expect(parseInputs(english).language).toBe('en');
  expect(projectAnswers(parseInputs(english)).language).toBe('en');

  // Without an answer the current value stays; back to the default it is removed
  expect(parseInputs(await renderProjectWorkflow(answers, english)).language).toBe('en');
  expect(parseInputs(await renderProjectWorkflow({ ...answers, language: 'pt-BR' }, english)).language).toBe(undefined);
});

test('keeps the incident lists setup does not ask about', async () => {
  const answers = { deploy: 'none', solo: true, incidents: true };
  const existing = (await renderProjectWorkflow(answers)).replace(
    '    with:\n',
    `    with:\n      incident-environments: '["production","qa"]'\n      incident-types: '["exception"]'\n`,
  );

  // Without staging, the environments question is not asked: the list stays as it is
  const again = parseInputs(await renderProjectWorkflow({ ...answers, incidentPerformance: false }, existing));
  expect(again['incident-environments']).toBe(`'["production","qa"]'`);
  expect(again['incident-types']).toBe(`'["exception"]'`);

  // Answered questions change only their own value
  const staging = parseInputs(
    await renderProjectWorkflow({ ...answers, incidentStaging: true, incidentPerformance: true }, existing),
  );
  expect(staging['incident-environments']).toBe(`'["production","qa","staging"]'`);
  expect(staging['incident-types']).toBe(undefined);
});

test('deploys production from its own branch', async () => {
  const answers = { deploy: 'forge', staging: true, productionBranch: 'main', solo: true, incidents: true };
  const content = await renderProjectWorkflow(answers, '', 'develop');
  expect(content).toMatch(/push:\n {4}branches: \[develop, main\]\n/);
  expect(parseInputs(content)['production-branch']).toBe('main');
  expect(projectAnswers(parseInputs(content)).productionBranch).toBe('main');
  expect(await changesOutside(content, 'develop')).toBe(false);

  // Without staging the default branch would deploy nothing, so the input is left out
  const single = await renderProjectWorkflow({ ...answers, staging: false }, content, 'develop');
  expect(parseInputs(single)['production-branch']).toBeUndefined();
  expect(single).toMatch(/branches: \[develop\]\n/);
});

test('matches a branch against the push filter like GitHub', () => {
  expect(runsOnPush(null, 'main')).toBe(true);
  expect(runsOnPush(['develop', 'main'], 'main')).toBe(true);
  expect(runsOnPush(['develop'], 'main')).toBe(false);
  expect(runsOnPush(['main*'], 'main-v2')).toBe(true);
  expect(runsOnPush(['release/*'], 'release/1.0')).toBe(true);
  expect(runsOnPush(['*'], 'release/1.0')).toBe(false);
  expect(runsOnPush(['**'], 'release/1.0')).toBe(true);
  expect(runsOnPush(['v[12].x'], 'v2.x')).toBe(true);
  // ? makes the character before it optional, as in a regular expression
  expect(runsOnPush(['v2?'], 'v')).toBe(true);
  expect(runsOnPush(['v?'], 'v2')).toBe(false);
  expect(runsOnPush(['v1.x'], 'v1-x')).toBe(false);
  // The last matching pattern wins
  expect(runsOnPush(['**', '!main'], 'main')).toBe(false);
  expect(runsOnPush(['**', '!main', 'main'], 'main')).toBe(true);
  expect(runsOnPush(['[main'], '[main')).toBe(true);
  // \ escapes a special character
  expect(runsOnPush(['release\\*'], 'release*')).toBe(true);
  expect(runsOnPush(['release\\*'], 'release-1')).toBe(false);
});

test('reads the push filter, also as branches-ignore or tags only', () => {
  const push = (filter) => pushBranches(`on:\n  push:\n${filter}  pull_request:\n`);
  expect(push('    branches: [develop, main]\n')).toStrictEqual(['develop', 'main']);
  expect(push('    branches:\n      - develop\n      - "main"\n')).toStrictEqual(['develop', 'main']);
  expect(push('    branches-ignore: [main]\n')).toStrictEqual(['**', '!main']);
  expect(runsOnPush(push('    branches-ignore: [main]\n'), 'main')).toBe(false);
  expect(runsOnPush(push('    branches-ignore: [main]\n'), 'develop')).toBe(true);
  // Only tags: no branch push runs the workflow
  expect(push('    tags: ["v*"]\n')).toStrictEqual([]);
  expect(runsOnPush(push('    tags: ["v*"]\n'), 'main')).toBe(false);
  expect(push('    tags-ignore:\n      - "v*"\n')).toStrictEqual([]);
  expect(push('    paths: [src/**]\n')).toBe(null);
});

test('reads a workflow file with CRLF line ends, also in the template comparison and the uses key', async () => {
  const crlf =
    'on:\r\n  push:\r\n    branches: [main]\r\njobs:\r\n  pipeline:\r\n    with:\r\n      php-version: "8.3"\r\n';
  expect(parseInputs(crlf)).toStrictEqual({ 'php-version': '"8.3"' });
  expect(pushBranches(crlf)).toStrictEqual(['main']);

  const content = (await renderProjectWorkflow({ deploy: 'none' })).replace(/\n/g, '\r\n');
  expect(await changesOutside(content)).toBe(false);
  expect(usesRef(content, PROJECT_REF)).toBe('v2');
  // A lone CR (old Mac line ends) is a line end too
  expect(lf('on:\r  push:\r\n')).toBe('on:\n  push:\n');
});

test('reads comments in the push filter, and tells no push trigger from one without a filter', () => {
  const push = (lines) => pushBranches(`on:\n${lines}jobs: {}\n`);
  expect(push('  push:\n    branches:\n      # production\n      - main\n\n      - develop\n')).toStrictEqual([
    'main',
    'develop',
  ]);
  expect(push('  push:\n    branches: # deploys\n      - main\n')).toStrictEqual(['main']);
  expect(push('  pull_request:\n')).toStrictEqual([]);
  expect(push('  push:\n  pull_request:\n')).toBe(null);
  expect(pushBranches('on: [pull_request]\n')).toStrictEqual([]);
  expect(pushBranches('on: [push, pull_request]\n')).toBe(null);
  // A flow mapping on one line
  expect(pushBranches('on: { push: { branches: [develop] }, pull_request: {} }\n')).toStrictEqual(['develop']);
  expect(runsOnPush(pushBranches('on: { push: { branches: [develop] } }\n'), 'main')).toBe(false);
  expect(pushBranches("on: { push: { 'branches-ignore': [main] } }\n")).toStrictEqual(['**', '!main']);
  expect(pushBranches('on: { push: { tags: [v*] } }\n')).toStrictEqual([]);
  expect(pushBranches('on: { push: {}, pull_request: {} }\n')).toBe(null);
  expect(pushBranches('on: { push: null }\n')).toBe(null);
  expect(pushBranches('on: { pull_request: { branches: [main] } }\n')).toStrictEqual([]);
  // Quoted keys, as some formatters write them
  expect(pushBranches("'on':\n  push:\n    branches: [main]\n")).toStrictEqual(['main']);
  expect(pushBranches('"on":\n  push:\n    branches: [main]\n')).toStrictEqual(['main']);
});

test('reads the version of a reusable workflow from its uses key only', () => {
  const ref = 'datalogix/workflows/.github/workflows/project.yml@v2';
  const file = `    # uses: ${ref}\n    uses: "datalogix/workflows/.github/workflows/project.yml@v1"\n`;
  expect(usesRef(file, ref)).toBe('v1');
  expect(usesRef('    # uses: datalogix/workflows/.github/workflows/project.yml@v2\n', ref)).toBe(null);
  // A step written as a list item
  expect(usesRef(`      - uses: ${ref}\n`, ref)).toBe('v2');
});

test('tells a release of the major from another major and from a branch or a commit', () => {
  const ref = 'datalogix/workflows/.github/workflows/project.yml@v2';
  const at = (version) => refStatus(`    uses: datalogix/workflows/.github/workflows/project.yml@${version}\n`, ref);
  expect(at('v2')).toStrictEqual({ status: 'release', version: 'v2' });
  expect(at('v2.10.3')).toStrictEqual({ status: 'release', version: 'v2.10.3' });
  expect(at('v1')).toStrictEqual({ status: 'other-major', version: 'v1' });
  expect(at('v3')).toStrictEqual({ status: 'other-major', version: 'v3' });
  expect(at('v1.2.0')).toStrictEqual({ status: 'other-major', version: 'v1.2.0' });
  expect(at('main')).toStrictEqual({ status: 'other-ref', version: 'main' });
  expect(at('feat/gate')).toStrictEqual({ status: 'other-ref', version: 'feat/gate' });
  expect(at('c771104')).toStrictEqual({ status: 'other-ref', version: 'c771104' });
  expect(at('v2.1')).toStrictEqual({ status: 'other-ref', version: 'v2.1' });
  expect(refStatus(null, ref)).toStrictEqual({ status: 'missing', version: null });
  expect(refStatus('on: push\n', ref)).toStrictEqual({ status: 'missing', version: null });
});

test('finds comments in the with block', () => {
  expect(hasInputComments('jobs:\n  pipeline:\n    with:\n      # PHP of the server\n      php-version: "8.3"\n')).toBe(
    true,
  );
  expect(hasInputComments('jobs:\n  pipeline:\n    with:\n      php-version: "8.3" # server\n')).toBe(false);
});

test('tells a comment in the with block from a # line of a multi-line value', () => {
  const block = (inputs) => hasInputComments(`jobs:\n  pipeline:\n    with:\n${inputs}`);
  // Part of a block scalar, after blank or deeper lines too
  expect(block('      extra: |\n        # not a comment\n      deploy: forge\n')).toBe(false);
  expect(block('      extra: >-\n        first\n\n        # still the value\n')).toBe(false);
  expect(block('      extra: |2 # kept\n        # the value\n')).toBe(false);
  // A deeper comment after a single-line value is a comment
  expect(block('      deploy: forge\n        # production only\n      staging: false\n')).toBe(true);
  expect(block('      extra: |\n        value\n      deploy: forge\n          # prod\n')).toBe(true);
  expect(block('      extra: "|"\n        # a comment\n')).toBe(true);
  // A comment at the inputs' indentation ends the multi-line value
  expect(block('      extra: |\n        value\n      # deploys\n      deploy: forge\n')).toBe(true);
});

test('reads the comment after an input value', () => {
  expect(inputComment('forge # prod')).toBe('# prod');
  expect(inputComment(`'["production"]'  # only production`)).toBe('# only production');
  // A # inside quotes or without a space before it is part of the value
  expect(inputComment(`'a # b'`)).toBe(null);
  expect(inputComment('a#b')).toBe(null);
  expect(inputComment('forge')).toBe(null);
  expect(inputComment(undefined)).toBe(null);
});

test('finds the input comments the rendered file drops', () => {
  const file = (inputs) => `jobs:\n  pipeline:\n    with:\n${inputs.map((input) => `      ${input}\n`).join('')}`;
  const existing = file(['deploy: forge # prod', 'php-version: "8.3" # server', 'staging: false']);
  expect(droppedInputComments(existing, file(['deploy: cloud', 'php-version: "8.3" # server']))).toStrictEqual([
    'deploy',
  ]);
  expect(droppedInputComments(existing, existing)).toStrictEqual([]);
  // An input the rendered file no longer has loses its comment too; a comment kept with another value is not lost
  expect(droppedInputComments(file(['staging: false # prod only']), file([]))).toStrictEqual(['staging']);
  expect(droppedInputComments(existing, file(['deploy: cloud # prod', 'php-version: "8.3" # server']))).toStrictEqual(
    [],
  );
});

test('reads only what a package workflow file can say', () => {
  expect(packageAnswers({ stack: 'laravel', coverage: 'false # no codecov', 'test-command': 'none' })).toStrictEqual({
    stack: 'laravel',
    tests: undefined,
    coverage: false,
    // The Claude layers and the risk gate are off unless the file turns them on
    claude: false,
    review: false,
    securityReview: false,
    riskGate: false,
    language: 'pt-BR',
    apiCheck: false,
    pint: undefined,
    phpstan: undefined,
    rector: undefined,
    lintCommand: null,
    testCommand: 'none',
    minCoverage: null,
  });
});

test('keeps what the file has after the with block, such as another job', async () => {
  const extra = '  # Runs the smoke tests\n  smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n';
  const base = await renderProjectWorkflow({ deploy: 'forge' });
  const existing = `${base}\n${extra}`;
  expect(parseInputs(existing)).toStrictEqual({ deploy: 'forge' });
  expect(await changesOutside(existing)).toBe(false);
  expect(hasInputComments(existing)).toBe(false);

  const rendered = await renderProjectWorkflow({ deploy: 'forge', solo: true }, existing);
  expect(rendered).toBe(`${await renderProjectWorkflow({ deploy: 'forge', solo: true })}\n${extra}`);
  expect(await renderProjectWorkflow({ deploy: 'forge', solo: true }, rendered)).toBe(rendered);
  expect(await renderPackageWorkflow(`${await renderPackageWorkflow()}\n${extra}`)).toBe(
    `${await renderPackageWorkflow()}\n${extra}`,
  );
  // Also without a with block: the other job is not compared with the template
  expect(hasChangesOutsideInputs(`${await renderPackageWorkflow()}\n${extra}`, await packageTemplate('main'))).toBe(
    false,
  );
});

test('reads a with line that ends with a comment', async () => {
  const content = (await renderProjectWorkflow({ deploy: 'forge' })).replace('    with:', '    with: # inputs');
  expect(parseInputs(content)).toStrictEqual({ deploy: 'forge' });
  expect(await changesOutside(content)).toBe(false);
  // The comment is not written back
  expect(hasInputComments(content)).toBe(true);
  expect(projectAnswers(parseInputs(`${content.trimEnd()}\n      tests: false\n`)).tests).toBe(false);
});

test('renders the package workflow without inputs', async () => {
  const content = await renderPackageWorkflow('', 'main');
  expect(content).toContain('branches: [main]');
  expect(content).not.toMatch(/^ {4}with:/m);
  expect(content).toMatch(/secrets: inherit\n {4}# All inputs are optional:\n/);
});

test('keeps the inputs of the existing package workflow file', async () => {
  const existing = (await renderPackageWorkflow('', 'main')).concat('    with:\n      pint: false\n');
  const content = await renderPackageWorkflow(existing, 'develop');
  expect(parseInputs(content)).toStrictEqual({ pint: 'false' });
  expect(content).toContain('branches: [develop]');
});

test('reads edge cases of the workflow file as nothing set', () => {
  expect(hasInputComments('jobs:\n  pipeline:\n    uses: x\n')).toBe(false);
  // Without an on: it can read, every push runs it
  expect(pushBranches('jobs: {}\n')).toBe(null);
  expect(listOf("'not json'")).toBe(null);
  expect(listOf('\'{"a": 1}\'')).toBe(null);
  expect(scalar('main # deploys')).toBe('main');
});

test('reads a quoted value before a comment', () => {
  expect(scalar('"a b" # comment')).toBe('a b');
});

test('writes github-deployments only when it is off and the app deploys, and reads it back', async () => {
  const off = await renderProjectWorkflow({ deploy: 'forge', staging: true, githubDeployments: false });
  expect(parseInputs(off)['github-deployments']).toBe('false');
  expect(projectAnswers(parseInputs(off)).githubDeployments).toBe(false);

  const on = await renderProjectWorkflow({ deploy: 'forge', staging: true, githubDeployments: true }, off);
  expect(parseInputs(on)).not.toHaveProperty('github-deployments');
  expect(projectAnswers(parseInputs(on)).githubDeployments).toBeUndefined();
  // Without deploys there is nothing to record: the input goes away
  expect(
    parseInputs(await renderProjectWorkflow({ deploy: 'none', githubDeployments: false }, off)),
  ).not.toHaveProperty('github-deployments');
});

test('writes the layers, production, approvals and js inputs only when they leave the default', async () => {
  const answers = {
    deploy: 'forge',
    staging: true,
    production: 'manual',
    review: false,
    securityReview: true,
    riskGate: true,
    fixCi: false,
    approvalsMedium: '0',
    approvalsHigh: '2',
    js: false,
  };
  const content = await renderProjectWorkflow(answers);
  expect(parseInputs(content)).toStrictEqual({
    review: 'false',
    'fix-ci': 'false',
    deploy: 'forge',
    production: 'manual',
    'approvals-medium': '0',
    'approvals-high': '2',
    js: 'false',
  });
  expect(projectAnswers(parseInputs(content))).toMatchObject({
    production: 'manual',
    review: false,
    securityReview: undefined,
    fixCi: false,
    approvalsMedium: '0',
    approvalsHigh: '2',
    js: false,
  });

  // Back to the defaults, nothing is written; questions not asked keep what the file has
  const defaults = {
    deploy: 'forge',
    staging: true,
    production: 'auto',
    review: true,
    fixCi: true,
    approvalsMedium: '1',
    approvalsHigh: '1',
    js: true,
  };
  expect(parseInputs(await renderProjectWorkflow(defaults, content))).toStrictEqual({ deploy: 'forge' });
  expect(parseInputs(await renderProjectWorkflow({ deploy: 'forge', staging: true }, content))).toStrictEqual(
    parseInputs(content),
  );
});

test('writes the monitoring service only when it is not Nightwatch, and reads it back', async () => {
  const nightwatch = await renderProjectWorkflow({ deploy: 'none', monitoring: 'nightwatch' });
  expect(parseInputs(nightwatch).monitoring).toBe(undefined);
  expect(projectAnswers(parseInputs(nightwatch)).monitoring).toBe('nightwatch');

  const sentry = await renderProjectWorkflow({ deploy: 'none', monitoring: 'sentry' }, nightwatch);
  expect(parseInputs(sentry).monitoring).toBe('sentry');
  expect(projectAnswers(parseInputs(sentry)).monitoring).toBe('sentry');
  // Not asked again: the file keeps it
  expect(parseInputs(await renderProjectWorkflow({ deploy: 'none' }, sentry)).monitoring).toBe('sentry');
});

test('reads the inputs of the pipeline job only, even after another job with inputs', async () => {
  const other = '  other:\n    uses: ./.github/workflows/other.yml\n    with:\n      tests: false\n\n';
  const workflow = (await renderProjectWorkflow({ deploy: 'forge', domain: 'app.test' })).replace(
    '  pipeline:',
    `${other}  pipeline:`,
  );
  expect(parseInputs(workflow)).toMatchObject({ deploy: 'forge' });
  expect(parseInputs(workflow).tests).toBeUndefined();
  // Setup keeps the other job's inputs out of the pipeline's
  const rendered = await renderProjectWorkflow({ deploy: 'forge', domain: 'app.test' }, workflow);
  expect(parseInputs(rendered).tests).toBeUndefined();
});

test('reads a push filter written on the push line, and a comment in column 0 inside on:', () => {
  expect(pushBranches('on:\n  push: { branches: [main, develop] }\n  pull_request:\n')).toStrictEqual([
    'main',
    'develop',
  ]);
  expect(pushBranches('on:\n  push: {}\n')).toBe(null);
  expect(pushBranches('on:\n  push: ~\n')).toBe(null);
  expect(pushBranches('on:\n# deploys\n  push:\n    branches: [main]\n  pull_request:\n')).toStrictEqual(['main']);
  expect(pushBranches('on:\n  push:\n# the branches that deploy\n    branches: [main]\n')).toStrictEqual(['main']);
});

test('counts as a comment of the with block only a line at the inputs indentation, not one of a multi-line value', () => {
  const block = (lines) => `jobs:\n  pipeline:\n    uses: x\n    with:\n${lines}\n`;
  expect(hasInputComments(block('      test-command: |\n        # run the suite\n        vendor/bin/pest'))).toBe(
    false,
  );
  expect(hasInputComments(block('      # the suite\n      test-command: vendor/bin/pest'))).toBe(true);
});

test('reads quoted values with their escapes, as YAML does', () => {
  expect(scalar("'it''s'")).toBe("it's");
  expect(scalar('"say \\"hi\\""')).toBe('say "hi"');
  expect(scalar('"a # b" # comment')).toBe('a # b');
  expect(scalar("'' # empty")).toBe('');
});
