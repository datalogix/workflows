import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CODEOWNERS_PATH, renderCodeOwners } from './codeowners.js';
import { droppedInputComments, hasChangesOutsideInputs, hasInputComments, WORKFLOW_PATH } from './workflow-file.js';

// Setup tasks every stack runs

/** Writes the /.github/ line of CODEOWNERS, keeping its other lines. */
export function codeOwnersTask(answers, { root, state }) {
  return {
    id: 'codeOwners',
    title: `Code owners ${CODEOWNERS_PATH}`,
    run: async () => {
      const content = renderCodeOwners(answers.codeOwners, state.codeOwnersFile ?? '');
      if (content === state.codeOwnersFile) return 'unchanged';
      await mkdir(dirname(join(root, CODEOWNERS_PATH)), { recursive: true });
      await writeFile(join(root, CODEOWNERS_PATH), content);
      return state.codeOwnersFile === null ? 'created' : 'updated';
    },
  };
}

// The files of the tasks every stack runs, by task id
export const TASK_FILES = { workflowFile: WORKFLOW_PATH, codeOwners: CODEOWNERS_PATH };

/**
 * Files the tasks created, changed or removed, from { task id: path } and the ids file:<path>, so the commit never
 * fails with "nothing to commit".
 */
export function changedFiles(results, files) {
  // A task whose file depends on the project names it in its id: file:<path>
  const fileOf = (result) => files[result.id] ?? (result.id?.startsWith('file:') ? result.id.slice(5) : null);
  return results
    .filter((result) => fileOf(result) && result.ok && result.detail !== 'unchanged')
    .map((result) => fileOf(result));
}

/** Writes the workflow file that render() returns, when it differs from the current one. */
export function workflowFileTask(render, { root, state }) {
  return {
    id: 'workflowFile',
    title: `Workflow file ${WORKFLOW_PATH}`,
    run: async () => {
      // Written with the line ends of the existing file (CRLF on Windows), so only the changes show in the diff
      const rendered = await render();
      const content = state.workflow?.includes('\r\n') ? rendered.replace(/\n/g, '\r\n') : rendered;
      if (content === state.workflow) return 'unchanged';
      await mkdir(dirname(join(root, WORKFLOW_PATH)), { recursive: true });
      await writeFile(join(root, WORKFLOW_PATH), content);
      return state.workflow ? 'updated' : 'created';
    },
  };
}

/**
 * The warnings shown before applying when the workflow file has lines the template base of its kind replaces, or
 * comments in its `with:` block that the rendered file (what setup writes) does not keep.
 */
export async function workflowWarnings({ workflow }, base, rendered) {
  if (!workflow) return [];
  const dropped = droppedInputComments(workflow, rendered);
  return [
    ...(hasChangesOutsideInputs(workflow, base)
      ? [`${WORKFLOW_PATH} has changes outside its "with:" inputs: they will be replaced by the template`]
      : []),
    ...(hasInputComments(workflow) ? [`${WORKFLOW_PATH} has comments in its "with:" block: they are removed`] : []),
    ...(dropped.length
      ? [`${WORKFLOW_PATH} has comments after the values of ${dropped.join(', ')}: setup rewrites them without`]
      : []),
  ];
}
