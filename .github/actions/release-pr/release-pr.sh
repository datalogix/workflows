#!/usr/bin/env bash
# Opens or updates a pull request between the development and production branches, chosen by MODE. Settings come from
# the environment (see action.yml). The text is shown in the target projects' GitHub, in their language.
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/language.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/language.sh"

owner=${GITHUB_REPOSITORY%%/*}

uri() {
  jq -rn --arg value "$1" '$value | @uri'
}

# Commits of head that base lacks and the files head changed since their merge base. A branch merged both ways shows no
# files even when it has merge commits the other lacks, so files tell whether anything is pending.
compare() {
  gh api "repos/$GITHUB_REPOSITORY/compare/$(uri "$1")...$(uri "$2")"
}

cannot_compare() {
  echo "::error::Cannot compare $1 with $2: check that both branches exist"
  exit 1
}

# Number of the open pull request from head to base, or nothing
open_pull() {
  gh api "repos/$GITHUB_REPOSITORY/pulls?state=open&base=$(uri "$2")&head=$(uri "$owner:$1")" --jq '.[0].number // empty'
}

# The comparison's commits as a list, without merge commits (the syncs between the branches)
commit_list() {
  local list
  list=$(jq -r '.commits | map(select(.parents | length == 1)) | .[] | "- \(.commit.message | split("\n")[0]) (\(.sha[0:7]))"' <<< "$1")
  [ -n "$list" ] || list=$(t "- Only merge commits; see the Commits tab" "- Só merge commits; veja a aba Commits")
  # The comparison lists at most 250 commits
  if [ "$(jq '.total_commits > (.commits | length)' <<< "$1")" = true ]; then
    list+=$'\n'$(t "- … and more commits, in the Commits tab" "- … e outros commits, na aba Commits")
  fi
  printf '%s' "$list"
}

nothing_pending() {
  t "Nothing pending: \`$1\` already has every change of \`$2\`." "Nada pendente: a \`$1\` já tem todas as mudanças da \`$2\`."
}

set_body() {
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/pulls/$1" -f "body=$2" >/dev/null
}

open_or_update() {
  local head=$1 base=$2 title=$3 body=$4 number
  number=$(open_pull "$head" "$base")
  if [ -n "$number" ]; then
    set_body "$number" "$body"
    echo "Updated pull request #$number"
  else
    number=$(gh api "repos/$GITHUB_REPOSITORY/pulls" -f "head=$head" -f "base=$base" -f "title=$title" -f "body=$body" --jq .number)
    echo "Opened pull request #$number"
  fi
}

# Opens or updates the pull request from head to base with the commits base lacks, between an intro and an outro; with
# nothing pending, only says so in the open one
propose() {
  local head=$1 base=$2 title=$3 intro=$4 outro=$5 comparison number
  comparison=$(compare "$base" "$head") || cannot_compare "$base" "$head"
  if [ "$(jq '.files | length' <<< "$comparison")" -eq 0 ]; then
    number=$(open_pull "$head" "$base")
    if [ -n "$number" ]; then
      set_body "$number" "$(nothing_pending "$base" "$head")"
      echo "Nothing to $MODE; updated pull request #$number"
    else
      echo "Nothing to $MODE: $base has every change of $head"
    fi
    return 0
  fi
  open_or_update "$head" "$base" "$title" "$intro

$(commit_list "$comparison")

$outro"
}

case "$MODE" in
  release)
    propose "$DEVELOPMENT" "$PRODUCTION" "Release: $DEVELOPMENT → $PRODUCTION" \
      "$(t "Changes of \`$DEVELOPMENT\` not yet in production:" "Mudanças da \`$DEVELOPMENT\` que ainda não estão em produção:")" \
      "$(t "Merging publishes to production. Use **Create a merge commit**, not squash: with squash, the two branches diverge and the commits already published show up here again." \
        "O merge publica em produção. Use **Create a merge commit**, não squash: com squash, as duas branches divergem e os commits já publicados voltam a aparecer aqui.")"
    ;;
  sync)
    propose "$PRODUCTION" "$DEVELOPMENT" "Sync: $PRODUCTION → $DEVELOPMENT" \
      "$(t "Changes of \`$PRODUCTION\` that \`$DEVELOPMENT\` does not have yet (hotfix):" "Mudanças da \`$PRODUCTION\` que a \`$DEVELOPMENT\` ainda não tem (hotfix):")" \
      "$(t "Use **Create a merge commit**, not squash. Until the merge, the release pull request is out of date with \`$PRODUCTION\`." \
        "Use **Create a merge commit**, não squash. Até o merge, o pull request de release fica desatualizado em relação à \`$PRODUCTION\`.")"
    ;;
  *) echo "::error::Unknown mode '$MODE'"; exit 1 ;;
esac
