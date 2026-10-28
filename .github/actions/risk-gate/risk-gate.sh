#!/usr/bin/env bash
# Classifies a pull request by risk and checks its human approvals. Settings come from the environment (see action.yml).
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/inputs.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/inputs.sh"
# shellcheck source=SCRIPTDIR/../lib/github.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/github.sh"
# shellcheck source=SCRIPTDIR/../lib/language.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/language.sh"

# A decimal would be read as false by test and let the pull request pass
whole_number high-risk-lines "$HIGH_LINES" 1
whole_number approvals-low "$APPROVALS_LOW" 0
whole_number approvals-medium "$APPROVALS_MEDIUM" 0
whole_number approvals-high "$APPROVALS_HIGH" 0

matches() {
  local file=$1 patterns=$2 pattern
  while IFS= read -r pattern; do
    # Without surrounding spaces or the CR of a line written on Windows, which would never match
    pattern=${pattern#"${pattern%%[![:space:]]*}"}
    pattern=${pattern%"${pattern##*[![:space:]]}"}
    [ -z "$pattern" ] && continue
    # shellcheck disable=SC2053
    [[ "$file" == $pattern ]] && return 0
  done <<< "$patterns"
  return 1
}

# Only the approvals of users who can push count, as in GitHub's own rules. A permission GitHub does not answer (rate
# limit, server error) does not count either, but the summary says why
unreadable=()
has_write() {
  local permission
  # No access to the repository (404) is answered as an empty permission, which running again does not change
  if ! permission=$(collaborator_permission "$1"); then
    echo "::warning::Could not read the permission of $1: $permission"
    unreadable+=("$1")
    return 1
  fi
  is_write_permission "$permission"
}

pr=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR")
head=$(jq -r '.head.sha' <<< "$pr")
base=$(jq -r '.base.ref | @uri' <<< "$pr")
files=$(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/files" | jq -s 'add // []')

# The changes the pull request makes up to a commit, from its files as GitHub lists them (on stdin): each file's name,
# status, mode and patch with its hunk positions (a hunk with the same lines elsewhere is another change), or blob when it
# has no patch (binary or mode only). Empty when they cannot be compared: GitHub leaves out large patches, and truncates
# the tree of a very large repository.
changes_of() {
  jq -c --slurpfile tree <(gh api "repos/$GITHUB_REPOSITORY/git/trees/$1?recursive=1" 2>/dev/null || true) '
    if any(.[]; .patch == null and .changes > 0) or ($tree | length) == 0 or $tree[0].truncated then empty
    else ($tree[0].tree | map({key: .path, value: .mode}) | from_entries) as $modes
      | map([.filename, .previous_filename, .status, $modes[.filename], .patch // .sha]) | sort
    end'
}

# The changes up to an earlier commit; the comparison lists at most 300 files
changes_at() {
  { gh api "repos/$GITHUB_REPOSITORY/compare/$base...$1" --jq 'if (.files | length) >= 300 then empty else .files end' 2>/dev/null || true; } |
    changes_of "$1"
}

# Whether an earlier commit makes the same changes as the current one; each commit is compared once
same_commits=" "
other_commits=" "
same_changes() {
  case "$same_commits" in *" $1 "*) return 0 ;; esac
  case "$other_commits" in *" $1 "*) return 1 ;; esac
  [ -n "${head_changes+set}" ] || head_changes=$(changes_of "$head" <<< "$files")
  if [ -n "$head_changes" ] && [ "$(changes_at "$1")" = "$head_changes" ]; then
    same_commits+="$1 "
    return 0
  fi
  other_commits+="$1 "
  return 1
}

risk=low
lines=0
reasons=()
# The files endpoint lists at most 3000 files: a larger pull request may hide a high-risk one
changed_files=$(jq -r '.changed_files // 0' <<< "$pr")
if [ "$changed_files" -gt 3000 ]; then
  risk=high
  reasons+=("$changed_files changed files (only the first 3000 can be classified)")
fi
while IFS=$'\t' read -r file changes previous; do
  # A rename also removes the old path: moving a migration to tests/ is as risky as changing it
  if matches "$file" "$HIGH_PATHS" || { [ -n "$previous" ] && matches "$previous" "$HIGH_PATHS"; }; then
    risk=high
    reasons+=("\`${previous:+$previous → }$file\` is a high-risk path")
  fi
  if matches "$file" "$LOW_PATHS" && { [ -z "$previous" ] || matches "$previous" "$LOW_PATHS"; }; then
    continue
  fi
  [ "$risk" = low ] && risk=medium
  # Generated files (lock files, built assets) still change what is deployed, but their size says nothing about the review
  if matches "$file" "$IGNORED_PATHS"; then
    continue
  fi
  lines=$((lines + changes))
done < <(jq -r '.[] | [.filename, (.additions + .deletions), (.previous_filename // "")] | @tsv' <<< "$files")

if [ "$lines" -ge "$HIGH_LINES" ]; then
  risk=high
  reasons+=("$lines changed lines (limit $HIGH_LINES)")
fi

case "$risk" in
  low) required=$APPROVALS_LOW ;;
  medium) required=$APPROVALS_MEDIUM ;;
  high) required=$APPROVALS_HIGH ;;
esac

# Keep exactly one risk label on the PR
for level in low medium high; do
  label="$PREFIX$level"
  if [ "$level" = "$risk" ]; then
    gh label create "$label" --repo "$GITHUB_REPOSITORY" --force \
      --color "$(case $level in low) echo 0e8a16;; medium) echo fbca04;; high) echo d93f0b;; esac)" \
      --description "$(t "Risk of the changes: $level" "Risco das mudanças: $level")" >/dev/null || true
    gh pr edit "$PR" --repo "$GITHUB_REPOSITORY" --add-label "$label" >/dev/null || echo "::warning::Could not add the $label label"
  elif jq -e --arg l "$label" 'any(.labels[]; .name == $l)' <<< "$pr" >/dev/null; then
    gh pr edit "$PR" --repo "$GITHUB_REPOSITORY" --remove-label "$label" >/dev/null || true
  fi
done

# A human approval counts only if it is the reviewer's latest decision, was given on a commit with the current changes
# (the current commit, or an earlier one the base was merged into or rebased under without moving them) and comes from
# someone with write access, read from their permission: author_association is no guide (a member of the organization
# whose membership is private shows as CONTRIBUTOR or NONE to the workflow token, and MEMBER does not mean write access).
# Bots never count: an AI review is not an approval.
approvers=()
while IFS=$'\t' read -r approver commit; do
  if [ -z "$approver" ] || ! has_write "$approver"; then continue; fi
  if [ "$commit" = "$head" ]; then
    approvers+=("$approver")
  elif same_changes "$commit"; then
    approvers+=("$approver (${commit:0:7}, same changes)")
  fi
done < <(
  gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/reviews" --jq '.[]' |
    jq -rs '
      [.[] | select(.user.type != "Bot" and .state != "COMMENTED" and .state != "PENDING")]
      | group_by(.user.login)
      | map(max_by(.submitted_at))
      | map(select(.state == "APPROVED"))
      | .[] | [.user.login, .commit_id] | @tsv'
)

# GitHub does not let authors approve their own PRs; a solo maintainer can count as the reviewer of the code they wrote.
# PRs opened by Claude are authored by a bot, so the person who asked for them still has to approve.
author=$(jq -r '.user.login' <<< "$pr")
if [ "$COUNT_AUTHOR" = true ] && jq -e '.user.type != "Bot"' <<< "$pr" >/dev/null &&
  has_write "$author"; then
  approvers+=("$author (author)")
fi

approved=${#approvers[@]}

{
  echo "### Risk: $risk"
  echo
  echo "Changed lines considered: $lines"
  for reason in ${reasons[@]+"${reasons[@]}"}; do echo "- $reason"; done
  echo
  echo "Human approvals of the current changes: $approved of $required${approvers[*]+ (${approvers[*]})}"
  if [ ${#unreadable[@]} -gt 0 ]; then
    echo
    echo "Not counted, GitHub did not answer their permission: ${unreadable[*]} (run the gate again)"
  fi
} >> "$GITHUB_STEP_SUMMARY"

if [ "$approved" -lt "$required" ]; then
  echo "::error::$risk risk: needs $required human approval(s) of the current changes, has $approved"
  exit 1
fi

echo "$risk risk: $approved of $required human approval(s)"
