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
import argparse, json, os, subprocess, sys, tempfile, wave
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
        # 配音驱动动效：便签三条 = 三句话，把每条的点亮时刻钉在对应句子上
        seg_args = dict(s.get('args') or {})
        if s['type'] == 'tip':
            items = seg_args.get('items') or []
            if len(idxs) == len(items):
                seg_args['itemAt'] = [round(caps[i]['start'] - cursor, 2) for i in idxs]
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

    out = {**src}
    out['durationSeconds'] = total
    out['captions'] = [
        {k: v for k, v in c.items() if k in ('start', 'end', 'text', 'speaker')} for c in caps
    ]
    out['segments'] = [
        {k: v for k, v in s.items() if not k.startswith('_')} for s in new_segs
    ]
    out['audio'] = str(out_wav)
    Path(a.out_preset).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'\n新时长 {total:.2f}s（原 {sum(float(s["dur"]) for s in segs):.2f}s）')
    for i, s in enumerate(new_segs):
        print(f'  段{i+1} {s["type"]:<8} {s["dur"]:.2f}s @ {s["_t0"]:.2f}s')
    print(f'音轨 → {out_wav}\npreset → {a.out_preset}')


if __name__ == '__main__':
    main()
