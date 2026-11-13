/**
 * profile.mjs — 外观档案（style profile）
 *
 * 为什么需要：同一套版式会有多代外观。science 模板在 2026-11-13 换了讲解员
 * （矢量 → 3D 位图）和封面副标位置，旧成片再也渲不出来。把"哪一代长什么样"
 * 存成数据（guide.json 的 profiles），params 里只写 `"profile": "legacy-2026-11"`
 * 就能复现，不用把几何常量散进每个 preset。
 *
 * 规则：
 *   - 档案按版式分桶（cover / talk / diagram …），只放几何与外观键，不放文案；
 *   - params 里显式写的字段优先（档案是默认值，不是强制值）；
 *   - 未知 profile 直接报错并列出可用项，不静默退回默认——静默退化的代价是
 *     "片子出来了但人不是那一代"，肉眼要看到成片才发现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../src/root.mjs';

const GUIDE = path.resolve(REPO_ROOT, 'kits', 'science', 'template', 'guide.json');

function readGuide() {
  return JSON.parse(fs.readFileSync(GUIDE, 'utf8'));
}

/** 可用档案名（去掉 _note 这类说明键）。 */
export function listProfiles() {
  const g = readGuide();
  return Object.keys(g.profiles || {}).filter((k) => !k.startsWith('_'));
}

/**
 * 把档案合并进 scenes。返回新数组，不改入参。
 * @param {Array} scenes normalizeSegments 之后的场景轴
 * @param {string} name 档案名
 */
export function applyProfile(scenes, name) {
  const g = readGuide();
  const p = (g.profiles || {})[name];
  if (!p) {
    throw new Error(`未知外观档案「${name}」，可用：${listProfiles().join(' / ') || '（guide.json 里没有 profiles）'}`);
  }
  return scenes.map((s) => {
    const bucket = p[s.type] || {};
    const base = {};
    for (const [k, v] of Object.entries(bucket)) if (!k.startsWith('_')) base[k] = v;
    return { ...s, args: { ...base, ...(s.args || {}) } };
  });
}
