#!/usr/bin/env bash
# session_chain.sh -- Cross-session chaining (--include-parent)
# Follows previous_session_id links to include parent session context.
# Part of Story 05, Task 13.
set -euo pipefail

# Source dependencies
_SESSION_CHAIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_SESSION_CHAIN_DIR}/paths.sh"
# shellcheck source=context_loader.sh
source "${_SESSION_CHAIN_DIR}/context_loader.sh"
# shellcheck source=format_context.sh
source "${_SESSION_CHAIN_DIR}/format_context.sh"

# Maximum chain depth
_GC_MAX_CHAIN_DEPTH=10

# resolve_session_chain(project_id, session_id, format)
#
# Resolves the session chain starting from session_id, following
# previous_session_id links. Outputs formatted context for the chain.
# Current session: full detail. Parent: compact. Grandparent+: one-liner.
resolve_session_chain() {
  local project_id="${1:?resolve_session_chain: project_id required}"
  local session_id="${2:?resolve_session_chain: session_id required}"
  local format="${3:-markdown}"

  # Track visited sessions to detect circular chains
  local -a visited=()
  local current_sid="$session_id"
  local depth=0

  if [[ "$format" == "json" ]]; then
    _resolve_chain_json "$project_id" "$session_id"
    return $?
  fi

  echo "## Session Context Recovery (Session Chain)"
  echo ""

  while [[ -n "$current_sid" && "$depth" -lt "$_GC_MAX_CHAIN_DEPTH" ]]; do
    # Circular chain detection
    local v
    for v in "${visited[@]+${visited[@]}}"; do
      if [[ "$v" == "$current_sid" ]]; then
        echo "**Warning**: Circular chain detected at session \`${current_sid}\`. Stopping."
        echo ""
        return 0
      fi
    done
    visited+=("$current_sid")

    # Load context for this session
    local context
    context="$(load_context "$project_id" "$current_sid" 2>/dev/null)" || {
      if [[ $depth -eq 0 ]]; then
        echo "### Current Session: ${current_sid}"
        echo ""
        echo "*Unable to load context for this session.*"
        echo ""
      else
        echo "### Ancestor Session: ${current_sid}"
        echo ""
        echo "*Unable to load context for this session.*"
        echo ""
      fi
      break
    }

    if [[ $depth -eq 0 ]]; then
      echo "### Current Session: ${current_sid}"
      echo ""
      printf '%s' "$context" | format_markdown
    elif [[ $depth -eq 1 ]]; then
      echo "---"
      echo ""
      echo "### Parent Session: ${current_sid}"
      echo ""
      _format_compact_summary "$context"
    else
      echo "---"
      echo ""
      echo "### Ancestor Session (depth ${depth}): ${current_sid}"
      echo ""
      _format_oneliner "$context"
    fi

    # Follow the chain
    local prev_sid
    prev_sid="$(printf '%s' "$context" | jq -r '.data.previous_session_id // empty' 2>/dev/null)"
    if [[ -z "$prev_sid" || "$prev_sid" == "null" ]]; then
      break
    fi
    current_sid="$prev_sid"
    depth=$((depth + 1))
  done

  # Check if chain was truncated
  if [[ $depth -ge $_GC_MAX_CHAIN_DEPTH ]]; then
    echo "---"
    echo ""
    echo "*Note: Chain depth limit (${_GC_MAX_CHAIN_DEPTH}) reached. Additional ancestor sessions exist but are omitted.*"
    echo ""
  fi
}

# _resolve_chain_json(project_id, session_id)
#
# Outputs the session chain as a JSON array.
_resolve_chain_json() {
  local project_id="$1"
  local session_id="$2"

  local -a visited=()
  local current_sid="$session_id"
  local depth=0
  local result="[]"

  while [[ -n "$current_sid" && "$depth" -lt "$_GC_MAX_CHAIN_DEPTH" ]]; do
    local v
    for v in "${visited[@]+${visited[@]}}"; do
      if [[ "$v" == "$current_sid" ]]; then
        # Circular chain, stop
        printf '%s' "$result" | jq '.'
        return 0
      fi
    done
    visited+=("$current_sid")

    local context
    context="$(load_context "$project_id" "$current_sid" 2>/dev/null)" || break

    result="$(printf '%s' "$result" | jq --argjson ctx "$context" --argjson depth "$depth" \
      '. + [{"depth": $depth, "context": $ctx}]')"

    local prev_sid
    prev_sid="$(printf '%s' "$context" | jq -r '.data.previous_session_id // empty' 2>/dev/null)"
    if [[ -z "$prev_sid" || "$prev_sid" == "null" ]]; then
      break
    fi
    current_sid="$prev_sid"
    depth=$((depth + 1))
  done

  printf '%s' "$result" | jq '.'
}

# _format_compact_summary(context_json)
#
# Compact summary for parent sessions: What Was Being Worked On + Files Modified + Where We Left Off
_format_compact_summary() {
  local context="$1"
  local data
  data="$(printf '%s' "$context" | jq -r '.data // .')"

  local last_prompt
  last_prompt="$(printf '%s' "$data" | jq -r '.last_prompt // ""')"
  if [[ -n "$last_prompt" && "$last_prompt" != "null" ]]; then
    echo "**Working on**: ${last_prompt}"
    echo ""
  fi

  local files_count
  files_count="$(printf '%s' "$data" | jq -r '.files_modified | length // 0')"
  if [[ "$files_count" -gt 0 ]]; then
    echo "**Files modified**: $(printf '%s' "$data" | jq -r '[.files_modified[].path] | join(", ")')"
    echo ""
  fi

  local event_count
  event_count="$(printf '%s' "$data" | jq -r '.event_count // 0')"
  echo "**Events**: ${event_count}"
  echo ""
}

# _format_oneliner(context_json)
#
# One-liner summary for grandparent+ sessions.
_format_oneliner() {
  local context="$1"
  printf '%s' "$context" | format_compact
  echo ""
}
