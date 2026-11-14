#!/usr/bin/env python3
"""content/incident/build.py · desk 版式的构建脚本

desk 与 paper/science 都不同：段放在 `shots` 里，**有显式 t0/t1**（不是 dur 累积），
段型是桌面界面类（title / notify / terminal / chat / files / flipBoard / counter / outro），
captions 还要 zh（可选 en）。入口是 `kits/desk/render.mjs`，不是主 render.mjs。
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, 'audio')
VOICE = 'zh-CN-XiaoxiaoNeural'
GAP = 0.45          # 段间留白（桌面片节奏比 paper 慢一点）
FPS = 60
CPS = 4.9


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def dur(path):
    r = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', path], text=True)
    return float(r.stdout.strip())


def main():
    os.makedirs(AUDIO, exist_ok=True)
    d = json.load(open(os.path.join(HERE, 'script.json'), encoding='utf-8'))
    shots, caps, parts = [], [], []
    t = 0.0
    for si, s in enumerate(d['shots']):
        mp3 = os.path.join(AUDIO, s['id'] + '.mp3')
        stale = os.path.exists(mp3) and os.path.getmtime(mp3) < os.path.getmtime(os.path.join(HERE, 'script.json'))
        if not os.path.exists(mp3) or stale:
            run(['edge-tts', '--voice', VOICE, '--text', s['text'], '--write-media', mp3])
        dd = dur(mp3)
        parts.append(mp3)
        # desk 要求时间轴**严格连续**（validateParams 会报 gap/overlap），
        # 所以留白不能放在段之间，要算进段时长：段末多留 0.45s 的静止画面。
        seg = dd + (GAP if si < len(d['shots']) - 1 else 0)   # 末段不留白，否则音画差 0.45s
        shots.append({
            'type': s['type'], 't0': round(t, 3), 't1': round(t + seg, 3),
            'chapter': s['chapter'], 'args': s['args'],
        })
        caps.append({'start': round(t + 0.05, 2), 'end': round(t + dd - 0.05, 2), 'zh': s['text']})
        print(f"  {s['id']} {s['type']:<10} 配音 {dd:5.2f}s / 段 {seg:5.2f}s  {s['text'][:20]}…")
        t += seg

    total = round(t, 3)
    silence = os.path.join(AUDIO, '_gap.wav')
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
         f'anullsrc=r=44100:cl=mono:d={GAP}', silence])
    wavs = []
    for i, m in enumerate(parts):
        w = os.path.join(AUDIO, f'_s{i}.wav')
        run(['ffmpeg', '-v', 'error', '-y', '-i', m, '-ar', '44100', '-ac', '1', w])
        wavs.append(w)
    seq = []
    for i, w in enumerate(wavs):
        seq += [w, silence] if i < len(wavs) - 1 else [w]
    lst = os.path.join(AUDIO, '_list.txt')
    open(lst, 'w').write(''.join(f"file '{p}'\n" for p in seq))
    vo = os.path.join(AUDIO, 'vo.wav')
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst,
         '-ar', '44100', '-ac', '1', vo])

    params = {
        'brand': d['brand'], 'fps': FPS, 'durationSeconds': total,
        'chapters': [], 'shots': shots, 'captions': caps,
    }
    # photo / clip 段靠 key 引用这些素材（相对 content/<片>/ 解析成绝对路径）
    if d.get('photos'):
        params['photos'] = {k: os.path.join(HERE, v) for k, v in d['photos'].items()}
    # 章节按出现顺序去重
    # 壁纸随章节变色（原版 demo 是 blue → light → orange 的节奏）。
    # 之前写死 'light'，整片壁纸一个色，和白纸幻灯片没区别——这是和原版差距最大的一处。
    seen = []
    wallOf = {s['chapter']: s.get('wall', 'light') for s in d['shots']}
    for s in shots:
        if s['chapter'] not in [x['name'] for x in seen]:
            seen.append({'name': s['chapter'], 'wall': wallOf.get(s['chapter'], 'light')})
    params['chapters'] = seen
    out = os.path.join(HERE, 'params-abs.json')
    json.dump(params, open(out, 'w'), ensure_ascii=False, indent=2)
    print(f'✓ {len(shots)} 段 / {len(caps)} 条字幕 / {total:.2f}s → params-abs.json')


if __name__ == '__main__':
    main()
