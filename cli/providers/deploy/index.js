import cloud from './cloud.js';
import forge from './forge.js';
import vercel from './vercel.js';

/**
 * The deploy targets setup knows, each a file here whose default export is:
 *
 *   id            the deploy input and the script the deploy action runs (.github/actions/deploy/providers/<id>.sh)
 *   label         the option of the deploy question, e.g. "Laravel Forge"
 *   name, kind    how messages name the provider and what it deploys to, e.g. "Forge" and "site"
 *   where         where the app's environment variables are set, e.g. "the Forge site"
 *   hookHint      where to find the deploy hook
 *   tokenHint     what setup does with an API token
 *   api(token)    the API client; find(api, repository) the sites (or environments) that deploy the repository, each
 *                 { name, branch, ... }; hook(api, site) its deploy hook, or null when the hook is asked for
 *   targetLabel(site)                       a site in the site question
 *   task(api, site, environment, branch)    the setup task that makes the site deploy only what the workflows ask for
 *   nightwatchTask(api, site, environment, token) or null    puts the Nightwatch token in the site
 *   manualSteps({ which, branchesOf, twoBranches, left, why })    what is left to do by hand without the API
 *
 * and optionally, for a provider deployed by something else than a deploy hook:
 *
 *   secret        the environment secret its deploys need (DEPLOY_HOOK by default), which check looks for
 *   variables     the environment variables its deploys need, which check looks for
 *   hookQuestions false: setup asks for no deploy hook
 *   environmentValues(answers, environment)   { secrets, variables } setup writes in that environment
 *
 * A stack offers the ones its apps deploy to (deployProviders), and a new one also needs its deploy script.
 */
export const DEPLOY_PROVIDERS = Object.fromEntries([forge, cloud, vercel].map((provider) => [provider.id, provider]));

/** The deploy providers of a stack, by id, in the order given. */
export const deployProviders = (ids) => Object.fromEntries(ids.map((id) => [id, DEPLOY_PROVIDERS[id]]));
