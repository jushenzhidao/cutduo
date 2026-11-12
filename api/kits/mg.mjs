import { cliAdapter } from './_runner.mjs';

export const capability = {
  id: 'mg',
  name: 'MG 动效',
  description: '5 类镜头的动效验证：文字 / 档案时间轴 / 黑洞 2.5D 粒子 / 等轴积木 / 信息卡，带确定性自检。2026-11-10 后未改动。',
  contentModel: {
    name: 'params.json',
    required: true,
    note: '结构自成一套（非 scenes/shots/segments），以 kits/mg/params.json 为准。',
  },
  output: { width: 1920, height: 1080, fpsChoices: [24, 30, 60], fpsDefault: 60 },
  paramsSchema: 'kits/mg/params.schema.json',
  schemaStatus: 'complete',
  schemaNote: 'schema 只约束 scenes 骨架与画幅字段；镜头参数在 args 里，结构随 type 变化，不在 schema 里锁死。',
  presets: [{ id: 'default', path: 'kits/mg/params.json', note: '唯一参数集' }],
  defaultPreset: 'kits/mg/params.json',
  audio: { required: false, note: '无口播，通常不出音轨' },
  extras: {},
  entry: { type: 'cli', script: 'kits/mg/render.mjs' },
};

export const adapter = cliAdapter(capability, {
  script: 'kits/mg/render.mjs',
});
