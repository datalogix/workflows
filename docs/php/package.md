# Adding a PHP package

PHP packages without Laravel (framework-agnostic libraries, Symfony bundles, Composer plugins) call `package`, the same entry point as Laravel packages, with `stack: php`. Today it runs the same tests as a [Laravel package](../laravel/package.md), without the Laravel axis of the matrix: the test suite across PHP versions and dependency stability (`prefer-lowest` / `prefer-stable`), with coverage uploaded to Codecov, and the lint checks once. New layers are added to `package`, so packages get them without changing their workflow file.

PHP apps without Laravel (Symfony, plain PHP) call `project` with `stack: php`; the setup command does not set them up yet: see [Manual setup of a PHP app](app-manual-setup.md).

## Setup

After the [organization setup](../organization-setup.md), from the package folder:

```bash
npx --allow-git=root github:datalogix/workflows#v2 setup
```

It detects a PHP package (a `composer.json` without `artisan` and without Laravel: no `laravel/framework`, `illuminate/*` or `orchestra/testbench` requirement and no `extra.laravel`) and asks you to confirm (`--stack php --kind package` answers it; `--yes` takes what it detected). Any `type` but `project` counts as a package, Composer's default being `library`; a `composer.json` with `type: project`, `bin/console` or `public/index.php` is an app, which setup refuses. A folder with both `composer.json` and `package.json` is a PHP project, not a JavaScript one.

The questions and what setup writes are those of a Laravel package (see [Adding a Laravel package](../laravel/package.md#setup)): the lint checks and the test suite, the Codecov token, whether you work alone on the package and, with a team, who must approve changes to `.github/`. The workflow file gets `stack: php`.

A package workflow file without a `stack` input runs the Laravel package tests, the default: setup and check keep reading it as a Laravel package, even when `composer.json` does not name Laravel. Run setup with `--stack php` to switch it.

### By hand

Follow [Adding a Laravel package](../laravel/package.md#by-hand), with `stack: php` in the `with:` of the workflow file:

```yaml
jobs:
  pipeline:
    uses: datalogix/workflows/.github/workflows/package.yml@v2
    secrets: inherit
    with:
      stack: php
```

The required check is the same, `pipeline / tests / all-checks`, and `protect` and `check` work as for a Laravel package.

Private Composer packages are not supported: the workflow passes no Composer credentials (`COMPOSER_AUTH`).

What the tests run and how to change the matrix: [PHP package tests](package-tests.md).
