/**
 * src/fonts.mjs · 字体注册（全仓库唯一入口）
 *
 * 这段逻辑原先长在 kits/paper 的 paper.mjs 里，于是 mg、editorial、desk 三个
 * 与纸感毫无关系的版式都要 `import { registerFonts } from '../skia-kit/paper.mjs'`。
 * 版式之间因此产生了一条假的依赖边：换 paper 的字体就会牵动另外三支。
 *
 * 抽到 src/ 后依赖方向变为 kits/* → src/*，单向。
 * paper.mjs 仍 re-export 同名函数，旧调用点不需要改。
 *
 * 分组口径（2026-11-13 重整）：
 *   基础三档 —— 任何 kit 都靠它兜中文，缺了整屏退化
 *   模板专用 —— 按「谁在用」分组，一个模板一行注释；共用字体只登记一次
 * 字体文件不进 git（见 assets/fonts/.gitignore），换机器先跑 `bash tools/fetch-fonts.sh`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';
import { DIRS } from './root.mjs';

/**
 * 基础三档 Noto Sans SC：五支内置 kit（paper / science / desk / editorial / mg）
 * 全部依赖它。缺了会回退系统字体——在 Linux 容器里等于整屏豆腐块且不报错
 * （2026-11-13 云端 editorial 就这么坏过，见 docs/FONTS.md）。
 */
export const BASE_FONTS = [
  ['NotoSansSC-Black.otf', 'NotoSC Black'],
  ['NotoSansSC-Medium.otf', 'NotoSC Medium'],
  ['NotoSansSC-Regular.otf', 'NotoSC Regular'],
];

/**
 * 模板专用字体，按使用方分组。注册失败不中断出片：
 * 各 kit 的 font 串末尾都带系统兜底，只是字形会失去风格。
 */
export const TEMPLATE_FONTS = {
  /** chalkboard（粉笔黑板）：粉笔字必须用 LongCang，笔画断开才像真粉笔 */
  chalkboard: [
    ['LongCang-Regular.ttf', 'LongCang'],
  ],
  /** 手写体共用组：chalkboard 的数字与正文 + cute-mv 的歌词（霞鹜文楷 / 站酷快乐体） */
  hand: [
    ['LXGWWenKai-Regular.ttf', 'LXGW WenKai'],
    ['ZCOOLKuaiLe-Regular.ttf', 'ZCOOL KuaiLe'],
  ],
  /** collage（深色科技风）：Mona Sans 是上游随包西文（OFL），JetBrains Mono 负责 HUD / 数值。
   *  Mona Sans 没有中文字形，中文由 Noto 兜底——渲染成空白而不是方框，更容易被忽略。 */
  collage: [
    ['MonaSans-Black.ttf', 'MonaBlack'],
    ['MonaSans-Bold.ttf', 'MonaBold'],
    ['MonaSans-SemiBold.ttf', 'MonaSemiBold'],
    ['MonaSans-Medium.ttf', 'MonaMedium'],
    ['MonaSans-Regular.ttf', 'MonaRegular'],
    ['MonaSansDisplay-Black.ttf', 'MonaDispBlack'],
    ['MonaSansExpanded-Black.ttf', 'MonaExpBlack'],
    ['MonaSansExpanded-Bold.ttf', 'MonaExpBold'],
    ['MonaSansExpanded-SemiBold.ttf', 'MonaExpSemi'],
    ['MonaSansExpanded-Medium.ttf', 'MonaExpMedium'],
    ['JetBrainsMono-Regular.ttf', 'JBMono'],
    ['JetBrainsMono-Medium.ttf', 'JBMonoMedium'],
    ['JetBrainsMono-Bold.ttf', 'JBMonoBold'],
  ],
};

/**
 * 合并视图：基础 + 全部模板专用。`registerFonts()` 注册的就是这一份。
 * 保持这个导出的名字不变，是因为外部有按它做「字体是否齐全」判断的调用点。
 */
export const FONT_FILES = [
  ...BASE_FONTS,
  ...Object.values(TEMPLATE_FONTS).flat(),
];

/**
 * 三件套模板（cute-mv 这类）额外要的手写体。
 * 与 TEMPLATE_FONTS.hand 是**同一个对象**，不是副本——早先这里重复列了 LXGW，
 * 结果调整字体时要改两处、漏一处就静默不一致。
 */
export const HAND_FONTS = TEMPLATE_FONTS.hand;

/** 注册手写体；缺文件静默跳过（模板会退化成 Noto，画面仍成立）。 */
export function registerHandFonts(dir = DIRS.fonts) {
  let ok = 0;
  for (const [file, name] of HAND_FONTS) {
    const p = path.join(dir, file);
    try {
      if (fs.existsSync(p)) {
        GlobalFonts.registerFromPath(p, name);
        ok++;
      }
    } catch {
      /* 单个字体坏掉不中断出片 */
    }
  }
  return ok;
}

/**
 * 注册全部字体。重复注册同一路径是幂等的（GlobalFonts 按路径去重），
 * 所以 `registerFonts()` 与 `registerHandFonts()` 可以叠加调用。
 * @param {string} [dir] 字体目录，默认 <repo>/assets/fonts
 * @returns {number} 成功注册的字重数
 */
export function registerFonts(dir = DIRS.fonts) {
  let ok = 0;
  let base = 0;
  for (const [file, name] of FONT_FILES) {
    const p = path.join(dir, file);
    try {
      if (fs.existsSync(p)) {
        GlobalFonts.registerFromPath(p, name);
        ok++;
        if (BASE_FONTS.some(([f]) => f === file)) base++;
      }
    } catch {
      /* 单个字体坏掉不应中断出片 */
    }
  }
  if (!base) {
    console.warn(
      '  \u26a0 \u672a\u627e\u5230 Noto Sans SC\uff0c\u6807\u9898\u4f1a\u56de\u9000\u7cfb\u7edf\u5b57\u4f53\uff08\u89c6\u89c9\u76f8\u4f3c\u5ea6\u4e0b\u964d\uff09\n' +
        '     \u8865\u5b57\u4f53\uff1abash tools/fetch-fonts.sh',
    );
  }
  return ok;
}
