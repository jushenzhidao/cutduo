/**
 * web/lib/build.mjs — 把客户填的表单编译成 science kit 的 params
 *
 * 设计原则：**客户不写 JSON、也不该懂 itemAt**。
 *   · 每段只填「画面文字」+「口播句」；口播句一行一句，行数就是该段的字幕条数；
 *   · 时长不填——由 tools/vo.py 按配音实测重排；
 *   · 容量（标题 6 字、副标 16 字、标签 5 字…）在这里校验并给出人话错误，
 *     而不是让渲染器静默缩小字号。
 *
 * 与 guide.json 的容量表一一对应；改那边记得同步这里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../src/root.mjs';

const GUIDE = path.resolve(REPO_ROOT, 'kits', 'science', 'template', 'guide.json');

export const TYPES = ['cover', 'talk', 'matrix', 'tip', 'outro'];

/** 容量表：id → { label, max, note } */
export const CAPACITY = {
  title: { label: '主词', max: 6 },
  prefix: { label: '前缀', max: 6 },
  sub: { label: '副标', max: 16 },
  eyebrow: { label: '小眉标', max: 10 },
  line: { label: '大字行', max: 9 },
  matrixTitle: { label: '阵列标题', max: 10 },
  matrixLabel: { label: '卡片标签', max: 5 },
  tipHead: { label: '便签抬头', max: 6 },
  tipTitle: { label: '便签标题', max: 12 },
  tipItem: { label: '条目', max: 10 },
  outroLine: { label: '结语行', max: 6 },
  outroNote: { label: '免责声明', max: 24 },
  caption: { label: '口播句', max: 26 },
};

export const ICONS = ['shield', 'drop', 'clock', 'check', 'question', 'eyes', 'scanner', 'probe', 'xray',
  'radiation', 'child', 'gut', 'stomach', 'gallbladder', 'appendix', 'kidney', 'uterus', 'intussusception', 'hip-joint'];
export const DISCS = ['#C8EBDD', '#FFD1DC', '#FFE770', '#CFE6FB', '#FFE0C2', '#E6DAFF'];
export const STICKERS = ['question', 'eyes', 'shield', 'check', 'drop', 'clock'];
export const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声（温暖播报，推荐）' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声（新闻腔，需男性讲解员）' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声（年轻）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声（活泼）' },
];
/** 旁白是男声时必须换男性讲解员，否则声音与画面不是同一个人（adversarial 会报 voice.gender）。 */
export const MALE_VOICES = new Set(['zh-CN-YunyangNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural', 'zh-CN-YunxiaNeural']);

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const len = (s) => [...clean(s)].length;

class Problem {
  constructor() { this.errors = []; }
  check(kind, value, segIndex) {
    const c = CAPACITY[kind];
    if (!c) return;
    const n = len(value);
    if (n > c.max) {
      this.errors.push({ seg: segIndex, field: c.label, msg: `${c.label}「${clean(value).slice(0, 12)}…」${n} 字，超过 ${c.max} 字上限` });
    }
  }
  require(value, name, segIndex) {
    if (!clean(value)) this.errors.push({ seg: segIndex, field: name, msg: `第 ${segIndex + 1} 段缺少「${name}」` });
  }
}

/**
 * @param {object} spec 客户表单（见 web/public/index.html 的 collect()）
 * @returns {{ok:boolean, errors:Array, params?:object}}
 */
export function build(spec) {
  const p = new Problem();
  const segs = Array.isArray(spec.segments) ? spec.segments : [];
  if (!segs.length) return { ok: false, errors: [{ msg: '至少要有一段' }] };
  if (segs[0].type !== 'cover') p.errors.push({ msg: '第一段必须是封面' });
  if (segs[segs.length - 1].type !== 'outro') p.errors.push({ msg: '最后一段必须是结尾' });

  const params = [];
  const captions = [];

  segs.forEach((s, i) => {
    const spoken = String(s.speech || '').split('\n').map((x) => x.trim()).filter(Boolean);
    spoken.forEach((text) => {
      p.check('caption', text, i);
      captions.push({ start: 0, end: 1, text, seg: i });
    });

    if (s.type === 'cover') {
      p.require(s.title, '主词', i); p.require(s.sub, '副标', i);
      p.check('title', s.title, i); p.check('sub', s.sub, i); if (s.prefix) p.check('prefix', s.prefix, i);
      params.push({
        type: 'cover', dur: 7.6,
        args: { prefix: clean(s.prefix), title: clean(s.title), sub: clean(s.sub), sticker: s.sticker || 'question', hint: clean(s.hint) },
      });
    } else if (s.type === 'talk') {
      const lines = [s.line1, s.line2].map(clean).filter(Boolean);
      p.require(lines[0], '第一行大字', i);
      lines.forEach((l) => p.check('line', l, i));
      if (s.eyebrow) p.check('eyebrow', s.eyebrow, i);
      params.push({
        type: 'talk', dur: 8.0,
        args: {
          paper: s.paper || 'cream', figure: 'right', figureHeight: 0.94,
          eyebrow: clean(s.eyebrow), lines, accentLine: s.accentLine === undefined ? 1 : Number(s.accentLine),
          size: 86, sticker: s.sticker || 'question', gesture: s.gesture || 'explain',
          ...(s.figureImage ? { figureImage: s.figureImage } : {}),
        },
      });
    } else if (s.type === 'matrix') {
      const items = (s.items || []).filter((x) => clean(x && x.label));
      if (items.length < 2) p.errors.push({ seg: i, field: '卡片', msg: `第 ${i + 1} 段至少要两张卡` });
      items.forEach((it) => p.check('matrixLabel', it.label, i));
      p.check('matrixTitle', s.matrixTitle, i);
      params.push({
        type: 'matrix', dur: 6.0,
        args: {
          paper: s.paper || 'mint', title: clean(s.matrixTitle),
          items: items.slice(0, 6).map((it, k) => ({ icon: it.icon || 'shield', label: clean(it.label), disc: it.disc || DISCS[k % DISCS.length] })),
        },
      });
    } else if (s.type === 'tip') {
      const items = (s.items || []).map((x) => clean(x && x.label)).filter(Boolean).slice(0, 3);
      if (items.length !== 3) p.errors.push({ seg: i, field: '条目', msg: `第 ${i + 1} 段需要正好 3 条（便签纸只能容 3 行，现在 ${items.length} 条）` });
      items.forEach((t) => p.check('tipItem', t, i));
      p.check('tipHead', s.tipHead, i); p.check('tipTitle', s.tipTitle, i);
      p.require(s.tipTitle, '便签标题', i);
      params.push({ type: 'tip', dur: 10.0, args: { paper: s.paper || 'sky', head: clean(s.tipHead), title: clean(s.tipTitle), items } });
    } else if (s.type === 'outro') {
      p.check('outroLine', s.line1, i); p.check('outroLine', s.line2, i); p.check('outroNote', s.note, i);
      params.push({ type: 'outro', dur: 5.0, args: { line1: clean(s.line1), line2: clean(s.line2), note: clean(s.note) } });
    } else {
      p.errors.push({ seg: i, msg: `未知段类型 ${s.type}` });
    }
  });

  if (p.errors.length) return { ok: false, errors: p.errors };

  const guide = JSON.parse(fs.readFileSync(GUIDE, 'utf8'));
  const out = {
    _note: `由 web 表单生成 · ${new Date().toISOString()}`,
    durationSeconds: params.reduce((a, s) => a + s.dur, 0),
    fps: 30,
    fadeOutSeconds: 0.32,
    theme: { ...(guide.palette || { pop: '#FD2551', sun: '#FFD84D', jade: '#26A38C', jadeDeep: '#0E7A5F', blue: '#2B7FD4', ink: '#2C3A3E' }), ...(spec.theme || {}) },
    brand: { show: true, text: clean(spec.brandText) || '科普频道', tag: clean(spec.brandTag) || 'SCIENCE EXPLAINER' },
    subtitle: { size: 62, color: '#FFFFFF', stroke: 6, strokeColor: '#1B2B30', y: 1002 },
    captions,
    segments: params,
  };
  return { ok: true, errors: [], params: out };
}

/** 默认示例：客户点「填示例」就能看到一份能直接出片的完整表单。 */
export const SAMPLE = {
  brandText: '儿童骨科科普', brandTag: 'SCIENCE EXPLAINER',
  voice: 'zh-CN-XiaoxiaoNeural', rate: '+5%', bgm: true,
  segments: [
    {
      type: 'cover', prefix: '孩子走路', title: '一瘸一拐', sub: '先别当成摔伤', sticker: 'question',
      hint: '儿童骨科科普 · 2 分钟看懂', speech: '孩子突然走路一瘸一拐，家长第一反应是摔伤了\n但有一种常见原因，和摔伤没关系',
    },
    {
      type: 'talk', eyebrow: '最容易被漏掉的一点', line1: '喊膝盖疼', line2: '问题可能在髋', accentLine: 1,
      sticker: 'question', gesture: 'explain', speech: '孩子说膝盖疼，问题不一定在膝盖\n髋关节的病变，常常表现为膝部疼痛',
    },
    {
      type: 'matrix', matrixTitle: '跛行的常见原因',
      items: [{ icon: 'shield', label: '滑膜炎' }, { icon: 'drop', label: '化脓性' }, { icon: 'clock', label: '缺血坏死' }, { icon: 'xray', label: '外伤' }],
      speech: '滑膜炎、化脓性关节炎、股骨头缺血坏死、外伤',
    },
    {
      type: 'tip', tipHead: '就医信号', tipTitle: '这三种情况立刻去',
      items: [{ label: '完全不能负重' }, { label: '伴发热精神差' }, { label: '疼痛持续加重' }],
      speech: '有三种情况，不要再等\n完全不能站立或负重\n伴随发热、寒战或精神萎靡\n疼痛明显且在持续加重',
    },
    { type: 'outro', line1: '早发现', line2: '早评估', note: '科普内容仅供参考 · 具体诊疗请遵医嘱', speech: '' },
  ],
};
