#!/usr/bin/env python3
"""用 P0 的 21 条脏素材回归服务内归一化引擎。

不是复用 cutproof/ingest.py 的结果，而是真的把素材喂进 renderd 的
Normalizer.precheck / run，再做 4 条完整服务链路（提交→worker→receipt）。
语料覆盖的是故障模式，跑通它才敢说「归一化接进服务了」。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from renderd import ingest as ING                       # noqa: E402
from renderd.config import load_config                   # noqa: E402
from renderd.errors import JobError                      # noqa: E402
from renderd.runner import Runner, _probe_assets          # noqa: E402
from renderd.service import Service                       # noqa: E402
from renderd.worker import Worker                         # noqa: E402

CORPUS = ROOT.parent / "cutproof" / "corpus" / "assets"
OUT = ROOT / "var" / "ingest_regression"
EXPECT_BLOCK = {"c08_zero_bytes", "c09_truncated", "c19_audio_only"}


def make_ir(uri: str, name: str) -> dict:
    return {
        "ir_version": "0.1", "id": f"corpus_{name}",
        "output": {
            "width": 540, "height": 960,
            "fps": {"num": 30, "den": 1}, "duration_frames": 60,
            "video": {"codec": "h264", "bitrate_kbps": 3000,
                      "pix_fmt": "yuv420p", "preset": "veryfast", "gop_frames": 30},
            "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2,
                      "bitrate_kbps": 128, "target_lufs": -14},
            "color": {"primaries": "bt709", "transfer": "bt709",
                      "matrix": "bt709", "range": "tv"},
        },
        "styles": {"s": {
            "font_family": "Hiragino Sans GB", "font_size": 48,
            "fill": "#FFFFFF", "stroke": "#000000", "align": "center",
            "anchor": "bottom", "max_chars_per_line": 8,
            "safe_area": {"top": 0.08, "bottom": 0.12, "left": 0.06, "right": 0.06},
        }},
        "assets": [{"id": "a0", "uri": uri}],
        "tracks": [
            {"id": "v", "kind": "video", "clips": [
                {"asset": "a0", "at_frame": 0, "out_frame": 60,
                 "in_frame": 0, "fit": "cover"}]},
            {"id": "t", "kind": "text", "clips": [
                {"at_frame": 0, "out_frame": 60, "text": "归一化", "style": "s"}]},
        ],
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    cfg = load_config(OUT / "data")
    cfg.allow_arbitrary_paths = True
    svc = Service(cfg)
    svc.ensure_tenant("corpus", monthly_minutes=10000, qps=1000)
    norm = svc.runner.normalizer

    files = sorted(p for p in CORPUS.glob("*")
                   if p.is_file() and not p.name.startswith("_"))
    if not files:
        print(f"语料目录为空: {CORPUS}")
        return 1
    print(f"语料 {len(files)} 条 → 服务内归一化引擎\n")

    rows = []
    for p in files:
        name = p.stem
        uri = "file://" + str(p.resolve())
        ir = make_ir(uri, name)
        row = {"id": name, "file": p.name, "bytes": p.stat().st_size}
        try:
            media, info = _probe_assets(ir, cfg)
            pre = norm.precheck(ir, media)
            row["precheck"] = pre
            _media2, report, info2 = norm.run(ir, media, info)
            r = report["assets"]["a0"]
            row.update({
                "flags": r["flags"], "actions": r["actions"],
                "warnings": r["warnings"], "post": r["post"],
                "passthrough": r["passthrough"], "digest": report["digest"],
                "normalized": True,
            })
        except JobError as e:
            row.update({"normalized": False, "error": e.code,
                        "message": e.message[:120]})
        except Exception as e:
            row.update({"normalized": False, "error": "E_INTERNAL",
                        "message": f"{type(e).__name__}: {e}"[:200]})
        rows.append(row)
        flag = "BLOCK" if not row["normalized"] else "OK"
        acts = ",".join(row.get("actions", []))[:52]
        print(f"  {name:22} {flag:5} {row.get('error') or acts:54} "
              f"{len(row.get('warnings', []))}w")

    (OUT / "matrix.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n")

    # ── 断言 ──
    blocked = {r["id"] for r in rows if not r["normalized"]}
    ok = True

    def check(cond: bool, label: str) -> None:
        nonlocal ok
        print(f"  {'PASS' if cond else 'FAIL'}  {label}")
        ok = ok and cond

    print("\n── 断言 ──")
    check(blocked == EXPECT_BLOCK,
          f"恰好 3 条硬失败：{sorted(blocked)}")
    check(all(r.get("post") for r in rows if r["normalized"]),
          "归一化成功的素材都有 post 规格")
    hdr = next((r for r in rows if r["id"] == "c01_hlg_hdr"), {})
    check("TONEMAP_HDR" in hdr.get("actions", []), "HLG HDR 触发 tone mapping")
    check(hdr.get("post", {}).get("color_space") == "bt709",
          "HDR 产物色彩标记为 bt709")
    rot = next((r for r in rows if r["id"] == "c03_rotated_mov"), {})
    check("BAKE_ROTATION" in rot.get("actions", []), "旋转矩阵被烤进画面")
    odd = next((r for r in rows if r["id"] == "c20_odd_res"), {})
    check("FIX_ODD" in odd.get("actions", []) and
          (odd.get("post", {}).get("width") or 1) % 2 == 0,
          "奇数分辨率用 crop 偶数化")
    check(all(r.get("post", {}).get("audio_channels") == 2
               for r in rows if r["normalized"]),
          "所有产物音轨统一为 48k 立体声")
    check(all(r.get("post", {}).get("fps") == 30
               for r in rows if r["normalized"]),
          "所有产物帧率对齐到时间线 30fps")

    # ── 4 条走完整服务链路 ──
    print("\n── 端到端（提交 → worker → receipt）──")
    picks = ["c01_hlg_hdr", "c03_rotated_mov", "c11_pillarbox", "c20_odd_res"]
    e2e = []
    for name in picks:
        p = next(x for x in files if x.stem == name)
        ir = make_ir("file://" + str(p.resolve()), "e2e_" + name)
        payload = {"ir": ir, "idempotency_key": f"corpus-e2e-{name}"}
        t0 = time.time()
        try:
            sub = svc.submit(payload, "corpus")
            Worker(cfg, svc.store, svc.runner, name="w-corpus").run_once()
            j = svc.store.get(sub["job_id"])
            rec = json.loads(j["receipt_json"]) if j and j["receipt_json"] else {}
            verdict = rec.get("verdict")
            l0 = rec.get("L0_ingest", {})
            row = {"id": name, "status": j["status"] if j else "?",
                   "verdict": verdict, "elapsed_s": round(time.time() - t0, 2),
                   "l0_assets": list((l0.get("assets") or {}).keys()),
                   "warnings": rec.get("warnings", [])[:3]}
            e2e.append(row)
            good = j and j["status"] == "succeeded" and verdict == "pass" \
                and bool(l0.get("assets"))
            check(bool(good), f"{name}: {row['status']} / {verdict} / "
                              f"L0={row['l0_assets']}")
        except Exception as exc:
            e2e.append({"id": name, "error": f"{type(exc).__name__}: {exc}"[:200]})
            check(False, f"{name}: 抛异常 {exc}")

    (OUT / "e2e.json").write_text(json.dumps(e2e, ensure_ascii=False, indent=2) + "\n")
    print(f"\n矩阵 → {OUT / 'matrix.json'}")
    print(f"E2E  → {OUT / 'e2e.json'}")
    print("结果:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
