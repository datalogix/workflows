# datalogix/workflows

Claude-powered CI/CD for Datalogix Laravel and JavaScript (Next, Nuxt, SvelteKit, Astro, React Router, Remix, Vue, React and Svelte with Vite, libraries) projects: one workflow file gives every project tests, Claude reviews, safe deploys with automatic rollback, and production errors as issues.

What each project gets:

- **Claude on issues and pull requests**: it plans and implements issues, answers `@claude` and fixes failed checks (tests, Pint, PHPStan, `composer audit`, the Node audit) on its own pull requests.
- **Checks on every pull request**: tests, a Claude code review (once per pull request), a security review and a risk gate that asks for your approval when the change is risky.
- **Safe deploys**: every merge goes to staging, then production, each watched after the deploy and rolled back automatically if it goes down.
- **Production errors as issues**: problems detected by Nightwatch, Sentry or Inspector become GitHub issues with Claude's diagnosis, and you decide to fix or roll back with a label.

Packages call a `package` workflow, the test matrix, and, when they turn them on, `package-claude` in a job of their own (Claude on issues and pull requests, the code review, the security review and the risk gate) and `package-release` in another ([releases](docs/releases.md): the version from the commits, the changelog, the tag, the GitHub release and npm). Packages: Laravel packages, PHP packages without Laravel (`stack: php`, also for Symfony and plain PHP apps; only public Composer packages: the workflows pass no Composer credentials) and JavaScript or TypeScript libraries (`stack: js`).

## Requirements

- [Node.js](https://nodejs.org) 22.12 or newer. The commands run with `npx` straight from this repository at the `v2` tag; `--allow-git=root` lets npm 12 or newer install it from git (it refuses git packages by default) without allowing git for its dependencies.
- The [GitHub CLI](https://cli.github.com), logged in to github.com with `gh auth login`: every command acts as you, always on github.com (`GH_HOST` is ignored).
- Only for monitoring problems as issues: a Cloudflare account, where `org` deploys the monitoring relay (it logs `wrangler` in for you), and macOS or Linux to deploy it and to store each project's webhook secret.

## Quick start

1. **Once per organization** ([organization setup](docs/organization-setup.md)):
   - Required: install the [Claude GitHub App](https://github.com/apps/claude) and generate the Claude token with `claude setup-token`.
   - Optional, as an organization admin and before the projects: run `org` for the shared issue forms and for monitoring problems as issues (setup reads the monitoring relay it deploys). Without it, everything else works.
2. **For each project**, from its folder, run `setup`, then the others when the table says.

All commands run as `npx --allow-git=root github:datalogix/workflows#v2 <command>`:

| Command | When | What it changes |
| --- | --- | --- |
| `org` | Once per organization, optional | The organization's public `.github` repository (issue forms, relay settings) and the relay on Cloudflare |
| `setup` | First for each project, and again whenever you want to change an answer | The workflow file and `CODEOWNERS` in the folder (you commit them), and the repository's labels, environments, secrets and branches on GitHub |
| `check` | Any time | Nothing: it lists what is missing or different |
| `protect` | After the first pull request shows its checks | The branch ruleset that requires those checks |

A project set up before `org` ran misses only the relay: run `setup` again afterwards. The full walkthrough is in [Adding a Laravel app](docs/laravel/app.md), [Adding a Laravel package](docs/laravel/package.md), [Adding a PHP app](docs/php/app.md), [Adding a PHP package](docs/php/package.md), [Adding a JavaScript app](docs/js/app.md) or [Adding a JavaScript library](docs/js/package.md).

> **GitHub Free:** private repositories have no rulesets, so `protect` changes nothing (the checks still run on every pull request, but do not block the merge), and they cannot read organization secrets, so `setup` asks for the Claude token in each project.

The tests of packages require 100% coverage by default (`min-coverage`, read from the Clover report the tests write); apps show it in the job summary and fail only below a `min-coverage` they set: see [Minimum coverage](docs/coverage.md) to configure the report and the minimum.

v1 stays at the `v1` tag and is no longer supported. To move a repository to v2, run `setup` and delete the workflow files that call `@v1`.

## How it works

```
issue ──► Claude plans / implements ──► pull request
                                            │
              tests · code review · security review · risk gate
                                            │
                              you approve (if risky) and merge
                                            │
                     staging (deploy + 3 min watch) ──► production (deploy + 3 min watch)
                                                                   │
                                     health check fails ──► automatic rollback + issue
                                     monitoring problem ──► issue + Claude's diagnosis ──► you: `claude` or `rollback`
```

The project's workflow file only lists the events and permissions; everything else lives here and reaches every project when a release is published. Projects call the workflows pinned to the `v2` tag.

> This repository must stay **public**: public repositories (the packages) can only call reusable workflows stored in public repositories. No secrets live here; they come from the calling repository or organization.

## Documentation

The [documentation index](docs/README.md) lists every guide. The main ones:

| Guide | What it covers |
| --- | --- |
| [Organization setup](docs/organization-setup.md) | Done once: the Claude GitHub App and token (required), then the `org` command for the shared issue forms and the monitoring relay, and the task manager and release GitHub Apps |
| [Adding a Laravel app](docs/laravel/app.md) | For each app: the setup command, what is left to do by hand, the first pull request and deploy, protecting the branch, `check`; [by hand](docs/laravel/app-manual-setup.md) without it |
| [Laravel app tests](docs/laravel/app-tests.md) | What the tests job runs, the project's test scripts, its inputs |
| [Adding a Laravel package](docs/laravel/package.md) | For each package: the setup command, protecting the branch |
| [Laravel package tests](docs/laravel/package-tests.md) | The test matrix, coverage, Pint, the `package.json` scripts and its inputs |
| [Adding a PHP package](docs/php/package.md) / [PHP package tests](docs/php/package-tests.md) | A PHP package without Laravel: the same tests without the Laravel axis |
| [Adding a JavaScript app](docs/js/app.md) | For each app: the setup command, what is left to do by hand, Vercel or Netlify deploys, Sentry, `check`; [by hand](docs/js/app-manual-setup.md) without it |
| [JavaScript app tests](docs/js/app-tests.md) | What the tests job runs and its inputs |
| [Adding a JavaScript library](docs/js/package.md) | For each library: the setup command, protecting the branch |
| [JavaScript library tests](docs/js/package-tests.md) | What the tests job runs and its inputs |
| [Daily use](docs/daily-use.md) | Working with Claude, a feature from issue to production, what to do when something breaks |
| [Verification layers](docs/verification-layers.md) | The eight layers every change goes through, the branch ruleset, solo maintainers, project rules for the security review |
| [Deploy](docs/deploy.md) | Staging and production deploys, health checks, rollbacks and the release history |
| [Production errors](docs/production-errors.md) | Nightwatch, Sentry and Inspector problems as GitHub issues, the relay and how to add another monitoring provider |
| [Reference](docs/reference.md) | The inputs of `project`, `package` and the workflows they call, the events `project` handles, the relay settings |
| [Troubleshooting](docs/troubleshooting.md) | Common problems and what to check |
| [Maintaining this repository](docs/maintaining.md) | Releases, the plugin, CI and dependencies; the [relay](relay/README.md) and the [setup command](cli/README.md) have their own |

## License

MIT, see [LICENSE](LICENSE).
