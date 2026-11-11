# Documentation

Start with the [organization setup](organization-setup.md), done once: the Claude GitHub App and token, and optionally the `org` command (issue forms, and the monitoring relay for Nightwatch problems as issues), before any project. Then follow the guide for what you are adding.

## By stack

Each stack has the same four pages (plus a manual setup for apps): adding an app, its tests, adding a package, its tests. Laravel apps and packages, PHP apps (Symfony and plain PHP, set up by hand for now) and packages without Laravel, and JavaScript apps (Next, Nuxt, Vue and React built with Vite) and libraries are supported; the `setup` command detects the stack and kind of the folder.

| Stack | App | App tests | Package | Package tests |
| --- | --- | --- | --- | --- |
| Laravel | [Adding a Laravel app](laravel/app.md) ([by hand](laravel/app-manual-setup.md)) | [Laravel app tests](laravel/app-tests.md) | [Adding a Laravel package](laravel/package.md) | [Laravel package tests](laravel/package-tests.md) |
| PHP without Laravel (`php`) | [By hand](php/app-manual-setup.md) (the setup command does not support it yet) | [PHP app tests](php/app-tests.md) | [Adding a PHP package](php/package.md) | [PHP package tests](php/package-tests.md) |
| JavaScript (`js`) | [Adding a JavaScript app](js/app.md) ([by hand](js/app-manual-setup.md)) | [JavaScript app tests](js/app-tests.md) | [Adding a JavaScript library](js/package.md) | [JavaScript library tests](js/package-tests.md) |

## Common to every stack

| Guide | What it covers |
| --- | --- |
| [Organization setup](organization-setup.md) | Done once: the Claude GitHub App, the Claude token, shared issue forms, the monitoring relay, the task manager and release GitHub Apps |
| [Daily use](daily-use.md) | Working with Claude, a feature from issue to production, what to do when something breaks |
| [Verification layers](verification-layers.md) | The eight layers every change goes through, the branch ruleset, solo maintainers, project rules for the security review |
| [Lint](lint.md) | What each tests workflow lints, the script names it runs and the recommended setup for Laravel apps and packages, Next, Nuxt, Vue, React and JavaScript libraries |
| [Minimum coverage](coverage.md) | The coverage the tests require (100% by default in packages, shown without a minimum in apps), how it is checked and how to write the Clover report |
| [Deploy](deploy.md) | Staging and production deploys, health checks, rollbacks and the release history |
| [Production errors](production-errors.md) | Nightwatch, Sentry and Inspector problems as GitHub issues, the relay and how to add another monitoring provider |
| [Task manager](task-manager.md) | How the task manager turns client tasks into GitHub issues, picks up issues labeled `task` and follows them |
| [Claude's conventions and environment](claude.md) | The rules Claude follows, how the project is prepared for it, models and usage limits |
| [Reference](reference.md) | The inputs of `project`, `package` and the workflows they call, the events `project` handles, the relay settings |
| [Troubleshooting](troubleshooting.md) | Common problems and what to check |
| [Maintaining this repository](maintaining.md) | Releases, the plugin, CI and dependencies |

## Adding a stack

A stack adds a folder here with the same four pages (or the two of the kind it supports), `cli/stacks/<stack>/` for the setup command ([cli/README.md](../cli/README.md)), its jobs in `project.yml` and `package.yml` behind the `stack` input, and, when it has apps (the Claude jobs live in `project.yml`), its Claude plugin in `plugins/<stack>`.
