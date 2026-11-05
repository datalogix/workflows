---
name: conventions
description: Datalogix conventions for Laravel projects (feature flags, migrations, tests, the tools of the validation and the pre-PR verification), on top of core:conventions (language, commits, scope, review rounds and pull requests). Use before changing code, creating commits, opening PRs or replying on issues and PRs.
---

# Datalogix conventions for Laravel

These rules add to `core:conventions`, which has the language, scope, validation limits, review rounds and pull request rules: load both.

## Feature flags and phased rollout

In projects that use `laravel/pennant`, new user-facing behavior ships behind a feature flag, unless the issue says otherwise:

- Define the flag where the project already defines its features (or in `AppServiceProvider::boot` if it has none) as a class-based or named feature whose resolver enables it only for internal users first. Reuse the project's existing way of identifying team members or admins; if there is none, enable it for nobody and say so in the PR.
- Keep the old behavior working while the flag is off. Removing the flag and the old code path is a separate, later PR.
- Rollout stages are separate PRs that only change the resolver: internal users, then a share of users with `Lottery::odds(...)`, then everyone.
- Mention the flag and its current stage in **Observações**.

## Migrations

Every deploy can be rolled back by redeploying the previous commit, which does not undo migrations. Migrations must therefore keep the previous release working:

- Only additive changes (new tables, new nullable or defaulted columns, new indexes) in the same PR as the code that uses them.
- Never drop or rename a column or table that the previous release still uses, and never change a column's type in place. Do it in steps across separate PRs: add the new structure, move the code to it, and remove the old structure only after that release is stable.
- Never edit a migration that is already on the default branch.

## Tests

- Create or update automated tests **only** if the project already has real tests beyond Laravel's scaffold tests (`tests/Feature/ExampleTest.php`, `tests/Unit/ExampleTest.php`).
- If the project only has those scaffold tests, do not create new tests.

## Validation

- Run Laravel Pint, if available, only on the files you changed (`vendor/bin/pint <files>`).
- Run PHPStan, if available, only on the files you changed, not the whole codebase.
- Use the project's scripts to learn how it runs its tools: read `scripts` in `composer.json` (`test`) and `package.json` (`typecheck`, `lint`, `test`) and use the same runner and options, filtered to your change (e.g. `php artisan test --filter=<Test>`, `npm run test -- <file>`). Fall back to `php artisan test`, `vendor/bin/pest` or `vendor/bin/phpunit` when there is no script.

## Pre-PR verification

The checks to run on what you changed (see `core:conventions`; never lower a PHPStan level or add ignores to pass):

1. Laravel Pint on the changed PHP files.
2. PHPStan on the changed PHP files.
3. The tests related to the change (PHP, and JavaScript/TypeScript through the `test` script of `package.json` when you changed frontend code).
4. The `typecheck` and `lint` scripts of `package.json`, when they are defined and you changed frontend code.
5. `composer audit --locked` if you changed `composer.lock`, and the audit of the Node lockfile you changed (`npm audit --audit-level=high`, `pnpm audit --audit-level high`, `yarn audit --level high` or `yarn npm audit --recursive --severity high`).
