#!/usr/bin/env node
/**
 * tools/esfx-warm.mjs · 预热 earshot 常用音色到缓存
 *
 *   node tools/esfx-warm.mjs           # 渲染缺的（已缓存跳过）
 *   node tools/esfx-warm.mjs --list    # 只看清单与缓存状态
 *
 * 为什么需要：首次遇到新音色要渲一次（单条约 0.1–3 s，40 条合计 9.5 s），
 * 出片时多等这几秒会被感知。预热一次，之后全命中缓存（0.4 s）。
 * 音色表与 docs/音效-earshot-2026-11-14.md 的角色对照表一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { earshotPython } from '../src/audio-mix.mjs';

/** 角色 → 音色（每行一个主 id；同一角色有多个备选时取首个，其余按需手写） */
export const ROLE_IDS = [
  'cut_hit/punch',          // 印章砸下 / 关键词 slam
  'pro_impact/short',       // 大揭晓 / 片名落定
  'pro_pop/thup',           // 数字落定
  'pro_hover_tick/soft',    // 数字滚动
  'pro_typing_key/soft',    // 逐字古文 / 打字
  'pro_pop_in/round',       // 条款卡 / 元素弹入
  'swipe/paper',            // 告示 / 翻页 / 卡片滑入
  'swish/flick',            // 荧光笔划重点
  'pro_zip/arc',            // 红圈画出
  'shutter/snap',           // 推近定格 / 截图
  'whoosh_fast/tight',      // 转场 / 快速飞入
  'whoosh_fast/crisp',      // 转场（备选）
  'reverse_swell/cymbal',   // 反转前的吸气
  'riser/dark',             // 紧张铺垫
  'pro_sub_drop/low',       // 倒台 / 悲剧
  'cut_hit/rumble',         // 冲突 / 变味
  'mallet/glock',           // 奖励 / 金币
  'toggle/on',              // 两难按钮
  'knock/wood',             // 敲门 / 木头
  'glitch/burst',           // 辟谣反转 / 出错
  'logo_sting/soft_bloom',  // 系列片头
  'shimmer/m3',             // 片尾闪光
];

// 与 audio-mix.mjs 的 efxCachePath 保持一致（只差参数，预热不带参数）
const cacheDir = process.env.EARSHOT_CACHE || path.join(os.homedir(), '.cache', 'cutduo', 'esfx');
const cacheOf = (id) => {
  const h = crypto.createHash('sha1').update([id, '', '', '', ''].join('|')).digest('hex').slice(0, 10);
  return path.join(cacheDir, `${id.replace('/', '__')}-${h}.wav`);
};

const listOnly = process.argv.includes('--list');
const missing = ROLE_IDS.filter((id) => !fs.existsSync(cacheOf(id)) || !fs.existsSync(cacheOf(id) + '.json'));

console.log(`音色表 ${ROLE_IDS.length} 条 · 已缓存 ${ROLE_IDS.length - missing.length} · 待渲染 ${missing.length}`);
if (listOnly || !missing.length) process.exit(0);

const py = earshotPython();
if (!py) {
  console.error('✗ 找不到 earshot（装法见 docs/音效-earshot-2026-11-14.md，或设 EARSHOT_PY）');
  process.exit(1);
}

const { execFileSync } = await import('node:child_process');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const spec = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'esfx-warm-')), 'spec.json');
fs.writeFileSync(spec, JSON.stringify({ items: missing.map((id) => ({ id, out: cacheOf(id) })) }));

const t = Date.now();
const out = execFileSync(py, [path.join(ROOT, 'tools/esfx-render.py'), '--spec', spec], {
  encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
});
const j = JSON.parse(out.trim().split('\n').pop());
console.log(`✓ 渲染 ${j.items.length} 条 / ${((Date.now() - t) / 1000).toFixed(1)}s → ${cacheDir}`);
for (const e of j.errors || []) console.error(`  ✗ ${e.id}: ${e.error}`);
const warns = (j.items || []).filter((i) => i.checks_ok === false);
if (warns.length) {
  console.log(`  自检提示 ${warns.length} 条（warning 级，不阻断）：`);
  for (const w of warns) console.log(`    · ${w.checks_summary}`);
}
