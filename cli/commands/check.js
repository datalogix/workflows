import { collectState } from '../lib/state.js';
import { clack, dim } from '../lib/ui.js';
import { detectStack, STACKS, withModule } from '../stacks/index.js';

/**
 * Compares the project or package with what the workflows need, as its stack and kind (state.stack, state.kind)
 * define. Each item is { level: ok | warn | error, title, hint }. Errors break the workflows; warnings leave a layer
 * weaker than it should be.
 */
export async function evaluate(state, options) {
  const stack = STACKS.find((candidate) => candidate.id === state.stack);
  if (!stack) throw new Error(`Unknown stack: ${state.stack}`);
  return withModule(stack, state.kind).module.evaluate(state, options);
}

export async function check(ctx) {
  if (ctx.folderRepository?.toLowerCase() !== ctx.repository.toLowerCase()) {
    clack.log.warn(`This folder is not ${ctx.repository}: its local files are checked`);
  }
  const spinner = clack.spinner();
  spinner.start(`Checking ${ctx.repository}`);
  const github = ctx.createGitHub(ctx.repository);
  let state;
  let items;
  try {
    const detected = await detectStack(ctx.root);
    // The relay settings (prepare) do not depend on the state, so both are read together
    [, state] = await Promise.all([detected.module.prepare?.(ctx), collectState(github, ctx.root, { detected })]);
    // GitHub's own spelling of the repository, which the relay keys use
    if (state) items = await evaluate(state, { relay: ctx.relay, repository: state.repo?.full_name ?? ctx.repository });
  } catch (error) {
    // A running spinner keeps the process alive
    spinner.error(`Could not check ${ctx.repository}`);
    throw error;
  }
  if (!state) {
    spinner.error(`${ctx.repository} was not found, or your gh login cannot see it`);
    return 1;
  }
  spinner.stop(`Checked ${ctx.repository}`);

  for (const item of items) {
    const hint = item.hint ? dim(`  → ${item.hint}`) : '';
    if (item.level === 'ok') clack.log.success(item.title);
    else if (item.level === 'warn') clack.log.warn(`${item.title}${hint}`);
    else clack.log.error(`${item.title}${hint}`);
  }

  const errors = items.filter((item) => item.level === 'error').length;
  const warnings = items.filter((item) => item.level === 'warn').length;
  clack.outro(errors || warnings ? `${errors} error(s), ${warnings} warning(s)` : 'Everything is set up');
  return errors ? 1 : 0;
}
