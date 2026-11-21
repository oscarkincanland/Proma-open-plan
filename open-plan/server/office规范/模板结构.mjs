/**
 * 模板结构抽取与覆盖率验收（O-14 / O-15）。
 *
 * 把 Markdown 模板里的「必备章节 / 可选章节 / 必备图表 / 格式规则 / 常见错误」
 * 解析成结构化对象，供写作与验收共用；模板正文本身只读。
 */

function splitLines(markdown) {
  return String(markdown || "").split(/\r?\n/);
}

/** 取二级章节正文（从匹配行到下一个 `## `）。 */
function level2Section(lines, startRe) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** 取三级章节正文（从匹配行到下一个 `### ` 或 `## `）。 */
function level3Section(lines, startRe) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

function cleanTitle(text) {
  return String(text || "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[：:]\s*$/, "")
    .trim();
}

function unique(list) {
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

function parseMarkedItems(sectionText, mark) {
  const out = [];
  for (const line of splitLines(sectionText)) {
    const match = line.match(/^\s*[-*]\s*([✅🔧])\s*(.+)$/u);
    if (!match || match[1] !== mark) continue;
    out.push(cleanTitle(match[2]));
  }
  return unique(out);
}

/**
 * 解析「标注」表格（08 等模板的格式）：
 * | 章节 | 标注 | 说明 |
 * | 一、前期工作进展 | ✅ 必备 | ... |
 */
function parseMarkedTable(sectionText) {
  const lines = splitLines(sectionText);
  let headerIndex = -1;
  let markerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const cells = lines[i].split("|").map((cell) => cell.trim());
    const idx = cells.findIndex((cell) => /标注|必备/.test(cell));
    if (idx >= 0) {
      headerIndex = i;
      markerIndex = idx;
      break;
    }
  }
  if (headerIndex < 0) return { required: [], optional: [] };
  const required = [];
  const optional = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i])) {
      if (lines[i].trim()) break;
      continue;
    }
    if (/^\s*\|?\s*:?-{2,}/.test(lines[i])) continue;
    const cells = lines[i].split("|").map((cell) => cell.trim());
    const name = cells[1] || cells[0];
    const marker = cells[markerIndex] || "";
    if (!name) continue;
    if (/✅/.test(marker)) required.push(cleanTitle(name));
    else if (/🔧/.test(marker)) optional.push(cleanTitle(name));
  }
  return { required: unique(required), optional: unique(optional) };
}

/** 结构骨架代码块里的顶层章节：一、二、三、四、。 */
function parseChaptersFromCodeBlock(sectionText) {
  const out = [];
  for (const match of String(sectionText || "").matchAll(/```[\s\S]*?```/g)) {
    for (const line of splitLines(match[0])) {
      const hit = line.match(/^\s*([一二三四五六七八九十百]+)、\s*(.+?)\s*$/u);
      if (hit) out.push(`${hit[1]}、${cleanTitle(hit[2])}`);
      // 2026-11-19-001 批次 B：条文式模板用「第一章 总则」而不是「一、」，原解析器漏掉整类。
      const chapter = line.match(/^\s*第([一二三四五六七八九十百]+)章\s*(.+?)\s*$/u);
      if (chapter) out.push(`第${chapter[1]}章${cleanTitle(chapter[2])}`);
    }
  }
  return unique(out);
}

/** `### ...（必备）` 形式的必备段落。 */
function parseRequiredHeadings(sectionText) {
  const out = [];
  for (const line of splitLines(sectionText)) {
    const hit = line.match(/^###\s+(.+?)\s*（必备）\s*$/u);
    if (hit) out.push(cleanTitle(hit[1]));
  }
  return unique(out);
}

function parseTableFirstColumn(sectionText) {
  const rows = [];
  for (const line of splitLines(sectionText)) {
    if (!/^\s*\|/.test(line)) continue;
    if (/^\s*\|?\s*:?-{2,}/.test(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (!cells.length) continue;
    if (/^(错误|序号|章节|图件|表格|项目)$/.test(cells[0])) continue;
    rows.push(cells[0]);
  }
  return unique(rows);
}

function parseFigureNumbers(sectionText) {
  const out = [];
  for (const match of String(sectionText || "").matchAll(/图\s?(\d+)\s?-\s?(\d+)/g)) {
    out.push(`图${match[1]}-${match[2]}`);
  }
  return unique(out);
}

function parseTableNumbers(sectionText) {
  const out = [];
  for (const match of String(sectionText || "").matchAll(/表\s?(\d+)\s?-\s?(\d+)/g)) {
    out.push(`表${match[1]}-${match[2]}`);
  }
  return unique(out);
}

/**
 * 解析模板结构。
 * @param {string} markdown 模板正文
 * @returns {{title:string, requiredSections:string[], optionalSections:string[], chapters:string[], figures:string[], tables:string[], formatRules:string[], pitfalls:string[]}}
 */
export function parseTemplateStructure(markdown) {
  const text = String(markdown || "");
  const lines = splitLines(text);
  const title = (text.match(/^#\s+(.+)$/m)?.[1] || "").trim();

  // 2026-11-19-001 批次 B：骨架标题在各模板里写法不同——「二、结构骨架」「2. 结构骨架：…」
  // 「二、PPT 四类场景实测骨架」，原正则只认第一种，导致 01/02/03/11 解析为空。
  const structureSection = level2Section(lines, /^##\s*(?:(?:[一二三四五六七八九十]+、|[0-9]+\.)\s*)?[^\n]*骨架/);
  const marked = parseMarkedTable(structureSection);
  const chapterHeadings = [...structureSection.matchAll(/^###\s+(第[一二三四五六七八九十百]+章[^\n]*)$/gm)]
    .map((match) => cleanTitle(match[1]));
  const chapters = unique([...chapterHeadings, ...parseChaptersFromCodeBlock(structureSection)]);
  const explicitRequired = unique([
    ...parseMarkedItems(structureSection, "✅"),
    ...marked.required,
    ...parseRequiredHeadings(structureSection),
  ]).filter((item) => !/(结构骨架|四段式|标注|字数占比|写作要点|格式规范|图表规范|案例出处|常见错误|检查清单|附录)/.test(item));
  // 兜底：01/02/03/10 等模板把章节骨架写在代码块里（没有 ✅ 标记、也没有标注表），
  // 此时用章节清单充当必备小节——inferred 仍为 true，验收只做告警、不误判失败。
  const chapterDerived = explicitRequired.length
    ? []
    : chapters.filter((item) => !/(封面|前言|目录|附录)$/.test(item));
  const requiredSections = explicitRequired.length ? explicitRequired : chapterDerived;
  const structureSource = explicitRequired.length ? "explicit" : (chapterDerived.length ? "chapters" : "none");
  const optionalSections = unique([
    ...parseMarkedItems(structureSection, "🔧"),
    ...marked.optional,
  ]);

  const figureSection = level3Section(lines, /^###\s*5\.2\s*必备图[件表]清单/);
  const tableSection = level3Section(lines, /^###\s*5\.3\s*必备表格清单/);
  const figures = unique([...parseFigureNumbers(figureSection), ...parseFigureNumbers(structureSection)]);
  const tables = unique([...parseTableNumbers(tableSection), ...parseTableNumbers(figureSection)]);

  const formatSection = level2Section(lines, /^##\s*三、\s*格式规范/);
  const formatRules = unique(
    splitLines(formatSection)
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line && /(字号|行距|缩进|页边距|磅|pt|twips)/i.test(line)),
  ).slice(0, 40);

  const pitfallSection = level2Section(lines, /^##\s*七、\s*常见错误/);
  const pitfalls = parseTableFirstColumn(pitfallSection).slice(0, 40);

  // 没有显式 ✅/标注表时视为推断结构：覆盖率缺失降为告警（章节兜底不等于模板给了必备标注）。
  const inferred = explicitRequired.length === 0;

  return { title, chapters, requiredSections, optionalSections, figures, tables, formatRules, pitfalls, inferred, structureSource };
}

function sectionCandidates(name) {
  const clean = cleanTitle(name);
  const out = new Set([clean]);
  out.add(clean.replace(/^\d+(?:\.\d+)+\s*/, ""));
  out.add(clean.replace(/^[一二三四五六七八九十百]+、\s*/, ""));
  out.add(clean.replace(/^[一二三四五六七八九十百]+(?=\S)/, ""));
  out.add(clean.replace(/^[一二三四五六七八九十百]+、\s*/, "").replace(/(若干|有关|相关|主要)/g, ""));
  out.add(clean.replace(/^.*?（[^）]*）\s*/, ""));
  out.add(clean.split("、").pop());
  return [...out].map((item) => item.trim()).filter(Boolean);
}

function normalize(text) {
  return String(text || "").replace(/[\s\u3000]+/g, "");
}

/**
 * 模板覆盖率验收。
 * @param {object} structure parseTemplateStructure 的结果
 * @param {string} producedText 产物文本（view text/outline 的输出）
 * @returns {{ok:boolean, total:number, covered:number, coverage:number, missing:string[]}}
 */
export function assertCoverage(structure, producedText) {
  const produced = normalize(producedText);
  const required = Array.isArray(structure?.requiredSections) ? structure.requiredSections : [];
  const chapters = Array.isArray(structure?.chapters) ? structure.chapters : [];
  const figures = Array.isArray(structure?.figures) ? structure.figures : [];
  const tables = Array.isArray(structure?.tables) ? structure.tables : [];

  // 模板没有结构标记时跳过覆盖率（避免误报）
  if (!required.length && !chapters.length && !figures.length && !tables.length) {
    return { ok: true, total: 0, covered: 0, coverage: 1, missing: [], skipped: true };
  }

  const missingSections = [];
  const missingAssets = [];
  let total = 0;
  let covered = 0;

  // 先算必备小节的覆盖情况：章节与必备小节常是同一批标题的两种写法
  // （如「第一章 概述」与「概述」），两边都无条件计入会把同一处缺失报两次，
  // 出现「全写了还报 8 处缺失」的假阴性（2026-11-19-001 批次 B 端到端实测）。
  const 已覆盖的必备名 = new Set();
  // 必备小节是「1.1 / 1.1.1」这类子章节时，章的**存在性**由所属章号是否已有内容覆盖决定，
  // 否则「第一章 概述」永远匹配不到「1.1 项目概况」，出现"全写了还报缺章"的假阴性。
  const 已覆盖的章号 = new Set();
  for (const section of required) {
    const number = section.match(/^\d+(?:\.\d+)+/)?.[0] || "";
    const name = cleanTitle(section.replace(/^\d+(?:\.\d+)+\s*/, ""));
    const candidates = sectionCandidates(name).map(normalize);
    const 编号命中 = Boolean(number && produced.includes(number));
    if (编号命中 || candidates.some((item) => produced.includes(item))) {
      已覆盖的必备名.add(normalize(name));
      // 章号只认「编号命中」：按名称命中会把别的章里的同名词（如「投资估算」出现在 7.x）
      // 误算成本章内容，从而把整章判成已覆盖。
      if (编号命中) {
        const top = number.split(".")[0];
        if (top) 已覆盖的章号.add(top);
      }
    }
  }
  const 中文数字 = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const 章号映射 = (chapter) => {
    const hit = String(chapter).match(/^第([一二三四五六七八九十]+)章/);
    const num = hit ? 中文数字[hit[1]] : 0;
    return num ? String(num) : "";
  };

  for (const chapter of chapters) {
    // 章节若已被某个必备小节覆盖（同名/包含），或其下子章节已有内容，不再重复计数与报缺失。
    const chapterName = normalize(cleanTitle(chapter.replace(/^第[一二三四五六七八九十百]+章\s*/, "")));
    const 被必备覆盖 = [...已覆盖的必备名].some((name) => name && (chapterName.includes(name) || name.includes(chapterName)));
    const 章号 = 章号映射(chapter);
    if (被必备覆盖 || (章号 && 已覆盖的章号.has(章号))) continue;
    total += 1;
    const number = chapter.match(/第[一二三四五六七八九十百]+章/)?.[0] || "";
    const name = cleanTitle(chapter.replace(/^第[一二三四五六七八九十百]+章\s*/, ""));
    const candidates = sectionCandidates(name).map(normalize);
    if ((number && produced.includes(number)) || candidates.some((item) => produced.includes(item))) covered += 1;
    else missingSections.push(chapter);
  }

  for (const section of required) {
    total += 1;
    const number = section.match(/^\d+(?:\.\d+)+/)?.[0] || "";
    const name = cleanTitle(section.replace(/^\d+(?:\.\d+)+\s*/, ""));
    const candidates = sectionCandidates(name).map(normalize);
    if ((number && produced.includes(number)) || candidates.some((item) => produced.includes(item))) covered += 1;
    else missingSections.push(section);
  }

  for (const figure of figures) {
    total += 1;
    if (produced.includes(figure)) covered += 1;
    else missingAssets.push(figure);
  }

  for (const table of tables) {
    total += 1;
    if (produced.includes(table)) covered += 1;
    else missingAssets.push(table);
  }

  const missing = [...missingSections, ...missingAssets];
  const coverage = total ? Number((covered / total).toFixed(4)) : 1;
  return { ok: missing.length === 0, total, covered, coverage, missing, missingSections, missingAssets, inferred: Boolean(structure?.inferred) };
}
