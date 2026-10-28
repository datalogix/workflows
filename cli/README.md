# Setup command

The `setup`, `check` and `protect` commands that configure Datalogix projects for these workflows, and `org`, which sets up what every project of an organization shares. An organization admin may run `org` once, first (optional: issue forms and the monitoring relay); then projects run the others, e.g.:

```bash
npx --allow-git=root github:datalogix/workflows#v2 org
npx --allow-git=root github:datalogix/workflows#v2 setup
```

How to use them is in [Adding a Laravel app](../docs/laravel/app.md) and [Adding a Laravel package](../docs/laravel/package.md). This page is for working on them.

## How it is released

There is no npm package: `npx` downloads this repository at the `v2` tag, installs the dependencies of the root [`package.json`](../package.json) and runs [`index.js`](index.js). The commands are therefore released together with the workflows, and the setup of `v2` always writes what the workflows of `v2` expect. Changes reach projects when a release moves the tag.

To try a branch before releasing it, run it from a project folder:

```bash
npx --allow-git=root github:datalogix/workflows#<branch> setup
# or, from a local clone:
node /path/to/workflows/cli/index.js setup
```

## Files

| Path | What it is |
| --- | --- |
| [`index.js`](index.js) | Entry point |
| [`lib/args.js`](lib/args.js) | Parses the options (unknown options and invalid values fail) and the help text |
| [`lib/main.js`](lib/main.js) | Parses the arguments, checks the `gh` login, detects the project and runs a command |
| [`commands/setup.js`](commands/setup.js) | Confirms the detected stack and kind (`--stack`, `--kind`; refusing another kind than the one the workflow file calls), then runs its setup: its questions, the changes they lead to and what is left by hand |
| [`commands/check.js`](commands/check.js) | Runs the `evaluate` of the folder's stack and kind |
| [`commands/protect.js`](commands/protect.js) | Creates or updates the default branch ruleset, requiring only the checks the stack's module lists for the layers that are on |
| [`commands/org.js`](commands/org.js) | Once per organization: checks the Claude GitHub App, writes the issue forms of [`examples/issue-templates`](../examples/issue-templates) to its public `.github` repository, deploys the relay (`kinds/project/relay.js`) and stores its settings in `workflows/relay.json` there |
| [`stacks/index.js`](stacks/index.js) | The supported stacks and `detectStack`: the workflow file decides the kind (`project.yml` or `package.yml`) and its `stack:` input the stack, in any case (an unsupported one stops); without one, the first stack that recognizes the folder. When the file calls neither entry point, that stack's detection decides the kind (an app by default) |
| [`kinds/project/`](kinds/project) | What `project.yml` needs from any app: `index.js` (`projectKind(stack)`: labels, Claude token, environments, branches, release App, relay, ruleset and code owners, with their questions, tasks, next steps and check items), `workflow.js` (`PROJECT_REF`, `projectAnswers`, `renderProjectWorkflow` from [`examples/project.yml`](../examples/project.yml), keeping the inputs it does not manage), `state.js` (labels, environments, release App), `relay.js` (relay settings from `<owner>/.github`, webhook secret in its KV, the deploy `org` runs; skipped on Windows), `domain.js` (domains of the health URLs). A stack's `app.js` passes only its own part (deploy targets, monitoring service, health check, lint and test tools) |
| [`kinds/package/`](kinds/package) | What `package.yml` needs from any package: `index.js` (`packageKind(stack)`: Codecov token, ruleset and code owners), `workflow.js` (`PACKAGE_REF`, `packageAnswers`, `renderPackageWorkflow` from [`examples/package.yml`](../examples/package.yml)). A stack's `package.js` passes only its own part (Laravel: its lint and test tools) |
| [`stacks/laravel/`](stacks/laravel) | Laravel: `index.js` (detection: `artisan` → app, `composer.json` using Laravel → package), `app.js` (what a Laravel app adds to `projectKind`: Forge and Laravel Cloud, Nightwatch, the health check, the lint and test questions), `package.js` (a Laravel package: `packageKind` with the lint and test questions), `health.js` (reads the health check and adds the database check to `AppServiceProvider`), `forge.js` and `cloud.js` (with an API token: find the sites or environments of the repository, the Forge deploy hook, fix the Forge deploy script and turn off Push to deploy), `api.js` (their JSON:API client), `tools.js` (reads Pint, PHPStan, Pest, PHPUnit and the scripts of `composer.json`, suggests the lint and test commands and asks for them) |
| [`lib/evaluate.js`](lib/evaluate.js) | The items every stack's `evaluate` shares: workflow file, ruleset, code owners |
| [`lib/steps.js`](lib/steps.js) | Setup questions every stack asks: the repository (then its current state), solo, code owners |
| [`lib/tools.js`](lib/tools.js) | The lint and test inputs every entry point takes (`pint`, `phpstan`, `lint-command`, `test-command`): written from the answers, read back from the workflow file |
| [`lib/tasks.js`](lib/tasks.js) | Setup tasks every stack runs (workflow file, code owners), the warnings about the workflow template and the changed files for the commit step |
| [`lib/state.js`](lib/state.js) | Reads everything about the project once: default branch, workflow file, code owners and ruleset, plus what the stack's module reads: `inspect` from the folder (a Laravel app's health check) and `read` from GitHub (an app's labels, environments and secrets, a package's Codecov token). A read that fails (no access, network) stops with "Cannot read the … of owner/repo" instead of looking like something missing. `readLocal` is the folder part alone (workflow file, its answers, `inspect`), which `protect` uses too |
| [`lib/ui.js`](lib/ui.js) | One question at a time with a progress bar (`askSteps`), and tasks with a progress bar (`runTasks`) |
| [`lib/github.js`](lib/github.js) | GitHub access through `gh`: a repository (`createGitHub`) and an organization (`createOrganization`: installed Apps, plan, repository files) |
| [`lib/project.js`](lib/project.js) | The project folder and its GitHub remote, and the repository check |
| [`lib/shell.js`](lib/shell.js) | Runs commands without a shell, with input through stdin |
| [`lib/workflow-file.js`](lib/workflow-file.js) | Reads a workflow file whatever its kind (inputs, `push.branches`, the version of a `uses:`, CRLF or LF) and builds one from an example's base and inputs |
| [`lib/ruleset.js`](lib/ruleset.js) | The `datalogix` ruleset: its body, and what it requires (checks, code owner approval, other branches) |
| [`lib/codeowners.js`](lib/codeowners.js) | Writes the `/.github/` line of `.github/CODEOWNERS`, keeping the other lines |
| [`test/`](test) | Tests |

## How setup works

1. It asks for the repository, asks before going on when the folder's git remote is another repository (`confirmFolder`, also used by `protect`), and reads its current state (`collectState`).
2. It asks the remaining questions of the stack and kind, one at a time. Each step in the module's `setup.steps()` (for an app, the questions of `kinds/project/` with the stack's own) has an optional `when` (asked only when it applies), an optional `flag` (an option that answers it) and an `ask` prefilled from the current state. The progress bar counts the steps that apply, recomputed after every answer.
3. It turns the answers into tasks (`setupTasks`). Each task compares the wanted state with the current one and changes only the difference, returning `created`, `updated` or `unchanged`. That is what makes running setup again safe. A task whose result the next steps need returns `{ detail, data }` instead (the Branches task tells which branches it created and whether it changed the default branch).
4. It warns about what the template replaces or drops in the workflow file (changes outside its `with:` inputs, comment lines in it, comments after the values it rewrites, an input it removes), asks to apply the changes (unless `--yes`), runs the tasks with a progress bar, then lists what is left to do by hand.

Secrets are never passed as command-line arguments: `gh secret set` reads them from stdin and encrypts them, and the relay secret goes through a temporary file readable only by the user. Commands run without a shell, so no value is ever interpreted.

## When a workflow changes

When a workflow gains an input or a requirement that projects must set:

- **A new input with a sensible default** needs nothing here.
- **A new input projects must choose**: add a step to `setupSteps()` of [`kinds/project/index.js`](kinds/project/index.js), write it in `renderProjectWorkflow()` (and list it in `MANAGED`), and read it back in `projectAnswers()` ([`kinds/project/workflow.js`](kinds/project/workflow.js)).
- **A new secret, variable, label or permission**: read it in the kind's `read` (`readProject()` in `kinds/project/index.js`, which `collectState()` calls), add a task in that file's `setupTasks()` and an item in its `evaluate()`, so `check` reports projects that lack it.
- **An input that turns off a layer with a required check** (today `tests`, `security-review`, `risk-gate`), or a new such layer: add its check to `PROJECT_CHECKS` in [`kinds/project/index.js`](kinds/project/index.js) (or `PACKAGE_CHECKS` in [`kinds/package/index.js`](kinds/package/index.js)) and read its flag in `projectAnswers()` (or `packageAnswers()`); `protect` and `check` derive the required checks from them.

## Tests

From the repository root (Node 22.12+, required by Vitest):

```bash
npm ci
npm test
```

The tests cover argument parsing, the project and relay helpers, the workflow file, the code owners file, the health check edit, `collectState`, the question flow, the tasks, `check` and `protect`, with fake GitHub objects passed in (`test/helpers.js` has the shared fixtures). The prompts themselves are not tested automatically: after changing them, run `setup` in a test project.
