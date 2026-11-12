#!/usr/bin/env bash
# MCP over Streamable HTTP 冒烟：协议协商 / 工具调用 / 通知 202 / 批量 / 错误语义 / 租户来源
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8793}
DATA=${DATA:-var/mcptest}
TOKEN="mcp-token"
BASE="http://127.0.0.1:${PORT}"
rm -rf "$DATA"

export RENDERD_TOKENS="${TOKEN}:acme"
export RENDERD_DATA_DIR="$DATA"
# 故意设一个「冒名」环境变量：HTTP 传输必须无视它，租户只能来自 token
export RENDERD_MCP_TENANT="evil"

python3 -m renderd --data-dir "$DATA" serve --port "$PORT" --workers 0 > /tmp/renderd_mcp_http.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 60); do
  curl -sf "$BASE/healthz" > /dev/null 2>&1 && break
  sleep 0.3
done

pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1 ($2)"; pass=$((pass+1)); else echo "  ✗ $1 期望 $3 实际 $2"; fail=$((fail+1)); fi; }
MCP() { curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" \
          -H 'Content-Type: application/json' -H 'Accept: application/json' "$@"; }
SSE() { curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" \
          -H 'Content-Type: application/json' -H 'Accept: text/event-stream' "$@"; }
J() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

echo "── 协议协商 ──"
R=$(MCP -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
chk "initialize 回 2025-03-26" "$(echo "$R" | J 'd["result"]["protocolVersion"]')" "2025-03-26"
chk "serverInfo.name" "$(echo "$R" | J 'd["result"]["serverInfo"]["name"]')" "renderd"

R=$(MCP -d '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}')
chk "不支持的高版本回落到最高可实现" "$(echo "$R" | J 'd["result"]["protocolVersion"]')" "2025-06-18"

R=$(MCP -d '{"jsonrpc":"2.0","id":22,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}')
chk "2025-11-25（tasks 版）降级到 2025-06-18" "$(echo "$R" | J 'd["result"]["protocolVersion"]')" "2025-06-18"

R=$(MCP -d '{"jsonrpc":"2.0","id":23,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}')
chk "老版本按原样接受" "$(echo "$R" | J 'd["result"]["protocolVersion"]')" "2024-11-05"

echo "── 工具 ──"
R=$(MCP -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}')
chk "工具数" "$(echo "$R" | J 'len(d["result"]["tools"])')" "5"
chk "含 submit_render" "$(echo "$R" | J '"submit_render" in [t["name"] for t in d["result"]["tools"]]')" "True"

R=$(MCP -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_templates","arguments":{}}}')
chk "list_templates isError" "$(echo "$R" | J 'd["result"]["isError"]')" "False"

R=$(MCP -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope","arguments":{}}}')
chk "未知工具报错" "$(echo "$R" | J 'd["result"]["isError"]')" "True"

echo "── 通知 / 批量 / 错误 ──"
code=$(curl -s -o /tmp/n.json -w '%{http_code}' -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')
chk "纯通知回 202" "$code" "202"
chk "202 无响应体" "$(wc -c < /tmp/n.json | tr -d ' ')" "0"

R=$(MCP -d '[{"jsonrpc":"2.0","id":6,"method":"ping"},{"jsonrpc":"2.0","id":7,"method":"tools/list"}]')
chk "批量回数组" "$(echo "$R" | J 'isinstance(d,list) and len(d)')" "2"

code=$(curl -s -o /tmp/b.json -w '%{http_code}' -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{oops')
chk "坏 JSON 回 400" "$code" "400"
chk "坏 JSON 是 -32700" "$(python3 -c "import json;print(json.load(open('/tmp/b.json'))['error']['code'])")" "-32700"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":8,"method":"ping"}')
chk "无 token 回 401" "$code" "401"

code=$(curl -s -o /tmp/g.json -w '%{http_code}' "$BASE/mcp" -H "Authorization: Bearer $TOKEN")
chk "GET /mcp 回 405" "$code" "405"
chk "405 带 Allow: POST" "$(curl -s -D- -o /dev/null "$BASE/mcp" -H "Authorization: Bearer $TOKEN" | grep -ci '^allow: *POST')" "1"

echo "── SSE 流式响应（Accept: text/event-stream）──"
hdr=$(curl -s -D- -o /tmp/sse1.txt -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":31,"method":"tools/list"}')
chk "Content-Type 是 text/event-stream" "$(echo "$hdr" | grep -ci 'content-type: text/event-stream')" "1"
chk "分帧用 event: message" "$(grep -c '^event: message$' /tmp/sse1.txt)" "1"
chk "帧内 data 是单行 JSON 且 id 正确" "$(python3 -c "
import json
for l in open('/tmp/sse1.txt'):
    if l.startswith('data: '):
        d = json.loads(l[6:]); print(d['id'], len(d['result']['tools']))
")" "31 5"

SSE -d '[{"jsonrpc":"2.0","id":32,"method":"ping"},{"jsonrpc":"2.0","id":33,"method":"ping"}]' > /tmp/sse2.txt
chk "批量在 SSE 下变两帧" "$(grep -c '^event: message$' /tmp/sse2.txt)" "2"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')
chk "SSE 模式下纯通知仍是 202" "$code" "202"

echo "── 租户来源（环境变量不得生效）──"
python3 - <<'PY'
import os, sys
sys.path.insert(0, '.')
os.environ['RENDERD_MCP_TENANT'] = 'evil'
from renderd.config import load_config
from renderd.service import Service
from renderd.mcp_stdio import MCPServer
svc = Service(load_config())
http_srv = MCPServer(svc, 'acme', from_env=False)
stdio_srv = MCPServer(svc, 'acme')
print(f"HTTP 传输租户={http_srv.tenant} (应为 acme)")
print(f"stdio 传输租户={stdio_srv.tenant} (应为 evil，这是设计意图)")
ok = http_srv.tenant == 'acme' and stdio_srv.tenant == 'evil'
sys.exit(0 if ok else 1)
PY
chk "HTTP 忽略 RENDERD_MCP_TENANT" "$?" "0"

echo
echo "通过 $pass 项，失败 $fail 项"
[ "$fail" -eq 0 ] || { echo "--- 服务日志尾部 ---"; tail -20 /tmp/renderd_mcp_http.log; exit 1; }
