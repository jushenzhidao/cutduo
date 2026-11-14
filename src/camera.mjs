/**
 * src/camera.mjs · 段级运镜（纯函数，无 ctx 依赖，可单测）
 *
 * 为什么需要：paper / science 的画面全是「固定机位 + 元素自己生长」。短片段没问题，
 * 长片（90s+）会读成 PPT —— 不是审美问题，是结构问题：观众感知运动有两条通道
 * （物体运动、相机运动），我们只有前者，所有变化都发生在同一张平面内。
 *
 * 设计约束（决定了接口长什么样）：
 *   1. **默认关闭**。不写 `args.camera` 就是现在的样子，零回归。
 *   2. **只放大不缩小**。zoom < 1 会露出画布外的空白（段型的背景是满屏的，但只覆盖
 *      1920×1080 这块区域）。拉远用「从放大态回到 1.0」表达，而不是 zoom 到 0.9。
 *   3. **段级、不跨段**。跨段相机要处理"上一镜继续推"（huashu 的 zoomThrough live），
 *      那需要把相机提到场景之上，与本仓 `renderFrame(t)` 的段内重画模型冲突。
 *   4. **确定性**。没有任何随机量；同一个 t 永远算出同一个 z。
 *
 * 参数（与 huashu 镜头语言.md 的动作表对齐）：
 *   { "kind": "push",  "z": 1.10, "dur": 1.0 }   缓推，0.6–1.5s，推近 10–40%
 *   { "kind": "pull",  "z": 1.10, "dur": 1.1 }   拉远：从 1.10 回到 1.0
 *   { "kind": "punch", "z": 1.22, "dur": 0.28 }  快推（重音：揭晓/反转/关键数字）
 *   { "kind": "drift", "z": 1.04 }                匀速慢漂，整段走完（氛围镜）
 *   { "kind": "hold",  "z": 1.08 }                整段固定在这个倍数（配合前后段的 push/pull 用）
 *   { "kind": "cut" }                             显式关掉（等同不写）
 *   "anchor": [960, 540]                          缩放中心，缺省画面中心
 *
 * 反面标尺（huashu 实测，写进 gate 的判据）：某支 102s/44 镜的片子推近 48 次
 * （平均 2.1s 一次）、几乎不拉远，被判「一点都不 smooth」。所以门禁看的是
 * **推近次数/分钟** 与 **重音占比**，而不是"有没有推"。
 */

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const sineInOut = (p) => 0.5 - 0.5 * Math.cos(Math.PI * p);
const expoOut = (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));

/** 能被识别为"运镜"的 kind。cut 与缺省都不产生变换。 */
export const CAMERA_KINDS = ['cut', 'push', 'pull', 'punch', 'drift', 'hold'];

/** 重音动作：gate 统计「重音占镜头数 ≤ 1/3」时只数这两类。 */
export const ACCENT_KINDS = ['punch'];

/**
 * 某一段在段内时刻 lt 的相机状态。
 * @param {object} cam   段的 args.camera
 * @param {number} lt    段内已过秒数（t − t0）
 * @param {number} span  本段总长（t1 − t0）
 * @param {{w:number,h:number}} stage 画布尺寸，用于缺省 anchor
 * @returns {{z:number, ax:number, ay:number}|null}  null = 不做变换
 */
export function cameraAt(cam, lt, span, stage = {}) {
  if (!cam || typeof cam !== 'object') return null;
  const kind = String(cam.kind || 'push');
  if (kind === 'cut' || !CAMERA_KINDS.includes(kind)) return null;

  const w = Number(stage.w) || 1920;
  const h = Number(stage.h) || 1080;
  const anchor = Array.isArray(cam.anchor) && cam.anchor.length >= 2
    ? [Number(cam.anchor[0]), Number(cam.anchor[1])]
    : [w / 2, h / 2];

  const zPeak = Number(cam.z ?? (kind === 'punch' ? 1.22 : 1.10));
  // 只放大：zoom ≤ 1 会让段型的满屏背景之外露出空白（背景只画到画布边界）。
  if (!(zPeak > 1.0001)) return null;

  const total = Number(span) > 0 ? Number(span) : 0;
  const durRaw = Number(cam.dur ?? (kind === 'punch' ? 0.28 : 1.0));
  const dur = Math.max(0.04, Math.min(durRaw, total || durRaw));
  const p = clamp01(Number(lt) / dur);

  let z;
  if (kind === 'hold') {
    // 静态保持某个 zoom。没有这个 kind，一拍拆成三段时只能 push/hold/pull 里的前两段可用，
    // 中间段会掉回 1.0 —— 观众看到"推近、跳回、再拉远"。拆段结构下这是必需的。
    z = zPeak;
  } else if (kind === 'drift') {
    // 匀速走完整段：氛围镜要"画一直是活的"，不能停
    z = 1 + (zPeak - 1) * clamp01(total > 0 ? Number(lt) / total : p);
  } else if (kind === 'pull') {
    // 拉远：从放大态回到 1.0，起步快、长尾落定
    z = zPeak - (zPeak - 1) * sineInOut(p);
  } else if (kind === 'punch') {
    // 快推：0.25–0.35s 推近后**停住**（exp 曲线前快后慢，落点稳）
    z = 1 + (zPeak - 1) * expoOut(p);
  } else {
    z = 1 + (zPeak - 1) * sineInOut(p);
  }
  return { z, ax: anchor[0], ay: anchor[1] };
}

/**
 * 把相机包成一次绘制。调用方保证 fn 只画**内容层**。
 * 字幕、时间码、头像卡必须在变换之外画，否则整块 UI 会跟着缩放。
 */
export function withCamera(ctx, cam, lt, span, stage, fn) {
  const c = cameraAt(cam, lt, span, stage);
  if (!c) return fn();
  ctx.save();
  ctx.translate(c.ax, c.ay);
  ctx.scale(c.z, c.z);
  ctx.translate(-c.ax, -c.ay);
  try {
    return fn();
  } finally {
    ctx.restore();
  }
}

/**
 * 静态统计：一段片子的运镜密度。给 gate 用，不读画面。
 * 判据来自 huashu 镜头语言.md：推近 > 8 次/分钟 报黄；重音 ≤ 1/3 镜头。
 */
export function cameraStats(scenes, durationSeconds) {
  const mins = Math.max(1e-6, Number(durationSeconds) / 60);
  let push = 0, accent = 0, withCam = 0;
  for (const s of scenes || []) {
    const cam = s && s.args && s.args.camera;
    if (!cam || cam.kind === 'cut') continue;
    withCam++;
    if (cam.kind === 'push' || cam.kind === 'punch' || cam.kind === 'drift') push++;
    if (ACCENT_KINDS.includes(cam.kind)) accent++;
  }
  const n = (scenes || []).length || 1;
  return {
    shots: n,
    withCam,
    pushPerMin: +(push / mins).toFixed(2),
    accentRatio: +(accent / n).toFixed(3),
    // 两条都来自反面标尺：>8 次/分 太多；重音 >1/3 等于全篇加粗
    warn: push / mins > 8 || accent / n > 1 / 3,
  };
}
