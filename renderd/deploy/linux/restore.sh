#!/usr/bin/env bash
# renderd 恢复：把一份备份写回去。**会覆盖现有数据。**
#
#   ./deploy/linux/restore.sh /var/backups/renderd/20261109-030000 --yes
#
# 顺序是有讲究的：先停写、再验完整、再恢复数据库、最后恢复文件。
# 反过来的话，恢复文件时 worker 可能已经把新素材写进了同一个卷，
# 结果是「半新半旧」的目录，比完全没恢复更难查。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.prod.yml"
ENV_FILE="${RENDERD_ENV_FILE:-${SCRIPT_DIR}/.env}"

SRC="${1:-}"
CONFIRM="${2:-}"
[ -n "$SRC" ] || { echo "用法: $0 <备份目录> --yes" >&2; exit 1; }
[ -f "$SRC/renderd.dump" ] && [ -f "$SRC/data.tar.gz" ] || {
  echo "✗ ${SRC} 不是完整备份（缺 renderd.dump 或 data.tar.gz）" >&2; exit 1; }

if [ "$CONFIRM" != "--yes" ]; then
  echo "这会覆盖现有数据库与 /data 卷，不可撤销。确认请加 --yes。" >&2
  exit 1
fi

[ -f "$ENV_FILE" ] || { echo "缺少 ${ENV_FILE}" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$1"; else shasum -a 256 -c "$1"; fi
}

# 1. 校验归档哈希（有 SHA256SUMS 才验）
if [ -f "$SRC/SHA256SUMS" ]; then
  echo "▸ 校验归档"
  ( cd "$SRC" && sha256_check SHA256SUMS ) || { echo "✗ 归档损坏，中止" >&2; exit 1; }
else
  echo "! 备份里没有 SHA256SUMS，跳过完整性校验"
fi

# 2. 停写：只停 api 和 worker，PG 留着（恢复要连它）
#    -t 30 是兜底：api 已注册 SIGTERM 会秒退，但万一卡住不该让恢复干等 300s
echo "▸ 停止 api / worker"
dc stop -t 30 api worker || true

# 3. 恢复数据库
echo "▸ 恢复 PG"
dc exec -T pg psql -U "${POSTGRES_USER:-renderd}" -d "${POSTGRES_DB:-renderd}" \
  -c "DROP SCHEMA IF EXISTS ${RENDERD_PG_SCHEMA:-renderd} CASCADE;" >/dev/null
dc exec -T pg pg_restore -U "${POSTGRES_USER:-renderd}" -d "${POSTGRES_DB:-renderd}" \
  --no-owner --exit-on-error < "${SRC}/renderd.dump"

# 4. 恢复文件卷：先清空再解包，避免旧文件混在里面
echo "▸ 恢复 /data"
dc run --rm --no-deps -T --user root --entrypoint sh api -c \
  'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf - -C /data' < "${SRC}/data.tar.gz"

# 5. 起服并验证
echo "▸ 启动"
dc start api worker

echo "▸ 等待就绪"
for _ in $(seq 1 40); do
  if curl -fsS -m 2 "http://127.0.0.1:${RENDERD_PORT:-8787}/readyz" >/dev/null 2>&1; then
    echo "✓ 已就绪"
    dc exec -T api python -m renderd --data-dir /data queue || true
    exit 0
  fi
  sleep 3
done

echo "✗ 恢复后未能就绪，检查日志：" >&2
dc logs --tail 50 api >&2
exit 1
