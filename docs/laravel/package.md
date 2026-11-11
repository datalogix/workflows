# Adding a Laravel package

Packages call `package`, their single entry point, like `project` for apps. Today it runs `laravel-package-tests`: the test suite across a matrix of PHP versions, Laravel versions and dependency stability (`prefer-lowest` / `prefer-stable`), with coverage uploaded to Codecov. New layers are added to `package`, so packages get them without changing their workflow file.

## Setup

After the [organization setup](../organization-setup.md), from the package folder:

```bash
npx --allow-git=root github:datalogix/workflows#v2 setup
```

It detects a Laravel package (no `artisan`, and a `composer.json` that requires `laravel/framework`, `illuminate/*` or `orchestra/testbench` or has `extra.laravel`) and asks you to confirm (`--kind package` answers it; `--yes` takes what it detected; a `composer.json` without Laravel is a [PHP package](../php/package.md)). When `.github/workflows/datalogix.yml` already calls the app workflow, setup refuses to set the folder up as a package: remove the file first. Then it asks for the lint checks and the test suite (as for an app, starting from what `composer.json` requires: see [Lint and test suite](app-tests.md#lint-and-test-suite); the suggested test command is `vendor/bin/pest` or `vendor/bin/phpunit` when `composer test` also lints), the Codecov token (only when the package uploads coverage, so not with `tests: false`, `coverage: false` or the test suite off, and cannot read a `CODECOV_TOKEN` secret; empty skips coverage uploads), whether you work alone on the package and, with a team, who must approve changes to `.github/`, and:

- writes `.github/workflows/datalogix.yml` from [`examples/package.yml`](../../examples/package.yml), with the default branch in the `push` trigger, the lint and test inputs of the answers and the other `with:` inputs of the existing file kept;
- with a team (or with `--code-owners`), writes the `/.github/` line of `.github/CODEOWNERS`;
- stores the Codecov token.

It ends with the commit to make and, without a ruleset, the `protect` command to run after the first pull request (or to run again when the ruleset no longer matches what check expects, such as the solo answer).

### By hand

1. Add the `CODECOV_TOKEN` secret if you want coverage reports. Packages are public, so an organization secret works even on GitHub Free.
2. Copy [`examples/package.yml`](../../examples/package.yml) to `.github/workflows/datalogix.yml`:

   ```yaml
   name: datalogix

   # The only workflow file a package needs, as .github/workflows/datalogix.yml. Every event below is handled by
   # datalogix/workflows; jobs that do not apply to an event are skipped.
   on:
     push:
       branches: [main]
     pull_request:
     # Required when the repository uses a merge queue
     merge_group:
     workflow_dispatch:

   permissions:
     contents: read

   jobs:
     pipeline:
       uses: datalogix/workflows/.github/workflows/package.yml@v2
       # Only CODECOV_TOKEN is used, for coverage reports
       secrets: inherit
       # All inputs are optional:
       # with:
       #   laravel: '["^11.0", "^12.0", "^13.0"]'
       #   php: '["8.3", "8.4", "8.5"]'
       #   pint: false
       #   min-coverage: 90   # 100 by default; 0 turns the coverage check off
   ```

3. After the first pull request shows its checks, protect the default branch from the package folder:

   ```bash
   npx --allow-git=root github:datalogix/workflows#v2 protect
   ```

   It stops when the workflow file is missing or does not call `package.yml` at `v2` or one of its tags (`v2.1.0`), even with `--yes` (a v1 file calls `laravel-tests.yml@v1`: run setup first). A file that calls a branch or a commit (to test a change) gets a warning, and `protect` asks before going on (`--yes` goes on). It requires pull requests and the `pipeline / tests / all-checks` check, and asks whether you work alone on the package (`--solo` / `--no-solo` answers it): with a team, changes to `.github/` also need the approval of its code owners (`.github/CODEOWNERS`).

To see what is missing, run `npx --allow-git=root github:datalogix/workflows#v2 check` from the package folder. In a package (its workflow file calls `package.yml`, or the folder looks like a Laravel package) it checks only the workflow file, the ruleset (as for an app: see [Checking the app](app.md#checking-the-app)), the Codecov token (unless `tests: false` or `coverage: false`) and the code owners of `.github/`.

## Claude and the risk gate (optional)

Packages can turn on three Claude layers and the risk gate, all off by default (`package` inputs, see [`package`](../reference.md#package)):

- `claude: true`: Claude answers `@claude` on issues and pull requests, implements issues labeled `claude` and plans those labeled `claude-plan` (as in an app: see [Daily use](../daily-use.md#working-with-claude)), and fixes the tests of its own pull requests (`claude/` branches), like Fix CI in an app. It gets one PHP or Node version, not the matrix, so a failure only on the lowest dependencies or an older version is harder for it to reproduce.
- `review: true`: Claude reviews each pull request once (opened, reopened or ready for review); the `no-review` label skips it.
- `security-review: true`: Claude reviews the security of every push, and a finding of `security-fail-on` (`high` by default) or higher fails the required check `pipeline / security / security`.
- `risk-gate: true`: labels each pull request `risk:low`, `risk:medium` or `risk:high` and requires `approvals-medium` and `approvals-high` human approvals (1 each by default) of its current changes, with the required check `pipeline / gate / gate`. It uses no Claude. High risk is what changes for the apps that install the next version: `composer.json` and `package.json`, service providers, `config/*`, `database/migrations/*` and `routes/*` (what the package registers or publishes in the app), `bin/*` and `.github/*`; tests and docs are low risk, the rest medium (see [`risk-gate`](../reference.md#risk-gate)). A solo maintainer cannot approve their own pull requests: setup writes `count-author: true`, so their own count as one approval.

Claude, in the code review, `@claude` and Fix CI, is told that the package's public API (public classes, methods, functions, config keys and exports) is used by apps it cannot see: it reports, or avoids, changes that break it unless a major version is asked for. No path of the risk gate sees such a change; to fail the tests on it, turn on [`api-check`](package-tests.md#public-api).

Setup asks which layers to turn on (`--layers claude,review,security-review,risk-gate`, or `none`) and, with a Claude layer, the team language, the Claude token when the repository cannot read the organization's, and creates the labels they use. `check` then reports the labels, the token and the Claude GitHub App, and an error when a layer is on but the workflow file lacks its events or permissions; `protect` requires `pipeline / security / security` and `pipeline / gate / gate` when their layers are on.

Things to know before turning them on in a public package:

- **Forks.** Most outside pull requests come from forks, which get no secrets: the code review and the security review skip them, and the security check passes without a review. Read those pull requests with security in mind before merging.
- **Issues from anyone.** Anybody can open an issue in a public repository. Adding `claude` or `claude-plan`, or mentioning `@claude`, runs Claude with write access on that text: read the issue first (only users with write access can trigger Claude).
- **Usage.** Each layer uses the Claude token's usage limits, shared by every project; `model` (`opus` by default) and `fix-ci-model` (`sonnet`) change the models.
- **Older workflow files.** A workflow file written before these layers grants only `contents: read` and has none of their events. Run setup again (it rewrites the file from [`examples/package.yml`](../../examples/package.yml)) rather than adding the inputs by hand.

Private Composer packages are not supported: the workflow passes no Composer credentials (`COMPOSER_AUTH`).

What the tests run and how to change the matrix: [Laravel package tests](package-tests.md).
