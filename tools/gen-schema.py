#!/usr/bin/env python3
"""从 guide.json + presets 反推 params.schema.json 的段参数约束。

  python3 tools/gen-schema.py --template kits/science/template            # 只看统计，不写
  python3 tools/gen-schema.py --template kits/science/template --write    # 写回 schema

为什么要有这个脚本：guide 的 layouts[].args 声明了参数名与说明，但 schema 里
`args` 常常只是一个裸 object —— 于是内容层完全不受校验，拼错键名也能跑。

类型从**真实 presets 的实际值**推断，不从说明文字猜：
  · 有实测值的键 → 按值定类型（全样本同类型的才收紧）
  · 只有 guide 说明、preset 没用过的键 → 只写 description，**不加 type**（宁松不错）

写回时保留 schema 的其余部分，只替换 segments.items.properties.args。
"""
import argparse
import glob
import json
import pathlib
import sys
from collections import defaultdict

TYPE_ORDER = ("boolean", "number", "string", "array", "object")


def infer(v):
    if isinstance(v, bool):
        return {"type": "boolean"}
    if isinstance(v, (int, float)):
        return {"type": "number"}
    if isinstance(v, str):
        return {"type": "string"}
    if isinstance(v, list):
        if not v:
            return {"type": "array"}
        sigs = {json.dumps(infer(x), sort_keys=True, ensure_ascii=False) for x in v}
        if len(sigs) == 1:
            return {"type": "array", "items": json.loads(sigs.pop())}
        return {"type": "array"}
    if isinstance(v, dict):
        return {"type": "object"}
    return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True, help="模板目录，如 kits/science/template")
    ap.add_argument("--write", action="store_true", help="写回 params.schema.json")
    a = ap.parse_args()

    root = pathlib.Path(a.template).resolve()
    gpath = root / "guide.json"
    spath = root / "params.schema.json"
    if not gpath.is_file() or not spath.is_file():
        print(f"✗ 缺 guide.json 或 params.schema.json：{root}", file=sys.stderr)
        return 2

    guide = json.loads(gpath.read_text(encoding="utf-8"))
    schema = json.loads(spath.read_text(encoding="utf-8"))

    # 1) guide 里的参数名与说明
    described = {}
    for lay in guide.get("layouts") or []:
        for k, v in (lay.get("args") or {}).items():
            described.setdefault(k, v if isinstance(v, str) else "")

    # 2) presets 里的实际值
    samples = defaultdict(list)
    files = sorted(glob.glob(str(root / "presets" / "*.json")))
    if not files:
        print("✗ presets/ 下没有 JSON", file=sys.stderr)
        return 2
    for f in files:
        d = json.loads(pathlib.Path(f).read_text(encoding="utf-8"))
        for seg in d.get("segments") or []:
            # 两种写法都认：segments[].args（嵌套）与 segments[].title（平铺）
            seg_args = seg.get("args")
            if not isinstance(seg_args, dict):
                seg_args = {k: v for k, v in seg.items() if k not in ("type", "dur", "note", "args")}
            for k, v in seg_args.items():
                samples[k].append(v)

    # 3) 合成 properties
    props = {}
    for k in sorted(set(described) | set(samples)):
        entry = {}
        if k in described and described[k]:
            entry["description"] = described[k]
        vals = samples.get(k) or []
        if vals:
            sigs = {json.dumps(infer(v), sort_keys=True) for v in vals}
            if len(sigs) == 1:
                entry.update(json.loads(sigs.pop()))
            else:
                # 注意：type 可能本身就是字符串（"array"），直接迭代会拆成单字符
                def as_list(t):
                    if isinstance(t, str):
                        return [t]
                    return list(t or [])

                types = sorted(
                    {x for sig in sigs for x in as_list(json.loads(sig).get("type"))} - {None}
                )
                if types:
                    entry["type"] = types if len(types) > 1 else types[0]
                entry["description"] = (entry.get("description", "") + "（实测多类型，未收紧）").strip()
        props[k] = entry

    measured = sum(1 for k in props if "type" in props[k])
    loose = sorted(set(described) - set(samples))
    extra = sorted(set(samples) - set(described))

    print(f"模板 {root.name}")
    print(f"  guide 声明 {len(described)} 个 · preset 实测 {len(samples)} 个 · 合成 {len(props)} 个")
    print(f"  可定类型 {measured} 个 · 只写说明不约束 {len(props) - measured} 个")
    if loose:
        print(f"  ! 只有说明、无实测样本（不加 type）：{loose}")
    if extra:
        print(f"  ! preset 用了但 guide 没声明（会用实测类型补上）：{extra}")

    if not a.write:
        print("\n（dry-run，加 --write 写回）")
        return 0

    props_seg = schema.setdefault("properties", {}).setdefault("segments", {})
    items = props_seg.setdefault("items", {"type": "object"})
    iprops = items.setdefault("properties", {})
    old = iprops.get("args") or {}
    iprops["args"] = {
        "type": "object",
        "additionalProperties": False,
        "description": old.get("description", "段参数；键名必须是版式声明的参数"),
        "properties": props,
    }
    # segments 至少要有 type/dur
    req = items.setdefault("required", [])
    for k in ("type", "dur"):
        if k not in req:
            req.append(k)

    spath.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n✓ 已写回 {spath.relative_to(pathlib.Path.cwd()) if spath.is_relative_to(pathlib.Path.cwd()) else spath}")
    print(f"  args.properties 共 {len(props)} 项，additionalProperties=false（拼错键名会被拒）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
