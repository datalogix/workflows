# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Reusable GitHub Actions workflows for Datalogix Laravel projects and packages, plus everything they depend on: composite actions (`.github/actions`), a Claude Code plugin (`plugins/laravel`), a Cloudflare Worker that relays monitoring webhooks (`relay/`) and the `setup` / `check` / `protect` / `org` command (`cli/`). Projects consume it by tag, never by npm package. The repository must stay public (public packages can only call reusable workflows from public repositories) and holds no secrets.

## Commands

```bash
npm ci && npm test                                   # CLI tests + action script tests (Node >= 22.12; bash and jq on PATH)
npm run lint                                         # ESLint + Prettier check
npm run format                                       # Prettier + ESLint --fix
npx vitest run cli/test/setup.test.js                # a single test file
npx vitest run -t "<name>" cli/test/setup.test.js
(cd relay && npm ci && npm test)                     # relay tests (separate package with its own Vitest)
shellcheck -x .github/actions/*/*.sh .github/actions/deploy/*/*.sh   # lint the action scripts
npx -y @anthropic-ai/claude-code plugin validate .   # and plugins/laravel
node cli/index.js setup                              # run the CLI from a project folder against a local clone
```

`actionlint` is run by `ci.yml`, which first rewrites `datalogix/workflows/.github/workflows/*@vN` references in `examples/*.yml`, `project.yml` and `package.yml` to local `./` paths under `.lint/` so inputs and secrets of the called workflows are checked. To lint locally, reproduce that step (the `/actionlint` binary and `.lint/` are gitignored for this).

YAML and Markdown are not formatted (`.prettierignore`); they follow `.editorconfig`.

## Release model (the key constraint)

- Everything reaches projects only when a GitHub release `vX.Y.Z` is published; the `release` workflow moves the major tag `v2`. Projects run `npx --allow-git=root github:datalogix/workflows#v2 <command>` and call workflows `@v2`.
- Internal references are hard-coded to `@v2`: `project.yml` and `package.yml` call the other workflows `@v2`, workflows call `datalogix/workflows/.github/actions/<name>@v2`, `cli/kinds/project/workflow.js` and `cli/kinds/package/workflow.js` have `PROJECT_REF` and `PACKAGE_REF`, the CLI's messages say `#v2` (`SETUP` and `PROTECT` in `cli/lib/evaluate.js`, `HELP` in `cli/lib/args.js` and a few next steps: `grep -rn '#v2' cli`), and examples/docs use `@v2`. Consequently a project pointed at a branch of `project.yml` still runs the *released* nested workflows/actions; to test a change, point the project at the individual workflow or action on the branch.
- Breaking changes (renamed/removed inputs, new required secrets or permissions) require a new major and updating every one of those references together (see `docs/maintaining.md`).
- The plugin ships with the workflows: the `plugins` action returns the repository checkout at the tag as a local marketplace. Plugin and workflows are coupled (e.g. the `[ci-fix]` commit tag written by the `fix-ci` command is what `claude-fix-ci.yml` counts to limit attempts).
- A release does not deploy the relay: the CLI's `org` command deploys the relay of its version (from `relay/src`, with a generated `wrangler.toml`) and stores its settings in `workflows/relay.json` of the organization's public `.github` repository, where setup and check read them (`loadRelayConfig`).

## Architecture

- **`project.yml` is the single entry point for apps.** A project's only workflow file (`examples/project.yml`, written by the CLI as `.github/workflows/datalogix.yml`) calls it with `secrets: inherit`. Each job in `project.yml` checks `github.event_name` and inputs to decide whether to call `claude`, `laravel-app-tests`, `claude-review`, `claude-security-review`, `risk-gate`, `claude-fix-ci`, `deploy`, `release-pr` or `incident`. Packages have their own entry point, `package.yml` (`examples/package.yml`, at the same `.github/workflows/datalogix.yml` path), which calls `laravel-package-tests`. Both entry points take a `stack` input (only `laravel` today): every job checks `inputs.stack == 'laravel'` in its condition, a `stack` job fails the run for an unsupported one, and the Claude workflows get the stack's plugin (`laravel@datalogix`, written as a literal: GitHub compares strings ignoring case, so `inputs.stack` may be spelled `Laravel`).
- **Job names are part of the branch ruleset.** Each layer that can be required has one check: `pipeline / tests / tests`, `pipeline / security / security` and `pipeline / gate / gate` (`PROJECT_CHECKS` in `cli/kinds/project/index.js`; `pipeline` is the calling job in `examples/project.yml`). Packages have `pipeline / tests / all-checks` (`PACKAGE_CHECKS` in `cli/kinds/package/index.js`). `protect` requires only the checks of the layers the workflow file turns on (`checksOn`), and `check` reports a required check whose layer is off. Renaming that job or the jobs in `project.yml` and the called workflows breaks protected projects. Skipped jobs are skipped in the caller, before the reusable workflow expands, so they never satisfy a required check.
- **Action logic lives in shell scripts** (`.github/actions/{deploy,risk-gate,incident,release-pr,security-review}/*.sh`), tested from Node in `.github/actions/test/` with fake `gh`, `curl` and `sleep` executables placed on `PATH` (`fakes.js`: rules matched by regex, `--jq` applied with real `jq`, calls recorded to `calls.jsonl`, calls no rule matched also to `unmatched.jsonl`). Shared helpers live in `.github/actions/lib/` (`language.sh`: `t()` for the fixed pt-BR/en texts; `releases.sh`: the release history read by `deploy` and `incident`; `github.sh`: `gh` reads that tell a 404 apart from an API error, and the collaborator permission; `inputs.sh`: `whole_number`) and are sourced by a path relative to the script, which works because the runner downloads the whole repository at the tag.
- **CLI** (`cli/README.md` has the file map): code specific to a stack and kind lives in `cli/stacks/<stack>/` (`app.js`, `package.js`), chosen by `detectStack`; what `project.yml` and `package.yml` need from any app or package is `cli/kinds/project/` and `cli/kinds/package/` (`projectKind(stack)`, `packageKind(stack)` in their `index.js`, with their workflow file in `workflow.js`, which a stack's `app.js` and `package.js` call with their own part); `cli/lib` holds what every stack shares. `collectState` reads the project once, `setupSteps()` asks questions, `setupTasks()` turns answers into idempotent tasks (`created` / `updated` / `unchanged`), `check`'s `evaluate()` reports what's missing. Commands run without a shell and secrets go through stdin or a private temp file, never argv.
- **Relay**: `/<provider>/<owner>/<repo>` → secret from KV key `<provider>:<owner>/<repo>` → provider `verify` + `normalize` → `repository_dispatch` type `incident`. The provider is chosen by URL only, never from the payload. `relay/src/keys.js` is shared with the CLI.

## When changing a workflow input or requirement

Keep these in sync:
- `docs/reference.md`, the stack's pages (`docs/<stack>/app.md`, `app-manual-setup.md`, `app-tests.md`, `package.md`, `package-tests.md`) and the examples. Docs common to every stack live in `docs/`, indexed by `docs/README.md`.
- For an input projects must choose: a step in the kind's `setupSteps()`, `renderProjectWorkflow()` + `MANAGED`, and `projectAnswers()` (`cli/kinds/project/`; `packageAnswers()` for a package).
- For a new secret, variable, label or permission: read it in the kind's `read` (`readProject()` in `cli/kinds/project/index.js`, called by `collectState()`), a task in that file's `setupTasks()` and an item in its `evaluate()`.
- For an input that turns off a layer with a required check (today `tests`, `security-review`, `risk-gate`), or a new such layer: its check in `PROJECT_CHECKS` or `PACKAGE_CHECKS` (`cli/kinds/<kind>/index.js`) and its flag in `projectAnswers()` or `packageAnswers()`; `protect` and `check` derive the required checks from them.
- `ci` does not exercise `laravel-package-tests`, `laravel-app-tests`, `deploy` or `release-pr` (only its script is unit-tested; the GitHub App token path needs a real project); validate those from a real project pointed at the branch.

## Note on the plugin

`plugins/laravel/skills/conventions/SKILL.md` (team language for commits and PR text, read from "Team language: <value>" in the system prompt, Brazilian Portuguese without it; feature flags, etc.) defines how Claude behaves *in the target Laravel projects*; the workflows' `language` input sets the team language per project. It is not the convention for this repository, where code, docs and commit messages are in English.
