#!/usr/bin/env python3
"""模板冒烟：一条命令跑完「结构 → 渲染 → 打包 → 包校验」四关。

  python3 tools/template-smoke.py --template kits/science/template
  python3 tools/template-smoke.py --template templates/_scaffold   # 骨架会自动实例化
  python3 tools/template-smoke.py --template templates/own/foo --keep   # 保留中间产物

为什么要有这个脚本：这四步此前是手工顺序执行的，`node --check` 抓不到路径错误
（import 合法、运行时才 404），单靠人记步骤一定会漏。CI 里也是跑它。

退出码：0 全过；1 有任一关失败。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = next((d for d in [Path(__file__).resolve().parent, *Path(__file__).resolve().parent.parents] if (d / ".git").exists()), Path.cwd())


def run(cmd, **kw):
    t = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, **kw)
    return r, time.time() - t


def step(name, cmd):
    print(f"\n── {name} ──")
    r, dt = run(cmd)
    out = (r.stdout or "").strip()
    err = (r.stderr or "").strip()
    if r.returncode != 0:
        print(out[-1500:] if out else "")
        print(err[-1500:] if err else "")
        print(f"  ✗ 失败（{dt:.1f}s）")
        return False
    # 只回显最有信息量的几行，避免刷屏
    lines = [ln for ln in out.splitlines() if ln.strip()]
    for ln in lines[:2] + (["  …"] if len(lines) > 6 else []) + lines[-4:]:
        print(ln)
    print(f"  ✓ 通过（{dt:.1f}s）")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True)
    ap.add_argument("--keep", action="store_true", help="保留临时实例与产物")
    ap.add_argument("--workers", default="4")
    ap.add_argument("--at", default="2", help="probe 取帧秒数")
    a = ap.parse_args()

    src = (ROOT / a.template).resolve()
    if not src.is_dir():
        print(f"✗ 目录不存在：{src}", file=sys.stderr)
        return 2

    manifest = json.loads((src / "motion.json").read_text(encoding="utf-8"))
    tid = (manifest.get("template") or {}).get("id") or ""
    preset = (manifest.get("parameters") or {}).get("defaultPreset") or "presets/default.json"

    tmp_root = Path(tempfile.mkdtemp(prefix="tpl-smoke-"))
    # 骨架未实例化（id 含 __）时先复制成一份真实模板再跑，避免拿占位符去渲染
    if "__" in tid:
        inst = tmp_root / "instance"
        shutil.copytree(src, inst)
        # 只改 id/status，不调 new-template.py：它只写仓库内路径，会把临时实例落进 templates/
        m = json.loads((inst / "motion.json").read_text(encoding="utf-8"))
        m["template"]["id"] = "smoke-inst"
        m["template"]["status"] = "draft"
        (inst / "motion.json").write_text(json.dumps(m, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        work = inst
        print(f"骨架已实例化为临时模板：{work}")
    else:
        work = src

    pkg = tmp_root / f"{work.name}.motion"
    probe = tmp_root / "probe.png"

    ok = True
    ok &= step("1/4 结构体检", [sys.executable, "tools/check-template.py", "--src", str(work)])
    ok &= step("2/4 单帧渲染", ["node", "render.mjs", "--kit", str(work), "--params",
                                 str(work / preset), "--probe", str(probe), "--at", str(a.at)])
    p = probe.is_file() and probe.stat().st_size > 5000
    print(f"  {'✓' if p else '✗'} probe 产物 {probe.name}：{(probe.stat().st_size // 1024) if probe.is_file() else 0}KB（>5KB 视为有效）")
    ok &= p

    ok &= step("3/4 打包", [sys.executable, "tools/build-template.py", "--src", str(work), "--out", str(pkg)])
    ok &= step("4/4 包校验", ["node", "tools/motion-render.mjs", "inspect", "--package", str(pkg)])

    if not a.keep:
        shutil.rmtree(tmp_root, ignore_errors=True)
    else:
        print(f"\n中间产物保留在 {tmp_root}")

    print(f"\n{'PASS' if ok else 'FAIL'} · {a.template}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
