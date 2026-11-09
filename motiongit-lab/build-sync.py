#!/usr/bin/env python3
"""把旁白逐句合成，按每句真实时长重排分镜时间轴，产出音画同步版本。

TTS 可选 edge-tts 神经音色（默认）或 macOS say。
产出（以 --prefix 命名）：
  edits/inputs-<prefix>.json
  edits/audio-<prefix>.m4a
  edits/captions-<prefix>.srt
  edits/sync-plan-<prefix>.json

用法:
  python3 build-sync.py --prefix v4 --voice zh-CN-YunxiNeural --rate +5%
  python3 build-sync.py --tts say --prefix v3
"""
import argparse
import copy
import hashlib
import json
import pathlib
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
TMP = pathlib.Path("/tmp/mg-sync")
if not TMP.exists():
    TMP.mkdir(parents=True)
PAD = 0.5           # 每句之后留给画面出场/转场的空档
TTS_CACHE = ROOT / "edits" / "tts-cache"
if not TTS_CACHE.exists():
    TTS_CACHE.mkdir(parents=True)

VOICE_LABELS = {
    "zh-CN-YunxiNeural": "云希",
    "zh-CN-XiaoxiaoNeural": "晓晓",
    "zh-CN-XiaoyiNeural": "晓伊",
    "zh-CN-liaoning-XiaobeiNeural": "小北（东北话）",
    "zh-CN-shaanxi-XiaoniNeural": "小妮（陕西话）",
    "zh-CN-YunjianNeural": "云健",
    "zh-CN-YunyangNeural": "云扬",
    "zh-CN-YunxiaNeural": "云夏",
}

VOICES = [
    "先讲清楚，再讲漂亮。一条视频，一个问题。",
    "别堆信息，先搭结构：结论、证据、例子。",
    "一页只讲一个观点。",
    "堆信息听完就忘，搭结构能复述。",
    "四步骨架：抛问题、给结论、摆证据、收行动。",
    "记住的不是信息量，是结构。",
    "发布前三问：说得清吗，证据够吗，能照做吗。",
    "改一份文案，就能再做一期。",
]


def probe(path):
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nk=1:nw=1", str(path)],
        capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def srt_time(sec):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def synth(text, i, tts, voice, rate, say_rate=195):
    """返回合成出的音频路径（edge→mp3，say→aiff）。"""
    ext = "mp3" if tts == "edge" else "aiff"
    out = TMP / f"seg{i}.{ext}"
    if out.exists():
        out.unlink()
    if tts == "say":
        subprocess.run(["say", "-v", "Tingting", "-r", str(say_rate), "-o", str(out), text], check=True)
        return out
    last = None
    for _ in range(3):
        try:
            r = subprocess.run(
                ["edge-tts", "--voice", voice, "--rate", rate,
                 "--text", text, "--write-media", str(out)],
                capture_output=True, text=True, timeout=40)
        except subprocess.TimeoutExpired:
            last = "timeout"
            time.sleep(1.5)
            continue
        if r.returncode == 0 and out.exists() and out.stat().st_size > 1000:
            return out
        last = r.stderr.strip()[-300:]
        time.sleep(1.5)
    raise SystemExit("edge-tts 合成失败: " + (last or "unknown"))


def synth_cached(text, i, tts, voice, rate):
    """同一句 + 同一音色/语速命中缓存，迭代时只重合成改动句。"""
    key = hashlib.sha1(f"{tts}|{voice}|{rate}|{text}".encode()).hexdigest()[:16]
    ext = "mp3" if tts == "edge" else "aiff"
    cached = TTS_CACHE / f"{key}.{ext}"
    if cached.exists() and cached.stat().st_size > 1000:
        return cached
    out = synth(text, i, tts, voice, rate)
    shutil.copy(out, cached)
    return cached


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tts", choices=["edge", "say"], default="edge")
    ap.add_argument("--voice", default="zh-CN-YunxiNeural")
    ap.add_argument("--rate", default="+5%", help="edge-tts 语速，如 +5% / -3%")
    ap.add_argument("--prefix", default="v4")
    ap.add_argument("--pad", type=float, default=PAD)
    ap.add_argument("--voices", default=None, help="JSON 数组文件：每段一句旁白，覆盖内置 VOICES")
    ap.add_argument("--scenes", default="edits/inputs-v2.json", help="分镜来源（只读其 scenes 数组）")
    ap.add_argument("--tts-jobs", type=int, default=4, help="TTS 并发数（默认 4）")
    args = ap.parse_args()
    voices = json.loads(pathlib.Path(args.voices).read_text()) if args.voices else VOICES
    v2 = json.loads((ROOT / args.scenes).read_text())
    scenes = v2["scenes"]
    assert len(scenes) == len(voices), "分镜数与旁白句数必须一致"

    # 1) 逐句 TTS（并发 + 缓存），测真实时长
    t_tts = time.time()
    with ThreadPoolExecutor(max_workers=max(1, args.tts_jobs)) as ex:
        audio_files = list(ex.map(
            lambda it: synth_cached(it[1], it[0], args.tts, args.voice, args.rate),
            enumerate(voices)))
    durations = [probe(f) for f in audio_files]
    who = args.voice if args.tts == "edge" else "Tingting (say)"
    print(f"TTS: {args.tts} / {who} / rate {args.rate} / {args.tts_jobs} 并发 / 耗时 {time.time()-t_tts:.2f}s")
    print("旁白分段时长:", ", ".join(f"{d:.2f}s" for d in durations))

    # 2) 时间轴：每段长度 = 该句时长 + 空档
    starts, lengths = [], []
    cursor = 0.35  # 片头留一点呼吸
    for i, d in enumerate(durations):
        L = d + (args.pad + 0.15 if i in (0, len(voices) - 1) else args.pad)
        starts.append(round(cursor, 3))
        lengths.append(round(L, 3))
        cursor += L
    total = round(cursor, 3)
    print("总片长:", total, "s")

    # 3) 分镜时间轴与内部锚点按比例重映射
    def conv(x, old0, new0, scale):
        return round(new0 + (x - old0) * scale, 3)

    new_scenes, captions = [], []
    for i, (sc, dur, t0, L) in enumerate(zip(scenes, durations, starts, lengths)):
        old0, old1 = sc["t0"], sc["t1"]
        scale = L / (old1 - old0)
        a = copy.deepcopy(sc["args"])
        typ = sc["type"]
        c = lambda x: conv(x, old0, t0, scale)
        if typ == "hero":
            for pair in a["lines"]:
                pair[1] = c(pair[1])
        elif typ == "point":
            for pair in a["words"]:
                pair[1] = c(pair[1])
            for pair in a["cards"]:
                pair[1] = c(pair[1])
        elif typ == "number":
            a["at"] = c(a["at"])
            a["dur"] = round(a["dur"] * scale, 3)
        elif typ == "compare":
            for k in ("leftAt", "rightAt", "strikeAt"):
                a[k] = c(a[k])
        elif typ == "steps":
            for pair in a["steps"]:
                pair[1] = c(pair[1])
        elif typ == "quote":
            a["at"] = c(a["at"])
        elif typ == "checklist":
            for pair in a["items"]:
                pair[1] = c(pair[1])
        # outro 内部时间从 t0 起算，无需转换；片尾「配音」一行按实际音色生成
        if typ == "outro" and isinstance(a.get("lines"), list) and len(a["lines"]) >= 2:
            label = VOICE_LABELS.get(args.voice, args.voice)
            a["lines"][1] = f"配音：edge-tts {label} · 自制背景音"
        new_scenes.append({"type": typ, "t0": t0, "t1": round(t0 + L, 3), "args": a})
        captions.append({
            "start": round(t0 + 0.05, 3),
            "end": round(min(t0 + dur + 0.05, t0 + L - 0.05), 3),
            "text": voices[i],
        })

    out_inputs = {
        "brand": "MOTION LAB",
        "accent": "#2462EA",
        "accent2": "#5B8CFF",
        "durationSeconds": total,
        "fps": 24,
        "scenes": new_scenes,
        "captions": captions,
    }
    (ROOT / "edits" / f"inputs-{args.prefix}.json").write_text(
        json.dumps(out_inputs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 4) SRT
    lines = []
    for i, cap in enumerate(captions, 1):
        lines += [str(i), f"{srt_time(cap['start'])} --> {srt_time(cap['end'])}", cap["text"], ""]
    (ROOT / "edits" / f"captions-{args.prefix}.srt").write_text("\n".join(lines), encoding="utf-8")

    # 5) 音轨：8 段旁白各按起始时间延迟，叠加自制背景音，输出侧定时长
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"]
    for f in audio_files:
        cmd += ["-i", str(f)]
    cmd += ["-f", "lavfi", "-i", f"sine=frequency=220:duration={total}",
            "-f", "lavfi", "-i", f"sine=frequency=330:duration={total}"]
    filters = []
    for i, t0 in enumerate(starts):
        d = int(round(t0 * 1000))
        filters.append(
            f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,"
            f"adelay={d}|{d},volume=1.0[v{i}]")
    n = len(voices)
    filters.append(
        f"[{n}:a][{n+1}:a]amix=inputs=2,volume=0.018,"
        f"afade=t=in:st=0:d=1,afade=t=out:st={max(0, total-2)}:d=2,"
        f"aformat=channel_layouts=stereo[bg]")
    mix_in = "".join(f"[v{i}]" for i in range(n)) + "[bg]"
    filters.append(f"{mix_in}amix=inputs={n+1}:duration=longest:normalize=0,"
                   f"alimiter=limit=0.95[a]")
    cmd += ["-filter_complex", ";".join(filters), "-map", "[a]",
            "-t", str(total), "-c:a", "aac", "-b:a", "192k",
            "-ar", "48000", "-ac", "2", str(ROOT / "edits" / f"audio-{args.prefix}.m4a")]
    subprocess.run(cmd, check=True)

    # 6) 同步计划，便于交付复核
    plan = {
        "totalSeconds": total,
        "fps": 24,
        "segments": [
            {"i": i + 1, "scene": s["type"], "t0": s["t0"], "t1": s["t1"],
             "voiceSeconds": round(d, 3), "caption": c["text"]}
            for i, (s, d, c) in enumerate(zip(new_scenes, durations, captions))
        ],
    }
    (ROOT / "edits" / f"sync-plan-{args.prefix}.json").write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✓ edits/inputs-{args.prefix}.json / audio-{args.prefix}.m4a / captions-{args.prefix}.srt / sync-plan-{args.prefix}.json")
    print("  音轨时长:", probe(ROOT / "edits" / f"audio-{args.prefix}.m4a"), "s")


if __name__ == "__main__":
    main()
