/**
 * tools/knowledge/knowledge.mjs · 内容模型层（不做视觉）
 *
 * 这层只回答三个问题：
 *   1. 这个选题有多复杂？（五项打分 → 推荐时长档）
 *   2. 这个母版在这一档该有哪些拍？（按 priority 裁拍，不是均匀压缩）
 *   3. 写好的稿子有没有走样？（拍数 / 时长 / 钩子层 / 画面字数）
 *
 * 渲染不在这里：骨架产出 kits/science 的 segments，交给 `render.mjs --kit science`。
 * 这是「讲法」与「呈现」分离——换版式不改母版，换母版不改版式。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = path.join(HERE, 'guide.json');
const SCIENCE_DEMO = path.join(HERE, '../../kits/science/template/presets/demo.json');

export const guide = JSON.parse(fs.readFileSync(GUIDE_PATH, 'utf8'));

/* ---------------- 复杂度 → 时长档 ---------------- */

/**
 * @param {{concepts:0|1|2, prereq:0|1|2, causal:0|1|2, evidence:0|1|2, dispute:0|1|2}} scores
 */
export function scoreComplexity(scores) {
  const dims = guide.complexity.dims;
  let total = 0;
  const detail = [];
  for (const d of dims) {
    const v = Number(scores?.[d.key] ?? 1);
    if (![0, 1, 2].includes(v)) throw new Error(`${d.key} 必须 0/1/2，收到 ${scores?.[d.key]}`);
    total += v;
    detail.push({ key: d.key, label: d.label, score: v, level: d.levels[v] });
  }
  const band = total <= 3 ? '简单' : total <= 6 ? '中等' : '复杂';
  return { total, band, detail, tiers: guide.complexity.recommend[band] };
}

/** 用户选的档跟复杂度差两级以上要提醒（上游 13-duration §四） */
export function mismatchedHint(band, tier) {
  const order = ['速览', '精讲', '标准', '深挖'];
  const ideal = guide.complexity.recommend[band][0];
  if (order.indexOf(tier) - order.indexOf(ideal) >= 2) {
    return `选题偏${band}，选「${tier}」会出现重复和长时间静止；建议「${ideal}」，或加一个相关子话题。`;
  }
  if (order.indexOf(ideal) - order.indexOf(tier) >= 2) {
    return `选题偏${band}，选「${tier}」只能讲到结论，「为什么」基本讲不到，评论区容易「没听懂」。`;
  }
  return null;
}

const PAPER_BY_SCIENCE = {
  cover: 'hero', talk: 'point', compare: 'compare', diagram: 'steps',
  matrix: 'checklist', focus: 'number', tip: 'quote', outro: 'outro',
};

/* ---------------- 母版 → 拍表 ---------------- */

/** 按 priority 裁到目标拍数；expand 允许把一拍拆成多拍（深挖档） */
export function planBeats(templateKey, tier) {
  const tpl = guide.templates[templateKey];
  if (!tpl) throw new Error(`不认识的母版 ${templateKey}（有 A–F：${Object.keys(guide.templates).join(' ')}）`);
  const spec = guide.durations[tier];
  if (!spec) throw new Error(`不认识的时长档 ${tier}（有：${Object.keys(guide.durations).join(' ')}）`);
  const [minBeats, maxBeats] = spec.beats;

  // A/B 有拍表；C/D/E/F 上游只给了流程，用 flow 并补默认优先级
  const raw = (tpl.beats || tpl.flow || []).map((b, i) => ({
    id: b.id || `${templateKey}${String(i + 1).padStart(2, '0')}`,
    role: b.role, priority: b.priority ?? 1, expand: b.expand ?? 1,
    screen: b.screen || '', intent: b.intent || '', scienceType: b.scienceType || 'talk',
    // 解析成最终类型：显式 paperType > 按 scienceType 兜底 > point。
    // 只存 null 的话，调用方会 `b.paperType || 'point'` 把兜底映射跳过（C–F 母版曾全部退成 point）。
    paperType: b.paperType || PAPER_BY_SCIENCE[b.scienceType] || 'point',
  }));
  if (!raw.length) throw new Error(`母版 ${templateKey} 没有拍表也没有流程`);

  // 深挖档：先用 expand 把拍数撑到下限
  let beats = [...raw];
  if (maxBeats > beats.length) {
    for (const b of raw) {
      if (beats.length >= minBeats) break;
      for (let k = 1; k < (b.expand || 1) && beats.length < minBeats; k++) {
        beats.push({ ...b, id: `${b.id}.${k}`, split: true });
      }
    }
  }
  // 短档：从 priority 3 开始砍
  const need = Math.min(maxBeats, beats.length);
  if (beats.length > need) {
    const order = [...beats].sort((a, b) => b.priority - a.priority);
    const drop = new Set();
    for (const b of order) {
      if (beats.length - drop.size <= need) break;
      if (b.priority > 1) drop.add(b.id);
    }
    beats = beats.filter((b) => !drop.has(b.id));
  }
  return { beats, spec, dropped: raw.length - beats.length };
}

/* ---------------- paper 目标 ---------------- */

/** 没有显式 paperType 时按 science 段型兜底 */
/**
 * paper 的 args 里带**绝对时间**（`at`、`leftAt`、`cards[][1]`…），照抄样例会让所有元素
 * 在新段开始时"早就出现过"，画面立刻静止 —— 实测 freeze 16.7 s，而样片只有 4.1 s。
 * 按 (新 t0 − 原 t0) 整体平移，元素重新按时出现。
 */
const TIME_KEY = /^(at|leftAt|rightAt|strikeAt|itemAt|from|until)$/;
function rebaseArgs(node, srcT0, dstT0, scale = 1) {
  const map = (t) => +(dstT0 + (t - srcT0) * scale).toFixed(2);
  if (Array.isArray(node)) {
    if ((node.length === 2 || node.length === 3) && typeof node[0] === 'string' && typeof node[1] === 'number') {
      node[1] = map(node[1]);
    }
    for (const v of node) if (v && typeof v === 'object') rebaseArgs(v, srcT0, dstT0, scale);
    return node;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (TIME_KEY.test(k) && typeof v === 'number') node[k] = map(v);
      else if (v && typeof v === 'object') rebaseArgs(v, srcT0, dstT0, scale);
    }
  }
  return node;
}

/** 从 kits/paper 的样例里按 scene 类型取一份最小 args 当占位 */
function paperArgTemplates() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(HERE, '../../kits/paper/presets/v8t.json'), 'utf8'));
    const map = {};
    for (const sc of d.scenes || []) if (!map[sc.type]) map[sc.type] = {
      args: sc.args || {}, t0: Number(sc.t0) || 0, t1: Number(sc.t1) || 0,
    };
    return map;
  } catch { return {}; }
}

/* ---------------- 骨架生成 ---------------- */

/** 从 science 的 demo 里按 type 取一份最小 args 当占位，保证骨架能直接渲染 */
function argTemplates() {
  try {
    const d = JSON.parse(fs.readFileSync(SCIENCE_DEMO, 'utf8'));
    const map = {};
    for (const s of d.segments || []) if (!map[s.type]) map[s.type] = s.args || {};
    return map;
  } catch { return {}; }
}

/**
 * 生成可直接渲染的 params 骨架：拍结构、时长、每拍该放什么都在 note 里，
 * args 借用 science demo 同类型的占位值——替换文案即可交付。
 */
// 拍长不按均分：冷开场要短促、章节要展开、片尾要利落。权重来自上游各母版的拍级描述，
// 归一化后按总时长分配；单一权重的片子（全部 1.0）仍然退化成均分。
const ROLE_WEIGHT = {
  hook: 0.65, title: 0.55, ask: 0.8, loop: 0.6, close: 0.7, heal: 0.7,
  chapter1: 1.15, chapter2: 1.15, chapter3: 1.15, chapter4: 1.2,
  twist: 1.1, elevate: 0.9, land: 0.85,
  setup: 1.0, process: 1.3, wait: 0.9, reveal: 0.8, control: 1.1,
  principle: 1.2, prop: 0.9, empathy: 1.2, solution: 0.8,
  turn: 0.7, trail: 1.4, converge: 0.9,
  map: 0.7, level: 1.3, drop: 0.8, boss: 1.2, sheet: 1.0,
  faces: 1.2,
};

export function buildSkeleton({ template, tier, title, subtitle = '', theme, target = 'science' }) {
  const { beats, spec } = planBeats(template, tier);
  const tpl = guide.templates[template];
  const argsTpl = argTemplates();
  const [lo, hi] = spec.seconds;
  const total = Math.round((lo + hi) / 2);
  const fps = 30;
  // 按**帧**分配，不按秒：秒四舍五入到两位小数，29 段累加会漂出 1 帧，最后一段落到时间线外
  // （src/temporal.mjs 实测抓到 segments[29] 越界 4951 > 4950）。整数分配后把余数按小数部分补给各拍。
  const totalFrames = total * fps;
  const wsum = beats.reduce((a, b) => a + (ROLE_WEIGHT[b.role] ?? 1), 0);
  const exact = beats.map((b) => (totalFrames * (ROLE_WEIGHT[b.role] ?? 1)) / wsum);
  const frames = exact.map((x) => Math.floor(x));
  const rem = totalFrames - frames.reduce((a, b) => a + b, 0);
  const byFrac = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < rem; k++) frames[byFrac[k % byFrac.length][1]]++;
  const durs = frames.map((f) => +(f / fps).toFixed(4));

  // 一拍拆成多段：母版拍长 12–16 s，而 science/paper 这类静态版式单段超过 8 s 就是死画面
  // （实测 16 s 一段 → freezedetect 报 15.6 s 静止）。拆段后 beat 字段仍指向同一拍，
  // 母版结构不变，只是渲染单元变细。
  const segMax = guide.narration.segmentMax || 8;
  const segments = [];
  beats.forEach((b, i) => {
    const parts = Math.max(1, Math.ceil(frames[i] / (segMax * fps)));
    const base = Math.floor(frames[i] / parts);
    const extra = frames[i] - base * parts;          // 余数给前几段，累加仍然精确
    for (let k = 0; k < parts; k++) {
      const args = JSON.parse(JSON.stringify(argsTpl[b.scienceType] || {}));
      // 首拍承接标题，末拍承接片名；不改动 args 的字段语义
      if (i === 0 && k === 0 && title) { args.title = title; if (subtitle && 'sub' in args) args.sub = subtitle; }
      if (i === beats.length - 1 && title) args.hint = title;
      const part = parts > 1 ? `（第 ${k + 1}/${parts} 段，内容接着上一段写）` : '';
      segments.push({
        type: b.scienceType,
        dur: +((base + (k < extra ? 1 : 0)) / fps).toFixed(4),
        note: `${b.id} ${b.role}${b.split ? '（拆拍）' : ''}${part}｜${b.intent}｜画面：${b.screen || '—'}`,
        beat: b.id,
        args,
      });
    }
  });

  if (target === 'paper') return buildPaperSkeleton({ template, tier, title, subtitle, theme, beats, frames, fps });

  return {
    durationSeconds: +(totalFrames / fps).toFixed(4),
    fps,
    theme: theme || { paper: 'cream', accent: '#E8503A' },
    brand: { name: 'knowledge', template, tier },
    subtitle: subtitle || title || '',
    segments,
    _meta: {
      generator: 'kits/knowledge',
      template, tier,
      templateName: tpl.name,
      beats: beats.length,
      words: spec.words,
      canTell: spec.canTell,
      cut: spec.cut,
      pairing: guide.pairing[template],
      note: 'args 是占位：把 title / lines / items 等文案换成本期内容；拍数与结构由母版决定，不要随手加减。',
    },
  };
}

/**
 * paper 目标骨架：按拍表产出 scenes（t0/t1 绝对）+ 空 captions。
 * 为什么要这条：guide 里 A 母版 pairing 写的是 science，但实战里 paper 更合
 * （science 的 18 个图标全是医学向）。以前这段映射是各片 build.py 里手写的 9 段 args，
 * 换片就得重抄；现在由母版表驱动，`paperType` 决定段型。
 */
function buildPaperSkeleton({ template, tier, title, subtitle, theme, beats, frames, fps }) {
  const tpl = guide.templates[template];
  const argsTpl = paperArgTemplates();
  const fpsP = 60;                                   // paper 版式是 60fps
  const scale = fpsP / fps;                          // 帧数按目标帧率换算
  const scenes = [];
  let t = 0;
  const GAP = 0.25;
  // paper 的段设计是 4–7 s（样片 3.5–7.5 s），而母版一拍 12–15 s。
  // 不拆段直接出片，实测 freeze 16.7 s —— 超过 10 s 告警线，等于一段死画面。
  // 按 ≤PAPER_SEG_MAX 秒拆，余数给前面的子段，保证总长不变。
  const PAPER_SEG_MAX = 7;
  beats.forEach((b, i) => {
    const type = b.paperType || 'point';
    const dur = +((frames[i] * scale) / fpsP).toFixed(4);
    const parts = Math.max(1, Math.ceil(dur / PAPER_SEG_MAX));
    const each = +(dur / parts).toFixed(4);
    for (let k = 0; k < parts; k++) {
      const tplEntry = argsTpl[type] || { args: {}, t0: 0, t1: 0 };
      const args = JSON.parse(JSON.stringify(tplEntry.args));
      // 只平移，**不缩放**：试过按段长拉伸元素时间，A 母版 5.3→6.1s 反而更差、C 母版不变。
      // 原因不在元素挤在前面，而在"同拍子段内容相同 + 每段元素出现完就静止"，相邻子段首尾相接就连成死画面。
      // 这件事骨架解决不了：paper 的镜头设计是 4–7 s，母版一拍 12–15 s，一拍必须拆成**内容不同**的
      // 两三个镜头；把同一份占位 args 复制两次只会得到两段一样的画面。
      rebaseArgs(args, tplEntry.t0, t, 1);
      if (i === 0 && k === 0 && title) {
        if (Array.isArray(args.lines)) args.lines = [[title, +(t + 0.7).toFixed(2)]];
        if ('sub' in args) args.sub = subtitle || tpl.name;
      }
      const tag = parts > 1 ? `（第 ${k + 1}/${parts} 段，内容接着上一段写）` : '';
      scenes.push({
        type, t0: +t.toFixed(2), t1: +(t + (k === parts - 1 ? dur - each * (parts - 1) : each)).toFixed(2),
        note: `${b.id} ${b.role}${tag}｜${b.intent}｜画面：${b.screen || '—'}`,
        beat: b.id, args,
      });
      // 子段之间**不留 gap**：gap 是"拍间隔"，不是"段间隔"。
      // 每段都加会让 12 拍拆成 32 段后凭空多出 5 秒（实测 167.75 → 172.75）。
      t += (k === parts - 1 ? dur - each * (parts - 1) : each);
      if (k === parts - 1) t += GAP;
    }
  });
  return {
    brand: { name: 'knowledge' },
    accent: theme?.accent || '#E8503A',
    accent2: '#2F6F8F',
    durationSeconds: +(t - GAP).toFixed(4),
    fps: fpsP,
    scenes,
    captions: [],
    _meta: {
      generator: 'tools/knowledge', template, tier, target: 'paper',
      templateName: tpl.name, beats: beats.length,
      pairing: guide.pairing[template],
      note: 'args 取自 paper 样例作占位（元素时间已平移到各段起点）：换成本期文案；captions 留空，由内容侧按配音生成。',
      // 说清楚预期，免得把骨架的静止当成 bug
      freezeHint: '骨架的「最长静止」会偏高：母版一拍 12–15s，paper 镜头 4–7s，一拍要拆 2–3 段，'
        + '拆出的子段用的是同一份占位 args，首尾相接就成死画面（实测 A 母版 6.1s、C 母版 17.2s）。'
        + '填完各段不同文案后仍不会自动变好——需要每拍给出**内容不同**的几个镜头，这是写稿的事，不是骨架的事。',
    },
  };
}

/* ---------------- 合规审查 ---------------- */

const CN = (s) => String(s || '').length;
/** 只统计"会被念出来"的字段，不数 color/icon 这类键 */
const TEXT_KEYS = new Set(['title', 'sub', 'prefix', 'hint', 'conclusion', 'eyebrow', 'accentLine', 'text', 'label', 'note']);

function collectText(obj, acc = []) {
  if (Array.isArray(obj)) { for (const v of obj) collectText(v, acc); return acc; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (TEXT_KEYS.has(k) && typeof v === 'string') acc.push(v);
      else collectText(v, acc);
    }
  }
  return acc;
}

/**
 * 审查一份稿子是否还符合母版。
 * errors = 结构走样（阻断）；warns = 可能有问题（提示）。
 */
export function audit(params, { template, tier } = {}) {
  const errors = [], warns = [];
  const segs = params?.segments || [];
  if (!segs.length) return { ok: false, errors: ['没有 segments'], warns };

  const tKey = template || params?._meta?.template;
  const tTier = tier || params?._meta?.tier;
  const spec = tTier ? guide.durations[tTier] : null;

  // 渲染段数会因为拆段变多，所以拍数按 beat 字段去重算（手写稿没有 beat 时退回段数）
  const beatsSeen = new Set(segs.map((s) => s.beat).filter(Boolean));
  const nBeats = beatsSeen.size || segs.length;
  if (spec) {
    const [b0, b1] = spec.beats;
    if (nBeats < b0 || nBeats > b1) {
      errors.push(`拍数 ${nBeats} 不在「${tTier}」的 ${b0}–${b1} 拍内（渲染段 ${segs.length}）`);
    }
    const [s0, s1] = spec.seconds;
    const dur = Number(params.durationSeconds || 0);
    if (dur && (dur < s0 - 1 || dur > s1 + 1)) {
      errors.push(`总时长 ${dur}s 不在「${tTier}」的 ${s0}–${s1}s 内`);
    }
  }

  const sum = segs.reduce((a, s) => a + Number(s.dur || 0), 0);
  if (Math.abs(sum - Number(params.durationSeconds || 0)) > 0.5) {
    errors.push(`各段 dur 之和 ${sum.toFixed(2)}s ≠ durationSeconds ${params.durationSeconds}s`);
  }

  // 钩子层：首段必须承担"让人先猜/先选"，别一上来就是片头
  const first = segs[0];
  const hookTypes = new Set(['cover', 'talk', 'focus']);
  if (!hookTypes.has(first?.type)) {
    warns.push(`首段类型 ${first?.type} 通常不是钩子位（${guide.rules.hook3s.slice(0, 18)}…）`);
  }

  // 语速：按文案字符数除以时长，偏离 5.5 字/秒太多就提示
  const chars = collectText(segs.map((s) => s.args || {})).reduce((a, t) => a + CN(t), 0);
  if (chars && params.durationSeconds) {
    const cps = chars / Number(params.durationSeconds);
    if (cps < 2.5) warns.push(`文案密度 ${cps.toFixed(1)} 字/秒，明显偏低（目标 ${guide.narration.charsPerSecond}）——画面会空`);
    if (cps > 8) warns.push(`文案密度 ${cps.toFixed(1)} 字/秒，过高——念不完，或要提速到听不清`);
  }

  // 画面字上限：单条文案超过 8 字就不是"关键词"了
  const longWords = collectText(segs.map((s) => s.args || {}))
    .filter((t) => CN(t) > guide.narration.screenCharsMax * 2 && !/[。！？，、]/.test(t));
  if (longWords.length) {
    warns.push(`${longWords.length} 条画面字超过 ${guide.narration.screenCharsMax * 2} 字且无标点，像是整句（画面字只要关键词）`);
  }

  // 单段过长 → 静态版式上会变成死画面（实测 16s 一段被 freezedetect 判 15.6s 静止）
  const segMax = guide.narration.segmentMax || 8;
  const longs = segs.filter((s) => Number(s.dur || 0) > segMax);
  if (longs.length) {
    warns.push(`${longs.length} 段超过 ${segMax}s（最长 ${Math.max(...longs.map((s) => s.dur))}s）——静态版式上会出现长静止，拆段或改用有推拉的版式`);
  }

  if (tKey && !guide.templates[tKey]) errors.push(`未知母版 ${tKey}`);
  return { ok: !errors.length, errors, warns, stats: { beats: nBeats, segs: segs.length, chars, cps: +(chars / (params.durationSeconds || 1)).toFixed(2) } };
}
