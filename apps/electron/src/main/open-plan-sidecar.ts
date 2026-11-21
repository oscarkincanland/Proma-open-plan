/**
 * open-plan sidecar 监管（ADR 0044 / 计划 2026-11-21-002 P1）。
 *
 * 进程模型：open-plan server（Express + Pi 运行时）以独立子进程运行——
 * 用 ELECTRON_RUN_AS_NODE=1 spawn Electron 自身执行 `desktop-sidecar-entry.mjs`，
 * 就绪后从 ready 文件读取 {url, token}。为什么不用进程内 import：
 *   1. open-plan server 注册了 `uncaughtException → process.exit(1)`（依赖监督
 *      循环拉起干净进程），进程内 import 会把整个壳一起带走；
 *   2. 本文件被 esbuild 打包为 CJS，open-plan server 含 `import.meta`，必须保持
 *      原生 ESM 独立进程；
 *   3. server 崩溃隔离在子进程，main 只做 restart-on-exit。
 *
 * 开关：GUIJU_EMBED_OPENPLAN=1（默认关闭；关闭时行为与上游 Proma 完全一致）。
 * 路径：GUIJU_OPENPLAN_ROOT 覆盖 open-plan 树根（默认 dev 解析仓库根/open-plan，
 * prod 解析 resources/open-plan，P5 打包接线时启用）。
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { app, dialog } from 'electron'
import {
  startOpenPlanBrowserHost,
  stopOpenPlanBrowserHost,
  setOpenPlanBrowserHostWindowGetter,
} from './open-plan-browser-host'

const RESTART_LIMIT = 3
const READY_TIMEOUT_MS = 60_000
const RESTART_BACKOFF_MS = 2_000

export interface OpenPlanSidecarHandle {
  url: string
  /** 已带 token 的应用入口 URL（`/?token=...`，open-plan 前端约定）。 */
  appUrl: string
}

let child: ChildProcess | null = null
let restartCount = 0
let stopping = false
let handle: OpenPlanSidecarHandle | null = null
let readyFile = ''
let restartTimer: ReturnType<typeof setTimeout> | null = null

export function isOpenPlanEmbedEnabled(): boolean {
  return process.env.GUIJU_EMBED_OPENPLAN === '1'
}

function resolveOpenPlanRoot(): string {
  const override = process.env.GUIJU_OPENPLAN_ROOT
  if (override) return resolve(override)
  if (app.isPackaged) return join(process.resourcesPath, 'open-plan')
  // dev：__dirname = apps/electron/dist → 仓库根/open-plan
  return resolve(__dirname, '..', '..', '..', 'open-plan')
}

function readReadyFile(): OpenPlanSidecarHandle | null {
  try {
    if (!existsSync(readyFile)) return null
    const raw = JSON.parse(readFileSync(readyFile, 'utf8')) as {
      url?: string
      token?: string
      error?: string
    }
    if (raw.error) throw new Error(raw.error)
    if (!raw.url || !raw.token) return null
    const url = raw.url.replace(/\/$/, '')
    return { url, appUrl: `${url}/?token=${raw.token}` }
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function waitForReady(): Promise<OpenPlanSidecarHandle> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  return new Promise((resolvePromise, reject) => {
    const poll = (): void => {
      if (stopping) return reject(new Error('sidecar 正在停止'))
      try {
        const result = readReadyFile()
        if (result) return resolvePromise(result)
      } catch (error) {
        return reject(error)
      }
      if (child && child.exitCode !== null) {
        return reject(new Error(`sidecar 提前退出（code=${child.exitCode}），检查服务日志`))
      }
      if (Date.now() > deadline) {
        return reject(new Error(`sidecar 在 ${READY_TIMEOUT_MS / 1000}s 内未就绪`))
      }
      setTimeout(poll, 200)
    }
    poll()
  })
}

async function spawnSidecar(): Promise<ChildProcess> {
  const root = resolveOpenPlanRoot()
  const entry = join(root, 'server', 'desktop-sidecar-entry.mjs')
  const clientDist = join(root, 'client', 'dist')
  const workDir = mkdtempSync(join(tmpdir(), 'guiju-sidecar-'))
  readyFile = join(workDir, 'ready.json')

  // ADR 0044 P2：起浏览器宿主桥（仅回环），把地址与 token 注入 sidecar env——
  // server 经 OAW_BROWSER_HOST_BRIDGE 注入远程宿主，browser_* 工具驱动 main 的 WebContentsView。
  // 桥必须在 spawn 前就绪（env 无法事后注入）；失败不阻断 sidecar（浏览器回落 system 驱动）。
  let bridgeEnv: Record<string, string> = {}
  try {
    setOpenPlanBrowserHostWindowGetter(getMainWindowRef)
    const bridge = await startOpenPlanBrowserHost()
    bridgeEnv = {
      OAW_BROWSER_HOST_BRIDGE: bridge.url,
      OAW_BRIDGE_TOKEN: bridge.token,
    }
    console.log('[open-plan sidecar] 浏览器宿主桥就绪', bridge.url)
  } catch (error) {
    console.error('[open-plan sidecar] 浏览器宿主桥启动失败（浏览器回落 system 驱动）:', error)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ...bridgeEnv,
  }
  const args = [
    entry,
    '--project-dir', root,
    '--out', readyFile,
    '--user-data-dir', join(app.getPath('userData'), 'guiju-data'),
    '--client-dist', clientDist,
  ]
  if (bridgeEnv.OAW_BROWSER_HOST_BRIDGE) {
    args.push('--browser-bridge', bridgeEnv.OAW_BROWSER_HOST_BRIDGE)
    args.push('--bridge-token', bridgeEnv.OAW_BRIDGE_TOKEN)
  }
  const proc = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = String(chunk).trim()
    if (text) console.log('[open-plan sidecar]', text)
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = String(chunk).trim()
    if (text) console.error('[open-plan sidecar]', text)
  })
  proc.on('exit', (code) => {
    child = null
    if (stopping) return
    console.error(`[open-plan sidecar] 异常退出（code=${code}），第 ${restartCount + 1} 次重启`)
    scheduleRestart()
  })
  return proc
}

function scheduleRestart(): void {
  if (stopping) return
  if (restartCount >= RESTART_LIMIT) {
    dialog.showErrorBox(
      '规聚服务已停止',
      'open-plan 服务多次异常退出，已停止自动重启。\n请重启应用；若持续出现，请检查安装目录下的服务日志。',
    )
    return
  }
  const delay = RESTART_BACKOFF_MS * (restartCount + 1)
  restartCount += 1
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (stopping) return
    try {
      rmSync(readyFile, { force: true })
    } catch {}
    void spawnSidecar()
      .then((proc) => {
        child = proc
        return waitForReady()
      })
      .then((result) => {
        handle = result
        restartCount = 0
        console.log(`[open-plan sidecar] 重启完成 ${result.url}`)
        // 主窗口若在加载失败页，尝试回到应用入口
        reloadMainWindowToOpenPlan()
      })
      .catch((error) => {
        console.error('[open-plan sidecar] 重启后未就绪:', error)
      })
  }, delay)
}

function reloadMainWindowToOpenPlan(): void {
  // 通过全局注册的主窗口 getter 拿窗口（避免循环 import）。
  const win = getMainWindowRef()
  if (!win || win.isDestroyed() || !handle) return
  win.webContents.loadURL(handle.appUrl).catch((error) => {
    console.error('[open-plan sidecar] 重载主窗口失败:', error)
  })
}

let mainWindowRef: (() => import('electron').BrowserWindow | null) | null = null

/** 由 index.ts 注入主窗口 getter（避免模块循环依赖）。 */
export function setOpenPlanMainWindowGetter(getter: () => import('electron').BrowserWindow | null): void {
  mainWindowRef = getter
}

function getMainWindowRef(): import('electron').BrowserWindow | null {
  return mainWindowRef ? mainWindowRef() : null
}

/** 启动 sidecar 并等待就绪。失败抛错（由调用方 safeAwait 隔离，不阻断窗口创建）。 */
export async function startOpenPlanSidecar(): Promise<OpenPlanSidecarHandle> {
  if (!isOpenPlanEmbedEnabled()) throw new Error('GUIJU_EMBED_OPENPLAN 未开启')
  stopping = false
  restartCount = 0
  child = await spawnSidecar()
  handle = await waitForReady()
  console.log(`[open-plan sidecar] 就绪 ${handle.url}`)
  return handle
}

/** 优雅停止：SIGTERM → 5s 超时 → 强杀；同时清理浏览器宿主桥。 */
export function stopOpenPlanSidecar(): void {
  stopping = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  stopOpenPlanBrowserHost()
  const proc = child
  child = null
  if (!proc || proc.exitCode !== null) return
  try {
    proc.kill('SIGTERM')
  } catch {}
  const killer = setTimeout(() => {
    try {
      if (proc.exitCode === null) proc.kill('SIGKILL')
    } catch {}
  }, 5_000)
  proc.once('exit', () => clearTimeout(killer))
  proc.unref()
}

/** 当前应用入口 URL（未就绪返回 null）。 */
export function getOpenPlanAppUrl(): string | null {
  return handle ? handle.appUrl : null
}
