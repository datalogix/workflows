# Reference

All inputs are optional unless marked required. Pass them with `with:` in the calling workflow.

## `project`

The workflow projects call ([`examples/project.yml`](../examples/project.yml)). Each job below calls one of the other workflows. They can also be called on their own with the inputs listed in their sections, but only `project` (and `package`, for packages) is documented and set up by the setup command: the required checks of the branch ruleset assume its job names.

| Input                                                             | Default                        | Description                                                              |
| ----------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| `stack`                                                           | `laravel`                      | Stack of the project, which picks its tests, the environment prepared for Claude and the Claude plugin (`laravel@datalogix`); only `laravel` is supported (another one fails the run) |
| `tests` / `review` / `security-review` / `risk-gate` / `fix-ci`   | `true`                         | Turn each layer on or off; `tests`, `security-review` and `risk-gate` have required checks, so run `protect` again after changing them |
| `php-version` / `node-version`                                    | detected                       | Override the environment versions                                        |
| `pint` / `phpstan`                                                | `true`                         | Run Pint (on the files changed by the pull request) and PHPStan when they are installed; see [Lint and test suite](laravel/app-tests.md#lint-and-test-suite) |
| `lint-command`                                                    | empty                          | Extra lint command run after Pint and PHPStan, e.g. `composer lint:check` |
| `test-command`                                                    | detected                       | Test command, `none` skips the test suite; see [Test scripts](laravel/app-tests.md#test-scripts) |
| `js`                                                              | `true`                         | Run the `typecheck`, `lint` and `test` scripts of `package.json`         |
| `model` / `plan-model` / `fix-ci-model`                           | `opus` / `best` / `sonnet`     | Models for replies, implementation, reviews and incident analysis / plans / CI fixes |
| `extra-instructions`                                              | empty                          | Extra instructions given to every Claude workflow (no double quotes); prefer `CLAUDE.md` |
| `language`                                                        | `pt-BR`                        | Language of what is written for the team (issues, pull requests, comments, commits; no double quotes): Claude writes in any language; the fixed texts of issues, comments, pull requests and labels exist in `pt-BR` and `en` (any value starting with `en`), other languages get `pt-BR` |
| `security-fail-on`                                                | `high`                         | Lowest security finding severity that fails the check                    |
| `approvals-medium` / `approvals-high`                             | `1` / `1`                      | Human approvals for medium and high risk pull requests                   |
| `count-author`                                                    | `false`                        | Count a human author with write access as one approval (solo maintainers) |
| `extra-high-risk-paths`                                           | empty                          | More patterns (one per line) that make a pull request high risk, added to the risk gate's defaults (e.g. `app/Services/Payment/*`) |
| `deploy`                                                          | `none`                         | Deploy the default branch with `forge` or `cloud` (with `production-branch`, the production branch goes to production) |
| `staging`                                                         | `true`                         | Deploy and watch `staging` before `production`                           |
| `production`                                                      | `auto`                         | `auto` after staging (with `production-branch`, on each push to the production branch), or `manual` (only on Run workflow) |
| `production-branch`                                               | empty                          | Branch deployed to production (e.g. `main`); the default branch then deploys only staging. List both branches in `push.branches` (e.g. `[develop, main]`; setup does). See [Production branch](deploy.md#production-branch) |
| `watch-minutes`                                                   | `5`                            | Minutes each environment is watched after a deploy                       |
| `staging-watch-minutes`                                           | `0`                            | Minutes staging is watched, so production follows sooner (e.g. `3`); `0` uses `watch-minutes` |
| `github-deployments`                                              | `true`                         | Record each deploy and rollback in the repository's **Deployments**; `false` still uses the environments' secrets, variables and required reviewers |
| `incidents`                                                       | `true`                         | Turn monitoring problems into GitHub issues analyzed by Claude           |
| `incident-environments`                                           | `["production", "staging"]`    | Monitoring environments whose problems become GitHub issues (JSON)       |
| `incident-types`                                                  | `["exception", "performance"]` | Problem types that become GitHub issues (JSON)                           |

| Event                                                    | Jobs                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `issues`, `issue_comment`, `pull_request_review_comment` | `claude`; `rollback` when the `rollback` label is added to an issue with `env:staging` or `env:production` |
| `pull_request_review`                                    | `claude`, `gate`                                                         |
| `pull_request`                                           | `tests`, `review`, `security`, `gate`, and `fix-ci` when the tests fail  |
| `merge_group`                                            | `tests`, `security`, `gate`                                              |
| `push` to the default branch, `workflow_dispatch`        | `tests`, then `staging` and `production` when `deploy` is set (`production` on push only with `production: auto`); with `production-branch`, `staging` and, on push, `release` |
| `push` to the `production-branch`, `workflow_dispatch` on it | `tests`, then `production` (on push only with `production: auto`); on push, `release` |
| `schedule`                                               | `tests` (weekly, with `composer audit` and the Node audit)              |
| `repository_dispatch` (`incident`)                       | `incident`                                                               |

`fix-ci` runs in the same workflow run as the tests, right after them, so the project needs no `workflow_run` trigger.

Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (required); `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY` (optional, with `production-branch`). With `deploy`, per environment: the `DEPLOY_HOOK` secret, the `HEALTH_URL` variable and the optional `NIGHTWATCH_TOKEN` secret (see [`deploy`](#deploy)).


## `package`

The workflow packages call ([`examples/package.yml`](../examples/package.yml), see [Packages](laravel/package.md)). Its `tests` job calls [`laravel-package-tests`](laravel/package-tests.md#inputs) with the same inputs and defaults, plus:

| Input   | Default | Description                                                                                |
| ------- | ------- | ------------------------------------------------------------------------------------------ |
| `stack` | `laravel` | Stack of the package, which picks its tests; only `laravel` is supported (another one fails the run) |
| `tests` | `true`  | Run the test suite; it has the required check `pipeline / tests / all-checks`, so run `protect` again after changing it |

Secrets: `CODECOV_TOKEN` (optional, passed with `secrets: inherit`).


## `laravel-app-tests`

The tests of a Laravel app: see [Laravel app tests](laravel/app-tests.md#inputs).

## `laravel-package-tests`

The tests of a Laravel package: see [Laravel package tests](laravel/package-tests.md#inputs).

## `claude`

| Input                                     | Default                                                                                          | Description                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `model`                                   | `opus`                                                                                           | Model for replies and implementation                                      |
| `plan-model`                              | `best`                                                                                           | Model for plans                                                           |
| `max-turns` / `timeout-minutes`           | `80` / `90`                                                                                      | Limits for replies and implementation                                     |
| `plan-max-turns` / `plan-timeout-minutes` | `40` / `30`                                                                                      | Limits for plans                                                          |
| `trigger-phrase`                          | `@claude`                                                                                        | Mention that triggers Claude in comments and reviews (not in issue titles or bodies) |
| `label`                                   | `claude`                                                                                         | Label that triggers an implementation                                     |
| `plan-label`                              | `claude-plan`                                                                                    | Label that triggers a plan                                                |
| `assignee`                                | empty                                                                                            | Username that triggers Claude when assigned to an issue                   |
| `branch-name-template`                    | `{{prefix}}{{entityNumber}}-{{description}}-{{timestamp}}`                                       | Branch name for implementations                                           |
| `commit-signing`                          | `false`                                                                                          | Sign commits through the GitHub API (no rebase or complex git operations) |
| `php-version` / `node-version`            | detected                                                                                         | Override the environment versions                                         |
| `extra-instructions`                      | empty                                                                                            | Extra instructions for this project (no double quotes)                    |
| `language`                                | `pt-BR`                                                                                          | Language of what Claude writes for the team (e.g. `pt-BR`, `en`; no double quotes) |
| `allowed-tools`                           | `Read,Write,Edit,MultiEdit,Grep,Glob,Bash(*),mcp__laravel-boost__*`                              | Tools Claude may use                                                      |
| `disallowed-tools`                        | force push, branch deletion, `gh pr merge`, `gh pr review`, `gh release`, `gh repo`, `gh secret` | Tools Claude may never use                                                |
| `plugin-marketplaces` / `plugins`         | empty / `laravel@datalogix`                                                                      | Extra marketplaces, besides this repository's at the workflows' version (always added), and plugins to install |
| `show-full-output`                        | `false`                                                                                          | Print Claude's full output in the logs (may expose secrets)               |

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (required).

## `claude-review`

Reviews a pull request. `project` calls it once, when the pull request is opened, reopened or marked ready for review; later pushes are not reviewed again (comment `@claude` for another review). The security review still runs on every push, unless the pull request changes only documentation or its changes are the same as in the last passing review (see [`claude-security-review`](#claude-security-review)). With [`production-branch`](deploy.md#production-branch), `project` skips the release and sync pull requests between the two branches; hotfix pull requests to the production branch are reviewed.

| Input                             | Default                                | Description                                            |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `model`                           | `opus`                                 | Review model                                           |
| `skip-label`                      | `no-review`                            | Pull requests with this label are not reviewed         |
| `ignored-authors`                 | `["dependabot[bot]", "renovate[bot]"]` | Authors that are not reviewed (JSON), unless someone else pushed the commits |
| `allowed-bots`                    | `*`                                    | Bots whose pull requests are reviewed                  |
| `extra-instructions`              | empty                                  | Extra instructions for this project (no double quotes) |
| `language`                        | `pt-BR`                                | Language of what Claude writes for the team (e.g. `pt-BR`, `en`; no double quotes) |
| `plugin-marketplaces` / `plugins` | same as `claude`                       | Extra Claude Code plugins, besides `code-review`       |
| `timeout-minutes`                 | `30`                                   | Job timeout                                            |

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (required).

## `claude-security-review`

Runs on every push to a pull request. A pull request whose changes, taken as a whole, are only Markdown files is not reviewed: the comment says so and the check passes. Markdown under `.github/`, `.claude/` or `resources/`, and any `CLAUDE.md` or `AGENTS.md`, counts as code, as does a deleted or renamed file; a push of documentation on top of code is still reviewed. A push that leaves the changes of the pull request as they were (updating the branch with the base, a rebase, an empty commit) keeps the last review when it passed with the same `fail-on`; a base change to a file the pull request also changes, and a manual re-run of the job, review again.

| Input                             | Default                                | Description                                                                         |
| --------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `model`                           | `opus`                                 | Review model                                                                        |
| `fail-on`                         | `high`                                 | Lowest severity that fails the check: `high`, `medium`, `low` or `none`             |
| `ignored-authors`                 | `["dependabot[bot]", "renovate[bot]"]` | Authors that are not reviewed (JSON), unless someone else pushed the commits; dependencies are covered by `composer audit` and the Node audit |
| `allowed-bots`                    | `*`                                    | Bots whose pull requests are reviewed                                               |
| `max-turns` / `timeout-minutes`   | `40` / `30`                            | Limits                                                                              |
| `plugin-marketplaces` / `plugins` | same as `claude`                       | Claude Code plugins to install                                                      |
| `extra-instructions`              | empty                                  | Extra instructions for this project (no double quotes)                              |
| `language`                        | `pt-BR`                                | Language of what Claude writes for the team (e.g. `pt-BR`, `en`; no double quotes); the fixed texts exist in `pt-BR` and `en`, other languages get `pt-BR` |

Claude only reads the code and writes its findings to a file; the workflow publishes them as a single pull request comment, updated on every review, and fails when a finding reaches `fail-on` (a finding with an unknown severity counts as `high`).

A pull request that changes the calling workflow file (`.github/workflows/datalogix.yml`) is not reviewed: `claude-code-action` only runs with the default branch's copy of the file, so the job skips Claude, the comment says why, and the check fails until the default branch has the same file. Move workflow changes to a pull request of their own, reviewed by a person; `claude-review` skips such pull requests too, with only a warning in its job.

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (required).

## `risk-gate`

| Input                                                   | Default                                                                                                                                    | Description                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `high-risk-paths`                                       | migrations, policies, middleware, `bootstrap/app.php`, auth-related config, `routes/api.php`, `composer.json`, `package.json`, `.github/*` | Patterns (one per line) that make a pull request high risk                 |
| `extra-high-risk-paths`                                 | empty | More patterns, added to `high-risk-paths`: a project's own sensitive paths without repeating (or dropping) the defaults |
| `low-risk-paths`                                        | tests, Markdown, `docs/*`, `lang/*.json`, editor and git config                                                                                 | A pull request touching only these is low risk; everything else is medium (`lang/*.php` too: it is PHP the app runs) |
| `ignored-paths`                                         | lock files, `public/build/*`                                                                                                               | Make it at least medium risk, but not counted in the changed lines         |
| `high-risk-lines`                                       | `600`                                                                                                                                      | Changed lines (outside ignored and low-risk paths) that make it high risk  |
| `approvals-low` / `approvals-medium` / `approvals-high` | `0` / `1` / `1`                                                                                                                            | Human approvals required of the current changes                            |
| `count-author`                                          | `false`                                                                                                                                    | Count a human author with write access as one approval (solo maintainers)  |
| `label-prefix`                                          | `risk:`                                                                                                                                    | Prefix of the risk labels                                                  |
| `language`                                              | `pt-BR`                                                                                                                                    | Language of the label descriptions: `en` for a value starting with `en`, otherwise `pt-BR` |

Patterns use shell matching where `*` also matches `/`, so `app/Policies/*` covers subdirectories. Only the latest review of each owner, member or collaborator with write access (write, maintain or admin) counts, and only when it approves the current commit or an earlier one with the same changes (the diff against the base with its line positions, plus each file's mode, so merging or rebasing onto a newer base keeps the approval unless the base changed the pull request's files before or next to its changes; binary files are compared by content; when GitHub cannot compare them, over 300 files, a patch too large to list or a repository tree too large to read, only the current commit counts); bot reviews never count. A renamed file is classified by its old path too (moving a migration to `tests/` is high risk), and a pull request with more than 3000 changed files is high risk, because GitHub lists only the first 3000.

## `claude-fix-ci`

| Input                                | Default          | Description                                                           |
| ------------------------------------ | ---------------- | --------------------------------------------------------------------- |
| `model`                              | `sonnet`         | Model for fixes                                                       |
| `max-attempts`                       | `2`              | Automatic fix commits per pull request before asking for human review |
| `branch-prefix`                      | `claude/`        | Only pull requests from these branches are fixed                      |
| `max-turns` / `timeout-minutes`      | `60` / `45`      | Limits per fix                                                        |
| `php-version` / `node-version`       | detected         | Override the environment versions                                     |
| `extra-instructions`                 | empty            | Extra instructions for this project (no double quotes)                |
| `language`                           | `pt-BR`          | Language of what Claude writes for the team (e.g. `pt-BR`, `en`; no double quotes); the fixed texts exist in `pt-BR` and `en`, other languages get `pt-BR` |
| `allowed-tools` / `disallowed-tools` | same as `claude` | Tools Claude may or may never use                                     |
| `plugin-marketplaces` / `plugins`    | same as `claude` | Claude Code plugins to install                                        |

Runs inside `project` after failed tests. Called from a workflow of its own on `workflow_run` instead (of the workflow that runs the tests), it reads the failed run from that event.

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (required).

## `deploy`

Called by `project` once per environment, and for rollbacks. Reads the environment's `DEPLOY_HOOK` secret, `HEALTH_URL` variable and optional `NIGHTWATCH_TOKEN` secret.

| Input             | Default   | Description                                                                                     |
| ----------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `environment`     | required  | GitHub environment to deploy                                                                    |
| `provider`        | required  | `forge` or `cloud`                                                                              |
| `branch`          | empty     | Branch the environment deploys, sent to Forge with the commit; empty uses the default branch    |
| `mode`            | `deploy`  | `deploy` publishes the run's commit; `rollback` returns to the release before the live one      |
| `issue`           | `0`       | Issue that asked for the rollback; gets the result as a comment and loses the `rollback` label  |
| `rollback-label`  | `rollback`| Label removed from that issue after a rollback                                                  |
| `settle-seconds`  | `0`       | Wait after triggering the deploy before watching; `0` uses 120 on Forge and 300 on Laravel Cloud |
| `watch-minutes`   | `5`       | Minutes to watch the health URL                                                                 |
| `max-failures`    | `3`       | Consecutive failed checks (every 30 seconds) that trigger the rollback                          |
| `rollback`        | `true`    | Redeploy the last good release when the checks fail                                             |
| `github-deployments` | `true` | Record the deploy in the repository's **Deployments**; `false` still uses the environment (custom deployment protection rules need the record: with them, `false` fails the job) |
| `timeout-minutes` | `60`      | Job timeout                                                                                     |
| `language`        | `pt-BR`   | Language of the issues and comments: `en` for a value starting with `en`, otherwise `pt-BR`     |

An automatic rollback is watched for 3 minutes; a rollback from the `rollback` label (`project`) for 5.

## `release-pr`

Called by `project` on pushes when `production-branch` and `deploy` are set. On the default branch, opens the release pull request to the production branch, or updates its list of pending commits; on the production branch, opens a pull request back to the default branch when the production branch has changes it lacks (hotfixes). See [Production branch](deploy.md#production-branch).

| Input               | Default  | Description                    |
| ------------------- | -------- | ------------------------------ |
| `production-branch` | required | Branch deployed to production  |
| `language`          | `pt-BR`  | Language of the pull request texts: `en` for a value starting with `en`, otherwise `pt-BR` |

Secrets: `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY` (optional), of the GitHub App in [Organization setup, step 6](organization-setup.md#6-create-the-release-github-app). Without them the pull requests are opened with the workflow token and run no checks; the repository must have **Allow GitHub Actions to create and approve pull requests** on (setup turns it on; see [Production branch](deploy.md#production-branch)).

## `incident`

Called by `project` on `repository_dispatch` events of type `incident`, sent by the [relay](../relay).

| Input                             | Default                        | Description                                                                                   |
| --------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `environments`                    | `["production", "staging"]`    | Monitoring environments handled (JSON)                                                        |
| `types`                           | `["exception", "performance"]` | Problem types handled (JSON)                                                                  |
| `label`                           | `incident`                     | Label of the created issues; each also gets `env:<environment>` (both created automatically)  |
| `model`                           | `opus`                         | Model for the analysis                                                                        |
| `max-turns` / `timeout-minutes`   | `40` / `30`                    | Limits                                                                                        |
| `plugin-marketplaces` / `plugins` | same as `claude`               | Claude Code plugins to install                                                                |
| `extra-instructions`              | empty                          | Extra instructions for this project (no double quotes)                                        |
| `language`                        | `pt-BR`                        | Language of what Claude writes for the team (e.g. `pt-BR`, `en`; no double quotes); the fixed texts exist in `pt-BR` and `en`, other languages get `pt-BR` |

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (required).

## Relay

| Setting            | Where                         | Description                                                                         |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------- |
| `ALLOWED_OWNER`    | Worker variable, set by `org` | GitHub owner whose repositories may be targeted: the organization `org` ran for     |
| `GITHUB_TOKEN`     | Cloudflare secret             | Fine-grained token with Contents: read and write on the project repositories        |
| `SECRETS`          | Cloudflare KV namespace       | One entry per repository: `<provider>:<owner>/<repo>` → webhook secret; also the events delivered in the last two hours (`delivery:…`, with a TTL), not sent again |
| `relay.json`       | `workflows/relay.json` in `<owner>/.github` | Written by `org`: the worker URL (for the webhook URL), the `SECRETS` namespace id (to register and look up each repository's secret) and the owner. Read by setup and check |

Webhook URL: `https://<worker>/<provider>/<owner>/<repo>`. Supported providers: `nightwatch`.
