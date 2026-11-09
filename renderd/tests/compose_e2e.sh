#!/usr/bin/env bash
# Compose 端到端：api 与 worker 分离部署 + 崩溃恢复 + 重启持久化
set -uo pipefail
cd "$(dirname "$0")/.."

export RENDERD_TOKENS="tokA-00000001:acme"
export RENDERD_SECRET="compose-secret"
export RENDERD_LEASE_S=15              # 缩短租约，好在测试里观测到回收
export RENDERD_MAX_ATTEMPTS=3
export RENDERD_PUBLISH_PORT=8790
export RENDERD_QUOTA_QPS=200

BASE="http://127.0.0.1:${RENDERD_PUBLISH_PORT}"
TOKEN="tokA-00000001"
H() { curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1 ($2)"; pass=$((pass+1)); else echo "  ✗ $1 期望 $3 实际 $2"; fail=$((fail+1)); fi; }

cleanup() { docker compose down -v >/dev/null 2>&1; }
trap cleanup EXIT

echo "── 0. 重建环境 ──"
cleanup
docker compose up -d --build >/tmp/compose_up.log 2>&1 || { echo "启动失败"; tail -20 /tmp/compose_up.log; exit 1; }
for i in $(seq 1 90); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 1; done
chk "api 就绪" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" "200"
docker compose ps --format '  {{.Service}}: {{.State}}' 2>/dev/null | sed 's/^/  /'

echo "── 1. 上传素材 ──"
[ -f /tmp/_e2e_clip.mp4 ] || ffmpeg -y -v error -f lavfi -i "testsrc2=s=1080x1920:r=30:d=12" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p /tmp/_e2e_clip.mp4
UP=$(H -X POST "$BASE/v1/assets" -H "X-Filename: c.mp4" --data-binary @/tmp/_e2e_clip.mp4)
URI=$(echo "$UP" | python3 -c "import json,sys;print(json.load(sys.stdin)['uri'])")
chk "上传成功" "$(echo "$UP" | python3 -c "import json,sys;print('yes' if json.load(sys.stdin)['bytes']>0 else 'no')")" "yes"

echo "── 2. 提交 4 条（3 模板 + 1 长任务做崩溃靶子）──"
STAMP=$(date +%s)
sub() { python3 -c "
import json,sys
print(json.dumps({'template_id':sys.argv[1],'variables':json.loads(sys.argv[2]),
 'assets':json.loads(sys.argv[3]),'idempotency_key':sys.argv[4]}, ensure_ascii=False))" "$@" \
  | H -X POST "$BASE/v1/render" -d @- | python3 -c "import json,sys;print(json.load(sys.stdin).get('job_id',''))"; }
A1="[{\"id\":\"a1\",\"uri\":\"$URI\"}]"
A3="[{\"id\":\"a1\",\"uri\":\"$URI\"},{\"id\":\"a2\",\"uri\":\"$URI\"},{\"id\":\"a3\",\"uri\":\"$URI\"}]"
J1=$(sub hook_vertical_6s '{"clip":"a1","hook":"compose 一"}' "$A1" "cp1-$STAMP")
J2=$(sub caption_square_9s '{"clip":"a1","caption":"方形也要对"}' "$A1" "cp2-$STAMP")
J3=$(sub brand_vertical_15s '{"clip1":"a1","clip2":"a2","clip3":"a3","title":"三段"}' "$A3" "cp3-$STAMP")
J4=$(sub brand_vertical_15s '{"clip1":"a1","clip2":"a2","clip3":"a3","title":"崩溃靶子"}' "$A3" "cp4-$STAMP")
JOBS="$J1 $J2 $J3 $J4"
echo "  jobs: $JOBS"
chk "4 条受理" "$(echo $JOBS | wc -w | tr -d ' ')" "4"

echo "── 3. 等 worker 开始干活，然后 kill -9 ──"
for i in $(seq 1 40); do
  st=$(H "$BASE/v1/jobs/$J4" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
  [ "$st" = "running" ] && break
  sleep 0.5
done
echo "  靶子状态: $st"
docker compose kill -s SIGKILL worker >/dev/null 2>&1
chk "worker 已杀死" "$(docker compose ps -q worker | wc -l | tr -d ' ')" "0"

echo "── 4. 等租约过期（LEASE_S=15）──"
sleep 18
st4=$(H "$BASE/v1/jobs/$J4" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
echo "  过期后状态: $st4"
EV=$(H "$BASE/v1/jobs/$J4/events" | python3 -c "
import json,sys
evs=json.load(sys.stdin)['events']
print('yes' if any('lease expired' in (e.get('message') or '') for e in evs) else 'no')")
chk "任务被识别为租约过期" "$EV" "yes"

echo "── 5. 拉起 worker，验证任务自愈 ──"
docker compose up -d worker >/dev/null 2>&1
for i in $(seq 1 150); do
  done_n=0
  for j in $JOBS; do
    s=$(H "$BASE/v1/jobs/$j" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
    case "$s" in succeeded|failed) done_n=$((done_n+1));; esac
  done
  [ "$done_n" -ge 4 ] && break
  sleep 1
done
okn=0
for j in $JOBS; do
  s=$(H "$BASE/v1/jobs/$j" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
  [ "$s" = "succeeded" ] && okn=$((okn+1))
done
chk "4 条最终全部成功" "$okn" "4"

echo "── 6. 崩溃任务的尝试次数 ──"
python3 - <<PY
import json,urllib.request
def get(p):
    r=urllib.request.Request("$BASE"+p, headers={"Authorization":"Bearer $TOKEN"})
    return json.load(urllib.request.urlopen(r))
j=get("/v1/jobs/$J4")
print(f"  attempts={j['attempts']} max={j['max_attempts']} cache_hit={j['cache_hit']} cost={j['cost_seconds']}s")
assert j["attempts"] >= 2, "崩溃后应有重试"
PY
chk "崩溃后发生了重试" "$?" "0"

echo "── 7. 重启 api，验证持久化 ──"
docker compose restart api >/dev/null 2>&1
for i in $(seq 1 60); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 1; done
s1=$(H "$BASE/v1/jobs/$J1" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
chk "重启后任务仍在" "$s1" "succeeded"
LIST=$(H "$BASE/v1/jobs?limit=10" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['jobs']))")
chk "任务列表可查" "$([ "$LIST" -ge 4 ] && echo yes)" "yes"

echo "── 8. 缓存命中（同 IR 二次提交）──"
BODY=$(python3 -c "
import json
print(json.dumps({'template_id':'hook_vertical_6s','variables':{'clip':'a1','hook':'compose 一'},
 'assets':[{'id':'a1','uri':'$URI'}],'idempotency_key':'cp1b-$STAMP'}, ensure_ascii=False))")
J5=$(echo "$BODY" | H -X POST "$BASE/v1/render" -d @- | python3 -c "import json,sys;print(json.load(sys.stdin)['job_id'])")
for i in $(seq 1 60); do
  s=$(H "$BASE/v1/jobs/$J5" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
  [ "$s" = "succeeded" ] && break; sleep 0.5
done
chk "二次提交命中缓存" "$(H "$BASE/v1/jobs/$J5" | python3 -c "import json,sys;print(json.load(sys.stdin)['cache_hit'])")" "True"

echo "── 9. 容器内非 root ──"
UID_=$(docker compose exec -T api id -u 2>/dev/null | tr -d '\r')
chk "以非 root 运行" "$([ "$UID_" != "0" ] && echo yes)" "yes"

echo
echo "通过 $pass / 失败 $fail"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
