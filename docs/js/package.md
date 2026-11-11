# Adding a JavaScript library

JavaScript and TypeScript libraries call `package`, the same entry point as Laravel packages, with `stack: js`. Today it runs `node-package-tests`: the `test` script of `package.json` on every Node version of the matrix, and the `typecheck`, `lint` and `build` scripts and the dependency audit once. New layers are added to `package`, so libraries get them without changing their workflow file.

Next and Nuxt apps, and Vue and React single-page apps built with Vite, call `project` instead: see [Adding a JavaScript app](app.md).

## Setup

After the [organization setup](../organization-setup.md), from the library folder:

```bash
npx --allow-git=root github:datalogix/workflows#v2 setup
```

It detects a JavaScript library (a `package.json`, no `composer.json`, and not an app: neither `next` nor `nuxt` among its dependencies nor a `next.config.*` or `nuxt.config.*` file, and not a Vite single-page app, which has `vite` and `vue` or `react`, an `index.html` at the root and no `exports`, `main` or `module`) and asks you to confirm whether it is a library or an app, starting from the library (`--yes` takes it as detected). A folder with `composer.json` is a PHP project, even with frontend scripts. It asks whether you work alone on the library and, with a team, who must approve changes to `.github/`, and:

- writes `.github/workflows/datalogix.yml` from [`examples/package.yml`](../../examples/package.yml) with `stack: js`, the default branch in the `push` trigger and the other `with:` inputs of the existing file kept;
- with a team (or with `--code-owners`), writes the `/.github/` line of `.github/CODEOWNERS`.

It ends with the commit to make and the `protect` command to run after the first pull request.

Claude and the risk gate can be turned on as in a Laravel package, with the `js` plugin and the high-risk paths of a JavaScript library: see [Claude and the risk gate (optional)](../laravel/package.md#claude-and-the-risk-gate-optional).

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
