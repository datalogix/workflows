# shellcheck shell=bash
# Sourced by the action scripts. The fixed texts exist in Portuguese and English; any other language gets Portuguese,
# like textIn() in cli/kinds/project/state.js. Workflows read it through the language action
language=${LANGUAGE:-}
case "${language#"${language%%[![:space:]]*}"}" in [Ee][Nn]*) english=true ;; *) english=false ;; esac

# Prints the English text or the Portuguese one
t() {
  if [ "$english" = true ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}
