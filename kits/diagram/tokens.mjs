/**
 * kits/diagram/tokens.mjs · 图示版式的几何与色彩规格
 *
 * 这套数值是照 Metro 类模板的成片量出来的（1920×1080），但配色换成 cutduo 自己的
 * 纸感暖调，而不是上游的 Swiss grid 中性灰。理由：图示通常长在我们的片子里，
 * 跟 paper / science 共用一条字幕和头像卡，色温必须同源；否则单看好看、成片像拼的。
 *
 * 两套 palette 只差色温，几何完全一样 —— 换皮不换版式。
 */

export const CANVAS = { w: 1920, h: 1080, fps: 60 };

/** 版心：四周留白按成片墨迹量的，右边比左边多留一点，给「单位」「注释」这类右对齐块 */
export const FRAME = {
  x: 132,
  y: 96,
  width: 1920 - 132 - 116,
  height: 1080 - 96 - 200, // 底部 200 留给烧录字幕，图示不压字
  titleSize: 46,
  titlePitch: 62,
  noteSize: 22,
  captionY: 940,
  captionSize: 42,
  unitSize: 22,
  ruleGap: 18,
  gridStep: 48,
  gridAlpha: 0.09,
};

export const PALETTES = {
  /** 默认：纸感暖调，跟 kits/paper 的 bg/ink/accent 同源（不是抄，是同一条视觉线） */
  paper: {
    bg: '#EFEFE5',
    ink: '#15231A',
    accent: '#C0392B',
    body: '#5F6A5C',
    label: '#6E7869',
    muted: 'rgba(21,35,26,0.34)',
    rule: 'rgba(21,35,26,0.16)',
    grid: 'rgba(21,35,26,0.055)',
    badge: '#15231A',
    badgeInk: '#EFEFE5',
  },
  /** 对照用：上游的中性纸色，出对照图时切过去比差异 */
  neutral: {
    bg: '#F3F1E9',
    ink: '#1D1D1B',
    accent: '#C0392B',
    body: '#6B6B64',
    label: '#8A8A80',
    muted: 'rgba(29,29,27,0.34)',
    rule: 'rgba(29,29,27,0.16)',
    grid: 'rgba(29,29,27,0.05)',
    badge: '#1D1D1B',
    badgeInk: '#F3F1E9',
  },
};

export const FONTS = {
  black: '"NotoSC Black", "PingFang SC", "Hiragino Sans GB", sans-serif',
  med: '"NotoSC Medium", "PingFang SC", "Hiragino Sans GB", sans-serif',
  reg: '"NotoSC Regular", "PingFang SC", "Hiragino Sans GB", sans-serif',
  mono: '"JetBrainsMono-Regular", Menlo, monospace',
};

/** 每个 family 的容量上限：超过就换组或拆镜头，不偷偷缩字（跟 paper 的容量门槛同一条纪律） */
export const CAPACITY = {
  'data-bar': { min: 2, max: 8, label: 12 },
  'data-line': { min: 2, max: 8, label: 12 },
  hierarchy: { min: 1, max: 8, label: 12 },
  cycle: { min: 2, max: 8, label: 10 },
  definition: { min: 1, max: 6, label: 14 },
  compare: { min: 2, max: 6, label: 12 },
  process: { min: 2, max: 6, label: 10 },
  causal: { min: 2, max: 6, label: 12 },
  parts: { min: 2, max: 6, label: 14 },
  experiment: { min: 1, max: 4, label: 14 },
  evidence: { min: 1, max: 3, label: 90 },
  formula: { min: 0, max: 6, label: 12 },
  recap: { min: 2, max: 6, label: 16 },
  // 元镜头：内容是"本片自己"，不接 items
  bignum: { min: 0, max: 1, label: 0 },
  timeline: { min: 0, max: 0, label: 0 },
  glyph: { min: 0, max: 0, label: 20 },
  framecount: { min: 0, max: 0, label: 0 },
};
