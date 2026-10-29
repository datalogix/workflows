# Documentation

Start with the [organization setup](organization-setup.md), done once: the Claude GitHub App and token, and optionally the `org` command (issue forms, and the monitoring relay for Nightwatch problems as issues), before any project. Then follow the guide for what you are adding.

## By stack

Each stack has the same four pages (plus a manual setup for apps): adding an app, its tests, adding a package, its tests. Only Laravel is supported today; the `setup` command detects the stack and kind of the folder.

| Stack | App | App tests | Package | Package tests |
| --- | --- | --- | --- | --- |
| Laravel | [Adding a Laravel app](laravel/app.md) ([by hand](laravel/app-manual-setup.md)) | [Laravel app tests](laravel/app-tests.md) | [Adding a Laravel package](laravel/package.md) | [Laravel package tests](laravel/package-tests.md) |

## Common to every stack

| Guide | What it covers |
| --- | --- |
| [Organization setup](organization-setup.md) | Done once: the Claude GitHub App, the Claude token, shared issue forms, the monitoring relay, the task manager and release GitHub Apps |
| [Daily use](daily-use.md) | Working with Claude, a feature from issue to production, what to do when something breaks |
| [Verification layers](verification-layers.md) | The eight layers every change goes through, the branch ruleset, solo maintainers, project rules for the security review |
| [Deploy](deploy.md) | Staging and production deploys, health checks, rollbacks and the release history |
| [Production errors](production-errors.md) | Nightwatch problems as GitHub issues, the relay and how to add another monitoring provider |
| [Task manager](task-manager.md) | How the task manager turns client tasks into GitHub issues, picks up issues labeled `task` and follows them |
| [Claude's conventions and environment](claude.md) | The rules Claude follows, how the project is prepared for it, models and usage limits |
| [Reference](reference.md) | The inputs of `project`, `package` and the workflows they call, the events `project` handles, the relay settings |
| [Troubleshooting](troubleshooting.md) | Common problems and what to check |
| [Maintaining this repository](maintaining.md) | Releases, the plugin, CI and dependencies |

## Adding a stack

A stack (php, js, vue, nuxt) adds a folder here with the same four pages, `cli/stacks/<stack>/` for the setup command ([cli/README.md](../cli/README.md)), its jobs in `project.yml` and `package.yml` behind the `stack` input, and its Claude plugin in `plugins/<stack>`.
