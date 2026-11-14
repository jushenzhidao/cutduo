#!/usr/bin/env node
/**
 * tools/publish-pack.mjs · 把一个 content/<片>/ 的成品整理成可以直接发的发布包
 *
 *   node tools/publish-pack.mjs --slug benford
 *   node tools/publish-pack.mjs --slug benford --at 29      # 指定封面取帧时刻
 *
 * 产出 out/publish/<slug>/
 *   <slug>.mp4     成片（复制，不是软链——发的时候要能直接上传）
 *   cover.jpg      封面帧（1920×1080，选取帧时刻可由 --at 指定）
 *   post.txt       标题 / 简介 / 标签，直接复制粘贴
 *   meta.json      时长、分辨率、帧数、大小、响度、台账摘要
 *
 * 设计原则：**只做能确定的事**。封面是成片里真实的一帧（不重新排版、不 P 图），
 * 文案来自 script.json 与 facts.md（不生成没根据的卖点）。平台规格差异（竖屏裁剪、
 * 时长上限）留给人判断，因为不同平台规矩不一样，硬编码只会做错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const slug = arg('slug');
if (!slug) {
  console.error('用法: node tools/publish-pack.mjs --slug <片名> [--at <封面秒数>]');
  process.exit(2);
}

const DIR = path.join(ROOT, 'content', slug);
const film = path.join(ROOT, 'out', slug + '.mp4');
if (!fs.existsSync(film)) {
  console.error(`没有成片：out/${slug}.mp4（先跑 content/${slug}/make.sh）`);
  process.exit(2);
}

const params = JSON.parse(fs.readFileSync(path.join(DIR, 'params-abs.json'), 'utf8'));
// science 版式用 segments（dur 累积），paper 用 scenes（t0/t1）——封面取帧要两边都认
// 三种容器都认：paper 的 scenes、science 的 segments、desk 的 shots
const SCENES = params.scenes || params.segments || params.shots || [];
const script = JSON.parse(fs.readFileSync(path.join(DIR, 'script.json'), 'utf8'));
const outDir = path.join(ROOT, 'out', 'publish', slug);
fs.mkdirSync(outDir, { recursive: true });

/* ---------- 探实际规格（不信任 params，以成片为准） ---------- */
const probe = (sel) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', sel,
  '-show_entries', 'stream=width,height,r_frame_rate,nb_frames', '-of', 'json', film], { encoding: 'utf8' });
const v = JSON.parse(probe('v:0')).streams[0];
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', film], { encoding: 'utf8' }).trim());
const sizeMB = (fs.statSync(film).size / 1e6).toFixed(2);
const fps = Math.round(eval(v.r_frame_rate.replace('/', '/')) * 100) / 100;

/* ---------- 文案 ---------- */
const at = Number(arg('at', pickCoverTime()));

// desk 版式的稿子用 shots 不是 beats
const beats = script.beats || script.shots || [];
const hook = beats[0] ? String(beats[0].text) : '';
const last = beats.length ? String(beats[beats.length - 1].text) : '';
// 标题：优先 script.title；太长就压到 24 字以内（平台标题区普遍只显示这么多）
let title = script.title || slug;
if (title.length > 24) title = title.slice(0, 23) + '…';
const titleForCover = script.title || slug;
// 简介：钩子句 + 结尾句，都是稿子里真有的原话，不另编卖点
const desc = [hook, last].filter(Boolean).join(' ').slice(0, 110);

const tags = ['知识科普', '冷知识'].slice();
for (const b of beats) if (b.screens && b.screens[0] && b.screens[0].chart) tags.push('数据可视化');
if (/数学|概率|数/.test(JSON.stringify(script))) tags.push('数学');

const post = [
  `标题：${title}`,
  '',
  `简介：${desc}`,
  '',
  `标签：${[...new Set(tags)].join(' ')}`,
  '',
  '---',
  `时长 ${dur.toFixed(1)}s · ${v.width}×${v.height} · ${fps}fps · ${sizeMB}MB`,
  `封面取自 ${at}s（成片原帧，未重排）`,
].join('\n');
fs.writeFileSync(path.join(outDir, 'post.txt'), post);

/* ---------- 封面：从成片里取一帧 ---------- */
// 默认取"信息最满"的时刻。要点是**取段末而不是段中**：
// chart / grid 的元素是逐个长出来的，取中点会得到"只画了一半"的图（实测封面只有 7 根柱子）。
function pickCoverTime() {
  const want = ['chart', 'grid', 'number', 'compare', 'diagram', 'talk', 'focus'];
  for (const t of want) {
    const i = SCENES.findIndex((x) => x.type === t);
    if (i < 0) continue;
    const s = SCENES[i];
    if (Number.isFinite(s.t0)) return +Math.max(s.t0 + 0.5, s.t1 - 1.2).toFixed(2);
    // segments 只有 dur：用前缀和算绝对时刻
    let at = 0;
    for (let k = 0; k < i; k++) at += Number(SCENES[k].dur || 0) + 0.25;
    return +(at + Math.max(0.5, Number(s.dur) - 1.2)).toFixed(2);
  }
  const first = SCENES[0];
  if (!first) return dur * 0.5;
  return Number.isFinite(first.t0) ? +(first.t0 + (first.t1 - first.t0) * 0.8).toFixed(2) : dur * 0.5;
}
const cover = path.join(outDir, 'cover.jpg');
// 封面上必须能读出标题——成片里标题只在开场出现几秒，取图表帧时它是没有的。
// 所以压一条标题带（不是重新排版，是封面常规做法）；底部字幕正好被带子盖住，封面不带字幕。
//
// 2026-11-14：从 ffmpeg drawbox+drawtext 改成 @napi-rs/canvas 绘制。
// 根因是本机 ffmpeg 不带 freetype（`ffmpeg -filters` 里根本没有 drawtext），整条滤镜链直接报
// "No such filter: 'drawtext'"；而 drawtext 还要求字体是单个 TTF/OTF（PingFang.ttc 索引不到中文字形）。
// 仓库本来就依赖 canvas，用它画反而少一个系统依赖。
const FONT = path.join(ROOT, 'assets/fonts/LXGWWenKai-Regular.ttf');
const rawCover = path.join(outDir, '.cover-raw.png');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', film, '-frames:v', '1', rawCover]);
{
  const img = await loadImage(rawCover);
  const cv = createCanvas(img.width, img.height);
  const g = cv.getContext('2d');
  g.drawImage(img, 0, 0);
  // 纸色不透明色带：半透明会让成片里的字幕条透出来，标题就和字幕打架（实测 black@0.62）
  const BAND = 210, SIZE = 76;
  // 色带颜色取自画面左上角的空白纸面，而不是写死 #EFEFE5：
  // 各支片子的纸色略有差异（paper 的 bg 每次可微调），写死会在封面上留一道横缝。
  const [r0, g0, b0] = g.getImageData(8, 8, 1, 1).data;
  g.fillStyle = `rgb(${r0},${g0},${b0})`;
  g.fillRect(0, img.height - BAND, img.width, BAND);
  if (!GlobalFonts.has('CoverKai')) GlobalFonts.registerFromPath(FONT, 'CoverKai');
  g.font = `${SIZE}px CoverKai`;
  g.fillStyle = '#15231A';
  g.textBaseline = 'middle';
  g.fillText(titleForCover, 72, img.height - BAND + BAND / 2);
  fs.writeFileSync(cover, cv.toBuffer('image/jpeg', 92));
}
fs.unlinkSync(rawCover);

/* ---------- 元信息 ---------- */
const factsFile = path.join(DIR, 'facts.md');
const factCount = fs.existsSync(factsFile)
  ? (fs.readFileSync(factsFile, 'utf8').match(/^\|\s*\d+\s*\|/gm) || []).length
  : 0;

const meta = {
  slug, title, durationSeconds: +dur.toFixed(3), width: v.width, height: v.height, fps,
  frames: Number(v.nb_frames) || null, sizeMB: +sizeMB, coverAt: at,
  template: script.template, tier: script.tier, beats: beats.length,
  scenes: SCENES.length, factRows: factCount,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));

/* ---------- 成片 ---------- */
fs.copyFileSync(film, path.join(outDir, slug + '.mp4'));

/* ---------- 竖屏版（可选 --vertical） ---------- */
let vertical = null;
if (process.argv.includes('--vertical')) {
  const vf = path.join(ROOT, 'out', 'vertical', `${slug}-9x16.mp4`);
  if (!fs.existsSync(vf)) {
    execFileSync('node', [path.join(ROOT, 'tools', 'reframe.mjs'), '--slug', slug], { stdio: 'inherit' });
  }
  if (fs.existsSync(vf)) {
    fs.copyFileSync(vf, path.join(outDir, slug + '-9x16.mp4'));
    vertical = `out/vertical/${slug}-9x16.mp4`;
  }
}

console.log(`✓ out/publish/${slug}/`);
console.log(`   ${slug}.mp4   ${dur.toFixed(1)}s · ${v.width}×${v.height} · ${sizeMB}MB`);
console.log(`   cover.jpg   ${at}s 处的原帧`);
console.log(`   post.txt    标题「${title}」`);
console.log(`   meta.json   ${meta.scenes} 段 / ${meta.beats} 拍 / 台账 ${factCount} 条`);
if (vertical) console.log(`   ${slug}-9x16.mp4   竖屏版（模糊填充，内容未裁）`);
