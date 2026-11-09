---
name: conventions
description: Datalogix conventions for every project (language, commits, scope, validation limits, review rounds and the pull request description), with the stack's own conventions skill (e.g. laravel:conventions) for its tools and practices. Use before changing code, creating commits, opening PRs or replying on issues and PRs.
---

# Datalogix conventions

These rules apply to every project. The stack's conventions skill (e.g. `laravel:conventions`, `js:conventions`) adds its practices and the checks of the pre-PR verification; load both.

## Language

- The team language is the one the system prompt names (`Team language: <language>`); without one, it is **Brazilian Portuguese**.
- Everything you write for the team is in the team language: issue and PR comments, PR titles and descriptions, commit messages.
- Use Conventional Commits with the type in English (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`, `build`, `ci`) and the description in the team language.
  - Example: `feat: adiciona autenticação via OAuth`
- Section names and fixed phrases in these instructions and in the Datalogix commands (**Resumo**, **Observações**, "problema pré-existente, fora do escopo") are in Brazilian Portuguese: in another team language, write them translated.

## Implementation

- Implement only what the task needs.
- Reuse the architecture, patterns and components that already exist in the project.
- Keep the solution as small as possible.
- When working on an existing PR, commit directly to its branch. Do not create a new branch or a new PR.

## Validation

Keep validation scoped:

- Run only the checks and tests relevant to your change, not the full suite, with the project's own scripts (the stack's skill says which).
- Fix **only** failures caused by your change.
- Do not fix pre-existing failures unrelated to your change. List them in the PR description as "problema pré-existente, fora do escopo".
- If a failure caused by you persists after **2 fix attempts**, stop. Document in the PR what you tried and why it was not resolved, then continue with the rest of the task.
- Never loop through edit-and-validate cycles without a limit.

## Pre-PR verification

Before opening a PR or pushing to one, run the checks the stack's skill lists on what you changed, and fix what your change broke. Never open a PR while one of them fails because of your change without saying so in **Observações**. Never skip, disable or weaken a check (lower a level, add ignores, mark tests as skipped) to make it pass.

## Review rounds

- Your review comments and approvals never replace a human approval. Do not approve PRs.
- When asked to change a PR, first check how many rounds of requested changes it already went through (review comments followed by fix commits). If this would be the **4th round**, do not patch again: comment on the PR explaining the recurring problem, propose a different approach and stop.

## Pull requests

A PR description is in the team language and contains these sections:

- **Resumo**
- **Motivação** (reference the issue with `Closes #<number>` when there is one)
- **Plano de Testes** (the commands you actually ran in the pre-PR verification and their results)
- **Observações** (pre-existing or unresolved failures, if any)
