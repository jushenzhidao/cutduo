#!/usr/bin/env node
// narration-lint.mjs — 口播文案的可自动检查项（对应 docs/科普口播-写作原则.md）。
//
// 为什么要有它（2026-11-14）：13 条原则写成了文档，但文档不拦人。出片流程里文案是唯一
// 没有任何机器约束的环节——画面有 gate、节奏有 pacing、事实有台账，而"像照目录复述"
// 这种最要命的问题全靠自觉。这里把其中**能判的**挑出来做硬检查，判不了的明确说判不了。
//
// 能判的（有硬指标）：
//   · 每拍字数 > 28 ⇒ 必然超 7s 被拆段，要多写一屏（§ 本仓口径）
//   · 总字数 ÷ 4.0 与档位目标时长偏差 > 20%
//   · 开场是定义式 / 预告式（§1）
//   · 报幕式过渡（§13 后半：只播报顺序，不给动机）
//   · 结尾是总结清单 / 客套（§9）
//   · 单句 > 35 字（§7 节奏）
//   · 连续三句字数接近 ⇒ 句式单调（§7）
//   · 「为什么」类因果词密度过低（§3 先动机后机制）
//
// 判不了的（必须人读）：主线是否唯一（§2）、比喻是否承重（§5）、数字是否换算（§4）、
// 术语是否后置（§8）。这些写在检查表里，工具不假装能测。
//
// 用法：node tools/narration-lint.mjs <slug> [<slug> ...] | --all

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = JSON.parse(readFileSync(path.join(ROOT, 'tools/knowledge/guide.json'), 'utf8'));
const CPS = GUIDE.narration.charsPerSecond || 4.0;
const BEAT_MAX = GUIDE.narration.beatCharsMax || 28;

const clean = (s) => String(s || '').replace(/[，。！？、；：""''（）—…·\s]/g, '');
const sentences = (s) => String(s || '').split(/[。！？；]/).map((x) => clean(x)).filter(Boolean);

// 因果/动机类词：§3 要求「先动机后机制」，一段里至少要有一处，否则就是在报机制
// 「动机」不只由因果连词承载：反问句（「一千个凭什么？」）同样是动机。
// 只数「因为/所以」会把一批好文案判死（实测本仓 9 支片全被误报 0.0/拍）。
const CAUSAL = /为什么|因为|否则|不然|后果|代价|导致|结果|才会|如果不|要不是|凭什么|怎么会|难道|不是.{0,8}而是/g;

function lintOne(slug) {
  const file = path.join(ROOT, `content/${slug}/script.json`);
  if (!existsSync(file)) return { slug, error: '没有 script.json' };
  const s = JSON.parse(readFileSync(file, 'utf8'));
  const beats = s.beats || [];
  const tier = GUIDE.durations[s.tier] || null;
  const findings = [];
  // 显式豁免：老片按旧口径（5.5 字/秒）写的，篇幅对不上新档位。**例外必须写进文件并给理由**，
  // 不能靠放宽阈值——放宽等于对所有新片失效，而这里要的是"这一支有据可查"。
  const waivers = new Set(s.lintWaivers || []);

  const chars = beats.map((b) => clean(b.text).length);
  const total = chars.reduce((a, b) => a + b, 0);
  const est = total / CPS;

  // 1. 每拍超长 ⇒ 必拆段。已经按「拆段数」补足 screens 的不再报——
  //    否则这套检查对"已修好的旧片"永远红，人就会整片忽略它。
  //
  // 段数优先读构建产物：用字数估会因为 TTS 停顿差异偏大（benford C04 估 2 段、实际 1 段），
  // 估出来的「需要几屏」会误杀。没有 params 时（还没构建过）才退回估算，并且只当提示。
  const abs = path.join(ROOT, `content/${slug}/params.json`);
  const segByBeat = new Map();
  let exact = false;
  if (existsSync(abs)) {
    try {
      const pj = JSON.parse(readFileSync(abs, 'utf8'));
      const list = pj.scenes || pj.segments || [];
      for (const sc of list) if (sc.beat) segByBeat.set(sc.beat, (segByBeat.get(sc.beat) || 0) + 1);
      exact = segByBeat.size > 0;
    } catch { /* 读不到就退回估算 */ }
  }

  const long = beats.map((b, i) => {
    const est = Math.max(1, Math.ceil((chars[i] / CPS) / 7));
    const parts = exact ? (segByBeat.get(b.id) || 1) : est;
    return { id: b.id, n: chars[i], parts, have: (b.screens || []).length };
  }).filter((r) => r.n > BEAT_MAX && r.have < r.parts);
  if (long.length) {
    findings.push({
      level: exact ? '中' : '低', rule: exact ? '本仓口径' : '本仓口径（估算）',
      what: `${long.length} 拍超 ${BEAT_MAX} 字且 screens 不够（${long.map((r) => `${r.id} ${r.n}字/${r.have}屏需${r.parts}屏`).join('、')}）——第二段会重放同一画面`,
    });
  }

  // 2. 总时长偏差
  if (tier) {
    const [lo, hi] = tier.seconds;
    const dev = est < lo ? (lo - est) / lo : (est > hi ? (est - hi) / hi : 0);
    if (dev > 0.2) {
      const waived = waivers.has('篇幅');
      findings.push({
        level: waived ? '低' : '中',
        rule: waived ? '§ 篇幅（已豁免）' : '§ 篇幅',
        what: `估算 ${est.toFixed(0)}s，${s.tier}档目标 ${lo}–${hi}s，偏差 ${(dev * 100).toFixed(0)}%${waived ? ` —— ${s.waiverNote || '已登记豁免'}` : ''}`,
      });
    }
  }

  const head = clean(beats[0] && beats[0].text);
  const tail = clean(beats[beats.length - 1] && beats[beats.length - 1].text);

  // 3. 开场：定义式 / 预告式
  if (/是一种|是一种|定义为|指的是|所谓|在本期|本期视频|这条视频|我们将|带你了解/.test(head)) {
    findings.push({ level: '高', rule: '§1 从处境切入', what: `开场是定义/预告式：「${head.slice(0, 18)}」——先给场景或谜题，别先给定义` });
  }

  // 4. 报幕式过渡
  const announce = beats.map((b) => clean(b.text)).filter((t) => /^(接下来|下面我们|接下来我们|首先我们来看|下一节|然后我们)/.test(t));
  if (announce.length) {
    findings.push({ level: '中', rule: '§13 报幕不要', what: `${announce.length} 处报幕式过渡（${announce.map((t) => t.slice(0, 8)).join('、')}）——给动机，不要播报顺序` });
  }

  // 5. 结尾：总结清单 / 客套
  if (/总之|综上|以上就是|希望.*有用|感谢观看|我们下期/.test(tail)) {
    findings.push({ level: '中', rule: '§9 结尾回扣', what: `结尾是总结/客套：「${tail.slice(0, 18)}」——结尾要回扣开场并重新框定` });
  }

  // 6. 单句过长
  const allSent = beats.flatMap((b) => sentences(b.text).map((x) => ({ id: b.id, x })));
  const tooLong = allSent.filter((r) => r.x.length > 35);
  if (tooLong.length) {
    findings.push({ level: '低', rule: '§7 节奏', what: `${tooLong.length} 句超过 35 字（最长 ${Math.max(...tooLong.map((r) => r.x.length))} 字）` });
  }

  // 7. 句式单调：连续三句长度差 ≤2
  let mono = 0;
  for (let i = 2; i < allSent.length; i++) {
    const [a, b, c] = [allSent[i - 2].x.length, allSent[i - 1].x.length, allSent[i].x.length];
    if (Math.abs(a - b) <= 2 && Math.abs(b - c) <= 2) mono++;
  }
  if (mono >= 3) {
    findings.push({ level: '低', rule: '§7 变换节奏', what: `${mono} 处连续三句字数几乎相同——读起来单调，改掉其中一句` });
  }

  // 8. 因果词密度
  // 疑问句也是动机：「差别在哪？」「凭什么？」不需要连词就已经在造动机。
  // 只数连词会把这类文案判死（实测 birthday-v2 两个反问却只算 1 处）。
  const joined = beats.map((b) => b.text).join('');
  const causal = (joined.match(CAUSAL) || []).length + (joined.match(/[？?]/g) || []).length;
  if (beats.length && causal / beats.length < 0.4) {
    // 只作提示：词典法数不出「两张图互相矛盾」这种**结构性动机**。
    // 判成"中"会让一批好文案常年挂红（实测 sample-chart 全片 0 连词 0 问号，动机是画面里的矛盾本身）。
    findings.push({ level: '低', rule: '§3 先动机后机制（仅提示）', what: `因果词+疑问句仅 ${causal} 处（${(causal / beats.length).toFixed(1)}/拍）——若动机由画面承担可忽略` });
  }

  return { slug, total, est, beats: beats.length, findings };
}

/* ---------- 入口 ---------- */
const argv = process.argv.slice(2);
let slugs = argv.filter((a) => !a.startsWith('-'));
if (argv.includes('--all') || !slugs.length) {
  slugs = readdirSync(path.join(ROOT, 'content')).filter((d) => existsSync(path.join(ROOT, `content/${d}/script.json`)));
}

let hard = 0, soft = 0;
for (const slug of slugs) {
  const r = lintOne(slug);
  if (r.error) { console.log(`${slug}  ${r.error}`); continue; }
  if (!r.beats) continue;   // 没有 beats 的不是口播片（incident / pipeline-intro 等），跳过
  const h = r.findings.filter((f) => f.level === '高').length;
  const m = r.findings.filter((f) => f.level === '中').length;
  const l = r.findings.filter((f) => f.level === '低').length;
  hard += h + m; soft += l;
  console.log(`${slug.padEnd(16)} ${String(r.total).padStart(3)}字 ≈${r.est.toFixed(0)}s / ${r.beats}拍   高${h} 中${m} 低${l}`);
  for (const f of r.findings) console.log(`  [${f.level}] ${f.rule} —— ${f.what}`);
}
console.log(`\n合计：中及以上 ${hard} 条 / 低 ${soft} 条`);
console.log('判不了（必须人读）：主线唯一性 §2、比喻是否承重 §5、数字是否换算 §4、术语是否后置 §8。');
process.exit(hard ? 1 : 0);
