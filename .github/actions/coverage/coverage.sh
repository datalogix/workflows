#!/usr/bin/env bash
# Reads the Clover report written by the tests and shows the coverage in the log and the job summary, counting
# statements, methods and conditionals together (Clover's elements). Below a minimum it fails; with min-coverage 0 it only
# shows the coverage and never fails. Settings come from the environment (see action.yml).
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/inputs.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/inputs.sh"

whole_number min-coverage "${MIN_COVERAGE:-}" 0
if ((10#$MIN_COVERAGE > 100)); then
  echo "::error::min-coverage must be a percentage from 0 to 100, got '$MIN_COVERAGE'"
  exit 1
fi
minimum=$((10#$MIN_COVERAGE))

# A problem with the report fails the check, or only notes it when there is no minimum. $2 is the hint shown with a
# minimum, $3 the one shown without
problem() {
  if ((minimum > 0)); then
    echo "::error::$1${2:+: $2}"
    exit 1
  fi
  echo "::notice::$1${3:+: $3}"
  exit 0
}

# The tests touch it before they start: without it, no tests ran (e.g. no test script)
if [ -n "${SINCE:-}" ] && [ ! -e "$SINCE" ]; then
  problem "No tests ran, so there is no coverage to check" "add tests, or set min-coverage: 0"
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
  problem "The tests wrote no Clover report (looked for ${REPORTS[*]})" \
    "configure the test runner to write one, or set min-coverage: 0" \
    "configure the test runner to write one to see the coverage"
fi

if ! command -v python3 >/dev/null; then
  problem "The coverage check needs python3, which this runner lacks"
fi
# The project's elements and covered elements, then a line per file not fully covered
if ! parsed=$(python3 -I "$(dirname "${BASH_SOURCE[0]}")/clover.py" "$report"); then
  problem "Could not read $report"
fi
if [ "$parsed" = invalid ]; then
  problem "$report is not a Clover report with project metrics (elements and coveredelements)"
fi
read -r elements covered <<< "$(head -n 1 <<< "$parsed")"
if ((elements == 0)); then
  problem "$report measures no code" "check which files the coverage includes" "check which files the coverage includes"
fi

# Rounded down, so a report short of the minimum never shows it
hundredths=$((covered * 10000 / elements))
percent=$(printf '%d.%02d' $((hundredths / 100)) $((hundredths % 100)))
summary="$percent% ($covered of $elements statements, methods and conditionals)"

passed=true
if ((minimum == 0)); then
  echo "Coverage is $summary, no minimum"
  status="no minimum"
elif ((covered * 100 >= minimum * elements)); then
  echo "Coverage is $summary, minimum $minimum%"
  status="minimum $minimum%"
else
  echo "::error::Coverage is $summary, below the minimum of $minimum%"
  status="below the minimum of $minimum%"
  passed=false
fi

# The files short of full coverage, at most LIMIT of them. PHPUnit writes absolute paths
LIMIT=50
count=$(($(wc -l <<< "$parsed") - 1))
files=$(tail -n +2 <<< "$parsed" | head -n "$LIMIT" | while IFS=$'\t' read -r file_covered file_elements name; do
  printf '%s\t%s\t%s\n' "${name#"${GITHUB_WORKSPACE:-$PWD}/"}" "$file_covered" "$file_elements"
done)

# The log lists the files only when the check fails; the summary always does
if [ "$passed" = false ]; then
  echo "Files not fully covered ($count):"
  while IFS=$'\t' read -r name file_covered file_elements; do
    echo "  $name: $file_covered of $file_elements"
  done <<< "$files"
  if ((count > LIMIT)); then
    echo "  ... and $((count - LIMIT)) more"
  fi
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Coverage: $percent%"
    echo
    echo "$covered of $elements statements, methods and conditionals; $status."
    if ((count > 0)); then
      echo
      echo "<details><summary>Files not fully covered ($count)</summary>"
      echo
      echo "| File | Covered | Total |"
      echo "| --- | --- | --- |"
      while IFS=$'\t' read -r name file_covered file_elements; do
        echo "| \`$name\` | $file_covered | $file_elements |"
      done <<< "$files"
      if ((count > LIMIT)); then
        echo
        echo "... and $((count - LIMIT)) more"
      fi
      echo
      echo "</details>"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

[ "$passed" = true ]
