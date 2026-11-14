/**
 * api/kits/_runner.mjs · 把「一支 kit 的 CLI」包成符合 API 契约的 adapter
 *
 * 为什么五支都走子进程，而不是 import 各自的 render 函数：
 *
 * 1. 现有五支的 render.mjs 都是**脚本**，模块顶层直接 parseArgs 并执行；import 即出片。
 *    改成可 import 要动五份入口，那是实现层的事，不该与契约层同时改。
 * 2. 隔离：一支 kit 崩（OOM、字体缺失）不应该带掉 API 进程。
 * 3. 契约不依赖实现形态。等哪天要省进程启动开销，只需把这里的 spawn 换成 import，
 *    capability 与回执字段一个都不用改。
 *
 * 回执的规格一律由 contract.probeOutput 用 ffprobe 读产物得到，**不解析子进程 stdout**：
 * 自述的帧数可能是计划值，探测的才是实际值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT } from '../../src/root.mjs';
import { ApiError, CODE } from '../errors.mjs';

const NODE = process.execPath;

function runNode(scriptPath, args, { cwd = REPO_ROOT, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [scriptPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new ApiError(CODE.RENDER_FAILED, `渲染超时（${Math.round(timeoutMs / 1000)}s）`, {
          hint: '片长 × 帧率超过预期，或 worker 死锁',
          fix: '降 workers 到 2 重试；仍超时就检查 params 里的 durationSeconds',
        }));
      }, timeoutMs);
    }

    child.once('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new ApiError(CODE.RENDER_FAILED, `无法启动 ${path.basename(scriptPath)}`, { cause: e }));
    });
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, signal, stdout: out, stderr: err });
    });
  });
}

/**
 * 只取尾部会把根因切掉：Node 的 stack trace 有 6–10 行，真正的
 * `Error: paper 不支持段型 "cover"` 在第一行，回执里就只剩一串 at。
 * 所以尾部之外补回首条错误行——根因比调用栈有用得多。
 */
const tail = (s, n = 8) => {
  const lines = String(s || '').trim().split('\n').filter(Boolean);
  const last = lines.slice(-n);
  const firstErr = lines.find((l) => /^\s*(?:\w*Error)\b:/.test(l));
  if (firstErr && !last.includes(firstErr)) last.unshift(firstErr);
  return last.join('\n');
};

/** 通用参数构造：五支只在 args 名与 kit 前缀上有差别。 */
export function buildArgs(req, { paramsFlag = '--params', kitId = null, extra = () => [] } = {}) {
  const a = [];
  if (kitId) a.push('--kit', kitId);
  a.push(paramsFlag, req.paramsPath);
  if (req.audio) a.push('--audio', req.audio);
  a.push('--out', req.out);

  const o = req.overrides || {};
  if (o.fps != null) a.push('--fps', String(o.fps));
  if (o.workers != null) a.push('--workers', String(o.workers));
  if (o.crf != null) a.push('--crf', String(o.crf));
  if (o.preset) a.push('--preset', o.preset);
  if (o.pipe) a.push('--pipe', o.pipe);
  if (o.theme) a.push('--theme', o.theme);
  if (o.transition) a.push('--transition', o.transition);
  a.push(...extra(req));
  return a;
}

/**
 * @param {object} capability
 * @param {{script:string, paramsFlag?:string, kitId?:string, extra?:Function}} spec
 */
export function cliAdapter(capability, spec) {
  const scriptPath = path.join(REPO_ROOT, spec.script);

  // 有的 kit 只有一部分超参有意义（diagram 是单进程、无主题切换）。
  // 默认全部接受；声明了 supportedOverrides 就按白名单拒绝，而不是静默忽略——
  // 静默忽略会让调用方以为 workers=8 生效了，回执里的耗时却对不上。
  const supported = spec.supportedOverrides || null;
  const assertOverrides = (req, extra = []) => {
    if (!supported) return;
    const bad = Object.keys(req.overrides || {})
      .filter((k) => !supported.includes(k) && !extra.includes(k));
    if (bad.length) {
      throw new ApiError(CODE.BAD_REQUEST, `kit ${capability.id} 不支持 overrides：${bad.join(', ')}`, {
        hint: '该支的渲染入口没有这些开关，传了也不会生效',
        fix: `可用 overrides：${[...supported, ...extra].join(' / ')}`,
        details: { unsupported: bad, supported: [...supported, ...extra] },
      });
    }
  };

  const assertEntry = () => {
    if (!fs.existsSync(scriptPath)) {
      throw new ApiError(CODE.INTERNAL, `kit ${capability.id} 的入口不存在：${spec.script}`, {
        hint: '目录重构后路径未跟随，或文件被移动',
        fix: '运行 bash tools/smoke.sh 定位是哪一支断了',
        details: { expected: spec.script, absolute: scriptPath },
      });
    }
  };

  return {
    capability,

    async render(req) {
      assertEntry();
      assertOverrides(req);
      const args = buildArgs(req, spec);

      // 产物目录要提前建：ffmpeg 不会替你 mkdir，失败信息还很隐晦
      fs.mkdirSync(path.dirname(req.out), { recursive: true });

      const r = await runNode(scriptPath, args, {
        timeoutMs: capability.timeoutMs || 30 * 60 * 1000,
      });

      if (r.code !== 0) {
        throw new ApiError(CODE.RENDER_FAILED, `kit ${capability.id} 渲染失败（退出码 ${r.code}${r.signal ? ` / ${r.signal}` : ''}）`, {
          hint: 'stderr 尾部见 details；常见原因是参数结构与 schema 不符、素材缺失、ffmpeg 不在 PATH',
          fix: `先跑 api.validate({ kit: "${capability.id}", paramsPath }) 看参数问题；参数没问题再跑 bash tools/smoke.sh`,
          details: { stderr: tail(r.stderr), args },
        });
      }
      return { args };
    },

    async probe(req, pngPath) {
      assertEntry();
      assertOverrides(req, ['at']);
      fs.mkdirSync(path.dirname(pngPath), { recursive: true });
      // 把 out 指到 png：五支的 probe 分支都在写 mp4 之前就 process.exit，
      // 所以 --out 只是占位，不改语义。
      const args = buildArgs({ ...req, out: pngPath }, spec);
      args.push('--probe', pngPath);
      if (req.overrides?.at != null) args.push('--at', String(req.overrides.at));

      const r = await runNode(scriptPath, args, { timeoutMs: 5 * 60 * 1000 });
      if (r.code !== 0 || !fs.existsSync(pngPath)) {
        throw new ApiError(CODE.RENDER_FAILED, `kit ${capability.id} 探针失败`, {
          hint: '单帧都出不来，通常是参数结构问题（不是性能问题）',
          details: { stderr: tail(r.stderr), args },
        });
      }
      return { args };
    },
  };
}
