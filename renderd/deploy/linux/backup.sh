#!/usr/bin/env bash
# renderd 备份：PG 逻辑备份 + /data 素材成片打包
#
#   ./deploy/linux/backup.sh                    # 默认存 /var/backups/renderd，保留 14 天
#   BACKUP_DIR=/mnt/backup KEEP_DAYS=30 ./deploy/linux/backup.sh
#
# 为什么要两份：
#   · PG dump 是「谁提交了什么、跑到哪一步」——任务状态与配额账本，丢了无法对账
#   · /data 是「素材与成片」——丢了任务记录还在但产物没了，回执里的哈希全部失配
# 只备份其一的方案在真实恢复时都会缺一半。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.prod.yml"
ENV_FILE="${RENDERD_ENV_FILE:-${SCRIPT_DIR}/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/renderd}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR}/${STAMP}"

[ -f "$ENV_FILE" ] || { echo "缺少 ${ENV_FILE}" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# 校验和工具的差异会让「备份完好」变成「备份脚本在开发机上根本跑不起来」。
sha256_gen() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

mkdir -p "$DEST"
chmod 700 "$BACKUP_DIR"

echo "▸ 备份到 ${DEST}"

# 1. 数据库
echo "▸ pg_dump"
if ! dc exec -T pg pg_dump -U "${POSTGRES_USER:-renderd}" -d "${POSTGRES_DB:-renderd}" \
      -Fc --no-owner > "${DEST}/renderd.dump"; then
  echo "✗ pg_dump 失败，终止（不产出半份备份）" >&2
  rm -rf "$DEST"; exit 1
fi

# 2. 数据卷（排除 tmp：临时渲染中间件，恢复没有意义）
echo "▸ 打包 /data"
dc exec -T api tar czf - --exclude=./tmp -C /data . > "${DEST}/data.tar.gz"

# 3. 清单：备份也要能被验证，否则恢复时才发现文件是空的
{
  echo "stamp=${STAMP}"
  echo "created_at=$(date -Iseconds)"
  echo "host=$(hostname)"
  echo "image=${RENDERD_IMAGE:-unknown}"
  echo "--- sizes ---"
  ls -l "${DEST}" | sed 's/  */ /g'
  echo "--- jobs ---"
  dc exec -T api python -m renderd --data-dir /data queue 2>/dev/null || echo "queue 查询失败"
} > "${DEST}/MANIFEST.txt"

sha256_gen "${DEST}/renderd.dump" "${DEST}/data.tar.gz" > "${DEST}/SHA256SUMS"

# 4. 校验：刚写完就读一遍，避免「备份成功但档案是空的」
( cd "$DEST" && sha256_gen -c SHA256SUMS --quiet ) || {
  echo "✗ 备份校验失败" >&2; exit 1; }

SIZE=$(du -sh "$DEST" | cut -f1)
echo "✓ 完成 ${DEST}（${SIZE}）"

# 5. 保留策略
echo "▸ 清理 ${KEEP_DAYS} 天前的备份"
find "$BACKUP_DIR" -maxdepth 1 -type d -name '20*' -mtime "+${KEEP_DAYS}" -print -exec rm -rf {} + 2>/dev/null || true

echo "✓ 备份结束"
