import { cliAdapter } from './_runner.mjs';

export const capability = {
  id: 'collage',
  name: '屏拼贴（深色科技风宣传片）',
  description:
    '半蒸馏自 motiongit.com/motiongit/motiongit-promo-main（template-585，v2.6.5-alpha.1）的 11 段结构：' +
    'hero / recipe / open / pack / flow / adapt / reuse / spec / share / finale / end。' +
    '深色底 + 全息字标 + 编辑器风 HUD + 底部时间轴，适合产品发布、工具介绍、规格说明。' +
    '上游是 html-canvas/1 且渲染核 AES-256-GCM 加密，换宿主不成立，故走半蒸馏（自写 Skia 渲染层）。',
  contentModel: {
    name: 'scenes[]',
    required: true,
    note:
      '每段 {type, t0, t1, args}。args 承载该段全部内容：hero 是 chip/kline/klineGrad/decode，' +
      'recipe 是 cards[] + 对照文案，flow 是 steps[] + messages[]，spec 是 tools[]，share 是 branches[]。' +
      '完整字段见 params.schema.json 的 x-sceneArgs。文案里用 klineGrad 指定要渐变的那一段（必须是子串）。',
  },
  output: { width: 1920, height: 1080, fpsChoices: [30, 60], fpsDefault: 60 },
  paramsSchema: 'kits/collage/params.schema.json',
  schemaStatus: 'complete',
  presets: [
    {
      id: 'cutduo',
      path: 'kits/collage/presets/cutduo.json',
      note: '11 段 / 57s，本仓自己的短片（成片 out/cutduo-film-57s.mp4）；就是一份 params JSON',
    },
    {
      id: 'demo',
      path: 'kits/collage/presets/demo.json',
      note: '11 段 / 57s，参考片复刻件（唯一保留 MotionGit 品牌的地方，用于逐帧对位）',
    },
    {
      id: 'capability-test',
      path: 'kits/collage/presets/capability-test.json',
      note: '能力验收件：7 个静止点加停留（57→68.5s）+ 真实素材接 adapt/reuse，用来验 hold 与 media',
    },
  ],
  defaultPreset: 'kits/collage/presets/cutduo.json',
  audio: {
    required: false,
    note:
      'params.audio 支持事件轨：cues[{at,src,gain}] 按绝对秒定位，src 可指向文件或内置合成音 ' +
      '（whoosh/tick/impact/rise，程序合成，非上游音效）。mode=effects-only 只出音效，external-music 叠配乐，' +
      '有 voice 时自动 sidechain ducking。命令行 --audio 优先级更高。',
  },
  extras: { theme: [], transition: ['cut'] },
  entry: { type: 'cli', script: 'render.mjs' },
  note:
    '实测 3420 帧 / 57s / 1920×1080@60：11.4s（300 fps，8 worker）。' +
    '上游自述 1080p60 约 2.7 帧/秒（同片约 21 分钟）⇒ 约 111×。',
};

export const adapter = cliAdapter(capability, {
  script: 'render.mjs',
  kitId: 'collage',
});
