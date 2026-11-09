"""renderd —— 商业级视频渲染服务。

设计约束（来自 P0/P1 的实测结论，不是风格偏好）：
  1. 时间一律整数帧，IR 里不出现浮点秒。
  2. 文字在编译期栅格化成图层，不让渲染器现算字形。
  3. 同后端两次渲染必须字节一致；跨后端只要求字段全等 + 感知一致。
  4. 每次成功都产出证据回执，不能只返回 URL。
"""

import os

# 版本号的单一事实源是 git tag：CI 用 `--build-arg RENDERD_VERSION` 注入，
# 本地未注入时回落到这里的默认值。这样镜像标签、/healthz、日志里的版本
# 永远说的是同一件事 —— 否则「线上跑的是哪个版本」只能靠猜。
__version__ = os.environ.get("RENDERD_VERSION") or "0.2.1"
IR_VERSION = "0.1"
RECEIPT_SCHEMA = "cutproof/receipt/v1"
