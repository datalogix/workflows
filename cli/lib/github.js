import { run, runOrThrow } from './shell.js';

/** The REST calls both clients share, through gh: a request, a GET that is null on 404, and the same over every page. */
function rest(runner) {
  const api = async (path, { method = 'GET', body } = {}) => {
    const args = ['api', '--method', method, path];
    if (body !== undefined) args.push('--input', '-');
    const stdout = await runner.runOrThrow('gh', args, {
      input: body === undefined ? undefined : JSON.stringify(body),
    });
    return stdout.trim() ? JSON.parse(stdout) : null;
  };

  // GET that returns null on 404 instead of failing
  const find = async (path) => {
    const result = await runner.run('gh', ['api', path]);
    if (result.code === 0) return result.stdout.trim() ? JSON.parse(result.stdout) : null;
    if (/HTTP 404|Not Found/i.test(result.stderr)) return null;
    throw new Error(`gh api ${path}: ${result.stderr.trim()}`);
  };

  // find over every page: the objects jq picks from each one (`.items[]`), null on 404
  const findAll = async (path, jq) => {
    const result = await runner.run('gh', ['api', '--paginate', path, '--jq', jq]);
    if (result.code === 0)
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    if (/HTTP 404|Not Found/i.test(result.stderr)) return null;
    throw new Error(`gh api ${path}: ${result.stderr.trim()}`);
  };

  return { api, find, findAll };
}

/**
 * GitHub access through the gh CLI, which provides the login and encrypts secrets.
 * Takes a runner so tests can replace gh.
 */
export function createGitHub(repository, runner = { run, runOrThrow }) {
  const { api, find, findAll } = rest(runner);

  // Private repositories on GitHub Free have no rulesets or branch protection
  const PLAN_LIMIT = /Upgrade to GitHub Pro|make this repository public/i;

  // Names of the organization secrets this repository can read (none for private repositories on GitHub Free),
  // fetched once per command
  let organizationSecrets;

  const paginate = async (path) => {
    const stdout = await runner.runOrThrow('gh', ['api', '--paginate', path, '--jq', '.[]']);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };

  const r = `repos/${repository}`;

  return {
    repository,

    repo: () => find(r),
    setDefaultBranch: (name) => api(r, { method: 'PATCH', body: { default_branch: name } }),

    // Each path segment encoded: the name comes from the workflow file and may hold #, % or ?
    branch: (name) => find(`${r}/branches/${name.split('/').map(encodeURIComponent).join('/')}`),
    createBranch: (name, sha) => api(`${r}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${name}`, sha } }),

    login: async () => (await find('user'))?.login ?? null,

    labels: async () =>
      (await paginate(`${r}/labels?per_page=100`)).map((label) => ({
        name: label.name,
        description: label.description,
      })),
    createLabel: (name, color, description) =>
      api(`${r}/labels`, { method: 'POST', body: { name, color, description } }),
    setLabelDescription: (name, description) =>
      api(`${r}/labels/${encodeURIComponent(name)}`, { method: 'PATCH', body: { description } }),

    environment: (name) => find(`${r}/environments/${name}`),
    createEnvironment: (name) => api(`${r}/environments/${name}`, { method: 'PUT', body: {} }),

    hasEnvironmentSecret: async (environment, name) =>
      Boolean(await find(`${r}/environments/${environment}/secrets/${name}`)),
    environmentVariable: async (environment, name) =>
      (await find(`${r}/environments/${environment}/variables/${name}`))?.value ?? null,

    // Whether GitHub Actions may open pull requests with the workflow token, and the token's default permissions
    workflowPermissions: () => find(`${r}/actions/permissions/workflow`),
    allowActionsPullRequests: (defaultPermissions) =>
      api(`${r}/actions/permissions/workflow`, {
        method: 'PUT',
        body: { default_workflow_permissions: defaultPermissions, can_approve_pull_request_reviews: true },
      }),

    hasRepositorySecret: async (name) => Boolean(await find(`${r}/actions/secrets/${name}`)),
    hasOrganizationSecret: async (name) => {
      organizationSecrets ??= findAll(`${r}/actions/organization-secrets?per_page=100`, '.secrets[]').then(
        (secrets) => secrets?.map((secret) => secret.name) ?? [],
      );
      return (await organizationSecrets).includes(name);
    },

    // gh encrypts the value with the repository's key; it is sent on stdin, never as an argument
    setSecret: (name, value, environment) =>
      runner.runOrThrow(
        'gh',
        ['secret', 'set', name, '--repo', repository, ...(environment ? ['--env', environment] : [])],
        { input: value },
      ),
    deleteSecret: (name, environment) =>
      runner.runOrThrow('gh', ['secret', 'delete', name, '--repo', repository, '--env', environment]),
    setVariable: (name, value, environment) =>
      runner.runOrThrow('gh', ['variable', 'set', name, '--repo', repository, '--env', environment, '--body', value]),

    // Only the repository's own: rulesets inherited from the organization cannot be changed through it. Null when
    // the plan does not offer rulesets for this repository
    async rulesets() {
      try {
        return (await find(`${r}/rulesets?per_page=100&includes_parents=false`)) ?? [];
      } catch (error) {
        if (PLAN_LIMIT.test(error.message)) return null;
        throw error;
      }
    },
    ruleset: (id) => find(`${r}/rulesets/${id}`),
    createRuleset: (body) => api(`${r}/rulesets`, { method: 'POST', body }),
    updateRuleset: (id, body) => api(`${r}/rulesets/${id}`, { method: 'PUT', body }),

    // Names of the checks that ran on the most recent pull request
    async latestPullRequestChecks() {
      const pulls = await find(`${r}/pulls?state=all&per_page=1&sort=created&direction=desc`);
      const pull = pulls?.[0];
      if (!pull) return null;
      const runs = await findAll(`${r}/commits/${pull.head.sha}/check-runs?per_page=100`, '.check_runs[]');
      return { number: pull.number, names: (runs ?? []).map((check) => check.name) };
    },
  };
}

/**
 * What the org command reads and writes in an organization, through the gh CLI. Takes a runner so tests can replace
 * gh.
 */
export function createOrganization(organization, runner = { run, runOrThrow }) {
  const { api, find } = rest(runner);
  const o = `orgs/${organization}`;

  return {
    organization,

    // The plan's name (free, team, enterprise), or null when gh cannot see it (only members see it)
    plan: async () => (await find(o))?.plan?.name ?? null,

    // Slugs of the GitHub Apps installed on the organization, or null without the admin:org scope (or not an admin)
    async installedApps() {
      const result = await runner.run('gh', [
        'api',
        '--paginate',
        `${o}/installations`,
        '--jq',
        '.installations[].app_slug',
      ]);
      if (result.code === 0) return result.stdout.split('\n').filter(Boolean);
      if (/admin:org|HTTP 403|HTTP 404|Not Found/i.test(result.stderr)) return null;
      throw new Error(`gh api ${o}/installations: ${result.stderr.trim()}`);
    },

    repo: (name) => find(`repos/${organization}/${name}`),
    // With a first commit, so files can be added through the contents API right away
    createPublicRepo: (name, description) =>
      api(`${o}/repos`, { method: 'POST', body: { name, description, visibility: 'public', auto_init: true } }),

    // A file of a repository: its text and the sha needed to replace it, or null
    async file(name, path) {
      const found = await find(`repos/${organization}/${name}/contents/${path}`);
      return found ? { sha: found.sha, content: Buffer.from(found.content, 'base64').toString('utf8') } : null;
    },
    putFile: (name, path, content, message, sha) =>
      api(`repos/${organization}/${name}/contents/${path}`, {
        method: 'PUT',
        body: { message, content: Buffer.from(content).toString('base64'), ...(sha && { sha }) },
      }),
  };
}
