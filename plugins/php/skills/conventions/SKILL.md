---
name: conventions
description: Datalogix conventions for PHP projects without Laravel, Symfony or plain PHP (feature flags, migrations, tests, the tools of the validation and the pre-PR verification), on top of core:conventions (language, commits, scope, review rounds and pull requests). Use before changing code, creating commits, opening PRs or replying on issues and PRs.
---

# Datalogix conventions for PHP

These rules add to `core:conventions`, which has the language, scope, validation limits, review rounds and pull request rules: load both. They cover Symfony apps (`bin/console`) and plain PHP apps; the Symfony-only rules say so.

## Feature flags and phased rollout

When the project already has a way to turn features on and off (a feature flag library such as Unleash or Flagception, or its own module), new user-facing behavior ships behind a flag, unless the issue says otherwise:

- Define the flag where the project defines the others, enabled only for internal users first. Reuse the project's existing way of identifying team members or admins; if there is none, enable it for nobody and say so in the PR.
- Keep the old behavior working while the flag is off. Removing the flag and the old code path is a separate, later PR.
- Rollout stages are separate PRs that only change who gets the flag.
- Mention the flag and its current stage in **Observações**.

Without such a mechanism, do not add a flag library: build the change directly.

## Migrations

Every deploy can be rolled back by redeploying the previous commit, which does not undo migrations. Migrations must therefore keep the previous release working:

- Write them with the project's tool: Doctrine Migrations (`migrations/`, generated with `php bin/console make:migration` or `doctrine:migrations:diff`, then reviewed), Phinx (`db/migrations`) or the project's own scripts.
- Only additive changes (new tables, new nullable or defaulted columns, new indexes) in the same PR as the code that uses them.
- Never drop or rename a column or table that the previous release still uses, and never change a column's type in place. Do it in steps across separate PRs: add the new structure, move the code to it, and remove the old structure only after that release is stable.
- Never edit a migration that is already on the default branch.

## Tests

- Create or update automated tests **only** if the project already has real tests beyond a framework scaffold.
- If the project has no tests, or only scaffold ones, do not create new tests.

## Validation

- Use the project's scripts to learn how it runs its tools: read `scripts` in `composer.json` (`test`, `cs:check`, `lint`, `analyse`) and `package.json` (`typecheck`, `lint`, `test`) and use the same runner and options, filtered to your change (e.g. `php bin/phpunit --filter=<Test>`, `vendor/bin/pest --filter=<Test>`). Fall back to `php bin/phpunit` (Symfony), `vendor/bin/pest` or `vendor/bin/phpunit` when there is no script.
- Run the project's formatter only on the files you changed: PHP-CS-Fixer (`vendor/bin/php-cs-fixer fix <files>`), ECS (`vendor/bin/ecs check <files> --fix`) or Laravel Pint (`vendor/bin/pint <files>`), whichever `composer.json` requires.
- Run PHPStan or Psalm, if available, only on the files you changed, not the whole codebase.
- **Symfony**: when you change configuration, templates or translations, also run `php bin/console lint:container`, `lint:twig` and `lint:yaml` on what you changed.

## Pre-PR verification

The checks to run on what you changed (see `core:conventions`; never lower a PHPStan or Psalm level or add ignores or baseline entries to pass):

1. The formatter of the project on the changed PHP files (see Validation).
2. PHPStan or Psalm on the changed PHP files.
3. The tests related to the change (PHP, and JavaScript/TypeScript through the `test` script of `package.json` when you changed frontend code).
4. The typecheck (`typecheck`, `types:check` or `type-check`) and lint (`lint` or `check`) scripts of `package.json`, when they are defined and you changed frontend code.
5. **Symfony**: the `lint:*` commands of Validation for the configuration, templates or translations you changed.
6. `composer audit --locked` if you changed `composer.lock`, and the audit of the Node lockfile you changed (`npm audit --audit-level=high`, `pnpm audit --audit-level high`, `yarn audit --level high` or `yarn npm audit --recursive --severity high`).
