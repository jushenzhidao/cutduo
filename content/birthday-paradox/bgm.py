#!/usr/bin/env python3
"""content/birthday-paradox/bgm.py · 分层配乐：按叙事段落让各层进出

为什么不用 add-bgm 的单曲循环：Apple Loops 都是短 loop（这首 8.3s），105 秒里循环 12 遍，
听感是一片糊。这里用三层不同音色，按段落加减，靠"层次进出"制造变化，而不是靠换曲。

  层 A  Wonderland Pizzicato Strings (28.7s)  全程，拨弦 = 好奇感
  层 B  Minimal Backbeat 01 (4.0s)            12.4s 起，极简后拍 = 推进
  层 C  Tension Bass (7.5s)                   77s 起，张力低音 = 反转段

段落边界取自 script.json 的实际配音时长，不是手填。
输出 bgm.wav（48k mono），再交给 src/audio-mix.mjs 与旁白做 ducking。
"""
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
LOOPS = '/Library/Audio/Apple Loops/Apple'
# 全用 02 Electro House 一套：7.5s 与 3.75s 正好二倍关系 ⇒ 同为 128 BPM，叠在一起不打架。
# Chillwave 的 12s loop 是另一个速度，混进来会听觉错位，所以不用。
LAYERS = {
    'a': f'{LOOPS}/02 Electro House/Binary System Synth Layers.caf',   # 合成器层，全程
    'b': f'{LOOPS}/02 Electro House/Blueprint Beat 01.caf',            # 电子鼓，中段起
    'c': f'{LOOPS}/02 Electro House/Acid Test Bass.caf',               # acid bass，反转段
    'd': f'{LOOPS}/02 Electro House/Apex Synth.caf',                   # 点缀：金句段与尺度段
}


def main():
    d = json.load(open(os.path.join(HERE, 'script.json'), encoding='utf-8'))
    beats = d['beats']
    # 时长与段落边界都以 build.py 产出的 params.json 为准（那里才有 t0/t1）
    p = json.load(open(os.path.join(HERE, 'params-abs.json'), encoding='utf-8'))
    total = p['durationSeconds']

    segs = p['scenes']
    t_quant = segs[2]['t0']       # 量化段
    t_twist = segs[6]['t0']       # 反转段
    t_loop = segs[8]['t0']        # 回问段

    # 每层的音量包络（expr 里用 t；eval=frame 让它逐帧生效）
    def env(pairs):
        # pairs: [(t_from, gain), ...] 阶梯
        expr = str(pairs[-1][1])
        for t, g in reversed(pairs[:-1]):
            expr = f'if(lt(t,{t}),{expr},{g})'
        return expr

    t_quote, t_scale, t_land = segs[4]['t0'], segs[5]['t0'], segs[7]['t0']

    # 层 A 合成器：全程，钩子轻、推理段抬、末段收
    a_env = env([(0, 0.30), (t_quant, 0.40), (t_twist, 0.46), (t_loop, 0.20)])
    # 层 B 电子鼓：量化段进，金句处撤一半（让人声落下来），落地段再抬
    b_env = env([(0, 0.0), (t_quant, 0.32), (t_quote, 0.14), (t_scale, 0.34),
                 (t_twist, 0.40), (t_loop, 0.0)])
    # 层 C acid bass：只在反转段与落地段
    c_env = env([(0, 0.0), (t_twist, 0.38), (t_loop, 0.0)])
    # 层 D 点缀 synth：金句段、尺度段各开一个窗口
    d_env = env([(0, 0.0), (t_quote, 0.17), (t_scale - 0.1, 0.0),
                 (t_twist - 6, 0.17), (t_twist, 0.0)])

    def lay(i, name, e, fade_in=False):
        tail = ',afade=t=in:st=0:d=1.6' if fade_in else ''
        return (f"[{i}:a]aresample=48000,aformat=channel_layouts=mono,"
                f"aloop=loop=-1:size=2147483647,atrim=0:{total},asetpts=N/SR/TB,"
                f"volume='{e}':eval=frame{tail}[{name}]")

    filters = [
        lay(0, 'a', a_env, fade_in=True),
        lay(1, 'b', b_env),
        lay(2, 'c', c_env),
        lay(3, 'd', d_env),
        f"[a][b][c][d]amix=inputs=4:normalize=0:duration=first,"
        f"alimiter=limit=0.85,afade=t=out:st={total - 2.2:.2f}:d=2.2[out]",
    ]

    wav = os.path.join(HERE, 'audio', 'bgm.wav')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                    '-i', LAYERS['a'], '-i', LAYERS['b'], '-i', LAYERS['c'], '-i', LAYERS['d'],
                    '-filter_complex', ';'.join(filters),
                    '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', wav], check=True)

    r = subprocess.run(['ffmpeg', '-nostats', '-i', wav, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True).stderr
    import re
    i = re.search(r'Integrated loudness:[\s\S]*?I:\s+(-?[\d.]+) LUFS', r)
    tp = re.search(r'True peak:[\s\S]*?Peak:\s+(-?[\d.]+) dBFS', r)
    print(f'✓ {wav}')
    print(f'  {total}s · A 全程 / B @{t_quant}s / C @{t_twist}s / D 窗 @{segs[4]["t0"]}s+{segs[6]["t0"]-6}s · '
          f'I={i.group(1) if i else "?"} LUFS · TP={tp.group(1) if tp else "?"} dBFS')


if __name__ == '__main__':
    main()
