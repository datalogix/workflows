# Lint

The tests workflows run the project's own lint tools, so CI, your machine and Claude check the code the same way. This page lists what each workflow runs and the setup we recommend for each kind of project.

| Project | Workflow | Lint it runs |
| --- | --- | --- |
| Laravel app | [`laravel-app-tests`](laravel/app-tests.md) | Pint on the files changed by the pull request, every file outside pull requests and the merge queue (Blade views too, see [Blade views](#blade-views)), PHPStan, Rector, `lint-command`; with `js`, the typecheck and lint scripts of `package.json`, and [ESLint, Prettier and Stylelint](#eslint-prettier-and-stylelint) |
| Laravel package | [`laravel-package-tests`](laravel/package-tests.md) | Pint on the changed files, every file outside pull requests and the merge queue (Blade views too), PHPStan, Rector, `lint-command`, once outside the matrix; with `js`, the typecheck and lint scripts of `package.json`, and [ESLint, Prettier and Stylelint](#eslint-prettier-and-stylelint), once in a job of their own |
| PHP package | [`laravel-package-tests`](php/package-tests.md), without Laravel | Pint on the changed files (every file outside pull requests and the merge queue), PHPStan, Rector, `lint-command` (php-cs-fixer, ECS, Psalm), once outside the matrix; with `js`, the typecheck and lint scripts of `package.json`, and [ESLint, Prettier and Stylelint](#eslint-prettier-and-stylelint), once |
| Next, Nuxt, SvelteKit, Astro, React Router, Remix, and Vue, React and Svelte built with Vite | [`node-app-tests`](js/app-tests.md) | The typecheck and lint scripts, [ESLint, Prettier and Stylelint](#eslint-prettier-and-stylelint), `lint-command`, then the build |
| JavaScript or TypeScript library | [`node-package-tests`](js/package-tests.md) | The typecheck and lint scripts, [ESLint, Prettier and Stylelint](#eslint-prettier-and-stylelint), the build, then `lint-command` |

## Rules for every project

- **Scripts check, they do not fix.** CI runs `typecheck` and `lint` and then fails when they changed a tracked file ("The typecheck or lint script changed tracked files"), as a fixer would pass with the error silently fixed on the runner. Keep the fixing versions under other names, for local use: `lint:fix`, `format`, `check:fix`.
- **Script names.** For the typecheck CI runs the first of `typecheck`, `types:check` (the Laravel starter kits) and `type-check` (create-vue); for lint, `lint`, otherwise `check` (Vite+'s `vp check`, in the Laravel starter kits). A script with another name runs only through `lint-command`.
- **ESLint, Prettier and Stylelint** run even without a script, when the project installed them and no script runs them already: see [below](#eslint-prettier-and-stylelint).
- **No loosening to pass.** Claude never lowers a PHPStan level, loosens `tsconfig.json` or adds `@ts-ignore`, `eslint-disable` or a baseline entry to make a check pass ([Claude's conventions](claude.md)); fix the code, or change the rule in its own pull request.

## ESLint, Prettier and Stylelint

After the typecheck and lint scripts, CI checks the code with each of these tools that the project installed and no script runs already. It uses the tool from `node_modules` through the package manager of the lockfile (`pnpm exec`, `yarn`, otherwise `npx --no-install`), never downloads it and never fixes; the log says why each one runs or not. Each runs even when an earlier one failed.

| Tool | Runs when | Skipped when | Command |
| --- | --- | --- | --- |
| ESLint | `package.json` declares `eslint` (in `dependencies` or `devDependencies`) and a config exists: `eslint.config.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, or a legacy `.eslintrc*` | There is a `lint` or `check` script (it may run another linter: oxlint, Biome, `vp check`) | `eslint --no-warn-ignored <files>`, only the `.js`, `.jsx`, `.ts`, `.tsx`, `.vue`, `.svelte`, `.astro` (and `.mjs`, `.cjs`, `.mts`, `.cts`) ones; a legacy config runs `eslint .` on the whole project, with `ESLINT_USE_FLAT_CONFIG=false` |
| Prettier | A `format:check` (or `prettier:check`) script exists, or `package.json` declares `prettier` and a config exists: `.prettierrc*`, `prettier.config.*` or a `prettier` key in `package.json` | The `lint` (or `check`) script names `prettier`, or the `format:check` script | The script, as written; otherwise `prettier --check --ignore-unknown <files>` |
| Stylelint | A `lint:css` (or `stylelint`) script exists, or `package.json` declares `stylelint` and a config exists: `.stylelintrc*`, `stylelint.config.*` or a `stylelint` key in `package.json` | The `lint` (or `check`) script names `stylelint`, or the `lint:css` script | The script, as written; otherwise `stylelint --allow-empty-input <files>`, only the `.css`, `.scss`, `.sass` and `.less` ones, and `.vue`, `.svelte`, `.astro` and `.html` when `package.json` declares `postcss-html` or a `stylelint-config-*` for them (`stylelint-config-recommended-vue`, `stylelint-config-html`) |

- **Which files.** On a pull request, only the files it changes (in the merge queue, those of the group), so existing issues do not block it, as with Pint; on other events (push, schedule, manual runs), every tracked file. Lockfiles, minified files (`*.min.js`, `*.min.css`), `vendor/`, `node_modules/` and `public/build/` are left out. A tool with no file to check is skipped. The ignore files still apply (`.prettierignore`, `.stylelintignore`, the `ignores` of the ESLint config).
- **Scripts check the whole scope they name.** `format:check` and `lint:css` run as written, on every event: `"format:check": "prettier --check resources/"` checks all of `resources/` on every pull request.
- **Turning one off.** `eslint: false`, `prettier: false` or `stylelint: false` in the workflow file (setup's lint question offers the ones the project has; with Prettier and Stylelint, their `format:check` and `lint:css` scripts are skipped too). A tool the `lint` script runs still runs there: the inputs only cover what CI runs on its own. `js: false` turns off every JavaScript check.

## Laravel app

PHP, in `composer.json`:

```json
{
    "require-dev": {
        "larastan/larastan": "^3.0",
        "laravel/pint": "^1.30"
    },
    "scripts": {
        "lint": ["pint --parallel"],
        "lint:check": ["pint --parallel --test"],
        "types:check": ["phpstan analyse"]
    }
}
```

- Pint, PHPStan and Rector run as steps of their own when installed (Rector only with a `rector.php`, in a dry run): no `lint-command` is needed for them, and setup does not suggest `composer lint:check` when Pint covers it. On a pull request Pint runs only on the files it changes, and in the merge queue only on the files of the queued group, so old style issues do not block unrelated pull requests; on pushes, scheduled and manual runs it checks every file, so those runs fail until the old issues are fixed: run `vendor/bin/pint` (with `--blade` when CI checks views) once and commit the result.
- PHPStan reads `phpstan.neon` (with Larastan's `extension.neon` and the level the project chose). Start at the level the code passes and raise it in pull requests of their own.
- When `composer test` also runs Pint or PHPStan (as in the starter kits), setup suggests `php artisan test` as the test command, so lint does not run twice.
- `lint-command` is for other checks, e.g. `composer cs:check`.

Frontend, in `package.json`, run with `js` (on by default). The Vue and React starter kits already have what CI runs:

```json
{
    "scripts": {
        "check": "vp check",
        "check:fix": "vp check --fix",
        "types:check": "vue-tsc --noEmit"
    }
}
```

With ESLint and Prettier instead of Vite+: `"lint": "eslint . && prettier --check resources/"` and `"typecheck": "vue-tsc --noEmit"` (`tsc --noEmit` with React). Older starter kits wrote `"lint": "eslint . --fix"`: drop the `--fix`. A Livewire app has no frontend scripts: Pint and PHPStan are its lint.

## Laravel and PHP packages

The same `composer.json` tools as an app (`laravel/pint`, `larastan/larastan` or `phpstan/phpstan`, `rector/rector`). Pint runs only when the package requires `laravel/pint`, PHPStan when it requires PHPStan or Larastan, and Rector when it requires `rector/rector` and has `rector.php`; they run once, on the newest PHP of the matrix.

A PHP package without Laravel uses the same steps: Pint works on any PHP code, and PHPStan without Larastan. Other tools run through `lint-command`, e.g. `composer cs:check` with `"cs:check": "php-cs-fixer fix --dry-run --diff"` (or `ecs check`), and Psalm in the same script; setup suggests the check scripts of `composer.json`.

A package without Blade views needs nothing else: without a `package.json` that declares `prettier-plugin-blade`, the lint job does not install Node and Pint checks PHP only.

A package with a `package.json` (a Livewire or Blade component library with its own JavaScript) gets, with `js` (on by default), a `js` job that runs its typecheck, lint (or ESLint) and `test` scripts once, as in an app: see [Laravel package tests](laravel/package-tests.md#what-it-does). It installs Node only when one of them exists. A package with views can check them too: see [Blade views](#blade-views).

## Next

```json
{
    "scripts": {
        "typecheck": "tsc --noEmit",
        "lint": "eslint . && prettier --check .",
        "lint:fix": "eslint . --fix && prettier --write ."
    }
}
```

- `create-next-app` writes `"lint": "eslint"` (or `"biome check"`), which already checks only. Next 16 removed `next lint`: a `"lint": "next lint"` script fails, replace it with `eslint .` and `eslint-config-next` in `eslint.config.mjs`.
- `next build` checks the types too, but a `typecheck` script reports them in a step of their own, before the tests.

## Nuxt

```json
{
    "scripts": {
        "postinstall": "nuxt prepare",
        "typecheck": "nuxt typecheck",
        "lint": "eslint . && prettier --check .",
        "lint:fix": "eslint . --fix && prettier --write ."
    }
}
```

- The Nuxt starter has no lint or typecheck script: add them. `nuxt typecheck` needs `vue-tsc` and `typescript` in `devDependencies`.
- `@nuxt/eslint` (`eslint.config.mjs` with `withNuxt()` from `./.nuxt/eslint.config.mjs`) and `nuxt typecheck` read files that `nuxt prepare` writes to `.nuxt/`: keep the `postinstall` the starter has, or lint fails in CI.

## Vue with Vite

```json
{
    "scripts": {
        "type-check": "vue-tsc --build",
        "lint": "eslint . && oxlint . && prettier --check src/",
        "lint:fix": "eslint . --fix && oxlint . --fix && prettier --write src/"
    }
}
```

`create-vue` writes `lint` scripts with `--fix` (`eslint . --fix --cache`, `oxlint . --fix`), which fail the check for changed files when they fix something: drop the `--fix`. Its `build` already runs `type-check`.

## React with Vite

```json
{
    "scripts": {
        "typecheck": "tsc -b",
        "lint": "oxlint && prettier --check ."
    }
}
```

`create-vite` writes `"lint": "oxlint"` (or `"eslint ."`), which already checks only, and type-checks in `build` (`tsc -b && vite build`).

## SvelteKit

```json
{
    "scripts": {
        "typecheck": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
        "lint": "prettier --check . && eslint ."
    }
}
```

The SvelteKit templates name the type check `check` (`svelte-kit sync && svelte-check`) and also write `lint`. CI runs the first of `lint` and `check` as lint, so with both, `svelte-check` never runs: add a `typecheck` script with the same command (keep `check` for your editor if you like). Without a `lint` script, `check` runs as lint instead. A Svelte single-page app built with Vite has `svelte-check` too: name it `typecheck` the same way.

## Astro

```json
{
    "scripts": {
        "typecheck": "astro check",
        "lint": "prettier --check . && eslint ."
    }
}
```

The Astro templates write no type check script: add `typecheck` with `astro check` (it needs `@astrojs/check` and `typescript` in the dev dependencies), so CI runs it. `astro build` does not type-check `.astro` files.

## React Router and Remix

```json
{
    "scripts": {
        "typecheck": "react-router typegen && tsc",
        "lint": "eslint ."
    }
}
```

The React Router templates already name the type check `typecheck`, which CI runs; `react-router typegen` writes the route types to `.react-router/`, so it goes first. Remix 2 apps run `tsc` alone.

## JavaScript and TypeScript libraries

```json
{
    "scripts": {
        "build": "tsdown",
        "typecheck": "tsc --noEmit",
        "lint": "eslint . && prettier --check .",
        "lint:fix": "eslint . --fix && prettier --write ."
    }
}
```

And, in `.github/workflows/datalogix.yml`:

```yaml
    with:
      stack: js
      lint-command: npx publint && npx attw --pack .
```

- `lint-command` runs after the build, so `publint` (what `package.json` publishes: `exports`, `main`, `types`) and `attw` (whether the types resolve in ESM and CommonJS) find `dist/`.
- `eslint.config.js` with `typescript-eslint`, ignoring `dist/` and `coverage/`; `.prettierignore` with `dist`, `coverage` and the lockfile.
- A JavaScript library without TypeScript drops `typecheck` and `attw`.

## Blade views

With Pint 1.30+, Pint checks Blade views too (`--blade`) when `package.json` declares `prettier-plugin-blade`: Pint formats them with Prettier, from `node_modules`. Add what Pint asks for to `devDependencies` (`prettier`, `prettier-plugin-blade`, `prettier-plugin-tailwindcss`, at the versions Pint names) and commit the lockfile. In a package, the lint job then installs Node and the package's dependencies first.

Pint formats Blade with its own Prettier configuration and its own passes before and after Prettier, so `prettier --check` on the same views disagrees with it even with the same options. When the project also runs Prettier, leave the views to Pint, in `.prettierignore`:

```
*.blade.php
```
