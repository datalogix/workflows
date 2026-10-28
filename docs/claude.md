# Claude's conventions and environment

## Conventions

Claude follows the rules in the `laravel` plugin ([`plugins/laravel`](../plugins/laravel)), loaded by every Claude workflow:

- Everything Claude writes for the team (commits, pull requests, comments) is in the project's `language` input, Brazilian Portuguese (`pt-BR`) by default; commits use Conventional Commits with English types, e.g. `feat: adiciona autenticação via OAuth`. The fixed texts of the workflows (deploy, incident and release issues and pull requests, security review summary, labels) exist in `pt-BR` and `en` only: any value starting with `en` gets English, any other language gets Portuguese.
- Implements only what is needed and reuses the existing architecture.
- Creates tests only if the project already has real tests beyond Laravel's scaffold.
- Runs Pint, PHPStan, the related tests and, for frontend changes, the `typecheck` and `lint` scripts, and `composer audit --locked` when `composer.lock` changes, before opening or updating a pull request; does not fix pre-existing failures and stops after 2 attempts on the same failure.
- Puts new user-facing behavior behind a Pennant flag in projects that use Pennant, and keeps migrations compatible with the previous release.
- Never approves pull requests, and stops after 3 rounds of requested changes.
- Pull request descriptions contain _Resumo_, _Motivação_, _Plano de Testes_ and _Observações_ (translated in another team language).

The rules live in [`plugins/laravel/skills/conventions/SKILL.md`](../plugins/laravel/skills/conventions/SKILL.md). Changing that file changes Claude's behavior in every project. Project-specific context belongs in the project's own `CLAUDE.md`.

To use the same conventions in your local Claude Code:

```
/plugin marketplace add datalogix/workflows
/plugin install laravel@datalogix
```

## Environment

`claude`, `claude-fix-ci` and `laravel-app-tests` prepare the project with the [`setup-laravel`](../.github/actions/setup-laravel/action.yml) action:

| Step          | Details                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHP           | Version from `.php-version`, then `composer.lock` / `composer.json` (`config.platform.php`), otherwise the **latest** release. Extensions are detected from the `ext-*` requirements in `composer.json` and `composer.lock`. |
| Composer      | `composer install` with a cached download directory. Private packages are not supported (no Composer credentials).                                                                                                           |
| Node          | Version from `.nvmrc` or `.node-version`, otherwise the current LTS. Installs with pnpm, yarn or npm according to the lockfile (Corepack is installed when the Node version no longer ships it).                             |
| `.env`        | Copied from `.env.example`, forced to SQLite (`database/database.sqlite`), with a generated `APP_KEY`.                                                                                                                       |
| Database      | `php artisan migrate`; a failure only produces a warning (for example, MySQL-specific migrations).                                                                                                                           |
| Frontend      | `build` script from `package.json`, so views using `@vite` render in tests; a failure only produces a warning.                                                                                                               |
| Laravel Boost | When `laravel/boost` is installed, Claude gets its MCP server (documentation search, database queries, Artisan, logs).                                                                                                       |

## Models and usage

| Workflow                              | Default model                                 |
| ------------------------------------- | --------------------------------------------- |
| `claude` (implementation and replies) | `opus`                                        |
| `claude` (plans)                      | `best`: Fable where available, otherwise Opus |
| `claude-review`                       | `opus`                                        |
| `claude-security-review`              | `opus`                                        |
| `incident`                            | `opus`                                        |
| `claude-fix-ci`                       | `sonnet`                                      |

Models are aliases, so they follow new releases automatically. Every repository shares the usage limits of the account that owns `CLAUDE_CODE_OAUTH_TOKEN`, including that account's own Claude Code usage. If the limit gets tight, reduce in this order: `model: sonnet` (replies, implementation, reviews and incident analysis), then `plan-model: opus`, then fewer incident types (`incident-types: '["exception"]'`).
