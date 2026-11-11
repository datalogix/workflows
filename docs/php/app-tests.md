# PHP app tests

With `stack: php`, the `tests` job of [`project`](../reference.md#project) calls `laravel-app-tests`, the same workflow as a Laravel app, and its check `pipeline / tests / tests` is required by the [branch ruleset](../verification-layers.md#branch-ruleset). Everything [Laravel app tests](../laravel/app-tests.md) describes applies (the dependency audits, the lint checks, the `package.json` scripts, the coverage), except how the app is prepared and the default test command.

## Preparing the app

The [`setup-laravel`](../../.github/actions/setup-laravel/action.yml) action follows the files of the app:

- PHP from `.php-version`, `composer.lock` or `composer.json` (`config.platform.php`), the extensions of the `ext-*` requirements, `composer install`, Node and the `build` script of `package.json` (Webpack Encore or Vite), as for Laravel.
- No `artisan`: no `.env` is written, and no Laravel Boost.
- **Symfony with Doctrine** (`bin/console` and `doctrine/doctrine-bundle`): with `APP_ENV=test`, it creates the test database and runs the migrations (`doctrine:migrations:migrate`, or `doctrine:schema:create` without Doctrine Migrations). The database is the one `.env.test` points at; Symfony's committed `.env` and `.env.test` are left as they are. Doctrine migrations are SQL for one platform, so SQLite is not forced: a failure only warns, and the tests that need the database fail on their own. To test on SQLite, set it in `.env.test`:

  ```
  DATABASE_URL="sqlite:///%kernel.project_dir%/var/data_%kernel.environment%.db"
  ```

  A Postgres or MySQL service for the tests is not available yet.

## Test command

Without `test-command`, the job runs the first of:

| When | Command |
| --- | --- |
| `composer.json` defines `test` | `composer test` |
| `artisan` exists (Laravel) | `php artisan test` |
| `bin/phpunit` exists (Symfony's PHPUnit recipe) | `php bin/phpunit` |
| Pest is installed | `vendor/bin/pest` |
| otherwise | `vendor/bin/phpunit` |

`test-command: none` turns the suite off; `tests: false` turns the whole layer off, with its required check.

## Lint

Pint and PHPStan run when `composer.json` requires them, as in a Laravel app (Pint works on any PHP code; PHPStan without Larastan). PHP-CS-Fixer, ECS, Psalm and Rector run through `lint-command`, e.g. `vendor/bin/php-cs-fixer fix --dry-run --diff` or a `composer cs:check` script. See [Lint](../lint.md).
