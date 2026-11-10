# shellcheck shell=bash
# Netlify: a build of the exact commit through the REST API, with the environment's NETLIFY_TOKEN secret and its
# NETLIFY_SITE_ID variable (one site per environment). The site keeps auto publishing locked, so Netlify's own builds
# of each push never go live: once the build is ready, the wait publishes it and locks it again. A build that fails
# is never published, and the previous deploy stays live

# shellcheck disable=SC2154 # environment_key is set by deploy.sh, which sources this file
netlify_deploy_file="${RUNNER_TEMP:-/tmp}/datalogix-netlify-$environment_key"

# The most the wait follows a build
provider_settle_seconds() {
  echo 900
}

provider_check() {
  if [ -z "${NETLIFY_TOKEN:-}" ]; then
    echo "::error::Add the NETLIFY_TOKEN secret to the $ENVIRONMENT environment (Settings > Environments)"
    exit 1
  fi
  if [ -z "${NETLIFY_SITE_ID:-}" ]; then
    echo "::error::Add the NETLIFY_SITE_ID variable (the Netlify site's id) to the $ENVIRONMENT environment"
    exit 1
  fi
}

# Calls the API (method, path, file for the body, then curl arguments) and prints the HTTP code. The token goes through
# a header file, never in the command line
netlify_call() {
  local method=$1 path=$2 out=$3
  shift 3
  curl -sS -o "$out" -w '%{http_code}' --max-time 60 -X "$method" \
    -H @<(printf 'Authorization: Bearer %s\n' "$NETLIFY_TOKEN") "$@" "https://api.netlify.com/api/v1$path" || true
}

netlify_error() {
  jq -r '.message // empty' "$1" 2>/dev/null || true
}

provider_trigger() {
  local sha=$1 out code id ref
  out=$(mktemp)
  ref=$(jq -rn --arg branch "$BRANCH" '$branch | @uri')
  # The branch the site publishes builds in its production context; the commit makes it build this exact one
  code=$(netlify_call POST "/sites/$NETLIFY_SITE_ID/builds?branch=$ref&commit_sha=$sha" "$out")
  if [ "${code:0:1}" != 2 ]; then
    echo "::error::Netlify answered HTTP ${code:-000}: $(netlify_error "$out")"
    return 1
  fi
  id=$(jq -r '.deploy_id // empty' "$out" 2>/dev/null)
  if [ -z "$id" ]; then
    echo "::error::Netlify did not return the deploy"
    return 1
  fi
  # The wait runs in another step of the same job
  echo "$id" > "$netlify_deploy_file"
  echo "Netlify deploy $id"
}

# Follows the deploy every 10 seconds, for at most the given seconds: once it is ready, publishes it by locking it
# (Netlify publishes a deploy it locks), then waits until the site serves it when the publish is queued (202). A build
# that fails is never published, so there is nothing to roll back: the step fails (1). One still going at the end may
# finish after the job (2)
provider_wait() {
  local limit=$1 waited=0 id out code state="" publishing=false
  id=$(cat "$netlify_deploy_file" 2>/dev/null) || true
  if [ -z "$id" ]; then
    echo "::error::No Netlify deploy to wait for"
    return 1
  fi
  out=$(mktemp)
  while true; do
    if [ "$publishing" = true ]; then
      code=$(netlify_call GET "/sites/$NETLIFY_SITE_ID" "$out")
      if [ "${code:0:1}" = 2 ] && [ "$(jq -r '.published_deploy.id // empty' "$out" 2>/dev/null)" = "$id" ]; then
        echo "Netlify deploy $id is published"
        return 0
      fi
    else
      code=$(netlify_call GET "/deploys/$id" "$out")
      # A failed read is tried again: the deploy goes on
      if [ "${code:0:1}" = 2 ]; then
        state=$(jq -r 'if .skipped == true then "skipped" else .state // empty end' "$out" 2>/dev/null)
        case "$state" in
          ready)
            code=$(netlify_call POST "/deploys/$id/lock" "$out")
            case "$code" in
              200) echo "Netlify deploy $id is published"; return 0 ;;
              # Publishing is gated: the publish and the lock are queued
              202) publishing=true; state=publishing ;;
              *)
                echo "::error::Netlify built the deploy $id but answered HTTP ${code:-000} to its publish: $(netlify_error "$out"); the previous deploy is still live"
                return 1 ;;
            esac ;;
          error | rejected | skipped)
            echo "::error::The Netlify deploy $id ended as $state; the previous deploy is still live"
            return 1 ;;
        esac
      fi
    fi
    if [ "$waited" -ge "$limit" ]; then
      echo "::error::The Netlify deploy $id was not published after $limit seconds (${state:-unknown})"
      return 2
    fi
    sleep 10
    waited=$((waited + 10))
  done
}
