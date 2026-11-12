/**
 * api/index.mjs · 对外唯一契约面
 *
 * 五个动词，覆盖 agent 从「有什么能力」到「拿到可交付产物」的完整路径：
 *
 *   capabilities()          有哪些版式、各自要什么、产出什么规格
 *   describe(kit)           单支详情（含完整 params schema）
 *   validate(req)           参数预检，不出片；永不抛异常，只报问题
 *   render(req)             出片，返回结构化回执
 *   gate(file)              对既有成片跑交付门禁
 *
 * 约定：
 * - 除 validate 外，失败一律抛 ApiError（带 code / hint / fix）。
 * - 回执里的规格来自 ffprobe 探测，不是渲染器的自述。
 * - 内容只走 params，overrides 只放渲染超参；两者混用会让回执无法重放。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, DIRS } from '../src/root.mjs';
import { ApiError, CODE, toApiError } from './errors.mjs';
import { normalizeRequest, probeOutput, buildReceipt } from './contract.mjs';
import { validate as validateSchema, formatErrors } from './validate.mjs';
import * as registry from './registry.mjs';
import { MAX_JOBS } from './jobs.mjs';

export { ApiError, CODE } from './errors.mjs';
export { MAX_JOBS } from './jobs.mjs';

/** 能力清单。可安全序列化成 JSON 交给 agent。 */
export function capabilities() {
  return {
    apiVersion: '1.0',
    repoRoot: REPO_ROOT,
    limits: {
      maxConcurrentJobs: MAX_JOBS,
      workersPerJob: 8,
      note: '每个 job 独立进程、各 8 worker；超出 maxConcurrentJobs 的任务停在 queued，由后续 submit/status/list 调用补位',
      override: '环境变量 CUTDUO_MAX_JOBS',
    },
    kits: registry.list(),
  };
}

/** 单支详情：把 params schema 一并给出，agent 据此构造参数。 */
export function describe(kit) {
  const { capability } = registry.get(kit);
  let schema = null;
  let schemaError = null;
  if (capability.paramsSchema) {
    const p = path.join(REPO_ROOT, capability.paramsSchema);
    try {
      schema = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      schemaError = `schema 读取失败：${e.message}`;
    }
  }
  return {
    ...capability,
    paramsSchemaPath: capability.paramsSchema,
    schema,
    ...(schemaError ? { schemaError } : {}),
    examples: (capability.presets || []).slice(0, 3).map((p) => ({
      kit: capability.id,
      preset: p.id,
      note: p.note,
    })),
  };
}

/**
 * 参数预检。语义是「告诉我哪里有问题」，所以永不抛：kit 不存在也返回结构化错误。
 * @returns {{ok:boolean, kit?:string, schemaStatus?:string, errors?:Array, warnings?:Array, error?:object}}
 */
export function validate(req) {
  let capability;
  try {
    capability = registry.get(req?.kit).capability;
  } catch (e) {
    return { ok: false, error: toApiError(e).toJSON() };
  }

  let normalized;
  try {
    normalized = normalizeRequest(req, capability);
  } catch (e) {
    return { ok: false, kit: capability.id, error: toApiError(e).toJSON() };
  }

  const warnings = [];
  let params;
  try {
    params = JSON.parse(fs.readFileSync(normalized.paramsPath, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      kit: capability.id,
      error: new ApiError(CODE.PARAMS_UNREADABLE, '参数文件不是合法 JSON', {
        hint: '常见原因：尾随逗号、注释、BOM 头',
        fix: `用 jq . ${path.relative(REPO_ROOT, normalized.paramsPath)} 定位行号`,
        details: { path: path.relative(REPO_ROOT, normalized.paramsPath), message: e.message },
      }).toJSON(),
    };
  }

  if (!capability.paramsSchema) {
    // 没有 schema 就不假装校验过。放行，但把状态带回给调用方。
    warnings.push(capability.schemaNote || '本支没有 params.schema.json，参数未被校验');
    return {
      ok: true,
      kit: capability.id,
      schemaStatus: 'missing',
      paramsPath: path.relative(REPO_ROOT, normalized.paramsPath),
      warnings,
    };
  }

  const schemaPath = path.join(REPO_ROOT, capability.paramsSchema);
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      kit: capability.id,
      error: new ApiError(CODE.SCHEMA_UNSUPPORTED, 'schema 文件无法解析', {
        hint: 'schema 本身坏了，不是参数的问题',
        details: { path: capability.paramsSchema, message: e.message },
      }).toJSON(),
    };
  }

  const result = validateSchema(schema, params);
  if (result.unsupported.length) {
    warnings.push(`schema 用了校验器不支持的关键字：${result.unsupported.join(', ')}（这部分未被检查）`);
  }

  if (!result.valid) {
    return {
      ok: false,
      kit: capability.id,
      schemaStatus: capability.schemaStatus,
      paramsPath: path.relative(REPO_ROOT, normalized.paramsPath),
      errors: result.errors,
      messages: formatErrors(result.errors),
      warnings,
    };
  }

  return {
    ok: true,
    kit: capability.id,
    schemaStatus: capability.schemaStatus,
    paramsPath: path.relative(REPO_ROOT, normalized.paramsPath),
    warnings,
  };
}

/**
 * 出片。
 * @param {object} req  { kit, params | paramsPath | preset, audio?, out?, overrides? }
 * @returns {Promise<object>} 回执
 */
export async function render(req) {
  const { capability, adapter } = registry.get(req?.kit);
  const normalized = normalizeRequest(req, capability);

  // 出片前先过一遍参数：让失败发生在 spawn 之前，错误能精确到字段
  if (capability.paramsSchema) {
    const pre = validate({ ...req, kit: capability.id });
    if (!pre.ok) {
      throw new ApiError(CODE.PARAMS_INVALID, `kit ${capability.id} 的参数不符合 schema`, {
        hint: '字段级问题见 details.errors；先用 validate() 单独预检可以不触发渲染',
        fix: '按 path 逐条修正，或改用 presets 里的现成参数',
        details: { errors: pre.errors, messages: pre.messages, paramsPath: pre.paramsPath },
      });
    }
  }

  const t0 = Date.now();
  await adapter.render(normalized);
  const wallSeconds = (Date.now() - t0) / 1000;

  const output = probeOutput(normalized.out);
  return buildReceipt({
    request: normalized,
    output,
    wallSeconds,
    kit: capability.id,
    extra: {
      unvalidated: capability.schemaStatus === 'missing',
      ...(capability.schemaStatus === 'missing' ? { schemaNote: capability.schemaNote } : {}),
    },
  });
}

/**
 * 单帧探针：出一个 PNG，用来看版式对不对，不消耗整片时间。
 * 回执里不含帧数与时长（PNG 没有这些概念），只给尺寸与体积。
 */
export async function probe(req) {
  const { capability, adapter } = registry.get(req?.kit);
  const normalized = normalizeRequest(req, capability);
  const png = normalized.out.replace(/\.mp4$/i, '.png');
  const at = req?.overrides?.at ?? 2.5;

  const t0 = Date.now();
  await adapter.probe({ ...normalized, overrides: { ...normalized.overrides, at } }, png);
  const wallSeconds = (Date.now() - t0) / 1000;

  if (!fs.existsSync(png)) {
    throw new ApiError(CODE.OUTPUT_INVALID, '探针未产出图片', { details: { expected: png } });
  }
  const bytes = fs.statSync(png).size;
  if (bytes < 5000) {
    throw new ApiError(CODE.OUTPUT_INVALID, `探针图过小（${bytes} 字节），疑似空白帧`, {
      hint: '参数结构对了但画面是空的：可能是 scene 的 t0/t1 不覆盖 at 指定的时间点',
      fix: `换一个 --at（当前 ${at}s），或检查 params 里的分镜时间轴`,
      details: { png: path.relative(REPO_ROOT, png), bytes },
    });
  }

  return {
    ok: true,
    kind: 'probe',
    kit: capability.id,
    at,
    output: { path: path.relative(REPO_ROOT, png), absolutePath: png, bytes },
    timings: { wallSeconds: Number(wallSeconds.toFixed(2)) },
  };
}

/**
 * 对既有成片跑交付门禁。判据只拦交付完整性（帧数/音画时长/空帧/黑帧），
 * hook 与亮度只告警——理由见 src/gate.mjs 头部。
 *
 * 走子进程而不是 import：gate.mjs 是脚本式入口，import 即执行。
 * 它已经把结论写成 JSON 报告，读报告比解析 stdout 稳。
 * @returns {{pass:boolean, films:Array, reportPath:string}}
 */
export function gate(filePath, opts = {}) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(REPO_ROOT, filePath);
  if (!fs.existsSync(abs)) {
    throw new ApiError(CODE.BAD_REQUEST, `成片不存在：${filePath}`, {
      hint: 'gate 只检查已存在的 mp4',
      fix: '先 render() 出片，或改正路径',
    });
  }

  const reportPath = path.join(DIRS.out, `gate-${process.pid}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  let exitCode = 0;
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'src', 'gate.mjs'), abs, '--json', reportPath, '--quiet'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
    });
  } catch (e) {
    // gate 判 FAIL 时退出码 1；报告仍然会写出来，所以不当异常处理
    exitCode = typeof e.status === 'number' ? e.status : 1;
  }

  if (!fs.existsSync(reportPath)) {
    throw new ApiError(CODE.GATE_FAILED, '门禁未产出报告', {
      hint: 'gate.mjs 可能在写报告前就退出了',
      fix: `手动跑：node src/gate.mjs ${path.relative(REPO_ROOT, abs)}`,
    });
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  return {
    pass: exitCode === 0,
    films: report.films || report,
    reportPath: path.relative(REPO_ROOT, reportPath),
  };
}

/** 供 CLI 输出统一形状 */
export function result(fn) {
  try {
    return fn();
  } catch (e) {
    return { ok: false, error: toApiError(e).toJSON() };
  }
}

// 异步任务：长片或需要断线重连时用这四个，语义与上面的 render 一致，
// 只是把「等结果」换成「拿 jobId 再轮询」。
export {
  submit as submitJob,
  status as jobStatus,
  list as listJobs,
  cancel as cancelJob,
} from './jobs.mjs';
