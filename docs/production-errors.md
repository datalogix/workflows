# Production errors

Errors and performance problems that Nightwatch (or errors that [Sentry](#sentry) or [Inspector](#inspector)) detects in production and staging become GitHub issues that Claude analyzes, and you decide what to do:

1. Nightwatch opens an issue and sends its webhook to the [relay](../relay), which checks it with that repository's secret, rejects events sent more than an hour from now, acknowledges without sending again an event it already delivered in the last two hours (see [replays](../relay/README.md)), and sends an `incident` event to the project repository.
2. The `incident` job creates a GitHub issue labeled `incident` and `env:<environment>`, titled like `[Nightwatch production] ...`, with the exception and its file and line (or the slow route, job or command and its duration), the release live in that environment and the changes of its last deploy.
3. Claude comments a diagnosis: the cause, whether the last deploy introduced it, the impact, a suggested fix and a recommendation.
4. You add `claude` (Claude fixes it in a pull request that goes through every layer), add `rollback` (when a previous release is known, the issue's environment goes back to it now), or close the issue.

The same problem never opens two issues. When it happens again, the issue is reopened if it was closed, and analyzed again only if another release is live than at its last analysis; resolving or ignoring it in Nightwatch closes it.

Problems are never rolled back automatically: a single error can come from one bad request or an external service, and the webhook does not say how often it happens. Automatic rollbacks stay with the health checks, which see an app that is down.

Setup is covered in [Organization setup](organization-setup.md#4-deploy-the-monitoring-relay-only-for-production-errors), [the setup command](laravel/app.md#step-1-run-setup) and [step 2](laravel/app.md#step-2-do-what-setup-cannot). To handle only some environments or types, pass `incident-environments` or `incident-types` to `project`, e.g. `incident-types: '["exception"]'`.

Nightwatch's documentation does not specify the exact format of the `Nightwatch-Signature` header; the relay accepts a hex HMAC-SHA256 digest, with or without a `sha256=` prefix. Check the first delivery in the worker's logs: a `401 Invalid signature` there means the format differs; `401 Stale event` means the webhook's timestamp is missing or more than an hour off.

## Sentry

With `monitoring: sentry` (setup asks which service the app uses), Sentry's issue alerts open the GitHub issues instead:

- In Sentry, create an internal integration (**Settings > Developer Settings > Custom Integrations**), turn on **Alert Rule Action**, and set its webhook URL to the one setup shows (`https://<worker>/sentry/OWNER/REPO`). Its **Client Secret** is the signing secret setup asks for.
- Add the integration as an action of the alert rules whose problems should become issues. The rule decides which problems (and how often); `incident-environments` still filters the environments.
- A Laravel app needs Sentry's SDK (`composer require sentry/sentry-laravel`), with the Sentry environments named `production` and `staging`, like the GitHub environments.

Differences from Nightwatch:

- **Only exceptions.** Performance problems are not sent.
- **Issues are not closed from Sentry.** Sentry's issue webhooks (resolved, archived) carry neither the environment nor a signed time they were sent, so the relay cannot check them against replays: close the GitHub issue there. A new alert for the same Sentry issue reopens it.
- **No deploy markers yet.**
- The alert must carry the event's environment (its `environment` field or tag), or the problem is skipped. The relay was written from Sentry's documentation: check the first delivery in the worker's logs (see [the relay's README](../relay/README.md#troubleshooting)).

## Inspector

With `monitoring: inspector`, Inspector's error notifications open the GitHub issues:

- Use one Inspector application per environment (production, and staging when its problems become issues): Inspector's notifications do not say the environment, so the relay tells them apart by the application's key.
- In each application, configure the **Webhook** channel (**Settings > Notifications Channels**) with the URL setup shows (`https://<worker>/inspector/OWNER/REPO`, the same for every environment). Setup asks for each application's ingestion key and stores them together in the relay.
- A Laravel app needs Inspector's package (`composer require inspector-apm/inspector-laravel`), with each environment's ingestion key in its `INSPECTOR_INGESTION_KEY`.

Differences from Nightwatch:

- **Only exceptions.** A new error opens the issue; a growing frequency or the Nth occurrence of it comments on the issue and reopens it when closed. Single occurrences, alerts and slow transactions are not sent.
- **No signature.** Inspector sends the application's key in the `X-Inspector-Key` header, not a signature of the body: anyone who has the key (it is in the app's `.env`) can send the relay an error for that repository. Keep the keys out of the repository.
- **Issues are not closed from Inspector**, which sends no event when an error is resolved: close the GitHub issue there.
- **No deploy markers.**
- The issue has no link to Inspector (the notification carries none). The relay does not check the notification's age: without a signature its times prove nothing, so only a body sent twice within two hours is caught. The relay was written from Inspector's documentation: check the first delivery in the worker's logs (see [the relay's README](../relay/README.md#troubleshooting)).

## Adding a provider

The relay is organized by monitoring provider: the webhook URL names the provider, and each repository is accepted only by the providers it has a secret for. A new provider is one file in the relay; the workflows need no changes. See [the relay's README](../relay/README.md#adding-a-provider). Setup needs its description in `cli/providers/monitoring/<id>.js`, and its deploy markers, if it has them, a script in `.github/actions/deploy/monitoring/` (see [Adding a deploy provider](deploy.md#adding-a-deploy-provider)).
