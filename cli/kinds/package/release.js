import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SETUP } from '../../lib/evaluate.js';
import { answersReleaseApp, hasReleaseApp, releaseAppSteps, releaseAppTask } from '../../lib/release-app.js';
import { bold, clack, cyan, dim, orExit, question } from '../../lib/ui.js';
import { grantedPermissions, grants, jobPermissions, WORKFLOW_PATH } from '../../lib/workflow-file.js';
import { RELEASE_JOB } from './workflow.js';

// The releases of a package (package-release.yml, the release job of its workflow file): the question that turns them
// on, the release GitHub App and the npm token they use, what check reports and what is left by hand

const releaseOn = (a) => a?.release === true;

// What the folder says that matters to releases, before it is read
export const RELEASE_STATE = {
  releaseApp: false,
  npmToken: false,
  composerVersion: null,
  workspaces: false,
  npmName: null,
  repositoryUrl: null,
  publishingWorkflows: [],
};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The repository of package.json (a string or { url }), or null. */
const repositoryOf = (manifest) =>
  typeof manifest?.repository === 'string' ? manifest.repository : (manifest?.repository?.url ?? null);

/**
 * The other workflow files that publish the package: they run npm publish or on a published release, which the
 * releases created here would trigger too (a double publish).
 */
async function publishingWorkflows(root) {
  const folder = join(root, '.github', 'workflows');
  let files;
  try {
    files = await readdir(folder);
  } catch {
    return [];
  }
  const own = WORKFLOW_PATH.split('/').at(-1);
  const found = [];
  for (const file of files.filter((name) => /\.ya?ml$/.test(name) && name !== own)) {
    const content = await readFile(join(folder, file), 'utf8').catch(() => '');
    if (/\bnpm publish\b|^\s*release:/m.test(content)) found.push(file);
  }
  return found;
}

/** What inspect reads from the folder for releases. */
export async function inspectRelease(root) {
  const composer = await readJson(join(root, 'composer.json'));
  const manifest = await readJson(join(root, 'package.json'));
  return {
    composerVersion: typeof composer?.version === 'string' ? composer.version : null,
    workspaces: Boolean(manifest?.workspaces),
    npmName: manifest?.name ?? null,
    repositoryUrl: repositoryOf(manifest),
    publishingWorkflows: await publishingWorkflows(root),
  };
}

/** Whether the repository can read NPM_TOKEN, as a repository or organization secret. */
async function hasNpmToken(github, read) {
  const repository = await read('secrets', github.hasRepositorySecret('NPM_TOKEN'));
  return repository || (await github.hasOrganizationSecret('NPM_TOKEN').catch(() => false));
}

/** What read adds for releases: in setup or with releases on, the release GitHub App and the npm token. */
export async function readRelease(github, read, { current, claude = false }) {
  if (!claude && !releaseOn(current)) return {};
  const [releaseApp, npmToken] = await Promise.all([read('secrets', hasReleaseApp(github)), hasNpmToken(github, read)]);
  return { releaseApp, npmToken };
}

/** The releases question, then the release GitHub App and, for js, the npm token. */
export function releaseSteps(stack) {
  const js = stack.id === 'js';
  return [
    {
      id: 'release',
      flag: 'release',
      ask: async ({ header, ctx }) =>
        orExit(
          await clack.confirm({
            message: question(header, 'Release new versions from the commits?', [
              'Keeps a release pull request with the next version (feat: minor, fix: patch, !: major) and its changelog',
              `Merging it tags the version and creates the GitHub release${js ? ', and publishes it to npm' : ' (Packagist reads the tag)'}`,
            ]),
            initialValue: ctx.state.current?.release ?? false,
          }),
        ),
    },
    ...releaseAppSteps({
      needed: releaseOn,
      without: 'Empty: the workflow token opens the release pull request, and its checks do not run',
    }),
    {
      id: 'npmToken',
      when: (a, ctx) => js && releaseOn(a) && !ctx.state.npmToken,
      ask: async ({ header }) =>
        orExit(
          await clack.password({
            message: question(
              header,
              `npm token${dim('  optional; only for the first publish or without trusted publishing')}`,
              "Empty: publishes with npm's trusted publishing, set up on npmjs.com for this repository",
            ),
          }),
        ),
    },
  ];
}

/** The release GitHub App's and the npm token's secrets the answers give. */
export function releaseTasks(answers, github) {
  if (!releaseOn(answers)) return [];
  const tasks = [];
  if (answersReleaseApp(answers)) tasks.push(releaseAppTask(answers, github));
  if (answers.npmToken?.trim()) {
    tasks.push({
      title: 'npm token',
      run: async () => {
        await github.setSecret('NPM_TOKEN', answers.npmToken.trim());
        return 'stored as a repository secret';
      },
    });
  }
  return tasks;
}

/** What releases need by hand: the App's write access, npm's trusted publisher and the first publish. */
export function releaseNextSteps(answers, { results = [], state, stack }) {
  if (!releaseOn(answers)) return [];
  const steps = [];
  const appStored = results.some((result) => result.id === 'releaseApp' && result.ok);
  if (!state.releaseApp && !appStored) {
    steps.push(
      `Make the release GitHub App's secrets (${bold('RELEASE_APP_CLIENT_ID')}, ${bold('RELEASE_APP_PRIVATE_KEY')}) available to this repository, or run setup again to store them: without the App, the release pull request runs no checks${state.canProtect ? ', so a protected branch cannot merge it' : ''}.`,
    );
  }
  steps.push(
    `The release GitHub App needs ${bold('Contents: Read and write')} and access to this repository: an organization admin accepts the new permission (docs/organization-setup.md in datalogix/workflows).`,
  );
  if (stack.id === 'js' && !answers.npmToken?.trim() && !state.npmToken) {
    const name = state.npmName ?? 'the package';
    steps.push(
      `On npmjs.com, add a trusted publisher to ${bold(name)}: GitHub Actions, repository ${bold(answers.repository ?? state.repo?.full_name ?? 'OWNER/REPO')}, workflow ${bold('datalogix.yml')}. Trusted publishing works only for a package that exists: publish its first version by hand (${cyan('npm publish')}) or store an ${bold('NPM_TOKEN')}.`,
    );
  }
  return steps;
}

// What the release job uses: the release pull request (contents and pull-requests write), npm's OIDC token for js
const RELEASE_PERMISSIONS = { contents: 'write', 'pull-requests': 'write' };

/** check's items for releases, when the workflow file turns them on. */
export function releaseItems({ ok, warn, error }, state, stack) {
  if (!releaseOn(state.current)) return;
  const js = stack.id === 'js';
  if (state.workflow) {
    const granted = jobPermissions(state.workflow, RELEASE_JOB) ?? grantedPermissions(state.workflow);
    const needs = { ...RELEASE_PERMISSIONS, ...(js ? { 'id-token': 'write' } : {}) };
    const missing = Object.entries(needs)
      .filter(([scope, level]) => !grants(granted, scope, level))
      .map(([scope, level]) => `${scope}: ${level}`);
    if (missing.length)
      error(`The release job lacks ${missing.join(', ')}, so the run of every push to the default branch fails`, SETUP);
  }
  if (state.releaseApp) ok('Release pull requests opened by the release GitHub App');
  else if (state.canProtect)
    error(
      'No release GitHub App: the release pull request is opened by the workflow token, runs no checks, and a protected branch cannot merge it',
      'make RELEASE_APP_CLIENT_ID and RELEASE_APP_PRIVATE_KEY available (docs/organization-setup.md), or run setup',
    );
  if (!js && state.composerVersion)
    warn(
      `composer.json sets version ${state.composerVersion}: Packagist reads the version from the tag, and the two disagree after the next release`,
      'remove version from composer.json',
    );
  if (state.workspaces)
    warn('package.json has workspaces: releases cover only the root package', 'release the workspaces by other means');
  const repository = state.repo?.full_name;
  if (js && repository && !new RegExp(`github\\.com[/:]${repository}(\\.git)?$`, 'i').test(state.repositoryUrl ?? '')) {
    warn(
      `package.json's repository is ${state.repositoryUrl ? `"${state.repositoryUrl}"` : 'missing'}: npm's provenance and trusted publishing need it to be this repository`,
      `set "repository": { "type": "git", "url": "git+https://github.com/${repository}.git" }`,
    );
  }
  for (const file of state.publishingWorkflows)
    warn(
      `.github/workflows/${file} also publishes (npm publish, or on a release): the releases created here would publish twice`,
      `remove it, or turn releases off in ${WORKFLOW_PATH}`,
    );
}
