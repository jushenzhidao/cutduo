#!/usr/bin/env node
/**
 * C3 判据 · editorial 编码路径指纹
 *
 * 为什么需要：P3 要改的就是 `encodeRange`（它的编码实现要换成 src/pipeline.mjs 的
 * partArgs + pumpFrames + spawnPart）。但整片 1130 帧出片成本高于本轮其他验证之和，
 * 所以用「真实编码 30 帧」覆盖这条路径——它走的是同一个函数、同一条 ffmpeg 调用，
 * 只是帧数少。
 *
 * 用法：node .fixloop/scripts/enc-fingerprint.mjs [输出 ts 路径]
 * 输出：{"frames":30,"bytes":...,"md5":"..."}
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const target = process.argv[2] || path.join(ROOT, 'out/arch/enc-30.ts');

// 模块顶层会按 argv 解析 --inputs 并立刻 loadInputs()，所以必须在 import 之前摆好 argv。
// 打包成 ['node','x','--inputs',...] 是为了让模块读到的 slice(2) 与真实 CLI 一致。
process.argv = [process.argv[0], 'x', '--inputs', 'content/inputs-v6.json'];
const m = await import(path.join(ROOT, 'kits', 'editorial', 'canvas-editorial.mjs'));

await m.encodeRange(0, 30, target);
const buf = fs.readFileSync(target);
console.log(JSON.stringify({
  frames: 30,
  bytes: buf.length,
  md5: crypto.createHash('md5').update(buf).digest('hex'),
}));
