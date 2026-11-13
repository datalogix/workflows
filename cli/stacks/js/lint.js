import { inspectJsLint, NO_JS_LINT } from '../../lib/tools.js';
import { clack, dim, orExit, question } from '../../lib/ui.js';

// The lint question of a JavaScript app or library: the ESLint, Prettier and Stylelint the JS style check runs
// (.github/actions/js-lint), turned off by the eslint, prettier and stylelint inputs (cli/lib/tools.js). The typecheck
// and lint scripts of package.json always run, so they are not asked

export { inspectJsLint, NO_JS_LINT };

const OPTIONS = {
  eslint: { label: 'ESLint', hint: 'without a lint script; changed files on pull requests' },
  prettier: { label: 'Prettier', hint: 'format:check, or changed files on pull requests' },
  stylelint: { label: 'Stylelint', hint: 'lint:css, or changed files on pull requests' },
};
const CHOICES = Object.keys(OPTIONS);
// --lint eslint,prettier,stylelint, or none
const parse = (value) => (value.trim() === 'none' ? [] : value.split(',').map((choice) => choice.trim()));
const installedOf = (ctx) => CHOICES.filter((tool) => ctx.state.jsLint?.[tool]);

/** Which of the tools the JS style check would run stay on, asked when it would run one. */
export const jsLintStep = {
  id: 'jsLint',
  flag: 'lint',
  validate: (value) =>
    parse(value ?? '').every((choice) => CHOICES.includes(choice))
      ? undefined
      : `use ${CHOICES.join(', ')} separated by commas, or none`,
  parse,
  when: (_answers, ctx) => installedOf(ctx).length > 0,
  ask: async ({ header, ctx }) => {
    const installed = installedOf(ctx);
    return orExit(
      await clack.multiselect({
        message: question(header, `Lint checks${dim('  installed tools come checked; the lint script always runs')}`),
        options: installed.map((tool) => ({ value: tool, ...OPTIONS[tool] })),
        initialValues: installed.filter((tool) => ctx.state.current?.[tool] !== false),
        required: false,
      }),
    );
  },
  // A tool that would run but is not checked is turned off; one that would not run stays at its default
  then: (answers, ctx) => {
    for (const tool of installedOf(ctx)) answers[tool] = answers.jsLint.includes(tool) ? undefined : false;
  },
};
