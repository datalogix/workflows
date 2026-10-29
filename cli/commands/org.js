import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cloudflareLoggedIn,
  cloudflareLogin,
  deployRelay,
  RELAY_PATH,
  RELAY_REPO,
  relayConfig,
  relayNamespace,
  relaySupported,
  relayWorker,
} from '../kinds/project/relay.js';
import { SETUP } from '../lib/evaluate.js';
import { packageRoot } from '../lib/project.js';
import { bold, clack, cyan, dim, orExit, runTasks } from '../lib/ui.js';

// What every project of an organization shares: the Claude GitHub App, the issue forms of its .github repository and
// the monitoring relay

const FORMS = join(packageRoot, 'examples', 'issue-templates');
const FORMS_PATH = '.github/ISSUE_TEMPLATE';
const CLAUDE_APP = 'https://github.com/apps/claude/installations/new';

/** The issue forms of this version, as { file name: content }. */
export async function issueForms(dir = FORMS) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.yml')).sort();
  return Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), 'utf8')])),
  );
}

/** Link to create the relay's GitHub token, filled in: owned by the organization, Contents: read and write. */
export function relayTokenUrl(organization) {
  const params = new URLSearchParams({
    name: `${organization} incident relay`.slice(0, 40),
    description:
      'Sends monitoring problems to the repositories as repository_dispatch events (datalogix/workflows relay)',
    target_name: organization,
    expires_in: '366',
    contents: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

const validToken = (value) =>
  !value?.trim() || /^github_pat_\w+$/.test(value.trim()) ? undefined : 'Paste a fine-grained token (github_pat_…)';

/** Asks for the relay's GitHub token, after showing where to create it; empty is `emptyMeans`. */
async function askToken(organization, emptyMeans) {
  clack.log.info(
    `Create a fine-grained token owned by ${bold(organization)}, for all repositories, with Contents: read and write:\n${cyan(relayTokenUrl(organization))}`,
  );
  const token = orExit(
    await clack.password({
      message: `GitHub token of the relay${dim(`  empty ${emptyMeans}`)}`,
      validate: validToken,
    }),
  );
  return token?.trim() ?? '';
}

/**
 * The relay task: deploys the worker of this version and stores its settings where setup reads them. `file` is
 * relay.json as read before (null when missing), whose sha the update needs.
 */
function relayTask(organization, relay, file, token) {
  const name = organization.organization;
  return {
    id: 'relay',
    title: relay.configured ? 'Monitoring relay (update)' : 'Monitoring relay',
    run: async () => {
      const namespaceId = relay.configured ? relay.namespaceId : (await relayNamespace()).id;
      const worker = relayWorker(name, relay.configured ? relay.url : '');
      const url = await deployRelay({ namespaceId, owner: name, token, worker });
      const content = `${JSON.stringify({ url, namespaceId, owner: name }, null, 2)}\n`;
      if (file?.content !== content) {
        await organization.putFile(
          RELAY_REPO,
          RELAY_PATH,
          content,
          'chore: store the monitoring relay settings',
          file?.sha,
        );
      }
      return `${relay.configured ? 'updated' : 'deployed'} ${url}`;
    },
  };
}

/**
 * Sets up what every project of the organization shares: checks the Claude GitHub App, creates the public .github
 * repository with the issue forms of this version and deploys the monitoring relay, then lists what is left by hand.
 */
export async function org(ctx) {
  const name = ctx.flags.org ?? ctx.repository?.split('/')[0];
  if (!name) throw new Error('Pass --org <organization>, or run it from a folder whose git remote is on GitHub');
  const organization = ctx.createOrganization(name);

  const spinner = clack.spinner();
  spinner.start(`Reading ${name}`);
  let plan, apps, repository, forms, current, relayFile;
  try {
    [plan, apps, repository, forms, relayFile] = await Promise.all([
      organization.plan(),
      organization.installedApps(),
      organization.repo(RELAY_REPO),
      issueForms(),
      // Kept with its sha for the relay task
      organization.file(RELAY_REPO, RELAY_PATH),
    ]);
    current = repository
      ? await Promise.all(Object.keys(forms).map((file) => organization.file(RELAY_REPO, `${FORMS_PATH}/${file}`)))
      : [];
  } catch (error) {
    // A running spinner keeps the process alive
    spinner.error(`Could not read ${name}`);
    throw error;
  }
  spinner.stop(`Read ${name}`);
  const relay = ctx.relay ?? relayConfig(relayFile?.content);

  const left = [];
  if (apps?.includes('claude')) clack.log.success('Claude GitHub App installed');
  else {
    if (apps === null) {
      clack.log.warn(
        `Could not see the GitHub Apps of ${name}: it takes an organization admin and the admin:org scope (${cyan('gh auth refresh -s admin:org')})`,
      );
    } else clack.log.error('The Claude GitHub App is not installed');
    left.push(
      `Make sure the Claude GitHub App is installed on ${bold(name)}, for all repositories:\n  ${cyan(CLAUDE_APP)}`,
    );
  }

  const tasks = [];
  if (!repository) {
    tasks.push({
      id: 'repository',
      title: `Public repository ${name}/${RELAY_REPO}`,
      run: async () => {
        await organization.createPublicRepo(
          RELAY_REPO,
          'Issue forms and settings every repository of the organization shares',
        );
        return 'created';
      },
    });
  }
  // With the forms read above (none when the repository is created by this run), so each update has its sha
  const changedForms = Object.keys(forms)
    .map((file, index) => ({ file, existing: current[index] }))
    .filter(({ file, existing }) => existing?.content !== forms[file]);
  tasks.push({
    id: 'issueForms',
    title: 'Issue forms',
    run: async () => {
      const changes = [];
      // One after another: parallel commits to one branch through the contents API conflict
      for (const { file, existing } of changedForms) {
        const path = `${FORMS_PATH}/${file}`;
        await organization.putFile(
          RELAY_REPO,
          path,
          forms[file],
          `chore: update the ${file} issue form`,
          existing?.sha,
        );
        changes.push(`${existing ? 'updated' : 'created'} ${file}`);
      }
      return changes.length ? changes.join(', ') : 'unchanged';
    },
  });

  if (!relaySupported()) {
    clack.log.warn('The monitoring relay cannot be deployed from Windows');
    left.push('Run org from macOS or Linux to deploy the monitoring relay.');
  } else if (!relay.configured) {
    const token = await askToken(name, 'to skip the relay (no problems become issues)');
    if (token) tasks.push(relayTask(organization, relay, relayFile, token));
    else
      left.push(`Problems of the monitoring service do not become issues until the relay is deployed: run org again.`);
  } else {
    clack.log.success(`Monitoring relay at ${relay.url}`);
    const update =
      !ctx.flags.yes &&
      orExit(
        await clack.confirm({
          message: 'Update the relay to this version (and replace its GitHub token)?',
          initialValue: false,
        }),
      );
    if (update) tasks.push(relayTask(organization, relay, relayFile, await askToken(name, 'to keep the current one')));
  }

  clack.note(tasks.map((task) => `• ${task.title}`).join('\n'), `Changes for ${name}`);
  if (!ctx.flags.yes && !orExit(await clack.confirm({ message: 'Apply these changes?', initialValue: true }))) {
    clack.cancel('Nothing was changed.');
    return 1;
  }

  // Before the progress bar: logging in opens the browser and may print a link
  if (tasks.some((task) => task.id === 'relay') && !(await cloudflareLoggedIn())) {
    clack.log.info('Log in to Cloudflare in the browser, where the relay runs');
    if (!(await cloudflareLogin())) throw new Error('Could not log in to Cloudflare: run npx wrangler login');
  }

  const results = await runTasks(tasks);
  for (const result of results) {
    const line = `${result.title}  ${dim(result.detail)}`;
    if (result.ok) clack.log.success(line);
    else clack.log.error(line);
  }

  const token = 'Generate the Claude token with claude setup-token';
  if (plan === 'free') {
    left.push(
      `${token}: on GitHub Free, private repositories cannot read organization secrets, so setup asks for it in each project.`,
    );
  } else {
    left.push(
      `${token} and store it once for every repository${plan ? '' : ' (on GitHub Free, setup asks for it in each project instead)'}:\n  ${cyan(`gh secret set CLAUDE_CODE_OAUTH_TOKEN --org ${name} --visibility all`)}`,
    );
  }
  left.push(`Set up each project from its folder:\n  ${cyan(SETUP)}`);
  clack.note(left.map((step, index) => `${index + 1}. ${step}`).join('\n\n'), 'Left to do by hand');

  const ok = results.every((result) => result.ok);
  clack.outro(ok ? `${name} is set up` : 'Finished with problems: fix them and run org again');
  return ok ? 0 : 1;
}
