#!/usr/bin/env bash
# format_context.sh -- Output formatters for context projection data
# Provides: format_json, format_markdown, format_text, format_compact
# Part of Story 05, Task 10.
set -euo pipefail

# Source dependencies
_FORMAT_CONTEXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "${_FORMAT_CONTEXT_DIR}/paths.sh"

# format_json(context_file_or_stdin)
#
# Pretty-print the context JSON as-is.
format_json() {
  local input="${1:-}"
  if [[ -n "$input" && -f "$input" ]]; then
    jq '.' "$input"
  else
    jq '.'
  fi
}

# _format_actions_markdown(data_json, actions_count)
#
# Render actions with progressive summarization for markdown:
# - Last 20: full detail (tool name, target, result summary)
# - 21-50 from end: tool name + target only
# - 51-100 from end: grouped by tool type with count
# - 100+ from end: one-line summary
_format_actions_markdown() {
  local data="$1"
  local total="$2"

  if [[ "$total" -le 20 ]]; then
    # All actions get full detail
    local i=0
    while [[ $i -lt $total ]]; do
      _render_action_full_md "$data" "$i"
      i=$((i + 1))
    done
    return
  fi

  # Progressive summarization tiers (indices are 0-based)
  # Tier 4 (100+ from end): one-line summary
  # Tier 3 (51-100 from end): grouped by tool type
  # Tier 2 (21-50 from end): tool name + target only
  # Tier 1 (last 20): full detail

  local tier1_start=$((total - 20))
  local tier2_start=$((total - 50))
  local tier3_start=$((total - 100))

  [[ $tier2_start -lt 0 ]] && tier2_start=0
  [[ $tier3_start -lt 0 ]] && tier3_start=0

  # Tier 4: one-line summary for actions beyond index 100 from end
  if [[ $tier3_start -gt 0 ]]; then
    local tier4_count=$tier3_start
    local tier4_tools
    tier4_tools="$(printf '%s' "$data" | jq -r "[.actions[0:$tier4_count][].tool_name] | unique | length")"
    echo "$tier4_count events across $tier4_tools tools (oldest, summarized)"
    echo ""
  fi

  # Tier 3: grouped by tool type for actions 51-100 from end
  if [[ $tier3_start -lt $tier2_start ]]; then
    echo "**Grouped actions** (events $((tier3_start + 1))-${tier2_start}):"
    printf '%s' "$data" | jq -r "
      [.actions[$tier3_start:$tier2_start][].tool_name]
      | group_by(.) | map({tool: .[0], count: length})
      | sort_by(-.count)[]
      | \"  - \(.tool) x\(.count)\"
    "
    echo ""
  fi

  # Tier 2: tool name + target only for actions 21-50 from end
  if [[ $tier2_start -lt $tier1_start ]]; then
    local i=$tier2_start
    while [[ $i -lt $tier1_start ]]; do
      local tool_name target
      tool_name="$(printf '%s' "$data" | jq -r ".actions[$i].tool_name // \"unknown\"")"
      target="$(printf '%s' "$data" | jq -r ".actions[$i].target // \"\"")"
      local line="$((i + 1)). **${tool_name}**"
      if [[ -n "$target" && "$target" != "null" ]]; then
        line="${line} on \`${target}\`"
      fi
      echo "$line"
      i=$((i + 1))
    done
    echo ""
  fi

  # Tier 1: full detail for last 20 actions
  local i=$tier1_start
  while [[ $i -lt $total ]]; do
    _render_action_full_md "$data" "$i"
    i=$((i + 1))
  done
}

# _render_action_full_md(data_json, index)
#
# Render a single action in full markdown detail.
_render_action_full_md() {
  local data="$1"
  local i="$2"

  local tool_name target result_summary
  tool_name="$(printf '%s' "$data" | jq -r ".actions[$i].tool_name // \"unknown\"")"
  target="$(printf '%s' "$data" | jq -r ".actions[$i].target // \"\"")"
  result_summary="$(printf '%s' "$data" | jq -r ".actions[$i].result_summary // \"\"")"

  local line="$((i + 1)). **${tool_name}**"
  if [[ -n "$target" && "$target" != "null" ]]; then
    line="${line} on \`${target}\`"
  fi
  if [[ -n "$result_summary" && "$result_summary" != "null" ]]; then
    line="${line} -- ${result_summary}"
  fi
  echo "$line"
}

# _format_actions_text(data_json, actions_count)
#
# Render actions with progressive summarization for text format.
_format_actions_text() {
  local data="$1"
  local total="$2"

  if [[ "$total" -le 20 ]]; then
    local i=0
    while [[ $i -lt $total ]]; do
      local tool_name target
      tool_name="$(printf '%s' "$data" | jq -r ".actions[$i].tool_name // \"unknown\"")"
      target="$(printf '%s' "$data" | jq -r ".actions[$i].target // \"\"")"
      local line="  - ${tool_name}"
      if [[ -n "$target" && "$target" != "null" ]]; then
        line="${line} on ${target}"
      fi
      echo "$line"
      i=$((i + 1))
    done
    return
  fi

  local tier1_start=$((total - 20))
  local tier2_start=$((total - 50))
  local tier3_start=$((total - 100))

  [[ $tier2_start -lt 0 ]] && tier2_start=0
  [[ $tier3_start -lt 0 ]] && tier3_start=0

  # Tier 4: one-line summary
  if [[ $tier3_start -gt 0 ]]; then
    local tier4_count=$tier3_start
    local tier4_tools
    tier4_tools="$(printf '%s' "$data" | jq -r "[.actions[0:$tier4_count][].tool_name] | unique | length")"
    echo "  $tier4_count events across $tier4_tools tools (oldest, summarized)"
    echo ""
  fi

  # Tier 3: grouped by tool type
  if [[ $tier3_start -lt $tier2_start ]]; then
    echo "  Grouped actions (events $((tier3_start + 1))-${tier2_start}):"
    printf '%s' "$data" | jq -r "
      [.actions[$tier3_start:$tier2_start][].tool_name]
      | group_by(.) | map({tool: .[0], count: length})
      | sort_by(-.count)[]
      | \"    - \(.tool) x\(.count)\"
    "
    echo ""
  fi

  # Tier 2: tool name + target only
  if [[ $tier2_start -lt $tier1_start ]]; then
    local i=$tier2_start
    while [[ $i -lt $tier1_start ]]; do
      local tool_name target
      tool_name="$(printf '%s' "$data" | jq -r ".actions[$i].tool_name // \"unknown\"")"
      target="$(printf '%s' "$data" | jq -r ".actions[$i].target // \"\"")"
      local line="  - ${tool_name}"
      if [[ -n "$target" && "$target" != "null" ]]; then
        line="${line} on ${target}"
      fi
      echo "$line"
      i=$((i + 1))
    done
    echo ""
  fi

  # Tier 1: full detail (tool + target)
  local i=$tier1_start
  while [[ $i -lt $total ]]; do
    local tool_name target
    tool_name="$(printf '%s' "$data" | jq -r ".actions[$i].tool_name // \"unknown\"")"
    target="$(printf '%s' "$data" | jq -r ".actions[$i].target // \"\"")"
    local line="  - ${tool_name}"
    if [[ -n "$target" && "$target" != "null" ]]; then
      line="${line} on ${target}"
    fi
    echo "$line"
    i=$((i + 1))
  done
}

# _gc_truncate_output(output_string, max_bytes)
#
# If output exceeds max_bytes, truncate tool results to 200 chars,
# omit old action details, and add truncation note.
# Outputs truncated text to stdout.
_gc_truncate_output() {
  local output="$1"
  local max_bytes="${2:-204800}"  # 200KB default

  local size=${#output}
  if [[ "$size" -le "$max_bytes" ]]; then
    printf '%s' "$output"
    return
  fi

  # Truncate: remove lines longer than 200 chars (likely tool results)
  local truncated=""
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ ${#line} -gt 200 ]]; then
      truncated="${truncated}${line:0:200}...(truncated)
"
    else
      truncated="${truncated}${line}
"
    fi
  done <<< "$output"

  # If still too large, take just the beginning
  if [[ ${#truncated} -gt "$max_bytes" ]]; then
    truncated="${truncated:0:$max_bytes}"
  fi

  printf '%s' "$truncated"
  echo ""
  echo "---"
  echo "*Note: Output truncated from $size bytes to fit within ${max_bytes} byte limit.*"
}

# format_markdown(context_file_or_stdin)
#
# Render context projection as markdown with sections:
# Session Info, What Was Being Worked On, Actions Taken,
# Files Modified, Key Decisions, Where We Left Off
format_markdown() {
  local input="${1:-}"
  local json
  if [[ -n "$input" && -f "$input" ]]; then
    json="$(cat "$input")"
  else
    json="$(cat)"
  fi

  # Normalize both real projection and degraded context into a common shape
  # Also filter out system-injected prompts (task notifications, skill expansions, etc.)
  local data
  data="$(printf '%s' "$json" | jq '
    def is_system_prompt:
      (.prompt // "") as $p |
      (($p | startswith("<task-notification>")) and (($p | contains("</task-notification>")) or ($p | contains("<task-id>")))) or
      (($p | startswith("<task-id>")) and ($p | contains("</task-id>"))) or
      (($p | startswith("<output-file>")) and ($p | contains("</output-file>"))) or
      (($p | startswith("<system-reminder>")) and ($p | contains("</system-reminder>"))) or
      (($p | startswith("<command-name>")) and ($p | contains("</command-name>"))) or
      (($p | startswith("<command-message>")) and ($p | contains("</command-message>")));
    if .data then
      # Degraded/minimal projection path -- prompts may already be in .data
      .data + {
        prompts: [(.data.prompts // [])[] | select(is_system_prompt | not)],
        responses: (.data.responses // [])
      }
    else {
      session_id: (._session_id // .session.id // "unknown"),
      project_id: (._project_id // "unknown"),
      started_at: (.session.started_at // "unknown"),
      last_event_at: (.session.ended_at // "unknown"),
      event_count: (.session.event_count // ._last_sequence // 0),
      last_prompt: ([(.prompts // [])[] | select(is_system_prompt | not)][-1].prompt // ""),
      prompts: [(.prompts // [])[] | select(is_system_prompt | not)],
      responses: (.responses // []),
      ended_at: (.session.ended_at // "in progress"),
      previous_session_id: (.session.previous_session_id // null),
      actions: [(.key_tool_calls // [])[] | {
        tool_name: .tool_name,
        target: .input_summary,
        result_summary: .output_summary
      }],
      files_modified: [(.files_modified // [])[] | {
        path: .path,
        operations: ((.operations // []) | join(", ")),
        last_action: (.last_operation // "unknown")
      }],
      decisions: [],
      last_state: (.last_state.working_on // null)
    }
    end
  ')"

  local session_id project_id started_at last_event_at event_count
  local last_prompt ended_at previous_session_id

  session_id="$(printf '%s' "$data" | jq -r '.session_id // "unknown"')"
  project_id="$(printf '%s' "$data" | jq -r '.project_id // "unknown"')"
  started_at="$(printf '%s' "$data" | jq -r '.started_at // "unknown"')"
  last_event_at="$(printf '%s' "$data" | jq -r '.last_event_at // "unknown"')"
  event_count="$(printf '%s' "$data" | jq -r '.event_count // 0')"
  last_prompt="$(printf '%s' "$data" | jq -r '.last_prompt // ""')"
  ended_at="$(printf '%s' "$data" | jq -r '.ended_at // "in progress"')"
  previous_session_id="$(printf '%s' "$data" | jq -r '.previous_session_id // "none"')"

  # Section 1: Session Info
  echo "## Session Info"
  echo ""
  echo "- **Session ID**: \`${session_id}\`"
  echo "- **Project**: \`${project_id}\`"
  echo "- **Started**: ${started_at}"
  echo "- **Last Activity**: ${last_event_at}"
  echo "- **Ended**: ${ended_at}"
  echo "- **Event Count**: ${event_count}"
  if [[ "$previous_session_id" != "none" && "$previous_session_id" != "null" && -n "$previous_session_id" ]]; then
    echo "- **Continuation of**: \`${previous_session_id}\`"
  fi
  echo ""

  # Section 2: What Was Being Worked On
  local prompts_count
  prompts_count="$(printf '%s' "$data" | jq -r '.prompts | length // 0')"

  local responses_count
  responses_count="$(printf '%s' "$data" | jq -r '.responses | length // 0')"

  echo "## Conversation"
  echo ""
  if [[ "$prompts_count" -gt 0 || "$responses_count" -gt 0 ]]; then
    # Build interleaved conversation from prompts and responses sorted by sequence
    local conv
    conv="$(printf '%s' "$data" | jq -r '
      ([(.prompts // [])[] | {seq: .sequence, type: "user", text: .prompt}] +
       [(.responses // [])[] | {seq: .sequence, type: "assistant", text: .response}])
      | sort_by(.seq)[]
      | "\(.type)\t\(.text)"
    ')"
    if [[ -n "$conv" ]]; then
      while IFS=$'\t' read -r role text; do
        if [[ "$role" == "user" ]]; then
          echo "**User**: ${text}"
        else
          # Truncate long responses for display
          if [[ ${#text} -gt 300 ]]; then
            text="${text:0:300}..."
          fi
          echo "**Claude**: ${text}"
        fi
        echo ""
      done <<< "$conv"
    fi
  elif [[ -n "$last_prompt" && "$last_prompt" != "null" ]]; then
    echo "**User**: ${last_prompt}"
    echo ""
  else
    echo "No conversation recorded."
    echo ""
  fi

  # Section 3: Actions Taken (with progressive summarization)
  local actions_count
  actions_count="$(printf '%s' "$data" | jq -r '.actions | length // 0')"

  echo "## Actions Taken"
  echo ""
  if [[ "$actions_count" -gt 0 ]]; then
    _format_actions_markdown "$data" "$actions_count"
    echo ""
  else
    echo "No actions recorded."
    echo ""
  fi

  # Section 4: Files Modified
  local files_count
  files_count="$(printf '%s' "$data" | jq -r '.files_modified | length // 0')"

  echo "## Files Modified"
  echo ""
  if [[ "$files_count" -gt 0 ]]; then
    echo "| File | Operations | Last Action |"
    echo "|------|-----------|-------------|"
    local j=0
    while [[ $j -lt $files_count ]]; do
      local fmod
      fmod="$(printf '%s' "$data" | jq -r ".files_modified[$j]")"
      local fpath ops last_action
      fpath="$(printf '%s' "$fmod" | jq -r '.path // "unknown"')"
      ops="$(printf '%s' "$fmod" | jq -r '.operations // "unknown"')"
      last_action="$(printf '%s' "$fmod" | jq -r '.last_action // "unknown"')"
      echo "| \`${fpath}\` | ${ops} | ${last_action} |"
      j=$((j + 1))
    done
    echo ""
  else
    echo "No files modified."
    echo ""
  fi

  # Section 5: Key Decisions
  local decisions_count
  decisions_count="$(printf '%s' "$data" | jq -r '.decisions | length // 0')"

  echo "## Key Decisions"
  echo ""
  if [[ "$decisions_count" -gt 0 ]]; then
    local k=0
    while [[ $k -lt $decisions_count ]]; do
      local decision
      decision="$(printf '%s' "$data" | jq -r ".decisions[$k]")"
      echo "- ${decision}"
      k=$((k + 1))
    done
    echo ""
  else
    echo "No key decisions recorded."
    echo ""
  fi

  # Section 6: Where We Left Off
  echo "## Where We Left Off"
  echo ""
  local last_state
  last_state="$(printf '%s' "$data" | jq -r '.last_state // empty' 2>/dev/null)"
  if [[ -n "$last_state" && "$last_state" != "null" ]]; then
    echo "$last_state"
  else
    if [[ -n "$last_prompt" && "$last_prompt" != "null" ]]; then
      echo "Last active on: ${last_prompt}"
    else
      echo "Session ended without explicit state."
    fi
  fi
  echo ""

  # Degraded context warning
  local is_degraded
  is_degraded="$(printf '%s' "$json" | jq -r '._degraded // false')"
  if [[ "$is_degraded" == "true" ]]; then
    local error_msg
    error_msg="$(printf '%s' "$data" | jq -r '.error // ""')"
    echo "---"
    echo ""
    echo "*Note: ${error_msg}*"
    echo ""
  fi
}

# format_text(context_file_or_stdin)
#
# Plain text output with indentation and dashes, no markdown.
format_text() {
  local input="${1:-}"
  local json
  if [[ -n "$input" && -f "$input" ]]; then
    json="$(cat "$input")"
  else
    json="$(cat)"
  fi

  local data
  data="$(printf '%s' "$json" | jq '
    def is_system_prompt:
      (.prompt // "") as $p |
      (($p | startswith("<task-notification>")) and (($p | contains("</task-notification>")) or ($p | contains("<task-id>")))) or
      (($p | startswith("<task-id>")) and ($p | contains("</task-id>"))) or
      (($p | startswith("<output-file>")) and ($p | contains("</output-file>"))) or
      (($p | startswith("<system-reminder>")) and ($p | contains("</system-reminder>"))) or
      (($p | startswith("<command-name>")) and ($p | contains("</command-name>"))) or
      (($p | startswith("<command-message>")) and ($p | contains("</command-message>")));
    if .data then
      .data + {
        prompts: [(.data.prompts // [])[] | select(is_system_prompt | not)],
        responses: (.data.responses // [])
      }
    else {
      session_id: (._session_id // .session.id // "unknown"),
      project_id: (._project_id // "unknown"),
      started_at: (.session.started_at // "unknown"),
      last_event_at: (.session.ended_at // "unknown"),
      event_count: (.session.event_count // ._last_sequence // 0),
      last_prompt: ([(.prompts // [])[] | select(is_system_prompt | not)][-1].prompt // ""),
      prompts: [(.prompts // [])[] | select(is_system_prompt | not)],
      responses: (.responses // []),
      ended_at: (.session.ended_at // "in progress"),
      actions: [(.key_tool_calls // [])[] | {
        tool_name: .tool_name,
        target: .input_summary
      }],
      files_modified: [(.files_modified // [])[] | {
        path: .path
      }]
    }
    end
  ')"

  local session_id project_id started_at last_event_at event_count last_prompt ended_at

  session_id="$(printf '%s' "$data" | jq -r '.session_id // "unknown"')"
  project_id="$(printf '%s' "$data" | jq -r '.project_id // "unknown"')"
  started_at="$(printf '%s' "$data" | jq -r '.started_at // "unknown"')"
  last_event_at="$(printf '%s' "$data" | jq -r '.last_event_at // "unknown"')"
  event_count="$(printf '%s' "$data" | jq -r '.event_count // 0')"
  last_prompt="$(printf '%s' "$data" | jq -r '.last_prompt // ""')"
  ended_at="$(printf '%s' "$data" | jq -r '.ended_at // "in progress"')"

  echo "Session: ${session_id}"
  echo "Project: ${project_id}"
  echo "Started: ${started_at}"
  echo "Last Activity: ${last_event_at}"
  echo "Ended: ${ended_at}"
  echo "Events: ${event_count}"
  echo ""

  local prompts_count
  prompts_count="$(printf '%s' "$data" | jq -r '.prompts | length // 0')"

  local responses_count
  responses_count="$(printf '%s' "$data" | jq -r '.responses | length // 0')"

  if [[ "$prompts_count" -gt 0 || "$responses_count" -gt 0 ]]; then
    echo "Conversation:"
    local conv
    conv="$(printf '%s' "$data" | jq -r '
      ([(.prompts // [])[] | {seq: .sequence, type: "user", text: .prompt}] +
       [(.responses // [])[] | {seq: .sequence, type: "assistant", text: .response}])
      | sort_by(.seq)[]
      | "\(.type)\t\(.text)"
    ')"
    if [[ -n "$conv" ]]; then
      while IFS=$'\t' read -r role text; do
        if [[ "$role" == "user" ]]; then
          echo "  User: ${text}"
        else
          if [[ ${#text} -gt 300 ]]; then
            text="${text:0:300}..."
          fi
          echo "  Claude: ${text}"
        fi
      done <<< "$conv"
    fi
    echo ""
  elif [[ -n "$last_prompt" && "$last_prompt" != "null" ]]; then
    echo "Last Prompt:"
    echo "  ${last_prompt}"
    echo ""
  fi

  local actions_count
  actions_count="$(printf '%s' "$data" | jq -r '.actions | length // 0')"
  if [[ "$actions_count" -gt 0 ]]; then
    echo "Actions:"
    _format_actions_text "$data" "$actions_count"
    echo ""
  fi

  local files_count
  files_count="$(printf '%s' "$data" | jq -r '.files_modified | length // 0')"
  if [[ "$files_count" -gt 0 ]]; then
    echo "Files Modified:"
    local j=0
    while [[ $j -lt $files_count ]]; do
      local fpath
      fpath="$(printf '%s' "$data" | jq -r ".files_modified[$j].path // \"unknown\"")"
      echo "  - ${fpath}"
      j=$((j + 1))
    done
    echo ""
  fi
}

# format_compact(context_file_or_stdin)
#
# Single-line summary per session.
format_compact() {
  local input="${1:-}"
  local json
  if [[ -n "$input" && -f "$input" ]]; then
    json="$(cat "$input")"
  else
    json="$(cat)"
  fi

  local data
  data="$(printf '%s' "$json" | jq '
    if .data then .data
    else {
      session_id: (._session_id // .session.id // "unknown"),
      project_id: (._project_id // "unknown"),
      started_at: (.session.started_at // "unknown"),
      event_count: (.session.event_count // ._last_sequence // 0),
      last_prompt: ((.prompts // [])[-1].prompt // ""),
      files_modified: (.files_modified // [])
    }
    end
  ')"

  local session_id started_at project_id event_count last_prompt files_count

  session_id="$(printf '%s' "$data" | jq -r '.session_id // "unknown"')"
  started_at="$(printf '%s' "$data" | jq -r '.started_at // "unknown"')"
  project_id="$(printf '%s' "$data" | jq -r '.project_id // "unknown"')"
  event_count="$(printf '%s' "$data" | jq -r '.event_count // 0')"
  last_prompt="$(printf '%s' "$data" | jq -r '.last_prompt // ""')"
  files_count="$(printf '%s' "$data" | jq -r '.files_modified | length // 0')"

  # Truncate prompt to 60 chars
  if [[ ${#last_prompt} -gt 60 ]]; then
    last_prompt="${last_prompt:0:57}..."
  fi

  printf '%s | %s | %s | %s events | %s | %s files\n' \
    "$session_id" "$started_at" "$project_id" "$event_count" "$last_prompt" "$files_count"
}
