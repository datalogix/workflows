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

- on pull requests, `pint --test` on the files they change, when the package requires `laravel/pint` (1.20+), so existing style issues in untouched files do not fail the build (`pint: false` turns it off); with `prettier-plugin-blade` in `package.json` and Pint 1.30+, it also checks Blade views (`--blade`), installing Node and the package's Node dependencies first, as in an [app](app-tests.md#test-scripts);
- PHPStan, when the package requires `phpstan/phpstan` or Larastan (`phpstan: false` turns it off);
- `lint-command`, when set (e.g. `composer lint:check`).

Each one runs even when an earlier one failed, so one run reports every lint failure.

Setup asks for them like for an app, starting from what `composer.json` requires: see [Lint and test suite](app-tests.md#lint-and-test-suite).

A new push to a pull request cancels the previous run; runs on `main` always finish. The `all-checks` job passes only when every other job passed (or was skipped), so the required check does not depend on the matrix job names.

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
| `pint`            | `true`                                                                 | Run `pint --test` on the files changed by the pull request (Pint 1.20+), Blade views included when `package.json` declares `prettier-plugin-blade` (Pint 1.30+) |
| `phpstan`         | `true`                                                                 | Run PHPStan once when `composer.json` requires it                       |
| `lint-command`    | empty                                                                  | Extra lint command, run once after Pint and PHPStan                     |

Secret: `CODECOV_TOKEN` (optional).
