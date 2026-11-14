#!/usr/bin/env python3
"""tools/esfx-render.py · earshot 音效批量渲染器（cutduo 侧适配层）

为什么批量：earshot 单次 CLI 调用 3.58s（CLI 包装占大头），17 条 cues 就是 60s。
同一进程 import 只要 0.25s，17 条连续渲 9s。所以一次进程渲全部缺的。

缓存：每个音效写 `<out>.wav` + `<out>.wav.json`（存 onset/peak/end/dur）。
两者都在 = 命中，不重渲。参数变化会改 out 路径（key 由调用方算），所以不需要额外校验。

输出（stdout 一行 JSON）：
  {"ok": true, "items": [{"id","file","onset_s","peak_s","end_s","dur_s","cached"}]}

失败不抛栈：{"ok": false, "error": "...", "items": [...]}，调用方据此降级。
"""
import argparse
import json
import os
import sys
import tempfile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True, help="JSON 文件：{items:[{id,out,dur,apex,pitch,seed,peak_db}]}")
    ap.add_argument("--threads", type=int, default=None)
    a = ap.parse_args()

    try:
        spec = json.load(open(a.spec, encoding="utf-8"))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"spec 读取失败: {e}", "items": []}))
        return 1

    if a.threads:
        os.environ["EARSHOT_THREADS"] = str(a.threads)

    try:
        from earshot.forge.sfx import sfx_render
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"earshot 不可用: {type(e).__name__}: {e}", "items": []}))
        return 2

    items, errors = [], []
    for it in spec.get("items", []):
        sid, out = it.get("id"), it.get("out")
        meta_path = out + ".json"
        if os.path.exists(out) and os.path.exists(meta_path):
            try:
                m = json.load(open(meta_path, encoding="utf-8"))
                items.append({**m, "file": out, "cached": True})
                continue
            except Exception:
                pass  # 元数据坏了，重渲
        try:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            fd, tmp = tempfile.mkstemp(suffix=".wav", dir=os.path.dirname(out))
            os.close(fd)
            r = sfx_render(
                sid, out=tmp,
                seed=it.get("seed"), dur=it.get("dur"), apex=it.get("apex"),
                pitch=it.get("pitch"), peak_db=it.get("peak_db", -1.0),
            )
            os.replace(tmp, out)          # 原子落盘，避免并发读到半个文件
            m = r["meta"]
            rec = {
                "id": m["id"], "onset_s": m["onset_s"], "peak_s": m["peak_s"],
                "end_s": m["end_s"], "dur_s": m["dur_s"], "seed": m.get("seed"),
                "peak_db": m.get("peak_db"),
                # earshot 的 checks 是 warning 级（尾部截断、音高爬升等），不是渲染失败。
                # 存原话而不是布尔：调用方要能看出"为什么没过"。
                "checks_ok": (m.get("checks") or {}).get("ok"),
                "checks_summary": (m.get("checks") or {}).get("summary"),
            }
            json.dump(rec, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False)
            items.append({**rec, "file": out, "cached": False})
        except Exception as e:
            errors.append({"id": sid, "error": f"{type(e).__name__}: {e}"})

    print(json.dumps({"ok": not errors, "items": items, "errors": errors}, ensure_ascii=False))
    return 0 if not errors else 3


if __name__ == "__main__":
    sys.exit(main())
