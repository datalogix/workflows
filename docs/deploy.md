# Deploy

With `deploy: forge` or `deploy: cloud`, `project` deploys the default branch after its tests pass (with a [production branch](#production-branch), the production branch goes to production), through the deploy hooks of [Laravel Forge](https://forge.laravel.com) or [Laravel Cloud](https://cloud.laravel.com):

1. **Staging**: triggers the deploy of the exact commit, waits for the provider to finish (120 seconds on Forge, 300 on Cloud, which builds an image first) and calls the health URL every 30 seconds for 10 minutes.
2. **Production**: the same, only after staging stayed healthy. `watch-minutes` sets both watches; `staging-watch-minutes` shortens the staging one (e.g. `5`), so production follows sooner.
3. **Rollback**: when the health checks fail three times in a row, the environment's last good release is redeployed, watched again, and an issue explains what happened. A failed staging deploy never reaches production; with a [production branch](#production-branch), pushes to that branch deploy production without staging.

Setup is covered in [Adding a Laravel app](laravel/app.md): the setup command creates the environments, and [step 2](laravel/app.md#step-2-do-what-setup-cannot) covers Forge and Cloud.

## Controlling production

- `production: manual` stops automatic production deploys: production is deployed only from **Actions > datalogix > Run workflow**, after staging.
- Environment protection rules apply too. Where your plan offers them, required reviewers or a wait timer on `production` make each production deploy wait for an approval or a delay.
- `staging: false` deploys straight to production (not recommended).
- `github-deployments: false` stops recording each deploy and rollback in the repository's **Deployments** (and the environment link on pull requests and commits); the jobs still use the environments, with their secrets, variables and required reviewers. The [release history](#release-history) does not depend on it, so rollbacks keep working.

## Production branch

With `production-branch: main` (setup asks for it when there is a staging environment), the project has two branches:

- the **default branch** (e.g. `develop`) is the development branch: feature pull requests, Claude's included, target it, and each push deploys **staging** only;
- the **production branch** deploys **production** on each push, after its tests.

Setup lists both branches under `push.branches` in the workflow file; by hand, use e.g. `branches: [develop, main]`, otherwise pushes to the branch left out run nothing.

Each push to the development branch opens the pull request **Release: develop → main**, or updates its list of pending commits: it is the list of what is in staging and not in production yet. Merging it deploys production without going through staging again: merge the release pull request only after staging is healthy. Merge it with **Create a merge commit**, not squash: with squash the branches diverge and released commits show up as pending again. With the release GitHub App (below), the release pull request runs the checks (all but the code review); its risk is usually high, so it waits for a human approval.

**Hotfixes** deploy production directly, without staging: keep them small. Open a pull request from a `hotfix/...` branch to the production branch (it gets the code review like any other). After the merge, a pull request **Sync: main → develop** brings the fix back to the development branch; merge it (also with a merge commit) before the next release, which stays out of date until then.

When nothing is left to release or sync (for example, after the sync pull request is merged), an open release or sync pull request stays open and its body says nothing is pending; the next change updates it again.

Who opens the pull requests decides whether their checks run:

- **With the release GitHub App** of [Organization setup, step 6](organization-setup.md#6-create-the-release-github-app) (secrets `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY`), they run the checks like any other pull request (except the code review), and `protect` protects both branches.
- **Without it**, GitHub Actions opens them with the workflow's own token: setup turns on the repository's **Allow GitHub Actions to create and approve pull requests**, which also lets workflows approve pull requests (bot approvals never count for the risk gate). If the organization does not allow it, setup fails that step: allow it first in the organization settings (**Actions > General**). GitHub runs no workflows for those pull requests, so they show no checks, and `protect` leaves the production branch out: requiring checks there would block every release. Each change was checked in its pull request to the development branch, and the push to the production branch still runs the tests before production deploys.

Private repositories on GitHub Free cannot be protected at all (see [Branch ruleset](verification-layers.md#branch-ruleset)), so there the App only makes the checks show on the release pull request.

On Forge, the staging site deploys the development branch and the production site the production branch, both with **Push to deploy** off: the workflow sends each hook its branch and commit. `production: manual` still works: pushes to the production branch then deploy only from **Run workflow** on that branch.

## Rolling back by hand

Add the `rollback` label to an issue: the issue's environment goes back to the release before the one that is live, is watched like any other deploy, and the result is commented on the issue. Issues opened by a failed deploy (unless the automatic rollback already brought the environment back) or by the monitoring service carry an `env:staging` or `env:production` label; the label does nothing on any other issue, so it never rolls back by accident. To roll back by hand, add `env:production` (or `env:staging`) to an issue along with `rollback`; setup creates the `env:` label of each environment it deploys. The release that was rolled back is never used by later rollbacks; a new merge publishes the fixed code. Only people with write access can roll back.

A rollback redeploys code, not the database, which is why the `laravel` plugin keeps migrations compatible with the previous release.

## Release history

Every deploy that stays healthy is recorded as a ref under `refs/datalogix/deploys/<environment>/` (environment name in lowercase; not a branch or tag, so it does not show up in the branch list), rolled-back releases under `refs/datalogix/rolled-back/<environment>/`, and the commit last deployed (healthy or not) as `refs/datalogix/live/<environment>`, which a rollback starts from. The rollbacks read this history, so it starts with the first deploy made by `project`; the 30 newest entries are kept. GitHub's own deployment list still shows the commit of each workflow run, which after a rollback is not the commit that is live.

## Vercel

`deploy: vercel` deploys through Vercel's API instead of a deploy hook, which on Vercel always builds the branch head: the API builds the exact commit, so rollbacks work as on Forge. Each GitHub environment needs:

- the `VERCEL_TOKEN` secret (an access token with access to the project);
- the `VERCEL_PROJECT` variable (the project's id or name), and `VERCEL_TEAM_ID` for a team's project;
- the `HEALTH_URL` variable, on the domain of that environment;
- optionally `VERCEL_TARGET`: the Vercel target is the GitHub environment's name (`production`, `staging`, or a custom environment with that name) unless it names another.

Turn off Vercel's own deploys of the branches the workflow deploys (`git.deploymentEnabled` in `vercel.json`, or **Settings > Git** in the project), or every push deploys before the tests run. The wait follows the build until it is ready (at most `settle-seconds`, 900 by default), instead of a fixed time. A build that fails leaves the previous deployment live: the job fails without a rollback or an issue, and the live release recorded for the `rollback` label is the one that failed to build until the next deploy. Setup does not ask for Vercel yet: set the secrets and variables by hand (see [manual setup](laravel/app-manual-setup.md)).

## Adding a deploy provider

Each provider is a script and a setup file; the deploy itself (the release history, the health checks, the rollback, the issues) is shared:

- `.github/actions/deploy/providers/<id>.sh` defines `provider_settle_seconds` (prints the seconds a deploy usually takes), `provider_check` (stops with an `::error::` when a secret or variable it needs is missing) and `provider_trigger <sha>` (deploys that exact commit; returns non-zero, with an `::error::`, when the provider did not accept it), and optionally `provider_wait <seconds>` (follows the deploy until it finishes, for at most those seconds, instead of the fixed wait; the trigger runs in another step of the job, so it passes what the wait needs in a file under `$RUNNER_TEMP`, as `vercel.sh` does). Hook providers call `require_deploy_hook` and `post_hook <curl --data-urlencode arguments>`. The deploy input `provider` names the script; any other name stops the deploy. A secret the provider reads also goes in the `env` of `deploy.yml`.
- `cli/providers/deploy/<id>.js` describes it to setup (the fields are listed in `cli/providers/deploy/index.js`); a stack offers it by adding its id to `deployProviders([...])` (a Laravel app: `cli/stacks/laravel/app.js`).
- Tests for both, next to `.github/actions/test/deploy.test.js` and `cli/test/deploy-target.test.js`.

Deploy markers belong to the monitoring service, not the provider: `.github/actions/deploy/monitoring/<id>.sh` defines `mark_<id> <sha> <name>`, which marks the deploy when the environment has its token and only warns when it cannot.

## What the health checks do not see

They catch an app that is down or failing on the health URL, and only during the watch after a deploy. A rise in errors on other pages is handled as a [production error](production-errors.md#production-errors). For outages at any other time, use an uptime monitor (Forge, Laravel Cloud and services like Oh Dear offer one).
