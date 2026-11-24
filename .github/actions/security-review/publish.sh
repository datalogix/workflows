#!/usr/bin/env bash
# Publishes the result of the security review as a single pull request comment and fails the check when a finding
# reaches fail-on. Settings come from the environment (see action.yml).
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/language.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/language.sh"

run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:-}"
marker="<!-- claude-security-review -->"
title=$(t "## Security review" "## Revisão de segurança")
view=$(t "[View run]($run_url)" "[Ver execução]($run_url)")

# The findings kept in the comment until they are resolved, as base64 JSON: Claude's text cannot write a comment (see
# text below), so only this script writes the line. check.sh gives the open ones to the review
findings_line() { printf '<!-- claude-security-review-findings: %s -->' "$1"; }
FINDINGS_LINE='<!-- claude-security-review-findings: (?<data>[A-Za-z0-9+/=]+) -->'

# A single comment per PR, updated on every review: the first of the bot with the marker, read once (with the findings
# it keeps). Every page is read and the first one kept in bash: a pipe into head could end gh with SIGPIPE, which
# pipefail turns into a failed step
comment=''
stored=''
load_comment() {
  local comments
  comments=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments?per_page=100" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$marker\")))
      | \"\\(.id) \\([.body | capture(\"$FINDINGS_LINE\").data][0] // \"\")\"")
  comments=${comments%%$'\n'*}
  comment=${comments%% *}
  stored=${comments#* }
  [ "$stored" != "$comments" ] || stored=
}

publish() {
  if [ -n "$comment" ]; then
    gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$comment" -f body="$1" >/dev/null
  else
    gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --body "$1"
  fi
}

# A message that replaces the review (it did not run) keeps the findings, so the next review still checks them
carried() {
  if [ "${KEEP_FINDINGS:-}" = true ] && [ -n "$stored" ]; then printf '\n%s' "$(findings_line "$stored")"; fi
}

# Running it again does not help: the default branch and this pull request need the same workflow file first
if [ "${WORKFLOW_CHANGED:-}" = true ]; then
  load_comment
  echo "::error::$WORKFLOW_FILE in this pull request is not the same as on the default branch, so Claude cannot review it"
  publish "$(printf '%s\n\n%s\n\n%s\n\n%s\n\n%s' "$title" \
    "$(t "\`$WORKFLOW_FILE\` in this pull request is not the same as on the default branch, so Claude does not review it: Claude only runs with the default branch's copy of the workflow file, so neither this security review nor the code review ran. This check fails until both are the same." \
      "O \`$WORKFLOW_FILE\` deste PR não é igual ao do branch padrão, então o Claude não o revisa: ele só roda com a cópia do arquivo de workflow do branch padrão, e nem esta revisão de segurança nem o code review rodaram. Este check falha até os dois serem iguais.")" \
    "$(t "Move the workflow change to a pull request of its own, reviewed by a person (an admin merges it past this check), then push to this pull request or re-run this job." \
      "Leve a mudança do workflow para um PR só com ela, revisado por uma pessoa (um admin faz o merge passando por este check), e depois envie um commit para este PR ou rode este job de novo.")" \
    "$view$(carried)" "$marker")"
  exit 1
fi

if [ "${DOCS_ONLY:-}" = true ]; then
  load_comment
  publish "$(printf '%s\n\n%s\n\n%s\n\n%s' "$title" \
    "$(t "This pull request changes only documentation (Markdown files), so Claude did not review it. A change to any other file brings the review back." \
      "Este PR altera só documentação (arquivos Markdown), então o Claude não o revisou. Uma mudança em qualquer outro arquivo traz a revisão de volta.")" \
    "$view" "$marker")"
  echo "### Security review" >> "$GITHUB_STEP_SUMMARY"
  echo "Only documentation changed: not reviewed." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

# The comment already shows the review of these same changes
if [ "${REUSED:-}" = true ]; then
  echo "### Security review" >> "$GITHUB_STEP_SUMMARY"
  echo "The changes of this pull request are the same as in the last passing review: not reviewed again." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

load_comment

if ! jq -e '.findings | type == "array" and all(type == "object")' "$FINDINGS" >/dev/null 2>&1; then
  echo "::error::The security review did not produce a valid findings file"
  publish "$(printf '%s\n\n%s\n\n%s\n\n%s' "$title" \
    "$(t "The security review did not finish; this check fails until it runs again (push a commit or re-run the job)." \
      "A revisão de segurança não terminou; este check falha até ela rodar de novo (envie um commit ou rode o job de novo).")" \
    "$view$(carried)" "$marker")"
  exit 1
fi
# The findings of earlier reviews, with keep-findings: each keeps its number. One Claude reports again (by its id) stays
# open, one it lists in resolved is marked resolved in this commit, and one it leaves out stays as it was, so a finding
# never disappears unseen. New findings get the next numbers. Without keep-findings, only this review's findings count
previous='[]'
if [ "${KEEP_FINDINGS:-}" = true ] && [ -n "$stored" ]; then
  previous=$(jq -n --arg data "$stored" \
    '(try ($data | @base64d | fromjson) catch []) | if type == "array" then map(select(type == "object" and (.id | type) == "number")) else [] end')
fi

# Severities spelled otherwise (High, critical) or unknown count as high, so they never pass unseen
jq --argjson previous "$previous" --arg head "${HEAD_SHA:-}" '
  def severity: (. // "") | tostring | ascii_downcase | if IN("medium", "low") then . else "high" end;
  ($previous | map(.id) | max // 0) as $last
  | ((.resolved // []) | if type == "array" then map(numbers) else [] end) as $resolved
  | (.findings | map(.severity |= severity)) as $found
  | ($previous | map(.id)) as $ids
  | ($found | map(select((.id | type) == "number" and (.id as $id | $ids | index($id))))) as $again
  | ($found | map(select(((.id | type) == "number" and (.id as $id | $ids | index($id))) | not))) as $new
  | .findings = (
      [$previous[] | . as $p | ([$again[] | select(.id == $p.id)][0]) as $same
        | if $same then $same + {status: "open", earlier: true}
          elif $p.status == "resolved" then $p
          elif ($resolved | index($p.id)) then $p + {status: "resolved", resolved_in: $head}
          else $p + {status: "open", earlier: true} end
        | del(if .status == "open" then .resolved_in else empty end)]
      + [$new | to_entries[] | .value + {id: ($last + .key + 1), status: "open"} | del(.earlier)]
    )' "$FINDINGS" > "$FINDINGS.merged"
mv "$FINDINGS.merged" "$FINDINGS"

blocking=$(jq --argjson levels "$LEVELS" '[.findings[] | select(.status == "open" and (.severity as $s | $levels | index($s)))] | length' "$FINDINGS")
total=$(jq '[.findings[] | select(.status == "open")] | length' "$FINDINGS")
echo "blocking=$blocking" >> "$GITHUB_OUTPUT"

# Kept for the next review, without what only this comment shows
kept=
if [ "${KEEP_FINDINGS:-}" = true ]; then
  kept=$(findings_line "$(jq -c '.findings | map(del(.earlier))' "$FINDINGS" | jq -r '@base64')")
fi

# Read by check.sh; only a passing review is kept
state=
if [ "$blocking" -eq 0 ] && [ -n "${DIGEST:-}" ]; then
  state="<!-- claude-security-review-state: diff=$DIGEST fail-on=$FAIL_ON -->"
fi

# Text written by Claude cannot hide a comment in the body, such as a state line read by check.sh
# The severities Claude fixes itself (fix-security), only on its own pull requests: the others need @claude
fix_levels='[]'
if [ "${FIX_SECURITY:-}" = true ] && [ -n "${HEAD_REF:-}" ] && [[ "$HEAD_REF" == "${BRANCH_PREFIX:-claude/}"* ]]; then
  case "${FIX_ON:-high}" in
    high) fix_levels='["high"]' ;;
    medium) fix_levels='["high", "medium"]' ;;
    low) fix_levels='["high", "medium", "low"]' ;;
  esac
fi

body=$(jq -r --arg title "$title" --arg view "$view" --arg marker "$marker" --arg state "$state" --arg kept "$kept" \
  --arg none "$(t "No security problems found in the changes of this PR." "Nenhum problema de segurança encontrado nas mudanças deste PR.")" \
  --arg recommendation "$(t Recommendation Recomendação)" \
  --arg still "$(t "still present" "ainda presente")" \
  --arg resolvedTitle "$(t "Resolved" "Resolvidos")" \
  --arg resolvedIn "$(t "resolved in" "resolvido em")" \
  --arg blocked "$(t "This PR is blocked until the problems above are fixed." "Este PR está bloqueado até que os problemas acima sejam corrigidos.")" \
  --arg fixAll "$(t "To fix them, comment \`@claude fix the security problems\`, or one of them with \`@claude fix finding N\`." \
    "Para corrigi-los, comente \`@claude corrija os problemas de segurança\`, ou um deles com \`@claude corrija o achado N\`.")" \
  --arg falsePositive "$(t "If one is a false positive, record it in \`.github/security-review.md\`." \
    "Se algum for um falso positivo, registre-o em \`.github/security-review.md\`.")" \
  --arg autofix "$(t "Claude fixes the findings at \`${FIX_ON:-high}\` or above itself, with a regression test, on the next run (up to 2 attempts)." \
    "O Claude corrige sozinho os achados de nível \`${FIX_ON:-high}\` ou acima, com um teste de regressão, na próxima execução (até 2 tentativas).")" \
  --argjson fixLevels "$fix_levels" \
  --arg mentions "${MENTIONS:-true}" --arg repository "$GITHUB_REPOSITORY" --arg server "${GITHUB_SERVER_URL:-https://github.com}" \
  --argjson blocking "$blocking" '
  def icon: {"high": "🔴", "medium": "🟠", "low": "🟡"}[.] // "⚪";
  def text: tostring | gsub("<!--"; "&lt;!--");
  def place: "`\(.file | text)\(if .line then ":\(.line | text)" else "" end)`";
  (.findings | map(select(.status == "open")) | sort_by({"high": 0, "medium": 1, "low": 2}[.severity] // 3, .id)) as $open
  | (.findings | map(select(.status == "resolved")) | sort_by(.id)) as $resolved
  | [
    $title,
    "",
    (.summary // "" | text),
    "",
    (if ($open | length) == 0 then $none
     else
       ($open[] |
         "### \(.severity | icon) \(.id). \(.title | text)\n\n\(place) · \(.severity) · \(.category | text)\(if .earlier then " · \($still)" else "" end)\n\n\(.description | text)\n\n**\($recommendation):** \(.recommendation | text)\n")
     end),
    (if ($resolved | length) == 0 then empty
     else
       "#### \($resolvedTitle)\n",
       ($resolved[] | "- ~~\(.id). \(.title | text)~~ (\(place))\(if (.resolved_in // "") != "" then " · \($resolvedIn) [\(.resolved_in[0:7])](\($server)/\($repository)/commit/\(.resolved_in))" else "" end)"),
       ""
     end),
    "",
    (if $blocking == 0 then empty else $blocked end),
    (if ($open | length) == 0 then empty
     else
       # With fix-security, on a pull request of Claude: the findings it fixes itself; @claude for the others
       ([$open[] | select(.severity as $s | $fixLevels | index($s) | not)]) as $manual
       | ((if ($open | length) > ($manual | length) then $autofix + " " else "" end)
         + (if $mentions == "true" and ($manual | length) > 0 then ($fixAll | sub("N`"; "\($manual[0].id)`")) + " " else "" end)
         + $falsePositive)
     end),
    "",
    $view,
    "",
    (if $kept == "" then empty else $kept end),
    (if $state == "" then empty else $state end),
    $marker
  ] | join("\n")
' "$FINDINGS")

publish "$body"

{
  echo "### Security review"
  echo
  echo "$total finding(s), $blocking at or above \`$FAIL_ON\`."
} >> "$GITHUB_STEP_SUMMARY"

if [ "$blocking" -gt 0 ]; then
  echo "::error::$blocking security finding(s) at or above $FAIL_ON"
  exit 1
fi
