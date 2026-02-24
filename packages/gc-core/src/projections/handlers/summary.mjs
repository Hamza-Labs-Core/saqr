// summary.mjs -- Summary projection handler.
// Produces aggregate metrics and a mechanically generated narrative paragraph.
import { CURRENT_PROJECTION_VERSION, register } from '../lib/registry.mjs';
import { formatDuration } from '../lib/utils.mjs';

const handler = {
  init(existing) {
    if (existing) {
      return {
        sessionId: existing._session_id || null,
        startedAt: existing.started_at || null,
        endedAt: existing.ended_at || null,
        eventCount: existing.event_count || 0,
        eventBreakdown: existing.event_breakdown || {},
        toolsUsed: existing.tools_used || {},
        filesTouchedSet: new Set(existing._files_touched || []),
        filesModifiedSet: new Set(existing._files_modified || []),
        agentsSpawnedCount: existing.agents_spawned_count || 0,
        compactionCount: existing.compaction_count || 0,
        userPromptsCount: existing.user_prompts_count || 0,
        failedToolCalls: existing.failed_tool_calls || 0,
        firstPrompt: existing.first_prompt || null,
      };
    }
    return {
      sessionId: null,
      startedAt: null,
      endedAt: null,
      eventCount: 0,
      eventBreakdown: {},
      toolsUsed: {},
      filesTouchedSet: new Set(),
      filesModifiedSet: new Set(),
      agentsSpawnedCount: 0,
      compactionCount: 0,
      userPromptsCount: 0,
      failedToolCalls: 0,
      firstPrompt: null,
    };
  },

  handle(state, event) {
    state.eventCount++;
    if (!state.sessionId && event.session_id) state.sessionId = event.session_id;

    // Breakdown
    const etype = event.event_type;
    state.eventBreakdown[etype] = (state.eventBreakdown[etype] || 0) + 1;

    switch (etype) {
      case 'SessionStarted':
        state.startedAt = event.timestamp;
        break;

      case 'SessionEnded':
        state.endedAt = event.timestamp;
        break;

      case 'UserPromptReceived':
        state.userPromptsCount++;
        if (!state.firstPrompt) {
          state.firstPrompt = event.data?.prompt || event.data?.message || null;
        }
        break;

      case 'ToolCallRequested': {
        const toolName = event.data?.tool_name;
        if (toolName) {
          state.toolsUsed[toolName] = (state.toolsUsed[toolName] || 0) + 1;
        }
        // File tracking
        const input = event.data?.tool_input;
        if (input) {
          const name = (toolName || '').toLowerCase();
          if (name === 'read' && input.file_path) {
            state.filesTouchedSet.add(input.file_path);
          } else if (name === 'write' && input.file_path) {
            state.filesTouchedSet.add(input.file_path);
            state.filesModifiedSet.add(input.file_path);
          } else if (name === 'edit' && input.file_path) {
            state.filesTouchedSet.add(input.file_path);
            state.filesModifiedSet.add(input.file_path);
          } else if (name === 'notebookedit' && input.notebook_path) {
            state.filesTouchedSet.add(input.notebook_path);
            state.filesModifiedSet.add(input.notebook_path);
          }
        }
        break;
      }

      case 'ToolCallFailed':
        state.failedToolCalls++;
        break;

      case 'AgentSpawned':
        state.agentsSpawnedCount++;
        break;

      case 'CompactionTriggered':
        state.compactionCount++;
        break;
    }

    return state;
  },

  finalize(state) {
    // Compute duration
    let durationSeconds = null;
    let durationHuman = '0m';
    if (state.startedAt && state.endedAt) {
      durationSeconds = (new Date(state.endedAt).getTime() - new Date(state.startedAt).getTime()) / 1000;
      durationHuman = formatDuration(durationSeconds);
    }

    // Generate narrative
    const narrative = generateNarrative(state, durationHuman);

    // Total tool calls = sum of toolsUsed
    const totalToolCalls = Object.values(state.toolsUsed).reduce((a, b) => a + b, 0);

    return {
      _projection_type: 'summary',
      _projection_version: CURRENT_PROJECTION_VERSION,
      _rebuilt_at: new Date().toISOString(),
      _session_id: state.sessionId,
      _last_sequence: 0, // set by caller
      event_count: state.eventCount,
      event_breakdown: state.eventBreakdown,
      tools_used: state.toolsUsed,
      total_tool_calls: totalToolCalls,
      files_touched_count: state.filesTouchedSet.size,
      files_modified_count: state.filesModifiedSet.size,
      user_prompts_count: state.userPromptsCount,
      agents_spawned_count: state.agentsSpawnedCount,
      compaction_count: state.compactionCount,
      failed_tool_calls: state.failedToolCalls,
      started_at: state.startedAt,
      ended_at: state.endedAt,
      duration_seconds: durationSeconds,
      duration_human: durationHuman,
      first_prompt: state.firstPrompt,
      narrative,
      // Internal: for incremental rebuild
      _files_touched: [...state.filesTouchedSet],
      _files_modified: [...state.filesModifiedSet],
    };
  },
};

function generateNarrative(state, durationHuman) {
  if (state.eventCount === 0) {
    return 'This session contained no events.';
  }

  if (state.eventCount === 1 && state.eventBreakdown['SessionStarted']) {
    return 'This session was started but contained no further activity.';
  }

  const parts = [];

  // Opening
  if (state.startedAt) {
    parts.push(`This session lasted ${durationHuman || 'an unknown duration'}`);
  } else {
    parts.push('This session');
  }

  // Event count
  parts.push(` and processed ${state.eventCount} events`);

  // Tool calls
  const totalToolCalls = Object.values(state.toolsUsed).reduce((a, b) => a + b, 0);
  if (totalToolCalls > 0) {
    const toolNames = Object.keys(state.toolsUsed).join(', ');
    parts.push(`, including ${totalToolCalls} tool calls (${toolNames})`);
  }

  // Files
  if (state.filesTouchedSet.size > 0) {
    parts.push(`. ${state.filesTouchedSet.size} files were touched`);
    if (state.filesModifiedSet.size > 0) {
      parts.push(`, ${state.filesModifiedSet.size} modified`);
    }
  }

  // Failures
  if (state.failedToolCalls > 0) {
    parts.push(`. ${state.failedToolCalls} tool call${state.failedToolCalls > 1 ? 's' : ''} failed`);
  }

  // Agents
  if (state.agentsSpawnedCount > 0) {
    parts.push(`. ${state.agentsSpawnedCount} agent${state.agentsSpawnedCount > 1 ? 's were' : ' was'} spawned`);
  }

  // First prompt hint
  if (state.firstPrompt) {
    const hint = state.firstPrompt.length > 100 ? state.firstPrompt.slice(0, 100) + '...' : state.firstPrompt;
    parts.push(`. The session began with: "${hint}"`);
  }

  parts.push('.');
  return parts.join('');
}

function formatJson(projection) {
  return JSON.stringify(projection, null, 2);
}

function formatText(projection) {
  const lines = [];
  lines.push('Session Summary');
  lines.push('===============');
  lines.push(`Events: ${projection.event_count}`);
  lines.push(`Tool Calls: ${projection.total_tool_calls}`);
  lines.push(`Files Touched: ${projection.files_touched_count}`);
  lines.push(`Files Modified: ${projection.files_modified_count}`);
  lines.push(`User Prompts: ${projection.user_prompts_count}`);
  lines.push(`Failed Calls: ${projection.failed_tool_calls}`);
  lines.push(`Agents Spawned: ${projection.agents_spawned_count}`);
  lines.push(`Duration: ${projection.duration_human}`);
  lines.push('');
  lines.push('Event Breakdown:');
  for (const [type, count] of Object.entries(projection.event_breakdown)) {
    lines.push(`  ${type}: ${count}`);
  }
  lines.push('');
  lines.push('Tools Used:');
  for (const [name, count] of Object.entries(projection.tools_used)) {
    lines.push(`  ${name}: ${count}`);
  }
  lines.push('');
  lines.push('Narrative:');
  lines.push(projection.narrative);
  return lines.join('\n');
}

function formatMarkdown(projection) {
  const lines = [];
  lines.push('# Session Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Events | ${projection.event_count} |`);
  lines.push(`| Tool Calls | ${projection.total_tool_calls} |`);
  lines.push(`| Files Touched | ${projection.files_touched_count} |`);
  lines.push(`| Files Modified | ${projection.files_modified_count} |`);
  lines.push(`| User Prompts | ${projection.user_prompts_count} |`);
  lines.push(`| Failed Calls | ${projection.failed_tool_calls} |`);
  lines.push(`| Agents | ${projection.agents_spawned_count} |`);
  lines.push(`| Duration | ${projection.duration_human} |`);
  lines.push('');
  lines.push('## Narrative');
  lines.push('');
  lines.push(projection.narrative);
  return lines.join('\n');
}

register('summary', {
  name: 'Summary',
  description: 'Aggregate metrics and narrative paragraph for the session',
  version: CURRENT_PROJECTION_VERSION,
  outputFile: 'summary.json',
  handler,
  formatters: { json: formatJson, text: formatText, markdown: formatMarkdown },
});

export { handler, formatJson, formatText, formatMarkdown };
