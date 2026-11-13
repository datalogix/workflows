#!/usr/bin/env bash
# Checks the style of a JavaScript or TypeScript project with the ESLint, Prettier and Stylelint it installed, each one
# no lint script of package.json runs already: the tool's own check script (format:check, lint:css) when package.json
# has one, otherwise the tool itself, on the files changed by the pull request or the merge queue group and on every
# tracked file on other events. Only checks, never fixes; every tool runs even when an earlier one failed. The eslint,
# prettier and stylelint inputs turn a tool off. Settings come from the environment (see action.yml).
set -uo pipefail

if [ ! -f package.json ]; then
  echo "No package.json, skipping"
  echo "tools=" >> "$GITHUB_OUTPUT"
  exit 0
fi

# Whether package.json declares the dependency
declared() {
  jq -e --arg name "$1" '(.devDependencies // {}) + (.dependencies // {}) | has($name)' package.json > /dev/null
}

# The first of the scripts that package.json defines
first_script() {
  local name
  for name in "$@"; do
    if jq -e --arg name "$name" '.scripts[$name] // "" | . != ""' package.json > /dev/null; then
      echo "$name"
      return
    fi
  done
}

# The first of the files that exists
first_file() {
  local file
  for file in "$@"; do
    if [ -f "$file" ]; then
      echo "$file"
      return
    fi
  done
}

# The config of a tool: the first of the files that exists, else the tool's key in package.json
config_of() {
  local key=$1 file
  shift
  file=$(first_file "$@")
  if [ -n "$file" ]; then
    echo "$file"
  elif jq -e --arg key "$key" 'has($key)' package.json > /dev/null; then
    echo "the $key key of package.json"
  fi
}

# The lint script the workflows run (lint, else check; check is Vite+'s), and whether its text names a tool or script,
# which it then runs already
lint=$(first_script lint check)
lint_text=
if [ -n "$lint" ]; then
  lint_text=$(jq -r --arg name "$lint" '.scripts[$name]' package.json)
fi
lint_runs() {
  [ -n "$lint_text" ] && grep -qF -- "$1" <<< "$lint_text"
}

tools=

# Whether an input turned the tool off
off() {
  local name=$1 input=$2
  if [ "$input" = false ]; then
    echo "$name is turned off ($3: false)"
  else
    return 1
  fi
}

# ESLint only without a lint script: one that runs another linter (oxlint, Biome, vp check) replaces it
eslint=
if off ESLint "${RUN_ESLINT:-true}" eslint; then
  :
elif [ -z "$lint" ] && declared eslint; then
  config=$(first_file eslint.config.{js,mjs,cjs,ts,mts,cts})
  if [ -n "$config" ]; then
    eslint=flat
  else
    config=$(first_file .eslintrc{,.js,.cjs,.yaml,.yml,.json})
    [ -n "$config" ] && eslint=legacy
  fi
  if [ -n "$eslint" ]; then
    echo "No lint script, but package.json declares eslint and $config configures it: running ESLint"
    tools+=" eslint"
  fi
fi

prettier=
prettier_script=$(first_script format:check prettier:check)
if off Prettier "${RUN_PRETTIER:-true}" prettier; then
  :
elif [ -n "$prettier_script" ]; then
  if lint_runs "$prettier_script"; then
    echo "The $lint script runs $prettier_script already"
  else
    prettier=script
    echo "Running the $prettier_script script"
  fi
elif declared prettier; then
  config=$(config_of prettier .prettierrc{,.json,.json5,.yaml,.yml,.toml,.js,.cjs,.mjs,.ts,.cts,.mts} \
    prettier.config.{js,cjs,mjs,ts,cts,mts})
  if [ -z "$config" ]; then
    echo "package.json declares prettier, but no config was found: skipping Prettier"
  elif lint_runs prettier; then
    echo "The $lint script runs Prettier already"
  else
    prettier=files
    echo "package.json declares prettier and $config configures it: running Prettier"
  fi
fi
[ -n "$prettier" ] && tools+=" prettier"

stylelint=
stylelint_script=$(first_script lint:css stylelint)
if off Stylelint "${RUN_STYLELINT:-true}" stylelint; then
  :
elif [ -n "$stylelint_script" ]; then
  if lint_runs "$stylelint_script"; then
    echo "The $lint script runs $stylelint_script already"
  else
    stylelint=script
    echo "Running the $stylelint_script script"
  fi
elif declared stylelint; then
  config=$(config_of stylelint .stylelintrc{,.json,.yaml,.yml,.js,.cjs,.mjs,.ts,.cts,.mts} \
    stylelint.config.{js,cjs,mjs,ts,cts,mts})
  if [ -z "$config" ]; then
    echo "package.json declares stylelint, but no config was found: skipping Stylelint"
  elif lint_runs stylelint; then
    echo "The $lint script runs Stylelint already"
  else
    stylelint=files
    echo "package.json declares stylelint and $config configures it: running Stylelint"
  fi
fi
[ -n "$stylelint" ] && tools+=" stylelint"

tools=${tools# }
echo "tools=$tools" >> "$GITHUB_OUTPUT"
if [ "${RUN:-true}" = false ] || [ -z "$tools" ]; then
  exit 0
fi

# The project's own binaries and scripts: nothing is downloaded
if [ -f pnpm-lock.yaml ]; then
  bin=(pnpm exec)
  run=(pnpm run)
elif [ -f yarn.lock ]; then
  bin=(yarn)
  run=(yarn run)
else
  bin=(npx --no-install)
  run=(npm run)
fi

# The files the tools check: those the pull request or the merge queue group changes, so existing issues do not block
# them (as Pint does), every tracked file on other events. Without the files no one writes by hand: lockfiles, minified
# files, vendored code and Vite's build
list=$(mktemp)
trap 'rm -f "$list" "$list.all"' EXIT
case "${GITHUB_EVENT_NAME:-}" in
  pull_request) base=${BASE_REF:+origin/$BASE_REF} ;;
  merge_group) base=${MERGE_GROUP_BASE:-} ;;
  *) base= ;;
esac
if [ -n "$base" ] && git -c core.quotePath=false diff --name-only --diff-filter=d "$base" HEAD > "$list.all"; then
  scope="the files changed since $base"
else
  if [ -n "$base" ]; then
    echo "::warning::Could not list the files changed since $base: checking every tracked file"
  fi
  git -c core.quotePath=false ls-files > "$list.all"
  scope="every tracked file"
fi
grep -vE '(^|/)(composer\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$|\.min\.(js|mjs|cjs|css)$|(^|/)(vendor|node_modules)/|^public/build/' \
  "$list.all" > "$list"

# Runs a command with the listed files whose names match the pattern, in batches that fit a command line
on_files() {
  local name=$1 pattern=$2 files
  shift 2
  files=$(grep -E "$pattern" "$list")
  if [ -z "$files" ]; then
    echo "No files for $name in $scope, skipping"
    return 0
  fi
  echo "$name on $scope"
  printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 "$@"
}

failed=
check() {
  local name=$1 status
  shift
  "$@"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::error::$name failed (exit code $status): it must pass without fixing files"
    failed=true
  fi
}

case "$eslint" in
  # Files no config object matches are ignored, without a warning
  flat) check ESLint on_files ESLint '\.(js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|astro)$' \
    "${bin[@]}" eslint --no-warn-ignored ;;
  # ESLint 8 lints every file it is given, whichever its config covers: the whole project, as its config says. ESLint 9
  # reads a legacy config only with ESLINT_USE_FLAT_CONFIG=false
  legacy) check ESLint env ESLINT_USE_FLAT_CONFIG=false "${bin[@]}" eslint . ;;
esac

case "$prettier" in
  script) check Prettier "${run[@]}" "$prettier_script" ;;
  # Files Prettier has no parser for (PHP without its plugin, Blade without prettier-plugin-blade) are skipped
  files) check Prettier on_files Prettier . "${bin[@]}" prettier --check --ignore-unknown ;;
esac

# Styles inside components only with a custom syntax for them (postcss-html, which the Vue and HTML configs bring)
styles='css|scss|sass|less'
if jq -e '(.devDependencies // {}) + (.dependencies // {}) | keys | any(. == "postcss-html" or test("^stylelint-config-.*(vue|html|svelte|astro)"))' \
  package.json > /dev/null; then
  styles+='|vue|svelte|astro|html'
fi
case "$stylelint" in
  script) check Stylelint "${run[@]}" "$stylelint_script" ;;
  files) check Stylelint on_files Stylelint "\\.($styles)\$" "${bin[@]}" stylelint --allow-empty-input ;;
esac

[ -z "$failed" ]
