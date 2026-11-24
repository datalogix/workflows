#!/usr/bin/env bash
# Decides whether Claude fixes the open findings of the security review on its own pull request: the findings at fix-on
# or above that the review comment keeps (keep-findings), within max-attempts fix commits. Settings come from the
# environment (see action.yml).
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/inputs.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/inputs.sh"
# shellcheck source=SCRIPTDIR/../lib/language.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/language.sh"

case "$FIX_ON" in
  high) levels='["high"]' ;;
  medium) levels='["high", "medium"]' ;;
  low) levels='["high", "medium", "low"]' ;;
  *)
    echo "::error::Invalid fix-security-on value: $FIX_ON (use high, medium or low)"
    exit 1
    ;;
esac
whole_number max-attempts "$MAX" 0

skip() {
  echo "$1"
  echo "fix=false" >> "$GITHUB_OUTPUT"
  exit 0
}

# A newer push is reviewed (and fixed) by its own run
reviewed=$(git rev-parse --verify --quiet "$HEAD_SHA^{commit}" || true)
[ "$(git rev-parse HEAD)" = "$reviewed" ] || skip "The branch has moved past the reviewed commit; the newer run handles it"

marker="<!-- claude-security-review -->"
stored=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments?per_page=100" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$marker\"))) | .body
    | [capture(\"<!-- claude-security-review-findings: (?<data>[A-Za-z0-9+/=]+) -->\").data][0] // \"\"")
stored=${stored%%$'\n'*}
jq -n --arg data "$stored" --argjson levels "$levels" '
  (try ($data | @base64d | fromjson) catch []) | if type == "array" then . else [] end
  | map(select(type == "object" and .status == "open" and (.severity as $s | $levels | index($s))))' > "$FINDINGS"
count=$(jq length "$FINDINGS")
[ "$count" -gt 0 ] || skip "No open security finding at $FIX_ON or above"

attempts=$(git log --oneline "origin/$BASE..HEAD" --grep='\[security-fix\]' | wc -l | tr -d ' ')
echo "Open findings at $FIX_ON or above: $count; previous attempts: $attempts of $MAX"
if [ "$attempts" -ge "$MAX" ]; then
  limit="<!-- claude-fix-security:limit -->"
  # One count per page of comments: summed, so a comment on a later page counts too
  warned=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments?per_page=100" \
    --jq "[.[] | select(.body | contains(\"$limit\"))] | length" | awk '{ total += $1 } END { print total + 0 }')
  if [ "$warned" = 0 ]; then
    gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --body "$(printf '%s\n\n%s' \
      "$(t "The security findings are still open after $attempts automatic fix attempts. I stopped here; they need a human review." \
        "Os achados de segurança continuam abertos após $attempts tentativas automáticas de correção. Parei por aqui; é preciso revisão humana.")" \
      "$limit")" >/dev/null
  fi
  skip "Reached the limit of $MAX automatic fixes"
fi

echo "fix=true" >> "$GITHUB_OUTPUT"
