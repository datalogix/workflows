import { bold } from '../../lib/ui.js';
import { apiClient } from './api.js';

// What setup does in Laravel Cloud with an API token: finds the environments of the repository's applications, turns
// off their Push to deploy and sets the branch each one deploys. The deploy hook is not in the API: setup asks for it

export const cloudApi = (token) => apiClient('https://cloud.laravel.com/api', token, 'Laravel Cloud');

/** The environments of the repository's applications: { application, id, name, branch, pushToDeploy }. */
export async function cloudEnvironments(api, repository) {
  const { data: applications } = await api.all('/applications');
  const environments = [];
  for (const application of applications) {
    if (application.attributes.repository?.full_name?.toLowerCase() !== repository.toLowerCase()) continue;
    const { data, included } = await api.all(
      `/applications/${encodeURIComponent(application.id)}/environments?include=branch`,
    );
    for (const environment of data) {
      const branch = environment.relationships?.branch?.data;
      environments.push({
        application: application.attributes.name,
        id: environment.id,
        name: environment.attributes.name,
        branch: included.find((item) => item.type === branch?.type && item.id === branch?.id)?.attributes.name ?? null,
        pushToDeploy: Boolean(environment.attributes.uses_push_to_deploy),
      });
    }
  }
  return environments;
}

/** Turns off the environment's Push to deploy and makes it deploy `branch` (null keeps its branch). */
export function cloudEnvironmentTask(api, environment, name, branch) {
  return {
    id: `deploySite:${name}`,
    title: `Laravel Cloud environment ${environment.application} ${environment.name} (${name})`,
    run: async () => {
      const changes = {};
      if (environment.pushToDeploy) changes.uses_push_to_deploy = false;
      if (branch && environment.branch !== branch) changes.branch = branch;
      if (!Object.keys(changes).length) return 'unchanged';
      await api.patch(`/environments/${encodeURIComponent(environment.id)}`, changes);
      // Cloud stages setting changes until the next deploy
      return [
        'uses_push_to_deploy' in changes && 'Push to deploy off',
        changes.branch && `branch ${changes.branch}`,
        'from the next deploy',
      ]
        .filter(Boolean)
        .join(', ');
    },
  };
}

/** Laravel Cloud, as a deploy target of setup (see index.js). */
export default {
  id: 'cloud',
  label: 'Laravel Cloud',
  name: 'Laravel Cloud',
  kind: 'environment',
  where: 'the Laravel Cloud environment',
  hookHint: 'Cloud: environment Settings > Deployments',
  tokenHint: 'turns off Push to deploy and sets the branch of each environment',
  api: cloudApi,
  find: cloudEnvironments,
  hook: null,
  targetLabel: (environment) => `${environment.application} · ${environment.name}`,
  task: cloudEnvironmentTask,
  nightwatchTask: null,
  manualSteps: ({ which, branchesOf, twoBranches, left, why }) => {
    const branches = () => branchesOf((environment, branch) => `${environment} track ${branch}`).join(' and ');
    return [
      [
        `In Laravel Cloud, for ${which('environment')}: turn off ${bold('Push to deploy')}${twoBranches ? `, make ${branches()}` : left.includes('staging') ? ', and make staging track the default branch' : ''}.`,
        ...why,
      ].join('\n'),
    ];
  },
};
