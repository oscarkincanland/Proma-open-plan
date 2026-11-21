/**
 * open-plan 浏览器宿主桥（ADR 0044 / 计划 2026-11-21-002 P2）。
 *
 * 为什么需要这一层：open-plan server 跑在 sidecar 纯 Node 子进程（ELECTRON_RUN_AS_NODE），
 * 无法持有 WebContentsView；内嵌浏览器视图必须活在 Electron main 进程。两侧经
 * 仅回环 HTTP + WebSocket 桥协作：
 *
 *   open-plan server（远程浏览器宿主.mjs，客户端） ──▶ 本桥（main 进程）
 *     POST /attach {key} → { wsUrl }：建/复用 WebContentsView + 返回 CDP WebSocket
 *     POST /detach / /setBounds / /setVisible：视图生命周期与摆位
 *
 * WS 上的 CDP 帧协议（与 server/平台/远程浏览器宿主.mjs 约定一致）：
 *   收 {type:"send", id, method, params} → webContents.debugger.sendCommand → 发 {type:"result", id, result|error}
 *   debugger message 事件 → 发 {type:"event", method, params}
 *   收 {type:"close"} → 关闭连接
 *
 * 视图管理逻辑移植自 open-plan desktop/src/浏览器视图.cjs（同进程形态，ADR 0024 §6 方案 B）：
 * 每会话独立 partition、sandbox 视图、debugger 直连改经 WS 转发，语义保持。
 *
 * 安全：仅监听 127.0.0.1；全部端点要求 x-oaw-bridge-token（启动时生成，时序安全比较）。
 * 开关：GUIJU_EMBED_OPENPLAN=1 时由 index.ts 启动（默认关闭 = 零行为变化）。
 */

import { createServer, type IncomingMessage, type Server as HttpServer } from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, timingSafeEqual } from 'crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { WebContentsView, session, type BrowserWindow } from 'electron'

/** key -> { view, webContents, wsSocket? } */
const views = new Map<
  string,
  { view: WebContentsView; webContents: import('electron').WebContents }
>()

/** wsPath -> webContents：attach 时登记，upgrade 连接按 path 分发 */
const wsEndpoints = new Map<string, import('electron').WebContents>()

let httpServer: HttpServer | null = null
let wss: WebSocketServer | null = null
let bridgeToken = ''
let windowGetter: (() => BrowserWindow | null) | null = null

/** 由 index.ts 注入主窗口 getter（与 open-plan-sidecar 同模式，避免循环 import）。 */
export function setOpenPlanBrowserHostWindowGetter(getter: () => BrowserWindow | null): void {
  windowGetter = getter
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

function authorize(req: IncomingMessage): boolean {
  const header = req.headers['x-oaw-bridge-token'] || ''
  return bridgeToken.length > 0 && constantTimeEqual(String(header), bridgeToken)
}

/** 把 main 侧 debugger 包成跨进程 WS 桥（协议见文件头注释）。 */
function createWsBridge(ws: WebSocket, webContents: import('electron').WebContents): void {
  const onDebuggerMessage = (_event: unknown, method: string, params: unknown): void => {
    // 全量转发 debugger 事件：server 侧 transport.on(method) 自行过滤，
    // 与同进程形态（desktop/src/浏览器视图.cjs）的 on 契约语义保持一致。
    try {
      ws.send(JSON.stringify({ type: 'event', method, params }))
    } catch {}
  }

  const sendResult = (id: number, patch: { result?: unknown; error?: string }): void => {
    try {
      ws.send(JSON.stringify({ type: 'result', id, ...patch }))
    } catch {}
  }

  ws.on('message', (raw) => {
    let frame: { type?: string; id?: number; method?: string; params?: Record<string, unknown> }
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    if (frame?.type === 'send' && typeof frame.id === 'number' && typeof frame.method === 'string') {
      webContents.debugger
        .sendCommand(frame.method, frame.params || {})
        .then((result) => sendResult(frame.id as number, { result: result || {} }))
        .catch((error) => sendResult(frame.id as number, { error: String((error as Error)?.message || error) }))
      return
    }
    if (frame?.type === 'close') {
      try { ws.close() } catch {}
    }
  })

  // debugger 事件统一挂一个监听器；WS 关闭时移除
  webContents.debugger.on('message', onDebuggerMessage)
  ws.on('close', () => {
    try {
      webContents.debugger.removeListener('message', onDebuggerMessage)
    } catch {}
  })
}

function getViewEntry(key: string): { view: WebContentsView; webContents: import('electron').WebContents } | null {
  const existing = views.get(key)
  if (existing && !existing.webContents.isDestroyed()) return existing
  if (existing) views.delete(key)
  return null
}

async function handleAttach(key: string): Promise<{ wsPath: string }> {
  const win = windowGetter?.()
  if (!win) throw Object.assign(new Error('桌面窗口尚未就绪'), { code: 'BROWSER_HOST_NOT_READY' })

  let entry = getViewEntry(key)
  if (!entry) {
    // 每个会话独立 partition：保留登录态，且与用户日常浏览器隔离
    const partition = `persist:oaw-browser-${String(key).replace(/[^\w-]/g, '_').slice(0, 40)}`
    const browserSession = session.fromPartition(partition)
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: true,
      },
    })
    view.setBackgroundColor('#ffffff')
    win.contentView.addChildView(view)
    // 初始尺寸为 0：等渲染进程上报面板边界后再显示，避免遮挡页面
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    if (!view.webContents.debugger.isAttached()) {
      view.webContents.debugger.attach('1.3')
    }
    entry = { view, webContents: view.webContents }
    views.set(key, entry)
  }

  // 每个 attach 一个独立 WS 端点（server 侧 transport 生命周期 = WS 生命周期）
  const wsPath = `/cdp/${randomBytes(12).toString('hex')}`
  wsEndpoints.set(wsPath, entry.webContents)
  return { wsPath }
}

async function handleDetach(key: string): Promise<void> {
  const entry = views.get(key)
  if (!entry) return
  const win = windowGetter?.()
  try { win?.contentView.removeChildView(entry.view) } catch {}
  try {
    if (entry.webContents.debugger.isAttached()) entry.webContents.debugger.detach()
  } catch {}
  try { entry.webContents.close() } catch {}
  views.delete(key)
  for (const [path, wc] of [...wsEndpoints]) {
    if (wc === entry.webContents) wsEndpoints.delete(path)
  }
}

/** 供 ipc.ts 的 guiju:browser-host-* IPC 直调（client 侧边界上报走 IPC，不经 HTTP 桥）。 */
export async function setBrowserViewBounds(key: string, bounds: Record<string, unknown>): Promise<boolean> {
  return handleSetBounds(key, bounds)
}

/** 供 ipc.ts 的 guiju:browser-host-* IPC 直调。 */
export async function setBrowserViewVisible(key: string, visible: boolean): Promise<boolean> {
  return handleSetVisible(key, visible)
}

async function handleSetBounds(key: string, bounds: Record<string, unknown>): Promise<boolean> {
  const entry = getViewEntry(key)
  if (!entry) return false
  const { x = 0, y = 0, width = 0, height = 0 } = bounds || {}
  const safe = {
    x: Math.max(0, Math.round(Number(x) || 0)),
    y: Math.max(0, Math.round(Number(y) || 0)),
    width: Math.max(0, Math.round(Number(width) || 0)),
    height: Math.max(0, Math.round(Number(height) || 0)),
  }
  entry.view.setBounds(safe)
  entry.view.setVisible(safe.width > 0 && safe.height > 0)
  // 同步视口，让页面按面板真实尺寸排版（替代 web 端的 browserResize）
  try {
    await entry.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: Math.max(320, safe.width),
      height: Math.max(240, safe.height),
      deviceScaleFactor: 1,
      mobile: false,
    })
  } catch {}
  return true
}

async function handleSetVisible(key: string, visible: boolean): Promise<boolean> {
  const entry = getViewEntry(key)
  if (!entry) return false
  entry.view.setVisible(Boolean(visible))
  return true
}

/** 启动仅回环桥。返回 { url, token } 供 sidecar 注入 env。 */
export async function startOpenPlanBrowserHost(): Promise<{ url: string; token: string }> {
  if (httpServer) {
    const address = httpServer.address() as AddressInfo
    return { url: `http://127.0.0.1:${address.port}`, token: bridgeToken }
  }
  bridgeToken = randomBytes(24).toString('hex')
  wss = new WebSocketServer({ noServer: true })

  // 全局唯一 connection 分发：按 upgrade 时的 wsPath 找到对应 webContents
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const webContents = wsEndpoints.get(url.pathname)
    if (!webContents || webContents.isDestroyed()) {
      try { ws.close() } catch {}
      return
    }
    createWsBridge(ws, webContents)
  })

  httpServer = createServer((req, res) => {
    const reply = (status: number, payload: Record<string, unknown>): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (!authorize(req)) return reply(401, { error: 'bridge token mismatch' })
    const pathname = (req.url || '').split('?')[0]
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('error', () => reply(400, { error: 'read error' }))
    req.on('end', () => {
      let parsed: Record<string, unknown> = {}
      try { parsed = body ? JSON.parse(body) : {} } catch { return reply(400, { error: 'bad json' }) }
      const key = String(parsed.key || '')
      Promise.resolve()
        .then(async () => {
          if (pathname === '/attach') return handleAttach(key)
          if (pathname === '/detach') { await handleDetach(key); return { ok: true } }
          if (pathname === '/setBounds') return { ok: await handleSetBounds(key, (parsed.bounds as Record<string, unknown>) || {}) }
          if (pathname === '/setVisible') return { ok: await handleSetVisible(key, parsed.visible !== false) }
          throw new Error(`未知桥端点 ${pathname}`)
        })
        .then((payload) => {
          // attach：把 wsPath 拼成完整 ws:// URL（含一次性 token query，upgrade 时校验）
          const wsPath = (payload as { wsPath?: string })?.wsPath
          if (wsPath) {
            const host = req.headers.host || `127.0.0.1:${(httpServer?.address() as AddressInfo)?.port || ''}`
            return reply(200, { wsUrl: `ws://${host}${wsPath}?t=${bridgeToken}` })
          }
          return reply(200, { wsUrl: '', ...payload })
        })
        .catch((error) => reply(500, { error: String((error as Error)?.message || error), code: (error as { code?: string })?.code || null }))
    })
  })

  // WS upgrade：校验 token query 后交由 wss 处理（connection 按 wsPath 分发）
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/cdp/') || !constantTimeEqual(url.searchParams.get('t') || '', bridgeToken)) {
      socket.destroy()
      return
    }
    wss?.handleUpgrade(req, socket, head, (ws) => {
      wss?.emit('connection', ws, req)
    })
  })

  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', reject)
    httpServer!.listen(0, '127.0.0.1', () => resolve())
  })
  const address = httpServer.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`
  console.log(`[open-plan browser host] 桥就绪 ${url}`)
  return { url, token: bridgeToken }
}

/** 停止桥并清理全部视图（before-quit 调用）。 */
export function stopOpenPlanBrowserHost(): void {
  for (const key of [...views.keys()]) {
    void handleDetach(key).catch(() => {})
  }
  try { httpServer?.close() } catch {}
  try { wss?.close() } catch {}
  httpServer = null
  wss = null
}
