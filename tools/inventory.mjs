#!/usr/bin/env node
/**
 * inventory.mjs · 版式总清单（唯一一份「有哪些东西能出片」的机器可读事实）
 *
 *   node tools/inventory.mjs            # 写 docs/inventory.json + docs/inventory.md
 *   node tools/inventory.mjs --check    # 只比较，不一致 exit 1（smoke / CI 用）
 *   node tools/inventory.mjs --json     # 打到 stdout，不落盘
 *
 * 为什么需要它：版式清单以前散在 README / kits/README / STYLES / AGENTS / API 五处，
 * 每加一支就有一处忘改。2026-11-15 实测：README 写 7 支、kits/README 写 8 支、
 * API 清单 9 支、STYLES 11 支、真实可渲染 13 支。人读文档无法判断该信哪个。
 *
 * 口径（不要在这里发明新分类）：
 *   kit      = kits/<id>/ 目录，必须接进 API（smoke 会拦）
 *   template = templates/own/<id>/src/ 有 kit.js + layouts.js + stage.js 三件套
 *   renderable = 能用 `render.mjs --kit <id>` 或自己的入口出片
 *
 * 这份文件只报事实，不替人选版式。选版式的判断在 kits/STYLES.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/root.mjs';
import { list } from '../api/registry.mjs';

const OUT_JSON = path.join(REPO_ROOT, 'docs', 'inventory.json');
const OUT_MD = path.join(REPO_ROOT, 'docs', 'inventory.md');
const CHECK = process.argv.includes('--check');
const PRINT_JSON = process.argv.includes('--json');

const kitsDir = path.join(REPO_ROOT, 'kits');
const ownDir = path.join(REPO_ROOT, 'templates', 'own');

const caps = list();
const byId = new Map(caps.map((c) => [c.id, c]));

const kitIds = fs.readdirSync(kitsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const styles = [];

for (const id of kitIds) {
  const cap = byId.get(id);
  const script = cap?.entry?.script || null;
  styles.push({
    uid: `kit:${id}`,
    id,
    kind: 'kit',
    renderable: true,
    api: !!cap,
    entry: script === 'render.mjs' ? `render.mjs --kit ${id}` : (script ? `${script} --params <preset>` : null),
    entryType: script === 'render.mjs' ? 'root-cli' : (script ? 'kit-cli' : 'unknown'),
    defaultPreset: cap?.defaultPreset || null,
    schemaStatus: cap?.schemaStatus || 'missing',
    presets: (cap?.presets || []).length,
    output: cap?.output || null,
  });
}

const ownIds = fs.readdirSync(ownDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const id of ownIds) {
  const src = path.join(ownDir, id, 'src');
  const threePiece = ['kit.js', 'layouts.js', 'stage.js'].every((f) => fs.existsSync(path.join(src, f)));
  // 同名不代表同一支：templates/own/editorial 是上游 DOM 版存档，
  // kits/editorial 才是 Skia 实现。API 的 id 只认后者的 schema 路径。
  const cap = byId.get(id);
  const apiCap = cap && (threePiece || String(cap.paramsSchema || '').startsWith('templates/own/')) ? cap : null;
  let output = apiCap?.output || null;
  if (!output) {
    const manifest = path.join(ownDir, id, 'motion.json');
    if (fs.existsSync(manifest)) {
      try {
        const o = JSON.parse(fs.readFileSync(manifest, 'utf8')).output;
        if (o?.width && o?.height) output = { width: o.width, height: o.height };
      } catch {
        /* manifest 坏了由 check-template 负责；这里不重复报 */
      }
    }
  }
  const preset = path.join(ownDir, id, 'presets', 'default.json');
  styles.push({
    uid: `template:${id}`,
    id,
    kind: 'template',
    renderable: threePiece,
    api: !!apiCap,
    entry: threePiece ? `render.mjs --kit ${id}` : null,
    entryType: threePiece ? 'root-cli' : 'none',
    defaultPreset: fs.existsSync(preset) ? path.relative(REPO_ROOT, preset) : (apiCap?.defaultPreset || null),
    schemaStatus: apiCap?.schemaStatus || (threePiece ? 'template' : 'n/a'),
    presets: (apiCap?.presets || []).length,
    output,
    ...(threePiece ? {} : { note: '不是三件套（缺 kit.js/layouts.js/stage.js），不能走 --kit 直出' }),
  });
}

const counts = {
  kits: styles.filter((s) => s.kind === 'kit').length,
  kitsInApi: styles.filter((s) => s.kind === 'kit' && s.api).length,
  templatesRenderable: styles.filter((s) => s.kind === 'template' && s.renderable).length,
  templatesInApi: styles.filter((s) => s.kind === 'template' && s.api).length,
  apiRegistered: styles.filter((s) => s.api).length,
  totalRenderable: styles.filter((s) => s.renderable).length,
};

const data = {
  schema: 'cutduo-inventory/1',
  note: '由 tools/inventory.mjs 生成，不要手改。uid 是唯一键（kit:<id> / template:<id>）；同名时以 kind 区分。改版式后跑 npm run inv。',
  counts,
  styles,
};

function markdown() {
  // 主表只列可出片的；不可直出的目录单独列在下面，避免与同名 kit 混淆。
  const rows = styles.filter((s) => s.renderable).map((s) => {
    const out = s.output ? `${s.output.width}×${s.output.height}${s.output.fpsDefault ? `@${s.output.fpsDefault}` : ''}` : '—';
    const api = s.api ? '✓' : '—';
    return `| \`${s.id}\` | ${s.kind === 'kit' ? 'kit' : 'template'} | ${s.renderable ? '✓' : '—'} | ${api} | ${s.entry ? `\`${s.entry}\`` : '—'} | ${out} | ${s.schemaStatus} |`;
  });
  return [
    '# 版式总清单（自动生成）',
    '',
    '> 由 `tools/inventory.mjs` 生成，**不要手改**。改了版式跑 `npm run inv`；',
    '> 漂移检查跑 `npm run docs:check`（README / STYLES / API 是否漏了某一支）。',
    '',
    `- kits：**${counts.kits}** 支（接入 API：**${counts.kitsInApi}** 支${counts.kitsInApi === counts.kits ? '，无遗漏' : '，**有遗漏**'}）`,
    `- 三件套模板：**${counts.templatesRenderable}** 支可直出`,
    `- 可渲染合计：**${counts.totalRenderable}** 支`,
    '',
    '| id | 类型 | 可出片 | 接 API | 入口 | 画幅/帧率 | schema |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '## 未接 API 但可出片的模板',
    '',
    styles.filter((s) => s.kind === 'template' && s.renderable && !s.api).length
      ? styles.filter((s) => s.kind === 'template' && s.renderable && !s.api)
        .map((s) => `- \`${s.id}\`：\`${s.entry}\``).join('\n')
      : '（无）',
    '',
    '## 目录里存在但不可直出的模板',
    '',
    styles.filter((s) => s.kind === 'template' && !s.renderable).length
      ? styles.filter((s) => s.kind === 'template' && !s.renderable)
        .map((s) => `- \`${s.id}\`：${s.note || '不是三件套'}`).join('\n')
      : '（无）',
    '',
  ].join('\n');
}

if (PRINT_JSON) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

const nextJson = JSON.stringify(data, null, 2) + '\n';
const nextMd = markdown();
const prevJson = fs.existsSync(OUT_JSON) ? fs.readFileSync(OUT_JSON, 'utf8') : '';
const prevMd = fs.existsSync(OUT_MD) ? fs.readFileSync(OUT_MD, 'utf8') : '';

if (CHECK) {
  if (prevJson === nextJson && prevMd === nextMd) {
    console.log(`PASS  inventory 与代码一致（${counts.totalRenderable} 支可渲染 / ${counts.apiRegistered} 支接 API）`);
    process.exit(0);
  }
  console.error('FAIL  inventory 已过期：');
  if (prevJson !== nextJson) {
    let hint = '';
    try {
      const a = JSON.parse(prevJson), b = data;
      const idsA = (a.styles || []).map((s) => s.id);
      const idsB = b.styles.map((s) => s.id);
      const added = idsB.filter((id) => !idsA.includes(id));
      const removed = idsA.filter((id) => !idsB.includes(id));
      if (added.length) hint += `  新增：${added.join(' / ')}\n`;
      if (removed.length) hint += `  移除：${removed.join(' / ')}\n`;
      if (!added.length && !removed.length) hint += '  条目相同，差异在字段（入口/API/画幅）。\n';
    } catch {
      hint = '  inventory.json 不是合法 JSON。\n';
    }
    console.error(hint);
  }
  if (prevMd !== nextMd) console.error('  inventory.md 也过期（表格由脚本生成）。\n');
  console.error('  修法：node tools/inventory.mjs');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, nextJson);
fs.writeFileSync(OUT_MD, nextMd);
console.log(`inventory → docs/inventory.{json,md} · ${counts.totalRenderable} 支可渲染 / ${counts.apiRegistered} 支接 API`);
