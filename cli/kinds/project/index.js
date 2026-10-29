import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { codeOwnerItems, createReport, ORG, PROTECT, rulesetItems, SETUP, workflowItems } from '../../lib/evaluate.js';
import { includedRefs, protectsBranch, requiredChecks } from '../../lib/ruleset.js';
import { checksOn, readOrFail } from '../../lib/state.js';
import { codeOwnersStep, repositoryStep, soloStep } from '../../lib/steps.js';
import { changedFiles, codeOwnersTask, TASK_FILES, workflowFileTask, workflowWarnings } from '../../lib/tasks.js';
import { bold, clack, cyan, dim, orExit, question } from '../../lib/ui.js';
import { pushBranches, runsOnPush, WORKFLOW_PATH } from '../../lib/workflow-file.js';
import { domainOf, isDomain, pathOf, suggestedDomain } from './domain.js';
import {
  hasSecret,
  loadRelayConfig,
  readSecret,
  registerSecret,
  relayAccepts,
  relaySupported,
  webhookUrl,
} from './relay.js';
import {
  deployedProductionBranch,
  hasReleaseApp,
  labelDescription,
  labelsFor,
  NO_ENVIRONMENT,
  textIn,
} from './state.js';
import {
  DEFAULT_LANGUAGE,
  LAYERS,
  PROJECT_REF,
  projectAnswers,
  projectTemplate,
  renderProjectWorkflow,
} from './workflow.js';

// What project.yml needs from a project, whatever its stack: the workflow file, labels, the Claude token, environments
// with their deploy hook and health URL, the production branch and its release pull requests, the monitoring relay,
// the ruleset and the code owners. A stack's app module (cli/stacks/<stack>/app.js) calls projectKind with what only it
// knows: where it deploys, its monitoring service, its health check and its own questions, tasks and check items.

// Check of each layer that can be required (project.yml), keyed by its answer in projectAnswers (inputs tests,
// security-review, risk-gate)
export const PROJECT_CHECKS = {
  tests: 'pipeline / tests / tests',
  securityReview: 'pipeline / security / security',
  riskGate: 'pipeline / gate / gate',
};

// What the kind reads (readProject), before it is read
const PROJECT_STATE = {
  labels: [],
  labelDescriptions: {},
  environments: { production: NO_ENVIRONMENT, staging: NO_ENVIRONMENT },
  claudeToken: { repository: false, organization: false },
  releaseApp: false,
  actionsPullRequests: null,
  productionBranchStatus: null,
  // How the Claude GitHub App reaches the owner's repositories (github.claudeApp); 'all' until it is read
  claudeApp: 'all',
  // The app's locale (e.g. pt_BR), read by the stack's inspect: the suggested domain ends with .com.br for pt_BR
  locale: null,
};

export const deploys = (a) => Boolean(a.deploy) && a.deploy !== 'none';
const twoBranches = (a) => Boolean(a.branches && a.productionBranch);
// The production branch of the current workflow file, when it exists
const existingProductionBranch = (state) =>
  state.productionBranchStatus?.exists ? state.productionBranchStatus.name : null;
// The production branch a project that keeps deploying leaves: it becomes the default branch again, or the development
// branch deploys production. Null when it does not leave one, or the branch no longer exists
const formerProductionBranch = (a, state) => (!twoBranches(a) && deploys(a) ? existingProductionBranch(state) : null);

const notEmpty = (value) => (value?.trim() ? undefined : 'Required');
const validDomain = (value) =>
  isDomain(value ?? '') ? undefined : 'Type only the domain, e.g. app.example.com (no https://)';
const validPath = (value) => (/^\/\S*$/.test(value ?? '') ? undefined : 'Start with /, e.g. /up');
// Also what git refuses (git check-ref-format): empty components (a//b, /a), components that start with a dot or end
// with .lock; @{ is outside the allowed characters
const validBranch = (value) =>
  /^(?!-)(?!.*\.\.)[\w./-]+$/.test(value ?? '') && !/[./]$|^\/|\/\/|(^|\/)\.|\.lock(\/|$)/.test(value)
    ? undefined
    : 'Use a branch name, e.g. main';
// The App's private key file, as GitHub downloads it; ~ is the home folder
const keyPath = (value) => resolve(value.trim().replace(/^~(?=$|\/)/, homedir()));
const readKey = (value) => readFileSync(keyPath(value), 'utf8');
const validKey = (value) => {
  try {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(readKey(value ?? ''))
      ? undefined
      : 'Not a private key (.pem) file';
  } catch {
    return 'Cannot read that file';
  }
};
// Goes into Claude's system prompt between double quotes: letters, digits, spaces, hyphens and underscores only
const validLanguage = (value) =>
  /^\p{L}[\p{L}\p{N} _-]*$/u.test(value?.trim() ?? '') ? undefined : 'Use a language name or code, e.g. pt-BR or en';
// What an empty signing secret does: registered (true), not registered (false) or unknown (null, the relay was not read)
const relayHint = (registered) =>
  registered === null
    ? '  empty to keep it as it is'
    : registered
      ? '  empty to keep the current one'
      : '  empty to set it later; until then, problems do not become issues';
// --layers review,security-review,risk-gate,fix-ci, or none: the inputs of LAYERS
const layerChoices = (value) => (value.trim() === 'none' ? [] : value.split(',').map((choice) => choice.trim()));
const validLayers = (value) =>
  layerChoices(value ?? '').every((choice) => Object.values(LAYERS).includes(choice))
    ? undefined
    : `use ${Object.values(LAYERS).join(', ')} separated by commas, or none`;
const validApprovals = (value) => (/^\d+$/.test(value?.trim() ?? '') ? undefined : 'Use a whole number, e.g. 1');
const validUrl = (value) => (/^https:\/\/\S+$/.test(value?.trim() ?? '') ? undefined : 'Paste the full https:// URL');

/**
 * A secret question: keep the current value or type a new one, one question at a time. An optional secret may be left
 * empty, to set it later.
 */
function secretSteps(id, { label, exists, when, validate: validValue = notEmpty, hint, about, optional = false }) {
  const validate = optional ? (value) => (value?.trim() ? validValue(value) : undefined) : validValue;
  // The label and the hint may depend on the answers
  const labelOf = (answers) => (typeof label === 'function' ? label(answers) : label);
  const hintsOf = (answers) =>
    [typeof hint === 'function' ? hint(answers) : hint, optional && 'empty to set it later']
      .filter(Boolean)
      .join(' · ');
  return [
    {
      id: `${id}Keep`,
      when: (a, ctx) => when(a, ctx) && exists(ctx),
      ask: async ({ header, answers }) =>
        orExit(
          await clack.select({
            message: question(header, `${labelOf(answers)} is already set. Keep it?`),
            options: [
              { value: true, label: 'Keep the current one' },
              { value: false, label: 'Replace it' },
            ],
          }),
        ),
    },
    {
      id,
      validate,
      when: (a, ctx) => when(a, ctx) && (!exists(ctx) || a[`${id}Keep`] === false),
      ask: async ({ header, answers }) => {
        const hints = hintsOf(answers);
        return orExit(
          await clack.password({
            message: question(header, `${labelOf(answers)}${hints ? dim(`  ${hints}`) : ''}`, about),
            validate,
          }),
        );
      },
    },
  ];
}

const ownerOf = (repository) => repository.split('/')[0];

// The monitoring service the answers (or the workflow file, as answers) chose, the stack's first by default; null when
// the project uses none
const monitoringOf = (stack, a) =>
  a?.monitoring === 'none'
    ? null
    : (stack.monitoring.find((service) => service.id === a?.monitoring) ?? stack.monitoring[0]);
// What the questions and messages name: the chosen service, or the stack's first
const serviceOf = (stack, a) => monitoringOf(stack, a) ?? stack.monitoring[0];
// What the relay stores for the service: a signing secret, or one key per environment (Inspector)
const secretName = (service) => (service.keyPerEnvironment ? 'application keys' : 'signing secret');

/** The keys stored by environment for a service with one key per environment, {} when none or not such JSON. */
function storedKeys(secret) {
  try {
    const keys = JSON.parse(secret);
    return keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
  } catch {
    return {};
  }
}

/** Loads the relay settings of an owner into ctx, remembering whose they are. */
async function loadRelay(ctx, owner) {
  ctx.relay = await loadRelayConfig(owner);
  ctx.relayOwner = owner;
}

/**
 * The repository step, then the relay settings of its owner: when prepare had no repository to load them for, or loaded
 * them for the folder's repository and the answer has another owner. Settings given without an owner (tests) stay.
 */
function withRelay(step) {
  return {
    ...step,
    then: async (answers, ctx) => {
      await step.then(answers, ctx);
      const owner = ownerOf(answers.repository);
      const other = ctx.relayOwner !== undefined && ctx.relayOwner.toLowerCase() !== owner.toLowerCase();
      if (ctx.relay === undefined || ctx.relay === null || other) await loadRelay(ctx, owner);
    },
  };
}

/** The questions, in order. */
function setupSteps(stack) {
  const staging = (a) => deploys(a) && a.staging;
  const markers = (a) => Boolean(monitoringOf(stack, a)?.markers(a));
  const monitors = (a) => monitoringOf(stack, a) !== null;
  const branches = (a) => staging(a) && a.branches;
  const targets = [...stack.deployTargets.map((target) => target.value), 'none'];

  return [
    // How release pull requests are opened: setup can turn a production branch on
    withRelay(repositoryStep({ readOptions: { release: true } })),
    {
      id: 'deploy',
      flag: 'deploy',
      // The stack's targets: --deploy is checked here, as each stack deploys elsewhere
      validate: (value) => (targets.includes(value) ? undefined : `use ${targets.join(', ')}`),
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.select({
            message: question(header, 'Where is the app deployed?'),
            initialValue: ctx.state.current?.deploy ?? stack.deployTargets[0].value,
            options: [
              ...stack.deployTargets,
              { value: 'none', label: 'Not deployed by the workflows', hint: 'tests and reviews only' },
            ],
          }),
        ),
    },
    {
      id: 'domain',
      flag: 'domain',
      validate: validDomain,
      when: deploys,
      ask: async ({ header, answers, ctx }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              'Production domain',
              'After each deploy, https://<domain><health check path> is checked',
            ),
            initialValue:
              domainOf(ctx.state.environments.production.healthUrl ?? '') ??
              suggestedDomain(answers.repository, ctx.state.locale),
            placeholder: 'app.example.com',
            validate: validDomain,
          }),
        ),
    },
    {
      id: 'staging',
      flag: 'staging',
      when: deploys,
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.confirm({
            message: question(
              header,
              'Deploy to a staging environment before production?',
              'Each deploy goes to staging first and is watched; production only gets it if staging stays healthy',
            ),
            initialValue: ctx.state.current?.staging ?? true,
          }),
        ),
    },
    {
      id: 'stagingDomain',
      flag: 'staging-domain',
      validate: validDomain,
      when: staging,
      ask: async ({ header, answers, ctx }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              'Staging domain',
              'Where staging is checked after each deploy; to have no staging, answer no to the previous question',
            ),
            initialValue: domainOf(ctx.state.environments.staging.healthUrl ?? '') ?? `dev.${answers.domain}`,
            validate: validDomain,
          }),
        ),
    },
    {
      id: 'branches',
      flag: 'branches',
      when: staging,
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.confirm({
            message: question(
              header,
              'Deploy production from its own branch?',
              'The development branch deploys staging; merging the release pull request into the production branch deploys production',
            ),
            initialValue: Boolean(ctx.state.current?.productionBranch),
          }),
        ),
    },
    {
      id: 'developmentBranch',
      flag: 'development-branch',
      validate: validBranch,
      when: branches,
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              `Development branch${dim('  becomes the default branch')}`,
              'Each push to it deploys staging; created from the default branch when missing',
            ),
            initialValue: ctx.state.current?.productionBranch ? ctx.state.defaultBranch : 'develop',
            validate: validBranch,
          }),
        ),
    },
    {
      id: 'productionBranch',
      flag: 'production-branch',
      validate: validBranch,
      when: branches,
      ask: async ({ header, answers, ctx }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              'Production branch',
              'Each push to it deploys production; created from what production runs today when missing',
            ),
            // The current one, else main; the first that differs from the development branch, so the prefilled value is valid
            initialValue: [ctx.state.current?.productionBranch, 'main', 'production'].find(
              (name) => name && name !== answers.developmentBranch,
            ),
            validate: (value) =>
              validBranch(value) ?? (value === answers.developmentBranch ? 'Use another branch' : undefined),
          }),
        ),
      then: (answers) => {
        if (answers.productionBranch === answers.developmentBranch) {
          throw new Error('The production branch must differ from the development branch');
        }
      },
    },
    {
      id: 'production',
      flag: 'production',
      validate: (value) => (['auto', 'manual'].includes(value) ? undefined : 'use auto or manual'),
      when: deploys,
      ask: async ({ header, answers, ctx }) =>
        orExit(
          await clack.select({
            message: question(
              header,
              'How does production deploy?',
              'Manually, production waits for someone to run the workflow from GitHub Actions',
            ),
            // Any other value than auto deploys only from Run workflow, as manual does
            initialValue: (ctx.state.current?.production ?? 'auto') === 'auto' ? 'auto' : 'manual',
            options: [
              {
                value: 'auto',
                label: 'Automatically',
                hint: twoBranches(answers)
                  ? `on each push to ${answers.productionBranch}`
                  : answers.staging
                    ? 'after staging stays healthy'
                    : 'after the tests',
              },
              { value: 'manual', label: 'Manually', hint: 'only from Actions > datalogix > Run workflow' },
            ],
          }),
        ),
    },
    {
      id: 'githubDeployments',
      flag: 'github-deployments',
      when: deploys,
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.confirm({
            message: question(
              header,
              "Record each deploy in the repository's Deployments?",
              "Each deploy and rollback appears in the repository's Deployments page and on its pull requests and commits; without it, the deploys work the same",
            ),
            initialValue: ctx.state.current?.githubDeployments ?? true,
          }),
        ),
    },
    {
      id: 'healthPath',
      flag: 'health-path',
      validate: validPath,
      when: deploys,
      ask: async ({ header, ctx }) => {
        const current = ctx.state.environments.production.healthUrl;
        return orExit(
          await clack.text({
            message: question(
              header,
              'Health check path',
              'Called every 30 seconds after each deploy; when it keeps failing, the deploy is rolled back, so it must answer 200 without a login or an IP allow list',
            ),
            initialValue: (current && pathOf(current)) || stack.healthPath(ctx),
            validate: validPath,
          }),
        );
      },
    },
    // The stack's questions about the deploy target, which may read the deploy hooks (answers.deployHooks)
    ...(stack.deploySteps?.() ?? []),
    ...secretSteps('productionHook', {
      label: 'Production deploy hook',
      hint: stack.deployHookHint,
      about: 'Empty: production deploys fail until setup runs again with it',
      when: (a) => deploys(a) && !a.deployHooks?.production,
      exists: (ctx) => ctx.state.environments.production.deployHook,
      validate: validUrl,
      // The site may not exist yet: its deploys fail until the hook is set
      optional: true,
    }),
    ...secretSteps('stagingHook', {
      label: 'Staging deploy hook',
      hint: stack.deployHookHint,
      about: 'Empty: staging deploys fail until setup runs again with it, and production waits for staging',
      when: (a) => staging(a) && !a.deployHooks?.staging,
      exists: (ctx) => ctx.state.environments.staging.deployHook,
      validate: validUrl,
      optional: true,
    }),
    {
      id: 'monitoring',
      flag: 'monitoring',
      validate: (value) =>
        [...stack.monitoring.map((service) => service.id), 'none'].includes(value)
          ? undefined
          : `use ${[...stack.monitoring.map((service) => service.id), 'none'].join(', ')}`,
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.select({
            message: question(
              header,
              'Which monitoring service does the app use?',
              'Its problems can become GitHub issues, and some mark each deploy',
            ),
            initialValue: ctx.state.current?.monitoring ?? stack.monitoring[0].id,
            options: [
              ...stack.monitoring.map((service) => ({ value: service.id, label: service.name, hint: service.hint })),
              { value: 'none', label: 'None', hint: 'no problems as issues' },
            ],
          }),
        ),
      // Without a service, nothing can become an issue
      then: (answers) => {
        if (answers.monitoring === 'none') answers.incidents = false;
      },
    },
    {
      id: 'monitoringMarkers',
      when: markers,
      ask: async ({ header, answers, ctx }) =>
        orExit(
          await clack.confirm({
            message: question(
              header,
              `Mark each deploy and rollback in ${serviceOf(stack, answers).name}?`,
              `${serviceOf(stack, answers).name} shows when each release went live, next to its errors and performance`,
            ),
            // Set up before with markers: keep the earlier choice, which the token tells
            initialValue:
              ctx.state.current && markers(ctx.state.current)
                ? ctx.state.environments.production.monitoringToken
                : true,
          }),
        ),
    },
    ...secretSteps('productionMonitoringToken', {
      label: (a) => `${serviceOf(stack, a).name} token of the production environment`,
      hint: (a) => serviceOf(stack, a).tokenHint,
      when: (a) => markers(a) && a.monitoringMarkers,
      exists: (ctx) => ctx.state.environments.production.monitoringToken,
    }),
    ...secretSteps('stagingMonitoringToken', {
      label: (a) => `${serviceOf(stack, a).name} token of the staging environment`,
      hint: (a) => serviceOf(stack, a).tokenHint,
      when: (a) => markers(a) && a.monitoringMarkers && staging(a),
      exists: (ctx) => ctx.state.environments.staging.monitoringToken,
    }),
    {
      id: 'claudeToken',
      when: (a, ctx) => !ctx.state.claudeToken.repository && !ctx.state.claudeToken.organization,
      ask: async ({ header }) =>
        orExit(
          await clack.password({
            message: question(
              header,
              `Claude token${dim('  from `claude setup-token`; stored as a repository secret')}`,
              'Used by every Claude workflow: @claude, the reviews, Fix CI and the analysis of production problems',
            ),
            validate: notEmpty,
          }),
        ),
    },
    {
      id: 'releaseAppClientId',
      // Organization secrets reach private repositories only on paid plans: elsewhere, the repository stores its own
      when: (a, ctx) => branches(a) && !ctx.state.releaseApp,
      ask: async ({ header }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              `Client ID of the release GitHub App${dim('  optional; empty to add it later')}`,
              'Empty: GitHub Actions opens the release pull requests, and their checks do not run',
            ),
            placeholder: 'Iv23li...',
          }),
        ),
    },
    {
      id: 'releaseAppKey',
      validate: validKey,
      when: (a, ctx) => branches(a) && !ctx.state.releaseApp && Boolean(a.releaseAppClientId?.trim()),
      ask: async ({ header }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              `Private key file of the release GitHub App${dim('  the .pem GitHub downloaded')}`,
            ),
            placeholder: '~/Downloads/app.private-key.pem',
            validate: validKey,
          }),
        ),
    },
    {
      id: 'incidents',
      flag: 'incidents',
      when: monitors,
      ask: async ({ header, answers, ctx }) =>
        orExit(
          await clack.confirm({
            message: question(
              header,
              `Turn problems detected by ${serviceOf(stack, answers).name} into GitHub issues?`,
              `Each problem opens one issue, with the release that was live; Claude analyzes it and suggests a fix. Needs the organization's monitoring relay`,
            ),
            initialValue: ctx.state.current?.incidents ?? true,
          }),
        ),
    },
    {
      id: 'incidentStaging',
      when: (a) => a.incidents && staging(a),
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.confirm({
            message: question(header, 'Include problems from staging?', 'Issues get the env:staging label'),
            initialValue: ctx.state.current?.incidentStaging ?? true,
          }),
        ),
    },
    {
      id: 'incidentPerformance',
      // Only from a service that reports performance problems
      when: (a) => a.incidents && serviceOf(stack, a).types.includes('performance'),
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.confirm({
            message: question(
              header,
              'Include performance problems (slow routes, jobs and commands)?',
              'Without them, only exceptions become issues',
            ),
            initialValue: ctx.state.current?.incidentPerformance ?? true,
          }),
        ),
    },
    {
      id: 'webhookSecret',
      when: (a, ctx) =>
        a.incidents && ctx.relay.configured && relaySupported() && relayAccepts(ctx.relay, a.repository),
      ask: async ({ header, answers, ctx }) => {
        const spinner = clack.spinner();
        spinner.start('Looking for the repository in the monitoring relay');
        const service = serviceOf(stack, answers);
        // A key per environment: the ones stored are read, so a key left empty keeps its current value
        const environments = answers.incidentStaging && staging(answers) ? ['production', 'staging'] : ['production'];
        let stored = null;
        if (service.keyPerEnvironment) {
          const secret = await readSecret(ctx.relay, service.id, answers.repository);
          stored = secret === null ? null : storedKeys(secret);
          ctx.relayRegistered = stored === null ? null : environments.every((environment) => stored[environment]);
        } else {
          ctx.relayRegistered = await hasSecret(ctx.relay, service.id, answers.repository);
        }
        spinner.stop(
          ctx.relayRegistered === null
            ? 'Could not read the monitoring relay (run npx wrangler login)'
            : ctx.relayRegistered
              ? 'Registered in the monitoring relay'
              : 'Not registered in the monitoring relay yet',
        );
        clack.note(
          [
            service.webhookHint,
            '',
            cyan(webhookUrl(ctx.relay, service.id, answers.repository)),
            '',
            service.secretHint,
          ].join('\n'),
          `${service.name} webhook`,
        );
        if (!service.keyPerEnvironment) {
          return orExit(
            await clack.password({
              message: question(header, `${service.name} signing secret${dim(relayHint(ctx.relayRegistered))}`),
            }),
          );
        }

        const typed = {};
        for (const environment of environments) {
          const registered = stored === null ? null : Boolean(stored[environment]);
          const key = orExit(
            await clack.password({
              message: question(header, `${service.name} key of ${environment}${dim(relayHint(registered))}`),
            }),
          ).trim();
          if (key) typed[environment] = key;
        }
        // Stored whole, with the keys not typed again; nothing typed stores nothing
        return Object.keys(typed).length ? JSON.stringify({ ...stored, ...typed }) : '';
      },
    },
    ...stack.steps(),
    {
      id: 'layers',
      flag: 'layers',
      validate: validLayers,
      parse: layerChoices,
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.multiselect({
            message: question(header, 'Claude and the risk gate on pull requests', [
              'Code review: Claude reviews the changes once per pull request and comments; @claude asks for another review',
              'Security review: Claude looks for vulnerabilities on every push; a finding from high up fails the required check',
              'Risk gate: labels each pull request low, medium or high risk by its files and size, and requires human approvals by level',
              "Fix CI: when the tests fail on one of Claude's pull requests, Claude tries to fix them (2 attempts)",
              "Each Claude workflow uses the Claude token's usage limits, shared by every project",
            ]),
            options: [
              { value: 'review', label: 'Code review', hint: 'once per pull request' },
              { value: 'security-review', label: 'Security review', hint: 'on every push; a required check' },
              { value: 'risk-gate', label: 'Risk gate', hint: 'human approvals by risk; a required check' },
              { value: 'fix-ci', label: 'Fix CI', hint: "on Claude's pull requests" },
            ],
            initialValues: Object.entries(LAYERS)
              .filter(([answer]) => ctx.state.current?.[answer] !== false)
              .map(([, input]) => input),
            required: false,
          }),
        ),
      then: (answers) => {
        for (const [answer, input] of Object.entries(LAYERS)) answers[answer] = answers.layers.includes(input);
      },
    },
    {
      id: 'language',
      flag: 'language',
      validate: validLanguage,
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              `Language of what is written for the team${dim('  issues, pull requests, comments and commits')}`,
            ),
            initialValue: ctx.state.current?.language ?? DEFAULT_LANGUAGE,
            placeholder: DEFAULT_LANGUAGE,
            validate: validLanguage,
          }),
        ),
    },
    soloStep({ subject: 'project', initial: (ctx) => ctx.state.current?.solo ?? true }),
    // A team project: how many people approve each risk level (solo maintainers count as their own approval)
    ...[
      ['approvalsMedium', 'approvals-medium', 'medium'],
      ['approvalsHigh', 'approvals-high', 'high'],
    ].map(([id, flag, level]) => ({
      id,
      flag,
      validate: validApprovals,
      when: (a) => a.riskGate !== false && a.solo === false,
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.text({
            message: question(
              header,
              `Human approvals a ${level}-risk pull request needs`,
              "0: the risk gate passes without one; the author's own approval never counts",
            ),
            initialValue: ctx.state.current?.[id] ?? '1',
            validate: validApprovals,
          }),
        ),
    })),
    codeOwnersStep(),
  ];
}

/** The workflow file the answers write; without two branches, its push branch is the one that deploys. */
function renderWorkflow(answers, state) {
  const productionBranch = twoBranches(answers) ? answers.productionBranch : null;
  const developmentBranch = twoBranches(answers)
    ? answers.developmentBranch
    : (formerProductionBranch(answers, state) ?? state.defaultBranch);
  return renderProjectWorkflow({ ...answers, productionBranch }, state.workflow ?? '', developmentBranch);
}

/** The changes the answers lead to, as tasks for the progress bar. */
function setupTasks(stack, answers, { github, root, state, relay, probe = healthStatus }) {
  const tasks = [];
  const environments = deploys(answers) ? (answers.staging ? ['production', 'staging'] : ['production']) : [];
  const domains = { production: answers.domain?.trim(), staging: answers.stagingDomain?.trim() };
  const hooks = {
    production: answers.deployHooks?.production ?? answers.productionHook,
    staging: answers.deployHooks?.staging ?? answers.stagingHook,
  };
  const tokens = { production: answers.productionMonitoringToken, staging: answers.stagingMonitoringToken };
  const productionBranch = twoBranches(answers) ? answers.productionBranch : null;
  const formerProduction = formerProductionBranch(answers, state);
  const developmentBranch = twoBranches(answers)
    ? answers.developmentBranch
    : (formerProduction ?? state.defaultBranch);

  tasks.push(workflowFileTask(() => renderWorkflow(answers, state), { root, state }));

  tasks.push(codeOwnersTask(answers, { root, state }));

  if (twoBranches(answers)) {
    tasks.push({
      id: 'branches',
      title: 'Branches',
      run: async () => {
        // A missing production branch starts from what production runs today: the former production branch when it
        // is renamed, else the default branch (on the first setup). A missing development branch starts from the
        // default branch, where the latest work is
        const created = [];
        const former = existingProductionBranch(state);
        // collectState already read the former production branch
        const known =
          former && state.productionBranchStatus.sha
            ? { [former]: { commit: { sha: state.productionBranchStatus.sha } } }
            : {};
        const lookup = (name) => known[name] ?? github.branch(name);
        const [development, production, defaultHead, formerHead] = await Promise.all([
          lookup(developmentBranch),
          lookup(productionBranch),
          lookup(state.defaultBranch),
          former && former !== productionBranch ? lookup(former) : null,
        ]);
        const sources = {
          [productionBranch]:
            formerHead ?? (state.defaultBranch !== developmentBranch ? defaultHead : null) ?? development,
          [developmentBranch]: defaultHead ?? production,
        };
        for (const [name, branch] of [
          [productionBranch, production],
          [developmentBranch, development],
        ]) {
          if (branch) continue;
          const source = sources[name];
          if (!source) throw new Error(`Neither ${developmentBranch} nor ${productionBranch} exists`);
          await github.createBranch(name, source.commit.sha);
          created.push(name);
        }
        const defaultChanged = state.defaultBranch !== developmentBranch;
        if (defaultChanged) await github.setDefaultBranch(developmentBranch);
        const changes = [
          ...created.map((name) => `created ${name}`),
          ...(defaultChanged ? [`${developmentBranch} is the default branch`] : []),
        ];
        // nextSteps reads data, never the text
        return { detail: changes.length ? changes.join(', ') : 'unchanged', data: { created, defaultChanged } };
      },
    });
  }

  if (formerProduction && state.defaultBranch !== formerProduction) {
    tasks.push({
      id: 'defaultBranch',
      title: 'Default branch',
      run: async () => {
        await github.setDefaultBranch(formerProduction);
        return `${formerProduction} is the default branch again`;
      },
    });
  }

  tasks.push({
    title: 'Labels',
    run: async () => {
      // Label names are case-insensitive on GitHub: "Rollback" is the rollback label
      const existing = new Map(state.labels.map((name) => [name.toLowerCase(), name]));
      const labels = labelsFor(environments);
      const missing = labels.filter((label) => !existing.has(label.name.toLowerCase()));
      // A description that is still the default text in another language follows the project's language; one written
      // by hand is kept
      const translations = labels
        .map((label) => ({ name: existing.get(label.name.toLowerCase()), label }))
        .filter(({ name, label }) => {
          const current = state.labelDescriptions[name];
          return (
            name &&
            current !== labelDescription(label, answers.language) &&
            Object.values(label.description).includes(current)
          );
        });
      // Each label is its own request, independent of the others
      await Promise.all([
        ...missing.map((label) =>
          github.createLabel(label.name, label.color, labelDescription(label, answers.language)),
        ),
        ...translations.map(({ name, label }) =>
          github.setLabelDescription(name, labelDescription(label, answers.language)),
        ),
      ]);
      const translated = translations.map(({ name }) => name);
      const changes = [
        ...(missing.length ? [`created ${missing.map((label) => label.name).join(', ')}`] : []),
        ...(translated.length ? [`translated ${translated.join(', ')}`] : []),
      ];
      return changes.length ? changes.join(', ') : 'unchanged';
    },
  });

  if (answers.claudeToken) {
    tasks.push({
      title: 'Claude token',
      run: async () => {
        await github.setSecret('CLAUDE_CODE_OAUTH_TOKEN', answers.claudeToken);
        return 'stored as a repository secret';
      },
    });
  }

  // Set by the Release GitHub App task when it stores the secrets, which the Ruleset task after it needs
  let appStored = false;
  const storesApp = twoBranches(answers) && Boolean(answers.releaseAppClientId?.trim() && answers.releaseAppKey);
  if (storesApp) {
    tasks.push({
      id: 'releaseApp',
      title: 'Release GitHub App',
      run: async () => {
        // Read when applying, so the key never stays in the answers; sent on stdin like every secret
        await github.setSecret('RELEASE_APP_CLIENT_ID', answers.releaseAppClientId.trim());
        await github.setSecret('RELEASE_APP_PRIVATE_KEY', readKey(answers.releaseAppKey));
        appStored = true;
        return 'stored as repository secrets';
      },
    });
  } else if (twoBranches(answers) && !state.releaseApp && state.actionsPullRequests?.allowed === false) {
    // Without the App, the release pull requests are opened with the workflow token
    tasks.push({
      title: 'GitHub Actions pull requests',
      run: async () => {
        try {
          await github.allowActionsPullRequests(state.actionsPullRequests.defaultPermissions);
        } catch (error) {
          throw new Error(
            'could not allow GitHub Actions to open pull requests; allow it in the organization settings (Actions > General) first',
            { cause: error },
          );
        }
        // GitHub has a single setting for both; the risk gate never counts approvals by bots
        return 'allowed to open and approve pull requests (bot approvals never count for the risk gate)';
      },
    });
  }

  // The ruleset follows ~DEFAULT_BRANCH to the development branch: keep production protected when its release pull
  // requests run the checks, so only with the App (otherwise nextSteps explains why it stays unprotected). A former
  // production branch the ruleset protects leaves it
  const addsProduction =
    twoBranches(answers) && (state.releaseApp || storesApp) && !protectsBranch(state.ruleset, productionBranch);
  const { productionBranch: previous } = state.current ?? {};
  const leaving =
    previous && previous !== productionBranch && protectsBranch(state.ruleset, previous) ? previous : null;
  if (state.ruleset && (addsProduction || leaving)) {
    tasks.push({
      title: 'Ruleset',
      run: async () => {
        // Requiring the checks without the App would leave every release waiting
        const adds = addsProduction && (state.releaseApp || appStored);
        if (!adds && !leaving) return 'skipped: the release GitHub App secrets were not stored';
        const { id, name, target, enforcement, bypass_actors, rules, conditions } = state.ruleset;
        const { include = [], exclude = [] } = conditions?.ref_name ?? {};
        await github.updateRuleset(id, {
          name,
          target,
          enforcement,
          bypass_actors,
          rules,
          conditions: {
            ref_name: {
              include: includedRefs(include, {
                add: adds ? [`refs/heads/${productionBranch}`] : [],
                remove: leaving ? [leaving] : [],
              }),
              exclude,
            },
          },
        });
        return [adds && `protects ${productionBranch}`, leaving && `no longer protects ${leaving}`]
          .filter(Boolean)
          .join(', ');
      },
    });
  }

  for (const environment of environments) {
    tasks.push({
      title: `Environment ${environment}`,
      run: async () => {
        const changes = [];
        if (!state.environments[environment].exists) {
          await github.createEnvironment(environment);
          changes.push('created');
        }
        const healthUrl = `https://${domains[environment]}${answers.healthPath}`;
        if (state.environments[environment].healthUrl !== healthUrl) {
          await github.setVariable('HEALTH_URL', healthUrl, environment);
          changes.push(`HEALTH_URL ${healthUrl}`);
        }
        if (hooks[environment]) {
          await github.setSecret('DEPLOY_HOOK', hooks[environment].trim(), environment);
          changes.push('DEPLOY_HOOK');
        }
        if (tokens[environment]) {
          await github.setSecret(serviceOf(stack, answers).secret, tokens[environment].trim(), environment);
          changes.push(serviceOf(stack, answers).secret);
        } else if (answers.monitoringMarkers === false && state.environments[environment].monitoringToken) {
          // The deploy marks the monitoring service whenever the secret exists and the target supports markers
          await github.deleteSecret(serviceOf(stack, answers).secret, environment);
          changes.push(`${serviceOf(stack, answers).secret} removed`);
        }
        return changes.length ? changes.join(', ') : 'unchanged';
      },
    });
  }

  if (answers.incidents && answers.webhookSecret?.trim()) {
    tasks.push({
      id: 'monitoringRelay',
      title: 'Monitoring relay',
      run: async () => {
        await registerSecret(relay, serviceOf(stack, answers).id, answers.repository, answers.webhookSecret.trim());
        return `registered ${answers.repository}`;
      },
    });
  }

  // Release pull requests are merged with a merge commit; unknown (undefined) without admin access to the repository
  if (twoBranches(answers) && state.repo?.allow_merge_commit === false) {
    tasks.push({
      id: 'mergeCommits',
      title: 'Merge commits',
      run: async () => {
        await github.allowMergeCommits();
        return 'allowed, for the release pull requests';
      },
    });
  }

  tasks.push(...stack.tasks(answers, { root, state }));

  // Last, after the stack's tasks, which may change the sites: a health URL that does not answer 200 rolls every
  // deploy back (nextSteps tells what to check)
  if (environments.length) {
    tasks.push({
      id: 'healthUrls',
      title: 'Health check URLs',
      run: async () => {
        const answered = await Promise.all(
          environments.map(async (environment) => {
            const url = `https://${domains[environment]}${answers.healthPath}`;
            return { environment, url, status: await probe(url) };
          }),
        );
        return {
          detail: answered.map(({ environment, status }) => `${environment} ${status ?? 'no answer'}`).join(', '),
          data: { failing: answered.filter(({ status }) => status !== 200) },
        };
      },
    });
  }

  return tasks;
}

/** What is left to do by hand after the tasks ran. */
function nextSteps(stack, answers, { relay, relayRegistered, results, state }) {
  const steps = [];
  const changed = changedFiles(results, { ...TASK_FILES, ...stack.files });
  // What the Branches task changed: a created branch or a new default branch moves where the work goes
  const branches = results.find((result) => result.id === 'branches' && result.ok)?.data;
  const branchesChanged = Boolean(branches?.created.length || branches?.defaultChanged);
  const formerProduction = formerProductionBranch(answers, state);
  // The development branch the default branch leaves, when the project goes back to a single branch
  const leftDevelopment = formerProduction && state.defaultBranch !== formerProduction ? state.defaultBranch : null;
  if (changed.length) {
    // Running setup again updates the workflow file it created before
    const created = results.some((result) => result.id === 'workflowFile' && result.detail === 'created');
    const message = textIn(
      created
        ? { en: 'ci: add Datalogix workflows', pt: 'ci: adiciona workflows da Datalogix' }
        : { en: 'ci: update Datalogix workflows', pt: 'ci: atualiza workflows da Datalogix' },
      answers.language,
    );
    const commit = `git add ${changed.join(' ')} && git commit -m "${message}"`;
    // A branch created by setup starts from the remote, without the workflow file, and the local branch may be the
    // former default one, now production: the file reaches the development branch through a pull request (a protected
    // branch rejects a push) and production only through the release pull request. A protected default branch rejects
    // a push too
    if (branchesChanged || state.ruleset) {
      const base = branchesChanged ? answers.developmentBranch : state.defaultBranch;
      // Claude only runs with the default branch's copy of the workflow file: on this pull request the reviews skip
      // Claude and the security review fails, so a required check needs an admin to merge past it
      const reviewFails = changed.includes(WORKFLOW_PATH) && answers.securityReview !== false;
      steps.push(
        [
          `Commit and open a pull request to ${bold(base)}:\n  ${cyan(`git switch -c ci/datalogix-workflows && ${commit} && git push -u origin HEAD && gh pr create --base ${base} --fill`)}`,
          ...(reviewFails
            ? [
                dim(
                  `  It changes ${WORKFLOW_PATH}, so Claude does not review it and the security review fails: have a person review it, then ${state.ruleset ? 'an admin merges it past the check' : 'merge it'}.`,
                ),
              ]
            : []),
        ].join('\n'),
      );
    } else {
      steps.push(`Commit and push:\n  ${cyan(`${commit} && git push`)}`);
    }
  }
  if (branchesChanged) {
    steps.push(
      `Work on ${bold(answers.developmentBranch)} from now on, the default branch: ${cyan(`git fetch origin && git switch ${answers.developmentBranch}`)}\n  ${dim(`Merge the release pull request (${answers.developmentBranch} → ${answers.productionBranch}) with a merge commit, not squash.`)}`,
    );
  }
  // The Default branch task should have run but failed
  const restored = results.some((result) => result.id === 'defaultBranch' && result.ok);
  if (leftDevelopment && !restored) {
    steps.push(
      `The default branch now deploys to production: make ${bold(formerProduction)} the default branch again in the repository settings, or ${bold(state.defaultBranch)} goes to production.`,
    );
  }
  if (leftDevelopment) {
    // Pushes to it no longer run the workflow: what was merged but not released would never deploy
    steps.push(
      `${bold(leftDevelopment)} no longer deploys: merge what is only on it into ${bold(formerProduction)} through a pull request, then work on ${bold(formerProduction)}:\n  ${cyan(`gh pr create --base ${formerProduction} --head ${leftDevelopment} --fill`)}`,
    );
  } else if (state.productionBranchStatus?.exists === false && deploys(answers) && !twoBranches(answers)) {
    steps.push(
      `${bold(state.productionBranchStatus.name)}, the former production branch, no longer exists: ${bold(state.defaultBranch)}, the default branch, now deploys to production.`,
    );
  }
  const appStored = results.some((result) => result.id === 'releaseApp' && result.ok);
  // Only where branches can be protected does the App change anything: elsewhere no check can be required
  if (twoBranches(answers) && !state.releaseApp && !appStored && state.canProtect) {
    steps.push(
      `Release pull requests are opened by GitHub Actions and run no checks, so ${bold(answers.productionBranch)} stays unprotected. To protect it, make the release GitHub App's secrets available to this repository (docs/organization-setup.md in datalogix/workflows) or run setup again to store them.`,
    );
  }

  // Deploy hooks left empty: every deploy to that environment fails until they are set
  const missingHooks = ['production', 'staging'].filter(
    (environment) =>
      deploys(answers) &&
      (environment === 'production' || answers.staging) &&
      !answers[`${environment}Hook`]?.trim() &&
      !answers.deployHooks?.[environment] &&
      !state.environments[environment].deployHook,
  );
  if (missingHooks.length) {
    steps.push(
      `Deploys to ${missingHooks.map((environment) => bold(environment)).join(' and ')} fail until the deploy hook is set: once the site exists, run setup again:\n  ${cyan(SETUP)}`,
    );
  }

  steps.push(...stack.deployNextSteps(answers, { twoBranches: twoBranches(answers), results }));

  if (answers.incidents) {
    if (!relay.configured) {
      steps.push(
        `The monitoring relay of ${ownerOf(answers.repository)} is not set up, so problems will not reach GitHub until an organization admin runs:\n  ${cyan(ORG)}`,
      );
    } else if (!relayAccepts(relay, answers.repository)) {
      steps.push(
        `The monitoring relay only accepts repositories of ${bold(relay.owner)}, so problems of ${answers.repository} will not reach GitHub. Deploy it again for ${ownerOf(answers.repository)}:\n  ${cyan(ORG)}`,
      );
    } else if (!relaySupported()) {
      steps.push(
        `Point the ${serviceOf(stack, answers).name} webhook to ${cyan(webhookUrl(relay, serviceOf(stack, answers).id, answers.repository))} and store its ${secretName(serviceOf(stack, answers))} in the relay by hand (relay/README.md in datalogix/workflows): setup cannot do it on Windows.`,
      );
    } else if (
      (!answers.webhookSecret?.trim() && relayRegistered !== true) ||
      results.some((result) => result.id === 'monitoringRelay' && !result.ok)
    ) {
      steps.push(
        `Point the ${serviceOf(stack, answers).name} webhook to ${cyan(webhookUrl(relay, serviceOf(stack, answers).id, answers.repository))} and run setup again to store its ${secretName(serviceOf(stack, answers))}.`,
      );
    }
  }

  // A service with a key per environment tells them apart by the key, not by name
  if ((answers.incidents || answers.monitoringMarkers) && !serviceOf(stack, answers).keyPerEnvironment) {
    steps.push(
      `In ${serviceOf(stack, answers).name}, name the environments ${bold('production')}${answers.staging ? ` and ${bold('staging')}` : ''}, like the GitHub environments.`,
    );
  }

  const health = results.find((result) => result.id === 'healthUrls' && result.ok)?.data;
  for (const { environment, url, status } of health?.failing ?? []) {
    steps.push(
      `${bold(environment)}: ${url} answers ${status ?? 'nothing'}, so every deploy to it is rolled back. Check the domain and its DNS, that the site exists, and leave ${bold(answers.healthPath)} out of basic auth and IP rules.`,
    );
  }

  if (
    twoBranches(answers) &&
    state.repo?.allow_merge_commit === false &&
    !results.some((result) => result.id === 'mergeCommits' && result.ok)
  ) {
    steps.push(
      `Allow merge commits in the repository's ${bold('Settings > General > Pull Requests')}: release pull requests are merged with one, and squash makes the branches diverge.`,
    );
  }

  const owner = ownerOf(answers.repository);
  const claudeInstall = cyan('https://github.com/apps/claude/installations/new');
  if (state.claudeApp === 'none') {
    steps.push(
      `Install the Claude GitHub App on ${bold(owner)}, or the Claude workflows (mentions, reviews, fix-ci, incidents) cannot act:\n  ${claudeInstall}`,
    );
  } else if (state.claudeApp === 'selected') {
    steps.push(
      `The Claude GitHub App reaches only selected repositories of ${bold(owner)}: add ${bold(answers.repository)} in its settings (${bold('Settings > GitHub Apps > Claude > Configure')}), or the Claude workflows cannot act on it.`,
    );
  } else if (state.claudeApp === null) {
    steps.push(
      `Could not see the GitHub Apps of ${bold(owner)} (it takes an organization admin and ${cyan('gh auth refresh -s admin:org')}): make sure the Claude GitHub App reaches ${bold(answers.repository)}:\n  ${claudeInstall}`,
    );
  }

  steps.push(...stack.nextSteps(answers, { state, results }));

  // A layer turned off whose check the ruleset still requires: every pull request would wait for it
  if (state.ruleset) {
    const expected = checksOn(stack.checks, answers);
    const required = requiredChecks(state.ruleset);
    const stale = required.filter((check) => Object.values(stack.checks).includes(check) && !expected.includes(check));
    const missing = expected.filter((check) => !required.includes(check));
    if (stale.length || missing.length) {
      steps.push(
        `Once the workflow file is merged, run protect again: the ruleset ${[
          stale.length &&
            `still requires ${stale.map((check) => bold(check)).join(', ')}, which no longer runs, so every pull request would wait`,
          missing.length && `does not require ${missing.map((check) => bold(check)).join(', ')} yet`,
        ]
          .filter(Boolean)
          .join(', and ')}:\n  ${cyan(PROTECT)}`,
      );
    }
  }

  if (state.canProtect) {
    steps.push(
      `After the first pull request shows its checks, protect the ${twoBranches(answers) ? 'branches' : 'default branch'}:\n  ${cyan('npx --allow-git=root github:datalogix/workflows#v2 protect')}`,
    );
  } else {
    steps.push(
      'Private repository on GitHub Free: branches cannot be protected, so the checks do not block merges and anyone with write access can push. Always merge through pull requests.',
    );
  }
  return steps;
}

/** Whether the answers drop the production-branch input of the existing workflow file, which needs a deploy and staging. */
export function dropsProductionBranch(answers, state) {
  return Boolean(state.current?.productionBranch) && (!deploys(answers) || answers.staging === false);
}

/** Warnings shown before applying: what the answers replace or drop in the existing workflow file. */
async function setupWarnings(answers, ctx) {
  const warnings = await workflowWarnings(
    ctx.state,
    await projectTemplate(ctx.state.workflow ?? '', ctx.state.defaultBranch),
    await renderWorkflow(answers, ctx.state),
  );
  if (dropsProductionBranch(answers, ctx.state)) {
    warnings.push('production-branch is removed: setup offers it only with a deploy and staging');
  }
  return warnings;
}

/**
 * What collectState reads from GitHub for a project: labels, environments, the Claude token and, with a production
 * branch (or `release`, as setup can turn one on), how release pull requests are opened.
 */
async function readProject(stack, github, read, { current, release }) {
  // Its secrets and variable are read along with it: for a missing environment they answer 404, read as none
  const environment = async (name) => {
    const [found, deployHook, healthUrl, monitoringToken] = await Promise.all([
      github.environment(name),
      github.hasEnvironmentSecret(name, 'DEPLOY_HOOK'),
      github.environmentVariable(name, 'HEALTH_URL'),
      // Only a service with deploy markers has a token in the environments
      monitoringOf(stack, current)?.secret
        ? github.hasEnvironmentSecret(name, monitoringOf(stack, current).secret)
        : false,
    ]);
    return found ? { exists: true, deployHook, healthUrl, monitoringToken } : NO_ENVIRONMENT;
  };
  const releases = release || Boolean(current?.productionBranch);

  const [
    labels,
    production,
    staging,
    repoToken,
    orgToken,
    releaseApp,
    workflowPermissions,
    productionBranchStatus,
    claudeApp,
  ] = await Promise.all([
    read('labels', github.labels()),
    read('production environment', environment('production')),
    read('staging environment', environment('staging')),
    read('secrets', github.hasRepositorySecret('CLAUDE_CODE_OAUTH_TOKEN')),
    // Optional: without access to organization secrets, setup asks for the token
    github.hasOrganizationSecret('CLAUDE_CODE_OAUTH_TOKEN').catch(() => false),
    releases ? read('secrets', hasReleaseApp(github)) : false,
    // Optional: reading it needs admin access
    releases ? github.workflowPermissions().catch(() => null) : null,
    current?.productionBranch
      ? read('branches', github.branch(current.productionBranch)).then((branch) => ({
          name: current.productionBranch,
          exists: Boolean(branch),
          // Its head, so setup can create a branch from it without reading it again
          sha: branch?.commit?.sha ?? null,
        }))
      : null,
    // Optional: null when gh cannot see the organization's GitHub Apps
    github.claudeApp(),
  ]);

  return {
    labels: labels.map((label) => label.name),
    // By label name, as GitHub spells it
    labelDescriptions: Object.fromEntries(labels.map((label) => [label.name, label.description ?? ''])),
    environments: { production, staging },
    claudeToken: { repository: repoToken, organization: orgToken },
    releaseApp,
    actionsPullRequests: workflowPermissions
      ? {
          allowed: workflowPermissions.can_approve_pull_request_reviews === true,
          defaultPermissions: workflowPermissions.default_workflow_permissions,
        }
      : null,
    productionBranchStatus,
    claudeApp,
  };
}

async function healthStatus(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return response.status;
  } catch {
    return null;
  }
}

/** Compares a project with what the workflows need (see check). */
async function evaluate(
  stack,
  state,
  { relay, repository, probe = healthStatus, relayLookup = hasSecret, relayRead = readSecret },
) {
  const report = createReport();
  const { ok, warn, error } = report;

  // The slow reads (health URLs, up to 10 seconds each, and the relay through wrangler) start together, here; the items
  // below await them in their usual order. A failure is kept for the await, not reported as unhandled meanwhile
  const started = (promise) => (promise.catch(() => {}), promise);
  const deploy = state.current?.deploy ?? 'none';
  const environments =
    deploy === 'none' ? [] : state.current?.staging === false ? ['production'] : ['production', 'staging'];
  const probes = Object.fromEntries(
    environments
      .filter((name) => state.environments[name].exists && state.environments[name].healthUrl)
      .map((name) => [name, started(probe(state.environments[name].healthUrl))]),
  );
  const looksUpRelay =
    state.current?.incidents !== false && relay.configured && !(repository && !relayAccepts(relay, repository));
  const service = serviceOf(stack, state.current);
  // A key per environment (Inspector): the environments that need one, and those missing in the relay (null unread)
  const keyed =
    environments.includes('staging') && state.current?.incidentStaging !== false
      ? ['production', 'staging']
      : ['production'];
  const missingKeys = async () => {
    const secret = await relayRead(relay, service.id, repository);
    return secret === null ? null : keyed.filter((name) => !storedKeys(secret)[name]);
  };
  const registration =
    looksUpRelay && relaySupported()
      ? started(service.keyPerEnvironment ? missingKeys() : relayLookup(relay, service.id, repository))
      : null;

  if (workflowItems(report, state, { ref: PROJECT_REF, kind: 'project', fix: SETUP })) {
    if (state.current?.incidents !== false && !/^(?![ \t]*#).*\brepository_dispatch\b/m.test(state.workflow)) {
      warn(
        `${WORKFLOW_PATH} has no repository_dispatch trigger, so ${serviceOf(stack, state.current).name} problems never arrive`,
        SETUP,
      );
    }
  }

  // Label names are case-insensitive on GitHub
  const labels = new Set(state.labels.map((name) => name.toLowerCase()));
  const deployed =
    (state.current?.deploy ?? 'none') === 'none'
      ? []
      : state.current?.staging === false
        ? ['production']
        : ['production', 'staging'];
  const missingLabels = labelsFor(deployed)
    .map((label) => label.name)
    .filter((name) => !labels.has(name));
  if (missingLabels.length) error(`Missing labels: ${missingLabels.join(', ')}`, SETUP);
  else ok('Labels');

  if (state.claudeToken.repository) ok('CLAUDE_CODE_OAUTH_TOKEN (repository secret)');
  else if (state.claudeToken.organization) ok('CLAUDE_CODE_OAUTH_TOKEN (organization secret)');
  else error('CLAUDE_CODE_OAUTH_TOKEN is not available to this repository', SETUP);

  const claudeInstall = 'https://github.com/apps/claude/installations/new';
  if (state.claudeApp === 'all') ok('Claude GitHub App (every repository)');
  else if (state.claudeApp === 'selected')
    warn(
      'The Claude GitHub App reaches only selected repositories: without this one, the Claude workflows cannot act',
      'add it in Settings > GitHub Apps > Claude > Configure',
    );
  else if (state.claudeApp === 'none') error('The Claude GitHub App is not installed', claudeInstall);
  else
    warn(
      'Could not see whether the Claude GitHub App reaches this repository',
      'run check as an organization admin after gh auth refresh -s admin:org',
    );

  if (deploy !== 'none') {
    for (const name of environments) {
      const environment = state.environments[name];
      if (!environment.exists) {
        error(`Environment ${name} is missing`, SETUP);
        continue;
      }
      if (!environment.deployHook) error(`Environment ${name} has no DEPLOY_HOOK secret`, SETUP);
      // Optional: only marks deploys in the monitoring service, and setup does not record the choice
      if (monitoringOf(stack, state.current)?.markers({ deploy }) && environment.monitoringToken)
        ok(`${name}: ${monitoringOf(stack, state.current).secret} (deploy markers)`);
      if (!environment.healthUrl) {
        error(`Environment ${name} has no HEALTH_URL variable`, SETUP);
        continue;
      }
      const status = await probes[name];
      if (status === 200) ok(`${name}: ${environment.healthUrl} answers 200`);
      else
        warn(
          `${name}: ${environment.healthUrl} answers ${status ?? 'nothing'}, so every deploy would be rolled back`,
          'check the domain, and that basic auth or IP rules do not block it',
        );
    }
    const productionBranch = state.current?.productionBranch;
    if (productionBranch) {
      const pushed = pushBranches(state.workflow ?? '');
      const staging = state.current?.staging !== false;
      if (state.productionBranchStatus && !state.productionBranchStatus.exists) {
        error(`Branch ${productionBranch} does not exist, so production is never deployed`, SETUP);
      } else if (!runsOnPush(pushed, productionBranch)) {
        error(
          `${WORKFLOW_PATH} does not run on pushes to ${productionBranch} (push.branches), so production is never deployed`,
          SETUP,
        );
      } else if (state.defaultBranch === productionBranch) {
        error(
          `${productionBranch} is the production branch and the default branch: staging and production deploy the same pushes`,
          SETUP,
        );
      } else if (!staging) {
        // Allowed by project.yml, but setup writes production-branch only with staging
        warn(
          `${productionBranch} deploys production, but staging is off: ${state.defaultBranch}, the default branch, deploys nothing`,
          SETUP,
        );
      } else if (!runsOnPush(pushed, state.defaultBranch)) {
        error(
          `${WORKFLOW_PATH} does not run on pushes to ${state.defaultBranch} (push.branches), so staging is never deployed`,
          SETUP,
        );
      } else {
        ok(`${state.defaultBranch} deploys staging, ${productionBranch} deploys production`);
      }
      if (state.releaseApp) ok('Release pull requests opened by the release GitHub App');
      else if (state.actionsPullRequests?.allowed === false)
        error(
          'GitHub Actions cannot open pull requests in this repository, so no release pull request is opened',
          SETUP,
        );
      // Reading the setting needs admin access
      else if (!state.actionsPullRequests)
        warn(
          'Could not read whether GitHub Actions can open pull requests: without it, or the release GitHub App, no release pull request is opened',
          'run check as a repository admin, or see Settings > Actions > General',
        );
      else ok('Release pull requests opened by GitHub Actions (their checks run only with the release GitHub App)');
      // Unknown (undefined) without admin access to the repository
      if (state.repo?.allow_merge_commit === false)
        error(
          'Merge commits are off, so release pull requests can only be squashed and the branches diverge',
          `${SETUP}, or allow them in Settings > General > Pull Requests`,
        );
      else if (state.repo?.allow_merge_commit) ok('Merge commits allowed, for the release pull requests');
    }

    stack.evaluateDeploy(report, state);
  }

  // Problems as issues (on by default) or deploy markers: the monitoring service's agent must be in the app
  const markers = Object.values(state.environments).some((environment) => environment.monitoringToken);
  if (state.current?.incidents !== false || markers) stack.evaluateMonitoring?.(report, state);

  // The production branch is protected only when the release GitHub App runs the checks of its release pull requests
  rulesetItems(report, state, {
    expected: checksOn(stack.checks, state.current),
    known: Object.values(stack.checks),
    branches: () => {
      const productionBranch = deployedProductionBranch(state.current);
      // A production branch that is the default branch is reported above, and ~DEFAULT_BRANCH covers it
      const separate = Boolean(productionBranch) && productionBranch !== state.defaultBranch;
      const unprotected = separate && !protectsBranch(state.ruleset, productionBranch);
      if (unprotected && state.releaseApp)
        warn(`The ruleset does not protect ${productionBranch}: anyone can push to production`, PROTECT);
      else if (unprotected)
        warn(
          `${productionBranch} is not protected: without the release GitHub App its release pull requests run no checks to require`,
          'see docs/organization-setup.md in datalogix/workflows',
        );
      else if (separate && !state.releaseApp)
        error(
          `The ruleset protects ${productionBranch}, but without the release GitHub App its release pull requests never run the checks: every release waits`,
          PROTECT,
        );
      return {
        ok: !unprotected && (!separate || state.releaseApp),
        label: separate ? `Default branch and ${productionBranch} protected` : undefined,
      };
    },
  });

  codeOwnerItems(report, state, { requireApproval: state.current ? !state.current.solo : null, hint: SETUP });

  if (state.current?.incidents !== false) {
    if (!relay.configured) {
      warn(`The monitoring relay is not set up${repository ? ` for ${ownerOf(repository)}` : ''}`, ORG);
    } else if (repository && !relayAccepts(relay, repository)) {
      warn(
        `The monitoring relay only accepts repositories of ${relay.owner}: problems of ${repository} are rejected`,
        ORG,
      );
    } else if (!relaySupported()) {
      warn('Cannot read the monitoring relay on Windows', 'see relay/README.md in datalogix/workflows');
    } else {
      const registered = await registration;
      // With a key per environment, the list of those missing: some of them is a key to add, all of them not registered
      const missing = Array.isArray(registered) ? registered : null;
      if (registered === true || missing?.length === 0) ok('Registered in the monitoring relay');
      else if (missing && missing.length < keyed.length)
        warn(
          `${service.name} key of ${missing.join(' and ')} missing in the monitoring relay: its problems are rejected`,
          SETUP,
        );
      else if (registered === false || missing)
        warn(`Not registered in the monitoring relay: ${service.name} problems are rejected`, SETUP);
      else warn('Could not read the monitoring relay', 'run npx wrangler login, then check again');
    }
  }

  return report.items;
}

/**
 * The production branch protect adds to the ruleset: only when the release GitHub App opens its release pull
 * requests, since opened with the workflow token they run no checks and would wait forever.
 */
async function protectedBranch(github, current) {
  const deployed = deployedProductionBranch(current);
  if (!deployed) return null;
  const releaseApp = await readOrFail(github, 'secrets', hasReleaseApp(github));
  if (releaseApp) return deployed;
  clack.log.warn(
    [
      `${deployed} is left unprotected: without the release GitHub App, release pull requests run no checks, so requiring them would block every release.`,
      dim(
        'Store RELEASE_APP_CLIENT_ID and RELEASE_APP_PRIVATE_KEY (docs/organization-setup.md) and run protect again.',
      ),
    ].join('\n'),
  );
  return null;
}

/**
 * The module of a stack's app (project.yml): what every project needs, with the stack's part. `stack` gives
 * deployTargets ([{ value, label }], 'none' is added), deployHookHint, monitoring (the services it offers, the
 * first by default: see cli/providers/monitoring/index.js),
 * healthPath(ctx), steps(), tasks(answers, ctx), files ({ task id: path } for the commit), deployNextSteps(answers,
 * { twoBranches, results }), nextSteps(answers, { state, results }), evaluateDeploy(report, state), and optionally evaluateMonitoring(report, state), checks
 * (PROJECT_CHECKS by default), deploySteps() (questions about the deploy target, asked before the deploy hooks, which
 * they may answer in answers.deployHooks), inspect(root) and empty (its part of the state before it is read).
 */
export function projectKind(stack) {
  const checks = stack.checks ?? PROJECT_CHECKS;
  const kind = { ...stack, checks };
  return {
    ref: PROJECT_REF,
    checks,
    empty: { ...PROJECT_STATE, ...stack.empty },
    inspect: stack.inspect,
    read: (github, read, options) => readProject(kind, github, read, options),
    answers: projectAnswers,
    /**
     * Loads what the commands need before they read the project: the relay settings of the repository's owner, unless
     * given (tests). Without a repository yet (setup asks for it), the repository step loads them.
     */
    prepare: async (ctx) => {
      if (ctx.repository && ctx.relay == null) await loadRelay(ctx, ownerOf(ctx.repository));
    },
    setup: {
      steps: () => setupSteps(kind),
      tasks: (answers, ctx) => setupTasks(kind, answers, ctx),
      warnings: setupWarnings,
      nextSteps: (answers, ctx) => nextSteps(kind, answers, ctx),
    },
    evaluate: (state, options) => evaluate(kind, state, options),
    /** Checks to require, from the workflow answers (state.current). */
    requiredChecks: (state) => checksOn(checks, state.current),
    // Solo maintainers (count-author) cannot approve their own pull requests, and nobody else can lower the checks
    needsCodeOwners: async (current) => !current?.solo,
    protectedBranch,
    /** The production branch of the workflow file, protected or not. */
    deployedBranch: deployedProductionBranch,
  };
}
