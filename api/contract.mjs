/**
 * api/contract.mjs · 请求规范化与回执构造
 *
 * 两条原则：
 *
 * 1. **请求只有一种形状**。调用方可以传内联对象、参数文件路径、或 preset 名，
 *    但进了 API 层之后全部收敛成 `{ kit, paramsPath, overrides, audio, out }`。
 *    多一种输入形状，就多一条 agent 猜错的路。
 *
 * 2. **回执不信自述，只信探测**。各支 kit 打印的「2573 帧 / 42.9s」是自述，
 *    可能是计划值而不是实际值。回执里的规格一律由 ffprobe 读产物得出，
 *    这样五支 kit 的回执字段含义完全一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, DIRS, resolveInput } from '../src/root.mjs';
import { ApiError, CODE } from './errors.mjs';

const FFPROBE = process.env.FFPROBE || '/opt/homebrew/bin/ffprobe';

/**
 * 把各种入参收敛成统一请求。
 * @param {object} raw
 * @param {object} capability  目标 kit 的声明，用于填默认值
 */
export function normalizeRequest(raw, capability) {
  if (!raw || typeof raw !== 'object') {
    throw new ApiError(CODE.BAD_REQUEST, '请求必须是对象', {
      hint: '最小请求：{ "kit": "paper", "preset": "v8t" }',
      fix: '传入 { kit, params | paramsPath | preset, audio?, out? }',
    });
  }

  const kit = raw.kit ?? capability.id;

  // 参数来源三选一，优先级：params（内联）> paramsPath（文件）> preset（具名）
  let paramsPath = null;
  if (raw.params && typeof raw.params === 'object') {
    const dir = path.join(DIRS.out, 'params');
    fs.mkdirSync(dir, { recursive: true });
    paramsPath = path.join(dir, `${kit}-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(paramsPath, JSON.stringify(raw.params, null, 2));
  } else if (raw.paramsPath) {
    paramsPath = resolveInput(raw.paramsPath);
    if (!fs.existsSync(paramsPath)) {
      throw new ApiError(CODE.PARAMS_MISSING, `参数文件不存在：${raw.paramsPath}`, {
        hint: `已按 cwd 与仓库根（${REPO_ROOT}）各试一次`,
        fix: `改用 presets 里的现成参数：${(capability.presets || []).join(' / ') || '（本 kit 未提供）'}`,
        details: { resolved: paramsPath },
      });
    }
  } else if (raw.preset) {
    const hit = (capability.presets || []).find(
      (p) => p.id === raw.preset || path.basename(p.path, '.json') === raw.preset,
    );
    if (!hit) {
      throw new ApiError(CODE.PARAMS_MISSING, `kit ${kit} 没有名为 ${raw.preset} 的 preset`, {
        hint: 'preset 必须取自 capabilities() 返回的 presets[].id',
        fix: `可用：${(capability.presets || []).map((p) => p.id).join(' / ') || '（无）'}`,
        details: { kit, requested: raw.preset },
      });
    }
    paramsPath = path.join(REPO_ROOT, hit.path);
  } else if (capability.defaultPreset) {
    paramsPath = path.join(REPO_ROOT, capability.defaultPreset);
  }

  if (!paramsPath) {
    throw new ApiError(CODE.PARAMS_MISSING, `kit ${kit} 需要 params / paramsPath / preset 三者之一`, {
      hint: '这是出片的唯一必需输入',
      fix: `例如 { "kit": "${kit}", "preset": "${(capability.presets || [])[0]?.id || 'default'}" }`,
    });
  }

  const audio = raw.audio ? resolveInput(raw.audio, true) : null;
  if (raw.audio && !fs.existsSync(audio)) {
    throw new ApiError(CODE.AUDIO_MISSING, `音轨不存在：${raw.audio}`, {
      hint: '口播片必须有音轨；纯画面片请省略 audio 字段',
      fix: `可用音轨：${DIRS.audio}`,
      details: { resolved: audio },
    });
  }

  const out = raw.out
    ? path.resolve(raw.out)
    : path.join(DIRS.out, `${kit}.mp4`);

  // overrides 只允许改「明显与内容无关」的出片超参，不允许改内容。
  // 内容改动必须走 params，否则回执与实际输入对不上，无法重放。
  const ALLOWED_OVERRIDES = ['fps', 'workers', 'crf', 'preset', 'pipe', 'probe', 'at', 'theme', 'transition'];
  const overrides = {};
  for (const k of ALLOWED_OVERRIDES) {
    if (raw.overrides && raw.overrides[k] !== undefined) overrides[k] = raw.overrides[k];
  }
  const unknown = Object.keys(raw.overrides || {}).filter((k) => !ALLOWED_OVERRIDES.includes(k));
  if (unknown.length) {
    throw new ApiError(CODE.BAD_REQUEST, `overrides 不接受字段：${unknown.join(', ')}`, {
      hint: '内容（文案/分镜/素材）必须走 params，overrides 只放渲染超参',
      fix: `可用 overrides：${ALLOWED_OVERRIDES.join(' / ')}`,
    });
  }

  return { kit, paramsPath, audio, out, overrides, probe: raw.probe ?? null, async: !!raw.async };
}

/** 用 ffprobe 读产物真实规格；读不出来就判产物无效，而不是回一个猜测值。 */
export function probeOutput(file) {
  if (!fs.existsSync(file)) {
    throw new ApiError(CODE.OUTPUT_INVALID, `产物不存在：${file}`, {
      hint: '渲染进程可能提前退出，或 out 路径不可写',
      fix: '检查 out 的父目录权限，或用绝对路径',
    });
  }
  let info;
  try {
    info = JSON.parse(execFileSync(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height,r_frame_rate,nb_frames:format=duration,size',
      '-of', 'json', file,
    ], { encoding: 'utf8' }));
  } catch (e) {
    throw new ApiError(CODE.OUTPUT_INVALID, 'ffprobe 无法解析产物', {
      hint: '文件可能是不完整的 mp4（编码中途被杀）',
      fix: '删除该产物后重跑；若反复出现，把 workers 降到 2 再试',
      cause: e,
    });
  }

  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  if (!v) {
    throw new ApiError(CODE.OUTPUT_INVALID, '产物里没有视频流', { details: { file } });
  }
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  const [num, den] = String(v.r_frame_rate || '0/1').split('/').map(Number);
  const fps = den ? num / den : null;
  const durationSeconds = Number(info.format?.duration || 0);
  const frames = v.nb_frames ? Number(v.nb_frames) : Math.round(durationSeconds * (fps || 0));

  return {
    path: path.relative(REPO_ROOT, file),
    absolutePath: file,
    bytes: Number(info.format?.size || fs.statSync(file).size),
    width: Number(v.width),
    height: Number(v.height),
    fps: fps ? Number(fps.toFixed(3)) : null,
    frames,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    hasAudio: !!a,
  };
}

/**
 * 统一回执。字段名一旦定下就是契约，五支 kit 必须一致。
 * @param {{request:object, output:object, wallSeconds:number, kit:string, extra?:object}} p
 */
export function buildReceipt({ request, output, wallSeconds, kit, kind = 'render', extra = {} }) {
  const throughput = wallSeconds > 0 ? output.frames / wallSeconds : null;
  return {
    ok: true,
    kind,
    kit,
    request: {
      paramsPath: path.relative(REPO_ROOT, request.paramsPath),
      audio: request.audio ? path.relative(REPO_ROOT, request.audio) : null,
      out: path.relative(REPO_ROOT, request.out),
      overrides: request.overrides || {},
    },
    output,
    timings: {
      wallSeconds: Number(wallSeconds.toFixed(2)),
      framesPerSecond: throughput ? Number(throughput.toFixed(1)) : null,
    },
    ...extra,
  };
}
