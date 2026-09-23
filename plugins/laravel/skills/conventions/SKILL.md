---
name: conventions
description: Datalogix conventions for Laravel projects (language, commits, scope, tests, validation and pull requests). Use before changing code, creating commits, opening PRs or replying on issues and PRs.
---

# Datalogix conventions

## Language

- Everything you write for the team is in **Brazilian Portuguese**: issue and PR comments, PR titles and descriptions, commit messages.
- Use Conventional Commits with the type in English (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`, `build`, `ci`) and the description in Portuguese.
  - Example: `feat: adiciona autenticação via OAuth`

## Implementation

- Implement only what the task needs.
- Reuse the architecture, patterns and components that already exist in the project.
- Keep the solution as small as possible.
- When working on an existing PR, commit directly to its branch. Do not create a new branch or a new PR.

## Tests

- Create or update automated tests **only** if the project already has real tests beyond Laravel's scaffold tests (`tests/Feature/ExampleTest.php`, `tests/Unit/ExampleTest.php`).
- If the project only has those scaffold tests, do not create new tests.

## Validation

Keep validation scoped:

- Run Laravel Pint, if available, only on the files you changed (`vendor/bin/pint <files>`).
- Run PHPStan, if available, only on the files you changed, not the whole codebase.
- Run only the tests relevant to your change, not the full suite.
- Fix **only** failures caused by your change.
- Do not fix pre-existing failures unrelated to your change. List them in the PR description as "problema pré-existente, fora do escopo".
- If a failure caused by you persists after **2 fix attempts**, stop. Document in the PR what you tried and why it was not resolved, then continue with the rest of the task.
- Never loop through edit-and-validate cycles without a limit.

## Pull requests

When implementing an issue:

1. Commit following the language rules above.
2. Push the branch.
3. Open the PR with `gh pr create`. If that is not possible, provide a link to open it manually.
4. The PR description must be in Portuguese and contain these sections:
   - **Resumo**
   - **Motivação** (reference the issue with `Closes #<number>`)
   - **Plano de Testes**
   - **Observações** (pre-existing or unresolved failures, if any)
5. Comment on the issue with the PR URL.
