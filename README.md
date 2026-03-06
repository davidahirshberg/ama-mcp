# ama-mcp

MCP server that coordinates multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions through a shared state file and [kitty](https://sw.kovidgoyal.net/kitty/) terminal notifications.

Agents register at startup. A manager delegates tasks, workers receive them via MCP tools, and kitty sends a nudge ("doorbell") so agents know to check. All message content flows through the state file — kitty never carries the actual message, just the notification.

## Requirements

- [kitty](https://sw.kovidgoyal.net/kitty/) terminal with `allow_remote_control socket-only` and `listen_on` configured
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 18+

### kitty config

```conf
# ~/.config/kitty/kitty.conf
allow_remote_control socket-only
listen_on unix:/tmp/kitty-sock-{kitty_pid}
```

### Shell alias

The `claude` alias passes the kitty window ID to the MCP server so it can identify which agent is calling:

```bash
alias claude="AGENT_WIN=$KITTY_WINDOW_ID command claude"
```

## Setup

```bash
npm install
```

Add to your Claude Code MCP config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "agent-manager": {
      "command": "node",
      "args": ["/path/to/ama-mcp/index.mjs"]
    }
  }
}
```

## Tools

### All agents

| Tool | Description |
|------|-------------|
| `register(manager?, session_id?, name?)` | Register this agent. All agents call at session start. |
| `chat(message, to?)` | Send a message + kick recipient. Omit `to` for manager. |
| `wait_for_task(timeout?)` | Block until a task or message arrives. |
| `my_task()` | Show own task and read unread messages. |
| `task_done(agent?)` | Mark own task done, or another's (manager only). |
| `task_list()` | List active tasks and registered agents. |

### Manager-only

| Tool | Description |
|------|-------------|
| `delegate(agent, description, message, after?, friendly_name?)` | Assign a tracked task + kick agent. |
| `wait_for_any(timeout?, interval?)` | Block until any agent reports. |
| `name_agent(agent, friendly_name)` | Set a friendly name for an agent (e.g. "sims guy"). |
| `spawn(cwd?, win?)` | Launch a fresh claude agent in a new kitty tab. |
| `respawn(agent, win?)` | Resume a dead agent session in an idle kitty tab. |
| `unregister_manager(to?)` | Step down or hand off manager role. |
| `task_check(win)` | Read agent's kitty terminal (escape hatch). |

## How it works

1. Open several kitty windows, each running `claude`.
2. Every agent calls `register()` at startup.
3. One agent calls `register(manager=true)` — becomes the manager, starts keepalive watcher.
4. Manager uses `delegate()` to assign tasks — state file records the task, kitty kicks the agent.
5. Agent sees the kick, calls `wait_for_task()` or `my_task()` to get the task.
6. Agent works, uses `chat()` to report back (kicks the manager).
7. Agent finishes, calls `task_done()`.

### Task dependencies

```
delegate(agent=3, description="analyze results", message="...", after="w5-m1abc")
```

Task stays blocked until `w5-m1abc` is done, then activates and kicks the agent.

### Notifications (📬)

Every kick sends `ESC` + `📬` + `Enter` to the agent's kitty window. The `ESC` interrupts blocking calls (`wait_for_any`, `wait_for_task`). The `📬` appears as user input — when the agent sees it, it calls `my_task()` to read actual messages from the state file. No message content ever goes through the terminal.

### Keepalive watcher

Background process (auto-started by `register(manager=true)`) polls every 45 seconds and kicks the manager when agents need attention. 5-minute cooldown between kicks.

## State

Task and message state persists in `~/.claude/agent-tasks.json`. Survives context compaction and session restarts. Agent registry tracks who's online and where to kick them.

## Configuration

Add this to your `CLAUDE.md` (global or per-project) so every agent knows how to participate:

```markdown
## Agent Manager

All sessions have the `agent-manager` MCP server. Call `register()` at session start. If you see **📬** as input, call `my_task()` — it means you have a new task or message.

If you're delegated a task but you're mid-work on something unrelated, push back via `chat()` — the manager can reassign.
```

### Manager reference (optional)

[`managing-agents.md`](managing-agents.md) has detailed guidance for the manager session — tool usage, behavioral guidelines, intervention patterns. Symlink it and reference from your `CLAUDE.md`:

```bash
ln -s /path/to/ama-mcp/managing-agents.md ~/.claude/reference/managing-agents.md
```

```markdown
- **managing-agents.md** — meta sessions, inter-agent communication, agent-manager MCP tools
```

## Provenance

This was written almost entirely by Claude (Opus), with human direction on design and behavior. The code, docs, and commit messages are AI-generated. The human has not read the code.

## License

MIT
