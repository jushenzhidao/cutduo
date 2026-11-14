# MEMORY.md — 本项目长期约定

> 只留「下次一定用到、不看文档就会踩坑」的结论与数字。过程见各日日志；代码可读的不重复。
> **细则已拆到 `MEMORY-DETAIL.md`**（门禁逐条、时间轴逐条、版式逐型、iso 实测），此处只留结论。
> 2026-11-14 三次压缩（原档 `MEMORY-archive-2026-11-14.md`）。注入上限约 12KB，超了会被截断。

## 一、发版

- **run=success ≠ 发布成功**，只看步骤级结论（`Build changelog` / `Create Release`）。曾 run=success 而两步全
  skipped：tag 在、Release 零个、无告警。根因：tag 正文有跳过标记，逃生阀判定早于模式判定且匹配整条 message。
- 惯例：tag-only、0 资产、标题=tag 名；自动补丁 `v0.x.y+1`，契约变化才人工打 tag。
- 纯 CI/纯文档用 `[skip release]`，**但它连 tag 一起跳过**（18 笔全带 ⇒ CI success、tag 停旧版）。要发版须人工
  `git tag -a vX.Y.Z && git push origin vX.Y.Z`，tag message 不能含跳过标记。

## 二、速度口径（同片同参，只换引擎）

- 三判据：墙钟、渲染 fps、体积。46.386s/8 段/60fps 同口播：film-kit 51s·55fps｜skia-kit **6.8s·409fps**｜cinecode 113s·24.6fps。
- **fps 随片长上升**（4127 帧 344 vs 1419 帧 195–210）⇒ 跨片比 fps 会误判。两个真开关：有无浏览器（≈6×）、
  中间帧压不压缩（10–30%）。命名四段式 `速度档/模板/传帧/封装`；`editorial` 不走浏览器。

## 三、模板接入与外来项目吸收

先问用途再问技术，默认 Chrome，别把换宿主当性能手段：一次性出片 → Chrome（0）；短期反复且源码可读 +
Canvas2D → 换宿主（几小时）；长期产线 → 半蒸馏（蒸**内容模型**，不蒸视觉代码，2–4 天）。

吸收外来项目（hypit / vibe-knowledge / anything2explainer / iso-explode-film）：**先定性它是什么（引擎？方法包？
素材包？），再分"能平移的规则"与"不可平移的假设"**，产出一份 `docs/<名>-蒸馏-<日期>.md` + 至少一个能跑的检查工具，
不整仓拷贝。anything2explainer 是方法包，三条不可平移：帧率基线（上游 0.1s）、底色极性（`lum>120` 取前景，
遇 paper 浅底会把整张纸当主体）、版式家族（静止占比差 15 倍）。许可证不商用也照此办：只取规则，代码与文字重写；
用户说"不用管协议"时同样重写，不做整段移植。

## 四、交付门禁（`src/gate.mjs`）

- 三项"像门禁"的其实是连续分布，**只报不拦**：hook 0.06–5.29（阈值 0.5 会误杀 13/19）、平均 L\* 0.40–91.3、
  重复帧 0–36.8%。**能拦的只有完整性**：空帧 ≤8%、黑帧 ≤3%、帧数差 ≤1、音画差 ≤0.10s。
- 竖屏必须传 `--subtitle-y 0.28,0.45`（默认写死 `y<0.3`，竖屏 15/15 全报 0%）。
- `--blank` 看主体区 240×105 灰度 std（连续 ≥2s <12）；`--loudness` −16 LUFS ±2 / TP ≤−0.5；
  `--bgm` 看旁白间隙；`--facts` 双向查；`--caption-check` 覆盖 <60% 报警。
- 细则（每条的实测数字、误报率、负向自检）见 `MEMORY-DETAIL.md` §四。

## 五、时间轴契约（`src/temporal.mjs`）

- 两套语义必须分开：骨架 args（v8t）的 `cards[][1]`/`at` 是**绝对秒**；`script.json` 的 `screens` 是**段内相对秒**；
  science 的 `segments` 只有 `dur`（前缀和）。混用会算出超段末时刻 ⇒ 卡片永不出现、只剩字幕。
- 关键词锚点：`{$mark}`（绝对秒）/ `{$markRel}`（段内相对）；词不在表或落点越界 ⇒ **出片前抛错**。
- `number.from` 是数值起点不是时间；不写 `from` 就不滚（`from = value` 只走圆环）。
- `screens` 时刻必须 < 子段时长；每屏要给 `cast`（2–6 字），缺省退标题。
- `args` 里时刻越界会拦（`tools/check-times.mjs` + `auditTiming`）。细则见 `MEMORY-DETAIL.md` §五。

## 六、版式与段型

- 十支版式、两套入口：`render.mjs --kit X`（paper/science/clay/collage/iso…）；editorial/desk/mg 有独立入口，
  传 `--kit` 会报"找不到 kit"。内置只有 4 个 kind，其余走 `templates/own/<name>/src`。
- paper 11 段型 / science 7 段型（用 `segments` 不是 `scenes`，**不能复用 paper 的 build**）；science 图标只有 7 个 ⇒ 选题由图标倒推。
- **args 结构最易混**：`quote.lines` 是字符串数组，`point.words`/`cards` 是 `[["文字",0.4]]` 元组数组
  （写成字符串数组不报错、**不渲染**）。跨版式喂参数会静默产废片（已改为抛错）。
- `iso`（`kits/iso/`）：`layers/parts/arrays/hero/mech` 全 JSON，11 种镜头；遮挡 = 零件对分离轴投票 + 拓扑
  （两轴相反或互穿都不建边）；几何 `box/cyl/ring/ball` + `rot`；`content.faceSort` 给环包内嵌体；
  `look: split|dark|studio`；每镜末段 `settle` 留 0.8–1.0 s 静止。
- **位图背景** `content.backdrop`：只走 `loadImage`（异步）+ 渲染器 `ready()`（`new Image(); src=buf` 在 napi-rs
  里 width/complete 都对，但 drawImage 出来全透明）；伪视差位移要 clamp 在铺满范围内（否则露黑边）；
  `zoom<1.15` 蒙雾化，否则爆炸镜头"人小桌近"；阴影必须**双层**（单层 1.15R 比物体还大，整块桌面被均匀压暗）。
- **贴片** `kind:'sprite'`（永远面向相机的平面）：宽度按两端投影实测；无面集但要有 bbox；`showIn` 按镜头类型
  切图（同一物体的"局部/整体"两张）；**必须补接地阴影**否则浮空；特写机位要收到接近正面（yaw 一转就露馅）。
- **字级对齐（2026-11-15）**：`diagram` 支持每项绑词（`rowAt` 管"是什么"、`at` 管"多大"，
  **两组不能合**，合了念名字时条已长满、报数成复读）。时刻靠本机 ASR —— **edge-tts 拿不到中文词边界**
  （7.3.1 只给 SentenceBoundary，6.1.x 握手 403），走 FireRedASR2-CTC int8
  （`csukuangfj2` / 740 MiB / hf-mirror）+ 逐句切窗 difflib 对齐，载入+3 句 4.2s。
  `resolveAnchors` 对"词不在稿里／越界／顺序倒"一律退出码 2。详见 `docs/字级时间戳-2026-11-15.md`。
- 细则（每型参数手感、五套母版、iso 全部实测）见 `MEMORY-DETAIL.md` §六。

## 七、音频

- `vo.py` 产 wav，**不能 `-c:a copy` 进 MP4**（PCM 在浏览器整轨静音）⇒ 非 aac 一律 `aac 160k`。
- **concat 会静默丢段**：edge-tts 24kHz mp3 + 静音 44.1kHz wav，7 段+6 gap 应 62.05s 实际 60.55s。必须先统一转
  wav 再 concat（无报错，只有时长不对）。
- **`--synth` 走代码合成**（`tools/synth-bgm.mjs`，纯 Node 零依赖、xorshift 确定性、drop 对齐段边界）：
  客观指标与 loop 版等价（−17.1 vs −16.9 LUFS、旁白间隙都 0 段）。本机虽有 Apple Loops 但**不入库**，
  换机/CI 只能走这条。两个坑：kick/hat 必须有 2ms/1ms 起音包络（否则频谱竖线贯穿全频）｜长片 drop 会
  一路到底（90s 片 11.4→87.1s），须让 outro 落在 78% 处 + drop 内每 8 小节回落一次。
- 配乐统一 `tools/audio-bed.mjs`：三层曲风（electrohouse/chillwave/hiphop）、各 4 层 loop 按包络进出。**a 层必须
  是铺底**（鼓组有空档 ⇒ 判"无铺底"FAIL）；各曲风电平差 8–9 dB，TRIM 要乘在**包络上**（hiphop ×2.6），不能乘
  在 amix 后。`content/<片>/bgm.mjs` 是 paper 遗留，别给 science 用。
- `vo.py` 的 `mouthCurve` 是死数据（写在 preset 顶层）⇒ 口型一直走模拟。

## 八、半蒸馏与换宿主

- `check-kit-contract` 段型提取三种写法：switch、白名单数组、**对象映射**（`PAINTERS[cur.type]`），且要允许驼峰
  （`flipBoard`）。覆盖 paper 11 / desk 18 / collage 11；clay/mg 无枚举（真实）。
- 竖屏用 `tools/reframe.mjs`（模糊填充不裁内容），别重排版式：paper 全绝对坐标，改宽高=重写；直裁又切字幕。
  背景 sigma 48 / 压暗 0.18 / 降饱和 0.55。
- `protection` 不是门槛：open 可换宿主，protected 只能 Chrome；换宿主还需引擎是 Canvas2D。已评估 mac-desktop
  最优（480fps/24w）；sketchnote 单核 14fps。**science 双宿主只快 20–27%**，别照抄 paper 的 6.9×。
- Skia：`renderFrame` 1ms 是假象，真实 10–16ms，代价在 `canvas.data()`；唯一有效优化是并行度
  （6/8/12/16/20w → 132/141/172/186/192fps）。

## 九、API 层（`api/` 是唯一业务实现）

- 六动词 capabilities/describe/validate/render/probe/gate；`api/capabilities.json` 由工具生成，不要手改。回执规格
  只信 ffprobe；错误必带 `code/hint/fix`；validate 永不抛。`overrides` 只放渲染超参，内容走 `params`。
- **validate 支持 `if/then/else`**（补之前 paper 9 组必填约束全失效）；仍不支持 `$ref`/`format`。
- 异步 job：一 job 一进程；**判终态先读 stdout 不看 pid**（pid 复用致永久 running）；`status()` 会拉队首。

## 十、仓库与内容

- 依赖单向 `kits/* → src/*`。目录：`render.mjs`/`src`/`kits`/`content`/`assets`/`templates(own|vendor)`/`tools`/`docs`。
  `refs/*`、`out/`、`content/*/audio/` 不入库。仓库根只从 `src/root.mjs`，字体只 `src/fonts.mjs`。
- `paper.mjs` 关键词卡兜底 `cast > title > label`，**不要退到 scene.type**（会印出 hero/compare）。
- 片库十支（2026-11-14）：paper 五支 55–102s、science 一支 62.1s、desk 两支 65.7/99.3s、iso 一支 27.3s。
- `tools/report.mjs` 出片库总览；`tools/publish-pack.mjs` 封面取**段末**（段中元素只长一半），标题带必须**不透明**
  （半透明会透出字幕条），字体用单 TTF（`.ttc` 索引不到中文会渲成方块）。
- `tools/coverage.mjs` 主指标是**每种段型平均复用次数**（≥3 次即明显重复），不是覆盖率。

## 十一、人物与字幕

- Skia 侧 `collectFigures()` 见 `document===undefined` 直接 return ⇒ 不补 `__MK_FIGS` 会静默退化成矢量。位图姿态图
  更快（15.2→13.2s）；`figureHeight` 矢量 0.86 / 3D 0.92–0.96。
- 字幕 62px 单行上限 **26 字**，超了按标点折行 + 降档（50→44）；安全区用视觉顶端；两行统一字号。
- 圆盘插画别用方图直塞，用 `tools/circle-prop.mjs` 做圆形 alpha。

## 十二、审查自身也会错

- `adversarial.mjs` 曾用 `params.fps`(30) 切 60fps 帧 ⇒ 8/8 报"重复帧"。已改优先 ffprobe `r_frame_rate`；
  **60fps 出片后必须重跑**。
- 版式清单必须逐支 probe 再写（照 README 抄曾 3 支假可用、又漏 3 支真能跑的）。
- 「适配 1–2 天/个」估算错了：lemo 框架仅 189KB/21 文件/2 包，代码 1–2 小时，成本全在素材。
