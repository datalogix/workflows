# Verification layers

Every change made by Claude, or by a person, goes through the same layers before reaching users. Each layer is a workflow or a rule, so it does not depend on anyone remembering it.

| Layer                                | How it is enforced                                                                                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Pre-PR verification**           | The `laravel` plugin makes Claude run Pint, PHPStan, the related tests, the `typecheck` and `lint` scripts (when it changes frontend code) and `composer audit` (when `composer.lock` changes) before opening or updating a pull request, and list what it ran under _Plano de Testes_ (or its translation in another team language). Locally, the same plugin applies to your Claude Code. |
| **2. Mandatory CI**                  | `laravel-app-tests` (projects) or `laravel-package-tests` (packages, through `package`), required by the branch ruleset. `claude-fix-ci` fixes failures on Claude's branches, up to 2 attempts.                                                                                                |
| **3. Claude code review**            | `claude-review` runs the `code-review` plugin, which reviews in parallel and filters findings by confidence. Its comments are advice: a bot review never counts as an approval.                                                                                       |
| **4. Security review**               | `claude-security-review` runs a Laravel-specific security review (authorization, mass assignment, injection, XSS, validation, authentication, secrets, data exposure, dependencies) and fails on findings at or above `fail-on`. `laravel-app-tests` runs `composer audit`. |
| **5. Risk-based approval**           | `risk-gate` classifies the pull request by the paths and lines it changes and requires 0, 1 or 1 human approvals (low, medium, high) of the current changes from people with write access; set `approvals-high: 2` with a team. A push that changes the diff requires a new approval; merging or rebasing onto a newer base does not, unless the base changed the files the pull request changes before or next to its changes.                        |
| **6. Merge queue**                   | The ruleset requires branches to be up to date, or a merge queue where your plan offers it.                                                                                                                                                                        |
| **7. Internal pre-release**          | Every merge is deployed to `staging` and watched before it can reach production (with a [production branch](deploy.md#production-branch), except hotfixes). In production, new behavior stays behind a Laravel Pennant flag enabled only for internal users, which the `laravel` plugin creates.                                               |
| **8. Phased release**                | Production is deployed only after staging stays healthy (with a [production branch](deploy.md#production-branch), on each push to it: merge the release pull request once staging is healthy), and is watched in turn: when its health checks fail, the last good release is redeployed and an issue is opened. Users get new behavior in stages (internal, a share with `Lottery`, everyone), one pull request per stage. Migrations stay compatible with the previous release so a rollback is always possible. |

Loop limits keep the automation from spinning: `claude-fix-ci` stops after 2 attempts, and Claude stops patching a pull request after 3 rounds of requested changes and proposes a different approach instead.

## Branch ruleset

The ruleset created in [step 5](laravel/app.md#step-5-protect-the-default-branch) is what turns the checks into requirements. It requires only the checks of the layers that are on (`tests`, `security-review`, `risk-gate`): a layer that is off never reports its check. With `examples/project.yml` the checks are named `pipeline / <job> / <job>`; adjust them if you rename the calling job.

- **Bypass**: repository admins (`actor_id: 5`) can merge a pull request whose checks fail. Use it for confirmed false positives and emergencies, and record security false positives in `.github/security-review.md` so the next review does not report them again.
- **Code owners**: the checks are configured in the project's workflow file, and a pull request runs with its own version of that file, so it could lower its own checks (`approvals-high: 0`, `security-fail-on: none`). In team projects, the ruleset requires the approval of the code owners of `.github/`, given after the last push (set by setup in `.github/CODEOWNERS`; GitHub reads it from the default branch, so a pull request cannot change it for itself). Solo maintainers do not need it: nobody else can open pull requests, and Claude cannot change workflow files.
- **Required workflows have no `paths` filters**: a required check that never runs leaves the pull request waiting forever. The workflows skip themselves instead (drafts, forks, Dependabot, merge queue runs), and a skipped job counts as passed.
- **Pull requests from forks** get no secrets, so the Claude code review and security review skip themselves and their checks pass without a review, and `@claude` comments on them are ignored (the fork's code would run with write access and the Claude token). The tests and the risk gate still run. A medium- or high-risk change needs the approval the gate requires, the only review it gets: read it with security in mind before approving. A low-risk one (only tests and docs by default) needs no approval with `approvals-low: 0`, so nobody reviews it but whoever merges it.
- **Merge queue**: where your plan offers it, enable it in the ruleset and keep the `merge_group` trigger in the calling workflow (`examples/project.yml` already has it). `strict_required_status_checks_policy` can then be turned off.
- **Packages** require only `pipeline / tests / all-checks`.
- **Private repositories on GitHub Free** have no rulesets or branch protection: the checks run and show on every pull request but do not block the merge, and anyone with write access can push, also to the branch that deploys production (after its tests). `protect` explains this and changes nothing, `check` warns about it. GitHub Team (or Pro), or a public repository, lifts the limit.

## Solo maintainers

GitHub does not let authors approve their own pull requests. Pull requests opened by Claude are authored by `claude[bot]`, so you approve them normally. For pull requests you open yourself, `count-author: true` makes you count as the reviewer of your own code (you need write access), which is what you are when no one else reviews.

## Project rules for the security review

The security review reads `.github/security-review.md` from the project, when it exists, before reviewing each pull request. Use it for what only that project knows:

- **Not vulnerabilities**: things that look unsafe in a diff but are protected elsewhere.
- **Accepted risks**: real issues you decided to accept.
- **Extra care**: areas where any doubt should be reported.

```markdown
# Security review notes

## Not vulnerabilities
- Routes in `routes/webhooks.php` have no user authentication on purpose: `VerifyWebhookSignature` checks the provider's signature on every request.

## Accepted risks
- `/horizon` is reachable without the `viewHorizon` gate in staging; staging is behind Forge's HTTP basic auth.

## Extra care
- Everything under `app/Billing` handles payments: report any missing authorization or validation there.
- Every query on `Invoice`, `Customer` and `Order` must be scoped to the current tenant.
```

Most projects never need it: create it when the review blocks a pull request for something that is not a problem there. Rules that apply to every project belong in the central checklist, [`plugins/laravel/commands/security-review.md`](../plugins/laravel/commands/security-review.md), and reach every project without copying anything.
