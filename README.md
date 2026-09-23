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

Every workflow is called from a small file in the target repository (see [`examples/`](examples)), so fixes and improvements made here reach every repository at once.

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

1. Sets up PHP with the requested extensions and the coverage driver (`pcov` by default).
2. Restores the Composer cache.
3. Requires the Laravel version under test (`composer require laravel/framework:<version> --no-update`) and runs `composer update --prefer-lowest` or `--prefer-stable`.
4. Runs the tests (`vendor/bin/phpunit` by default).
5. Uploads coverage to Codecov. The package's `phpunit.xml` must produce a Clover report, for example:

   ```xml
   <coverage>
       <report>
           <clover outputFile="clover.xml"/>
       </report>
   </coverage>
   ```

A new push to a pull request cancels the previous run; runs on `main` always finish.

### Customizing the matrix

All matrix inputs are JSON strings. For example, a package that only supports Laravel 12 and 13 on PHP 8.3+:

```yaml
jobs:
  tests:
    uses: datalogix/workflows/.github/workflows/laravel-tests.yml@v1
    secrets: inherit
    with:
      php: '["8.3", "8.4", "8.5"]'
      laravel: '["^12.0", "^13.0"]'
      exclude: "[]"
```

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

Claude follows the rules in the `laravel` plugin ([`plugins/laravel`](plugins/laravel)), loaded by every Claude workflow:

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

| Input             | Default                                                                | Description                 |
| ----------------- | ---------------------------------------------------------------------- | --------------------------- |
| `php`             | `["8.2", "8.3", "8.4", "8.5"]`                                         | PHP versions (JSON)         |
| `laravel`         | `["^11.0", "^12.0", "^13.0"]`                                          | Laravel versions (JSON)     |
| `stability`       | `["prefer-lowest", "prefer-stable"]`                                   | Composer stability (JSON)   |
| `exclude`         | Laravel 13 on PHP 8.2; `prefer-lowest` on PHP 8.4 and 8.5              | Matrix exclusions (JSON)    |
| `os`              | `["ubuntu-latest"]`                                                    | Runners (JSON)              |
| `extensions`      | `dom, curl, libxml, mbstring, zip, pcntl, pdo, sqlite, pdo_sqlite, gd` | PHP extensions              |
| `test-command`    | `vendor/bin/phpunit`                                                   | Test command                |
| `coverage`        | `true`                                                                 | Collect and upload coverage |
| `coverage-driver` | `pcov`                                                                 | `pcov` or `xdebug`          |
| `timeout-minutes` | `30`                                                                   | Timeout per matrix job      |

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

| Input             | Default                                | Description                                    |
| ----------------- | -------------------------------------- | ---------------------------------------------- |
| `model`           | `opus`                                 | Review model                                   |
| `skip-label`      | `no-review`                            | Pull requests with this label are not reviewed |
| `ignored-authors` | `["dependabot[bot]", "renovate[bot]"]` | Authors that are not reviewed (JSON)           |
| `allowed-bots`    | `*`                                    | Bots whose pull requests are reviewed          |
| `timeout-minutes` | `30`                                   | Job timeout                                    |

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

| Problem                                   | Check                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude does not react to `@claude`        | The author is an owner, member or collaborator; the Claude GitHub App is installed; `CLAUDE_CODE_OAUTH_TOKEN` is available to the repository |
| `claude-fix-ci` never runs                | The tests workflow is named `tests`; the pull request branch starts with `claude/`                                                           |
| Wrong PHP version                         | Add a `.php-version` file or pass `php-version`                                                                                              |
| Views fail with "Vite manifest not found" | Check the warning of the _Build frontend assets_ step in `setup-laravel`                                                                     |

---
