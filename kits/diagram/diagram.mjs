/**
 * kits/diagram/diagram.mjs · 图示段型的入口：周边 + 分发
 *
 * 分工：
 *   families.mjs 只画"图"本身（条形、折线、节点）；
 *   本文件画"图之外"的东西 —— 标题、细横线、单位行、注释、底纹。
 * 这样 family 换皮肤时不动周边，周边换位置时不动 family。
 *
 * 调用方（kit 或 tools）只需要：
 *   drawDiagram(ctx, recipe, t, box, { palette, fonts })
 */

import {
  CANVAS,
  CAPACITY,
  FONTS,
  FRAME,
  PALETTES,
} from './tokens.mjs';
import { FAMILIES } from './families.mjs';
import {
  CapacityError,
  activeIndex,
  anchorActive,
  anchorStagger,
  clamp,
  drawGrid,
  drawRule,
  easeOutCubic,
  fitText,
  stagger,
  wrapLines,
  wrapWithin,
} from './layout.mjs';

export const DIAGRAM_FAMILIES = Object.keys(FAMILIES);

/**
 * 把 items[].at（锚点词）解析成段内秒。
 *
 * 为什么出片前就要解析：锚点写错（词不在稿子里、顺序颠倒）在画面上表现为
 * "某项永远不出现"，不会报错，只有看片才发现。宁可在这里抛。
 *
 * @param {object} recipe  { items[].at }
 * @param {{chars: {ch: string, t: number}[], line: string}} segTiming  段内相对秒
 * @param {number} segDur  段时长（秒），锚点越界也要拦
 */
export function resolveAnchors(recipe, segTiming, segDur) {
  const items = recipe?.items ?? [];
  const line = segTiming?.line ?? recipe?.line ?? '';
  const chars = segTiming?.chars ?? [];

  // 两组锚点，语义不同，不能合一：
  //   at    —— 这一项"多长/多大"什么时候说出来（条长、数值）
  //   rowAt —— 这一项"是什么"什么时候说出来（行标签先出现，条还是空的）
  // 分开以后才有"先说三个引擎，再一个一个报数"的节奏；合成一组的话，
  // 念到名字时条已经长满了，后面报数就只是复读。
  const pick = (field) => {
    const wants = items.map((it) => it?.[field]).filter((v) => typeof v === 'string' && v);
    if (!wants.length) return null;
    if (!line) throw new CapacityError('DIAGRAM_ANCHOR', `有锚点（${field}）但缺口播稿（line）`);

    const entries = [];
    let lastT = -1;
    items.forEach((it, i) => {
      const at = it?.[field];
      if (typeof at !== 'string' || !at) {
        entries.push(entries.length ? entries[entries.length - 1] : 0);
        return;
      }
      const pos = line.indexOf(at);
      if (pos < 0) {
        throw new CapacityError('DIAGRAM_ANCHOR', `锚点词不在口播稿里：「${at}」(${field})\n  稿：${line}`);
      }
      const t = Number(chars[pos]?.t);
      if (!Number.isFinite(t)) {
        throw new CapacityError('DIAGRAM_ANCHOR', `锚点没有时刻：「${at}」在第 ${pos} 字，chars 缺项`);
      }
      if (t > segDur) {
        throw new CapacityError('DIAGRAM_ANCHOR', `锚点越界：「${at}」在 ${t.toFixed(2)}s，段长只有 ${segDur.toFixed(2)}s`);
      }
      if (t < lastT) {
        throw new CapacityError('DIAGRAM_ANCHOR', `锚点顺序倒了：「${at}」在 ${t.toFixed(2)}s，上一项 ${lastT.toFixed(2)}s`);
      }
      lastT = t;
      entries.push(t);
    });
    return entries;
  };

  const entries = pick('at');
  const rowEntries = pick('rowAt');
  const resolved = items.map((it, i) => ({
    index: i,
    at: it?.at ?? null,
    rowAt: it?.rowAt ?? null,
    t: entries ? Number(entries[i].toFixed(3)) : null,
    rowT: rowEntries ? Number(rowEntries[i].toFixed(3)) : null,
  }));

  return { entries, rowEntries, resolved };
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} recipe  { family, duration, title?, unit?, note?, items[] }
 * @param {number} t       段内秒数（0..duration）
 * @param {{x,y,width,height}} box 可用矩形
 * @param {object} opts    { palette, fonts, frame, background }
 */
export function drawDiagram(ctx, recipe, t, box, opts = {}) {
  const family = recipe?.family;
  const draw = FAMILIES[family];
  if (!draw) {
    throw new CapacityError('DIAGRAM_FAMILY', `未知图示类型：${family}；可用 ${DIAGRAM_FAMILIES.join(' / ')}`);
  }

  const palette = opts.palette ?? PALETTES.paper;
  const fonts = opts.fonts ?? FONTS;
  const frame = { ...FRAME, ...(opts.frame ?? {}) };
  const duration = Number(recipe.duration) || 8;
  const p = Math.min(1, Math.max(0, t / duration));

  // 逐项锚点：recipe._entries 是每项"念到哪个字才进场"的段内秒，由 render 侧用
  // resolveAnchors() 算好写进来。没有锚点时保持老行为（按序号均分整段），
  // 13 类图示的样张与旧片一帧不改。
  const entries = Array.isArray(recipe._entries) ? recipe._entries : null;
  const rowEntries = Array.isArray(recipe._rowEntries) ? recipe._rowEntries : null;
  const fade = Number(recipe.revealFade) || 0.3;
  const env = {
    palette,
    fonts,
    frame,
    // 元镜头要的两样东西：当前绝对秒（timeline/glyph 判"这个字念到没有"）、
    // 当前帧号（framecount 直接印在屏幕上）。普通图示不看它们。
    now: Number.isFinite(opts.now) ? opts.now : null,
    frameInfo: opts.frame ?? null,
    reveal: (pp, i, n, span = 0.12) => (entries ? anchorStagger(t, i, entries, fade) : stagger(pp, i, n, span)),
    rowReveal: (pp, i, n, span = 0.12) =>
      rowEntries ? anchorStagger(t, i, rowEntries, fade) : entries ? anchorStagger(t, i, entries, fade) : stagger(pp, i, n, span),
    active: (pp, n) => (entries ? anchorActive(t, entries) : activeIndex(pp, n)),
  };

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (opts.background) {
    ctx.fillStyle = palette.bg;
    ctx.fillRect(box.x - 200, box.y - 200, box.width + 400, box.height + 400);
  }
  // ── 标题：三种位置轮换，避免八段同一构图
  //    left   —— 左上（默认，信息密度高的段落用）
  //    center —— 居中（定义/收束这类"要停下来读"的段落）
  //    none   —— 不画标题（公式、构成这类图本身够满的段落）
  const heading = recipe.heading ?? 'left';
  let contentTop = box.y;
  if (recipe.title && heading !== 'none') {
    const maxW = heading === 'center' ? box.width * 0.8 : box.width * 0.72;
    const titleFit = fitText(ctx, recipe.title, maxW, fonts.black, {
      start: frame.titleSize,
      min: 28,
      maxLines: 2,
    });
    if (titleFit.overflow && titleFit.lines.length > 2) {
      throw new CapacityError('DIAGRAM_CAPACITY', `标题过长：${recipe.title}`);
    }
    ctx.font = `${titleFit.size}px ${fonts.black}`;
    ctx.fillStyle = palette.ink;
    const blockH = titleFit.size * titleFit.lines.length * 1.16;
    if (heading === 'center') {
      ctx.textAlign = 'center';
      const cx = box.x + box.width / 2;
      titleFit.lines.forEach((ln, i) => {
        ctx.fillText(ln, cx, box.y + titleFit.size + i * titleFit.size * 1.16);
      });
      ctx.textAlign = 'left';
      ctx.save();
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - 60, box.y + blockH + 12);
      ctx.lineTo(cx + 60, box.y + blockH + 12);
      ctx.stroke();
      ctx.restore();
      contentTop = box.y + blockH + 40;
    } else {
      titleFit.lines.forEach((ln, i) => {
        ctx.fillText(ln, box.x, box.y + titleFit.size + i * titleFit.size * 1.16);
      });
      const ruleY = box.y + blockH + 12;
      drawRule(ctx, box.x, ruleY, box.width, palette);
      contentTop = ruleY + 16;
    }
  }

  // ── 段落计数器：右上角 02 / 08，给观众"还剩几段"的锚点
  if (opts.index != null && opts.total) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.font = `22px ${fonts.mono}`;
    ctx.fillStyle = palette.label;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${String(opts.index).padStart(2, '0')} / ${String(opts.total).padStart(2, '0')}`, box.x + box.width, box.y + 18);
    ctx.restore();
  }

  // 网格只铺内容区：铺到标题底下时，标题会压着一堆格线，像没对齐
  if (recipe.grid !== false) drawGrid(
    ctx,
    { x: box.x, y: contentTop, width: box.width, height: box.y + box.height - contentTop },
    palette,
    frame.gridStep,
    frame.gridAlpha
  );

  // ── 图本体
  const inner = { x: box.x, y: contentTop, width: box.width, height: box.y + box.height - contentTop };
  const state = draw(ctx, recipe, p, inner, env);

  // ── 注释：左下角一行小字，说明数据是虚构/示例，避免被当成事实
  if (recipe.note) {
    const noteFit = fitText(ctx, recipe.note, box.width * 0.8, fonts.reg, { start: frame.noteSize, min: 16, maxLines: 2 });
    ctx.font = `${noteFit.size}px ${fonts.reg}`;
    ctx.fillStyle = palette.label;
    ctx.globalAlpha = easeOutCubic(Math.min(1, p / 0.3));
    noteFit.lines.forEach((ln, i) => {
      ctx.fillText(ln, box.x, box.y + box.height - (noteFit.lines.length - 1 - i) * noteFit.size * 1.3);
    });
    ctx.globalAlpha = 1;
  }

  ctx.restore();
  return { family, duration, progress: p, ...state };
}

/**
 * 烧录字幕：底部居中，最多两行。
 * 只在有 line 的段画 —— 图示段是"图说话"，字幕是旁白的文字版，两者必须同一句，
 * 否则观众会以为字幕在解释图里的细节。
 */
export function drawCaption(ctx, text, t, total, size, opts = {}) {
  if (!text) return { lines: 0 };
  const palette = opts.palette ?? PALETTES.paper;
  const fonts = opts.fonts ?? FONTS;
  const W = opts.width ?? 1920;
  const y = opts.y ?? FRAME.captionY;
  const maxW = opts.maxW ?? 1560;
  const s0 = size ?? FRAME.captionSize;

  // 段首 0.18s 淡入、段尾 0.18s 淡出：硬切会像另一条画面
  const a = Math.min(1, clamp(t / 0.18), clamp((total - t) / 0.18));
  if (a <= 0.01) return { lines: 0 };

  const fit = fitText(ctx, text, maxW, fonts.med, { start: s0, min: 30, maxLines: 2 });
  const lines = fit.lines;
  const lineH = fit.size * 1.34;
  const top = y - ((lines.length - 1) * lineH) / 2;

  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = `${fit.size}px ${fonts.med}`;
  ctx.textBaseline = 'middle';

  // 逐字上色：念到的墨色、刚念到的 0.35s 内偏红、没念到的压灰。
  // 不用"每个字单独 fillText"—— 逐字累加宽度会累积亚像素误差，中文间距会变成毛毛的。
  // 改成整行只排一次版，用矩形 clip 分层重绘：字形位置完全一致，只是颜色不同。
  const chars = opts.chars;
  if (Array.isArray(chars) && chars.length && Number.isFinite(opts.now)) {
    ctx.textAlign = 'left';
    let k = 0;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const y = top + i * lineH;
      const x0 = W / 2 - ctx.measureText(ln).width / 2;

      // 底：整行压灰
      ctx.globalAlpha = a * 0.34;
      ctx.fillStyle = palette.label;
      ctx.fillText(ln, x0, y);

      // 已念到的连续前缀
      let n = 0;
      for (const ch of ln) {
        const c = chars[k + n];
        if (!c || !Number.isFinite(c.at) || opts.now < c.at) break;
        n++;
      }
      if (n > 0) {
        const w = ctx.measureText(ln.slice(0, n)).width;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 - 2, y - lineH, w + 2, lineH * 1.6);
        ctx.clip();
        ctx.globalAlpha = a;
        ctx.fillStyle = palette.ink;
        ctx.fillText(ln, x0, y);
        ctx.restore();
      }

      k += ln.length;
    }
  } else {
    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'center';
    lines.forEach((ln, i) => ctx.fillText(ln, W / 2, top + i * lineH));
  }
  ctx.restore();
  return { lines: lines.length, size: fit.size, overflow: fit.overflow };
}

/**
 * 片头标题卡：不配图、不配字幕，只给片名。
 * 这支片子原本第一帧就是数据条，观众不知道在看什么；标题卡是唯一的"先说要讲什么"。
 */
export function drawTitleCard(ctx, card, t, box, opts = {}) {
  const palette = opts.palette ?? PALETTES.paper;
  const fonts = opts.fonts ?? FONTS;
  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const dur = Number(card.duration) || 1.4;

  // 0.55s 推入：片名从下往上 26px，副标题晚 0.12s。之后完全静止，留一口气。
  const p = clamp(t / 0.55);
  const e = easeOutCubic(p);
  const sub = easeOutCubic(clamp((t - 0.12) / 0.55));

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.globalAlpha = e;
  ctx.fillStyle = palette.ink;
  ctx.font = `88px ${fonts.black}`;
  ctx.fillText(card.title ?? '', W / 2, H / 2 - 34 + (1 - e) * 26);

  if (card.sub) {
    ctx.globalAlpha = sub;
    ctx.font = `30px ${fonts.reg}`;
    ctx.fillStyle = palette.label;
    ctx.fillText(card.sub, W / 2, H / 2 + 78 + (1 - sub) * 18);
  }

  // 片名下的短线：从左往右展开，给"开场"一个明确的起手式
  const lineW = 120 * e;
  ctx.globalAlpha = e;
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W / 2 - lineW / 2, H / 2 + 142);
  ctx.lineTo(W / 2 + lineW / 2, H / 2 + 142);
  ctx.stroke();
  ctx.restore();

  // 最后 0.18s 淡出，硬切到第一段会闪
  void dur;
  return { card: true };
}

/** 出片前的静态校验：不画，只判断能不能画。gate 与 validate 用它。 */
export function validateDiagram(recipe) {
  const errors = [];
  const family = recipe?.family;
  const cap = CAPACITY[family];
  if (!FAMILIES[family]) {
    errors.push({ code: 'DIAGRAM_FAMILY', message: `未知图示类型：${family}` });
    return { ok: false, errors };
  }
  const n = recipe?.items?.length ?? 0;
  if (cap && (n < cap.min || n > cap.max)) {
    errors.push({ code: 'DIAGRAM_CAPACITY', message: `${family} 需要 ${cap.min}–${cap.max} 项，实际 ${n}` });
  }
  if (!(Number(recipe?.duration) > 0)) {
    errors.push({ code: 'DIAGRAM_DURATION', message: 'duration 必须是正数' });
  }
  if (family === 'hierarchy') {
    const ids = new Set((recipe.items ?? []).map((it) => it.id));
    const roots = (recipe.items ?? []).filter((it) => !it.parent || !ids.has(it.parent));
    if (roots.length !== 1) errors.push({ code: 'DIAGRAM_STRUCTURE', message: `hierarchy 需要恰好一个根，实际 ${roots.length}` });
    const cap2 = (recipe.items ?? []).filter((it) => cap && (it.label ?? '').length > cap.label);
    if (cap2.length) errors.push({ code: 'DIAGRAM_CAPACITY', message: `节点标签超过 ${cap.label} 字：${cap2[0].label}` });
  }
  return { ok: errors.length === 0, errors };
}

export { CANVAS, FONTS, FRAME, PALETTES, CapacityError };
