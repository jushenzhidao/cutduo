#!/usr/bin/env node
/**
 * tools/facts-check.mjs · 出处台账 ↔ 屏幕字对照
 *
 * 上游的核心主张是「没出处不上屏」：每个数字、人名、年份、引文都要在台账里有一行。
 * 这里把它变成机器可查的两件事：
 *
 *   正向  --facts facts.md            台账里写的数字，屏幕上有没有真的出现
 *   反向  --facts facts.md --orphans  屏幕上出现的数字，台账里有没有出处
 *
 * 用法（通常由 gate.mjs 的 --facts 转调，也可单独跑）：
 *   node tools/facts-check.mjs --ocr ocr.txt --facts facts.md
 *   node tools/facts-check.mjs --ocr ocr.txt --facts facts.md --orphans
 *
 * 只输出结论，不做判定（判定在 gate.mjs，由 --require-facts 决定是否拦）。
 */
import fs from 'node:fs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/**
 * 解析 markdown 台账。只认表头里含「事实」的那张表，取第 2 列（上屏写法）。
 * 兼容上游模板的六列：| # | 事实（上屏写法） | 出处 | 级别 | 原文摘录 | 用在哪一拍 |
 */
export function parseFacts(md) {
  const rows = [];
  for (const line of String(md).split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^[-:\s]+$/.test(cells[0]) || /^#?$/.test(cells[0])) continue;       // 分隔行 / 表头
    if (/事实|claim|上屏/i.test(cells[0]) && /出处|source/i.test(cells[1] || '')) continue;  // 表头
    const claim = cells[1] || '';
    if (!claim || /事实（上屏写法）/.test(claim)) continue;
    rows.push({
      idx: cells[0],
      claim,
      source: cells[2] || '',
      level: cells[3] || '',
      beat: cells[5] || '',
      numbers: extractNumbers(claim),
    });
  }
  return rows;
}

/**
 * 提取"值得核对"的数字：整数、小数、百分比、带千分位。
 * 刻意跳过年份前缀之外的单字数字（如「第一章」的 1）——用长度与上下文过滤，宁可漏不可噪。
 */
export function extractNumbers(text, { strict = false } = {}) {
  const out = [];
  const re = /\d+(?:[.,]\d+)*(?:\s?%)?/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const raw = m[0].replace(/\s/g, '');
    // 正向（台账 → 屏幕）单个数字也算："8 段" 的 8 值得核对。
    // 反向（屏幕 → 台账）要 strict：只有带单位/小数/多位的才算，否则页码、章节号会刷屏。
    if (!strict || /%|[.,]/.test(raw) || raw.length >= 2) out.push(raw);
  }
  return [...new Set(out)];
}

/** 数字归一化：去掉千分位、全角数字、尾随 0 的小数 */
const normNum = (s) => String(s)
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/,/g, '')
  .replace(/\.0+$/, '')
  .replace(/%$/, '');

export function check(facts, ocrLines) {
  const screen = ocrLines.map((l) => normNum(l.text)).join('\n');
  const hits = [], missing = [], noNumbers = [];
  for (const f of facts) {
    if (!f.numbers.length) { noNumbers.push(f); continue; }   // 纯文字条目没有可核对的数字
    const found = f.numbers.filter((n) => screen.includes(normNum(n)));
    (found.length ? hits : missing).push({ ...f, found });
  }

  // 反向：屏幕上的数字哪些在台账里找不到出处
  const tableNums = new Set(facts.flatMap((f) => f.numbers.map(normNum)));
  const orphans = new Map();
  // 反向清单的噪声源：时间码、分辨率、章节号都是版式装饰，不是"上屏事实"。
  // 不滤掉的话一条片子能刷出二十几行，功能就没人看了。
  const NOISE = [
    /\d{1,2}:\d{2}(:\d{2})?/,      // 00:03:59 时间码
    /\d{3,4}\s*[x×]\s*\d{3,4}/,   // 1920x1080 分辨率
    /^\s*\d{1,2}\s*[/／]\s*[A-Za-z]/, // 03 / CREATE 章节号
    // 01 / 09 纯数字章节号（OCR 会把两段拆成两行，斜杠也常被读成全角）
    /^\s*\d{1,2}\s*[/／]\s*\d{1,2}\s*$/, 
    /^\s*\d{1,2}\s*[.、]\s*\S{0,2}$/, // 1. 2. 编号
  ];
  for (const l of ocrLines) {
    if (NOISE.some((re) => re.test(l.text))) continue;
    for (const n of extractNumbers(l.text, { strict: true })) {
      const k = normNum(n);
      // 补零两位数（01 / 02 / 03）是版式的序号装饰（如 steps 段每步的编号），不是上屏事实。
      // 声称的数字不会写成 "01"；不滤掉的话每段 steps 都会刷出三条"无出处"。
      if (/^0\d$/.test(k)) continue;
      if (!tableNums.has(k) && !orphans.has(k)) orphans.set(k, { num: n, t: l.t, text: l.text });
    }
  }
  return { hits, missing, noNumbers, orphans: [...orphans.values()] };
}

/* ---------------- CLI ---------------- */
if (process.argv[1]?.endsWith('facts-check.mjs')) {
  const ocrPath = arg('ocr');
  const factsPath = arg('facts');
  if (!ocrPath || !factsPath) {
    console.error('用法: facts-check.mjs --ocr ocr.txt --facts facts.md [--orphans]');
    process.exit(2);
  }
  const lines = fs.readFileSync(ocrPath, 'utf8').split('\n')
    .map((l) => { const m = l.match(/^(\d+:\d+(?:\.\d+)?)\s+(.*)$/); return m ? { t: m[1], text: m[2] } : null; })
    .filter(Boolean);
  const facts = parseFacts(fs.readFileSync(factsPath, 'utf8'));
  const r = check(facts, lines);
  console.log(`台账 ${facts.length} 条 · 屏幕 ${lines.length} 行`);
  console.log(`  兑现 ${r.hits.length} 条 · 未见 ${r.missing.length} 条 · 无数字条目 ${r.noNumbers.length} 条`);
  for (const m of r.missing) console.log(`  未见  [${m.idx}] ${m.claim}（数字 ${m.numbers.join('/') || '—'}）`);
  for (const h of r.hits) console.log(`  ok    [${h.idx}] ${h.claim} → ${h.found.join('/')}`);
  if (process.argv.includes('--orphans')) {
    console.log(`  台账外数字 ${r.orphans.length} 个（屏幕上有、台账没有出处）`);
    for (const o of r.orphans.slice(0, 20)) console.log(`  无出处 ${o.num}  @${o.t}  ${o.text.slice(0, 40)}`);
  }
}
