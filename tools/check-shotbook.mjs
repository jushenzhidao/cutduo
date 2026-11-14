#!/usr/bin/env node
/**
 * tools/check-shotbook.mjs · 出片前的版式体检（渲染前，不看像素）
 *
 * 来源：video-talkcraft 的两条机器闸被平移过来，改造成吃我们自己的 preset：
 *   ① 版式轮换：同 family 连用 ≥3 段 = 观众看到的是同一张图换字；
 *      单一 family 占比过高 = 全片只有一种语法。
 *   ② 空台预判：相邻锚点间隔过长 = 那几秒画面里没有新东西（gate 的 --blank 要到
 *      渲完才知道，这张表在渲染前一秒就能算出来）。
 *
 * 用法：
 *   node tools/check-shotbook.mjs kits/diagram/presets/render-cost-20s.json
 *   node tools/check-shotbook.mjs <preset.json> --timing out/x.timing.json [--gap 2.5]
 *
 * 退出码：有 FAIL 时 1，否则 0（WARN 不影响）。
 */

import fs from 'node:fs';
import path from 'node:path';

const PASS = new Set(['bignum', 'timeline', 'glyph', 'framecount']); // 元镜头：一段只讲一件事，不参与轮换

// 能量档（与 kits/diagram/tokens.mjs 的 ENERGY 同表；此处内联是为了让工具零依赖可跑）
const ENERGY = {
  'data-bar': '中', 'data-line': '中', hierarchy: '低', cycle: '中', definition: '低',
  compare: '中', process: '中', causal: '中', parts: '中', experiment: '中',
  evidence: '低', formula: '低', recap: '中',
  bignum: '高', timeline: '高', glyph: '高', framecount: '高',
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/^\d/.test(a) && a !== arg('timing'));
  const presetPath = files[0];
  if (!presetPath) {
    console.error('usage: node tools/check-shotbook.mjs <preset.json> [--timing out/x.timing.json] [--gap 2.5]');
    process.exit(2);
  }
  const timingPath = arg('timing', '');
  const gap = Number(arg('gap', 2.5));

  const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
  const segs = preset.segments ?? [];
  if (!segs.length) throw new Error('preset 没有 segments');

  const timing = timingPath ? JSON.parse(fs.readFileSync(timingPath, 'utf8')) : null;
  const byIndex = new Map((timing?.segments ?? []).map((s) => [s.index, s]));

  const fails = [];
  const warns = [];
  const rows = [];

  // ── ① 版式轮换
  let run = 1;
  const runs = [];
  for (let i = 1; i <= segs.length; i++) {
    const same = i < segs.length && segs[i].family === segs[i - 1].family;
    if (same) run++;
    else {
      if (run >= 3) runs.push({ family: segs[i - 1].family, len: run, end: i });
      run = 1;
    }
  }
  for (const r of runs) fails.push(`版式连用 ${r.len} 段：${r.family}（不是不能连，是连这么久观众会以为是同一张图）`);

  const typable = segs.filter((s) => !PASS.has(s.family));
  if (typable.length >= 6) {
    const count = new Map();
    for (const s of typable) count.set(s.family, (count.get(s.family) ?? 0) + 1);
    for (const [f, n] of count) {
      if (n / typable.length > 0.34) warns.push(`${f} 占 ${Math.round((n / typable.length) * 100)}%（${n}/${typable.length}），全片语法偏单一`);
    }
  }

  // ── ② 空台预判：段内相邻锚点的间隔
  let acc = Number(preset.titleCard?.duration ?? 0);
  segs.forEach((s, i) => {
    const st = byIndex.get(i);
    const dur = Number(st?.duration ?? s.duration) || 8;

    // 元镜头不适用锚点判据：framecount 每帧都在变、glyph 逐字点亮、timeline 逐段入场，
    // 它们的事件不在 items 上。硬套"无锚点=空台"只会制造一堆假警报。
    if (PASS.has(s.family)) {
      rows.push({ 段: i + 1, family: s.family, 时长: dur.toFixed(2), 锚点: '元', 最长空窗: '—', 位置: `${acc.toFixed(1)}s` });
      acc += dur;
      return;
    }
    const anchors = [];

    // 锚点由 render 用 resolveAnchors 解析；这里只看"用户声明了几个词锚"，
    // 解析精度不影响体检结论（要精确核对用 render 的 --timing 报错）
    for (const it of s.items ?? []) {
      for (const k of ['rowAt', 'at']) if (typeof it[k] === 'string') anchors.push(it[k]);
    }

    const events = [];
    if (st) {
      const line = st.line ?? '';
      for (const at of anchors) {
        const pos = line.indexOf(at);
        if (pos >= 0 && st.chars?.[pos]?.t != null) events.push(Number(st.chars[pos].t));
      }
    }
    events.sort((a, b) => a - b);

    let maxGap = 0;
    let gapAt = 0;
    if (events.length) {
      let prev = 0;
      for (const e of events) {
        if (e - prev > maxGap) {
          maxGap = e - prev;
          gapAt = prev;
        }
        prev = e;
      }
      if (dur - prev > maxGap) {
        maxGap = dur - prev;
        gapAt = prev;
      }
    } else {
      maxGap = dur; // 一个锚点都没有 = 整段靠 stagger 或纯静止
      gapAt = 0;
    }

    rows.push({
      段: i + 1,
      family: s.family,
      时长: dur.toFixed(2),
      锚点: events.length,
      最长空窗: maxGap.toFixed(1),
      位置: `${(acc + gapAt).toFixed(1)}s`,
    });

    if (maxGap > gap) {
      const where = `${(acc + gapAt).toFixed(1)}s 起约 ${maxGap.toFixed(1)}s`;
      if (events.length === 0) warns.push(`第 ${i + 1} 段（${s.family}）整段无锚点 —— ${where} 没有新东西进场，gate 的 --blank 会盯这一段`);
      else warns.push(`第 ${i + 1} 段（${s.family}）${where} 无事件 —— 要么补一个锚点，要么这段自带持续运动（写进注释说明）`);
    }
    acc += dur;
  });

  // ── 输出
  const pad = (v, n) => String(v).padEnd(n);
  console.log(`\n${path.basename(presetPath)}  ·  ${segs.length} 段 / ${acc.toFixed(2)}s\n`);
  console.log(pad('段', 4) + pad('family', 14) + pad('能', 4) + pad('时长', 8) + pad('锚点', 6) + pad('最长空窗', 10) + '位置');
  for (const r of rows) {
    console.log(pad(r.段, 4) + pad(r.family, 14) + pad(ENERGY[r.family] ?? '-', 4) + pad(r.时长, 8) + pad(r.锚点, 6) + pad(r.最长空窗, 10) + r.位置);
  }
  const high = rows.filter((r) => ENERGY[r.family] === '高').length;
  if (rows.length >= 6 && high / rows.length > 0.5) {
    console.log(`\n提示  高能量段占 ${Math.round((high / rows.length) * 100)}% —— 整片都在换屏时，观众没有"停下来读"的段落`);
  }
  console.log('');
  for (const m of fails) console.log(`FAIL  ${m}`);
  for (const m of warns) console.log(`warn  ${m}`);
  if (!fails.length && !warns.length) console.log('ok    版式轮换与事件密度都没问题');
  console.log('');
  process.exit(fails.length ? 1 : 0);
}

main();
