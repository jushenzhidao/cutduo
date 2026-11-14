#!/usr/bin/env node
/**
 * tools/review-sheet.mjs · 锚点帧审片表
 *
 * 为什么需要：现在审片是"随手挑几个时间点抽帧"——挑的人（或模型）心里有预期，
 * 自然会挑到正常的帧，漏掉"某一项根本没出现"这种。锚点帧把"该看哪一帧"从人的手感
 * 变成从 preset 算出来：每个锚点词念到之后 0.22s（让它长完）就是一帧，
 * 段首/段末各一帧，覆盖开场与收场。
 *
 * 来源：video-talkcraft 的 `anchors.json`（"状态切换必须标 burst，连拍三帧"）。
 * 我们只取"从时间表算必看帧"这一条，不做连拍。
 *
 * 用法：
 *   node tools/review-sheet.mjs --video out/talkcraft-final.mp4 \
 *     --preset kits/diagram/presets/talkcraft-15s.json --timing out/tc.timing.json \
 *     --out out/talkcraft-sheet.png
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const COLS = 3;
const TW = 600;
const TH = 338;
const PAD = 16;
const LABEL = 34;

async function main() {
  const video = arg('video');
  const presetPath = arg('preset');
  const timingPath = arg('timing');
  const out = path.resolve(arg('out', 'out/review-sheet.png'));
  if (!video || !presetPath) {
    console.error('usage: node tools/review-sheet.mjs --video x.mp4 --preset x.json [--timing x.timing.json] [--out x.png]');
    process.exit(2);
  }

  const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
  const timing = timingPath ? JSON.parse(fs.readFileSync(timingPath, 'utf8')) : null;
  const byIndex = new Map((timing?.segments ?? []).map((s) => [s.index, s]));
  const segs = preset.segments ?? [];

  // ── 算必看帧
  const events = [];
  let acc = Number(preset.titleCard?.duration ?? 0);
  segs.forEach((s, i) => {
    const st = byIndex.get(i);
    const dur = Number(st?.duration ?? s.duration) || 8;
    const line = st?.line ?? s.line ?? '';

    const before = events.length;
    events.push({ t: acc + 0.4, tag: `段${i + 1} 首`, seg: i + 1 });
    for (const it of s.items ?? []) {
      for (const k of ['rowAt', 'at']) {
        const w = it?.[k];
        if (typeof w !== 'string') continue;
        const pos = line.indexOf(w);
        const t = pos >= 0 ? st?.chars?.[pos]?.t : null;
        if (t === null || t === undefined) continue;
        events.push({ t: acc + Number(t) + 0.22, tag: `段${i + 1} ${k === 'rowAt' ? '行' : '量'}·${w}`, seg: i + 1 });
      }
    }
    // 元镜头没有 items 锚点（事件在字符时刻上），只抽首末会漏掉中间那几次状态切换
    if (events.length === before + 1) events.push({ t: acc + dur / 2, tag: `段${i + 1} 中`, seg: i + 1 });
    events.push({ t: acc + dur - 0.28, tag: `段${i + 1} 末`, seg: i + 1 });
    acc += dur;
  });

  // 同一时刻只留一个；超过 12 帧按"每段均匀取"降采样，别让 8 张全挤在第一段
  const uniq = [];
  for (const e of events.sort((a, b) => a.t - b.t)) {
    if (uniq.length && Math.abs(uniq[uniq.length - 1].t - e.t) < 0.12) continue;
    uniq.push(e);
  }
  const MAX = 15;
  // 降采样时必须保住每段的"首"和"末"：`slice(0, per)` 会留下开头两个锚点、
  // 把段末丢掉 —— 而段末恰恰是"最后一项有没有出现"的那一帧。
  const spread = (own, per) => {
    if (own.length <= per) return own;
    if (per === 1) return [own[0]];
    const step = (own.length - 1) / (per - 1);
    return Array.from({ length: per }, (_, k) => own[Math.round(k * step)]);
  };
  const picked = uniq.length <= MAX ? uniq : (() => {
    const per = Math.max(2, Math.floor(MAX / segs.length));
    const out2 = [];
    for (let s = 1; s <= segs.length; s++) out2.push(...spread(uniq.filter((e) => e.seg === s), per));
    return out2.slice(0, MAX);
  })();

  // ── 抽帧
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'));
  const files = picked.map((e, k) => {
    const f = path.join(tmp, `f${String(k).padStart(2, '0')}.png`);
    // -ss 在 -i 之前是**关键帧 seek**，会退到最近的关键帧（gop 2–4s），抽出来的帧
    // 和标注对不上 —— 审片表错位比不抽更糟。放 -i 之后是逐帧解码，精确到帧。
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', video, '-ss', e.t.toFixed(3), '-frames:v', '1', f]);
    return f;
  });

  // ── 拼图
  const fontDir = path.resolve('assets/fonts');
  for (const [f, a] of [['NotoSansSC-Black.otf', 'SC Black'], ['NotoSansSC-Regular.otf', 'SC']]) {
    const p = path.join(fontDir, f);
    if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, a);
  }
  const rows = Math.ceil(picked.length / COLS);
  const W = COLS * TW + (COLS + 1) * PAD;
  const H = rows * (TH + LABEL) + PAD * 2;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#EFEFE5';
  ctx.fillRect(0, 0, W, H);

  for (let k = 0; k < picked.length; k++) {
    const img = await loadImage(files[k]);
    const cx = PAD + (k % COLS) * (TW + PAD);
    const cy = PAD + Math.floor(k / COLS) * (TH + LABEL + PAD);
    ctx.drawImage(img, cx, cy, TW, TH);
    ctx.fillStyle = 'rgba(21,35,26,0.12)';
    ctx.fillRect(cx, cy + TH, TW, 1);
    ctx.fillStyle = '#15231A';
    ctx.font = '21px "SC Black", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${String(k + 1).padStart(2, '0')}  ${picked[k].t.toFixed(2)}s`, cx, cy + TH + 8);
    ctx.fillStyle = '#6E7869';
    ctx.font = '19px "SC", sans-serif';
    ctx.fillText(picked[k].tag, cx + 118, cy + TH + 9);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await cv.encode('png'));
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(JSON.stringify({ ok: true, out, frames: picked.length, at: picked.map((e) => `${e.t.toFixed(2)}s ${e.tag}`) }, null, 2));
}

await main();
