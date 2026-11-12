/* 参数驱动分镜（本期改造）
 * 宿主在页面加载前注入 window.MOTION_INPUTS（来自已校验的 inputs.json）。
 * 每个 scene = { type, t0, t1, args }；args 原样传给上游 TPL.<type>。
 * 上游原版工作流是「每集手改 scenes.js」；这里改成改 JSON 即可重剪。
 * 时间一律是全片绝对秒数，*文字* 会渲染成强调色。
 */
(function () {
  const inp = window.MOTION_INPUTS || {};
  const list = Array.isArray(inp.scenes) ? inp.scenes : [];
  const end = Number(inp.durationSeconds) || 28;

  window.END = end;
  CONFIG.end = end;
  CONFIG.fps = Number(inp.fps) || 24;
  CONFIG.subtitles = false;                 // 本期无字幕数据，不生成空字幕层
  CONFIG.race = { labels: [], keys: [] };  // 关闭上游内置赛道线，时间线由 inputs 决定
  CONFIG.brand = inp.brand || CONFIG.brand;
  CONFIG.account = inp.brand || CONFIG.account;
  if (inp.accent) document.documentElement.style.setProperty('--blue', inp.accent);
  if (inp.accent2) document.documentElement.style.setProperty('--blue2', inp.accent2);

  for (const s of list) {
    const fn = TPL[s.type];
    if (typeof fn !== 'function') { console.warn('未知场景类型：' + s.type); continue; }
    const args = Object.assign({}, s.args || {});
    args.t0 = Number(s.t0);
    args.t1 = Number(s.t1);
    args.cam = 'none';   // 本期无真人/录屏素材，统一关闭口播卡，避免占位图
    fn(args);
  }

  // 字幕层：独立于 #world（不受镜头 transform 影响），由 bridge.js 每帧按 t 切换文本
  const cues = Array.isArray(inp.captions) ? inp.captions : [];
  if (cues.length) {
    window.__MG_CAPTIONS = cues;
    const stage = document.getElementById('stage');
    const box = document.createElement('div');
    box.id = 'mg-caption';
    box.style.cssText = 'position:absolute;left:0;right:0;bottom:42px;text-align:center;'
      + 'z-index:99;pointer-events:none;opacity:0';
    const span = document.createElement('span');
    span.style.cssText = 'display:inline-block;max-width:1500px;white-space:normal;'
      + 'background:rgba(16,20,34,.90);border:1px solid rgba(255,255,255,.14);'
      + 'color:#fff;padding:10px 26px;border-radius:12px;'
      + 'font:600 36px/1.45 -apple-system,"PingFang SC",sans-serif;letter-spacing:.5px;'
      + 'box-shadow:0 8px 30px rgba(0,0,0,.4)';
    box.appendChild(span);
    stage.appendChild(box);
  }
})();
