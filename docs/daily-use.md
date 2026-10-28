# Daily use

## Working with Claude

| You do                                                  | Claude does                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open an issue with the **Tarefa para o Claude** form, or add the `claude` label | Creates a `claude/<number>-<title>-<date>` branch, implements the issue and opens a pull request                         |
| Open an issue with **Planejar com o Claude**, or add `claude-plan` | Posts an implementation plan (understanding, affected files, approach, risks, open questions, size) without changing code, then removes the label |
| Comment `@claude <request>` on an issue or pull request | Replies, or commits the change to the pull request branch                                                                                         |
| — (every pull request)                                  | Reviews the code once, when opened, reopened or ready for review, except drafts, forks, Dependabot, Renovate, pull requests labeled `no-review` and the release and sync pull requests of a [production branch](deploy.md#production-branch) |
| — (every pull request)                                  | Reviews its security and blocks it on high-severity findings                                                                                      |
| — (every pull request)                                  | Labels it `risk:low`, `risk:medium` or `risk:high` and blocks it until it has the approvals that risk requires                                    |
| — (tests fail on a `claude/*` branch)                   | Reads the log and pushes a fix, up to 2 attempts per pull request, then asks for human review                                                     |

Only users with write access to the repository (write, maintain or admin) can trigger Claude, with `@claude`, a label or an assignment; for anyone else the run ends with a notice. The `claude-plan` label only needs triage access. On an issue, only the labels start Claude: mentioning `@claude` in its title or body does nothing, so an issue can talk about Claude without triggering it. `claude-plan` takes precedence over `claude`: an issue with both (or that gets `claude` while it is being planned) is only planned, and both labels are removed; add `claude` again after reading the plan to implement it. An implementation already started before `claude-plan` was added keeps running.

## A new feature, step by step

1. Open an issue with **Planejar com o Claude**. Use the plan for anything larger than a small change.
2. Read the plan, answer the open questions in the issue and adjust what you need.
3. Add the `claude` label. Claude implements it and opens a pull request.
4. The checks run. If the tests fail, Claude tries to fix them.
5. Low-risk pull requests can be merged as soon as the checks pass. Medium and high risk ones wait for your approval: review, ask for changes with `@claude` if needed, approve and merge.
6. The merge deploys to staging and then production. With a [production branch](deploy.md#production-branch), it deploys staging and adds the change to the release pull request; merging that pull request deploys production.

## When something goes wrong in production

| What happened | What you get | What you do |
| --- | --- | --- |
| The app goes down right after a deploy | The deploy is rolled back automatically and an issue explains what happened | Fix it: open an issue for Claude or add `claude-plan` to that one |
| Nightwatch detects an error or a slow route | An `incident` issue with Claude's diagnosis and recommendation | Add `claude` to fix it, `rollback` to go back to the previous release now, or close the issue |
| You want to undo the last deploy | — | Add `rollback` to an issue labeled `env:production` or `env:staging` (add both labels to an issue of your own) |
