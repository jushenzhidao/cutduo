#!/usr/bin/env bash
# 主题回归测试：CLI 三主题必须互不相同；daemon 并发不同主题不得串色。
set -u
cd "$(dirname "$0")"
IN="edits/inputs-v8.json"
AUD="edits/audio-v8.m4a"
TMP="/tmp/theme-test"
rm -rf "$TMP" && mkdir -p "$TMP"
fail() { echo "FAIL: $*"; exit 1; }
psnr() {
  /opt/homebrew/bin/ffmpeg -hide_banner -i "$1" -i "$2" -lavfi "[0:v][1:v]psnr" -f null - 2>&1 \
    | grep -oE 'average:[0-9.]+' | tail -1 | cut -d: -f2
}

echo "=== 1. CLI 三主题渲染 ==="
for t in knowledge product lifestyle; do
  node canvas-editorial.mjs --inputs "$IN" --audio "$AUD" --theme "$t" \
    --out "$TMP/cli-$t.mp4" --workers 8 > "$TMP/cli-$t.log" 2>&1 || fail "render $t"
  printf "  %-10s %s\n" "$t" "$(md5 -q "$TMP/cli-$t.mp4" | cut -c1-12)"
done
uniq_count=$(md5 -q "$TMP"/cli-*.mp4 | sort -u | wc -l | tr -d ' ')
[ "$uniq_count" = "3" ] || fail "三主题输出有重复（uniq=$uniq_count），worker 可能未收到 theme"

echo "=== 2. daemon 并发不同主题 ==="
node render-daemon.mjs 7811 4 > "$TMP/daemon.log" 2>&1 &
DPID=$!
trap 'kill $DPID 2>/dev/null' EXIT
sleep 3
curl -s --max-time 60 -X POST http://127.0.0.1:7811/render -H 'content-type: application/json' \
  -d "{\"inputs\":\"$IN\",\"out\":\"$TMP/d-product.mp4\",\"audio\":\"$AUD\",\"theme\":\"product\"}" > "$TMP/r1.json" &
P1=$!
curl -s --max-time 60 -X POST http://127.0.0.1:7811/render -H 'content-type: application/json' \
  -d "{\"inputs\":\"$IN\",\"out\":\"$TMP/d-lifestyle.mp4\",\"audio\":\"$AUD\",\"theme\":\"lifestyle\"}" > "$TMP/r2.json" &
P2=$!
wait "$P1" "$P2"
grep -q '"ok":true' "$TMP/r1.json" || fail "daemon product 请求失败：$(cat "$TMP/r1.json")"
grep -q '"ok":true' "$TMP/r2.json" || fail "daemon lifestyle 请求失败：$(cat "$TMP/r2.json")"

p_same=$(psnr "$TMP/d-product.mp4" "$TMP/cli-product.mp4")
p_cross=$(psnr "$TMP/d-product.mp4" "$TMP/cli-lifestyle.mp4")
l_same=$(psnr "$TMP/d-lifestyle.mp4" "$TMP/cli-lifestyle.mp4")
l_cross=$(psnr "$TMP/d-lifestyle.mp4" "$TMP/cli-product.mp4")
echo "  product   vs CLI product=${p_same}dB  vs CLI lifestyle=${p_cross}dB"
echo "  lifestyle vs CLI lifestyle=${l_same}dB  vs CLI product=${l_cross}dB"

python3 - "$p_same" "$p_cross" "$l_same" "$l_cross" <<'PY' || fail "daemon 主题串色或画质异常"
import sys
s1, c1, s2, c2 = map(float, sys.argv[1:5])
assert s1 > 45 and s2 > 45, f"同主题 PSNR 过低：{s1}, {s2}"
assert c1 < 30 and c2 < 30, f"跨主题 PSNR 过高（可能串色）：{c1}, {c2}"
print("  ✓ 同主题 >45dB、跨主题 <30dB")
PY

echo "=== 3. 帧数与音画对齐 ==="
for f in "$TMP"/cli-*.mp4 "$TMP"/d-*.mp4; do
  frames=$(/opt/homebrew/bin/ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of csv=p=0 "$f")
  [ "$frames" = "1020" ] || fail "$(basename "$f") 帧数 $frames != 1020"
done
echo "  全部 1020 帧"

echo "RESULT: PASS"
