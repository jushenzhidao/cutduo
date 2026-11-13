#!/usr/bin/env python3
"""vo.py — 配音驱动时间轴（edge-tts → 重排段落 → 拼音轨 → 输出可渲染 preset）

用法:
  uv run --with numpy python tools/vo.py --preset presets/microwave.json \
      --out-preset presets/microwave.vo.json --out-audio out/microwave.vo.wav [--voice ...]

做三件事：
1. 逐句 TTS，实测每句时长（不猜）。
2. 按"句子属于哪个段"重算段落时长与句子起止：段长 = 段首留白 + 本段句子音频 + 句间隔 + 段尾留白。
3. 把句子音频按新起点写入全长静音底，导出 wav，供 motion-render --audio 直接 mux。

原则：时间轴跟随配音，不是配音迁就时间轴。
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, wave
from pathlib import Path

import numpy as np

SR = 44100
LEAD = 0.45      # 段首留白：给画面入场
GAP = 0.28       # 句间停顿
END = 0.55       # 段尾留白
MIN_SEC = 2.6    # 单段下限，避免切太碎
TAIL_HOLD = 0.14 # 字幕比语音多留一点，防止话音未落字幕先消失


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"失败: {' '.join(cmd[:6])}...\n{r.stderr[-800:]}")
    return r


def probe_dur(p):
    r = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(p)])
    return float(json.loads(r.stdout)['format']['duration'])


def tts(text, mp3, voice, rate, pitch):
    run(['edge-tts', '--voice', voice, '--rate', rate, '--pitch', pitch, '--text', text, '--write-media', str(mp3)])
    wav = mp3.with_suffix('.wav')
    run(['ffmpeg', '-y', '-v', 'error', '-i', str(mp3), '-ac', '1', '-ar', str(SR), '-c:a', 'pcm_s16le', str(wav)])
    return wav


def mouth_curve(pcm, fps, total, win=0.045):
    """按帧算 RMS 包络 → 0..1，用于对口型。窗长略大于一帧，避免抖动。"""
    n = int(SR * total)
    pcm = pcm[:n].astype(np.float32) / 32768.0
    frames = int(round(total * fps))
    hop = SR / fps
    half = max(1, int(SR * win / 2))
    out = np.zeros(frames, dtype=np.float32)
    for i in range(frames):
        c = int(i * hop)
        a, b = max(0, c - half), min(len(pcm), c + half)
        if b > a:
            seg = pcm[a:b]
            out[i] = float(np.sqrt(np.mean(seg * seg)))
    # 归一化到 p95，静音段压到 0
    hi = np.percentile(out, 95) or 1.0
    out = np.clip(out / hi, 0, 1)
    out[out < 0.06] = 0
    # 轻平滑（EMA），再去掉尾音抖动
    a = 0.55
    for i in range(1, frames):
        out[i] = a * out[i] + (1 - a) * out[i - 1]
    return [round(float(v), 2) for v in out]


def read_wav(p):
    with wave.open(str(p), 'rb') as w:
        if w.getnchannels() != 1 or w.getframerate() != SR:
            sys.exit(f"{p} 不是 {SR}Hz 单声道")
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--preset', required=True)
    ap.add_argument('--out-preset', required=True)
    ap.add_argument('--out-audio', required=True)
    ap.add_argument('--voice', default='zh-CN-XiaoxiaoNeural')
    ap.add_argument('--rate', default='+8%')
    ap.add_argument('--pitch', default='+0Hz')
    ap.add_argument('--keep', action='store_true', help='保留逐句音频')
    a = ap.parse_args()

    # 前置检查：edge-tts 常装在 ~/.local/bin，非交互 shell 的 PATH 里往往没有。
    # 不做这一步，报错会是 "失败: edge-tts --voice ..." 而看不出真实原因。
    if shutil.which('edge-tts') is None:
        sys.exit(
            '找不到 edge-tts。\n'
            '  安装：uv tool install edge-tts\n'
            '  或把 ~/.local/bin 加进 PATH：export PATH="$HOME/.local/bin:$PATH"'
        )

    src = json.loads(Path(a.preset).read_text(encoding='utf-8'))
    caps = src['captions']
    segs = src['segments']

    # 原段边界
    bounds, acc = [], 0.0
    for s in segs:
        bounds.append((acc, acc + float(s['dur']), s))
        acc += float(s['dur'])

    # 句子归属段（按原 start 落点）
    owner = []
    for c in caps:
        if isinstance(c.get('seg'), int) and 0 <= c['seg'] < len(bounds):
            owner.append(c['seg'])          # 显式指定，最可靠
            continue
        k = len(bounds) - 1
        for i, (t0, t1, _) in enumerate(bounds):
            if t0 <= float(c['start']) < t1:
                k = i
                break
        owner.append(k)

    # 字幕容量检查：单行 62px 在 1660px 内约 26 个汉字。超了会折行并降档，
    # 折行是兜底不是设计——cover/tip 这类底部有内容的版式会变挤。
    LONG = 26
    over = [(i, c) for i, c in enumerate(caps) if len(c['text']) > LONG]
    if over:
        print(f'⚠ {len(over)} 句超过 {LONG} 字（会自动折行，建议拆句）：')
        for i, c in over:
            print(f'   第{i+1}句 {len(c["text"])} 字：{c["text"][:24]}…')

    voices = src.get('voices') or {}

    def voice_of(c):
        sp = c.get('speaker') or 'default'
        return voices.get(sp) or voices.get('default') or a.voice

    tmp = Path(a.keep and Path(a.out_audio).with_suffix('') or tempfile.mkdtemp())
    tmp.mkdir(parents=True, exist_ok=True)

    used = sorted({c.get('speaker') or 'default' for c in caps})
    print(f'配音 {len(caps)} 句 · 角色 {len(used)} 个 · rate={a.rate}')
    for sp in used:
        print(f'  {sp:<8} → {voices.get(sp) or a.voice}')
    durs, wavs = [], []
    for i, c in enumerate(caps):
        v = voice_of(c)
        w = tts(c['text'], tmp / f'{i:02d}.mp3', v, a.rate, a.pitch)
        d = probe_dur(w)
        durs.append(d)
        wavs.append(w)
        sp = c.get('speaker') or '-'
        print(f'  {i+1:2d}. [{sp:<5}] {d:5.2f}s  {c["text"]}')

    # 重算段长与句子位置
    new_segs, cursor = [], 0.0
    for k, (t0, t1, s) in enumerate(bounds):
        idxs = [i for i in range(len(caps)) if owner[i] == k]
        if not idxs:
            dur = float(s['dur'])                     # 无台词的段（尾板）保留原长
        else:
            body = sum(durs[i] for i in idxs) + GAP * (len(idxs) - 1)
            dur = max(MIN_SEC, LEAD + body + END)
        # 句子落位
        tc = cursor + LEAD
        for i in idxs:
            caps[i]['start'] = round(tc, 3)
            caps[i]['end'] = round(tc + durs[i] + TAIL_HOLD, 3)
            tc += durs[i] + GAP
        # 配音驱动动效：tip / matrix 的每一条 = 一句话，把点亮时刻钉在对应句上。
        # 允许「引入句 + N 条」：如「记住三点」后接三条，此时条目对齐**后** N 句；
        # 多出的句子最多 1 句（引入），否则说明文案与条目数量不匹配，不猜。
        seg_args = dict(s.get('args') or {})
        if s['type'] in ('tip', 'matrix'):
            items = seg_args.get('items') or []
            n = len(items)
            picked = None
            if n and len(idxs) >= n and len(idxs) - n <= 1:
                # 一句一条：直接用句子起点
                picked = [round(caps[i]['start'] - cursor, 2) for i in idxs[-n:]]
            elif n:
                # 段内找「一句列举 N 项」的句子（如「阑尾炎、肠套叠、胆囊炎、肾结石」）：
                # 按各段字数比例切分这句的语音区间。朗读匀速，等长词的误差 < 0.1s。
                for i in idxs:
                    c = caps[i]
                    parts = [x for x in re.split(r'[、，,]', c['text']) if x.strip()]
                    if len(parts) != n:
                        continue
                    speech = max(0.1, (c['end'] - c['start']) - TAIL_HOLD)
                    total = sum(len(x) for x in parts)
                    t_acc, picked = c['start'], []
                    for x in parts:
                        picked.append(round(t_acc - cursor, 2))
                        t_acc += speech * len(x) / total
                    break
            if picked:
                seg_args['itemAt'] = picked
        # 圆框图解：标注时刻**作者写了就听作者的**，没写才按句子起点兜底。
        # 曾经的实现是无条件覆盖，把作者写的 1.4–1.5s 冲成 0.45s（和"第一句留给入场"的注释相反），
        # 成片实测引线标注在 1.4–1.6s 出现。现在只补空缺，重跑不再漂移（幂等）。
        if s['type'] == 'diagram':
            cos = seg_args.get('callouts') or []
            if cos and len(idxs) >= len(cos):
                off = 1 if len(idxs) > len(cos) else 0
                filled = []
                for i, c in enumerate(cos):
                    if isinstance(c.get('at'), (int, float)):
                        filled.append(c)
                    else:
                        filled.append({**c, 'at': round(caps[idxs[min(i + off, len(idxs) - 1)]]['start'] - cursor, 2)})
                seg_args['callouts'] = filled
        # 讲解位：把本段每句的说话区间写进去，人物嘴型只在说话时动
        if s['type'] == 'talk' and idxs:
            seg_args['talking'] = [
                [round(caps[i]['start'] - cursor, 2), round(caps[i]['end'] - cursor, 2)] for i in idxs
            ]
        new_segs.append({**s, 'args': seg_args, 'dur': round(dur, 3), '_t0': cursor})
        cursor += dur

    total = round(cursor, 3)

    # 拼音轨：全长静音 + 逐句写入
    buf = np.zeros(int(SR * (total + 0.5)), dtype=np.int16)
    for i, w in enumerate(wavs):
        pcm = read_wav(w)
        s0 = int(caps[i]['start'] * SR)
        s1 = min(len(buf), s0 + len(pcm))
        buf[s0:s1] = np.clip(buf[s0:s1].astype(np.int32) + pcm[: s1 - s0].astype(np.int32), -32768, 32767).astype(np.int16)

    out_wav = Path(a.out_audio)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    raw = out_wav.with_name(out_wav.stem + '.raw.wav')
    with wave.open(str(raw), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        # 多写 0.12s：音频略长于视频，ffmpeg -shortest 才不会截掉最后一帧
        w.writeframes(buf[: int(SR * (total + 0.12))].tobytes())
    # 响度归一化：edge-tts 原始电平约 -21 dB，短视频平台通常要 -16 LUFS
    run(['ffmpeg', '-y', '-v', 'error', '-i', str(raw),
         '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', str(SR), '-ac', '1',
         '-c:a', 'pcm_s16le', str(out_wav)])
    raw.unlink(missing_ok=True)

    fps = float(src.get('fps') or 30)
    out = {**src}
    # 段长是连续秒（TTS 实测），边界几乎必然落在两帧之间；不量化的结果是
    # "恰好卡在切点的那一帧" 被判给上一段 —— 成片上看是一帧迟切，实测 MAE 0.1，
    # 肉眼几乎看不出，但对抗审查会报 cut.duplicate。这里直接打开帧网格对齐。
    out['snapToFrames'] = True
    out['mouthCurve'] = mouth_curve(np.frombuffer(buf[: int(SR * total)].tobytes(), dtype=np.int16), fps, total)
    out['durationSeconds'] = total
    out['captions'] = [
        {k: v for k, v in c.items() if k in ('start', 'end', 'text', 'speaker')} for c in caps
    ]
    out['segments'] = [
        {k: v for k, v in s.items() if not k.startswith('_')} for s in new_segs
    ]
    out['audio'] = str(out_wav)
    # 把实际用到的音色写回 preset：否则成片与"声音是谁"脱钩，
    # 事后既审计不了性别一致性，也复现不了同一条音轨。
    out['voices'] = {sp: voice_of({'speaker': sp}) for sp in used}
    Path(a.out_preset).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'\n新时长 {total:.2f}s（原 {sum(float(s["dur"]) for s in segs):.2f}s）')
    for i, s in enumerate(new_segs):
        print(f'  段{i+1} {s["type"]:<8} {s["dur"]:.2f}s @ {s["_t0"]:.2f}s')
    print(f'口型包络 {len(out["mouthCurve"])} 帧（逐帧 RMS）')
    print(f'音轨 → {out_wav}\npreset → {a.out_preset}')


if __name__ == '__main__':
    main()
