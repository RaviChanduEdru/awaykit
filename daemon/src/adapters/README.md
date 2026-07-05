# awaykit adapters — use (almost) any coding agent

awaykit's daemon speaks a neutral protocol — *a tool/command → an approve/deny
from your phone* — so each agent needs only a small **adapter**. The Claude Code
adapter is [`../hook.js`](../hook.js); the rest live here and all share
[`../agent-core.js`](../agent-core.js).

## Supported agents

| Agent | Approve / deny from phone | Notify | Adapter |
|---|---|---|---|
| **Claude Code** | ✅ | ✅ | [`../hook.js`](../hook.js) |
| **OpenAI Codex CLI** | ✅ | ✅ | `codex.js` |
| **Cursor CLI** | ✅ | ✅ (`stop`) | `cursor.js` |
| **Gemini CLI** | ✅ | ✅ | `gemini.js` |
| **OpenCode** | ✅ | ✅ (`session.idle`) | `opencode.js` (plugin) |
| **Aider** | ❌ notify only | ✅ | `aider-notify.js` |
| **anything else** | ✅ (wrap a command) | — | `awaykit-ask` (`ask.js`) |

Prereqs: the daemon running (`npm start`) and your phone paired. Replace
`/path/to/awaykit` with your clone path; on Windows use forward slashes. Every
adapter is **fail-safe**: if the daemon is down it emits no decision and the agent
uses its own normal flow.

## OpenAI Codex CLI
Codex hooks mirror Claude Code's. In `~/.codex/hooks.json`:
```json
{ "hooks": {
  "PreToolUse":    [ { "command": "node /path/to/awaykit/daemon/src/adapters/codex.js" } ],
  "Notification":  [ { "command": "node /path/to/awaykit/daemon/src/adapters/codex.js" } ]
} }
```

## Cursor CLI (`cursor-agent`)
In `~/.cursor/hooks.json`:
```json
{ "version": 1, "hooks": {
  "beforeShellExecution": [ { "command": "node /path/to/awaykit/daemon/src/adapters/cursor.js" } ]
} }
```
> Verify your `cursor-agent` version runs local command hooks before relying on it.

## Gemini CLI
In `~/.gemini/settings.json`:
```json
{ "hooks": {
  "BeforeTool":    [ { "hooks": [ { "type": "command", "command": "node /path/to/awaykit/daemon/src/adapters/gemini.js" } ] } ],
  "Notification":  [ { "hooks": [ { "type": "command", "command": "node /path/to/awaykit/daemon/src/adapters/gemini.js" } ] } ]
} }
```

## OpenCode
Copy `opencode.js` into your project's `.opencode/plugin/` (or add its path to the
`plugin` array in `opencode.json`). It's self-contained. `tool.execute.before`
gates every tool through your phone; `session.idle` buzzes it.

## Aider (notify only)
Aider has no pre-execution approval hook, so awaykit can't gate its commands — it
just buzzes you when a response is ready:
```
aider --notifications \
      --notifications-command "node /path/to/awaykit/daemon/src/adapters/aider-notify.js"
```
For approve/deny *with* Aider, gate risky commands yourself with `awaykit-ask`.

## awaykit-ask — the universal gate
Approve **any** command from your phone, from any script, CI step, or agent:
```bash
node /path/to/awaykit/daemon/src/adapters/ask.js "Deploy to prod?" && ./deploy.sh
```
Exit `0` = approved · `1` = denied (your note prints to stderr) · `2` = no phone
connected / daemon down (**fail-closed**, so a `&&` chain won't run unapproved).

## Write your own adapter (~30 lines)
An adapter maps your agent's event → awaykit → your agent's decision format, using
[`../agent-core.js`](../agent-core.js):

- `readStdinJSON()` — parse the agent's stdin event.
- `requestPermission({ tool, summary, detail, sessionId, cwd })` → `{ choice: "approve"|"deny"|null, note }`. **Blocks** until you answer on your phone.
- `requestStop({ sessionId, cwd, stopActive })` → `{ choice: "continue"|"stop"|null, note }` for a turn-end "what next?" card.
- `notify({ icon, text })` — buzz the phone's Activity feed.

Render `choice` into whatever your agent expects on stdout, and **fail safe**: on
any error or a `null` choice, emit nothing so the agent falls back to its normal
prompt. Copy [`codex.js`](codex.js) as a template. PRs for more agents welcome.
