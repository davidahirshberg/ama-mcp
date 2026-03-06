# Agent Manager MCP Server

Coordinates agents via shared state file + kitty kicks for notifications. All agents register at startup. Communication goes through the state file; kitty rings the doorbell so agents know to check.

Agents can be terminal Claude Code sessions (identified by kitty window ID) or headless processes like Todd (identified by name string).

## Tools

### register(manager?, session_id?, name?)

All agents call this at session start. Stores the agent in the registry with kitty window ID (from `$AGENT_WIN`), optional session ID / name, and working directory (`$PWD`). Preserves any friendly name assigned by the manager across re-registrations.

- `manager`: set true to register as manager (starts keepalive watcher)
- `session_id`: Claude session ID (for JSONL lookup)
- `name`: agent name (for headless agents without a kitty window)

### delegate(agent, description, message, after?, friendly_name?)

Assign a task to an agent. Writes task to state and kicks the agent via kitty so they know to check. Manager only.

- `agent`: Kitty window ID (number), agent name, or friendly name
- `description`: Short human-readable label (5-10 words)
- `message`: Full task message
- `after`: Optional. Task ID or array of IDs — task is blocked until all complete.
- `friendly_name`: Optional. Set a friendly name for the agent (same as `name_agent`).

Returns task ID. Use in `after` for dependent tasks.

### chat(message, to?)

Send a message to another agent's inbox. Writes to state and kicks the recipient via kitty.

- `message`: Message to send
- `to`: Optional. Agent ID or name. Omit to send to the manager.

### wait_for_task(timeout?)

Block until a task or message arrives for this agent. Polls the state file every 5s. Returns the task message or chat messages.

### wait_for_any(timeout?, interval?)

Block until any agent sends a message or a task status changes. Manager use. Default timeout 600s, interval 15s.

### task_list()

List all active tasks and registered agents. Call at session start.

### task_done(agent?)

Mark a task done. No args = mark own task. Marking another agent's task requires manager. Automatically unblocks dependent tasks and kicks them via kitty.

### task_check(win)

**Escape hatch.** Read an agent's kitty terminal window directly. For when an agent is stuck or unresponsive. If the window is gone, removes the agent from the registry.

### my_task()

Show own task, unread messages (reads them inline). Uses `$AGENT_WIN`.

### register_manager()

Alias for `register(manager=true)`.

### unregister_manager(to?)

Step down as manager. Manager only. Pass `to` to hand the role to a specific registered agent (they get kicked to let them know). Omit `to` to just vacate the slot.

### name_agent(agent, friendly_name)

Set or change a friendly name for an agent. Manager only. Names are for manager/human communication — agents don't need to know their names.

- `agent`: Agent identifier (kitty win, session ID, or current name)
- `friendly_name`: Human-readable name (e.g. "sims guy", "survival paper")

Names persist across agent re-registrations. All tools that accept an agent identifier also accept friendly names.

### respawn(agent, win?)

Resume a dead agent session. Manager only. Looks up the agent's session ID and working directory from the registry, finds an idle kitty tab, and runs `cd <cwd> && claude --resume <session_id>`.

- `agent`: Agent identifier or friendly name
- `win`: Optional. Kitty window to use. Omit to auto-find an idle tab (prefers the agent's old window if alive, then any idle tab not assigned to another agent).

Updates the agent's registry entry with the new kitty window.

### spawn(cwd?, win?)

Launch a fresh claude agent in a new kitty tab. Manager only. The new agent will call `register()` on startup per its CLAUDE.md guidance.

- `cwd`: Working directory. Defaults to home directory.
- `win`: Optional. Kitty window to use instead of creating a new tab.

Returns the window ID. Use `delegate(win, ...)` once the agent has registered.

## delegate vs chat

- **delegate**: "Do this work." Creates a tracked task, kicks the agent.
- **chat**: "Quick question" / "Here's context." Goes to inbox, kicks the agent.

If you'd want to know when it's done, use `delegate`.

## Agent Lifecycle

1. Agent starts, calls `register()` — added to agent registry
2. Manager calls `delegate(agent, ...)` — task written to state, agent kicked via kitty
3. Agent sees the kick, calls `wait_for_task()` or `my_task()` — gets the task
4. Agent works, uses `chat()` to report progress
5. Agent finishes, calls `task_done()`
6. Agent waits for next kick or calls `wait_for_task()` to poll

## Notification Model

The state file (`~/.claude/agent-tasks.json`) is the source of truth. Kitty is the doorbell:

- `delegate()` writes task → kicks agent via kitty
- `chat()` writes message → kicks recipient via kitty
- `task_done()` with unblocked deps → kicks each unblocked agent

**Kicks are 📬.** Every kick sends `ESC` (interrupts blocking calls like `wait_for_any`) then `📬` + Enter to the agent's kitty window. The 📬 appears as input text. No message content is sent through the terminal — the actual task or message lives in the state file.

**When you see 📬 as input, call `my_task()`.** This is the universal response. `my_task()` returns your current task and any unread messages.

Headless agents (no kitty window) must poll via `wait_for_task()`.

## Agent Registry

`state.agents` tracks all registered agents:

```json
{
  "id": 7,
  "kitty_win": 7,
  "session_id": "a0ff6112-...",
  "friendly_name": "sims guy",
  "cwd": "/Users/skip/work/bregman-lower-bound",
  "registered_at": "ISO timestamp",
  "is_manager": false
}
```

- `friendly_name`: Set by manager via `name_agent()` or `delegate(friendly_name=...)`. Persists across re-registrations.
- `cwd`: Captured automatically from `$PWD` at registration. Used by `respawn()` to cd before resuming.

Lazy cleanup: when any tool tries to interact with an agent's kitty window and it's gone, the agent is removed from the registry.

## Task Schema

```json
{
  "id": "w5-mmb2df6x",
  "agent": 5,
  "description": "Build survival paper",
  "message": "Full task text...",
  "status": "pending|blocked|working|idle|done",
  "acknowledged": true,
  "delegated_at": "ISO timestamp",
  "last_checked": "ISO timestamp",
  "completed_at": "ISO timestamp (only if done)",
  "blockedBy": ["w3-mmb2hblm"]
}
```

Status flow: `blocked` → `pending` → `working` (acknowledged) → `idle`/`done`

## Messages

```json
{
  "to": 2,
  "from": 5,
  "text": "Found the bug, it's in dispersion.R",
  "timestamp": "ISO timestamp",
  "read": false
}
```

## State File

`~/.claude/agent-tasks.json` — persists across sessions and compaction. Auto-prunes on save: done tasks older than 24h and read messages older than 1h are dropped. History lives in agent JONSLs.

## Keepalive Watcher

Auto-started by `register(manager=true)`. Polls every 45s, kicks the manager via kitty when agents need attention.

Log: `~/.claude/keepalive.log`
