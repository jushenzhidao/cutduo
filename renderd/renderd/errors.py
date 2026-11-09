"""错误契约。

一条铁律：code 是契约，message 是叙事，二者不可互换。
Agent 靠 code 决策，人靠 message 理解。所有错误都必须能回答三个问题：
改哪里（field）、改成什么（allowed_values）、要不要重试（retryable）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# code -> (retryable, stage, http_status, human_message)
ERROR_SPECS: dict[str, tuple[bool, str, int, str]] = {
    # ── 输入 ──
    "E_INPUT_UNREADABLE":   (False, "ingesting", 422, "素材无法解析（编码或封装不支持）"),
    "E_INPUT_AUDIO_ONLY":   (False, "ingesting", 422, "纯音频文件被投递到视频素材位"),
    "E_INPUT_TRUNCATED":    (False, "ingesting", 422, "文件被截断或损坏"),
    "E_INPUT_OVERLONG":     (False, "ingesting", 422, "素材时长超过上限，需人工确认"),
    "E_MEDIA_MISSING":      (False, "ingesting", 422, "引用的素材不存在"),
    "E_MEDIA_TOO_SHORT":    (False, "ingesting", 422, "素材时长短于时间线需要"),
    "E_INPUT_TOO_LARGE":    (False, "ingesting", 422, "素材分辨率超过解码上限"),
    "E_UPLOAD_TOO_LARGE":   (False, "ingesting", 413, "上传超过大小上限"),
    "E_QUOTA_STORAGE_EXCEEDED": (False, "admission", 413, "租户存储空间配额不足"),
    "E_METRICS_FORBIDDEN":  (False, "admission", 403, "metrics 端点不对该来源开放"),
    "E_PAYLOAD_TOO_LARGE":  (False, "admission", 413, "请求体超过大小上限"),
    "E_MEDIA_FORBIDDEN":    (False, "ingesting", 403, "素材路径不在允许范围内"),
    "E_CALLBACK_FORBIDDEN": (False, "admission", 400, "回调地址不允许（协议或目标地址非法）"),
    "E_OUTPUT_TOO_LONG":    (False, "compiling", 422, "成片时长超过单任务上限"),
    "E_METHOD_NOT_ALLOWED": (False, "admission", 405, "不支持的 HTTP 方法"),
    "E_ASSET_IN_USE":       (False, "admission", 409, "素材仍被在途任务引用，暂不能删除"),
    "E_ASSET_AMBIGUOUS":    (False, "admission", 409, "素材前缀匹配到多个对象"),
    # ── 编译 ──
    "E_IR_INVALID":         (False, "compiling", 400, "时间线参数非法"),
    "E_IR_UNSUPPORTED":     (False, "compiling", 400, "时间线使用了本版本不支持的结构"),
    "E_TEMPLATE_NOT_FOUND": (False, "compiling", 404, "模板不存在"),
    "E_TEMPLATE_VARS":      (False, "compiling", 400, "模板变量缺失或类型不对"),
    "E_FONT_MISSING":       (False, "compiling", 422, "模板字体缺少字符"),
    "E_TEXT_OVERFLOW":      (False, "compiling", 422, "文本越出安全区"),
    # ── 准入 ──
    "E_AUTH_REQUIRED":      (False, "admission", 401, "缺少或无效的访问令牌"),
    "E_QUOTA_EXCEEDED":     (False, "admission", 429, "配额不足"),
    "E_QUEUE_FULL":         (True,  "admission", 429, "队列已满或租户并发超限"),
    "E_RATE_LIMITED":       (True,  "admission", 429, "请求过于频繁"),
    "E_BAD_REQUEST":        (False, "admission", 400, "请求格式不正确"),
    "E_NOT_FOUND":          (False, "admission", 404, "资源不存在"),
    # ── 执行 ──
    "E_TIMEOUT":            (True,  "rendering", 504, "渲染超时"),
    "E_OOM":                (True,  "rendering", 503, "资源不足"),
    "E_NVENC_SESSION":      (True,  "rendering", 503, "编码会话达上限"),
    "E_RENDER_FAILED":      (True,  "rendering", 500, "渲染进程异常退出"),
    "E_NORMALIZE_FAILED":   (False, "ingesting", 422, "素材归一化失败"),
    # ── 校验 ──
    "E_OUTPUT_INVALID":     (False, "validating", 500, "成片未通过断言"),
    "E_OUTPUT_MISSING":     (True,  "validating", 500, "成片文件缺失"),
    # ── 交付 ──
    "E_DELIVERY_FAILED":    (True,  "delivering", 502, "成片交付失败"),
    "E_CANCELLED":          (False, "cancelled", 409, "任务已取消"),
    "E_INTERNAL":           (True,  "internal", 500, "服务内部错误"),
}

RETRYABLE = {k for k, v in ERROR_SPECS.items() if v[0]}


class JobError(Exception):
    """带契约的错误。抛出它，上层就能原样返回给客户端。"""

    def __init__(self, code: str, message: str = "", *, hint: str = "",
                 field: str | None = None, allowed_values: list[Any] | None = None,
                 stage: str | None = None, detail: str = ""):
        spec = ERROR_SPECS.get(code, ERROR_SPECS["E_INTERNAL"])
        self.code = code
        self.message = message or spec[3]
        self.hint = hint
        self.field = field
        self.allowed_values = allowed_values or []
        self.stage = stage or spec[1]
        self.http_status = spec[2]
        self.detail = detail
        super().__init__(f"{code}: {self.message}")

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "stage": self.stage,
        }
        if self.hint:
            d["hint"] = self.hint
        if self.field:
            d["field"] = self.field
        if self.allowed_values:
            d["allowed_values"] = self.allowed_values
        if self.detail:
            d["detail"] = self.detail[:2000]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "JobError":
        return cls(
            d.get("code", "E_INTERNAL"),
            d.get("message", ""),
            hint=d.get("hint", ""),
            field=d.get("field"),
            allowed_values=d.get("allowed_values"),
            stage=d.get("stage"),
            detail=d.get("detail", ""),
        )


def classify_stderr(text: str) -> str:
    """把 ffmpeg 的 stderr 归到一个错误码。只做保守映射，认不出就 E_RENDER_FAILED。"""
    t = (text or "").lower()
    if "out of memory" in t or "cannot allocate memory" in t or "oom" in t:
        if "openencodesessionex" in t:
            return "E_NVENC_SESSION"
        return "E_OOM"
    if "openencodesessionex" in t or "no capable devices" in t:
        return "E_NVENC_SESSION"
    if "no space left" in t:
        return "E_OOM"
    if "invalid data found" in t or "moov atom not found" in t:
        return "E_INPUT_TRUNCATED"
    if "no such file" in t:
        return "E_MEDIA_MISSING"
    if "fontconfig" in t or "could not load font" in t:
        return "E_FONT_MISSING"
    return "E_RENDER_FAILED"


@dataclass
class Problem:
    """IR 校验的单个问题。字段路径必须精确到能让调用方直接改。"""

    field: str
    code: str
    message: str
    allowed_values: list[Any] = field(default_factory=list)

    def to_job_error(self) -> JobError:
        return JobError(
            self.code, self.message,
            field=self.field,
            allowed_values=self.allowed_values,
            hint=f"修正 {self.field} 后重试",
        )
