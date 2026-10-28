# Organization setup

Done once, before [adding the first project](laravel/app.md). Each step explains what it is for.

Steps 1 and 2 are required. Steps 3 and 4 are optional (the shared issue forms, and Nightwatch problems as issues) and are done by the `org` command, which also checks step 1. An organization admin runs it from any folder (from macOS or Linux, to deploy the relay), before setting up the projects:

```bash
npx --allow-git=root github:datalogix/workflows#v2 org --org datalogix
```

It checks the Claude GitHub App, creates the public `datalogix/.github` repository with the issue forms of this version, deploys the monitoring relay (it logs in to Cloudflare in the browser and asks for the relay's GitHub token, with a link that fills the token in), and lists what is left by hand. Running it again updates the issue forms, and the relay when you say so (also to replace its token).

## 1. Install the Claude GitHub App

Install the [Claude GitHub App](https://github.com/apps/claude) on the organization, with access to all repositories (or to every project that uses these workflows). `org` tells whether it is installed; that takes the `admin:org` scope (`gh auth refresh -s admin:org`).

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

`org` creates the public repository `datalogix/.github` and writes the files of [`examples/issue-templates`](../examples/issue-templates) to `.github/ISSUE_TEMPLATE/` in it. The repository must be public: GitHub only shares a public one's forms.

**Why:** GitHub uses them in every repository of the organization that has no issue templates of its own. Opening an issue with **Tarefa para o Claude** applies the `claude` label (Claude implements it); **Planejar com o Claude** applies `claude-plan` (Claude only posts a plan).

## 4. Deploy the monitoring relay (only for production errors)

Skip this if you do not want Nightwatch problems turned into issues: leave the token empty when `org` asks for it.

`org` deploys the relay of the version it runs to Cloudflare Workers, with:

1. A **fine-grained GitHub token** owned by the organization, for all repositories, with **Contents: read and write**: GitHub requires it to receive the `repository_dispatch` events the relay sends. `org` shows a link that fills it in; it expires after a year at most, so note the date and run `org` again with a new one before then.
2. A Cloudflare login, opened in the browser the first time. The first deploy of an account may ask to choose its `workers.dev` subdomain in the Cloudflare dashboard.

It stores the worker's URL, its KV namespace and the organization in `workflows/relay.json` of `datalogix/.github`, where every project's setup reads them. To update the relay after a release changes it, run `org` again and say yes to updating it.

**Why:** Nightwatch cannot call GitHub directly, because GitHub requires an authorization header that Nightwatch webhooks cannot send. The relay checks that each webhook really came from Nightwatch, with the secret stored for that repository, and forwards it. It only targets repositories of the organization it was deployed for (`ALLOWED_OWNER`). Each repository's secret is a separate entry in the `SECRETS` namespace, so the setup command can add a project without touching the others.

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
