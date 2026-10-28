import * as clack from '@clack/prompts';
import { styleText } from 'node:util';

export { clack };

export const dim = (text) => styleText('dim', text);
export const bold = (text) => styleText('bold', text);
export const cyan = (text) => styleText('cyan', text);

/** "■■■■□□□□□□  4/10": shown above each question, so you always know how far you are. */
export function stepBar(index, total, width = 10) {
  const filled = total ? Math.round((index / total) * width) : 0;
  return `${'■'.repeat(filled)}${'□'.repeat(width - filled)}  ${index}/${total}`;
}

/** Stops cleanly on Ctrl+C. */
export function orExit(value, message = 'Cancelled. Nothing was changed.') {
  if (clack.isCancel(value)) {
    clack.cancel(message);
    process.exit(1);
  }
  return value;
}

/**
 * Asks the active steps one at a time. A step is { id, when?(answers, ctx), flag?, validate?(value),
 * ask({ header, answers, ctx }), then?(answers, ctx) }; `then` runs right after the answer (e.g. to load what later
 * questions need). Steps answered by a command-line flag are skipped, after checking the value with `validate`. The
 * total is recomputed after every answer, because answers decide which later steps apply.
 */
export async function askSteps(steps, ctx, answers = {}) {
  const applies = (step) => (step.when ? step.when(answers, ctx) : true);
  const fromFlag = (step) => step.flag && ctx.flags?.[step.flag] !== undefined;

  for (const step of steps) {
    if (!applies(step)) continue;
    if (fromFlag(step)) {
      const problem = step.validate?.(ctx.flags[step.flag]);
      if (problem) throw new Error(`--${step.flag}: ${problem}`);
      answers[step.id] = ctx.flags[step.flag];
    } else {
      const active = steps.filter((candidate) => applies(candidate) && !fromFlag(candidate));
      const header = stepBar(active.indexOf(step) + 1, active.length);
      answers[step.id] = await step.ask({ header, answers, ctx });
    }
    if (step.then) await step.then(answers, ctx);
  }
  return answers;
}

/**
 * Local files are read from (and written to) the current folder, while GitHub changes go to the chosen repository:
 * when the folder's git remote is another repository, asks before going on (warns only with --yes).
 */
export async function confirmFolder(ctx, repository) {
  if (ctx.folderRepository?.toLowerCase() === repository.toLowerCase()) return;
  const folder = ctx.folderRepository ? `is ${ctx.folderRepository}` : 'has no GitHub remote';
  const message = `This folder ${folder}, not ${repository}: its files are the ones read and written`;
  if (ctx.flags?.yes) {
    clack.log.warn(message);
    return;
  }
  if (!orExit(await clack.confirm({ message: `${message}. Go on anyway?`, initialValue: false }))) {
    clack.cancel('Nothing was changed. Run it from the project folder.');
    process.exit(1);
  }
}

/** Message of a question: its progress bar on one line, the question on the next. */
export function question(header, text) {
  return `${dim(header)}\n${text}`;
}

/** The result fields of what a task's run returned: { detail } or { detail, data }. */
export function taskOutcome(value) {
  if (value && typeof value === 'object') return { detail: value.detail ?? 'done', data: value.data };
  return { detail: value ?? 'done' };
}

/**
 * Runs tasks with a progress bar. A task is { id?, title, run() } and run returns a short result
 * ('created', 'updated', 'unchanged', 'skipped: why'), or { detail, data } when later steps need more than the text;
 * a thrown error marks the task as failed and the others still run. The id, kept in the result, is what later steps
 * look the result up by, so the title can change freely.
 */
export async function runTasks(tasks) {
  const bar = clack.progress({ max: tasks.length, style: 'heavy' });
  bar.start(tasks[0]?.title ?? 'Applying');
  const results = [];
  for (const task of tasks) {
    bar.message(task.title);
    const named = { ...(task.id && { id: task.id }), title: task.title };
    try {
      results.push({ ...named, ok: true, ...taskOutcome(await task.run()) });
    } catch (error) {
      results.push({ ...named, ok: false, detail: error.message.split('\n')[0] });
    }
    bar.advance(1, task.title);
  }
  const failed = results.filter((result) => !result.ok).length;
  bar.stop(failed ? `Applied with ${failed} problem(s)` : 'All applied');
  return results;
}
