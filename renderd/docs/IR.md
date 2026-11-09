# IR（时间线中间表示）规范 v0.1

IR 是**事实来源**。MLT XML 与 FFmpeg filtergraph 都是由它编译出来的产物——可以随时丢、随时重编。

## 三条不可协商的约束

1. **时间一律整数帧**，不出现浮点秒（29.97/23.976 下浮点秒必然累积漂移）。
2. **素材内容寻址**（`sha256`），不用路径当身份。
3. **不可表达即报错**，不静默降级（`E_IR_UNSUPPORTED`）。

## 完整示例

```json
{
  "ir_version": "0.1",
  "id": "brand_vertical_15s",
  "title": "竖版 15 秒品牌模板",
  "output": {
    "width": 1080,
    "height": 1920,
    "fps": {"num": 30, "den": 1},
    "duration_frames": 450,
    "video": {"codec": "h264", "bitrate_kbps": 8000, "pix_fmt": "yuv420p",
              "preset": "veryfast", "gop_frames": 60, "crf": 20},
    "audio": {"codec": "aac", "sample_rate": 48000, "channels": 2,
              "bitrate_kbps": 192, "target_lufs": -14.0},
    "color": {"primaries": "bt709", "transfer": "bt709", "matrix": "bt709", "range": "tv"}
  },
  "styles": {
    "s_title": {
      "font_family": "Hiragino Sans GB",
      "font_size": 84,
      "fill": "#FFFFFF",
      "stroke": "#000000@0.8",
      "align": "center",
      "anchor": "bottom",
      "offset_y": 0,
      "max_chars_per_line": 9,
      "safe_area": {"top": 0.10, "bottom": 0.16, "left": 0.07, "right": 0.07}
    }
  },
  "assets": [
    {"id": "a1", "uri": "file:///data/media/a.mp4", "sha256": "8f3d…"},
    {"id": "m1", "uri": "upload:11ab….m4a"}
  ],
  "tracks": [
    {"id": "v1", "kind": "video", "clips": [
      {"asset": "a1", "at_frame": 0, "out_frame": 150, "in_frame": 0, "fit": "cover"},
      {"asset": "a1", "at_frame": 150, "out_frame": 300, "in_frame": 90, "fit": "cover"}
    ]},
    {"id": "t1", "kind": "text", "clips": [
      {"at_frame": 30, "out_frame": 420, "text": "季度回顾", "style": "s_title"}
    ]},
    {"id": "a1t", "kind": "audio", "clips": [
      {"asset": "m1", "at_frame": 0, "out_frame": 450, "fade_out_frames": 30}
    ]}
  ],
  "delivery": {"egress": "customer_bucket", "retention_hours": 72}
}
```

## output

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `width` `height` | int | 16–4096，**必须偶数** | yuv420p 要求 |
| `fps` | {num,den} | 正整数对 | 23.976 写 `{24000,1001}` |
| `duration_frames` | int | 1–216000 | 2 小时 @30fps |
| `video.codec` | enum | `h264` `hevc` `av1` | |
| `video.bitrate_kbps` | int | 200–80000 | **码率上限**，不是平均值 |
| `video.crf` | int | 默认 20 | 质量目标；与 `bitrate_kbps` 构成 capped CRF |
| `video.pix_fmt` | enum | `yuv420p` `yuv422p10le` `yuv420p10le` | |
| `audio.sample_rate` | enum | 44100 / 48000 | |
| `audio.channels` | enum | 1 / 2 | |
| `audio.target_lufs` | float | 默认 -14 | 渲染期用 loudnorm 归一 |
| `color.*` | const | 全部 bt709 / tv | 本版本不支持 HDR 输出 |

> `bitrate_kbps` 的语义是**上限**（VBV maxrate），实际码率随内容复杂度浮动。
> 这是刻意的：CBR/ABR 与多线程不兼容（同命令两次字节不同），见 `decisions.md` 01:06。

### 三种编码的容器 tag

MP4 里的 codec tag 不是实现细节，它直接决定播放器认不认：

| `video.codec` | 容器 tag | 说明 |
|---|---|---|
| `h264` | `avc1` | 兼容性最好，默认选择 |
| `hevc` | **`hvc1`** | ffmpeg / melt 默认写 `hev1`，而 **Safari / QuickTime / iOS 只认 `hvc1`**，拿到 `hev1` 直接不播 |
| `av1` | `av01` | Chrome / Firefox 支持；Safari 17+ 部分支持 |

三种都显式写死并进缓存指纹（`compile_ffmpeg.encoder_signature`）。客户选 HEVC 往往
就是为了 Apple 端省带宽 —— tag 写错等于交付了一个「看着成功、实际播不了」的成片。
两条后端都验证过：`tests/test_codec_branches.py`（ffmpeg）、
`tests/test_mlt_backend.py::test_08`（MLT）。

## 剪辑能力（续轮 10 新增）

### 转场：`clip.transition_in`

```json
{"asset": "a1", "at_frame": 50, "out_frame": 180,
 "transition_in": {"type": "fade", "frames": 20}}
```

| 字段 | 约束 | 说明 |
|---|---|---|
| `type` | `fade` `dissolve` `wipeleft` `wiperight` `slideup` `slidedown` `circleopen` `fadeblack` | 只暴露跨版本稳定的 xfade 子集 |
| `frames` | 正整数，且 **< 本段长度**、**< 前一段长度** | 转场窗口 |

**时间轴语义**：带转场的段从「前一段结束前 N 帧」开始，即 `at_frame == 前段 out_frame - N`。
两段在时间轴上真实重叠 N 帧（交叉淡化需要两段同时存在），所以**总时长不变**。
校验器强制这个等式 —— 位置与转场帧数不自洽时，xfade 的输出长度会和 `duration_frames` 对不上。

轨道第一段不能有 `transition_in`（没有前一段可衔接）。

### 音量：`clip.volume`

```
{"asset": "music", "at_frame": 0, "out_frame": 180, "volume": 0.3}
```

- 范围 `0–4`，`1.0` 为原始音量；只对 `audio` 轨有效
- 是**混音前增益**：决定各音轨之间的相对比例
- 成品绝对响度仍由 `output.audio.target_lufs` 决定。若希望 volume 决定最终响度，
  把 `target_lufs` 设为 `null`（或 `0`）关闭响度归一 —— 这时响度断言只测量不判定
- 与 `fade_in_frames` / `fade_out_frames` 可叠加使用

### 字幕：`kind="subtitle"` 轨 + `assets[].kind="subtitle"`

```json
"assets": [{"id": "sub", "uri": "upload:abc.srt", "kind": "subtitle"}],
"tracks": [{"id": "sb", "kind": "subtitle",
            "clips": [{"asset": "sub", "style": "caption",
                       "at_frame": 0, "out_frame": 450}]}]
```

- 支持 **SRT / WebVTT**；解析在 `renderd/subtitles.py`
- 时间码是**相对整条时间线**的绝对值，再与 clip 的 `[at_frame, out_frame)` 求交 ——
  所以「只让字幕在某段出现」只需缩小 clip 窗口
- 每条 cue 展开成一个 text clip，走与手工文字**完全相同**的 Pillow 栅格化路径：
  因此安全区硬校验、字体指纹、确定性断言全部继承
- 字幕文件里的 `<i>` 标签与 `{\an8}` 位置覆盖码会被剥离：位置由 `styles` 决定，
  不允许字幕文件自带定位（否则安全区校验形同虚设）
- 超框仍按 `E_TEXT_OVERFLOW` 硬失败 —— 这是商业底线，不静默缩小字号

### 画幅适配：`clip.fit`

| 值 | 行为 | 什么时候用 |
|---|---|---|
| `cover`（默认） | 等比放大到铺满，裁掉多余 | 素材与目标同比例，或主体在中央 |
| `contain` | 等比缩到完整可见，留黑边 | 需要完整画面且能接受黑边 |
| `stretch` | 直接拉伸（会变形） | 只在素材比例接近时用 |
| **`blur`** | 背景 = 同素材放大+高斯模糊+压暗；前景 = 完整画面居中 | **横版素材上竖版**（或反过来） |

`cover` 的代价要算清楚：16:9 → 9:16 时只保留中间约 **31%** 的宽度。
实测一条真实的横版 promo 素材，两侧的 HUD 与文字直接被切掉。
`blur` 是短视频行业的标准解法：完整画面居中，上下用模糊背景填满，既不失真也不浪费屏幕。

```json
{"asset": "a0", "at_frame": 0, "out_frame": 150, "fit": "blur"}
```

`overlay` 轨不支持 `blur`（叠加层需要 alpha，模糊背景会把它变成不透明），传了会直接 `E_IR_UNSUPPORTED`。

### 多轨叠加：`overlay` 轨保留 alpha

- overlay 轨的素材在归一化阶段**透传**（不重编码）。原因：归一化用 libx264，
  而 x264 没有 alpha 通道，重编一次 alpha 就没了（实测：源 `argb`，归一化后 `yuv420p`，
  叠加变成不透明色块）
- 编译期用 `format=yuva420p` + 透明填充（`contain` 时黑边也是透明的）
- 代价：叠加素材需自行保证尺寸/帧率接近目标，否则多一次缩放

## tracks

| kind | 要求 |
|---|---|
| `video` / `overlay` | **必须从帧 0 连续铺满到 `duration_frames`**，不允许空洞（`E_IR_UNSUPPORTED`）。多轨时按顺序叠加 |
| `text` | 每个 clip 需要 `text` + `style`；允许任意时间窗口与重叠 |
| `audio` | 允许空洞与重叠；多个 clip 用 adelay + amix 混合 |

clip 字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `at_frame` | 必填 | 时间线上的起点 |
| `out_frame` | 必填 | 必须 > `at_frame`，且 ≤ `duration_frames` |
| `in_frame` | 0 | 素材内入点 |
| `asset` | — | video/overlay/audio 必填，必须是 `assets[].id` |
| `fit` | `cover` | `cover` / `contain` / `stretch` |
| `speed` | 1.0 | 变速；>1 加速（消耗更多源帧） |
| `fade_in_frames` / `fade_out_frames` | 0 | 仅音频 |
| `text` / `style` | — | 仅文本 |

## styles

`safe_area` 是相对值（0–1）。文本墨迹包围盒必须落在安全区内，否则**编译期硬失败** `E_TEXT_OVERFLOW`——这是商业化的底线，不是样式偏好。

`font_family` 必须是镜像内已装字体的 family 名；缺字**硬失败** `E_FONT_MISSING`，附缺失码点。不做静默替换。

## 校验规则（`renderd/ir.py`）

一次返回**全部**问题，不是遇到第一个就抛——调用方才能一次改完。

| 检查 | 错误码 |
|---|---|
| 必填/类型/取值域 | `E_IR_INVALID` |
| 轨道空洞 / 未铺满 | `E_IR_UNSUPPORTED` |
| 引用不存在的素材 | `E_IR_INVALID`（`field=assets[n]`） |
| 文本为空 / style 不存在 | `E_IR_INVALID` |

## 模板格式

模板 = IR 骨架 + 变量声明，放在 `var/templates/*.json`：

```json
{
  "template_id": "hook_vertical_6s",
  "family": "hook_vertical",
  "aspect": "9:16",
  "description": "竖版 6 秒钩子：单段素材 + 大字标题",
  "output": { "...": "..." },
  "styles": {"s_hook": {"...": "..."}},
  "variables": [
    {"name": "clip", "type": "asset_id", "required": true},
    {"name": "hook", "type": "string", "required": true, "max_chars": 14}
  ],
  "tracks": [
    {"id": "v1", "kind": "video", "clips": [{"asset": "{{clip}}", "at_frame": 0, "out_frame": 180}]},
    {"id": "t1", "kind": "text", "clips": [{"at_frame": 6, "out_frame": 174, "text": "{{hook}}", "style": "s_hook"}]}
  ]
}
```

- 占位符 `{{var}}` 出现在整串时按原类型替换（数字仍是数字），出现在句中时按字符串插值。
- 可选变量未填 → 含该占位符的 clip 会被摘掉，而不是留下字面量 `{{var}}`。
- `max_chars` 在提交时校验（`E_TEMPLATE_VARS`），早于渲染。
