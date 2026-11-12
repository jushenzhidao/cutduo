#!/usr/bin/env python3
"""模板结构体检。可对任意模板目录跑，不执行包内代码。

  python3 check-template.py --src templates/own/science-explainer
  python3 check-template.py --src templates/_scaffold        # 骨架自己也要过

两层检查：
  通用约束 —— 所有模板都必须满足（manifest 引用、JSON、敏感文件、integrity）
  形态约束 —— 按 runtime.profile 与内容模型分派，不强迫所有模板同构

分三档：
  ✗ FAIL  结构不成立，打包会挂或运行时必炸
  ! WARN  能跑但有风险（TBD 残留 / DOM 依赖 / integrity 过期）
  ✓ 通过
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

FAIL, WARN, OK = [], [], []

MANIFEST_REFS = [
    ("runtime.entry", ("runtime", "entry")),
    ("runtime.dependencyLock", ("runtime", "dependencyLock")),
    ("parameters.schema", ("parameters", "schema")),
    ("parameters.defaultPreset", ("parameters", "defaultPreset")),
    ("assets.manifest", ("assets", "manifest")),
    ("license.file", ("license", "file")),
    ("ai.entry", ("ai", "entry")),
    ("ai.guide", ("ai", "guide")),
]

# 只有绘制层必须纯净；main.js 允许碰 document（取 canvas 是宿主的活）
PURE_FILES = ("kit.js", "layouts.js")
DOM_CALLS = ("createElement", "querySelectorAll", "getElementById", "appendChild")
CJK_RUN = re.compile(r"[\u4e00-\u9fa5]{3,}")


def fail(m):
    FAIL.append(m)


def warn(m):
    WARN.append(m)


def ok(m):
    OK.append(m)


def rel_lum(hex_color):
    h = str(hex_color).lstrip("#")
    if len(h) == 3:
        h = "".join(c + c for c in h)
    try:
        r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    except (ValueError, IndexError):
        return -1.0

    def f(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def contrast(a, b):
    la, lb = rel_lum(a), rel_lum(b)
    if la < 0 or lb < 0:
        return -1.0
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def strip_comments(js):
    js = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
    js = re.sub(r"(?<![:\"'\\])//[^\n]*", "", js)
    return js


def load_json(p, label):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"{label} 不存在：{p.name}")
    except json.JSONDecodeError as e:
        fail(f"{label} JSON 解析失败：{p.name} 第 {e.lineno} 行 {e.msg}")
    return None


def get(d, path):
    cur = d
    for k in path:
        if not isinstance(cur, dict) or k not in cur:
            return None
        cur = cur[k]
    return cur


def check_manifest(root):
    m = load_json(root / "motion.json", "motion.json")
    if not m:
        return None
    if m.get("format") != "motiongit-template":
        fail(f"motion.json: format 应为 motiongit-template，实际 {m.get('format')!r}")
    if not m.get("specVersion"):
        fail("motion.json: 缺 specVersion")

    tid = get(m, ("template", "id"))
    if not tid:
        fail("motion.json: 缺 template.id")
    elif "__" in str(tid):
        warn(f"motion.json: template.id={tid!r} 是未替换的占位符（骨架未实例化）")
    elif tid != root.name:
        # id 是全局唯一标识，目录名是本地路径，规范不要求相等；但跨仓安装时会按 id 找目录
        warn(
            f"motion.json: template.id={tid!r} 与目录名 {root.name!r} 不同"
            "（本地无影响，跨仓安装时按 id 找目录会找不到）"
        )
    else:
        ok(f"身份 template.id = {tid}")

    good = 0
    for label, path in MANIFEST_REFS:
        ref = get(m, path)
        if not ref:
            fail(f"motion.json: 缺 {label}")
        elif not (root / ref).is_file():
            fail(f"motion.json: {label} 指向的文件不存在 → {ref}")
        else:
            good += 1
    if good == len(MANIFEST_REFS):
        ok(f"{len(MANIFEST_REFS)} 个 manifest 引用全部存在")

    if get(m, ("template", "status")) == "skeleton":
        warn("motion.json: status 仍是 skeleton，正式模板应改为 draft/stable")

    lock = root / "motion.lock.json"
    if lock.is_file():
        j = load_json(lock, "motion.lock.json")
        if j is not None:
            if "dependencies" not in j:
                fail("motion.lock.json: 缺 dependencies（无依赖也要写 {}，空对象是声明）")
            else:
                ok(
                    f"环境锁 runtime = {j.get('runtime')}，"
                    f"dependencies = {len(j.get('dependencies') or {})} 项"
                )
    return m


def check_json_parse(root):
    files = list(root.rglob("*.json"))
    bad = 0
    for p in files:
        try:
            json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            bad += 1
            fail(f"JSON 解析失败：{p.relative_to(root)} 第 {e.lineno} 行 {e.msg}")
    if not bad:
        ok(f"{len(files)} 个 JSON 文件全部可解析")


def check_purity(root, m):
    profile = str(get(m or {}, ("runtime", "profile")) or "")
    if not profile.startswith("html-canvas"):
        ok(f"runtime.profile = {profile or '(未声明)'}，跳过 Canvas2D 纯度检查")
        return

    src = root / "src"
    targets = [n for n in PURE_FILES if (src / n).is_file()]
    if not targets:
        # 允许单文件实现（distill 就是 232 行 main.js），但换宿主前必须拆
        others = sorted(p.name for p in src.glob("*.js") if p.name != "main.js")
        if others:
            targets = others
        else:
            warn(
                "src/ 下只有 main.js，绘制层未拆分（html-canvas 模板建议 kit.js + layouts.js，"
                "否则换宿主时不知道哪部分能搬）"
            )
            return

    for name in targets:
        f = src / name
        body = strip_comments(f.read_text(encoding="utf-8"))

        # 特性检测（typeof document / typeof window）是双宿主的正确写法，不算依赖
        guarded = ("typeof document" in body) or ("typeof window" in body)

        # 只查真正的 DOM 创建/查询；window.X = ... 是挂全局命名空间，两个宿主都支持
        hits = [k for k in DOM_CALLS if k in body]
        if hits:
            if guarded:
                warn(
                    f"src/{name} 调用了 DOM {hits}，虽有 typeof 保护但仍建议收进 index.html"
                    "（换宿主靠运行时分支，容易漏测）"
                )
            else:
                fail(f"src/{name} 无保护地调用 DOM {hits} —— 换宿主必断")
        else:
            ok(f"src/{name} 绘制层不碰 DOM")

        strs = re.findall(r"['\"`]([^'\"`]*)['\"`]", body)
        cjk = [s for s in strs if CJK_RUN.search(s)]
        if cjk:
            warn(f"src/{name} 有 {len(cjk)} 处中文字面量，疑似硬编码文案（应从 preset 读）：{cjk[0][:24]}…")


def check_contract(root):
    g_path = root / "guide.json"
    s_path = root / "params.schema.json"
    g = load_json(g_path, "guide.json") if g_path.is_file() else None
    sch = load_json(s_path, "params.schema.json") if s_path.is_file() else None

    layout_types = set()
    if g:
        for lay in g.get("layouts") or []:
            t = lay.get("type")
            if not t:
                fail("guide.json: layouts[] 有条目缺 type")
                continue
            layout_types.add(t)
            if not lay.get("capacity"):
                fail(f"guide.json: 版式 {t} 缺 capacity（容量不上限，等于没有约束）")
        if layout_types:
            ok(f"guide.json 声明 {len(layout_types)} 个版式：{', '.join(sorted(layout_types))}")
        if not g.get("pitfalls"):
            warn("guide.json: 没有 pitfalls[]，踩过的坑不会被下一支模板继承")
        if not (g.get("rhythm") or {}).get("beatPattern"):
            warn("guide.json: rhythm.beatPattern 为空，AI 无从知道段型配比")

    if not (g and sch and layout_types):
        return layout_types

    props = sch.get("properties") or {}
    seg_items = (props.get("segments") or {}).get("items") or {}
    flat = set((seg_items.get("properties") or {}).keys())
    nested = set(((seg_items.get("properties") or {}).get("args") or {}).get("properties", {}).keys())
    # 两种形态都合法：segments[].title（平铺）与 segments[].args.title（嵌套）
    seg_props = nested or flat

    declared = set()
    for lay in g.get("layouts") or []:
        declared |= set(lay.get("args") or {})

    orphan = declared - seg_props
    if orphan:
        if "args" in flat and not nested:
            fail(
                f"params.schema.json 的 segments[].args 未展开：guide 声明了 {len(declared)} 个参数，"
                "schema 里 args 只是一个裸 object，等于内容层完全不受校验"
                "（修法：把 args 展开成 properties，或改用平铺写法）"
            )
        else:
            fail(
                f"params.schema.json 未声明 {len(orphan)} 个版式参数：{sorted(orphan)[:8]}…"
                "（guide 用了但 schema 不约束，校验会漏）"
            )
    unused = seg_props - declared - {"type", "dur", "figure", "note", "args"}
    if unused:
        warn(f"params.schema.json 有未被任何版式使用的段参数：{sorted(unused)}")
    if "segments" not in props:
        warn("params.schema.json 顶层没有 segments 属性（该模板可能不用段模型）")
    return layout_types


def check_presets(root, layout_types, m=None):
    default_rel = str(get(m or {}, ("parameters", "defaultPreset")) or "")
    for pj in sorted((root / "presets").glob("*.json")):
        inp = load_json(pj, f"presets/{pj.name}")
        if not inp:
            continue

        # 主题可读性：与内容模型无关，一律查
        th = inp.get("theme") or {}
        if th.get("bg") and th.get("ink"):
            cr = contrast(th["bg"], th["ink"])
            if cr < 0:
                warn(f"presets/{pj.name}: theme 颜色无法解析（{th.get('bg')} / {th.get('ink')}）")
            elif cr < 3.0:
                fail(
                    f"presets/{pj.name}: theme.ink {th['ink']} 压在 theme.bg {th['bg']} 上"
                    f"对比度仅 {cr:.2f}:1 < 3.0，正文会看不清"
                )
            else:
                ok(f"presets/{pj.name}: 主题对比度 {cr:.1f}:1")

        segs = inp.get("segments")
        scenes = inp.get("scenes")
        if not segs and not scenes:
            ok(f"presets/{pj.name}: 非段模型（顶层键 {sorted(inp.keys())[:6]}），跳过参数契约检查")
            continue

        if scenes and not segs:
            total = max((float(s.get("t1") or 0) for s in scenes), default=0)
            if total and inp.get("durationSeconds") and abs(float(inp["durationSeconds"]) - total) > 0.05:
                warn(
                    f"presets/{pj.name}: durationSeconds={inp['durationSeconds']} "
                    f"与末场景 t1={total:.2f} 不符"
                )
            else:
                ok(f"presets/{pj.name}: 场景模型 {len(scenes)} 段 / {total:.2f}s 自洽")
            continue

        if not segs:
            fail(f"presets/{pj.name}: segments 是空数组")
            continue

        total = sum(float(s.get("dur") or 0) for s in segs)
        declared_dur = inp.get("durationSeconds")
        if declared_dur is None:
            warn(f"presets/{pj.name}: 没写 durationSeconds，时长只能按段累加推断")
        elif abs(float(declared_dur) - total) > 0.05:
            is_default = default_rel and str(pj.relative_to(root).as_posix()) == default_rel.lstrip("./")
            msg = (
                f"presets/{pj.name}: durationSeconds={declared_dur} 但 segments 累加={total:.2f}"
                f"（差 {abs(float(declared_dur) - total):.2f}s，末段会被截断）"
            )
            # 默认 preset 是契约的一部分（被 manifest 引用、第三方会直接用），必须严；
            # 其他是样例，过期只算误导
            if is_default:
                fail(msg + " · 这是 parameters.defaultPreset")
            else:
                warn(msg + " · 备选 preset，不影响默认出片")
        else:
            ok(f"presets/{pj.name}: 时长自洽 {total:.2f}s / {len(segs)} 段")

        if layout_types:
            unknown = {s.get("type") for s in segs} - layout_types
            if unknown:
                fail(f"presets/{pj.name}: 用了 guide 里没有的版式 {sorted(unknown)}")

        caps = sorted(
            ((float(c.get("start") or 0), float(c.get("end") or 0)) for c in inp.get("captions") or []),
            key=lambda x: x[0],
        )
        for i in range(1, len(caps)):
            if caps[i][0] < caps[i - 1][1]:
                fail(
                    f"presets/{pj.name}: 字幕重叠 {caps[i-1][0]:.2f}-{caps[i-1][1]:.2f} 与 "
                    f"{caps[i][0]:.2f}-{caps[i][1]:.2f}（同帧会出两条）"
                )
                break
        over = [c for c in caps if c[1] > total + 0.05]
        if over:
            warn(f"presets/{pj.name}: {len(over)} 条字幕结束时间超过总时长 {total:.2f}s")


def check_assets(root):
    am = root / "asset-manifest.json"
    if not am.is_file():
        return
    man = load_json(am, "asset-manifest.json")
    if not man:
        return
    items = man.get("assets") or []
    missing = [x.get("path") for x in items if not (root / (x.get("path") or "")).is_file()]
    norole = [x.get("path") for x in items if not x.get("role")]
    if missing:
        warn(f"asset-manifest.json 引用的文件不存在：{missing}")
    if norole:
        warn(f"素材缺 role（不知道用在哪）：{norole}")
    if not missing and not norole:
        ok(f"素材台账 {len(items)} 条，引用全部存在且都有 role")


def check_integrity(root, m):
    if not (m and m.get("integrity")):
        return
    ip = root / m["integrity"]
    if not ip.is_file():
        # 还没打包：integrity 由 build-template.py 生成，不是缺件
        ok("尚未打包（integrity.json 由 build-template.py 生成）")
        return
    ij = load_json(ip, "integrity.json")
    if not ij:
        return
    files = ij.get("files") or {}
    stale = []
    for rel, h in files.items():
        f = root / rel
        if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest() != h:
            stale.append(rel)
    if stale:
        warn(f"integrity 已过期 {len(stale)} 个文件（改了没重新打包）：{stale[:3]}")
    else:
        ok(f"integrity {len(files)}/{len(files)} 通过")


def check_secrets(root):
    hits = [
        p
        for p in root.rglob("*")
        if p.is_file()
        and (
            "package/personal" in p.as_posix()
            or p.name in {"core.enc", "template.motion", "release.bin"}
        )
    ]
    if hits:
        fail(f"发现不可分发文件 {len(hits)} 个：{[str(p.relative_to(root)) for p in hits[:3]]}")


def check_tbd(root):
    tbd = sorted(
        {
            p.name
            for p in root.rglob("*")
            if p.is_file()
            and p.suffix in {".md", ".json", ".txt"}
            and "TBD" in p.read_text(encoding="utf-8", errors="ignore")
        }
    )
    if tbd:
        warn(f"仍有 TBD 未填：{tbd}（结构可过，但这些数必须实测后填）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    a = ap.parse_args()
    root = Path(a.src).resolve()
    if not root.is_dir():
        print(f"✗ 目录不存在：{root}", file=sys.stderr)
        return 2

    m = check_manifest(root)
    check_json_parse(root)
    check_purity(root, m)
    layout_types = check_contract(root)
    check_presets(root, layout_types, m)
    check_assets(root)
    check_integrity(root, m)
    check_secrets(root)
    check_tbd(root)

    print(f"\n体检 · {root.name}")
    for line in OK:
        print(f"  ✓ {line}")
    for line in WARN:
        print(f"  ! {line}")
    for line in FAIL:
        print(f"  ✗ {line}")
    verdict = "FAIL" if FAIL else ("WARN" if WARN else "PASS")
    print(f"\n{verdict}  ·  {len(OK)} 通过 / {len(WARN)} 警告 / {len(FAIL)} 失败\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
