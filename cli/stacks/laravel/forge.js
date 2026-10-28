import { apiClient, repositoryOf } from './api.js';

// What setup does in Forge with an API token: finds the sites of the repository, reads their deploy hook, makes their
// deploy script check out the commit the workflow asks for and turns off Push to deploy

export const forgeApi = (token) => apiClient('https://forge.laravel.com/api', token, 'Forge');

// Zero-downtime sites: right after cd $FORGE_RELEASE_DIRECTORY, the release checks out the commit
export const ZERO_DOWNTIME_SNIPPET = `if [ -n "$FORGE_VAR_COMMIT" ]; then
    git fetch --quiet origin "$FORGE_VAR_COMMIT"
    git checkout --quiet --detach "$FORGE_VAR_COMMIT"
fi`;

// Standard sites pull the branch in place: the checkout replaces their git pull
export const STANDARD_SNIPPET = `git fetch --quiet origin
git checkout --quiet --force --detach "\${FORGE_VAR_COMMIT:-origin/$FORGE_SITE_BRANCH}"`;

// The line ending stays out of the match, so the script keeps its own (\n or \r\n)
const RELEASE_DIRECTORY = /^([ \t]*)cd "?\$(?:FORGE_RELEASE_DIRECTORY|\{FORGE_RELEASE_DIRECTORY\})"?[ \t]*(?=\r?$)/m;
const PULL = /^([ \t]*)git pull origin "?\$(?:FORGE_SITE_BRANCH|\{FORGE_SITE_BRANCH\})"?[ \t]*(?=\r?$)/m;

/**
 * The deploy script checking out FORGE_VAR_COMMIT: unchanged when it already does, null when it has neither the cd of
 * a zero-downtime release nor the git pull of a standard site.
 */
export function withCommitCheckout(script) {
  if (script.includes('FORGE_VAR_COMMIT')) return script;
  const eol = script.includes('\r\n') ? '\r\n' : '\n';
  const lines = (snippet, spaces) => snippet.replace(/^/gm, spaces).replace(/\n/g, eol);
  const release = RELEASE_DIRECTORY.exec(script);
  if (release) {
    const end = release.index + release[0].length;
    return `${script.slice(0, end)}${eol}${lines(ZERO_DOWNTIME_SNIPPET, release[1])}${script.slice(end)}`;
  }
  const pull = PULL.exec(script);
  if (pull) return script.replace(PULL, () => lines(STANDARD_SNIPPET, pull[1]));
  return null;
}

const sitePath = (site) => `/orgs/${encodeURIComponent(site.organization)}/servers/${site.server}/sites/${site.id}`;

/** The sites of the repository in every organization the token sees: { organization, server, id, name, branch, pushToDeploy }. */
export async function forgeSites(api, repository) {
  const { data: organizations } = await api.all('/orgs');
  const sites = [];
  for (const organization of organizations) {
    const slug = organization.attributes.slug;
    const { data } = await api.all(`/orgs/${encodeURIComponent(slug)}/sites`);
    for (const site of data) {
      const server = site.relationships?.server?.data?.id;
      if (!server || repositoryOf(site.attributes.repository?.url) !== repository.toLowerCase()) continue;
      sites.push({
        organization: slug,
        server,
        id: site.id,
        name: site.attributes.name,
        branch: site.attributes.repository?.branch ?? null,
        pushToDeploy: Boolean(site.attributes.quick_deploy),
      });
    }
  }
  return sites;
}

/** The site's deploy hook URL. */
export async function forgeDeployHook(api, site) {
  const body = await api.get(`${sitePath(site)}/deployments/deploy-hook`);
  return body.data.attributes.url;
}

/** Makes the site's deploy script check out the commit and turns off its Push to deploy. */
export function forgeSiteTask(api, site, environment) {
  return {
    id: `deploySite:${environment}`,
    title: `Forge site ${site.name} (${environment})`,
    run: async () => {
      const changes = [];
      const { data } = await api.get(`${sitePath(site)}/deployments/script`);
      const script = data.attributes.content ?? '';
      const updated = withCommitCheckout(script);
      if (updated === null) {
        throw new Error(
          'the deploy script has neither cd $FORGE_RELEASE_DIRECTORY nor git pull origin $FORGE_SITE_BRANCH: change it by hand',
        );
      }
      if (updated !== script) {
        await api.put(`${sitePath(site)}/deployments/script`, {
          content: updated,
          auto_source: data.attributes.auto_source,
        });
        changes.push('deploy script checks out the commit');
      }
      if (site.pushToDeploy) {
        await api.delete(`${sitePath(site)}/deployments/push-to-deploy`);
        changes.push('Push to deploy off');
      }
      return changes.length ? changes.join(', ') : 'unchanged';
    },
  };
}

/**
 * Puts the app's Nightwatch token in the site's .env, when it has none: without it Nightwatch receives nothing. With
 * no token to write ({ data: { missing: true } }), setup lists it as left to do by hand.
 */
export function forgeNightwatchTask(api, site, environment, token) {
  return {
    id: `nightwatchEnv:${environment}`,
    title: `NIGHTWATCH_TOKEN of Forge site ${site.name} (${environment})`,
    run: async () => {
      const { data } = await api.get(`${sitePath(site)}/environment`);
      const content = data.attributes.content ?? '';
      if (/^NIGHTWATCH_TOKEN=[ \t]*["']?[^\s"'#]/m.test(content)) return 'unchanged';
      if (!token) return { detail: 'not in .env', data: { missing: true } };
      const line = `NIGHTWATCH_TOKEN=${token}`;
      const updated = /^NIGHTWATCH_TOKEN=.*$/m.test(content)
        ? content.replace(/^NIGHTWATCH_TOKEN=.*$/m, () => line)
        : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
      await api.put(`${sitePath(site)}/environment`, { environment: updated });
      // The deploy script caches the configuration again
      return 'added to .env, from the next deploy';
    },
  };
}
