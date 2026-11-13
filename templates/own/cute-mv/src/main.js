/* main.js — 浏览器宿主薄壳（只做三件事：取 canvas、建 stage、暴露 renderFrame）
 *
 * 编排逻辑全在 stage.js（与 Skia 宿主共用同一份），这里不许再写时间轴/字幕/淡出。
 * 一旦在这里补逻辑，Skia 侧就会缺一块 —— 这是 science-explainer 犯过的错。
 */
(function () {
  'use strict';

  const cvs = document.getElementById('c');
  const ctx = cvs.getContext('2d');

  const stage = window.createStage({
    ctx,
    W: cvs.width,
    H: cvs.height,
    MK: window.MK,
    L: window.L,
  });

  // 宿主约定：注入 window.MOTION_INPUTS，每帧调用 renderFrame(frame, inputs)
  window.renderFrame = function (frame, inputs) {
    const inp = Object.assign({}, window.MOTION_INPUTS || {}, inputs || {});
    stage.setContent(inp);
    const fps = Number(inp.fps || window.__FPS || 30);
    stage.renderFrame(frame / fps);
    return true;
  };

  window.__motionInfo = function () {
    const inp = window.MOTION_INPUTS || {};
    return {
      segments: (inp.segments || []).length,
      total: stage.duration(),
      fps: Number(inp.fps || window.__FPS || 30),
      size: [cvs.width, cvs.height],
    };
  };
})();
