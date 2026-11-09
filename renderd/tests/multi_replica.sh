#!/usr/bin/env bash
# 三副本 API 共享一个 PG：验证限流与存储在**容器级**也是同一份预算。
# 这是 §6.1 的现场复现：修复前 3 副本 → 3×QPS、配额写成 1.34MB。
#
# 用法：./tests/multi_replica.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

IMG=${IMG:-renderd:0.1.0}
NET=renderd-mr
TOK="tokA-00000001"
SECRET="mr-secret-$(date +%s)"
PORTS=(8791 8792 8793)

cleanup() {
  for i in 1 2 3; do docker rm -f "mr-api-$i" >/dev/null 2>&1; done
  docker rm -f mr-pg >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
}
trap cleanup EXIT

docker network rm "$NET" >/dev/null 2>&1
docker network create "$NET" >/dev/null || exit 1

echo "── 起 PG ──"
docker run -d --name mr-pg --network "$NET" \
  -e POSTGRES_USER=renderd -e POSTGRES_PASSWORD=renderd_local \
  -e POSTGRES_DB=renderd postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec mr-pg pg_isready -U renderd -d renderd >/dev/null 2>&1 && break
  sleep 0.5
done

echo "── 起 3 个 API 副本（同一 DSN / 同一 schema）──"
for i in 1 2 3; do
  docker run -d --name "mr-api-$i" --network "$NET" -p "${PORTS[$((i-1))]}:8787" \
    -e RENDERD_DB_DSN="postgresql://renderd:renderd_local@mr-pg:5432/renderd" \
    -e RENDERD_PG_SCHEMA=renderd \
    -e RENDERD_TOKENS="$TOK:acme" \
    -e RENDERD_SECRET="$SECRET" \
    -e RENDERD_REAPER=0 \
    "$IMG" >/dev/null
done
for p in "${PORTS[@]}"; do
  for _ in $(seq 1 80); do
    curl -sf "http://127.0.0.1:$p/healthz" >/dev/null 2>&1 && break
    sleep 0.25
  done
done

docker exec mr-api-1 python -m renderd tenant --name acme --qps 5 \
  --storage-mb 1 >/dev/null || exit 1
echo "tenant acme: qps=5 storage=1MB"

echo "── 1) 限流：3 副本共用一个 5 QPS 预算 ──"
ok=0; limited=0
end=$(( $(date +%s) + 1 ))
n=0
while [ "$(date +%s)" -lt "$end" ]; do
  p=${PORTS[$((n % 3))]}; n=$((n+1))
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" \
         "http://127.0.0.1:$p/v1/templates")
  if [ "$code" = "200" ]; then ok=$((ok+1)); else limited=$((limited+1)); fi
done
echo "  1 秒内：放行 ${ok} / 拒绝 ${limited}（期望 ≤ 6）"

sleep 2   # 让上一个 1 秒窗口彻底过去，否则测到的是限流不是配额
echo "── 2) 配额：3 副本并发上传，1MB 配额不能被写成 1.34MB ──"
for i in 1 2 3; do
  head -c 700000 /dev/urandom > "/tmp/mr_$i.bin"
  curl -s -o "/tmp/mr_r$i.json" -X POST \
    -H "Authorization: Bearer $TOK" -H "X-Filename: r$i.mp4" \
    --data-binary "@/tmp/mr_$i.bin" \
    "http://127.0.0.1:${PORTS[$((i-1))]}/v1/assets" &
done
wait
creates=0
for i in 1 2 3; do
  if grep -q '"sha256"' "/tmp/mr_r$i.json"; then creates=$((creates+1)); fi
done
used=$(curl -s -H "Authorization: Bearer $TOK" \
  "http://127.0.0.1:8791/v1/usage" | python3 -c "import json,sys;print(json.load(sys.stdin)['storage_used_bytes'])")
echo "  成功上传 ${creates} / 3，记账 ${used} 字节（配额 1048576）"

pass=0; fail=0
[ "$ok" -le 6 ] && { echo "  ✓ 限流未被副本放大"; pass=$((pass+1)); } || { echo "  ✗ 限流被放大 $ok 倍"; fail=$((fail+1)); }
[ "$creates" -eq 1 ] && { echo "  ✓ 并发上传只有一个成功"; pass=$((pass+1)); } || { echo "  ✗ $creates 个上传都成功"; fail=$((fail+1)); }
[ "$used" -le 1048576 ] && { echo "  ✓ 记账未超配额"; pass=$((pass+1)); } || { echo "  ✗ 记账 $used > 1MB"; fail=$((fail+1)); }
echo
echo "通过 $pass / 失败 $fail"
[ "$fail" -eq 0 ]
