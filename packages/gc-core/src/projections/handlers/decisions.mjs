// decisions.mjs -- Decisions projection handler.
// Groups events into decision groups starting at UserPromptReceived.
// Pairs tool calls with completions using tool_use_id.
import { CURRENT_PROJECTION_VERSION, register } from '../lib/registry.mjs';
import { generateInputSummary, generateOutputSummary } from '../lib/summary-generators.mjs';
import { truncate } from '../lib/utils.mjs';

const handler = {
  init(existing) {
    if (existing) {
      return {
        groups: existing.groups || [],
        currentGroup: null,
        pendingToolCalls: {},
        groupIdCounter: (existing.groups || []).length,
        stats: existing.stats || { total_groups: 0, total_actions: 0, failed_actions: 0 },
      };
    }
    return {
      groups: [],
      currentGroup: null,
      pendingToolCalls: {},
      groupIdCounter: 0,
      stats: { total_groups: 0, total_actions: 0, failed_actions: 0 },
    };
  },

  handle(state, event) {
    switch (event.event_type) {
      case 'UserPromptReceived': {
        // Close any open group
        if (state.currentGroup) {
          closeGroup(state);
        }
        // Start new group
        state.groupIdCounter++;
        const prompt = event.data?.prompt || event.data?.message || '';
        state.currentGroup = {
          group_id: state.groupIdCounter,
          user_prompt: {
            prompt,
            prompt_length: prompt.length,
            sequence: event.sequence,
            timestamp: event.timestamp,
          },
          actions: [],
          agents_spawned: [],
          all_succeeded: true,
          action_count: 0,
        };
        break;
      }

      case 'ToolCallRequested': {
        if (!state.currentGroup) break; // Before first prompt
        const data = event.data || {};
        const toolUseId = data.tool_use_id || `seq_${event.sequence}`;
        const inputSummary = generateInputSummary(data.tool_name, data.tool_input);

        const action = {
          tool_use_id: toolUseId,
          tool_name: data.tool_name || '?',
          input_summary: inputSummary,
          output_summary: '(no completion recorded)',
          success: null,
          request_sequence: event.sequence,
          completion_sequence: null,
          timestamp: event.timestamp,
        };

        state.currentGroup.actions.push(action);
        state.pendingToolCalls[toolUseId] = action;
        break;
      }

      case 'ToolCallCompleted': {
        const data = event.data || {};
        const toolUseId = data.tool_use_id;
        let action = toolUseId ? state.pendingToolCalls[toolUseId] : null;

        // Fallback: match by tool_name + sequence proximity
        if (!action && data.tool_name && state.currentGroup) {
          for (const a of state.currentGroup.actions) {
            if (a.tool_name === data.tool_name && a.success === null && !a.completion_sequence) {
              action = a;
              break;
            }
          }
        }

        if (action) {
          action.output_summary = generateOutputSummary(data.tool_name, data.tool_response || data.result, data);
          action.success = true;
          action.completion_sequence = event.sequence;
          if (toolUseId) delete state.pendingToolCalls[toolUseId];
        }
        break;
      }

      case 'ToolCallFailed': {
        const data = event.data || {};
        const toolUseId = data.tool_use_id;
        let action = toolUseId ? state.pendingToolCalls[toolUseId] : null;

        if (!action && data.tool_name && state.currentGroup) {
          for (const a of state.currentGroup.actions) {
            if (a.tool_name === data.tool_name && a.success === null && !a.completion_sequence) {
              action = a;
              break;
            }
          }
        }

        if (action) {
          action.output_summary = `FAILED: ${truncate(data.error || '', 150)}`;
          action.success = false;
          action.completion_sequence = event.sequence;
          if (toolUseId) delete state.pendingToolCalls[toolUseId];
        }
        break;
      }

      case 'TurnCompleted':
      case 'SessionEnded': {
        if (state.currentGroup) {
          closeGroup(state);
        }
        break;
      }

      case 'AgentSpawned': {
        if (state.currentGroup) {
          state.currentGroup.agents_spawned.push({
            agent_type: event.data?.agent_type || '?',
            description: event.data?.description || '',
            sequence: event.sequence,
            timestamp: event.timestamp,
          });
        }
        break;
      }

      case 'AgentCompleted': {
        if (state.currentGroup) {
          state.currentGroup.agents_spawned.push({
            agent_type: event.data?.agent_type || '?',
            status: event.data?.status || '?',
            sequence: event.sequence,
            timestamp: event.timestamp,
          });
        }
        break;
      }
    }

    return state;
  },

  finalize(state) {
    // Close any remaining open group
    if (state.currentGroup) {
      closeGroup(state);
    }

    // Compute stats
    let totalActions = 0;
    let failedActions = 0;
    for (const group of state.groups) {
      totalActions += group.action_count;
      for (const action of group.actions) {
        if (action.success === false) failedActions++;
      }
    }

    return {
      _projection_type: 'decisions',
      _projection_version: CURRENT_PROJECTION_VERSION,
      _rebuilt_at: new Date().toISOString(),
      _session_id: null,
      _last_sequence: 0, // set by caller
      group_count: state.groups.length,
      groups: state.groups,
      stats: {
        total_groups: state.groups.length,
        total_actions: totalActions,
        failed_actions: failedActions,
      },
    };
  },
};

function closeGroup(state) {
  const group = state.currentGroup;
  // Mark any remaining pending tool calls
  for (const action of group.actions) {
    if (action.success === null) {
      group.all_succeeded = false;
    }
  }
  // Check all_succeeded
  group.all_succeeded = group.actions.every(a => a.success === true);
  group.action_count = group.actions.length;
  state.groups.push(group);
  state.currentGroup = null;
  state.pendingToolCalls = {};
}

function formatJson(projection) {
  return JSON.stringify(projection, null, 2);
}

function formatText(projection) {
  const lines = [];
  lines.push(`Decisions: ${projection.group_count} groups, ${projection.stats.total_actions} actions`);
  lines.push('');
  for (const group of projection.groups) {
    lines.push(`--- Group ${group.group_id}: ${truncate(group.user_prompt.prompt, 80)} ---`);
    for (let i = 0; i < group.actions.length; i++) {
      const a = group.actions[i];
      const status = a.success === true ? '[OK]' : a.success === false ? '[FAIL]' : '[?]';
      lines.push(`  ${i + 1}. ${status} ${a.input_summary}`);
      if (a.output_summary) lines.push(`     -> ${a.output_summary}`);
    }
    if (group.agents_spawned.length > 0) {
      lines.push(`  Agents: ${group.agents_spawned.map(a => a.agent_type).join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatMarkdown(projection) {
  const lines = [];
  lines.push('# Decisions');
  lines.push('');
  lines.push(`**${projection.group_count} groups**, ${projection.stats.total_actions} actions, ${projection.stats.failed_actions} failed`);
  lines.push('');

  for (const group of projection.groups) {
    lines.push(`### Group ${group.group_id}`);
    lines.push('');
    lines.push(`> ${group.user_prompt.prompt}`);
    lines.push('');
    for (let i = 0; i < group.actions.length; i++) {
      const a = group.actions[i];
      const status = a.success === true ? 'OK' : a.success === false ? 'FAIL' : '?';
      lines.push(`${i + 1}. **[${status}]** ${a.input_summary}`);
      if (a.output_summary) lines.push(`   - ${a.output_summary}`);
    }
    if (group.agents_spawned.length > 0) {
      lines.push('');
      lines.push('**Agents:**');
      for (const a of group.agents_spawned) {
        lines.push(`- ${a.agent_type}: ${a.description || a.status || ''}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

register('decisions', {
  name: 'Decisions',
  description: 'Groups events into decision groups starting at each user prompt',
  version: CURRENT_PROJECTION_VERSION,
  outputFile: 'decisions.json',
  handler,
  formatters: { json: formatJson, text: formatText, markdown: formatMarkdown },
});

export { handler, formatJson, formatText, formatMarkdown };
