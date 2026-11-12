/**
 * api/jobs.mjs · 异步出片、并发排队与状态查询
 *
 * 为什么需要：`render()` 是同步的，40 秒片约 6 秒尚可接受；分钟级长片会卡住调用方，
 * 而 agent 通常没有耐心等一个不返回的调用。
 *
 * 四条实现约束，改这个文件前必须知道：
 *
 * 1. **一个 job 一个独立进程**（detached + unref），不是 worker 线程。
 *    API 进程可能先退出，job 必须继续跑；线程会随宿主进程一起死。
 * 2. **状态只落在文件里**，不留在内存。任何进程（含重启后的 CLI）都能查同一份状态。
 * 3. **判定终态以产物为准，不以 pid 为准**。系统会复用 pid，`kill(pid,0)` 成功
 *    不代表还是那个 job。早期版本只看 pid，导致已完成的 job 永久卡在 running ——
 *    这比报错更糟，调用方会一直等。
 * 4. **并发靠排队，不靠拒绝**。每个渲染本身已经 8 worker，多开只会互相拖慢。
 *    超出上限的任务停在 `queued`，等空位。
 *
 * 调度的代价：没有常驻调度器，补位发生在 `submit()` / `status()` / `list()` 调用时
 * （lazy scheduling）。也就是说 **`status()` 不是纯查询** —— 它会顺带启动队首任务。
 * 代价是「没人轮询时队列不动」，但既然没人在轮询，也就没人在等结果，晚点跑不影响正确性。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { REPO_ROOT, DIRS } from '../src/root.mjs';
import { ApiError, CODE } from './errors.mjs';

const JOB_DIR = path.join(DIRS.out, 'jobs');
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/** 并发上限：每个 job 默认 8 worker，按「每 8 核一个」估，夹在 1–4 之间。可用 CUTDUO_MAX_JOBS 覆盖。 */
export const MAX_JOBS = (() => {
  const env = Number(process.env.CUTDUO_MAX_JOBS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return Math.max(1, Math.min(4, Math.floor(os.cpus().length / 8)));
})();

const pad = (n, w = 2) => String(n).padStart(w, '0');

function newId() {
  const d = new Date();
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `job-${ts}-${Math.random().toString(36).slice(2, 8)}`;
}

const jsonPath = (id) => path.join(JOB_DIR, `${id}.json`);
const stdoutPath = (id) => path.join(JOB_DIR, `${id}.stdout.json`);
const stderrPath = (id) => path.join(JOB_DIR, `${id}.stderr.log`);

function readJob(id) {
  const p = jsonPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJob(job) {
  fs.mkdirSync(JOB_DIR, { recursive: true });
  // 先写临时文件再 rename：避免轮询方读到半个 JSON
  const tmp = jsonPath(job.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, jsonPath(job.id));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const tail = (s, n = 6) => String(s || '').trim().split('\n').slice(-n).join('\n');

/** 只认 job 状态文件本身：排除 <id>.stdout.json 与 <id>.json.tmp */
const JOB_FILE = /^job-\d{8}-\d{6}-[a-z0-9]+\.json$/;

function listIds() {
  if (!fs.existsSync(JOB_DIR)) return [];
  return fs.readdirSync(JOB_DIR).filter((f) => JOB_FILE.test(f)).map((f) => f.replace(/\.json$/, ''));
}

function readStdout(id) {
  const p = stdoutPath(id);
  const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // 可能正在写，下次轮询再看
  }
}

/**
 * 把单个 job 推进到它能到达的最新状态。幂等。
 * 只处理 running；queued 与终态原样返回。
 */
function reconcile(job) {
  if (job.status !== 'running') return job;

  // 先找终局证据：stdout 是完整 JSON 就说明子进程已跑完
  const parsed = readStdout(job.id);
  const hasVerdict = !!(parsed && (parsed.ok || parsed.error));

  if (!hasVerdict) {
    if (alive(job.pid)) return job; // 确实还在跑
    job.status = 'failed';
    job.error = {
      code: CODE.RENDER_FAILED,
      message: '子进程已退出，但没有产出可解析的回执',
      hint: '常见于进程被系统杀死（OOM）或 stdin 传递失败',
      fix: '降 workers 到 2 重试；若反复出现，改用同步 render() 看完整 stderr',
      details: { stderr: tail(fs.existsSync(stderrPath(job.id)) ? fs.readFileSync(stderrPath(job.id), 'utf8') : '') },
    };
    job.finishedAt = new Date().toISOString();
    writeJob(job);
    return job;
  }

  if (parsed.ok) {
    job.status = 'done';
    job.receipt = parsed;
  } else {
    job.status = 'failed';
    job.error = parsed.error;
  }

  // 完成时刻取 stdout 的 mtime，而不是「我判定它的那一刻」。
  // 用 now() 会把「任务完成到下次轮询之间」的空档算进耗时，
  // 于是同一个 job 在不同时间查询会得到不同的 elapsed —— 回执就不成立了。
  const st = fs.existsSync(stdoutPath(job.id)) ? fs.statSync(stdoutPath(job.id)) : null;
  job.finishedAt = st ? st.mtime.toISOString() : new Date().toISOString();
  writeJob(job);
  return job;
}

/** 真正拉起进程。只在调度器里调用。 */
function launch(job) {
  fs.mkdirSync(JOB_DIR, { recursive: true });
  const outFd = fs.openSync(stdoutPath(job.id), 'w');
  const errFd = fs.openSync(stderrPath(job.id), 'w');

  // stdin 传请求：避免把参数塞进命令行（长度限制 + 转义问题）
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'api', 'cli.mjs'), 'render', '--stdin', '--json'], {
    cwd: REPO_ROOT,
    detached: true, // 与当前进程组脱离，API 退出后继续跑
    stdio: ['pipe', outFd, errFd],
  });
  try {
    child.stdin.end(JSON.stringify(job.request));
  } catch {
    /* 子进程若已退出，stdin 会 EPIPE；reconcile 会兜住 */
  }
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  job.pid = child.pid;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  writeJob(job);
  return job;
}

/**
 * 补位：把 queued 里最早的任务拉起来，直到 running 达到上限。
 * 会读全部 job 文件并 reconcile 一遍，顺带释放「已死但状态没更新」的槽位。
 */
function schedule() {
  const jobs = listIds().map(readJob).filter(Boolean).map(reconcile);
  const running = jobs.filter((j) => j.status === 'running');
  if (running.length >= MAX_JOBS) return;

  const queued = jobs
    .filter((j) => j.status === 'queued')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  for (const job of queued) {
    if (running.length >= MAX_JOBS) break;
    launch(job);
    running.push(job);
  }
}

/** 排队位置，1 表示下一个就会被拉起。 */
function queuePosition(id) {
  const queued = listIds()
    .map(readJob)
    .filter((j) => j && j.status === 'queued')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const idx = queued.findIndex((j) => j.id === id);
  return idx >= 0 ? idx + 1 : null;
}

/**
 * 提交一个异步出片任务。立即返回，不等待渲染。
 * 有空位就直接跑，没空位就排队（status='queued' + queuePosition）。
 * @returns {{ok:true, jobId:string, status:string, pid?:number, queuePosition?:number|null, maxConcurrent:number}}
 */
export function submit(req) {
  if (!req || typeof req !== 'object') {
    throw new ApiError(CODE.BAD_REQUEST, '请求必须是对象', {
      fix: '例如 { "kit": "paper", "preset": "v8t" }',
    });
  }
  fs.mkdirSync(JOB_DIR, { recursive: true });

  const id = newId();
  writeJob({
    id,
    status: 'queued',
    kit: req.kit ?? null,
    request: req,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    pid: null,
    receipt: null,
    error: null,
  });

  schedule();

  const job = readJob(id);
  return {
    ok: true,
    jobId: id,
    status: job.status,
    ...(job.pid ? { pid: job.pid } : {}),
    ...(job.status === 'queued' ? { queuePosition: queuePosition(id) } : {}),
    maxConcurrent: MAX_JOBS,
  };
}

/**
 * 查询状态。**不是纯查询**：会补位拉起排队中的任务（见文件头说明）。
 */
export function status(id) {
  const found = readJob(id);
  if (!found) {
    throw new ApiError(CODE.JOB_NOT_FOUND, `job 不存在：${id}`, {
      hint: 'job 记录在 out/jobs/<id>.json，可能已被清理',
      fix: '用 jobs 列出最近的 job，或重新 submit',
      details: { dir: path.relative(REPO_ROOT, JOB_DIR) },
    });
  }
  reconcile(found);
  schedule();
  // 补位可能刚把这个 job 拉起来，重读一次
  return shape(readJob(id) || found);
}

function shape(job) {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const start = job.startedAt ? Date.parse(job.startedAt) : Date.parse(job.createdAt);
  const elapsedSeconds = Math.max(0, Number(((end - start) / 1000).toFixed(1)));
  return {
    ok: true,
    jobId: job.id,
    status: job.status,
    kit: job.kit,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedSeconds,
    ...(job.status === 'queued' ? { queuePosition: queuePosition(job.id) } : {}),
    ...(job.status === 'running' ? { pid: job.pid } : {}),
    ...(job.receipt ? { receipt: job.receipt } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

/**
 * 最近的任务，按创建时间倒序。同样会补位（否则队列会因为没有 status 调用而停住）。
 */
export function list(limit = 20) {
  if (!fs.existsSync(JOB_DIR)) return { ok: true, jobs: [], maxConcurrent: MAX_JOBS };
  schedule();
  const jobs = listIds()
    .map(readJob)
    .filter(Boolean)
    .map(reconcile)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map(shape);
  return { ok: true, jobs, maxConcurrent: MAX_JOBS };
}

/**
 * 取消。queued 的直接出队；running 的先 SIGTERM 给 2 秒收尾（ffmpeg 会留下不完整 mp4），再 SIGKILL。
 */
export async function cancel(id) {
  const job = readJob(id);
  if (!job) {
    throw new ApiError(CODE.JOB_NOT_FOUND, `job 不存在：${id}`, {
      fix: '用 jobs 列出最近的 job',
    });
  }
  if (TERMINAL.has(job.status)) {
    return { ok: true, jobId: id, status: job.status, note: '已是终态，无需取消' };
  }

  if (job.status === 'running' && alive(job.pid)) {
    try { process.kill(job.pid, 'SIGTERM'); } catch { /* 已退出 */ }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && alive(job.pid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (alive(job.pid)) {
      try { process.kill(job.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
  }

  job.status = 'cancelled';
  job.finishedAt = new Date().toISOString();
  job.error = { code: CODE.RENDER_FAILED, message: '任务被取消' };
  writeJob(job);

  // 腾出槽位，立刻补位下一个（取消常发生在长任务上，不补位会白等）
  schedule();
  return { ok: true, jobId: id, status: 'cancelled' };
}
