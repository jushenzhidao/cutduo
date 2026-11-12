import { cliAdapter } from './_runner.mjs';

export const capability = {
  id: 'paper',
  name: '纸感口播',
  description: '从 paper-perspective 成片逐像素反推的 8 个版式：hero / point / number / compare / steps / quote / checklist / outro。适合知识口播、单主持、强排版。',
  contentModel: {
    name: 'scenes[]',
    required: true,
    note: '每个 scene 需要 type / t0 / t1 / args；时间单位秒。captions 可选。',
  },
  output: { width: 1920, height: 1080, fpsChoices: [24, 30, 60], fpsDefault: 60 },
  paramsSchema: 'kits/paper/params.schema.json',
  schemaStatus: 'complete',
  presets: [{ id: 'v8t', path: 'kits/paper/presets/v8t.json', note: '8 版式示例，42.9s' }],
  defaultPreset: 'kits/paper/presets/v8t.json',
  audio: { required: false, note: '有口播时必须给；无音轨也能出片但 gate 会告警' },
  extras: { theme: ['clean'], transition: ['cut', 'fade'] },
  entry: { type: 'cli', script: 'render.mjs' },
};

export const adapter = cliAdapter(capability, {
  script: 'render.mjs',
  kitId: 'paper',
});
