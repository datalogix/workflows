#!/usr/bin/env bash
# One step of a deploy or rollback, chosen by the first argument. Settings come from the environment (see action.yml).
set -euo pipefail

# Lowercase, like the GitHub environment names (case-insensitive) and the monitoring names the incident workflow reads
# shellcheck disable=SC2153 # ENVIRONMENT is set by the step env in deploy.yml
environment_key=$(tr '[:upper:]' '[:lower:]' <<< "$ENVIRONMENT")

# shellcheck source=SCRIPTDIR/../lib/language.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/language.sh"
# shellcheck source=SCRIPTDIR/../lib/github.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/github.sh"
# shellcheck source=SCRIPTDIR/../lib/inputs.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/inputs.sh"
# shellcheck source=SCRIPTDIR/../lib/releases.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/releases.sh"

# The deploy provider (providers/<id>.sh) defines provider_settle_seconds (prints the seconds a deploy usually takes, or
# the most provider_wait <seconds> follows it, when the provider can tell it finished), provider_check and
# provider_trigger <sha>,
# which returns non-zero, with an ::error::, when the provider did not accept the deploy. The name is checked before it
# becomes a path
providers_dir="$(dirname "${BASH_SOURCE[0]}")/providers"
if [[ ! "${PROVIDER:-}" =~ ^[a-z][a-z0-9-]*$ ]] || [ ! -f "$providers_dir/$PROVIDER.sh" ]; then
  known=""
  for file in "$providers_dir"/*.sh; do known+="${known:+, }$(basename "$file" .sh)"; done
  echo "::error::provider must be one of $known, got '${PROVIDER:-}'"
  exit 1
fi
# shellcheck source=/dev/null
source "$providers_dir/$PROVIDER.sh"

# The monitoring service (monitoring/<id>.sh) defines monitoring_name and, with deploy markers, mark_<id> <sha> <name>,
# which marks a deploy when the environment has its token and only warns when it cannot. none, or a service without a
# script, has neither
monitoring=${MONITORING:-nightwatch}
monitoring_file="$(dirname "${BASH_SOURCE[0]}")/monitoring/$monitoring.sh"
if [[ "$monitoring" =~ ^[a-z][a-z0-9-]*$ ]] && [ -f "$monitoring_file" ]; then
  # shellcheck source=/dev/null
  source "$monitoring_file"
fi

history=$(history_ref "$environment_key")
rejected=$(rolled_back_ref "$environment_key")
live_path=$(live_ref "$environment_key")

record_good() {
  local sha=$1 entries old kept
  gh api "repos/$GITHUB_REPOSITORY/git/refs" -f "ref=refs/$history/$(date +%s%N)" -f "sha=$sha" >/dev/null || return 1
  # The entries as "<time> <sha>", newest first. Not pruned when the history cannot be read, which would look like an
  # empty one
  entries=$(gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/$history/" --jq '.[] | "\(.ref | split("/") | last) \(.object.sha)"' |
    sort -rn) || return 0
  tail -n +31 <<< "$entries" |
    while read -r old _; do gh api -X DELETE "repos/$GITHUB_REPOSITORY/git/refs/$history/$old" >/dev/null || true; done
  # Rolled-back marks of releases no longer in the history exclude nothing
  kept=$(head -n 30 <<< "$entries" | cut -d ' ' -f 2)
  gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/$rejected/" --jq '.[].object.sha' |
    { grep -vxF -f <(printf '%s\n' "$kept") || true; } |
    while read -r old; do gh api -X DELETE "repos/$GITHUB_REPOSITORY/git/refs/$rejected/$old" >/dev/null || true; done || true
}

# The release is healthy: recording it is bookkeeping, and failing here would roll a healthy release back
record_good_or_warn() {
  record_good "$1" || echo "::warning::Could not record ${1:0:7} in the release history of $ENVIRONMENT"
}

set_live() {
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/git/refs/$live_path" -f "sha=$1" -F force=true >/dev/null 2>&1 ||
    gh api "repos/$GITHUB_REPOSITORY/git/refs" -f "ref=refs/$live_path" -f "sha=$1" >/dev/null 2>&1 ||
    echo "::warning::Could not record ${1:0:7} as the live release of $ENVIRONMENT"
}

mark_rolled_back() {
  gh api "repos/$GITHUB_REPOSITORY/git/refs" -f "ref=refs/$rejected/$1" -f "sha=$1" >/dev/null 2>&1 || true
}

# For providers deployed by a hook: the DEPLOY_HOOK secret is required
require_deploy_hook() {
  if [ -z "${DEPLOY_HOOK:-}" ]; then
    echo "::error::Add the DEPLOY_HOOK secret to the $ENVIRONMENT environment (Settings > Environments)"
    exit 1
  fi
}

# POSTs to the deploy hook with the given query parameters (curl --data-urlencode ...). No retries: a hook that
# answered late may have deployed already
post_hook() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 60 -X POST --get "$@" "$DEPLOY_HOOK" || true)
  if [ "${code:0:1}" != 2 ]; then
    echo "::error::The deploy hook answered HTTP ${code:-000}"
    return 1
  fi
}

trigger() {
  local sha=$1
  provider_trigger "$sha" || return 1
  set_live "$sha"
  echo "Deploy of $sha to $ENVIRONMENT triggered"
}

settle() {
  local seconds=${1:-0}
  if [ "$seconds" -eq 0 ]; then
    seconds=$(provider_settle_seconds)
  fi
  # A provider that can tell when the deploy finished follows it, for at most those seconds
  if declare -F provider_wait >/dev/null; then
    echo "Waiting up to $seconds seconds for $PROVIDER to finish the deploy"
    provider_wait "$seconds"
    return
  fi
  echo "Waiting $seconds seconds for $PROVIDER to finish the deploy"
  sleep "$seconds"
}

# Checks the health URL every 30 seconds for the given minutes; fails after max-failures consecutive errors. A run of
# errors still open when the minutes end is followed until it ends, so a release failing at the end (or a window with
# fewer checks than max-failures) is not taken as healthy
watch_health() {
  # As a decimal number: arithmetic reads 08 as octal and fails, which would end the loop before any check
  local minutes=$((10#$1)) fails=0 check=0 code
  while ((check < minutes * 2 || fails > 0)); do
    if ((check > 0)); then sleep 30; fi
    check=$((check + 1))
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$HEALTH_URL" 2>/dev/null || true)
    if [ "$code" = 200 ]; then
      fails=0
    else
      fails=$((fails + 1))
      echo "::warning::$HEALTH_URL answered HTTP ${code:-000} ($fails in a row)"
      if [ "$fails" -ge "$MAX_FAILURES" ]; then
        return 1
      fi
    fi
  done
}

# Marks the deploy in the monitoring service, when it has deploy markers
report_markers() {
  if declare -F "mark_$monitoring" >/dev/null; then "mark_$monitoring" "$1" "$2"; fi
}

check() {
  case "$MODE" in
    deploy | rollback) ;;
    *) echo "::error::mode must be deploy or rollback, got '$MODE'"; exit 1 ;;
  esac
  provider_check
  if [ -z "$HEALTH_URL" ]; then
    echo "::error::Add the HEALTH_URL variable to the $ENVIRONMENT environment, e.g. https://example.com/up"
    exit 1
  fi
  # Inputs of type number accept decimals: checked before the deploy, since watch would fail after it and roll back
  whole_number settle-seconds "${SETTLE:-0}" 0
  whole_number watch-minutes "${MINUTES:-}" 1
  whole_number max-failures "${MAX_FAILURES:-}" 1

  # Labels only need triage access; a rollback needs write access
  if [ "$MODE" = rollback ]; then
    local permission
    # An error other than 404 (rate limit, server error) is not a lack of access
    if ! permission=$(collaborator_permission "${SENDER:-}"); then
      echo "::error::Could not read the permission of ${SENDER:-} to roll back $ENVIRONMENT: $permission (add the label again)"
      exit 1
    fi
    if ! is_write_permission "$permission"; then
      echo "::error::${SENDER:-} needs write access to roll back $ENVIRONMENT (has '${permission:-none}')"
      exit 1
    fi
  fi
}

choose() {
  if [ "$MODE" = deploy ]; then
    echo "sha=$GITHUB_SHA" >> "$GITHUB_OUTPUT"
    return 0
  fi

  local releases live target
  if ! releases=$(good_releases "$environment_key"); then
    echo "::error::Cannot read the release history of $ENVIRONMENT"
    exit 1
  fi
  # The live release may be one that failed and stayed (rollback off, or the automatic rollback failed), which the
  # history of good releases does not have
  live=$(live_release "$environment_key") || exit 1
  [ -n "$live" ] || live=$(head -n 1 <<< "$releases")
  if [ -z "$live" ]; then
    echo "::error::No release of $ENVIRONMENT recorded yet; the history starts with the first deploy made by this workflow"
    exit 1
  fi
  target=$(previous_release "$releases" "$live")
  if [ -z "$target" ]; then
    echo "::error::No release of $ENVIRONMENT before ${live:0:7} to roll back to"
    exit 1
  fi

  echo "from=$live" >> "$GITHUB_OUTPUT"
  echo "sha=$target" >> "$GITHUB_OUTPUT"
  echo "Rolling $ENVIRONMENT back from ${live:0:7} to ${target:0:7}"
}

deploy() {
  local name
  trigger "$SHA"
  if [ "$MODE" = rollback ]; then
    # Only now that the environment changed: never return to the release rolled back, even if it passed its checks
    mark_rolled_back "${FROM:-}"
    name="$ENVIRONMENT rollback to ${SHA:0:7}"
  else
    name="$ENVIRONMENT ${SHA:0:7}"
  fi
  report_markers "$SHA" "$name"
}

watch() {
  # shellcheck disable=SC2153 # MINUTES is set by the step env in deploy.yml
  if watch_health "$MINUTES"; then
    record_good_or_warn "$SHA"
    echo "$ENVIRONMENT healthy for $MINUTES minutes after deploying ${SHA:0:7}" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "::error::$ENVIRONMENT failed its health checks after deploying ${SHA:0:7}"
    exit 1
  fi
}

rollback() {
  local releases target
  # Without a target nothing is attempted, and the issue says so
  if ! releases=$(good_releases "$environment_key"); then
    echo "::error::Cannot read the release history of $ENVIRONMENT to roll back"
    echo "target=" >> "$GITHUB_OUTPUT"
    exit 1
  fi
  target=$(previous_release "$releases" "$GITHUB_SHA")
  if [ -z "$target" ]; then
    echo "::error::No previous good release of $ENVIRONMENT to roll back to"
    echo "target=" >> "$GITHUB_OUTPUT"
    exit 1
  fi

  echo "target=$target" >> "$GITHUB_OUTPUT"
  echo "Rolling $ENVIRONMENT back to $target"
  trigger "$target"
  # Only now that the environment changed, as in a rollback by label: a release recorded as good before (deployed
  # again with Re-run jobs) is never a rollback target after failing
  mark_rolled_back "$GITHUB_SHA"
  report_markers "$target" "$ENVIRONMENT rollback to ${target:0:7}"

  settle "${SETTLE:-0}"
  if watch_health 3; then
    record_good_or_warn "$target"
    echo "Rolled $ENVIRONMENT back to ${target:0:7}" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "::error::$ENVIRONMENT is still failing after the rollback to ${target:0:7}"
    exit 1
  fi
}

# Where to look after a failed deploy: the monitoring service's errors, when there is one, and the provider's logs
errors_hint() {
  local rerun_en="To redeploy this commit after the fix, use **Re-run jobs** on this run: $RUN_URL"
  local rerun_pt="Para redeployar este commit depois da correção, use **Re-run jobs** nesta execução: $RUN_URL"
  if declare -F monitoring_name >/dev/null; then
    local name
    name=$(monitoring_name)
    t "Check the errors in $name and the deploy logs in $PROVIDER. $rerun_en" \
      "Verifique os erros no $name e os logs do deploy no $PROVIDER. $rerun_pt"
  else
    t "Check the deploy logs in $PROVIDER. $rerun_en" "Verifique os logs do deploy no $PROVIDER. $rerun_pt"
  fi
}

open_issue() {
  local short=${GITHUB_SHA:0:7} result body
  # shellcheck disable=SC2153 # TARGET is set by the step env in deploy.yml
  case "${ROLLBACK:-}" in
    success)
      result=$(t "The environment was rolled back automatically to \`${TARGET:0:7}\` and is responding again." \
        "O ambiente foi revertido automaticamente para \`${TARGET:0:7}\` e voltou a responder.") ;;
    failure)
      if [ -n "${TARGET:-}" ]; then
        result=$(t "**The automatic rollback to \`${TARGET:0:7}\` did not help**. The environment needs attention now." \
          "**A reversão automática para \`${TARGET:0:7}\` não resolveu**. O ambiente precisa de atenção agora.")
      else
        result=$(t "**The automatic rollback could not start** (no earlier good release, or the release history could not be read: see the run); the environment still runs \`$short\` and needs attention now." \
          "**A reversão automática não pôde começar** (não há versão boa anterior, ou o histórico de versões não pôde ser lido: veja a execução); o ambiente continua com \`$short\` e precisa de atenção agora.")
      fi ;;
    *)
      result=$(t "The automatic rollback is off; the environment still runs \`$short\`." \
        "A reversão automática está desligada; o ambiente continua com \`$short\`.") ;;
  esac
  body=$(printf '%s\n\n%s\n\n%s\n\n%s' \
    "$(t "The deploy of commit $GITHUB_SHA to **$ENVIRONMENT** failed the health checks of \`$HEALTH_URL\`." \
      "O deploy do commit $GITHUB_SHA em **$ENVIRONMENT** falhou nos health checks de \`$HEALTH_URL\`.")" \
    "$result" \
    "$(errors_hint)" \
    "$(t "To ask Claude to investigate, add the \`claude-plan\` label." \
      "Para pedir ao Claude que investigue, adicione o label \`claude-plan\`.")")

  # The env:<name> label makes the rollback label revert this environment, as in the incident issues. Not after an
  # automatic rollback that worked: the rollback label would revert the healthy release it went back to
  local labels=()
  if [ "${ROLLBACK:-}" != success ]; then
    environment_label "$environment_key"
    labels=(--label "env:$environment_key")
  fi
  gh issue create --repo "$GITHUB_REPOSITORY" \
    --title "$(t "Deploy of $short to $ENVIRONMENT failed" "Deploy de $short em $ENVIRONMENT falhou")" \
    --body "$body" ${labels[@]+"${labels[@]}"}
}

report_rollback() {
  local body view
  view="[$(t "View run" "Ver execução")]($RUN_URL)"
  case "${RESULT:-}" in
    success)
      body=$(t "**$ENVIRONMENT** was rolled back from \`${FROM:0:7}\` to \`${SHA:0:7}\` and is responding normally. Release \`${FROM:0:7}\` will not be used in future rollbacks. To publish it again once fixed, merge again." \
        "**$ENVIRONMENT** foi revertido de \`${FROM:0:7}\` para \`${SHA:0:7}\` e está respondendo normalmente. A versão \`${FROM:0:7}\` não será usada em reversões futuras. Para voltar a publicá-la depois de corrigida, faça um novo merge.") ;;
    cancelled)
      body=$(t "The rollback of **$ENVIRONMENT** to \`${SHA:0:7}\` was triggered, but the check was interrupted (timeout or cancellation). Check the environment." \
        "A reversão de **$ENVIRONMENT** para \`${SHA:0:7}\` foi disparada, mas a verificação foi interrompida (tempo esgotado ou cancelamento). Confira o ambiente.") ;;
    failure)
      body=$(t "**The rollback of $ENVIRONMENT to \`${SHA:0:7}\` failed the health checks.** The environment needs attention now." \
        "**A reversão de $ENVIRONMENT para \`${SHA:0:7}\` falhou nos health checks.** O ambiente precisa de atenção agora.") ;;
    *)
      body=$(t "Could not roll back **$ENVIRONMENT**: see the reason in the run." \
        "Não foi possível reverter **$ENVIRONMENT**: veja o motivo na execução.") ;;
  esac
  gh issue comment "$ISSUE" --repo "$GITHUB_REPOSITORY" --body "$body $view"
  # So the label can be added again for another rollback
  gh issue edit "$ISSUE" --repo "$GITHUB_REPOSITORY" --remove-label "$LABEL" >/dev/null || true
}

case "${1:-}" in
  check) check ;;
  choose) choose ;;
  deploy) deploy ;;
  settle) settle "${SETTLE:-0}" ;;
  watch) watch ;;
  rollback) rollback ;;
  open-issue) open_issue ;;
  report-rollback) report_rollback ;;
  *) echo "::error::Unknown deploy step '${1:-}'"; exit 1 ;;
esac
