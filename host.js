/**
 * dsh-mcp-expose — expose this DeepSeek Harness runtime as an MCP server.
 *
 * Two kinds of endpoint are served from one plugin:
 *
 *  - The runtime endpoint (`config.path`, default `/mcp/dsh`): the whole Harness —
 *    pick or create a session per call.
 *  - Exported session endpoints (`/mcp/dsh/<sessionId>`): one session's interface,
 *    created from the Web UI. There is no way to address another session through
 *    that endpoint.
 *
 * Both speak MCP Streamable HTTP. The transport is stateless: no `Mcp-Session-Id`
 * is issued, notification-only POSTs answer 202, and GET/DELETE answer 405 because
 * no server-initiated SSE stream is opened.
 */

import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

export const name = 'dsh-mcp-expose'

/** The routes need the HTTP carrier; every run needs the Agent registry. */
export const inject = ['webServer', 'agents']

const SERVER_NAME = 'deepseek-harness'
const SERVER_VERSION = '1.2.0'
const PACKAGE_NAME = 'dsh-mcp-expose'
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const PREFERRED_PROTOCOL = '2025-06-18'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_TOOL_RESULT_CHARS = 400_000
const TURN_START_TIMEOUT_MS = 60_000

const DEFAULTS = {
  path: '/mcp/dsh',
  token: '',
  defaultCwd: '',
  defaultPreset: '',
  maxPromptWaitMs: 600_000,
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  if (typeof config.path !== 'string' || !config.path.startsWith('/')) {
    throw new Error('dsh-mcp-expose: config.path must be an absolute route path such as /mcp/dsh')
  }
  const basePath = config.path.replace(/\/+$/, '')
  const exports = createExportStore()

  ctx.effect(
    () => {
      const disposers = [
        // The runtime endpoint: whole-Harness MCP surface.
        ctx.webServer.register({
          kind: 'exact',
          path: basePath,
          handler: (req, res) => {
            guard(ctx, () =>
              serveMcp(ctx, config, null, req, res),
            )
          },
        }),
        // Exported session endpoints: `/mcp/dsh/<sessionId>`.
        // The prefix must be the bare base path: the carrier matches a prefix `p`
        // only when the pathname is exactly `p` or starts with `${p}/`, so a
        // trailing slash here would never match.
        ctx.webServer.register({
          kind: 'prefix',
          path: basePath,
          handler: (req, res) => {
            guard(ctx, async () => {
              const sessionId = sessionIdOf(config, req.url)
              if (sessionId === undefined) {
                writeJson(res, 404, rpcError(null, -32000, 'no such exported session endpoint'))
                return
              }
              if (!exports.has(sessionId)) {
                writeJson(
                  res,
                  404,
                  rpcError(null, -32000, `session "${sessionId}" is not exported; export it in the MCP Server page`),
                )
                return
              }
              await serveMcp(ctx, config, sessionId, req, res)
            })
          },
        }),
        // Same-origin control API for the Web UI (and anything else local).
        ctx.webServer.register({
          kind: 'exact',
          path: `${basePath}/api`,
          handler: (req, res) => {
            guard(ctx, () => serveApi(ctx, config, exports, req, res))
          },
        }),
      ]
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    },
    'dsh-mcp-expose.routes',
  )

  // Load persisted exports once; a failure leaves an empty registry, never a failed start.
  exports.ready = exports.load().catch(() => undefined)

  ctx.logger.info(
    `dsh-mcp-expose: MCP endpoints serving at ${basePath} and ${basePath}/<sessionId> ` +
      `(${config.token ? 'bearer token required' : 'loopback callers only'})`,
  )
}

/**
 * Run one route body, containing any async failure to a log line so a rejected
 * request never escapes as an unhandled rejection.
 */
function guard(ctx, start) {
  try {
    const result = start()
    if (result !== undefined && result !== null && typeof result.then === 'function') {
      result.catch((error) => {
        ctx.logger.warn(`dsh-mcp-expose: request failed: ${String(error)}`)
      })
    }
  } catch (error) {
    ctx.logger.warn(`dsh-mcp-expose: request failed: ${String(error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* exported-session registry                                           */
/* ------------------------------------------------------------------ */

function exportStorePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'mcp-expose', 'exports.json')
}

function createExportStore() {
  const file = exportStorePath()
  const entries = new Map()
  const api = {
    ready: Promise.resolve(),
    has: (sessionId) => entries.has(sessionId),
    list: () =>
      [...entries.entries()]
        .map(([sessionId, value]) => ({ sessionId, ...value }))
        .sort((left, right) => (left.exportedAt ?? 0) - (right.exportedAt ?? 0)),
    async add(sessionId) {
      if (!entries.has(sessionId)) {
        entries.set(sessionId, { exportedAt: Date.now() })
        await api.save()
      }
      return entries.get(sessionId)
    },
    async remove(sessionId) {
      const removed = entries.delete(sessionId)
      if (removed) await api.save()
      return removed
    },
    async load() {
      try {
        const text = await readFile(file, 'utf8')
        const parsed = JSON.parse(text)
        const rows = parsed?.exports
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const id = typeof row?.sessionId === 'string' ? row.sessionId : ''
            if (!id) continue
            entries.set(id, {
              exportedAt: Number.isFinite(row.exportedAt) ? row.exportedAt : Date.now(),
            })
          }
        }
      } catch {
        // Missing file on first use is the normal case.
      }
    },
    async save() {
      const payload = JSON.stringify({ version: 1, exports: api.list() }, null, 2)
      try {
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        await writeFile(temp, payload, 'utf8')
        await rename(temp, file)
      } catch {
        // Persistence is a convenience: the endpoints still work for this process.
      }
    },
  }
  return api
}

/* ------------------------------------------------------------------ */
/* control API (Web UI)                                                */
/* ------------------------------------------------------------------ */

async function serveApi(ctx, config, exports, req, res) {
  if (!isAuthorized(config, req)) {
    writeJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }
  await exports.ready

  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET') {
    writeJson(res, 200, await describeState(ctx, config, exports))
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'use GET or POST' })
    return
  }

  let body
  try {
    body = JSON.parse(await readBody(req, 64 * 1024))
  } catch (error) {
    writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    return
  }

  const action = typeof body?.action === 'string' ? body.action : ''
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  try {
    if (action === 'export') {
      if (!sessionId) throw new Error('sessionId is required')
      await exports.add(sessionId)
    } else if (action === 'revoke') {
      if (!sessionId) throw new Error('sessionId is required')
      await exports.remove(sessionId)
    } else if (action === 'refresh') {
      // No state change: the response below re-reads the live session index.
    } else {
      throw new Error(`unknown action: ${action || '(none)'}`)
    }
    writeJson(res, 200, { ok: true, state: await describeState(ctx, config, exports) })
  } catch (error) {
    writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
  }
}

async function describeState(ctx, config, exports) {
  let origin
  try {
    origin = ctx.webServer.getOrigin()
  } catch {
    origin = undefined
  }
  const rows = await sessionRows(ctx)
  const exportedIds = new Set(exports.list().map((row) => row.sessionId))
  const base = `${origin ?? 'http://127.0.0.1'}${config.path}`
  return {
    ok: true,
    origin: origin ?? null,
    runtimeEndpoint: base,
    auth: config.token ? 'bearer-token' : 'loopback-only',
    clientBundle: describeClientBundle(ctx),
    sessions: rows.map((row) => ({
      ...row,
      exported: exportedIds.has(row.session_id),
      endpoint: `${base}/${encodeURIComponent(row.session_id)}`,
    })),
  }
}

/**
 * Report whether the Host composed a browser bundle for this package. A page can
 * only register the slots when its boot graph carries this row, so this is the
 * one fact that separates "UI code is wrong" from "UI code was never delivered".
 */
function describeClientBundle(ctx) {
  const modules = ctx.get('clientModules')
  if (!modules?.graph) return { available: false, reason: 'client-modules is not mounted' }
  try {
    const graph = modules.graph()
    const row = (graph?.entries ?? []).find((entry) => entry?.id === PACKAGE_NAME)
    if (row === undefined) {
      return {
        available: false,
        reason: 'no boot-graph row for this package',
        rows: (graph?.entries ?? []).map((entry) => entry?.id).filter((id) => typeof id === 'string'),
      }
    }
    return { available: true, revision: row.rev ?? null, release: graph?.release ?? null }
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Best-effort session title from the row's projection hints. The projection
 * namespace is owned by the session-title plugin, so a build without it (or
 * one that has not materialized the projection yet) simply yields no title and
 * the client falls back to the working directory.
 */
function sessionTitleOf(row) {
  const values = row?.projections?.values
  if (values === null || typeof values !== 'object') return undefined
  const candidates = [values.sessionTitle?.title, values.title?.title, values.title]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return undefined
}

async function sessionRows(ctx) {
  const controller = ctx.get('sessionController')
  let rows = []
  if (controller?.list) {
    try {
      const value = await controller.list({}, AbortSignal.timeout(20_000))
      rows = Array.isArray(value?.items) ? value.items : []
    } catch {
      rows = []
    }
  }
  if (rows.length === 0) {
    rows = ctx.agents.list().map((agent) => ({
      sessionId: String(agent.id),
      updatedAt: Date.now(),
      running: agent.status === 'running',
      agentAvailable: true,
      blank: false,
      cwd: agent.session?.header?.cwd,
    }))
  }
  return rows
    .map((row) => {
      const title = sessionTitleOf(row)
      return {
        session_id: String(row?.sessionId ?? ''),
        ...(typeof title === 'string' && title ? { title } : {}),
        running: Boolean(row?.running),
        live: Boolean(row?.agentAvailable),
        blank: Boolean(row?.blank),
        ...(row?.cwd ? { cwd: String(row.cwd) } : {}),
        ...(typeof row?.updatedAt === 'number' ? { updatedAt: row.updatedAt } : {}),
      }
    })
    .filter((row) => row.session_id.length > 0)
}

/* ------------------------------------------------------------------ */
/* MCP transport                                                       */
/* ------------------------------------------------------------------ */

/** The session an exported endpoint addresses, derived from the request path. */
function sessionIdOf(config, url) {
  const basePath = config.path.replace(/\/+$/, '')
  let pathname
  try {
    pathname = new URL(url ?? '/', 'http://localhost').pathname
  } catch {
    return undefined
  }
  const prefix = `${basePath}/`
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length).replace(/\/+$/, '')
  if (!rest || rest === 'api') return undefined
  try {
    return decodeURIComponent(rest)
  } catch {
    return undefined
  }
}

async function serveMcp(ctx, config, scopedSessionId, req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, allowHeaders())
    res.end()
    return
  }
  if (!isAuthorized(config, req)) {
    writeJson(res, 401, rpcError(null, -32001, 'unauthorized: missing or invalid bearer token'))
    return
  }
  if (req.method !== 'POST') {
    // No server-initiated stream (GET) and no session to delete (DELETE).
    res.writeHead(405, { ...allowHeaders(), Allow: 'POST, OPTIONS', 'Content-Type': 'application/json' })
    res.end(JSON.stringify(rpcError(null, -32000, `${req.method} is not supported by this stateless endpoint`)))
    return
  }

  let text
  try {
    text = await readBody(req, MAX_BODY_BYTES)
  } catch (error) {
    writeJson(res, 413, rpcError(null, -32600, 'invalid request', String(error?.message ?? error)))
    return
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    writeJson(res, 400, rpcError(null, -32700, 'parse error', String(error?.message ?? error)))
    return
  }

  const messages = Array.isArray(payload) ? payload : [payload]
  if (messages.length === 0) {
    writeJson(res, 400, rpcError(null, -32600, 'invalid request: empty batch'))
    return
  }

  const responses = []
  for (const message of messages) {
    const response = await dispatch(ctx, config, scopedSessionId, message)
    if (response !== null) responses.push(response)
  }

  if (responses.length === 0) {
    res.writeHead(202, allowHeaders())
    res.end()
    return
  }

  const body = Array.isArray(payload) ? responses : responses[0]
  const accept = String(req.headers.accept ?? '')
  if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
    res.writeHead(200, {
      ...allowHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
    })
    res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
    return
  }
  writeJson(res, 200, body)
}

function allowHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
    'Access-Control-Max-Age': '86400',
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...allowHeaders(),
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function isAuthorized(config, req) {
  const token = typeof config.token === 'string' ? config.token.trim() : ''
  if (token.length > 0) {
    const header = String(req.headers.authorization ?? '')
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    let query = ''
    try {
      query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? ''
    } catch {
      query = ''
    }
    return bearer === token || query === token
  }
  // Without a token the endpoint serves loopback callers only.
  return LOOPBACK.has(String(req.socket?.remoteAddress ?? ''))
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
      req.destroy()
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new Error(`request body exceeds ${limit} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
  })
}

/* ------------------------------------------------------------------ */
/* JSON-RPC dispatch                                                   */
/* ------------------------------------------------------------------ */

async function dispatch(ctx, config, scopedSessionId, message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'invalid request')
  }
  const { method, id, params } = message
  if (typeof method !== 'string') {
    if (id === undefined || id === null) return null
    return rpcError(id, -32600, 'invalid request: missing method')
  }
  // Notifications (initialized, notifications/cancelled, ...) carry no response.
  if (id === undefined || id === null) return null

  try {
    const result = await handleMethod(ctx, config, scopedSessionId, method, params ?? {})
    return { jsonrpc: '2.0', id, result }
  } catch (error) {
    const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : -32603
    return rpcError(id, code, error?.message ? String(error.message) : 'internal error', error?.data)
  }
}

function rpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = typeof data === 'string' ? data : safeJson(data)
  return { jsonrpc: '2.0', id: id ?? null, error }
}

function fail(message, code = -32602, data) {
  const error = new Error(message)
  error.rpcCode = code
  if (data !== undefined) error.data = data
  return error
}

async function handleMethod(ctx, config, scopedSessionId, method, params) {
  switch (method) {
    case 'initialize':
      return initializeResult(scopedSessionId, params)
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: toolDefinitions(scopedSessionId) }
    case 'tools/call':
      return callTool(ctx, config, scopedSessionId, params)
    case 'resources/list':
      return { resources: [] }
    case 'resources/templates/list':
      return { resourceTemplates: [] }
    case 'prompts/list':
      return { prompts: [] }
    default:
      throw fail(`method not found: ${method}`, -32601)
  }
}

function initializeResult(scopedSessionId, params) {
  const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
  const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : PREFERRED_PROTOCOL
  const sessionLine = scopedSessionId
    ? `This endpoint is bound to DSH session "${scopedSessionId}": every tool operates on that one session, and no other session is reachable. ` +
      '`dsh_run` continues it directly.\n\n'
    : ''
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: 'DeepSeek Harness' },
    instructions:
      sessionLine +
      'This server exposes a running DeepSeek Harness (DSH) runtime. `dsh_run` delegates one self-contained task to a DSH agent that has its own filesystem, shell, web, skill, and MCP tools, and returns that agent\'s final answer. ' +
      (scopedSessionId
        ? 'Use `dsh_history` to read the conversation so far and `dsh_cancel` to stop a running turn.'
        : 'Pass `session_id` to continue an earlier DSH session; omit it to start a new one. Use `dsh_sessions` and `dsh_history` to inspect what already happened, and `dsh_status` as a connectivity check.'),
  }
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

function toolDefinitions(scopedSessionId) {
  if (scopedSessionId) {
    return [
      {
        name: 'dsh_run',
        title: 'Continue this DSH session',
        description:
          'Send one message to this exported DSH session and wait for the agent\'s final answer. The agent keeps the session\'s existing history, tools, sandbox mode, and permission policy, so it can read and modify files and run commands in that workspace. Long tasks can exceed a client-side tool timeout: raise that timeout or lower `timeout_ms`.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', minLength: 1, description: 'The task or question for the DSH agent.' },
            timeout_ms: {
              type: 'integer',
              minimum: 1000,
              maximum: 3600000,
              description: 'Wall-clock budget for the whole turn; defaults to the server configuration.',
            },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      {
        name: 'dsh_history',
        title: 'Read this session transcript',
        description:
          'Read the durable transcript of this session: user prompts, assistant answers, and tool calls/results.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most recent messages (default 50).' },
            max_text_chars: {
              type: 'integer',
              minimum: 200,
              maximum: 20000,
              description: 'Truncate each message text to this length (default 4000).',
            },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      {
        name: 'dsh_cancel',
        title: 'Cancel the running turn',
        description: 'Cancel the active turn of this session without deleting its history.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: 'dsh_info',
        title: 'Describe this session',
        description: 'Title, working directory, liveness, and turn state of this exported session.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
    ]
  }

  return [
    {
      name: 'dsh_run',
      title: 'Run a task in DeepSeek Harness',
      description:
        'Delegate a task to a DeepSeek Harness agent and wait for its final answer. The DSH agent runs with this deployment\'s own model, tools (filesystem, shell, web, skills, MCP), sandbox mode, and permission policy, so it can read and modify files and run commands inside its workspace. Omit `session_id` to start a fresh session and receive a new id in the result; pass an existing id to continue that conversation. Long tasks can exceed a client-side tool timeout: raise that timeout or lower `timeout_ms`.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1, description: 'The task or question for the DSH agent.' },
          session_id: { type: 'string', description: 'Continue this DSH session instead of creating one.' },
          cwd: {
            type: 'string',
            description:
              'Absolute working directory for a new session (ignored when continuing one). Defaults to the Harness working directory.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: 3600000,
            description: 'Wall-clock budget for the whole turn; defaults to the server configuration.',
          },
          provider: { type: 'string', description: 'Override the model provider for a new session.' },
          model: { type: 'string', description: 'Override the model for a new session.' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'dsh_sessions',
      title: 'List DSH sessions',
      description: 'List sessions known to this Harness, newest activity first.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum rows (default 20).' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'dsh_history',
      title: 'Read a DSH session transcript',
      description:
        'Read the durable transcript of one DSH session: user prompts, assistant answers, and tool calls/results. Works for live sessions and for persisted idle ones.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session id from dsh_run or dsh_sessions.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Return at most this many of the most recent messages (default 50).',
          },
          max_text_chars: {
            type: 'integer',
            minimum: 200,
            maximum: 20000,
            description: 'Truncate each message text to this length (default 4000).',
          },
        },
        required: ['session_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'dsh_tools',
      title: 'List DSH agent tools',
      description:
        'List the tools the DSH agent can call inside `dsh_run`. Use it to decide what to delegate, or to check whether a capability (shell, web, a configured MCP server) is loaded.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive substring filter on name or description.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'dsh_models',
      title: 'List routable models',
      description: 'List the providers and models this Harness can route, plus the deployment default.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'dsh_cancel',
      title: 'Cancel a running DSH turn',
      description: 'Cancel the active turn of a DSH session without deleting its history.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Live session whose turn to cancel.' } },
        required: ['session_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: 'dsh_status',
      title: 'Describe this DSH runtime',
      description:
        'Report the endpoint, process, default model, live agent count, and loaded capabilities. Useful as a connectivity check.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ]
}

async function callTool(ctx, config, scopedSessionId, params) {
  const toolName = typeof params?.name === 'string' ? params.name : ''
  if (!toolDefinitions(scopedSessionId).some((tool) => tool.name === toolName)) {
    throw fail(`unknown tool: ${toolName}`, -32602)
  }
  const args =
    params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {}

  if (scopedSessionId) {
    switch (toolName) {
      case 'dsh_run':
        return runTool(ctx, config, { ...args, session_id: scopedSessionId }, scopedSessionId)
      case 'dsh_history':
        return historyTool(ctx, { ...args, session_id: scopedSessionId })
      case 'dsh_cancel':
        return cancelTool(ctx, { session_id: scopedSessionId })
      case 'dsh_info':
        return infoTool(ctx, scopedSessionId)
      default:
        throw fail(`unknown tool: ${toolName}`, -32602)
    }
  }

  switch (toolName) {
    case 'dsh_run':
      return runTool(ctx, config, args, undefined)
    case 'dsh_sessions':
      return sessionsTool(ctx, args)
    case 'dsh_history':
      return historyTool(ctx, args)
    case 'dsh_tools':
      return await toolsTool(ctx, config, args)
    case 'dsh_models':
      return modelsTool(ctx)
    case 'dsh_cancel':
      return cancelTool(ctx, args)
    case 'dsh_status':
      return await statusTool(ctx, config)
    default:
      throw fail(`unknown tool: ${toolName}`, -32602)
  }
}

function textResult(value, isError = false) {
  const body = typeof value === 'string' ? value : safeJson(value)
  const clipped =
    body.length > MAX_TOOL_RESULT_CHARS ? `${body.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated]` : body
  return { content: [{ type: 'text', text: clipped }], ...(isError ? { isError: true } : {}) }
}

/* ------------------------------------------------------------------ */
/* dsh_run                                                             */
/* ------------------------------------------------------------------ */

async function runTool(ctx, config, args, scopedSessionId) {
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  if (prompt.trim().length === 0) throw fail('prompt must be a non-empty string')

  const timeoutMs = clampInt(
    args.timeout_ms,
    1000,
    3_600_000,
    Number(config.maxPromptWaitMs) || DEFAULTS.maxPromptWaitMs,
  )
  const cwd =
    typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : String(config.defaultCwd ?? '').trim()
  if (cwd && !isAbsolute(cwd)) throw fail(`cwd must be an absolute path: ${cwd}`)

  const { agent, sessionId } = await resolveAgent(ctx, config, args, cwd, scopedSessionId)

  const events = []
  const state = { started: false }
  const waiters = new Set()
  const wakeAll = () => {
    for (const waiter of [...waiters]) waiter()
  }

  const off = ctx.on('session/event', (session, event) => {
    if (String(session?.id ?? '') !== sessionId) return
    events.push(event)
    if (event?.type === 'turn/start') state.started = true
    wakeAll()
  })

  try {
    agent.followup(userMessage(prompt))

    const started = await until(() => state.started, Math.min(timeoutMs, TURN_START_TIMEOUT_MS), waiters)
    if (!started) {
      throw fail(
        `the DSH agent accepted the prompt but opened no turn within ${Math.round(
          Math.min(timeoutMs, TURN_START_TIMEOUT_MS) / 1000,
        )}s (session ${sessionId}); it may be waiting on an approval, out of credit, or archived`,
        -32000,
      )
    }

    let timedOut = false
    let agentError
    const settled = await Promise.race([
      agent.whenIdle().then(
        () => 'idle',
        (error) => {
          agentError = error
          return 'idle'
        },
      ),
      sleep(timeoutMs).then(() => 'timeout'),
    ])
    if (settled === 'timeout') {
      timedOut = true
      try {
        agent.cancel({ kind: 'user' })
      } catch {
        /* cancellation is best-effort */
      }
    }

    const outcome = collectOutcome(events)
    const answer = outcome.text.length > 0 ? outcome.text : '(the DSH agent produced no assistant text)'
    const meta = [`session_id: ${sessionId}`, `turns: ${outcome.turns}`, `tool_calls: ${outcome.toolCalls}`]
    if (timedOut) meta.push(`timeout: no idle state within ${timeoutMs} ms; the turn was cancelled`)
    if (outcome.failure) meta.push(`turn_failure: ${outcome.failure}`)
    if (agentError) meta.push(`agent_error: ${String(agentError?.message ?? agentError)}`)

    const failed = Boolean(outcome.failure || agentError) && outcome.text.length === 0
    return textResult(`${answer}\n\n---\n${meta.join('\n')}`, failed)
  } finally {
    off()
    waiters.clear()
  }
}

function collectOutcome(events) {
  const texts = []
  let toolCalls = 0
  let turns = 0
  let failure
  for (const event of events) {
    switch (event?.type) {
      case 'assistant/message': {
        const content = event.data?.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) texts.push(block.text)
          }
        }
        break
      }
      case 'tool/call':
        toolCalls += 1
        break
      case 'turn/start':
        turns += 1
        break
      case 'turn/end': {
        const reason = event.data?.reason
        if (reason?.kind === 'error') failure ??= reason.error?.message ?? 'model request failed'
        else if (reason?.kind === 'aborted') failure ??= `turn aborted (${reason.reason?.kind ?? 'unknown'})`
        else if (reason?.kind === 'max-tokens') failure ??= 'the turn stopped at the output-token limit'
        else if (reason?.kind === 'interrupted') failure ??= 'the turn was interrupted'
        break
      }
      default:
        break
    }
  }
  return { text: texts.join('\n\n').trim(), toolCalls, turns, failure }
}

async function resolveAgent(ctx, config, args, cwd, scopedSessionId) {
  const agents = ctx.agents
  const requested = scopedSessionId ?? (typeof args.session_id === 'string' ? args.session_id.trim() : '')

  if (requested) {
    const live = agents.get(requested)
    if (live) return { agent: live, sessionId: requested }
    try {
      const handle = await agents.resume({ resumeSessionId: requested })
      return { agent: handle.agent, sessionId: requested }
    } catch (error) {
      throw fail(`cannot resume DSH session "${requested}": ${String(error?.message ?? error)}`, -32000)
    }
  }

  const sessionId = `mcp-${randomUUID()}`
  const agentOptions = resolveAgentOptions(ctx, args)
  // Always place the session in a real workspace directory: a session created with
  // no cwd persists under `_no-cwd` and stays invisible to the session index, so it
  // could be neither listed nor resumed.
  const meta = { cwd: cwd || defaultCwd(ctx) }
  // A root agent created outside a preset composition inherits only Host-level
  // tools (no shell, no filesystem, no skills). `mount()` in the setup hook is what
  // actually composes the preset — recording `meta.agentPreset` alone does not.
  const preset = await resolvePreset(ctx, config)
  if (preset) meta.agentPreset = preset

  const setup = preset ? await presetSetup(ctx, preset) : undefined

  try {
    const handle = await agents.create({
      sessionId,
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      meta,
      ...(setup ? { setup } : {}),
    })
    return { agent: handle.agent, sessionId, preset }
  } catch (error) {
    throw fail(`cannot create a DSH session: ${String(error?.message ?? error)}`, -32000)
  }
}

/**
 * Build the setup hook that mounts one preset on the unpublished agent context.
 * Setup runs before the agent is published, which is exactly where a preset
 * binding belongs: its tool and prompt registrations must exist before the first
 * creation announcement and before any queued input starts a turn.
 */
async function presetSetup(ctx, preset) {
  const presets = ctx.get('agentPresets')
  if (!presets?.mount) {
    throw fail('agentPresets is unavailable, so a preset cannot be mounted', -32000)
  }
  return async (agentCtx) => {
    await presets.mount(agentCtx, preset)
  }
}

/** The preset a new session joins: the configured one, else the registry default. */
async function resolvePreset(ctx, config) {
  const configured = String(config.defaultPreset ?? '').trim()
  if (configured) return configured
  const presets = ctx.get('agentPresets')
  if (!presets?.resolve) return undefined
  try {
    const preset = await presets.resolve()
    const id = typeof preset?.id === 'string' ? preset.id.trim() : ''
    return id || undefined
  } catch {
    return undefined
  }
}

function resolveAgentOptions(ctx, args) {
  const options = {}
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection && typeof selection === 'object') {
    if (typeof selection.provider === 'string' && selection.provider) options.provider = selection.provider
    if (typeof selection.model === 'string' && selection.model) options.model = selection.model
    if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== null) {
      options.reasoningEffort = selection.reasoningEffort
    }
  }
  if (typeof args.provider === 'string' && args.provider.trim()) options.provider = args.provider.trim()
  if (typeof args.model === 'string' && args.model.trim()) options.model = args.model.trim()
  return options
}

/** The deployment's default working directory, falling back to the process cwd. */
function defaultCwd(ctx) {
  const directory = ctx.get('workingDirectory')
  const value = typeof directory?.defaultDirectory === 'string' ? directory.defaultDirectory : ''
  return value || process.cwd()
}

/* ------------------------------------------------------------------ */
/* read-only tools                                                     */
/* ------------------------------------------------------------------ */

async function sessionsTool(ctx, args) {
  const limit = clampInt(args.limit, 1, 200, 20)
  const rows = await sessionRows(ctx)
  const items = rows.slice(0, limit).map((row) => ({
    session_id: row.session_id,
    ...(row.title ? { title: row.title } : {}),
    running: row.running,
    live: row.live,
    blank: row.blank,
    ...(row.cwd ? { cwd: row.cwd } : {}),
    ...(row.updatedAt ? { updated_at: new Date(row.updatedAt).toISOString() } : {}),
  }))
  return textResult({ total: rows.length, returned: items.length, sessions: items })
}

async function infoTool(ctx, sessionId) {
  const rows = await sessionRows(ctx)
  const row = rows.find((candidate) => candidate.session_id === sessionId)
  if (!row) throw fail(`session "${sessionId}" was not found`, -32000)
  const agent = ctx.agents.get(sessionId)
  return textResult({
    session_id: sessionId,
    ...(row.title ? { title: row.title } : {}),
    ...(row.cwd ? { cwd: row.cwd } : {}),
    live: row.live,
    running: row.running,
    blank: row.blank,
    preset: ctx.get('agentPresets')?.composedPreset?.(agent?.ctx) ?? null,
    ...(row.updatedAt ? { updated_at: new Date(row.updatedAt).toISOString() } : {}),
  })
}

async function historyTool(ctx, args) {
  const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : ''
  if (!sessionId) throw fail('session_id must be a non-empty string')
  const limit = clampInt(args.limit, 1, 500, 50)
  const maxChars = clampInt(args.max_text_chars, 200, 20_000, 4000)

  let events = []
  let header
  const live = ctx.get('sessions')?.get?.(sessionId)
  if (live) {
    events = live.snapshotEvents()
    header = live.header
  } else {
    const controller = ctx.get('sessionController')
    if (!controller?.inspect) {
      throw fail('this Harness exposes no cold session store and the session is not live', -32000)
    }
    const inspection = await controller.inspect(sessionId, AbortSignal.timeout(20_000))
    events = Array.isArray(inspection?.events) ? inspection.events : []
    header = inspection?.meta
  }

  const messages = []
  for (const event of events) {
    const message = projectEvent(event, maxChars)
    if (message) messages.push(message)
  }
  const sliced = messages.slice(-limit)
  return textResult({
    session_id: sessionId,
    ...(header?.cwd ? { cwd: header.cwd } : {}),
    ...(header?.createdAt ? { created_at: new Date(header.createdAt).toISOString() } : {}),
    total_messages: messages.length,
    returned: sliced.length,
    messages: sliced,
  })
}

function projectEvent(event, maxChars) {
  switch (event?.type) {
    case 'user/message': {
      const source = event.data?.source?.kind
      // Injected snapshots and catalogs (runtime context, skill catalog, time,
      // tool registry, model-switch notices) are model-facing plumbing rather than
      // conversation. Only the plain `user` source is a human/agent prompt.
      if (source !== undefined && source !== 'user') return null
      const text = textOf(event.data?.content)
      return text ? { role: 'user', text: clip(text, maxChars) } : null
    }
    case 'assistant/message': {
      const text = textOf(event.data?.message?.content)
      return text ? { role: 'assistant', text: clip(text, maxChars) } : null
    }
    case 'tool/call':
      return {
        role: 'tool-call',
        tool: String(event.data?.name ?? ''),
        arguments: clip(String(event.data?.arguments ?? ''), Math.min(maxChars, 2000)),
      }
    case 'tool/result': {
      const text = textOf(event.data?.message?.content)
      return {
        role: 'tool-result',
        is_error: Boolean(event.data?.message?.isError),
        text: clip(text ?? '', Math.min(maxChars, 2000)),
      }
    }
    case 'turn/end': {
      const kind = event.data?.reason?.kind
      return kind === 'completed' ? null : { role: 'system', text: `turn ended: ${String(kind)}` }
    }
    default:
      return null
  }
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function clip(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

async function toolsTool(ctx, config, args) {
  const tools = ctx.get('tools')
  if (!tools?.schemas) throw fail('this Harness exposes no tool registry', -32000)
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''

  // Global registration alone under-reports: a delegated agent's shell, filesystem,
  // web, and skill tools come from its preset composition. Read the preset scope so
  // the answer matches what `dsh_run` can actually call.
  let rows = []
  let scope = 'global'
  const preset = await resolvePreset(ctx, config)
  const presets = ctx.get('agentPresets')
  let lease
  if (preset && presets?.acquireScope) {
    try {
      lease = await presets.acquireScope(preset)
      rows = tools.schemas(lease.key).map(toRow)
      scope = preset
    } catch {
      rows = []
    }
  }
  try {
    if (rows.length === 0) {
      rows = tools.schemas().map(toRow)
      scope = 'global'
    }
  } finally {
    if (lease) {
      try {
        await lease[Symbol.asyncDispose]?.()
      } catch {
        /* the lease is advisory for this read */
      }
    }
  }

  const filtered = query
    ? rows.filter((row) => row.name.toLowerCase().includes(query) || row.description.toLowerCase().includes(query))
    : rows
  return textResult({ scope, total: rows.length, returned: filtered.length, tools: filtered })
}

function toRow(schema) {
  return {
    name: String(schema?.name ?? ''),
    description: clip(String(schema?.description ?? ''), 400),
  }
}

async function modelsTool(ctx) {
  const controller = ctx.get('sessionController')
  if (!controller?.modelCatalog) throw fail('this Harness exposes no model catalog', -32000)
  const catalog = await controller.modelCatalog()
  return textResult({
    default: catalog?.default ?? null,
    providers: (catalog?.groups ?? []).map((group) => ({
      id: group?.id,
      name: group?.name,
      models: (group?.models ?? []).map((model) => ({ id: model?.id, name: model?.name })),
    })),
    failures: catalog?.failures ?? [],
  })
}

function cancelTool(ctx, args) {
  const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : ''
  if (!sessionId) throw fail('session_id must be a non-empty string')
  const agent = ctx.agents.get(sessionId)
  if (!agent) throw fail(`no live DSH agent for session "${sessionId}"`, -32000)
  agent.cancel({ kind: 'user' })
  return textResult({ cancelled: true, session_id: sessionId })
}

async function statusTool(ctx, config) {
  let origin
  try {
    origin = ctx.webServer.getOrigin()
  } catch {
    origin = undefined
  }
  const tools = ctx.get('tools')
  return textResult({
    server: SERVER_NAME,
    version: SERVER_VERSION,
    endpoint: `${origin ?? 'http://127.0.0.1'}${config.path}`,
    auth: config.token ? 'bearer-token' : 'loopback-only',
    process: { pid: process.pid, node: process.versions.node, platform: process.platform, cwd: process.cwd() },
    default_model: ctx.get('agentDefaultModel')?.currentSelection?.() ?? null,
    default_preset: String(config.defaultPreset ?? '').trim() || '(Harness default preset)',
    available_presets: await listPresets(ctx),
    live_agents: ctx.agents.list().length,
    tool_count: tools?.schemas ? tools.schemas().length : null,
    capabilities: {
      sessionController: Boolean(ctx.get('sessionController')),
      sessionStore: Boolean(ctx.get('sessions')),
      toolRegistry: Boolean(tools?.schemas),
    },
  })
}

/**
 * Preset ids a client may pass as `defaultPreset`. An agent's capability set —
 * including whether it has shell or web tools at all — comes from the preset it
 * joins, so this is the knob that decides what a delegated task can do.
 */
async function listPresets(ctx) {
  const presets = ctx.get('agentPresets')
  if (!presets?.list) return null
  try {
    const rows = await presets.list()
    return rows.map((preset) => ({
      id: String(preset?.id ?? ''),
      ...(preset?.name ? { name: String(preset.name) } : {}),
      ...(preset?.isDefault ? { default: true } : {}),
      ...(preset?.broken ? { broken: String(preset.broken) } : {}),
    }))
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the canonical identified user message. The Session log requires every
 * surface message to carry its own `id` and `role`; a bare `{ content, source }`
 * object is rejected when the durable log is re-validated on resume.
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Wait until `predicate` holds, re-checked whenever a registered waiter is
 * woken, or return false at the deadline.
 */
function until(predicate, timeoutMs, waiters) {
  if (predicate()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      waiters.delete(check)
      resolve(value)
    }
    const check = () => {
      if (predicate()) finish(true)
    }
    const timer = setTimeout(() => finish(predicate()), Math.max(0, timeoutMs))
    timer.unref?.()
    waiters.add(check)
  })
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
