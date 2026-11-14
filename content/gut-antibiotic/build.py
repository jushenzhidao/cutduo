#!/usr/bin/env python3
"""content/gut-antibiotic/build.py · science 版式的构建脚本

paper 那套（`kits/paper`）用 `scenes[{t0,t1}]` + 链式时间轴；science 完全不同：
  - 段放在 `segments` 里，**用 `dur` 累积**，没有 t0/t1
  - 段型是 cover / talk / diagram / compare / matrix / focus / tip / outro（医学科普向）
  - 顶层要 theme / brand / subtitle

所以不能复用 paper 的 build.py，这里单独写一份。

用法：
  python3 build.py            # 配音（有缓存）+ 拼轨 + 生成 params + 混音
  python3 build.py --voice    # 强制重新配音
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
AUDIO = os.path.join(HERE, 'audio')
VOICE = 'zh-CN-XiaoxiaoNeural'
GAP = 0.25          # 段间静默
FPS = 30
CPS = 5.5           # 中文语速（字/秒），用于字幕时长


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def dur(path):
    r = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', path], text=True)
    return float(r.stdout.strip())


def say(text, mp3):
    run(['edge-tts', '--voice', VOICE, '--text', text, '--write-media', mp3])


def split_caption(text, limit=18):
    out, cur = [], ''
    for ch in text:
        cur += ch
        if len(cur) >= limit and re.search(r'[，。、；：？！]', ch):
            out.append(cur)
            cur = ''
    if cur:
        out.append(cur)
    return out


def fit_captions(text, span, min_hold=1.8, limit=18):
    """字幕切段：一条至少停 max(min_hold, 字数/语速)，放不下就合并最短相邻条。
    （规则同 paper 的 fit_captions，见 docs/时间轴-契约 §16）"""
    chunks = split_caption(text, limit)
    while len(chunks) > 1:
        need = [max(min_hold, len(c) / CPS) for c in chunks]
        if sum(need) <= span + 1e-6:
            break
        k = min(range(len(chunks) - 1), key=lambda i: len(chunks[i]) + len(chunks[i + 1]))
        chunks[k:k + 2] = [chunks[k] + chunks[k + 1]]
    need = [max(min_hold, len(c) / CPS) for c in chunks]
    total = sum(need) or 1
    return [(c, span * n / total) for c, n in zip(chunks, need)]


def main():
    force = '--voice' in sys.argv
    os.makedirs(AUDIO, exist_ok=True)
    d = json.load(open(os.path.join(HERE, 'script.json'), encoding='utf-8'))
    beats = d['beats']

    segments, captions, parts = [], [], []
    t = 0.0
    for b in beats:
        mp3 = os.path.join(AUDIO, b['id'] + '.mp3')
        if force or not os.path.exists(mp3):
            say(b['text'], mp3)
        dd = dur(mp3)
        parts.append(mp3)
        args = (b.get('screens') or [{}])[0]
        segments.append({'type': b['type'], 'dur': round(dd, 3), 'args': args})

        cur = t
        for text, hold in fit_captions(b['text'], dd):
            captions.append({'start': round(cur, 2), 'end': round(cur + hold, 2), 'text': text})
            cur += hold
        t += dd + GAP
        print(f'  {b["id"]} {b["type"]:<8} {dd:5.2f}s  {b["text"][:22]}…')

    total = round(t - GAP, 3)

    # 拼轨：段之间插 GAP 静音。
    # 必须先把每个 mp3 转成**统一的 wav 格式**再拼：edge-tts 出的是 24 kHz mp3，
    # 静音是 44.1 kHz wav，concat demuxer 遇到不一致的输入会**静默丢段**
    # （实测 7 段 + 6 gap 应得 62.05s，实际只拼出 60.55s = 少掉全部 1.5s 的 gap）。
    silence = os.path.join(AUDIO, '_gap.wav')
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
         f'anullsrc=r=44100:cl=mono:d={GAP}', silence])
    wavs = []
    for i, m in enumerate(parts):
        w = os.path.join(AUDIO, f'_seg{i}.wav')
        run(['ffmpeg', '-v', 'error', '-y', '-i', m, '-ar', '44100', '-ac', '1', w])
        wavs.append(w)
    seq = []
    for i, w in enumerate(wavs):
        seq += [w, silence] if i < len(wavs) - 1 else [w]
    lst = os.path.join(AUDIO, '_list.txt')
    with open(lst, 'w') as f:
        for p in seq:
            f.write(f"file '{p}'\n")
    vo = os.path.join(AUDIO, 'vo.wav')
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst,
         '-ar', '44100', '-ac', '1', vo])

    # 音效：段界一声 whoosh、开场一声 impact、diagram 的每条引线标注一个 tick。
    # science 的段界只有 build 时才知道（dur 累积），所以 cues 在这里生成而不是手写。
    cues = []
    tc = 0.0
    for i, seg in enumerate(segments):
        if i == 0:
            cues.append({'at': 0, 'src': 'impact', 'gain': 0.20})
        elif seg['type'] != 'outro':
            # outro 用 rise 收，不再叠 whoosh（两个同刻会糊成一团）
            cues.append({'at': round(tc, 2), 'src': 'whoosh', 'gain': 0.16})
        if seg['type'] == 'diagram':
            for c in (seg['args'].get('callouts') or []):
                cues.append({'at': round(tc + float(c.get('at', 1.0)), 2), 'src': 'tick', 'gain': 0.14})
        if seg['type'] == 'outro':
            cues.append({'at': round(tc, 2), 'src': 'rise', 'gain': 0.18})
        tc += seg['dur'] + GAP

    params = {
        'audio': {'cues': cues},
        'brand': {'show': True, 'text': '医学科普', 'tag': 'SCIENCE EXPLAINER'},
        'theme': {'pop': '#FD2551', 'sun': '#FFD84D', 'jade': '#26A38C',
                  'jadeDeep': '#0E7A5F', 'blue': '#2B7FD4', 'ink': '#2C3A3E'},
        'subtitle': {'size': 62, 'color': '#FFFFFF', 'stroke': 6, 'strokeColor': '#1B2B30', 'y': 1002},
        'fadeOutSeconds': 0.32,
        'fps': FPS,
        'durationSeconds': total,
        'segments': segments,
        'captions': captions,
    }
    out = os.path.join(HERE, 'params-abs.json')
    json.dump(params, open(out, 'w'), ensure_ascii=False, indent=2)
    print(f'✓ {len(segments)} 段 / {len(captions)} 条字幕 / {len(cues)} 条音效 / {total:.2f}s → params-abs.json')


if __name__ == '__main__':
    main()
