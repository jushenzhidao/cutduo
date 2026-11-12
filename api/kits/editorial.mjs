import { cliAdapter } from './_runner.mjs';

export const capability = {
  id: 'editorial',
  name: '杂志剪辑',
  description: '8 段分镜的杂志排版：强网格、大字号标题、色块分区。改造自 MIT 项目，适合观点输出与品牌短片。',
  contentModel: {
    name: 'scenes[]',
    required: true,
    note: '需要 scenes 与 durationSeconds；brand / accent 可选。参数文件在 content/inputs-*.json。',
  },
  output: { width: 1920, height: 1080, fpsChoices: [24, 30, 60], fpsDefault: 24, fpsNote: '实际帧率由 params.fps 决定，inputs-v6 是 24fps' },
  paramsSchema: null,
  // 不假装有校验：这支没有 params.schema.json，API 会放行但回执里标明 unvalidated
  schemaStatus: 'missing',
  schemaNote: '本支尚未提供 params.schema.json，validate 会对参数放行并在回执标 unvalidated:true。补 schema 后自动生效。',
  presets: [
    { id: 'inputs-v6', path: 'content/inputs-v6.json', note: '6 版分镜' },
    { id: 'inputs-v8t', path: 'content/inputs-v8t.json', note: '8 版分镜' },
    { id: 'inputs-kit', path: 'content/inputs-kit.json', note: '纸感同源内容' },
    { id: 'inputs-md', path: 'content/inputs-md.json', note: '基准用固定内容' },
  ],
  defaultPreset: 'content/inputs-v6.json',
  audio: { required: false, note: '口播片必须给；无音轨只出画面' },
  extras: { theme: '强调色', skin: '排版风格', avatar: '头像路径或 off' },
  entry: { type: 'cli', script: 'kits/editorial/canvas-editorial.mjs' },
};

export const adapter = cliAdapter(capability, {
  script: 'kits/editorial/canvas-editorial.mjs',
  // 这支的参数名与其他四支不同：读 --inputs 而不是 --params
  paramsFlag: '--inputs',
});
