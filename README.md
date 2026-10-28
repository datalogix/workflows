# datalogix/workflows

Reusable GitHub Actions workflows, the composite actions they use, a Claude Code plugin, a monitoring relay and a setup command used across Datalogix repositories.

A Laravel project adds **one workflow file** and gets:

- **Claude on issues and pull requests**: it plans and implements issues, answers `@claude` and fixes failed checks (tests, Pint, PHPStan, `composer audit`) on its own pull requests.
- **Checks on every pull request**: tests, a Claude code review (once per pull request), a security review and a risk gate that asks for your approval when the change is risky.
- **Safe deploys**: every merge goes to staging, then production, each watched after the deploy and rolled back automatically if it goes down.
- **Production errors as issues**: problems detected by Nightwatch become GitHub issues with Claude's diagnosis, and you decide to fix or roll back with a label.

Packages call a single `package` workflow, today the test matrix. Only public Composer packages are supported: the workflows pass no Composer credentials.

## Quick start

1. **Once per organization**, follow the [organization setup](docs/organization-setup.md): install the Claude GitHub App and generate the Claude token. For the shared issue forms and for Nightwatch problems as issues, an organization admin also runs `org`, before the projects (setup reads the monitoring relay it deploys):

   ```bash
   npx --allow-git=root github:datalogix/workflows#v2 org       # optional: issue forms, monitoring relay
   ```

2. **For each project**, from its folder:

   ```bash
   npx --allow-git=root github:datalogix/workflows#v2 setup     # asks a few questions and sets the project up
   npx --allow-git=root github:datalogix/workflows#v2 check     # lists what is missing, without changing anything
   npx --allow-git=root github:datalogix/workflows#v2 protect   # protects the default branch, after the first pull request
   ```

Without `org`, everything else works: tests, reviews, the risk gate and deploys. A project set up before `org` ran misses only the relay: run `setup` again afterwards.

The full walkthrough is in [Adding a Laravel app](docs/laravel/app.md) or [Adding a Laravel package](docs/laravel/package.md).

v1 stays at the `v1` tag and is no longer supported. To move a repository to v2, run `setup` and delete the workflow files that call `@v1`.

## How it works

```
issue ──► Claude plans / implements ──► pull request
                                            │
              tests · code review · security review · risk gate
                                            │
                              you approve (if risky) and merge
                                            │
                     staging (deploy + 10 min watch) ──► production (deploy + 10 min watch)
                                                                   │
                                     health check fails ──► automatic rollback + issue
                                     Nightwatch problem ──► issue + Claude's diagnosis ──► you: `claude` or `rollback`
```

The project's workflow file only lists the events and permissions; everything else lives here and reaches every project when a release is published. Projects call the workflows pinned to the `v2` tag.

> This repository must stay **public**: public repositories (the packages) can only call reusable workflows stored in public repositories. No secrets live here; they come from the calling repository or organization.

## Documentation

The [documentation index](docs/README.md) lists every guide. The main ones:

| Guide | What it covers |
| --- | --- |
| [Organization setup](docs/organization-setup.md) | Done once: the Claude GitHub App, the Claude token, shared issue forms, the monitoring relay, the task manager and release GitHub Apps |
| [Adding a Laravel app](docs/laravel/app.md) | For each app: the setup command, what is left to do by hand, the first pull request and deploy, protecting the branch, `check`; [by hand](docs/laravel/app-manual-setup.md) without it |
| [Laravel app tests](docs/laravel/app-tests.md) | What the tests job runs, the project's test scripts, its inputs |
| [Adding a Laravel package](docs/laravel/package.md) | For each package: the setup command, protecting the branch |
| [Laravel package tests](docs/laravel/package-tests.md) | The test matrix, coverage, Pint and its inputs |
| [Daily use](docs/daily-use.md) | Working with Claude, a feature from issue to production, what to do when something breaks |
| [Verification layers](docs/verification-layers.md) | The eight layers every change goes through, the branch ruleset, solo maintainers, project rules for the security review |
| [Deploy](docs/deploy.md) | Staging and production deploys, health checks, rollbacks and the release history |
| [Production errors](docs/production-errors.md) | Nightwatch problems as GitHub issues, the relay and how to add another monitoring provider |
| [Reference](docs/reference.md) | The inputs of `project`, `package` and the workflows they call, the events `project` handles, the relay settings |
| [Troubleshooting](docs/troubleshooting.md) | Common problems and what to check |
| [Maintaining this repository](docs/maintaining.md) | Releases, the plugin, CI and dependencies; the [relay](relay/README.md) and the [setup command](cli/README.md) have their own |

## License

MIT, see [LICENSE](LICENSE).
