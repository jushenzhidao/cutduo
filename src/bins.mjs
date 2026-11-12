/**
 * src/bins.mjs · 外部二进制路径解析
 *
 * 为什么需要：代码里曾把 ffmpeg 写死成 `/opt/homebrew/bin/ffmpeg`（macOS Homebrew 的位置）。
 * 本地一切正常，云端第一次出片就 `spawn /opt/homebrew/bin/ffmpeg ENOENT` ——
 * 容器里它在 /usr/bin。写死任何一方都会让另一边挂掉，且这个错误在本地冒烟里永远看不见。
 *
 * 解析优先级：环境变量 → macOS Homebrew 路径 → 交给 PATH 搜索。
 * 最后一步是关键：PATH 里的 `ffmpeg` 在两种环境都能命中。
 */
import fs from 'node:fs';

function resolveBin(envKey, name, macPath) {
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(macPath)) return macPath;
  } catch {
    /* 无权限等情况，退回 PATH */
  }
  return name; // 裸名，由子进程的 PATH 解析
}

export const FFMPEG = resolveBin('FFMPEG', 'ffmpeg', '/opt/homebrew/bin/ffmpeg');
export const FFPROBE = resolveBin('FFPROBE', 'ffprobe', '/opt/homebrew/bin/ffprobe');
