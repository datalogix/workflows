# Adding a PHP app

PHP apps without Laravel (Symfony, and plain PHP apps) call `project`, the same entry point as Laravel apps, with `stack: php`. They get what a Laravel app gets: Claude on issues and pull requests, the [tests](app-tests.md), the Claude code review, the security review, the risk gate, Fix CI, Sentry or Inspector problems as issues and, on Forge, deploys to staging and production, each watched and rolled back automatically when its health check fails.

Claude follows the `core` and `php` plugins ([Claude's conventions](../claude.md)): the language and pull request rules of every project, plus PHP's practices (feature flags only with the project's flag library, additive Doctrine or Phinx migrations, the formatter and static analysis the project uses, Symfony's `lint:*` commands). The security review uses a checklist for Symfony's firewall and voters, entities bound from the request, DQL and PDO queries, Twig and the committed `.env` files.

## Step 1: run setup

After the [organization setup](../organization-setup.md), from the app folder:

```bash
npx --allow-git=root github:datalogix/workflows#v2 setup
```

It detects a PHP app (a `composer.json` without `artisan` and without Laravel, not a [JavaScript project with a tooling `composer.json`](../js/app.md#step-1-run-setup), with Symfony's `bin/console`, a `public/index.php` or `web/index.php`, Craft's `craft` or Composer's `type: project`; any other `composer.json` is a [PHP package](package.md)) and asks you to confirm (`--stack php --kind app` answers it). A Symfony app is one with `bin/console` and `symfony/framework-bundle`; everything else is plain PHP.

The questions are those of a [Laravel app](../laravel/app.md#step-1-run-setup), with these differences:

| Question | Difference |
| --- | --- |
| Where the app is deployed (`deploy`) | Forge or not by the workflows: Laravel Cloud runs only Laravel, Vercel and Netlify run no PHP |
| Health check path | `/health` for Symfony, `/health.php` for plain PHP |
| The app's monitoring service (`monitoring`) | Sentry (the default) or Inspector; Nightwatch is Laravel only |
| Whether to create the health check | Asked when the app deploys to that path and has none. Symfony: `src/Controller/HealthController.php`, a `/health` route (only when `config/routes.yaml` imports the routes of `src/Controller`, as Symfony's default does). Plain PHP: `public/health.php` (`web/health.php` with a `web` folder, as in Craft; `health.php` without either) |
| Whether the health check fails when the database is down | A Symfony health route, with Doctrine installed: the controller runs `SELECT 1` on Doctrine's connection |
| Database for the tests (`database`) | A Symfony app with Doctrine: the database of `.env.test` (the default), or a PostgreSQL, MySQL or MariaDB server started for the tests ([Test database](app-tests.md#test-database)) |
| Lint checks and test suite | As for a Laravel app; the suggested test command is `composer test`, otherwise `php bin/phpunit` (Symfony's recipe), `vendor/bin/pest` or `vendor/bin/phpunit` |

Then it writes `.github/workflows/datalogix.yml` with `stack: php` and does what it does for a Laravel app: the labels, the environments with Forge's deploy hook and `HEALTH_URL`, the Claude token, the relay secret, the code owners and, with a Forge API token, the sites. Nightwatch's agent and token are left out.

## Step 2: do what setup cannot

As for a Laravel app ([step 2](../laravel/app.md#step-2-do-what-setup-cannot)), plus:

- **The monitoring SDK**, when setup says it is missing: `composer require sentry/sentry-symfony` or `inspector-apm/inspector-symfony` (Symfony), `sentry/sentry` or `inspector-apm/inspector-php` (plain PHP).
- **The health check by hand**, when setup could not write it (a Symfony app without attribute routing): see [Health check](app-manual-setup.md#health-check).
- **The test database**: without a `database` server, the tests migrate the database of `.env.test`; a project that tests on SQLite says so there (see [Preparing the app](app-tests.md#preparing-the-app)).

Without the setup command, follow [Manual setup of a PHP app](app-manual-setup.md). `check` and `protect` work as for a Laravel app.
