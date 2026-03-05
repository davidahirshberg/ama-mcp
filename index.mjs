#!/usr/bin/env node
/**
 * Agent Manager MCP Server
 *
 * Coordinates agents via shared state file. Communication is MCP-native:
 * agents call wait_for_task() to receive work, chat() to send messages.
 * No kitty terminal scraping for normal communication.
 *
 * Tools:
 *   - delegate(agent, description, message)  assign task (manager only)
 *   - chat(message, to?)                     send message to another agent
 *   - wait_for_task(timeout?)                block until task/message arrives
 *   - wait_for_any(timeout?)                 block until any agent reports
 *   - task_list()                            show active tasks
 *   - task_done(agent)                       mark task complete
 *   - task_check(agent)                      read agent's kitty window (escape hatch)
 *   - my_task()                              show own task
 *   - register_manager()                     register as manager
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync, exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, 'bin');

const STATE_FILE = `${os.homedir()}/.claude/agent-tasks.json`;
const ME = process.env.AGENT_WIN ? parseInt(process.env.AGENT_WIN) : null;

// ---- State helpers ----

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { }
  }
  return { tasks: [], messages: [] };
}

function saveState(state) {
  if (!state.messages) state.messages = [];
  fs.mkdirSync(`${os.homedir()}/.claude`, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getTask(state, agent) {
  return state.tasks.find(t => t.agent === agent && t.status !== 'done');
}

function getTaskById(state, id) {
  return state.tasks.find(t => t.id === id);
}

function isBlocked(state, task) {
  if (!task.blockedBy || !task.blockedBy.length) return false;
  return task.blockedBy.some(depId => {
    const dep = getTaskById(state, depId);
    return dep && dep.status !== 'done';
  });
}

function unblockDependents(state, completedId) {
  const unblocked = [];
  for (const t of state.tasks) {
    if (t.status === 'blocked' && t.blockedBy) {
      if (!isBlocked(state, t)) {
        // All deps done — activate. Agent's wait_for_task() will pick it up.
        t.status = 'pending';
        unblocked.push(t);
      }
    }
  }
  return unblocked;
}

function now() {
  return new Date().toISOString();
}

function requireManager() {
  if (!ME) return 'Cannot identify caller — $AGENT_WIN not set.';
  const state = loadState();
  if (state.manager_win !== ME) return `Only the manager (win ${state.manager_win ?? 'unregistered'}) can do this. You are win ${ME}.`;
  return null;
}

// Resolve agent identifier — accepts number (kitty win ID) or string (agent name)
function resolveAgent(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && /^\d+$/.test(val)) return parseInt(val);
  return val; // string agent name (e.g. "todd")
}

// ---- Message helpers ----

function postMessage(state, to, from, text) {
  if (!state.messages) state.messages = [];
  state.messages.push({ to, from, text, timestamp: now(), read: false });
}

function getUnread(state, agent) {
  if (!state.messages) return [];
  return state.messages.filter(m => m.to === agent && !m.read);
}

function markRead(state, agent) {
  if (!state.messages) return;
  for (const m of state.messages) {
    if (m.to === agent && !m.read) m.read = true;
  }
}

// ---- Kitty helpers (escape hatch only) ----

function readWindow(win) {
  try {
    const out = execSync(`${BIN}/agent-read ${win}`, { encoding: 'utf8', timeout: 10000 });
    return { ok: true, text: out };
  } catch (e) {
    return { ok: false, error: e.message || 'failed to read window' };
  }
}

function isIdle(output) {
  const lines = output.split('\n').filter(l => l.trim());
  if (!lines.length) return false;
  if (lines.some(l => /esc to interrupt/.test(l))) return false;
  const chromePattern = /^[\s─━═\-]+$|^\s*(\?|esc |[0-9]+ bash|\u2193|Context left|Tip:)/;
  const filtered = lines.filter(l => !chromePattern.test(l));
  if (!filtered.length) return false;
  const last = filtered[filtered.length - 1];
  return /^[❯>]\s*$/.test(last);
}

function windowTail(output, n = 40) {
  return output.split('\n').slice(-n).join('\n');
}

// ---- MCP server ----

const server = new Server(
  { name: 'agent-manager', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'delegate',
      description: 'Assign a task to an agent. The agent receives it via wait_for_task(). Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: ['number', 'string'], description: 'Agent identifier — kitty window ID (number) or agent name (string, e.g. "todd")' },
          description: { type: 'string', description: 'Short human-readable description (5-10 words)' },
          message: { type: 'string', description: 'Full task message for the agent' },
          after: { description: 'Task ID or array of IDs — deferred until all complete.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        },
        required: ['agent', 'description', 'message'],
      },
    },
    {
      name: 'chat',
      description: 'Send a message to another agent (or the manager if "to" is omitted). Delivered via shared state — the recipient sees it on their next wait_for_task() or wait_for_any() call.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { description: 'Recipient agent ID or name. Omit to send to the manager.' },
          message: { type: 'string', description: 'Message to send' },
        },
        required: ['message'],
      },
    },
    {
      name: 'wait_for_task',
      description: 'Block until a task or message arrives for this agent. Call this when idle. Returns the task message or chat messages.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout: { type: 'number', description: 'Max seconds to wait (default 600)' },
        },
      },
    },
    {
      name: 'wait_for_any',
      description: 'Block until any agent reports (chat message to manager, task completion, or status change). Manager use.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout: { type: 'number', description: 'Max seconds to wait (default 600)' },
          interval: { type: 'number', description: 'Poll interval in seconds (default 15)' },
        },
      },
    },
    {
      name: 'task_list',
      description: 'List all active (non-done) tasks with status. Call at session start.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'task_done',
      description: 'Mark a task done. Call with no args to mark your own task done, or specify agent to mark another (manager only).',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: ['number', 'string'], description: 'Agent identifier. Omit to mark own task done.' },
        },
      },
    },
    {
      name: 'task_check',
      description: 'Read an agent\'s kitty terminal window (escape hatch for when agent is unresponsive). Returns window tail and status.',
      inputSchema: {
        type: 'object',
        properties: {
          win: { type: 'number', description: 'Kitty window ID' },
        },
        required: ['win'],
      },
    },
    {
      name: 'my_task',
      description: 'Show what task is assigned to this agent. Uses $AGENT_WIN to identify caller.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'register_manager',
      description: 'Register as manager. Auto-detects window from $AGENT_WIN. Starts keepalive watcher.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ---- delegate ----
  if (name === 'delegate') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const agent = resolveAgent(args.agent);
    const { description, message } = args;
    const afterRaw = args.after;
    const blockedBy = afterRaw ? (Array.isArray(afterRaw) ? afterRaw : [afterRaw]) : [];

    const state = loadState();

    const blocked = blockedBy.length > 0 && blockedBy.some(depId => {
      const dep = getTaskById(state, depId);
      return dep && dep.status !== 'done';
    });

    // Replace any existing non-done task for this agent
    state.tasks = state.tasks.filter(t => !(t.agent === agent && t.status !== 'done'));
    const taskId = `${typeof agent === 'string' ? agent : 'w' + agent}-${Date.now().toString(36)}`;
    const task = {
      id: taskId,
      agent,
      // Keep 'win' as alias for backward compat with task_check
      ...(typeof agent === 'number' ? { win: agent } : {}),
      description,
      message,
      delegated_at: now(),
      status: blocked ? 'blocked' : 'pending',
      last_checked: now(),
    };
    if (blocked) {
      task.blockedBy = blockedBy;
    } else if (blockedBy.length > 0) {
      task.blockedBy = blockedBy;
    }
    state.tasks.push(task);
    saveState(state);

    const pendingCount = state.tasks.filter(t => t.status === 'pending').length;
    const blockedCount = state.tasks.filter(t => t.status === 'blocked').length;
    const idleAgents = state.tasks.filter(t => t.status === 'idle').map(t => t.agent);
    let nudge = `${pendingCount} pending`;
    if (blockedCount > 0) nudge += `, ${blockedCount} blocked`;
    nudge += '.';
    if (idleAgents.length > 0) nudge += ` Idle agents: ${idleAgents.join(', ')}. Any tasks for them?`;
    if (pendingCount > 0) nudge += ' Call wait_for_any() to monitor.';
    const statusMsg = blocked ? `Queued (blocked by ${blockedBy.join(', ')})` : 'Delegated';
    return {
      content: [{
        type: 'text',
        text: `${statusMsg} to ${agent} [${taskId}]: ${description}\n${nudge}`,
      }],
    };
  }

  // ---- chat ----
  if (name === 'chat') {
    const { message } = args;
    let to = args.to != null ? resolveAgent(args.to) : null;
    if (to == null) {
      const state = loadState();
      to = state.manager_win;
      if (!to) return { content: [{ type: 'text', text: 'No recipient specified and no manager registered.' }], isError: true };
    }
    const from = ME || 'unknown';
    const state = loadState();
    postMessage(state, to, from, message);
    saveState(state);

    let warning = '';
    if (ME && state.manager_win === ME && message.length > 200) {
      warning = '\n\n⚠ Long message (>200 chars). If assigning work, use delegate() instead.';
    }

    return { content: [{ type: 'text', text: `Message queued for ${to}.${warning}` }] };
  }

  // ---- wait_for_task ----
  if (name === 'wait_for_task') {
    if (!ME) return { content: [{ type: 'text', text: '$AGENT_WIN not set.' }], isError: true };
    const timeoutMs = Math.min(args.timeout ?? 600, 600) * 1000;
    const intervalMs = 5000; // poll every 5s — state file is local, cheap to read
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const state = loadState();

      // Check for unread messages first
      const unread = getUnread(state, ME);
      if (unread.length > 0) {
        markRead(state, ME);
        saveState(state);
        const formatted = unread.map(m => `[from ${m.from}] ${m.text}`).join('\n\n');
        return { content: [{ type: 'text', text: `Messages received:\n\n${formatted}` }] };
      }

      // Check for a pending task assigned to me
      const task = state.tasks.find(t => t.agent === ME && t.status === 'pending' && !t.acknowledged);
      if (task) {
        task.acknowledged = true;
        task.status = 'working';
        task.last_checked = now();
        saveState(state);
        return {
          content: [{
            type: 'text',
            text: `Task assigned [${task.id}]: ${task.description}\n\n${task.message}\n\nUse chat() to report progress, results, or issues. Call task_done() or chat() when finished.`,
          }],
        };
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }

    return { content: [{ type: 'text', text: 'No task or message received (timeout). Call wait_for_task() again to keep waiting.' }] };
  }

  // ---- wait_for_any ----
  if (name === 'wait_for_any') {
    const timeoutMs = Math.min(args.timeout ?? 600, 600) * 1000;
    const intervalMs = Math.min(args.interval ?? 15, 120) * 1000;
    const deadline = Date.now() + timeoutMs;

    // Snapshot what we've already seen so we only report new things
    let lastState = loadState();
    const seenMessageCount = (lastState.messages || []).filter(m => m.to === ME).length;

    while (Date.now() < deadline) {
      const state = loadState();

      // Check for new messages to manager
      const myMessages = (state.messages || []).filter(m => m.to === ME);
      if (myMessages.length > seenMessageCount) {
        const newMsgs = myMessages.slice(seenMessageCount);
        // Mark them read
        for (const m of newMsgs) m.read = true;
        saveState(state);
        const formatted = newMsgs.map(m => `[from ${m.from}] ${m.text}`).join('\n\n');
        const pending = state.tasks.filter(t => t.status === 'pending' || t.status === 'working').length;
        const next = pending > 0
          ? `\n\n${pending} task(s) still active. Call wait_for_any() again.`
          : '\n\nNo active tasks.';
        return {
          content: [{
            type: 'text',
            text: `Incoming message(s):\n\n${formatted}${next}`,
          }],
        };
      }

      // Check for tasks that became idle (agent marked themselves done via state)
      const nowIdle = state.tasks.filter(t => t.status === 'idle');
      const wasIdle = lastState.tasks.filter(t => t.status === 'idle').map(t => t.id);
      const newlyIdle = nowIdle.filter(t => !wasIdle.includes(t.id));
      if (newlyIdle.length > 0) {
        const t = newlyIdle[0];
        const remaining = state.tasks.filter(tt => tt.status === 'pending' || tt.status === 'working').length;
        const next = remaining > 0
          ? `\n\n${remaining} task(s) still active. Call wait_for_any() again.`
          : '\n\nNo other active tasks.';
        return {
          content: [{
            type: 'text',
            text: `Agent ${t.agent} idle [${t.id}: ${t.description}]${next}`,
          }],
        };
      }

      // Check for blocked tasks that got unblocked
      const pendingNoAck = state.tasks.filter(t => t.status === 'pending' && !t.acknowledged);
      // These will be picked up by the agent's wait_for_task — nothing to report yet

      lastState = state;
      const wait = Math.min(intervalMs, deadline - Date.now());
      await new Promise(r => setTimeout(r, wait));
    }

    return { content: [{ type: 'text', text: 'Timeout. Call wait_for_any() again to keep monitoring.' }], isError: true };
  }

  // ---- task_list ----
  if (name === 'task_list') {
    const state = loadState();
    const active = state.tasks.filter(t => t.status !== 'done');
    if (!active.length) {
      return { content: [{ type: 'text', text: 'No active tasks.' }] };
    }

    const lines = active.map(t => {
      const age = Math.round((Date.now() - new Date(t.delegated_at)) / 60000);
      let status = t.status;
      if (t.status === 'blocked' && t.blockedBy) {
        status = `blocked by ${t.blockedBy.join(', ')}`;
      }
      if ((t.status === 'pending' || t.status === 'working') && age > 1440) {
        status += ` [stale — ${Math.round(age / 60)}h]`;
      }
      return `[${t.id}] ${t.agent} | ${status} | ${t.description} | ${age}m ago`;
    });

    const working = active.filter(t => t.status === 'working');
    const pending = active.filter(t => t.status === 'pending');
    const idle = active.filter(t => t.status === 'idle');
    const blocked = active.filter(t => t.status === 'blocked');

    // Check for unread messages
    const unread = ME ? getUnread(state, ME) : [];

    let nudge = '';
    if (unread.length > 0) nudge += `\n\n📬 ${unread.length} unread message(s). Check them.`;
    if (idle.length > 0) nudge += `\n\n${idle.length} idle — review and delegate or mark done.`;
    if (working.length > 0) nudge += `\n\n${working.length} working — call wait_for_any() to monitor.`;
    if (pending.length > 0) nudge += ` ${pending.length} pending (awaiting agent pickup).`;
    if (blocked.length > 0) nudge += ` ${blocked.length} blocked.`;
    return { content: [{ type: 'text', text: lines.join('\n') + nudge }] };
  }

  // ---- task_done ----
  if (name === 'task_done') {
    // Either the manager marks an agent done, or an agent marks itself done
    const agent = args.agent ? resolveAgent(args.agent) : ME;
    if (!agent) return { content: [{ type: 'text', text: 'No agent specified and $AGENT_WIN not set.' }], isError: true };

    // If calling for another agent, must be manager
    if (agent !== ME) {
      const guard = requireManager();
      if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    }

    const state = loadState();
    const task = getTask(state, agent);
    if (!task) {
      return { content: [{ type: 'text', text: `No active task for ${agent}.` }] };
    }
    task.status = 'done';
    task.completed_at = now();
    const unblocked = unblockDependents(state, task.id);
    saveState(state);

    const remaining = state.tasks.filter(t => t.status !== 'done').length;
    let msg = `Marked ${agent} task done: ${task.description}.`;
    if (unblocked.length > 0) {
      msg += `\nUnblocked: ${unblocked.map(t => `[${t.id}] ${t.agent}: ${t.description}`).join('; ')}`;
    }
    if (remaining > 0) {
      msg += ` ${remaining} task(s) remaining.`;
    } else {
      msg += ' All tasks complete.';
    }
    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- task_check (kitty escape hatch) ----
  if (name === 'task_check') {
    const win = args.win;
    const result = readWindow(win);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Cannot read win ${win}: ${result.error}` }], isError: true };
    }
    const idle = isIdle(result.text);

    const state = loadState();
    const task = state.tasks.find(t => (t.win === win || t.agent === win) && t.status !== 'done');
    if (task) {
      if (idle && task.status === 'working') task.status = 'idle';
      task.last_checked = now();
      saveState(state);
    }

    const statusStr = idle ? 'IDLE' : 'WORKING';
    let taskStr = ' [no recorded task]';
    if (task) {
      const age = Math.round((Date.now() - new Date(task.delegated_at)) / 60000);
      taskStr = ` [${task.id}: ${task.description} | ${age}m ago]`;
    }

    return {
      content: [{
        type: 'text',
        text: `win ${win} ${statusStr}${taskStr}:\n${windowTail(result.text)}`,
      }],
    };
  }

  // ---- my_task ----
  if (name === 'my_task') {
    if (!ME) return { content: [{ type: 'text', text: '$AGENT_WIN not set.' }], isError: true };
    const state = loadState();
    const task = getTask(state, ME);
    const unread = getUnread(state, ME);

    let text = '';
    if (task) {
      const age = Math.round((Date.now() - new Date(task.delegated_at)) / 60000);
      let depInfo = '';
      if (task.blockedBy && task.blockedBy.length > 0) {
        const depDetails = task.blockedBy.map(id => {
          const dep = getTaskById(state, id);
          return dep ? `${id} (${dep.description} — ${dep.status})` : `${id} (unknown)`;
        });
        depInfo = `\nBlocked by: ${depDetails.join(', ')}`;
      }
      text = `Your task [${task.id}]: ${task.description}\nStatus: ${task.status} | ${age}m ago${depInfo}`;
    } else {
      text = `No active task for win ${ME}.`;
    }

    if (unread.length > 0) {
      text += `\n\n📬 ${unread.length} unread message(s). Call wait_for_task() to read them.`;
    }

    return { content: [{ type: 'text', text }] };
  }

  // ---- register_manager ----
  if (name === 'register_manager') {
    if (!ME) {
      return { content: [{ type: 'text', text: '$AGENT_WIN not set. Launch claude with the alias.' }], isError: true };
    }
    const state = loadState();
    state.manager_win = ME;
    saveState(state);

    // Start keepalive if not already running
    try {
      execSync(`pgrep -f ${BIN}/agent-keepalive`, { encoding: 'utf8', timeout: 5000 });
    } catch {
      exec(`${BIN}/agent-keepalive`, { detached: true, stdio: 'ignore' }).unref();
    }

    return { content: [{ type: 'text', text: `Registered win ${ME} as manager. Keepalive watcher running.\n\nRead ~/.claude/reference/managing-agents.md before proceeding.` }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
