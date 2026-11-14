import { cliAdapter } from './_runner.mjs';

export const capability = {
  id: 'iso',
  name: '等轴测爆炸大片（产品拆装）',
  description:
    '蒸馏自 Warrickchenxin/iso-explode-film（等轴爆炸大片 skill）的内容模型与镜头库：' +
    '把一件产品拆成几十个凸块零件，按层爆炸、阵列飞散、核心件特写拆解、机构按压、夹层推镜，' +
    '最后一层层合拢。0.25 s 甩镜做转场、停留时镜头缓慢漂移、最后半秒静止。' +
    '上游是 SVG + Chrome 逐帧截图 + numpy 透视合成，本实现整条链压进 Skia Canvas2D（无浏览器、无中间帧），' +
    '零件几何与整支分镜全部是声明式 JSON，改产品不改代码。',
  contentModel: {
    name: 'scenes[] + content{layers,parts,arrays,hero,mech}',
    required: true,
    note:
      'scenes 是九种镜头（hero/rise/explode/part/action/array/stack/assemble/end），每段 {type,t0,t1,args}；' +
      'content 是产品本体：layers 从上到下、parts 是凸块（box/cyl/prism）、arrays 是重复件、hero 是被拆的核心件、' +
      'mech 是机构动作。几何即一切：画面里只有零件，不贴图。零件之间不许穿插——穿插会让画家算法的遮挡顺序无解。',
  },
  output: { width: 1920, height: 1080, fpsChoices: [30, 60], fpsDefault: 60 },
  paramsSchema: 'kits/iso/params.schema.json',
  schemaStatus: 'complete',
  presets: [
    {
      id: 'powerbank',
      path: 'content/iso-powerbank/params.json',
      note: 'PB-1 移动电源 · 7 层 36 件 · 25.6s · 成片 out/iso-powerbank.mp4',
    },
  ],
  defaultPreset: 'content/iso-powerbank/params.json',
  audio: {
    required: false,
    note:
      '本支默认无声（几何与运镜本身就是节奏）。要配乐可走 params.audio 的 external-music，' +
      '或先出无声片再用 tools/audio-bed.mjs 叠。上游的配乐是 film/synth.py 代码合成（Am–F–C–G / 120 BPM），本仓不移植。',
  },
  extras: { look: ['split', 'dark'] },
  entry: { type: 'cli', script: 'render.mjs' },
  note:
    '实测 1536 帧 / 25.6s / 1920×1080@60：12.5s（123 fps，15 worker）。' +
    '上游同一支量级（900 帧 × 2 版）在 8 核笔记本上 1.5–2 小时，约 0.3 帧/秒 ⇒ 两个数量级以上，' +
    '差异来自「浏览器逐帧截图 + numpy 合成」与「Canvas2D 单进程直出」。',
};

export const adapter = cliAdapter(capability, {
  script: 'render.mjs',
  kitId: 'iso',
});
