// stage.js · 编排层（宿主无关）
//
// 只有五件事：时间轴 → 定位镜头 → 画场景 → 叠三类文字 → 首尾淡入淡出。
// 浏览器（main.js）与 Skia（src/webcanvas.mjs）调的是同一份，不各写一遍——
// 一旦在这里补逻辑、在宿主里再补一份，两边必然漂移（science-explainer 犯过）。
//
// 硬约束：不碰 DOM、不读文件、不建 canvas，只接收 ctx。
//
// 输入两种形态都认：
//   scenes:   [{ type, t0, t1, args }]   ← render.mjs 归一化后的形态（Skia 侧走这条）
//   segments: [{ type, dur, ... }]       ← 人写的内容稿（浏览器侧走这条）
// 文字内容单独一块 content：{ lyrics, keywords, notes } —— 对齐上游参数的三个字段。

(function (root) {
  'use strict';

  root.createStage = function (opts) {
    const ctx = opts.ctx;
    const W = opts.W;
    const H = opts.H;
    const MK = opts.MK;
    const L = opts.L;
    const clamp = MK.u.clamp;

    let state = {
      timeline: [],
      content: { lyrics: [], keywords: [], notes: [] },
      lyricStyle: null,
      fadeIn: 0.6,
      fadeOut: 0.6,
    };

    function toTimeline(inp) {
      if (Array.isArray(inp.scenes) && inp.scenes.length) {
        return inp.scenes.map((s) => ({
          type: s.type,
          t0: Number(s.t0) || 0,
          t1: Number(s.t1) || 0,
          args: s.args || s,
        }));
      }
      const segs = Array.isArray(inp.segments) ? inp.segments : [];
      let acc = 0;
      return segs.map((s) => {
        const t0 = acc;
        acc += Number(s.dur || 3);
        return { type: s.type, t0, t1: acc, args: s.args || s };
      });
    }

    function setContent(inp) {
      const src = inp || {};
      // 内容块两种写法都认：顶层 lyrics/keywords/notes（浏览器直喂），
      // 或 content: {...}（render.mjs 显式透传）。少认一种就会"有画面没歌词"。
      const pack = src.content || {};
      state = {
        timeline: toTimeline(src),
        content: {
          lyrics: pack.lyrics || src.lyrics || [],
          keywords: pack.keywords || src.keywords || [],
          notes: pack.notes || src.notes || [],
        },
        lyricStyle: src.lyricStyle || pack.lyricStyle || null,
        fadeIn: src.fadeInSeconds === undefined ? 0.6 : Number(src.fadeInSeconds),
        fadeOut: src.fadeOutSeconds === undefined ? 0.6 : Number(src.fadeOutSeconds),
      };
      return state;
    }

    function duration() {
      const tl = state.timeline;
      return tl.length ? tl[tl.length - 1].t1 : 0;
    }

    function currentLyric(t) {
      const lines = state.content.lyrics || [];
      // 倒序找：同一时刻有两条重叠时，后写的那条优先（与上游一致）
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (t >= l.s - 0.2 && t < l.e + 0.3) return l;
      }
      return null;
    }

    // 纯函数：同一 t 多次调用结果一致
    function renderFrame(t) {
      const tl = state.timeline;
      ctx.save();
      ctx.clearRect(0, 0, W, H);
      if (!tl.length) {
        ctx.restore();
        return false;
      }

      let cur = tl[tl.length - 1];
      for (const s of tl) {
        if (t >= s.t0 && t < s.t1) { cur = s; break; }
      }
      if (t < tl[0].t0) cur = tl[0];

      const localT = clamp(t - cur.t0, 0, cur.t1 - cur.t0);
      const fn = L[cur.type];
      // 未知版式不要静默出空帧：空帧是交付门禁的硬失败项
      (fn || L.street)(ctx, W, H, localT, cur.t1 - cur.t0, cur.args || {}, {
        T: MK.T,
        palette: null,
      });

      // 三类文字固定顺序：大字在底、纸条压人、歌词条最上
      const c = state.content;
      for (const w of c.keywords || []) MK.bigWord(ctx, W, H, w, t);
      for (const n of c.notes || []) MK.note(ctx, W, H, n, t);
      const lyric = currentLyric(t);
      if (lyric) MK.lyricBar(ctx, W, H, lyric, state.lyricStyle, t);

      // 首尾压黑：硬切之间靠它做"一口气"的开合
      const dur = duration();
      let dark = 0;
      // 淡入留 14% 画面：首帧若真压到全黑，交付门禁按 YMAX<24 会判黑帧（实测 1 帧就占 3%）
      if (state.fadeIn > 0 && t < state.fadeIn) dark = 0.86 * (1 - t / state.fadeIn);
      if (state.fadeOut > 0 && t > dur - state.fadeOut) {
        dark = Math.max(dark, (t - (dur - state.fadeOut)) / state.fadeOut);
      }
      if (dark > 0) {
        ctx.fillStyle = 'rgba(0,0,0,' + clamp(dark, 0, 1).toFixed(3) + ')';
        ctx.fillRect(0, 0, W, H);
      }

      ctx.restore();
      return true;
    }

    return { setContent, renderFrame, duration };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.createStage;
})(typeof window !== 'undefined' ? window : this);
