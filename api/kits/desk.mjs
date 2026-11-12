import { cliAdapter, buildArgs } from './_runner.mjs';

export const capability = {
  id: 'desk',
  name: '桌面片场',
  description: '把整台 Mac 桌面重写成模板：桌面骨架 + 16 个版式镜头 + photo/clip 两类素材镜头，13 项量化自检。适合软件演示、产品叙事。',
  contentModel: {
    name: 'shots[]',
    required: true,
    note: '需要 fps / durationSeconds / shots；chapters 决定壁纸与整屏翻牌，brand 是右下角角标。',
  },
  output: { width: 1440, height: 1080, fpsChoices: [24, 30, 60], fpsDefault: 60 },
  paramsSchema: 'kits/desk/params.schema.json',
  schemaStatus: 'complete',
  presets: [
    { id: 'demo', path: 'content/demo.json', note: '基础演示，无配音' },
    { id: 'demo-voiced', path: 'content/demo-voiced.json', note: '带配音对齐' },
    { id: 'hotpot', path: 'content/hotpot.json', note: '实拍 + 分镜混合' },
    { id: 'nanjing', path: 'content/nanjing.json', note: '城市叙事' },
    { id: 'uv', path: 'content/uv.json', note: '单概念讲解' },
  ],
  defaultPreset: 'content/demo.json',
  audio: { required: false, note: '口播片必须给；`-voiced` 系列参数已按配音时长重排' },
  extras: { presenter: '头像路径或 off', profiles: ['standard', 'quality'] },
  entry: { type: 'cli', script: 'kits/desk/render.mjs' },
};

export const adapter = cliAdapter(capability, {
  script: 'kits/desk/render.mjs',
});
