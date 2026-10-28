# Manual setup of a Laravel app

What [the setup command](app.md#step-1-run-setup) does, step by step, for when you cannot run it. Replace `OWNER/REPO` with the project's repository. After this, continue with [step 2 of Adding a Laravel app](app.md#step-2-do-what-setup-cannot).

## Workflow file

Copy [`examples/project.yml`](../../examples/project.yml) to `.github/workflows/datalogix.yml`. If the default branch is not `main`, change `branches: [main]` under `push:` to it; with [`production-branch`](../deploy.md#production-branch), list both branches (e.g. `branches: [develop, main]`), otherwise pushes to the one left out run nothing. Then set its inputs:

```yaml
jobs:
  pipeline:
    uses: datalogix/workflows/.github/workflows/project.yml@v2
    secrets: inherit
    with:
      deploy: forge        # forge or cloud; remove the line to disable deploys
      count-author: true   # you work alone: your own pull requests count as reviewed by you
      language: en         # pt-BR by default; remove the line to keep it
      phpstan: false       # Pint and PHPStan run when installed; false turns each off
      test-command: php artisan test   # when composer test also runs Pint or PHPStan; none turns the suite off
```

See [Lint and test suite](app-tests.md#lint-and-test-suite) for `lint-command` and what setup suggests.

## Labels

```bash
gh label create claude      --repo OWNER/REPO --color 1d76db --description "Claude implementa e abre um pull request" --force
gh label create claude-plan --repo OWNER/REPO --color 0e8a16 --description "Claude publica um plano de implementação" --force
gh label create no-review   --repo OWNER/REPO --color ededed --description "Pula a revisão do Claude" --force
gh label create rollback    --repo OWNER/REPO --color b60205 --description "Reverte o ambiente para a versão anterior" --force
# With deploy, one per environment (env:staging only with staging): rollback on an issue with one rolls that environment back
gh label create env:production --repo OWNER/REPO --color c5def5 --description "Ambiente do problema; o label rollback reverte este ambiente" --force
gh label create env:staging    --repo OWNER/REPO --color c5def5 --description "Ambiente do problema; o label rollback reverte este ambiente" --force
```

For an English project (`language` starting with `en`), use the English descriptions: "Claude implements it and opens a pull request", "Claude posts an implementation plan", "Skips Claude's review", "Rolls the environment back to the previous release" and, for the `env:` labels, "Environment of the problem; the rollback label rolls this environment back".

## Claude token

GitHub Free only:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo OWNER/REPO
```

## Environments

```bash
for env in staging production; do
  gh api --method PUT "repos/OWNER/REPO/environments/$env" >/dev/null
done
gh secret set DEPLOY_HOOK --repo OWNER/REPO --env staging
gh variable set HEALTH_URL --repo OWNER/REPO --env staging --body "https://dev.example.com/up"
gh secret set DEPLOY_HOOK --repo OWNER/REPO --env production
gh variable set HEALTH_URL --repo OWNER/REPO --env production --body "https://example.com/up"
# Forge only, optional: marks deploys in Nightwatch
gh secret set NIGHTWATCH_TOKEN --repo OWNER/REPO --env staging
gh secret set NIGHTWATCH_TOKEN --repo OWNER/REPO --env production
```

## Health check

Laravel 11 and newer enable `/up` in `bootstrap/app.php` (`health: '/up'` in `withRouting()`). To make it fail when the database is unreachable, add to `AppServiceProvider::boot()`:

```php
use Illuminate\Foundation\Events\DiagnosingHealth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;

Event::listen(DiagnosingHealth::class, function () {
    DB::connection()->getPdo();
});
```

On Laravel 10 or older, create a route that answers `200` and use it instead.

## Relay

Store the Nightwatch signing secret under the key `nightwatch:OWNER/REPO`. `<id>` is the `namespaceId` in `workflows/relay.json` of the organization's `.github` repository. The secret goes through a file only you can read, removed right after, so it never appears in a command line:

```bash
read -rs SECRET   # paste the signing secret; it is not shown or saved in the shell history
(umask 077; printf '%s' "$SECRET" > secret.txt)
npx wrangler kv key put "nightwatch:OWNER/REPO" --namespace-id <id> --path secret.txt --remote
rm -f secret.txt; unset SECRET
```

## Code owners

In team projects, create `.github/CODEOWNERS` with the people (or team) who must approve changes to the workflows, as its last line:

```
/.github/ @user @datalogix/team
```

## Ruleset

```bash
gh api --method POST repos/OWNER/REPO/rulesets --input - <<'JSON'
{
  "name": "datalogix",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "pipeline / tests / tests" },
          { "context": "pipeline / security / security" },
          { "context": "pipeline / gate / gate" }
        ]
      }
    }
  ]
}
JSON
```

List only the checks of the layers that are on (`tests` → `pipeline / tests / tests`, `security-review` → `pipeline / security / security`, `risk-gate` → `pipeline / gate / gate`); with all three off, remove the whole `required_status_checks` rule.

In team projects, set `require_code_owner_review`, `dismiss_stale_reviews_on_push` and `require_last_push_approval` to `true`, so changes to `.github/` need the approval of its code owners given after the last push (an approval of an earlier commit would let a later push lower the checks). Solo maintainers keep the three `false`: they cannot approve their own pull requests.

## Production branch

Only with [`production-branch`](../deploy.md#production-branch) (which needs a staging environment). Create the missing branch (the production branch from the one that deploys production today, the development branch from the default branch) and make the development branch the default one:

```bash
gh api --method POST repos/OWNER/REPO/git/refs -f ref=refs/heads/develop -f sha="$(gh api repos/OWNER/REPO/commits/main --jq .sha)"
gh repo edit OWNER/REPO --default-branch develop
```

Then let the release and sync pull requests be opened, in one of two ways:

- **With the release GitHub App** of [Organization setup, step 6](../organization-setup.md#6-create-the-release-github-app), unless its secrets are shared with the repository by the organization:

  ```bash
  gh secret set RELEASE_APP_CLIENT_ID --repo OWNER/REPO
  gh secret set RELEASE_APP_PRIVATE_KEY --repo OWNER/REPO < release-app.private-key.pem
  ```

  The release pull requests then run the checks, so add the production branch to the ruleset: `"include": ["~DEFAULT_BRANCH", "refs/heads/main"]`.
- **Without it**, turn on **Allow GitHub Actions to create and approve pull requests** (repository **Settings > Actions > General**; the organization must allow it first) and leave the production branch out of the ruleset: those pull requests run no checks, so requiring them would block every release.
