#!/usr/bin/env bash
# Whether the pull request's copy of the workflow file the run started from differs from the default branch's.
# Settings come from the environment (see action.yml).
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/github.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/github.sh"

# In a reusable workflow GITHUB_WORKFLOW_REF is the caller's: owner/repo/.github/workflows/<file>@<ref>
path=${GITHUB_WORKFLOW_REF#"$GITHUB_REPOSITORY"/}
path=${path%%@*}
echo "path=$path" >> "$GITHUB_OUTPUT"

# The blob in both places tells, without a checkout. The run's copy is the merge commit's (MERGE_SHA, github.sha of a
# pull request), which already has the default branch's changes: only a pull request that changes the file differs, or
# the one that adds it (missing on the default branch). A failed read says unchanged, leaving the decision to
# claude-code-action
changed=false
if [ -n "${MERGE_SHA:-}" ]; then
  if ! head=$(gh_or_missing api "repos/$GITHUB_REPOSITORY/contents/$path?ref=$MERGE_SHA" --jq .sha) ||
    ! base=$(gh_or_missing api "repos/$GITHUB_REPOSITORY/contents/$path?ref=$DEFAULT_BRANCH" --jq .sha); then
    echo "::warning::Could not compare $path with the default branch's copy: ${base:-$head}"
  elif [ -n "$head" ] && [ "$head" != "$base" ]; then
    changed=true
    echo "::warning::$path in this pull request is not the same as on the default branch: Claude only runs with the default branch's copy of it"
  fi
fi
echo "changed=$changed" >> "$GITHUB_OUTPUT"
