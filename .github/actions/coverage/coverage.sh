#!/usr/bin/env bash
# Fails when the Clover report written by the tests covers less than the minimum percentage of the code, counting
# statements, methods and conditionals together (Clover's elements). Settings come from the environment (see action.yml).
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/inputs.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/inputs.sh"

whole_number min-coverage "${MIN_COVERAGE:-}" 0
if ((10#$MIN_COVERAGE > 100)); then
  echo "::error::min-coverage must be a percentage from 0 to 100, got '$MIN_COVERAGE'"
  exit 1
fi
minimum=$((10#$MIN_COVERAGE))
if ((minimum == 0)); then
  echo "min-coverage is 0: coverage is not checked"
  exit 0
fi

# The tests touch it before they start: without it, no tests ran (e.g. no test script)
if [ -n "${SINCE:-}" ] && [ ! -e "$SINCE" ]; then
  echo "::error::No tests ran, so there is no coverage to check: add tests, or set min-coverage: 0"
  exit 1
fi

# Where PHPUnit, Pest, Vitest and Jest are usually told to write it. A report older than the tests (committed, or left by
# an earlier step) is not theirs
REPORTS=(clover.xml build/logs/clover.xml build/clover.xml coverage/clover.xml)
report=""
for candidate in "${REPORTS[@]}"; do
  if [ -f "$candidate" ] && { [ -z "${SINCE:-}" ] || [ "$candidate" -nt "$SINCE" ]; }; then
    report=$candidate
    break
  fi
done
if [ -z "$report" ]; then
  echo "::error::The tests wrote no Clover report (looked for ${REPORTS[*]}): configure the test runner to write one, or set min-coverage: 0"
  exit 1
fi

if ! command -v python3 >/dev/null; then
  echo "::error::The coverage check needs python3, which this runner lacks"
  exit 1
fi
# The project's elements and covered elements, then a line per file not fully covered
if ! parsed=$(python3 -I "$(dirname "${BASH_SOURCE[0]}")/clover.py" "$report"); then
  echo "::error::Could not read $report"
  exit 1
fi
if [ "$parsed" = invalid ]; then
  echo "::error::$report is not a Clover report with project metrics (elements and coveredelements)"
  exit 1
fi
read -r elements covered <<< "$(head -n 1 <<< "$parsed")"
if ((elements == 0)); then
  echo "::error::$report measures no code: check which files the coverage includes"
  exit 1
fi

# Rounded down, so a report short of the minimum never shows it
hundredths=$((covered * 10000 / elements))
percent=$(printf '%d.%02d' $((hundredths / 100)) $((hundredths % 100)))
summary="$percent% ($covered of $elements statements, methods and conditionals)"

if ((covered * 100 >= minimum * elements)); then
  echo "Coverage is $summary, minimum $minimum%"
  exit 0
fi

echo "::error::Coverage is $summary, below the minimum of $minimum%"

# The files short of full coverage, at most LIMIT of them. PHPUnit writes absolute paths
LIMIT=50
count=$(($(wc -l <<< "$parsed") - 1))
echo "Files not fully covered ($count):"
tail -n +2 <<< "$parsed" | head -n "$LIMIT" | while IFS=$'\t' read -r file_covered file_elements name; do
  echo "  ${name#"${GITHUB_WORKSPACE:-$PWD}/"}: $file_covered of $file_elements"
done
if ((count > LIMIT)); then
  echo "  ... and $((count - LIMIT)) more"
fi
exit 1
