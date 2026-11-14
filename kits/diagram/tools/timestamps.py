#!/usr/bin/env python3
"""
kits/diagram/tools/timestamps.py · 字级时间戳（本机 CPU，不上传）

为什么要它：画面的揭示时刻必须由"念到哪个字"决定，而不是"段内进度到几点"。
后者一句 3 秒念 12 个字，元素在第 1.5 秒才长出来一半，观众已经在听第三个词。

通道：sherpa-onnx + FireRedASR2-CTC(int8)。模型约 776 MB，放固定目录：
  ~/.cache/koubo/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25/
    model.int8.onnx  tokens.txt

用法（uv 管环境，不污染全局）：
  uv run --with sherpa-onnx python kits/diagram/tools/timestamps.py \
    --wav out/x.vo.wav --manifest out/x.vo.json --out out/x.timing.json

manifest 就是 vo.mjs 产出的 params：用它给的 audioAt/speech 逐句切窗，
一句一个识别上下文。逐句切的好处是错字不外溢，而且每句能单独算 match 分。
"""

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
import wave

MODEL_DIR = os.path.expanduser(
    "~/.cache/koubo/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25"
)
# 中文标点：不发音，时刻跟前面那个字走。英文标点一起处理，稿子里常混排。
PUNCT = set("，。、；：？！“”‘’（）《》〈〉【】—…·,.!?;:\"'()[]{}<>-—–/\\|~`@#$%^&*_+= \n\t\r　")


def read_wav_16k(path):
    """按 16k/mono/16bit 读 PCM。不是这个格式就先转 —— 别指望 C++ 端猜。"""
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"需要 16k/mono/16bit wav，实际 {w.getframerate()}/{w.getnchannels()}/{w.getsampwidth()}")
        raw = w.readframes(w.getnframes())
    import array

    a = array.array("h")
    a.frombytes(raw)
    return a, 16000


def to_16k(src, tmpdir):
    dst = os.path.join(tmpdir, "audio16k.wav")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst],
        check=True,
    )
    return dst


def build_recognizer(threads):
    import sherpa_onnx

    model = os.path.join(MODEL_DIR, "model.int8.onnx")
    tokens = os.path.join(MODEL_DIR, "tokens.txt")
    for p in (model, tokens):
        if not os.path.exists(p):
            raise SystemExit(f"缺模型文件：{p}")
    return sherpa_onnx.OfflineRecognizer.from_fire_red_asr_ctc(
        model=model, tokens=tokens, num_threads=threads, decoding_method="greedy_search", debug=False
    )


def norm_token(t):
    """识别 token 可能带 ▁ 词首标记；中文单字则原样。"""
    return t.replace("▁", "").strip()


def align(line, tokens, stamps):
    """
    识别结果 ↔ 手写稿，字符级对齐。

    tokens/stamps 是识别出来的字与各自开口时刻（绝对秒）。返回与 line 等长的
    [{ch, t}]：每个稿子字符（含标点）在这句话里的开口时刻。

    同音字不算错 —— 对齐看的是"位置"，不是"读音"。识别错的地方在锚点之间
    线性插值补齐，因为观众听到的是稿子，不是识别结果。
    """
    src = [(norm_token(t), s) for t, s in zip(tokens, stamps) if norm_token(t)]
    src_txt = "".join(t for t, _ in src)

    # 稿子侧：只取发音字符做锚点，标点不参与匹配
    idx = [(i, ch) for i, ch in enumerate(line) if ch not in PUNCT]
    dst_txt = "".join(ch for _, ch in idx)

    out = [None] * len(line)
    if not src or not dst_txt:
        return out, 0.0, src_txt

    sm = difflib.SequenceMatcher(None, src_txt, dst_txt, autojunk=False)
    matched = 0

    def put(pos_dst, t):
        out[idx[pos_dst][0]] = t

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(j2 - j1):
                put(j1 + k, src[i1 + k][1])
            matched += j2 - j1
        elif tag == "replace":
            # 用识别段的起止时刻把稿子这一段均匀铺开（tokens 里换行/多字都在这）
            t0 = src[i1][1]
            t1 = src[i2][1] if i2 < len(src) else (src[i2 - 1][1] + 0.18)
            span = max(0.05, t1 - t0)
            n = max(1, j2 - j1)
            for k in range(n):
                put(j1 + k, t0 + span * k / n)
        elif tag == "delete":
            # 稿子有、识别没给（漏字/连读）：插在上一个和下一下锚点之间
            t_prev = src[i1 - 1][1] if i1 > 0 else (src[0][1] if src else 0.0)
            t_next = src[i1][1] if i1 < len(src) else t_prev + 0.18
            n = max(1, j2 - j1)
            for k in range(n):
                put(j1 + k, t_prev + (t_next - t_prev) * (k + 1) / (n + 1))

    # 识别多出来的（insert）不影响稿子，跳过
    # 标点：跟前面最近的发音字；句首标点跟后面
    last = None
    for i, ch in enumerate(line):
        if out[i] is not None:
            last = out[i]
        elif last is not None:
            out[i] = last
    nxt = None
    for i in range(len(line) - 1, -1, -1):
        if out[i] is not None:
            nxt = out[i]
        elif nxt is not None:
            out[i] = nxt

    score = matched / max(1, len(dst_txt))
    return [{"ch": ch, "t": (None if out[i] is None else round(float(out[i]), 4))} for i, ch in enumerate(line)], score, src_txt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--manifest", required=True, help="vo.mjs 产出的 params（含 _timeline）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--pad", type=float, default=0.12, help="每句两侧各留多少秒再识别")
    args = ap.parse_args()

    params = json.load(open(args.manifest, encoding="utf-8"))
    segs = params.get("segments") or []
    tl = {t["index"]: t for t in (params.get("_timeline") or [])}
    if not segs:
        raise SystemExit("manifest 没有 segments")

    tmpdir = tempfile.mkdtemp(prefix="stamp-")
    wav16 = to_16k(args.wav, tmpdir)
    samples, sr = read_wav_16k(wav16)
    recognizer = build_recognizer(args.threads)

    for i, seg in enumerate(segs):
        t = tl.get(i)
        # 一段多句时 params.segments[i] 只有 lines 数组，拼接后的整句在 _timeline.line
        line = seg.get("line") or (t or {}).get("line") or ""
        if not line or not t:
            raise SystemExit(f"第 {i + 1} 段缺 line 或 _timeline")
        a = max(0.0, t["audioAt"] - args.pad)
        b = min(len(samples) / sr, t["audioAt"] + t["speech"] + args.pad)
        chunk = samples[int(a * sr): int(b * sr)]

        st = recognizer.create_stream()
        st.accept_waveform(sr, chunk)
        recognizer.decode_stream(st)
        res = st.result
        stamps = [a + float(x) for x in (res.timestamps or [])]

        chars, score, heard = align(line, list(res.tokens or []), stamps)
        if score < 0.90:
            print(f"[warn] 第 {i + 1} 句 match {score:.2f} < 0.90，务必听一遍：{line}", file=sys.stderr)

        seg_t = {
            "index": i,
            "line": line,
            "start": t["start"],
            "duration": t["duration"],
            "audioAt": t["audioAt"],
            "speech": t["speech"],
            "match": round(score, 3),
            "heard": heard,
            # 逐句时间：一段多句时字幕要按句换，render 侧靠这个切
            "lines": t.get("lines") or [],
            # 段内相对秒：动画只认这个，不认绝对秒（片头卡会让绝对值整体后移）
            "chars": [
                {"ch": c["ch"], "t": None if c["t"] is None else round(c["t"] - t["start"], 4)}
                for c in chars
            ],
        }
        segs[i] = seg_t
        print(f"[{i + 1}/{len(segs)}] match {score:.2f}  {len(line)} 字  {heard}", file=sys.stderr)

    out = {
        "wav": args.wav,
        "total": round(sum(s["duration"] for s in segs) + float((params.get("titleCard") or {}).get("duration") or 0), 3),
        "model": "FireRedASR2-CTC-int8",
        "segments": segs,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(
        json.dumps(
            {
                "ok": True,
                "out": args.out,
                "segments": len(segs),
                "match": [s["match"] for s in segs],
                "total": out["total"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
