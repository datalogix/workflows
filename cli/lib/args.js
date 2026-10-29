import { isRepository } from './project.js';

// The options it accepts, each listed in HELP
export const BOOLEAN = ['staging', 'branches', 'github-deployments', 'incidents', 'js', 'solo', 'yes', 'help'];
export const VALUE = [
  'repo',
  'deploy',
  'domain',
  'staging-domain',
  'development-branch',
  'production-branch',
  'health-path',
  'production',
  'monitoring',
  'layers',
  'approvals-medium',
  'approvals-high',
  'code-owners',
  'language',
  'lint',
  'lint-command',
  'test-command',
  'stack',
  'kind',
  'org',
];

/** The value of --flag=value for a boolean flag; anything but true/false, 1/0 or yes/no is refused. */
function booleanValue(name, value) {
  if (['true', '1', 'yes'].includes(value)) return true;
  if (['false', '0', 'no'].includes(value)) return false;
  throw new Error(`--${name} takes true or false`);
}

/**
 * Parses `<command> [--flag value] [--flag=value] [--flag] [--no-flag]`.
 * Boolean flags take no value; --no-<flag> sets one to false.
 */
export function parseArgs(argv) {
  const flags = {};
  let command = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (command === null) command = arg;
      else throw new Error(`Unexpected argument: ${arg}`);
      continue;
    }

    const [rawName, inline] = arg.slice(2).split(/=(.*)/s);
    if (rawName.startsWith('no-') && BOOLEAN.includes(rawName.slice(3))) {
      flags[rawName.slice(3)] = false;
    } else if (BOOLEAN.includes(rawName)) {
      flags[rawName] = inline === undefined ? true : booleanValue(rawName, inline);
    } else if (!VALUE.includes(rawName)) {
      throw new Error(`Unknown option: --${rawName}`);
    } else if (inline !== undefined) {
      flags[rawName] = inline;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[rawName] = argv[++i];
    } else {
      throw new Error(`--${rawName} needs a value`);
    }
  }

  if (flags.repo !== undefined && !isRepository(flags.repo)) {
    throw new Error('--repo must be owner/repo');
  }
  if (flags.org !== undefined && !/^[\w-]+$/.test(flags.org)) {
    throw new Error('--org must be an organization name');
  }
  if (flags.kind !== undefined && !['app', 'package'].includes(flags.kind)) {
    throw new Error('--kind must be app or package');
  }

  return { command: command ?? (flags.help ? 'help' : 'setup'), flags };
}

export const HELP = `Usage: npx --allow-git=root github:datalogix/workflows#v2 <command> [options]

Run it from the project folder. It uses your gh login.

Commands
  setup     Asks a few questions and sets the project up (default). Safe to run again.
  check     Lists what is missing or different, without changing anything.
  protect   Protects the default branch (and the production branch) of a project or a package. Run it after the first
            pull request shows its checks.
  org       Sets up what every project of the organization shares, once, as an organization admin: checks the Claude
            GitHub App, writes the issue forms to its public .github repository and deploys the monitoring relay.
            Safe to run again (updates the forms, and the relay if you say so).

Options (each one skips its question in setup)
  --stack laravel             Stack of the folder (default: detected)
  --kind app|package          An app or a package (default: detected)
  --org <organization>        Organization of org (default: the owner of the git remote)
  --repo owner/repo           Repository (default: from the git remote)
  --deploy <target>           Where the app is deployed (laravel: forge, cloud or none)
  --domain app.example.com    Production domain
  --staging / --no-staging    Deploy to staging before production
  --staging-domain <domain>   Staging domain
  --branches / --no-branches  Deploy production from its own branch (development branch → staging)
  --development-branch develop  Development branch, made the default branch
  --production-branch main    Production branch
  --health-path /up           Health check path
  --production auto|manual    Deploy production automatically, or only from Run workflow
  --github-deployments / --no-github-deployments  Record each deploy in the repository's Deployments
  --monitoring <service>      The app's monitoring service (laravel: nightwatch, sentry, inspector or none)
  --incidents / --no-incidents  Turn problems of the monitoring service (see --monitoring) into GitHub issues
  --solo / --no-solo          You work alone on the project (protect: on the package)
  --approvals-medium 1        Human approvals a medium-risk pull request needs (team projects)
  --approvals-high 1          Human approvals a high-risk pull request needs (team projects)
  --layers review,security-review,risk-gate,fix-ci  Claude workflows and risk gate on pull requests (none turns all off)
  --code-owners "@user"       Who must approve changes to .github/ (users or @org/teams)
  --language pt-BR            Language of what is written for the team (fixed texts: pt-BR or en)
  --lint pint,phpstan,command  Lint checks, separated by commas (none turns lint off)
  --lint-command "<command>"  Lint command, with --lint command
  --test-command "<command>"  Test command (none turns the test suite off)
  --js / --no-js              Run the typecheck, lint and test scripts of package.json
  --yes                       Do not ask for confirmation before applying
  --help                      Show this help

On Windows, setup does not store the monitoring service's signing secret in the relay:
store it by hand as relay/README.md in datalogix/workflows explains.
`;
