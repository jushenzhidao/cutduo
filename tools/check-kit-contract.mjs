#!/usr/bin/env node
/**
 * tools/check-kit-contract.mjs · 版式契约体检
 *
 * 查两件事，都是 2026-11-14 实测踩过坑的：
 *
 * 1. **渲染器认的段型 vs schema 允许的段型是否一致**
 *    不一致的两个方向都危险：
 *      - schema 更宽 → 参数能过校验，渲染器不认识，静默画白纸（editorial 的 grid 就这样产出了废片）
 *      - 渲染器更宽 → 能渲染但 API 会拒，云端挂而本地正常
 *
 * 2. **段型 switch 是否还有兜底不报错的 default**
 *    `default: bg('paper')` 这类写法会让错误变成"一张白纸"，而像素门禁完全看不出来。
 *
 * 用法：
 *   node tools/check-kit-contract.mjs          # 体检，有问题退出码 1
 *   node tools/check-kit-contract.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KITS = path.join(ROOT, 'kits');

/**
 * 段型清单。两种写法都认：
 *   1. `switch (x.type) { case 'a': ... }` —— 只取该块内的 case
 *   2. `const SHOT_TYPES = ['a','b']` 这类白名单常量
 * 不能笼统抓全文件的 `case 'x':`——desk 的 Dock 图标（safari / wechat）也是 case，
 * 抓进来会把 13 个图标名当成 13 个段型，跟 schema 一比就全错（踩过一次）。
 */
function casesOf(src) {
  const out = new Set();
  // 1) switch (…type…) 块内的 case
  const swRe = /switch\s*\(\s*[\w$.]*\bt(?:ype)?\s*\)\s*\{/g;
  let sw;
  while ((sw = swRe.exec(src))) {
    let depth = 1, i = sw.index + sw[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const block = src.slice(sw.index, i);
    const cRe = /case\s+'([a-zA-Z][a-zA-Z0-9_-]*)'\s*:/gi;
    let c;
    while ((c = cRe.exec(block))) out.add(c[1]);
  }
  // 2) 白名单常量
  const arrRe = /(?:SHOT_TYPES|SEGMENT_TYPES|SCENE_TYPES|TYPES|KINDS)\s*=\s*\[([^\]]+)\]/g;
  let a;
  while ((a = arrRe.exec(src))) {
    for (const q of a[1].matchAll(/'([a-zA-Z][a-zA-Z0-9_-]*)'/g)) out.add(q[1]);
  }
  // 3) 对象映射：`const PAINTERS = { hero: S.hero, ... }` + `PAINTERS[cur.type]`
  //    collage 是这种写法，只认 switch 的话会提取出 0 种，跟 schema 一比就全错。
  const mapNames = [];
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Z][A-Z0-9_]+)\s*=\s*\{/g)) mapNames.push(m[1]);
  for (const name of mapNames) {
    // 只有真的被当分发表用过（name[...type...]）才算
    if (!new RegExp(`${name}\\s*\\[`).test(src)) continue;
    const start = src.indexOf(`${name} = {`);
    if (start < 0) continue;
    let i = src.indexOf('{', start), depth = 0, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const body = src.slice(start, end);
    // 只取第一层的键（缩进 2 空格）
    for (const k of body.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9_-]*)\s*:/gm)) out.add(k[1]);
  }
  return out;
}

/** 找 schema 里 scenes[].type 或 shots[].type 的 enum */
function enumOf(schema) {
  const seen = [];
  const walk = (o, p) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o.enum) && o.enum.length && o.enum.every((x) => typeof x === 'string')) {
      // 只收看起来像段型枚举的（含 hero / point / cover 这类）
      if (o.enum.some((x) => /^(hero|point|number|cover|talk|intro|grid|chart)$/.test(x))) {
        seen.push({ path: p, values: o.enum });
      }
    }
    for (const [k, v] of Object.entries(o)) walk(v, p + '/' + k);
  };
  walk(schema, '');
  return seen;
}

/** 找有没有"兜底画背景"的 default */
function lazyDefaults(src) {
  const hits = [];
  const re = /^\s*default:\s*([^\n;{]+);?/gm;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1].trim();
    if (/^(bg\(|paperBg\(|background\(|clear\()/.test(body)) hits.push(body);
  }
  return hits;
}

const rows = [];
if (fs.existsSync(KITS)) {
  for (const dir of fs.readdirSync(KITS)) {
    const d = path.join(KITS, dir);
    if (!fs.statSync(d).isDirectory()) continue;

    // 渲染器：目录下最大的 .mjs，或 render.mjs / <dir>.mjs
    const mjs = fs.readdirSync(d).filter((f) => f.endsWith('.mjs'));
    if (!mjs.length) continue;
    // 扫**整个目录**的 .mjs：desk 的渲染逻辑在 desktop.mjs 而不在 render.mjs，
    // 只读入口文件会把它误判成"一个段型都不支持"。
    const skip = /^(verify|out\.|test)/;
    const all = mjs.filter((f) => !skip.test(f));
    const srcFile = path.join(d, ['render.mjs', `${dir}.mjs`].find((f) => all.includes(f)) || all[0]);
    const src = all.map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n');

    const cases = casesOf(src);
    // science 用对象映射分发（`const fn = L[cur.type]`），clay 把 type 映射成 mechanism，
    // 都不是 switch——只靠 case 提取会漏。所以补一条：看源码里有没有这个段型的字面量。
    // 但先得有 schema 才知道该查哪些字，所以这里的判断放到拿到 enum 之后。

    const schemaFile = ['params.schema.json', 'schema.json'].map((f) => path.join(d, f)).find((f) => fs.existsSync(f));
    if (!cases.size && !schemaFile) continue;       // 既无段型也无 schema（如 webcanvas 宿主），跳过
    const enums = schemaFile ? enumOf(JSON.parse(fs.readFileSync(schemaFile, 'utf8'))) : [];
    const enumVals = enums.length ? new Set(enums[0].values) : null;

    const lazy = lazyDefaults(src);
    const onlyRenderer = enumVals ? [...cases].filter((c) => !enumVals.has(c)) : [];
    // 判断"schema 有、渲染器没有"用字面量查找（覆盖 switch / === / 对象键三种写法）
    const mentions = (t) => src.includes(`'${t}'`) || src.includes(`"${t}"`) || new RegExp(`\\b${t}\\s*[:=]`, 'm').test(src);
    const onlySchema = enumVals ? [...enumVals].filter((c) => !mentions(c)) : [];

    rows.push({
      kit: dir,
      renderer: path.relative(ROOT, srcFile),
      cases: [...cases].sort(),
      schema: enumVals ? [...enumVals].sort() : null,
      onlyRenderer,
      onlySchema,
      lazyDefault: lazy,
      ok: !onlyRenderer.length && !onlySchema.length && !lazy.length,
    });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 1));
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

console.log(`\n版式契约体检 · ${rows.length} 支\n`);
let bad = 0;
for (const r of rows) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.kit.padEnd(12)} ${r.renderer.replace('kits/', '')}`);
  console.log(`    渲染器 ${r.cases.length} 种：${r.cases.join(' ')}`);
  if (r.schema) console.log(`    schema ${r.schema.length} 种：${r.schema.join(' ')}`);
  else console.log('    schema 无段型枚举（未对表）');
  if (r.onlySchema.length) {
    console.log(`    ⚠ schema 有、渲染器没有 → 能过校验但会静默画白纸：${r.onlySchema.join(' ')}`);
  }
  if (r.onlyRenderer.length) {
    console.log(`    ⚠ 渲染器有、schema 没有 → 本地能渲、API 会拒：${r.onlyRenderer.join(' ')}`);
  }
  if (r.lazyDefault.length) {
    console.log(`    ⚠ 兜底不报错的 default：${r.lazyDefault.join(' / ')}`);
  }
  if (!r.ok) bad++;
}
console.log(`\n${rows.length - bad}/${rows.length} 一致`);
process.exit(bad ? 1 : 0);
