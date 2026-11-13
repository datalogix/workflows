# PHP package tests

With `stack: php`, the `tests` job of [`package`](../reference.md#package) calls `laravel-package-tests` with an empty Laravel axis (`laravel: '[""]'`), so no framework is installed: each combination of PHP version, dependency stability and OS runs `composer update` with the package's own requirements. Its check `pipeline / tests / all-checks` is required by the branch ruleset. Setting the package up: [Adding a PHP package](package.md).

Everything else is what [Laravel package tests](../laravel/package-tests.md) describes: the test command (`composer test`, else `vendor/bin/pest`, else `vendor/bin/phpunit`), coverage on the newest combination (highest PHP, `prefer-stable`, first OS) checked against `min-coverage` (100% by default, see [Minimum coverage](../coverage.md)), and the `lint` job:

- `pint --test` when the package requires `laravel/pint`, which works on any PHP code: on the files a pull request (or the merge queue group) changes, on every file on other events;
- PHPStan, when the package requires `phpstan/phpstan`;
- Rector in a dry run (`rector process --dry-run`), when the package requires `rector/rector` and has `rector.php` (`rector: false` turns it off);
- `lint-command` for any other tool, e.g. `composer cs:check` for php-cs-fixer or ECS, or Psalm. See [Lint](../lint.md#laravel-and-php-packages).

And the `js` job, once, for a package with a `package.json`: its typecheck, lint and test scripts, and ESLint, Prettier and Stylelint when no script runs them, as described in [Laravel package tests](../laravel/package-tests.md#what-it-does) (`js: false` turns it off).

The matrix job names leave Laravel out (`P8.5 - prefer-stable - ubuntu-latest`).

## Customizing the matrix

The inputs are those of a Laravel package, except `laravel`, which is ignored. For example, a package that supports PHP 8.3+:

```yaml
jobs:
  pipeline:
    uses: datalogix/workflows/.github/workflows/package.yml@v2
    secrets: inherit
    with:
      stack: php
      php: '["8.3", "8.4", "8.5"]'
```

The default `exclude` (`prefer-lowest` on PHP 8.4 and 8.5) also applies; its Laravel entry matches nothing. See all inputs in [`package`](../reference.md#package).
