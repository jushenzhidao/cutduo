# tools/ · 模板自带的离线工具

只放**确定性、无网络、可重跑**的脚本。需要联网或调用付费接口的一律不进模板
（`permissions.network = false` 是承诺，不是默认值）。

可选工具清单：

| 文件 | 作用 | 依赖 |
|---|---|---|
| `vo.py` | 按口播文稿生成配音并回填 `captions[]` 时间轴 | `edge-tts`（`uv tool install edge-tts`） |

音轨合成注意：`vo.py` 产 wav，PCM 直接 `-c:a copy` 进 MP4 会让浏览器整轨静音——
要探测 codec，非 aac 转 `aac 160k`。
