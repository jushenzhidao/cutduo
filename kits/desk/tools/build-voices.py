#!/usr/bin/env python3
"""为 desktop-kit 合成旁白，并按每句真实时长重排分镜与字幕。

默认（不带参数）与首版完全一致：读 content/demo.json → content/demo-voiced.json
+ edits/audio-desktop.m4a。换内容只要给 --preset，输出路径自动按文件名推导：

  uv run python desktop-kit/tools/build-voices.py --preset content/uv.json
  → content/uv-voiced.json + edits/audio-uv.m4a

只用标准库 + edge-tts + ffmpeg；同一句 + 同一音色/语速命中本地缓存。
"""
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import subprocess
import time
import wave

ROOT = pathlib.Path(__file__).resolve().parents[2]
KIT = ROOT / "desktop-kit"
DEFAULT_PRESET = ROOT / "content" / "demo.json"
CACHE = ROOT / "edits" / "tts-cache"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
EDGE = str(pathlib.Path.home() / ".local" / "bin" / "edge-tts")
SR, CH = 48000, 2


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def clean_zh(s):
    return s.replace("*", "")


def synthesize(i, text, voice, rate, tmp):
    key = hashlib.sha1(f"edge|{voice}|{rate}|{text}".encode()).hexdigest()[:16]
    cached = CACHE / f"{key}.mp3"
    wav = tmp / f"seg{i:02d}.wav"
    if not cached.exists() or cached.stat().st_size < 1000:
        mp3 = tmp / f"seg{i:02d}.mp3"
        last = ""
        for _ in range(4):
            r = run([EDGE, "--voice", voice, f"--rate={rate}", "--text", text,
                     "--write-media", str(mp3)], timeout=60)
            if r.returncode == 0 and mp3.exists() and mp3.stat().st_size > 1000:
                cached.write_bytes(mp3.read_bytes())
                break
            last = (r.stderr or "")[-260:]
            time.sleep(1.2)
        else:
            raise SystemExit(f"第 {i+1} 句 edge-tts 合成失败: {last}")
    r = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(cached),
             "-ar", str(SR), "-ac", str(CH), "-c:a", "pcm_s16le", str(wav)], timeout=90)
    if r.returncode != 0:
        raise SystemExit(f"第 {i+1} 句转 wav 失败: {r.stderr[-300:]}")
    with wave.open(str(wav), "rb") as f:
        frames, sr = f.getnframes(), f.getframerate()
        data = f.readframes(frames)
    return i, data, frames / sr


def resolve(p):
    """相对路径先按仓库根解析（与 render.mjs 的 resolveInput 一致）。"""
    q = pathlib.Path(p)
    return q if q.is_absolute() else ROOT / q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", default=str(DEFAULT_PRESET), help="nominal 分镜 JSON")
    ap.add_argument("--out-params", default=None, help="重排后的 params（默认 <preset stem>-voiced.json）")
    ap.add_argument("--audio", default=None, help="输出音轨（默认 edits/audio-<stem>.m4a）")
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    ap.add_argument("--rate", default="+8%")
    ap.add_argument("--gap", type=float, default=0.42, help="句间空档秒数")
    ap.add_argument("--lead", type=float, default=0.35, help="第一句前的空档秒数")
    ap.add_argument("--tail", type=float, default=2.8, help="末句后的空档秒数")
    a = ap.parse_args()

    preset = resolve(a.preset)
    stem = preset.stem.removesuffix("-voiced")
    voiced = resolve(a.out_params) if a.out_params else preset.with_name(f"{stem}-voiced.json")
    # demo 保留历史文件名，避免破坏 README 与既有成片的复跑命令。
    default_audio = "audio-desktop.m4a" if stem == "demo" else f"audio-{stem}.m4a"
    audio = resolve(a.audio) if a.audio else ROOT / "edits" / default_audio
    tmp = pathlib.Path(f"/tmp/desktop-voices-{stem}")

    tmp.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    audio.parent.mkdir(parents=True, exist_ok=True)
    if not preset.exists():
        raise SystemExit(f"找不到分镜文件: {preset}")
    d = json.loads(preset.read_text())
    shots, caps = d["shots"], d["captions"]
    if len(shots) != len(caps):
        raise SystemExit("shots 与 captions 数量不一致，无法一一对应重排")

    texts = [clean_zh(c["zh"]) for c in caps]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        futs = [ex.submit(synthesize, i, t, a.voice, a.rate, tmp) for i, t in enumerate(texts)]
        results = sorted((f.result() for f in futs), key=lambda x: x[0])

    silence = b"\x00" * int(SR * a.gap * CH * 2)
    lead = b"\x00" * int(SR * a.lead * CH * 2)
    tail = b"\x00" * int(SR * a.tail * CH * 2)
    chunks, starts, ends, cursor = [lead], [], [], a.lead
    for i, data, dur in results:
        starts.append(cursor)
        chunks.append(data)
        cursor += dur
        ends.append(cursor)
        if i != len(results) - 1:
            chunks.append(silence)
            cursor += a.gap
    chunks.append(tail)
    total = cursor + a.tail

    raw = tmp / "voice.wav"
    with wave.open(str(raw), "wb") as f:
        f.setnchannels(CH); f.setsampwidth(2); f.setframerate(SR)
        f.writeframes(b"".join(chunks))
    r = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw),
             "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(audio)], timeout=120)
    if r.returncode != 0:
        raise SystemExit("音频封装失败: " + r.stderr[-300:])

    # 镜头边界取「下一句开始」；字幕窗口跟着本句语音，末尾留 0.38s 让英文行读完。
    new_shots, new_caps = [], []
    for i, s in enumerate(shots):
        t0 = 0.0 if i == 0 else starts[i] - 0.22
        t1 = starts[i + 1] - 0.22 if i + 1 < len(shots) else total
        ns = dict(s); ns["t0"] = round(t0, 3); ns["t1"] = round(t1, 3)
        new_shots.append(ns)
        c = dict(caps[i]); c["start"] = round(starts[i] - 0.12, 3)
        c["end"] = round(min(t1, ends[i] + 0.38), 3)
        new_caps.append(c)
    d["shots"], d["captions"] = new_shots, new_caps
    d["durationSeconds"] = round(total, 3)
    d["_note"] = f"由 build-voices.py 按真实配音时长重排；音轨 {audio.relative_to(ROOT)}"
    voiced.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n")

    print(f"✓ 音频 {audio}  {total:.3f}s / {len(results)} 句")
    print(f"✓ 分镜 {voiced}  首镜 {new_shots[0]['t0']}s  末镜 {new_shots[-1]['t1']}s")
    print("  句长(s): " + " ".join(f"{x[2]:.2f}" for x in results))


if __name__ == "__main__":
    main()
