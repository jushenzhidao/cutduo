/* html-canvas/1 宿主桥接：上游模板引擎暴露 renderAt(t)，t 为秒。
 * MotionGit 规范要求 window.renderFrame(frame, inputs) 或 legacy window.seek(t, inputs)；
 * 这里实现 legacy 接口，把整数帧换算出的秒传给 renderAt，画面仍是 frame 的纯函数。
 */
window.seek = function (t, inputs) {
  const end = window.END || CONFIG.end;
  const tt = Math.max(0, Math.min(Number(t) || 0, end - 0.001));
  window.renderAt(tt);

  // 字幕：按全片绝对秒数切换，和分段旁白、分镜共用同一条时间轴
  const box = document.getElementById('mg-caption');
  if (!box) return;
  const cues = window.__MG_CAPTIONS || [];
  let text = '';
  for (const c of cues) {
    if (tt >= c.start && tt < c.end) { text = c.text; break; }
  }
  const span = box.firstElementChild;
  if (span.textContent !== text) span.textContent = text;
  box.style.opacity = text ? '1' : '0';
};
