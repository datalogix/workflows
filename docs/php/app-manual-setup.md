# Manual setup of a PHP app

PHP apps without Laravel (Symfony, and plain PHP apps) call `project`, the same entry point as Laravel apps, with `stack: php`. The setup command does not set them up yet: this page is what it would do. Replace `OWNER/REPO` with the project's repository.

What a PHP app gets is what a Laravel app gets (see [Verification layers](../verification-layers.md)), with these differences:

- The tests run [`laravel-app-tests`](app-tests.md), which prepares the app by its files: Composer, Node and the frontend build, and for Symfony with Doctrine the test database of `.env.test`. No Laravel `.env`, `artisan` or Boost.
- Claude installs the `php` plugin (`php@datalogix`: conventions for Symfony and plain PHP, and the `fix-ci`, `plan`, `security-review` and `incident` commands) and runs with `APP_ENV=test`.
- The risk gate uses [PHP's high-risk paths](../reference.md#risk-gate) (Doctrine migrations, the security firewall, routes, `.env`).
- Deploys go to Forge, as described in [Deploy](../deploy.md) (Laravel Cloud runs only Laravel; Vercel and Netlify run no PHP).
- Problems become issues with [Sentry](../production-errors.md#sentry) or [Inspector](../production-errors.md#inspector); Nightwatch is Laravel only.

## Workflow file

Copy [`examples/project.yml`](../../examples/project.yml) to `.github/workflows/datalogix.yml` (change `branches: [main]` under `push:` when the default branch is another one) and set its inputs:

```yaml
jobs:
  pipeline:
    uses: datalogix/workflows/.github/workflows/project.yml@v2
    secrets: inherit
    with:
      stack: php
      deploy: forge        # remove the line to disable deploys
      monitoring: sentry   # or inspector; without either: incidents: false
      pint: false          # Pint and PHPStan run when installed; false turns each off
      lint-command: vendor/bin/php-cs-fixer fix --dry-run --diff   # PHP-CS-Fixer, ECS, Psalm or Rector
```

The other inputs are those of a Laravel app: see [`project`](../reference.md#project).

## Labels, Claude token, environments, relay, code owners and ruleset

The same as for a Laravel app: see [Manual setup of a Laravel app](../laravel/app-manual-setup.md#labels), from **Labels** to **Production branch**, with these changes:

- **Environments**: Forge's `DEPLOY_HOOK` secret and the `HEALTH_URL` variable of each environment, pointing at the app's health check (below); no `NIGHTWATCH_TOKEN`.
- **Relay**: store the signing secret under `sentry:OWNER/REPO` (Sentry's Client Secret) or the ingestion keys under `inspector:OWNER/REPO`; see [Production errors](../production-errors.md#sentry).

## Health check

The deploy watches `HEALTH_URL` and rolls back when it stops answering `200`. Symfony and plain PHP have no health route of their own:

- **Symfony**: add a controller, which the default attribute routing of `src/Controller` picks up, and set `HEALTH_URL` to `https://example.com/health`:

  ```php
  <?php

  namespace App\Controller;

  use Doctrine\DBAL\Connection;
  use Symfony\Component\HttpFoundation\JsonResponse;
  use Symfony\Component\Routing\Attribute\Route;

  final class HealthController
  {
      #[Route('/health', name: 'health', methods: ['GET'])]
      public function __invoke(Connection $connection): JsonResponse
      {
          // Fails (500) when the database is unreachable; remove it, and the Connection, to check only the app
          $connection->executeQuery('SELECT 1');

          return new JsonResponse(['status' => 'ok'], headers: ['Cache-Control' => 'no-store']);
      }
  }
  ```

- **Plain PHP**: add `public/health.php` (or `health.php` in the web root) and set `HEALTH_URL` to `https://example.com/health.php`:

  ```php
  <?php

  header('Content-Type: application/json');
  header('Cache-Control: no-store');
  echo json_encode(['status' => 'ok']);
  ```

  Forge's default Nginx configuration runs any `.php` file under the web root; a configuration that sends every request to `index.php` needs a route there instead.

## Monitoring SDK

- **Sentry**: `composer require sentry/sentry-symfony` (Symfony) or `sentry/sentry` (plain PHP), with the Sentry environments named `production` and `staging`, like the GitHub environments.
- **Inspector**: `composer require inspector-apm/inspector-symfony` (Symfony) or `inspector-apm/inspector-php` (plain PHP), with each environment's ingestion key.

What the tests run: [PHP app tests](app-tests.md).
