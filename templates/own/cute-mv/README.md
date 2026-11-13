# 可爱角色歌词 MV · cute-mv

33 秒 / 9 镜头 / 1920×1080@30。把一段中文歌词编译成 chibi 角色 MV：
底部歌词条、顶部 3D 关键词、中景手写纸条；人物是程序绘制的矢量角色，**零素材依赖**。

- 上游：`motiongit.com/chenyutao0417/cute-character-lyric-mv` v1.0.1（Remotion 4 + Canvas2D，MIT）
- 接入深度：**半蒸馏**（只借内容模型，渲染层全部自写）——见 `../../03-semi-distill/README.md`
- 包：`packages/cute-mv.motion`

## 一、三条命令

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
cd <repo>

# 0) 首次取字体（OFL，不进包、不进 git）
bash templates/own/cute-mv/tools/fetch-fonts.sh

# 1) 出片（Skia 直出，无浏览器）
node render.mjs --kit cute-mv \
  --params templates/own/cute-mv/presets/default.json \
  --audio /path/to/music.m4a --out out/cute-mv.mp4

# 2) 门禁
node src/gate.mjs out/cute-mv.mp4
```

实测：990 帧 / 8 worker **5.2 s**（≈190 fps），成片 5.5 MB（CRF 20 / raw pipe）。

## 二、内容怎么改

只动 `presets/default.json` 里的 `content`：

```json
"content": {
  "lyrics":   [{ "s": 0.8, "e": 3.4, "zh": "一句歌词" }],      // ≤12 条
  "keywords": [{ "s": 0.6, "e": 3.4, "text": "刚刚好", "y": 130, "size": 150 }], // ≤12 条
  "notes":    [{ "s": 3.0, "e": 5.2, "text": "两行\n纸条", "x": 120, "y": 150, "rot": -7 }] // ≤6 条
}
```

`scenes` 是 9 个固定镜头，**不要增删**；只允许调 `args.x / y / s`（机位）与 `pose`（动作名）。

## 三、文件

| 文件 | 职责 |
|---|---|
| `src/kit.js` | 绘制原语：chibi 骨骼、场景件（天/日/云/树/楼/草/纸飞机）、三类文字层 |
| `src/layouts.js` | 9 个镜头，每个 = 一个场景 + 一个机位 |
| `src/stage.js` | 编排：时间轴 → 定位镜头 → 画场景 → 叠文字 → 首尾淡入淡出（宿主无关） |
| `src/main.js` | 浏览器薄壳 |
| `params.schema.json` | 内容契约（对齐上游三字段 + 9 镜头） |
| `presets/default.json` | 自写文案的演示参数 |
| `guide.json` / `SPEC.md` | 内容模型 / 可复用规律 |
| `tools/fetch-fonts.sh` | 取 LXGW WenKai 与 ZCOOL KuaiLe（OFL） |

## 四、借了什么、没借什么

| 借（内容模型） | 没借（渲染层） |
|---|---|
| `lyrics / keywords / notes` 三字段与条数上限 12/12/6 | 上游 `Shots.tsx` / `rig.ts` 的任何代码 |
| 9 镜头的顺序与时长（4.25/3.65/3.15/4.25/4.5/3.95/2.8/3.25/3.2） | 上游的 9 个渐变背景与占位角色画法 |
| 三类文字的排版数值（62px 底部、150px 顶部、40px 纸条） | 示例歌词、纸条文案、品牌标识 |
| 固定 33 s / 30 fps / 1920×1080 | 《碎碎念》演示片与阿涛/小怡人物 |

## 五、已知边界

- **只能横屏**：机位按 16:9 的横向留白摆，改 9:16 要重排 9 个镜头，不是改参数。
- **配乐是外部输入**：模板不带音乐，`--audio` 传已授权文件；无音轨时出无声片。
- **人物只有一个**：造型、服装、发型都是固定的；换角色要改 `kit.js` 的 `chibi()`，不是填参数。
- **字体退化**：没跑 `fetch-fonts.sh` 时 Skia 会用 Noto Sans SC 顶替，字重对、字形不对。
