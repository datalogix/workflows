# JavaScript app tests

The `tests` job of [`project`](../reference.md#project) calls `node-app-tests` when `stack` is `js`, and its check `pipeline / tests / tests` is required by the [branch ruleset](../verification-layers.md#branch-ruleset).

A single job, on the Node version of `.nvmrc` or `.node-version` (the current LTS otherwise), runs the app's own `package.json` scripts, so CI, your machine and Claude run them the same way. The package manager comes from the lockfile (pnpm through Corepack, Yarn or npm). Each step runs even when an earlier one failed, so one run reports every failure:

1. `typecheck` (or `types:check`, `type-check`), then `lint` (or `check`), then `lint-command`. The typecheck and lint scripts must only check: the job fails when they change a tracked file. Recommended scripts for Next and Nuxt: [Lint](../lint.md).
2. `test` (`test-command` runs another command; `none` skips it). The test script `npm init` writes is ignored. The job summary shows its coverage, read from the Clover report it writes, and with `min-coverage` set it must cover at least that percent of the code: see [Minimum coverage](../coverage.md). Without a `test` script or a report, the run only notes it, unless `min-coverage` is set.
3. `build`: Next and Nuxt report rendering and route errors only when they build.
4. `test:e2e`, after the build and only when it did not fail, with `CI=true`. When `package.json` requires Playwright, its browsers are installed first (`playwright install --with-deps`, which adds a few minutes); other runners (Cypress) install their own binary with the dependencies. The script starts the app itself, for example with Playwright's `webServer`. `e2e: false` turns it off.
5. The audit (`pnpm audit --audit-level high`, `npm audit --audit-level=high` or `yarn audit`/`yarn npm audit`), only on pull requests that change the lockfile and on scheduled and manual runs.

A script that does not exist is skipped.

## Inputs

Passed to `project` with `stack: js`:

| Input | Default | Description |
| --- | --- | --- |
| `node-version` | empty | Node version; empty reads `.nvmrc` or `.node-version`, otherwise the current LTS |
| `test-command` | empty | Empty runs the `test` script; `none` skips the unit tests |
| `min-coverage` | `0` | Minimum coverage of the unit tests; the coverage is shown either way, and `0` never fails. See [Minimum coverage](../coverage.md) |
| `lint-command` | empty | Extra lint command after the `typecheck` and `lint` scripts, e.g. `composer install --no-interaction && composer lint` for PHP tooling |
| `e2e` | `true` | Run the `test:e2e` script after the build |
| `tests` | `true` | `false` turns the layer off, and its required check with it: run `protect` again |

The Laravel inputs (`php-version`, `pint`, `phpstan`, `js`) are ignored.
