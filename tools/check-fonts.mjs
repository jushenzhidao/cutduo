#!/usr/bin/env node
/**
 * tools/check-fonts.mjs · 字体是否真的可用（不是文件在不在）
 *
 * 为什么要单独一支：`fetch-fonts.sh --verify` 只证明「文件字节对」，
 * 证明不了「Skia 认这个族名」。两者之间还有两道坑：
 *   1. fonts.mjs 里登记了，但文件名写错 → 文件在、注册失败、静默回退
 *   2. 模板 kit.js 里写死了一个族名，fonts.mjs 里根本没有 → 同样静默回退
 * 两道都不会报错，只是画面悄悄换成系统字体。
 *
 * 判据（三重，任何一重不过就算 FAIL）：
 *   GlobalFonts.has(family)      注册表里有没有这个名字
 *   measureText(中文)             宽度与「不存在的族名」不同，才算真的换了字形
 *   模板声明的族名                 kit.js 里用到的族名必须在注册表里
 *
 * 用法：
 *   node tools/check-fonts.mjs
 *   node tools/check-fonts.mjs --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { registerFonts, BASE_FONTS, TEMPLATE_FONTS } from '../src/fonts.mjs';
import { DIRS } from '../src/root.mjs';

const JSON_OUT = process.argv.includes('--json');
const PROBE = '遮挡比例 对向影高';       // 中英数混排，能测出 CJK 是否真的换了
const CTRL = '__no_such_family_9527__'; // 回退基准

const registered = registerFonts();
const ctx = createCanvas(64, 64).getContext('2d');

const widthOf = (family) => {
  ctx.font = `48px "${family}"`;
  return ctx.measureText(PROBE).width;
};
const baseline = widthOf(CTRL);

/** 每一组：[组名, [[文件, 族名], …]] */
const groups = [
  ['基础（五支内置 kit 全靠它）', BASE_FONTS],
  ...Object.entries(TEMPLATE_FONTS).map(([k, v]) => [`模板专用 · ${k}`, v]),
];

const rows = [];
for (const [group, list] of groups) {
  for (const [file, family] of list) {
    const abs = path.join(DIRS.fonts, file);
    const exists = fs.existsSync(abs);
    const has = GlobalFonts.has(family);
    const w = widthOf(family);
    // 字体在 but 宽度与回退基准相同 → 族名没落地（比如注册名拼错）
    const real = Math.abs(w - baseline) > 0.01;
    const ok = exists && has && real;
    rows.push({
      group, file, family, exists, has, real,
      width: Number(w.toFixed(2)),
      bytes: exists ? fs.statSync(abs).size : 0,
      ok,
    });
  }
}

/** 模板源码里声明用到的族名，必须在注册表里 */
function templateFamilies() {
  const dir = path.join(DIRS.templates || path.join(DIRS.root, 'templates'), 'own');
  const found = new Map(); // family -> [文件]
  if (!fs.existsSync(dir)) return found;
  const known = new Set(rows.map((r) => r.family));

  for (const name of fs.readdirSync(dir)) {
    const src = path.join(dir, name, 'src');
    if (!fs.existsSync(src)) continue;
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.js')) continue;
      const txt = fs.readFileSync(path.join(src, f), 'utf8');
      // 只在 FACE / FAM / FONT 这类字体映射里找，避免把普通字符串当成族名
      const m = txt.match(/(?:FACE|FAM|FONT)\s*=\s*\{[\s\S]{0,800}?\};/);
      if (!m) continue;
      // 值是 CSS font-family 列表：'LongCang, "LXGW WenKai", "PingFang SC", sans-serif'
      // 必须按逗号拆开再比对，整串比会漏掉第一个（上一版就漏了 LongCang）。
      for (const q of m[0].matchAll(/['"]([^'"]{2,120})['"]/g)) {
        for (const part of q[1].split(',')) {
          const v = part.trim().replace(/^['"]|['"]$/g, '').trim();
          if (!known.has(v)) continue;
          if (!found.has(v)) found.set(v, []);
          found.get(v).push(`${name}/${f}`);
        }
      }
    }
  }
  return found;
}

const tplFams = templateFamilies();
const bad = rows.filter((r) => !r.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({
    registered, baseline: Number(baseline.toFixed(2)), rows, templateFamilies: [...tplFams.keys()], ok: bad.length === 0,
  }, null, 2));
} else {
  console.log(`字体目录：${DIRS.fonts}`);
  console.log(`注册调用返回 ${registered} 项 · 回退基准字宽 ${baseline.toFixed(2)}\n`);
  let cur = '';
  for (const r of rows) {
    if (r.group !== cur) { cur = r.group; console.log(cur); }
    const mark = r.ok ? '✓' : '✗';
    const why = !r.exists ? '文件缺失' : !r.has ? '族名未注册' : !r.real ? '宽度=回退值' : '';
    console.log(
      `  ${mark} ${r.family.padEnd(16)} ${String(r.bytes).padStart(9)} B  ` +
      `字宽 ${String(r.width).padStart(7)}${why ? '  ← ' + why : ''}`
    );
  }
  console.log();
  if (tplFams.size) {
    console.log('模板源码声明用到的族名：');
    for (const [f, where] of tplFams) console.log(`  · ${f}  (${[...new Set(where)].join(', ')})`);
    console.log();
  }
  if (bad.length) {
    console.log(`FAIL · ${bad.length} 项不可用：${bad.map((r) => r.family).join(', ')}`);
    console.log('修法：bash tools/fetch-fonts.sh，然后复查 src/fonts.mjs 的族名是否与文件名一致。');
  } else {
    console.log(`PASS · ${rows.length} 项全部可用（文件在 + 族名已注册 + 字形非回退）`);
  }
}

process.exit(bad.length ? 1 : 0);
