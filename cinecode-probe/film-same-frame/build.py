#!/usr/bin/env python3
"""Build film.html for 「同一帧」 from the cinecode quick-mode starter.

Two things are done here, and both are needed on this machine:

1. The FILM section of the starter is replaced by this film's own (film_section.js next to this file).
2. `window.renderAudio` is made window-aware (`?off=` / `?len=`). The headless Chrome in this sandbox kills the renderer
   when an OfflineAudioContext is longer than about 8 s — measured with a page that renders one oscillator and nothing
   else: 8 s exports, 10 s crashes. The soundtrack is therefore rendered in two windows and joined with ffmpeg.

Usage:  python3 build.py            # writes film.html
"""
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
KIT = pathlib.Path.home() / ".claude/skills/cinecode/templates/quick/film.html"
FILM_MARK = "// ============================== FILM =============================="
TAIL_MARK = "const q = new URLSearchParams(location.search);"

PATCHES = [
    (TAIL_MARK,
     TAIL_MARK + "\nconst AUDIO_OFF = +(q.get('off') || 0), AUDIO_LEN = +(q.get('len') || DURATION);"),
    ("new OfflineAudioContext(2, Math.round(DURATION * SR), SR)",
     "new OfflineAudioContext(2, Math.round(AUDIO_LEN * SR), SR)"),
    ("  SCENES.forEach((s, i) => { if (s.amb) ambience(ctx, wet(ctx, bus, 0.15), s.from, s.to, s.amb.kind, s.amb.gain, 300 + i); });\n"
     "  for (const e of SFX) sfx(ctx, bus, e);",
     "  SCENES.forEach((s, i) => { if (s.amb) { const a = Math.max(0, s.from - AUDIO_OFF), b = Math.min(AUDIO_LEN, s.to - AUDIO_OFF);\n"
     "    if (b - a > 0.05) ambience(ctx, wet(ctx, bus, 0.15), a, b, s.amb.kind, s.amb.gain, 300 + i); } });\n"
     "  for (const e of SFX) if (e.at >= AUDIO_OFF && e.at < AUDIO_OFF + AUDIO_LEN) sfx(ctx, bus, { ...e, at: e.at - AUDIO_OFF });"),
    ("} else score(ctx, bus);", "} else score(ctx, bus, AUDIO_OFF, AUDIO_LEN);"),
]


def main() -> int:
    src = KIT.read_text()
    film = (HERE / "film_section.js").read_text()
    head = src[: src.index(FILM_MARK) + len(FILM_MARK)]
    tail = src[src.index(TAIL_MARK):]
    out = head + "\n" + film.split("\n", 1)[1] + "\n" + tail

    for old, new in PATCHES:
        if old not in out:
            print(f"patch not applied, anchor missing: {old[:60]!r}", file=sys.stderr)
            return 1
        out = out.replace(old, new, 1)

    (HERE / "film.html").write_text(out)
    print(f"film.html written: {len(out)} bytes, {out.count(chr(10)) + 1} lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
