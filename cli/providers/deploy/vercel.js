import { bold, cyan } from '../../lib/ui.js';
import { apiClient } from './api.js';

// What setup does in Vercel with an API token: finds the projects linked to the repository, in the user's account and
// teams, and creates the project's staging custom environment when it has none. Unlike Forge's, the token is also
// stored, as the VERCEL_TOKEN secret of each environment: the deploys create their deployments with it

export const vercelApi = (token) => apiClient('https://api.vercel.com', token, 'Vercel');

const withTeam = (path, teamId) => (teamId ? `${path}${path.includes('?') ? '&' : '?'}teamId=${teamId}` : path);

/** The projects linked to the repository: { id, name, teamId, team, branch }, in the account and in each team. */
export async function vercelProjects(api, repository) {
  const { teams = [] } = (await api.get('/v2/teams?limit=100')) ?? {};
  const scopes = [{ id: null, slug: null }, ...teams.map((team) => ({ id: team.id, slug: team.slug }))];
  const found = new Map();
  for (const scope of scopes) {
    const path = withTeam(
      `/v10/projects?limit=100&repoUrl=${encodeURIComponent(`https://github.com/${repository}`)}`,
      scope.id,
    );
    const body = await api.get(path);
    // An array in older answers, { projects, pagination } in the current one
    for (const project of Array.isArray(body) ? body : (body?.projects ?? [])) {
      const linked = `${project.link?.org}/${project.link?.repo}`.toLowerCase() === repository.toLowerCase();
      if (!linked || found.has(project.id)) continue;
      found.set(project.id, {
        id: project.id,
        name: project.name,
        teamId: scope.id ?? (project.accountId?.startsWith('team_') ? project.accountId : null),
        team: scope.slug,
        branch: project.link?.productionBranch ?? null,
      });
    }
  }
  return [...found.values()];
}

/**
 * The project's staging custom environment, created when it is missing (Pro and Enterprise teams have custom
 * environments). Its domain is set in Vercel: the API answer says whether it has one.
 */
export function vercelStagingTask(api, project) {
  return {
    id: 'vercelStaging',
    title: `Vercel environment staging of ${project.name}`,
    run: async () => {
      const path = withTeam(`/v9/projects/${encodeURIComponent(project.id)}/custom-environments`, project.teamId);
      const { environments = [] } = (await api.get(path)) ?? {};
      const staging = environments.find((environment) => environment.slug === 'staging');
      if (!staging) {
        await api.post(path, { slug: 'staging', description: 'Deployed by the Datalogix workflows' });
        return { detail: 'created, without a domain', data: { domain: false } };
      }
      const domain = Boolean(staging.domains?.length);
      return { detail: domain ? 'unchanged' : 'no domain yet', data: { domain } };
    },
  };
}

/** Vercel, as a deploy target of setup (see index.js); the js stack asks its token and project (cli/stacks/js). */
export default {
  id: 'vercel',
  label: 'Vercel',
  name: 'Vercel',
  kind: 'project',
  where: 'the Vercel project',
  hookHint: '',
  tokenHint: 'an access token with access to the project, stored as the VERCEL_TOKEN secret of each environment',
  secret: 'VERCEL_TOKEN',
  variables: ['VERCEL_PROJECT'],
  hookQuestions: false,
  /** The token, the project and the protection bypass of the answers, for each environment. */
  environmentValues: (answers) => ({
    secrets: {
      VERCEL_TOKEN: answers.deployToken?.trim(),
      VERCEL_AUTOMATION_BYPASS_SECRET: answers.vercelBypass?.trim(),
    },
    variables: { VERCEL_PROJECT: answers.vercelProject?.id, VERCEL_TEAM_ID: answers.vercelProject?.teamId },
  }),
  manualSteps: ({ answers }) => {
    const steps = [];
    if (!answers.deployToken?.trim() || !answers.vercelProject) {
      steps.push(
        `In each GitHub environment, set the ${bold('VERCEL_TOKEN')} secret and the ${bold('VERCEL_PROJECT')} variable (the project's id or name; ${bold('VERCEL_TEAM_ID')} too for a team's project), or run setup again with a token.`,
      );
    }
    if (!answers.vercelBypass?.trim()) {
      steps.push(
        `If Deployment Protection covers an environment (staging, with Standard Protection), store the project's Protection Bypass for Automation secret (${bold('Settings > Deployment Protection')}) as the ${bold('VERCEL_AUTOMATION_BYPASS_SECRET')} secret of each environment, or every deploy fails its health checks:\n  ${cyan('gh secret set VERCEL_AUTOMATION_BYPASS_SECRET --env staging')}`,
      );
    }
    return steps;
  },
};
