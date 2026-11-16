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
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { planShards, partArgs, pumpFrames, spawnPart, concatParts, report } from './pipeline.mjs';
import { checkDeterminism } from './determinism.mjs';
import { resolveInput } from './root.mjs';

/**
 * 容器实际可用的 CPU 数。
 *
 * **不能用 os.cpus().length**：容器里它返回的是宿主核数（ai-prod 是 64），
 * 而不是容器被限到多少。2026-11-16 因此算出 32 worker —— 每个 worker 的 V8 堆上限
 * 是 512MB，32 个就是 16GB，叠加机器上另外 30 多个服务直接把 ai-prod 打成 swap thrashing，
 * SSH 登不进、8787 无响应、公网 504，整机失联十几分钟。
 *
 * 优先读 cgroup：v2 的 cpu.max（"配额 周期"），v1 的 cfs_quota/cfs_period。
 */
function availableCpus() {
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (raw[0] && raw[0] !== 'max') return Number(raw[0]) / Number(raw[1] || 100000);
  } catch { /* 非 v2 或没有 cgroup */ }
  try {
    const q = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
    const per = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
    if (q > 0 && per > 0) return q / per;
  } catch { /* v1 也没有 */ }
  return os.cpus().length;
}

/**
 * 容器内存上限（MB）。cgroup v2 的 memory.max / v1 的 limit_in_bytes，读不到就用宿主总量。
 */
function availableMemoryMB() {
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (raw && raw !== 'max') return Number(raw) / 1048576;
  } catch { /* 非 v2 */ }
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
    const n = Number(raw);
    if (n > 0 && n < 1e15) return n / 1048576;   // v1 无限额时是个天文数字
  } catch { /* v1 也没有 */ }
  return os.totalmem() / 1048576;
}

/**
 * 默认 worker 数：并行度优先，但**必须被内存卡住**。
 *
 * 实测（core-4 / i9-14900KS 25 逻辑核配额 / desk 1440×1080 / 16GB 限额）：
 *   8 → 17.42s (196 fps)
 *  12 → 14.13s (242 fps)
 *  16 → 12.18s (281 fps)   ← 甜点
 *  20/24/32 → OOM SIGKILL
 * 每 worker 峰值约 800MB（V8 堆上限 512MB + canvas/照片/ffmpeg），
 * 所以 16GB 只能装 20 个，留余量取 16。
 *
 * 上一版上限写死 8 是「被打挂一次之后的过度保守」：那次是 ai-prod 上 32 worker
 * 且容器无内存限制，打挂的是整台机器。现在有 mem_limit 兜底，OOM 只会杀掉
 * 容器内的渲染进程并返回 RENDER_FAILED —— 失败可控，就该把并行度用满。
 *
 * 共享机器想更保守，用 CUTDUO_MAX_WORKERS 覆盖（ai-prod 建议 8）。
 */
export function defaultWorkers() {
  const hardCap = Number(process.env.CUTDUO_MAX_WORKERS || 0) || 16;
  const byCpu = Math.max(2, Math.floor(availableCpus()));      // 一 worker 一核
  const byMem = Math.max(2, Math.floor(availableMemoryMB() / 800));  // 实测每 worker ~800MB
  return Math.min(hardCap, byCpu, byMem);
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
export async function renderPart({ renderer, canvas, P, pipe = 'jpeg', crf, preset, jpeg, x264Threads, start, end, part, width, height, partIndex }) {
  const ff = spawnPart(partArgs({ pipe, fps: P.fps, width, height, crf, preset, jpeg, x264Threads, part }));
  // 进度写 stderr，带分片号：多个 worker 并发写同一个 stderr 文件，
  // 但一行 JSON 远小于 4KB，POSIX 下是原子写，不会互相截断。
  // upper 层（api/jobs.mjs）按 part 号取每个分片的最新一条再求和。
  // 分片标识优先用显式索引，否则用起点帧号 —— 各分片的 start 天然互不相同，
  // 这样 9 个调用点一个都不用改，也不会漏掉新增的入口。
  // **默认值不能写 0**：`0 ?? start` 是 0（?? 只对 null/undefined 生效），
  // 曾因此让 15 个分片全标成 part 0，进度互相覆盖、出现倒退。
  const partKey = partIndex !== undefined ? partIndex : start;
  // worker 线程里绝不能直接写 process.stderr：实测（2026-11-16）它的输出到不了
  // 父进程被重定向到文件的 fd（同步跑能看到、走 job 时 stderr 文件 0 字节）。
  // 所以 worker 走 postMessage 交给主线程，由主线程统一写 —— 顺带能在这里按分片合并。
  const onProgress = (done, total) => {
    const msg = { part: partKey, done, total };
    if (isMainThread) process.stderr.write(`@@progress ${JSON.stringify(msg)}\n`);
    else parentPort.postMessage({ progress: msg });
  };
  await pumpFrames({ renderer, canvas, fps: P.fps, start, end, ff, pipe, jpeg, onProgress });
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
    // 用 on 而不是 once：worker 会先发若干条 progress，最后才发 {ok:true}。
    // once 只能吃到第一条（progress），任务就永远 resolve 不了。
    w.on('message', (m) => {
      if (m && m.progress) {
        process.stderr.write(`@@progress ${JSON.stringify(m.progress)}\n`);
        return;
      }
      if (m && m.ok) resolve(m);
      else reject(new Error((m && m.error) || 'worker 未返回可识别的结果'));
    });
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
