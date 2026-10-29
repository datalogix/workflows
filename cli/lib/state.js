import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CODEOWNERS_PATH, parseOwners } from './codeowners.js';
import { RULESET_NAME } from './ruleset.js';
import { parseInputs, stackOf, WORKFLOW_PATH } from './workflow-file.js';

/**
 * Checks to require for the workflow answers, from a stack's { answer: check } map (inputs tests, security-review,
 * risk-gate). A layer turned off never reports its check, so requiring it would leave every pull request waiting.
 */
export function checksOn(checks, current) {
  return Object.entries(checks)
    .filter(([layer]) => current?.[layer] !== false)
    .map(([, check]) => check);
}

/**
 * State of a project with nothing set up, used until the real one is read: what every stack and kind has. The module
 * of the detected stack and kind adds its own part (its `empty`).
 */
export const EMPTY_STATE = {
  repo: null,
  defaultBranch: 'main',
  workflow: null,
  current: null,
  canProtect: true,
  ruleset: null,
  codeOwners: null,
  codeOwnersFile: null,
  login: null,
  stack: null,
  kind: null,
};

/** Turns a failed GitHub read (no access, network) into an error instead of something that looks missing. */
export function readOrFail(github, what, promise) {
  return promise.catch((error) => {
    throw new Error(`Cannot read the ${what} of ${github.repository}: ${error.message.split('\n')[0]}`);
  });
}

/**
 * What check and protect read from the folder: the workflow file, its answers (current) and what the stack's module
 * reads with inspect(root). Without `detected` (or its workflow), the workflow file is read here.
 */
export async function readLocal(detected, root) {
  // detectStack already read it
  let workflow = detected?.workflow ?? null;
  if (detected?.workflow === undefined) {
    try {
      workflow = await readFile(join(root, WORKFLOW_PATH), 'utf8');
    } catch {
      // no workflow file yet
    }
  }
  const answers = detected?.module.answers ?? ((inputs) => ({ stack: stackOf(inputs) }));
  const inspected = detected?.module.inspect ? await detected.module.inspect(root) : {};
  return { workflow, current: workflow ? answers(parseInputs(workflow)) : null, ...inspected };
}

/**
 * Everything setup and check need to know about the project, read once. Null when the repository is not reachable.
 * `detected` is the stack and kind of the folder (cli/stacks): its module's inspect(root) adds what it reads from the
 * folder, read(github, read, { current, ...options }) what it reads from GitHub (`read` wraps a request so a failure
 * stops with "Cannot read the … of owner/repo"; `options` are what the setup of the kind passes, e.g. an app's
 * `release`), and answers(inputs) what its workflow file says.
 */
export async function collectState(github, root, { detected = null, options = {} } = {}) {
  const repo = await github.repo();
  if (!repo) return null;

  const local = await readLocal(detected, root);

  let codeOwnersFile = null;
  try {
    codeOwnersFile = await readFile(join(root, CODEOWNERS_PATH), 'utf8');
  } catch {
    // no CODEOWNERS yet
  }

  const read = (what, promise) => readOrFail(github, what, promise);

  // The ruleset is read as soon as the list has its id, not after the slowest of the other reads
  const [[rulesets, ruleset], remote, login] = await Promise.all([
    read('rulesets', github.rulesets()).then(async (list) => {
      const summary = list?.find((candidate) => candidate.name === RULESET_NAME);
      return [list, summary ? await read('ruleset', github.ruleset(summary.id)) : null];
    }),
    // What only that stack and kind needs (an app's environments, labels and secrets)
    detected?.module.read ? detected.module.read(github, read, { current: local.current, ...options }) : {},
    github.login().catch(() => null),
  ]);

  return {
    // What the stack's module does not read keeps its empty value
    ...EMPTY_STATE,
    ...detected?.module.empty,
    repo,
    defaultBranch: repo.default_branch ?? 'main',
    canProtect: rulesets !== null,
    ruleset,
    codeOwners: codeOwnersFile === null ? null : parseOwners(codeOwnersFile),
    codeOwnersFile,
    login,
    stack: detected?.stack ?? null,
    kind: detected?.kind ?? null,
    ...local,
    ...remote,
  };
}
