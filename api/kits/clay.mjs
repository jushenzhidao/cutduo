import { cliAdapter } from './_runner.mjs';

export const capability = {
  id: 'clay',
  name: '黏土图示',
  description:
    '换宿主自 knowledge-explainer-clay v2.7.4 的 7 种机制：split-merge / interface-bind / shear-break / ' +
    'lineage-track / channel-transport / focus-return / alternative-compare。' +
    '数值驱动的黏土物体形变，适合过程解释、科学图示、拆解合并。',
  contentModel: {
    name: 'segments[]',
    required: true,
    note:
      '每个 segment 是一条 recipe：type 填机制名，dur 为该段时长，' +
      '再带 title / nodes[{id,label,value}] / unit / valueUnit / decimals 与该机制专有字段。' +
      'captions 可选（本套自带字幕绘制）。',
  },
  output: { width: 1920, height: 1080, fpsChoices: [30, 60], fpsDefault: 30 },
  paramsSchema: 'kits/clay/params.schema.json',
  schemaStatus: 'complete',
  presets: [{ id: 'default', path: 'kits/clay/presets/default.json', note: '7 段 / 70s，覆盖全部机制' }],
  defaultPreset: 'kits/clay/presets/default.json',
  audio: { required: false, note: '上游片为无声演示；有口播时给 --audio，音轨会转 aac' },
  extras: { theme: ['clay'], transition: ['cut'] },
  entry: { type: 'cli', script: 'render.mjs' },
  note: '上游 runtime 写作 native-python-node/1，但绘制层是纯 Canvas2D，故走换宿主而非半蒸馏。',
};

export const adapter = cliAdapter(capability, {
  script: 'render.mjs',
  kitId: 'clay',
});
