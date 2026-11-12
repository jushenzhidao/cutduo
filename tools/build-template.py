#!/usr/bin/env python3
"""把任意模板目录按 MotionGit 规范打包成 .motion（ZIP）。

用法:
  python3 build-template.py                                                  # 默认 distill 模板
  python3 build-template.py --src templates/own/editorial --out packages/editorial-cut.motion

- 生成 integrity.json：除自身外所有冻结文件的 SHA-256
- 根目录含 motion.json；所有引用文件必须存在
- 不打包任何凭据、绝对路径或自动加载的 AGENTS/CLAUDE 文件
"""
import argparse
import hashlib
import json
import pathlib
import zipfile

ap = argparse.ArgumentParser()
ap.add_argument("--src", default="templates/own/distill")
ap.add_argument("--out", default="packages/workbuddy-distill.motion")
a = ap.parse_args()

def _repo_root(start):
    """向上找 .git（与 src/root.mjs 同策略）：脚本在 tools/ 下也能定位仓库根。"""
    for d in [start, *start.parents]:
        if (d / ".git").exists():
            return d
    return start


ROOT = _repo_root(pathlib.Path(__file__).resolve().parent)
SRC = (ROOT / a.src).resolve()
OUT = (ROOT / a.out).resolve()
OUT.parent.mkdir(parents=True, exist_ok=True)

manifest = json.loads((SRC / "motion.json").read_text())
refs = [
    manifest["runtime"]["entry"],
    manifest["runtime"]["dependencyLock"],
    manifest["parameters"]["schema"],
    manifest["parameters"]["defaultPreset"],
    manifest["assets"]["manifest"],
    manifest["license"]["file"],
    manifest["ai"]["entry"],
    manifest["ai"]["guide"],
]
for ref in refs:
    assert (SRC / ref).is_file(), f"manifest 引用缺失: {ref}"

# 打包只收运行时产物：_raw.* 是未抠图/未压缩的源素材，indesign 类中间件同样排除
SKIP = ("_raw.png", "_raw.jpg", "_raw.jpeg", ".psd", ".xcf")
files = sorted(
    p for p in SRC.rglob("*")
    if p.is_file() and p.name != "integrity.json" and not p.name.startswith(".")
    and not p.name.endswith(SKIP)
)
integrity = {
    "algorithm": "sha256",
    "files": {
        p.relative_to(SRC).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in files
    },
}
(SRC / "integrity.json").write_text(
    json.dumps(integrity, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
files.append(SRC / "integrity.json")

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for p in files:
        z.write(p, p.relative_to(SRC).as_posix())

print(f"✓ {OUT}")
print(f"  {len(files)} 个条目 · {OUT.stat().st_size} bytes · integrity 覆盖 {len(integrity['files'])} 个文件")
print("\n".join("    " + p.relative_to(SRC).as_posix() for p in files))
