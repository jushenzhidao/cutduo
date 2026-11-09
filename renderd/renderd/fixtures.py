"""测试与本地演示用的合成素材。全部 lavfi 生成，无版权风险，可确定性复现。"""

from __future__ import annotations

import subprocess
from pathlib import Path

FIXTURES = {
    # name: (lavfi 视频源, 时长秒, 可选音频)
    "v_a.mp4": ("testsrc2=s=540x960:r=30:d=8", 8, True),
    "v_b.mp4": ("smptebars=s=720x480:r=30:d=10", 10, True),
    "v_c.mp4": ("testsrc2=s=540x960:r=30:d=8,hue=h=200", 8, True),
    "music.m4a": (None, 10, True),
    "tall.mp4": ("testsrc2=s=1080x1920:r=30:d=8", 8, True),
}


def ensure_media(media_dir: Path, names: list[str] | None = None) -> dict[str, str]:
    media_dir.mkdir(parents=True, exist_ok=True)
    out: dict[str, str] = {}
    for name, (src, dur, with_audio) in FIXTURES.items():
        if names and name not in names:
            continue
        p = media_dir / name
        if p.exists():
            out[name] = str(p.resolve())
            continue
        cmd = ["ffmpeg", "-y", "-v", "error"]
        if src is None:
            cmd += ["-f", "lavfi", "-i", f"sine=f=330:r=48000:d={dur}",
                    "-c:a", "aac", "-b:a", "160k", str(p)]
        else:
            cmd += ["-f", "lavfi", "-i", src]
            if with_audio:
                cmd += ["-f", "lavfi", "-i", f"sine=f=440:r=48000:d={dur}"]
            cmd += ["-map", "0:v:0"]
            if with_audio:
                cmd += ["-map", "1:a:0"]
            cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
                    "-pix_fmt", "yuv420p",
                    "-colorspace", "bt709", "-color_primaries", "bt709",
                    "-color_trc", "bt709", "-color_range", "tv",
                    "-x264-params",
                    "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv"]
            if with_audio:
                cmd += ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest"]
            cmd += [str(p)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"生成素材失败 {name}: {r.stderr[-500:]}")
        out[name] = str(p.resolve())
    return out
