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

  Or set `database` to start a server for the tests: see [Test database](#test-database).

## Test database

With `database: postgres`, `mysql` or `mariadb`, the tests job starts that server as a service (PostgreSQL 17, MySQL 8.4 or MariaDB 11.4) and sets `DATABASE_URL` before the app is prepared, so the migrations and the tests use it:

| `database` | `DATABASE_URL` |
| --- | --- |
| `postgres` | `postgresql://app:app@127.0.0.1:5432/app?serverVersion=17&charset=utf8` |
| `mysql` | `mysql://root:root@127.0.0.1:3306/app?serverVersion=8.4.0&charset=utf8mb4` |
| `mariadb` | `mysql://root:root@127.0.0.1:3306/app?serverVersion=11.4.0-MariaDB&charset=utf8mb4` |

A real environment variable wins over Symfony's `.env` files, so `.env.test` needs no change; Doctrine's `dbname_suffix` of the test environment still applies (`app_test`), which is why MySQL and MariaDB connect as `root`, allowed to create it. With `none` (the default) nothing is started and `DATABASE_URL` is left to `.env.test`. Setup asks for it when a Symfony app uses Doctrine (`--database` answers it).

The server is only for the tests job: Claude's sessions (`@claude`, Fix CI) prepare the app without it, so their migrations warn and the tests that need the database fail there.

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
