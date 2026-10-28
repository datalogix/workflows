import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTasks } from '../lib/ui.js';
import { EMPTY_STATE } from '../lib/state.js';
import laravelApp from '../stacks/laravel/app.js';
import laravelPackage from '../stacks/laravel/package.js';

/** A temporary folder for one test, removed when the test ends. */
export async function tempRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A temporary folder with the files given as { path: content }, their folders created. */
export async function folder(t, files = {}, prefix = 'test-') {
  const root = await tempRoot(t, prefix);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

// What the fake GitHub records for each method that changes something, by the name the tests check
const RECORDED = {
  createLabel: 'label',
  setLabelDescription: 'label description',
  createEnvironment: 'environment',
  setSecret: 'secret',
  setVariable: 'variable',
  deleteSecret: 'delete secret',
  createBranch: 'branch',
  setDefaultBranch: 'default',
  createRuleset: 'create ruleset',
  updateRuleset: 'ruleset',
  allowActionsPullRequests: 'allow',
  allowMergeCommits: 'merge commits',
};

/**
 * A fake GitHub for the setup tasks: the methods that change something record [name, ...args] in `calls`, `branch`
 * answers from `branches`, `methods` replaces any of them, and a method it does not know fails the test, so a task
 * calling something unexpected does not pass silently.
 */
export function fakeGitHub({ branches = {}, ...methods } = {}) {
  const calls = [];
  const known = {
    calls,
    repository: 'datalogix/app',
    branch: async (name) => branches[name] ?? null,
    ...Object.fromEntries(
      Object.entries(RECORDED).map(([method, name]) => [method, async (...args) => void calls.push([name, ...args])]),
    ),
    ...methods,
  };
  return new Proxy(known, {
    get(target, name) {
      if (name in target || typeof name === 'symbol' || name === 'then') return target[name];
      throw new Error(`The fake GitHub has no ${String(name)}`);
    },
  });
}

/** The results runTasks gives for the tasks ({ title, ok, detail, data }), as setup sees them. */
export const runResults = (tasks) => runTasks(tasks);

/** The results by task title: the detail when it worked, the result ({ ok: false, detail }) when it failed. */
export const byTitle = (results) =>
  Object.fromEntries(results.map((result) => [result.title, result.ok ? result.detail : result]));

export const RELAY = { configured: true, url: 'https://relay.test', namespaceId: 'id', owner: 'datalogix' };

/** The ids of the questions that apply to the answers, with a full context (state, relay). */
export function askedSteps(steps, answers, ctx = {}) {
  const context = { state: APP_STATE, relay: RELAY, ...ctx };
  return steps.filter((step) => !step.when || step.when(answers, context)).map((step) => step.id);
}

/** Laravel's default app/Providers/AppServiceProvider.php. */
export const APP_SERVICE_PROVIDER = `<?php

namespace App\\Providers;

use Illuminate\\Support\\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        //
    }
}
`;

/** The state of a Laravel app or package with nothing set up, as collectState starts it. */
export const APP_STATE = { ...EMPTY_STATE, ...laravelApp.empty, stack: 'laravel', kind: 'project' };
export const PACKAGE_STATE = { ...EMPTY_STATE, ...laravelPackage.empty, stack: 'laravel', kind: 'package' };

/** Runs the test as on that platform (win32: npx cannot reach the relay). */
export function onPlatform(t, value) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value });
  t.onTestFinished(() => Object.defineProperty(process, 'platform', platform));
}

/** A GitHub environment of an app, set up unless told otherwise. */
export const environment = (overrides = {}) => ({
  exists: true,
  deployHook: true,
  healthUrl: 'https://app.example.com/up',
  monitoringToken: false,
  ...overrides,
});
