# Setting up a JavaScript app by hand

What [setup](app.md) does, for when you cannot run it. Replace `OWNER/REPO`.

## Workflow file

Copy [`examples/project.yml`](../../examples/project.yml) to `.github/workflows/datalogix.yml` and add the stack:

```yaml
jobs:
  pipeline:
    uses: datalogix/workflows/.github/workflows/project.yml@v2
    secrets: inherit
    with:
      stack: js
      # With Sentry problems as issues
      monitoring: sentry
      # Without Sentry: incidents: false
```

With Vercel deploys, add `deploy: vercel`, then set up the environments and `vercel.json` below; with Netlify, `deploy: netlify` and [Netlify](#netlify).

## Labels, Claude token and code owners

The same as for a Laravel app, without the `env:` labels: see [Labels](../laravel/app-manual-setup.md#labels), the [Claude token](../laravel/app-manual-setup.md#claude-token) when the repository cannot read the organization's, and the `/.github/` line of `.github/CODEOWNERS` ([Code owners](../laravel/app-manual-setup.md#code-owners)).

## Vercel

Each GitHub environment (`production`, and `staging` for the project's `staging` custom environment) needs the variables and secrets of [Vercel](../deploy.md#vercel):

```bash
for env in staging production; do
  gh api --method PUT "repos/OWNER/REPO/environments/$env" >/dev/null
  gh secret set VERCEL_TOKEN --repo OWNER/REPO --env $env
  gh secret set VERCEL_AUTOMATION_BYPASS_SECRET --repo OWNER/REPO --env $env
  gh variable set VERCEL_PROJECT --repo OWNER/REPO --env $env --body "prj_..."
  # Only for a team's project
  gh variable set VERCEL_TEAM_ID --repo OWNER/REPO --env $env --body "team_..."
done
gh variable set HEALTH_URL --repo OWNER/REPO --env staging --body "https://dev.example.com/api/health"
gh variable set HEALTH_URL --repo OWNER/REPO --env production --body "https://example.com/api/health"
```

In `vercel.json`, turn off Vercel's own deploys of the branches the workflows deploy, keeping the previews of pull requests:

```json
{
  "git": { "deploymentEnabled": { "main": false } }
}
```

Add a route that answers `200` at `/api/health` (`app/api/health/route.ts` on Next, `server/api/health.get.ts` on Nuxt, `src/routes/api/health/+server.ts` on SvelteKit, with `export const prerender = false;`). A Vue, React or Svelte single-page app built with Vite, a Nuxt app built with `nuxt generate` or a SvelteKit app with `@sveltejs/adapter-static` has no server: add `public/health.json` (`static/health.json` on SvelteKit) with `{"status":"ok"}` and point `HEALTH_URL` to `/health.json`. With a router, also send every path to `index.html` in `vercel.json`: `"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]`; for SvelteKit's `fallback` page (`fallback: '200.html'`), send them to that page instead.

## Netlify

Each environment deploys its own Netlify site, linked to the repository, with its production branch set to the branch that environment deploys. Each GitHub environment needs the variables and secrets of [Netlify](../deploy.md#netlify):

```bash
gh secret set NETLIFY_TOKEN --repo OWNER/REPO --env staging
gh secret set NETLIFY_TOKEN --repo OWNER/REPO --env production
gh variable set NETLIFY_SITE_ID --repo OWNER/REPO --env staging --body "<staging site id>"
gh variable set NETLIFY_SITE_ID --repo OWNER/REPO --env production --body "<production site id>"
gh variable set HEALTH_URL --repo OWNER/REPO --env staging --body "https://dev.example.com/api/health"
gh variable set HEALTH_URL --repo OWNER/REPO --env production --body "https://example.com/api/health"
```

In each site, open **Deploys** and choose **Lock to stop auto publishing**, or every push goes live before its tests (the first deploy of the workflows locks it too). The health route is the same as on Vercel; for a single-page app with a router, send every path to `index.html` in `netlify.toml`:

```toml
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

## Sentry

1. Install Sentry's SDK: `npx @sentry/wizard@latest -i nextjs` (or `-i nuxt`, `-i sveltekit`; `npm install @sentry/vue`, `@sentry/react` or `@sentry/svelte` in a single-page app), with the Sentry environments named `production` and `staging`.
2. Create the internal integration and its alert rules as [Production errors](../production-errors.md#sentry) says, with the webhook URL `https://<worker>/sentry/OWNER/REPO`.
3. Store its Client Secret in the relay: see [the relay's README](../../relay/README.md).

## Protect

After the first pull request shows its checks, run `protect` from the app folder, or create the ruleset with the checks `pipeline / tests / tests`, `pipeline / security / security` and `pipeline / gate / gate`.
