/**
 * api/registry.mjs · 能力注册表
 *
 * 唯一职责：把「kit 名字」映射到 adapter，并把可用清单如实报出来。
 *
 * 2026-11-15 起改为**目录自动发现**：`api/kits/*.mjs` 里每个文件导出一个
 * `capability` 与一个 `adapter`，文件名必须等于 capability.id。加一支 kit
 * 只需新增一个文件，不再需要回来改 import 与 MODULES —— 之前漏改过一次
 * （diagram 已能渲染但没进清单，smoke 的目录检查会 FAIL，而人只看 README
 * 不会发现）。代价是任何 adapter 写坏会在 API 启动时立刻抛错，这是有意的：
 * 静默少一支比启动失败更难查。
 *
 * 文件名以 `_` 开头的视为私有模块（当前是 `_runner.mjs`），不参与发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/root.mjs';
import { ApiError, CODE } from './errors.mjs';

const KITS_DIR = path.join(REPO_ROOT, 'api', 'kits');

const files = fs.readdirSync(KITS_DIR)
  // 排除 `_` 开头（约定为私有脚本，如 _runner.mjs）与 `.` 开头（隐藏文件）。
  // 后者不是洁癖：macOS 打包会为每个带 xattr 的文件生成 `._<name>` 的 AppleDouble 伴随文件，
  // 它同样以 `.mjs` 结尾。2026-11-16 部署时 `._clay.mjs` 就这样通过了过滤并被 import，
  // 容器启动直接 SyntaxError 重启循环 —— 报错里只有堆栈，没有文件名。
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && !f.startsWith('.'))
  .sort();

const MODULES = [];
for (const file of files) {
  const id = path.basename(file, '.mjs');
  const mod = await import(pathToFileURL(path.join(KITS_DIR, file)).href);
  if (!mod.capability || !mod.adapter) {
    throw new Error(
      `api/kits/${file} 必须同时导出 capability 与 adapter（当前：` +
      `${mod.capability ? '有 capability' : '缺 capability'} / ${mod.adapter ? '有 adapter' : '缺 adapter'}）`,
    );
  }
  if (mod.capability.id !== id) {
    throw new Error(
      `api/kits/${file} 的 capability.id 是 "${mod.capability.id}"，` +
      `与文件名 "${id}" 不一致。约定文件名 = kit id，否则 capability 与实现会走散。`,
    );
  }
  MODULES.push(mod);
}

/** 别名 → 规范 id。别名只做输入宽容，不扩张契约。 */
const ALIASES = {
  'skia-paper': 'paper',
  paperkit: 'paper',
  'science-explainer': 'science',
  sci: 'science',
  'desktop-kit': 'desk',
  desktop: 'desk',
  'canvas-editorial': 'editorial',
  edit: 'editorial',
  'mg-kit': 'mg',
  'screen-collage': 'collage',
  'promo-main': 'collage',
  'iso-explode': 'iso',
  'exploded-view': 'iso',
  'diagram-kit': 'diagram',
  charts: 'diagram',
  figures: 'diagram',
};

const BY_ID = new Map();
for (const m of MODULES) {
  if (BY_ID.has(m.capability.id)) {
    throw new Error(`kit id 重复：${m.capability.id}（api/kits/${m.capability.id}.mjs）`);
  }
  BY_ID.set(m.capability.id, { capability: m.capability, adapter: m.adapter });
}

/** 能力清单（不含实现引用，可安全序列化）。 */
export function list() {
  return [...BY_ID.values()].map(({ capability }) => ({
    id: capability.id,
    name: capability.name,
    description: capability.description,
    contentModel: capability.contentModel,
    output: capability.output,
    paramsSchema: capability.paramsSchema,
    schemaStatus: capability.schemaStatus,
    ...(capability.schemaNote ? { schemaNote: capability.schemaNote } : {}),
    // 跨片可复用的标定值：有就透出，别让 agent 去猜路径。
    ...(capability.calibration ? { calibration: capability.calibration } : {}),
    presets: capability.presets || [],
    defaultPreset: capability.defaultPreset || null,
    audio: capability.audio,
    extras: capability.extras || {},
    // 入口也是契约的一部分：agent 拿 CLI 入口判断该走哪条命令。
    ...(capability.entry ? { entry: capability.entry } : {}),
  }));
}

export function ids() {
  return [...BY_ID.keys()];
}

/**
 * @param {string} idOrAlias
 * @returns {{capability:object, adapter:object}}
 */
export function get(idOrAlias) {
  if (!idOrAlias) {
    throw new ApiError(CODE.BAD_REQUEST, '缺少 kit', {
      hint: 'kit 是必填字段，决定用哪套版式',
      fix: `可用：${ids().join(' / ')}`,
    });
  }
  const key = String(idOrAlias).toLowerCase();
  const id = BY_ID.has(key) ? key : ALIASES[key];
  if (!id || !BY_ID.has(id)) {
    throw new ApiError(CODE.KIT_NOT_FOUND, `未知 kit：${idOrAlias}`, {
      hint: 'kit 必须取自 capabilities() 返回的 id 或已知别名',
      fix: `可用：${ids().join(' / ')}`,
      details: { requested: idOrAlias, available: ids(), aliases: Object.keys(ALIASES) },
    });
  }
  return BY_ID.get(id);
}

/** 读某支的 params schema；没有就返回 null（由调用方决定是放行还是拒绝）。 */
export function schemaOf(capability) {
  return capability.paramsSchema || null;
}
