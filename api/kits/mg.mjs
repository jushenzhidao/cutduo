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
  paramsSchema: null,
  schemaStatus: 'missing',
  schemaNote: '本支只用一份固定 params.json，尚未抽出 schema。结构变化时 API 无从校验，需靠 smoke.sh 兜底。',
  presets: [{ id: 'default', path: 'kits/mg/params.json', note: '唯一参数集' }],
  defaultPreset: 'kits/mg/params.json',
  audio: { required: false, note: '无口播，通常不出音轨' },
  extras: {},
  entry: { type: 'cli', script: 'kits/mg/render.mjs' },
};

export const adapter = cliAdapter(capability, {
  script: 'kits/mg/render.mjs',
});
