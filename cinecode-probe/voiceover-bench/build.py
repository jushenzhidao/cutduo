#!/usr/bin/env python3
"""Build film.html for the voice-over benchmark.

The FILM section of the cinecode quick-mode starter is replaced by film_section.js next to this file. Nothing else is
patched: this film is rendered picture-only and muxed with the same audio track the Skia pipeline used, so the two
deliverables differ only in their renderer.

Usage:  python3 build.py [film_section.js] [film.html]
"""
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
KIT = pathlib.Path.home() / ".claude/skills/cinecode/templates/quick/film.html"
FILM_MARK = "// ============================== FILM =============================="
TAIL_MARK = "const q = new URLSearchParams(location.search);"


def main() -> int:
    film_name = sys.argv[1] if len(sys.argv) > 1 else "film_section.js"
    out_name = sys.argv[2] if len(sys.argv) > 2 else "film.html"
    src = KIT.read_text()
    film = (HERE / film_name).read_text()
    head = src[: src.index(FILM_MARK) + len(FILM_MARK)]
    tail = src[src.index(TAIL_MARK):]
    out = head + "\n" + film.split("\n", 1)[1] + "\n" + tail
    (HERE / out_name).write_text(out)
    print(f"{out_name} written: {len(out)} bytes (film: {film_name})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
