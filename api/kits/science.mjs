import { cliAdapter } from './_runner.mjs';

export const capability = {
  id: 'science',
  name: '科普讲解',
  description: '自建 9 版式：讲解位 37% / 图解释意 33% / 标签强调 10% / 阵列 6% / 对比 4% / 首尾 10%。切点中位 2.75s，跟句子走不跟动作走。',
  contentModel: {
    name: 'segments[]',
    required: true,
    note: '每段 { type, dur, ...平铺参数 } 或 { type, dur, args }。durationSeconds 必须等于各段 dur 之和。',
  },
  output: { width: 1920, height: 1080, fpsChoices: [24, 30, 60], fpsDefault: 30 },
  paramsSchema: 'kits/science/template/params.schema.json',
  // 跨片可复用的标定值（画幅/调色板/字幕样式/各版式锚点 + 容差）。
  // agent 取默认值或做断言都读这一个文件，不必翻片级的 elements.json。
  calibration: {
    path: 'kits/science/template/calibration.json',
    schema: 'cutduo-calibration/1',
    profiles: ['current', 'legacy-2026-11'],
    verify: 'node tools/verify-calibration.mjs --params <preset.json>',
    note: 'entries[].scope=appearance 的值绑定 profile，params.profile 不匹配时验证器判 SKIP 而非 PASS。',
  },
  schemaStatus: 'complete',
  presets: [
    { id: 'demo', path: 'kits/science/template/presets/demo.json', note: '基础演示' },
    { id: 'demo.vo', path: 'kits/science/template/presets/demo.vo.json', note: '带配音时长对齐' },
    { id: 'microwave', path: 'kits/science/template/presets/microwave.json', note: '微波炉原理，含图解释意' },
    { id: 'microwave.vo', path: 'kits/science/template/presets/microwave.vo.json', note: '同上，配音版' },
    { id: 'kids-qa', path: 'kits/science/template/presets/kids-qa.json', note: '儿童问答体' },
    { id: 'nap-qa', path: 'kits/science/template/presets/nap-qa.json', note: '午睡问答体' },
    { id: 'demo.edge', path: 'kits/science/template/presets/demo.edge.json', note: '边界用例' },
  ],
  defaultPreset: 'kits/science/template/presets/demo.json',
  audio: { required: false, note: '口播科普片必须给；片段时长与音轨需对齐，否则末段被截断' },
  extras: { theme: '任意强调色对象', dualHost: '同一份 kit.js/layouts.js 可跑浏览器宿主' },
  entry: { type: 'cli', script: 'render.mjs' },
};

export const adapter = cliAdapter(capability, {
  script: 'render.mjs',
  kitId: 'science',
});
