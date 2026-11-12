# Package releases

Packages can release new versions from their commits, off by default: [`package-release`](reference.md#package-release), called by the `release` job of [`examples/package-release.yml`](../examples/package-release.yml), which setup writes when you turn releases on (`--release`). Apps release by deploying instead: see [Deploy](deploy.md).

## How it works

1. **Every push to the default branch** whose tests passed opens or updates the **release pull request**, from the `datalogix/release` branch. It is rebuilt from the pushed commit each time, with one commit, `chore(release): vX.Y.Z`, that:
   - adds the version's section to `CHANGELOG.md` (created when missing), with the commits since the last tag under Breaking changes, Features, Fixes and Other changes (in the team `language`; pt-BR by default);
   - for a JavaScript package, sets that version in `package.json` (and `package-lock.json`).
2. **Merging it** (any merge method) tags the merge commit `vX.Y.Z` and creates the GitHub release with that section as its notes, once the tests of that push pass.
   - **Composer packages**: Packagist reads the new tag, through the GitHub integration it already has.
   - **JavaScript packages**: the same run checks the tag out, installs the dependencies, and publishes to npm with provenance (`npm publish --access public`; a prerelease goes to the `next` dist-tag). A private package and a version npm already has are skipped.
3. With nothing to release (only docs, tests, CI), no pull request is opened, and an open one says so.

The tag, the release and the npm version are checked before they are created, so a re-run creates nothing twice.

## The version

From the commits since the last tag (`vX.Y.Z` or `X.Y.Z`; the next tag keeps the prefix, `v` without one), as [Conventional Commits](https://www.conventionalcommits.org) that Claude already writes:

| Commits | Next version (from 1.2.3) | Before 1.0.0 (from 0.4.1) |
| --- | --- | --- |
| A `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer | 2.0.0 | 0.5.0 |
| `feat` | 1.3.0 | 0.5.0 |
| `fix`, `perf`, `revert`, `deps` | 1.2.4 | 0.4.2 |
| Only other types (`docs`, `test`, `ci`, `chore`, `refactor`, `style`, `build`) | none | none |

- **A `Release-As: X.Y.Z` footer** in any commit sets the version, e.g. `git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"` for the first major.
- **The first release**, without a tag: the version of `package.json` for a JavaScript package (unless it is `0.0.0`), otherwise `0.1.0`.
- **A project without type prefixes** (`- Commits: no type prefix` in its `CLAUDE.md`): every commit is a patch, a `BREAKING CHANGE:` footer a major; use `Release-As` for a minor.
- With a squash merge, the pull request's title is the commit, so it follows the same format (as Claude's are).

## What it needs

- **The release GitHub App**, with **Contents: Read and write** (it commits the release branch through the API, so GitHub signs the commit) and Pull requests: read and write, installed on the package's repository: see [Organization setup, step 6](organization-setup.md#6-create-the-release-github-app). Without it, the release pull request is opened with the workflow token and runs no workflows: its required checks never report, and a protected default branch cannot merge it. `check` reports it as an error where the branch can be protected.
- **The workflow file's `release` job** with `contents` and `pull-requests` write, and `id-token` write for npm; the tests keep `contents: read`. Setup writes it; `check` reports a job without them.
- **npm (JavaScript packages)**: [trusted publishing](https://docs.npmjs.com/trusted-publishers), with no long-lived token. On npmjs.com, add a trusted publisher to the package: GitHub Actions, this repository, workflow `datalogix.yml`. It can only be set up for a package that exists: publish the first version by hand, or store an `NPM_TOKEN` secret (setup asks), which is then used instead. `package.json`'s `repository` must be this repository, or npm refuses the provenance; `check` warns.

## Things to know

- **Not for monorepos**: only the root `composer.json` or `package.json` is released; `check` warns about `workspaces`.
- **`composer.json` without `version`**: Packagist reads the version from the tag; `check` warns about a `version` field.
- **One publisher**: another workflow that runs `npm publish` or on a published release would publish again; `check` warns.
- **Claude's review** skips the release pull request (it only changes the changelog and the version); the security review and the risk gate run on it as on any other.
- The release branch is moved with force on every push to the default branch, to a signed commit the API creates on top of the pushed one: do not commit to it by hand.
