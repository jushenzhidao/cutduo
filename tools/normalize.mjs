#!/usr/bin/env node
/**
 * tools/normalize.mjs · 响度归一（两遍法）
 *
 * 为什么不是一条命令：单遍 `loudnorm=I=-16` 是**边测边归**，测的时候已经在改，
 * 结果离目标差 0.2–0.4 LUFS（本仓实测单遍 −16.2，两遍 −16.0）。
 * 两遍法是先量一遍拿到 measured_*，第二遍用这些值做**线性增益**，动态不被压。
 *
 * 来源：video-talkcraft SKILL.md ⑧ 交付段的"第一遍量测 / 第二遍线性归一"。
 *
 * 用法：
 *   node tools/normalize.mjs out/x.mp4 out/x-final.mp4 [-16]
 *
 * 输出：成片 + 一行 JSON（含实测 input_i / output_i / TP / LRA），写进交付回执。
 */

import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const [, , src, dst, targetArg] = process.argv;
if (!src || !dst) {
  console.error('usage: node tools/normalize.mjs <in.mp4> <out.mp4> [targetLUFS=-16]');
  process.exit(2);
}
const I = Number(targetArg ?? -16);
const TP = -1.5;
const LRA = 11;

/** 第一遍：只量不改。print_format=json 会打一段 JSON 到 stderr */
function measure(file) {
  // loudnorm 的量测 JSON 打在 **stderr**，execFileSync 只返回 stdout —— 必须用 spawnSync
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-v', 'info', '-i', file, '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, '-f', 'null', '-'],
    { encoding: 'utf8' }
  );
  const txt = `${r.stderr ?? ''}${r.stdout ?? ''}`;
  const m = txt.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
  if (!m) throw new Error('没拿到量测 JSON');
  return JSON.parse(m[0]);
}

const skip = new Set();
function main() {
  const k = measure(src);
  const measured = {
    measured_I: k.input_i,
    measured_TP: k.input_tp,
    measured_LRA: k.input_lra,
    measured_thresh: k.input_thresh,
    offset: k.target_offset,
  };

  // 第二遍：用实测值做线性增益，视频直接 copy
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-i', src,
    '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:${Object.entries(measured).map(([a, b]) => `${a}=${b}`).join(':')}:linear=true`,
    '-ar', '48000',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-shortest', '-movflags', '+faststart',
    dst,
  ]);

  const after = measure(dst);
  const before = Number(k.input_i);
  const out = Number(after.input_i);
  const res = {
    ok: Math.abs(out - I) <= 0.3,
    src,
    dst,
    target: I,
    before: { lufs: before, tp: Number(k.input_tp), lra: Number(k.input_lra) },
    after: { lufs: out, tp: Number(after.input_tp), lra: Number(after.input_lra) },
    delta: Number((out - I).toFixed(2)),
    gain: Number((out - before).toFixed(2)),
  };
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) {
    console.error(`FAIL 归一后 ${out} 偏离目标 ${I} 超过 0.3 LUFS`);
    process.exit(1);
  }
}

void skip;
main();
