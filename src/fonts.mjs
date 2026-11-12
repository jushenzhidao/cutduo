/**
 * src/fonts.mjs · 字体注册（全仓库唯一入口）
 *
 * 这段逻辑原先长在 kits/paper 的 paper.mjs 里，于是 mg、editorial、desk 三个
 * 与纸感毫无关系的版式都要 `import { registerFonts } from '../skia-kit/paper.mjs'`。
 * 版式之间因此产生了一条假的依赖边：换 paper 的字体就会牵动另外三支。
 *
 * 抽到 src/ 后依赖方向变为 kits/* → src/*，单向。
 * paper.mjs 仍 re-export 同名函数，旧调用点不需要改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';
import { DIRS } from './root.mjs';

/** 模板依赖的三档 Noto Sans SC；缺字体会回退系统字体，视觉退化。 */
export const FONT_FILES = [
  ['NotoSansSC-Black.otf', 'NotoSC Black'],
  ['NotoSansSC-Medium.otf', 'NotoSC Medium'],
  ['NotoSansSC-Regular.otf', 'NotoSC Regular'],
];

/**
 * 注册模板所需字重。重复注册同一路径是幂等的（GlobalFonts 按路径去重）。
 * @param {string} [dir] 字体目录，默认 <repo>/assets/fonts
 * @returns {number} 成功注册的字重数
 */
export function registerFonts(dir = DIRS.fonts) {
  let ok = 0;
  for (const [file, name] of FONT_FILES) {
    const p = path.join(dir, file);
    try {
      if (fs.existsSync(p)) {
        GlobalFonts.registerFromPath(p, name);
        ok++;
      }
    } catch {
      /* 单个字体坏掉不应中断出片 */
    }
  }
  if (!ok) {
    console.warn(
      '  \u26a0 \u672a\u627e\u5230 Noto Sans SC\uff0c\u6807\u9898\u4f1a\u56de\u9000\u7cfb\u7edf\u5b57\u4f53\uff08\u89c6\u89c9\u76f8\u4f3c\u5ea6\u4e0b\u964d\uff09',
    );
  }
  return ok;
}
