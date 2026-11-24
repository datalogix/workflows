#!/usr/bin/env bash
# Merges the branch of a pull request into the open pull requests based on it, with the merges API: a regular merge
# commit on their branch, never a force push. Each merge is a push to a pull request above, which runs this again for
# the pull requests above that one. Settings come from the environment (see action.yml).
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/language.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/language.sh"

marker="<!-- datalogix-update-stacked -->"
base=$(jq -rn --arg branch "$BRANCH" '$branch | @uri')

# Only pull requests of this repository: a fork's branch is not ours to push to
children=$(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls?state=open&base=$base&per_page=100" \
  --jq ".[] | select(.head.repo.full_name == \"$GITHUB_REPOSITORY\") | [.number, .head.ref] | @tsv")

# The comment of an earlier run on that pull request, updated rather than repeated on every push
comment_on() {
  local number=$1 body=$2 only_update=$3 ids id
  ids=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$number/comments?per_page=100" \
    --jq ".[] | select(.user.type == \"Bot\" and (.body | contains(\"$marker\"))) | .id")
  id=${ids%%$'\n'*}
  if [ -n "$id" ]; then
    gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$body" >/dev/null
  elif [ "$only_update" != true ]; then
    gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$number/comments" -f body="$body" >/dev/null
  fi
}

failed=0
updated=
while IFS=$'\t' read -r number ref; do
  [ -n "$number" ] || continue
  status=0
  result=$(gh api --method POST "repos/$GITHUB_REPOSITORY/merges" -f base="$ref" -f head="$BRANCH" \
    -f commit_message="Merge branch '$BRANCH' into $ref" --jq '.sha // ""' 2>&1) || status=$?
  if [ "$status" -eq 0 ]; then
    # Nothing to merge (204) answers no commit
    if [ -n "$result" ]; then
      updated+="#$number "
      echo "Merged $BRANCH into $ref (#$number): ${result:0:7}"
      # Only a pull request that had a conflict before has a comment to update
      comment_on "$number" "$(t "The changes of \`$BRANCH\` (#$PR) were merged into this pull request in ${result:0:7}." \
        "As mudanças de \`$BRANCH\` (#$PR) foram trazidas para este PR em ${result:0:7}.")"$'\n\n'"$marker" true
    else
      echo "$ref (#$number) already has the changes of $BRANCH"
    fi
  elif [[ "$result" == *"HTTP 409"* ]]; then
    echo "::warning::$BRANCH conflicts with $ref (#$number): merge it by hand"
    comment_on "$number" "$(t "The changes of \`$BRANCH\` (#$PR) could not be merged into this pull request: they conflict. Merge them by hand (\`git merge origin/$BRANCH\`), resolve the conflicts and push; the next push to #$PR tries again." \
      "Não foi possível trazer as mudanças de \`$BRANCH\` (#$PR) para este PR: há conflito. Faça o merge à mão (\`git merge origin/$BRANCH\`), resolva os conflitos e envie; o próximo push no #$PR tenta de novo.")"$'\n\n'"$marker" false
  else
    # A workflow file changed by the pull request below needs a token with the workflows permission, which the App lacks
    echo "::error::Could not merge $BRANCH into $ref (#$number): $result"
    failed=1
  fi
done <<< "$children"

{
  echo "### Stacked pull requests"
  echo
  if [ -z "$children" ]; then
    echo "No open pull request is based on \`$BRANCH\`."
  else
    echo "Updated with \`$BRANCH\`: ${updated:-none}"
  fi
} >> "$GITHUB_STEP_SUMMARY"

exit "$failed"
