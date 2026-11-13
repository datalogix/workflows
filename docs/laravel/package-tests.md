# Laravel package tests

The `tests` job of [`package`](../reference.md#package) calls `laravel-package-tests`, and its check `pipeline / tests / all-checks` is required by the branch ruleset. Setting the package up: [Adding a Laravel package](package.md).

## What it does

For each combination of the matrix it:

1. Sets up PHP with the requested extensions.
2. Restores the Composer cache.
3. Requires the Laravel version under test (`composer require laravel/framework:<version> --no-update`; skipped with `laravel: '[""]'`, which a [PHP package](../php/package-tests.md) gets) and runs `composer update --prefer-lowest` or `--prefer-stable`.
4. Runs the tests: `composer test` when `composer.json` defines it, otherwise `vendor/bin/pest` when Pest is installed, otherwise `vendor/bin/phpunit` (or `test-command`; `none` skips the matrix). See [Test scripts](app-tests.md#test-scripts).

Coverage is collected only on the newest combination (highest PHP and Laravel, `prefer-stable`, first OS), with `pcov` by default, uploaded to Codecov (`coverage`) and checked against `min-coverage` (100% by default, see [Minimum coverage](../coverage.md)): the driver slows the tests down, and the other combinations would measure the same code. If `exclude` removes that combination, the run warns and coverage is neither reported nor checked. The other jobs run PHPUnit or Pest with `--no-coverage`, so a coverage report configured in `phpunit.xml` does not fail them with `failOnWarning`. With `composer test`, the flag is passed only when the script is a single PHPUnit or Pest command (e.g. `"test": "vendor/bin/pest"`). The package's `phpunit.xml.dist` must produce a Clover report: see the model in [Minimum coverage](../coverage.md#laravel-packages).

A separate `lint` job runs once, outside the matrix, on the highest PHP version of the matrix with `prefer-stable`:

- `pint --test`, when the package requires `laravel/pint` (`pint: false` turns it off): on a pull request only on the files it changes (`--diff`, Pint 1.20+), so existing style issues in untouched files do not block it, and in the merge queue only on the files of the queued group (compared with its base commit), so they do not block the queue either; on pushes, scheduled and manual runs on every file, so the default branch stays clean. With `prettier-plugin-blade` in `package.json` and Pint 1.30+, it also checks Blade views (`--blade`), installing Node and the package's Node dependencies first, as in an [app](app-tests.md#test-scripts);
- PHPStan, when the package requires `phpstan/phpstan` or Larastan (`phpstan: false` turns it off);
- Rector in a dry run (`rector process --dry-run`), when the package requires `rector/rector` and has `rector.php` (`rector: false` turns it off);
- `lint-command`, when set (e.g. `composer lint:check`).

Each one runs even when an earlier one failed, so one run reports every lint failure.

Setup asks for them like for an app, starting from what `composer.json` requires: see [Lint and test suite](app-tests.md#lint-and-test-suite).

A separate `js` job runs, once and without PHP, the scripts of `package.json` an [app](app-tests.md#test-scripts) runs: the first of `typecheck`, `types:check` and `type-check`, then `lint` (or `check`), then `test` (npm init's placeholder `test` script is skipped). Then ESLint (without a `lint` or `check` script), Prettier and Stylelint, when `package.json` declares them, they have a config and no script runs them: on the files changed by the pull request or the merge queue group, every tracked file on other events, with the version the package installed (see [ESLint, Prettier and Stylelint](../lint.md#eslint-prettier-and-stylelint)). Node and the dependencies are installed with [`setup-js`](../../.github/actions/setup-js/action.yml) (the version of `.nvmrc` or `.node-version`, otherwise the current LTS) only when there is something to run; without `package.json`, any of these scripts or any of these tools, the job passes without installing anything. The typecheck and lint must only check: the job fails when they change a tracked file (see [Lint](../lint.md#rules-for-every-project)). `js: false` turns the job off; setup asks when `package.json` has one of the scripts.

A new push to a pull request cancels the previous run; runs on `main` always finish. The `all-checks` job passes only when every other job (the matrix, `lint` and `js`) passed or was skipped, so the required check does not depend on the matrix job names.

## Public API

With `api-check: true` (setup asks; `--api-check`), the lint job also runs, on pull requests, [`roave/backward-compatibility-check`](https://github.com/Roave/BackwardCompatibilityCheck) against the base branch: a removed public method, class or constant, a new required argument or a narrower type fails the check, with each break annotated on its line. The tool is installed in Composer's global folder, so it neither changes nor conflicts with the package's dependencies. It checks the PHP code only, not config keys or behavior: Claude's review covers those (see [Claude and the risk gate](package.md#claude-and-the-risk-gate-optional)).

A break that is meant to be (a major version) still fails it: merge it with the check overridden by an admin, or turn `api-check` off for that release.

## Customizing the matrix

All matrix inputs are JSON strings. For example, a package that only supports Laravel 13 on PHP 8.3+:

```yaml
jobs:
  pipeline:
    uses: datalogix/workflows/.github/workflows/package.yml@v2
    secrets: inherit
    with:
      php: '["8.3", "8.4", "8.5"]'
      laravel: '["^13.0"]'
      exclude: "[]"
```

A package that still supports Laravel 11 adds it back with `laravel: '["^11.0", "^12.0", "^13.0"]'`. See all inputs in [`package`](../reference.md#package).

## Inputs

| Input             | Default                                                                | Description                                                             |
| ----------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `php`             | `["8.2", "8.3", "8.4", "8.5"]`                                         | PHP versions (JSON)                                                     |
| `laravel`         | `["^12.0", "^13.0"]`                                                   | Laravel versions (JSON); `[""]` installs no framework                    |
| `stability`       | `["prefer-lowest", "prefer-stable"]`                                   | Composer stability (JSON)                                               |
| `exclude`         | Laravel 13 on PHP 8.2; `prefer-lowest` on PHP 8.4 and 8.5              | Matrix exclusions (JSON)                                                |
| `os`              | `["ubuntu-latest"]`                                                    | Runners (JSON)                                                          |
| `extensions`      | `dom, curl, libxml, mbstring, zip, pcntl, pdo, sqlite, pdo_sqlite, gd` | PHP extensions                                                          |
| `test-command`    | `composer test`, else `vendor/bin/pest`, else `vendor/bin/phpunit`     | Test command; `none` skips the matrix                                   |
| `coverage`        | `true`                                                                 | Upload coverage to Codecov from the newest combination of the matrix    |
| `min-coverage`    | `100`                                                                  | Minimum coverage on that combination; `0` turns the check off. See [Minimum coverage](../coverage.md) |
| `coverage-driver` | `pcov`                                                                 | `pcov` or `xdebug`                                                      |
| `timeout-minutes` | `30`                                                                   | Timeout per job                                                         |
| `pint`            | `true`                                                                 | Run `pint --test`: on the files changed by the pull request (Pint 1.20+) or the merge queue group, on every file on other events; Blade views included when `package.json` declares `prettier-plugin-blade` (Pint 1.30+) |
| `phpstan`         | `true`                                                                 | Run PHPStan once when `composer.json` requires it                       |
| `rector`          | `true`                                                                 | Run Rector in a dry run once when `composer.json` requires `rector/rector` and `rector.php` exists |
| `eslint` / `prettier` / `stylelint` | `true` | Run ESLint, Prettier (or `format:check`) and Stylelint (or `lint:css`) in the `js` job when the package installed them and no script runs them; see [ESLint, Prettier and Stylelint](../lint.md#eslint-prettier-and-stylelint) |
| `lint-command`    | empty                                                                  | Extra lint command, run once after Pint, PHPStan and Rector             |
| `js`              | `true`                                                                 | Run the `typecheck` (or `types:check`, `type-check`), `lint` (or `check`) and `test` scripts of `package.json`, and [ESLint, Prettier and Stylelint](../lint.md#eslint-prettier-and-stylelint) when no script runs them, once, in the `js` job; see [What it does](#what-it-does) |
| `typecheck` / `js-tests` | `true` | `false` skips the typecheck script (`typecheck`, `types:check` or `type-check`) or the `test` script of `package.json` in the `js` job, keeping the rest of the JavaScript checks |

Secret: `CODECOV_TOKEN` (optional).
