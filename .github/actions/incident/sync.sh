#!/usr/bin/env bash
# Creates, reopens or closes the GitHub issue of a monitoring problem. Settings come from the environment (see action.yml).
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/language.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/language.sh"
# shellcheck source=SCRIPTDIR/../lib/github.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/github.sh"
# shellcheck source=SCRIPTDIR/../lib/releases.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/releases.sh"

if ! jq -en --argjson e "$ENVIRONMENTS" --argjson t "$TYPES" '($e | type) == "array" and ($t | type) == "array"' >/dev/null 2>&1; then
  echo "::error::environments and types must be JSON lists, e.g. [\"production\"] and [\"exception\"]"
  exit 1
fi

payload=$(jq '.client_payload' "$GITHUB_EVENT_PATH")
event=$(jq -r '.event // empty' <<< "$payload")
provider_id=$(jq -r '.provider.id // empty' <<< "$payload")
provider=$(jq -r '.provider.name // .provider.id' <<< "$payload")
problem_id=$(jq -r '.issue.id // empty' <<< "$payload")
if [ -z "$provider_id" ] || [ -z "$problem_id" ]; then
  echo "::error::The payload has no provider or problem id"
  exit 1
fi
marker="<!-- incident:$provider_id:$problem_id -->"

# The release the issue's analysis was made with, written on the line before the marker of its body and at the end of the
# comments that ask for a new analysis
release_marker() {
  echo "<!-- incident-live:$1 -->"
}

# The issue of the problem, as "<number> <OPEN|CLOSED>", followed by " release:<sha>" when its body records the release
# of its first analysis, on the line before the marker: the marker is the last incident marker of its body (the message
# from the application, before it, could contain another one; text someone adds after it does not hide the issue)
with_marker() {
  jq -rs --arg marker "$marker" '
    def lines: .body // "" | split("\n") | map(rtrimstr("\r"));
    [.[] | select(.pull_request | not) | lines as $lines
      | ([range(0; $lines | length) | select($lines[.] | test("^<!-- incident:.+ -->$"))] | last) as $at
      | select($at != null and $lines[$at] == $marker) | .release_line = (if $at > 0 then $lines[$at - 1] else "" end)][0]
    | if . then
        ([.release_line | capture("^<!-- incident-live:(?<sha>[0-9a-f]*) -->$")? | .sha] | first) as $release
        | "\(.number) \(.state | ascii_upcase)\(if $release then " release:\($release)" else "" end)"
      else empty end'
}
# Only the open issues: a project collects closed ones for good, and a closed issue is found by search_issue
find_issue() {
  gh api --paginate --method GET "repos/$GITHUB_REPOSITORY/issues" -f "labels=$LABEL" -f state=open -f per_page=100 --jq '.[]' |
    with_marker
}
# One search by the marker's text instead of listing every issue: the search index lags behind for a few seconds,
# which only matters for an issue just created, and that one is still open
search_issue() {
  gh api --method GET search/issues -f "q=repo:$GITHUB_REPOSITORY is:issue in:body \"incident:$provider_id:$problem_id\"" \
    -f per_page=100 --jq '.items[]' | with_marker
}
number=''
state=''
body_release=''
live=''
previous=''

relevant() {
  jq -e --argjson envs "$ENVIRONMENTS" --argjson types "$TYPES" \
    '((.environment.name // "" | ascii_downcase) as $e | $envs | map(ascii_downcase) | index($e)) and (.issue.type as $t | $types | index($t))' <<< "$payload" >/dev/null
}

# Sets number and state. Open issues with the label first; then a search, for a closed issue or one whose label someone
# removed, only for a problem the project handles (relevant): one that is not never got an issue. The search runs for
# every new problem and has a low rate limit (30 a minute): it is tried again, then its failure counts as not found and
# the issue is opened, so no new problem is lost (at the cost of a second issue for one that lost its label)
lookup() {
  local existing attempt
  existing=$(find_issue)
  if [ -z "$existing" ] && relevant; then
    for attempt in 1 2 3; do
      existing=$(search_issue) && break
      existing=''
      if [ "$attempt" -lt 3 ]; then
        sleep 20
      else
        echo "::warning::Could not search for an issue of this problem without the $LABEL label"
      fi
    done
    # Found without the label: put it back, so the next event finds it among the labeled issues once it is open
    if [ -n "$existing" ]; then
      gh issue edit "${existing%% *}" --repo "$GITHUB_REPOSITORY" --add-label "$LABEL" >/dev/null || true
    fi
  fi
  number=${existing%% *}
  existing=${existing#* }
  state=${existing%% *}
  [ "$existing" = "$state" ] || body_release=${existing#* }
}

# The release of the issue's latest analysis, as "release:<sha>": the one in the newest comment of this workflow that
# asked for an analysis, or else the one in the body. Empty when unknown (an issue opened before releases were recorded,
# or comments that cannot be read), which is analyzed again
analyzed_release() {
  local release
  release=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$number/comments" --jq '.[]' 2>/dev/null | jq -rs '
    [.[] | select(.user.type == "Bot") | .body // "" | rtrimstr("\n") | split("\n") | .[-1] // ""
      | capture("^<!-- incident-live:(?<sha>[0-9a-f]*) -->$")? | .sha] | last // empty | "release:\(.)"') || return 0
  echo "${release:-$body_release}"
}

url=$(jq -r '.issue.url // empty' <<< "$payload")
# The monitoring environment name is also the GitHub environment and the env:<name> label used by the rollback
environment=$(jq -r '.environment.name // empty | ascii_downcase' <<< "$payload")

case "$event" in
  opened | reopened)
    if ! relevant; then
      echo "Not a handled environment or issue type, skipping"
      exit 0
    fi
    lookup

    # A repeated delivery of an event for a problem whose issue is open (a retry, or a replay within the relay's
    # window): the issue already has its analysis
    if [ -n "$number" ] && [ "$state" = OPEN ] && [ "$event" = opened ]; then
      echo "Issue #$number is already open for this problem, skipping"
      exit 0
    fi

    # Best effort: without them the issue is still opened, only without the releases. Read for a problem that
    # happens again too: the analysis compares with the release live now, maybe deployed since
    live_read=true
    live=$(live_release "$environment" 2>/dev/null) || {
      echo "::warning::Could not read the live release of $environment"
      live=''
      live_read=false
    }
    releases=$(good_releases "$environment" 2>/dev/null) || {
      echo "::warning::Could not read the release history of $environment"
      releases=''
    }
    # No live ref yet (before the first deploy that recorded one): the newest good release. A live ref that could
    # not be read is not guessed, as deploy.sh does not: the issue and the analysis would get the wrong releases
    if [ "$live_read" = true ]; then
      [ -n "$live" ] || live=$(sed -n 1p <<< "$releases")
      previous=$(previous_release "$releases" "$live")
    fi

    analyze=true
    if [ -n "$number" ]; then
      comment=$(t "The problem happened again, according to $provider: $url" "O problema voltou a ocorrer, segundo o $provider: $url")
      # Analyzed again only with another release live than the last analysis: the same one adds nothing to it
      if [ "$live_read" = true ] && [ "$(analyzed_release)" = "release:$live" ]; then
        analyze=false
        comment+=$'\n\n'$(t "The release live in $environment is the one of the last analysis, which still applies." "A versão em $environment é a mesma da última análise, que continua valendo.")
      elif [ "$live_read" = true ]; then
        comment+=$'\n\n'$(release_marker "$live")
      fi
      [ "$state" = OPEN ] || gh issue reopen "$number" --repo "$GITHUB_REPOSITORY" >/dev/null
      gh issue comment "$number" --repo "$GITHUB_REPOSITORY" --body "$comment"
    else
      gh label create "$LABEL" --repo "$GITHUB_REPOSITORY" --color 5319e7 --force \
        --description "$(t "Problem detected by the monitoring service" "Problema detectado pelo monitoramento")" >/dev/null || true
      environment_label "$environment"

      title=$(jq -r --arg env "$environment" --arg provider "$provider" --argjson en "$english" \
        '"[\($provider) \($env)] " + ((.issue.title // "" | select(. != "")) // (if $en then "Untitled problem" else "Problema sem título" end)) | .[0:250]' <<< "$payload")
      release=''
      [ "$live_read" = false ] || release=$(release_marker "$live")
      body=$(jq -r --arg marker "$marker" --arg release "$release" --arg live "$live" --arg previous "$previous" --arg env "$environment" --arg provider "$provider" --arg repo "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" --argjson en "$english" '
        .issue as $i | ($i.details // {}) as $d |
        # A fence longer than any run of backticks in the message, so the message cannot close it
        (($d.message // "") | [scan("`+") | length] | max // 0) as $ticks |
        ("`" * ([$ticks + 1, 4] | max)) as $fence |
        def t(en; pt): if $en then en else pt end;
        [
          t("\($provider) detected a new problem in **\(.environment.name // "?")**."; "O \($provider) detectou um novo problema em **\(.environment.name // "?")**."),
          "",
          "| | |",
          "| --- | --- |",
          "| \(t("Type"; "Tipo")) | \($i.type // "?") |",
          "| \(t("Priority"; "Prioridade")) | \($i.priority // "?") |",
          (if $d.class then "| \(t("Exception"; "Exceção")) | `\($d.class)` |" else empty end),
          (if $d.file then "| \(t("Location"; "Local")) | `\($d.file):\($d.line // "?")` |" else empty end),
          (if $d.path then "| \(t("Route"; "Rota")) | `\(($d.methods // []) | join(","))` `\($d.path)` |" else empty end),
          (if $d.name then "| \(t("Name"; "Nome")) | `\($d.name)` |" else empty end),
          (if $d.duration then "| \(t("Duration"; "Duração")) | \($d.duration) (\(t("threshold"; "limite")) \($d.threshold // "?")) |" else empty end),
          (if $d.runtime then "| \(t("Runtime"; "Ambiente de execução")) | \($d.runtime) |" else empty end),
          (if $live != "" then "| \(t("Release in"; "Versão em")) \($env) | [`\($live[0:7])`](\($repo)/commit/\($live)) |" else empty end),
          (if $previous != "" then "| \(t("Changes of the last deploy"; "Mudanças do último deploy")) | [`\($previous[0:7])...\($live[0:7])`](\($repo)/compare/\($previous)...\($live)) |" else empty end),
          "",
          (if $d.message then "**\(t("Message"; "Mensagem"))** (\(t("text from the application"; "texto vindo da aplicação"))):\n\n\($fence)text\n\($d.message)\n\($fence)\n" else empty end),
          (if $i.url then t("[View in \($provider)](\($i.url))"; "[Ver no \($provider)](\($i.url))") else empty end),
          "",
          "---",
          "",
          t("Claude will comment below with the analysis. Then decide:"; "O Claude vai comentar abaixo com a análise. Depois, decida:"),
          "",
          t("- add the `claude` label for Claude to fix it and open a pull request;"; "- adicione o label `claude` para o Claude corrigir e abrir um pull request;"),
          # Without a recorded previous release there is nothing to roll back to
          (if $previous != "" then t("- add the `rollback` label to roll **\($env)** back to the previous release now;"; "- adicione o label `rollback` para reverter **\($env)** para a versão anterior agora;") else empty end),
          t("- or close the issue if the error is not relevant."; "- ou feche a issue se o erro não for relevante."),
          "",
          (if $release != "" then $release else empty end),
          $marker
        ] | join("\n")' <<< "$payload")

      number=$(gh issue create --repo "$GITHUB_REPOSITORY" --title "$title" --body "$body" --label "$LABEL" --label "env:$environment" | grep -oE '[0-9]+$')
    fi

    {
      echo "number=$number"
      echo "analyze=$analyze"
      echo "live=${live:-}"
      echo "previous=${previous:-}"
    } >> "$GITHUB_OUTPUT"
    ;;

  resolved | ignored)
    lookup
    if [ -z "$number" ] || [ "$state" != OPEN ]; then
      echo "No open GitHub issue for this problem"
      exit 0
    fi
    who=$(jq -r '.actor.name // empty' <<< "$payload")
    if [ "$event" = resolved ]; then
      reason=completed
      comment=$(t "Marked as resolved in $provider${who:+ by $who}." "Marcado como resolvido no $provider${who:+ por $who}.")
    else
      reason="not planned"
      comment=$(t "Marked as ignored in $provider${who:+ by $who}." "Marcado como ignorado no $provider${who:+ por $who}.")
    fi
    gh issue close "$number" --repo "$GITHUB_REPOSITORY" --reason "$reason" --comment "$comment"
    ;;

  *)
    echo "Unhandled event '$event', skipping"
    ;;
esac
