import { CLAUDE_LABEL, labelDescription, NO_REVIEW_LABEL, PLAN_LABEL, textIn } from '../../lib/claude.js';

// What project.yml needs from a project that only apps (cli/kinds/project) read: the labels of the Claude workflows,
// the environments and the release GitHub App

// Shared with packages (cli/lib/claude.js)
export { labelDescription, textIn };

// Shown in the target projects' GitHub, in the project's language (labelDescription)
export const LABELS = [
  CLAUDE_LABEL,
  PLAN_LABEL,
  NO_REVIEW_LABEL,
  // Issues the task manager follows (docs/task-manager.md): it creates them, or picks up the ones labeled task
  {
    name: 'task',
    color: 'fbca04',
    // Why it may be missing: no workflow reads it, so check only warns
    optional: 'only the task manager uses it',
    description: { pt: 'Tarefa do gerenciador de tarefas', en: 'Task of the task manager' },
  },
  {
    name: 'rollback',
    color: 'b60205',
    description: {
      pt: 'Reverte o ambiente para a versão anterior',
      en: 'Rolls the environment back to the previous release',
    },
  },
];

/**
 * LABELS and the env:<name> label of each deployed environment: rollback on an issue with one rolls that environment
 * back. The deploy and incident scripts create them too (environment_label in .github/actions/lib/releases.sh), with
 * the same color and text.
 */
export function labelsFor(environments) {
  return [
    ...LABELS,
    ...environments.map((environment) => ({
      name: `env:${environment}`,
      color: 'c5def5',
      description: {
        pt: 'Ambiente do problema; o label rollback reverte este ambiente',
        en: 'Environment of the problem; the rollback label rolls this environment back',
      },
    })),
  ];
}

// The release GitHub App is shared with packages (cli/lib/release-app.js)
export { hasReleaseApp } from '../../lib/release-app.js';

export const NO_ENVIRONMENT = { exists: false, deployHook: false, healthUrl: null, monitoringToken: false };

/** The production branch of a project that deploys, which protect and check consider for the ruleset. */
export function deployedProductionBranch(current) {
  return current?.deploy !== 'none' ? (current?.productionBranch ?? null) : null;
}
