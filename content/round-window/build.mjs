#!/usr/bin/env node
/**
 * build.mjs · round-window 的通用构建：配音定长 → 时间轴（链式）→ scenes → 音轨
 * 这段代码**不含本片内容**，全部来自 script.json 与 tools/knowledge/guide.json。
 *   node build.mjs            生成 params.json / params-abs.json
 *   node build.mjs --chain    额外生成 params-chain.json（链式，渲染用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planBeats, buildSkeleton } from '../../tools/knowledge/knowledge.mjs';

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
  // 缓存要带 mtime：只判存在会让"改了 script.json 但配音没变"（实测：文案加到 438 字，
  // 视频还是 70s，因为 5 个旧 mp3 被直接复用）。
  const stale = fs.existsSync(mp3) && fs.statSync(mp3).mtimeMs < fs.statSync(path.join(HERE, 'script.json')).mtimeMs;
  if (!fs.existsSync(mp3) || stale) {
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
      note: `${b.id} ${b.role}${parts > 1 ? `（第 ${k + 1}/${parts} 段）` : ''}｜${b.intent || ''}`,
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
    return { ...rest, from: i === 0 ? t0 : (gap > 0.0005 ? `@prev+${gap}` : '@prev'), for: +(t1 - t0).toFixed(4) };
  }) };
  ch.durationSeconds = '@last+0.02';
  fs.writeFileSync(path.join(HERE, 'params-chain.json'), JSON.stringify(ch, null, 1));
}

/* 6. 旁白音轨：段间补 GAP，与时间轴严格一致 */
const inputs = [], filters = [];
beats.forEach((b, i) => {
  inputs.push('-i', path.join(HERE, 'audio', b.id + '.mp3'));
  filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,apad=pad_dur=${GAP}[a${i}]`);
});
filters.push(`${beats.map((_, i) => `[a${i}]`).join('')}concat=n=${beats.length}:v=0:a=1,atrim=0:${total}[out]`);
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'),
  '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', path.join(HERE, 'audio', 'vo.wav')]);

console.log(`✓ ${scenes.length} 段 / ${caps.length} 条字幕 / ${total}s`);
console.log(`  配音 ${beats.length} 拍，最长段 ${Math.max(...scenes.map((s) => s.t1 - s.t0)).toFixed(1)}s`);
// 档位自检：拍数对了但每拍文案太短，总长会远低于目标区间（占位文案常见）
const [s0, s1] = spec.seconds;
if (total < s0 * 0.95 || total > s1 * 1.05) {
  console.log(`  ⚠ 总长 ${total}s 不在「${script.tier}」档 ${s0}–${s1}s 内：${total < s0 ? '文案偏短，每拍至少要讲 ' + Math.round(s0 / beats.length) + 's' : '文案偏长，考虑升档'} `);
}
