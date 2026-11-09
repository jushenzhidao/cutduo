#!/usr/bin/env bash
# 长稳：连续 N 条，观察内存与磁盘增长、失败率、延迟分布
set -uo pipefail
cd "$(dirname "$0")/.."
BASE=${1:-http://127.0.0.1:8788}; TOKEN=${2:-tokA-00000001}; N=${3:-15}
CT=${4:-renderd-test}
H() { curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

URI=$(H -X POST "$BASE/v1/assets" -H "X-Filename: s.mp4" --data-binary @/tmp/_multi_clip.mp4 \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['uri'])")

mem() { docker stats --no-stream --format '{{.MemUsage}}' "$CT" 2>/dev/null | awk '{print $1}'; }
echo "起始内存: $(mem)  起始磁盘: $(docker exec "$CT" du -sh /data | cut -f1)"

ok=0; fail=0; t0=$(date +%s); declare -a lat=()
for i in $(seq 1 "$N"); do
  BODY=$(python3 -c "
import json
print(json.dumps({'template_id':'hook_vertical_6s','variables':{'clip':'a1','hook':'soak $((i/20))'},
 'assets':[{'id':'a1','uri':'$URI'}],'idempotency_key':'soak-$i-$(date +%s)'}, ensure_ascii=False))")
  J=$(echo "$BODY" | H -X POST "$BASE/v1/render" -d @- | python3 -c "import json,sys;print(json.load(sys.stdin).get('job_id',''))")
  s=$(date +%s%N)
  for k in $(seq 1 120); do
    st=$(H "$BASE/v1/jobs/$J" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
    case "$st" in succeeded|failed) break;; esac
    sleep 0.4
  done
  e=$(date +%s%N)
  ms=$(( (e-s)/1000000 )); lat+=("$ms")
  if [ "$st" = "succeeded" ]; then ok=$((ok+1)); else fail=$((fail+1)); echo "  失败 #$i: $st"; fi
  if [ "$((i % 10))" -eq 0 ]; then printf "  #%03d %5dms %s\n" "$i" "$ms" "$st"; fi
  if [ "$((i % 100))" -eq 0 ]; then
    echo "  [checkpoint $i] mem=$(mem)  disk=$(docker exec "$CT" du -sh /data 2>/dev/null | cut -f1)"
  fi
done
dur=$(( $(date +%s) - t0 ))
echo "总计 ${dur}s  成功 $ok / 失败 $fail"
python3 - "${lat[@]}" <<'PY'
import sys
v=sorted(int(x) for x in sys.argv[1:])
n=len(v)
if n:
    print(f"  延迟 p50={v[n//2]}ms p90={v[min(n-1,int(n*0.9))]}ms max={v[-1]}ms")
PY
echo "结束内存: $(mem)  结束磁盘: $(docker exec "$CT" du -sh /data | cut -f1)"
echo "队列状态: $(H "$BASE/v1/jobs?limit=200" | python3 -c "
import json,sys,collections
jobs=json.load(sys.stdin)['jobs']
print(dict(collections.Counter(j['status'] for j in jobs)))")"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
