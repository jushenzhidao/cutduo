#!/usr/bin/env bash
# Caddy 网关端到端：TLS 终止 → 反代 → 真实任务链路 → /metrics 白名单收紧。
set -uo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.tls.yml"
export RENDERD_TOKENS="tokA-00000001:acme"
export RENDERD_SECRET="gateway-secret"
export RENDERD_TLS_PORT=8443
TOKEN=tokA-00000001
BASE=https://127.0.0.1:8443
./deploy/make-dev-cert.sh >/dev/null

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS $1 ($2)"; pass=$((pass+1));
        else echo "  FAIL $1: got=$2 want=$3"; fail=$((fail+1)); fi; }
H() { curl -sk -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

echo "启动 api + worker + gateway…"
$COMPOSE up -d --build >/tmp/gateway_up.log 2>&1 || { tail -30 /tmp/gateway_up.log; exit 1; }

ok=0
for i in $(seq 1 60); do
  curl -sk --max-time 3 "$BASE/healthz" >/dev/null 2>&1 && { ok=1; break; }
  sleep 1
done
if [ "$ok" -ne 1 ]; then echo "网关未就绪"; tail -30 /tmp/gateway_up.log; $COMPOSE logs --tail=30; exit 1; fi

chk "HTTPS healthz" "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/healthz")" "200"
chk "明文 HTTP 打 TLS 端口被拒" \
  "$(curl -s --max-time 3 http://127.0.0.1:8443/healthz | grep -c '"ok"' || true)" "0"
chk "默认白名单可取 metrics" \
  "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/metrics")" "200"

# 真实任务：上传 → 提交 → 轮询 → 回执，全部走 HTTPS
[ -f /tmp/_multi_clip.mp4 ] || ffmpeg -y -v error -f lavfi -i "testsrc2=s=540x960:r=30:d=10" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p /tmp/_multi_clip.mp4 >/dev/null 2>&1
URI=$(H -X POST "$BASE/v1/assets" -H "X-Filename: gw.mp4" \
  --data-binary @/tmp/_multi_clip.mp4 | python3 -c "import json,sys;print(json.load(sys.stdin).get('uri',''))")
chk "HTTPS 上传素材" "$([ -n "$URI" ] && echo yes || echo no)" "yes"

BODY=$(python3 -c "
import json
print(json.dumps({'template_id':'hook_vertical_6s',
 'variables':{'clip':'a1','hook':'网关链路'},
 'assets':[{'id':'a1','uri':'$URI'}],
 'idempotency_key':'gateway-e2e-0001'}, ensure_ascii=False))")
JID=$(echo "$BODY" | H -X POST "$BASE/v1/render" -d @- \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('job_id',''))")
chk "HTTPS 提交任务" "$([ -n "$JID" ] && echo yes || echo no)" "yes"

ST=""
for i in $(seq 1 90); do
  ST=$(H "$BASE/v1/jobs/$JID" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])" 2>/dev/null)
  case "$ST" in succeeded|failed) break;; esac
  sleep 0.5
done
chk "任务成功" "$ST" "succeeded"
VERDICT=$(H "$BASE/v1/jobs/$JID/receipt" | python3 -c "
import json,sys;d=json.load(sys.stdin);print(d.get('verdict',''))" 2>/dev/null)
chk "回执 verdict=pass" "$VERDICT" "pass"
L0=$(H "$BASE/v1/jobs/$JID/receipt" | python3 -c "
import json,sys;d=json.load(sys.stdin);print('yes' if d.get('L0_ingest',{}).get('applicable') else 'no')" 2>/dev/null)
chk "回执含 L0_ingest" "$L0" "yes"

# 收紧白名单：宿主机来源应被 403
METRICS_ALLOW="10.0.0.0/8" $COMPOSE up -d --force-recreate gateway >/tmp/gateway_reload.log 2>&1
sleep 3
chk "收紧后 metrics 403" \
  "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/metrics")" "403"
chk "收紧后业务接口不受影响" \
  "$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/healthz")" "200"

echo "网关 E2E：通过 $pass / 失败 $fail"
$COMPOSE down >/tmp/gateway_down.log 2>&1
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
