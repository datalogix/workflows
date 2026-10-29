# Adding a Next or Nuxt app

Next and Nuxt apps call `project`, the same entry point as Laravel apps, with `stack: js`. They get Claude on issues and pull requests, the tests, the Claude code review, the security review, the risk gate, Fix CI, Sentry problems as issues and, on [Vercel](../deploy.md#vercel), the same deploys as a Laravel app: staging, then production, each watched and rolled back automatically when its health checks fail.

Claude follows the `core` and `js` plugins ([Claude's conventions](../claude.md)): the language and pull request rules of every project, plus JavaScript's practices (feature flags only with the project's flag library, additive migrations, the `package.json` scripts and the build before a pull request). The security review uses a checklist for server routes, API handlers, server actions, secrets exposed to the browser and the page payload.

## Step 1: run setup

After the [organization setup](../organization-setup.md), from the app folder:

```bash
npx --allow-git=root github:datalogix/workflows#v2 setup
```

It detects a JavaScript app (a `package.json` without `composer.json`, with `next` or `nuxt` among its dependencies or a `next.config.*` or `nuxt.config.*` file) and asks you to confirm whether it is an app or a library (`--stack js --kind app` answers it). Then it asks, as for a Laravel app and in this order:

| Question | Asked when |
| --- | --- |
| GitHub repository | always |
| Where the app is deployed: Vercel or not by the workflows (`deploy`) | always |
| Production domain, whether there is a staging environment (the `staging` custom environment of the project, on Pro and Enterprise teams), staging domain, development and production branches, how production deploys, Deployments records, health check path (`/api/health` by default) | the app is deployed, as for a [Laravel app](../laravel/app.md#step-1-run-setup) |
| Vercel access token (hidden input; stored as the `VERCEL_TOKEN` secret of each environment, which the deploys need; empty leaves the secrets to set by hand) | the app is deployed |
| The Vercel project, from those linked to the repository in your account and teams; **None of these** leaves it to set by hand | a token was given and it found a project |
| The project's Protection Bypass for Automation secret (**Settings > Deployment Protection**; empty keeps it or leaves it for later) | the app is deployed |
| The app's monitoring service: Sentry or none (`monitoring`) | always |
| Claude token (hidden input) | the repository cannot read one |
| Whether Sentry problems become issues (of the `production` and `staging` environments: `incident-environments` changes them), and Sentry's signing secret (the Client Secret of an [internal integration](../production-errors.md#sentry)) | the app has a monitoring service; the secret, when the relay is configured |
| Whether to create the health route `/api/health` (`app/api/health/route.ts` or `pages/api/health.ts` on Next, `server/api/health.get.ts` on Nuxt, in JavaScript without a `tsconfig.json`) | the app deploys to `/api/health` and has no route there |
| Whether the tests run the end-to-end tests (`test:e2e`) | `package.json` has that script |
| Claude and the risk gate on pull requests: code review, security review, risk gate and fix CI | always |
| Language of what is written for the team | always |
| Whether you work alone on the project, and the approvals of each risk level | always (the approvals: a team project with the risk gate on) |
| Who must approve changes to `.github/` | always |

Then it writes `.github/workflows/datalogix.yml` with `stack: js` (and `deploy: vercel`, `monitoring: sentry`), the `/.github/` line of `.github/CODEOWNERS`, creates the labels, stores the Claude token when the repository needs its own, and registers Sentry's signing secret in the relay. With Vercel it also:

- creates the `production` environment (and `staging`) with `VERCEL_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `VERCEL_PROJECT`, `VERCEL_TEAM_ID` and `HEALTH_URL`;
- creates the project's `staging` custom environment when it has none (its domain is set in Vercel: the next steps say so);
- writes `vercel.json` without Vercel's own deploys of the branches the workflows deploy (`git.deploymentEnabled`), so a push is deployed only after the tests, while pull requests keep their preview deployments. Commit it with the workflow file;
- creates the health route, when you said so.

It ends with what is left: the commit, what Vercel still needs (the secrets left empty, the staging domain), Sentry's SDK when `package.json` does not have it (`npx @sentry/wizard@latest -i nextjs`, or `-i nuxt`), the Sentry webhook, and `protect`.

## Step 2: protect the default branch

After the first pull request shows its checks:

```bash
npx --allow-git=root github:datalogix/workflows#v2 protect
```

The required checks are the same as a Laravel app's: `pipeline / tests / tests`, `pipeline / security / security` and `pipeline / gate / gate`, for the layers that are on.

`check` reports what is missing: the workflow file, labels, Claude token, the environments with `VERCEL_TOKEN`, `VERCEL_PROJECT` and `HEALTH_URL` (and whether it answers `200`), the health route, the ruleset, the code owners, Sentry's SDK in `package.json` and the relay registration.

What the tests run: [JavaScript app tests](app-tests.md). Without setup: [by hand](app-manual-setup.md).
