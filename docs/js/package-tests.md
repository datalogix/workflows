# JavaScript library tests

The `tests` job of [`package`](../reference.md#package) calls `node-package-tests` when `stack` is `js`. Its check `pipeline / tests / all-checks` is required by the branch ruleset.

The checks are the library's own `package.json` scripts, so CI, your machine and Claude run them the same way. The package manager comes from the lockfile: `pnpm-lock.yaml` (pnpm, through Corepack), `yarn.lock` (Yarn) or `package-lock.json` (npm, with `npm ci`); without a lockfile, `npm install`, with a warning, since nothing pins the versions.

| Job | Runs |
| --- | --- |
| Tests, on each Node version of `node` and each runner of `os` | The `test` script (`test-command` runs another command; `none` skips it). Without a `test` script, or with the one `npm init` writes, nothing runs and the job says so. On the first runner of `os`, the coverage must reach `min-coverage` (see [Minimum coverage](../coverage.md)); without tests, that check fails unless `min-coverage` is 0 |
| Lint, once, on the Node version of `.nvmrc` or `.node-version` (the current LTS otherwise) | The `typecheck` (or `types:check`, `type-check`), `lint` (or `check`) and `build` scripts that exist, then `lint-command`. The typecheck and lint scripts must only check: the job fails when they change a tracked file (see [Lint](../lint.md)). Each runs even when an earlier one failed, so one run reports every failure. Then the audit: `pnpm audit --audit-level high`, `npm audit --audit-level=high` or `yarn audit --level high` (Yarn 1; `yarn npm audit --recursive --severity high` from Yarn 2), only on pull requests that change the lockfile and on scheduled and manual runs |
| `all-checks` | The required check: fails when either job failed |

## Inputs

Passed to `package` with `stack: js`:

| Input | Default | Description |
| --- | --- | --- |
| `node` | `["22", "24", "26"]` | Node versions the tests run on (JSON) |
| `os` | `["ubuntu-latest"]` | Runners the tests run on (JSON) |
| `test-command` | empty | Empty runs the `test` script; `none` skips the tests |
| `min-coverage` | `100` | Minimum coverage of the tests; `0` turns the check off. See [Minimum coverage](../coverage.md) |
| `lint-command` | empty | Extra lint command after the `build` script, e.g. `npx publint && npx attw --pack .`, or `composer install --no-interaction && composer lint` for PHP tooling |
| `timeout-minutes` | `30` | Timeout of each job |
| `tests` | `true` | `false` turns the layer off, and its required check with it: run `protect` again |

The Laravel inputs (`php`, `laravel`, `stability`, `pint`, `phpstan`, `coverage`…) are ignored.

## Published package

With `api-check: true` (setup asks; `--api-check`), the lint job runs [`publint`](https://publint.dev) and [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) after the build: `exports`, `files`, `main` and `types` that point to missing files, entry points whose types do not resolve in every module system, and a package that would publish without what it builds. They check what is published, not whether the API changed: Claude's review covers that.
