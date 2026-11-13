#!/usr/bin/env python3
"""半蒸馏第一步：读一个 .motion 包的内容模型，产出报告 + guide 草稿。

  python3 tools/distill-inspect.py --package refs/vendor/knowledge-explainer-sketchnote/template.motion
  python3 tools/distill-inspect.py --package refs/vendor/promo-ink/package --out /tmp/report

支持三种输入（自动识别）：
  · `xxx.motion`（ZIP）
  · 已解包目录（含 motion.json）
  · 目录下的 `package/`（旧的下载形态，自动下钻）

支持两代规范：
  · 1.0-rc  → 内容模型在 `content/release.bin`（内层 ZIP）+ `assistant/guide.json`
  · 0.1-draft → 内容模型就在根目录的 `guide.json` / `params.schema.json`

只读：不执行包内代码、不碰 `personal/`（凭据）、不覆盖任何现有文件。
"""
import argparse
import collections
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = next((d for d in [Path(__file__).resolve().parent, *Path(__file__).resolve().parent.parents] if (d / ".git").exists()), Path.cwd())


class Backend:
    """统一的只读访问：目录或 ZIP。"""

    def __init__(self, root, zf=None):
        self.root = root
        self.zf = zf

    def read(self, rel):
        try:
            if self.zf:
                return self.zf.read(rel)
            p = self.root / rel
            return p.read_bytes() if p.is_file() else None
        except (KeyError, OSError):
            return None

    def read_json(self, rel):
        raw = self.read(rel)
        if raw is None:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def list(self, prefix=""):
        if self.zf:
            names = self.zf.namelist()
        else:
            names = [p.relative_to(self.root).as_posix() for p in self.root.rglob("*") if p.is_file()]
        return [n for n in names if n.startswith(prefix)]


def open_source(p: Path):
    """返回 (manifest_backend, model_backend, 规范代号)。"""
    if p.is_file() and zipfile.is_zipfile(p):
        zf = zipfile.ZipFile(p)
        outer = Backend(None, zf)
    elif p.is_dir():
        # 下载形态：目录下有 package/
        if (p / "package" / "motion.json").is_file():
            outer = Backend(p / "package")
        else:
            outer = Backend(p)
    else:
        raise SystemExit(f"✗ 读不了：{p}")

    m = outer.read_json("motion.json")
    if not m:
        raise SystemExit("✗ 找不到 motion.json（不是 .motion 包，也不是解包目录）")

    # 1.0-rc：内容在 content/release.bin（内层 ZIP）
    rel = (m.get("content") or {}).get("path")
    if rel:
        raw = outer.read(rel)
        if raw and raw[:4] == b"PK\x03\x04":
            import io
            inner = Backend(None, zipfile.ZipFile(io.BytesIO(raw)))
            return outer, inner, "1.0-rc"
    # 0.1-draft：内容就在根目录
    return outer, outer, "0.1-draft"


def guess_name(src: Path):
    """1.0-rc 包的 motion.json 没有 template 字段，按输入路径推断：
    .../<名字>/template.motion 与 .../<名字>/package 都取上一级。"""
    if src.is_dir() and src.name == "package":
        return src.parent.name
    if src.is_file() and src.suffix == ".motion":
        return src.parent.name
    return src.stem


DISCRIMINATORS = ("mechanism", "mode", "kind", "type")


def find_branches(schema):
    """找「类型分支」：顶层 oneOf，或数组的 items.oneOf。返回 (路径说明, 分支列表)。"""
    if isinstance(schema.get("oneOf"), list):
        return "(顶层 oneOf)", schema["oneOf"]
    props = schema.get("properties") or {}
    for key in ("shots", "segments", "scenes", "clips"):
        items = ((props.get(key) or {}).get("items") or {})
        if isinstance(items.get("oneOf"), list):
            return f"properties.{key}.items.oneOf", items["oneOf"]
    return None, None


def pick_disc(branch):
    props = branch.get("properties") or {}
    for k in DISCRIMINATORS:
        const = (props.get(k) or {}).get("const")
        if const:
            return k, const
    return None, None


def mechanisms_from_schema(inner):
    """提取内容模型。不同模板形态不同：版式型（mechanism）/ 镜头型（shots.mode）/ 段型（segments）。

    返回 (条目列表, schema, 形态说明)。
    """
    seen = set()
    for name in ("native/parameters.schema.json", "params.schema.json",
                 "adapter/params-base.schema.json"):
        if name in seen:
            continue
        seen.add(name)
        sch = inner.read_json(name)
        if not sch:
            continue

        where, branches = find_branches(sch)
        if branches:
            out = []
            for br in branches:
                disc, val = pick_disc(br)
                if not val:
                    continue
                out.append({
                    "type": val,
                    "disc": disc,
                    "required": br.get("required") or [],
                    "args": [k for k in (br.get("properties") or {}) if k != disc],
                    "source": name,
                })
            if out:
                return out, sch, f"类型分支 · {where} · 判别键 `{out[0]['disc']}`"

        seg = ((((sch.get("properties") or {}).get("segments") or {}).get("items") or {}).get("properties") or {})
        if seg:
            return ([{"type": "(single)", "disc": None, "required": [], "args": list(seg),
                      "source": name}], sch, f"单一形态 · {name} · segments.items.properties")

        top = list((sch.get("properties") or {}).keys())
        if top:
            return ([{"type": "(single)", "disc": None, "required": sch.get("required") or [],
                      "args": top, "source": name}], sch, f"顶层参数表 · {name} · properties")

    return [], None, "未识别"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", required=True)
    ap.add_argument("--out", default=None, help="输出目录，默认 out/distill-<名字>")
    a = ap.parse_args()

    src = Path(a.package)
    if not src.exists():
        src = (ROOT / a.package)
    outer, inner, spec = open_source(src)
    m = outer.read_json("motion.json") or {}

    tid = ((m.get("template") or {}).get("id")) or src.stem
    name = ((m.get("template") or {}).get("name")) or guess_name(src) or tid
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "template"
    outdir = Path(a.out) if a.out else ROOT / "out" / f"distill-{safe}"
    outdir.mkdir(parents=True, exist_ok=True)

    # ── 内容模型 ──
    mechs, schema, form = mechanisms_from_schema(inner)
    recipes = (inner.read_json("native/examples/recipes.json") or {}).get("recipes") or []
    ai = inner.read_json("AI-CHOICES.json") or {}
    guide = outer.read_json("assistant/guide.json") or inner.read_json("guide.json") or {}
    shot_plan = inner.read_json("native/production/knowledge/shot-plan.schema.json") or {}

    # gallery 按「内容族」归档（gallery/<族>/...），不是按 mechanism：
    # 内容模型其实是两半——版式（mechanism）+ 内容族（family），后者才决定"什么内容用什么版式"
    families = collections.Counter()
    for n in inner.list("gallery/"):
        parts = n.split("/")
        if len(parts) > 2 and not n.endswith("catalog.json"):
            families[parts[1]] += 1

    # 内容配方按 mechanism 归类
    recipe_by = collections.Counter(r.get("mechanism") for r in recipes if isinstance(r, dict))

    lines = []
    A = lines.append
    A(f"# {name} · 内容模型报告")
    A("")
    A(f"- 包：`{src}`")
    A(f"- 规范：`{m.get('format')}` / specVersion `{m.get('specVersion')}`")
    prot = (m.get("content") or {}).get("protection", "n/a")
    A(f"- runtime：`{(m.get('runtime') or {}).get('profile')}`  ·  protection：`{prot}`")
    A(f"- 内容模型入口：`{spec}`")
    A(f"- 内容模型形态：{form}")
    A(f"- 版式 {len(mechs)} 种 · 配方 {len(recipes)} 条 · 内容族 {len(families)} 个 / 样例 {sum(families.values())} 条")
    if prot == "protected":
        A("")
        A("> 渲染源码加密，但 `params.schema.json` 可读 —— **半蒸馏仍成立**（借内容模型、重写渲染层）；换宿主不成立。")
    A("")

    single = len(mechs) == 1 and mechs[0]["type"] == "(single)"
    A("## 一、参数组（这个包没有版式枚举，只有一套参数）" if single else "## 一、版式清单")
    A("")
    A("| 组 | 必填参数 | 可选参数 | 配方条数 |" if single else "| 版式 | 必填参数 | 可选参数 | 配方条数 |")
    A("|---|---|---|---|")
    for mech in mechs:
        if single:
            mech = dict(mech, type="(顶层 properties)")
        d = mech.get("disc")
        req = ", ".join(x for x in mech["required"] if x != d) or "—"
        opt = ", ".join(x for x in mech["args"] if x not in mech["required"]) or "—"
        A(f"| `{mech['type']}` | {req} | {opt} | {recipe_by.get(mech['type'], 0)} |")
    A("")

    if families:
        A("## 内容族（gallery 的口径）")
        A("")
        A("版式决定怎么画，内容族决定这类内容该用哪个版式。两者合起来才是完整内容模型。")
        A("")
        mech_names = {x["type"] for x in mechs}
        A("| 内容族 | 样例条目 | 备注 |")
        A("|---|---|---|")
        for fam, cnt in families.most_common():
            note = "也是版式名" if fam in mech_names else ""
            A(f"| `{fam}` | {cnt} | {note} |")
        A("")

    if ai:
        A("## 二、AI 决策索引（`AI-CHOICES.json`）")
        A("")
        A(f"- schema：`{ai.get('schema')}` · 版本 `{ai.get('documentationVersion')}`")
        if isinstance(ai.get("tasks"), list):
            A(f"- tasks（{len(ai['tasks'])} 条）：决定该用哪个版式讲哪类内容")
            for t in ai["tasks"][:8]:
                if isinstance(t, dict):
                    need = t.get("need") or t.get("id") or "?"
                    fams = ", ".join(t.get("existingFamilies") or []) or "（无映射）"
                    A(f"  - **{need}** → {fams}")
                else:
                    A(f"  - {t}")
        if isinstance(ai.get("routes"), list):
            A(f"- routes（{len(ai['routes'])} 条）")
            for r in ai["routes"][:4]:
                A(f"  - {str(r)[:110]}")
        A("")

    if recipes:
        A("## 三、内容配方示例")
        A("")
        for r in recipes[:5]:
            A(f"- `{r.get('mechanism')}` · {r.get('title')} — {r.get('subtitle') or ''}")
        A("")

    if shot_plan:
        A("## 四、分镜计划契约")
        A("")
        A(f"- title：{shot_plan.get('title')}")
        A(f"- 顶层字段：{', '.join(list((shot_plan.get('properties') or {}).keys())[:10])}")
        A("")

    A("## 半蒸馏建议")
    A("")
    A(f"1. 版式落在 `guide.json` 的 `layouts[]`，`type` 用上面 5 列里的第一列（共 {len(mechs)} 种）。")
    A("2. `capacity` 必须**实测后填**：现在只有参数名，没有字数上限。")
    A("3. 渲染层重写：这些包是 `motiongit-host/1`，源码形态不是我们的三件套，不能直接搬。")
    A("4. 先跑 `tools/new-template.py --id <名字>` 生成骨架，再照本报告填 guide。")

    report = outdir / "report.md"
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # ── guide 草稿 ──
    draft = {
        "_note": "由 tools/distill-inspect.py 生成；capacity / rhythm 必须实测后填，TBD 不删",
        "purpose": (guide.get("purpose") if isinstance(guide, dict) else None) or f"{name}（半蒸馏自 {tid}）",
        "distilledFrom": {
            "file": src.name,
            "durationSeconds": 0,
            "size": "TBD",
            "fps": 0,
            "shots": 0,
            "medianShotSeconds": 0,
            "note": "只借内容模型（版式/参数/配方），渲染层自写；未复制素材与文案",
        },
        "duration": {"policy": "fixed", "seconds": 0, "fps": {"num": 30, "den": 1}, "adaptation": "TBD"},
        "materials": [
            {"role": "text.script", "mappedParameters": ["segments", "captions"], "required": True, "ifMissing": "stop"},
        ],
        "layout": {"ratio": "16:9", "pixels": "1920x1080", "safeArea": "TBD（按字高实测）", "notes": "TBD"},
        "rhythm": {"hardCut": "TBD", "captionLag": "TBD", "beatPattern": "TBD（按实测配比）"},
        "layouts": [
            {
                "type": mech["type"],
                "role": "TBD（这个版式负责讲什么）",
                "maxPerFilm": 0,
                "args": {k: "TBD" for k in mech["args"] if k != mech.get("disc")},
                "capacity": "TBD（实测：字号下能放多少字）",
            }
            for mech in mechs
        ],
        "runtime": {"profile": "html-canvas/1", "entry": "src/index.html",
                    "dependencies": ["kit.js", "layouts.js", "stage.js"], "network": False, "fonts": "TBD"},
        "pitfalls": [],
    }
    (outdir / "guide.draft.json").write_text(
        json.dumps(draft, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"✓ {outdir.relative_to(ROOT) if outdir.is_relative_to(ROOT) else outdir}")
    print(f"  report.md          类型 {len(mechs)} 种 / 内容族 {len(families)} 个 / 配方 {len(recipes)} 条 / 形态 {form}")
    print(f"  guide.draft.json   layouts[] 已按版式预填，capacity 留 TBD")
    if not mechs:
        print("  ! 没识别到版式清单：这个包的内容模型结构可能不同，看 report 里的规范字段再定")
    return 0


if __name__ == "__main__":
    sys.exit(main())
