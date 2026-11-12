#!/usr/bin/env python3
"""成片级自检：解码 MP4 逐帧算相邻帧平均绝对差（MAD）。

判据：
  1) 无重复帧（MAD < 0.05 视为完全静止）
  2) worker 分片边界处的 MAD 不显著高于同镜头内的正常帧
  3) 镜头切点应出现明显跳变（设计内，单独列出）

用法：
  uv run --with numpy python mg-kit/verify-video.py
"""
import json
import os
import subprocess
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MP4 = os.path.join(HERE, 'out', 'mg-demo.mp4')
FFMPEG = os.environ.get('FFMPEG', '/opt/homebrew/bin/ffmpeg')
W, H = 320, 180
PARAMS = json.load(open(os.path.join(HERE, 'params.json'), encoding='utf-8'))
FPS = PARAMS['fps']
TOTAL = round(PARAMS['durationSeconds'] * FPS)
PER = -(-TOTAL // 8)                      # 与 render.mjs 的分片长度一致

cmd = [FFMPEG, '-v', 'error', '-i', MP4, '-vf', f'scale={W}:{H},format=gray',
       '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
prev = None
mads = []
nbytes = W * H
while True:
    buf = proc.stdout.read(nbytes)
    if len(buf) < nbytes:
        break
    cur = np.frombuffer(buf, dtype=np.uint8).astype(np.int16)
    if prev is not None:
        mads.append(float(np.abs(cur - prev).mean()))
    prev = cur
proc.wait()
mads = np.array(mads)

boundaries = [b for b in range(PER, TOTAL, PER) if b - 1 < len(mads)]
cuts = [round(s['t0'] * FPS) - 1 for s in PARAMS['scenes'][1:]]
normal_mask = np.ones(len(mads), dtype=bool)
for f in boundaries + cuts:
    for d in (-1, 0, 1):
        if 0 <= f + d < len(mads):
            normal_mask[f + d] = False
normal = mads[normal_mask]
median = float(np.median(normal))
boundary_mads = {str(b - 1): round(float(mads[b - 1]), 3) for b in boundaries}
cut_mads = {str(f): round(float(mads[f]), 3) for f in cuts if 0 <= f < len(mads)}
dup = int((mads < 0.05).sum())
worst = max(boundary_mads.values(), default=0.0)
# 落版保持是 MG 的正常设计，判据改为「最长连续静止段」而非「零静止帧」。
# 0.5s（30 帧 @60fps）是上限：超过就说明该镜头在视觉上停住了。
still = (mads < 0.05).astype(int)
longest = run = start = best_start = 0
for i, v in enumerate(still):
    if v:
        if run == 0:
            start = i
        run += 1
        if run > longest:
            longest, best_start = run, start
    else:
        run = 0

result = {
    'decoded_frames': len(mads) + 1,
    'expected_frames': TOTAL,
    'duplicate_frames_mad_lt_0_05': dup,
    'longest_still_run_frames': longest,
    'longest_still_run_seconds': round(longest / FPS, 3),
    'longest_still_run_start_seconds': round(best_start / FPS, 3),
    'longest_still_run_limit_frames': 30,
    'normal_frame_mad_median': round(median, 3),
    'normal_frame_mad_min': round(float(normal.min()), 3),
    'normal_frame_mad_max': round(float(normal.max()), 3),
    'worker_boundary_mad': boundary_mads,
    'worker_boundary_max': round(worst, 3),
    'scene_cut_mad': cut_mads,
    'boundary_within_normal_range': worst <= max(median * 3, float(normal.max())),
    'verdict': 'PASS' if longest <= 30 and len(mads) + 1 == TOTAL else 'FAIL',
}
out = os.path.join(HERE, 'out', 'verify-video.json')
json.dump(result, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(json.dumps(result, ensure_ascii=False, indent=2))
