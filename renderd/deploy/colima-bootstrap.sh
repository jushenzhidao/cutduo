#!/usr/bin/env bash
# 固化 Colima VM 的两处环境修复。可重复执行（幂等）。
#
# 背景：macOS Virtualization.Framework 下，VM 内 /etc/resolv.conf 是指向
# systemd-resolved 的断链（目标文件不存在），Go 解析器会退到 [::1]:53，
# 所有镜像拉取都失败；同时 registry-1.docker.io 在部分网络里被劫持到不可达地址。
# 这两处修在 VM 里，重建 VM 就会丢 —— 所以必须有脚本，不能只留在文档里。
set -euo pipefail

CPU=${COLIMA_CPU:-4}
MEM=${COLIMA_MEM:-8}
DISK=${COLIMA_DISK:-60}
# 宿主机网关 DNS：Colima 默认 bridge 的网关地址，按实际环境覆盖
HOST_DNS=${COLIMA_HOST_DNS:-192.168.112.1}

if ! command -v colima >/dev/null 2>&1; then
  echo "colima 未安装：brew install colima" >&2
  exit 1
fi

if ! colima status >/dev/null 2>&1; then
  echo "启动 Colima (${CPU}C/${MEM}G/${DISK}G)…"
  colima start --cpu "$CPU" --memory "$MEM" --disk "$DISK" \
    --vm-type vz --mount-type virtiofs --dns "$HOST_DNS" \
    --dns 223.5.5.5 --dns 1.1.1.1
fi

echo "修复 VM 内 /etc/resolv.conf …"
colima ssh -- sh -c '
  if [ -L /etc/resolv.conf ] || [ ! -s /etc/resolv.conf ]; then
    sudo rm -f /etc/resolv.conf
  fi
  printf "nameserver '"$HOST_DNS"'\nnameserver 223.5.5.5\nnameserver 1.1.1.1\n" \
    | sudo tee /etc/resolv.conf >/dev/null
'

echo "配置 Docker daemon（registry mirror + DNS）…"
colima ssh -- sh -c '
  sudo mkdir -p /etc/docker
  sudo tee /etc/docker/daemon.json >/dev/null <<JSON
{
  "exec-opts": ["native.cgroupdriver=cgroupfs"],
  "features": {"buildkit": true, "containerd-snapshotter": true},
  "dns": ["'"$HOST_DNS"'", "223.5.5.5"],
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://dockerproxy.net",
    "https://hub.rat.dev"
  ]
}
JSON
  sudo systemctl restart docker
'

echo "校验…"
for i in 1 2 3; do
  if colima ssh -- getent hosts registry-1.docker.io >/dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 3 ] && { echo "DNS 仍未恢复，请检查 HOST_DNS=$HOST_DNS" >&2; exit 1; }
  sleep 2
done
docker version --format 'server={{.Server.Version}} arch={{.Server.Arch}}'
docker pull --quiet python:3.12-slim >/dev/null && echo "镜像拉取 OK"
echo "Colima bootstrap 完成。注意：BuildKit 插件缺失时用传统 builder（DOCKER_BUILDKIT=0）。"
