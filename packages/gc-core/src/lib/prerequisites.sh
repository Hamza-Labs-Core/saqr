#!/usr/bin/env bash
# prerequisites.sh -- Prerequisite checker library for GlobalContext.
# Verifies system has all required dependencies.
# Called by gc-install (to gate installation) and gc-doctor (to report health).
# Does not abort on failure -- reports what is missing and lets the caller decide.
set -euo pipefail

# ---------------------------------------------------------------------------
# Associative arrays for results
# ---------------------------------------------------------------------------
declare -gA PREREQ_STATUS=()
declare -gA PREREQ_VERSION=()
declare -gA PREREQ_MESSAGE=()

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# _gc_version_major version_string -> major version number
_gc_version_major() {
  local ver="$1"
  echo "${ver%%.*}"
}

# ---------------------------------------------------------------------------
# gc_check_prerequisites()
#   Populates PREREQ_STATUS, PREREQ_VERSION, PREREQ_MESSAGE arrays.
#   Returns 0 if all required prerequisites pass, 1 otherwise.
# ---------------------------------------------------------------------------
gc_check_prerequisites() {
  local all_required_ok=true

  # --- bash 4+ (required) ---
  local bash_major="${BASH_VERSINFO[0]}"
  PREREQ_VERSION[bash]="$bash_major.${BASH_VERSINFO[1]}"
  if [[ "$bash_major" -ge 4 ]]; then
    PREREQ_STATUS[bash]="ok"
    PREREQ_MESSAGE[bash]="bash ${PREREQ_VERSION[bash]}"
  else
    PREREQ_STATUS[bash]="outdated"
    PREREQ_MESSAGE[bash]="ERROR: bash 4+ required (found: ${PREREQ_VERSION[bash]}). On macOS: brew install bash"
    all_required_ok=false
  fi

  # --- jq (required, 1.5+) ---
  if command -v jq &>/dev/null; then
    local jq_ver
    jq_ver="$(jq --version 2>/dev/null | sed 's/jq-//')"
    PREREQ_VERSION[jq]="$jq_ver"
    local jq_major jq_minor
    jq_major="${jq_ver%%.*}"
    jq_minor="${jq_ver#*.}"
    jq_minor="${jq_minor%%.*}"
    if [[ "$jq_major" -gt 1 ]] 2>/dev/null || \
       { [[ "$jq_major" -eq 1 ]] && [[ "$jq_minor" -ge 5 ]]; } 2>/dev/null; then
      PREREQ_STATUS[jq]="ok"
      PREREQ_MESSAGE[jq]="jq $jq_ver"
    else
      PREREQ_STATUS[jq]="outdated"
      PREREQ_MESSAGE[jq]="ERROR: jq 1.5+ required (found: $jq_ver). Install: sudo apt install jq (Debian/Ubuntu) or brew install jq (macOS)"
      all_required_ok=false
    fi
  else
    PREREQ_STATUS[jq]="missing"
    PREREQ_VERSION[jq]=""
    PREREQ_MESSAGE[jq]="ERROR: jq is required but not found. Install: sudo apt install jq (Debian/Ubuntu) or brew install jq (macOS)"
    all_required_ok=false
  fi

  # --- node 18+ (required) ---
  if command -v node &>/dev/null; then
    local node_ver
    node_ver="$(node --version 2>/dev/null | sed 's/^v//')"
    PREREQ_VERSION[node]="$node_ver"
    local node_major
    node_major="$(_gc_version_major "$node_ver")"
    if [[ "$node_major" -ge 18 ]] 2>/dev/null; then
      PREREQ_STATUS[node]="ok"
      PREREQ_MESSAGE[node]="node $node_ver"
    else
      PREREQ_STATUS[node]="outdated"
      PREREQ_MESSAGE[node]="ERROR: Node.js 18+ required (found: $node_ver). Install from https://nodejs.org/"
      all_required_ok=false
    fi
  else
    PREREQ_STATUS[node]="missing"
    PREREQ_VERSION[node]=""
    PREREQ_MESSAGE[node]="ERROR: Node.js 18+ required but not found. Install from https://nodejs.org/"
    all_required_ok=false
  fi

  # --- sha256sum or shasum (required) ---
  if command -v sha256sum &>/dev/null; then
    PREREQ_STATUS[sha256sum]="ok"
    PREREQ_VERSION[sha256sum]="sha256sum"
    PREREQ_MESSAGE[sha256sum]="sha256sum"
  elif command -v shasum &>/dev/null; then
    PREREQ_STATUS[sha256sum]="ok"
    PREREQ_VERSION[sha256sum]="shasum"
    PREREQ_MESSAGE[sha256sum]="shasum (fallback)"
  else
    PREREQ_STATUS[sha256sum]="missing"
    PREREQ_VERSION[sha256sum]=""
    PREREQ_MESSAGE[sha256sum]="ERROR: sha256sum or shasum required for project-id hashing. Install coreutils."
    all_required_ok=false
  fi

  # --- git (optional) ---
  if command -v git &>/dev/null; then
    local git_ver
    git_ver="$(git --version 2>/dev/null | awk '{print $3}')"
    PREREQ_STATUS[git]="ok"
    PREREQ_VERSION[git]="$git_ver"
    PREREQ_MESSAGE[git]="git $git_ver"
  else
    PREREQ_STATUS[git]="optional_missing"
    PREREQ_VERSION[git]=""
    PREREQ_MESSAGE[git]="INFO: git not found. Version tracking will be limited."
  fi

  # --- flock (optional) ---
  if command -v flock &>/dev/null; then
    PREREQ_STATUS[flock]="ok"
    PREREQ_VERSION[flock]="available"
    PREREQ_MESSAGE[flock]="flock"
  else
    PREREQ_STATUS[flock]="optional_missing"
    PREREQ_VERSION[flock]=""
    PREREQ_MESSAGE[flock]="WARN: flock not found. Concurrent event writes will use best-effort mode (no locking)."
  fi

  # --- uuidgen (optional) ---
  if command -v uuidgen &>/dev/null; then
    PREREQ_STATUS[uuidgen]="ok"
    PREREQ_VERSION[uuidgen]="available"
    PREREQ_MESSAGE[uuidgen]="uuidgen"
  else
    PREREQ_STATUS[uuidgen]="optional_missing"
    PREREQ_VERSION[uuidgen]=""
    PREREQ_MESSAGE[uuidgen]="INFO: uuidgen not found. Using bash-native UUID generation (slightly weaker entropy)."
  fi

  if [[ "$all_required_ok" == "true" ]]; then
    return 0
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# gc_print_prereq_report()
#   Prints a formatted report of prerequisite statuses to stdout.
# ---------------------------------------------------------------------------
gc_print_prereq_report() {
  local names=("bash" "jq" "node" "sha256sum" "flock" "git" "uuidgen")
  for name in "${names[@]}"; do
    local status="${PREREQ_STATUS[$name]:-unknown}"
    local message="${PREREQ_MESSAGE[$name]:-}"
    local indicator
    case "$status" in
      ok)
        if [[ "$name" == "git" || "$name" == "flock" || "$name" == "uuidgen" ]]; then
          indicator="ok (optional)"
        else
          indicator="ok"
        fi
        printf "  %-20s %s\n" "$message" "$indicator"
        ;;
      missing|outdated)
        printf "  %-20s FAIL\n" "$message"
        ;;
      optional_missing)
        printf "  %-20s %s\n" "$name" "not found (optional)"
        ;;
      *)
        printf "  %-20s %s\n" "$name" "unknown"
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# gc_prereq_ok()
#   Returns 0 if all required prerequisites are met, 1 otherwise.
#   Must be called after gc_check_prerequisites.
# ---------------------------------------------------------------------------
gc_prereq_ok() {
  local required=("bash" "jq" "node" "sha256sum")
  for name in "${required[@]}"; do
    local status="${PREREQ_STATUS[$name]:-unknown}"
    if [[ "$status" != "ok" ]]; then
      return 1
    fi
  done
  return 0
}
