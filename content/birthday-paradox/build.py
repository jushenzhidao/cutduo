#!/usr/bin/env python3
"""content/birthday-paradox/build.py · 由配音长度排时间轴 → 生成 paper params + 拼音轨

时间轴只有一个来源：配音的实测时长。画面和字幕都跟着它走，不手敲秒数。
"""
import json
import os
import sys
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
GAP = 0.25          # 拍间隔（≤0.25s，符合快节奏口播）
FPS = 60


def dur(path):
    return float(subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        capture_output=True, text=True).stdout)


def split_caption(text, limit=18):
    """把一段旁白切成 ≤limit 字的字幕块，尽量落在标点处。"""
    parts = re.split(r'(?<=[，。、；：？！])', text)
    out, cur = [], ''
    for p in parts:
        if not p:
            continue
        if len(cur) + len(p) <= limit:
            cur += p
        else:
            if cur:
                out.append(cur)
            cur = p if len(p) <= limit else p  # 单句超长也保留，后面按比例切
    if cur:
        out.append(cur)
    # 单块仍超长：按字数硬切
    final = []
    for c in out:
        while len(c) > limit:
            final.append(c[:limit])
            c = c[limit:]
        if c:
            final.append(c)
    return final


def fit_captions(text, seg_dur, min_hold=1.8, limit=18, cps=5.5):
    """把一段文案切成字幕，并返回每条的停留时长。
    两条约束（来源：lemo-opuscar 的 STYLE.md §4 阅读时间规则）：
      1. 一条至少停 min_hold 秒，否则一闪而过；
      2. 一条至少停 字数/语速 秒，否则读不完。
    做法：按标点切到 ≤limit 字；若各条所需时长之和超过这段的时长，就**合并最短的相邻对**
    直到放得下；最后按"所需时长"加权分配，而不是按字数——按字数分会让 6 字的短句只拿到 1.2s。
    **不需要 +0.6 缓冲**：本仓字幕与配音同步，N 字就是说 N/5.5 秒，加缓冲永远不成立。
    """
    chunks = split_caption(text, limit)
    while len(chunks) > 1:
        need = [max(min_hold, len(c) / cps) for c in chunks]
        if sum(need) <= seg_dur + 1e-6:
            break
        k = min(range(len(chunks) - 1), key=lambda i: len(chunks[i]) + len(chunks[i + 1]))
        chunks[k:k + 2] = [chunks[k] + chunks[k + 1]]
    need = [max(min_hold, len(c) / cps) for c in chunks]
    total = sum(need) or 1
    return [(c, seg_dur * n / total) for c, n in zip(chunks, need)]


def main():
    d = json.load(open(os.path.join(HERE, 'script.json'), encoding='utf-8'))
    beats = d['beats']
    for b in beats:
        b['dur'] = dur(os.path.join(HERE, 'audio', b['id'] + '.mp3'))

    # ── 时间轴 ──
    t = 0.0
    for b in beats:
        b['t0'] = round(t, 2)
        b['t1'] = round(t + b['dur'], 2)
        t = b['t1'] + GAP
    total = round(t - GAP, 2)          # 最后一段不加尾间隔

    # ── 字幕（按字数比例分配每段时长）──
    captions = []
    for b in beats:
        t_cur = b['t0']
        for c, hold in fit_captions(b['text'], b['t1'] - b['t0']):
            captions.append({'start': round(t_cur, 2), 'end': round(t_cur + hold, 2), 'text': c})
            t_cur += hold

    # ── 画面：每拍一个 paper scene ──
    A = lambda b, k=0: round(b['t0'] + k, 2)
    scenes = []

    b = beats[0]
    scenes.append({'type': 'hero', 't0': b['t0'], 't1': b['t1'], 'args': {
        'lines': [['一个班 23 个人，', A(b, 0.7)], ['有人*同一天生日*', A(b, 3.4)]],
        'cast': '23 人', 'sub': '// 概率 · 反直觉'}})

    b = beats[1]
    scenes.append({'type': 'point', 't0': b['t0'], 't1': b['t1'], 'args': {
        'cast': '悖论', 'words': [['名字叫', A(b, 0.5)], ['*生日悖论*', A(b, 1.9), 'slam']],
        'cards': [['不是矛盾', A(b, 4.2)], ['是直觉算错', A(b, 5.6)], ['错在问法', A(b, 7.0)]]}})

    b = beats[2]
    # 用点阵而不是环形计数器：253 这个数字，看 253 个点比看一个"253"更有体感。
    # stagger 铺满整段（15s），点逐个落下本身就是持续动画，不会出静止画面。
    n_pts = 11 * 23
    scenes.append({'type': 'grid', 't0': b['t0'], 't1': b['t1'], 'args': {
        'cast': '253 对', 'title': '二十三个人，两两配对',
        'rows': 11, 'cols': 23, 'gap': 30, 'size': 9, 'origin': [300, 392],
        'at': A(b, 0.7), 'stagger': round((b['t1'] - b['t0'] - 1.2) / n_pts, 4),
        'highlight': [[0, 0], [4, 8], [10, 22]],
        'exception': [5, 11],
        'note': '23 × 22 ÷ 2 = 253 对', 'noteSize': 44}})

    b = beats[3]
    n = 5
    step_gap = (b['t1'] - b['t0'] - 2.0) / max(1, n - 1)
    scenes.append({'type': 'steps', 't0': b['t0'], 't1': b['t1'], 'args': {
        'cast': '倒着算', 'title': '正确算法：倒过来算',
        'steps': [
            ['都不同', A(b, 0.6)],
            ['避开前一个', A(b, 0.6 + step_gap)],
            ['避开前两个', A(b, 0.6 + step_gap * 2)],
            ['乘到第 23 个', A(b, 0.6 + step_gap * 3)],
            ['再用 1 去减', A(b, 0.6 + step_gap * 4)],
        ]}})

    b = beats[4]
    scenes.append({'type': 'quote', 't0': b['t0'], 't1': b['t1'], 'args': {
        'cast': '一个·所有', 'lines': ['直觉算的是*一个人*', '答案问的是*所有人*'], 'at': A(b, 0.7), 'by': '生日悖论'}})

    b = beats[5]
    scenes.append({'type': 'number', 't0': b['t0'], 't1': b['t1'], 'args': {
        'cast': '99%', 'label': '57 个人里，至少一对同生日', 'at': A(b, 1.0), 'from': 0, 'value': 99,
        'unit': '%', 'dur': 2.4, 'sub': '23 人 50.7% · 41 人 90.3% · 57 人 99.0%'}})

    b = beats[6]
    scenes.append({'type': 'compare', 't0': b['t0'], 't1': b['t1'], 'args': {
        'cast': '差在哪', 'left': {'title': '直觉', 'items': ['一年 365 天', '23 人怎么可能', '估不到 10%']},
        'right': {'title': '实际', 'items': ['253 对组合', '23 人 50.7%', '57 人 99.0%']},
        'leftAt': A(b, 0.6), 'rightAt': A(b, 1.6), 'strikeAt': A(b, 3.2), 'stamp': '差在问法'}})

    b = beats[7]
    scenes.append({'type': 'point', 't0': b['t0'], 't1': b['t1'], 'args': {
        'cast': '多少对', 'words': [['看到巧合，', A(b, 0.5)], ['先问*多少对*', A(b, 1.6), 'slam']],
        'cards': [['不是运气', A(b, 3.0)], ['是配对数', A(b, 4.0)], ['组合在放大', A(b, 5.0)]]}})

    b = beats[8]
    scenes.append({'type': 'outro', 't0': b['t0'], 't1': b['t1'], 'args': {
        'cast': '回问', 'title': '回问',
        'lines': ['你上学那个班，有没有两个人同一天生日？', '现在你知道，它比你以为的常见得多'],
        'prompt': '把这个概率问题讲给一个朋友听'}})

    # 音效事件：拍间 whoosh + 数字段 tick + 开场 impact。
    # 只挂在**拍边界**（不是拆段边界），否则一屏内会连响三次。
    # 用 earshot 的**配方音效**（真 DSP），不是内置合成音：内置的 impact/whoosh/tick 是
    # 几条正弦+噪声，塑料感明显；earshot 的是 FORGE 配方，质感差一档。
    #   pro_impact/short 0.67s 峰值 0.18  → 开场
    #   swish/soft       0.88s 峰值 0.11  → 拍间
    #   click/soft       0.09s 峰值 0.004 → 数字段（极轻，gain 要大）
    # 峰值差 40 倍，所以每条音效单独给 gain，不能统一。
    cues = [{'at': 0.0, 'src': 'pro_impact/short', 'gain': 0.34}]
    for b in beats[1:]:
        cues.append({'at': round(b['t0'], 2), 'src': 'swish/soft', 'gain': 0.28})
    for sc in scenes:
        if sc['type'] == 'number':
            cues.append({'at': round(sc['t0'] + 0.8, 2), 'src': 'click/soft', 'gain': 1.5})
    cues.sort(key=lambda c: c['at'])

    params = {
        'brand': {'name': 'birthday-paradox'},
        'audio': {'cues': cues},
        'accent': '#E8503A',
        'accent2': '#2F6F8F',
        'durationSeconds': total,
        'fps': FPS,
        'scenes': scenes,
        'captions': captions,
    }
    # 无论哪种模式都先存一份绝对版：bgm.py 与字幕生成要读 t0/t1
    json.dump(params, open(os.path.join(HERE, 'params-abs.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    # --chain：输出链式声明（from: "@prev+GAP"），只改第一段的 for 就能带动整条时间轴。
    # 字幕仍是绝对时间——它们在同一段内按字数比例分布，链式表达不了。
    if '--chain' in sys.argv:
        prev = None
        for sc in scenes:
            seg_dur = round(sc['t1'] - sc['t0'], 4)      # 别叫 dur：会和上面的 dur() 函数撞名
            sc['from'] = 0.0 if prev is None else f'@prev+{GAP}'
            sc['for'] = seg_dur
            del sc['t0'], sc['t1']
            prev = sc
        params['durationSeconds'] = '@last+0.02'
        out = os.path.join(HERE, 'params-chain.json')
    else:
        out = os.path.join(HERE, 'params.json')
    json.dump(params, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


    # ── 音轨：每段后补 GAP 静音，与时间轴严格一致 ──
    inputs, filters = [], []
    for i, b in enumerate(beats):
        inputs += ['-i', os.path.join(HERE, 'audio', b['id'] + '.mp3')]
        filters.append(f'[{i}:a]aresample=48000,aformat=channel_layouts=mono,'
                       f'apad=pad_dur={GAP}[a{i}]')
    chain = ''.join(f'[a{i}]' for i in range(len(beats)))
    filters.append(f'{chain}concat=n={len(beats)}:v=0:a=1,'
                   f'atrim=0:{total}[out]')
    wav = os.path.join(HERE, 'audio', 'vo.wav')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *inputs,
                    '-filter_complex', ';'.join(filters), '-map', '[out]',
                    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', wav], check=True)

    print(f'✓ {out}')
    print(f'  {len(scenes)} 段 · {len(captions)} 条字幕 · {total}s · 音轨 {dur(wav):.2f}s')
    print(f'  首段 {beats[0]["t0"]}–{beats[0]["t1"]}s · 末段 {beats[-1]["t0"]}–{beats[-1]["t1"]}s')


if __name__ == '__main__':
    main()
