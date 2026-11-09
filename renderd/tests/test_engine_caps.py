"""引擎能力：转场 / 音量 / 字幕 / 多轨 alpha。

四件事都是「内容生产必须有」的能力。每个能力分两层断言：

  · 结构层（快）：IR 校验拦不拦得住错，argv 里有没有对应滤镜
  · 渲染层（慢）：效果是否真的出现在成片里 —— 这一层才是「能不能用」的证据

渲染层的判据都选**可量化**的，不靠肉眼：
  · 转场：转场中点应接近 A/B 各半（0.2–0.8 倍全差异），而不是 A 或 B 本身
  · 音量：0.25 增益应比 1.0 低约 12dB（20·log10(0.25) = -12.04）
  · 字幕：字幕时段有近白像素、非字幕时段没有
  · alpha：叠加后底层纹理仍在（G 通道仍有方差），而不是被纯色遮死
"""

import json
import os
import statistics
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from renderd import compile_ffmpeg, ir as IR, subtitles       # noqa: E402

FFMPEG = os.environ.get("RENDERD_FFMPEG", "ffmpeg")
W, H, FPS, TOTAL = 540, 960, 30, 180


def _ir(tracks, assets, *, lufs=-14.0, styles=None, total=TOTAL):
    return {"ir_version": "0.1", "id": "caps_probe",
            "output": {"width": W, "height": H,
                       "fps": {"num": FPS, "den": 1}, "duration_frames": total,
                       "video": {"codec": "h264", "bitrate_kbps": 3000,
                                 "pix_fmt": "yuv420p", "preset": "veryfast",
                                 "gop_frames": 30, "crf": 22},
                       "audio": {"codec": "aac", "sample_rate": 48000,
                                 "channels": 2, "bitrate_kbps": 128,
                                 "target_lufs": lufs},
                       "color": {"primaries": "bt709", "transfer": "bt709",
                                 "matrix": "bt709", "range": "tv"}},
            "styles": styles or {},
            "assets": assets, "tracks": tracks}


def _video(clips):
    return {"id": "v1", "kind": "video", "clips": clips}


def _audio(clip):
    return {"id": "a1", "kind": "audio", "clips": [clip]}


class TestIrRules(unittest.TestCase):
    def test_01_transition_must_overlap_previous(self) -> None:
        bad = _ir([_video([{"asset": "a0", "at_frame": 0, "out_frame": 60},
                           {"asset": "a0", "at_frame": 60, "out_frame": 180,
                            "transition_in": {"type": "fade", "frames": 10}}])],
                  [{"id": "a0", "uri": "file:///x.mp4"}])
        self.assertIn("tracks[0].clips[1].at_frame",
                      [p.field for p in IR.validate(bad)])

    def test_02_first_clip_cannot_transition(self) -> None:
        bad = _ir([_video([{"asset": "a0", "at_frame": 0, "out_frame": 180,
                            "transition_in": {"type": "fade", "frames": 5}}])],
                  [{"id": "a0", "uri": "file:///x.mp4"}])
        self.assertIn("tracks[0].clips[0].transition_in",
                      [p.field for p in IR.validate(bad)])

    def test_03_unknown_transition_rejected(self) -> None:
        bad = _ir([_video([{"asset": "a0", "at_frame": 0, "out_frame": 60},
                           {"asset": "a0", "at_frame": 50, "out_frame": 180,
                            "transition_in": {"type": "zoomin", "frames": 10}}])],
                  [{"id": "a0", "uri": "file:///x.mp4"}])
        self.assertIn("tracks[0].clips[1].transition_in.type",
                      [p.field for p in IR.validate(bad)])

    def test_04_transition_longer_than_clip_rejected(self) -> None:
        # 第二段只有 10 帧，却要求 10 帧转场 —— 等于整段都在转场，没有内容
        bad = _ir([_video([{"asset": "a0", "at_frame": 0, "out_frame": 60},
                           {"asset": "a0", "at_frame": 50, "out_frame": 60,
                            "transition_in": {"type": "fade", "frames": 10}},
                           {"asset": "a0", "at_frame": 60, "out_frame": 180}])],
                  [{"id": "a0", "uri": "file:///x.mp4"}])
        self.assertIn("tracks[0].clips[1].transition_in.frames",
                      [p.field for p in IR.validate(bad)])

    def test_05_volume_only_on_audio(self) -> None:
        bad = _ir([_video([{"asset": "a0", "at_frame": 0, "out_frame": 180,
                            "volume": 0.5}])],
                  [{"id": "a0", "uri": "file:///x.mp4"}])
        self.assertIn("tracks[0].clips[0].volume",
                      [p.field for p in IR.validate(bad)])

    def test_06_subtitle_needs_subtitle_asset(self) -> None:
        bad = _ir([_video([{"asset": "a0", "at_frame": 0, "out_frame": 180}]),
                   {"id": "sb", "kind": "subtitle",
                    "clips": [{"asset": "a0", "style": "s",
                               "at_frame": 0, "out_frame": 180}]}],
                  [{"id": "a0", "uri": "file:///x.mp4"}],
                  styles={"s": {"font_family": "Noto Sans CJK SC",
                                "font_size": 32, "fill": "#FFFFFF"}})
        self.assertIn("tracks[1].clips[0].asset",
                      [p.field for p in IR.validate(bad)])


class TestSubtitleParsing(unittest.TestCase):
    SRT = ("1\n00:00:00,500 --> 00:00:02,000\n第一句\n\n"
           "2\n00:00:02,500 --> 00:00:04,250\n第二句\n换行\n")

    def test_07_parses_srt_with_multiline(self) -> None:
        cues = subtitles.parse_cues(self.SRT)
        self.assertEqual(len(cues), 2)
        self.assertAlmostEqual(cues[0][0], 0.5)
        self.assertAlmostEqual(cues[1][1], 4.25)
        self.assertEqual(cues[1][2], "第二句\n换行")

    def test_08_parses_vtt_and_strips_tags(self) -> None:
        vtt = ("WEBVTT\n\nNOTE 注释块\n\n"
               "00:00:01.000 --> 00:00:03.000 align:start\n"
               "<i>斜体</i>与{\\an8}覆盖码\n")
        cues = subtitles.parse_cues(vtt)
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0][2], "斜体与覆盖码")

    def test_09_file_without_timecode_is_rejected(self) -> None:
        from renderd.errors import JobError

        p = Path(f"/tmp/empty_{os.getpid()}.srt")
        p.write_text("纯文本，没有时间码\n", encoding="utf-8")
        try:
            with self.assertRaises(JobError):
                subtitles.read_cues(p)
        finally:
            p.unlink(missing_ok=True)


class TestCompiledGraph(unittest.TestCase):
    """只看 argv：结构对不对，跑得快。"""

    def _argv(self, ir):
        from helpers import Sandbox

        s = Sandbox("caps-argv")
        try:
            norm = IR.normalize(ir)
            media = {a["id"]: str(s.media["v_a.mp4"]) for a in norm["assets"]
                     if a.get("kind") != "subtitle"}
            return compile_ffmpeg.build(norm, media, [], s.dir / "o.mp4",
                                        s.cfg.target, threads=2).argv
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()

    def test_10_transition_compiles_to_xfade(self) -> None:
        argv = self._argv(_ir(
            [_video([{"asset": "a0", "at_frame": 0, "out_frame": 60},
                     {"asset": "a0", "at_frame": 50, "out_frame": 180,
                      "transition_in": {"type": "fade", "frames": 10}}])],
            [{"id": "a0", "uri": "file:///x.mp4"}]))
        graph = argv[argv.index("-filter_complex") + 1]
        self.assertIn("xfade=transition=fade", graph)
        self.assertIn("duration=0.333333", graph)     # 10 帧 @30fps
        self.assertIn("offset=1.666667", graph)       # 50 帧
        self.assertNotIn("concat", graph)

    def test_11_no_transition_still_uses_concat(self) -> None:
        argv = self._argv(_ir(
            [_video([{"asset": "a0", "at_frame": 0, "out_frame": 60},
                     {"asset": "a0", "at_frame": 60, "out_frame": 180}])],
            [{"id": "a0", "uri": "file:///x.mp4"}]))
        graph = argv[argv.index("-filter_complex") + 1]
        self.assertIn("concat=n=2", graph)
        self.assertNotIn("xfade", graph)

    def test_12_volume_emits_volume_filter(self) -> None:
        argv = self._argv(_ir(
            [_video([{"asset": "a0", "at_frame": 0, "out_frame": 180}]),
             _audio({"asset": "a0", "at_frame": 0, "out_frame": 180,
                     "volume": 0.25})],
            [{"id": "a0", "uri": "file:///x.mp4"}]))
        graph = argv[argv.index("-filter_complex") + 1]
        self.assertIn("volume=0.2500", graph)

    def test_13_lufs_null_skips_loudnorm(self) -> None:
        argv = self._argv(_ir(
            [_video([{"asset": "a0", "at_frame": 0, "out_frame": 180}]),
             _audio({"asset": "a0", "at_frame": 0, "out_frame": 180})],
            [{"id": "a0", "uri": "file:///x.mp4"}], lufs=None))
        graph = argv[argv.index("-filter_complex") + 1]
        self.assertNotIn("loudnorm", graph)
        self.assertIn("apad", graph)

    def test_14_overlay_track_keeps_alpha(self) -> None:
        argv = self._argv(_ir(
            [_video([{"asset": "a0", "at_frame": 0, "out_frame": 180}]),
             {"id": "o1", "kind": "overlay",
              "clips": [{"asset": "a1", "at_frame": 0, "out_frame": 180}]}],
            [{"id": "a0", "uri": "file:///x.mp4"},
             {"id": "a1", "uri": "file:///x.mov"}]))
        graph = argv[argv.index("-filter_complex") + 1]
        self.assertIn("format=yuva420p", graph)


class TestFitBlur(unittest.TestCase):
    """横版素材上竖版：cover 会裁掉两侧，blur 用模糊背景保住完整画面。"""

    def _argv(self, fit):
        from helpers import Sandbox

        s = Sandbox(f"caps-fit-{fit}")
        try:
            ir = _ir([_video([{"asset": "a0", "at_frame": 0, "out_frame": 180,
                               "fit": fit}])],
                     [{"id": "a0", "uri": "file:///x.mp4"}])
            norm = IR.normalize(ir)
            return compile_ffmpeg.build(norm, {"a0": str(s.media["v_a.mp4"])},
                                        [], s.dir / "o.mp4", s.cfg.target,
                                        threads=2).argv
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()

    def test_19_blur_compiles_to_split_and_boxblur(self) -> None:
        graph = self._argv("blur")
        graph = graph[graph.index("-filter_complex") + 1]
        self.assertIn("split=2", graph)
        self.assertIn("boxblur=24:2", graph)
        self.assertIn("force_original_aspect_ratio=decrease", graph)

    def test_20_cover_has_no_split(self) -> None:
        graph = self._argv("cover")
        graph = graph[graph.index("-filter_complex") + 1]
        self.assertNotIn("split=2", graph)
        self.assertIn("force_original_aspect_ratio=increase", graph)

    def test_21_blur_rejected_on_overlay_track(self) -> None:
        from helpers import Sandbox
        from renderd.errors import JobError

        s = Sandbox("caps-fit-overlay")
        try:
            ir = IR.normalize(_ir(
                [_video([{"asset": "a0", "at_frame": 0, "out_frame": 180}]),
                 {"id": "o1", "kind": "overlay",
                  "clips": [{"asset": "a1", "at_frame": 0, "out_frame": 180,
                             "fit": "blur"}]}],
                [{"id": "a0", "uri": "file:///x.mp4"},
                 {"id": "a1", "uri": "file:///y.mov"}]))
            with self.assertRaises(JobError) as ctx:
                compile_ffmpeg.build(
                    ir, {"a0": str(s.media["v_a.mp4"]),
                         "a1": str(s.media["v_b.mp4"])},
                    [], s.dir / "o.mp4", s.cfg.target, threads=2)
            self.assertEqual(ctx.exception.code, "E_IR_UNSUPPORTED")
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()

    def test_22_blur_background_is_not_black(self) -> None:
        """真渲染判据：blur 的背景非黑（>8），contain 的黑边 ≈0。

        只看 argv 里有 boxblur 不够 —— 全黑背景也能「编译通过」。
        """
        from helpers import Sandbox

        s = Sandbox("caps-fit-render")
        try:
            shots = {}
            # 必须用横版素材：竖版素材配竖版画幅，contain 也不会有黑边，
            # 两种 fit 结果完全相同（上一版就是这样误判的）。
            for fit in ("blur", "contain"):
                ir = _ir([_video([{"asset": "a0", "at_frame": 0,
                                   "out_frame": 180, "fit": fit}])],
                         [{"id": "a0", "uri": s.uri("v_b.mp4")}])
                out = s.submit({"ir": ir,
                                "idempotency_key": f"fit-{fit}-0001"})
                s.run_one()
                job = s.service.store.get(out["job_id"])
                self.assertEqual(job["status"], "succeeded", job["error_json"])
                im = _grab(s, Path(job["output_path"]), 60, f"fit_{fit}")
                # 顶部 8% 区域：blur 是模糊背景，contain 是黑边
                w, h = im.size
                top = [im.getpixel((x, y)) for y in range(int(h * 0.02), int(h * 0.08))
                       for x in range(0, w, 4)]
                shots[fit] = statistics.mean(sum(p) / 3 for p in top)
            self.assertGreater(shots["blur"], 8,
                               f"blur 背景太暗，可能没生效: {shots}")
            self.assertLess(shots["contain"], 4,
                            f"contain 顶部本应是黑边: {shots}")
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()


def _grab(sandbox, video: Path, frame: int, name: str):
    from PIL import Image

    png = sandbox.dir / f"{name}.png"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", str(video),
                    "-ss", f"{frame / FPS:.6f}", "-frames:v", "1", str(png)],
                   check=True, capture_output=True)
    return Image.open(png).convert("RGB")


def _mad(a, b) -> float:
    from PIL import ImageChops

    d = ImageChops.difference(a, b)
    px = list(d.getdata())
    return sum(sum(p) for p in px) / (len(px) * 3)


class TestRenderedBehaviour(unittest.TestCase):
    """真渲染：证明效果真的出现在成片里。"""

    def _run(self, s, ir) -> dict:
        out = s.submit({"ir": ir,
                        "idempotency_key": f"caps-{abs(hash(json.dumps(ir, sort_keys=True))) % 10**10}-01"})
        s.run_one()
        job = s.service.store.get(out["job_id"])
        self.assertEqual(job["status"], "succeeded", job["error_json"])
        self.assertEqual(json.loads(job["receipt_json"])["verdict"], "pass")
        return job

    def _sandbox(self, tag: str):
        from helpers import Sandbox

        return Sandbox(f"caps-{tag}")

    def test_15_transition_midpoint_is_a_blend(self) -> None:
        s = self._sandbox("trans")
        try:
            # 转场窗口 40..60：40 帧前是 A，60 帧后是 B，50 帧应是各半
            ir = _ir([_video([
                {"asset": "a0", "at_frame": 0, "out_frame": 60},
                {"asset": "a1", "at_frame": 40, "out_frame": 180,
                 "transition_in": {"type": "fade", "frames": 20}}])],
                [{"id": "a0", "uri": s.uri("v_a.mp4")},
                 {"id": "a1", "uri": s.uri("v_b.mp4")}])
            job = self._run(s, ir)
            a = _grab(s, Path(job["output_path"]), 30, "t_a")
            mid = _grab(s, Path(job["output_path"]), 50, "t_mid")
            b = _grab(s, Path(job["output_path"]), 70, "t_b")
            full = _mad(a, b)
            to_a, to_b = _mad(mid, a), _mad(mid, b)
            # 全差异必须够大，否则这条断言没有意义
            self.assertGreater(full, 40, f"A/B 差异太小，无法判定转场: {full}")
            # 转场中点应「既不像 A 也不像 B」，而是各占一半
            self.assertGreater(to_a, full * 0.2, f"中点太像 A: {to_a}/{full}")
            self.assertGreater(to_b, full * 0.2, f"中点太像 B: {to_b}/{full}")
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()

    def test_16_volume_scales_loudness_by_expected_db(self) -> None:
        s = self._sandbox("vol")
        means = {}
        try:
            for vol in (1.0, 0.25):
                ir = _ir([_video([{"asset": "a0", "at_frame": 0,
                                   "out_frame": 180}]),
                          _audio({"asset": "a0", "at_frame": 0,
                                  "out_frame": 180, "volume": vol})],
                         [{"id": "a0", "uri": s.uri("v_a.mp4")}], lufs=None)
                job = self._run(s, ir)
                err = subprocess.run(
                    [FFMPEG, "-hide_banner", "-i", job["output_path"],
                     "-af", "volumedetect", "-f", "null", "-"],
                    capture_output=True, text=True).stderr
                line = next(l for l in err.splitlines() if "mean_volume" in l)
                means[vol] = float(line.split("mean_volume:")[1].split("dB")[0])
            drop = means[1.0] - means[0.25]
            self.assertAlmostEqual(drop, 12.04, delta=1.5,
                                   msg=f"实测下降 {drop:.2f}dB，理论 12.04dB")
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()

    def test_17_subtitle_burns_into_frames(self) -> None:
        s = self._sandbox("subs")
        try:
            srt = Path(s.cfg.media_dir) / "caps_sub.srt"
            srt.write_text("1\n00:00:00,500 --> 00:00:02,000\n第一句\n\n"
                           "2\n00:00:02,500 --> 00:00:04,000\n第二句\n",
                           encoding="utf-8")
            ir = _ir([_video([{"asset": "a0", "at_frame": 0,
                               "out_frame": 180}]),
                      {"id": "sb", "kind": "subtitle",
                       "clips": [{"asset": "sub", "style": "s",
                                  "at_frame": 0, "out_frame": 180}]}],
                     [{"id": "a0", "uri": s.uri("v_a.mp4")},
                      {"id": "sub", "uri": f"upload:{srt.name}",
                       "kind": "subtitle"}],
                     styles={"s": {"font_family": "Noto Sans CJK SC",
                                   "font_size": 42, "fill": "#FFFFFF",
                                   "stroke": "#000000"}})
            job = self._run(s, ir)
            on = _grab(s, Path(job["output_path"]), 36, "sub_on")     # 1.2s
            off = _grab(s, Path(job["output_path"]), 135, "sub_off")  # 4.5s
            white_on = sum(1 for p in on.getdata()
                           if p[0] > 200 and p[1] > 200 and p[2] > 200)
            white_off = sum(1 for p in off.getdata()
                            if p[0] > 200 and p[1] > 200 and p[2] > 200)
            self.assertGreater(white_on, 500, f"字幕时段没有文字像素: {white_on}")
            self.assertLess(white_off, 50, f"非字幕时段出现了文字像素: {white_off}")
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()

    def test_18_overlay_alpha_preserves_underlying_texture(self) -> None:
        s = self._sandbox("alpha")
        try:
            ov = Path(s.cfg.media_dir) / "caps_overlay.mov"
            # 50% 半透明红：libvpx 那条路实测会丢 alpha（输出 yuv420p），用 qtrle
            subprocess.run(
                [FFMPEG, "-y", "-v", "error", "-f", "lavfi",
                 "-i", f"color=c=red:s={W}x{H}:d=6:r={FPS}",
                 "-vf", "format=rgba,colorchannelmixer=aa=0.5",
                 "-c:v", "qtrle", "-pix_fmt", "argb", str(ov)],
                check=True, capture_output=True)

            base_ir = _ir([_video([{"asset": "a0", "at_frame": 0,
                                    "out_frame": 180}])],
                          [{"id": "a0", "uri": s.uri("v_a.mp4")}])
            over_ir = _ir([_video([{"asset": "a0", "at_frame": 0,
                                    "out_frame": 180}]),
                           {"id": "o1", "kind": "overlay",
                            "clips": [{"asset": "ov", "at_frame": 0,
                                       "out_frame": 180}]}],
                          [{"id": "a0", "uri": s.uri("v_a.mp4")},
                           {"id": "ov", "uri": f"upload:{ov.name}"}])
            base = self._run(s, base_ir)
            over = self._run(s, over_ir)
            f0 = _grab(s, Path(base["output_path"]), 60, "a_base")
            f1 = _grab(s, Path(over["output_path"]), 60, "a_over")
            g0 = statistics.pstdev([p[1] for p in f0.getdata()])
            g1 = statistics.pstdev([p[1] for p in f1.getdata()])
            m1 = statistics.mean([p[1] for p in f1.getdata()])
            # 底层是彩色画面，G 通道方差明显；若 alpha 丢了会被纯红盖死 -> 方差 0
            self.assertGreater(g0, 40, "底层素材本身方差太小，无法判定")
            self.assertGreater(g1, g0 * 0.25,
                               f"叠加后底层纹理消失（alpha 丢失）: {g1:.1f} vs {g0:.1f}")
            self.assertGreater(m1, 10, "叠加后 G 通道归零，说明被不透明色块遮死")
        finally:
            s.service.store.close_thread_connection()
            s.cleanup()


if __name__ == "__main__":
    unittest.main()
