// context-snapshot.mjs -- Context snapshot projection handler.
// Builds full resumable state: session metadata, prompts, tool calls,
// files modified, agents, last state, compaction markers.
// Includes size-aware progressive summarization when output > 100KB.
import { CURRENT_PROJECTION_VERSION, register } from '../lib/registry.mjs';
import { generateInputSummary, generateOutputSummary } from '../lib/summary-generators.mjs';
import { truncate, formatDuration } from '../lib/utils.mjs';

const handler = {
  init(existing) {
    if (existing) {
      return {
        session: existing.session || { id: null, started_at: null, ended_at: null, model: null, project_directory: null, duration_seconds: null, event_count: 0 },
        prompts: existing.prompts || [],
        keyToolCalls: existing.key_tool_calls || [],
        filesModified: rebuildFilesModifiedMap(existing.files_modified || []),
        agents: existing.agents || [],
        pendingAgents: {},
        lastState: existing.last_state || { last_user_prompt: null, last_tool_call: null, last_tool_result: null, working_on: null },
        compactionMarkers: existing.compaction_markers || [],
        pendingToolCalls: {},
      };
    }
    return {
      session: { id: null, started_at: null, ended_at: null, model: null, project_directory: null, duration_seconds: null, event_count: 0 },
      prompts: [],
      keyToolCalls: [],
      filesModified: {},
      agents: [],
      pendingAgents: {},
      lastState: { last_user_prompt: null, last_tool_call: null, last_tool_result: null, working_on: null },
      compactionMarkers: [],
      pendingToolCalls: {},
    };
  },

  handle(state, event) {
    state.session.event_count++;
    const data = event.data || {};

    switch (event.event_type) {
      case 'SessionStarted': {
        state.session.id = event.session_id;
        state.session.started_at = event.timestamp;
        state.session.model = data.model || data.session?.model || null;
        state.session.project_directory = data.cwd || data.session?.cwd || null;
        break;
      }

      case 'SessionEnded': {
        state.session.ended_at = event.timestamp;
        if (state.session.started_at) {
          state.session.duration_seconds =
            (new Date(event.timestamp).getTime() - new Date(state.session.started_at).getTime()) / 1000;
        }
        break;
      }

      case 'UserPromptReceived': {
        const prompt = data.prompt || data.message || '';
        state.prompts.push({
          prompt,
          prompt_length: prompt.length,
          sequence: event.sequence,
          timestamp: event.timestamp,
        });
        state.lastState.last_user_prompt = truncate(prompt, 500);
        state.lastState.working_on = truncate(prompt, 200);
        break;
      }

      case 'ToolCallRequested': {
        const toolUseId = data.tool_use_id || `seq_${event.sequence}`;
        const inputSummary = generateInputSummary(data.tool_name, data.tool_input);

        const toolCall = {
          tool_use_id: toolUseId,
          tool_name: data.tool_name || '?',
          input_summary: inputSummary,
          output_summary: null,
          success: null,
          request_sequence: event.sequence,
          completion_sequence: null,
          timestamp: event.timestamp,
        };

        state.keyToolCalls.push(toolCall);
        state.pendingToolCalls[toolUseId] = toolCall;

        // Update lastState
        state.lastState.last_tool_call = inputSummary;

        // Track file modifications
        const input = data.tool_input || {};
        const name = (data.tool_name || '').toLowerCase();
        if (['write', 'edit'].includes(name) && input.file_path) {
          trackFileModified(state, input.file_path, name, event.timestamp);
        } else if (name === 'notebookedit' && input.notebook_path) {
          trackFileModified(state, input.notebook_path, 'edit', event.timestamp);
        } else if (name === 'read' && input.file_path) {
          trackFileModified(state, input.file_path, 'read', event.timestamp);
        }
        break;
      }

      case 'ToolCallCompleted': {
        const toolUseId = data.tool_use_id;
        let toolCall = toolUseId ? state.pendingToolCalls[toolUseId] : null;

        if (!toolCall && data.tool_name) {
          // Fallback: match by tool_name
          for (let i = state.keyToolCalls.length - 1; i >= 0; i--) {
            if (state.keyToolCalls[i].tool_name === data.tool_name && state.keyToolCalls[i].success === null) {
              toolCall = state.keyToolCalls[i];
              break;
            }
          }
        }

        if (toolCall) {
          const response = data.tool_response || data.result || '';
          const serializedSize = typeof response === 'string' ? response.length : JSON.stringify(response).length;

          if (serializedSize > 2048) {
            // Size-aware summarization
            toolCall.output_summary = summarizeLargeOutput(data.tool_name, response, data);
          } else {
            toolCall.output_summary = generateOutputSummary(data.tool_name, response, data);
          }
          toolCall.success = true;
          toolCall.completion_sequence = event.sequence;
          if (toolUseId) delete state.pendingToolCalls[toolUseId];
        }

        // Update lastState
        const response = data.tool_response || data.result || '';
        state.lastState.last_tool_result = truncate(
          typeof response === 'string' ? response : JSON.stringify(response),
          500
        );
        break;
      }

      case 'ToolCallFailed': {
        const toolUseId = data.tool_use_id;
        let toolCall = toolUseId ? state.pendingToolCalls[toolUseId] : null;

        if (!toolCall && data.tool_name) {
          for (let i = state.keyToolCalls.length - 1; i >= 0; i--) {
            if (state.keyToolCalls[i].tool_name === data.tool_name && state.keyToolCalls[i].success === null) {
              toolCall = state.keyToolCalls[i];
              break;
            }
          }
        }

        if (toolCall) {
          toolCall.output_summary = `FAILED: ${truncate(data.error || '', 150)}`;
          toolCall.success = false;
          toolCall.completion_sequence = event.sequence;
          if (toolUseId) delete state.pendingToolCalls[toolUseId];
        }

        state.lastState.last_tool_result = `FAILED: ${truncate(data.error || '', 200)}`;
        break;
      }

      case 'AgentSpawned': {
        const agentEntry = {
          agent_type: data.agent_type || '?',
          spawn_sequence: event.sequence,
          status: 'running',
          outcome_summary: null,
          timestamp: event.timestamp,
        };
        state.agents.push(agentEntry);
        state.pendingAgents[data.agent_type || event.sequence] = agentEntry;
        break;
      }

      case 'AgentCompleted': {
        const key = data.agent_type || '';
        const agent = state.pendingAgents[key];
        if (agent) {
          agent.status = data.status || 'completed';
          agent.outcome_summary = data.outcome_summary || data.result || null;
          delete state.pendingAgents[key];
        } else {
          state.agents.push({
            agent_type: data.agent_type || '?',
            spawn_sequence: null,
            status: data.status || 'completed',
            outcome_summary: data.outcome_summary || data.result || null,
            timestamp: event.timestamp,
          });
        }
        break;
      }

      case 'CompactionTriggered': {
        state.compactionMarkers.push({
          sequence: event.sequence,
          timestamp: event.timestamp,
          data: data,
        });
        break;
      }
    }

    return state;
  },

  finalize(state) {
    // Convert filesModified map to sorted array
    const filesModified = Object.entries(state.filesModified).map(([filePath, entry]) => ({
      path: filePath,
      operations: [...entry.operations],
      last_operation: entry.last_operation,
    }));
    filesModified.sort((a, b) => a.path.localeCompare(b.path));

    const projection = {
      _projection_type: 'context',
      _projection_version: CURRENT_PROJECTION_VERSION,
      _rebuilt_at: new Date().toISOString(),
      _session_id: state.session.id,
      _last_sequence: 0, // set by caller
      _size_bytes: 0,
      _summarization_applied: [],
      session: state.session,
      prompts: state.prompts,
      key_tool_calls: state.keyToolCalls,
      files_modified: filesModified,
      agents: state.agents,
      last_state: state.lastState,
      compaction_markers: state.compactionMarkers,
    };

    // Measure size
    const serialized = JSON.stringify(projection);
    projection._size_bytes = serialized.length;

    // Progressive summarization if > 100KB
    if (projection._size_bytes > 100 * 1024) {
      applyProgressiveSummarization(projection);
    }

    return projection;
  },
};

function trackFileModified(state, filePath, operation, timestamp) {
  if (!state.filesModified[filePath]) {
    state.filesModified[filePath] = {
      operations: new Set(),
      last_operation: operation,
    };
  }
  state.filesModified[filePath].operations.add(operation);
  state.filesModified[filePath].last_operation = operation;
}

function rebuildFilesModifiedMap(filesArray) {
  const map = {};
  for (const file of filesArray) {
    map[file.path] = {
      operations: new Set(file.operations || []),
      last_operation: file.last_operation,
    };
  }
  return map;
}

function summarizeLargeOutput(toolName, response, data) {
  const name = (toolName || '').toLowerCase();
  const text = typeof response === 'string' ? response : JSON.stringify(response);

  switch (name) {
    case 'read': {
      const lineCount = (text.match(/\n/g) || []).length + 1;
      const filePath = data?.tool_input?.file_path || data?.file_path || '?';
      return `Read ${lineCount} lines from ${filePath} (${text.length} bytes)`;
    }
    case 'bash': {
      return `Command output: ${truncate(text, 200)} (${text.length} chars total)`;
    }
    case 'grep': {
      const lines = text.split('\n').filter(l => l.trim());
      const files = new Set();
      for (const line of lines) {
        const m = line.match(/^(.+?):\d+:/);
        if (m) files.add(m[1]);
        else if (line.startsWith('/')) files.add(line.trim());
      }
      return `${lines.length} matches across ${files.size} files`;
    }
    case 'glob': {
      const count = text.split('\n').filter(l => l.trim()).length;
      return `${count} files matched`;
    }
    default:
      return `${truncate(text, 200)} (${text.length} chars total)`;
  }
}

function applyProgressiveSummarization(projection) {
  const phases = [];

  // Phase 1: Truncate output_summary to 100 chars for all but last 20 tool calls
  const toolCalls = projection.key_tool_calls;
  if (toolCalls.length > 20) {
    const cutoff = toolCalls.length - 20;
    for (let i = 0; i < cutoff; i++) {
      if (toolCalls[i].output_summary && toolCalls[i].output_summary.length > 100) {
        toolCalls[i].output_summary = truncate(toolCalls[i].output_summary, 100);
      }
    }
    phases.push('phase1_truncate_summaries');
  }

  let size = JSON.stringify(projection).length;
  projection._size_bytes = size;
  if (size <= 80 * 1024) {
    projection._summarization_applied = phases;
    return;
  }

  // Phase 2: Remove Read-only tool calls not in last 30
  if (toolCalls.length > 30) {
    const cutoff = toolCalls.length - 30;
    projection.key_tool_calls = toolCalls.filter((tc, i) => {
      if (i >= cutoff) return true;
      return tc.tool_name !== 'Read';
    });
    phases.push('phase2_remove_reads');
  }

  size = JSON.stringify(projection).length;
  projection._size_bytes = size;
  if (size <= 60 * 1024) {
    projection._summarization_applied = phases;
    return;
  }

  // Phase 3: Collapse consecutive Read calls
  const collapsed = [];
  let readRun = [];
  for (const tc of projection.key_tool_calls) {
    if (tc.tool_name === 'Read') {
      readRun.push(tc);
    } else {
      if (readRun.length > 1) {
        collapsed.push({
          ...readRun[0],
          output_summary: `Read ${readRun.length} files (collapsed)`,
          _collapsed_count: readRun.length,
        });
      } else if (readRun.length === 1) {
        collapsed.push(readRun[0]);
      }
      readRun = [];
      collapsed.push(tc);
    }
  }
  if (readRun.length > 1) {
    collapsed.push({
      ...readRun[0],
      output_summary: `Read ${readRun.length} files (collapsed)`,
      _collapsed_count: readRun.length,
    });
  } else if (readRun.length === 1) {
    collapsed.push(readRun[0]);
  }
  projection.key_tool_calls = collapsed;
  phases.push('phase3_collapse_reads');

  size = JSON.stringify(projection).length;
  projection._size_bytes = size;
  if (size <= 50 * 1024) {
    projection._summarization_applied = phases;
    return;
  }

  // Phase 4: Truncate user prompts (except last 3) to 500 chars
  if (projection.prompts.length > 3) {
    const cutoff = projection.prompts.length - 3;
    for (let i = 0; i < cutoff; i++) {
      if (projection.prompts[i].prompt.length > 500) {
        projection.prompts[i].prompt = truncate(projection.prompts[i].prompt, 500);
        projection.prompts[i].prompt_length = projection.prompts[i].prompt.length;
      }
    }
    phases.push('phase4_truncate_prompts');
  }

  size = JSON.stringify(projection).length;
  projection._size_bytes = size;
  projection._summarization_applied = phases;
}

function formatJson(projection) {
  return JSON.stringify(projection, null, 2);
}

function formatText(projection) {
  const lines = [];
  const s = projection.session;
  lines.push('Context Snapshot');
  lines.push('================');
  lines.push(`Session: ${s.id || '?'}`);
  lines.push(`Model: ${s.model || '?'}`);
  lines.push(`CWD: ${s.project_directory || '?'}`);
  lines.push(`Started: ${s.started_at || '?'}`);
  lines.push(`Ended: ${s.ended_at || '?'}`);
  lines.push(`Duration: ${s.duration_seconds != null ? formatDuration(s.duration_seconds) : '?'}`);
  lines.push(`Events: ${s.event_count}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Prompts
  lines.push('User Prompts:');
  for (const p of projection.prompts) {
    lines.push(`  [${p.sequence}] ${p.prompt}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Key Tool Calls
  lines.push('Key Tool Calls:');
  for (const tc of projection.key_tool_calls) {
    const status = tc.success === true ? 'OK' : tc.success === false ? 'FAIL' : '?';
    lines.push(`  [${tc.request_sequence}] [${status}] ${tc.input_summary}`);
    if (tc.output_summary) lines.push(`    -> ${tc.output_summary}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Files Modified
  lines.push('Files Modified:');
  for (const f of projection.files_modified) {
    lines.push(`  ${f.path} (${[...f.operations].join(', ')}) last: ${f.last_operation}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Last State
  lines.push('Last State:');
  const ls = projection.last_state;
  lines.push(`  Working on: ${ls.working_on || '(none)'}`);
  lines.push(`  Last prompt: ${ls.last_user_prompt || '(none)'}`);
  lines.push(`  Last tool call: ${ls.last_tool_call || '(none)'}`);
  lines.push(`  Last result: ${truncate(ls.last_tool_result || '(none)', 200)}`);

  return lines.join('\n');
}

function formatMarkdown(projection) {
  const lines = [];
  const s = projection.session;
  lines.push('# Context Snapshot');
  lines.push('');
  lines.push('## Session');
  lines.push('');
  lines.push(`- **ID**: ${s.id || '?'}`);
  lines.push(`- **Model**: ${s.model || '?'}`);
  lines.push(`- **Directory**: ${s.project_directory || '?'}`);
  lines.push(`- **Duration**: ${s.duration_seconds != null ? formatDuration(s.duration_seconds) : '?'}`);
  lines.push(`- **Events**: ${s.event_count}`);
  lines.push('');

  // Prompts
  lines.push('## User Prompts');
  lines.push('');
  for (const p of projection.prompts) {
    lines.push(`### Prompt ${p.sequence}`);
    lines.push('');
    lines.push(`> ${p.prompt}`);
    lines.push('');
  }

  // Tool Calls
  lines.push('## Key Tool Calls');
  lines.push('');
  for (const tc of projection.key_tool_calls) {
    const status = tc.success === true ? 'OK' : tc.success === false ? 'FAIL' : '?';
    lines.push(`- **[${status}]** \`${tc.input_summary}\``);
    if (tc.output_summary) lines.push(`  - ${tc.output_summary}`);
  }
  lines.push('');

  // Files
  lines.push('## Files Modified');
  lines.push('');
  for (const f of projection.files_modified) {
    lines.push(`- \`${f.path}\`: ${[...f.operations].join(', ')} (last: ${f.last_operation})`);
  }
  lines.push('');

  // Last State
  lines.push('## Last State');
  lines.push('');
  const ls = projection.last_state;
  lines.push(`- **Working on**: ${ls.working_on || '(none)'}`);
  lines.push(`- **Last prompt**: ${ls.last_user_prompt || '(none)'}`);
  lines.push(`- **Last tool call**: ${ls.last_tool_call || '(none)'}`);

  if (projection._summarization_applied.length > 0) {
    lines.push('');
    lines.push(`*Summarization applied: ${projection._summarization_applied.join(', ')}*`);
  }

  return lines.join('\n');
}

register('context', {
  name: 'Context Snapshot',
  description: 'Full resumable context snapshot for session recovery',
  version: CURRENT_PROJECTION_VERSION,
  outputFile: 'context.json',
  handler,
  formatters: { json: formatJson, text: formatText, markdown: formatMarkdown },
});

export { handler, formatJson, formatText, formatMarkdown };
