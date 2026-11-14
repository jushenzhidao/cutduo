#!/usr/bin/env node
/**
 * kits/diagram/render.mjs · 图示段型的出片入口
 *
 * 与其它 kit 的差别：这支不是「一条版式」，是一组**段型**（13 类图示）。
 * 所以参数是一串 segments，每段一个 family，段内自己处理揭示节奏。
 *
 *   node kits/diagram/render.mjs --params kits/diagram/presets/default.json --out out/diagram.mp4
 *
 * 首版只做单进程：4 段的验证片不值得为它接 worker 分片。要上产线再接
 * src/pipeline.mjs 的 planShards（接口已经留好，改 pumpFrames 的调用处即可）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

import { DIRS, REPO_ROOT, resolveInput } from '../../src/root.mjs';
import { concatParts, partArgs, pumpFrames, report, spawnPart } from '../../src/pipeline.mjs';
import { drawCaption, drawDiagram, drawTitleCard, resolveAnchors, validateDiagram } from './diagram.mjs';
import { clamp, easeInCubic, easeOutCubic } from './layout.mjs';
import { FONTS } from './tokens.mjs';
import { CANVAS, FRAME, PALETTES } from './tokens.mjs';

const FONT_FILES = [
  ['NotoSansSC-Black.otf', 'NotoSC Black'],
  ['NotoSansSC-Medium.otf', 'NotoSC Medium'],
  ['NotoSansSC-Regular.otf', 'NotoSC Regular'],
  ['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Regular'],
];

function registerFonts() {
  const dir = path.join(DIRS.assets, 'fonts');
  for (const [file, alias] of FONT_FILES) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, alias);
  }
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

function main() {
  registerFonts();

  const paramsPath = resolveInput(arg('params', 'kits/diagram/presets/default.json'));
  const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
  const segments = params.segments ?? [];
  if (!segments.length) throw new Error('params.segments 为空');

  // 出片前先静态校验每一段：宁可现在报错，不要渲到一半倒在 ffmpeg 上
  const problems = [];
  segments.forEach((s, i) => {
    const c = validateDiagram(s);
    if (!c.ok) problems.push({ index: i, family: s.family, errors: c.errors });
  });
  if (problems.length) {
    console.error(JSON.stringify({ ok: false, problems }, null, 2));
    process.exit(2);
  }

  // 字级时间戳（可选）：给了就把每项的锚点词解析成段内秒，画面改成"念到才动"。
  // 没给就退回按序号均分的 stagger —— 旧预设、样张、13 类图示全部照旧。
  const timingPath = arg('timing', '');
  if (timingPath) {
    const timing = JSON.parse(fs.readFileSync(resolveInput(timingPath), 'utf8'));
    const byIndex = new Map((timing.segments ?? []).map((s) => [s.index, s]));
    const anchorErrors = [];
    segments.forEach((s, i) => {
      const st = byIndex.get(i);
      if (!st) return;
      try {
        const { entries, rowEntries, resolved } = resolveAnchors(s, st, Number(s.duration) || 8);
        if (entries) {
          s._entries = entries;
          s._anchors = resolved;
        }
        if (rowEntries) s._rowEntries = rowEntries;
        if (Array.isArray(st.lines) && st.lines.length) {
          // 字幕逐字上色要用这一句自己的字级时刻（段内秒 → 绝对秒）
          s._lines = st.lines.map((L) => {
            const pos = (st.line ?? '').indexOf(L.text);
            const cs = pos >= 0 ? (st.chars ?? []).slice(pos, pos + L.text.length) : [];
            return {
              ...L,
              chars: cs.map((c) => ({ ch: c.ch, at: c.t == null ? null : st.start + c.t })),
            };
          });
        }
        // 元镜头的数据源：时间轴要全片每段的真实范围与字刻线，glyph 要这一句的逐字时刻
        if (s.family === 'timeline') {
          s._timeline = timing.segments ?? [];
          s._total = timing.total;
        }
        if (s.family === 'glyph') {
          const punct = /[，。、；：？！“”‘’（）《》〈〉【】—…·,.!?;:]/;
          const cs = (st.chars ?? []).filter((c) => c.ch && !punct.test(c.ch));
          s._chars = cs.map((c, k) => {
            const next = cs[k + 1];
            const d = next && next.t != null && c.t != null ? Math.max(0.03, next.t - c.t) : 0.14;
            return { ch: c.ch, t: c.t == null ? null : Number((st.start + c.t).toFixed(3)), d: Number(d.toFixed(3)) };
          });
        }
      } catch (e) {
        anchorErrors.push({ index: i, family: s.family, error: e.message });
      }
    });
    if (anchorErrors.length) {
      console.error(JSON.stringify({ ok: false, anchorErrors }, null, 2));
      process.exit(2);
    }
    const low = (timing.segments ?? []).filter((s) => Number(s.match) < 0.9);
    if (low.length) {
      console.warn(`[timing] ${low.length} 句 match < 0.90：${low.map((s) => `#${s.index + 1} ${s.match}`).join(', ')}`);
    }
  }

  const width = params.width ?? CANVAS.w;
  const height = params.height ?? CANVAS.h;
  const fps = params.fps ?? CANVAS.fps;
  const palette = PALETTES[params.palette ?? 'paper'] ?? PALETTES.paper;
  const box = {
    x: params.frame?.x ?? FRAME.x,
    y: params.frame?.y ?? FRAME.y,
    width: width - (params.frame?.x ?? FRAME.x) * 2,
    height: height - (params.frame?.y ?? FRAME.y) - (params.frame?.bottom ?? 120),
  };

  // 时间段表：每段 [start, end) 秒。片头卡占掉最前面，所以起点从它之后算
  const tc = params.titleCard;
  const tcDur = tc ? Number(tc.duration ?? 1.4) : 0;
  let acc = tcDur;
  const timeline = segments.map((s) => {
    const dur = Number(s.duration) || 8;
    const item = { seg: s, start: acc, end: acc + dur, dur };
    acc += dur;
    return item;
  });
  const total = acc;
  const frames = Math.round(total * fps);

  // 元镜头要把真值印在屏幕上（帧数、总长），但这些值要到所有段时长定下来才知道。
  // 用 {frames} / {total} / {seconds} 占位，出片前一次性替换 —— 手打的数字迟早对不上。
  const facts = { frames: String(frames), total: total.toFixed(2), seconds: total.toFixed(1) };
  const subst = (v) => {
    if (typeof v === 'string') return v.replace(/\{(frames|total|seconds)\}/g, (m, k) => facts[k] ?? m);
    if (Array.isArray(v)) return v.map(subst);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = k.startsWith('_') ? x : subst(x);
      return out;
    }
    return v;
  };
  segments.forEach((seg) => {
    for (const k of Object.keys(seg)) if (!k.startsWith('_')) seg[k] = subst(seg[k]);
  });

  if (tcDur > 0) timeline.unshift({ seg: { family: '__title__', ...tc, duration: tcDur }, start: 0, end: tcDur, dur: tcDur });

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  // 出场用的离屏画布：段落末 0.2s 要把整段内容淡出，而 family 内部到处直接赋值
  // globalAlpha，外层设的透明度会被它们覆盖 —— 只能先画到离屏、再带 alpha 贴回。
  // 每帧新建 canvas 太贵（实测 3–5ms），固定复用一个。
  const scratch = createCanvas(width, height);
  const sctx = scratch.getContext('2d');

  const renderer = {
    renderFrame(t) {
      const cur = timeline.find((x) => t >= x.start && t < x.end) ?? timeline[timeline.length - 1];
      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, width, height);
      if (cur.seg.family === '__title__') {
        drawTitleCard(ctx, cur.seg, t - cur.start, box, { palette, width, height });
        return;
      }
      const idx = timeline.filter((x) => x.seg.family !== '__title__').indexOf(cur) + 1;
      const drawOpts = {
        palette,
        index: idx,
        total: segments.length,
        now: t,
        frame: { index: Math.floor(t * fps), total: frames, fps },
      };

      // 出场：三段式的最后一段（入场 0.2–0.8 / hold / 出场 0.15–0.5）。
      // 只做淡出会像画面突然断电；淡出 + 上移 10px 才是"让位"。
      const exitFade = Number(params.exitFade ?? 0.2);
      const exitT = exitFade > 0 && cur.seg.family !== '__title__' ? clamp((t - (cur.end - exitFade)) / exitFade) : 0;
      if (exitT > 0) {
        sctx.clearRect(0, 0, width, height);
        drawDiagram(sctx, cur.seg, t - cur.start, box, drawOpts);
        ctx.save();
        ctx.globalAlpha = 1 - easeInCubic(exitT);
        ctx.drawImage(scratch, 0, -10 * easeInCubic(exitT));
        ctx.restore();
      } else {
        drawDiagram(ctx, cur.seg, t - cur.start, box, drawOpts);
      }
      const fadingOut = (params.outroFade ?? 0) > 0 && t > total - (params.outroFade ?? 0);
      if (params.captions !== false && !fadingOut) {
        // 一段多句时字幕只挂"当前这一句"：两句一起挂底部会一直显示 30+ 字，
        // 既超 26 字上限要折行，也和图上正在讲的那项对不上。
        let text = cur.seg.line;
        let from = cur.start;
        let to = cur.end;
        let curLine = null;
        const ls = cur.seg._lines;
        if (Array.isArray(ls) && ls.length) {
          let k = 0;
          for (let j = 0; j < ls.length; j++) if (t >= ls[j].at - 0.06) k = j;
          const L = ls[k];
          curLine = L;
          text = L.text;
          from = L.at;
          to = Math.min(cur.end, L.at + L.speech + 0.62);
        }
        drawCaption(ctx, text, t - from, to - from, params.captionSize, {
          palette,
          width,
          y: params.captionY ?? height - 140,
          chars: curLine?.chars,
          now: t,
        });
      }

      // 首段揭幕：0.7s 内从底色压下来。不是为了好看，是为了让 hook（前 2 秒的
      // 64×36 灰度差）有个大面积变化 —— 图示段的细碎动效在缩略图里等于静止。
      const fadeIn = params.introFade ?? 0;
      if (fadeIn > 0 && t < fadeIn) {
        ctx.save();
        ctx.globalAlpha = 1 - easeOutCubic(clamp(t / fadeIn));
        ctx.fillStyle = palette.bg;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }

      // 片尾落版：压暗 + 片名，别让它停在半张图上
      const fadeOut = params.outroFade ?? 0;
      if (fadeOut > 0 && t > total - fadeOut) {
        const a = easeOutCubic(clamp((t - (total - fadeOut)) / fadeOut));
        ctx.save();
        // 必须压成不透明：留 8% 透明度时，底下的编号和字幕会透上来和片名叠在一起
        ctx.globalAlpha = a;
        ctx.fillStyle = palette.bg;
        ctx.fillRect(0, 0, width, height);
        ctx.globalAlpha = clamp((a - 0.45) / 0.55);
        ctx.fillStyle = palette.ink;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `52px ${FONTS.black}`;
        ctx.fillText(params.outroTitle ?? params.title ?? '', width / 2, height / 2 - 18);
        if (params.outroNote) {
          ctx.font = `28px ${FONTS.reg}`;
          ctx.fillStyle = palette.label;
          ctx.fillText(params.outroNote, width / 2, height / 2 + 44);
        }
        ctx.restore();
      }
    },
  };

  const out = path.resolve(REPO_ROOT, arg('out', 'out/diagram.mp4'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-'));
  const part = path.join(tmpDir, 'seg-0.ts');

  const ff = spawnPart(
    partArgs({ pipe: 'raw', fps, width, height, crf: params.crf ?? 18, preset: params.preset ?? 'veryfast', part })
  );

  const startedAt = Date.now();
  return pumpFrames({ renderer, canvas, fps, start: 0, end: frames, ff, pipe: 'raw' }).then(() => {
    concatParts({ parts: [part], tmpDir, out, audio: params.audio, fps, frames });
    report({ out, frames, fps, startedAt, workers: 1 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
