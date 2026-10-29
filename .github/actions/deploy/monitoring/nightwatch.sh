# shellcheck shell=bash
# Laravel Nightwatch, with deploy markers sent with the environment's NIGHTWATCH_TOKEN. Laravel Cloud already reports
# its deploys to Nightwatch, so only the other providers mark them here

monitoring_name() {
  echo Nightwatch
}

mark_nightwatch() {
  local sha=$1 name=$2
  [ "$PROVIDER" != cloud ] && [ -n "${NIGHTWATCH_TOKEN:-}" ] || return 0
  # The token goes through a header file, never in the command line
  jq -n --arg deploy "$sha" --arg ref "$sha" --arg name "$name" --arg url "$RUN_URL" '{deploy: $deploy, ref: $ref, name: $name, url: $url}' |
    curl -sS --fail --max-time 30 -o /dev/null -X POST https://nightwatch.laravel.com/api/deployments \
      -H @<(printf 'Authorization: Bearer %s\n' "$NIGHTWATCH_TOKEN") -H 'Content-Type: application/json' --data @- ||
    echo "::warning::Could not report the deploy to Nightwatch"
}
