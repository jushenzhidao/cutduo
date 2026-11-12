#!/usr/bin/env python3
"""从 build-sync 产物（inputs-<p>.json + 音轨）自动生成 MotionGit 模板实例。

映射规则（与 params-v7.json 的已验证配置一致）：
  hero      → title  (slam)
  point     → keyword
  number    → number
  compare   → compare(split)
  steps     → steps  (track)
  quote     → quote  (type)
  checklist → number （checklist 只接受需要私有 beats 的用途，用 number 代替）
  outro     → outro  (thanks)

单镜头可用 args["tpl"] 覆盖默认映射：{"control": "...", "variant": "...", "props": {...}}
narrationMap 按 control 绑定用途，区间严格等于镜头 t0/t1（模板硬性要求）。

用法：
  python3 gen-tpl-params.py --inputs edits/inputs-v7.json --audio edits/audio-v7.m4a \
      --voice-label "晓晓 · 口播" --work /tmp/tpl-auto
输出：实例目录路径（含 params.json 与 inputs/），可直接交给 render-batch.py。
"""
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

TPL = pathlib.Path(__file__).resolve().parent / "templates" / "paper-perspective"
AVATAR = pathlib.Path(__file__).resolve().parent / "edits" / "assets" / "avatar.png"

PURPOSE = {
    "title": "neutral-emphasis",
    "keyword": "neutral-list",
    "number": "neutral-emphasis",
    "compare": "real-comparison",
    "steps": "ordered-process",
    "quote": "summary",
    "outro": "user-requested-action",
}


def cut(s, n):
    s = str(s).strip()
    return s[:n]


def clean_kicker(sub):
    s = re.sub(r"^//\s*", "", str(sub or ""))
    return cut(s.split("·")[0].strip(), 28) or "重点"


def map_scene(sc):
    """返回 (control, variant, props)。"""
    t, a = sc["type"], sc.get("args", {})
    if "tpl" in a:                       # 显式覆盖优先
        o = a["tpl"]
        return o.get("control", "title"), o.get("variant"), o.get("props", {})

    if t == "hero":
        lines = a.get("lines", [])
        return "title", "slam", {
            "kicker": clean_kicker(a.get("sub")),
            "line1": cut(lines[0][0], 16) if lines else "",
            "line2": cut(lines[1][0], 16) if len(lines) > 1 else "",
        }
    if t == "point":
        word = re.sub(r"\s+", "", "".join(w[0] for w in a.get("words", [])))
        return "keyword", None, {
            "kicker": "重点",
            "word": word[:10],
            "sub": [cut(c[0], 8) for c in a.get("cards", [])][:3],
        }
    if t == "number":
        note = [cut(a.get("sub", ""), 20)] if a.get("sub") else []
        return "number", None, {
            "label": cut(a.get("label", ""), 12),
            "value": int(a.get("value", 1)),
            "from": int(a.get("from", 0)),
            "unit": cut(a.get("unit", ""), 6),
            "note": note,
        }
    if t == "compare":
        def side(s):
            items = [x[0] if isinstance(x, list) else x for x in s.get("items", [])]
            return {"label": cut(s.get("title", ""), 8),
                    "big": cut(items[0] if items else "", 8),
                    "lines": [cut(x, 12) for x in items[1:3]]}
        return "compare", "split", {
            "left": side(a.get("left", {})),
            "right": side(a.get("right", {})),
            "verdict": "对比", "winner": "right",
        }
    if t == "steps":
        steps = [cut(x[0] if isinstance(x, list) else x, 14)
                 for x in a.get("steps", [])][:5]
        return "steps", "track", {"title": cut(a.get("title", ""), 18), "steps": steps}
    if t == "quote":
        text = "，".join(re.sub(r"[*]", "", l) if "*" not in l else l
                         for l in a.get("lines", []))
        return "quote", "type", {"text": cut(text, 60), "who": cut(a.get("by", ""), 24)}
    if t == "checklist":
        items = [x[0] if isinstance(x, list) else x for x in a.get("items", [])]
        return "number", None, {
            "label": cut(a.get("title", ""), 12),
            "value": len(items),
            "from": 0, "unit": "条",
            "note": [cut(x, 14) for x in items][:3],
        }
    if t == "outro":
        prompt = cut(a.get("prompt") or (a.get("lines") or [""])[0], 14)
        return "outro", "thanks", {
            "thanks": cut(a.get("title", "下期见"), 10),
            "sub": cut((a.get("lines") or [""])[0], 24),
            "items": [{"text": prompt}] if prompt else [{"text": "继续关注"}],
        }
    raise SystemExit(f"未知场景类型：{t}")


def srt_ts(sec):
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inputs", required=True, help="build-sync 产物 inputs-<p>.json")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--voice-label", default="口播")
    ap.add_argument("--work", required=True, help="新实例输出目录")
    ap.add_argument("--allow-short", action="store_true", help="跳过分镜时长预检（不推荐）")
    args = ap.parse_args()

    src = json.loads(pathlib.Path(args.inputs).read_text())
    audio = pathlib.Path(args.audio).resolve()
    assert audio.exists(), f"音轨不存在：{audio}"

    segments, caps_out = [], []
    for sc in src["scenes"]:
        control, variant, props = map_scene(sc)
        seg = {"control": control, "t0": round(sc["t0"], 3), "t1": round(sc["t1"], 3),
               "props": props}
        if variant:
            seg["variant"] = variant
        segments.append(seg)
    segments[0]["t0"] = 0.0   # 模板要求首镜从 0 开始，否则开头留黑场

    # 模板渲染阶段才校验镜长，且一错就整批失败；此处前置拦截
    MIN_SECONDS = {"compare": 4.0}
    DEFAULT_MIN = 3.0
    short = []
    for i, seg in enumerate(segments, 1):
        dur = seg["t1"] - seg["t0"]
        floor = MIN_SECONDS.get(seg["control"], DEFAULT_MIN)
        if dur < floor - 1e-6:
            short.append((i, seg["control"], dur, floor))
    if short and not args.allow_short:
        detail = "；".join(f"第{i}镜 {c} {d:.2f}s < {f:.1f}s" for i, c, d, f in short)
        raise SystemExit(
            f"分镜时长不满足模板硬约束：{detail}\n"
            f"请用 build-sync.py --scene-min '{{\"compare\":4.2}}' 重出时间轴后再生成"
        )

    for i, c in enumerate(src.get("captions", []), 1):
        caps_out.append({"s": round(c["start"], 3), "e": round(c["end"], 3), "text": c["text"]})

    narration = [{
        "subtitleId": i + 1,
        "start": s["t0"], "end": s["t1"],
        "spokenText": caps_out[i]["text"],
        "purpose": PURPOSE[s["control"]],
    } for i, s in enumerate(segments)]

    timeline = {
        "layout": "landscape",
        "duration": round(src["durationSeconds"], 3),
        "voiceover": "voiceover.m4a",
        "subtitles": "captions.srt",
        "music": "",
        "styleProfile": "paper",
        "ending": "cut",
        "captions": caps_out,
        "segments": segments,
        "narrationMap": narration,
    }
    if AVATAR.exists():
        timeline["presenter"] = {"src": "avatar.png", "badge": cut(args.voice_label, 12),
                                 "audio": "mute"}
    params = {"workflow": "motion-kit", "timeline": timeline}

    # 建实例
    out = subprocess.run(["node", str(TPL / "tools" / "motion.mjs"), "new",
                          str(TPL / "template.motion")],
                         capture_output=True, text=True, check=True)
    inst = pathlib.Path(json.loads(out.stdout)["instanceDirectory"])
    if pathlib.Path(args.work).exists():
        shutil.rmtree(args.work)
    shutil.copytree(inst, args.work, symlinks=True)
    work = pathlib.Path(args.work)
    shutil.rmtree(work / "plan", ignore_errors=True)
    shutil.rmtree(work / "project", ignore_errors=True)
    for f in ("video.mp4", "video-v2.mp4"):
        (work / f).unlink(missing_ok=True)

    (work / "inputs").mkdir(exist_ok=True)
    shutil.copy(audio, work / "inputs" / "voiceover.m4a")
    shutil.copy(AVATAR, work / "inputs" / "avatar.png") if AVATAR.exists() else None
    srt = []
    for i, c in enumerate(caps_out, 1):
        srt += [str(i), f"{srt_ts(c['s'])} --> {srt_ts(c['e'])}", c["text"], ""]
    (work / "inputs" / "captions.srt").write_text("\n".join(srt), encoding="utf-8")
    (work / "params.json").write_text(json.dumps(params, ensure_ascii=False, indent=2))

    print(json.dumps({
        "instance": str(work),
        "duration": timeline["duration"],
        "segments": [(s["control"], s["t0"], s["t1"]) for s in segments],
        "captions": len(caps_out),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
