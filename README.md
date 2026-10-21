# dsh-mcp-expose

**Turn your DeepSeek Harness into an MCP server** — hand another agent (Codex, WorkBuddy,
Claude Code, Cursor, n8n, anything that speaks MCP) either the whole Harness or exactly
**one conversation you pick in the UI**.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin.
No extra process, no extra port, no bridge: it registers routes on the Harness Web
server and speaks **MCP Streamable HTTP** on the same origin as the GUI.

[![npm](https://img.shields.io/npm/v/dsh-mcp-expose)](https://www.npmjs.com/package/dsh-mcp-expose)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22.19-blue)

**English | [简体中文](./README.zh-CN.md)**

---

## Why

DeepSeek Harness already is a full agent runtime: model routing, shell, filesystem,
web, skills, subagents, MCP clients, sandbox and approval policy. If you also run
Codex or WorkBuddy, you end up with two agents that cannot see each other's work.

This plugin closes that gap in the smallest possible way:

- **Runtime endpoint** — `/mcp/dsh` exposes the whole Harness. The caller passes a
  `session_id` to continue an existing conversation or omits it to start a new one.
- **Session endpoints** — `/mcp/dsh/<sessionId>` exposes *one* session. It is a
  different MCP server per session, and there is no way to reach any other session
  through it. Use it when you want to give a client a narrowly scoped capability
  instead of the keys to the whole machine.

Both surfaces are the same code path an ordinary DSH session uses, so the delegated
agent gets your model, tools, workspace, sandbox mode and permission policy.

## Requirements

- DeepSeek Harness `0.2.x` (`@deepseek-ai/dsh`), desktop app or `dsh web`.
- Node.js `>= 22.19` (the version the Harness itself runs on).
- An MCP client that supports **Streamable HTTP** (sometimes called "HTTP" or
  "streamable" transport). stdio-only clients can bridge with `mcp-remote`.

## Install

```bash
# add it to the profile that should host it (the desktop app's profile is "desktop")
npx @deepseek-ai/dsh plugin --profile desktop add dsh-mcp-expose
```

Then restart the Harness (close the desktop app and reopen it, or restart `dsh web`).
The plugin registers its routes on startup, so a restart is what makes them live.

<details>
<summary><b>No npm registry? Install straight from GitHub</b></summary>

Installing by path works without any registry account, and is also how you work on
the plugin itself:

```bash
git clone https://github.com/wangpeng123-ux/dsh-mcp-expose.git
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-mcp-expose
```

`dsh` resolves plugin specs through npm/pnpm, so a GitHub spec usually works too:

```bash
npx @deepseek-ai/dsh plugin --profile desktop add github:wangpeng123-ux/dsh-mcp-expose
```

Or run it without touching any profile at all:

```bash
npx @deepseek-ai/dsh web --patch /path/to/dsh-mcp-expose/cordis.patch.yml
```

To update a clone-based install later: `git pull` in the checkout and restart.
</details>

### Verify

With the Harness running, open the URL it printed and go to
**Settings → Plugins → 「MCP 服务器」** (the "MCP server" tab). The page lists every
visible session, exports the ones you choose, and shows the endpoint each one gets.

Prefer curl? The same data comes from the control API:

```bash
curl http://127.0.0.1:57787/mcp/dsh/api
```

The port is whatever the Harness Web UI uses — take it from the URL the Harness
printed, or from the settings page.

## Use

### 1. Pick what to expose

| What you want | What to do | Endpoint |
|---|---|---|
| The whole Harness | nothing — it is on by default | `http://127.0.0.1:57787/mcp/dsh` |
| One specific conversation | Settings page → 「导出」, or the 「导出 MCP」 button in that session's header | `http://127.0.0.1:57787/mcp/dsh/<sessionId>` |

Exporting is instant and reversible: 「取消导出」 makes the URL answer `404`
immediately, without deleting the session or its transcript. Exports persist across
restarts in `~/.dsh/mcp-expose/exports.json`.

### 2. Connect an MCP client

**Codex** (`~/.codex/config.toml`) — whole Harness:

```toml
[mcp_servers.dsh]
url = "http://127.0.0.1:57787/mcp/dsh"
startup_timeout_sec = 30
tool_timeout_sec = 900
```

**Codex** — just one conversation:

```toml
[mcp_servers.dsh_web_project]
url = "http://127.0.0.1:57787/mcp/dsh/session-49def6c7-d76f-429c-8871-dfdea254a481"
tool_timeout_sec = 900
```

**Claude Code / any `mcp.json` client:**

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:57787/mcp/dsh"
    }
  }
}
```

**WorkBuddy / stdio-only clients** — bridge the same endpoint:

```bash
npx -y mcp-remote http://127.0.0.1:57787/mcp/dsh
```

If you configured a `token`, add `Authorization: Bearer <token>` (or `?token=<token>`);
the Codex equivalent is `bearer_token_env_var = "DSH_MCP_TOKEN"`.

### 3. Delegate

```
dsh_run  prompt="in this repo, add a CHANGELOG entry for 1.2.0 and run the tests"
dsh_run  prompt="what did we decide about the retry policy?"  session_id="session-49de…"
```

`dsh_run` blocks until the turn ends and returns the assistant's final answer. The
repository, shell and tools it uses are all inside your Harness workspace, so the
result is real work, not a suggestion.

## Tools

The **runtime endpoint** exposes seven tools:

| Tool | Arguments | Purpose |
|---|---|---|
| `dsh_run` | `prompt`, `session_id?`, `cwd?`, `timeout_ms?`, `provider?`, `model?` | Delegate one task; continue a session or start a new one. |
| `dsh_sessions` | `limit?` | List sessions, newest activity first. |
| `dsh_history` | `session_id`, `limit?`, `max_text_chars?` | Read a transcript: user prompts, answers, tool calls and results. |
| `dsh_tools` | `query?` | List the tools a delegated agent can call, from its preset scope. |
| `dsh_models` | — | Routable providers/models and the deployment default. |
| `dsh_cancel` | `session_id` | Cancel the running turn, keeping the history. |
| `dsh_status` | — | Endpoint, process, model, presets, capability and auth summary. |

A **session endpoint** exposes four:

| Tool | Arguments | Purpose |
|---|---|---|
| `dsh_run` | `prompt`, `timeout_ms?` | Always drives *that* session — there is no `session_id` parameter. |
| `dsh_history` | `limit?`, `max_text_chars?` | That session's transcript only. |
| `dsh_cancel` | — | Cancel that session's running turn. |
| `dsh_info` | — | Title, workspace, liveness and turn state of that session. |

Resources and prompts are advertised as empty; tools are the exposed surface.

## The plugin UI

The plugin ships a browser half (no build step, two slots):

- **Settings → Plugins → 「MCP 服务器」** — the full page: runtime endpoint with a copy
  button, the list of exported sessions with their URLs, and every visible session
  with a filter box and an 「导出」/「取消导出」 toggle.
- **Session header → 「导出 MCP」** — one-click export/revoke for the conversation
  you are reading, plus 「复制地址」 once it is exported. A green dot marks exported
  sessions.

Both talk to the same-origin control API below; the page never constructs MCP traffic
itself.

## Control API

Not MCP — a small JSON API for the UI (and for scripts). It follows the same auth rule
as the MCP routes.

```http
GET /mcp/dsh/api
```
```json
{
  "ok": true,
  "origin": "http://127.0.0.1:57787",
  "runtimeEndpoint": "http://127.0.0.1:57787/mcp/dsh",
  "auth": "loopback-only",
  "sessions": [
    {
      "session_id": "session-49def6c7-…",
      "title": "MCP plugin",
      "running": true,
      "live": true,
      "blank": false,
      "cwd": "C:\\Users\\me\\Documents\\project",
      "updatedAt": 1792407838229,
      "exported": false,
      "endpoint": "http://127.0.0.1:57787/mcp/dsh/session-49def6c7-…"
    }
  ]
}
```

```http
POST /mcp/dsh/api
{ "action": "export" | "revoke" | "refresh", "sessionId": "session-49def6c7-…" }
```
→ `{ "ok": true, "state": <same shape as GET> }`

`sessions[].endpoint` is always the URL that session *would* use, so you can write a
client config before exporting anything; `exported` says whether it currently answers.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `path` | `/mcp/dsh` | Base route on the Harness Web server. Session endpoints live under it. |
| `token` | `''` | Bearer token. Empty means **loopback callers only**. |
| `defaultCwd` | `''` | Working directory for new sessions; empty uses the Harness default directory. |
| `defaultPreset` | `''` | Agent preset for new sessions; empty uses the registry default (see `dsh_status`). |
| `maxPromptWaitMs` | `600000` | Default `dsh_run` budget when the caller sends no `timeout_ms`. |

Override them in your profile's `cordis.patch.yml` (usually
`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: dsh-mcp-expose
  config:
    token: 'your-long-random-token'
    defaultPreset: standard
```

The plugin ships no settings form, so this file is the configuration surface.

## How it works

```
MCP client (Codex / WorkBuddy / …)
   │  POST /mcp/dsh                      POST /mcp/dsh/<sessionId>
   ▼                                        ▼
dsh-mcp-expose  ── JSON-RPC over Streamable HTTP ──┐
   │  exports registry (~/.dsh/mcp-expose/exports.json)
   │                                               │
   └──────────────► ctx.agents / session log ◄─────┘
                        │
                        ▼
                 DSH agent loop → model, tools, sandbox, approvals
```

- One `exact` route (runtime), one `prefix` route (session endpoints), one `exact`
  route for the control API.
- The transport is **stateless**: no `Mcp-Session-Id`, notification-only POSTs answer
  `202`, `GET`/`DELETE` answer `405`, batches and request-scoped SSE are supported.
- `dsh_run` admits a real user message into the session log, waits for the turn to
  start, then waits for the agent to go idle (or for `timeout_ms`).

## Security

- **Loopback by default.** With no `token`, every route accepts only `127.0.0.1`,
  `::1` and `::ffff:127.0.0.1`, so a hostile page cannot reach it through DNS
  rebinding. Set `token` before exposing the Harness on a non-loopback interface.
- **The caller acts as you.** `dsh_run` can read and write files and run commands
  under your Harness permission policy. Point a client here only if you would give it
  the same access to a DSH terminal.
- **`dsh_run` cannot approve itself.** An approval prompt still goes to the Harness
  UI, exactly as for a human turn.
- **A session endpoint is a capability URL.** Anyone who can reach the route and knows
  the session id can continue that conversation. Revoke the export when you are done.

## Limitations

- Stateless transport: a client that insists on a server-initiated SSE session cannot
  use it (request-scoped SSE is fine).
- `dsh_run` waits for idleness, so a long turn can exceed a client-side tool timeout.
  Raise the client timeout or pass a smaller `timeout_ms`.
- No sampling, elicitation, resources or prompts.
- Session endpoints are single-session by construction. For a second conversation,
  export that session too — or use the runtime endpoint.

## License

[MIT](./LICENSE)
