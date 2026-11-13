import { cliAdapter } from './_runner.mjs';

export const capability = {
  id: 'night-card',
  name: '夜色卡片',
  description:
    '竖屏 9:16 情绪向卡片：一屏一句话，深色底加暖金点缀，四角取景框 + 底部进度线。六个版式 cover / statement / quote / contrast / number / outro，段长中位 7s，适合深夜独白、情绪向口播。',
  contentModel: {
    name: 'segments[]',
    required: true,
    note:
      '每段需要 type / dur 与对应版式参数（cover: title/sub/kicker；statement: text/note；quote: text/from；' +
      'contrast: before/after；number: value/label/note；outro: title/sub/brand）。durationSeconds 必须等于 dur 之和。',
  },
  output: { width: 1080, height: 1920, fpsChoices: [24, 30, 60], fpsDefault: 30 },
  paramsSchema: 'templates/own/night-card/params.schema.json',
  schemaStatus: 'complete',
  presets: [
    {
      id: 'default',
      path: 'templates/own/night-card/presets/default.json',
      note: '8 段示例，56s，覆盖全部六个版式',
    },
  ],
  defaultPreset: 'templates/own/night-card/presets/default.json',
  audio: { required: false, note: '情绪向卡片默认无声，正文即大字；有旁白时给 m4a，字幕走 subtitle 口径' },
  extras: {
    theme: ['night'],
    layouts: ['cover', 'statement', 'quote', 'contrast', 'number', 'outro'],
  },
  entry: { type: 'cli', script: 'render.mjs' },
};

export const adapter = cliAdapter(capability, {
  script: 'render.mjs',
  kitId: 'night-card',
});
