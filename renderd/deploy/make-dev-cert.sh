#!/usr/bin/env bash
# 生成自签证书，仅供本地/容器验证 TLS 终止与 WAF 规则使用。
# 生产必须用 ACME 或企业 CA 签发的证书，不要用这个。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 644 "$DIR/cert.pem" "$DIR/key.pem"
echo "$DIR/cert.pem"
