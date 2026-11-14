/**
 * kits/diagram/layout.mjs · 图示类段型共用的排版原语
 *
 * 为什么单独一层：13 个 family 的差别在「画什么形状」，不在「怎么量字、怎么折行、
 * 怎么在盒子放不下时报错」。这些共同的纪律放这里，family 只写自己的几何。
 *
 * 三条硬纪律（跟 paper 的段型门槛一致）：
 *   1. 折行只按实测宽度断，不按字数估 —— 中文全角、英文半角、数字字宽差一倍。
 *   2. 放不下就抛 CAPACITY 错误，不缩字号硬塞 —— 缩到看不清等于没画。
 *   3. 所有落笔位置先过 measure，再决定字号，最后才画 —— 反过来必留半截字。
 */

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/**
 * 当前讲到第几项。没有词级时间戳，只能按段内进度线性推 —— 段末必然落到最后一项。
 * 乘 1.12 让最后一项早点到，别让它在结束时才亮。
 */
export function activeIndex(progress, n) {
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.floor(clamp(progress) * n * 1.12));
}

/** 刻度步长取 1/2/5×10^n：读者认得 5、10、15，认不得 8.5 */
export function niceStep(span, target = 4) {
  const raw = Math.max(1e-9, span / Math.max(1, target));
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return mult * pow;
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t), 3);
export const easeOutQuint = (t) => 1 - Math.pow(1 - clamp(t), 5);
export const easeInOutSine = (t) => -(Math.cos(Math.PI * clamp(t)) - 1) / 2;

/** 错峰：第 i 个元素在窗口 [0,1] 内的出场进度，stagger 是每个元素的延迟占比 */
export function stagger(t, i, n, span = 0.12) {
  if (n <= 1) return easeOutCubic(t);
  const step = span / Math.max(1, n - 1);
  return easeOutCubic((t - i * step) / (1 - span));
}

/**
 * 锚点式进场：第 i 项在 entries[i] 秒（段内秒）才开始长，fade 秒内长完。
 *
 * 与 stagger 的区别是"依据什么排先后"：stagger 按序号均分整段（画面自己数拍子），
 * anchor 按念到那个词的真实时刻（画面跟声音）。后者才是"字幕和图不同步"的解药 ——
 * 一句里念到第三个数时，图上恰好只有三条。
 */
export function anchorStagger(t, i, entries, fade = 0.3) {
  const at = entries?.[i];
  if (!Number.isFinite(at)) return 0;
  return easeOutCubic((t - at) / Math.max(0.08, fade));
}

/** 当前讲到第几项：最后一个已经开口的锚点。逐项锚点时比 activeIndex 的线性外推可靠 */
export function anchorActive(t, entries) {
  if (!entries?.length) return 0;
  let idx = 0;
  for (let i = 0; i < entries.length; i++) if (t >= entries[i]) idx = i;
  return idx;
}

export function measure(ctx, text) {
  return ctx.measureText(text).width;
}

/**
 * 折行。中文逐字可断，英文/数字串不拆开（拆了 "1,200" 会变 "1,2"+"00"）。
 * 返回行数组，不做省略号 —— 截断由调用方决定抛错还是换版式。
 */
export function wrapLines(ctx, text, maxWidth) {
  const s = String(text ?? '');
  if (!s) return [];
  const tokens = s.match(/[A-Za-z0-9]+(?:[.,][A-Za-z0-9]+)*|\s+|[^\s]/g) ?? [s];
  const lines = [];
  let line = '';
  for (const tk of tokens) {
    const next = line + tk;
    if (line && measure(ctx, next) > maxWidth) {
      lines.push(line.trimEnd());
      line = tk.trimStart();
    } else {
      line = next;
    }
    // 单 token 本身就超宽（超长英文词）—— 按字符硬断，避免整行溢出
    while (line && measure(ctx, line) > maxWidth && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && measure(ctx, line.slice(0, cut)) > maxWidth) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/** 在给定字号下折行；行数超 maxLines 时返回 null，由调用方降字号或抛错 */
export function wrapWithin(ctx, text, maxWidth, fontSize, font, maxLines = 3) {
  ctx.font = `${fontSize}px ${font}`;
  const lines = wrapLines(ctx, text, maxWidth);
  return lines.length <= maxLines ? lines : null;
}

/**
 * 选字号：从 start 往下试，直到行数不超过 maxLines 且不小于 min。
 * 都不行就返回 { size: min, lines, overflow: true } —— 由调用方抛错或换版式。
 */
export function fitText(ctx, text, maxWidth, font, { start = 46, min = 20, maxLines = 2 } = {}) {
  for (let size = start; size >= min; size -= 2) {
    const lines = wrapWithin(ctx, text, maxWidth, size, font, maxLines);
    if (lines) return { size, lines, overflow: false };
  }
  ctx.font = `${min}px ${font}`;
  return { size: min, lines: wrapLines(ctx, text, maxWidth), overflow: true };
}

export class CapacityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CapacityError';
    this.code = code;
  }
}

/** 底纹网格：极淡，只提供"这是一张图纸"的暗示，不参与读数 */
export function drawGrid(ctx, box, palette, step = 44, alpha = 0.055) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = 1;
  const x0 = Math.ceil(box.x / step) * step;
  const y0 = Math.ceil(box.y / step) * step;
  ctx.beginPath();
  for (let x = x0; x <= box.x + box.width; x += step) {
    ctx.moveTo(x + 0.5, box.y);
    ctx.lineTo(x + 0.5, box.y + box.height);
  }
  for (let y = y0; y <= box.y + box.height; y += step) {
    ctx.moveTo(box.x, y + 0.5);
    ctx.lineTo(box.x + box.width, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** 标题下的细横线：从标题左缘拉到版心右缘 */
export function drawRule(ctx, x, y, width, palette) {
  ctx.save();
  ctx.strokeStyle = palette.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.5);
  ctx.lineTo(x + width, y + 0.5);
  ctx.stroke();
  ctx.restore();
}

/**
 * 编号圆点：黑底白字的小徽标，hierarchy / cycle / process 共用。
 * state: 'idle'（未讲到，退成灰）/ 'done'（讲完，黑）/ 'active'（正在讲，强调色）
 */
export function badge(ctx, cx, cy, n, palette, r = 15, state = 'done') {
  ctx.save();
  const fill = state === 'active' ? palette.accent : state === 'idle' ? palette.muted : palette.badge;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = palette.badgeInk;
  ctx.font = `700 ${Math.round(r * 1.06)}px ${'"NotoSC Black", sans-serif'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), cx, cy + 0.5);
  ctx.restore();
}

/** 直角折线：从 a 到 b，先竖后横（hierarchy / cycle 的连线语言） */
export function elbow(ctx, ax, ay, bx, by, midY) {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax, midY);
  ctx.lineTo(bx, midY);
  ctx.lineTo(bx, by);
  ctx.stroke();
}

/** 数字格式化：千分位 + 去掉无意义小数 */
export function fmtNum(v) {
  if (!Number.isFinite(v)) return String(v);
  const fixed = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return fixed.toLocaleString('zh-CN');
}
