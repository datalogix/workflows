import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectKind } from '../../kinds/project/index.js';
import { monitoringServices } from '../../providers/monitoring/index.js';
import { clack, cyan, orExit, question } from '../../lib/ui.js';

// What a JavaScript app (Next, Nuxt) adds to project.yml (cli/kinds/project/index.js): Sentry, and whether the tests run
// its end-to-end tests. Not deployed by the workflows yet

// Sentry's SDK and wizard of each framework
const SENTRY = {
  next: { name: '@sentry/nextjs', wizard: 'nextjs' },
  nuxt: { name: '@sentry/nuxt', wizard: 'nuxt' },
};

/** The framework, the end-to-end tests script and whether Sentry's SDK is installed, from package.json. */
async function inspectApp(root) {
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch {
    // An app without a readable package.json: nothing to say
  }
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const framework = ['next', 'nuxt'].find((name) => names.includes(name)) ?? null;
  return {
    framework,
    e2eScript: Boolean(manifest.scripts?.['test:e2e']),
    sentry: names.some((name) => name === SENTRY.next.name || name === SENTRY.nuxt.name),
  };
}

/** Whether the tests run the test:e2e script, asked when package.json has one. */
const e2eStep = {
  id: 'e2e',
  when: (a, ctx) => ctx.state.e2eScript,
  ask: async ({ header, ctx }) =>
    orExit(
      await clack.confirm({
        message: question(
          header,
          'Run the end-to-end tests (test:e2e) in the tests?',
          "After the build, with Playwright's browsers when the project uses Playwright; a failure fails the tests check",
        ),
        initialValue: ctx.state.current?.e2e ?? true,
      }),
    ),
};

/** Sentry's SDK, when its problems become issues and the app does not have it yet. */
function sentryNextSteps(answers, { state }) {
  if (answers.monitoring !== 'sentry' || !answers.incidents || state.sentry) return [];
  const sdk = SENTRY[state.framework];
  return [
    sdk
      ? `Install Sentry's SDK in the app, or nothing reaches Sentry: ${cyan(`npx @sentry/wizard@latest -i ${sdk.wizard}`)}`
      : "Install Sentry's SDK in the app, or nothing reaches Sentry.",
  ];
}

/** Whether Sentry's SDK is in the app, when Sentry is on. */
function evaluateMonitoring({ ok, warn }, state) {
  if ((state.current?.monitoring ?? 'sentry') !== 'sentry') return;
  const sdk = SENTRY[state.framework]?.name ?? '@sentry/nextjs or @sentry/nuxt';
  if (state.sentry) ok(`${sdk} in package.json`);
  else warn(`package.json does not require ${sdk}, so nothing reaches Sentry`, `npm install ${sdk}`);
}

export default projectKind({
  id: 'js',
  deployTargets: [],
  deployHookHint: '',
  monitoring: monitoringServices(['sentry']),
  empty: { framework: null, e2eScript: false, sentry: false },
  inspect: inspectApp,
  healthPath: () => '/',
  steps: () => [e2eStep],
  tasks: () => [],
  files: {},
  deployNextSteps: () => [],
  nextSteps: sentryNextSteps,
  evaluateDeploy: () => {},
  evaluateMonitoring,
});
