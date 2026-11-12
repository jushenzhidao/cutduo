/**
 * src/root.mjs · 仓库根探测与输入路径解析
 *
 * 原先四个 kit 各自用 `path.resolve(dirname, '..')` 猜仓库根：
 * skia-kit 在 motiongit-lab/ 下一层成立，desktop-kit / mg-kit 同层也成立。
 * 一旦 kit 搬进 kits/<name>/，深度多一层，那条 `..` 就会指到 kits/ 而不是仓库根。
 *
 * 这里改成向上找 `.git`（唯一可靠的仓库标记），搬家不再需要改任何 ROOT 计算。
 * 若在非 git 目录里运行（如打成单文件分发），退回调用者所在目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

/**
 * 容器里没有 .git，向上探测会一直走到 / 然后退回 SRC_DIR，路径全错。
 * 所以部署时用 CUTDUO_ROOT 显式指定；产物目录同理用 CUTDUO_OUT 指到可写卷。
 */
export const REPO_ROOT = process.env.CUTDUO_ROOT
  ? path.resolve(process.env.CUTDUO_ROOT)
  : findRepoRoot(SRC_DIR);

/**
 * 相对路径解析：先按 cwd，再按仓库根。
 * 这样从仓库根、从 kits/ 里、或从任意工作目录跑都能找到同一份文件。
 * @param {string|null|undefined} p
 * @param {boolean} mustExist  false 表示“按根拼出来即可，不必存在”（输出路径用）
 */
export function resolveInput(p, mustExist = true) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  const byCwd = path.resolve(p);
  if (fs.existsSync(byCwd)) return byCwd;
  const byRoot = path.join(REPO_ROOT, p);
  if (fs.existsSync(byRoot) || !mustExist) return byRoot;
  return byCwd;
}

/** 常用目录，避免各 kit 重复拼路径。 */
export const DIRS = {
  root: REPO_ROOT,
  src: path.join(REPO_ROOT, 'src'),
  kits: path.join(REPO_ROOT, 'kits'),
  content: path.join(REPO_ROOT, 'content'),
  assets: path.join(REPO_ROOT, 'assets'),
  fonts: path.join(REPO_ROOT, 'assets', 'fonts'),
  audio: path.join(REPO_ROOT, 'assets', 'audio'),
  // 容器里挂的是只读代码卷 + 可写数据卷，产物与 job 状态必须落到后者
  out: process.env.CUTDUO_OUT ? path.resolve(process.env.CUTDUO_OUT) : path.join(REPO_ROOT, 'out'),
  refs: path.join(REPO_ROOT, 'refs'),
};
