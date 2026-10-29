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

# Running it again does not help: the workflow change has to reach the default branch first
if [ "${WORKFLOW_CHANGED:-}" = true ]; then
  echo "::error::This pull request changes $WORKFLOW_FILE, so Claude cannot review it"
  publish "$(printf '%s\n\n%s\n\n%s\n\n%s\n\n%s' "$title" \
    "$(t "This pull request changes \`$WORKFLOW_FILE\`, so Claude does not review it: Claude only runs with the default branch's copy of the workflow file, so neither this security review nor the code review ran. This check fails until the default branch has the same workflow file." \
      "Este PR altera \`$WORKFLOW_FILE\`, então o Claude não o revisa: ele só roda com a cópia do arquivo de workflow do branch padrão, e nem esta revisão de segurança nem o code review rodaram. Este check falha até o branch padrão ter o mesmo arquivo de workflow.")" \
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

body=$(jq -r --arg marker "$marker" --arg state "$state" --arg run "$run_url" --argjson blocking "$blocking" --argjson en "$english" '
  def icon: {"high": "🔴", "medium": "🟠", "low": "🟡"}[.] // "⚪";
  [
    (if $en then "## Security review" else "## Revisão de segurança" end),
    "",
    .summary,
    "",
    (if (.findings | length) == 0 then
       (if $en then "No security problems found in the changes of this PR." else "Nenhum problema de segurança encontrado nas mudanças deste PR." end)
     else
       (.findings | sort_by({"high": 0, "medium": 1, "low": 2}[.severity] // 3)[] |
         "### \(.severity | icon) \(.title)\n\n`\(.file)\(if .line then ":\(.line)" else "" end)` · \(.severity) · \(.category)\n\n\(.description)\n\n**\(if $en then "Recommendation" else "Recomendação" end):** \(.recommendation)\n")
     end),
    "",
    (if $blocking == 0 then empty
     elif $en then "This PR is blocked until the problems above are fixed. Ask `@claude fix the security problems`; if one is a false positive, record it in `.github/security-review.md`."
     else "Este PR está bloqueado até que os problemas acima sejam corrigidos. Peça `@claude corrija os problemas de segurança`; se for um falso positivo, registre-o em `.github/security-review.md`." end),
    "",
    (if $en then "[View run](\($run))" else "[Ver execução](\($run))" end),
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
