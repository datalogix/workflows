# Laravel package tests

The `tests` job of [`package`](../reference.md#package) calls `laravel-package-tests`, and its check `pipeline / tests / all-checks` is required by the branch ruleset. Setting the package up: [Adding a Laravel package](package.md).

## What it does

For each combination of the matrix it:

1. Sets up PHP with the requested extensions.
2. Restores the Composer cache.
3. Requires the Laravel version under test (`composer require laravel/framework:<version> --no-update`) and runs `composer update --prefer-lowest` or `--prefer-stable`.
4. Runs the tests: `composer test` when `composer.json` defines it, otherwise `vendor/bin/pest` when Pest is installed, otherwise `vendor/bin/phpunit` (or `test-command`). See [Test scripts](app-tests.md#test-scripts).

Coverage is collected only on the newest combination (highest PHP and Laravel, `prefer-stable`, first OS), with `pcov` by default, and uploaded to Codecov: the driver slows the tests down, and the other combinations would upload the same report. If `exclude` removes that combination, the run warns and no coverage is reported. The other jobs run PHPUnit or Pest with `--no-coverage`, so a coverage report configured in `phpunit.xml` does not fail them with `failOnWarning`. With `composer test`, the flag is passed only when the script is a single PHPUnit or Pest command (e.g. `"test": "vendor/bin/pest"`). The package's `phpunit.xml` must produce a Clover report, for example:

```xml
<coverage>
    <report>
        <clover outputFile="clover.xml"/>
    </report>
</coverage>
```

On pull requests, a separate job also runs `pint --test` on the files changed by the pull request, once and outside the matrix, when the package requires `laravel/pint` (1.20+). Existing style issues in untouched files do not fail the build. Disable it with `pint: false`.

A new push to a pull request cancels the previous run; runs on `main` always finish. The `all-checks` job passes only when every other job passed (or was skipped), so the required check does not depend on the matrix job names.

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
| `laravel`         | `["^12.0", "^13.0"]`                                                   | Laravel versions (JSON)                                                 |
| `stability`       | `["prefer-lowest", "prefer-stable"]`                                   | Composer stability (JSON)                                               |
| `exclude`         | Laravel 13 on PHP 8.2; `prefer-lowest` on PHP 8.4 and 8.5              | Matrix exclusions (JSON)                                                |
| `os`              | `["ubuntu-latest"]`                                                    | Runners (JSON)                                                          |
| `extensions`      | `dom, curl, libxml, mbstring, zip, pcntl, pdo, sqlite, pdo_sqlite, gd` | PHP extensions                                                          |
| `test-command`    | `composer test`, else `vendor/bin/pest`, else `vendor/bin/phpunit`     | Test command                                                            |
| `coverage`        | `true`                                                                 | Collect and upload coverage on the newest combination of the matrix     |
| `coverage-driver` | `pcov`                                                                 | `pcov` or `xdebug`                                                      |
| `timeout-minutes` | `30`                                                                   | Timeout per job                                                         |
| `pint`            | `true`                                                                 | Run `pint --test` on the files changed by the pull request (Pint 1.20+) |

Secret: `CODECOV_TOKEN` (optional).
