---
description: Read the log of a failed CI run and fix the cause on the PR branch
argument-hint: <run id> <PR number>
---

CI run $1 failed on PR #$2. Fix the cause on the current branch.

1. Read the log of the failed steps with `gh run view $1 --log-failed | tail -n 300`.
2. Read the PR with `gh pr view $2` and its diff with `gh pr diff $2` to understand what changed.
3. Find the cause of the failure and classify it:
   - **Caused by the PR**: fix only what is needed.
   - **Pre-existing, flaky or infrastructure**: do not change code. Comment on the PR explaining the diagnosis and stop.
4. Validate by running locally only what failed (the specific test, Pint or PHPStan check).
5. Commit with the `[ci-fix]` tag at the end of the subject, for example: `fix: corrige validação do formulário de cadastro [ci-fix]`. The tag is used to limit automatic attempts, so never omit it.
6. Push to the current branch. Never create another branch or PR.
7. Comment on the PR with `gh pr comment $2`, explaining the cause and the fix in a few lines.
