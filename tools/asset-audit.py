#!/usr/bin/env python3
"""tools/asset-audit.py · 素材引用与来源审计

回答三个问题，按修复的紧迫度排序：

  P0  引用的素材能不能找到？          （路径失效 → 出片才炸，或静默缺图）
  P1  有没有 source 记录？            （`docs/ASSET-POLICY.md` 的硬要求）
  P2  source 字段够不够重跑？          （generated/synthesized 要能复现）

为什么 P0 排在 P1 前面：重构把 `edits/assets/` 挪到 `assets/media/` 之后，
content 里的路径没回写。这类问题不查出来，规范写得再好也没意义——
素材根本加载不到。

用法：
  python3 tools/asset-audit.py                       # 全量审计，只报告
  python3 tools/asset-audit.py content/nanjing.json  # 单支
  python3 tools/asset-audit.py --strict              # 有 P0/P1 就退出 1
  python3 tools/asset-audit.py --fix-paths           # 自动改写能映射到 media 的旧路径
  python3 tools/asset-audit.py --init-manifest       # 为缺失的片子生成 manifest 骨架

manifest 位置：`assets/media/<片子>/manifest.json`。
片子名 = content 文件名去掉 `-voiced` 后缀。
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# source.type 的四种合法取值，与 docs/ASSET-POLICY.md 第四节一致
KINDS = {"generated", "synthesized", "shot", "stock"}


def repo_root() -> Path:
    """向上找 .git。禁止用 dirname(__file__)/..——各脚本深度不同，一搬家必错。"""
    p = Path(__file__).resolve().parent
    for _ in range(8):
        if (p / ".git").exists():
            return p
        if p.parent == p:
            break
        p = p.parent
    return Path(__file__).resolve().parent.parent


ROOT = repo_root()
MEDIA = ROOT / "assets" / "media"


def items_of(v):
    """photos/clips 可能是 dict，也可能是 list。统一成 [(key, value)]。"""
    if isinstance(v, dict):
        return list(v.items())
    if isinstance(v, list):
        return list(enumerate(v))
    return []


def path_of(v):
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return v.get("path") or v.get("dir") or ""
    return ""


def film_of(content_path: Path) -> str:
    return content_path.stem.replace("-voiced", "")


def resolve_ref(raw: str):
    """把 content 里的路径解析成实际文件/目录。

    返回 (resolved_path, how)。how ∈ {'direct', 'media', 'missing'}。
    'media' 表示原路径失效但能在 assets/media/<片子>/ 下按 basename 找到，可自动修复。
    """
    if not raw:
        return None, "missing"
    p = Path(raw)
    cand = p if p.is_absolute() else (ROOT / raw)
    if cand.exists():
        return cand, "direct"
    # 旧结构 edits/assets/<片子>/<...> → assets/media/<片子>/<...>
    # 必须整段替换前缀，不能按 basename 猜：clips 的路径是目录，
    # 按 basename 会把 edits/assets/nanjing/clips/xuanwu 猜成 media/clips/xuanwu。
    parts = Path(raw).parts
    if len(parts) >= 3 and parts[0] == "edits" and parts[1] == "assets":
        guess = MEDIA.joinpath(*parts[2:])
        if guess.exists():
            return guess, "media"
    return None, "missing"


CITE = re.compile(r"出处|来源|公报|指南|手册|统计|报告|https?://")


def check_note_inherit(content_path: Path):
    """派生文件（-voiced）是否继承了原版 _note 里的出处。

    build-voices.py 曾把 _note 整段覆盖成「按配音重排」，查证过的医学/统计出处就此丢失，
    配音版出片时那段文案就成了「无来源断言」。派生只许追加，不许覆盖。
    """
    stem = content_path.stem
    if not stem.endswith("-voiced"):
        return None
    base = content_path.with_name(stem[: -len("-voiced")] + ".json")
    if not base.is_file():
        return None
    try:
        a = json.loads(base.read_text(encoding="utf-8")).get("_note") or ""
        b = json.loads(content_path.read_text(encoding="utf-8")).get("_note") or ""
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if CITE.search(a) and not CITE.search(b):
        return "原版 _note 有出处，派生版没有（派生只许追加，不许覆盖）"
    return None


def load_manifest(film: str):
    p = MEDIA / film / "manifest.json"
    if not p.is_file():
        return None, p
    try:
        return json.loads(p.read_text(encoding="utf-8")), p
    except json.JSONDecodeError as e:
        print(f"  ! {p.relative_to(ROOT)} 解析失败：第 {e.lineno} 行 {e.msg}")
        return None, p


def index_manifest(m):
    """返回 {basename: entry}，兼容按 id 或按文件名匹配。"""
    idx = {}
    for a in (m or {}).get("assets", []):
        if not isinstance(a, dict):
            continue
        if a.get("id"):
            idx[str(a["id"])] = a
        if a.get("path"):
            idx[os.path.basename(str(a["path"]))] = a
    return idx


# 镜头里写的 credit → 清单里该填的 license。
# 只放能确认的图库；未命中的 credit 仍按 stock 记，但许可标「待确认」，不替它编。
# 关键词而不是全等：实测 credit 的取值有 "Pexels" / "Pexels 素材" / "本人实拍" 三套写法。
CREDIT_LICENSE = {
    "pexels": "Pexels License（免费商用、无需署名）",
    "unsplash": "Unsplash License（免费商用、无需署名）",
    "pixabay": "Pixabay License（免费商用，逐条目查）",
    "wikimedia": "Wikimedia Commons（按条目页许可）",
    "本人": "本人拍摄",
}


def license_for(credit: str) -> str:
    low = str(credit).strip().lower()
    for k, v in CREDIT_LICENSE.items():
        if k in low:
            return v
    return f"{credit}（许可待确认）"


def type_for(credit: str) -> str:
    """credit 说的是「谁拍的」，不是「哪来的许可」。本人实拍必须判 shot，不是 stock。"""
    low = str(credit).strip().lower()
    if any(k in low for k in ("本人", "自拍", "自己拍")) or low in {"self", "shot"}:
        return "shot"
    if any(k in low for k in ("ai", "生成", "generated")):
        return "generated"
    return "stock"


def credit_map(c: dict) -> dict:
    """从镜头参数里提取 key → credit。

    来源证据不只在 `_note` 里：desk 的 `shots[].args.credit` 才是随画面渲染的那一份，
    片子上那个「Pexels 素材」角标就是它。不同 kit 的容器名不同（shots/scenes/segments），
    三种都扫。
    """
    out = {}
    for container in ("shots", "scenes", "segments"):
        for _, node in items_of(c.get(container)):
            if not isinstance(node, dict):
                continue
            a = node.get("args") if isinstance(node.get("args"), dict) else node
            credit = a.get("credit") or node.get("credit")
            key = a.get("key") or a.get("photo") or a.get("image") or a.get("clip")
            if credit and key is not None:
                out[str(key)] = str(credit)
    return out


def check_source(entry, credit=None):
    """返回该条 source 的问题列表。

    前缀是级别：P0/P1 阻断，P2 不阻断，W 是「待确认」——
    unknown 表示清单建了但来源还没查清，不该让历史数据把回归卡死。
    """
    probs = []
    src = entry.get("source")
    if not isinstance(src, dict):
        return ["P1 缺 source 记录"]
    t = src.get("type")
    if t == "unknown":
        if credit:
            return [f"W source.type 待确认；镜头 credit={credit!r} 可直接回填（--apply-credit）"]
        return ["W source.type 待确认（不阻断，但发布前必须填）"]
    if t not in KINDS:
        probs.append(f"P1 source.type={t!r} 不在 {sorted(KINDS)}")
    if t in {"generated", "synthesized"}:
        if not src.get("prompt") and not src.get("script"):
            probs.append("P2 generated/synthesized 缺 prompt 或 script，无法重跑")
        if src.get("seed") is None and t == "generated":
            probs.append("P2 generated 缺 seed，同 prompt 也可能出不同结果")
    if not entry.get("license"):
        probs.append("P1 缺 license")
    if entry.get("frozen") is not True:
        probs.append("P2 frozen 未置 true")
    return probs


def audit_one(content_path: Path, fix_paths=False, init_manifest=False, apply_credit=False):
    try:
        c = json.loads(content_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"\n{content_path.relative_to(ROOT)}  ✗ 无法解析：{e}")
        return {"p0": 1, "p1": 0, "p2": 0, "warn": 0, "fixed": 0}
    if not isinstance(c, dict):
        return {"p0": 0, "p1": 0, "p2": 0, "warn": 0, "fixed": 0}

    photos = items_of(c.get("photos"))
    clips = items_of(c.get("clips"))
    if not photos and not clips:
        return {"p0": 0, "p1": 0, "p2": 0, "warn": 0, "fixed": 0}

    film = film_of(content_path)
    rel = content_path.relative_to(ROOT)
    print(f"\n{rel}  ·  片子 {film}")

    stats = {"p0": 0, "p1": 0, "p2": 0, "warn": 0, "fixed": 0}
    changed = False
    replacements = []  # (old_raw, new_raw)，最后做文本级替换，不重排 JSON

    inherit = check_note_inherit(content_path)
    if inherit:
        print(f"  · W {inherit}")
        stats["warn"] += 1

    manifest, mpath = load_manifest(film)
    idx = index_manifest(manifest)
    credits = credit_map(c)
    if manifest is None and (photos or clips):
        print(f"  ! 无清单 {mpath.relative_to(ROOT)}（P1：来源不可追溯）")


    for group, entries, kind in (("photos", photos, "image"), ("clips", clips, "video")):
        if not entries:
            continue
        print(f"  {group}: {len(entries)} 项")
        for key, val in entries:
            raw = path_of(val)
            resolved, how = resolve_ref(raw)
            label = f"{key}({raw or '<空>'})"

            if resolved is None:
                print(f"    ✗ {label}  路径失效（P0）")
                stats["p0"] += 1
                continue

            if how == "media":
                if fix_paths:
                    new_raw = str(Path(resolved).relative_to(ROOT))
                    replacements.append((raw, new_raw))
                    changed = True
                    stats["fixed"] += 1
                    print(f"    ✓ {label}  → {new_raw}（已改写）")
                else:
                    print(f"    ! {label}  旧路径可修复 → {Path(resolved).relative_to(ROOT)}（P0，加 --fix-paths）")
                    stats["p0"] += 1
                # 修复后继续查 source，不中断
            elif how == "direct":
                print(f"    ✓ {label}")

            entry = idx.get(str(key)) or idx.get(os.path.basename(raw))
            if entry is None:
                print(f"      ✗ 清单里没有这条（P1）")
                stats["p1"] += 1
            else:
                for prob in check_source(entry, credits.get(str(key)) or credits.get(os.path.basename(raw))):
                    level = "warn" if prob.startswith("W ") else ("p2" if prob.startswith("P2 ") else "p1")
                    stats[level] += 1
                    mark = "·" if level == "warn" else "!"
                    print(f"      {mark} {prob}")

    # 只替换路径字符串本身，不重排版。
    # 原文件可能是紧凑格式（hotpot.json 116 行），json.dumps 重写会变成 331 行，
    # diff 被格式噪声淹没，review 时看不出改了什么。
    if changed and replacements:
        text = content_path.read_text(encoding="utf-8")
        for old_raw, new_raw in replacements:
            needle = json.dumps(old_raw, ensure_ascii=False)
            repl = json.dumps(new_raw, ensure_ascii=False)
            if text.count(needle) < 1:
                print(f"  ! 文本里找不到 {needle}，跳过")
                continue
            text = text.replace(needle, repl)
        content_path.write_text(text, encoding="utf-8")
        print(f"  → 已写回 {rel}（{stats['fixed']} 处路径，仅替换字符串）")

    if init_manifest and manifest is None:
        MEDIA.mkdir(parents=True, exist_ok=True)
        (MEDIA / film).mkdir(parents=True, exist_ok=True)
        skeleton = {
            "film": film,
            "_note": "由 asset-audit.py --init-manifest 生成。source.type 必须改成 generated/synthesized/shot/stock 之一，"
            "generated 与 synthesized 还要补 prompt/script 与 seed，否则无法重跑。规范见 docs/ASSET-POLICY.md。",
            "assets": [],
        }
        for group, entries in (("photos", photos), ("clips", clips)):
            for key, val in entries:
                resolved, _ = resolve_ref(path_of(val))
                credit = credits.get(str(key))
                if credit:
                    src = {"type": type_for(credit), "note": f"预填自镜头 args.credit={credit!r}（随画面渲染的那份）"}
                    lic = license_for(credit)
                else:
                    src = {"type": "unknown", "note": "必填：generated/synthesized/shot/stock"}
                    lic = ""
                skeleton["assets"].append(
                    {
                        "id": str(key),
                        "kind": "image" if group == "photos" else "video",
                        "path": str(resolved.relative_to(MEDIA / film)) if resolved else path_of(val),
                        "source": src,
                        "license": lic,
                        "frozen": bool(credit),
                    }
                )
        mpath.write_text(json.dumps(skeleton, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        filled = sum(1 for a in skeleton["assets"] if a["frozen"])
        print(
            f"  → 已生成骨架 {mpath.relative_to(ROOT)}"
            f"（{len(skeleton['assets'])} 条，其中 {filled} 条按 credit 预填，其余待填）"
        )
        # 刚预填掉的那些不该再计入待确认，否则汇总行与文件状态对不上
        stats["warn"] = max(0, stats["warn"] - filled)

    # 已有清单里的 unknown 条目，按镜头 credit 回填。只填有证据的，其余不动。
    if apply_credit and manifest is not None:
        filled = 0
        for a in manifest.get("assets", []):
            cur = a.get("source") or {}
            if cur.get("type") != "unknown":
                continue
            credit = credits.get(str(a.get("id")))
            if not credit:
                continue
            a["source"] = {"type": type_for(credit), "note": f"回填自镜头 args.credit={credit!r}"}
            a["license"] = license_for(credit)
            a["frozen"] = True
            filled += 1
        if filled:
            mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"  → 按镜头 credit 回填 {filled} 条 → {mpath.relative_to(ROOT)}")
            stats["warn"] = max(0, stats["warn"] - filled)

    return stats


def main():
    ap = argparse.ArgumentParser(description="素材引用与来源审计")
    ap.add_argument("files", nargs="*", help="content/*.json；缺省扫全部")
    ap.add_argument("--strict", action="store_true", help="有 P0/P1 问题时退出码 1")
    ap.add_argument("--fix-paths", action="store_true", help="把能映射到 assets/media 的旧路径写回 content")
    ap.add_argument("--init-manifest", action="store_true", help="为缺失的片子生成 manifest 骨架（有 credit 的自动预填）")
    ap.add_argument("--apply-credit", action="store_true", help="把清单里 unknown 的条目按镜头 args.credit 回填")
    a = ap.parse_args()

    targets = [Path(f) for f in a.files] if a.files else sorted((ROOT / "content").glob("*.json"))
    if not targets:
        print("没有找到 content/*.json")
        return 0

    total = {"p0": 0, "p1": 0, "p2": 0, "warn": 0, "fixed": 0}
    for t in targets:
        p = t if t.is_absolute() else (ROOT / t)
        if not p.is_file():
            print(f"\n跳过（不存在）：{t}")
            continue
        s = audit_one(p, fix_paths=a.fix_paths, init_manifest=a.init_manifest, apply_credit=a.apply_credit)
        for k in total:
            total[k] += s[k]

    print("\n" + "─" * 52)
    print(
        f"P0 路径 {total['p0']} · P1 来源 {total['p1']} · "
        f"P2 可重跑 {total['p2']} · W 待确认 {total['warn']}"
        + (f" · 已改写 {total['fixed']}" if total["fixed"] else "")
    )
    blocking = total["p0"] + total["p1"]
    if a.strict and blocking:
        print("FAIL · 有 P0/P1 问题")
        return 1
    if blocking:
        print("WARN · 只报告不阻断（加 --strict 才判失败）")
    elif total["warn"]:
        print(f"PASS · 引用与来源齐备，但 {total['warn']} 项来源待确认（发布前必须填）")
    else:
        print("PASS · 素材引用与来源记录齐备")
    return 0


if __name__ == "__main__":
    sys.exit(main())
