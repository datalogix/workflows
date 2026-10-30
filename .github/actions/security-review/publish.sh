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

# A single comment per PR, updated on every review. Every page is read and the first id kept in bash: a pipe into head
# could end gh with SIGPIPE, which pipefail turns into a failed step
publish() {
  local comments comment
  comments=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments?per_page=100" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$marker\"))) | .id")
  comment=${comments%%$'\n'*}
  if [ -n "$comment" ]; then
    gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$comment" -f body="$1" >/dev/null
  else
    gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --body "$1"
  fi
}

# Running it again does not help: the default branch and this pull request need the same workflow file first
if [ "${WORKFLOW_CHANGED:-}" = true ]; then
  echo "::error::$WORKFLOW_FILE in this pull request is not the same as on the default branch, so Claude cannot review it"
  publish "$(printf '%s\n\n%s\n\n%s\n\n%s\n\n%s' "$title" \
    "$(t "\`$WORKFLOW_FILE\` in this pull request is not the same as on the default branch, so Claude does not review it: Claude only runs with the default branch's copy of the workflow file, so neither this security review nor the code review ran. This check fails until both are the same." \
      "O \`$WORKFLOW_FILE\` deste PR não é igual ao do branch padrão, então o Claude não o revisa: ele só roda com a cópia do arquivo de workflow do branch padrão, e nem esta revisão de segurança nem o code review rodaram. Este check falha até os dois serem iguais.")" \
    "$(t "Move the workflow change to a pull request of its own, reviewed by a person (an admin merges it past this check), then push to this pull request or re-run this job." \
      "Leve a mudança do workflow para um PR só com ela, revisado por uma pessoa (um admin faz o merge passando por este check), e depois envie um commit para este PR ou rode este job de novo.")" \
    "$view" "$marker")"
  exit 1
fi

if [ "${DOCS_ONLY:-}" = true ]; then
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

if ! jq -e '.findings | type == "array" and all(type == "object")' "$FINDINGS" >/dev/null 2>&1; then
  echo "::error::The security review did not produce a valid findings file"
  publish "$(printf '%s\n\n%s\n\n%s\n\n%s' "$title" \
    "$(t "The security review did not finish; this check fails until it runs again (push a commit or re-run the job)." \
      "A revisão de segurança não terminou; este check falha até ela rodar de novo (envie um commit ou rode o job de novo).")" \
    "$view" "$marker")"
  exit 1
fi
# Severities spelled otherwise (High, critical) or unknown count as high, so they never pass unseen
jq '.findings |= map(.severity = ((.severity // "") | tostring | ascii_downcase
  | if IN("medium", "low") then . else "high" end))' "$FINDINGS" > "$FINDINGS.normalized"
mv "$FINDINGS.normalized" "$FINDINGS"

blocking=$(jq --argjson levels "$LEVELS" '[.findings[] | select(.severity as $s | $levels | index($s))] | length' "$FINDINGS")
total=$(jq '.findings | length' "$FINDINGS")
echo "blocking=$blocking" >> "$GITHUB_OUTPUT"

# Read by check.sh; only a passing review is kept
state=
if [ "$blocking" -eq 0 ] && [ -n "${DIGEST:-}" ]; then
  state="<!-- claude-security-review-state: diff=$DIGEST fail-on=$FAIL_ON -->"
fi

# Text written by Claude cannot hide a comment in the body, such as a state line read by check.sh
body=$(jq -r --arg title "$title" --arg view "$view" --arg marker "$marker" --arg state "$state" \
  --arg none "$(t "No security problems found in the changes of this PR." "Nenhum problema de segurança encontrado nas mudanças deste PR.")" \
  --arg recommendation "$(t Recommendation Recomendação)" \
  --arg blocked "$(t "This PR is blocked until the problems above are fixed. Ask \`@claude fix the security problems\`; if one is a false positive, record it in \`.github/security-review.md\`." \
    "Este PR está bloqueado até que os problemas acima sejam corrigidos. Peça \`@claude corrija os problemas de segurança\`; se for um falso positivo, registre-o em \`.github/security-review.md\`.")" \
  --argjson blocking "$blocking" '
  def icon: {"high": "🔴", "medium": "🟠", "low": "🟡"}[.] // "⚪";
  def text: tostring | gsub("<!--"; "&lt;!--");
  [
    $title,
    "",
    (.summary // "" | text),
    "",
    (if (.findings | length) == 0 then $none
     else
       (.findings | sort_by({"high": 0, "medium": 1, "low": 2}[.severity] // 3)[] |
         "### \(.severity | icon) \(.title | text)\n\n`\(.file | text)\(if .line then ":\(.line | text)" else "" end)` · \(.severity) · \(.category | text)\n\n\(.description | text)\n\n**\($recommendation):** \(.recommendation | text)\n")
     end),
    "",
    (if $blocking == 0 then empty else $blocked end),
    "",
    $view,
    "",
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
