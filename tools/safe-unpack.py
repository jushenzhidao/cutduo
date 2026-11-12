#!/usr/bin/env python3
"""只读、安全地把 .motion (ZIP) 解到临时目录；拒绝越界路径、符号链接与特殊文件。

用法: python3 safe-unpack.py <package.motion> <dest-dir>
stdout: 包内条目清单，一行一个
"""
import pathlib
import stat
import sys
import zipfile

MAX_ENTRIES = 5000
MAX_TOTAL = 600 * 1024 * 1024


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: safe-unpack.py <package.motion> <dest-dir>")
    pkg, dst = sys.argv[1], sys.argv[2]
    root = pathlib.Path(dst).resolve()
    root.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(pkg) as z:
        infos = z.infolist()
        if len(infos) > MAX_ENTRIES:
            raise SystemExit(f"too many entries: {len(infos)}")
        total = 0
        for info in infos:
            name = info.filename
            parts = pathlib.PurePosixPath(name).parts
            mode = (info.external_attr >> 16) & 0o170000
            if name.startswith(("/", "\\")) or ".." in parts or "\\" in name or "\x00" in name:
                raise SystemExit(f"unsafe entry path: {name}")
            if mode == stat.S_IFLNK or mode not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise SystemExit(f"special entry: {name} (mode={oct(mode)})")
            if info.flag_bits & 0x1:
                raise SystemExit(f"encrypted entry: {name}")
            total += info.file_size
            if info.compress_size and info.file_size / info.compress_size > 200 and info.file_size > 10 * 1024 * 1024:
                raise SystemExit(f"compression ratio too high: {name}")
        if total > MAX_TOTAL:
            raise SystemExit(f"expanded size too large: {total}")

        for info in infos:
            if info.is_dir():
                continue
            target = (root / info.filename).resolve()
            if not str(target).startswith(str(root) + "/"):
                raise SystemExit(f"path traversal: {info.filename}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(info))
        print("\n".join(i.filename for i in infos))


if __name__ == "__main__":
    main()
