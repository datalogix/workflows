# Maintaining this repository

## Releases

Repositories call the workflows with `@v2`, so changes on `main` reach them only when a release is published:

1. Merge the changes into `main` and make sure `ci` passes.
   - `ci` does not run `laravel-package-tests`, `laravel-app-tests`, `deploy` or `release-pr` (only its script is unit tested; the GitHub App token path needs a real project). When they change, first point a package or project at the branch (`laravel-package-tests.yml@<branch>`: `package.yml` still calls the released `laravel-package-tests`) and open a test pull request there.
   - The scripts of `risk-gate`, `deploy`, `incident` and `release-pr` live in [`.github/actions`](../.github/actions) and are unit tested by `ci`. The workflows call those actions with `@v2`, so to try a script change in a project, also point the action references in the workflow at the branch.
2. Publish a GitHub release tagged `vX.Y.Z` (for example `v2.1.0`). The `release` workflow moves the major tag (`v2`) to it when it is the newest release of that major (a hotfix of an older minor or a re-run of an old release leaves `v2` where it is), also when a pre-release is promoted; other tag formats are rejected. Re-running it is safe.

Breaking changes (renamed or removed inputs, new required secrets or permissions) need a new major version. In that case, also update the references to the actions in `.github/actions` (`setup-laravel@v2`, `deploy@v2` and the others) inside the workflows, the workflow references in `project.yml` and `package.yml`, and the `@v2` in the examples, the docs and the setup command.

`project.yml` and `package.yml` call the other workflows with `@v2`, not with the ref they were called with, so a project pointing at a branch of `project.yml` still runs the released versions of the other workflows. To test changes to them, point a project at the individual workflows on the branch.

## The Claude plugin is released with the workflows

The workflows install the `core` plugin and the plugin of the project's stack (`laravel`) through the [`plugins`](../.github/actions/plugins/action.yml) action, called with `@v2` like the other actions. The runner downloads the whole repository at that tag, and the action returns its path as a local marketplace (the Claude Code action does not accept a ref in marketplace URLs). Changes to [`plugins/`](../plugins) therefore reach projects only when a release moves the tag, together with the workflows that depend on them: for example, the `[ci-fix]` commit tag required by the `fix-ci` command is what `claude-fix-ci` counts to limit attempts.

To try a plugin change in a project before releasing it, point the `plugins@v2` reference of the workflow at the branch (`plugin-marketplaces` only adds marketplaces next to this repository's, so it cannot replace the released plugin). Your local Claude Code still installs the plugin from the marketplace URL, that is, from the default branch.

## The relay and the setup command

Both live here and have their own README, for working on them:

- [`relay`](../relay/README.md) runs on Cloudflare Workers. A release does not deploy it: `org` deploys the relay of its version, so after a release that changes it, run `org` and say yes to updating the relay.
- [`cli`](../cli/README.md) is released with the workflows: projects run it from the `v2` tag.

## CI

[`ci.yml`](../.github/workflows/ci.yml) runs on every pull request and push to `main`:

- **lint**: `actionlint` on the workflows, on the examples and on `project.yml` and `package.yml` (pointed at the local workflows, so their inputs and secrets are checked too), `shellcheck` on the scripts of the actions, the tests of the relay, of the setup command and of the action scripts (with fake `gh`, `curl` and `sleep`), `claude plugin validate` on the marketplace and the plugin, ESLint and Prettier (`npm run lint`).
- **setup-laravel**: creates a fresh Laravel app and runs the action across PHP, Node and package manager versions, with and without Laravel Boost, then checks the environment, starts the Boost MCP server and runs the app's tests.
- **all-checks**: passes only when every job above passed. It is the required status check of the `main` branch protection, so it does not depend on the matrix job names.

A new push to a pull request cancels its previous run; runs on `main` always finish.

## Working locally

- `npm ci && npm test`: tests of the setup command and of the action scripts (Node 22.12+, required by Vitest; the action script tests need `bash` and `jq` on `PATH`).
- `npm run lint` (ESLint and Prettier) and `npm run format` to fix formatting and lint errors.
- `(cd relay && npm ci && npm test)` and `shellcheck -x .github/actions/*/*.sh .github/actions/deploy/*/*.sh` (`-x` follows the shared `lib/` scripts they source).

## Dependencies

Actions are referenced by their major version tag (`actions/checkout@v7`), so minor and patch releases apply automatically. Dependabot opens a single grouped pull request when a new major version is released. The npm dependencies (root and `relay/`) get one grouped pull request per directory each month. The `actionlint` version in `ci.yml` is not covered and must be bumped manually.
