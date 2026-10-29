# shellcheck shell=bash
# Vercel: a deployment of the exact commit through the REST API, with the environment's VERCEL_TOKEN secret and its
# VERCEL_PROJECT variable (the project's id or name; VERCEL_TEAM_ID too for a team's project). The GitHub environment's
# name is the Vercel target (production, staging or a custom environment) unless VERCEL_TARGET names another. The wait
# follows the deployment until it is ready, instead of a fixed time

# shellcheck disable=SC2154 # environment_key is set by deploy.sh, which sources this file
vercel_deployment_file="${RUNNER_TEMP:-/tmp}/datalogix-vercel-$environment_key"

# The most the wait follows a build
provider_settle_seconds() {
  echo 900
}

provider_check() {
  if [ -z "${VERCEL_TOKEN:-}" ]; then
    echo "::error::Add the VERCEL_TOKEN secret to the $ENVIRONMENT environment (Settings > Environments)"
    exit 1
  fi
  if [ -z "${VERCEL_PROJECT:-}" ]; then
    echo "::error::Add the VERCEL_PROJECT variable (the Vercel project's id or name) to the $ENVIRONMENT environment"
    exit 1
  fi
}

# Calls the API (method, path, file for the body, then curl arguments) and prints the HTTP code. The token goes through
# a header file, never in the command line
vercel_call() {
  local method=$1 path=$2 out=$3 url
  shift 3
  url="https://api.vercel.com$path"
  if [ -n "${VERCEL_TEAM_ID:-}" ]; then
    if [[ "$url" == *\?* ]]; then url+="&teamId=$VERCEL_TEAM_ID"; else url+="?teamId=$VERCEL_TEAM_ID"; fi
  fi
  curl -sS -o "$out" -w '%{http_code}' --max-time 60 -X "$method" \
    -H @<(printf 'Authorization: Bearer %s\n' "$VERCEL_TOKEN") "$@" "$url" || true
}

provider_trigger() {
  local sha=$1 out code id
  out=$(mktemp)
  # forceNew: a rollback deploys a commit Vercel already built, which it would otherwise answer with that deployment
  # shellcheck disable=SC2154 # environment_key is set by deploy.sh
  code=$(jq -n --arg project "$VERCEL_PROJECT" --arg target "${VERCEL_TARGET:-$environment_key}" \
    --arg org "${GITHUB_REPOSITORY%%/*}" --arg repo "${GITHUB_REPOSITORY#*/}" --arg ref "$BRANCH" --arg sha "$sha" \
    '{name: $project, project: $project, target: $target, gitSource: {type: "github", org: $org, repo: $repo, ref: $ref, sha: $sha}}' |
    vercel_call POST "/v13/deployments?forceNew=1" "$out" -H 'Content-Type: application/json' --data @-)
  if [ "${code:0:1}" != 2 ]; then
    echo "::error::Vercel answered HTTP ${code:-000}: $(jq -r '.error.message // empty' "$out" 2>/dev/null)"
    return 1
  fi
  id=$(jq -r '.id // empty' "$out" 2>/dev/null)
  if [ -z "$id" ]; then
    echo "::error::Vercel did not return the deployment"
    return 1
  fi
  # The wait runs in another step of the same job
  echo "$id" > "$vercel_deployment_file"
  echo "Vercel deployment $id"
}

# Follows the deployment every 10 seconds until it is ready, for at most the given seconds. A build that fails leaves
# the previous deployment live, so there is nothing to roll back: the step fails
provider_wait() {
  local limit=$1 waited=0 id out code state
  id=$(cat "$vercel_deployment_file" 2>/dev/null) || true
  if [ -z "$id" ]; then
    echo "::error::No Vercel deployment to wait for"
    return 1
  fi
  out=$(mktemp)
  while true; do
    code=$(vercel_call GET "/v13/deployments/$id" "$out")
    # A failed read is tried again: the deployment goes on
    if [ "${code:0:1}" = 2 ]; then
      state=$(jq -r '.readyState // empty' "$out" 2>/dev/null)
      case "$state" in
        READY) echo "Vercel deployment $id is ready"; return 0 ;;
        ERROR | CANCELED)
          echo "::error::The Vercel deployment $id ended as $state; the previous deployment is still live"
          return 1 ;;
      esac
    fi
    if [ "$waited" -ge "$limit" ]; then
      echo "::error::The Vercel deployment $id was not ready after $limit seconds (${state:-unknown})"
      return 1
    fi
    sleep 10
    waited=$((waited + 10))
  done
}
