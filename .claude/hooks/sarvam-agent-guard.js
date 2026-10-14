// PreToolUse hook: keeps Sarvam MCP writes on the agent named by SARVAM_AGENT_ID in .env.
const fs = require('fs');
const path = require('path');

const PREFIX = 'mcp__sarvam-voice-agents__';
const AGENT_READ_OPS = new Set(['list', 'get', 'list_voices', 'list_templates', 'list_tool_kinds']);
const READ_ONLY_TOOLS = new Set(['analytics', 'boards', 'stream_cohort_users', 'export_board_widget', 'run_board_widget']);
const READ_OP_PATTERN = /^(list|get|search|describe|stream|count|export)/;

function loadAllowedAgentId() {
  const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const match = env.match(/^\s*SARVAM_AGENT_ID\s*=\s*(.+?)\s*$/m);
    return match ? match[1].replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    decide('deny', 'sarvam-agent-guard could not parse the hook input.');
  }

  const toolName = event.tool_name || '';
  if (!toolName.startsWith(PREFIX)) process.exit(0);

  const tool = toolName.slice(PREFIX.length);
  const input = event.tool_input || {};
  const operation = input.operation || '';

  if (READ_ONLY_TOOLS.has(tool)) process.exit(0);
  if (tool === 'agents' && AGENT_READ_OPS.has(operation)) process.exit(0);

  const allowed = loadAllowedAgentId();
  if (!allowed) {
    decide('deny', 'SARVAM_AGENT_ID is not set in .env, so Sarvam changes are blocked.');
  }

  if (tool === 'configure_agent' && (!input.agent_id || input.clone_from)) {
    decide('deny', `Creating or cloning agents is blocked. Only ${allowed} may be changed.`);
  }

  const targets = [input.agent_id, input.app_id];
  if (tool === 'agents') targets.push(input.id);
  for (const target of targets) {
    if (target !== undefined && target !== null && target !== allowed) {
      decide('deny', `Agent ${target} is not ${allowed}. Only ${allowed} may be changed.`);
    }
  }

  if (targets.includes(allowed)) process.exit(0);
  if (READ_OP_PATTERN.test(operation)) process.exit(0);

  decide('ask', `${tool} is a workspace-level Sarvam change not tied to ${allowed}. Confirm it does not affect other agents.`);
});
