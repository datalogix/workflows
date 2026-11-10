import { bold } from '../../lib/ui.js';
import { apiClient } from './api.js';

// What setup does in Netlify with an API token: finds the sites linked to the repository, one per environment, and
// locks auto publishing on each, so Netlify's own builds of a push never go live: the deploys publish the build of the
// exact commit once it is ready. As on Vercel, the token is also stored, as the NETLIFY_TOKEN secret of each environment

export const netlifyApi = (token) => apiClient('https://api.netlify.com/api/v1', token, 'Netlify');

const PER_PAGE = 100;
// A list longer than this is a loop, not a real account
const MAX_PAGES = 50;

/** The sites linked to the repository, in every account the token reaches: { id, name, url, branch }. */
export async function netlifySites(api, repository) {
  const found = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sites = (await api.get(`/sites?filter=all&per_page=${PER_PAGE}&page=${page}`)) ?? [];
    for (const site of sites) {
      const settings = site.build_settings ?? {};
      const linked =
        settings.repo_path?.toLowerCase() === repository.toLowerCase() ||
        settings.repo_url?.toLowerCase().replace(/\.git$/, '') === `https://github.com/${repository}`.toLowerCase();
      if (!linked) continue;
      found.push({
        id: site.id,
        name: site.name,
        url: site.ssl_url ?? site.url ?? null,
        branch: settings.repo_branch ?? null,
      });
    }
    if (sites.length < PER_PAGE) break;
  }
  return found;
}

/** Locks auto publishing on the site: its published deploy stays live until the deploys publish another. */
export function netlifyLockTask(api, site, environment) {
  return {
    id: `netlifyLock:${environment}`,
    title: `Netlify auto publishing of ${site.name} (${environment})`,
    run: async () => {
      const { published_deploy: published } = (await api.get(`/sites/${encodeURIComponent(site.id)}`)) ?? {};
      if (!published?.id) return 'nothing published yet: the first deploy locks it';
      if (published.locked) return 'unchanged';
      await api.post(`/deploys/${encodeURIComponent(published.id)}/lock`);
      return 'locked';
    },
  };
}

/** The site of an environment in the answers: staging has its own. */
const siteOf = (answers, environment) => (environment === 'staging' ? answers.netlifyStagingSite : answers.netlifySite);

/** Netlify, as a deploy target of setup (see index.js); the js stack asks its token and sites (cli/stacks/js). */
export default {
  id: 'netlify',
  label: 'Netlify',
  name: 'Netlify',
  kind: 'site',
  where: 'the Netlify site',
  hookHint: '',
  tokenHint: 'a personal access token, stored as the NETLIFY_TOKEN secret of each environment',
  secret: 'NETLIFY_TOKEN',
  variables: ['NETLIFY_SITE_ID'],
  hookQuestions: false,
  /** The token, and the site of the environment. */
  environmentValues: (answers, environment) => ({
    secrets: { NETLIFY_TOKEN: answers.deployToken?.trim() },
    variables: { NETLIFY_SITE_ID: siteOf(answers, environment)?.id },
  }),
  // What neither the answers nor the environments have: a setup run again keeps what is stored
  manualSteps: ({ answers, state }) => {
    const names = answers.staging ? ['production', 'staging'] : ['production'];
    const missing = names.filter((name) => {
      const environment = state?.environments?.[name] ?? {};
      return (
        (!answers.deployToken?.trim() && !environment.deployHook) ||
        (!siteOf(answers, name) && !environment.variables?.NETLIFY_SITE_ID)
      );
    });
    const steps = [];
    if (missing.length) {
      steps.push(
        `In the GitHub environment ${missing.map((name) => bold(name)).join(' and ')}, set the ${bold('NETLIFY_TOKEN')} secret and the ${bold('NETLIFY_SITE_ID')} variable (the id of that environment's own site), or run setup again with a token.`,
      );
    }
    // With a token, setup locked them; the first deploy locks them too
    if (!answers.deployToken?.trim()) {
      steps.push(
        `In each Netlify site, open ${bold('Deploys')} and choose ${bold('Lock to stop auto publishing')}, or every push goes live before its tests until the first deploy of the workflows.`,
      );
    }
    return steps;
  },
};
