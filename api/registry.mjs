/**
 * api/registry.mjs · 能力注册表
 *
 * 唯一职责：把「kit 名字」映射到 adapter，并把可用清单如实报出来。
 * 清单里的 schemaStatus 必须诚实：editorial 与 mg 没有 params.schema.json，
 * 标成 complete 会让 agent 以为参数已被校验过，出了片才发现字段被静默忽略。
 */
import { ApiError, CODE } from './errors.mjs';
import * as paper from './kits/paper.mjs';
import * as science from './kits/science.mjs';
import * as desk from './kits/desk.mjs';
import * as editorial from './kits/editorial.mjs';
import * as mg from './kits/mg.mjs';
import * as clay from './kits/clay.mjs';
import * as collage from './kits/collage.mjs';
import * as nightCard from './kits/night-card.mjs';

const MODULES = [paper, science, desk, editorial, mg, clay, collage, nightCard];

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
};

const BY_ID = new Map();
for (const m of MODULES) {
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
