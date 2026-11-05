---
description: Read the log of a failed CI run and fix the cause on the PR branch
argument-hint: <run id> <PR number>
---

CI run $1 failed on PR #$2. Fix the cause on the current branch.

1. Read the log of the failed tests. The run may still be in progress, so read the failed jobs one by one:
   - List them with `gh api repos/{owner}/{repo}/actions/runs/$1/jobs --paginate --jq '.jobs[] | select(.conclusion == "failure") | "\(.id) \(.name)"'`.
   - Read each test job's log with `gh api repos/{owner}/{repo}/actions/jobs/<job id>/logs | tail -n 300`.
   - Only fix failures of the tests job: Pint, PHPStan, the PHP tests, the `typecheck`, `lint` and `test` scripts of `package.json`, `composer audit` and the Node audit. Failures of the security review or the risk gate are not yours to fix: ignore them.
   - If no log can be read, reproduce the failure locally by running those same checks on what the PR changed.
2. Read the PR with `gh pr view $2` and its diff with `gh pr diff $2` to understand what changed.
3. Find the cause of the failure and classify it:
   - **Caused by the PR**: fix only what is needed.
   - **Pre-existing, flaky or infrastructure**: do not change code. If an earlier comment on the PR (`gh pr view $2 --comments`) already gives this diagnosis, stop; otherwise comment on the PR, in the team language (see the core:conventions skill), explaining it and stop.
4. Validate by running locally only what failed (the specific test, Pint, PHPStan, `package.json` script, `composer audit` or Node audit).
5. Commit with the `[ci-fix]` tag at the end of the subject, for example: `fix: corrige validação do formulário de cadastro [ci-fix]`. The tag is used to limit automatic attempts, so never omit it.
6. Push to the current branch. Never create another branch or PR.
7. Comment on the PR with `gh pr comment $2`, in the team language (see the core:conventions skill), explaining the cause and the fix in a few lines.
