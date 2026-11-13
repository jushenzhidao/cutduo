/**
 * kits/collage/collage.mjs · Screen Collage（深色科技风 · 横屏 1920×1080）
 *
 * 半蒸馏产物：借的是模板的**内容模型**（11 个场景 / 场景原长与停留点 / 槽位语义），
 * 渲染层全部重写。上游 `content/release.bin` 里的渲染核心是 AES-256-GCM 密文，
 * 换宿主不成立（拿不到源码），所以按 AGENTS.md §1.1 的梯子走到"半蒸馏"这一级。
 *
 * 内容模型对照（上游 → 本 kit）：
 *   guide.duration.rules 的 11 段原长      → presets/demo.json 的 t0/t1
 *   copy.<scene>.*  229 个文字槽           → 每个场景 args 里的具名字段
 *   media.wall00..11 / demo / portrait     → reuse.args.tiles / adapt 的示例画面
 *   brand.name / domain / initial          → end.args
 *   copy.labels.<scene>                    → scenes[].args.label（HUD 章节名）
 *
 * 逐帧耗时实测见 README.md（Skia 直出，无浏览器）。
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  C, FAM, clamp, easeOut, seg, txt, tag, appIcon, dot, bar, fillRR, strokeRR, glass, measure,
} from './ui.mjs';
import * as S from './scenes.mjs';

const W = 1920;
const H = 1080;
const TINT = 'rgba(13,24,49,0.95)';

/** 固定的星点（不能用 Math.random：每帧位置会跳，出片会闪） */
const STARS = (() => {
  const out = [];
  let seed = 20261113;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 90; i++) {
    out.push({ x: rnd() * W, y: rnd() * H, r: 0.5 + rnd() * 1.5, p: rnd() * 6.28, a: 0.10 + rnd() * 0.35 });
  }
  return out;
})();

/** 背景里那些模糊的方块（参考片上半部有意无意透出的"版面残影"） */
const TILES = [
  [180, 140, 260, 190, 0.020], [520, 80, 360, 240, 0.014], [1180, 110, 300, 200, 0.018],
  [1560, 180, 240, 300, 0.013], [300, 450, 420, 200, 0.012], [1290, 420, 380, 240, 0.014],
];

/** 静态背景离屏缓存：底/辉光/残影/透视地面/暗角都是不动的，
 *  每帧重画等于 4 次全屏渐变填充（实测占单帧 60% 的绘制时间）。
 *  缓存成一张位图后每帧只剩 1 次 drawImage + 90 个星点。 */
let _bg = null;
function backgroundPlate() {
  if (_bg) return _bg;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');

  ctx.fillStyle = '#000204';
  ctx.fillRect(0, 0, W, H);

  const g = ctx.createRadialGradient(W * 0.5, H * 0.46, 30, W * 0.5, H * 0.46, 860);
  g.addColorStop(0, 'rgba(16,28,58,1)');
  g.addColorStop(0.35, 'rgba(8,14,34,1)');
  g.addColorStop(0.72, 'rgba(2,4,10,1)');
  g.addColorStop(1, 'rgba(0,1,3,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  for (const [x, y, w, h, a] of TILES) {
    fillRR(ctx, x, y, w, h, 8, `rgba(120,150,235,${a})`);
  }

  const horizon = 560;
  ctx.strokeStyle = 'rgba(120,150,220,0.055)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.lineTo(W, horizon);
  ctx.stroke();
  for (let i = -12; i <= 12; i++) {
    ctx.beginPath();
    ctx.moveTo(W / 2 + i * 26, horizon);
    ctx.lineTo(W / 2 + i * 240, H);
    ctx.stroke();
  }
  for (let i = 1; i < 9; i++) {
    const y = horizon + Math.pow(i / 8, 2.1) * (H - horizon);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  const v = ctx.createRadialGradient(W * 0.5, H * 0.5, 380, W * 0.5, H * 0.5, 1180);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.82)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);

  _bg = cv;
  return cv;
}

function background(ctx, t) {
  ctx.drawImage(backgroundPlate(), 0, 0);
  // 星点保留逐帧闪烁：这是画面里唯一的"活"背景元素
  for (const s of STARS) {
    const a = s.a * (0.55 + 0.45 * Math.sin(t * 1.6 + s.p));
    ctx.fillStyle = `rgba(190,210,255,${a * 0.5})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function timecode(t) {
  const f = Math.floor((t % 1) * 60);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60);
  return `00:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

function hud(ctx, t, label, alpha = 1, brand = { name: 'cutduo', initial: 'c' }) {
  ctx.save();
  ctx.globalAlpha = alpha;
  // 左上：应用图标 + 产品名 + 章节
  appIcon(ctx, 24, 22, 28, { r: 8, glow: false, letter: brand.initial });
  txt(ctx, brand.name, 64, 42, { size: 15, fam: FAM.semi, color: '#E8EBF2' });
  if (label) tag(ctx, label, 232, 41, { size: 11.5, tracking: 1.8, color: '#6E7590' });

  // 右上：预览标识 + 时间码
  dot(ctx, 1634, 36, 3.2, '#FF5C7A', 8);
  tag(ctx, 'PREVIEW', 1650, 41, { size: 10.5, tracking: 2.2, color: '#6E7590' });
  tag(ctx, timecode(t), 1849, 41, { size: 12, tracking: 0.8, align: 'right', color: '#B9BFD4' });

  // 章节细线
  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 112);
  ctx.lineTo(1880, 112);
  ctx.stroke();
  // 当前章节刻度：一段亮线（参考片只在左侧画一小段）
  const cg = ctx.createLinearGradient(40, 112, 300, 112);
  cg.addColorStop(0, 'rgba(255,255,255,0.55)');
  cg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = cg;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(40, 112);
  ctx.lineTo(300, 112);
  ctx.stroke();
  ctx.restore();
}

function timeline(ctx, t, total, scenes) {
  const x0 = 40;
  const x1 = 1880;
  const y = 1014;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();

  const at = (sec) => x0 + (x1 - x0) * clamp(sec / total);
  // 场景刻度
  for (const s of scenes) {
    const x = at(Number(s.t0));
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.stroke();
  }
  // 已播部分
  const px = at(t);
  const g = ctx.createLinearGradient(x0, y, x1, y);
  g.addColorStop(0, '#7ED8F8');
  g.addColorStop(0.5, '#C48BF2');
  g.addColorStop(1, '#F76FB2');
  ctx.strokeStyle = g;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(px, y);
  ctx.stroke();

  // 播放头
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(px, y - 16);
  ctx.lineTo(px, y + 6);
  ctx.stroke();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(px, y, 3.2, 0, Math.PI * 2);
  ctx.fill();

  // 当前场景名（在播放头右边，10px mono）
  const cur = scenes.find((s) => t >= Number(s.t0) && t < Number(s.t1)) ||
    scenes.find((s) => t >= Number(s.t0));
  if (cur && cur.args && cur.args.label) {
    tag(ctx, cur.args.label, px + 12, y + 5, { size: 9, tracking: 1.2, color: 'rgba(255,255,255,0.42)' });
  }
  ctx.restore();
}

/**
 * 已审核静止点（照抄 guide.json 的 duration.rules）。
 * 停留只允许发生在这些点上，且场景构图必须保持不动 —— 这是上游的硬约束，
 * 不是"随便停一下"。没有列出静止点的场景（hero/open/spec/finale）不允许停留。
 */
const STILL = {
  recipe: 4.75, pack: 5.75, flow: 8.5, adapt: 2.0, reuse: 4.0, share: 3.0, end: 2.5,
};

const PAINTERS = {
  hero: S.hero,
  recipe: S.recipe,
  open: S.open,
  pack: S.pack,
  flow: S.flow,
  adapt: S.adapt,
  reuse: S.reuse,
  spec: S.spec,
  share: S.share,
  finale: S.finale,
  end: S.end,
};

export function createCollageRenderer({ canvas, ctx, width = W, height = H, fps = 60 }) {
  let scenes = [];
  let total = 57;
  let brand = { name: 'cutduo', initial: 'c' };
  // 媒体载体（上游 media 契约的对应物）：角色名 → { img, fit, focusX, focusY }
  const media = new Map();
  let mediaDefs = {};
  let fadeIn = 0.35;

  function paintAt(t) {
    background(ctx, t);
    let cur = null;
    for (const s of scenes) {
      const t0 = Number(s.t0 ?? 0);
      const t1 = Number(s.t1 ?? t0 + 4);
      if (t >= t0 && t < t1) {
        cur = s;
        break;
      }
    }
    if (!cur && scenes.length) cur = scenes[scenes.length - 1];

    if (cur) {
      const t0 = Number(cur.t0 ?? 0);
      const t1 = Number(cur.t1 ?? t0 + 4);
      const dur = Math.max(0, t1 - t0);
      // 停留：到达已审核静止点后，场景时钟就地冻住，构图不动；
      // 全局时间轴、HUD 时间码、底部进度继续走（上游规则原话）。
      const still = cur.still !== undefined ? Number(cur.still) : STILL[cur.type];
      const hold = Number(cur.hold || 0);
      const frozen = hold > 0 && still !== undefined ? Math.min(Math.max(0, t - t0), still) : null;
      const local = frozen !== null
        ? frozen
        : clamp(t - t0, 0, Math.max(0, dur - 1 / fps));
      const fn = PAINTERS[cur.type] || S.hero;
      ctx.save();
      try {
        // 品牌注入：图标字母、文件后缀这类全片统一的标识，不该由每个场景各写一份
        fn(ctx, { ...(cur.args || {}), __brand: brand, __media: media }, local, t1 - t0);
      } catch (e) {
        // 单场景出错不该让整片崩：把错误画在画面上，继续渲染下一帧
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, 300, W, 120);
        txt(ctx, `scene "${cur.type}" failed: ${String(e.message).slice(0, 90)}`, 60, 370, {
          size: 24, fam: FAM.mono, color: '#FF7A8A',
        });
      }
      ctx.restore();
    }

    // HUD：end 场景末尾淡出（参考片最后 1.2s 只剩落款）
    let hudA = 1;
    if (cur && cur.type === 'end') {
      const t0 = Number(cur.t0);
      hudA = 1 - clamp((t - (t0 + 1.4)) / 1.2);
    }
    if (hudA > 0.01) hud(ctx, t, cur && cur.args ? cur.args.label : '', hudA, brand);
    timeline(ctx, t, total, scenes);

    // 开场淡入：时长由 params.fadeInSeconds 决定（默认 0.35s）。
    // 30 秒短片里 0.35s ≈ 1.2% 帧，叠加场景首帧就会顶穿 3% 黑帧门禁。
    if (fadeIn > 0 && t < fadeIn) {
      ctx.fillStyle = `rgba(0,0,0,${1 - t / fadeIn})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  return {
    setContent(content) {
      scenes = (content && content.scenes) || [];
      mediaDefs = (content && content.media) || {};
      // 开场淡入时长可配：短片总帧数少，0.35s 的黑场就会把「黑帧占比」推过 3% 的门禁线
      if (content && content.fadeInSeconds !== undefined) fadeIn = Number(content.fadeInSeconds);
      if (content && content.brand) {
        brand = { name: content.brand.name || brand.name, initial: content.brand.initial || brand.initial };
      }
      total = scenes.reduce((m, s) => Math.max(m, Number(s.t1 ?? 0)), 57);
    },
    async ready() {
      // 媒体载体：src 由 render.mjs 解析成绝对路径；cover/contain + focus 语义同上游。
      // 载入失败不中断出片（该角色退回程序化绘制），只打一行警告。
      for (const [role, d] of Object.entries(mediaDefs)) {
        if (!d || !d.src) continue;
        try {
          const img = await loadImage(d.src);
          media.set(role, {
            img,
            fit: d.fit === 'contain' ? 'contain' : 'cover',
            focusX: d.focusX === undefined ? 0.5 : Number(d.focusX),
            focusY: d.focusY === undefined ? 0.5 : Number(d.focusY),
          });
        } catch (e) {
          console.warn(`  ⚠ media.${role} 载入失败：${d.src}`);
        }
      }
    },
    renderFrame(t) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      paintAt(t);
      ctx.restore();
    },
  };
}

/** 供 api/kits/collage.mjs 复用：能力自述 */
export const COLLAGE_SCENES = Object.keys(PAINTERS);
