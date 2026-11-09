# Lint

The tests workflows run the project's own lint tools, so CI, your machine and Claude check the code the same way. This page lists what each workflow runs and the setup we recommend for each kind of project.

| Project | Workflow | Lint it runs |
| --- | --- | --- |
| Laravel app | [`laravel-app-tests`](laravel/app-tests.md) | Pint on the files changed by the pull request (Blade views too, see [Blade views](#blade-views)), PHPStan, `lint-command`; with `js`, the typecheck and lint scripts of `package.json` |
| Laravel package | [`laravel-package-tests`](laravel/package-tests.md) | Pint on the changed files (Blade views too), PHPStan, `lint-command`, once outside the matrix |
| Next, Nuxt | [`node-app-tests`](js/app-tests.md) | The typecheck and lint scripts, `lint-command`, then the build |
| JavaScript or TypeScript library (Vue and React apps built with Vite too, for now) | [`node-package-tests`](js/package-tests.md) | The typecheck and lint scripts, the build, then `lint-command` |

## Rules for every project

- **Scripts check, they do not fix.** CI runs `typecheck` and `lint` and then fails when they changed a tracked file ("The typecheck or lint script changed tracked files"), as a fixer would pass with the error silently fixed on the runner. Keep the fixing versions under other names, for local use: `lint:fix`, `format`, `check:fix`.
- **Script names.** For the typecheck CI runs the first of `typecheck`, `types:check` (the Laravel starter kits) and `type-check` (create-vue); for lint, `lint`, otherwise `check` (Vite+'s `vp check`, in the Laravel starter kits). A script with another name runs only through `lint-command`.
- **Formatting** is checked only when a script checks it: put `prettier --check` (or `biome check`, `vp check`) in `lint`.
- **No loosening to pass.** Claude never lowers a PHPStan level, loosens `tsconfig.json` or adds `@ts-ignore`, `eslint-disable` or a baseline entry to make a check pass ([Claude's conventions](claude.md)); fix the code, or change the rule in its own pull request.

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

- Pint and PHPStan run as steps of their own when installed: no `lint-command` is needed for them, and setup does not suggest `composer lint:check` when Pint covers it. Pint runs only on the files changed by the pull request, so old style issues do not block unrelated pull requests.
- PHPStan reads `phpstan.neon` (with Larastan's `extension.neon` and the level the project chose). Start at the level the code passes and raise it in pull requests of their own.
- When `composer test` also runs Pint or PHPStan (as in the starter kits), setup suggests `php artisan test` as the test command, so lint does not run twice.
- `lint-command` is for other checks, e.g. `vendor/bin/rector --dry-run`.

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

## Laravel package

The same `composer.json` tools as an app (`laravel/pint`, `larastan/larastan` or `phpstan/phpstan`). Pint runs only when the package requires `laravel/pint`, and PHPStan when it requires PHPStan or Larastan; both run once, on the newest PHP of the matrix.

A package without Blade views needs nothing else: without a `package.json` that declares `prettier-plugin-blade`, the lint job does not install Node and Pint checks PHP only. A package with views can check them too: see [Blade views](#blade-views).

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

Setup takes Vue and React apps built with Vite for libraries, as they have neither `next` nor `nuxt`: they run [`node-package-tests`](js/package-tests.md), whose `min-coverage` is 100 by default. Set `min-coverage` to the coverage you want, or `0`.

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
