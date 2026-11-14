/**
 * src/determinism.mjs · 确定性检查（可复用于任何"按 t 重画"的渲染器）
 *
 * 从 render.mjs 抽出来，因为 desk / mg 是两个独立入口，各自有 renderFrame，
 * 复制三份检查逻辑迟早会漂。调用方只需要提供一个 `(t) => void` 的 renderer
 * 和一个已绑定好的 ctx。
 */
/**
 * 确定性检查：同一时刻渲两次，必须逐像素相同。
 *
 * 为什么要单独查：`renderFrame(t)` 只重画、不重置 ctx。任何一处漏写
 * `ctx.globalAlpha = 1` / `setLineDash([])` / `lineJoin`，状态就会漏到下一帧。
 * 这类缺陷**按时间顺序出片看不出来**，单独出静帧又是对的——所以出片后肉眼验收发现不了。
 * （同源实现见 dashi-animationstyle 的 render.mjs --check-determinism；它的受害名单是
 *  立体卡通、黑底科技、复古报刊三套模板。）
 *
 * 做法：渲 t → 快照 A → 跳到靠近片尾的远处 → 回到 t → 快照 B，逐像素比较。
 * A≠B 说明这一帧的画面取决于「之前画过什么」，而不是只取决于 t。
 */
export function determinismTimes(spec, duration) {
  if (!spec || spec === 'auto') return [0.25, 0.5, 0.75].map((f) => +(duration * f).toFixed(3));
  const t = String(spec).split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x >= 0);
  return t.length ? t : [0.25, 0.5, 0.75].map((f) => +(duration * f).toFixed(3));
}

export function checkDeterminism({ renderer, ctx, width, height, duration, spec, label }) {
  const snap = () => ctx.getImageData(0, 0, width, height).data;
  const cmp = (a, b) => {
    let n = 0, max = 0, first = -1;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1])
        + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]);
      if (d) { if (first < 0) first = i >> 2; n++; if (d > max) max = d; }
    }
    return { n, max, first };
  };
  const times = determinismTimes(spec, duration);
  const far = +(duration * 0.97).toFixed(3);
  const rows = [];
  let bad = 0;
  for (const t of times) {
    const tt = +Number(t).toFixed(3);
    renderer.renderFrame(tt);
    const A = snap();
    // 中间这一跳要足够远、且不能等于 tt 本身（片长 97% 恰好等于 tt 时等于没跳）
    renderer.renderFrame(Math.abs(far - tt) < 0.5 ? +(duration * 0.5).toFixed(3) : far);
    renderer.renderFrame(0.017);
    renderer.renderFrame(tt);
    const B = snap();
    const d = cmp(A, B);
    if (d.n) bad++;
    rows.push({ t: tt, ...d, x: d.first >= 0 ? d.first % width : -1, y: d.first >= 0 ? Math.floor(d.first / width) : -1 });
  }
  const total = width * height;
  console.log(`\n确定性检查 · ${label}`);
  console.log('─'.repeat(64));
  for (const r of rows) {
    if (!r.n) { console.log(`  t=${String(r.t).padEnd(8)} 一致`); continue; }
    const pct = (r.n / total * 100).toFixed(2);
    console.log(`  t=${String(r.t).padEnd(8)} 不一致 ${r.n} px (${pct}%)，最差 Δ=${r.max}，首处 (${r.x}, ${r.y})`);
  }
  console.log('─'.repeat(64));
  if (!bad) {
    console.log(`全部一致（${rows.length} 个时刻）——帧内容只由 t 决定\n`);
    return 0;
  }
  console.log(
    `RESULT: FAIL (${bad}/${rows.length}) — 帧内容与绘制顺序相关，即 ctx 状态漏到了下一帧。\n` +
    '  逐项排查：globalAlpha / shadowBlur / setLineDash / lineWidth / lineJoin / lineCap\n' +
    '            / textAlign / textBaseline / globalCompositeOperation / clip 未 save-restore。\n' +
    '  修法：renderFrame 开头统一 resetCtx()，或每帧 ctx.save()→画→ctx.restore()。\n'
  );
  return 2;
}
