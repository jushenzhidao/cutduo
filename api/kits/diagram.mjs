import { cliAdapter } from './_runner.mjs';

export const capability = {
  id: 'diagram',
  name: '说明性图示（13 类段型库）',
  description:
    '把「数据怎么比、关系怎么走、结构怎么分」画成图，而不是写成句子。' +
    '13 类段型：data-bar / data-line / hierarchy / cycle / definition / compare / ' +
    'process / causal / parts / experiment / evidence / formula / recap。' +
    '这是段型库而不是完整版式：不自带片头、讲解员与字幕条，出片入口只用于版式验证；' +
    '要成片请把它当段型来源，或在 presets 里串成一条验证片。',
  contentModel: {
    name: 'segments[]',
    required: true,
    note:
      '每段 { family, duration, title?, unit?, note?, items[] }，字段契约见 kits/diagram/README.md。' +
      '字级锚点：params.timing 指向 ASR 产出的 timing.json（也可用 CLI --timing）；' +
      '给了之后 item 的 at/rowAt 改为「念到才动」，不给则按序号均分。' +
      '段内时刻是相对秒，跨段用前缀和——与 paper 的绝对秒不是一套语义。',
  },
  output: { width: 1920, height: 1080, fpsChoices: [30, 60], fpsDefault: 30 },
  paramsSchema: 'kits/diagram/params.schema.json',
  schemaStatus: 'complete',
  presets: [
    { id: 'default', path: 'kits/diagram/presets/default.json', note: '4 类示范 · 26s' },
    { id: 'all', path: 'kits/diagram/presets/all.json', note: '13 类全量 · 84s' },
    { id: 'render-cost', path: 'kits/diagram/presets/render-cost.json', note: '8 段 · 64s' },
    { id: 'render-cost-20s', path: 'kits/diagram/presets/render-cost-20s.json', note: '3 段 · 22s' },
    { id: 'talkcraft-15s', path: 'kits/diagram/presets/talkcraft-15s.json', note: '5 段 · 22s' },
  ],
  defaultPreset: 'kits/diagram/presets/default.json',
  audio: {
    required: false,
    note:
      '无声可出片。要音轨用请求的 audio 字段（会转成 --audio）；' +
      '也可在 params.audio 里写相对仓库根的路径。',
  },
  extras: {
    palette: ['paper', 'neutral'],
    families: [
      'data-bar', 'data-line', 'hierarchy', 'cycle', 'definition', 'compare',
      'process', 'causal', 'parts', 'experiment', 'evidence', 'formula', 'recap',
    ],
  },
  entry: { type: 'cli', script: 'kits/diagram/render.mjs' },
  note:
    '单进程渲染（首版不接 worker 分片）：一段 8s 的图示不值得为分片付调度成本。' +
    '要上产线再接 src/pipeline.mjs 的 planShards，接口已留好。',
};

export const adapter = cliAdapter(capability, {
  script: 'kits/diagram/render.mjs',
  // 单进程：没有 workers / pipe / theme / transition 这些开关。
  // 与其静默忽略，不如让 API 明确拒绝——调用方才能改对。
  supportedOverrides: ['fps', 'crf', 'preset'],
});
