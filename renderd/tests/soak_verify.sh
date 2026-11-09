#!/usr/bin/env bash
# 资源修复的实证：跑 N 条，看 fd / 内存 / 磁盘是否收敛。
# 修复前 500 条实测：67 个残留 sqlite fd、内存 194→257 MiB、磁盘 97M→1.7G。
# 修复后期望：fd 稳定在个位数、内存收敛、磁盘只随「不同成片」增长（硬链接）。
set -uo pipefail
cd "$(dirname "$0")/.."
BASE=${1:-http://127.0.0.1:8788}
TOKEN=${2:-tokA-00000001}
N=${3:-100}
CT=${4:-renderd-test}

fd()   { docker exec "$CT" sh -c 'ls /proc/1/fd 2>/dev/null | wc -l' 2>/dev/null | tr -d ' '; }
mem()  { docker stats --no-stream --format '{{.MemUsage}}' "$CT" 2>/dev/null | awk '{print $1}'; }
disk() { docker exec "$CT" du -sh /data 2>/dev/null | cut -f1; }

SUMMARY=/tmp/soak_verify_summary.txt
echo "起始  fd=$(fd)  mem=$(mem)  disk=$(disk)" | tee "$SUMMARY"
./tests/soak.sh "$BASE" "$TOKEN" "$N" "$CT" > /tmp/soak_verify.log 2>&1
RC=$?
echo "结束  fd=$(fd)  mem=$(mem)  disk=$(disk)" | tee -a "$SUMMARY"
tail -10 /tmp/soak_verify.log
grep -E "总计|延迟 p50" /tmp/soak_verify.log >> "$SUMMARY" || true

FD=$(fd)
START_FD=$(grep -oE 'fd=[0-9]+' "$SUMMARY" | head -1 | cut -d= -f2)
echo "── 判定 ──"
# 绝对阈值会误报：容器跑了多久、常驻 worker/reaper 线程几个，都影响基线。
# 真正要测的是「这 N 条请求有没有让 fd 继续增长」—— 用增量。
DELTA=$(( ${FD:-999} - ${START_FD:-999} ))
echo "  fd 基线=${START_FD:-?} 结束=${FD:-?} 增量=${DELTA}"
if [ "$DELTA" -lt 10 ]; then
  echo "  PASS  fd 增量 ${DELTA} < 10（无持续泄漏）"
else
  echo "  FAIL  fd 增量 ${DELTA} 过大，疑似连接泄漏"
  RC=1
fi
exit "$RC"
