#!/usr/bin/env node
/**
 * web/pipeline.mjs — 一个客户任务的完整链路（独立进程）
 *
 *   node web/pipeline.mjs --id <jobId> --spec <spec.json>
 *
 * 六个阶段，每步都把状态写进 `out/web/<id>/status.json`（前端轮询这个文件）：
 *   validate → 生成参数 → 配音重排(vo.py) → 出片(render.mjs) → 配乐(add-bgm) → 门禁(gate)
 *
 * 为什么独立进程：TTS + 渲染合计 30–90s，HTTP 请求扛不住；进程死了状态文件还在，
 * 前端能直接看到"第几步失败"，不用翻服务端日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build, MALE_VOICES } from './lib/build.mjs';
import { REPO_ROOT } from '../src/root.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ID = arg('id');
const SPEC = arg('spec');
if (!ID || !SPEC) { console.error('用法: node web/pipeline.mjs --id <jobId> --spec <spec.json>'); process.exit(2); }

const DIR = path.join(REPO_ROOT, 'out', 'web', ID);
fs.mkdirSync(DIR, { recursive: true });
const STATUS = path.join(DIR, 'status.json');
const LOG = path.join(DIR, 'pipeline.log');

const started = Date.now();
let current = { id: ID, stage: 'init', pct: 0, msg: '准备中', startedAt: started };

function write(patch) {
  current = { ...current, ...patch, updatedAt: Date.now() };
  fs.writeFileSync(STATUS, JSON.stringify(current, null, 2));
}
function log(line) {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
}
/** 长阶段的心跳：让前端进度条在 TTS 期间也在动，而不是卡在 15% 一分钟。 */
let ticker = null;
function stage(name, pct, msg, ceiling) {
  if (ticker) clearInterval(ticker);
  write({ stage: name, pct, msg });
  if (ceiling > pct) {
    ticker = setInterval(() => {
      if (current.pct < ceiling - 1) write({ pct: current.pct + 1 });
    }, 1200);
  }
}
function fail(stageName, err) {
  if (ticker) clearInterval(ticker);
  const tail = String(err || '').slice(-1200);
  log(`FAIL ${stageName}: ${tail}`);
  write({ stage: stageName, failed: true, error: tail, msg: '失败', elapsedMs: Date.now() - started });
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const voice = spec.voice || 'zh-CN-XiaoxiaoNeural';
const rate = spec.rate || '+5%';

// ── 1. 校验并编译参数 ───────────────────────────────────────────────
stage('validate', 4, '校验字段与容量');
const r = build(spec);
if (!r.ok) {
  write({ stage: 'validate', failed: true, msg: '表单有 ' + r.errors.length + ' 处需要改', errors: r.errors, elapsedMs: Date.now() - started });
  process.exit(0); // 表单问题不是系统故障，前端按 errors 渲染
}
const params = r.params;

// 男声必须配男性讲解员（否则声音与画面不是同一个人）
if (MALE_VOICES.has(voice)) {
  params.figureGender = 'male';
  for (const s of params.segments) {
    if (s.type === 'talk') s.args.figureImage = 'kits/science/template/assets/figures/male-idle.png';
  }
}
fs.writeFileSync(path.join(DIR, 'preset.json'), JSON.stringify(params, null, 2));
log(`preset 写出 · ${params.segments.length} 段 · ${params.captions.length} 句`);

// ── 2. 配音 + 时间轴重排 ────────────────────────────────────────────
stage('tts', 12, `配音与时间轴重排（${params.captions.length} 句）`, 52);
const voPreset = path.join(DIR, 'vo.json');
const wav = path.join(DIR, 'vo.wav');
const vo = spawnSync('uv', ['run', '--with', 'numpy', 'python', 'tools/vo.py',
  '--preset', path.join(DIR, 'preset.json'),
  '--out-preset', voPreset, '--out-audio', wav,
  '--voice', voice, '--rate', rate], {
  cwd: path.join(REPO_ROOT, 'kits', 'science', 'template'),
  encoding: 'utf8', env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
});
log('vo.py rc=' + vo.status + '\n' + (vo.stdout || '') + (vo.stderr || ''));
if (vo.status !== 0 || !fs.existsSync(voPreset)) fail('tts', vo.stderr || vo.stdout || 'vo.py 失败');

// 男人物/性别声明要在 vo 之后重新写回（vo.py 会重写 segments）
const voiced = JSON.parse(fs.readFileSync(voPreset, 'utf8'));
if (params.figureGender) {
  voiced.figureGender = params.figureGender;
  for (const s of voiced.segments) {
    if (s.type === 'talk' && params.segments.find((x) => x.type === 'talk')?.args.figureImage) {
      s.args.figureImage = 'kits/science/template/assets/figures/male-idle.png';
    }
  }
  fs.writeFileSync(voPreset, JSON.stringify(voiced, null, 2));
}

// ── 3. 出片 ────────────────────────────────────────────────────────
stage('render', 55, '渲染画面', 82);
const rawMp4 = path.join(DIR, 'raw.mp4');
const rd = spawnSync('node', ['render.mjs', '--kit', 'science', '--params', voPreset,
  '--audio', wav, '--out', rawMp4, '--fps', '30', '--workers', '8'], { cwd: REPO_ROOT, encoding: 'utf8' });
log('render rc=' + rd.status + '\n' + (rd.stdout || '') + (rd.stderr || ''));
if (rd.status !== 0 || !fs.existsSync(rawMp4)) fail('render', rd.stderr || rd.stdout || 'render.mjs 失败');

// ── 4. 配乐（失败不阻断，客户至少拿到无 BGM 版） ──────────────────────
let final = rawMp4;
if (spec.bgm) {
  stage('bgm', 85, '混入背景音乐', 92);
  const bgmOut = path.join(DIR, 'final.mp4');
  const bg = spawnSync('node', ['tools/add-bgm.mjs', '--video', rawMp4,
    '--loop', spec.bgmLoop || 'Mellow Drizzle Soft Pad', '--out', bgmOut], { cwd: REPO_ROOT, encoding: 'utf8' });
  log('add-bgm rc=' + bg.status + '\n' + (bg.stdout || '') + (bg.stderr || ''));
  if (bg.status === 0 && fs.existsSync(bgmOut)) final = bgmOut;
  else write({ bgmSkipped: true, bgmReason: (bg.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ') });
}

// ── 5. 门禁 ────────────────────────────────────────────────────────
stage('gate', 94, '交付门禁', 99);
const g = spawnSync('node', ['src/gate.mjs', final, '--require-audio', '--json', path.join(DIR, 'gate.json')],
  { cwd: REPO_ROOT, encoding: 'utf8' });
log('gate rc=' + g.status + '\n' + (g.stdout || '') + (g.stderr || ''));
let gate = null;
try { gate = JSON.parse(fs.readFileSync(path.join(DIR, 'gate.json'), 'utf8'))[0]; } catch { /* 忽略 */ }

// ── 6. 完成 ────────────────────────────────────────────────────────
if (ticker) clearInterval(ticker);
const stat = fs.statSync(final);
const dur = (() => {
  try {
    const o = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', final], { encoding: 'utf8' });
    return Number(o.stdout.trim());
  } catch { return null; }
})();
write({
  stage: 'done', pct: 100, msg: '完成', failed: false,
  video: path.relative(REPO_ROOT, final),
  videoUrl: `/api/jobs/${ID}/video`,
  sizeMB: +(stat.size / 1048576).toFixed(2),
  durationSeconds: dur,
  segments: voiced.segments.length,
  captions: voiced.captions.length,
  voice, gate: gate ? { verdict: gate.verdict, frames: `${gate.frames}/${gate.expectFrames || gate.frames}`, hook: gate.hook } : null,
  elapsedMs: Date.now() - started,
});
log(`DONE ${final} ${(stat.size / 1048576).toFixed(2)}MB ${dur}s`);
