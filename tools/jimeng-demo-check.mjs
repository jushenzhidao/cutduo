#!/usr/bin/env node
/**
 * jimeng-demo-check.mjs · 任务 A 的判据（fix-loop 阶段 0）
 *
 * 判据来自 `.fixloop/criteria.md` 的 A1–A5，不是我自己想的"最佳实践"：
 *   A1 换题材只改 JSON —— --params <alt> 能出片，且帧必须与默认不同
 *   A2 重构行为不变 —— 默认参数下 6 个固定时刻的帧 md5 逐个等于基线
 *   A3 不能静默产废片 —— 参数非法必须退出码 ≠ 0
 *   A4 不带 --params 仍可用
 *   A5 单帧模式不受影响
 *
 *   node tools/jimeng-demo-check.mjs            # 跑一遍，写留痕
 *   node tools/jimeng-demo-check.mjs --rebase   # 重设基线（只在**有意的**视觉改动后手动跑）
 *
 * 为什么要基线存盘而不是每次现算：现算等于「自己跟自己比」，改了代码基线也跟着变，
 * A2 永远绿。基线一旦写死，重构才可能被发现"其实改了输出"。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FIX = path.join(ROOT, '.fixloop');
const BASE = path.join(FIX, 'jimeng-baseline.json');
const FIXTURE = path.join(FIX, 'fixtures', 'alt-params.json');
const ALT_OUT = path.join(FIX, 'out');
const REBASE = process.argv.includes('--rebase');

/** 固定抽样时刻：每镜一个，覆盖六种构图 */
const MARKS = ['1.9', '3.9', '6.6', '8.8', '11.4', '14.0'];

fs.mkdirSync(ALT_OUT, { recursive: true });
fs.mkdirSync(path.join(FIX, 'logs'), { recursive: true });

const run = (args) => {
  const r = spawnSync('node', ['tools/jimeng-demo.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 << 20,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

const render = (at, out, extra = []) => {
  const r = run(['--at', at, '--out', out, ...extra]);
  return { ...r, hash: fs.existsSync(out) ? md5(out) : null };
};

/* ────────────────────────────── 基线 */

function buildBaseline() {
  const b = {};
  for (const m of MARKS) {
    const o = path.join(ALT_OUT, `base-${m}.png`);
    const r = render(m, o);
    if (r.code !== 0 || !r.hash) {
      console.error(`基线渲染失败 ${m}s：${r.out.slice(-300)}`);
      process.exit(2);
    }
    b[m] = r.hash;
  }
  fs.writeFileSync(BASE, JSON.stringify({ created: new Date().toISOString(), marks: b }, null, 2));
  return b;
}

if (REBASE && fs.existsSync(BASE)) {
  fs.renameSync(BASE, BASE.replace('.json', `.bak-${Date.now()}.json`));
  console.log('  基线已归档，重新生成');
}
const hadBase = fs.existsSync(BASE);
const baseline = hadBase ? JSON.parse(fs.readFileSync(BASE, 'utf8')).marks : buildBaseline();
const freshBaseline = !hadBase;   // 先判存在性再生成，否则恒为 false

/* ────────────────────────────── 检查 */

const results = [];
function check(id, name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r.ok;
    detail = r.detail || '';
  } catch (e) {
    ok = false;
    detail = `异常：${e.message}`;
  }
  results.push({ id, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${detail ? ' — ' + detail : ''}`);
}

/* A2：重构等价（先跑，因为它不依赖新参数） */
check('A2', '默认参数 6 帧与基线逐帧一致', () => {
  const diff = [];
  for (const m of MARKS) {
    const o = path.join(ALT_OUT, `cur-${m}.png`);
    const r = render(m, o);
    if (r.code !== 0) return { ok: false, detail: `${m}s 渲染失败` };
    if (r.hash !== baseline[m]) diff.push(m);
  }
  return {
    ok: diff.length === 0,
    detail: diff.length ? `不一致：${diff.join(', ')}` : '6/6 相同',
  };
});

/* A4：省略参数仍可用 */
check('A4', '不带 --params 用内置默认', () => {
  const r = render('3.9', path.join(ALT_OUT, 'a4.png'));
  return { ok: r.code === 0 && r.hash !== null, detail: `exit=${r.code}` };
});

/* A5：单帧模式 */
check('A5', '单帧模式 --at --out 输出 PNG', () => {
  const o = path.join(ALT_OUT, 'a5.png');
  const r = render('12.6', o);
  const head = fs.existsSync(o) ? fs.readFileSync(o).subarray(1, 4).toString() : '';
  return { ok: r.code === 0 && head === 'PNG', detail: `exit=${r.code} magic=${head || '无'}` };
});

/* A1：换题材只改 JSON（夹具是**目标 schema**，先于实现写好） */
check('A1', '--params <alt> 生效且产物不同于默认', () => {
  if (!fs.existsSync(FIXTURE)) return { ok: false, detail: `缺夹具 ${path.relative(ROOT, FIXTURE)}` };
  const o = path.join(ALT_OUT, 'a1.png');
  const r = render('3.9', o, ['--params', FIXTURE]);
  if (r.code !== 0) return { ok: false, detail: `exit=${r.code}` };
  const same = r.hash === baseline['3.9'];
  return {
    ok: !same,
    detail: same ? '帧与默认完全相同 ⇒ --params 被忽略' : '帧已改变',
  };
});

/* A3：非法参数必须报错（三种） */
const bad = [
  ['空对象', { meta: { duration: 15, fps: 30 } }, '缺 scenes'],
  ['未知 scene id', { meta: { duration: 15, fps: 30 }, scenes: [{ id: 'nope', t0: 0, t1: 2 }] }, '未知 id'],
  ['时刻越界', { meta: { duration: 15, fps: 30 }, scenes: [{ id: 'scatter', t0: 0, t1: 99 }] }, '越界'],
];
for (const [label, payload, why] of bad) {
  check('A3', `非法参数(${label}) 必须非零退出`, () => {
    const f = path.join(ALT_OUT, `bad-${label}.json`);
    fs.writeFileSync(f, JSON.stringify(payload));
    const r = render('1.0', path.join(ALT_OUT, `bad-${label}.png`), ['--params', f]);
    return { ok: r.code !== 0, detail: `exit=${r.code}（期望≠0，理由：${why}）` };
  });
}

/* D1：版式容量 —— 超宽文案必须被拒绝，且要报出字数上限。
   这条判据来自实测：长文案会让卡片标题穿出卡片、大字压到玻璃卡，
   而渲染器不会报错，只是画出来难看。 */
check('D1', '超宽文案被拒绝且给出字数上限', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/jimeng-showreel/params.json'), 'utf8'));
  const bad = JSON.parse(JSON.stringify(base));
  const g = bad.scenes.find((x) => x.id === 'gather');
  g.title[0] = '往里掉，就出不来。';   // 9 字 > 800px / 104px ≈ 7 字
  const f = path.join(ALT_OUT, 'too-long.json');
  fs.writeFileSync(f, JSON.stringify(bad, null, 2));
  const r = render('3.9', path.join(ALT_OUT, 'too-long.png'), ['--params', f]);
  const mentionsCap = /建议 ≤\d+ 字/.test(r.out);
  return {
    ok: r.code !== 0 && mentionsCap,
    detail: `exit=${r.code} 字数上限提示=${mentionsCap ? '有' : '无'}`,
  };
});

/* D2：容量校验不能误杀合法文案 */
check('D2', '合法文案不被容量校验误杀', () => {
  const r = render('3.9', path.join(ALT_OUT, 'd2.png'), ['--params', FIXTURE]);
  return { ok: r.code === 0, detail: `alt 夹具 exit=${r.code}` };
});

/* E1–E3：容量表的可维护性。
   问题不是"能不能校验"，是"改了版式坐标会不会忘了改容量"——
   现在 27 条 maxW 是手工从坐标反推的数，改坐标时不会有任何提示。
   彻底解法是把绘制坐标抽成常量、两边共用；但那是 15+ 处坐标改动，成本和风险都高过收益
   （每改一处都可能打错，A2 会一轮轮打回）。所以退一步：**强制把依据写成算式**，
   让人改坐标时看得见 `1010 - 170 - 40`，从而知道要同步。 */

check('E1', '--print-slots 可导出容量表', () => {
  const r = spawnSync('node', ['tools/jimeng-demo.mjs', '--print-slots'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, detail: `exit=${r.status} ${(r.stderr || '').slice(0, 120)}` };
  const rows = JSON.parse(r.stdout);
  const bad = rows.filter((x) => !Number.isFinite(x.maxW));
  return { ok: rows.length > 0 && !bad.length, detail: `${rows.length} 条` };
});

check('E2', 'maxW 全部写成算式（不允许裸数字）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/jimeng-demo.mjs'), 'utf8');
  const bare = [...src.matchAll(/maxW:\s*(\d+)\s*[,}]/g)];
  return {
    ok: bare.length === 0,
    detail: bare.length ? `${bare.length} 处裸数字（前三个：${bare.slice(0, 3).map((m) => m[1]).join(', ')}）` : '全部为算式',
  };
});

check('E3', '容量值与改写前快照逐个相同', () => {
  const snap = path.join(FIX, 'slots-baseline.json');
  if (!fs.existsSync(snap)) return { ok: false, detail: `缺快照 ${path.relative(ROOT, snap)}` };
  const base = JSON.parse(fs.readFileSync(snap, 'utf8'));
  const r = spawnSync('node', ['tools/jimeng-demo.mjs', '--print-slots'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, detail: `--print-slots exit=${r.status}` };
  const cur = JSON.parse(r.stdout);
  const key = (x) => `${x.sc}|${JSON.stringify(x.path)}`;
  const bm = new Map(base.map((x) => [key(x), x.maxW]));
  /* 只比对快照里**已有**的槽位：新增槽位没有"改写前"的值可比，
     把它算成"不同"会让每次扩覆盖面都误报回归。 */
  const diff = cur
    .filter((x) => bm.has(key(x)) && bm.get(key(x)) !== x.maxW)
    .map((x) => `${x.sc}=${bm.get(key(x))}→${x.maxW}`);
  const added = cur.filter((x) => !bm.has(key(x))).length;
  return {
    ok: diff.length === 0,
    detail: diff.length ? diff.join(' ') : `${cur.length - added}/${base.length} 原有相同${added ? ` · 新增 ${added}` : ''}`,
  };
});

/* F1/F3：容量覆盖面。上一轮只覆盖 27 个槽位，四类"可长文本"漏在外面——
   eyebrow 的短语、scatter 的漂浮词、落版的平台清单、arrange 的标签。
   漏掉的后果与已覆盖的一样：写长了穿出画面，渲完才发现。 */

const REQUIRED_SLOTS = [
  ['scatter', ['words']],
  ['gather', ['eyebrow', 1]],
  ['recall', ['eyebrow', 1]],
  ['arrange', ['tags']],
  ['route', ['eyebrow', 1]],
  ['lockup', ['platforms']],
];

check('F1', '四类可长文本已纳入容量表', () => {
  const r = spawnSync('node', ['tools/jimeng-demo.mjs', '--print-slots'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, detail: `--print-slots exit=${r.status}` };
  const keys = new Set(JSON.parse(r.stdout).map((x) => `${x.sc}|${JSON.stringify(x.path)}`));
  const miss = REQUIRED_SLOTS.filter(([sc, path]) => !keys.has(`${sc}|${JSON.stringify(path)}`));
  return {
    ok: miss.length === 0,
    detail: miss.length ? `缺 ${miss.map(([sc, p]) => sc + '.' + p.join('.')).join(', ')}` : `${keys.size} 条全覆盖`,
  };
});

const LONG_CASES = [
  ['eyebrow 短语过长', (t) => { t.scenes.find((x) => x.id === 'gather').eyebrow[1] = 'WRITE.THE.WHOLE.FILM.AND.EVERY.SINGLE.SHOT.AND.CAPTION.IN.ONE.SENTENCE.WITH.NO.BREAKS.AT.ALL'; }, 'gather.eyebrow'],
  ['scatter 漂浮词过长', (t) => { t.scenes.find((x) => x.id === 'scatter').words[0] = '一整个完整的分镜脚本'; }, 'scatter.words'],
  ['落版平台清单过长', (t) => { t.scenes.find((x) => x.id === 'lockup').platforms = ['CLI', 'API', 'MCP', 'WEB', '微信', '小程序', '飞书', '企业微信', '钉钉', 'QQ', '支付宝', '抖音', 'B站', '小红书', '知乎', '微博', '快手', '淘宝', '京东', '拼多多']; }, 'lockup.platforms'],
];

for (const [i, [label, mutate]] of LONG_CASES.entries()) {
  check('F3', `${label}必须被拒绝`, () => {
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/jimeng-showreel/params.json'), 'utf8'));
    const bad = JSON.parse(JSON.stringify(base));
    mutate(bad);
    const f = path.join(ALT_OUT, `f3-${i}.json`);
    fs.writeFileSync(f, JSON.stringify(bad, null, 2));
    const r = render('3.9', path.join(ALT_OUT, `f3-${i}.png`), ['--params', f]);
    return { ok: r.code !== 0, detail: `exit=${r.code}（期望≠0）` };
  });
}

/* ────────────────────────────── 留痕 */

const failed = results.filter((r) => !r.ok);
const round = fs.existsSync(path.join(FIX, 'runs.ndjson'))
  ? fs.readFileSync(path.join(FIX, 'runs.ndjson'), 'utf8').trim().split('\n').filter(Boolean).length + 1
  : 1;
const logPath = path.join(FIX, 'logs', `r${String(round).padStart(2, '0')}.log`);
const full = [
  `# round ${round} · ${new Date().toISOString()}`,
  ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}\t${r.id}\t${r.name}\t${r.detail}`),
].join('\n');
fs.writeFileSync(logPath, full + '\n');

const firstError = failed.length ? `${failed[0].id} ${failed[0].name}` : '';
const record = {
  round,
  ts: new Date().toISOString(),
  cmd: 'node tools/jimeng-demo-check.mjs',
  exit_code: failed.length ? 1 : 0,
  passed: results.length - failed.length,
  failed: failed.length,
  fingerprint: crypto.createHash('sha1').update(firstError).digest('hex').slice(0, 8),
  first_error: firstError,
  log_path: path.relative(ROOT, logPath),
  git_head: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'none',
  fresh_baseline: freshBaseline,
};
fs.appendFileSync(path.join(FIX, 'runs.ndjson'), JSON.stringify(record) + '\n');

console.log(`\n  ${results.length - failed.length}/${results.length} 通过 · round ${round}`);
if (failed.length) console.log(`  失败：${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length ? 1 : 0);
