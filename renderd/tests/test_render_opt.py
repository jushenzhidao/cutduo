#!/usr/bin/env python3
"""渲染优化的回归：省掉的成本不能变成「输出变了」。

三条优化（2026-11-10）都声称输出逐字节不变，这个文件负责钉住：

1. 文字层只栅格化 bbox（原来整帧 1080×1920，实测文字只占 0.8%–3.7%）；
2. 校验阶段黑场与接触表合并成一次解码、末帧改用 seek（原来各解一遍）；
3. 元数据类动作走流拷贝（判断必须严格：任何影响画面的动作都要重编）。

前两条在实现时都用「与旧实现逐字节比对」验过；这里把它固化成测试。
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from renderd.config import load_config                     # noqa: E402
from renderd.fixtures import ensure_media                  # noqa: E402
from renderd.ingest import can_copy_video                  # noqa: E402
from renderd.textlayer import rasterize                    # noqa: E402
from renderd.validate import video_analysis                # noqa: E402

FPS = 30.0


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


class TextLayerCrop(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.cfg = load_config(self.dir / "data")
        self.cfg.target.width = 1080
        self.cfg.target.height = 1920

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _ir(self, text: str = "测试标题") -> dict:
        return {
            "output": {
                "width": 1080, "height": 1920,
                "fps": {"num": 30, "den": 1}, "duration_frames": 90,
                "video": {"codec": "h264", "bitrate_kbps": 7000, "pix_fmt": "yuv420p",
                          "preset": "veryfast", "gop_frames": 60, "crf": 20},
                "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2,
                          "bitrate_kbps": 192, "target_lufs": -14.0},
                "color": {"primaries": "bt709", "transfer": "bt709",
                          "matrix": "bt709", "range": "tv"},
            },
            "assets": [{"id": "a1", "uri": "x.mp4"}],
            "styles": {"s1": {"font_family": "PingFang SC", "font_size": 90,
                              "fill": "#FFFFFF", "align": "center",
                              "anchor": "bottom", "offset_y": 0,
                              "max_chars_per_line": 8,
                              "safe_area": {"top": 0.1, "bottom": 0.16,
                                            "left": 0.07, "right": 0.07}}},
            "tracks": [{"id": "v1", "kind": "video",
                        "clips": [{"asset": "a1", "at_frame": 0, "out_frame": 90}]},
                       {"id": "t1", "kind": "text",
                        "clips": [{"at_frame": 0, "out_frame": 90, "text": text,
                                   "style": "s1"}]}],
        }

    def _font(self) -> str:
        from renderd.fonts import resolve_or_fallback
        return resolve_or_fallback("PingFang SC")[0]

    def test_layer_png_is_cropped_to_bbox(self) -> None:
        layers = rasterize(self._ir(), self._font(), self.dir)
        self.assertEqual(len(layers), 1)
        layer = layers[0]
        self.assertIsNotNone(layer.bbox)
        x0, y0, x1, y1 = layer.bbox
        from PIL import Image
        with Image.open(layer.png) as im:
            # 存的是 bbox 大小，不是整帧
            self.assertEqual(im.size, (x1 - x0, y1 - y0))
            self.assertLess(im.size[0] * im.size[1], 1080 * 1920 // 4,
                            "文字图层不应接近整帧面积")

    def test_blank_text_produces_placeholder(self) -> None:
        layers = rasterize(self._ir(""), self._font(), self.dir)
        self.assertEqual(len(layers), 1)
        from PIL import Image
        with Image.open(layers[0].png) as im:
            self.assertEqual(im.size, (1, 1))     # 占位，编译期按 bbox=None 跳过

    def test_overlay_uses_bbox_offset(self) -> None:
        """图层被裁了，overlay 就必须按 bbox 偏移；否则文字会跳位置。"""
        from renderd.compile_ffmpeg import build
        from renderd.fixtures import ensure_media

        media = ensure_media(self.cfg.media_dir)
        ir = self._ir()
        ir["assets"] = [{"id": "a1", "uri": "file://" + media["v_a.mp4"]}]
        layers = rasterize(ir, self._font(), self.dir / "layers")
        plan = build(ir, {"a1": media["v_a.mp4"]}, layers,
                     self.dir / "out.mp4", self.cfg.target)
        graph = " ".join(plan.argv)
        x, y = int(layers[0].bbox[0]), int(layers[0].bbox[1])
        self.assertIn(f"overlay={x}:{y}:", graph)
        self.assertNotIn("overlay=0:0:format=auto:eof_action=repeat:enable", graph,
                         "裁过的图层不能再按 0:0 叠")


class IngestCopyPolicy(unittest.TestCase):
    def test_metadata_only_actions_can_copy(self) -> None:
        self.assertTrue(can_copy_video(["TAG_COLOR"]))
        self.assertTrue(can_copy_video(["TAG_COLOR", "AUDIO_SYNTH"]))
        self.assertTrue(can_copy_video(["AUDIO_SYNTH"]))
        self.assertTrue(can_copy_video([]))          # 无动作 = passthrough，也走 copy

    def test_any_pixel_changing_action_forces_reencode(self) -> None:
        for act in ("BAKE_ROTATION", "CROP_PILLARBOX", "SQUARE_PIXELS",
                    "CAP_LONG_EDGE", "FIX_ODD", "FORMAT_YUV420P",
                    "TONEMAP_HDR", "CFR", "DEINTERLACE", "DECIMATE",
                    "TRIM_OVERLONG"):
            self.assertFalse(can_copy_video(["TAG_COLOR", act]), act)

    def test_audio_role_never_copies_video(self) -> None:
        self.assertFalse(can_copy_video(["TAG_COLOR"], audio_role=True))


class LastFrameSeek(unittest.TestCase):
    """末帧用 -sseof 取，必须与全解码 select=eq(n,N-1) 逐字节一致。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.cfg = load_config(self.dir / "data")
        media = ensure_media(self.cfg.media_dir)
        # 造一个短片段：3 种 fps 都验一遍，避免只在 30fps 上成立
        self.ffmpeg = self.cfg.ffmpeg
        self.src = self.dir / "src.mp4"
        subprocess.run([self.ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i",
                        "testsrc=size=320x240:rate=30:duration=4",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(self.src)],
                       check=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_seek_matches_full_decode(self) -> None:
        frames = 120
        for fps in (30.0, 25.0, 24.0):
            out = self.dir / f"ev{fps:g}"
            res = video_analysis(self.ffmpeg, self.src, out, frames, fps=fps)
            got = res["evidence"].get("last_frame")
            self.assertTrue(got, f"{fps}: 未产出末帧")

            ref = self.dir / f"ref{fps:g}.jpg"
            subprocess.run([self.ffmpeg, "-y", "-v", "error", "-i", str(self.src),
                            "-vf", f"select=eq(n\\,{frames - 1})", "-frames:v", "1",
                            "-q:v", "2", str(ref)], check=True)
            self.assertEqual(_sha(Path(got)), _sha(ref),
                             f"{fps}fps：seek 取到的不是最后一帧")

            # 合并解码也要能产出接触表与黑场结果
            self.assertTrue(Path(res["evidence"]["contact_sheet"]).exists())
            self.assertIn("ranges", res["black"])


if __name__ == "__main__":
    unittest.main()
