# Setting up a Next or Nuxt app by hand

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

Do not set `deploy`: the workflows do not deploy JavaScript apps yet.

## Labels, Claude token and code owners

The same as for a Laravel app, without the `env:` labels: see [Labels](../laravel/app-manual-setup.md#labels), the [Claude token](../laravel/app-manual-setup.md#claude-token) when the repository cannot read the organization's, and the `/.github/` line of `.github/CODEOWNERS` ([Code owners](../laravel/app-manual-setup.md#code-owners)).

## Sentry

1. Install Sentry's SDK: `npx @sentry/wizard@latest -i nextjs` (or `-i nuxt`), with the Sentry environments named `production` and `staging`.
2. Create the internal integration and its alert rules as [Production errors](../production-errors.md#sentry) says, with the webhook URL `https://<worker>/sentry/OWNER/REPO`.
3. Store its Client Secret in the relay: see [the relay's README](../../relay/README.md).

## Protect

After the first pull request shows its checks, run `protect` from the app folder, or create the ruleset with the checks `pipeline / tests / tests`, `pipeline / security / security` and `pipeline / gate / gate`.
