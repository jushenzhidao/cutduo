#!/usr/bin/env python3
"""
把 desktop-kit 里真实用到的三条运动曲线做「系数蒸馏」：
关键帧 → 多项式 → 解析式，比字节数与最大误差。

曲线不是杜撰的，是 desktop.mjs 里逐字抄过来的：
  eo(x)   = 1 - (1-x)^3                      # easeOutCubic，翻牌/入场用
  eio(x)  = 先 4x^3 后 1-(-2x+2)^3/2          # easeInOutCubic，转场用
  bob(t)  = 1.2 * sin(2.1t + 0.02x)          # Dock 呼吸律动
"""
import json
import pathlib

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "out" / "curve-desk.json"
F32 = 4  # 每个系数 float32 占 4 字节


def eo(x):
    return 1 - np.power(1 - x, 3)


def eio(x):
    q = np.clip(x, 0, 1)
    return np.where(q < 0.5, 4 * q ** 3, 1 - np.power(-2 * q + 2, 3) / 2)


def bob(t):
    return 1.2 * np.sin(2.1 * t + 0.02 * 320)


def maxerr(fn, approx, span=(0, 1), n=4001):
    x = np.linspace(span[0], span[1], n)
    return float(np.max(np.abs(fn(x) - approx(x))))


def poly_fit(fn, deg, span=(0, 1)):
    x = np.linspace(span[0], span[1], 2000)
    c = np.polyfit(x, fn(x), deg)
    return c, (lambda z: np.polyval(c, z))


def keyframe_bytes(n=60):
    # 等距采样：每个关键帧存 (t, v) 两个 float32
    return n * 2 * F32


def main():
    curves = []

    # 1. easeOutCubic
    c3, p3 = poly_fit(eo, 3)
    c4, p4 = poly_fit(eo, 4)
    curves.append({
        "name": "eo · easeOutCubic（翻牌/入场）",
        "reps": [
            {"rep": "60 关键帧", "bytes": keyframe_bytes(), "maxErr": maxerr(eo, lambda z: np.interp(z, np.linspace(0, 1, 60), eo(np.linspace(0, 1, 60))))},
            {"rep": "三次多项式 4 系数", "bytes": 4 * F32, "maxErr": maxerr(eo, p3), "coef": [round(float(v), 6) for v in c3]},
            {"rep": "四次多项式 5 系数", "bytes": 5 * F32, "maxErr": maxerr(eo, p4), "coef": [round(float(v), 6) for v in c4]},
            {"rep": "解析式 1-(1-x)^3（2 参数）", "bytes": 2 * F32, "maxErr": 0.0},
        ],
    })

    # 2. easeInOutCubic（单段拟合 vs 分段）
    c3b, p3b = poly_fit(eio, 3)
    x = np.linspace(0, 1, 2000)
    left = x < 0.5
    cl = np.polyfit(x[left], eio(x[left]), 3)
    cr = np.polyfit(x[~left], eio(x[~left]), 3)
    piece = lambda z: np.where(z < 0.5, np.polyval(cl, z), np.polyval(cr, z))
    curves.append({
        "name": "eio · easeInOutCubic（转场）",
        "reps": [
            {"rep": "60 关键帧", "bytes": keyframe_bytes(), "maxErr": maxerr(eio, lambda z: np.interp(z, np.linspace(0, 1, 60), eio(np.linspace(0, 1, 60))))},
            {"rep": "三次多项式 4 系数（单段）", "bytes": 4 * F32, "maxErr": maxerr(eio, p3b), "coef": [round(float(v), 6) for v in c3b]},
            {"rep": "分段三次（2×4 系数 + 断点，9 参数）", "bytes": 9 * F32, "maxErr": maxerr(eio, piece)},
            {"rep": "解析式（分段立方，2 参数）", "bytes": 2 * F32, "maxErr": 0.0},
        ],
    })

    # 3. Dock 呼吸律动：正弦
    T = 6.0
    c3c, p3c = poly_fit(bob, 3, (0, T))
    curves.append({
        "name": "bob · Dock 律动（正弦）",
        "reps": [
            {"rep": "60 关键帧/周期", "bytes": keyframe_bytes(), "maxErr": maxerr(bob, lambda z: np.interp(z, np.linspace(0, T, 60), bob(np.linspace(0, T, 60))), (0, T))},
            {"rep": "三次多项式 4 系数", "bytes": 4 * F32, "maxErr": maxerr(bob, p3c, (0, T)), "coef": [round(float(v), 6) for v in c3c]},
            {"rep": "解析式 A·sin(ωt+φ)（3 参数）", "bytes": 3 * F32, "maxErr": 0.0},
        ],
    })

    payload = {"curves": curves,
               "total": {
                   "keyframe": sum(c["reps"][0]["bytes"] for c in curves),
                   "best": sum(min(r["bytes"] for r in c["reps"]) for c in curves),
               }}
    if not OUT.parent.exists():
        OUT.parent.mkdir(parents=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    for c in curves:
        print(c["name"])
        for r in c["reps"]:
            print(f"    {r['rep']:<34}{r['bytes']:>5} B   最大误差 {r['maxErr']*100:7.4f}%")
    print(f"\n合计：关键帧 {payload['total']['keyframe']} B → 最优表示 {payload['total']['best']} B "
          f"（{payload['total']['keyframe']/payload['total']['best']:.1f}×）")


if __name__ == "__main__":
    main()
