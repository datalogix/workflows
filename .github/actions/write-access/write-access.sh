#!/usr/bin/env bash
# Whether the user who triggered the run can push to the repository: Claude pushes and runs commands with the Claude
# token, and labels only need triage access. Settings come from the environment (see action.yml).
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/github.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/github.sh"

# An error other than 404 (rate limit, server error) is not a lack of access
if ! permission=$(collaborator_permission "${SENDER:-}"); then
  echo "::error::Could not read the permission of ${SENDER:-}: $permission"
  exit 1
fi
if ! is_write_permission "$permission"; then
  echo "::notice::${SENDER:-} needs write access for Claude to run (has '${permission:-none}')"
  echo "skip=true" >> "$GITHUB_OUTPUT"
fi
