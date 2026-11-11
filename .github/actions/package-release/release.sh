#!/usr/bin/env bash
# The releases of a package, run from its repository's checkout of the pushed commit (with its history and tags).
# MODE (see action.yml):
# - release: when the pushed commit merged the release pull request, tags it and creates the GitHub release (publish);
#   otherwise opens or updates the release pull request with the next version and its changelog (propose)
# - npm: publishes the checked out tag to npm (js packages)
# The texts are shown in the package's GitHub, in its language.
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/language.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/language.sh"
# shellcheck source=SCRIPTDIR/../lib/pulls.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/pulls.sh"
# shellcheck source=SCRIPTDIR/../lib/github.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/github.sh"

BRANCH=${BRANCH:-datalogix/release}
# The default branch, which the release pull request merges into
BASE=${BASE:-main}
STACK=${STACK:-laravel}
SHA=${SHA:-${GITHUB_SHA:-}}
# The body of the release pull request carries the version it releases, which publish reads after the merge
MARKER='datalogix-release'
SEMVER='^v?([0-9]+)\.([0-9]+)\.([0-9]+)$'
# Subjects of the commits this script writes, left out of the changelog
RELEASE_COMMIT='^chore\(release\): '

output() {
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "$1=$2" >> "$GITHUB_OUTPUT"
}

# The newest version tag reachable from HEAD (v1.2.3 or 1.2.3), or nothing
last_tag() {
  git tag --merged HEAD | grep -E "$SEMVER" | sort -V | tail -n 1 || true
}

# The pull request of the release branch that the pushed commit merged, as JSON, or nothing
merged_release_pull() {
  gh api "repos/$GITHUB_REPOSITORY/commits/$SHA/pulls" \
    --jq "[.[] | select(.head.ref == \"$BRANCH\" and .merged_at != null)] | .[0] // empty"
}

# Classifies the commits since the last tag (newest first) into the changelog sections and the bump they ask for:
# breaking changes are major, feat minor, fix, perf, revert and deps patch; other types are listed but release nothing.
# When no commit follows Conventional Commits (a project without type prefixes), every commit is a patch and a
# BREAKING CHANGE footer a major. A Release-As: X.Y.Z footer sets the version
breaking=() features=() fixes=() others=()
bump=none release_as=''
conventional=0 total=0

raise() {
  case "$1:$bump" in
    major:*) bump='major' ;;
    minor:none | minor:patch) bump='minor' ;;
    patch:none) bump='patch' ;;
  esac
}

commit_line() {
  local scope=$1 description=$2 sha=$3 url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/commit/$3"
  printf -- '- %s%s ([%s](%s))' "${scope:+**$scope:** }" "$description" "${sha:0:7}" "$url"
}

read_commits() {
  local range=$1 record sha subject body type scope bang description line
  local pattern='^([A-Za-z]+)(\(([^)]*)\))?(!)?:[[:space:]]+(.+)$'
  local -a plain=()
  while IFS= read -r -d $'\x1e' record; do
    record=${record#$'\n'}
    [ -n "$record" ] || continue
    sha=${record%%$'\x1f'*}
    record=${record#*$'\x1f'}
    subject=${record%%$'\x1f'*}
    body=${record#*$'\x1f'}
    [[ "$subject" =~ $RELEASE_COMMIT ]] && continue
    total=$((total + 1))
    if [ -z "$release_as" ] && [[ "$body" =~ (^|$'\n')Release-As:[[:space:]]*(v?[0-9]+\.[0-9]+\.[0-9]+) ]]; then
      release_as=${BASH_REMATCH[2]#v}
    fi
    local breaks=false
    [[ "$body" =~ (^|$'\n')BREAKING[\ -]CHANGE: ]] && breaks=true
    if [[ "$subject" =~ $pattern ]]; then
      conventional=$((conventional + 1))
      type=$(tr '[:upper:]' '[:lower:]' <<< "${BASH_REMATCH[1]}")
      scope=${BASH_REMATCH[3]}
      bang=${BASH_REMATCH[4]}
      description=${BASH_REMATCH[5]}
      line=$(commit_line "$scope" "$description" "$sha")
      [ -n "$bang" ] && breaks=true
      if [ "$breaks" = true ]; then
        breaking+=("$line")
        raise major
      elif [ "$type" = feat ]; then
        features+=("$line")
        raise minor
      elif [[ "$type" =~ ^(fix|perf|revert|deps)$ ]]; then
        fixes+=("$line")
        raise patch
      else
        others+=("$line")
      fi
    else
      line=$(commit_line '' "$subject" "$sha")
      if [ "$breaks" = true ]; then breaking+=("$line"); else plain+=("$line"); fi
      [ "$breaks" = true ] && raise major
    fi
  done < <(git log --no-merges --format='%H%x1f%s%x1f%b%x1e' "$range")
  others+=(${plain[@]+"${plain[@]}"})
  # Without any Conventional Commit, every commit asks for a patch
  if [ "$conventional" -eq 0 ] && [ "$total" -gt 0 ]; then raise patch; fi
}

# The next version from the current one (empty without a tag) and the bump; before 1.0.0 a breaking change is minor
next_version() {
  local current=$1 major minor patch
  if [ -n "$release_as" ]; then
    printf '%s' "$release_as"
    return
  fi
  [ "$bump" != none ] || return 0
  if [ -z "$current" ]; then
    # The first release: the version package.json already has (js), else 0.1.0
    local declared=''
    [ "$STACK" != js ] || [ ! -f package.json ] || declared=$(jq -r '.version // empty' package.json)
    if [[ "$declared" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ "$declared" != 0.0.0 ]; then
      printf '%s' "$declared"
    else
      printf '0.1.0'
    fi
    return
  fi
  [[ "$current" =~ $SEMVER ]]
  major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]}
  case "$bump" in
    major) if [ "$major" -eq 0 ]; then printf '0.%s.0' $((minor + 1)); else printf '%s.0.0' $((major + 1)); fi ;;
    minor) printf '%s.%s.0' "$major" $((minor + 1)) ;;
    patch) printf '%s.%s.%s' "$major" "$minor" $((patch + 1)) ;;
  esac
}

section() {
  local title=$1
  shift
  [ "$#" -gt 0 ] || return 0
  printf '\n### %s\n\n' "$title"
  printf '%s\n' "$@"
}

# The changelog section of the version, from the commits read_commits classified
changelog() {
  local tag=$1 previous=$2 heading
  heading=$tag
  [ -z "$previous" ] || heading="[$tag](${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/compare/$previous...$tag)"
  printf '## %s (%s)\n' "$heading" "$(date -u +%Y-%m-%d)"
  section "$(t 'Breaking changes' 'Mudanças incompatíveis')" ${breaking[@]+"${breaking[@]}"}
  section "$(t 'Features' 'Novidades')" ${features[@]+"${features[@]}"}
  section "$(t 'Fixes' 'Correções')" ${fixes[@]+"${fixes[@]}"}
  section "$(t 'Other changes' 'Outras mudanças')" ${others[@]+"${others[@]}"}
}

# CHANGELOG.md with the section first, under its title when it has one
write_changelog() {
  local notes=$1 file=CHANGELOG.md
  if [ ! -f "$file" ]; then
    printf '# Changelog\n\n%s\n' "$notes" > "$file"
    return
  fi
  local first
  first=$(head -n 1 "$file")
  if [[ "$first" =~ ^#\  ]]; then
    # The title, the new section, then the rest without the blank lines that followed the title
    { printf '%s\n\n%s\n\n' "$first" "$notes"; tail -n +2 "$file" | sed '/./,$!d'; } > "$file.new"
  else
    { printf '%s\n\n' "$notes"; cat "$file"; } > "$file.new"
  fi
  mv "$file.new" "$file"
}

nothing_to_release() {
  t "Nothing to release: the commits since \`$1\` change nothing a release needs (only docs, tests, CI and the like). A \`Release-As: X.Y.Z\` footer in a commit releases anyway." \
    "Nada a lançar: os commits desde \`$1\` não mudam nada que precise de uma versão (só docs, testes, CI e afins). Um rodapé \`Release-As: X.Y.Z\` num commit lança mesmo assim."
}

# Opens or updates the release pull request: CHANGELOG.md and, for js, the version of package.json, committed on the
# release branch, rebuilt from the pushed commit each time
propose() {
  local tag previous range current next prefix notes number body
  previous=$(last_tag)
  range=HEAD
  [ -z "$previous" ] || range="$previous..HEAD"
  read_commits "$range"
  current=${previous#v}
  next=$(next_version "$current")
  if [ -z "$next" ]; then
    number=$(open_pull "$BRANCH" "$BASE")
    if [ -n "$number" ]; then
      set_body "$number" "$(nothing_to_release "${previous:-$BASE}")"
      echo "Nothing to release; updated pull request #$number"
    else
      echo "Nothing to release since ${previous:-the first commit}"
    fi
    return 0
  fi
  # The tag prefix follows the last tag: v by default
  prefix=v
  [ -z "$previous" ] || [[ "$previous" == v* ]] || prefix=''
  tag="$prefix$next"
  notes=$(changelog "$tag" "$previous")

  git switch --quiet -C "$BRANCH"
  write_changelog "$notes"
  git add CHANGELOG.md
  if [ "$STACK" = js ] && [ -f package.json ]; then
    npm version "$next" --no-git-tag-version --allow-same-version --ignore-scripts >/dev/null
    git add package.json
    [ ! -f package-lock.json ] || git add package-lock.json
  fi
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit --quiet -m "chore(release): $tag"
  git push --quiet --force origin "HEAD:refs/heads/$BRANCH"

  body="<!-- $MARKER: $tag -->
$(t "Merging this pull request releases **$tag**: it tags the merge commit and creates the GitHub release with these notes" \
    "O merge deste pull request lança a **$tag**: cria a tag no commit do merge e a release no GitHub com estas notas")$([ "$STACK" = js ] && t ', and publishes it to npm' ', e publica no npm').

<!-- $MARKER-notes -->
$notes
<!-- /$MARKER-notes -->

$(t "It is rebuilt from \`$BASE\` on every push. The commit types decide the version: \`feat\` is minor, \`fix\` patch, \`!\` or \`BREAKING CHANGE:\` major (minor before 1.0.0); a \`Release-As: X.Y.Z\` footer in a commit sets it." \
    "Ele é refeito a partir da \`$BASE\` a cada push. Os tipos dos commits decidem a versão: \`feat\` é minor, \`fix\` patch, \`!\` ou \`BREAKING CHANGE:\` major (minor antes da 1.0.0); um rodapé \`Release-As: X.Y.Z\` num commit define a versão.")"
  open_or_update "$BRANCH" "$BASE" "chore(release): $tag" "$body" title
  output version "$next"
}

# Tags the merge commit of the release pull request and creates the GitHub release, unless they exist (a re-run)
publish() {
  local pull=$1 tag sha notes existing
  tag=$(jq -r '.body // ""' <<< "$pull" | sed -nE "s/^<!-- $MARKER: ([^ ]+) -->.*/\1/p" | head -n 1)
  if [ -z "$tag" ]; then
    echo "::error::The release pull request #$(jq -r .number <<< "$pull") does not say which version it releases (<!-- $MARKER: vX.Y.Z -->)"
    exit 1
  fi
  sha=$(jq -r '.merge_commit_sha // empty' <<< "$pull")
  sha=${sha:-$SHA}
  # The notes are what the body has between the notes markers
  notes=$(jq -r '.body' <<< "$pull" | sed -n "/^<!-- $MARKER-notes -->/,/^<!-- \/$MARKER-notes -->/p" | sed '1d;$d')

  if ! existing=$(gh_or_missing api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" --jq .object.sha); then
    echo "::error::Cannot read the tag $tag: $existing"
    exit 1
  fi
  if [ -z "$existing" ]; then
    gh api "repos/$GITHUB_REPOSITORY/git/refs" -f "ref=refs/tags/$tag" -f "sha=$sha" >/dev/null
    echo "Tagged $tag at ${sha:0:7}"
  else
    echo "$tag already exists"
  fi

  if ! existing=$(gh_or_missing api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" --jq .html_url); then
    echo "::error::Cannot read the release $tag: $existing"
    exit 1
  fi
  if [ -z "$existing" ]; then
    existing=$(gh api "repos/$GITHUB_REPOSITORY/releases" -f "tag_name=$tag" -f "name=$tag" -f "body=$notes" --jq .html_url)
    echo "Created the release $existing"
  else
    echo "The release $tag already exists: $existing"
  fi
  output tag "$tag"
  output version "${tag#v}"
}

# Publishes package.json to npm with provenance: trusted publishing (OIDC, id-token: write) or NPM_TOKEN. Skips a
# private package and a version npm already has, so a re-run publishes nothing twice
publish_npm() {
  local name version private dist_tag=latest
  name=$(jq -r '.name // empty' package.json)
  version=$(jq -r '.version // empty' package.json)
  private=$(jq -r '.private // false' package.json)
  if [ "$private" = true ]; then
    echo "package.json is private: nothing is published to npm"
    return 0
  fi
  if [ "$version" != "${TAG#v}" ]; then
    echo "::error::package.json has version $version, but the release is $TAG"
    exit 1
  fi
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "$name@$version is already on npm"
    return 0
  fi
  [[ "$version" != *-* ]] || dist_tag=next
  if [ -n "${NPM_TOKEN:-}" ]; then
    NODE_AUTH_TOKEN=$NPM_TOKEN npm publish --access public --provenance --tag "$dist_tag"
  else
    # Trusted publishing: npm exchanges the workflow's OIDC token, and adds provenance on its own
    npm publish --access public --tag "$dist_tag"
  fi
  echo "Published $name@$version to npm"
}

case "${MODE:-release}" in
  release)
    pull=$(merged_release_pull)
    if [ -n "$pull" ]; then publish "$pull"; else propose; fi
    ;;
  npm) publish_npm ;;
  *) echo "::error::Unknown mode '$MODE'"; exit 1 ;;
esac
