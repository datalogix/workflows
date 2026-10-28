# Adding a Laravel app

Run these steps for each Laravel app, in order, after the [organization setup](../organization-setup.md). Each step explains what it is for and how to check it worked. Without the setup command, follow [Manual setup](app-manual-setup.md) instead of step 1.

The setup command does almost everything. It needs [Node.js](https://nodejs.org) 22.12 or newer and the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`); for production errors, also `npx wrangler login` (not on Windows, where the relay step is done by hand).

## Step 1: Run setup

From the project folder:

```bash
npx --allow-git=root github:datalogix/workflows#v2 setup
```

It first says what the folder looks like (a Laravel app has an `artisan` file) and asks you to confirm it; `--kind app` and `--stack laravel` answer it, and `--yes` takes what it detected. When `.github/workflows/datalogix.yml` already calls the package workflow, setup refuses to set the folder up as an app: remove the file first.

Then it asks one question at a time, with a progress bar showing how many are left. Answers come prefilled from what the project already has, so running it again only changes what you change:

| Question | Asked when |
| --- | --- |
| GitHub repository | always (prefilled from the git remote) |
| Where the app is deployed: Forge, Laravel Cloud or not by the workflows | always |
| Production domain, whether there is a staging environment, staging domain, health check path | the app is deployed |
| Whether production deploys from its own branch, and the development and production branch names (`develop` and `main` by default) | there is a staging environment (turning staging off, or choosing not to deploy, removes `production-branch`; setup warns first) |
| Production and staging deploy hooks (hidden input; keep or replace when already set) | the app is deployed |
| Whether to mark deploys in Nightwatch, and each environment's Nightwatch token | Forge |
| Client ID and private key file (`.pem`) of the [release GitHub App](../organization-setup.md#6-create-the-release-github-app); an empty Client ID leaves them for later | production deploys from its own branch and the repository cannot read the App's secrets |
| Claude token (hidden input) | the repository cannot read one (GitHub Free, see [Organization setup, step 2](../organization-setup.md#2-generate-the-claude-token)) |
| Whether Nightwatch problems become issues, from staging too (with a staging environment), performance problems too | always |
| Nightwatch signing secret, after showing the webhook URL to set in Nightwatch (empty keeps the secret already registered, or leaves it for later; when setup cannot read the relay it says so, and empty changes nothing) | problems become issues and the relay is configured (not on Windows) |
| Whether `/up` should check the database (edits `AppServiceProvider`) | the app is deployed, setup can read `bootstrap/app.php` and `/up` does not check it yet |
| Language of what is written for the team (`pt-BR` by default; written to the workflow file only when it is another) | always |
| Whether you work alone on the project | always |
| Who must approve changes to `.github/` (your `gh` login by default; users or `@org/team`) | always |

After a summary and your confirmation, it applies the changes with a progress bar:

- with a production branch, creates the missing branches (the production branch from the former production branch when it is renamed, else from the current default branch; the development branch from the current default branch, where the latest work is) and makes the development branch the default branch;
- when a project that deploys leaves the two branches, makes the former production branch the default branch again;
- writes `.github/workflows/datalogix.yml` from the template, with the repository's default branch (and the production branch) in the `push` trigger, keeping the inputs you added by hand under `with:` (without their comments, and comments after the values setup writes are lost); anything else you changed in the file is replaced (setup warns first);
- writes the `/.github/` line of `.github/CODEOWNERS`, keeping its other lines;
- creates the labels `claude`, `claude-plan`, `no-review` and `rollback`, plus `env:production` and `env:staging` for the environments it deploys, in the project's language, and translates the descriptions still left with the default text of the other language (descriptions written by hand are kept);
- creates the `production` environment (and `staging`, when used) with the `DEPLOY_HOOK` secret and the `HEALTH_URL` variable, plus `NIGHTWATCH_TOKEN` on Forge when deploys are marked in Nightwatch;
- stores the Claude token, and the release GitHub App's secrets, when the repository needs its own;
- with a production branch and without the App, turns on the repository's **Allow GitHub Actions to create and approve pull requests** ([Production branch](../deploy.md#production-branch));
- with a production branch and the App's secrets, adds the production branch to the existing `datalogix` ruleset ([step 5](#step-5-protect-the-default-branch)); without them it stays unprotected;
- registers the repository's Nightwatch secret in the relay;
- adds the database check to `/up`.

Secrets never appear on screen, in a command line or in a file: they go straight to GitHub (encrypted by `gh`) or to Cloudflare.

Each question can also be answered with an option, which skips it (`--deploy forge --domain app.example.com --no-staging --solo`); see `npx --allow-git=root github:datalogix/workflows#v2 --help`. Unknown options and invalid values stop the command before anything changes. Run from another repository's folder, setup and protect ask before going on.

## Step 2: Do what setup cannot

Setup ends with this list, adjusted to your answers:

1. **Commit and push** the workflow file and `.github/CODEOWNERS` (and `AppServiceProvider.php`, if it added the database check). When setup created a branch or changed the default branch, open a pull request to the development branch instead (setup prints the command), then work on the development branch: the file reaches the production branch through the release pull request, and pushing it there directly would deploy production. When the default branch is already protected (setup run again after `protect`), open a pull request to it: the ruleset rejects a push (setup prints that command too).
   When a project leaves the two branches, merge what is only on the former development branch into the production branch through a pull request (setup prints the command), since pushes to it no longer deploy; when the former production branch no longer exists, setup says the default branch now deploys production.
2. **Forge**, on each site: in **Settings > Deployments**, turn off **Push to deploy**. In the deploy script, make Forge deploy the exact commit the workflow asks for. On zero-downtime sites, add right after `cd $FORGE_RELEASE_DIRECTORY`:

   ```bash
   if [ -n "$FORGE_VAR_COMMIT" ]; then
       git fetch --quiet origin "$FORGE_VAR_COMMIT"
       git checkout --quiet --detach "$FORGE_VAR_COMMIT"
   fi
   ```

   On standard sites, replace `git pull origin $FORGE_SITE_BRANCH` with:

   ```bash
   git fetch --quiet origin
   git checkout --quiet --force --detach "${FORGE_VAR_COMMIT:-origin/$FORGE_SITE_BRANCH}"
   ```

3. **Laravel Cloud**, on each environment: in **Settings > Deployments**, turn off **Push to deploy**; make sure staging tracks the default branch.
4. **Nightwatch**: if you did not have the signing secret during setup, set the webhook to the URL setup showed (`https://<worker>/nightwatch/OWNER/REPO`) and run setup again. Name the Nightwatch environments `production` and `staging`, like the GitHub environments (also needed for the deploy markers).
5. **Release GitHub App** (optional): with a production branch and without the App's secrets, release pull requests run no checks and the production branch stays unprotected; store them as organization secrets ([Organization setup, step 6](../organization-setup.md#6-create-the-release-github-app)) or run setup again.
6. **Monitoring relay**: if setup says it is not configured, finish [Organization setup, step 4](../organization-setup.md#4-deploy-the-monitoring-relay-only-for-production-errors) first. On Windows, setup cannot store the signing secret: store it by hand as in [Manual setup](app-manual-setup.md#relay).
7. **Health check**: if setup could not read `bootstrap/app.php`, make the health path answer `200` only when the app works ([Manual setup](app-manual-setup.md#health-check)).

**Why:** with push to deploy on, every push would deploy before the tests and staging ran. Forge's hook always deploys the branch head; the snippet makes it deploy the commit in `FORGE_VAR_COMMIT`, which is what lets a rollback deploy the previous commit. Forge, Cloud and Nightwatch have no API for these settings that setup could use.

**Check:** `curl -I https://<domain>/up` answers `200`. If staging is protected by HTTP basic auth or an IP allow list, exclude `/up`, or every deploy will be rolled back.

## Step 3: Open a test pull request

Open any small pull request (a README change is enough).

**Check:** within a few minutes the pull request has:

- the checks `pipeline / tests / tests`, `pipeline / security / security` and `pipeline / gate / gate` (only those of the layers that are on);
- a `risk:low`, `risk:medium` or `risk:high` label;
- a security review comment and, unless it only touched skipped files, a code review comment.

## Step 4: Merge and watch the first deploy

Merge the test pull request.

**Check:** the `datalogix` run on the default branch runs the tests, then **staging** (deploy, wait, 10 minutes of health checks), then **production**. With a production branch, that run deploys only staging and opens the release pull request: merge it to see the production deploy. Each successful deploy is recorded in the [release history](../deploy.md#release-history); the `rollback` label needs a recorded release before the live one.

## Step 5: Protect the default branch

```bash
npx --allow-git=root github:datalogix/workflows#v2 protect
```

It checks that the latest pull request ran the checks of the layers that are on (`tests`, `security-review`, `risk-gate`), then creates (or updates) a ruleset named `datalogix` for the default branch, and the production branch when the project has one and the [release GitHub App](../organization-setup.md#6-create-the-release-github-app). Private repositories on GitHub Free cannot be protected: `protect` says so and changes nothing (see [Branch ruleset](../verification-layers.md#branch-ruleset)).

**Why:** without a ruleset the checks are only advice. The ruleset requires pull requests and, for each layer that is on, its check on an up-to-date branch (with all three layers off it requires no checks), and blocks force pushes and branch deletion. Run `protect` again after turning a layer on or off. It requires no fixed number of approvals because the risk gate decides how many each pull request needs. Repository admins can still merge a pull request whose checks fail, for confirmed false positives and emergencies. In team projects (without `count-author: true`), changes to `.github/` also need the approval of its code owners, given after the last push: the workflow file sets the checks, so otherwise a pull request could lower its own. An update keeps what was added to the ruleset by hand: other rules (signed commits, say), required checks not named `pipeline / …`, bypass actors and branches. More in [Branch ruleset](../verification-layers.md#branch-ruleset).

A required check that never reports would leave every pull request waiting, which is why this step comes after the first pull request.

## Step 6: Add project context (optional)

| File | When to add it |
| --- | --- |
| `CLAUDE.md` | Always worth it: the project's domain, stack details and what not to touch. Claude reads it in every workflow, and your local Claude Code reads it too. |
| `.php-version` | The project cannot run on the latest PHP release (e.g. `8.3`). |
| `.github/security-review.md` | The security review blocked a pull request for something that is not a problem in this project. See [Project rules for the security review](../verification-layers.md#project-rules-for-the-security-review). |
| `.github/ISSUE_TEMPLATE/` | The project needs issue forms different from the organization's. |


## Checking the app

```bash
npx --allow-git=root github:datalogix/workflows#v2 check
```

Lists what is set up and what is missing or different, without changing anything: the workflow file, labels, Claude token, environments and their secrets, whether each `HEALTH_URL` answers `200`, the database check, the production branch (exists, is not the default branch, and pushes to it and to the default branch run the workflow, following `push.branches` or `branches-ignore` patterns; a warning when staging is off), who opens the release pull requests (the release GitHub App, or GitHub Actions with the repository's permission, a warning when reading that permission needs admin access), the ruleset and whether it protects the production branch, the code owners of `.github/` and the relay registration. On private repositories on GitHub Free it warns that nothing can be protected. Errors break the workflows; warnings leave a layer weaker. Run it after updating these workflows, or when something does not work. Setup fixes most of what it reports.
