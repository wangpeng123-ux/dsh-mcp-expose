# dsh-mcp-expose

**把 DeepSeek Harness 变成 MCP 服务器** —— 让别的 agent（Codex、WorkBuddy、Claude Code、
Cursor、n8n，任何会说 MCP 的客户端）调用你的 Harness：要么给它整个运行时，要么只给它
**你在界面上选中的那一个会话**。

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件。
不额外起进程、不占新端口、不需要中转程序：它直接在 Harness 的 Web 服务器上注册路由，
用 **MCP Streamable HTTP** 与 GUI 同源提供服务。

[English](./README.md) | **简体中文**

---

## 它解决什么问题

DeepSeek Harness 本身已经是一个完整的 agent 运行时：模型路由、shell、文件系统、联网、
技能、子 agent、MCP 客户端、沙箱与审批策略。如果你同时也在用 Codex 或 WorkBuddy，
就会有两个互相看不见对方工作的 agent。

这个插件用最小的方式把两边接起来：

- **运行时端点** —— `/mcp/dsh` 暴露整个 Harness。调用方传 `session_id` 就续跑已有会话，
  不传就新开一个。
- **会话端点** —— `/mcp/dsh/<sessionId>` 只暴露**一个**会话。每个会话就是一个独立的
  MCP 服务器，且无法通过它触达任何其它会话。当你只愿意给某个客户端一项窄能力、
  而不是整台机器的钥匙时，用它。

两条路走的是普通 DSH 会话完全相同的代码路径，所以被委托的 agent 拿到的仍是你的模型、
工具、工作目录、沙箱模式和权限策略。

## 环境要求

- DeepSeek Harness `0.2.x`（`@deepseek-ai/dsh`），桌面版或 `dsh web` 均可。
- Node.js `>= 22.19`（Harness 自身运行所需版本）。
- 支持 **Streamable HTTP** 传输的 MCP 客户端（有的客户端把它叫 HTTP / streamable）。
  只支持 stdio 的客户端可以用 `mcp-remote` 桥接。

## 安装

```bash
# 装进要承载它的 profile（桌面版默认是 desktop）
npx @deepseek-ai/dsh plugin --profile desktop add dsh-mcp-expose
```

然后重启 Harness（关掉桌面应用再打开，或重启 `dsh web`）。插件在启动时注册路由，
重启才会上线。

<details>
<summary><b>没有 npm 账号？直接从 GitHub 装</b></summary>

按本地路径安装不需要任何 registry 账号，也是改插件源码时的用法：

```bash
git clone https://github.com/wangpeng123-ux/dsh-mcp-expose.git
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-mcp-expose
```

`dsh` 底层用 npm/pnpm 解析插件 spec，所以 GitHub spec 通常也能直接用：

```bash
npx @deepseek-ai/dsh plugin --profile desktop add github:wangpeng123-ux/dsh-mcp-expose
```

或者完全不碰 profile，用 patch 方式跑：

```bash
npx @deepseek-ai/dsh web --patch /path/to/dsh-mcp-expose/cordis.patch.yml
```

以后更新：在 clone 目录里 `git pull`，然后重启 Harness。
</details>

### 验证

Harness 启动后，打开它打印出来的 URL，进入 **设置 → 插件 →「MCP 服务器」**。页面会列出
所有可见会话，勾选导出，并显示每个会话拿到的端点。

也可以直接 curl 同一个控制接口：

```bash
curl http://127.0.0.1:57787/mcp/dsh/api
```

端口就是 Harness Web UI 用的那个，以 Harness 打印的 URL 为准。

## 使用

### 1. 决定暴露什么

| 想要的效果 | 怎么做 | 端点 |
|---|---|---|
| 整个 Harness | 无需操作，默认就有 | `http://127.0.0.1:57787/mcp/dsh` |
| 某个指定会话 | 设置页点「导出」，或在会话标题栏点「导出 MCP」 | `http://127.0.0.1:57787/mcp/dsh/<sessionId>` |

导出是即时且可撤销的：点「取消导出」后该 URL 立刻返回 `404`，但不会删除会话，也不会丢历史。
导出记录会持久化在 `~/.dsh/mcp-expose/exports.json`，重启后仍在。

### 2. 接上 MCP 客户端

**Codex**（`~/.codex/config.toml`）—— 整个 Harness：

```toml
[mcp_servers.dsh]
url = "http://127.0.0.1:57787/mcp/dsh"
startup_timeout_sec = 30
tool_timeout_sec = 900
```

**Codex** —— 只接一个会话：

```toml
[mcp_servers.dsh_web_project]
url = "http://127.0.0.1:57787/mcp/dsh/session-49def6c7-d76f-429c-8871-dfdea254a481"
tool_timeout_sec = 900
```

**Claude Code / 任意 `mcp.json` 客户端：**

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

**WorkBuddy / 只支持 stdio 的客户端** —— 桥接同一个端点：

```bash
npx -y mcp-remote http://127.0.0.1:57787/mcp/dsh
```

如果你配置了 `token`，加上 `Authorization: Bearer <token>`（或 `?token=<token>`）；
Codex 的等价写法是 `bearer_token_env_var = "DSH_MCP_TOKEN"`。

### 3. 开始委托

```
dsh_run  prompt="在这个仓库里给 1.2.0 补一条 CHANGELOG 并跑测试"
dsh_run  prompt="我们之前对重试策略是怎么定的？"  session_id="session-49de…"
```

`dsh_run` 会阻塞到这一轮结束，返回助手的最终答复。它用的仓库、shell 和工具都在你的
Harness 工作区里，所以拿到的结果是真干完的活，不是建议。

## 工具清单

**运行时端点**暴露 7 个工具：

| 工具 | 参数 | 作用 |
|---|---|---|
| `dsh_run` | `prompt`、`session_id?`、`cwd?`、`timeout_ms?`、`provider?`、`model?` | 委托一个任务；续跑会话或新建会话。 |
| `dsh_sessions` | `limit?` | 列出会话，最近活动的在前。 |
| `dsh_history` | `session_id`、`limit?`、`max_text_chars?` | 读取会话记录：用户提问、助手回答、工具调用与结果。 |
| `dsh_tools` | `query?` | 列出被委托 agent 能调用的工具（按预设作用域）。 |
| `dsh_models` | — | 可路由的 provider/model 以及部署默认值。 |
| `dsh_cancel` | `session_id` | 取消正在跑的这一轮，保留历史。 |
| `dsh_status` | — | 端点、进程、模型、预设、能力与鉴权摘要。 |

**会话端点**暴露 4 个：

| 工具 | 参数 | 作用 |
|---|---|---|
| `dsh_run` | `prompt`、`timeout_ms?` | 永远驱动**该**会话，没有 `session_id` 参数。 |
| `dsh_history` | `limit?`、`max_text_chars?` | 只读该会话的记录。 |
| `dsh_cancel` | — | 取消该会话正在跑的这一轮。 |
| `dsh_info` | — | 该会话的标题、工作目录、活跃状态与轮次状态。 |

resources 与 prompts 均声明为空，能力面只有 tools。

## 插件界面

插件带一个浏览器半区（无需构建，挂在两个插槽上）：

- **设置 → 插件 →「MCP 服务器」** —— 完整页面：运行时端点及其复制按钮、已导出会话与其
  URL 列表、以及所有可见会话（带过滤框和「导出」/「取消导出」开关）。
- **会话标题栏 →「导出 MCP」** —— 对当前正在看的会话一键导出/取消，导出后多一个
  「复制地址」。已导出的会话会显示一个绿点。

两者都只调用下面的同源控制接口，页面自己不发 MCP 流量。

## 控制接口

这不是 MCP，而是给界面（和脚本）用的小 JSON 接口，鉴权规则与 MCP 路由一致。

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
      "title": "MCP 插件",
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
→ `{ "ok": true, "state": <与 GET 相同的结构> }`

`sessions[].endpoint` 始终是该会话**将会**使用的 URL，所以你可以先写好客户端配置再导出；
`exported` 表示它当前是否真的可用。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `/mcp/dsh` | Harness Web 服务器上的基础路由，会话端点挂在它下面。 |
| `token` | `''` | Bearer token。留空表示**只允许本机回环访问**。 |
| `defaultCwd` | `''` | 新会话的工作目录；留空用 Harness 默认目录。 |
| `defaultPreset` | `''` | 新会话的 agent 预设；留空用注册表默认值（见 `dsh_status`）。 |
| `maxPromptWaitMs` | `600000` | 调用方没给 `timeout_ms` 时 `dsh_run` 的默认预算。 |

在你的 profile 的 `cordis.patch.yml`（通常是 `~/.dsh/profiles/<profile>/cordis.patch.yml`）
里覆盖：

```yaml
- id: dsh-mcp-expose
  config:
    token: '一串足够长的随机字符'
    defaultPreset: standard
```

插件没有提供设置表单，所以这个文件就是配置入口。

## 实现要点

```
MCP 客户端（Codex / WorkBuddy / …）
   │  POST /mcp/dsh                      POST /mcp/dsh/<sessionId>
   ▼                                        ▼
dsh-mcp-expose  ── JSON-RPC over Streamable HTTP ──┐
   │  导出登记表（~/.dsh/mcp-expose/exports.json）
   │                                               │
   └──────────────► ctx.agents / 会话日志 ◄────────┘
                        │
                        ▼
                 DSH agent loop → 模型、工具、沙箱、审批
```

- 一条 `exact` 路由（运行时端点）、一条 `prefix` 路由（会话端点）、一条 `exact` 路由
  （控制接口）。
- 传输是**无状态**的：不发 `Mcp-Session-Id`，纯通知 POST 返回 `202`，`GET`/`DELETE`
  返回 `405`，支持批量请求与请求级 SSE。
- `dsh_run` 会向会话日志写入一条真实的用户消息，等这一轮开始，再等 agent 空闲
  （或直到 `timeout_ms` 用尽）。

## 安全

- **默认只允许回环。** 没配 `token` 时，所有路由只接受 `127.0.0.1`、`::1`、
  `::ffff:127.0.0.1`，恶意网页无法通过 DNS rebinding 打进来。要在非回环地址上暴露
  Harness 之前，请先设置 `token`。
- **调用方等同于你本人。** `dsh_run` 能读写文件、执行命令，全部受你的 Harness 权限策略
  约束。只有当你能接受对方拥有一个 DSH 终端的同等权限时，才把客户端接过来。
- **`dsh_run` 无法自己批准自己。** 需要审批时，提示照旧弹到 Harness 界面。
- **会话端点就是一个能力 URL。** 任何能访问该路由、又知道会话 id 的人，都能续跑那段对话。
  用完记得取消导出。

## 局限

- 无状态传输：坚持要服务端主动 SSE 会话的客户端用不了（请求级 SSE 没问题）。
- `dsh_run` 要等到空闲，长任务可能超过客户端工具超时。请调大客户端超时，或传更小的
  `timeout_ms`。
- 不支持 sampling、elicitation、resources、prompts。
- 会话端点在构造上就是单会话的。要第二段对话，把那个会话也导出 —— 或者用运行时端点。

## 许可证

[MIT](./LICENSE)
