/**
 * src/entry-kit.mjs · 出片入口的公共外壳
 *
 * 为什么有这一层：`render.mjs` / `kits/desk/render.mjs` / `kits/mg/render.mjs` 三支的骨架
 * 完全同构——parseArgs、默认值、字体注册、worker 分片、concat、report 各写一遍。
 * 四份默认值就是四个隐性不一致源，而 API 的 `overrides` 白名单假定默认值统一
 * （见 docs/API.md「overrides 白名单」与 tools/check-arch.mjs 的 I1）。
 *
 * **不抽的两样东西**（有意保留在入口里）：
 *   1. `new Worker(new URL(import.meta.url))` —— worker 必须指回入口自身文件，
 *      由入口求值后把 URL 传进来（`runShards({ entryUrl })`）。
 *   2. renderer 的构造 —— 每支版式的画布、内容模型、ready() 语义都不同。
 *
 * 判据：入口文件应该只剩「解析自有参数 + 造 renderer + 转发」三件事。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { planShards, partArgs, pumpFrames, spawnPart, concatParts, report } from './pipeline.mjs';
import { checkDeterminism } from './determinism.mjs';
import { resolveInput } from './root.mjs';

/**
 * 默认 worker 数：每 worker 约吃 2 核（node 进程 + ffmpeg 子进程），上限 32 下限 4。
 * 实测：30 核 M5 用 16 最快（5.6s vs 8 worker 6.7s）；64 核 Xeon 用 32 最快（19.4s vs 22.0s）。
 * 代价是分片变多、体积略增约 5%（mpegts 分片边界更多）。
 */
export function defaultWorkers() {
  return Math.min(32, Math.max(4, Math.floor(os.cpus().length / 2)));
}

/**
 * 解析公共参数。返回对象带 `get`，供入口取自己的私有开关（如 `--kit` / `--presenter`）。
 * @param {string[]} argv
 * @param {{params?:string,out?:string,crf?:number|string,jpeg?:number,preset?:string}} defaults
 */
export function parseStdArgs(argv, defaults = {}) {
  const get = (k, d) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  return {
    params: resolveInput(get('params', defaults.params)),
    audio: resolveInput(get('audio', null), false),
    out: path.resolve(get('out', defaults.out)),
    workers: Math.max(1, Number(get('workers', defaultWorkers()))),
    fps: get('fps', null),
    crf: String(get('crf', defaults.crf ?? 20)),
    jpeg: Number(get('jpeg', defaults.jpeg ?? 94)),
    preset: get('preset', defaults.preset ?? 'veryfast'),
    probe: get('probe', null),
    at: Number(get('at', 2.5)),
    // --check-determinism [auto|t1,t2,t3]：不带值时 auto（片长的 25/50/75%）。
    // 不能复用 get()：它会把后面的 --kit 当成取值，于是「--check-determinism --kit paper」静默变成 spec='--kit'。
    determinism: (() => {
      const i = argv.indexOf('--check-determinism');
      if (i < 0) return null;
      const v = argv[i + 1];
      return v && !v.startsWith('--') ? v : 'auto';
    })(),
    get,
  };
}

/**
 * probe / determinism 分支。返回 true 表示已处理（内部已 process.exit）。
 * `makeRenderer` 必须是 async 且返回 `{ canvas, r }`——science/webcanvas 需要 await ready()。
 */
export async function handleProbeOrDeterminism({ A, P, makeRenderer, width, height, label }) {
  if (!A.probe && !A.determinism) return false;
  const { canvas, r } = await makeRenderer();
  if (A.determinism) {
    const code = checkDeterminism({
      renderer: r,
      ctx: canvas.getContext('2d'),
      width,
      height,
      duration: Number(P.durationSeconds || P.frames / P.fps || 0),
      spec: A.determinism,
      label,
    });
    process.exit(code);
  }
  r.renderFrame(A.at);
  const out = path.resolve(A.probe);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  console.log('probe →', A.probe, `${P.frames} 帧计划`, `t=${A.at}s`);
  process.exit(0);
}

/** worker 内的单分片渲染：起 ffmpeg → 把帧灌进去。所有入口共用同一份。
 *  `x264Threads` 必须透传：漏了它 x264 会按默认线程数跑，同等 CRF 下码率控制不同，
 *  实测 paper 一支体积 0.91→0.93MB —— 只差 2%，但说明参数没走同一条路。 */
export async function renderPart({ renderer, canvas, P, pipe = 'jpeg', crf, preset, jpeg, x264Threads, start, end, part, width, height }) {
  const ff = spawnPart(partArgs({ pipe, fps: P.fps, width, height, crf, preset, jpeg, x264Threads, part }));
  await pumpFrames({ renderer, canvas, fps: P.fps, start, end, ff, pipe, jpeg });
}

/**
 * 主线程：切分片 → 派 worker → concat → report。
 * `entryUrl` 由入口传 `new URL(import.meta.url)`，保证 worker 指回入口自己。
 */
export async function runShards({
  entryUrl,
  P,
  A,
  width,
  height,
  workerData = {},
  tmpPrefix = 'kit',
  pipe = 'jpeg',
}) {
  const t0 = Date.now();
  fs.mkdirSync(path.dirname(A.out), { recursive: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `${tmpPrefix}-`));
  const segs = planShards(P.frames, A.workers, TMP);
  await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
    const w = new Worker(entryUrl, {
      workerData: {
        start: seg.s, end: seg.e, part: seg.part,
        params: A.params, fps: P.fps, width, height,
        crf: A.crf, jpeg: A.jpeg, preset: A.preset, pipe,
        ...workerData,
      },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    w.once('message', (m) => (m && m.ok ? resolve(m) : reject(new Error(m && m.error))));
    w.once('error', reject);
  })));
  concatParts({
    parts: segs.map((s) => s.part),
    tmpDir: TMP,
    out: A.out,
    audio: A.audio,
    fps: P.fps,
    frames: P.frames,
  });
  fs.rmSync(TMP, { recursive: true, force: true });
  report({ out: A.out, frames: P.frames, fps: P.fps, startedAt: t0, workers: A.workers });
}
