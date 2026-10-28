import { askSteps, clack, dim, orExit, runTasks } from '../lib/ui.js';
import { WORKFLOW_PATH } from '../lib/workflow-file.js';
import { detectStack, fromFlags, setupChoices } from '../stacks/index.js';

/**
 * The stack and kind to set up: --stack and --kind, else the detected ones, confirmed with a question (the detection
 * only reads the folder's files).
 */
export async function chooseStack(ctx) {
  const detected = await detectStack(ctx.root);
  // The workflow file decides the kind: setting it up as the other kind would replace it with the other template
  const { fileKind } = detected;
  let chosen = detected;
  if (ctx.flags.stack !== undefined || ctx.flags.kind !== undefined) chosen = fromFlags(ctx.flags, detected);
  else if (!ctx.flags.yes) {
    const choices = setupChoices().filter((choice) => !fileKind || choice.kind === fileKind);
    if (choices.length > 1 && choices.some((choice) => choice.label === detected.label)) {
      const label = orExit(
        await clack.select({
          message: `This folder looks like a ${detected.label}. Set it up as:`,
          initialValue: detected.label,
          options: choices.map((choice) => ({ value: choice.label, label: choice.label })),
        }),
      );
      chosen = choices.find((choice) => choice.label === label);
    }
  }
  if (fileKind && chosen.kind !== fileKind) {
    throw new Error(
      `${WORKFLOW_PATH} calls the ${fileKind} workflow: setup cannot set this folder up as a ${chosen.label}. Remove the file first to change it.`,
    );
  }
  // The workflow file goes along, so collectState does not read it again
  return { ...chosen, workflow: detected.workflow };
}

/**
 * Asks the questions of the folder's stack and kind (cli/stacks), shows the changes, applies them as tasks and lists
 * what is left to do by hand.
 */
export async function setup(ctx) {
  ctx.detected = await chooseStack(ctx);
  const { label, module } = ctx.detected;
  clack.log.info(`Setting up a ${label}`);
  await module.prepare?.(ctx);
  const answers = await askSteps(module.setup.steps(), ctx);

  const tasks = module.setup.tasks(answers, ctx);
  for (const warning of await module.setup.warnings(answers, ctx)) clack.log.warn(warning);
  clack.note(tasks.map((task) => `• ${task.title}`).join('\n'), `Changes for ${answers.repository}`);
  if (!ctx.flags.yes && !orExit(await clack.confirm({ message: 'Apply these changes?', initialValue: true }))) {
    clack.cancel('Nothing was changed.');
    return 1;
  }

  const results = await runTasks(tasks);
  for (const result of results) {
    const line = `${result.title}  ${dim(result.detail)}`;
    if (result.ok) clack.log.success(line);
    else clack.log.error(line);
  }

  clack.note(
    module.setup
      .nextSteps(answers, { ...ctx, results })
      .map((step, index) => `${index + 1}. ${step}`)
      .join('\n\n'),
    'Left to do by hand',
  );
  clack.outro(
    results.every((result) => result.ok)
      ? 'Setup complete'
      : 'Setup finished with problems: fix them and run setup again',
  );
  return results.every((result) => result.ok) ? 0 : 1;
}
