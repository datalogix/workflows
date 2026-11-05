import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseInputs, stackOf, usesRef, WORKFLOW_PATH } from '../lib/workflow-file.js';
import js from './js/index.js';
import laravel from './laravel/index.js';

/**
 * The stacks the commands support, in the order they are tried. A stack is { id, label, detect(root) → kind or null,
 * kinds: { project, package } }, each kind a module with what setup, check and protect need (see laravel/).
 * Adding a stack (php, js, vue, nuxt) is a folder here and a line in this list.
 */
export const STACKS = [laravel, js];

// A folder no stack recognizes (or no folder) is read as a Laravel app, the most common case; setup refuses it unless
// --stack or --kind says what it is (recognized: false)
const FALLBACK = { stack: laravel, kind: 'project' };

/**
 * The stack and kind of the folder: the workflow file decides the kind (project.yml or package.yml) and its `stack:`
 * input the stack; without a workflow file, the first stack that recognizes the folder. Also returns the workflow
 * file's content (null without one), the kind whose entry point it calls (fileKind, null when it calls none) and whether
 * a stack recognized the folder or its workflow file (recognized; false when it fell back to a Laravel app).
 */
export async function detectStack(root) {
  let workflow = null;
  try {
    workflow = await readFile(join(root, WORKFLOW_PATH), 'utf8');
  } catch {
    // no workflow file yet
  }
  const named = workflow && stackOf(parseInputs(workflow));
  let found = named ? { stack: STACKS.find((stack) => stack.id === named), kind: null } : null;
  if (found && !found.stack)
    throw new Error(`${WORKFLOW_PATH} uses stack ${named}, which this command does not support yet`);
  for (const stack of found ? [] : STACKS) {
    const kind = await stack.detect(root);
    if (kind) {
      found = { stack, kind };
      break;
    }
  }
  const fileKind = (workflow && workflowKind((found ?? FALLBACK).stack, workflow)) || null;
  const recognized = Boolean(found || fileKind);
  found ??= { ...FALLBACK };
  // A file that names the stack but calls no entry point leaves the kind to the folder
  const kind = fileKind || found.kind || (await found.stack.detect(root)) || 'project';
  return { ...withModule(found.stack, kind), workflow, fileKind, recognized };
}

/** Every stack and kind setup can set up, as detection results, for the question that confirms the detected one. */
export function setupChoices() {
  return STACKS.flatMap((stack) => Object.keys(stack.kinds).map((kind) => withModule(stack, kind)));
}

/** The stack and kind given as --stack and --kind (app or package), each falling back to the detected one. */
export function fromFlags(flags, detected) {
  const id = flags.stack ?? detected.stack;
  const stack = STACKS.find((candidate) => candidate.id === id);
  if (!stack) throw new Error(`--stack: use ${STACKS.map((candidate) => candidate.id).join(' or ')}`);
  // parseArgs accepts only app and package; app is the project kind (project.yml)
  const kind = flags.kind === undefined ? detected.kind : { app: 'project', package: 'package' }[flags.kind];
  return withModule(stack, kind);
}

/** The kind whose entry point (its module's ref, at any version) the workflow file calls, or null. */
export function workflowKind(stack, workflow) {
  return Object.keys(stack.kinds).find((kind) => usesRef(workflow, stack.kinds[kind].ref) !== null) ?? null;
}

/** The detection result for a stack and kind: { stack, kind, label, module }. */
export function withModule(stack, kind) {
  const module = stack.kinds[kind];
  const label = `${stack.label} ${kind === 'project' ? 'app' : 'package'}`;
  if (!module) throw new Error(`${label}s are not supported yet`);
  return { stack: stack.id, kind, label, module };
}
