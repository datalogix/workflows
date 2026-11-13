# Adding a JavaScript library

JavaScript and TypeScript libraries call `package`, the same entry point as Laravel packages, with `stack: js`. Today it runs `node-package-tests`: the `test` script of `package.json` on every Node version of the matrix, and the `typecheck`, `lint` and `build` scripts and the dependency audit once. New layers are added to `package`, so libraries get them without changing their workflow file.

Next and Nuxt apps, and Vue and React single-page apps built with Vite, call `project` instead: see [Adding a JavaScript app](app.md).

## Setup

After the [organization setup](../organization-setup.md), from the library folder:

```bash
npx --allow-git=root github:datalogix/workflows#v2 setup
```

It detects a JavaScript library (a `package.json`, and not an app: neither `next` nor `nuxt` among its dependencies nor a `next.config.*` or `nuxt.config.*` file, and not a Vite single-page app, which has `vite` and `vue` or `react`, an `index.html` at the root and no `exports`, `main` or `module`) and asks you to confirm whether it is a library or an app, starting from the library (`--yes` takes it as detected). A `composer.json` at the root makes the folder a PHP project, with two exceptions that stay JavaScript: a Next or Nuxt app without a PHP entry point (`bin/console`, `public/index.php`, `web/index.php`, `craft` or a `*.php` file at the root), even when it has a PHP tool inside, and a `composer.json` only there for tooling (no `autoload`, only platform requirements such as `php` and `ext-*`, the default type, `library` or `project`, and no PHP in `src/`). Anything else, a Vite single-page app with PHP code (the frontend of a PHP app) or a WordPress theme, is PHP; `--stack js` sets it up as JavaScript anyway, with the kind its `package.json` says. To run PHP tooling in CI, use `lint-command` (the runner has PHP and Composer), e.g. `composer install --no-interaction && composer lint`. It asks whether you work alone on the library and, with a team, who must approve changes to `.github/`, and:

- writes `.github/workflows/datalogix.yml` from [`examples/package.yml`](../../examples/package.yml) with `stack: js`, the default branch in the `push` trigger and the other `with:` inputs of the existing file kept;
- with a team (or with `--code-owners`), writes the `/.github/` line of `.github/CODEOWNERS`;
- when the [JS style check](../lint.md#eslint-prettier-and-stylelint) would run ESLint, Prettier or Stylelint, asks which stay on (`--lint eslint,prettier,stylelint` or `none` answers it), writing `eslint: false`, `prettier: false` or `stylelint: false` for those unchecked.

It ends with the commit to make and the `protect` command to run after the first pull request.

Claude and the risk gate can be turned on as in a Laravel package, with the `js` plugin and the high-risk paths of a JavaScript library: see [Claude and the risk gate (optional)](../laravel/package.md#claude-and-the-risk-gate-optional).

Releases can be turned on as in a Laravel package, and also publish to npm with provenance (npm's trusted publishing, or an `NPM_TOKEN`): see [Package releases](../releases.md).

### By hand

Copy [`examples/package.yml`](../../examples/package.yml) to `.github/workflows/datalogix.yml` and add the stack:

```yaml
jobs:
  pipeline:
    uses: datalogix/workflows/.github/workflows/package.yml@v2
    secrets: inherit
    with:
      stack: js
```

After the first pull request shows its checks, protect the default branch from the library folder:

```bash
npx --allow-git=root github:datalogix/workflows#v2 protect
```

It requires pull requests and the `pipeline / tests / all-checks` check, the same check as a Laravel package, and asks whether you work alone on the library (`--solo` / `--no-solo` answers it).

`check` checks the workflow file, the ruleset and the code owners of `.github/`. No coverage report is uploaded yet, so there is no Codecov token to set.

What the tests run and how to change the Node versions: [JavaScript library tests](package-tests.md).
