# shellcheck shell=bash
# Sourced by the action scripts. GitHub reads that tell a missing resource apart from an API error.

# Prints the output of gh with the arguments, or nothing when GitHub answers 404 (the resource does not exist, or there
# is no access to it). On any other error (rate limit, server error) fails and prints the first line of the error
# instead, so it is not mistaken for a missing resource. stderr is kept apart: a notice from gh on success would
# otherwise change the output
gh_or_missing() {
  local output err
  err=$(mktemp)
  if output=$(gh "$@" 2>"$err"); then
    rm -f "$err"
    printf '%s' "$output"
    return 0
  fi
  if grep -qE 'HTTP 404|Not Found' "$err"; then
    rm -f "$err"
    return 0
  fi
  head -n 1 "$err" | grep . || echo no answer
  rm -f "$err"
  return 1
}

# The permission of a user on the repository (admin, maintain, write, triage or read), or nothing for a user without
# access to it (a former collaborator, a deleted account). Fails like gh_or_missing
collaborator_permission() {
  gh_or_missing api "repos/$GITHUB_REPOSITORY/collaborators/$1/permission" --jq .permission
}

# Whether a permission from collaborator_permission lets the user push to the repository
is_write_permission() {
  case "$1" in
    admin | maintain | write) return 0 ;;
    *) return 1 ;;
  esac
}
