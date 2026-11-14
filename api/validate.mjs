/**
 * api/validate.mjs · 最小 JSON Schema 校验器
 *
 * 为什么不用 ajv：五支 kit 的 schema 混用 draft-07 与 2020-12，ajv 要按方言分别实例化；
 * 而实际用到的关键字只有十来个。手写一个覆盖它们的校验器，比引入一条依赖更容易解释。
 *
 * 覆盖：type / required / properties / additionalProperties / items /
 *       enum / const / minimum / maximum / exclusive* / minLength / maxLength /
 *       pattern / minItems / maxItems / oneOf / anyOf
 *
 * 刻意不支持：$ref、format。遇到返回 unsupported 列表而不是静默放过 —— 静默放过等于假通过。
 *
 * if-then-else 原本也不支持，但 2026-11-14 改了：`paper` 的 schema 用它对 9 种段型分别约束
 * 必填 args（比如 number 段必须有 value）。不支持 = 这 9 条约束全部失效，传一个缺 value 的
 * number 段能过 API 校验，渲染出来是空白。所以补上——if 的判定用一次子校验，只看是否通过。
 */

const TYPES = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(spec, value) {
  const list = Array.isArray(spec) ? spec : [spec];
  return list.some((t) => (TYPES[t] ? TYPES[t](value) : true));
}

/**
 * @returns {{valid:boolean, errors:Array, unsupported:Array}}
 */
export function validate(schema, value) {
  const errors = [];
  const unsupported = new Set();

  const walk = (sch, val, path) => {
    if (!sch || typeof sch !== 'object') return;

    if ('$ref' in sch) unsupported.add('$ref');
    // 条件分支：if 匹配则套 then，否则套 else。if 里通常只有 type/const/required/properties，
    // 用一次子校验判定"是否匹配"（它的 errors 不并进当前错误，否则会报一堆"if 不成立"的噪音）。
    if (sch.if && typeof sch.if === 'object') {
      let hit = false;
      try { hit = validate(sch.if, val).valid; } catch { hit = false; }
      const branch = hit ? sch.then : sch.else;
      if (branch && typeof branch === 'object') walk(branch, val, path);
    }
    // allOf 是纯合取，可以安全展开；paper 的 schema 用它挂公共约束
    if (Array.isArray(sch.allOf)) sch.allOf.forEach((sub) => walk(sub, val, path));

    if (sch.type && !matchesType(sch.type, val)) {
      errors.push({
        path: path || '/',
        message: `类型应为 ${Array.isArray(sch.type) ? sch.type.join('|') : sch.type}，实际是 ${typeOf(val)}`,
        expected: sch.type,
        got: typeOf(val),
      });
      return; // 类型不符时后续断言无意义
    }

    if (sch.const !== undefined && val !== sch.const) {
      errors.push({ path: path || '/', message: `应为常量 ${JSON.stringify(sch.const)}`, got: val });
    }

    if (Array.isArray(sch.enum) && !sch.enum.some((e) => e === val)) {
      errors.push({
        path: path || '/',
        message: `取值必须是 ${sch.enum.map((e) => JSON.stringify(e)).join(' / ')} 之一`,
        expected: sch.enum,
        got: val,
      });
    }

    if (typeof val === 'number') {
      if (sch.minimum !== undefined && val < sch.minimum) {
        errors.push({ path: path || '/', message: `不能小于 ${sch.minimum}`, got: val });
      }
      if (sch.maximum !== undefined && val > sch.maximum) {
        errors.push({ path: path || '/', message: `不能大于 ${sch.maximum}`, got: val });
      }
      if (sch.exclusiveMinimum !== undefined && val <= sch.exclusiveMinimum) {
        errors.push({ path: path || '/', message: `必须大于 ${sch.exclusiveMinimum}`, got: val });
      }
      if (sch.exclusiveMaximum !== undefined && val >= sch.exclusiveMaximum) {
        errors.push({ path: path || '/', message: `必须小于 ${sch.exclusiveMaximum}`, got: val });
      }
      if (sch.multipleOf && val % sch.multipleOf !== 0) {
        errors.push({ path: path || '/', message: `必须是 ${sch.multipleOf} 的整数倍`, got: val });
      }
    }

    if (typeof val === 'string') {
      if (sch.minLength !== undefined && val.length < sch.minLength) {
        errors.push({ path: path || '/', message: `长度不能少于 ${sch.minLength}`, got: val.length });
      }
      if (sch.maxLength !== undefined && val.length > sch.maxLength) {
        errors.push({ path: path || '/', message: `长度不能超过 ${sch.maxLength}`, got: val.length });
      }
      if (sch.pattern) {
        let re = null;
        try { re = new RegExp(sch.pattern); } catch { unsupported.add('pattern(非法正则)'); }
        if (re && !re.test(val)) {
          errors.push({ path: path || '/', message: `不匹配模式 ${sch.pattern}`, got: val });
        }
      }
    }

    if (Array.isArray(val)) {
      if (sch.minItems !== undefined && val.length < sch.minItems) {
        errors.push({ path: path || '/', message: `至少需要 ${sch.minItems} 项，实际 ${val.length} 项`, got: val.length });
      }
      if (sch.maxItems !== undefined && val.length > sch.maxItems) {
        errors.push({ path: path || '/', message: `最多 ${sch.maxItems} 项，实际 ${val.length} 项`, got: val.length });
      }
      if (sch.items) val.forEach((item, i) => walk(sch.items, item, `${path}/${i}`));
    }

    if (TYPES.object(val)) {
      for (const key of sch.required || []) {
        if (!(key in val)) {
          errors.push({
            path: `${path}/${key}`,
            message: `缺少必填字段 ${key}`,
            expected: sch.properties?.[key]?.description || 'required',
          });
        }
      }
      const props = sch.properties || {};
      for (const [key, v] of Object.entries(val)) {
        if (props[key]) walk(props[key], v, `${path}/${key}`);
        else if (sch.additionalProperties === false) {
          errors.push({
            path: `${path}/${key}`,
            message: `不允许的字段 ${key}`,
            hint: Object.keys(props).length ? `可用字段：${Object.keys(props).join(' / ')}` : undefined,
          });
        }
      }
    }

    for (const key of ['oneOf', 'anyOf']) {
      if (Array.isArray(sch[key])) {
        const results = sch[key].map((sub) => {
          const r = validate(sub, val);
          return r.valid;
        });
        const pass = key === 'oneOf' ? results.filter(Boolean).length === 1 : results.some(Boolean);
        if (!pass) {
          errors.push({ path: path || '/', message: `不满足 ${key} 中任何一个分支` });
        }
      }
    }
  };

  walk(schema, value, '');

  return { valid: errors.length === 0, errors, unsupported: [...unsupported] };
}

/** 把校验错误压成一行一条，便于 CLI 与日志阅读。 */
export function formatErrors(errors, limit = 12) {
  const shown = errors.slice(0, limit).map((e) => `${e.path || '/'}: ${e.message}${e.hint ? `（${e.hint}）` : ''}`);
  if (errors.length > limit) shown.push(`… 另有 ${errors.length - limit} 处`);
  return shown;
}
