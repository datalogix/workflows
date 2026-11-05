# shellcheck shell=bash
# Sourced by the action scripts. The release history the deploy workflow keeps per environment (its lowercase name):
# refs/datalogix/deploys/<environment>/<time> point at every commit that deployed and stayed healthy,
# refs/datalogix/rolled-back/<environment>/<sha> mark releases that were rolled back by hand, and
# refs/datalogix/live/<environment> points at the last commit a deploy or rollback was triggered for, healthy or not.

# The refs of an environment, also written by the deploy script
live_ref() { printf 'datalogix/live/%s' "$1"; }
history_ref() { printf 'datalogix/deploys/%s' "$1"; }
rolled_back_ref() { printf 'datalogix/rolled-back/%s' "$1"; }

# Needs gh_or_missing (github.sh) and, for environment_label, t() (language.sh).

# Creates (or updates) the env:<environment> label of the issues about an environment, opened by the deploy and
# incident scripts: the rollback label added to such an issue rolls that environment back
environment_label() {
  gh label create "env:$1" --repo "$GITHUB_REPOSITORY" --color c5def5 --force \
    --description "$(t "Environment of the problem; the rollback label rolls this environment back" \
      "Ambiente do problema; o label rollback reverte este ambiente")" >/dev/null || true
}

# The commit the environment runs, or nothing before the first deploy that recorded it (404). Fails on any other
# error, so an API error is not mistaken for no live release.
live_release() {
  local environment=$1 sha
  if ! sha=$(gh_or_missing api "repos/$GITHUB_REPOSITORY/git/ref/$(live_ref "$environment")" --jq '.object.sha'); then
    echo "::error::Cannot read the live release of $environment: $sha" >&2
    return 1
  fi
  [ -z "$sha" ] || printf '%s\n' "$sha"
}

# Good releases, newest first and once each, without the rolled-back ones. Fails when the history cannot be read, so
# an API error is not mistaken for an empty history.
good_releases() {
  local environment=$1 bad refs
  bad=$(gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/$(rolled_back_ref "$environment")/" --jq '.[].object.sha') ||
    return 1
  refs=$(gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/$(history_ref "$environment")/" \
    --jq '.[] | "\(.ref | split("/") | last) \(.object.sha)"') || return 1
  printf '%s\n' "$refs" | sed '/^$/d' | sort -rn | awk '{ print $2 }' | awk '!seen[$0]++' |
    { grep -vxF -f <(printf '%s\n' "$bad" | sed '/^$/d') || true; }
}

# The newest of the releases (from good_releases) other than the given one: what a rollback from it returns to
previous_release() {
  awk -v sha="$2" 'NF && $0 != sha { print; exit }' <<< "$1"
}
