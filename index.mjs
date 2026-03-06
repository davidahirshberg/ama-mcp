#!/usr/bin/env node
/**
 * Agent Manager MCP Server v3.0
 *
 * Coordinates agents via shared state file + kitty kicks for notifications.
 * All agents register at startup. Communication goes through the state file;
 * kitty sends a nudge so agents know to check.
 *
 * Tools:
 *   - register(manager?, session_id?)    register this agent (all agents call this)
 *   - delegate(agent, description, message)  assign task (manager only)
 *   - chat(message, to?)                 send message + kick recipient
 *   - wait_for_task(timeout?)            block until task/message arrives
 *   - task_list()                        show active tasks + registered agents
 *   - task_done(agent?)                  mark task complete
 *   - task_check(win)                    read agent's kitty window (escape hatch)
 *   - my_task()                          show own task + unread messages
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
const ME = process.env.AGENT_WIN ? parseInt(process.env.AGENT_WIN)
  : process.env.KITTY_WINDOW_ID ? parseInt(process.env.KITTY_WINDOW_ID)
  : null;

// ---- State helpers ----

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { }
  }
  return { tasks: [], messages: [], agents: [] };
}

function saveState(state) {
  if (!state.messages) state.messages = [];
  if (!state.agents) state.agents = [];

  // Prune: drop done tasks older than 24h, read messages older than 1h
  const now_ = Date.now();
  state.tasks = state.tasks.filter(t => {
    if (t.status !== 'done') return true;
    return (now_ - new Date(t.completed_at || t.delegated_at).getTime()) < 86400000;
  });
  state.messages = state.messages.filter(m => {
    if (!m.read) return true;
    return (now_ - new Date(m.timestamp).getTime()) < 3600000;
  });

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
  if (!ME) return 'Cannot identify caller — $KITTY_WINDOW_ID not set.';
  const state = loadState();
  if (state.manager !== ME) return `Only the manager (win ${state.manager ?? 'unregistered'}) can do this. You are win ${ME}.`;
  return null;
}

// Resolve agent identifier — accepts number (kitty win ID) or string (agent name)
function resolveAgent(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && /^\d+$/.test(val)) return parseInt(val);
  return val; // string agent name (e.g. "todd")
}

// ---- Agent registry ----

function getAgent(state, id) {
  if (!state.agents) return null;
  return state.agents.find(a => a.id === id || a.kitty_win === id || a.name === id || a.friendly_name === id);
}

function removeAgent(state, id) {
  if (!state.agents) return;
  state.agents = state.agents.filter(a => a.id !== id && a.kitty_win !== id && a.name !== id && a.friendly_name !== id);
}

function kittyWindowExists(win) {
  try {
    execSync(`${BIN}/agent-exists ${win}`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Lazy cleanup: check if agent's kitty window still exists. Remove if not.
function checkAgent(state, id) {
  const agent = getAgent(state, id);
  if (!agent) return false;
  if (agent.kitty_win) {
    if (!kittyWindowExists(agent.kitty_win)) {
      removeAgent(state, id);
      saveState(state);
      return false;
    }
  }
  return true;
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

// ---- Kitty helpers ----

function kickAgent(kittyWin) {
  try {
    execSync(`${BIN}/agent-kick ${kittyWin}`, {
      encoding: 'utf8', timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function readWindow(win) {
  try {
    const out = execSync(`${BIN}/agent-read ${win}`, { encoding: 'utf8', timeout: 10000 });
    return { ok: true, text: out };
  } catch (e) {
    return { ok: false, error: e.message || 'failed to read window' };
  }
}

function isIdle(win) {
  try {
    execSync(`${BIN}/agent-idle ${win}`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function windowTail(output, n = 40) {
  return output.split('\n').slice(-n).join('\n');
}

// Kick an agent via kitty if they have a window. Returns whether kick was sent.
function notifyAgent(state, agentId) {
  const agent = getAgent(state, agentId);
  if (!agent || !agent.kitty_win) return false;
  const sent = kickAgent(agent.kitty_win);
  if (!sent) {
    // Window gone — clean up
    removeAgent(state, agentId);
    saveState(state);
  }
  return sent;
}

// ---- MCP server ----

const server = new Server(
  { name: 'agent-manager', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'register',
      description: 'Register this agent. All agents call this at session start. Pass manager=true to register as manager.',
      inputSchema: {
        type: 'object',
        properties: {
          manager: { type: 'boolean', description: 'Register as manager (default false)' },
          session_id: { type: 'string', description: 'Claude session ID (for JSONL lookup)' },
          name: { type: 'string', description: 'Agent name (for headless agents without kitty window)' },
        },
      },
    },
    {
      name: 'delegate',
      description: 'Assign a task to an agent. Kicks the agent via kitty so they know to check. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: ['number', 'string'], description: 'Agent identifier — kitty window ID (number), agent name, or friendly name' },
          description: { type: 'string', description: 'Short human-readable description (5-10 words)' },
          message: { type: 'string', description: 'Full task message for the agent' },
          after: { description: 'Task ID or array of IDs — deferred until all complete.', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          friendly_name: { type: 'string', description: 'Set a friendly name for the agent (optional, same as name_agent)' },
        },
        required: ['agent', 'description', 'message'],
      },
    },
    {
      name: 'chat',
      description: 'Send a message to another agent (or the manager if "to" is omitted). Writes to state file and kicks recipient via kitty.',
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
      name: 'task_list',
      description: 'List all active (non-done) tasks and registered agents. Call at session start.',
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
      description: 'Show what task is assigned to this agent and any unread messages.',
      inputSchema: { type: 'object', properties: {} },
    },
    // Keep register_manager as alias for backward compat (keepalive watcher calls it)
    {
      name: 'register_manager',
      description: 'Register as manager. Alias for register(manager=true).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'unregister_manager',
      description: 'Step down as manager. Pass "to" to hand it to a specific agent. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: ['number', 'string'], description: 'Agent to pass manager role to. Omit to just vacate.' },
        },
      },
    },
    {
      name: 'name_agent',
      description: 'Set or change a friendly name for an agent. Manager only. Names are for manager/human communication — agents don\'t need to know their names.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: ['number', 'string'], description: 'Agent identifier (kitty win, session ID, or current name)' },
          friendly_name: { type: 'string', description: 'Friendly name (e.g. "sims guy", "survival paper")' },
        },
        required: ['agent', 'friendly_name'],
      },
    },
    {
      name: 'respawn',
      description: 'Resume a dead agent session. Finds an idle kitty tab (or the agent\'s old window), cd\'s to the agent\'s working directory, and runs claude --resume. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: ['number', 'string'], description: 'Agent identifier or friendly name' },
          win: { type: 'number', description: 'Kitty window to use. Omit to auto-find an idle tab.' },
        },
        required: ['agent'],
      },
    },
    {
      name: 'spawn',
      description: 'Launch a fresh claude agent in an idle kitty tab. The agent will register itself on startup. Manager only.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Working directory for the new agent. Defaults to home directory.' },
          win: { type: 'number', description: 'Kitty window to use. Omit to auto-find an idle tab.' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ---- register ----
  if (name === 'register' || name === 'register_manager') {
    const isManager = name === 'register_manager' || args.manager === true;
    const agentName = args.name || null;

    // Need either KITTY_WINDOW_ID or a name
    if (!ME && !agentName) {
      return { content: [{ type: 'text', text: '$KITTY_WINDOW_ID not set and no name provided. Set AGENT_WIN or pass name for headless agents.' }], isError: true };
    }

    const state = loadState();
    if (!state.agents) state.agents = [];

    const id = ME || agentName;

    // Guard: can't claim manager if someone else already is
    if (isManager && state.manager && state.manager !== id) {
      return { content: [{ type: 'text', text: `Manager already registered (${state.manager}). Only the current manager can re-register as manager.` }], isError: true };
    }

    // Upsert: preserve friendly_name from old entry, then remove
    const oldEntry = getAgent(state, id);
    const oldFriendlyName = oldEntry?.friendly_name;
    removeAgent(state, id);

    const entry = {
      id,
      registered_at: now(),
    };
    if (ME) entry.kitty_win = ME;
    if (agentName) entry.name = agentName;
    // Session ID: use explicit arg, or auto-detect from most recent JSONL
    if (args.session_id) {
      entry.session_id = args.session_id;
    } else {
      const cwd = process.env.PWD || '';
      const projectHash = cwd.replace(/\//g, '-') || '-';
      const projectDir = path.join(os.homedir(), '.claude', 'projects', projectHash);
      try {
        const jsonls = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (jsonls.length > 0) {
          entry.session_id = jsonls[0].name.replace('.jsonl', '');
        }
      } catch { /* project dir doesn't exist, skip */ }
    }
    if (oldFriendlyName) entry.friendly_name = oldFriendlyName;
    // Capture working directory for respawn
    if (process.env.PWD) entry.cwd = process.env.PWD;
    if (isManager) entry.is_manager = true;

    state.agents.push(entry);

    if (isManager) {
      state.manager = id;
      // Start keepalive if not already running
      try {
        execSync(`pgrep -f ${BIN}/agent-keepalive`, { encoding: 'utf8', timeout: 5000 });
      } catch {
        exec(`${BIN}/agent-keepalive`, { detached: true, stdio: 'ignore' }).unref();
      }
    }

    saveState(state);

    const agentCount = state.agents.length;
    let msg = `Registered ${id}${isManager ? ' as manager' : ''}. ${agentCount} agent(s) registered.`;

    const refPath = `${os.homedir()}/.claude/reference/managing-agents.md`;
    const repoRefPath = path.join(__dirname, 'managing-agents.md');
    const refExists = fs.existsSync(refPath);

    if (isManager) {
      msg += ' Keepalive watcher running.';
      msg += '\n\nWhen you see 📬 as input, call my_task() — it means an agent sent you a message or a task changed.';
      if (refExists) {
        msg += '\nRead ~/.claude/reference/managing-agents.md before proceeding.';
      } else {
        msg += `\n\n⚠ ~/.claude/reference/managing-agents.md not found. Symlink it:\n  ln -s ${repoRefPath} ${refPath}\n\nFor now, read ${path.join(__dirname, 'CLAUDE.md')} for tool reference.`;
      }
    } else {
      msg += '\n\nWhen you see 📬 as input, call my_task() — it means you have a new task or message.';
      if (refExists) {
        msg += '\nSee ~/.claude/reference/managing-agents.md for how to work with the manager.';
      } else {
        msg += `\nSee ${path.join(__dirname, 'CLAUDE.md')} for tool reference.`;
      }
    }

    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- unregister_manager ----
  if (name === 'unregister_manager') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const state = loadState();
    const oldAgent = getAgent(state, ME);
    if (oldAgent) delete oldAgent.is_manager;

    const to = args.to != null ? resolveAgent(args.to) : null;
    if (to) {
      const newManager = getAgent(state, to);
      if (!newManager) return { content: [{ type: 'text', text: `Agent ${to} not registered.` }], isError: true };
      newManager.is_manager = true;
      state.manager = to;
      saveState(state);
      notifyAgent(state, to);
      return { content: [{ type: 'text', text: `Passed manager to ${to}.` }] };
    }

    delete state.manager;
    saveState(state);
    return { content: [{ type: 'text', text: `Stepped down as manager. Manager slot is now open.` }] };
  }

  // ---- delegate ----
  if (name === 'delegate') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    let agent = resolveAgent(args.agent);
    const { description, message } = args;
    const afterRaw = args.after;
    const blockedBy = afterRaw ? (Array.isArray(afterRaw) ? afterRaw : [afterRaw]) : [];

    const state = loadState();

    // Resolve friendly name / name to canonical agent ID
    const agentEntry = getAgent(state, agent);
    if (agentEntry) agent = agentEntry.id;

    // Set friendly name if provided
    if (args.friendly_name) {
      if (agentEntry) agentEntry.friendly_name = args.friendly_name;
    }

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
      description,
      message,
      delegated_at: now(),
      status: blocked ? 'blocked' : 'pending',
      last_checked: now(),
    };
    if (blockedBy.length > 0) task.blockedBy = blockedBy;
    state.tasks.push(task);
    saveState(state);

    // Kick agent via kitty if not blocked
    let kicked = false;
    if (!blocked) {
      kicked = notifyAgent(state, agent);
    }

    const pendingCount = state.tasks.filter(t => t.status === 'pending').length;
    const blockedCount = state.tasks.filter(t => t.status === 'blocked').length;
    let nudge = `${pendingCount} pending`;
    if (blockedCount > 0) nudge += `, ${blockedCount} blocked`;
    nudge += '.';
    const statusMsg = blocked ? `Queued (blocked by ${blockedBy.join(', ')})` : 'Delegated';
    const kickMsg = kicked ? ' (kicked)' : (!blocked && getAgent(state, agent) ? ' (no kitty window — agent must poll)' : '');
    return {
      content: [{
        type: 'text',
        text: `${statusMsg} to ${agent} [${taskId}]: ${description}${kickMsg}\n${nudge}`,
      }],
    };
  }

  // ---- chat ----
  if (name === 'chat') {
    const { message } = args;
    let to = args.to != null ? resolveAgent(args.to) : null;
    const state = loadState();
    if (to == null) {
      to = state.manager;
      if (!to) return { content: [{ type: 'text', text: 'No recipient specified and no manager registered.' }], isError: true };
    } else {
      // Resolve friendly name to canonical ID
      const toEntry = getAgent(state, to);
      if (toEntry) to = toEntry.id;
    }
    const from = ME || 'unknown';
    postMessage(state, to, from, message);
    saveState(state);

    // Kick recipient
    const kicked = notifyAgent(state, to);

    let warning = '';
    if (ME && state.manager === ME && message.length > 200) {
      warning = '\n\n⚠ Long message (>200 chars). If assigning work, use delegate() instead.';
    }

    const kickMsg = kicked ? ' (kicked)' : '';
    return { content: [{ type: 'text', text: `Message queued for ${to}${kickMsg}.${warning}` }] };
  }

  // ---- wait_for_task ----
  if (name === 'wait_for_task') {
    if (!ME) return { content: [{ type: 'text', text: '$KITTY_WINDOW_ID not set.' }], isError: true };
    const timeoutMs = Math.min(args.timeout ?? 600, 600) * 1000;
    const intervalMs = 5000;
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
            text: `Task assigned [${task.id}]: ${task.description}\n\n${task.message}\n\nUse chat() to report progress, results, or issues. Call task_done() when finished.`,
          }],
        };
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }

    return { content: [{ type: 'text', text: 'No task or message received (timeout). Call wait_for_task() again to keep waiting.' }] };
  }

  // ---- task_list ----
  if (name === 'task_list') {
    const state = loadState();
    const active = state.tasks.filter(t => t.status !== 'done');
    const agents = state.agents || [];

    let text = '';

    // Show registered agents
    if (agents.length > 0) {
      const agentLines = agents.map(a => {
        let label = a.friendly_name ? `"${a.friendly_name}"` : `${a.id}`;
        if (a.name) label += ` (${a.name})`;
        if (a.friendly_name) label += ` [id:${a.id}]`;
        if (a.is_manager) label += ' [manager]';
        if (a.session_id) label += ` session:${a.session_id.slice(0, 8)}`;
        if (a.kitty_win) label += ` kitty:${a.kitty_win}`;
        return label;
      });
      text += `Agents: ${agentLines.join(', ')}\n\n`;
    }

    if (!active.length) {
      text += 'No active tasks.';
      return { content: [{ type: 'text', text }] };
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

    text += lines.join('\n');

    const working = active.filter(t => t.status === 'working');
    const pending = active.filter(t => t.status === 'pending');
    const idle = active.filter(t => t.status === 'idle');
    const blocked = active.filter(t => t.status === 'blocked');

    const unread = ME ? getUnread(state, ME) : [];

    let nudge = '';
    if (unread.length > 0) nudge += `\n\n📬 ${unread.length} unread message(s). Check them.`;
    if (idle.length > 0) nudge += `\n\n${idle.length} idle — review and delegate or mark done.`;
    if (working.length > 0) nudge += `\n\n${working.length} working.`;
    if (pending.length > 0) nudge += ` ${pending.length} pending (awaiting agent pickup).`;
    if (blocked.length > 0) nudge += ` ${blocked.length} blocked.`;
    return { content: [{ type: 'text', text: text + nudge }] };
  }

  // ---- task_done ----
  if (name === 'task_done') {
    const agent = args.agent ? resolveAgent(args.agent) : ME;
    if (!agent) return { content: [{ type: 'text', text: 'No agent specified and $KITTY_WINDOW_ID not set.' }], isError: true };

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

    // Kick newly unblocked agents
    for (const u of unblocked) {
      notifyAgent(state, u.agent);
    }

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
      // Window gone — clean up agent registry
      const state = loadState();
      const agent = getAgent(state, win);
      if (agent) {
        removeAgent(state, win);
        saveState(state);
      }
      return { content: [{ type: 'text', text: `Cannot read win ${win}: ${result.error}. Agent removed from registry.` }], isError: true };
    }
    const idle = isIdle(win);

    const state = loadState();
    const task = state.tasks.find(t => t.agent === win && t.status !== 'done');
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
    if (!ME) return { content: [{ type: 'text', text: '$KITTY_WINDOW_ID not set.' }], isError: true };
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
      text = `No active task for win ${ME}. If you were kicked, run task_list() to check on agents.`;
    }

    if (unread.length > 0) {
      // Read and return the messages inline
      markRead(state, ME);
      saveState(state);
      const formatted = unread.map(m => `[from ${m.from}] ${m.text}`).join('\n\n');
      text += `\n\n📬 Messages:\n\n${formatted}`;
    }

    return { content: [{ type: 'text', text }] };
  }

  // ---- name_agent ----
  if (name === 'name_agent') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const agentId = resolveAgent(args.agent);
    const friendlyName = args.friendly_name;
    const state = loadState();
    const agent = getAgent(state, agentId);
    if (!agent) return { content: [{ type: 'text', text: `Agent ${agentId} not registered.` }], isError: true };
    const oldName = agent.friendly_name;
    agent.friendly_name = friendlyName;
    saveState(state);
    const msg = oldName
      ? `Renamed ${agent.id}: "${oldName}" → "${friendlyName}"`
      : `Named ${agent.id}: "${friendlyName}"`;
    return { content: [{ type: 'text', text: msg }] };
  }

  // ---- respawn ----
  if (name === 'respawn') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };
    const agentId = resolveAgent(args.agent);
    const state = loadState();
    const agent = getAgent(state, agentId);
    if (!agent) return { content: [{ type: 'text', text: `Agent ${agentId} not found in registry.` }], isError: true };
    if (!agent.session_id) return { content: [{ type: 'text', text: `Agent ${agentId} has no session_id — can't resume.` }], isError: true };

    // Find a kitty window to use
    let targetWin = args.win || null;

    if (!targetWin && agent.kitty_win && kittyWindowExists(agent.kitty_win)) {
      // Old window still alive — use it
      targetWin = agent.kitty_win;
    }

    if (!targetWin) {
      // Find any idle kitty tab via agent-windows
      try {
        const windowsJson = execSync(`${BIN}/agent-windows`, { encoding: 'utf8', timeout: 5000 });
        const windows = JSON.parse(windowsJson);
        const registeredWins = new Set((state.agents || []).filter(a => a.kitty_win).map(a => a.kitty_win));
        if (ME) registeredWins.add(ME);

        for (const win of windows) {
          if (registeredWins.has(win.id)) continue;
          if (win.at_prompt) {
            targetWin = win.id;
            break;
          }
        }
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to enumerate windows: ${e.message}` }], isError: true };
      }
    }

    if (!targetWin) {
      return { content: [{ type: 'text', text: `No idle kitty tab found. Open a new terminal tab and try again, or pass win explicitly.` }], isError: true };
    }

    // Build the command: cd to cwd if available, then claude --resume
    const parts = [];
    if (agent.cwd) parts.push(`cd ${JSON.stringify(agent.cwd)}`);
    parts.push(`claude --resume ${agent.session_id}`);
    const cmd = parts.join(' && ');

    // Send the resume command directly via kitty (not agent-kick — we need to send actual text, not 📬)
    try {
      const sock = execSync(`ls -t /tmp/kitty-sock-* 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (!sock) throw new Error('no kitty socket found');
      const escaped = cmd.replace(/\\/g, '\\\\');
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" "${escaped}"`, { encoding: 'utf8', timeout: 10000 });
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" '\\r'`, { encoding: 'utf8', timeout: 10000 });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to send to kitty win ${targetWin}: ${e.message}` }], isError: true };
    }

    // Update registry: new kitty window
    agent.kitty_win = targetWin;
    saveState(state);

    const label = agent.friendly_name || agent.name || agent.id;
    return { content: [{ type: 'text', text: `Respawning "${label}" in win ${targetWin}: ${cmd}` }] };
  }

  // ---- spawn ----
  if (name === 'spawn') {
    const guard = requireManager();
    if (guard) return { content: [{ type: 'text', text: guard }], isError: true };

    const cwd = args.cwd || os.homedir();
    let targetWin = args.win || null;

    try {
      const sock = execSync(`ls -t /tmp/kitty-sock-* 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
      if (!sock) throw new Error('no kitty socket found');

      if (!targetWin) {
        // Launch a new tab, get the window ID back
        const winId = execSync(`kitty @ --to "unix:${sock}" launch --type=tab --cwd "${cwd}"`, { encoding: 'utf8', timeout: 10000 }).trim();
        targetWin = parseInt(winId, 10);
        if (isNaN(targetWin)) throw new Error(`kitty launch returned unexpected value: ${winId}`);
      }

      // Send claude command
      const cmd = `cd ${JSON.stringify(cwd)} && claude`;
      const escaped = cmd.replace(/\\/g, '\\\\');
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" "${escaped}"`, { encoding: 'utf8', timeout: 10000 });
      execSync(`kitty @ --to "unix:${sock}" send-text --match "id:${targetWin}" '\\r'`, { encoding: 'utf8', timeout: 10000 });
    } catch (e) {
      return { content: [{ type: 'text', text: `Failed to spawn: ${e.message}` }], isError: true };
    }

    return { content: [{ type: 'text', text: `Spawned new agent in win ${targetWin} (cwd: ${cwd}). It will register itself on startup. Use delegate(${targetWin}, ...) once it's registered.` }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
