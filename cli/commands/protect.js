import { SETUP } from '../lib/evaluate.js';
import { mergeRuleset, RULESET_NAME, rulesetBody } from '../lib/ruleset.js';
import { clack, confirmFolder, dim, orExit } from '../lib/ui.js';
import { readLocal, readOrFail } from '../lib/state.js';
import { refStatus, refVersion, unversioned, WORKFLOW_PATH } from '../lib/workflow-file.js';
import { detectStack } from '../stacks/index.js';

/**
 * Creates or updates the ruleset of the default branch, requiring only the checks of the layers the workflow file turns
 * on (checksOn), and first looks for them on the latest pull request. The stack's module may protect another branch
 * (a Laravel app's production branch, with the release GitHub App).
 */
export async function protect(ctx) {
  await confirmFolder(ctx, ctx.repository);
  const github = ctx.createGitHub(ctx.repository);
  const detected = await detectStack(ctx.root);
  const { module } = detected;
  const local = await readLocal(detected, ctx.root);
  const { current } = local;
  // The checks come from the workflow file of this major: without it, or on another one (a package still on v1), they
  // never run, and even --yes would leave every pull request waiting. A branch or a commit (testing a change) may run
  // other checks than the release: protect warns and asks first
  const { status, version } = refStatus(local.workflow, module.ref);
  if (status === 'missing' || status === 'other-major') {
    clack.log.error(
      local.workflow
        ? `${WORKFLOW_PATH} does not call ${module.ref}, so its checks never run`
        : `${WORKFLOW_PATH} is missing, so no check runs`,
    );
    clack.outro(`Run setup first, then protect once its pull request shows the checks: ${SETUP}`);
    return 1;
  }
  if (status === 'other-ref') {
    clack.log.warn(
      [
        `${WORKFLOW_PATH} calls ${unversioned(module.ref)}${version}, not a release of ${refVersion(module.ref)}.`,
        dim('Its checks may differ from the release, and change with it: point it back at the release once tested.'),
      ].join('\n'),
    );
    if (
      !ctx.flags.yes &&
      !orExit(await clack.confirm({ message: 'Protect the default branch with that version?', initialValue: false }))
    ) {
      clack.outro('Nothing was changed');
      return 1;
    }
  }
  const checks = module.requiredChecks(local);

  const rulesets = await github.rulesets();
  if (rulesets === null) {
    clack.log.warn(
      [
        'GitHub offers no rulesets or branch protection for private repositories on the Free plan:',
        'the checks run and show on every pull request, but do not block the merge, and anyone with write access can push.',
        dim('Use GitHub Team (or Pro), or make the repository public, to protect it.'),
      ].join('\n'),
    );
    clack.outro('Nothing was changed');
    return 1;
  }

  const spinner = clack.spinner();
  spinner.start('Looking for the checks on the latest pull request');
  let latest;
  try {
    latest = await github.latestPullRequestChecks();
  } catch (error) {
    // A running spinner keeps the process alive
    spinner.error('Could not read the latest pull request');
    throw error;
  }
  const missing = latest ? checks.filter((check) => !latest.names.includes(check)) : checks;
  spinner.stop(latest ? `Latest pull request: #${latest.number}` : 'No pull request yet');

  if (missing.length) {
    clack.log.warn(
      [
        latest ? `Pull request #${latest.number} did not run:` : 'No pull request has run the checks yet:',
        ...missing.map((check) => `  • ${check}`),
        dim(
          'Open a pull request and wait for its checks first, or every pull request may wait for a check that never comes.',
        ),
      ].join('\n'),
    );
    if (
      !ctx.flags.yes &&
      !orExit(await clack.confirm({ message: 'Protect the default branch anyway?', initialValue: false }))
    ) {
      clack.outro('Nothing was changed');
      return 1;
    }
  }

  const existing = rulesets.find((ruleset) => ruleset.name === RULESET_NAME);
  const ruleset = existing ? await github.ruleset(existing.id) : null;
  const codeOwners = await module.needsCodeOwners(current, ctx.flags, ruleset);
  const productionBranch = module.protectedBranch ? await module.protectedBranch(github, current) : null;
  // In an app's ruleset, the production branch left without the release GitHub App leaves it. Other single branches
  // may have been added by hand or be a former production branch, which the ruleset cannot tell apart: they stay, with
  // a warning. Patterns (release/*) stay
  const deployed = module.deployedBranch?.(current) ?? null;
  const single = (ruleset?.conditions?.ref_name?.include ?? [])
    .filter((ref) => /^refs\/heads\/[^*?[\]+!]+$/.test(ref))
    .map((ref) => ref.slice('refs/heads/'.length));
  const unprotect = deployed && deployed !== productionBranch && single.includes(deployed) ? [deployed] : [];
  const others = module.protectedBranch
    ? single.filter((branch) => branch !== productionBranch && branch !== deployed)
    : [];
  // An exclude of the default branch leaves the ruleset, which needs its name
  const defaultBranch = ruleset
    ? ((await readOrFail(github, 'repository', github.repo()))?.default_branch ?? null)
    : null;
  // Keeps what was added to the ruleset by hand (other rules, checks, bypass actors and patterns of branches)
  const body = ruleset
    ? mergeRuleset(ruleset, rulesetBody(checks, { codeOwners, productionBranch }), { unprotect, defaultBranch })
    : rulesetBody(checks, { codeOwners, productionBranch });
  if (existing) await github.updateRuleset(existing.id, body);
  else await github.createRuleset(body);
  if (others.length) {
    clack.log.warn(
      [
        `The "${RULESET_NAME}" ruleset also protects ${others.join(', ')}, kept as added by hand.`,
        dim('If one was a former production branch, remove it in Settings > Rules > Rulesets.'),
      ].join('\n'),
    );
  }

  clack.log.success(
    `${existing ? 'Updated' : 'Created'} the "${RULESET_NAME}" ruleset: ${checks.length ? 'pull requests and these checks are required' : 'pull requests are required; every layer with a check is off'}`,
  );
  if (checks.length) clack.log.message(checks.map((check) => `  • ${check}`).join('\n'));
  if (codeOwners)
    clack.log.message('Changes to .github/ also need the approval of its code owners (.github/CODEOWNERS)');
  clack.outro(productionBranch ? `Default branch and ${productionBranch} protected` : 'Default branch protected');
  return 0;
}
