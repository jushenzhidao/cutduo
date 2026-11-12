#!/usr/bin/env python3
"""7.1 曲线系数蒸馏：把一条 motion 曲线压成「关键帧 / 多项式 / 弹簧解析解」，比数据量与保真度。

用法：uv run --with numpy --with scipy python desktop-kit/tools/curve-fit.py
输出：out/curve-fit.json + 屏幕表格；并顺带生成 7.2 的 flow map / noise 纹理（raw RGBA）。
"""
import json
import pathlib

import numpy as np
from scipy.optimize import curve_fit

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "out"
if not OUT.exists():
    OUT.mkdir()

N = 60
t = np.linspace(0, 1, N)


def ease_out_cubic(x):
    return 1 - (1 - x) ** 3


def spring(x):
    # 归一化到 1 的欠阻尼弹簧：用于通知/卡片滑入的回弹
    return 1 - np.exp(-6 * x) * np.cos(12 * x)


CURVES = {
    "easeOutCubic（翻牌/入场）": ease_out_cubic(t),
    "spring（通知滑入回弹）": spring(t),
}


def eval_cost(fn, n=20000):
    """纯 Python 标量求值耗时（模拟逐帧调用），返回 µs/次。"""
    import time
    xs = np.linspace(0, 1, n)
    t0 = time.perf_counter()
    for x in xs:
        fn(float(x))
    return (time.perf_counter() - t0) / n * 1e6


def stats(y, yh):
    e = np.abs(y - yh)
    return float(e.max()), float(np.sqrt((e ** 2).mean()))


rows = []
for name, y in CURVES.items():
    # 1) 关键帧数组：N 点线性插值
    err_kf = stats(y, np.interp(t, t, y))
    rows.append(dict(curve=name, method="关键帧数组（60 点线性插值）", params=N,
                     bytes=N * 4, maxErr=err_kf[0], rmse=err_kf[1],
                     evalUs=0.0, note="运行时查表+线性插值"))

    # 2) 三次多项式
    c = np.polyfit(t, y, 3)
    yh = np.polyval(c, t)
    e = stats(y, yh)
    rows.append(dict(curve=name, method="三次多项式（4 系数）", params=4, bytes=16,
                     maxErr=e[0], rmse=e[1],
                     evalUs=eval_cost(lambda x: c[0] * x ** 3 + c[1] * x ** 2 + c[2] * x + c[3]),
                     note=f"系数 {np.round(c, 3).tolist()}"))

    # 3) 弹簧解析解 A - B·e^(-λt)·cos(ωt+φ)
    try:
        popt, _ = curve_fit(
            lambda x, A, B, lam, om, ph: A - B * np.exp(-lam * x) * np.cos(om * x + ph),
            t, y, p0=[1, 1, 6, 12, 0], maxfev=20000)
        yh = popt[0] - popt[1] * np.exp(-popt[2] * t) * np.cos(popt[3] * t + popt[4])
        e = stats(y, yh)
        rows.append(dict(curve=name, method="弹簧解析解（A,B,λ,ω,φ）", params=5, bytes=20,
                         maxErr=e[0], rmse=e[1],
                         evalUs=eval_cost(lambda x: popt[0] - popt[1] * np.exp(-popt[2] * x) * np.cos(popt[3] * x + popt[4])),
                         note=f"A={popt[0]:.2f} B={popt[1]:.2f} λ={popt[2]:.2f} ω={popt[3]:.2f} φ={popt[4]:.2f}"))
    except Exception as ex:  # noqa: BLE001
        rows.append(dict(curve=name, method="弹簧解析解", params=5, bytes=20,
                         maxErr=9, rmse=9, evalUs=0, note=f"拟合失败 {ex}"))

print(f"{'曲线':<26}{'表示':<28}{'参数':>4}{'体积':>7}{'最大误差':>9}{'RMSE':>8}{'求值 µs':>9}")
for r in rows:
    print(f"{r['curve']:<26}{r['method']:<28}{r['params']:>4}{r['bytes']:>6}B{r['maxErr']:>9.4f}{r['rmse']:>8.4f}{r['evalUs']:>9.3f}")

(OUT / "curve-fit.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))

# ── 7.2 素材：256×256 flow map（RGBA，r/g 存方向，b 存强度）与噪声纹理 ──
S = 256
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
u, v = xx / S, yy / S
# 两股涡旋 + 一层整体右向流，方向编码到 0..1
# 多涡旋叠加（curl 场）：规则 cos 网格会在平流后留下方块状流动伪影
rng_f = np.random.default_rng(3)
fx = np.zeros((S, S), np.float32)
fy = np.zeros((S, S), np.float32)
for _ in range(9):
    cx, cy = rng_f.random(2)
    strength = rng_f.uniform(-1.2, 1.2)
    rad = rng_f.uniform(0.12, 0.30)
    dx, dy = u - cx, v - cy
    r = np.sqrt(dx * dx + dy * dy) + 1e-4
    fall = np.exp(-(r * r) / (2 * rad * rad))
    fx += (-dy / r) * strength * fall
    fy += (dx / r) * strength * fall
fx += 0.25                                   # 一点整体流向，避免纯环流
scale = max(np.abs(fx).max(), np.abs(fy).max(), 1e-6)
fx, fy = fx / scale, fy / scale
mag = np.clip(np.hypot(fx, fy), 0, 1)
flow = np.zeros((S, S, 4), np.uint8)
flow[..., 0] = np.clip((fx * 0.5 + 0.5) * 255, 0, 255)
flow[..., 1] = np.clip((fy * 0.5 + 0.5) * 255, 0, 255)
flow[..., 2] = np.clip(mag * 255, 0, 255)
flow[..., 3] = 255
(OUT / "flow-256.rgba").write_bytes(flow.tobytes())

def fbm(size, seed, octaves=5):
    """多倍频 value noise：纯随机点放大后是细碎拉丝，fBm 才有流体的团块感。"""
    rng = np.random.default_rng(seed)
    out = np.zeros((size, size), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        n = 2 ** (o + 3)   # 基频从 8 起：4×4 的最底层会在画面留下可见的方格子
        g = rng.random((n, n)).astype(np.float32)
        idx = np.linspace(0, n - 1, size)
        i0 = np.floor(idx).astype(int)
        i1 = (i0 + 1) % n                 # wrap：最后一格插回第一格，保证纹理可无缝平铺
        f = (idx - i0).astype(np.float32)
        f = f * f * (3 - 2 * f)           # smoothstep：线性插值会在网格边界留下方块
        rows = g[i0] * (1 - f)[:, None] + g[i1] * f[:, None]
        grid = rows[:, i0] * (1 - f)[None, :] + rows[:, i1] * f[None, :]
        out += grid * amp
        total += amp
        amp *= 0.55
    return out / total


nb = fbm(S, 7)
noise = np.zeros((S, S, 4), np.uint8)
noise[..., 0] = np.clip(nb * 255, 0, 255)
noise[..., 1] = np.clip(fbm(S, 11) * 255, 0, 255)
noise[..., 2] = np.clip(fbm(S, 13) * 255, 0, 255)
noise[..., 3] = 255
(OUT / "noise-256.rgba").write_bytes(noise.tobytes())
print(f"\n✓ out/curve-fit.json  ·  out/flow-256.rgba ({S}²)  ·  out/noise-256.rgba ({S}²)")
