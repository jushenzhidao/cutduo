#!/usr/bin/env node
/**
 * tools/new-film.mjs · 新片脚手架：一条命令建出可运行的 content/<slug>/
 *
 *   node tools/new-film.mjs --slug bfd2 --template A --tier 精讲 --title "本福特定律"
 *
 * 建出来的目录：
 *   script.json      拍表 + 文案（大模型/人填 text 与 screens）
 *   facts.md         出处台账模板
 *   build.mjs        通用：配音定长 → 时间轴（链式）→ scenes → 音轨
 *   bgm.mjs          通用分层配乐（按段落边界让各层进出）
 *   make.sh          一条命令出片
 *   README.md        三步流程
 *
 * 关键设计：build.mjs **不含这支片的内容**。段型来自 guide.json 的 paperType，
 * 文案来自 script.json。这是把 `content/birthday-paradox/build.py` 里 9 段手写映射抽出来的结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guide, planBeats, buildSkeleton } from './knowledge/knowledge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* 段型骨架：从 v8t 取同段型的 args，把时间平移成"段内相对秒"。
   给用户一个能直接改的结构，而不是空对象——空对象会逼人去猜字段名，而猜错不报错，
   是一路崩到渲染函数里（实测：quote.lines 写成元组、compare.left 写成数组，
   错误信息是 l.replace is not a function，完全不指向病因）。 */
const V8T = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'kits/paper/presets/v8t.json'), 'utf8'));
  } catch { return { scenes: [] }; }
})();

function shiftTimes(node, delta) {
  if (Array.isArray(node)) {
    if (node.length >= 2 && typeof node[0] === 'string' && typeof node[1] === 'number') {
      node[1] = +(node[1] + delta).toFixed(2);
    }
    node.forEach((v) => v && typeof v === 'object' && shiftTimes(v, delta));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/^(at|leftAt|rightAt|strikeAt|itemAt)$/.test(k) && typeof v === 'number') {
        node[k] = +(v + delta).toFixed(2);
      } else if (v && typeof v === 'object') shiftTimes(v, delta);
    }
  }
}

/* 把 args 里所有时刻按比例压进 limit。
   build 会把一拍按 ≤7s 拆成多段，每段**重放同一份 screens 并从 0 起算**：
   元素钉在 4.2s 而子段只有 3.6s ⇒ 永不出现，画面只剩标题（实测踩过）。
   实测子段最短 3.5s，所以上限取 3.0（留 15% 余量）。等比缩放，不改变相对节奏。 */
function collectTimes(node, out) {
  if (Array.isArray(node)) {
    if (node.length >= 2 && typeof node[0] === 'string' && typeof node[1] === 'number') out.push(node[1]);
    node.forEach((v) => v && typeof v === 'object' && collectTimes(v, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/^(at|leftAt|rightAt|strikeAt|itemAt)$/.test(k) && typeof v === 'number') out.push(v);
      else if (v && typeof v === 'object') collectTimes(v, out);
    }
  }
}

function scaleTimes(node, k) {
  if (Array.isArray(node)) {
    if (node.length >= 2 && typeof node[0] === 'string' && typeof node[1] === 'number') node[1] = +(node[1] * k).toFixed(2);
    node.forEach((v) => v && typeof v === 'object' && scaleTimes(v, k));
  } else if (node && typeof node === 'object') {
    for (const [key, v] of Object.entries(node)) {
      if (/^(at|leftAt|rightAt|strikeAt|itemAt)$/.test(key) && typeof v === 'number') node[key] = +(v * k).toFixed(2);
      else if (v && typeof v === 'object') scaleTimes(v, k);
    }
  }
}

const SCREEN_LIMIT = 3.0;   // 子段最短实测 3.5s，留 15% 余量

function clampTimes(node, limit = SCREEN_LIMIT) {
  const t = [];
  collectTimes(node, t);
  if (!t.length) return node;
  const max = Math.max(...t);
  if (max <= limit) return node;
  scaleTimes(node, limit / max);
  return node;
}

function templateFor(type) {
  const sc = (V8T.scenes || []).find((x) => x.type === type);
  if (!sc) return {};
  const a = JSON.parse(JSON.stringify(sc.args || {}));
  shiftTimes(a, -Number(sc.t0 || 0));
  return a;
}

const arg = (n, d = null, short = null) => {
  let i = process.argv.indexOf('--' + n);
  if (i < 0 && short) i = process.argv.indexOf('-' + short);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const slug = arg('slug', null, 's');
const template = arg('template', 'A', 't');
const tier = arg('tier', '精讲');
const title = arg('title', '未命名', 'T');

if (!slug) {
  console.error('用法: node tools/new-film.mjs --slug <名字> [--template A] [--tier 精讲|标准] [--title "标题"]');
  console.error('      母版：' + Object.entries(guide.templates).map(([k, v]) => `${k}=${v.name}`).join(' · '));
  process.exit(2);
}

const dir = path.join(ROOT, 'content', slug);
if (fs.existsSync(dir)) {
  console.error(`目录已存在：content/${slug}（换个 slug，或先删掉）`);
  process.exit(2);
}

const tpl = guide.templates[template];
if (!tpl) { console.error(`不认识母版 ${template}`); process.exit(2); }
const { beats, spec } = planBeats(template, tier);
const skel = buildSkeleton({ template, tier, title, target: 'paper' });

/* ---------------- script.json ---------------- */
const script = {
  _how: 'text 是旁白原文（会逐段配音）；screens 是这一拍的画面，可以有多个——一拍拆成几段时按顺序取，'
      + '给不同 screens 才能避免同拍子段画面完全一样（骨架默认 freeze 偏高就是因为它俩共用一份 args）。',
  template, tier, title, subtitle: '',
  voice: 'zh-CN-YunjianNeural', rate: '+8%',
  beats: beats.map((b) => ({
    id: b.id, role: b.role,
    type: b.paperType || 'point',
    // 占位文案给个字数提示：太长会让字幕挤（每条至少停 1.8s），太短会让片子不到档位
    text: `【${b.id}】这一拍的旁白，约 ${Math.max(8, Math.round((spec.seconds[0] / beats.length) * 5.5 * 0.9))} 字`,
    screens: [clampTimes(templateFor(b.paperType || "point"))],
    _note: `画面参考：${b.screen || '—'}`,
  })),
};

/* ---------------- facts.md ---------------- */
const facts = `# 事实清单 · ${title}

> 规则：旁白和画面上的每一个数字、人名、年份、引文都要在这里有一行；没有出处的不上屏。
> 级别：T1 原始文献 / 官方页面；T2 权威二手；T3 社区（只当线索）。
> 写完跑：\`node src/gate.mjs out/${slug}.mp4 --facts content/${slug}/facts.md --require-facts\`

| # | 事实（上屏写法） | 出处 | 级别 | 原文摘录 | 用在哪一拍 |
|---|---|---|---|---|---|
| 1 |  |  | T1 |  | ${beats[0]?.id || 'B01'} |
| 2 |  |  | T1 |  | ${beats[1]?.id || 'B02'} |

## 示意性画面
- （有 AI 生成图就写明「示意」；纯代码绘制可写“无”）

## 对抗审查记录
- 钩子是否在 3 秒内让人参与：
- 每一屏字数是否 ≤ 8 字关键词（字幕除外）：
- 有没有无出处的断言：
`;

/* ---------------- build.mjs ---------------- */
const build = `#!/usr/bin/env node
/**
 * build.mjs · ${slug} 的通用构建：配音定长 → 时间轴（链式）→ scenes → 音轨
 * 这段代码**不含本片内容**，全部来自 script.json 与 tools/knowledge/guide.json。
 *   node build.mjs            生成 params.json / params-abs.json
 *   node build.mjs --chain    额外生成 params-chain.json（链式，渲染用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planBeats, buildSkeleton } from '${path.relative(dir, path.join(ROOT, 'tools/knowledge/knowledge.mjs'))}';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAP = 0.25;
const FPS = 60;
const SEG_MAX = 7;            // paper 镜头设计 4–7s

const script = JSON.parse(fs.readFileSync(path.join(HERE, 'script.json'), 'utf8'));
const { beats: plan, spec } = planBeats(script.template, script.tier);
const skel = buildSkeleton({ template: script.template, tier: script.tier, title: script.title, target: 'paper' });

/* 1. 配音：每拍一段，量真实时长 */
fs.mkdirSync(path.join(HERE, 'audio'), { recursive: true });
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim());
const beats = plan.map((b, i) => {
  const src = script.beats[i] || script.beats.find((x) => x.id === b.id) || {};
  const mp3 = path.join(HERE, 'audio', b.id + '.mp3');
  if (!fs.existsSync(mp3)) {
    execFileSync(process.env.EDGE_TTS || 'edge-tts', [
      '--voice', script.voice, '--rate=' + (script.rate || '+8%'),
      '--text', src.text, '--write-media', mp3,
    ], { stdio: 'pipe' });
  }
  return { ...b, text: src.text, screens: src.screens || [{}], dur: dur(mp3), scriptType: src.type || null };
});

/* 2. scenes：段型取 paperType，按 ≤SEG_MAX 拆，args 从骨架同拍取再叠加 screens */
const skelByBeat = new Map();
for (const s of skel.scenes) if (!skelByBeat.has(s.beat)) skelByBeat.set(s.beat, s);
const merge = (base, over) => {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) merge(base[k], v);
    else base[k] = v;
  }
  return base;
};

const scenes = [];
let t = 0;
beats.forEach((b, i) => {
  const base = skelByBeat.get(b.id) || { type: b.paperType || 'point', args: {} };
  // 换段型时**不要继承骨架的 args**：骨架那一拍的 args 是另一种段型的（比如 number 的 label/value/at）。
  // 混在一起会让渲染器读到不该有的字段（实测 at 变成负数，绘制直接抛 l.replace is not a function）。
  const switched = b.scriptType && b.scriptType !== base.type;
  const parts = Math.max(1, Math.ceil(b.dur / SEG_MAX));
  const each = b.dur / parts;
  for (let k = 0; k < parts; k++) {
    // 同一拍的多个子段**按顺序取不同的 screens**，这是避免"两段一模一样"的唯一办法
    const screen = b.screens[k % Math.max(1, b.screens.length)] || {};

    // 元素时刻必须小于子段时长：每段重放同一份 screens 并从 0 起算，
    // 钉在 4.2s 而子段只有 3.6s ⇒ 永不出现，画面只剩标题（实测踩过）。
    {
      const times = [];
      const collect = (n) => {
        if (Array.isArray(n)) {
          if (n.length >= 2 && typeof n[0] === 'string' && typeof n[1] === 'number') times.push(n[1]);
          n.forEach((v) => v && typeof v === 'object' && collect(v));
        } else if (n && typeof n === 'object') {
          for (const [key, v] of Object.entries(n)) {
            if (/^(at|leftAt|rightAt|strikeAt|itemAt)$/.test(key) && typeof v === 'number') times.push(v);
            else if (v && typeof v === 'object') collect(v);
          }
        }
      };
      collect(screen);
      const maxT = times.length ? Math.max(...times) : 0;
      const segDur = k === parts - 1 ? b.dur - each * (parts - 1) : each;
      if (maxT >= segDur - 0.05) {
        console.warn('  ⚠ ' + b.id + '[' + k + '] screens 最晚时刻 ' + maxT + 's ≥ 子段时长 ' + segDur.toFixed(2) + 's —— 该元素不会出现');
      }
    }
    const walk = (n, delta) => {
      if (Array.isArray(n)) {
        if (n.length >= 2 && typeof n[0] === 'string' && typeof n[1] === 'number') n[1] = +(n[1] + delta).toFixed(2);
        n.forEach((v) => v && typeof v === 'object' && walk(v, delta));
      } else if (n && typeof n === 'object') {
        for (const [key, v] of Object.entries(n)) {
          if (/^(at|leftAt|rightAt|strikeAt|itemAt)$/.test(key) && typeof v === 'number') n[key] = +(v + delta).toFixed(2);
          else if (v && typeof v === 'object') walk(v, delta);
        }
      }
    };

    // 两套时间语义必须分开处理，merge 之后就没法区分了：
    //   骨架 args 的 cards[][1] / at 是**绝对秒**（v8t 里 point 段的 cards 是 7.868，落在 5.32–11.44 之间），
    //     所以按 (实际 t0 − 骨架 t0) 平移，让元素在新段重新按时出现；
    //   用户在 script.json 的 screens 里写的是**段内相对秒**（1.2 / 2.8 / 4.4），直接加 t。
    // 混在一起处理会得出 71.72 这种远超段末的时间 ⇒ 卡片永不出现 ⇒ 画面只剩字幕（实测 40–43s 空镜）。
    const args = switched ? {} : JSON.parse(JSON.stringify(base.args || {}));
    if (!switched) walk(args, t - Number(base.t0 || 0));
    const userArgs = JSON.parse(JSON.stringify(screen));
    walk(userArgs, t);
    merge(args, userArgs);
    const d = parts > 1 && k === parts - 1 ? b.dur - each * (parts - 1) : each;
    scenes.push({
      // script.json 里显式写的 type 优先：用户想把某一拍换成 chart / grid 时，
      // 只改 script 的 type 即可，不用动骨架（之前这里固定取骨架的 type，改了没用）。
      type: b.scriptType || base.type || b.paperType || 'point',
      t0: +t.toFixed(2), t1: +(t + d).toFixed(2),
      note: \`\${b.id} \${b.role}\${parts > 1 ? \`（第 \${k + 1}/\${parts} 段）\` : ''}｜\${b.intent || ''}\`,
      beat: b.id, args,
    });
    t += d;
    if (k === parts - 1) t += GAP;
  }
});

const total = +(t - GAP).toFixed(4);

/* 3. 音效：拍间 whoosh / 数字段 tick / 开场 impact（gain 保守，避免真峰值越线） */
const cues = [{ at: 0, src: 'impact', gain: 0.20 }];
for (const b of beats.slice(1)) {
  const first = scenes.find((s) => s.beat === b.id);
  if (first) cues.push({ at: first.t0, src: 'whoosh', gain: 0.18 });
}
for (const s of scenes) if (s.type === 'number') cues.push({ at: +(s.t0 + 0.8).toFixed(2), src: 'tick', gain: 0.14 });

/* 声音化：chart 段的每个标记落一个点击音，趋势先被"听见"再被"读到"（lemo dataviz 的第三层）。
 * 隔一个响一次——253 个点全响会糊成噪音。音高是固定的，所以传的是**密度**而非**数值**；
 * 真要"音高对应值"得让 earshot 逐点渲不同 pitch，那是另一次改造。 */
for (const s of scenes) {
  if (s.type !== 'chart') continue;
  const a = s.args || {};
  const step = Number(a.stagger) || 0.12;
  const base = Number(a.at) || (s.t0 + 0.4);
  const n = a.chart === 'bar' ? (a.items || []).length : (a.series || []).reduce((k, x) => k + (x.points || []).length, 0);
  for (let i = 0; i < n; i += 2) {
    cues.push({ at: +(base + i * step).toFixed(2), src: 'click/soft', gain: 1.2 });
  }
}

const abs = {
  brand: { name: script.template + '-' + script.title },
  accent: '#E8503A', accent2: '#2F6F8F',
  audio: { cues }, durationSeconds: total, fps: FPS, scenes, captions: [],
};

/* 4. 字幕：一条至少停 max(1.8s, 字数/语速)，放不下就合并相邻条
 *    规则出自 lemo-opuscar 的 STYLE.md §4；按"所需时长"加权而不是按字数，
 *    否则 6 字的短句只分到 1.2s（实测评测 5/39 条一闪而过）。 */
const CPS = 5.5, MIN_HOLD = 1.8;
const split = (s, lim = 18) => {
  const out = []; let cur = '';
  for (const ch of s) { cur += ch; if (cur.length >= lim && /[，。、；：？！]/.test(ch)) { out.push(cur); cur = ''; } }
  if (cur) out.push(cur);
  return out;
};
const fitCaptions = (text, span) => {
  let chunks = split(text);
  while (chunks.length > 1) {
    const need = chunks.map((c) => Math.max(MIN_HOLD, c.length / CPS));
    if (need.reduce((a, c) => a + c, 0) <= span + 1e-6) break;
    let k = 0, best = Infinity;
    for (let i = 0; i < chunks.length - 1; i++) {
      const w = chunks[i].length + chunks[i + 1].length;
      if (w < best) { best = w; k = i; }
    }
    chunks.splice(k, 2, chunks[k] + chunks[k + 1]);
  }
  const need = chunks.map((c) => Math.max(MIN_HOLD, c.length / CPS));
  const total = need.reduce((a, c) => a + c, 0) || 1;
  return chunks.map((c, i) => ({ text: c, hold: span * need[i] / total }));
};
const caps = [];
for (const b of beats) {
  const first = scenes.find((s) => s.beat === b.id);
  const last = [...scenes].reverse().find((s) => s.beat === b.id);
  const span = (last ? last.t1 : first.t0) - first.t0;
  let t = first.t0;
  for (const { text, hold } of fitCaptions(b.text, span)) {
    caps.push({ start: +t.toFixed(2), end: +(t + hold).toFixed(2), text });
    t += hold;
  }
}
abs.captions = caps;

fs.writeFileSync(path.join(HERE, 'params.json'), JSON.stringify(abs, null, 1));
fs.writeFileSync(path.join(HERE, 'params-abs.json'), JSON.stringify(abs, null, 1));

/* 5. 链式版（渲染用）：只改第一段 for 就能带动整条时间轴 */
if (process.argv.includes('--chain')) {
  const ch = { ...abs, scenes: abs.scenes.map((s, i) => {
    const { t0, t1, ...rest } = s;
    // 链式间隔按**实际间隔**生成：同一拍拆出的子段之间没有间隔，一律写 @prev+0.25
    // 会让 15 段凭空多出 1.76s，而配音是按真实总长切的 ⇒ 音画差 1.77s、gate FAIL。
    const gap = i === 0 ? 0 : +(s.t0 - abs.scenes[i - 1].t1).toFixed(4);
    return { ...rest, from: i === 0 ? t0 : (gap > 0.0005 ? \`@prev+\${gap}\` : '@prev'), for: +(t1 - t0).toFixed(4) };
  }) };
  ch.durationSeconds = '@last+0.02';
  fs.writeFileSync(path.join(HERE, 'params-chain.json'), JSON.stringify(ch, null, 1));
}

/* 6. 旁白音轨：段间补 GAP，与时间轴严格一致 */
const inputs = [], filters = [];
beats.forEach((b, i) => {
  inputs.push('-i', path.join(HERE, 'audio', b.id + '.mp3'));
  filters.push(\`[\${i}:a]aresample=48000,aformat=channel_layouts=mono,apad=pad_dur=\${GAP}[a\${i}]\`);
});
filters.push(\`\${beats.map((_, i) => \`[a\${i}]\`).join('')}concat=n=\${beats.length}:v=0:a=1,atrim=0:\${total}[out]\`);
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'),
  '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', path.join(HERE, 'audio', 'vo.wav')]);

console.log(\`✓ \${scenes.length} 段 / \${caps.length} 条字幕 / \${total}s\`);
console.log(\`  配音 \${beats.length} 拍，最长段 \${Math.max(...scenes.map((s) => s.t1 - s.t0)).toFixed(1)}s\`);
// 档位自检：拍数对了但每拍文案太短，总长会远低于目标区间（占位文案常见）
const [s0, s1] = spec.seconds;
if (total < s0 * 0.95 || total > s1 * 1.05) {
  console.log(\`  ⚠ 总长 \${total}s 不在「\${script.tier}」档 \${s0}–\${s1}s 内：\${total < s0 ? '文案偏短，每拍至少要讲 ' + Math.round(s0 / beats.length) + 's' : '文案偏长，考虑升档'} \`);
}
`;

/* ---------------- bgm.mjs（通用分层配乐） ---------------- */
const bgm = `#!/usr/bin/env node
/**
 * bgm.mjs · 分层配乐：四层 128 BPM 电子，按段落边界让各层进出。
 * 曲目来自本机 Apple Loops（不入库）。段落边界读 params-abs.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOPS = '/Library/Audio/Apple Loops/Apple';
const LAYERS = {
  a: LOOPS + '/02 Electro House/Binary System Synth Layers.caf',
  b: LOOPS + '/02 Electro House/Blueprint Beat 01.caf',
  c: LOOPS + '/02 Electro House/Acid Test Bass.caf',
  d: LOOPS + '/02 Electro House/Apex Synth.caf',
};
const p = JSON.parse(fs.readFileSync(path.join(HERE, 'params-abs.json'), 'utf8'));
const total = p.durationSeconds;
const sc = p.scenes;
const t1 = sc[Math.min(2, sc.length - 1)].t0;
const t2 = sc[Math.min(Math.floor(sc.length * 0.45), sc.length - 1)].t0;
const t3 = sc[Math.min(Math.floor(sc.length * 0.75), sc.length - 1)].t0;

const env = (pairs) => {
  let e = String(pairs[pairs.length - 1][1]);
  for (let i = pairs.length - 2; i >= 0; i--) e = \`if(lt(t,\${pairs[i][0]}),\${e},\${pairs[i][1]})\`;
  return e;
};
const lay = (i, name, expr, fi) => \`[\${i}:a]aresample=48000,aformat=channel_layouts=mono,aloop=loop=-1:size=2147483647,atrim=0:\${total},asetpts=N/SR/TB,volume='\${expr}':eval=frame\${fi ? ',afade=t=in:st=0:d=1.6' : ''}[\${name}]\`;

const filters = [
  lay(0, 'a', env([[0, 0.30], [t1, 0.40], [t3, 0.46], [total * 0.9, 0.20]]), true),
  lay(1, 'b', env([[0, 0], [t1, 0.32], [t2, 0.16], [t3, 0.40], [total * 0.9, 0]])),
  lay(2, 'c', env([[0, 0], [t3, 0.36], [total * 0.9, 0]])),
  lay(3, 'd', env([[0, 0], [t2, 0.16], [t3, 0], [t3 + 2, 0.15], [total * 0.85, 0]])),
  \`[a][b][c][d]amix=inputs=4:normalize=0:duration=first,alimiter=limit=0.85,afade=t=out:st=\${(total - 2.2).toFixed(2)}:d=2.2[out]\`,
];
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', LAYERS.a, '-i', LAYERS.b, '-i', LAYERS.c, '-i', LAYERS.d,
  '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
  path.join(HERE, 'audio', 'bgm.wav')]);
console.log('✓ audio/bgm.wav', total + 's');
`;

/* ---------------- mix.mjs ---------------- */
const mix = `#!/usr/bin/env node
// 旁白 + 分层配乐 + 音效事件 → 混音（ducking 在 src/audio-mix.mjs）
import fs from 'node:fs';
const ROOT = new URL('../..', import.meta.url).pathname;
const D = new URL('.', import.meta.url).pathname;
const { buildMix } = await import(ROOT + 'src/audio-mix.mjs');
const { auditTiming } = await import(ROOT + 'src/temporal.mjs');
const p = JSON.parse(fs.readFileSync(D + 'params-abs.json', 'utf8'));
const ta = auditTiming(p);
if (!ta.ok) { console.error('时间轴校验失败：', ta.errors); process.exit(2); }
const cues = (p.audio && p.audio.cues) || [];
const r = buildMix({
  out: D + 'audio/mix-final.wav', duration: p.durationSeconds,
  mode: 'external-music', music: D + 'audio/bgm.wav', voice: D + 'audio/vo-norm.wav',
  musicGain: 0.5, cues,
});
console.log('混音', r ? '✓' : '✗', p.durationSeconds + 's ·', cues.length, '条音效');
`;

/* ---------------- make.sh ---------------- */
const make = `#!/bin/bash
# 一条命令：配音时间轴 → 响度归一 → 配乐 → 混音 → 渲染 → 门禁
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
echo "── 1/6 配音定长 + 时间轴（链式）"
node build.mjs --chain
echo "── 2/6 旁白响度归一（edge-tts 原始约 -23.7 LUFS，必须在配音环节补）"
ffmpeg -v error -y -i audio/vo.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -ac 1 audio/vo-norm.wav
echo "── 3/6 分层配乐"
node bgm.mjs
echo "── 4/6 混音"
node mix.mjs
echo "── 5/6 渲染"
cd "$ROOT"
node render.mjs --kit paper --params content/${slug}/params-chain.json \\
  --audio content/${slug}/audio/mix-final.wav --out out/${slug}.mp4
echo "── 6/6 门禁"
node src/gate.mjs out/${slug}.mp4 \\
  $([ -s content/${slug}/facts.md ] && echo "--facts content/${slug}/facts.md") \\
  --require-loudness --require-bgm --blank 2>&1 | grep -E "PASS|FAIL|LUFS|台账|空镜"
`;

/* ---------------- README ---------------- */
const readme = `# ${slug} · ${title}

母版 **${template} ${tpl.name}** × ${tier} 档（${spec.seconds[0]}–${spec.seconds[1]}s / ${spec.beats[0]}–${spec.beats[1]} 拍）。

## 三步

1. **写稿**：改 \`script.json\` 的 \`text\`（旁白）与 \`screens\`（画面要素）。
   \`screens\` 可以写多个 —— 一拍拆成几段时按顺序取，**给不同 screens 才能避免同拍子段画面一样**。
2. **写台账**：改 \`facts.md\`，每个上屏数字都要有一行出处。
3. **出片**：\`./make.sh\`（配音 → 时间轴 → 配乐 → 混音 → 渲染 → 门禁）。

## 改一句旁白之后

重新配那一段（删掉 \`audio/<拍ID>.mp3\` 让它重合成，或手动 edge-tts），再 \`./make.sh\`。
时间轴是链式的（\`from: "@prev+0.25"\`），**其余段落会自动顺移，不用手改任何秒数**。

## 注意

- 骨架刚生成时 \`freeze\`（最长静止）会偏高：一拍 12–15s、paper 镜头 4–7s，拆出的子段默认共用一份占位 args。
  给每拍写多个不同的 \`screens\` 才能压下来。
- 响度必须在**配音环节**归一（\`make.sh\` 第 2 步），成片阶段补不回来。
`;

/* ---------------- 落盘 ---------------- */
fs.mkdirSync(dir, { recursive: true });
const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);
write('script.json', JSON.stringify(script, null, 2) + '\n');
write('facts.md', facts);
write('build.mjs', build);
write('bgm.mjs', bgm);
write('mix.mjs', mix);
write('make.sh', make);
write('README.md', readme);
fs.chmodSync(path.join(dir, 'make.sh'), 0o755);

console.log(`✓ content/${slug}`);
console.log(`  ${tpl.name} · ${tier} · ${beats.length} 拍 · 目标 ${spec.seconds[0]}–${spec.seconds[1]}s`);
console.log(`  下一步：改 script.json 的 text/screens 与 facts.md，然后 ./make.sh`);
