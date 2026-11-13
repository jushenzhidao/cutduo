#!/usr/bin/env bash
# tools/fetch-fonts.sh · 字体是构建依赖，不进 git
#
# 用法：
#   bash tools/fetch-fonts.sh            # 缺什么补什么
#   bash tools/fetch-fonts.sh --verify   # 只校验现有文件，不下载（部署前跑这个）
#   bash tools/fetch-fonts.sh --force    # 全部重下（上游改版后修复用）
#
# 设计：19 个文件全部 sha256 硬校验，没有一个「只锁 tag」的例外。
#   上一版有 13 个只锁 tag（Mona Sans / JetBrains Mono），而 tag 里的路径写错了
#   （v1.0.1/fonts/ttf 而不是 v2.0.27/fonts/static/ttf）—— 体积差一倍，
#   脚本会「成功」下到另一个版本的字形，且 --verify 永远显示 ✓。这类静默错版
#   只有字节级校验能挡住。
#
# 退出码：0 全部就位；1 有缺失或校验失败。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/assets/fonts"
mkdir -p "$DIR"

VERIFY=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --verify) VERIFY=1 ;;
    --force)  FORCE=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$a"; exit 2 ;;
  esac
done

# 文件名|sha256|url
# 上游版本：Noto CJK main / Google Fonts 的 LongCang、ZCOOL / LXGW v1.510 /
#           Mona Sans v2.0.27 (fonts/static/ttf) / JetBrains Mono v2.304
FONTS=(
  "JetBrainsMono-Bold.ttf|5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb|https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@v2.304/fonts/ttf/JetBrainsMono-Bold.ttf"
  "JetBrainsMono-Medium.ttf|31c92d01a8a08528b718a43addf0ad3df0af2ca4b7b3290a452f70f358e14d3d|https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@v2.304/fonts/ttf/JetBrainsMono-Medium.ttf"
  "JetBrainsMono-Regular.ttf|a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f|https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@v2.304/fonts/ttf/JetBrainsMono-Regular.ttf"
  "LXGWWenKai-Regular.ttf|ea47ec17d0f3d0ed1e6d9c51d6146402d4d1e2f0ff397a90765aaaa0ddd382fb|https://cdn.jsdelivr.net/gh/lxgw/LxgwWenKai@v1.510/fonts/TTF/LXGWWenKai-Regular.ttf"
  "LongCang-Regular.ttf|e5bf2c3f24ef2327c6f136d8f73e2f9dfdf44896fdbeb35a9515f44777bb91bc|https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/longcang/LongCang-Regular.ttf;https://raw.githubusercontent.com/google/fonts/main/ofl/longcang/LongCang-Regular.ttf;https://fastly.jsdelivr.net/gh/google/fonts@main/ofl/longcang/LongCang-Regular.ttf"
  "MonaSans-Black.ttf|f163fdc0235c5946c6ebb751711187479b4d12afbf24fcec527fb1436817f427|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSans-Black.ttf"
  "MonaSans-Bold.ttf|5ccaea90ac9d61a1503efb7b138bf4440313e7214432bdaa584189aba177e807|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSans-Bold.ttf"
  "MonaSans-Medium.ttf|e5c608f35644eecba539cc37fdaa6cbe04a28ad780f0cfa85637779bdc7ef414|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSans-Medium.ttf"
  "MonaSans-Regular.ttf|ae4eb31f8cd332260a698b6a4391d5fff079e818c152d31d686ac0e1533cc0fa|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSans-Regular.ttf"
  "MonaSans-SemiBold.ttf|67636cd715fc8637df3d0f215f478af37924fa3f2c9ee0d3ed8f3147211811f2|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSans-SemiBold.ttf"
  "MonaSansDisplay-Black.ttf|906ec2c2a153dfc5cb3a119e16f1c0f5312c67ed207d189f2d11d59fe656a0df|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSansDisplay-Black.ttf"
  "MonaSansExpanded-Black.ttf|197407cae9d8450c2557f8977a8299b127a7bfbfdcd496fca08abf74c132e343|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSansExpanded-Black.ttf"
  "MonaSansExpanded-Bold.ttf|fd72430c52101057fa97fcf1a38dcd1ccf8ff37bbbdfdd262bb45069266d49b3|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSansExpanded-Bold.ttf"
  "MonaSansExpanded-Medium.ttf|0b3057ad37bdd323b7926fffbfa1bf880757ff0859d09a4757f91d18d879a5a1|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSansExpanded-Medium.ttf"
  "MonaSansExpanded-SemiBold.ttf|f64b5083d37ce2a1ab52b8199901393d1d5eefdca249519ddf70eedb0632b16b|https://cdn.jsdelivr.net/gh/github/mona-sans@v2.0.27/fonts/static/ttf/MonaSansExpanded-SemiBold.ttf"
  "NotoSansSC-Black.otf|ccb496022356b7dd14d117538a472ae40feff8f6e8f3fe8bffc5616785d2f3f9|https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Black.otf"
  "NotoSansSC-Medium.otf|7633f5a016d4dd95e685a69633d818aabc4644c4b08e26bd35b1b30c45ed5dda|https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Medium.otf"
  "NotoSansSC-Regular.otf|faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9|https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf"
  "ZCOOLKuaiLe-Regular.ttf|812a6fc1fe54b6d73a419245c32dfeba8aa33104d5be90d1cf6af082007cb71d|https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf;https://raw.githubusercontent.com/google/fonts/main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf"
)

sha_of() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
size_of() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null; }

# 字体魔数：0x00010000 / OTTO / true / ttcf。防的是「下载到了 HTML 错误页」。
font_ok() {
  local f="$1" sz magic
  sz=$(size_of "$f"); [ -n "${sz:-}" ] && [ "$sz" -gt 50000 ] || return 1
  magic=$(od -An -tx1 -N4 "$f" | tr -d ' \n')
  case "$magic" in
    00010000|4f54544f|74727565|74746366) return 0 ;;
    *) return 1 ;;
  esac
}

OK=0; MISSING=0; BAD=0
FAILED=()

for e in "${FONTS[@]}"; do
  IFS='|' read -r name want url <<< "$e"
  path="$DIR/$name"

  if [ "$FORCE" = 1 ] && [ "$VERIFY" = 0 ]; then rm -f "$path"; fi

  if [ -s "$path" ]; then
    got=$(sha_of "$path")
    if [ "$got" = "$want" ]; then
      printf '  ✓ %-32s %s 字节\n' "$name" "$(size_of "$path")"
      OK=$((OK+1)); continue
    fi
    printf '  ✗ %-32s sha256 不符（本地文件被改过或是别的版本）\n' "$name"
    printf '      期望 %s\n      实际 %s\n' "$want" "$got"
    BAD=$((BAD+1)); FAILED+=("$name")
    if [ "$VERIFY" = 1 ]; then continue; fi
    printf '      重下…\n'
  else
    if [ "$VERIFY" = 1 ]; then
      printf '  ✗ %-32s 缺失\n' "$name"
      MISSING=$((MISSING+1)); FAILED+=("$name"); continue
    fi
    printf '  ↓ %-32s 下载中…\n' "$name"
  fi

  tmp="$path.part"
  got_ok=0
  # 多源回退：源之间用 ; 分隔。jsDelivr 的 @main 对大仓库会中途 reset，
  # --retry-all-errors 才会重试「传到一半断了」，默认的 --retry 不重试这一种。
  IFS=';' read -ra URLS <<< "$url"
  for u in "${URLS[@]}"; do
    if curl -sSL --http1.1 --retry 4 --retry-delay 2 --retry-all-errors --retry-connrefused \
         --connect-timeout 20 --max-time 300 -o "$tmp" "$u"; then
      got_ok=1; break
    fi
    printf '  … %-32s 换源重试\n' "$name"
  done
  if [ "$got_ok" = 0 ]; then
    printf '  ✗ %-32s 全部源都失败\n      %s\n' "$name" "$url"
    rm -f "$tmp"; MISSING=$((MISSING+1)); FAILED+=("$name"); continue
  fi
  got=$(sha_of "$tmp")
  if [ "$got" != "$want" ]; then
    printf '  ✗ %-32s 下载后 sha256 不符（上游改了同一 tag 的文件？）\n' "$name"
    printf '      期望 %s\n      实际 %s\n' "$want" "$got"
    rm -f "$tmp"; BAD=$((BAD+1)); FAILED+=("$name"); continue
  fi
  if ! font_ok "$tmp"; then
    printf '  ✗ %-32s 内容不是字体\n' "$name"
    rm -f "$tmp"; BAD=$((BAD+1)); FAILED+=("$name"); continue
  fi
  mv "$tmp" "$path"
  printf '  ✓ %-32s 已就位 %s 字节\n' "$name" "$(size_of "$path")"
  OK=$((OK+1))
done

echo
echo "──────────── $OK 就位 / $MISSING 缺失 / $BAD 校验失败（共 ${#FONTS[@]} 项）────────────"
if [ "$MISSING" -eq 0 ] && [ "$BAD" -eq 0 ]; then echo "字体齐全，可以出片。"; exit 0; fi
printf '问题文件：%s\n' "${FAILED[*]}" >&2
[ "$VERIFY" = 1 ] && echo "跑 bash tools/fetch-fonts.sh 补齐。" >&2
exit 1
