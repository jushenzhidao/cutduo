#!/usr/bin/env node
/**
 * harness/run.mjs — 单轮评测：出片 + 跑全部门禁 + 产出结构化反馈
 *
 * 为什么要有：之前的迭代是我人工"渲一遍 → 看 MAE → 改参数 → 再渲"，
 * 判据散在 gate / calibration / adversarial 三个脚本里，每次都要人记住"哪条警告该改什么"。
 * harness 把这件事收敛成：**一次运行 → 一份 report.json + 一份 advice.md**，
 * agent（或 CI）照着 advice 改参数，再跑一轮。
 *
 *   node harness/run.mjs --task harness/tasks/hip-v4.json
 *   node harness/run.mjs --task ... --visual-only     # 复用已有 vo.json，只重渲画面（约 16s 而非 45s）
 *
 * 三条约束：
 *   1. **判据不参与创作**：harness 只报"哪条不过、该改哪个字段"，不改参数；
 *   2. **每轮独立存档**：out/harness/<task>/<round-N>/ 存 params、指标、报告，可回溯；
 *   3. **预算硬上限**：轮次与墙钟都封顶，防止 agent 在无解任务上无限试。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../src/root.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TASK_FILE = arg('task');
const VISUAL_ONLY = process.argv.includes('--visual-only');
const QUIET = process.argv.includes('--quiet');
if (!TASK_FILE) { console.error('用法: node harness/run.mjs --task harness/tasks/<id>.json [--visual-only]'); process.exit(2); }

const task = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, TASK_FILE), 'utf8'));
const TASK_DIR = path.join(REPO_ROOT, 'out', 'harness', task.id);
fs.mkdirSync(TASK_DIR, { recursive: true });

// ── 轮次：自动递增，预算封顶 ────────────────────────────────────────
const rounds = fs.existsSync(TASK_DIR) ? fs.readdirSync(TASK_DIR).filter((d) => /^round-\d+$/.test(d)) : [];
const round = rounds.length + 1;
const budget = task.budget?.rounds ?? 8;
if (round > budget) {
  console.error(`已用完 ${budget} 轮预算。看 ${path.relative(REPO_ROOT, TASK_DIR)}/round-*/report.json，或改 task.budget.rounds`);
  process.exit(2);
}
const R = path.join(TASK_DIR, `round-${String(round).padStart(2, '0')}`);
fs.mkdirSync(R, { recursive: true });

const started = Date.now();
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const need = (ok, msg) => { if (!ok) { console.error('✗ ' + msg); fs.writeFileSync(path.join(R, 'report.json'), JSON.stringify({ stage: 'abort', error: msg }, null, 2)); process.exit(1); } };

// ── 1. 参数：base 或上一轮补丁 ──────────────────────────────────────
const basePath = path.resolve(REPO_ROOT, task.base);
const prevRound = rounds.length ? path.join(TASK_DIR, `round-${String(rounds.length).padStart(2, '0')}`, 'params.json') : null;
// 优先级：patch.mjs 产出的 next.json（待消费）> 上一轮 params > 任务 base
const nextFile = path.join(TASK_DIR, 'next.json');
const paramsIn = task.chain === false
  ? basePath
  : (fs.existsSync(nextFile) ? nextFile : (prevRound && fs.existsSync(prevRound) ? prevRound : basePath));
const params = JSON.parse(fs.readFileSync(paramsIn, 'utf8'));
const paramsPath = path.join(R, 'params.json');
fs.writeFileSync(paramsPath, JSON.stringify(params, null, 2));
// 消费掉 next.json：不删的话下一轮会一直吃同一份补丁，agent 以为改了其实没改
if (path.basename(paramsIn) === 'next.json') fs.unlinkSync(paramsIn);

// 视觉迭代的护栏：不许动时间轴。改了段长/字幕却复用旧音轨，音画就错位，
// 而 gate 只比"总时长"，查不出来——这类"跑得通但废了"的分要靠这里拦。
if (VISUAL_ONLY && task.vo && fs.existsSync(path.resolve(REPO_ROOT, task.vo))) {
  const voiced = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, task.vo), 'utf8'));
  const a = JSON.stringify((params.segments || []).map((x) => Math.round(Number(x.dur) * 1000)));
  const b = JSON.stringify((voiced.segments || []).map((x) => Math.round(Number(x.dur) * 1000)));
  const c = JSON.stringify((params.captions || []).map((x) => x.text));
  const d = JSON.stringify((voiced.captions || []).map((x) => x.text));
  if (a !== b || c !== d) {
    need(false, '--visual-only 不能改段长或文案（时间轴跟着配音走）。改内容请去掉 --visual-only，重跑完整链路。');
  }
}

// ── 2. 配音：复用 or 重跑 ───────────────────────────────────────────
let voPath = path.join(R, 'vo.json');
let wavPath = path.join(R, 'vo.wav');
const reuseVo = VISUAL_ONLY && task.vo && fs.existsSync(path.resolve(REPO_ROOT, task.vo));
if (reuseVo) {
  // 视觉迭代：**打补丁的 params 本身就是已配音的 vo.json**，直接拿来渲染。
  // 早期这里 fileCopy 了 task.vo（原始文件），补丁被原地覆盖 —— 每一轮都渲同一份参数，
  // 所有判据都 PASS，看起来"改好了"其实一个字没改。这是 harness 最危险的一类静默失效。
  fs.copyFileSync(paramsPath, voPath);
  const prevWav = task.voWav && path.resolve(REPO_ROOT, task.voWav);
  need(prevWav && fs.existsSync(prevWav), `--visual-only 需要 task.voWav 指向已有音轨（${task.voWav}）`);
  fs.copyFileSync(prevWav, wavPath);
} else {
  const r = run('uv', ['run', '--with', 'numpy', 'python', 'tools/vo.py',
    '--preset', paramsPath, '--out-preset', voPath, '--out-audio', wavPath,
    '--voice', task.constraints?.voice || 'zh-CN-XiaoxiaoNeural',
    '--rate', task.constraints?.rate || '+5%'], {
    cwd: path.join(REPO_ROOT, 'kits', 'science', 'template'),
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
  });
  fs.writeFileSync(path.join(R, 'vo.log'), r.out + '\n' + r.err);
  need(r.code === 0 && fs.existsSync(voPath), 'vo.py 失败，见 round-*/vo.log');
}

// ── 3. 出片 ────────────────────────────────────────────────────────
const mp4 = path.join(R, 'film.mp4');
let r = run('node', ['render.mjs', '--kit', task.kit || 'science', '--params', voPath,
  '--audio', wavPath, '--out', mp4, '--fps', String(task.fps || 30), '--workers', '8']);
need(r.code === 0 && fs.existsSync(mp4), 'render.mjs 失败：' + r.err.slice(-300));

if (task.bgm) {
  const bgmOut = path.join(R, 'film-bgm.mp4');
  const b = run('node', ['tools/add-bgm.mjs', '--video', mp4, '--out', bgmOut]);
  if (b.code === 0) fs.renameSync(bgmOut, mp4);
}

// ── 4. 三门判据（全部拿 JSON，不解析人话输出） ────────────────────────
const gateJson = path.join(R, 'gate.json');
run('node', ['src/gate.mjs', mp4, '--require-audio', '--json', gateJson, '--quiet']);
const gate = fs.existsSync(gateJson) ? JSON.parse(fs.readFileSync(gateJson, 'utf8'))[0] : null;

let calib = null;
if (task.calibration !== false) {
  const cj = path.join(R, 'calibration.json');
  const c = run('node', ['tools/verify-calibration.mjs', '--params', voPath, '--json']);
  fs.writeFileSync(cj, c.out || '{}');
  try { calib = JSON.parse(c.out); } catch { calib = null; }
}

// 注意：adversarial 的 --json 是打到 stdout，不是写文件（calibration 也是）。
// 早期这里没接 stdout，文件不存在 → adv=null → 所有对抗判据被跳过，harness 静默判 PASS。
// 这类"检查器没输出却被当成通过"比检查失败更危险，所以下面还有一道 missing 兜底。
const aj = path.join(R, 'adversarial.json');
const ar = run('node', ['tools/adversarial.mjs', '--video', mp4, '--params', voPath, '--json']);
fs.writeFileSync(aj, ar.out || '{}');
let adv = null;
try { adv = JSON.parse(ar.out); } catch { adv = null; }
if (!adv) {
  need(false, `对抗审查没有产出可解析的 JSON（exit ${ar.code}）：${(ar.err || '').slice(-200)}`);
}

// ── 5. 指标汇总 ────────────────────────────────────────────────────
const probe = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size',
  '-show_entries', 'stream=codec_type,width,height', '-of', 'json', mp4]);
const info = probe.code === 0 ? JSON.parse(probe.out) : {};
const v = (info.streams || []).find((s) => s.codec_type === 'video') || {};
const metrics = {
  duration: Number(info.format?.duration || 0),
  sizeMB: +((Number(info.format?.size || 0)) / 1048576).toFixed(2),
  width: v.width, height: v.height,
  frames: gate ? Number(String(gate.frames || '0/0').split('/')[0]) : null,
  hook: gate?.hook, flatPct: gate?.flatPct, blackPct: gate?.blackPct,
  calibPass: calib?.pass, calibFail: calib?.fail, calibSkip: calib?.skip,
  // adversarial 的 --json 里 blockers/warns 是**计数**（数字），不是数组；取 .length 会得到 undefined
  blockers: adv ? adv.blockers : null, warns: adv ? adv.warns : null,
};

// ── 6. 判据判定 + 可执行的建议 ───────────────────────────────────────
const limit = task.limits || {};
const fails = [];
const warns = [];
if (gate && gate.verdict !== 'PASS') fails.push({ id: 'gate.fail', msg: `门禁 ${gate.verdict}：${[...(gate.fails || []), ...(gate.warns || [])].join('；')}` });
if (limit.duration) {
  const [a, b] = limit.duration;
  if (metrics.duration < a || metrics.duration > b) fails.push({ id: 'duration.range', msg: `时长 ${metrics.duration.toFixed(1)}s 不在 ${a}–${b}s 内` });
}
if (task.calibration !== false && !calib) fails.push({ id: 'harness.checkMissing', msg: '标定验证器没有产出 JSON：这条判据等于没跑' });
if (calib && (calib.fail > 0 || calib.coverageShort)) fails.push({ id: 'calibration.fail', msg: `标定断言 ${calib.fail} 条超差${calib.coverageShort ? '（且可断言条目低于下限）' : ''}` });
if (adv) {
  if ((adv.blockers || 0) > (limit.maxBlocker ?? 0)) fails.push({ id: 'adversarial.blocker', msg: `对抗审查 ${adv.blockers} 个 BLOCKER（上限 ${limit.maxBlocker ?? 0}）` });
  if ((adv.warns || 0) > (limit.maxWarn ?? 99)) warns.push({ id: 'adversarial.warn', msg: `对抗审查 ${adv.warns} 条 WARN（上限 ${limit.maxWarn ?? 99}）` });
}

/** 检查项 → 该改哪个字段。这是 harness 的核心资产：把"人肉经验"变成表。 */
const ADVICE = {
  'gate.fail': { fields: ['durationSeconds', 'segments[].dur', 'captions[]'], hint: '门禁是交付完整性：帧数与时长不符、音画差 >0.1s、空帧/黑帧超限。先看 gate.json 的具体条目。' },
  'adversarial.blocker': { fields: ['segments[].args.itemAt', 'segments[].args.callouts[].at', 'segments[].dur'], hint: 'BLOCKER 多半是"元素永不会出现"：itemAt/at 超过段长。要么把时刻往前提，要么加长该段。' },
  'adversarial.warn': { fields: ['segments[].args.itemAt', 'segments[].args.figureImage'], hint: 'WARN 不阻断但要看：段首空帧属版式固有；voice.gender 需换音色或换人物；asset.source 需补来源记录。' },
  'calibration.fail': { fields: ['profile', 'segments[].args.figureCx', 'segments[].args.subY'], hint: '外观锚点超差：确认 profile 选对（current / legacy-2026-11），或该字段被显式覆盖成了另一代的值。' },
  'duration.range': { fields: ['captions[].text', 'segments[]'], hint: '时长由配音决定：改文案字数（每句约 0.22s/字），或增删段。' },
};

const report = {
  task: task.id, round, at: new Date().toISOString(), paramsIn: path.relative(REPO_ROOT, paramsIn),
  visualOnly: reuseVo, verdict: fails.length ? 'FAIL' : 'PASS',
  metrics, limits: limit,
  fails, warns,
  advice: fails.map((f) => ({ id: f.id, ...(ADVICE[f.id] || {}) })),
  detail: {
    gate: gate ? { verdict: gate.verdict, flatPct: gate.flatPct, blackPct: gate.blackPct, hook: gate.hook, avDelta: gate.avDelta } : null,
    calibration: calib ? { pass: calib.pass, fail: calib.fail, skip: calib.skip, bad: (calib.rows || []).filter((x) => x.status === 'FAIL') } : null,
    adversarial: adv ? { blockers: (adv.rows || []).filter((x) => x.level === 'BLOCKER'), warns: (adv.rows || []).filter((x) => x.level === 'WARN') } : null,
  },
  elapsedMs: Date.now() - started,
  artifacts: { params: 'params.json', film: 'film.mp4', gate: 'gate.json', calibration: 'calibration.json', adversarial: 'adversarial.json' },
};
fs.writeFileSync(path.join(R, 'report.json'), JSON.stringify(report, null, 2));

const md = [
  `# round-${String(round).padStart(2, '0')} · ${report.verdict}`,
  '',
  `| 指标 | 值 |`, `|---|---|`,
  `| 时长 | ${metrics.duration.toFixed(2)}s |`,
  `| 体积 | ${metrics.sizeMB} MB |`,
  `| 帧数 | ${metrics.frames} |`,
  `| 门禁 | ${gate?.verdict || '—'}（flat ${metrics.flatPct}% / black ${metrics.blackPct}%） |`,
  `| 标定 | ${calib ? `${calib.pass} pass / ${calib.fail} fail / ${calib.skip} skip` : '—'} |`,
  `| 对抗 | BLOCKER ${metrics.blockers ?? '—'} / WARN ${metrics.warns ?? '—'} |`,
  '',
  '## 必须改', ...(fails.length ? fails.map((f) => `- **${f.id}** ${f.msg}`) : ['- 无']), '',
  ...(warns.length ? ['## 可以解释', ...warns.map((f) => `- ${f.id} ${f.msg}`), ''] : []),
  '## 下一轮建议',
  ...(report.advice.length ? report.advice.map((a) => `- ${a.id}：改 \`${(a.fields || []).join(' / ')}\` —— ${a.hint}`) : ['- 无，可以交付']),
].join('\n');
fs.writeFileSync(path.join(R, 'report.md'), md);

if (!QUIET) {
  console.log(`round-${String(round).padStart(2, '0')} · ${report.verdict} · ${metrics.duration.toFixed(1)}s · ${metrics.sizeMB}MB · ${(report.elapsedMs / 1000).toFixed(1)}s`);
  for (const f of fails) console.log(`  ✗ ${f.id}: ${f.msg}`);
  for (const w of warns) console.log(`  ! ${w.id}: ${w.msg}`);
  if (report.advice.length) {
    console.log('  建议：');
    for (const a of report.advice) console.log(`    · ${a.id} → ${(a.fields || []).join(' / ')}`);
  }
  console.log(`  报告 ${path.relative(REPO_ROOT, path.join(R, 'report.md'))}`);
}
process.exit(fails.length ? 1 : 0);
