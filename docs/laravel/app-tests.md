# Laravel app tests

The `tests` job of [`project`](../reference.md#project) calls `laravel-app-tests`, and its check `pipeline / tests / tests` is required by the [branch ruleset](../verification-layers.md#branch-ruleset).

`project` does not pass `pint`, `phpstan`, `audit` or `timeout-minutes` to [`laravel-app-tests`](#inputs): Pint (on pull requests, changed files only) and PHPStan run whenever they are installed (remove the package to turn the check off), `composer audit` runs on scheduled and manual runs and on pull requests that change `composer.lock`, and the tests job stops after 30 minutes.

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
- An explicit `test-command` replaces `composer test`.
- Scripts must check, not fix, and exit when done: `eslint .`, not `eslint . --fix`; `vitest run`, not `vitest`.
- CI turns off Composer's 300-second script timeout. For long suites locally, start the script with `Composer\\Config::disableProcessTimeout`.
- Pint and PHPStan stay in the workflow (Pint checks only the files changed by the pull request), so CI does not run `composer lint` or similar scripts.

## Inputs

| Input             | Default            | Description                                                                               |
| ----------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `php-version`     | detected           | Override the PHP version                                                                  |
| `node-version`    | detected           | Override the Node version                                                                 |
| `pint`            | `true`             | Run `pint --test` on the files changed by the pull request (Pint 1.20+)                   |
| `phpstan`         | `true`             | Run PHPStan when installed                                                                |
| `audit`           | `true`             | Run `composer audit` on scheduled and manual runs, and on PRs that change `composer.lock` |
| `test-command`    | detected           | Test command: `composer test` when defined, otherwise `php artisan test`                  |
| `js`              | `true`             | Run the `typecheck`, `lint` and `test` scripts of `package.json` when they are defined    |
| `timeout-minutes` | `30`               | Job timeout                                                                               |

`project` passes `php-version`, `node-version`, `test-command` and `js`; call `laravel-app-tests` on its own for the others.
