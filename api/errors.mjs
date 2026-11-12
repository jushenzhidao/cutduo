/**
 * api/errors.mjs · 结构化错误
 *
 * 判定标准：一条错误信息的好坏，取决于**调用方能否据此自行纠正**。
 * 所以每个错误都必须带 code（可分支）、hint（人读）、fix（可执行动作）。
 * 只写 `throw new Error('找不到 kit：xxx')` 的调用方只能把原文抛给用户，
 * 而 agent 需要的是「改哪个字段、填什么值」。
 */

export const CODE = {
  KIT_NOT_FOUND: 'KIT_NOT_FOUND',
  KIT_AMBIGUOUS: 'KIT_AMBIGUOUS',
  PARAMS_MISSING: 'PARAMS_MISSING',
  PARAMS_UNREADABLE: 'PARAMS_UNREADABLE',
  PARAMS_INVALID: 'PARAMS_INVALID',
  SCHEMA_UNSUPPORTED: 'SCHEMA_UNSUPPORTED',
  AUDIO_MISSING: 'AUDIO_MISSING',
  OUTPUT_UNWRITABLE: 'OUTPUT_UNWRITABLE',
  RENDER_FAILED: 'RENDER_FAILED',
  OUTPUT_INVALID: 'OUTPUT_INVALID',
  GATE_FAILED: 'GATE_FAILED',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
};

export class ApiError extends Error {
  /**
   * @param {keyof CODE} code
   * @param {string} message  一句话说清发生了什么
   * @param {{hint?:string, fix?:string, details?:any, cause?:Error}} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = meta.hint || '';
    this.fix = meta.fix || '';
    this.details = meta.details ?? null;
    if (meta.cause) this.cause = meta.cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.fix ? { fix: this.fix } : {}),
      ...(this.details != null ? { details: this.details } : {}),
    };
  }
}

/** 把任意异常收敛成 ApiError，避免上层同时处理两种错误形状。 */
export function toApiError(err, fallback = CODE.INTERNAL) {
  if (err instanceof ApiError) return err;
  const msg = err && err.message ? err.message : String(err);
  // ffmpeg / ffprobe 的失败是最常见的非契约异常，单独归类便于调用方重试判断
  const code = /ffmpeg|ffprobe|libx264|No such file or directory/i.test(msg) ? CODE.RENDER_FAILED : fallback;
  return new ApiError(code, msg, { cause: err });
}
