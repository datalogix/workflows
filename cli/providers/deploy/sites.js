import { answeredEnvironments, deploys, twoBranches } from '../../kinds/project/index.js';
import { bold, clack, dim, orExit, question } from '../../lib/ui.js';

// The deploy questions, tasks and next steps of the targets that deploy a site (or environment) found with an API token:
// Forge and Laravel Cloud, shared by the stacks that offer them (Laravel and PHP apps)

/**
 * The branch an environment deploys: with two branches, the development one to staging and the production one to
 * production; otherwise the default branch (null: whatever the site has).
 */
function branchOf(a, environment, state) {
  if (twoBranches(a)) return environment === 'staging' ? a.developmentBranch : a.productionBranch;
  return state.defaultBranch ?? null;
}

/** The branch a Cloud environment must track: both with two branches, staging otherwise (Forge gets it in the hook). */
function cloudBranch(answers, environment, state) {
  if (twoBranches(answers)) return branchOf(answers, environment, state);
  return environment === 'staging' ? branchOf(answers, environment, state) : null;
}

/**
 * The site (or environment) suggested for an environment: one on its branch named after it, else one on its branch not
 * named after the other environment (without two branches both deploy the same branch), else one named after it.
 */
export function suggestedTarget(targets, environment, branch) {
  const other = environment === 'staging' ? 'production' : 'staging';
  const named = (target, name) => target.name.toLowerCase().includes(name);
  return (
    targets.find((target) => target.branch === branch && named(target, environment)) ??
    targets.find((target) => target.branch === branch && !named(target, other)) ??
    targets.find((target) => named(target, environment))
  );
}

/**
 * The deploy steps, tasks and next steps of the providers (cli/providers/deploy, by id) a stack offers. siteTasks(provider,
 * api, site, environment, answers) adds the stack's own tasks for each chosen site (a Laravel app's Nightwatch token).
 */
export function deploySites(providers, { siteTasks = () => [] } = {}) {
  const withToken = (a) => deploys(a) && Boolean(providers[a.deploy]) && Boolean(a.deployToken?.trim());

  /** The API token of the deploy target, then the sites (or environments) it finds for the repository. */
  const deployTokenStep = {
    id: 'deployToken',
    when: (a) => deploys(a) && Boolean(providers[a.deploy]),
    ask: async ({ header, answers }) => {
      const provider = providers[answers.deploy];
      return orExit(
        await clack.password({
          message: question(
            header,
            `${provider.name} API token${dim(`  optional: ${provider.tokenHint}`)}`,
            'Empty: setup lists what to do by hand at the end',
          ),
        }),
      );
    },
    then: async (answers, ctx) => {
      ctx.deployTargets = [];
      if (!withToken(answers)) return;
      const provider = providers[answers.deploy];
      const spinner = clack.spinner();
      spinner.start(`Looking for the ${provider.name} ${provider.kind}s of ${answers.repository}`);
      try {
        ctx.deployTargets = await provider.find(provider.api(answers.deployToken.trim()), answers.repository);
      } catch (error) {
        // Setup goes on: what the token would do is left to do by hand, with the reason (nextSteps)
        spinner.error(error.message);
        answers.deployToken = '';
        answers.deployProblem = error.message;
        return;
      }
      if (ctx.deployTargets.length) {
        spinner.stop(`Found ${ctx.deployTargets.length} ${provider.name} ${provider.kind}(s) of ${answers.repository}`);
      } else {
        answers.deployProblem = `no ${provider.name} ${provider.kind} deploys ${answers.repository}`;
        spinner.error(`${answers.deployProblem}: set it up by hand`);
        answers.deployToken = '';
      }
    },
  };

  /** Which site (or environment) of the target an environment deploys to; with Forge, its deploy hook comes along. */
  function deploySiteStep(environment) {
    return {
      id: `${environment}Site`,
      when: (a, ctx) =>
        withToken(a) && answeredEnvironments(a).includes(environment) && Boolean(ctx.deployTargets?.length),
      ask: async ({ header, answers, ctx }) => {
        const provider = providers[answers.deploy];
        const taken = environment === 'staging' ? answers.productionSite : null;
        const targets = ctx.deployTargets.filter((target) => target !== taken);
        const initial = suggestedTarget(targets, environment, branchOf(answers, environment, ctx.state));
        const index = orExit(
          await clack.select({
            message: question(header, `${provider.name} ${provider.kind} of ${environment}`),
            initialValue: initial ? targets.indexOf(initial) : -1,
            options: [
              ...targets.map((target, i) => ({
                value: i,
                label: provider.targetLabel(target),
                hint: target.branch ? `branch ${target.branch}` : undefined,
              })),
              { value: -1, label: 'None of these', hint: 'setup lists what to do by hand at the end' },
            ],
          }),
        );
        return index === -1 ? null : targets[index];
      },
      then: async (answers) => {
        const provider = providers[answers.deploy];
        const site = answers[`${environment}Site`];
        if (!site || !provider.hook) return;
        try {
          answers.deployHooks = {
            ...answers.deployHooks,
            [environment]: await provider.hook(provider.api(answers.deployToken.trim()), site),
          };
        } catch (error) {
          // The hook question asks for it instead
          clack.log.warn(`Could not read the deploy hook of ${site.name}: ${error.message}`);
        }
      },
    };
  }

  /** The changes in the deploy target the chosen sites (or environments) need. */
  function tasks(answers, { state }) {
    if (!withToken(answers)) return [];
    const provider = providers[answers.deploy];
    const api = provider.api(answers.deployToken.trim());
    return answeredEnvironments(answers)
      .filter((environment) => answers[`${environment}Site`])
      .flatMap((environment) => {
        const site = answers[`${environment}Site`];
        return [
          provider.task(api, site, environment, cloudBranch(answers, environment, state)),
          ...siteTasks(provider, api, site, environment, answers),
        ];
      });
  }

  /** What the deploy target needs by hand, so it deploys only what the workflows ask for: what setup did not do. */
  function nextSteps(answers, { twoBranches, results = [] }) {
    if (!providers[answers.deploy]) return [];
    const resultOf = (environment) => results.find((result) => result.id === `deploySite:${environment}`);
    const left = answeredEnvironments(answers).filter((environment) => !resultOf(environment)?.ok);
    if (!left.length) return [];
    // Why the API did not do it: the token or the search failed, or the task of that environment did
    const problems = [
      answers.deployProblem,
      ...left
        .filter((environment) => resultOf(environment))
        .map((environment) => `${environment}: ${resultOf(environment).detail}`),
    ].filter(Boolean);
    const why = problems.length ? [dim(`  Setup could not do it through the API (${problems.join('; ')}).`)] : [];
    // Staging first, each with the branch it deploys; only read with two branches
    const branchesOf = (phrase) =>
      ['staging', 'production']
        .filter((environment) => left.includes(environment))
        .map((environment) =>
          phrase(environment, bold(environment === 'staging' ? answers.developmentBranch : answers.productionBranch)),
        );
    const which = (kind) =>
      left.length === 2 ? `both ${kind}s` : answers.staging ? `the ${left[0]} ${kind}` : `the ${kind}`;
    return providers[answers.deploy]?.manualSteps({ which, branchesOf, twoBranches, left, why }) ?? [];
  }

  return {
    steps: () => [deployTokenStep, deploySiteStep('production'), deploySiteStep('staging')],
    tasks,
    nextSteps,
  };
}
