#!/usr/bin/env bash
# Decides whether Claude reviews the security of a pull request. Settings come from the environment (see action.yml).
set -euo pipefail

marker="<!-- claude-security-review -->"
# The findings publish.sh keeps in the comment, as base64 JSON (Claude's text cannot write a comment: see publish.sh)
FINDINGS_LINE='<!-- claude-security-review-findings: (?<data>[A-Za-z0-9+/=]+) -->'

# Before the review: a typo in fail-on would otherwise cost a whole review and fail the check
case "$FAIL_ON" in
  high) levels='["high"]' ;;
  medium) levels='["high", "medium"]' ;;
  low) levels='["high", "medium", "low"]' ;;
  none) levels='[]' ;;
  *)
    echo "::error::Invalid fail-on value: $FAIL_ON (use high, medium, low or none)"
    exit 1
    ;;
esac
# Written first: the publish step runs when it is set, so a failure below still updates the comment
echo "levels=$levels" >> "$GITHUB_OUTPUT"

# A pull request that changes the workflow file cannot run Claude (claude-code-action requires the default branch's
# copy): the publish step says so and fails the check
if [ "${WORKFLOW_CHANGED:-}" = true ]; then
  echo "review=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# A pull request that changes only documentation has nothing to review. The whole pull request counts, not the last
# push: a push of documentation on top of code (or on top of a blocking finding) is still reviewed. Markdown read as
# instructions (.github/, .claude/, CLAUDE.md, AGENTS.md) or that the app may render (resources/) counts as code, and so
# does a deleted or renamed file (--no-renames lists its old name). A failed git diff fails this step, so the review
# never skips by accident
files=$(git diff --name-only --no-renames "origin/$BASE...HEAD")
docs=false
if [ -n "$files" ]; then
  docs=true
  while IFS= read -r file; do
    case "$file" in
      .github/* | .claude/* | */.claude/* | resources/* | CLAUDE.md | */CLAUDE.md | AGENTS.md | */AGENTS.md) docs=false ;;
      *.md) ;;
      *) docs=false ;;
    esac
  done <<< "$files"
fi
echo "docs-only=$docs" >> "$GITHUB_OUTPUT"
if [ "$docs" = true ]; then
  echo "review=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

# A push that leaves the changes of the pull request as they were (updating the branch with the base, a rebase, an
# empty commit) keeps the result of the last review. The digest covers the blob before and after of every changed file,
# so a base change to a file the pull request also changes is reviewed again. Only a review that passed with the same
# fail-on is kept (the publish step writes the state line only then), and a manual re-run always reviews. The state line
# lives in the comment, which anyone who can push a workflow can also write: the same people who can already report this
# check themselves
digest=$(git diff --raw --no-abbrev --no-renames "origin/$BASE...HEAD" | sha256sum | cut -d' ' -f1)
echo "digest=$digest" >> "$GITHUB_OUTPUT"

if [ "${RUN_ATTEMPT:-1}" = 1 ]; then
  state="<!-- claude-security-review-state: diff=$digest fail-on=$FAIL_ON -->"
  # Only where publish.sh writes it, right before the marker that ends the comment, never inside the text of the review
  kept=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments?per_page=100" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$marker\"))) | .body | endswith(\"$state\\n$marker\")")
  if [ "${kept%%$'\n'*}" = true ]; then
    echo "reused=true" >> "$GITHUB_OUTPUT"
    echo "review=false" >> "$GITHUB_OUTPUT"
    exit 0
  fi
fi

# The open findings of earlier reviews, kept in the comment by publish.sh, so Claude checks whether each is still there
if [ "${KEEP_FINDINGS:-}" = true ] && [ -n "${PREVIOUS:-}" ]; then
  stored=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments?per_page=100" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$marker\"))) | .body
      | [capture(\"$FINDINGS_LINE\").data][0] // \"\"")
  stored=${stored%%$'\n'*}
  jq -n --arg data "$stored" '
    (try ($data | @base64d | fromjson) catch []) | if type == "array" then . else [] end
    | map(select(type == "object" and .status == "open")
      | {id, severity, category, file, line, title, description})' > "$PREVIOUS"
fi

echo "review=true" >> "$GITHUB_OUTPUT"
