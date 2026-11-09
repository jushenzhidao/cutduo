#!/usr/bin/env bash
# 验证服务内置 TLS 终止 + /metrics 来源白名单。
# Caddy 反向代理链路另见 docker-compose.tls.yml + make test-gateway。
set -uo pipefail
cd "$(dirname "$0")/.."
CERT=deploy/certs/cert.pem
KEY=deploy/certs/key.pem
[ -f "$CERT" ] || ./deploy/make-dev-cert.sh >/dev/null

PORT=${1:-8797}
DATA=var/tlstest
rm -rf "$DATA"
LOG=/tmp/renderd_tls.log
RENDERD_TLS_CERT="$CERT" RENDERD_TLS_KEY="$KEY" \
RENDERD_TOKENS="tok:acme" RENDERD_SECRET="tlssecret" \
RENDERD_METRICS_CIDRS="127.0.0.1/32,::1/128" \
  python3 -m renderd --data-dir "$DATA" serve --port "$PORT" --workers 0 >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null' EXIT

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS $1 ($2)"; pass=$((pass+1));
        else echo "  FAIL $1: got=$2 want=$3"; fail=$((fail+1)); fi; }

for i in $(seq 1 30); do
  curl -sk --max-time 2 "https://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.4
done

code=$(curl -sk -o /tmp/tls_health.json -w '%{http_code}' "https://127.0.0.1:$PORT/healthz")
chk "HTTPS healthz 200" "$code" "200"
chk "healthz 返回 ok" "$(python3 -c "import json;print(json.load(open('/tmp/tls_health.json'))['ok'])" 2>/dev/null)" "True"

# 明文 HTTP 打到 TLS 端口必须拿不到正常 JSON
plain=$(curl -s --max-time 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | head -c 20)
if echo "$plain" | grep -q '"ok"'; then r=no; else r=yes; fi
chk "明文 HTTP 被拒" "$r" "yes"

mcode=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/metrics")
chk "loopback 可取 metrics" "$mcode" "200"

# 白名单收紧到不含 loopback，必须 403
kill $PID 2>/dev/null; wait $PID 2>/dev/null
RENDERD_TLS_CERT="$CERT" RENDERD_TLS_KEY="$KEY" \
RENDERD_TOKENS="tok:acme" RENDERD_SECRET="tlssecret" \
RENDERD_METRICS_CIDRS="10.0.0.0/8" \
  python3 -m renderd --data-dir "$DATA" serve --port "$PORT" --workers 0 >"$LOG" 2>&1 &
PID=$!
for i in $(seq 1 30); do
  curl -sk --max-time 2 "https://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.4
done
mcode=$(curl -sk -o /tmp/tls_metrics.json -w '%{http_code}' "https://127.0.0.1:$PORT/metrics")
chk "非白名单来源 metrics 403" "$mcode" "403"
chk "错误契约 code" "$(python3 -c "import json;print(json.load(open('/tmp/tls_metrics.json'))['error']['code'])" 2>/dev/null)" "E_METRICS_FORBIDDEN"

echo "TLS 冒烟：通过 $pass / 失败 $fail"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
