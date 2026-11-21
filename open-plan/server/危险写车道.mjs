/**
 * 危险写车道（计划 2026-11-19-001 批次 C）
 *
 * 背景：Pi 内核按 `maxParallelToolCalls` 并行执行同一批工具调用；写文件本身有
 * per-file 写锁兜底，但**破坏性操作**（删除、固化、导入、覆盖、重置）之间的竞态
 * 不在写锁覆盖范围内——两个破坏性操作并发时，"谁先看到什么状态"是不确定的。
 *
 * 做法：只对元数据标记为 destructive / forceConfirm / needsApproval 的工具串行化，
 * 只读与普通写不受影响（不牺牲常规并发）。串行只发生在同一进程内，靠 promise 链。
 *
 * 纯逻辑、无 IO，可单测。
 */

export function createSerialLane() {
  let tail = Promise.resolve();
  let pending = 0;

  /** 排队执行：前一个结束（成功或失败）后才会开始下一个。 */
  function run(task) {
    if (typeof task !== "function") throw new TypeError("serial lane 需要一个函数");
    pending += 1;
    const started = tail.then(task, task);
    // 失败不能阻塞后续任务，也不能产生 unhandled rejection。
    tail = started.then(() => {}, () => {});
    return started.finally(() => { pending -= 1; });
  }

  return {
    run,
    get pending() { return pending; },
    /** 测试/诊断用：等待当前队列清空。 */
    async idle() { await tail; },
  };
}

/** 哪些工具需要进危险写车道（元数据事实，不在业务代码里另写名单）。 */
export function needsDangerousLane(metadata) {
  if (!metadata) return false;
  return Boolean(metadata.destructive || metadata.forceConfirm || metadata.needsApproval);
}
