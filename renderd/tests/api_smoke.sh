#!/usr/bin/env bash
# REST 冒烟：起服务 → 提交 → 轮询 → 取回执 → 下片 → 清理
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8791}
DATA=${DATA:-var/apitest}
TOKEN="devtoken"
BASE="http://127.0.0.1:${PORT}"
rm -rf "$DATA"

export RENDERD_TOKENS="${TOKEN}:acme"
export RENDERD_DATA_DIR="$DATA"

python3 - <<'PY'
import sys; sys.path.insert(0,'.')
from pathlib import Path
from renderd.config import load_config
from renderd.fixtures import ensure_media
cfg = load_config()
print("素材:", sorted(Path(p).name for p in ensure_media(cfg.media_dir).values()))
PY

python3 -m renderd --data-dir "$DATA" serve --port "$PORT" --workers 2 > /tmp/renderd_api.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 60); do
  curl -sf "$BASE/healthz" > /tmp/h.json 2>/dev/null && break
  sleep 0.3
done

H() { curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1 ($2)"; pass=$((pass+1)); else echo "  ✗ $1 期望 $3 实际 $2"; fail=$((fail+1)); fi; }

code() { echo "$1" | tail -1; }

echo "── health ──"
chk "healthz" "$(code "$(curl -s -o /dev/null -w '%{http_code}\n' "$BASE/healthz")")" "200"
echo "  $(cat /tmp/h.json)"

echo "── 鉴权 ──"
chk "无 token 401" "$(code "$(curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/templates")")" "401"
chk "错 token 401" "$(code "$(curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer nope' "$BASE/v1/templates")")" "401"

echo "── templates ──"
H "$BASE/v1/templates" -o /tmp/tpl.json
chk "templates 200" "$(code "$(curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$BASE/v1/templates")")" "200"
python3 -c "import json;d=json.load(open('/tmp/tpl.json'));print('  模板数:',d['count'] if 'count' in d else len(d['templates']))"

echo "── upload ──"
UP=$(curl -s -H "Authorization: Bearer $TOKEN" -H "X-Filename: a.mp4" \
     --data-binary "@$DATA/media/v_a.mp4" "$BASE/v1/assets")
echo "  $UP"
URI=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['uri'])" "$UP")
SHA=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['sha256'])" "$UP")

REQ=$(python3 - "$URI" <<'PY'
import json,sys
uri=sys.argv[1]
print(json.dumps({
  "template_id":"hook_vertical_6s",
  "variables":{"clip":"a1","hook":"第一性原理"},
  "assets":[{"id":"a1","uri":uri}],
  "idempotency_key":"api-smoke-0001"
}, ensure_ascii=False))
PY
)

echo "── validate ──"
H -X POST "$BASE/v1/validate" -d "$REQ" -o /tmp/val.json
python3 -c "
import json;d=json.load(open('/tmp/val.json'))
print('  valid:',d['valid'],'| checks:',{k:v['pass'] for k,v in d['checks'].items()})
print('  estimate:',d['estimate'])"

echo "── submit ──"
H -X POST "$BASE/v1/render" -d "$REQ" -o /tmp/sub.json -w '%{http_code}\n' > /tmp/sub.code
chk "submit 202" "$(cat /tmp/sub.code)" "202"
cat /tmp/sub.json | python3 -c "import json,sys;d=json.load(sys.stdin);print('  job:',d['job_id'],'replay:',d['idempotent_replay'])"
JOB=$(python3 -c "import json;print(json.load(open('/tmp/sub.json'))['job_id'])")

echo "── 幂等重放 ──"
H -X POST "$BASE/v1/render" -d "$REQ" -o /tmp/sub2.json
python3 -c "import json;d=json.load(open('/tmp/sub2.json'));print('  same job:',d['job_id']=='$JOB','replay:',d['idempotent_replay'])"

echo "── 轮询 ──"
for i in $(seq 1 120); do
  H "$BASE/v1/jobs/$JOB" -o /tmp/job.json
  ST=$(python3 -c "import json;print(json.load(open('/tmp/job.json'))['status'])")
  [ "$ST" = "succeeded" ] && break
  [ "$ST" = "failed" ] && break
  sleep 0.5
done
python3 -c "
import json;d=json.load(open('/tmp/job.json'))
print('  status:',d['status'],'stage:',d['stage'],'cache:',d.get('cache_hit'),'cost:',d.get('cost_seconds'))
print('  error:',d.get('error'))"
chk "job succeeded" "$ST" "succeeded"

echo "── receipt ──"
H "$BASE/v1/jobs/$JOB/receipt" -o /tmp/rec.json -w '%{http_code}\n' > /tmp/rec.code
chk "receipt 200" "$(cat /tmp/rec.code)" "200"
python3 -c "
import json;d=json.load(open('/tmp/rec.json'))
print('  verdict:',d['verdict'],'failures:',d['failures'])
print('  L1:',{k:v['pass'] for k,v in d['L1']['assertions'].items()})
print('  L3 loudness:',d['L3']['loudness'].get('integrated_lufs'),'ok:',d['L3']['loudness'].get('ok'))
print('  evidence:',list(d['evidence'])[:5])"

echo "── 下载（签名 URL，不带 header）──"
VURL=$(python3 -c "import json;print(json.load(open('/tmp/job.json'))['video_url'])")
SZ=$(curl -s -o /tmp/dl.mp4 -w '%{size_download} %{http_code}' "$BASE$VURL")
chk "video 200" "$(echo $SZ | awk '{print $2}')" "200"
echo "  下载字节: $(echo $SZ | awk '{print $1}')"
ffprobe -v error -select_streams v -show_entries stream=width,height,nb_frames -of csv=p=0 /tmp/dl.mp4 | sed 's/^/  成片: /'

echo "── 篡改签名应拒绝 ──"
chk "bad signature 401" "$(code "$(curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/jobs/$JOB/video?exp=9999999999&sig=deadbeef")")" "401"

echo "── usage / metrics ──"
H "$BASE/v1/usage" -o /tmp/u.json
cat /tmp/u.json | python3 -c "import json,sys;d=json.load(sys.stdin);print('  usage:',d['rendered_minutes'],'min /',d['monthly_quota_minutes'],'min')"
curl -s "$BASE/metrics" | head -4 | sed 's/^/  /'

echo "── 负向：字体缺失（拉丁字体渲中文，直传 IR）──"
python3 tests/gen_bad_ir.py "$URI" > /tmp/bad_req.json
H -X POST "$BASE/v1/render" -d @/tmp/bad_req.json -o /tmp/bad.json -w '%{http_code}\n' > /tmp/bad.code
chk "字体缺失 422" "$(cat /tmp/bad.code)" "422"
chk "错误码 = E_FONT_MISSING" "$(python3 -c "import json;print(json.load(open('/tmp/bad.json'))['error']['code'])")" "E_FONT_MISSING"
python3 -c "
import json;d=json.load(open('/tmp/bad.json'))['error']
print('  field:',d.get('field'),'| retryable:',d['retryable'],'| allowed:',d.get('allowed_values'))
print('  message:',d['message'][:64])"

echo
echo "通过 $pass / 失败 $fail"
tail -3 /tmp/renderd_api.log
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
