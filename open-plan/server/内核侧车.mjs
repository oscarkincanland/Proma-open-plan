/**
 * U5：内核侧车（bash 并发门 + 统计）。
 *
 * 2026-11-20（计划 2026-11-20-002 / v2）修订：
 *   - 旧实现自己 spawn 子进程并返回 `{ code, stdout, stderr }`，不符合 Pi SDK
 *     `BashOperations.exec` 契约（`onData(Buffer)` + `{ exitCode }`），默认开启后
 *     所有 bash 结果都变成 "(no output) / Command exited with code undefined"。
 *   - 新实现**不再自己执行进程**，只保留并发门、排队/abort 出队、执行统计（含字节数）；
 *     真正的 spawn / 超时（秒）/ AbortSignal / 进程树终止 / cwd / env 全部委托给
 *     调用方注入的 executor（agent.mjs 注入 SDK 的 createLocalBashOperations），
 *     从而与 SDK bash 工具契约逐字兼容。
 *   - 侧车不缓冲输出（模型可见截断由 SDK 工具层负责），只统计通过 onData 的字节数。
 *
 * flag：OAW_PI_SIDECAR=on 时 agent.mjs 的 bash operations 改经本管理器执行。
 */
const MAX_CONCURRENCY = 4;

export class BashSidecarManager {
  constructor({ maxConcurrency = MAX_CONCURRENCY } = {}) {
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || MAX_CONCURRENCY);
    this.stats = {
      total: 0,
      failed: 0,
      timeout: 0,
      aborted: 0,
      active: 0,
      lastMs: null,
      totalMs: 0,
      bytes: 0,
    };
    this.waiting = [];
  }

  snapshot() {
    return {
      maxConcurrency: this.maxConcurrency,
      ...this.stats,
      avgMs: this.stats.total ? Math.round(this.stats.totalMs / this.stats.total) : null,
    };
  }

  /** 占一个并发槽；满额时排队。排队中 abort 会移出队列并以 "aborted" 拒绝。 */
  _acquire(signal) {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.stats.active < this.maxConcurrency) {
      this.stats.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, onAbort: null, cleanup: null };
      waiter.cleanup = () => {
        if (!waiter.onAbort) return;
        try { signal?.removeEventListener("abort", waiter.onAbort); } catch {}
        waiter.onAbort = null;
      };
      waiter.onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        waiter.cleanup();
        reject(new Error("aborted"));
      };
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  /** 释放槽位；若有排队者，把槽位直接转交给下一个（active 不回落，避免被新调用插队）。 */
  _release() {
    const next = this.waiting.shift();
    if (next) {
      next.cleanup?.();
      // 槽位直接转交：active 保持占用，不再 +1（否则每次转交都会虚增）。
      next.resolve();
      return;
    }
    this.stats.active = Math.max(0, this.stats.active - 1);
  }

  /**
   * 并发门 + 统计包装：所有执行语义由 executor 负责。
   * @param {string} command
   * @param {string} cwd
   * @param {{ onData?: (chunk: Buffer) => void, signal?: AbortSignal, timeout?: number, env?: Record<string,string> }} options
   *   timeout 单位与 SDK BashOperations 契约一致：秒。
   * @param {(command: string, cwd: string, options: object) => Promise<{ exitCode: number|null }>} executor
   */
  async run(command, cwd = "", options = {}, executor) {
    if (typeof executor !== "function") throw new Error("bash sidecar executor required");
    this.stats.total += 1;
    if (options.signal?.aborted) {
      this.stats.aborted += 1;
      throw new Error("aborted");
    }
    try {
      await this._acquire(options.signal);
    } catch (error) {
      this.stats.aborted += 1;
      throw error;
    }

    const started = Date.now();
    let bytes = 0;
    const forwarded = {};
    const externalOnData = typeof options.onData === "function" ? options.onData : null;
    // SDK 契约要求 onData 必传；调用方没给时也要提供一个只计数的 no-op，否则 local ops 会崩。
    forwarded.onData = (chunk) => {
      try { bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk)); } catch {}
      // 输出只在 SDK 工具层组装/截断；这里原样透传 Buffer。
      if (externalOnData) return externalOnData(chunk);
    };
    if (options.signal) forwarded.signal = options.signal;
    if (options.timeout !== undefined && options.timeout !== null) forwarded.timeout = options.timeout;
    if (options.env) forwarded.env = options.env;

    try {
      if (options.signal?.aborted) throw new Error("aborted");
      const result = await executor(command, cwd, forwarded);
      // 非零退出不是异常（SDK 契约以 exitCode 表达），但侧车统计里记为 failed。
      if (!result || result.exitCode === null || result.exitCode !== 0) this.stats.failed += 1;
      return result;
    } catch (error) {
      const message = String(error?.message || error);
      if (/timeout/i.test(message)) this.stats.timeout += 1;
      else if (/aborted/i.test(message)) this.stats.aborted += 1;
      else this.stats.failed += 1;
      throw error;
    } finally {
      const ms = Date.now() - started;
      this.stats.lastMs = ms;
      this.stats.totalMs += ms;
      this.stats.bytes += bytes;
      this._release();
    }
  }
}

/** 把侧车包装成 SDK `BashOperations`：executor 由 agent.mjs 注入（localBash.exec）。 */
export function createSidecarBashOperations(manager, executor) {
  if (!manager || typeof manager.run !== "function") throw new Error("bash sidecar manager required");
  if (typeof executor !== "function") throw new Error("bash sidecar executor required");
  return {
    exec: (command, cwd, options = {}) => manager.run(command, cwd, options, executor),
  };
}

let sharedManager = null;

/** 进程内共享实例（agent.mjs bash operations 使用）。 */
export function getBashSidecar() {
  if (!sharedManager) sharedManager = new BashSidecarManager();
  return sharedManager;
}
