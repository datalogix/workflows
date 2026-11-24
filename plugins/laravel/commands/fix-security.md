---
description: Fix the open security findings of a pull request on its branch, with a regression test for each (commits and pushes; meant for the claude-fix-security workflow)
argument-hint: <PR number> <findings file>
---

The security review found problems in PR #$1 that are still open. Fix them on the current branch.

1. Read `$2`: a JSON array of the open findings, each with `id`, `severity`, `category`, `file`, `line`, `title`, `description` and `recommendation`.
2. Read the PR with `gh pr view $1` and its diff with `gh pr diff $1`. If `.github/security-review.md` exists, read it: it holds this project's rules, accepted risks and known false positives.
3. For each finding, check it against the current code:
   - **Real**: fix it with the smallest change that removes the vulnerability, following the recommendation unless the code shows a better way, and add a test that fails without the fix (a regression test), where the project has real tests.
   - **False positive** (protected elsewhere, or not reachable): do not change code for it; say why in the comment of step 7, so someone can record it in `.github/security-review.md`.
4. Change only what the findings need: no refactoring, no other fixes.
5. Validate by running the checks of the pre-PR verification of the laravel:conventions skill on what you changed (Pint, PHPStan, Rector and the related tests).
6. Commit with the `[security-fix]` tag at the end of the subject, for example: `fix: restringe a fatura ao cliente dono [security-fix]`. The tag limits the automatic attempts, so never omit it. Push to the current branch. Never create another branch or PR.
7. Comment on the PR with `gh pr comment $1`, in the team language (see the core:conventions skill): for each finding by its number, what you fixed and the test you added, or why it is a false positive. The next security review checks the findings again.
