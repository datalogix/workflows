# Incident relay

A Cloudflare Worker that turns monitoring webhooks into GitHub `repository_dispatch` events. Monitoring services cannot send the `Authorization` header GitHub requires, so their webhooks point here instead:

```
Nightwatch ──webhook──► https://<worker>/nightwatch/<owner>/<repo> ──repository_dispatch (incident)──► project workflow
```

For each request, the worker:

1. Takes the provider and the repository from the path, and rejects owners other than `ALLOWED_OWNER`.
2. Reads the body, up to 1 MB (1,048,576 bytes, `413` past that, with or without `Content-Length`).
3. Reads the repository's secret for that provider from KV (`<provider>:<owner>/<repo>`) and lets the provider verify the raw body with it. No secret answers like a bad signature (`401`), in the same time, so the configured repositories cannot be found by trying names; the log tells them apart.
4. Lets the provider convert the webhook into the incident format; events it does not use get `204` and stop here.
5. Rejects events sent more than an hour before or after now (`401`), and acknowledges without sending again (`204`) an event it already delivered in the last two hours (remembered in `SECRETS` by the SHA-256 of its body, once GitHub accepted it), so a captured request cannot be replayed. KV is eventually consistent: two copies within about a minute may both go through. On the free plan, KV takes 1,000 writes a day per account: during a storm of incidents past that limit the events are still delivered, but a replay is no longer recognized until the limit resets (each delivery logs `Could not remember the delivery`).
6. Sends an `incident` event to the repository (an error message over 2000 characters is cut, with `…`, to fit GitHub's limits), where the [`incident`](../.github/workflows/incident.yml) workflow turns it into an issue.

How projects use it is in [Production errors](../docs/production-errors.md).

## Files

| Path | What it is |
| --- | --- |
| [`src/index.js`](src/index.js) | The worker: routing, secret lookup, dispatch to GitHub |
| [`src/providers/index.js`](src/providers/index.js) | The provider registry and the incident format every provider produces |
| [`src/providers/nightwatch.js`](src/providers/nightwatch.js) | Laravel Nightwatch: HMAC-SHA256 signature, issue events |
| [`src/signatures.js`](src/signatures.js) | Signature checks shared by providers (HMAC-SHA256) |
| [`src/keys.js`](src/keys.js) | The KV key format, shared with the setup command |
| [`test/`](test) | Tests, run with `npm test` (Vitest) |
| [`wrangler.toml`](wrangler.toml) | Worker name, `ALLOWED_OWNER` and the KV namespace |

## Configuration

| Setting | Where | What it is |
| --- | --- | --- |
| `ALLOWED_OWNER` | `wrangler.toml`, `[vars]` (set by `org` to its organization) | GitHub owner whose repositories may be targeted |
| `SECRETS` | `wrangler.toml`, `[[kv_namespaces]]` (`org` reuses or creates `incident-relay-secrets`) | KV namespace with one entry per repository and provider: `<provider>:<owner>/<repo>` → webhook secret; also the events delivered in the last two hours (`delivery:…`, with a TTL) |
| `GITHUB_TOKEN` | Worker secret | Fine-grained token with **Contents: read and write** on the project repositories |
| `relay.json` | `workflows/relay.json` in `<owner>/.github` | Written by `org`: the worker's URL, the namespace id and the owner, so setup can show the webhook URL and store each repository's secret |

Each repository is a separate KV entry so the setup command can add or replace one without touching the others: Worker secrets cannot be read back, so a single JSON secret would have to be retyped whole every time.

## Deploying

The CLI's `org` command deploys it (see [Organization setup, step 4](../docs/organization-setup.md#4-deploy-the-monitoring-relay-only-for-production-errors)): it copies `src/` of the version it runs to a private folder with a `wrangler.toml` made from this one (the namespace id and `ALLOWED_OWNER` filled in), runs `wrangler deploy`, stores `GITHUB_TOKEN` on stdin and writes `relay.json`. `wrangler.toml` here keeps the placeholder id: it is the template, and what `npm run deploy` needs for a deploy by hand after you fill it in.

After changing the code, run `npm test`, release, and run `org` again, saying yes to updating the relay. A release does not change the deployed worker by itself.

## Registering a repository

The setup command does it (except on Windows). By hand, write the secret to a private file, store it under the repository's key and delete the file:

```bash
read -rs SECRET   # paste the signing secret; it is not shown or saved in the shell history
(umask 077; printf '%s' "$SECRET" > secret.txt)
npx wrangler kv key put "nightwatch:datalogix/app" --namespace-id <id> --path secret.txt --remote
rm -f secret.txt; unset SECRET
```

On Windows, paste the secret into a file with an editor, save it outside any repository, run the same `kv key put` with `--path <file>` and delete the file afterwards; never type the secret in the command line. `<id>` is the `namespaceId` in `workflows/relay.json` of the organization's `.github` repository.

`npx wrangler kv key list --namespace-id <id> --remote` lists the registered repositories (the keys, not the secrets).

## Adding a provider

1. **Write `src/providers/<id>.js`**, exporting `{ id, name, verify, sentAt, normalize }`:
   - `id` is the URL segment and the prefix of its KV keys; `name` is shown in GitHub issues.
   - `verify(request, body, secret)` proves the raw body came from the provider. Use a signature (`verifyHmacSha256`).
   - `sentAt(webhook)` returns when the provider sent the webhook, in epoch milliseconds, from a field covered by the signature.
   - `normalize(webhook)` returns the incident format documented in [`src/providers/index.js`](src/providers/index.js), or `null` for events to ignore. The problem's `id` must be the same in every event about it, so issues are reopened and closed instead of duplicated. `environment.name` must match the GitHub environment (`production`, `staging`).
2. **Register it** in `src/providers/index.js`.
3. **Test it with a real webhook** from the provider, captured from its dashboard or a test delivery: signature format, event names and payload shape are where documentation is most often incomplete.
4. **Document its setup** in [Production errors](../docs/production-errors.md), and teach the setup command to ask for its secret ([`../cli`](../cli/README.md)).

The provider is always chosen by the URL, never by looking at the request. If the worker guessed it from the payload, a forged request could pick the provider with the weakest verification.

## Troubleshooting

The worker's logs (`npx wrangler tail`, or the Cloudflare dashboard) show each request's status:

| Status | Meaning |
| --- | --- |
| `404` | Unknown provider or owner not allowed |
| `401` | `Invalid signature`: wrong secret, the provider signs in another format, or no secret for that repository and provider (the log then says `No <provider> secret for <owner>/<repo>`). `Stale event`: sent more than an hour away from now (replayed, or the provider's clock is off) |
| `413` | The body is over 1 MB (1,048,576 bytes) |
| `400` | The body is not JSON |
| `204` | Delivered to GitHub, already delivered in the last two hours (a replay or a retry), or an event the relay ignores |
| `200` | `GitHub rejected the event` with a 4xx that a retry would not fix: check `GITHUB_TOKEN` (expired, or missing **Contents: write** on the repository); the log has GitHub's answer. Acknowledged so the provider does not retry it, so the incident is lost |
| `502` | `GitHub unreachable`: the request to GitHub failed, see the log. `GitHub rejected the event`: GitHub answered 5xx, 429 or a 403 rate limit; the provider retries |
