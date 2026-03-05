# Agent Manager MCP Server

Coordinates agents via shared state file. Communication is MCP-native — agents receive work via `wait_for_task()` and send messages via `chat()`. No terminal scraping for normal communication.

Agents can be terminal Claude Code sessions (identified by kitty window ID) or headless processes like Todd (identified by name string).

## Tools

### delegate(agent, description, message, after?)

Assign a task to an agent. The agent receives it on their next `wait_for_task()` call. Manager only.

- `agent`: Kitty window ID (number) or agent name (string, e.g. "todd")
- `description`: Short human-readable label (5-10 words)
- `message`: Full task message
- `after`: Optional. Task ID or array of IDs — task is blocked until all complete.

Returns task ID. Use in `after` for dependent tasks.

### chat(message, to?)

Send a message to another agent's inbox. Delivered on their next `wait_for_task()` or `wait_for_any()`.

- `message`: Message to send
- `to`: Optional. Agent ID or name. Omit to send to the manager.

### wait_for_task(timeout?)

Block until a task or message arrives for this agent. **Call this when idle.** Returns the task message or chat messages. Polls the state file every 5s.

### wait_for_any(timeout?, interval?)

Block until any agent sends a message or a task status changes. Manager use. Default timeout 600s, interval 15s.

### task_list()

List all active tasks. Call at session start.

### task_done(agent?)

Mark a task done. Agents can mark their own task done; marking another agent's task requires manager. Automatically unblocks dependent tasks.

### task_check(win)

**Escape hatch.** Read an agent's kitty terminal window directly. For when an agent is stuck or unresponsive and you need to see what's on screen. Not needed for normal communication.

### my_task()

Show own task and unread message count. Uses `$AGENT_WIN`.

### register_manager()

Register as manager. Call at session start. Starts keepalive watcher.

## delegate vs chat

- **delegate**: "Do this work." Creates a tracked task, agent picks it up via `wait_for_task()`.
- **chat**: "Quick question" / "Here's context." Goes to inbox, no task created.

If you'd want to know when it's done, use `delegate`.

## Agent Lifecycle

1. Agent starts, calls `wait_for_task()` — blocks until work arrives
2. Manager calls `delegate(agent, ...)` — task written to state
3. Agent's `wait_for_task()` returns the task message
4. Agent works, uses `chat()` to report progress
5. Agent finishes, calls `task_done()` (or manager calls it after review)
6. Agent calls `wait_for_task()` again — ready for next task

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

`~/.claude/agent-tasks.json` — persists across sessions and compaction.

## Keepalive Watcher

Auto-started by `register_manager`. Polls every 45s, kicks the manager (via kitty, the one remaining kitty use) when agents need attention.

Log: `~/.claude/keepalive.log`
