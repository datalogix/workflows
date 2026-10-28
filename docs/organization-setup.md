# Organization setup

Done once, before [adding the first project](laravel/app.md). Each step explains what it is for.

## 1. Install the Claude GitHub App

Install the [Claude GitHub App](https://github.com/apps/claude) on the organization, with access to all repositories (or to every project that uses these workflows).

**Why:** the workflows act as `claude[bot]` through this App. Its commits, comments and pull requests trigger the other workflows (tests, reviews) normally, which commits made with the default `GITHUB_TOKEN` would not.

## 2. Generate the Claude token

```bash
claude setup-token
```

Where it goes depends on the organization's plan, because [organization secrets are not available to private repositories on GitHub Free](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets):

- **GitHub Team or Enterprise**: store it once as an organization secret, and no project has to configure it:

  ```bash
  gh secret set CLAUDE_CODE_OAUTH_TOKEN --org datalogix --visibility all
  ```

- **GitHub Free**: store it in each project as a repository secret; [setup](laravel/app.md#step-1-run-setup) asks for it when the project cannot read one. To renew it in every project at once:

  ```bash
  read -rs TOKEN   # paste the token; it is not shown or saved in the shell history
  for repo in app other-app; do
    gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "datalogix/$repo" --body "$TOKEN"
  done
  unset TOKEN
  ```

  Keep the list of repositories somewhere you will find it: the same loop renews the token when it expires.

**Why:** every Claude workflow needs it. All projects share the usage limits of the account that generated it (see [Models and usage](claude.md#models-and-usage)).

## 3. Share the issue forms (optional)

Create a repository named `datalogix/.github` and copy the files from [`examples/issue-templates`](../examples/issue-templates) to `.github/ISSUE_TEMPLATE/` in it.

**Why:** GitHub uses them in every repository of the organization that has no issue templates of its own. Opening an issue with **Tarefa para o Claude** applies the `claude` label (Claude implements it); **Planejar com o Claude** applies `claude-plan` (Claude only posts a plan).

## 4. Deploy the monitoring relay (only for production errors)

Skip this if you do not want Nightwatch problems turned into issues.

1. Create a **fine-grained GitHub token** owned by the organization, with access to the project repositories and the **Contents: read and write** permission. GitHub requires it to receive the `repository_dispatch` events the relay sends.
2. Create the relay's storage and deploy it to Cloudflare Workers (the first `wrangler` command asks you to log in to Cloudflare):

   ```bash
   cd relay
   npm install
   npx wrangler kv namespace create SECRETS   # copy the id it prints into relay/wrangler.toml
   npx wrangler secret put GITHUB_TOKEN        # paste the token
   npx wrangler deploy                         # prints the worker URL
   ```

3. Put the worker URL in [`cli/config.json`](../cli/config.json) (`"relayUrl": "https://incident-relay.<account>.workers.dev"`), commit both files and publish a release: the setup command reads them from the released version.

**Why:** Nightwatch cannot call GitHub directly, because GitHub requires an authorization header that Nightwatch webhooks cannot send. The relay checks that each webhook really came from Nightwatch, with the secret stored for that repository, and forwards it. It only targets repositories of `ALLOWED_OWNER` (in [`relay/wrangler.toml`](../relay/wrangler.toml)). Each repository's secret is a separate entry in the `SECRETS` namespace, so the setup command can add a project without touching the others.

## 5. Create the task manager's GitHub App

Skip this if client tasks are not tracked in a task manager. The task manager must be reachable at a public URL.

1. In **Organization settings → Developer settings → GitHub Apps → New GitHub App**, create an App with:

   | Setting                   | Value                                                                                       |
   | ------------------------- | ------------------------------------------------------------------------------------------- |
   | Webhook URL               | The task manager's endpoint for GitHub events, e.g. `https://<task-manager>/github/webhook` |
   | Webhook secret            | A random value, also stored in the task manager's configuration                             |
   | Permissions               | Issues: read and write, Metadata: read                                                      |
   | Subscribe to events       | Issues                                                                                      |
   | Where can it be installed | Any account, so client organizations can install it                                         |

2. Generate a private key and store it, with the App ID, in the task manager's configuration.
3. Install the App on the organization, and on each client organization that holds a project's repository.

**Why:** GitHub sends a webhook to the task manager on every issue event in the repositories where the App is installed, signed with the secret, and the task manager uses the same App to create issues from tasks. An App, unlike an organization webhook, can be installed in client organizations. What the task manager does with each event is in [Task manager](task-manager.md).

## 6. Create the release GitHub App

Optional. Without it, release pull requests (`production-branch`, see [Production branch](deploy.md#production-branch)) are opened by GitHub Actions and run no checks, so the production branch cannot require them. Skip it if no project has a production branch, or if they are all private repositories on GitHub Free, where no branch can be protected anyway.

1. In **Organization settings → Developer settings → GitHub Apps → New GitHub App**, create an App with:

   | Setting                   | Value                                                        |
   | ------------------------- | ------------------------------------------------------------ |
   | Webhook                   | Off                                                          |
   | Permissions               | Contents: read, Pull requests: read and write, Metadata: read |
   | Where can it be installed | Only on this account                                         |

2. Generate a private key, and install the App on the project repositories (or all repositories).
3. Store the App's **Client ID** and private key as organization secrets available to those repositories:

   ```bash
   gh secret set RELEASE_APP_CLIENT_ID --org datalogix --visibility all --body "<client id>"
   gh secret set RELEASE_APP_PRIVATE_KEY --org datalogix --visibility all < release-app.private-key.pem
   ```

   On GitHub Free, private repositories cannot read organization secrets: setup asks for the Client ID and the key file and stores both as repository secrets (or use `--repo datalogix/<repo>` instead of `--org ... --visibility all`).

**Why:** GitHub runs no workflows for pull requests opened with a workflow's own token. A token of the App, created for each run, opens them as the App instead, so they run the checks the branch ruleset can then require.
