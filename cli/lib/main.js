import { check } from '../commands/check.js';
import { org } from '../commands/org.js';
import { protect } from '../commands/protect.js';
import { setup } from '../commands/setup.js';
import { HELP, parseArgs } from './args.js';
import { createGitHub, createOrganization } from './github.js';
import { detectProject } from './project.js';
import { run } from './shell.js';
import { EMPTY_STATE } from './state.js';
import { clack, cyan } from './ui.js';

const COMMANDS = { setup, check, protect, org };

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    return 2;
  }

  const { command, flags } = parsed;
  if (command === 'help' || flags.help) {
    console.log(HELP);
    return 0;
  }
  if (!COMMANDS[command]) {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }

  clack.intro(` datalogix · ${command} `);

  // Only github.com: without --hostname, a broken login on another host (GitHub Enterprise) fails the check
  const gh = await run('gh', ['auth', 'status', '--hostname', 'github.com']);
  if (gh.code === 127) {
    clack.cancel(`The GitHub CLI is not installed: ${cyan('https://cli.github.com')}`);
    return 1;
  }
  if (gh.code !== 0) {
    clack.cancel(`Log in to GitHub first: ${cyan('gh auth login')}`);
    return 1;
  }

  const project = await detectProject(process.cwd());
  const repository = flags.repo ?? project.repository;
  // org takes the organization from --org when there is no repository
  if (!['setup', 'org'].includes(command) && !repository) {
    clack.cancel('Run it from the project folder, or pass --repo owner/repo');
    return 1;
  }

  try {
    const ctx = {
      root: project.root,
      repository,
      folderRepository: project.repository,
      flags,
      createGitHub,
      createOrganization,
      state: EMPTY_STATE,
    };
    return await COMMANDS[command](ctx);
  } catch (error) {
    clack.cancel(error.message);
    return 1;
  }
}
