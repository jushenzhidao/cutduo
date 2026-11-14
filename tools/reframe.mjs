#!/usr/bin/env node
/**
 * tools/reframe.mjs · 横屏成片转竖屏 / 方屏（模糊填充，不裁内容）
 *
 *   node tools/reframe.mjs --slug benford                 # 9:16 竖屏
 *   node tools/reframe.mjs --slug benford --ratio 1:1     # 1:1 方屏
 *   node tools/reframe.mjs --in out/x.mp4 --out out/y.mp4 --ratio 9:16
 *
 * 为什么不重排版式：paper 的栅格按 1920×1080 定的、全是绝对坐标，改成 1080×1920
 * 等于重写布局；而 science 的讲解员/器官位置同理。成本高、风险大。
 * 为什么不直接裁：会切掉右侧关键词卡和底部字幕，等于丢内容。
 *
 * 做法：原画面放大模糊当背景铺满，原画面按宽度缩放居中叠上去。
 * 内容一帧不少，手机上也占满屏；代价是上下各留一条模糊区（这是竖屏发横屏内容的通行做法）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const RATIOS = {
  '9:16': { w: 1080, h: 1920, name: 'vertical' },
  '1:1': { w: 1080, h: 1080, name: 'square' },
  '3:4': { w: 1080, h: 1440, name: 'portrait34' },
};

const ratio = arg('ratio', '9:16');
const spec = RATIOS[ratio];
if (!spec) {
  console.error(`未知比例 ${ratio}；可用：${Object.keys(RATIOS).join(' / ')}`);
  process.exit(2);
}

let input = arg('in');
let output = arg('out');
const slug = arg('slug');

if (slug && !input) {
  input = path.join(ROOT, 'out', slug + '.mp4');
  output = output || path.join(ROOT, 'out', spec.name, `${slug}-${ratio.replace(':', 'x')}.mp4`);
}
if (!input || !fs.existsSync(input)) {
  console.error(`输入不存在：${input || '(未指定)'}`);
  process.exit(2);
}
fs.mkdirSync(path.dirname(output), { recursive: true });

const { w: W, h: H } = spec;

/* 背景：原画面按"填满"缩放 + 裁到目标比例 + 高斯模糊 + 压暗 + 降饱和（否则原画面的色块会抢前景）
   前景：原画面按宽度缩放，垂直居中叠上去 */
const filter = [
  `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=48,eq=brightness=-0.18:saturation=0.55[bg]`,
  `[0:v]scale=${W}:-2:flags=lanczos[fg]`,
  `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v]`,
].join(';');

execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input,
  '-filter_complex', filter, '-map', '[v]', '-map', '0:a?',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output]);

const probe = (f, e) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', e, '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim();
const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', output], { encoding: 'utf8' }).trim();
const mb = (fs.statSync(output).size / 1e6).toFixed(2);

console.log(`✓ ${path.relative(ROOT, output)}`);
console.log(`   ${W}×${H} (${ratio}) · ${Number(dur).toFixed(1)}s · ${mb}MB · 内容未裁，上下为模糊填充`);
