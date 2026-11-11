# shellcheck shell=bash
# Sourced by the action scripts that keep a pull request open (release-pr, package-release): finding the open pull
# request of a branch, and opening it or updating its body. They act on GITHUB_REPOSITORY with gh (GH_TOKEN).

# The value encoded for a URL (a branch name in a query or a path)
uri() {
  jq -rn --arg value "$1" '$value | @uri'
}

# Number of the open pull request from head to base, or nothing
open_pull() {
  gh api "repos/$GITHUB_REPOSITORY/pulls?state=open&base=$(uri "$2")&head=$(uri "${GITHUB_REPOSITORY%%/*}:$1")" --jq '.[0].number // empty'
}

set_body() {
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/pulls/$1" -f "body=$2" >/dev/null
}

set_title_and_body() {
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/pulls/$1" -f "title=$2" -f "body=$3" >/dev/null
}

# Opens the pull request from head to base, or updates the body of the open one (and its title, with update_title)
open_or_update() {
  local head=$1 base=$2 title=$3 body=$4 update_title=${5:-} number
  number=$(open_pull "$head" "$base")
  if [ -n "$number" ]; then
    if [ -n "$update_title" ]; then set_title_and_body "$number" "$title" "$body"; else set_body "$number" "$body"; fi
    echo "Updated pull request #$number"
  else
    number=$(gh api "repos/$GITHUB_REPOSITORY/pulls" -f "head=$head" -f "base=$base" -f "title=$title" -f "body=$body" --jq .number)
    echo "Opened pull request #$number"
  fi
}
