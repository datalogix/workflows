// What project.yml needs from a project that only apps (cli/kinds/project) read: the labels of the Claude workflows,
// the environments and the release GitHub App

// Shown in the target projects' GitHub, in the project's language (labelDescription)
export const LABELS = [
  {
    name: 'claude',
    color: '1d76db',
    description: {
      pt: 'Claude implementa e abre um pull request',
      en: 'Claude implements it and opens a pull request',
    },
  },
  {
    name: 'claude-plan',
    color: '0e8a16',
    description: { pt: 'Claude publica um plano de implementação', en: 'Claude posts an implementation plan' },
  },
  { name: 'no-review', color: 'ededed', description: { pt: 'Pula a revisão do Claude', en: "Skips Claude's review" } },
  {
    name: 'rollback',
    color: 'b60205',
    description: {
      pt: 'Reverte o ambiente para a versão anterior',
      en: 'Rolls the environment back to the previous release',
    },
  },
];

/**
 * LABELS and the env:<name> label of each deployed environment: rollback on an issue with one rolls that environment
 * back. The deploy and incident scripts create them too (environment_label in .github/actions/lib/releases.sh), with
 * the same color and text.
 */
export function labelsFor(environments) {
  return [
    ...LABELS,
    ...environments.map((environment) => ({
      name: `env:${environment}`,
      color: 'c5def5',
      description: {
        pt: 'Ambiente do problema; o label rollback reverte este ambiente',
        en: 'Environment of the problem; the rollback label rolls this environment back',
      },
    })),
  ];
}

/** A fixed text ({ en, pt }) in the project's language: English or Portuguese, as in the workflows. */
export function textIn(texts, language) {
  return /^en/i.test(language?.trim() ?? '') ? texts.en : texts.pt;
}

/** A label's description in the project's language. */
export function labelDescription(label, language) {
  return textIn(label.description, language);
}

// Secrets of the GitHub App that opens the release pull requests (production-branch)
const RELEASE_APP_SECRETS = ['RELEASE_APP_CLIENT_ID', 'RELEASE_APP_PRIVATE_KEY'];

export const NO_ENVIRONMENT = { exists: false, deployHook: false, healthUrl: null, monitoringToken: false };

/**
 * Whether the repository can read both secrets of the release GitHub App, as repository or organization secrets.
 * Without them the release pull requests are opened with the workflow token, so their checks do not run.
 */
export async function hasReleaseApp(github) {
  const found = await Promise.all(
    RELEASE_APP_SECRETS.map(async (name) => {
      const [repository, organization] = await Promise.all([
        github.hasRepositorySecret(name),
        github.hasOrganizationSecret(name).catch(() => false),
      ]);
      return repository || organization;
    }),
  );
  return found.every(Boolean);
}

/** The production branch of a project that deploys, which protect and check consider for the ruleset. */
export function deployedProductionBranch(current) {
  return current?.deploy !== 'none' ? (current?.productionBranch ?? null) : null;
}
