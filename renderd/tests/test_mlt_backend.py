"""MLT 后端：结构断言 + （装了 melt 时）真渲染。

这一轮把 MLT 从「只生成 XML」推进到「melt 能出片」，过程中修了三个会让它
静默出错的问题，每个都在这里钉住：

1. `avformat-novalidate` 不探测时长 → melt 把整条时间线当 1 帧（0.04s 的成片）。
2. 写死 `audio_index=1 / video_index=0` → 纯音频素材（音乐床）直接打不开。
3. 视频轨没有 `hide="audio"` → 视频自带的声音会混进成片，与 ffmpeg 后端不一致；
   多条音频轨只给第一条加 `mix` → 第二条被丢弃。

没有 melt 的环境只跑结构断言；`make test-mlt` 会在 Dockerfile.mlt 的镜像里跑全量。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from renderd import compile_mlt, ir as IR, render      # noqa: E402
from renderd.config import load_config                  # noqa: E402
from renderd.textlayer import Layer                     # noqa: E402


def _ir(tracks: list[dict], frames: int = 60) -> dict:
    return IR.normalize({
        "ir_version": "0.1", "id": "mlt_case",
        "output": {"width": 320, "height": 240, "fps": {"num": 30, "den": 1},
                   "duration_frames": frames,
                   "video": {"codec": "h264", "bitrate_kbps": 1200,
                             "pix_fmt": "yuv420p", "preset": "veryfast",
                             "gop_frames": 30, "crf": 26},
                   "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2,
                             "bitrate_kbps": 96, "target_lufs": -14.0},
                   "color": {"primaries": "bt709", "transfer": "bt709",
                             "matrix": "bt709", "range": "tv"}},
        "styles": {}, "assets": [{"id": "a0", "uri": "file:///clip.mp4"}],
        "tracks": tracks,
    })


class TestMltXml(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="mlt-xml-"))
        self.media = {"a0": str(self.tmp / "clip.mp4")}

    def test_01_uses_probing_producer(self) -> None:
        xml = compile_mlt.build(_ir([{"id": "v1", "kind": "video", "clips": [
            {"asset": "a0", "at_frame": 0, "out_frame": 60}]}]), self.media, [])
        self.assertIn('name="mlt_service">avformat<', xml)
        self.assertNotIn("avformat-novalidate", xml,
                         "novalidate 不探测时长，melt 会把时间线当 1 帧")
        self.assertNotIn("video_index", xml, "写死流索引会让纯音频素材打不开")
        self.assertNotIn("audio_index", xml)

    def test_02_one_mix_per_audio_track(self) -> None:
        tracks = [{"id": "v1", "kind": "video",
                   "clips": [{"asset": "a0", "at_frame": 0, "out_frame": 60}]}]
        for i in range(2):
            tracks.append({"id": f"a{i}", "kind": "audio",
                           "clips": [{"asset": "a0", "at_frame": 0, "out_frame": 60}]})
        xml = compile_mlt.build(_ir(tracks), self.media, [])
        self.assertEqual(xml.count('name="mlt_service">mix<'), 2,
                         "每条音频轨都要一条 mix，否则后几条会被丢弃")

    def test_03_tracks_split_audio_and_video(self) -> None:
        tracks = [{"id": "v1", "kind": "video",
                   "clips": [{"asset": "a0", "at_frame": 0, "out_frame": 60}]},
                  {"id": "a1", "kind": "audio",
                   "clips": [{"asset": "a0", "at_frame": 0, "out_frame": 60}]}]
        xml = compile_mlt.build(_ir(tracks), self.media, [])
        self.assertIn('hide="audio"', xml, "视频轨不能把自己的声音混进来")
        self.assertIn('hide="video"', xml, "音频轨不该输出画面")

    def test_04_text_layer_length_is_frames(self) -> None:
        png = self.tmp / "layer.png"
        png.write_bytes(b"\x89PNG\r\n\x1a\n")
        layer = Layer(track="tx", clip_index=0, at_frame=10, out_frame=40,
                      text="T", png=png, sha256="x", bbox=None, within_safe=True)
        xml = compile_mlt.build(_ir([{"id": "v1", "kind": "video", "clips": [
            {"asset": "a0", "at_frame": 0, "out_frame": 60}]}]), self.media, [layer])
        self.assertIn('name="length">30<', xml, "length 单位是帧，不是时间码")


@unittest.skipUnless(shutil.which(os.environ.get("RENDERD_MELT", "melt")),
                     "未安装 melt（用 Dockerfile.mlt 构建镜像，或 make test-mlt）")
class TestMltRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp(prefix="mlt-render-"))
        cls.clip = cls.tmp / "clip.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
             "-i", "testsrc2=s=320x240:r=30:d=4", "-f", "lavfi",
             "-i", "sine=f=440:r=48000:d=4", "-map", "0:v", "-map", "1:a",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-shortest", str(cls.clip)], check=True)
        cls.cfg = load_config(cls.tmp / "data")
        cls.media = {"a0": str(cls.clip)}

    def _render(self, name: str, tracks: list[dict]) -> tuple[bool, Path]:
        work = self.tmp / name
        work.mkdir(exist_ok=True)
        ir = _ir(tracks)
        xml = work / "timeline.mlt"
        compile_mlt.write(ir, self.media, [], xml)
        plan = compile_mlt.plan(ir, xml, work / "out.mp4", self.cfg)
        res = render.run(plan.argv, timeout=180, cwd=work, expected_frames=60)
        return res.ok, work / "out.mp4"

    def _duration(self, path: Path) -> float:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout.strip()
        return float(out or 0)

    def test_05_renders_full_duration(self) -> None:
        ok, out = self._render("v", [{"id": "v1", "kind": "video", "clips": [
            {"asset": "a0", "at_frame": 0, "out_frame": 60}]}])
        self.assertTrue(ok)
        self.assertAlmostEqual(self._duration(out), 2.0, delta=0.15,
                               msg="novalidate 的老问题会让它只有 1 帧")

    def test_06_two_audio_tracks_are_summed(self) -> None:
        base = [{"id": "v1", "kind": "video", "clips": [
            {"asset": "a0", "at_frame": 0, "out_frame": 60}]}]
        one = base + [{"id": "a1", "kind": "audio", "clips": [
            {"asset": "a0", "at_frame": 0, "out_frame": 60}]}]
        two = one + [{"id": "a2", "kind": "audio", "clips": [
            {"asset": "a0", "at_frame": 0, "out_frame": 60}]}]
        ok1, o1 = self._render("a1", one)
        ok2, o2 = self._render("a2", two)
        self.assertTrue(ok1 and ok2)

        def mean_db(p: Path) -> float:
            log = subprocess.run(
                ["ffmpeg", "-hide_banner", "-i", str(p), "-af", "volumedetect",
                 "-f", "null", "-"], capture_output=True, text=True).stderr
            for line in log.splitlines():
                if "mean_volume" in line:
                    return float(line.split("mean_volume:")[1].split("dB")[0])
            return -99.0

        diff = mean_db(o2) - mean_db(o1)
        self.assertGreater(diff, 3.0,
                           f"两条相同的音轨叠加应约 +6dB，实测 {diff:.1f}dB —— 说明第二条被丢了")


@unittest.skipUnless(shutil.which(os.environ.get("RENDERD_MELT", "melt")),
                     "未安装 melt（用 Dockerfile.mlt 构建镜像，或 make test-mlt）")
class TestMltService(unittest.TestCase):
    def test_07_full_pipeline_with_music_bed(self) -> None:
        """带音乐床的模板走完整服务：MLT 出片 → 响度归一 → 断言 → 回执 pass。

        这一条同时钉住两个只有真跑才会暴露的问题：
        · MLT 没有 LUFS 目标（不补 loudnorm 就会 L3 失败）
        · 音轨到最后一个片段就结束（不补 apad 就会音画不同步）
        """
        from helpers import Sandbox

        s = Sandbox("mlt-svc")
        try:
            out = s.submit({
                "template_id": "brand_vertical_15s",
                "variables": {"clip1": "a0", "clip2": "a1", "clip3": "a2",
                              "title": "音轨验证", "music": "a3"},
                "assets": s.assets("v_a.mp4", "v_b.mp4", "v_c.mp4", "music.m4a"),
                "backend": "mlt",
                "idempotency_key": "mlt-svc-audio-0001",
            })
            s.run_one()
            job = s.service.store.get(out["job_id"])
            self.assertEqual(job["status"], "succeeded", job["error_json"])
            rec = json.loads(job["receipt_json"])
            self.assertEqual(rec["verdict"], "pass", rec["failures"])
            self.assertTrue(rec["L3"]["loudness"]["ok"],
                            rec["L3"]["loudness"])
            self.assertEqual(rec["L1"]["structural"]["frames"], 450)
        finally:
            s.cleanup()


    def test_08_hevc_output_is_tagged_hvc1(self) -> None:
        """melt 写 HEVC 默认是 hev1，Safari/iOS 不认。

        客户要 HEVC 往往就是为了 Apple 端省带宽；tag 不对等于给了一个
        看着成功、实际播不了的成片。
        """
        import subprocess

        from helpers import Sandbox
        from renderd.templates import TemplateRegistry

        s = Sandbox("mlt-hevc")
        try:
            reg = TemplateRegistry(s.cfg.template_dir)
            ir = reg.instantiate("hook_vertical_6s",
                                 {"clip": "a0", "hook": "hevc tag"},
                                 s.assets("v_a.mp4"))
            ir["output"]["video"]["codec"] = "hevc"
            out = s.submit({"ir": ir, "backend": "mlt",
                            "idempotency_key": "mlt-hevc-tag-0001"})
            s.run_one()
            job = s.service.store.get(out["job_id"])
            self.assertEqual(job["status"], "succeeded", job["error_json"])
            p = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=codec_name,codec_tag_string",
                 "-of", "csv=p=0", job["output_path"]],
                capture_output=True, text=True)
            self.assertEqual(p.stdout.strip(), "hevc,hvc1")
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()


    def test_09_volume_becomes_entry_filter(self) -> None:
        """音量在 MLT 里只能挂在 entry 上（没有轨道增益）。

        而且要真的写进去 —— 静默忽略 volume 会让「音乐床压到 0.3」失效，
        客户听到的是原声音量的背景音乐。
        """
        from helpers import Sandbox
        from renderd.templates import TemplateRegistry

        s = Sandbox("mlt-vol")
        try:
            reg = TemplateRegistry(s.cfg.template_dir)
            ir = reg.instantiate("hook_vertical_6s",
                                 {"clip": "a0", "hook": "vol"},
                                 s.assets("v_a.mp4"))
            ir["tracks"].append({"id": "a1", "kind": "audio",
                                 "clips": [{"asset": "a0", "at_frame": 0,
                                            "out_frame": 180, "volume": 0.3}]})
            ir = __import__("renderd.ir", fromlist=["ir"]).normalize(ir)
            xml = s.dir / "vol.mlt"
            import renderd.compile_mlt as cm
            cm.write(ir, {"a0": str(s.media["v_a.mp4"])}, [], xml)
            body = xml.read_text()
            self.assertIn('name="mlt_service">volume', body)
            self.assertIn('name="level">0.3000', body)
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()


if __name__ == "__main__":
    unittest.main()
