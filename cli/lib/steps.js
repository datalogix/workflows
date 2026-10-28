import { isOwnerList } from './codeowners.js';
import { isRepository } from './project.js';
import { collectState } from './state.js';
import { clack, confirmFolder, dim, orExit, question } from './ui.js';

// Setup questions every stack asks

const validRepository = (value) => (isRepository(value ?? '') ? undefined : 'Use owner/repo');
const validOwners = (value) =>
  isOwnerList(value ?? '') ? undefined : 'Use @user, @org/team or emails, separated by spaces';

/**
 * The first question of every setup: the repository, then what is already set up in it (ctx.state), from which the
 * other questions start. `readOptions` are the options of the kind's read (e.g. an app's `release`).
 */
export function repositoryStep({ readOptions = {} } = {}) {
  return {
    id: 'repository',
    flag: 'repo',
    validate: validRepository,
    ask: async ({ header, ctx }) =>
      orExit(
        await clack.text({
          message: question(header, 'GitHub repository'),
          initialValue: ctx.repository ?? '',
          placeholder: 'datalogix/app',
          validate: validRepository,
        }),
      ),
    then: async (answers, ctx) => {
      await confirmFolder(ctx, answers.repository);
      ctx.github = ctx.createGitHub(answers.repository);
      const spinner = clack.spinner();
      spinner.start(`Reading the current setup of ${answers.repository}`);
      let state;
      try {
        state = await collectState(ctx.github, ctx.root, { detected: ctx.detected, options: readOptions });
      } catch (error) {
        // A running spinner keeps the process alive
        spinner.error(`Could not read the current setup of ${answers.repository}`);
        throw error;
      }
      // An error stops setup before any change: main shows it and exits with 1
      if (!state) {
        spinner.error(`Could not read the current setup of ${answers.repository}`);
        throw new Error(`${answers.repository} was not found, or your gh login cannot see it`);
      }
      ctx.state = state;
      // GitHub's own spelling: the relay compares the owner as it is written
      if (state.repo.full_name) answers.repository = state.repo.full_name;
      spinner.stop(`Read the current setup of ${answers.repository}`);
    },
  };
}

/** Whether one person maintains the project or package: no code owner approval then (see protect). */
export function soloStep({ subject, initial = () => true }) {
  return {
    id: 'solo',
    flag: 'solo',
    ask: async ({ header, ctx }) =>
      orExit(
        await clack.confirm({
          message: question(header, `Do you work alone on this ${subject}?`),
          initialValue: initial(ctx),
        }),
      ),
  };
}

/** Who must approve changes to .github/, written to CODEOWNERS (codeOwnersTask). */
export function codeOwnersStep() {
  return {
    id: 'codeOwners',
    flag: 'code-owners',
    validate: validOwners,
    ask: async ({ header, ctx }) =>
      orExit(
        await clack.text({
          message: question(
            header,
            `Who must approve changes to .github/?${dim('  the workflow file and its checks')}`,
          ),
          initialValue: ctx.state.codeOwners?.join(' ') ?? (ctx.state.login ? `@${ctx.state.login}` : ''),
          placeholder: '@user or @datalogix/team',
          validate: validOwners,
        }),
      ),
  };
}
