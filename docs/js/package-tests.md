# JavaScript library tests

The `tests` job of [`package`](../reference.md#package) calls `node-package-tests` when `stack` is `js`. Its check `pipeline / tests / all-checks` is required by the branch ruleset.

The checks are the library's own `package.json` scripts, so CI, your machine and Claude run them the same way. The package manager comes from the lockfile: `pnpm-lock.yaml` (pnpm, through Corepack), `yarn.lock` (Yarn) or `package-lock.json` (npm, with `npm ci`); without a lockfile, `npm install`.

| Job | Runs |
| --- | --- |
| Tests, on each Node version of `node` and each runner of `os` | The `test` script (`test-command` runs another command; `none` skips it). Without a `test` script, or with the one `npm init` writes, nothing runs and the job says so |
| Lint, once, on the Node version of `.nvmrc` or `.node-version` (the current LTS otherwise) | The `typecheck`, `lint` and `build` scripts that exist, then `lint-command`. Each runs even when an earlier one failed, so one run reports every failure. Then the audit: `pnpm audit --audit-level high`, `npm audit --audit-level=high` or `yarn audit --level high` (Yarn 1; `yarn npm audit --recursive --severity high` from Yarn 2), only on pull requests that change the lockfile and on scheduled and manual runs |
| `all-checks` | The required check: fails when either job failed |

## Inputs

Passed to `package` with `stack: js`:

| Input | Default | Description |
| --- | --- | --- |
| `node` | `["22", "24", "26"]` | Node versions the tests run on (JSON) |
| `os` | `["ubuntu-latest"]` | Runners the tests run on (JSON) |
| `test-command` | empty | Empty runs the `test` script; `none` skips the tests |
| `lint-command` | empty | Extra lint command after the `typecheck` and `lint` scripts, e.g. `npx publint` |
| `timeout-minutes` | `30` | Timeout of each job |
| `tests` | `true` | `false` turns the layer off, and its required check with it: run `protect` again |

The Laravel inputs (`php`, `laravel`, `stability`, `pint`, `phpstan`, `coverage`…) are ignored.
