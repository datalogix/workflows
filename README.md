# datalogix/workflows

Reusable GitHub Actions workflows, a shared setup action and a Claude Code plugin used across Datalogix repositories.

- [Which workflows to use](#which-workflows-to-use)
- [Packages](#packages)
- [Projects](#projects)
- [Reference](#reference)
- [Maintaining this repository](#maintaining-this-repository)

## Which workflows to use

| Repository type                           | Workflows                                                                          | Example files                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Package** (public Laravel package)      | `laravel-tests`                                                                    | `package-tests.yml`                                                     |
| **Project** (private Laravel application) | `claude`, plus optionally `laravel-app-tests`, `claude-review` and `claude-fix-ci` | `claude.yml`, `app-tests.yml`, `claude-review.yml`, `claude-fix-ci.yml` |

Every workflow is called from a small file in the target repository (see [`examples/`](examples)) pinned to the `v1` tag, so fixes and improvements made here reach every repository as soon as a release is published.

> This repository must stay **public**: public repositories (the packages) can only call reusable workflows stored in public repositories. Private projects can use it either way. No secrets live here; they come from the calling repository.

---

## Packages

Packages use `laravel-tests`, which runs the test suite across a matrix of PHP versions, Laravel versions and dependency stability (`prefer-lowest` / `prefer-stable`), and uploads coverage to Codecov.

### Setup

1. Add the `CODECOV_TOKEN` secret (organization or repository) if you want coverage reports.
2. Copy [`examples/package-tests.yml`](examples/package-tests.yml) to `.github/workflows/tests.yml`.

```yaml
name: tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  tests:
    uses: datalogix/workflows/.github/workflows/laravel-tests.yml@v1
    secrets: inherit
```

### What it does

For each combination of the matrix it:

1. Sets up PHP with the requested extensions.
2. Restores the Composer cache.
3. Requires the Laravel version under test (`composer require laravel/framework:<version> --no-update`) and runs `composer update --prefer-lowest` or `--prefer-stable`.
4. Runs the tests (`vendor/bin/phpunit` by default).

Coverage is collected only on the newest combination (highest PHP and Laravel, `prefer-stable`, first OS), with `pcov` by default, and uploaded to Codecov: the driver slows the tests down, and the other combinations would upload the same report. The other jobs run PHPUnit or Pest with `--no-coverage`, so a coverage report configured in `phpunit.xml` does not fail them with `failOnWarning`. The package's `phpunit.xml` must produce a Clover report, for example:

```xml
<coverage>
    <report>
        <clover outputFile="clover.xml"/>
    </report>
</coverage>
```

On pull requests, a separate job also runs `pint --test` on the files changed by the pull request, once and outside the matrix, when the package requires `laravel/pint` (1.20+). Existing style issues in untouched files do not fail the build. Disable it with `pint: false`.

A new push to a pull request cancels the previous run; runs on `main` always finish.

### Customizing the matrix

All matrix inputs are JSON strings. For example, a package that only supports Laravel 13 on PHP 8.3+:

```yaml
jobs:
  tests:
    uses: datalogix/workflows/.github/workflows/laravel-tests.yml@v1
    secrets: inherit
    with:
      php: '["8.3", "8.4", "8.5"]'
      laravel: '["^13.0"]'
      exclude: "[]"
```

A package that still supports Laravel 11 adds it back with `laravel: '["^11.0", "^12.0", "^13.0"]'`.

See all inputs in [`laravel-tests`](#laravel-tests).

---

## Projects

Projects use Claude to answer questions, plan and implement issues, review pull requests and fix failed CI, plus an optional test workflow.

| Workflow            | Purpose                                                                                      | Needs                                               |
| ------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `claude`            | Replies to `@claude`, implements issues labeled `claude`, plans issues labeled `claude-plan` | —                                                   |
| `laravel-app-tests` | Runs Pint, PHPStan and the test suite                                                        | —                                                   |
| `claude-review`     | Reviews every pull request                                                                   | —                                                   |
| `claude-fix-ci`     | Fixes failed tests on Claude's pull requests                                                 | `laravel-app-tests` (or any workflow named `tests`) |

Use only `claude.yml` for the minimum setup and add the others as needed.

### Setup

1. **Install the [Claude GitHub App](https://github.com/apps/claude)** on the repository, or run `/install-github-app` in Claude Code. The workflows exchange the job's OIDC token for this App's token, so Claude's commits, comments and pull requests appear as `claude[bot]` and trigger other workflows (tests, review, fix-ci) normally.
2. **Add the `CLAUDE_CODE_OAUTH_TOKEN` secret**, generated with `claude setup-token`. Prefer an organization secret shared with the project repositories.
3. **Create the labels** `claude`, `claude-plan` and, if you use the review, `no-review`.
4. **Copy the example files** you need from [`examples/`](examples) to `.github/workflows/`:
   - [`claude.yml`](examples/claude.yml)
   - [`app-tests.yml`](examples/app-tests.yml), saved as `tests.yml`
   - [`claude-review.yml`](examples/claude-review.yml)
   - [`claude-fix-ci.yml`](examples/claude-fix-ci.yml), which reacts to the workflow named `tests`
5. **Pin the PHP version** with a `.php-version` file (for example `8.3`) if the project cannot run on the latest PHP release. See [Environment](#environment).

### Working with Claude

| You do                                                  | Claude does                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comment `@claude <request>` on an issue or pull request | Replies, or commits the change to the pull request branch                                                                                         |
| Open an issue whose title or body mentions `@claude`    | Handles the issue like a comment                                                                                                                  |
| Add the `claude-plan` label to an issue                 | Posts an implementation plan (understanding, affected files, approach, risks, open questions, size) without changing code, then removes the label |
| Add the `claude` label to an issue                      | Creates a `claude/<number>-<title>-<date>` branch, implements the issue and opens a pull request                                                  |
| — (automatic)                                           | Reviews every pull request, except drafts, forks, Dependabot, Renovate and pull requests labeled `no-review`                                      |
| — (automatic)                                           | When tests fail on a `claude/*` branch, reads the log and pushes a fix, up to 2 attempts per pull request, then asks for human review             |

Only repository owners, members and collaborators can trigger Claude with `@claude`. Labels and assignments already require triage access.

A typical flow for a new feature:

1. Open the issue and add `claude-plan`.
2. Read the plan, answer the open questions in the issue and adjust what you need.
3. Add `claude`. Claude implements it and opens a pull request.
4. `tests` and `claude-review` run on the pull request. If tests fail, `claude-fix-ci` tries to fix them.
5. Review the pull request, ask for changes with `@claude` if needed, and merge.

### Conventions

Claude follows the rules in the `laravel` plugin ([`plugins/laravel`](plugins/laravel)), loaded by every Claude workflow, including the review:

- Everything Claude writes for the team (commits, pull requests, comments) is in Brazilian Portuguese; commits use Conventional Commits with English types, e.g. `feat: adiciona autenticação via OAuth`.
- Implements only what is needed and reuses the existing architecture.
- Creates tests only if the project already has real tests beyond Laravel's scaffold.
- Runs Pint and PHPStan only on changed files and only the relevant tests; does not fix pre-existing failures and stops after 2 attempts on the same failure.
- Pull request descriptions contain _Resumo_, _Motivação_, _Plano de Testes_ and _Observações_.

The rules live in [`plugins/laravel/skills/conventions/SKILL.md`](plugins/laravel/skills/conventions/SKILL.md). Changing that file changes Claude's behavior in every project. Project-specific context (domain, stack details, what not to touch) belongs in the project's own `CLAUDE.md`, which Claude reads automatically.

To use the same conventions in your local Claude Code:

```
/plugin marketplace add datalogix/workflows
/plugin install laravel@datalogix
```

### Environment

`claude`, `claude-fix-ci` and `laravel-app-tests` prepare the project with the [`setup-laravel`](.github/actions/setup-laravel/action.yml) action:

| Step          | Details                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHP           | Version from `.php-version`, then `composer.lock` / `composer.json` (`config.platform.php`), otherwise the **latest** release. Extensions are detected from the `ext-*` requirements in `composer.json` and `composer.lock`. |
| Composer      | `composer install` with a cached download directory.                                                                                                                                                                         |
| Node          | Version from `.nvmrc` or `.node-version`, otherwise the current LTS. Installs with pnpm, yarn or npm according to the lockfile (Corepack is installed when the Node version no longer ships it).                             |
| `.env`        | Copied from `.env.example`, forced to SQLite (`database/database.sqlite`), with a generated `APP_KEY`.                                                                                                                       |
| Database      | `php artisan migrate`; a failure only produces a warning (for example, MySQL-specific migrations).                                                                                                                           |
| Frontend      | `build` script from `package.json`, so views using `@vite` render in tests; a failure only produces a warning.                                                                                                               |
| Laravel Boost | When `laravel/boost` is installed, Claude gets its MCP server (documentation search, database queries, Artisan, logs).                                                                                                       |

### Models and usage

| Workflow                              | Default model                                 |
| ------------------------------------- | --------------------------------------------- |
| `claude` (implementation and replies) | `opus`                                        |
| `claude` (plans)                      | `best`: Fable where available, otherwise Opus |
| `claude-review`                       | `opus`                                        |
| `claude-fix-ci`                       | `sonnet`                                      |

Models are aliases, so they follow new releases automatically. Every repository shares the usage limits of the account that owns `CLAUDE_CODE_OAUTH_TOKEN`, including that account's own Claude Code usage. If the limit gets tight, reduce in this order: `model: sonnet` on `claude-review`, then `plan-model: opus` on `claude`.

---

## Reference

All inputs are optional. Pass them with `with:` in the calling workflow.

### `laravel-tests`

| Input             | Default                                                                | Description                                                             |
| ----------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `php`             | `["8.2", "8.3", "8.4", "8.5"]`                                         | PHP versions (JSON)                                                     |
| `laravel`         | `["^12.0", "^13.0"]`                                                   | Laravel versions (JSON)                                                 |
| `stability`       | `["prefer-lowest", "prefer-stable"]`                                   | Composer stability (JSON)                                               |
| `exclude`         | Laravel 13 on PHP 8.2; `prefer-lowest` on PHP 8.4 and 8.5              | Matrix exclusions (JSON)                                                |
| `os`              | `["ubuntu-latest"]`                                                    | Runners (JSON)                                                          |
| `extensions`      | `dom, curl, libxml, mbstring, zip, pcntl, pdo, sqlite, pdo_sqlite, gd` | PHP extensions                                                          |
| `test-command`    | `vendor/bin/phpunit`                                                   | Test command                                                            |
| `coverage`        | `true`                                                                 | Collect and upload coverage on the newest combination of the matrix     |
| `coverage-driver` | `pcov`                                                                 | `pcov` or `xdebug`                                                      |
| `timeout-minutes` | `30`                                                                   | Timeout per job                                                         |
| `pint`            | `true`                                                                 | Run `pint --test` on the files changed by the pull request (Pint 1.20+) |

Secret: `CODECOV_TOKEN` (optional).

### `laravel-app-tests`

| Input             | Default            | Description                                                             |
| ----------------- | ------------------ | ----------------------------------------------------------------------- |
| `php-version`     | detected           | Override the PHP version                                                |
| `node-version`    | detected           | Override the Node version                                               |
| `pint`            | `true`             | Run `pint --test` on the files changed by the pull request (Pint 1.20+) |
| `phpstan`         | `true`             | Run PHPStan when installed                                              |
| `test-command`    | `php artisan test` | Test command                                                            |
| `timeout-minutes` | `30`               | Job timeout                                                             |

### `claude`

| Input                                     | Default                                                                          | Description                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `model`                                   | `opus`                                                                           | Model for replies and implementation                                      |
| `plan-model`                              | `best`                                                                           | Model for plans                                                           |
| `max-turns` / `timeout-minutes`           | `80` / `90`                                                                      | Limits for replies and implementation                                     |
| `plan-max-turns` / `plan-timeout-minutes` | `40` / `30`                                                                      | Limits for plans                                                          |
| `trigger-phrase`                          | `@claude`                                                                        | Mention that triggers Claude                                              |
| `label`                                   | `claude`                                                                         | Label that triggers an implementation                                     |
| `plan-label`                              | `claude-plan`                                                                    | Label that triggers a plan                                                |
| `assignee`                                | empty                                                                            | Username that triggers Claude when assigned to an issue                   |
| `branch-name-template`                    | `{{prefix}}{{entityNumber}}-{{description}}-{{timestamp}}`                       | Branch name for implementations                                           |
| `commit-signing`                          | `false`                                                                          | Sign commits through the GitHub API (no rebase or complex git operations) |
| `php-version` / `node-version`            | detected                                                                         | Override the environment versions                                         |
| `extra-instructions`                      | empty                                                                            | Extra instructions for this project (no double quotes)                    |
| `allowed-tools`                           | `Read,Write,Edit,MultiEdit,Grep,Glob,Bash(*),mcp__laravel-boost__*`              | Tools Claude may use                                                      |
| `disallowed-tools`                        | force push, branch deletion, `gh pr merge`, `gh release`, `gh repo`, `gh secret` | Tools Claude may never use                                                |
| `plugin-marketplaces` / `plugins`         | this repository / `laravel@datalogix`                                            | Claude Code plugins to install                                            |
| `show-full-output`                        | `false`                                                                          | Print Claude's full output in the logs (may expose secrets)               |

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (required).

### `claude-review`

| Input                             | Default                                | Description                                            |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `model`                           | `opus`                                 | Review model                                           |
| `skip-label`                      | `no-review`                            | Pull requests with this label are not reviewed         |
| `ignored-authors`                 | `["dependabot[bot]", "renovate[bot]"]` | Authors that are not reviewed (JSON)                   |
| `allowed-bots`                    | `*`                                    | Bots whose pull requests are reviewed                  |
| `extra-instructions`              | empty                                  | Extra instructions for this project (no double quotes) |
| `plugin-marketplaces` / `plugins` | same as `claude`                       | Extra Claude Code plugins, besides `code-review`       |
| `timeout-minutes`                 | `30`                                   | Job timeout                                            |

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (required).

### `claude-fix-ci`

| Input                                | Default          | Description                                                           |
| ------------------------------------ | ---------------- | --------------------------------------------------------------------- |
| `model`                              | `sonnet`         | Model for fixes                                                       |
| `max-attempts`                       | `2`              | Automatic fix commits per pull request before asking for human review |
| `branch-prefix`                      | `claude/`        | Only pull requests from these branches are fixed                      |
| `max-turns` / `timeout-minutes`      | `60` / `45`      | Limits per fix                                                        |
| `php-version` / `node-version`       | detected         | Override the environment versions                                     |
| `extra-instructions`                 | empty            | Extra instructions for this project (no double quotes)                |
| `allowed-tools` / `disallowed-tools` | same as `claude` | Tools Claude may or may never use                                     |
| `plugin-marketplaces` / `plugins`    | same as `claude` | Claude Code plugins to install                                        |

Secret: `CLAUDE_CODE_OAUTH_TOKEN` (required).

### Troubleshooting

| Problem                                    | Check                                                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude does not react to `@claude`         | The author is an owner, member or collaborator; the Claude GitHub App is installed; `CLAUDE_CODE_OAUTH_TOKEN` is available to the repository |
| `claude-fix-ci` never runs                 | The tests workflow is named `tests`; the pull request branch starts with `claude/`                                                           |
| Wrong PHP version                          | Add a `.php-version` file or pass `php-version`                                                                                              |
| Views fail with "Vite manifest not found"  | Check the warning of the _Build frontend assets_ step in `setup-laravel`                                                                     |
| Pint fails with an unknown `--diff` option | Update `laravel/pint` to 1.20+ or pass `pint: false`                                                                                         |

---

## Maintaining this repository

### Releases

Repositories call the workflows with `@v1`, so changes on `main` reach them only when a release is published:

1. Merge the changes into `main` and make sure `ci` passes.
   - `ci` does not run `laravel-tests` or `laravel-app-tests`. When they change, first point a package or project at the branch (`laravel-tests.yml@<branch>`) and open a test pull request there.
2. Publish a GitHub release tagged `vX.Y.Z` (for example `v1.2.0`). The `release` workflow moves the major tag (`v1`) to it; other tag formats are rejected.

Breaking changes (renamed or removed inputs, new required secrets or permissions) need a new major version. In that case, also update the `setup-laravel@v1` references inside the workflows and the `@v1` in the examples and in this README.

### The Claude plugin is not versioned

The workflows install the `laravel` plugin from this repository's default branch, not from the tag they are called with (the Claude Code action only accepts marketplace URLs without a ref). Changes to [`plugins/laravel`](plugins/laravel) therefore apply to every project immediately, without a release, and must stay compatible with every released version of the workflows. For example, the `[ci-fix]` commit tag required by the `fix-ci` command is what `claude-fix-ci` counts to limit attempts.

### CI

[`ci.yml`](.github/workflows/ci.yml) runs on every pull request and push to `main`:

- **lint**: `actionlint` on the workflows and on the examples (pointed at the local workflows, so their inputs and secrets are checked too), and `claude plugin validate` on the marketplace and the plugin.
- **setup-laravel**: creates a fresh Laravel app and runs the action across PHP, Node and package manager versions, with and without Laravel Boost, then checks the environment, starts the Boost MCP server and runs the app's tests.

### Dependencies

Dependabot updates the actions weekly, in a single grouped pull request. Actions that receive secrets (`anthropics/claude-code-action`, `codecov/codecov-action`) are pinned to a commit SHA with the version in a comment, so a moved tag upstream cannot change what runs with those secrets; Dependabot keeps both up to date. The `actionlint` version in `ci.yml` is not covered and must be bumped manually.
