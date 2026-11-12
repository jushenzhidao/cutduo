#!/usr/bin/env python3
"""从 templates/_scaffold 生成一支新模板。

  python3 new-template.py --id my-template --title "我的版式"
  python3 new-template.py --id my-template --title "我的版式" --summary "一句话" --source xxx.mp4

做的事：复制骨架 → 替换占位符 → 把 .README.md.tmpl 改名成 README.md → 自检 → 打印下一步。
不做的事：不写画面语言（那是设计工作，脚本代替不了），不自动打包。
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

def _repo_root(start):
    """向上找 .git（与 src/root.mjs 同策略）：脚本在 tools/ 下也能定位仓库根。"""
    for d in [start, *start.parents]:
        if (d / ".git").exists():
            return d
    return start


ROOT = _repo_root(Path(__file__).resolve().parent)
SCAFFOLD = ROOT / "templates" / "_scaffold"

# 骨架里不复制的东西：README.md 是骨架自己的说明书；integrity 由打包器生成
SKIP_NAMES = {"README.md", "integrity.json"}
# 这些后缀按文本处理；其余按二进制原样复制
TEXT_SUFFIX = {".json", ".md", ".js", ".html", ".txt", ".py", ".tmpl"}


def owner_default() -> str:
    try:
        out = subprocess.run(
            ["git", "config", "user.name"], capture_output=True, text=True, timeout=3
        )
        name = out.stdout.strip()
        if name:
            return name
    except Exception:
        pass
    return "cutduo"


def build_map(a) -> dict:
    return {
        "__ID__": a.id,
        "__TITLE__": a.title,
        "__SUMMARY__": a.summary or f"{a.title}视频模板",
        "__SOURCE__": a.source or "TBD（补上反推用的参考片文件名）",
        "__RESOLUTION__": a.resolution or "TBD",
        "__BRAND__": a.brand or a.title,
        "__OWNER__": a.owner,
        "__YEAR__": str(date.today().year),
        "__STYLE__": a.style or "TBD（一句话描述画面语言）",
        "__USE_CASE__": a.use_case or "TBD",
        "__NOT_FOR__": a.not_for or "TBD",
        # SPEC.md 里的实测位：留 TBD，由 check-template.py 提醒，不许编数
        "__MEDIAN_SHOT__": "TBD",
        "__RATIO_EXPLAIN__": "TBD",
        "__RATIO_DIAGRAM__": "TBD",
        "__RATIO_LABEL__": "TBD",
        "__RATIO_BOOKEND__": "TBD",
        "__SIZE_TITLE__": "TBD",
        "__CAP_TITLE__": "TBD",
        "__SIZE_SUB__": "TBD",
        "__CAP_SUB__": "TBD",
        "__SIZE_CAPTION__": "TBD",
        "__CAP_CAPTION__": "TBD",
        "__SIZE_LABEL__": "TBD",
        "__CAP_LABEL__": "TBD",
    }


def apply(path: Path, mapping: dict) -> None:
    text = path.read_text(encoding="utf-8")
    for k, v in mapping.items():
        text = text.replace(k, v)
    # 骨架 → 草稿：status 是枚举，生成后不该还写 skeleton
    if path.name == "motion.json":
        text = text.replace('"status": "skeleton"', '"status": "draft"')
    path.write_text(text, encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True, help="kebab-case，例如 chat-explainer")
    ap.add_argument("--title", required=True)
    ap.add_argument("--summary", default="")
    ap.add_argument("--source", default="")
    ap.add_argument("--resolution", default="")
    ap.add_argument("--brand", default="")
    ap.add_argument("--style", default="")
    ap.add_argument("--use-case", dest="use_case", default="")
    ap.add_argument("--not-for", dest="not_for", default="")
    ap.add_argument("--owner", default=owner_default())
    ap.add_argument("--out-dir", default="templates/own")
    ap.add_argument("--force", action="store_true", help="目标已存在时覆盖")
    a = ap.parse_args()

    if not re.fullmatch(r"[a-z][a-z0-9-]{1,40}", a.id):
        print(f"✗ id 必须是 kebab-case（小写字母/数字/连字符）：{a.id}", file=sys.stderr)
        return 2
    if a.id.startswith("_") or a.id in {"own", "vendor"}:
        print(f"✗ id 不能用保留名：{a.id}", file=sys.stderr)
        return 2

    dest = (ROOT / a.out_dir / a.id).resolve()
    if dest.exists():
        if not a.force:
            print(f"✗ 目标已存在：{dest}\n  加 --force 覆盖，或换个 id", file=sys.stderr)
            return 2
        shutil.rmtree(dest)

    mapping = build_map(a)
    n_files = 0
    for src in sorted(SCAFFOLD.rglob("*")):
        if not src.is_file():
            continue
        rel = src.relative_to(SCAFFOLD)
        if rel.name in SKIP_NAMES:
            continue
        # .README.md.tmpl → README.md（模板自身的说明）
        if rel.name.startswith(".") and rel.name.endswith(".tmpl"):
            target = dest / rel.parent / rel.name[1 : -len(".tmpl")]
        else:
            target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix in TEXT_SUFFIX:
            target.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
            apply(target, mapping)
        else:
            shutil.copy2(src, target)
        n_files += 1

    print(f"✓ 生成 {dest.relative_to(ROOT)}  ·  {n_files} 个文件")

    # 自检：结构能不能过
    chk = ROOT / "check-template.py"
    if chk.exists():
        print("\n—— 结构自检 ——")
        sys.stdout.flush()
        r = subprocess.run([sys.executable, str(chk), "--src", str(dest)])
        if r.returncode != 0:
            print("\n自检未通过，先按上面的 ✗ 修，再开始写画面。", file=sys.stderr)
            return 1

    print(
        "\n下一步：\n"
        f"  1. 读 templates/_scaffold/README.md 第五节，按顺序填 guide → schema → preset\n"
        f"  2. uv run python check-template.py --src {a.out_dir}/{a.id}\n"
        f"  3. uv run python build-template.py --src {a.out_dir}/{a.id} --out packages/{a.id}.motion"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
