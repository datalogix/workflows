---
name: conventions
description: Datalogix conventions for Laravel projects (language, commits, scope, feature flags, migrations, tests, validation, review rounds and pull requests). Use before changing code, creating commits, opening PRs or replying on issues and PRs.
---

# Datalogix conventions

## Language

- The team language is the one the system prompt names (`Team language: <language>`); without one, it is **Brazilian Portuguese**.
- Everything you write for the team is in the team language: issue and PR comments, PR titles and descriptions, commit messages.
- Use Conventional Commits with the type in English (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`, `build`, `ci`) and the description in the team language.
  - Example: `feat: adiciona autenticação via OAuth`
- Section names and fixed phrases in these instructions and in the laravel commands (**Resumo**, **Observações**, "problema pré-existente, fora do escopo") are in Brazilian Portuguese: in another team language, write them translated.

## Implementation

- Implement only what the task needs.
- Reuse the architecture, patterns and components that already exist in the project.
- Keep the solution as small as possible.
- When working on an existing PR, commit directly to its branch. Do not create a new branch or a new PR.

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

Keep validation scoped:

- Run Laravel Pint, if available, only on the files you changed (`vendor/bin/pint <files>`).
- Run PHPStan, if available, only on the files you changed, not the whole codebase.
- Run only the tests relevant to your change, not the full suite.
- Use the project's scripts to learn how it runs its tools: read `scripts` in `composer.json` (`test`) and `package.json` (`typecheck`, `lint`, `test`) and use the same runner and options, filtered to your change (e.g. `php artisan test --filter=<Test>`, `npm run test -- <file>`). Fall back to `php artisan test`, `vendor/bin/pest` or `vendor/bin/phpunit` when there is no script.
- Fix **only** failures caused by your change.
- Do not fix pre-existing failures unrelated to your change. List them in the PR description as "problema pré-existente, fora do escopo".
- If a failure caused by you persists after **2 fix attempts**, stop. Document in the PR what you tried and why it was not resolved, then continue with the rest of the task.
- Never loop through edit-and-validate cycles without a limit.

## Pre-PR verification

Before opening a PR or pushing to one, run on what you changed and fix what your change broke:

1. Laravel Pint on the changed PHP files.
2. PHPStan on the changed PHP files.
3. The tests related to the change (PHP, and JavaScript/TypeScript through the `test` script of `package.json` when you changed frontend code).
4. The `typecheck` and `lint` scripts of `package.json`, when they are defined and you changed frontend code.
5. `composer audit --locked` if you changed `composer.lock`, and the audit of the Node lockfile you changed (`npm audit --audit-level=high`, `pnpm audit --audit-level high`, `yarn audit --level high` or `yarn npm audit --recursive --severity high`).

Never open a PR while one of these fails because of your change without saying so in **Observações**. Never skip, disable or weaken a check (lower a PHPStan level, add ignores, mark tests as skipped) to make it pass.

## Review rounds

- Your review comments and approvals never replace a human approval. Do not approve PRs.
- When asked to change a PR, first check how many rounds of requested changes it already went through (review comments followed by fix commits). If this would be the **4th round**, do not patch again: comment on the PR explaining the recurring problem, propose a different approach and stop.

## Pull requests

When implementing an issue:

1. Commit following the language rules above.
2. Push the branch.
3. Open the PR with `gh pr create`. If that is not possible, provide a link to open it manually.
4. The PR description must be in the team language and contain these sections:
   - **Resumo**
   - **Motivação** (reference the issue with `Closes #<number>`)
   - **Plano de Testes** (the commands you actually ran in the pre-PR verification and their results)
   - **Observações** (pre-existing or unresolved failures, if any)
5. Comment on the issue with the PR URL.
