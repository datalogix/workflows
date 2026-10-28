# shellcheck shell=bash
# Sourced by the action scripts. Checks of the action inputs.

# Fails unless the input is a whole number of at least the minimum. Inputs of type number accept decimals, which test
# would not read as numbers
whole_number() {
  local name=$1 value=$2 min=$3
  if ! [[ "$value" =~ ^[0-9]+$ ]] || ((10#$value < min)); then
    echo "::error::$name must be a whole number of at least $min, got '$value'"
    exit 1
  fi
}
