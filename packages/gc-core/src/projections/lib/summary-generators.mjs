// summary-generators.mjs -- Shared summary generation for tool inputs/outputs.
// Used by timeline, decisions, and context projections.
import { truncate } from './utils.mjs';

/**
 * Generate an input summary for a tool call request.
 */
export function generateInputSummary(toolName, toolInput) {
  if (!toolInput) return `${toolName}: (no input)`;

  const name = (toolName || '').toLowerCase();
  switch (name) {
    case 'read':
      return `Read file_path=${toolInput.file_path || '?'}`;
    case 'write':
      return `Write file_path=${toolInput.file_path || '?'} (${(toolInput.content || '').length} chars)`;
    case 'edit':
      return `Edit file_path=${toolInput.file_path || '?'}`;
    case 'notebookedit':
      return `NotebookEdit notebook_path=${toolInput.notebook_path || '?'}`;
    case 'bash':
      return `Bash: ${truncate(toolInput.command || '', 100)}`;
    case 'glob':
      return `Glob pattern=${toolInput.pattern || '?'} path=${toolInput.path || '.'}`;
    case 'grep':
      return `Grep pattern=${truncate(toolInput.pattern || '?', 50)} path=${toolInput.path || '.'}`;
    case 'webfetch':
      return `WebFetch url=${truncate(toolInput.url || '?', 80)}`;
    case 'websearch':
      return `WebSearch query=${truncate(toolInput.query || '?', 80)}`;
    case 'task':
      return `Task: ${truncate(toolInput.description || toolInput.prompt || '?', 100)}`;
    default:
      return `${toolName}: ${truncate(JSON.stringify(toolInput), 100)}`;
  }
}

/**
 * Generate an output summary for a tool call completion.
 */
export function generateOutputSummary(toolName, toolResponse, data) {
  const name = (toolName || '').toLowerCase();
  const response = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse || '');

  switch (name) {
    case 'read': {
      const lines = (response.match(/\n/g) || []).length + 1;
      return `Read ${lines} lines (${response.length} chars)`;
    }
    case 'write':
      return `Write completed`;
    case 'edit':
      return `Edit completed`;
    case 'bash': {
      const exitCode = data?.exit_code ?? data?.exitCode ?? '?';
      const stdout = data?.stdout || response;
      return `Bash exit=${exitCode}: ${truncate(stdout, 100)}`;
    }
    case 'glob': {
      const fileCount = response.split('\n').filter(l => l.trim()).length;
      return `Glob: ${fileCount} files matched`;
    }
    case 'grep': {
      const matchLines = response.split('\n').filter(l => l.trim());
      return `Grep: ${matchLines.length} results`;
    }
    default:
      return `${toolName}: ${truncate(response, 100)}`;
  }
}

/**
 * Generate a full event summary string.
 */
export function generateEventSummary(event) {
  const data = event.data || {};

  switch (event.event_type) {
    case 'SessionStarted': {
      const model = data.model || data.session?.model || '?';
      const cwd = data.cwd || data.session?.cwd || '?';
      return `Session started (model: ${model}, cwd: ${cwd})`;
    }
    case 'SessionEnded':
      return 'Session ended';
    case 'UserPromptReceived':
      return `User: ${truncate(data.prompt || data.message || '', 200)}`;
    case 'ToolCallRequested':
      return generateInputSummary(data.tool_name, data.tool_input);
    case 'ToolCallCompleted':
      return generateOutputSummary(data.tool_name, data.tool_response || data.result, data);
    case 'ToolCallFailed':
      return `FAILED ${data.tool_name || '?'}: ${truncate(data.error || '', 150)}`;
    case 'AgentSpawned':
      return `Spawned ${data.agent_type || '?'} agent: ${truncate(data.description || '', 100)}`;
    case 'AgentCompleted':
      return `Agent completed: ${data.agent_type || '?'} (status: ${data.status || '?'})`;
    case 'TurnCompleted':
      return 'Turn completed';
    case 'CompactionTriggered':
      return `COMPACTION triggered at sequence ${event.sequence}`;
    default:
      return `${event.event_type} at sequence ${event.sequence}`;
  }
}
