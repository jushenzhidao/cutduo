/**
 * api/jobs.mjs · 异步出片与状态查询
 *
 * 为什么需要：`render()` 是同步的，40 秒片约 5–16 秒，尚可接受；分钟级长片会卡住调用方，
 * 而 agent 通常没有耐心等一个不返回的调用。
 *
 * 设计取舍：
 *
 * 1. **一个 job 一个独立进程**（detached + unref），不是 worker 线程。
 *    理由：API 进程可能先退出，job 必须继续跑；线程会随宿主进程一起死。
 * 2. **状态只落在文件里**，不留在内存。任何进程（包括重启后的 CLI）都能查询同一份状态。
 * 3. **状态可自愈**：读到的 status 是 running 但 pid 已死时，就地根据 stdout 判定
 *    是 done 还是 failed，并把结论写回。否则轮询方会永远卡在 running —— 这比报错更糟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, DIRS } from '../src/root.mjs';
import { ApiError, CODE } from './errors.mjs';

const JOB_DIR = path.join(DIRS.out, 'jobs');
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

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
    // EPERM 说明进程存在但无权限（不该发生），仍按存活处理
    return e.code === 'EPERM';
  }
}

const tail = (s, n = 6) => String(s || '').trim().split('\n').slice(-n).join('\n');

/**
 * 提交一个异步出片任务。立即返回，不等待渲染。
 * @param {object} req 与 render() 相同的请求形状
 * @returns {{ok:true, jobId:string, status:string, pid:number}}
 */
export function submit(req) {
  if (!req || typeof req !== 'object') {
    throw new ApiError(CODE.BAD_REQUEST, '请求必须是对象', {
      fix: '例如 { "kit": "paper", "preset": "v8t" }',
    });
  }
  fs.mkdirSync(JOB_DIR, { recursive: true });

  const id = newId();
  const job = {
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
  };
  writeJob(job);

  const outFd = fs.openSync(stdoutPath(id), 'w');
  const errFd = fs.openSync(stderrPath(id), 'w');

  // stdin 传请求：避免把参数塞进命令行（长度限制 + 转义问题）
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'api', 'cli.mjs'), 'render', '--stdin', '--json'], {
    cwd: REPO_ROOT,
    detached: true, // 与当前进程组脱离，API 退出后继续跑
    stdio: ['pipe', outFd, errFd],
  });
  try {
    child.stdin.end(JSON.stringify(req));
  } catch {
    /* 子进程若已退出，stdin 会 EPIPE；状态自愈逻辑会兜住 */
  }
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  job.pid = child.pid;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  writeJob(job);

  return { ok: true, jobId: id, status: 'running', pid: child.pid };
}

/**
 * 查询状态。running 且进程已死时就地判定结果并写回（自愈）。
 */
export function status(id) {
  const job = readJob(id);
  if (!job) {
    throw new ApiError(CODE.JOB_NOT_FOUND, `job 不存在：${id}`, {
      hint: 'job 记录在 out/jobs/<id>.json，可能已被清理',
      fix: '用 jobs 列出最近的 job，或重新 submit',
      details: { dir: path.relative(REPO_ROOT, JOB_DIR) },
    });
  }
  if (TERMINAL.has(job.status)) return shape(job);

  // 先找终局证据：stdout 是完整 JSON，就说明子进程已经跑完。
  // 不能只看 pid —— 系统会复用 pid，kill(pid, 0) 成功不代表还是这个 job；
  // 曾经因此把已完成的 job 永久卡在 running（比报错更糟，调用方会一直等）。
  const raw = fs.existsSync(stdoutPath(id)) ? fs.readFileSync(stdoutPath(id), 'utf8').trim() : '';
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const hasVerdict = !!(parsed && (parsed.ok || parsed.error));

  if (!hasVerdict) {
    if (alive(job.pid)) return shape(job); // 确实还在跑
    job.status = 'failed';
    job.error = {
      code: CODE.RENDER_FAILED,
      message: '子进程已退出，但没有产出可解析的回执',
      hint: '常见于进程被系统杀死（OOM）或 stdin 传递失败',
      fix: '降 workers 到 2 重试；若反复出现，改为同步调用 render() 看完整 stderr',
      details: { stderr: tail(fs.existsSync(stderrPath(id)) ? fs.readFileSync(stderrPath(id), 'utf8') : '') },
    };
    job.finishedAt = new Date().toISOString();
    writeJob(job);
    return shape(job);
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
  const soPath = stdoutPath(id);
  const st = fs.existsSync(soPath) ? fs.statSync(soPath) : null;
  job.finishedAt = st ? st.mtime.toISOString() : new Date().toISOString();
  writeJob(job);
  return shape(job);
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
    ...(job.status === 'running' ? { pid: job.pid } : {}),
    ...(job.receipt ? { receipt: job.receipt } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

/** 最近的任务，按创建时间倒序。 */
export function list(limit = 20) {
  if (!fs.existsSync(JOB_DIR)) return { ok: true, jobs: [] };
  const ids = fs.readdirSync(JOB_DIR)
    // 只认 job 状态文件本身：还要排除 <id>.stdout.json 与 <id>.json.tmp，
    // 它们的后缀同样是 .json，不过滤会被当成 job 读进来并 shape 出 undefined。
    .filter((f) => /^job-\d{8}-\d{6}-[a-z0-9]+\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''));
  const jobs = ids
    .map((id) => readJob(id))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map(shape);
  return { ok: true, jobs };
}

/**
 * 取消任务。先 SIGTERM 给 2 秒收尾（ffmpeg 会留下不完整 mp4），再 SIGKILL。
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
  if (alive(job.pid)) {
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
  return { ok: true, jobId: id, status: 'cancelled' };
}
