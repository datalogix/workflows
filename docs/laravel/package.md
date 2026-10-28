# Adding a Laravel package

Packages call `package`, their single entry point, like `project` for apps. Today it runs `laravel-package-tests`: the test suite across a matrix of PHP versions, Laravel versions and dependency stability (`prefer-lowest` / `prefer-stable`), with coverage uploaded to Codecov. New layers are added to `package`, so packages get them without changing their workflow file.

## Setup

After the [organization setup](../organization-setup.md), from the package folder:

```bash
npx --allow-git=root github:datalogix/workflows#v2 setup
```

It detects a Laravel package (no `artisan`, and a `composer.json` that requires `laravel/framework` or `illuminate/*` or has `extra.laravel`) and asks you to confirm (`--kind package` answers it; `--yes` takes what it detected). When `.github/workflows/datalogix.yml` already calls the app workflow, setup refuses to set the folder up as a package: remove the file first. Then it asks for the Codecov token (only when the package uploads coverage, so not with `tests: false` or `coverage: false`, and cannot read a `CODECOV_TOKEN` secret; empty skips coverage uploads), the lint checks and the test suite (as for an app, starting from what `composer.json` requires: see [Lint and test suite](app-tests.md#lint-and-test-suite); the suggested test command is `vendor/bin/pest` or `vendor/bin/phpunit` when `composer test` also lints), whether you work alone on the package and who must approve changes to `.github/`, and:

- writes `.github/workflows/datalogix.yml` from [`examples/package.yml`](../../examples/package.yml), with the default branch in the `push` trigger, the lint and test inputs of the answers and the other `with:` inputs of the existing file kept;
- writes the `/.github/` line of `.github/CODEOWNERS` and stores the Codecov token.

It ends with the commit to make and the `protect` command to run after the first pull request.

### By hand

1. Add the `CODECOV_TOKEN` secret if you want coverage reports. Packages are public, so an organization secret works even on GitHub Free.
2. Copy [`examples/package.yml`](../../examples/package.yml) to `.github/workflows/datalogix.yml`:

   ```yaml
   name: datalogix

   on:
     push:
       branches: [main]
     pull_request:
     merge_group:
     workflow_dispatch:

   permissions:
     contents: read

   jobs:
     pipeline:
       uses: datalogix/workflows/.github/workflows/package.yml@v2
       secrets: inherit
   ```

3. After the first pull request shows its checks, protect the default branch from the package folder:

   ```bash
   npx --allow-git=root github:datalogix/workflows#v2 protect
   ```

   It requires pull requests and the `pipeline / tests / all-checks` check, and asks whether you work alone on the package (`--solo` / `--no-solo` answers it): with a team, changes to `.github/` also need the approval of its code owners (`.github/CODEOWNERS`).

To see what is missing, run `npx --allow-git=root github:datalogix/workflows#v2 check` from the package folder. In a package (its workflow file calls `package.yml`, or the folder looks like a Laravel package) it checks only the workflow file, the ruleset, the Codecov token (unless `tests: false` or `coverage: false`) and the code owners of `.github/`.

Private Composer packages are not supported: the workflow passes no Composer credentials (`COMPOSER_AUTH`).

What the tests run and how to change the matrix: [Laravel package tests](package-tests.md).
