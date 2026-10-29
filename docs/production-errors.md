# Production errors

Errors and performance problems that Nightwatch detects in production and staging become GitHub issues that Claude analyzes, and you decide what to do:

1. Nightwatch opens an issue and sends its webhook to the [relay](../relay), which checks it with that repository's secret, rejects events sent more than an hour from now, acknowledges without sending again an event it already delivered in the last two hours (see [replays](../relay/README.md)), and sends an `incident` event to the project repository.
2. The `incident` job creates a GitHub issue labeled `incident` and `env:<environment>`, titled like `[Nightwatch production] ...`, with the exception and its file and line (or the slow route, job or command and its duration), the release live in that environment and the changes of its last deploy.
3. Claude comments a diagnosis: the cause, whether the last deploy introduced it, the impact, a suggested fix and a recommendation.
4. You add `claude` (Claude fixes it in a pull request that goes through every layer), add `rollback` (when a previous release is known, the issue's environment goes back to it now), or close the issue.

The same problem never opens two issues. When it happens again, the issue is reopened if it was closed, and analyzed again only if another release is live than at its last analysis; resolving or ignoring it in Nightwatch closes it.

Problems are never rolled back automatically: a single error can come from one bad request or an external service, and the webhook does not say how often it happens. Automatic rollbacks stay with the health checks, which see an app that is down.

Setup is covered in [Organization setup](organization-setup.md#4-deploy-the-monitoring-relay-only-for-production-errors), [the setup command](laravel/app.md#step-1-run-setup) and [step 2](laravel/app.md#step-2-do-what-setup-cannot). To handle only some environments or types, pass `incident-environments` or `incident-types` to `project`, e.g. `incident-types: '["exception"]'`.

Nightwatch's documentation does not specify the exact format of the `Nightwatch-Signature` header; the relay accepts a hex HMAC-SHA256 digest, with or without a `sha256=` prefix. Check the first delivery in the worker's logs: a `401 Invalid signature` there means the format differs; `401 Stale event` means the webhook's timestamp is missing or more than an hour off.

## Adding a provider

The relay is organized by monitoring provider: the webhook URL names the provider, and each repository is accepted only by the providers it has a secret for. A new provider is one file in the relay; the workflows need no changes. See [the relay's README](../relay/README.md#adding-a-provider). Setup needs its description in `cli/providers/monitoring/<id>.js`, and its deploy markers, if it has them, a script in `.github/actions/deploy/monitoring/` (see [Adding a deploy provider](deploy.md#adding-a-deploy-provider)).
