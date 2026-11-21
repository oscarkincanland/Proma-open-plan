/**
 * 计划文件持久化（H4-4）
 *
 * 注意：这不是 PlanMode，也不引入新的权限模式。只把复杂任务的计划落成
 * 工作区内的 Markdown 文件，Run 恢复/用户回看时可读。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeWorkspace } from "./workspace.mjs";
import { atomicWriteFile, ensureDirectory } from "./持久化工具.mjs";
import { acquireWriteLock, releaseWriteLock } from "./写入协调.mjs";

export function plansDir(workspace) {
  const root = normalizeWorkspace(workspace);
  return path.join(root || String(workspace || "."), ".plans");
}

export function safePlanName(value) {
  const clean = String(value || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean || `plan-${Date.now()}`;
}

export function planFileName(title = "") {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${stamp}-${safePlanName(title || "plan")}.md`;
}

export function writePlan({ workspace, title = "任务计划", content = "", runId = null, threadId = null, name = null } = {}) {
  const root = normalizeWorkspace(workspace);
  if (!root) return { ok: false, error: "工作区不可用" };
  const dir = plansDir(root);
  ensureDirectory(dir);
  const file = path.join(dir, name ? `${safePlanName(name)}.md` : planFileName(title));
  const header = [
    `# ${title}`,
    "",
    `> 生成时间：${new Date().toISOString()}`,
    runId ? `> Run：${runId}` : "",
    "",
    String(content || "").trim(),
    "",
  ].filter((line) => line !== "").join("\n");
  // 2026-11-19-001 批次 C：计划文件也走写入协调，避免同会话两个 Run 同时整文件重写互相覆盖
  // （之前是裸 atomicWriteFile，原子但不互斥：后写者胜，前者的待办进度会静默丢失）。
  const lock = runId
    ? acquireWriteLock({ workspace: root, targetPath: file, runId, threadId, kind: "plan_write" })
    : null;
  try {
    atomicWriteFile(file, header, "utf8");
  } finally {
    if (lock) releaseWriteLock(lock);
  }
  return { ok: true, path: file, relativePath: path.relative(root, file).replace(/\\/g, "/"), name: path.basename(file) };
}

/**
 * 计划文件清理（2026-11-19-001 批次 C）。
 *
 * 刻意做成**显式调用**且默认 dryRun：计划文件在工作区内，静默删除属于动用户文件。
 * 调用方（运维脚本/设置项）需要显式传 dryRun:false 才会真正删除。
 * 规则：只删超过 keepDays 未更新的 .md，且总数超过 maxFiles 时按最旧优先回收。
 * @returns {{ok:boolean, dryRun:boolean, candidates:Array<{name:string, mtime:string}>, deleted:string[], kept:number}}
 */
export function prunePlans(workspace, { keepDays = 30, maxFiles = 200, dryRun = true, now = new Date() } = {}) {
  const root = normalizeWorkspace(workspace);
  if (!root) return { ok: false, dryRun: true, candidates: [], deleted: [], kept: 0 };
  const dir = plansDir(root);
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return { name, file, mtime: stat.mtime.toISOString(), ageMs: Math.max(0, now.getTime() - stat.mtimeMs) };
    }).sort((left, right) => right.ageMs - left.ageMs);
  } catch {
    return { ok: true, dryRun, candidates: [], deleted: [], kept: 0 };
  }
  const maxAge = Math.max(1, Number(keepDays) || 30) * 86400000;
  const limit = Math.max(1, Number(maxFiles) || 200);
  const 过期 = entries.filter((item) => item.ageMs > maxAge);
  // entries 按「最旧在前」排序：保留最新 limit 个，删除更旧的那部分。
  const 超额 = limit < entries.length ? entries.slice(0, entries.length - limit) : [];
  const candidates = [...new Set([...过期, ...超额])];
  const deleted = [];
  if (!dryRun) {
    for (const item of candidates) {
      try { fs.unlinkSync(item.file); deleted.push(item.name); } catch {}
    }
  }
  return {
    ok: true,
    dryRun: Boolean(dryRun),
    candidates: candidates.map((item) => ({ name: item.name, mtime: item.mtime })),
    deleted,
    kept: entries.length - (dryRun ? 0 : deleted.length),
  };
}

export function readPlan(workspace, name) {
  const root = normalizeWorkspace(workspace);
  if (!root) return null;
  const file = path.join(plansDir(root), path.basename(String(name || "")));
  try {
    return { name: path.basename(file), path: file, content: fs.readFileSync(file, "utf8") };
  } catch {
    return null;
  }
}

export function listPlans(workspace) {
  const root = normalizeWorkspace(workspace);
  if (!root) return [];
  const dir = plansDir(root);
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort().map((name) => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return { name, path: file, bytes: stat.size, mtime: stat.mtime.toISOString(), source: "workspace.plans" };
    });
  } catch {
    return [];
  }
}

/** 从 todo 列表生成 Markdown 计划；只做展示，不改变 todos。 */
export function persistPlanFromTodo({ workspace, todoItems = [], runId = null, threadId = null, title = "任务计划", goal = "" } = {}) {
  const items = Array.isArray(todoItems) ? todoItems : [];
  const lines = items.map((item) => {
    const text = String(item?.content || item?.title || item || "").trim();
    if (!text) return "";
    const checked = ["completed", "done"].includes(String(item?.status || "")) ? "x" : " ";
    return `- [${checked}] ${text}`;
  }).filter(Boolean);
  const content = [goal ? `## 目标\n${goal}` : "", "## 待办", ...lines].filter(Boolean).join("\n");
  // 2026-11-19-001 D：以会话为锚（threadId），同一会话的计划原地更新——
  // 此前用 runId 生成文件名，续跑换一个 Run 就写成一个新文件，"中断后恢复现场"落空。
  const name = threadId
    ? `thread-${safePlanName(threadId)}`
    : (runId ? `${safePlanName(title)}-${crypto.createHash("sha1").update(String(runId)).digest("hex").slice(0, 8)}` : null);
  return writePlan({ workspace, title, content, runId, threadId, name });
}
