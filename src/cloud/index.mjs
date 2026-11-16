/**
 * src/cloud/index.mjs · 侧车能力层（cloud sidecar）
 *
 * 定位：**需要网络、凭据、且可能失败**的能力放这里，TTS 只是第一个。
 * 渲染器（src/pipeline.mjs / kits/*）与契约层（api/*）都不该知道 provider 是谁。
 *
 * 加新能力时保持同一契约，调用方就不用改：
 *   1. 输入可哈希（同输入必须同输出，否则不能缓存）
 *   2. 输出落地成文件（不返回内存 buffer——大对象会撑爆回执）
 *   3. 失败可降级（failMode: soft ⇒ 主流程继续，只是少这项增强）
 *   4. 命中缓存要上报（否则看不出"这次为什么只花了 1 秒"）
 */
import path from 'node:path';
import fs from 'node:fs';
import { synthesizeCaptions, ttsInfo, CACHE_ROOT } from './tts.mjs';

export { synthesizeCaptions, ttsInfo, CACHE_ROOT };

/** 当前可用的侧车能力清单（给 /health 与 capabilities 用）。 */
export function cloudCapabilities() {
  return [ttsInfo()];
}

/**
 * 出片前的侧车阶段：params 里有 captions、请求又没给音轨时，自动配音。
 *
 * 三条刻意的设计：
 * - **失败降级**：TTS 挂了出无声片并告警，不让整个请求失败。视频本身可用，
 *   而"因为这个片区没网所以出不了片"是更糟的失败。
 * - **不覆盖显式 audio**：调用方自己传了音轨就绝不插手，那是明确意图。
 * - **可关**：`autoTts: false` 一律跳过，给"我就要无声版"留出口。
 *
 * @returns {Promise<{audio:string|null, stats:object}>}
 */
export async function autoTts({ params, paramsPath, durationSeconds, cacheDir, voice, rate }) {
  try {
    return await synthesizeCaptions({
      params,
      paramsPath,
      durationSeconds,
      cacheDir: cacheDir || CACHE_ROOT,
      voice,
      rate,
    });
  } catch (e) {
    // failMode: soft —— 记录原因，交给回执，不抛
    return {
      audio: null,
      stats: {
        failMode: 'soft',
        error: String(e?.message || e).slice(0, 240),
        hint: '配音失败不影响出片，只是音轨为空；查 edge-tts 是否在 PATH、容器能否访问 speech.platform.bing.com',
      },
    };
  }
}

/** 供回执使用：把 stats 压成人类能读的一行。 */
export function summarizeTts(stats) {
  if (!stats) return null;
  if (stats.error) return `配音失败（已降级为无声）：${stats.error}`;
  if (stats.reason) return `未配音：${stats.reason}`;
  const parts = [`${stats.sentences} 句`, `${stats.totalSeconds}s`];
  if (stats.sentenceCacheHits) parts.push(`缓存命中 ${stats.sentenceCacheHits}/${stats.sentences}`);
  if (stats.bedCached) parts.push('整轨复用');
  if (stats.overflow?.length) parts.push(`${stats.overflow.length} 句超出时间窗已裁剪`);
  parts.push(`${stats.elapsedMs}ms`);
  return parts.join(' · ');
}

/** 确保缓存目录存在（容器里 /data 可能还没建）。 */
export function ensureCloudDirs() {
  for (const d of [CACHE_ROOT, path.join(path.dirname(CACHE_ROOT), 'cloud')]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 只读环境就算了，合成时会再报 */ }
  }
}
