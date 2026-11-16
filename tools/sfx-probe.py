#!/usr/bin/env python3
"""
sfx-probe.py · 从成片反推音效事件（即梦 Motion Showreel 蒸馏用）

    uv run --no-project python tools/sfx-probe.py refs/jimeng/01-motion-showreel/source.mp4
    python3 tools/sfx-probe.py <video> --json out/sfx-probe.json

做三件事，全部基于实测，不依赖听感：
  1. 10ms 帧的全频 RMS 与 3kHz 以上 RMS 两条包络
  2. 突增检测：全频段突增 → impact / stinger；高频段突增 → whoosh / tick
  3. 用 ffmpeg 场景检测拿硬切点，与音频事件对齐，报告误差

为什么要分两条包络：ambient / 弦乐的能量集中在 200Hz 以下，
一个 4kHz 的 whoosh 混在里面全频 RMS 几乎不动，只有高通后看得见。
只测全频会把"每个切点前的 riser"全部漏掉——这是本片最关键的音效结构。

退出码：0 正常；2 输入不存在或 ffmpeg 失败。
"""
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile

SR = 22050
HOP = 220          # 10ms 一帧
HI_CUT = 3000      # 高通分界：音效多在此以上，配乐多在此以下


def load_raw(path):
    b = open(path, 'rb').read()
    return struct.unpack('<%df' % (len(b) // 4), b)


def rms_db(seq, i):
    s = 0.0
    base = i * HOP
    for k in range(base, base + HOP):
        if k < len(seq):
            v = seq[k]
            s += v * v
    return 10 * math.log10(s / HOP + 1e-12)


def median(xs):
    if not xs:
        return -120.0
    ys = sorted(xs)
    m = len(ys) // 2
    return ys[m] if len(ys) % 2 else 0.5 * (ys[m - 1] + ys[m])


def probe(video):
    tmp = tempfile.mkdtemp(prefix='sfxprobe-')
    all_raw = os.path.join(tmp, 'all.raw')
    hi_raw = os.path.join(tmp, 'hi.raw')
    for out, af in ((all_raw, 'anull'), (hi_raw, f'highpass=f={HI_CUT}')):
        cmd = ['ffmpeg', '-v', 'error', '-i', video, '-ac', '1', '-ar', str(SR)]
        if af != 'anull':
            cmd += ['-af', af]
        cmd += ['-f', 'f32le', '-y', out]
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0:
            print('FAIL  ffmpeg 提取音频失败\n' + r.stderr.decode('utf-8', 'ignore')[-500:], file=sys.stderr)
            sys.exit(2)
    a = load_raw(all_raw)
    h = load_raw(hi_raw)
    n = min(len(a), len(h))
    frames = n // HOP
    A = [rms_db(a, i) for i in range(frames)]
    H = [rms_db(h, i) for i in range(frames)]
    return A, H, frames


def detect(seq, frames, look_back=25, look_skip=3, thresh=7.0, floor=-45.0):
    """突增检测：当前帧比「过去 250ms 的中位数」高 thresh dB 以上。"""
    events = []
    for i in range(frames):
        if seq[i] < floor:
            continue
        window = seq[max(0, i - look_back):max(0, i - look_skip)]
        if len(window) < 5:
            continue   # 开头不足半个观察窗：base 会是 -120，必然报假突增
        base = median(window)
        d = seq[i] - base
        if d >= thresh:
            events.append({'i': i, 't': round(i * HOP / SR, 3), 'db': round(seq[i], 1), 'delta': round(d, 1)})
    # 合并 60ms 内的同类事件，保留 delta 最大者
    merged = []
    for e in events:
        if merged and e['t'] - merged[-1]['t'] < 0.06:
            if e['delta'] > merged[-1]['delta']:
                merged[-1] = e
        else:
            merged.append(e)
    return merged


def cluster(events, gap=0.28):
    """把高频突增按间隔聚类。

    单个 whoosh 是一个事件，但**渐强的 riser 会连续触发十几次**（本片 12.0–12.32
    就是一段），不聚类会把它读成"十几个 tick"。音乐里的镲片也会触发，
    区别在于镲片成串且 Δ 小，riser 的 Δ 集中在 12–25 且簇尾正好落在切点上。
    """
    out = []
    for e in events:
        if out and e['t'] - out[-1]['end'] <= gap:
            out[-1]['end'] = e['t']
            out[-1]['peak'] = max(out[-1]['peak'], e['delta'])
            out[-1]['n'] += 1
        else:
            out.append({'start': e['t'], 'end': e['t'], 'peak': e['delta'], 'n': 1})
    for g in out:
        g['span'] = round(g['end'] - g['start'], 3)
        g['kind'] = 'riser' if g['span'] >= 0.12 and g['peak'] >= 12 else 'tick'
    return out


def scene_cuts(video):
    """硬切点。阈值 0.18 与蒸馏文档一致；同一镜头内连续帧会被合并。"""
    r = subprocess.run(
        ['ffmpeg', '-hide_banner', '-i', video, '-vf', "select='gt(scene,0.18)',showinfo", '-f', 'null', '-'],
        capture_output=True)
    txt = r.stderr.decode('utf-8', 'ignore')
    ts = sorted({round(float(m), 3) for m in re.findall(r'pts_time:([0-9.]+)', txt)})
    merged = []
    for t in ts:
        if merged and t - merged[-1] < 0.12:
            continue
        merged.append(t)
    return merged


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        print(__doc__)
        sys.exit(2)
    video = args[0]
    if not os.path.exists(video):
        print(f'FAIL  找不到 {video}', file=sys.stderr)
        sys.exit(2)

    json_out = None
    if '--json' in sys.argv:
        json_out = sys.argv[sys.argv.index('--json') + 1]

    A, H, frames = probe(video)
    dur = frames * HOP / SR
    impacts = detect(A, frames, thresh=8.0, floor=-40.0)
    whooshes = detect(H, frames, thresh=6.0, floor=-70.0)
    cuts = scene_cuts(video)

    print(f'源：{video}')
    print(f'时长 {dur:.3f}s · 帧数 {frames}（10ms/帧）· 高通 {HI_CUT}Hz\n')

    print('── 全频突增（impact / stinger）')
    print('   t(秒)    dB     ΔdB')
    for e in impacts:
        print(f"  {e['t']:7.3f} {e['db']:7.1f} {e['delta']:7.1f}")

    print('\n── 高频突增（whoosh / riser / tick）')
    print('   t(秒)    dB     ΔdB')
    for e in whooshes:
        print(f"  {e['t']:7.3f} {e['db']:7.1f} {e['delta']:7.1f}")

    groups = cluster(whooshes)
    print('\n── 高频聚类（riser / tick）')
    print('   起     止    时长   峰ΔdB  次数  类型')
    for g in groups:
        print(f"  {g['start']:6.3f} {g['end']:6.3f} {g['span']:6.3f} {g['peak']:6.1f} {g['n']:5d}  {g['kind']}")

    print('\n── 硬切点 vs 最近的音频事件')
    print('  切点     最近事件   偏移(ms)  类型')
    for c in cuts:
        # 50ms 内有 impact 就认 impact：它的噪声爆会同时触发 whoosh 检测，
        # 只按距离排序会把同一发音效报成 whoosh
        near = [(abs(e['t'] - c), e, 'impact') for e in impacts if abs(e['t'] - c) <= 0.05]
        if not near:
            near = [(abs(e['t'] - c), e, 'whoosh') for e in whooshes if abs(e['t'] - c) <= 0.35]
        near.sort(key=lambda x: x[0])
        if near:
            off, e, kind = near[0]
            print(f'  {c:6.3f}   {e["t"]:7.3f}   {(e["t"]-c)*1000:+7.0f}   {kind}')
        else:
            print(f'  {c:6.3f}   {"—":>7}   {"—":>7}   —')

    if json_out:
        os.makedirs(os.path.dirname(os.path.abspath(json_out)), exist_ok=True)
        json.dump({
            'source': video,
            'duration': round(dur, 3),
            'frame_ms': HOP / SR * 1000,
            'impacts': impacts,
            'whooshes': whooshes,
            'hi_clusters': groups,
            'cuts': cuts,
        }, open(json_out, 'w'), ensure_ascii=False, indent=2)
        print(f'\n  → {json_out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
