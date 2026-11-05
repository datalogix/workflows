#!/usr/bin/env bash
# Writes the plugins to install: core and the stack's, on which the prompts of the workflows depend whatever the project
# asks for, then the project's own, one per line and without repeating one
set -euo pipefail

stack=$(tr '[:upper:]' '[:lower:]' <<< "${STACK:-}")
[ "$stack" = js ] || stack=laravel

{
  echo 'plugins<<DATALOGIX_PLUGINS'
  printf '%s\n' core@datalogix "$stack@datalogix" "${PLUGINS:-}" |
    sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' |
    awk 'NF && !seen[$0]++'
  echo DATALOGIX_PLUGINS
} >> "$GITHUB_OUTPUT"
