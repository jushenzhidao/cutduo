#!/usr/bin/env node
/**
 * api/cli.mjs · API 的 CLI 宿主
 *
 * 这个文件不承载任何业务逻辑：解析参数、调用 api/index.mjs、按形状输出。
 * 逻辑写在别处，是因为同一个 API 还会有 HTTP / MCP 宿主，它们共享同一份实现。
 *
 * 用法：
 *   node api/cli.mjs capabilities
 *   node api/cli.mjs describe --kit science
 *   node api/cli.mjs validate --kit paper --preset v8t
 *   node api/cli.mjs render   --kit paper --preset v8t --out out/x.mp4
 *   node api/cli.mjs probe    --kit desk  --preset demo --at 3
 *   node api/cli.mjs gate     out/x.mp4
 *
 * 机器调用（推荐给 agent）：
 *   echo '{"kit":"paper","preset":"v8t"}' | node api/cli.mjs render --stdin --json
 *
 * 退出码：0 成功 / 1 失败（含 gate 判 FAIL）
 */
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as api from './index.mjs';
import { toApiError } from './errors.mjs';
import { REPO_ROOT } from '../src/root.mjs';

const argv = process.argv.slice(2);
const verb = argv[0];
const asJson = argv.includes('--json');
const useStdin = argv.includes('--stdin');

function parseFlags(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const flags = parseFlags(argv.slice(1));

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`stdin 不是合法 JSON：${e.message}`);
  }
}

/** 从 flags 构造请求。--params-json 接受内联 JSON 字符串。 */
function reqFromFlags() {
  const req = {};
  if (flags.kit) req.kit = String(flags.kit);
  if (flags.preset) req.preset = String(flags.preset);
  if (flags.params) req.paramsPath = String(flags.params);
  if (flags['params-json']) {
    try {
      req.params = JSON.parse(String(flags['params-json']));
    } catch (e) {
      throw new Error(`--params-json 不是合法 JSON：${e.message}`);
    }
  }
  if (flags.audio) req.audio = String(flags.audio);
  if (flags.out) req.out = String(flags.out);

  const ov = {};
  for (const k of ['fps', 'workers', 'crf', 'preset', 'pipe', 'probe', 'at', 'theme', 'transition']) {
    if (flags[k] !== undefined && k !== 'preset') ov[k] = flags[k];
  }
  if (flags['transition-dur']) ov.transition = ov.transition || 'fade';
  if (Object.keys(ov).length) req.overrides = ov;
  return req;
}

function pr(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// 中文按显示宽度算两格，否则能力清单在终端里会错位
const dispWidth = (s) => [...String(s)].reduce((n, c) => n + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dispWidth(s)));

function human(kind, r) {
  if (kind === 'capabilities') {
    const lines = [`api ${r.apiVersion} · ${r.kits.length} 支版式`];
    for (const k of r.kits) {
      const o = k.output;
      const schema = k.schemaStatus === 'complete' ? 'schema 完整' : '无 schema';
      lines.push(
        `  ${pad(k.id, 11)}${pad(k.name, 10)}${pad(`${o.width}x${o.height}@${o.fpsDefault}`, 15)}${pad(k.contentModel.name, 13)}${schema}`,
      );
    }
    return lines.join('\n');
  }
  if (kind === 'describe') {
    return [
      `${r.id} · ${r.name}   ${r.output.width}x${r.output.height} @ ${r.output.fpsDefault}fps`,
      r.description,
      `内容模型：${r.contentModel.name} —— ${r.contentModel.note}`,
      `schema：${r.paramsSchemaPath || '（无）'}  [${r.schemaStatus}]`,
      `presets：${r.presets.map((p) => p.id).join(' / ') || '（无）'}`,
    ].join('\n');
  }
  if (kind === 'validate') {
    if (r.ok) return `✓ ${r.kit} 参数通过${r.warnings?.length ? `\n  提示：${r.warnings.join('；')}` : ''}`;
    if (r.error) return `✗ ${r.error.code}: ${r.error.message}${r.error.fix ? `\n  改法：${r.error.fix}` : ''}`;
    return `✗ ${r.kit} 参数不合法\n  ${(r.messages || []).join('\n  ')}`;
  }
  if (kind === 'render') {
    const o = r.output;
    return [
      `✓ ${o.path}`,
      `  ${o.frames} 帧 / ${o.durationSeconds}s / ${o.fps}fps / ${o.width}x${o.height} / ${(o.bytes / 1048576).toFixed(2)}MB`,
      `  ${r.timings.wallSeconds}s 墙钟 · ${r.timings.framesPerSecond} fps 吞吐 · 音轨 ${o.hasAudio ? '有' : '无'}`,
      ...(r.unvalidated ? [`  ⚠ ${r.schemaNote || '参数未经 schema 校验'}`] : []),
    ].join('\n');
  }
  if (kind === 'probe') {
    return `✓ ${r.output.path}  ${(r.output.bytes / 1024).toFixed(0)}KB  @${r.at}s  ${r.timings.wallSeconds}s`;
  }
  if (kind === 'gate') {
    const rows = (r.films || []).map((f) => `${f.verdict || (f.pass ? 'PASS' : 'FAIL')}  ${f.file || f.path || ''}`);
    return [`${r.pass ? '✓ 门禁通过' : '✗ 门禁未通过'}`, ...rows].join('\n');
  }
  return JSON.stringify(r, null, 2);
}

async function main() {
  if (!verb || verb === '--help' || verb === 'help') {
    process.stdout.write(`cutduo api · 动词\n\n  capabilities\n  describe --kit <id>\n  validate --kit <id> [--preset <p> | --params <file>]\n  render   --kit <id> [--preset <p> | --params <file> | --params-json '<json>'] [--audio <f>] [--out <f>]\n  probe    --kit <id> [--preset <p>] [--at <sec>]\n  gate     <file.mp4>\n\n公共开关：--json（机器可读）  --stdin（从 stdin 读请求 JSON）\n`);
    return 0;
  }

  const stdinReq = useStdin ? await readStdin() : null;

  switch (verb) {
    case 'capabilities': {
      const r = api.capabilities();
      asJson ? pr(r) : process.stdout.write(human('capabilities', r) + '\n');
      return 0;
    }
    case 'describe': {
      const r = api.describe(String(flags.kit || ''));
      asJson ? pr(r) : process.stdout.write(human('describe', r) + '\n');
      return 0;
    }
    case 'validate': {
      const r = api.validate(stdinReq || reqFromFlags());
      asJson ? pr(r) : process.stdout.write(human('validate', r) + '\n');
      return r.ok ? 0 : 1;
    }
    case 'render': {
      const r = await api.render(stdinReq || reqFromFlags());
      asJson ? pr(r) : process.stdout.write(human('render', r) + '\n');
      return 0;
    }
    case 'probe': {
      const r = await api.probe(stdinReq || reqFromFlags());
      asJson ? pr(r) : process.stdout.write(human('probe', r) + '\n');
      return 0;
    }
    case 'gate': {
      // gate 的唯一参数是位置参数；不能拿 argv[1]，因为它可能是 --json
      const file = argv.slice(1).find((a) => !a.startsWith('--'));
      if (!file) throw new Error('gate 需要一个 mp4 路径');
      const r = api.gate(file);
      asJson ? pr(r) : process.stdout.write(human('gate', r) + '\n');
      return r.pass ? 0 : 1;
    }
    default:
      throw new Error(`未知动词 ${verb}（可用：capabilities / describe / validate / render / probe / gate）`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    const err = toApiError(e);
    if (asJson) pr({ ok: false, error: err.toJSON() });
    else {
      process.stderr.write(`✗ ${err.code}: ${err.message}\n`);
      if (err.hint) process.stderr.write(`  原因：${err.hint}\n`);
      if (err.fix) process.stderr.write(`  改法：${err.fix}\n`);
      if (err.details) process.stderr.write(`  细节：${JSON.stringify(err.details, null, 2)}\n`);
    }
    process.exit(1);
  });
