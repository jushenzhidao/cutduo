"""任务编排：把一条 IR 从入队跑到证据回执。

阶段顺序刻意固定：ingesting → compiling → rendering → validating → delivering → done。
每个阶段失败都能定位到具体原因，而不是笼统的「渲染失败」。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import threading
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from . import (compile_ffmpeg, compile_mlt, delivery, fonts,
               ingest as ING, subtitles,
               ir as IR, render, templates, textlayer, validate)
from .config import Config
from .errors import JobError, classify_stderr
from .store import Store

# 每输出分钟的直接成本（算力+带宽+存储+重试的加权，见 P0 手册第三节）。
# 只用于给 Agent 报价，不参与计费决策。
COST_PER_MINUTE_CNY = 0.049
# 保守吞吐：1080p 多轨合成按 2× 实时估算
SPEED_FACTOR = 2.0


@dataclass
class Estimate:
    cost_cny: float
    render_s: float
    wall_clock_s: float
    queue_hint: str = ""

    def to_dict(self) -> dict:
        return {"cost_cny": round(self.cost_cny, 4),
                "render_s_p50": round(self.render_s, 1),
                "wall_clock_s_p50": round(self.wall_clock_s, 1)}


def estimate(ir: dict) -> Estimate:
    dur = IR.duration_seconds(ir)
    render_s = dur / SPEED_FACTOR
    return Estimate(
        cost_cny=dur / 60.0 * COST_PER_MINUTE_CNY,
        render_s=render_s,
        wall_clock_s=render_s + 6.0,          # 入库 + 编译 + 校验 + 交付的固定开销
    )


UPLOAD_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_uri(uri: str, cfg: Config) -> Path | None:
    """把 uri 解析成本地路径，并强制围栏在 media 目录内。

    为什么必须围栏：`file:///etc/passwd` 这种输入会让服务去打开任意文件，
    攻击者可以用它探测文件存在性、读取可解析的媒体文件、甚至拿到别的租户的成片。
    默认只允许 media 目录；本地开发可开 RENDERD_ALLOW_ARBITRARY_PATHS。
    """
    if not uri:
        return None
    media_root = cfg.media_dir.resolve()

    def deny(why: str) -> None:
        raise JobError(
            "E_MEDIA_FORBIDDEN", why, field="assets[].uri",
            hint="先 POST /v1/assets 上传素材，再用 upload:<name> 引用",
            allowed_values=[f"upload:<file> 或 {media_root}/ 下的文件名"])

    if uri.startswith("upload:"):
        name = uri.split(":", 1)[1]
        if not UPLOAD_NAME.match(name) or ".." in name:
            deny(f"非法的上传素材名: {name[:40]}")
        p = (media_root / name).resolve()
        if not _inside(p, media_root):
            deny("素材路径越出 media 目录")
        return p

    if uri.startswith("file://"):
        p = Path(uri[7:]).resolve()
        if cfg.allow_arbitrary_paths:
            return p
        if not _inside(p, media_root):
            deny("file:// 只允许指向 media 目录内的文件")
        return p

    p = (media_root / uri).resolve()
    if not _inside(p, media_root):
        deny("相对路径越出 media 目录")
    return p


def check_callback(url: str, cfg: Config) -> dict:
    """兼容入口：委托给 netguard，返回钉住的连接信息。"""
    from . import netguard
    return netguard.resolve_pinned(
        url, allow_private=cfg.allow_private_callbacks)


def capacity_problems(ir: dict, cfg: Config) -> list:
    """容量与成本护栏。防止一次请求把整个集群占满。"""
    from .errors import Problem

    probs: list[Problem] = []
    dur = IR.duration_seconds(ir)
    if dur > cfg.max_output_seconds:
        fps = ir["output"]["fps"]
        probs.append(Problem(
            "output.duration_frames", "E_OUTPUT_TOO_LONG",
            f"成片时长 {dur:.0f}s 超过单任务上限 {cfg.max_output_seconds:.0f}s",
            [int(cfg.max_output_seconds * fps["num"] / fps["den"])]))
    if len(ir.get("assets", [])) > cfg.max_assets:
        probs.append(Problem("assets", "E_IR_INVALID",
                             f"素材数 {len(ir['assets'])} 超过上限 {cfg.max_assets}",
                             [cfg.max_assets]))
    for t in ir.get("tracks", []):
        if len(t.get("clips", [])) > cfg.max_clips_per_track:
            probs.append(Problem(f"tracks[{t.get('id')}].clips", "E_IR_INVALID",
                                 f"片段数 {len(t['clips'])} 超过上限 "
                                 f"{cfg.max_clips_per_track}", [cfg.max_clips_per_track]))
        for c in t.get("clips", []):
            txt = c.get("text")
            if isinstance(txt, str) and len(txt) > cfg.max_text_chars:
                probs.append(Problem("tracks[].clips[].text", "E_IR_INVALID",
                                     f"文本 {len(txt)} 字超过上限 {cfg.max_text_chars}",
                                     [cfg.max_text_chars]))
    return probs


def _probe_assets(ir: dict, cfg: Config) -> tuple[dict[str, str], dict[str, dict]]:
    """解析并体检素材。返回 (id -> local path, id -> probe 摘要)。"""
    # 帧数按时间线帧率折算，不是源帧率：归一化会把素材转成时间线帧率，
    # 之后 trim=start_frame 的帧号语义才对得上。
    target_fps = ir["output"]["fps"]["num"] / ir["output"]["fps"]["den"]
    media: dict[str, str] = {}
    info: dict[str, dict] = {}
    tracks_by_asset: dict[str, set[str]] = {}
    for t in ir["tracks"]:
        for c in t["clips"]:
            if c.get("asset"):
                tracks_by_asset.setdefault(c["asset"], set()).add(t["kind"])

    for asset in ir["assets"]:
        aid = asset["id"]
        path = resolve_uri(asset.get("uri", ""), cfg)
        if path is None or not path.exists():
            raise JobError("E_MEDIA_MISSING", f"素材 {aid} 的文件不存在",
                           field=f"assets[{aid}].uri",
                           hint="先上传素材，或用 file:// 绝对路径")
        if path.stat().st_size == 0:
            raise JobError("E_INPUT_UNREADABLE", f"素材 {aid} 为 0 字节",
                           field=f"assets[{aid}].uri")
        if asset.get("kind") == "subtitle":
            # 字幕没有音视频流：probe 出来是空 streams，会被下面的分支当成坏素材。
            # 这里只登记路径，真正解析在 subtitles.expand()。
            media[aid] = str(path)
            info[aid] = {"type": "subtitle"}
            continue
        meta = render.probe_json(cfg.ffprobe, path)
        streams = meta.get("streams", [])
        has_v = any(s.get("codec_type") == "video" for s in streams)
        has_a = any(s.get("codec_type") == "audio" for s in streams)
        kinds = tracks_by_asset.get(aid, set())
        if kinds & {"video", "overlay"} and not has_v:
            raise JobError("E_INPUT_AUDIO_ONLY",
                           f"素材 {aid} 没有视频流，却被用在视频轨",
                           field=f"assets[{aid}]")
        if kinds == {"audio"} and not has_a:
            raise JobError("E_INPUT_UNREADABLE", f"素材 {aid} 没有音频流",
                           field=f"assets[{aid}]")

        v = next((s for s in streams if s.get("codec_type") == "video"), None)
        if v:
            num, den = (v.get("r_frame_rate") or "0/1").split("/")
            try:
                fps = float(num) / float(den)
            except ZeroDivisionError:
                fps = 0.0
            dur = float(v.get("duration") or meta.get("format", {}).get("duration") or 0)
            wpx, hpx = int(v.get("width") or 0), int(v.get("height") or 0)
            if wpx * hpx > cfg.max_decoded_pixels:
                raise JobError(
                    "E_INPUT_TOO_LARGE",
                    f"素材 {aid} 为 {wpx}×{hpx}，超过单帧解码上限 "
                    f"{cfg.max_decoded_pixels} 像素",
                    field=f"assets[{aid}]",
                    hint="先转码降到 4K 以内再上传",
                    allowed_values=[f"<= {cfg.max_decoded_pixels} 像素"])
            info[aid] = {"type": "video",
                         "frames": int(round(dur * target_fps)) if dur else 0,
                         "source_fps": fps, "duration": dur,
                         "width": wpx, "height": hpx}
        else:
            a = next(s for s in streams if s.get("codec_type") == "audio")
            info[aid] = {"type": "audio",
                         "duration": float(a.get("duration")
                                           or meta.get("format", {}).get("duration") or 0)}
        media[aid] = str(path)

    _check_length(ir, info)
    return media, info


def _check_length(ir: dict, info: dict[str, dict]) -> None:
    """按 canonical 帧数复核。不够长会在 concat 阶段神秘失败，必须提前拦。"""
    for t in ir["tracks"]:
        if t["kind"] not in ("video", "overlay"):
            continue
        for c in t["clips"]:
            need = int(c.get("in_frame", 0)) + round(
                (c["out_frame"] - c["at_frame"]) * float(c.get("speed", 1.0)))
            have = info.get(c["asset"], {}).get("frames", 0)
            if have and need > have + 1:
                raise JobError(
                    "E_MEDIA_TOO_SHORT",
                    f"素材 {c['asset']} 归一化后只有 {have} 帧，时间线需要 {need} 帧",
                    field=f"tracks[{t['id']}].clips",
                    allowed_values=[f"out_frame ≤ {c['at_frame'] + have}"],
                    hint="缩短该段时长，或换更长的素材")


class Runner:
    def __init__(self, cfg: Config, store: Store,
                 registry: templates.TemplateRegistry | None = None):
        self.cfg = cfg
        self.store = store
        self.registry = registry or templates.TemplateRegistry(cfg.template_dir)
        self.engine = render.ffmpeg_version(cfg.ffmpeg)
        self.threads = 4          # 固定线程数：x264 的字节输出与线程数相关
        self.normalizer = ING.Normalizer(cfg, self.engine)

    # ── 预检 ────────────────────────────────────────────
    def preflight(self, ir: dict, *, backend: str = "ffmpeg") -> dict:
        problems = IR.validate(ir)
        try:
            problems = problems + capacity_problems(IR.normalize(ir), self.cfg)
        except Exception:
            pass
        checks: dict[str, dict] = {}
        fixes: list[dict] = []

        checks["ir_schema"] = {
            "pass": not problems,
            "detail": [p.__dict__ for p in problems][:20],
        }
        if problems:
            err = problems[0].to_job_error().to_dict()
            err["detail"] = json.dumps([p.__dict__ for p in problems][:10],
                                       ensure_ascii=False, default=str)[:1500]
            checks["ir_schema"]["error"] = err
        for p in problems[:10]:
            fixes.append({"field": p.field, "action": "set",
                          "value": p.allowed_values[0] if p.allowed_values else None,
                          "reason": p.message})
        if problems:
            return {"valid": False, "checks": checks, "fixes": fixes,
                    "estimate": estimate(ir).to_dict() if ir.get("output") else {}}

        norm = IR.normalize(ir)
        try:
            media, info = _probe_assets(norm, self.cfg)
            checks["assets_readable"] = {"pass": True,
                                         "detail": {k: v for k, v in info.items()}}
        except JobError as e:
            checks["assets_readable"] = {"pass": False, "detail": e.to_dict(),
                                         "error": e.to_dict()}
            return {"valid": False, "checks": checks, "fixes": fixes,
                    "estimate": estimate(norm).to_dict()}

        # 归一化预检：ffprobe 元数据全健康的截断文件，只有抽样解码才抓得到。
        # 不在提交时抓，Agent 会以为提交成功、然后在异步阶段莫名失败。
        try:
            ing = self.normalizer.precheck(norm, media)
            checks["ingest"] = {"pass": True, "detail": ing,
                                "note": "已抽样解码；归一化动作将在执行阶段落盘"}
        except JobError as e:
            checks["ingest"] = {"pass": False, "detail": e.to_dict(),
                                 "error": e.to_dict()}
            return {"valid": False, "checks": checks, "fixes": fixes,
                    "estimate": estimate(norm).to_dict()}

        texts = IR.all_text(norm)
        if texts:
            families = {s.get("font_family") for s in norm["styles"].values()}
            cov_all = {"ok": True, "fonts": []}
            for fam in families:
                fp, _used, _fb = fonts.resolve_or_fallback(fam)
                if _fb:
                    fixes.append({"field": "styles.*.font_family", "action": "pick_font",
                                  "value": _used, "reason": _fb})
                try:
                    if not fp:
                        raise JobError("E_FONT_MISSING", f"找不到字体: {fam}",
                                       field="styles.*.font_family")
                except JobError as e:
                    cov_all["ok"] = False
                    cov_all["fonts"].append(e.to_dict())
                    fixes.append({"field": "styles.*.font_family", "action": "pick_font",
                                  "value": "Hiragino Sans GB",
                                  "reason": f"字体不可用: {fam}"})
                    continue
                cov = fonts.coverage(fp, texts)
                cov_all["fonts"].append(cov)
                if not cov["ok"]:
                    cov_all["ok"] = False
                    fixes.append({"field": "styles.*.font_family", "action": "pick_font",
                                  "value": "Hiragino Sans GB",
                                  "reason": "当前字体缺字: "
                                            + ",".join(cov.get("missing_codepoints", [])[:6])})
            checks["font_coverage"] = {"pass": cov_all["ok"], "detail": cov_all}
            if not cov_all["ok"]:
                missing = []
                for f in cov_all["fonts"]:
                    if isinstance(f, dict):
                        missing += f.get("missing_codepoints", []) or []
                fe = JobError(
                    "E_FONT_MISSING",
                    "模板字体缺字：" + ",".join(missing[:8]),
                    field="styles.*.font_family",
                    hint="换字体或补齐字体文件；禁止静默替换",
                    allowed_values=["Hiragino Sans GB"],
                ).to_dict()
                checks["font_coverage"]["error"] = fe

            try:
                safe_ref, _u, _w = fonts.resolve_or_fallback(next(iter(families)))
                if not safe_ref:
                    raise JobError("E_FONT_MISSING",
                                   f"找不到可用字体: {next(iter(families))}",
                                   field="styles.*.font_family")
                layers = textlayer.rasterize(norm, safe_ref,
                                             self.cfg.tmp_dir / "preflight")
                ok = all(l.within_safe is not False for l in layers)
                checks["text_safe_area"] = {"pass": ok,
                                            "detail": [l.summary() for l in layers]}
                if not ok:
                    fixes.append({"field": "tracks[].clips[].text", "action": "shorten_text",
                                  "reason": "文本越出安全区"})
            except JobError as e:
                checks["text_safe_area"] = {"pass": False, "detail": e.to_dict(),
                                            "error": e.to_dict()}
                fixes.append({"field": e.field, "action": "shorten_text",
                              "value": None, "reason": e.message})
        else:
            checks["font_coverage"] = {"pass": True, "detail": "无文本轨"}
            checks["text_safe_area"] = {"pass": True, "detail": "无文本轨"}

        has_audio = any(t["kind"] == "audio" for t in norm["tracks"])
        checks["audio_present"] = {"pass": True,
                                   "detail": "有音轨" if has_audio else "无音轨，将补静音（已告知）"}

        valid = all(c.get("pass", False) for c in checks.values())
        return {"valid": valid, "checks": checks, "fixes": fixes,
                "estimate": estimate(norm).to_dict()}

    # ── 缓存键 ──────────────────────────────────────────
    def cache_key(self, ir: dict, layers: list[textlayer.Layer], backend: str,
                   ingest_fp: str = "") -> str:
        font_paths = {fonts.resolve(s.get("font_family", "")) for s in ir["styles"].values()}
        font_fp = fonts.fonts_digest([p for p in font_paths if p])
        if layers:
            font_fp += ":" + textlayer.layers_digest(layers)
        t = self.cfg.target
        # encoder 指纹必须进键：改一个 -tag:v / preset 就会改变输出字节，
        # 但 IR 没变、ffmpeg 版本没变 —— 不带指纹就会命中旧产物。
        enc_fp = compile_ffmpeg.encoder_signature(ir) if backend == "ffmpeg" else ""
        target_fp = (f"{t.long_edge}x{t.fps}:{t.pix_fmt}:{t.sample_rate}:"
                     f"{t.channels}:{t.crf}:threads={self.threads}:"
                     f"enc={enc_fp}:ingest={ingest_fp}")
        return IR.content_hash(ir, backend=backend, engine=self.engine,
                               font_fp=font_fp, target_fp=target_fp)

    # ── 主流程 ──────────────────────────────────────────
    def execute(self, job: dict, worker: str = "worker") -> None:
        job_id = job["id"]
        t0 = time.time()
        try:
            ir = IR.normalize(json.loads(job["ir_json"]))
            backend = job.get("backend") or "ffmpeg"
            work = (self.cfg.tmp_dir / job_id).resolve()
            if work.exists():
                shutil.rmtree(work, ignore_errors=True)
            work.mkdir(parents=True, exist_ok=True)

            # ── 1 入库 + 输入归一化 ──
            media, info = _probe_assets(ir, self.cfg)
            # 字幕轨 → 文本片段。必须在解析出 media 路径之后、栅格化之前。
            subtitles.expand(ir, media)
            self.store.set_stage(job_id, "ingesting", "归一化输入素材")
            media, ingest_report, info = self.normalizer.run(ir, media, info)
            _check_length(ir, info)      # 用 canonical 帧数复核，不能用源帧数
            self.store.set_stage(job_id, "compiling",
                                 f"{len(media)} 个素材就绪（已归一化）",
                                 {"assets": info,
                                  "ingest_digest": ingest_report.get("digest")})

            # ── 2 编译 ──
            problems = IR.validate(ir) + capacity_problems(ir, self.cfg)
            if problems:
                raise problems[0].to_job_error()

            texts = IR.all_text(ir)
            font_path = None
            cov = {"ok": True, "skipped": "无文本轨"}
            font_warnings: list[str] = []
            if texts:
                families = sorted({s.get("font_family") for s in ir["styles"].values()})
                font_path, used_font, fb_warn = fonts.resolve_or_fallback(families[0])
                if not font_path:
                    fonts.require(families[0])      # 抛出带 allowed_values 的契约错误
                if fb_warn:
                    font_warnings.append(fb_warn)
                cov = fonts.coverage(font_path, texts)
                if not cov["ok"]:
                    raise JobError(
                        "E_FONT_MISSING",
                        "模板字体缺字：" + ",".join(cov.get("missing_codepoints", [])[:8]),
                        field="styles.*.font_family",
                        hint="换字体或补齐字体文件；禁止静默替换",
                        detail=json.dumps(cov, ensure_ascii=False))

            layers = textlayer.rasterize(ir, font_path, work / "layers") if texts else []
            key = self.cache_key(ir, layers, backend,
                                 ingest_report.get("digest", ""))

            out_tmp = work / "render.mp4"
            if backend == "ffmpeg":
                plan = compile_ffmpeg.build(ir, media, layers, out_tmp, self.cfg.target,
                                            threads=self.threads, ffmpeg=self.cfg.ffmpeg)
            elif backend == "mlt":
                mlt_path = work / "timeline.mlt"
                mlt = compile_mlt.write(ir, media, layers, mlt_path)
                if not mlt["ok"]:
                    raise JobError("E_IR_UNSUPPORTED",
                                   f"MLT 结构校验未通过: {mlt.get('unknown_services')}",
                                   hint="检查后端模块是否齐备")
                if not shutil.which(self.cfg.melt):
                    raise JobError("E_RENDER_FAILED",
                                   f"MLT 后端需要 melt 运行时（未找到 {self.cfg.melt}）",
                                   hint="用 Dockerfile.mlt 构建镜像，或改用 backend=ffmpeg")
                plan = compile_mlt.plan(ir, mlt_path, out_tmp, self.cfg,
                                        threads=self.threads)
            else:
                raise JobError("E_IR_INVALID", f"未知后端: {backend}",
                               field="backend", allowed_values=["ffmpeg", "mlt"])

            (work / "filtergraph.txt").write_text(plan.filtergraph)
            self.store.set_stage(job_id, "compiling",
                                 f"编译完成，{len(layers)} 个文字图层",
                                 {"layers": [l.summary() for l in layers],
                                  "cache_key": key[:16]})

            # ── 缓存命中 ──
            cached = self.store.cache_get(key)
            if cached:
                self.store.set_stage(job_id, "delivering", "命中渲染缓存")
                self._deliver(job_id, Path(cached["output_path"]),
                              json.loads(Path(cached["receipt_path"]).read_text()),
                              cache_hit=True, ir=ir)
                return

            # ── 3 渲染 ──
            self.store.set_stage(job_id, "rendering",
                                 f"开始渲染 {plan.expected_frames} 帧",
                                 {"cmd": plan.command()[:4000]})
            stop = threading.Event()
            hb = threading.Thread(target=self._heartbeat_loop,
                                  args=(job_id, worker, stop, plan.expected_frames),
                                  daemon=True)
            hb.start()
            try:
                res = render.run(plan.argv, timeout=self.cfg.render_timeout_s,
                                 cwd=work, expected_frames=plan.expected_frames)
            finally:
                stop.set()
                hb.join(timeout=5)

            if not res.ok:
                if res.timed_out:
                    raise JobError("E_TIMEOUT", f"渲染超时（{self.cfg.render_timeout_s}s）",
                                   detail=res.stderr_tail)
                raise JobError(classify_stderr(res.stderr_tail),
                               "渲染进程异常退出",
                               detail=f"exit={res.exit_code}\n{res.stderr_tail}")

            # MLT 出片后必须做一次容器规范化 —— 无论有没有音轨。
            # 三个理由（都实测过）：
            #   · melt 写 HEVC 用 hev1，Safari/iOS 只认 hvc1
            #   · MLT 没有 LUFS 目标，不补 loudnorm 会在 L3 断言上失败
            #   · 音频轨到最后一个片段就结束，不 apad+atrim 就音画不同步
            if backend == "mlt":
                has_audio = any(t["kind"] == "audio" for t in ir["tracks"])
                fin_out = work / "render_final.mp4"
                fr = render.run(
                    compile_mlt.finalize_argv(ir, out_tmp, fin_out, self.cfg,
                                              normalise_audio=has_audio),
                    timeout=min(600.0, self.cfg.render_timeout_s), cwd=work)
                if not fr.ok:
                    raise JobError("E_RENDER_FAILED", "MLT 输出的容器规范化失败",
                                   detail=fr.stderr_tail[-800:])
                out_tmp = fin_out

            # ── 4 校验 ──
            self.store.set_stage(job_id, "validating", "生成证据回执")
            if not out_tmp.exists() or out_tmp.stat().st_size == 0:
                raise JobError("E_OUTPUT_MISSING", "渲染进程返回成功但成片不存在")

            meta = render.probe_json(self.cfg.ffprobe, out_tmp)
            struct = validate.structural(meta, out_tmp)
            ev = validate.evidence(self.cfg.ffmpeg, out_tmp, work / "evidence",
                                   struct["frames"])
            receipt = validate.build_receipt(
                ir=ir, ir_hash=job["ir_hash"], render_path=out_tmp, struct=struct,
                layers=layers, font_coverage=cov,
                loud=validate.loudness(
                    self.cfg.ffmpeg, out_tmp,
                    ir["output"]["audio"].get("target_lufs", -14.0)),
                black=validate.black_ranges(self.cfg.ffmpeg, out_tmp),
                ev=ev,
                warnings=(plan.warnings + font_warnings
                          + ingest_report.get("warnings", [])),
                has_audio_track=any(t["kind"] == "audio" for t in ir["tracks"]),
                ingest=ingest_report)

            if receipt["verdict"] != "pass":
                raise JobError("E_OUTPUT_INVALID",
                               "成片未通过断言：" + ",".join(receipt["failures"][:6]),
                               detail=json.dumps({"failures": receipt["failures"],
                                                  "l1": receipt["L1"]["assertions"]},
                                                 ensure_ascii=False)[:1800])

            # ── 5 交付 ──
            self.store.set_stage(job_id, "delivering", "落盘并登记缓存")
            self._deliver(job_id, out_tmp, receipt, cache_hit=False, ir=ir, key=key)
            self.store.set_stage(job_id, "done",
                                 f"完成，耗时 {round(time.time() - t0, 2)}s")

        except JobError as e:
            self._record_failure(job_id, e.to_dict())
        except Exception as e:  # pragma: no cover
            self._record_failure(job_id, {
                "code": "E_INTERNAL", "message": f"{type(e).__name__}: {e}",
                "retryable": True, "stage": "internal"})

    def _heartbeat_loop(self, job_id: str, worker: str, stop: threading.Event,
                        total: int) -> None:
        interval = max(3.0, self.cfg.lease_s / 3.0)
        while not stop.wait(interval):
            try:
                self.store.heartbeat(job_id, worker, self.cfg.lease_s)
            except Exception:
                pass

    def _deliver(self, job_id: str, src: Path, receipt: dict, *, cache_hit: bool,
                 ir: dict, key: str | None = None) -> None:
        out_final = self.cfg.out_dir / f"{job_id}.mp4"
        if cache_hit:
            # 缓存命中时给每个 job 硬链接一份，而不是复制 5MB 成片。
            # 500 条长稳实测：复制会让磁盘线性涨 2.5GB，硬链接几乎不涨，
            # 同时每个 job 仍保留独立的可签名路径与独立的 gc 语义。
            out_final.unlink(missing_ok=True)
            try:
                os.link(src, out_final)
            except OSError:
                shutil.copy2(src, out_final)
        else:
            shutil.move(str(src), str(out_final))

        job = self.store.get(job_id) or {}
        # 成片直传客户自己的 bucket：出口流量不经我方，成本模型里那 61% 直接归零。
        # 失败不阻断任务成功，但必须写进回执与事件，不能假装交付过。
        dres = delivery.push(job, out_final, self.cfg, self.store)
        receipt["delivery"] = dres
        # 第一性原理：Agent 看不见视频，verdict 是它判断成败的唯一依据。
        # 客户把 put_url 当唯一取片通道时，直传失败却回 pass = 骗人。
        # job.status 仍是 succeeded（成片确实生成、本地可取），但回执必须降级，
        # 让 Agent 知道要重试或换交付方式。
        if dres.get("mode") == "put_url" and dres.get("status") != "delivered":
            receipt["warnings"] = list(receipt.get("warnings") or []) + [
                f"成片直传失败（{dres.get('error') or dres.get('response_line')}）；"
                f"已保留本地副本，请手动取回"]
            receipt["verdict"] = "fail"
            receipt["failures"] = sorted(set(
                list(receipt.get("failures") or []) + ["E_DELIVERY_FAILED"]))

        ev_dir = self.cfg.evidence_dir / job_id
        if receipt.get("evidence"):
            receipt["evidence"] = validate.copy_evidence(receipt["evidence"], ev_dir)
            # 回执必须对「它所引用的每个文件」做内容承诺。原来只有成片有
            # sha256，contact sheet / 首尾帧 / 波形图被替换后 receipt 毫无察觉。
            receipt["evidence_sha256"] = {
                k: validate.sha256_file(Path(p))
                for k, p in receipt["evidence"].items() if Path(p).exists()
            }
        receipt["output"] = str(out_final)
        receipt["cache_hit"] = cache_hit
        receipt_path = self.cfg.out_dir / f"{job_id}.receipt.json"
        validate.write_json(receipt_path, receipt)

        if key and not cache_hit:
            self.store.cache_put(key, ir_hash=receipt.get("ir_hash", ""),
                                 backend="ffmpeg", output_path=str(out_final),
                                 receipt_path=str(receipt_path),
                                 size=out_final.stat().st_size)

        self.store.succeed(job_id, output_path=str(out_final),
                           receipt_path=str(receipt_path),
                           receipt=receipt, cache_hit=cache_hit)
        dur = ir["output"]["duration_frames"] / (
            ir["output"]["fps"]["num"] / ir["output"]["fps"]["den"])
        try:
            if job:
                self.store.usage_add(job["tenant"], dur)
                self._notify(job, "succeeded")
        except Exception:
            pass

    def _record_failure(self, job_id: str, error: dict) -> None:
        try:
            status = self.store.fail(
                job_id, error, backoff_base_s=self.cfg.retry_backoff_base_s)
            if status == "failed":
                job = self.store.get(job_id)
                if job:
                    self._notify(job, "failed", error)
        except Exception:
            pass

    # ── webhook ─────────────────────────────────────────
    def _notify(self, job: dict, status: str, error: dict | None = None) -> None:
        """投递到钉住的 IP。刻意不用 urllib：它会再做一次 DNS 解析。"""
        from . import netguard

        url = job.get("callback_url")
        if not url:
            return
        # at-least-once 投递：给收端一个稳定的去重键。
        # 同一次尝试的重试用同一个 event_id，重试/重放则不同。
        payload = {
            "job_id": job["id"], "status": status,
            "event_id": f"{job['id']}:{status}:{job.get('attempts', 0)}",
            "attempt": job.get("attempts", 0),
            "receipt_url": f"/v1/jobs/{job['id']}/receipt",
            "error": error,
        }
        data = json.dumps(payload, ensure_ascii=False).encode()

        pin = None
        raw = job.get("callback_ip")
        if raw:
            try:
                pin = json.loads(raw) if raw.strip().startswith("{") else {"ip": raw}
            except Exception:
                pin = {"ip": str(raw)}
        if not pin or not pin.get("host"):
            # 兼容旧任务：解析一次并立刻直连该 IP，仍然不做二次解析
            try:
                pin = netguard.resolve_pinned(
                    url, allow_private=self.cfg.allow_private_callbacks)
            except Exception as exc:
                self.store.event(job["id"], "delivering",
                                 f"webhook 跳过（回调地址复核失败）: {exc}", level="warn")
                return

        last = ""
        for attempt in range(2):
            try:
                netguard.revalidate_pin(
                    pin, allow_private=self.cfg.allow_private_callbacks)
                code, line = netguard.pinned_request(
                    pin, method="POST", data=data,
                    headers={"Content-Type": "application/json"}, timeout=8.0)
                if 200 <= code < 300:
                    self.store.event(job["id"], "delivering",
                                     f"webhook {status} 已投递 (pin={pin.get('ip')})")
                    return
                last = f"HTTP {code} {line[:80]}"
            except Exception as exc:
                last = f"{type(exc).__name__}: {exc}"
            if attempt == 0:
                time.sleep(0.5)
        self.store.event(job["id"], "delivering",
                         f"webhook 投递失败: {last[:200]}", level="warn")
