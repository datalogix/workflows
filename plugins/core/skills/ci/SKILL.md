---
name: ci
description: How the Datalogix Claude workflows publish an implemented issue (push the branch, open the PR, comment on the issue). Only for the non-interactive GitHub Actions sessions whose prompt asks to load it; never use it in a local or interactive session, where pushing and opening PRs is the developer's call.
---

# Publishing work in CI

These steps apply only to the non-interactive Claude workflows that ask you to load this skill, on top of `core:conventions`.

When implementing an issue:

1. Commit following the language rules of `core:conventions`.
2. Push the branch.
3. Open the PR with `gh pr create`, with the description `core:conventions` defines. If that is not possible, provide a link to open it manually.
4. Comment on the issue with the PR URL.
