// html-canvas/1：宿主调用 window.renderFrame(frame, inputs)，按整数帧渲染，不依赖实时时钟
const c = document.getElementById('c'), ctx = c.getContext('2d');
window.renderFrame = (frame, inputs) => {
  const t = frame / 30, W = c.width, H = c.height;
  ctx.fillStyle = inputs.background || '#0d1117'; ctx.fillRect(0, 0, W, H);
  const k = Math.min(1, t / 0.8), e = 1 - Math.pow(1 - k, 3);
  ctx.globalAlpha = e; ctx.fillStyle = inputs.accent || '#79c0ff';
  ctx.font = `700 ${Math.round(H * 0.11)}px sans-serif`;
  ctx.fillText(inputs.title || '', W * 0.08, H * 0.55 + (1 - e) * H * 0.05);
  ctx.globalAlpha = 1;
};
