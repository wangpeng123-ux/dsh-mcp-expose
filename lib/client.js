/**
 * Browser half of dsh-mcp-expose.
 *
 * Adds an "MCP 服务器" page to the Plugins settings section: pick sessions, export
 * them, and copy the endpoint each one gets. A second one-click control sits in the
 * Session header so the session in front of you can be exported from the
 * conversation. The page talks to the Host half's same-origin control API; it never
 * constructs MCP traffic itself.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mcp-expose',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API_PATH = '/mcp/dsh/api'

    const CSS = `
.dmx-page { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 24px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.dmx-section-title { margin: 0; font-size: 12px; font-weight: 600; line-height: 18px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.dmx-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dmx-endpoint { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; }
.dmx-endpoint-row { display: flex; align-items: center; gap: 8px; }
.dmx-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; word-break: break-all; color: var(--dsw-alias-label-primary); }
.dmx-muted { color: var(--dsw-alias-label-secondary); }
.dmx-tag { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; line-height: 18px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.dmx-tag--on { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
.dmx-list { display: flex; flex-direction: column; }
.dmx-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; }
.dmx-row + .dmx-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.dmx-row-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.dmx-row-title { margin: 0; font-size: 13px; font-weight: 500; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmx-row-sub { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmx-row-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.dmx-btn { appearance: none; font: inherit; font-size: 12px; line-height: 20px; padding: 3px 12px; border-radius: 7px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-primary); transition: background-color .15s ease, border-color .15s ease; }
.dmx-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dmx-btn:disabled { opacity: .45; cursor: default; }
.dmx-btn--primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
.dmx-btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
.dmx-btn--quiet { border-color: transparent; color: var(--dsw-alias-label-secondary); padding: 3px 8px; }
.dmx-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dmx-filter { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dmx-input { flex: 1; min-width: 0; box-sizing: border-box; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: inherit; font: inherit; font-size: 12px; outline: none; }
.dmx-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dmx-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dmx-note--error { color: var(--dsw-alias-state-error-primary); }
.dmx-empty { padding: 20px 16px; text-align: center; }
.dmx-copy { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.dmx-copy .dmx-mono { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmx-header-action { display: inline-flex; align-items: center; gap: 5px; }
.dmx-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: none; }
`

    function useStyles() {
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const id = 'dmx-styles'
        if (document.getElementById(id) !== null) return undefined
        const style = document.createElement('style')
        style.id = id
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, [])
    }

    async function readState() {
      const res = await fetch(API_PATH, { cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body
    }

    async function postAction(action, sessionId) {
      const res = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, sessionId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok !== true) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body.state
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the textarea path */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    function useExposeState() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)

      const reload = useCallback(() => {
        let cancelled = false
        setError(null)
        readState()
          .then((next) => {
            if (!cancelled) setState(next)
          })
          .catch((err) => {
            if (!cancelled) setError(err instanceof Error ? err.message : String(err))
          })
        return () => {
          cancelled = true
        }
      }, [])

      useEffect(() => reload(), [reload])

      const run = useCallback(async (action, sessionId) => {
        setBusy(sessionId ?? action)
        setError(null)
        try {
          setState(await postAction(action, sessionId))
          return true
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          return false
        } finally {
          setBusy(null)
        }
      }, [])

      return { state, error, busy, reload, run }
    }

    function sessionLabel(row) {
      if (row.title) return row.title
      if (row.cwd) {
        const parts = row.cwd.split(/[\\/]/).filter(Boolean)
        const tail = parts.slice(-2).join('/')
        if (tail) return tail
      }
      return row.session_id
    }

    function CopyButton({ text, label, doneLabel }) {
      const [copied, setCopied] = useState(false)
      return h('button', {
        className: 'dmx-btn',
        type: 'button',
        onClick: () => {
          copyText(text).then((ok) => {
            if (!ok) return
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          })
        },
      }, copied ? doneLabel ?? '已复制' : label ?? '复制')
    }

    function SessionRow({ row, busy, onExport, onRevoke }) {
      const working = busy === row.session_id
      return h('div', { className: 'dmx-row' },
        h('div', { className: 'dmx-row-body' },
          h('p', { className: 'dmx-row-title' }, sessionLabel(row)),
          h('p', { className: 'dmx-row-sub' },
            `${row.session_id}${row.running ? ' · 运行中' : ''}${row.cwd ? ` · ${row.cwd}` : ''}`),
        ),
        h('div', { className: 'dmx-row-actions' },
          h('span', { className: row.exported ? 'dmx-tag dmx-tag--on' : 'dmx-tag' }, row.exported ? '已导出' : '未导出'),
          row.exported
            ? h('button', {
                className: 'dmx-btn dmx-btn--quiet',
                type: 'button',
                disabled: working,
                onClick: () => onRevoke(row.session_id),
              }, working ? '…' : '取消导出')
            : h('button', {
                className: 'dmx-btn dmx-btn--primary',
                type: 'button',
                disabled: working,
                onClick: () => onExport(row.session_id),
              }, working ? '…' : '导出'),
        ),
      )
    }

    function ExportedCard({ row, busy, onRevoke }) {
      return h('div', { className: 'dmx-row' },
        h('div', { className: 'dmx-row-body' },
          h('p', { className: 'dmx-row-title' }, sessionLabel(row)),
          h('p', { className: 'dmx-row-sub dmx-mono' }, row.endpoint),
        ),
        h('div', { className: 'dmx-row-actions' },
          h(CopyButton, { text: row.endpoint, label: '复制地址' }),
          h('button', {
            className: 'dmx-btn dmx-btn--quiet',
            type: 'button',
            disabled: busy === row.session_id,
            onClick: () => onRevoke(row.session_id),
          }, busy === row.session_id ? '…' : '取消导出'),
        ),
      )
    }

    function McpExposePage() {
      useStyles()
      const { state, error, busy, reload, run } = useExposeState()
      const [query, setQuery] = useState('')

      const sessions = useMemo(() => (state?.sessions ?? []), [state])
      const exported = useMemo(() => sessions.filter((row) => row.exported), [sessions])
      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (!needle) return sessions
        return sessions.filter((row) =>
          [sessionLabel(row), row.session_id, row.cwd ?? ''].join(' ').toLowerCase().includes(needle),
        )
      }, [sessions, query])

      if (error !== null) {
        return h('div', { className: 'dmx-page' },
          h('p', { className: 'dmx-note dmx-note--error' }, `无法读取 MCP 状态：${error}`),
          h('div', null, h('button', { className: 'dmx-btn', type: 'button', onClick: reload }, '重试')),
        )
      }
      if (state === null) {
        return h('div', { className: 'dmx-page' }, h('p', { className: 'dmx-note' }, '正在加载…'))
      }

      return h('div', { className: 'dmx-page' },
        h('div', { className: 'dmx-card' },
          h('div', { className: 'dmx-endpoint' },
            h('div', { className: 'dmx-endpoint-row' }, h('span', { className: 'dmx-section-title' }, '运行时端点（全部会话）')),
            h('div', { className: 'dmx-endpoint-row' },
              h('div', { className: 'dmx-copy' }, h('span', { className: 'dmx-mono' }, state.runtimeEndpoint)),
              h(CopyButton, { text: state.runtimeEndpoint }),
            ),
            h('p', { className: 'dmx-note' },
              state.auth === 'bearer-token'
                ? '需要 Bearer token 才能访问。'
                : '当前仅允许本机回环地址访问；如需对局域网开放，请在插件配置中设置 token。'),
          ),
        ),

        h('p', { className: 'dmx-section-title' }, `已导出的会话（${exported.length}）`),
        exported.length === 0
          ? h('div', { className: 'dmx-card' },
              h('div', { className: 'dmx-empty' },
                h('p', { className: 'dmx-note' }, '还没有导出的会话。在下方列表中选择一个会话并点击「导出」，它就会获得独立端点。'),
              ),
            )
          : h('div', { className: 'dmx-card' },
              h('div', { className: 'dmx-list' },
                exported.map((row) =>
                  h(ExportedCard, { key: row.session_id, row, busy, onRevoke: (id) => run('revoke', id) }),
                ),
              ),
            ),

        h('p', { className: 'dmx-section-title' }, `会话（${sessions.length}）`),
        h('div', { className: 'dmx-card' },
          h('div', { className: 'dmx-filter' },
            h('input', {
              className: 'dmx-input',
              value: query,
              placeholder: '按标题、目录或会话 ID 过滤',
              spellCheck: false,
              onChange: (event) => setQuery(event.currentTarget.value),
            }),
            h('button', { className: 'dmx-btn dmx-btn--quiet', type: 'button', onClick: reload }, '刷新'),
          ),
          filtered.length === 0
            ? h('div', { className: 'dmx-empty' }, h('p', { className: 'dmx-note' }, '没有匹配的会话。'))
            : h('div', { className: 'dmx-list' },
                filtered.map((row) =>
                  h(SessionRow, {
                    key: row.session_id,
                    row,
                    busy,
                    onExport: (id) => run('export', id),
                    onRevoke: (id) => run('revoke', id),
                  }),
                ),
              ),
        ),

        h('p', { className: 'dmx-note' },
          '导出的会话端点只暴露那一个会话：它的 dsh_run 会直接续跑这个会话，无法通过它访问其他会话。取消导出会立即失效，但不会删除会话。'),
      )
    }

    function HeaderControl(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [exported, setExported] = useState(null)
      const [busy, setBusy] = useState(false)
      const [copied, setCopied] = useState(false)

      const refresh = useCallback(() => {
        if (!sessionId) return undefined
        let cancelled = false
        readState()
          .then((next) => {
            if (cancelled) return
            const row = (next.sessions ?? []).find((candidate) => candidate.session_id === sessionId)
            setExported(row !== undefined ? Boolean(row.exported) : false)
          })
          .catch(() => {
            if (!cancelled) setExported(false)
          })
        return () => {
          cancelled = true
        }
      }, [sessionId])

      useEffect(() => refresh(), [refresh])

      if (!sessionId) return null

      const toggle = () => {
        setBusy(true)
        postAction(exported ? 'revoke' : 'export', sessionId)
          .then((next) => {
            const row = (next.sessions ?? []).find((candidate) => candidate.session_id === sessionId)
            setExported(row !== undefined ? Boolean(row.exported) : !exported)
          })
          .catch(() => {})
          .finally(() => setBusy(false))
      }

      const copyEndpoint = () => {
        readState()
          .then((next) => {
            const row = (next.sessions ?? []).find((candidate) => candidate.session_id === sessionId)
            if (row === undefined) return
            copyText(row.endpoint).then((ok) => {
              if (!ok) return
              setCopied(true)
              setTimeout(() => setCopied(false), 1600)
            })
          })
          .catch(() => {})
      }

      return h('span', { className: 'dmx-header-action' },
        exported === true ? h('span', { className: 'dmx-dot', 'aria-hidden': true }) : null,
        h('button', {
          className: exported === true ? 'dmx-btn' : 'dmx-btn dmx-btn--quiet',
          type: 'button',
          disabled: busy,
          title: exported === true ? '该会话已导出为 MCP 端点，点击取消' : '把这个会话导出为 MCP 端点',
          onClick: toggle,
        }, busy ? '…' : exported === true ? 'MCP 已导出' : '导出 MCP'),
        exported === true
          ? h('button', { className: 'dmx-btn dmx-btn--quiet', type: 'button', onClick: copyEndpoint },
              copied ? '已复制' : '复制地址')
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        if (slots === undefined) return

        ctx.effect(() => {
          const disposers = [
            slots.inject('settings.plugins.tab', () =>
              slots.register(
                { name: 'settings.plugins.tab', id: 'dsh-mcp-expose', order: 40, label: 'MCP 服务器' },
                McpExposePage,
              ),
            ),
            slots.inject('conversation.session.header.actions', () =>
              slots.register(
                { name: 'conversation.session.header.actions', id: 'dsh-mcp-expose', order: 5 },
                HeaderControl,
              ),
            ),
          ]
          return () => {
            for (const dispose of disposers.reverse()) dispose()
          }
        }, 'dsh-mcp-expose-client.slots')
      },
    }
  },
})
