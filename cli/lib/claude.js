import { CLAUDE_INSTALL, SETUP } from './evaluate.js';
import { bold, clack, cyan, dim, orExit, question } from './ui.js';

// What the Claude workflows need from any project or package that turns them on: the Claude token, the Claude GitHub
// App, the team language and the labels that start them (cli/kinds/project for apps, cli/kinds/package for packages)

// Default of the language input of project.yml and package.yml
export const DEFAULT_LANGUAGE = 'pt-BR';

// The labels of the Claude workflows, shown in the target projects' GitHub in the project's language (labelDescription)
export const CLAUDE_LABEL = {
  name: 'claude',
  color: '1d76db',
  description: {
    pt: 'Claude implementa e abre um pull request',
    en: 'Claude implements it and opens a pull request',
  },
};
export const PLAN_LABEL = {
  name: 'claude-plan',
  color: '0e8a16',
  description: { pt: 'Claude publica um plano de implementação', en: 'Claude posts an implementation plan' },
};
export const NO_REVIEW_LABEL = {
  name: 'no-review',
  color: 'ededed',
  description: { pt: 'Pula a revisão do Claude', en: "Skips Claude's review" },
};

// What the reads below return, before they are read
export const CLAUDE_STATE = {
  labels: [],
  labelDescriptions: {},
  claudeToken: { repository: false, organization: false },
  // How the Claude GitHub App reaches the owner's repositories (github.claudeApp); 'all' until it is read
  claudeApp: 'all',
};

const notEmpty = (value) => (value?.trim() ? undefined : 'Required');
const ownerOf = (repository) => repository.split('/')[0];

// Goes into Claude's system prompt between double quotes: letters, digits, spaces, hyphens and underscores only
export const validLanguage = (value) =>
  /^\p{L}[\p{L}\p{N} _-]*$/u.test(value?.trim() ?? '') ? undefined : 'Use a language name or code, e.g. pt-BR or en';

/** A fixed text ({ en, pt }) in the project's language: English or Portuguese, as in the workflows. */
export function textIn(texts, language) {
  return /^en/i.test(language?.trim() ?? '') ? texts.en : texts.pt;
}

/** A label's description in the project's language. */
export function labelDescription(label, language) {
  return textIn(label.description, language);
}

/** The labels of the repository and their descriptions. */
export async function readLabels(github, read) {
  const labels = await read('labels', github.labels());
  return {
    labels: labels.map((label) => label.name),
    // By label name, as GitHub spells it
    labelDescriptions: Object.fromEntries(labels.map((label) => [label.name, label.description ?? ''])),
  };
}

/** Whether the repository can read a Claude token, and how the Claude GitHub App reaches the owner's repositories. */
export async function readClaude(github, read) {
  const [repository, organization, claudeApp] = await Promise.all([
    read('secrets', github.hasRepositorySecret('CLAUDE_CODE_OAUTH_TOKEN')),
    // Optional: without access to organization secrets, setup asks for the token
    github.hasOrganizationSecret('CLAUDE_CODE_OAUTH_TOKEN').catch(() => false),
    // Optional: null when gh cannot see the organization's GitHub Apps, or the read fails (check and nextSteps say so)
    github.claudeApp().catch(() => null),
  ]);
  return { claudeToken: { repository, organization }, claudeApp };
}

/** The Claude token, asked when the repository cannot read one (and when(answers) says the workflows need it). */
export function claudeTokenStep({ when = () => true, about } = {}) {
  return {
    id: 'claudeToken',
    when: (a, ctx) => when(a, ctx) && !ctx.state.claudeToken.repository && !ctx.state.claudeToken.organization,
    ask: async ({ header }) =>
      orExit(
        await clack.password({
          message: question(
            header,
            `Claude token${dim('  from `claude setup-token`; stored as a repository secret')}`,
            about ??
              'Used by every Claude workflow: @claude, the reviews, Fix CI and the analysis of production problems',
          ),
          validate: notEmpty,
        }),
      ),
  };
}

/** The language of what is written for the team (the language input). */
export function languageStep({ when } = {}) {
  return {
    id: 'language',
    flag: 'language',
    ...(when ? { when } : {}),
    validate: validLanguage,
    ask: async ({ header, ctx }) =>
      orExit(
        await clack.text({
          message: question(
            header,
            `Language of what is written for the team${dim('  issues, pull requests, comments and commits')}`,
          ),
          initialValue: ctx.state.current?.language ?? DEFAULT_LANGUAGE,
          placeholder: DEFAULT_LANGUAGE,
          validate: validLanguage,
        }),
      ),
  };
}

/** Creates the missing labels, and translates the descriptions still in another language's default text. */
export function labelsTask(labels, { github, state, language }) {
  return {
    title: 'Labels',
    run: async () => {
      // Label names are case-insensitive on GitHub: "Rollback" is the rollback label
      const existing = new Map(state.labels.map((name) => [name.toLowerCase(), name]));
      const missing = labels.filter((label) => !existing.has(label.name.toLowerCase()));
      // A description that is still the default text in another language follows the project's language; one written
      // by hand is kept
      const translations = labels
        .map((label) => ({ name: existing.get(label.name.toLowerCase()), label }))
        .filter(({ name, label }) => {
          const current = state.labelDescriptions[name];
          return (
            name && current !== labelDescription(label, language) && Object.values(label.description).includes(current)
          );
        });
      // Each label is its own request, independent of the others
      await Promise.all([
        ...missing.map((label) => github.createLabel(label.name, label.color, labelDescription(label, language))),
        ...translations.map(({ name, label }) => github.setLabelDescription(name, labelDescription(label, language))),
      ]);
      const translated = translations.map(({ name }) => name);
      const changes = [
        ...(missing.length ? [`created ${missing.map((label) => label.name).join(', ')}`] : []),
        ...(translated.length ? [`translated ${translated.join(', ')}`] : []),
      ];
      return changes.length ? changes.join(', ') : 'unchanged';
    },
  };
}

/** Stores the Claude token typed in setup, when one was. */
export function claudeTokenTasks(answers, github) {
  if (!answers.claudeToken) return [];
  return [
    {
      title: 'Claude token',
      run: async () => {
        await github.setSecret('CLAUDE_CODE_OAUTH_TOKEN', answers.claudeToken);
        return 'stored as a repository secret';
      },
    },
  ];
}

/** The check items of the labels: an error for a missing one, a warning for a missing optional one. */
export function labelItems({ ok, warn, error }, state, labels) {
  // Label names are case-insensitive on GitHub
  const names = new Set(state.labels.map((name) => name.toLowerCase()));
  const missingLabels = labels.filter((label) => !names.has(label.name.toLowerCase()));
  const labelNames = (list) => list.map((label) => label.name).join(', ');
  const needed = missingLabels.filter((label) => !label.optional);
  const optional = missingLabels.filter((label) => label.optional);
  if (needed.length) error(`Missing labels: ${labelNames(needed)}`, SETUP);
  for (const label of optional) warn(`Missing label: ${label.name} (${label.optional})`, SETUP);
  if (!missingLabels.length) ok('Labels');
}

/** The check items of the Claude token and the Claude GitHub App. */
export function claudeItems({ ok, warn, error }, state) {
  if (state.claudeToken.repository) ok('CLAUDE_CODE_OAUTH_TOKEN (repository secret)');
  else if (state.claudeToken.organization) ok('CLAUDE_CODE_OAUTH_TOKEN (organization secret)');
  else error('CLAUDE_CODE_OAUTH_TOKEN is not available to this repository', SETUP);

  if (state.claudeApp === 'all') ok('Claude GitHub App (every repository)');
  else if (state.claudeApp === 'selected')
    warn(
      'The Claude GitHub App reaches only selected repositories: without this one, the Claude workflows cannot act',
      'add it in Settings > GitHub Apps > Claude > Configure',
    );
  else if (state.claudeApp === 'none') error('The Claude GitHub App is not installed', CLAUDE_INSTALL);
  else
    warn(
      'Could not see whether the Claude GitHub App reaches this repository',
      'run check as an organization admin after gh auth refresh -s admin:org',
    );
}

/** What it takes for the Claude GitHub App to reach the repository. */
export function claudeAppNextSteps(answers, state) {
  const owner = ownerOf(answers.repository);
  const claudeInstall = cyan(CLAUDE_INSTALL);
  if (state.claudeApp === 'none') {
    return [
      `Install the Claude GitHub App on ${bold(owner)}, or the Claude workflows (mentions, reviews, fix-ci, incidents) cannot act:\n  ${claudeInstall}`,
    ];
  } else if (state.claudeApp === 'selected') {
    return [
      `The Claude GitHub App reaches only selected repositories of ${bold(owner)}: add ${bold(answers.repository)} in its settings (${bold('Settings > GitHub Apps > Claude > Configure')}), or the Claude workflows cannot act on it.`,
    ];
  } else if (state.claudeApp === null) {
    return [
      `Could not see the GitHub Apps of ${bold(owner)} (it takes an organization admin and ${cyan('gh auth refresh -s admin:org')}): make sure the Claude GitHub App reaches ${bold(answers.repository)}:\n  ${claudeInstall}`,
    ];
  }
  return [];
}
