# Laravel app tests

The `tests` job of [`project`](../reference.md#project) calls `laravel-app-tests`, and its check `pipeline / tests / tests` is required by the [branch ruleset](../verification-layers.md#branch-ruleset).

`project` passes `pint`, `phpstan`, `lint-command` and `test-command` to [`laravel-app-tests`](#inputs), but not `audit` or `timeout-minutes`: `composer audit` and the Node audit run on scheduled and manual runs and on pull requests that change their lockfile, and the tests job stops after 30 minutes.

## Dependency audits

| Lockfile | Command |
| --- | --- |
| `composer.lock` | `composer audit --locked --abandoned=report` (any advisory fails; abandoned packages are only reported) |
| `package-lock.json` | `npm audit --audit-level=high` |
| `pnpm-lock.yaml` | `pnpm audit --audit-level high` |
| `yarn.lock` | `yarn audit --level high` (Yarn 1) or `yarn npm audit --recursive --severity high` (Yarn 2+) |

The Node audit fails only on high and critical advisories, as npm publishes many low ones, and includes the dev dependencies: in a Laravel app, Vite and the frontend libraries are usually there and end up in the bundle. On pull requests each audit runs only when its lockfile changes, so a new advisory does not block unrelated pull requests; the weekly run catches advisories published later. Without a lockfile, the audit is skipped.

## Lint and test suite

Setup reads `composer.json` and asks two questions, starting from what is installed:

- **Lint checks**: Laravel Pint (on pull requests, only the files they change), PHPStan, and another command. The installed tools come checked; unchecking one writes `pint: false` or `phpstan: false`, and unchecking everything turns lint off. Another command (`lint-command`) runs after them, on every event; setup suggests the `composer.json` scripts that only check (e.g. `composer lint:check && composer types:check`), leaving out what Pint and PHPStan already cover.
- **Test suite**: the suggested command, another command (`test-command`) or off (`test-command: none`). The suggestion is `composer test` when that script only runs tests, and `php artisan test` when it also runs Pint or PHPStan (as in the Laravel starter kits), so lint does not run twice, nor Pint on every file. Without Pest, PHPUnit or a `test` script, the question starts at off.

With the suite and lint off, the `tests` job still runs (the audits, the `package.json` scripts), so its required check still reports. To turn the whole layer off, and its required check with it, set `tests: false`.

## Test scripts

The tests job runs the project's own scripts when they are defined, so CI, your machine and Claude run the tests the same way:

| Script | File | CI runs | Without it |
| --- | --- | --- | --- |
| `test` | `composer.json` | `composer test` | `php artisan test` (packages: `vendor/bin/pest`, otherwise `vendor/bin/phpunit`) |
| `typecheck` | `package.json` | `npm run typecheck` | skipped |
| `lint` | `package.json` | `npm run lint` | skipped |
| `test` | `package.json` | `npm run test` | skipped |

For example:

```json
{
    "scripts": {
        "test": [
            "@php artisan config:clear --ansi",
            "@php artisan test"
        ]
    }
}
```

```json
{
    "scripts": {
        "build": "vite build",
        "typecheck": "vue-tsc --noEmit",
        "lint": "eslint .",
        "test": "vitest run"
    }
}
```

- `package.json` scripts run with pnpm or yarn instead of npm when their lockfile is present. The placeholder `test` script written by `npm init` is ignored. `js: false` turns the three off.
- An explicit `test-command` replaces `composer test`; `none` skips the test suite.
- Scripts must check, not fix, and exit when done: `eslint .`, not `eslint . --fix`; `vitest run`, not `vitest`.
- CI turns off Composer's 300-second script timeout. For long suites locally, start the script with `Composer\\Config::disableProcessTimeout`.
- Pint and PHPStan stay in the workflow (Pint checks only the files changed by the pull request), so CI does not run `composer lint` or similar scripts unless `lint-command` names them.

## Inputs

| Input             | Default            | Description                                                                               |
| ----------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `php-version`     | detected           | Override the PHP version                                                                  |
| `node-version`    | detected           | Override the Node version                                                                 |
| `pint`            | `true`             | Run `pint --test` on the files changed by the pull request (Pint 1.20+)                   |
| `phpstan`         | `true`             | Run PHPStan when installed                                                                |
| `lint-command`    | empty              | Extra lint command run after Pint and PHPStan, e.g. `composer lint:check`                 |
| `audit`           | `true`             | Run `composer audit` and the Node audit on scheduled and manual runs, and on PRs that change their lockfile |
| `test-command`    | detected           | Test command: `composer test` when defined, otherwise `php artisan test`; `none` skips it |
| `js`              | `true`             | Run the `typecheck`, `lint` and `test` scripts of `package.json` when they are defined    |
| `timeout-minutes` | `30`               | Job timeout                                                                               |

`project` passes `php-version`, `node-version`, `test-command` and `js`; call `laravel-app-tests` on its own for the others.
