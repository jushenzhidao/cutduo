#!/usr/bin/env bash
# renderd 一键安装（Linux 单机）
#
# 用法：
#   ./deploy/linux/install.sh                       # 用当前仓库代码，交互式
#   ./deploy/linux/install.sh --domain render.example.com --email ops@example.com --tls
#   ./deploy/linux/install.sh --yes                 # 非交互（CI / 云初始化脚本）
#
# 幂等：重复执行不会覆盖已生成的 .env（覆盖 = 轮换密钥 = 已发出的下载链接全失效）。
# 要重新生成密钥，先自己备份并删除 .env。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.prod.yml"
ENV_FILE="${SCRIPT_DIR}/.env"

DOMAIN=""
EMAIL=""
ENABLE_TLS=0
ASSUME_YES=0
PORT=""
BIND=""

# ── 输出 ───────────────────────────────────────────────
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_END=""
fi
log()  { printf '%s▸%s %s\n' "${C_DIM}" "${C_END}" "$*"; }
ok()   { printf '%s✓%s %s\n' "${C_OK}" "${C_END}" "$*"; }
warn() { printf '%s!%s %s\n' "${C_WARN}" "${C_END}" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "${C_ERR}" "${C_END}" "$*" >&2; exit 1; }

# ── 参数 ───────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; ENABLE_TLS=1; shift 2 ;;
    --email)  EMAIL="${2:-}"; shift 2 ;;
    --tls)    ENABLE_TLS=1; shift ;;
    --port)   PORT="${2:-}"; shift 2 ;;
    --bind)   BIND="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

# ── 环境检查 ───────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "需要 root（安装 docker、写 /opt 目录）。用 sudo 重跑。"

. /etc/os-release 2>/dev/null || die "读不到 /etc/os-release，无法判断发行版。"
OS_ID="${ID:-unknown}"
ARCH="$(uname -m)"
log "系统: ${PRETTY_NAME:-$OS_ID} / ${ARCH}"

case "$ARCH" in
  x86_64|amd64)  ARCH_OK=1 ;;
  aarch64|arm64) ARCH_OK=1 ;;
  *) ARCH_OK=0; warn "架构 ${ARCH} 未在 CI 里验证过，镜像可构建但 ffmpeg 性能未知。" ;;
esac

# 磁盘：镜像 ~1GB + 依赖，素材按业务量增长。低于 20GB 直接拦，别装到一半满盘。
FREE_GB=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)
if [ "${FREE_GB:-0}" -lt 20 ]; then
  warn "根分区可用 ${FREE_GB}GB，建议至少 20GB。数据目录可以用独立云盘挂到别处。"
  [ "$ASSUME_YES" -eq 1 ] || die "空间不足，终止。"
fi

# ── Docker ────────────────────────────────────────────
docker_ok() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }

install_docker() {
  log "未检测到 docker + compose 插件，开始安装"
  case "$OS_ID" in
    ubuntu|debian)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      # docker-compose-v2 是 compose 插件包；老发行版没有就退到官方脚本
      if ! apt-get install -y -qq docker.io docker-compose-v2 2>/dev/null; then
        warn "发行版源里没有 docker-compose-v2，改用官方脚本"
        curl -fsSL https://get.docker.com | sh
      fi
      ;;
    amzn|centos|rhel|rocky|almalinux|alinux|anolis|openEuler)
      if command -v dnf >/dev/null 2>&1; then PM=dnf; else PM=yum; fi
      # 阿里云/华为云等国产发行版通常自带 docker，先试系统源
      if ! $PM install -y docker docker-compose-plugin 2>/dev/null; then
        warn "系统源装不上，改用官方脚本（国内机器可能慢，建议先配镜像加速）"
        curl -fsSL https://get.docker.com | sh
      fi
      ;;
    *)
      warn "未适配的发行版 ${OS_ID}，尝试官方脚本"
      curl -fsSL https://get.docker.com | sh
      ;;
  esac

  systemctl enable --now docker 2>/dev/null || service docker start || true
  docker_ok || die "docker 安装后仍不可用。手动安装后重跑：https://docs.docker.com/engine/install/"
}
install_docker
ok "docker $(docker --version | awk '{print $3}' | tr -d ,) / $(docker compose version --short)"

# 国内镜像加速提示：不自动改 daemon.json（改坏了更难查），只提示
if ! grep -qs "registry-mirrors" /etc/docker/daemon.json 2>/dev/null; then
  warn "未配置镜像加速。国内机器拉镜像可能很慢，建议在 /etc/docker/daemon.json 加 registry-mirrors 后重启 docker。"
fi

# ── 代码 ───────────────────────────────────────────────
[ -f "${PROJECT_DIR}/Dockerfile" ] || die "找不到 ${PROJECT_DIR}/Dockerfile，安装脚本必须在仓库的 deploy/linux/ 下。"
log "代码目录: ${PROJECT_DIR}"

# ── .env ──────────────────────────────────────────────
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [ -f "$ENV_FILE" ]; then
  ok ".env 已存在，保留原密钥（不覆盖）"
  # 只补齐缺失的键，不动已有的值
  set -a; . "$ENV_FILE"; set +a
else
  log "生成 .env（令牌与密钥随机）"
  PG_PASS="$(rand_hex 24)"
  TOKEN="$(rand_hex 32)"
  SECRET="$(rand_hex 32)"
  ADMIN="$(rand_hex 32)"
  umask 077
  cat > "$ENV_FILE" <<EOF
# 由 install.sh 于 $(date -Iseconds) 生成。chmod 600，勿入版本库。
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_USER=renderd
POSTGRES_DB=renderd

RENDERD_TOKENS=${TOKEN}:acme
RENDERD_SECRET=${SECRET}
RENDERD_ADMIN_TOKENS=${ADMIN}

RENDERD_PORT=${PORT:-8787}
RENDERD_BIND=${BIND:-127.0.0.1}
RENDERD_IMAGE=renderd:0.1.0

RENDERD_QUOTA_QPS=10
RENDERD_MAX_QUEUE_DEPTH=2000
RENDERD_MAX_TENANT_INFLIGHT=8
RENDERD_STORAGE_QUOTA_MB=2048
RENDERD_MIN_FREE_GB=5

RENDERD_WORKER_CONCURRENCY=1
RENDERD_WORKER_TENANT=acme
RENDERD_WORKER_NAME=w1

API_CPUS=2.0
API_MEMORY=2g
WORKER_CPUS=4.0
WORKER_MEMORY=4g

RENDERD_ALLOW_PRIVATE_CALLBACKS=0
RENDERD_DOMAIN=${DOMAIN}
ACME_EMAIL=${EMAIL}
EOF
  umask 022
  chmod 600 "$ENV_FILE"
  ok ".env 已生成（600）"
fi

# 命令行参数覆盖 .env 里的空值
if [ -n "$DOMAIN" ]; then
  sed -i.bak "s|^RENDERD_DOMAIN=.*|RENDERD_DOMAIN=${DOMAIN}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
fi
if [ -n "$EMAIL" ]; then
  sed -i.bak "s|^ACME_EMAIL=.*|ACME_EMAIL=${EMAIL}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
fi

set -a; . "$ENV_FILE"; set +a

# ── 构建 ──────────────────────────────────────────────
log "构建镜像（首次约 3-5 分钟：ffmpeg + 中文字体）"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build api

# ── 启动 ──────────────────────────────────────────────
if [ "$ENABLE_TLS" -eq 1 ]; then
  [ -n "${RENDERD_DOMAIN:-}" ] || die "启用 TLS 必须给 --domain"
  log "启动完整栈（含 Caddy TLS，域名 ${RENDERD_DOMAIN}）"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile tls up -d
else
  log "启动（api + worker + pg，不启用反代）"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d
fi

# ── 等待就绪 ───────────────────────────────────────────
log "等待就绪（探 /readyz，最多 180s）"
READY=0
for i in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:${RENDERD_PORT:-8787}/readyz" >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 3
done

if [ "$READY" -ne 1 ]; then
  warn "180s 内未就绪。诊断："
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
  echo "--- api 最近日志 ---"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail 40 api || true
  echo "--- readyz 原始响应 ---"
  curl -sS -m 3 "http://127.0.0.1:${RENDERD_PORT:-8787}/readyz" || true
  die "启动失败，按上面日志排查（常见：磁盘不足、POSTGRES_PASSWORD 含特殊字符、端口被占）"
fi

ok "服务已就绪"

# ── 验收 ──────────────────────────────────────────────
BASE="http://127.0.0.1:${RENDERD_PORT:-8787}"
TOKEN_VAL="${RENDERD_TOKENS%%:*}"
if [ "$ENABLE_TLS" -eq 1 ]; then
  BASE="https://${RENDERD_DOMAIN}"
fi

cat <<EOF

${C_OK}安装完成${C_END}

  接口地址   ${BASE}
  健康检查   curl -s ${BASE}/healthz
  就绪检查   curl -s ${BASE}/readyz
  指标       curl -s http://127.0.0.1:${RENDERD_PORT:-8787}/metrics   （仅内网）

  租户令牌   ${TOKEN_VAL}
             ↑ 存在 ${ENV_FILE}，只显示这一次，请自行保存

  常用命令（在 ${PROJECT_DIR} 下）：
    docker compose -f deploy/linux/docker-compose.prod.yml ps
    docker compose -f deploy/linux/docker-compose.prod.yml logs -f api
    docker compose -f deploy/linux/docker-compose.prod.yml exec api \\
      python -m renderd --data-dir /data doctor

  备份：见 deploy/linux/backup.sh，建议加进 crontab：
    0 3 * * * /opt/renderd/deploy/linux/backup.sh >> /var/log/renderd-backup.log 2>&1

  提交第一个任务（需先上传素材，见 docs/API.md）：
    curl -s -X POST ${BASE}/v1/render \\
      -H "Authorization: Bearer ${TOKEN_VAL}" \\
      -H 'Content-Type: application/json' \\
      -d @sample-ir.json

EOF

if [ "$ENABLE_TLS" -ne 1 ]; then
  warn "当前只监听 127.0.0.1，公网访问不到。要对外提供服务，加 --domain 重跑（需要域名已解析到本机、80/443 放通）。"
fi
