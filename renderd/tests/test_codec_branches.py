"""编码分支（h264 / hevc / av1）的常驻断言。

这三条分支此前只有 h264 走过完整回归 —— hevc/av1 属于「代码里写了、从没人跑」。
本文件钉住两件事：

  1. MP4 的 codec tag 必须是播放器认的值：hevc 默认写成 `hev1`，
     而 Safari / QuickTime / iOS 只认 `hvc1`，拿到 hev1 直接不播。
  2. 缓存键必须随编码参数与编译器版本变化，否则「改了参数却仍返回旧产物」。

第 2 条不是假想：HEVC tag 从 hev1 改成 hvc1 时，IR 一个字段都没动，
缓存键不变，线上会继续拿到旧的 hev1 成片。
"""

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from renderd import compile_ffmpeg, ir as IR          # noqa: E402
from renderd.config import load_config               # noqa: E402
from renderd.templates import TemplateRegistry       # noqa: E402

FFMPEG = os.environ.get("RENDERD_FFMPEG", "ffmpeg")


def _has_encoder(name: str) -> bool:
    try:
        out = subprocess.run([FFMPEG, "-hide_banner", "-encoders"],
                             capture_output=True, text=True, timeout=30).stdout
    except Exception:                                  # noqa: BLE001
        return False
    return f" {name} " in out


HAVE_X265 = _has_encoder("libx265")
HAVE_AV1 = _has_encoder("libsvtav1")


def _plan(codec: str, preset: str = "veryfast") -> tuple[list[str], dict]:
    """构造一份最小 IR 并编译成 argv。不渲染，只看命令。"""
    from helpers import Sandbox

    s = Sandbox(f"codec-args-{codec}")
    try:
        reg = TemplateRegistry(s.cfg.template_dir)
        ir = reg.instantiate("hook_vertical_6s", {"clip": "a0", "hook": "编码"},
                             s.assets("v_a.mp4"))
        ir["output"]["video"]["codec"] = codec
        ir["output"]["video"]["preset"] = preset
        norm = IR.normalize(ir)
        plan = compile_ffmpeg.build(
            norm, {"a0": str(s.media["v_a.mp4"])}, [], s.dir / "o.mp4",
            s.cfg.target, threads=2, ffmpeg=FFMPEG)
        return plan.argv, norm
    finally:
        s.service.store.close_thread_connection()
        s.cleanup()


class TestCompileArgs(unittest.TestCase):
    """不渲染，只断言 argv 与指纹。跑得快，每次 CI 都跑。"""

    def test_01_h264_tag_is_avc1(self) -> None:
        argv, _ = _plan("h264")
        i = argv.index("-tag:v")
        self.assertEqual(argv[i + 1], "avc1")

    @unittest.skipUnless(HAVE_X265, "ffmpeg 未编译 libx265")
    def test_02_hevc_tag_is_hvc1_not_hev1(self) -> None:
        """hev1 是 ffmpeg 的默认值，但 Apple 生态不认 —— 必须显式改成 hvc1。"""
        argv, _ = _plan("hevc")
        i = argv.index("-tag:v")
        self.assertEqual(argv[i + 1], "hvc1")
        self.assertNotIn("hev1", argv)

    @unittest.skipUnless(HAVE_AV1, "ffmpeg 未编译 libsvtav1")
    def test_03_av1_tag_is_av01(self) -> None:
        argv, _ = _plan("av1")
        i = argv.index("-tag:v")
        self.assertEqual(argv[i + 1], "av01")

    def test_04_signature_differs_by_codec(self) -> None:
        sigs = {c: compile_ffmpeg.encoder_signature(_ir_of(c)) for c in
                ("h264", "hevc", "av1")}
        self.assertEqual(len(set(sigs.values())), 3, sigs)

    def test_05_signature_includes_compile_rev(self) -> None:
        """改 argv 构造方式时 bump COMPILE_REV；签名必须跟着变。

        没有这一条，「代码变了、IR 没变」仍会命中旧缓存 —— 本次 tag 修复正是这种情况。
        """
        ir = _ir_of("h264")
        before = compile_ffmpeg.encoder_signature(ir)
        saved = compile_ffmpeg.COMPILE_REV
        try:
            compile_ffmpeg.COMPILE_REV = saved + 1
            after = compile_ffmpeg.encoder_signature(ir)
        finally:
            compile_ffmpeg.COMPILE_REV = saved
        self.assertNotEqual(before, after)

    def test_06_signature_changes_with_preset(self) -> None:
        a = compile_ffmpeg.encoder_signature(_ir_of("h264", "veryfast"))
        b = compile_ffmpeg.encoder_signature(_ir_of("h264", "medium"))
        self.assertNotEqual(a, b)

    def test_07_cache_key_carries_encoder_signature(self) -> None:
        """同一份 IR 换 preset，缓存键必须不同（否则会返回旧产物）。"""
        from renderd.service import Service

        d = Path(f"/tmp/renderd-cachekey-{os.getpid()}")
        svc = Service(load_config(d))
        r = svc.runner
        try:
            k1 = r.cache_key(_ir_of("h264", "veryfast"), [], "ffmpeg")
            k2 = r.cache_key(_ir_of("h264", "medium"), [], "ffmpeg")
            self.assertNotEqual(k1, k2)
            k3 = r.cache_key(_ir_of("h264", "veryfast"), [], "mlt")
            self.assertNotEqual(k1, k3,
                                "backend 必须进缓存键，否则两端产物会互相污染")
        finally:
            svc.store.close_thread_connection()


class TestCodecRender(unittest.TestCase):
    """真渲染：出片 + 断言通过 + 容器里的 tag 正确。"""

    def _render(self, codec: str) -> dict:
        from helpers import Sandbox

        s = Sandbox(f"codec-render-{codec}")
        try:
            reg = TemplateRegistry(s.cfg.template_dir)
            ir = reg.instantiate("hook_vertical_6s",
                                 {"clip": "a0", "hook": f"{codec} 出片"},
                                 s.assets("v_a.mp4"))
            ir["output"]["video"]["codec"] = codec
            out = s.submit({"ir": ir, "idempotency_key": f"codec-render-{codec}-01"})
            s.run_one()
            job = s.service.store.get(out["job_id"])
            self.assertEqual(job["status"], "succeeded", job["error_json"])
            rec = json.loads(job["receipt_json"])
            self.assertEqual(rec["verdict"], "pass", rec["failures"])
            p = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=codec_name,codec_tag_string,nb_frames",
                 "-of", "json", job["output_path"]],
                capture_output=True, text=True)
            return json.loads(p.stdout)["streams"][0]
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()

    @unittest.skipUnless(HAVE_X265, "ffmpeg 未编译 libx265")
    def test_08_hevc_renders_with_hvc1(self) -> None:
        st = self._render("hevc")
        self.assertEqual(st["codec_name"], "hevc")
        self.assertEqual(st["codec_tag_string"], "hvc1")
        self.assertEqual(int(st["nb_frames"]), 180)

    @unittest.skipUnless(HAVE_AV1, "ffmpeg 未编译 libsvtav1")
    def test_09_av1_renders_with_av01(self) -> None:
        st = self._render("av1")
        self.assertEqual(st["codec_name"], "av1")
        self.assertEqual(st["codec_tag_string"], "av01")
        self.assertEqual(int(st["nb_frames"]), 180)


def _ir_of(codec: str, preset: str = "veryfast") -> dict:
    """不启服务的最小 IR，只用于算指纹/缓存键。"""
    return IR.normalize({
        "ir_version": "0.1", "id": f"sig-{codec}-{preset}",
        "output": {
            "width": 1080, "height": 1920,
            "fps": {"num": 30, "den": 1}, "duration_frames": 180,
            "video": {"codec": codec, "bitrate_kbps": 4000, "pix_fmt": "yuv420p",
                      "preset": preset, "gop_frames": 60, "crf": 23},
            "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2,
                      "bitrate_kbps": 128, "target_lufs": -14.0},
            "color": {"primaries": "bt709", "transfer": "bt709",
                      "matrix": "bt709", "range": "tv"},
        },
        "styles": {},
        "assets": [{"id": "a0", "uri": "file:///tmp/none.mp4"}],
        "tracks": [{"id": "v1", "kind": "video",
                    "clips": [{"asset": "a0", "at_frame": 0, "out_frame": 180}]}],
    })


if __name__ == "__main__":
    unittest.main()
