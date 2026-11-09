#!/usr/bin/env bash
# 容器内端到端：上传 → 预检 → 提交 → 轮询 → 回执 → 下载 → 校验
# 用法：./tests/container_e2e.sh [BASE] [TOKEN]
set -uo pipefail
cd "$(dirname "$0")/.."

BASE=${1:-http://127.0.0.1:8788}
TOKEN=${2:-tokA-00000001}
H() { curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1 ($2)"; pass=$((pass+1)); else echo "  ✗ $1 期望 $3 实际 $2"; fail=$((fail+1)); fi; }

echo "── 等待就绪 ──"
for i in $(seq 1 60); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
HEALTH=$(curl -s "$BASE/healthz")
echo "  $HEALTH"
ENGINE=$(echo "$HEALTH" | python3 -c "import json,sys;print(json.load(sys.stdin)['engine'])")
FONTS=$(echo "$HEALTH" | python3 -c "import json,sys;print(json.load(sys.stdin)['fonts_available'])")
echo "  引擎: $ENGINE / 字体族: $FONTS"

echo "── 准备素材（宿主机生成，上传进容器）──"
[ -f /tmp/_e2e_clip.mp4 ] || ffmpeg -y -v error -f lavfi -i "testsrc2=s=1080x1920:r=30:d=12" \
  -f lavfi -i "sine=f=440:r=48000:d=12" -map 0:v -map 1:a \
  -c:v libx264 -preset ultrafast -crf 22 -pix_fmt yuv420p \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -x264-params "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv" \
  -c:a aac -ar 48000 -ac 2 -shortest /tmp/_e2e_clip.mp4
[ -f /tmp/_e2e_music.m4a ] || ffmpeg -y -v error -f lavfi -i "sine=f=330:r=48000:d=24" \
  -c:a aac -b:a 160k /tmp/_e2e_music.m4a

UP=$(H -X POST "$BASE/v1/assets" -H "X-Filename: clip.mp4" --data-binary @/tmp/_e2e_clip.mp4)
URI=$(echo "$UP" | python3 -c "import json,sys;print(json.load(sys.stdin)['uri'])")
SHA=$(echo "$UP" | python3 -c "import json,sys;print(json.load(sys.stdin)['sha256'])")
chk "上传素材" "$(echo "$UP" | python3 -c "import json,sys;print(bool(json.load(sys.stdin)['sha256']))")" "True"

UPM=$(H -X POST "$BASE/v1/assets" -H "X-Filename: music.m4a" --data-binary @/tmp/_e2e_music.m4a)
URIM=$(echo "$UPM" | python3 -c "import json,sys;print(json.load(sys.stdin)['uri'])")

echo "── 预检（含模板变量）──"
REQ=$(python3 -c "
import json,sys
print(json.dumps({'template_id':'brand_vertical_15s',
 'variables':{'clip1':'a1','clip2':'a2','clip3':'a3','title':'容器端到端','music':'m1'},
 'assets':[{'id':'a1','uri':'$URI'},{'id':'a2','uri':'$URI'},
           {'id':'a3','uri':'$URI'},{'id':'m1','uri':'$URIM'}]}, ensure_ascii=False))")
H -X POST "$BASE/v1/validate" -d "$REQ" -o /tmp/ce2e_val.json
python3 -c "
import json;d=json.load(open('/tmp/ce2e_val.json'))
print('  valid:',d['valid'])
for k,v in d['checks'].items(): print(f'    {k}: {v[\"pass\"]}')
print('  fixes:',[f.get('reason','')[:60] for f in d.get('fixes',[])][:3])
print('  estimate:',d.get('estimate'))"
chk "预检有效" "$(python3 -c "import json;print(json.load(open('/tmp/ce2e_val.json'))['valid'])")" "True"

echo "── 提交三条（三个模板）──"
declare -a JOBS=()
submit() {
  local tpl=$1; local vars=$2; local assets=$3; local key=$4
  local body=$(python3 -c "
import json
print(json.dumps({'template_id':'$tpl','variables':json.loads('''$vars'''),
 'assets':json.loads('''$assets'''),'idempotency_key':'$key'}, ensure_ascii=False))")
  local out=$(H -X POST "$BASE/v1/render" -d "$body")
  echo "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('job_id',''))"
}
STAMP=$(date +%s)
J1=$(submit "hook_vertical_6s" "{\"clip\":\"a1\",\"hook\":\"容器验证\"}" "[{\"id\":\"a1\",\"uri\":\"$URI\"}]" "c1-$STAMP")
J2=$(submit "caption_square_9s" "{\"clip\":\"a1\",\"caption\":\"方形字幕条在容器里也要对\"}" "[{\"id\":\"a1\",\"uri\":\"$URI\"}]" "c2-$STAMP")
J3=$(submit "brand_vertical_15s" "{\"clip1\":\"a1\",\"clip2\":\"a2\",\"clip3\":\"a3\",\"title\":\"三段拼接\",\"music\":\"m1\"}" "[{\"id\":\"a1\",\"uri\":\"$URI\"},{\"id\":\"a2\",\"uri\":\"$URI\"},{\"id\":\"a3\",\"uri\":\"$URI\"},{\"id\":\"m1\",\"uri\":\"$URIM\"}]" "c3-$STAMP")
echo "  jobs: $J1 $J2 $J3"
for j in $J1 $J2 $J3; do [ -n "$j" ] && JOBS+=("$j"); done
chk "三条都已受理" "${#JOBS[@]}" "3"

echo "── 轮询 ──"
T0=$(date +%s)
for i in $(seq 1 200); do
  all_done=1
  for j in "${JOBS[@]}"; do
    ST=$(H "$BASE/v1/jobs/$j" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
    case "$ST" in succeeded|failed) ;; *) all_done=0 ;; esac
  done
  [ $all_done -eq 1 ] && break
  sleep 0.5
done
ELAPSED=$(( $(date +%s) - T0 ))
echo "  耗时 ${ELAPSED}s"
ok=0
for j in "${JOBS[@]}"; do
  H "$BASE/v1/jobs/$j" -o /tmp/ce2e_job.json
  python3 -c "
import json;d=json.load(open('/tmp/ce2e_job.json'))
print(f\"    {d['job_id']} {d['status']:9} stage={d['stage']:10} cost={d.get('cost_seconds')}s err={(d.get('error') or {}).get('code')}\")"
  [ "$(python3 -c "import json;print(json.load(open('/tmp/ce2e_job.json'))['status'])")" = "succeeded" ] && ok=$((ok+1))
done
chk "三条全部成功" "$ok" "3"

echo "── 回执（容器内的字体回退是否留痕）──"
H "$BASE/v1/jobs/$J1/receipt" -o /tmp/ce2e_rec.json
python3 -c "
import json;d=json.load(open('/tmp/ce2e_rec.json'))
print('  verdict:',d['verdict'],'failures:',d['failures'])
print('  warnings:',d.get('warnings'))
print('  L3 font:',d['L3']['font_coverage'])
print('  L3 loudness:',d['L3']['loudness'].get('integrated_lufs'),'applicable:',d['L3']['loudness'].get('applicable'))
print('  L1 frames:',d['L1']['structural']['frames'],'size:',d['L1']['structural']['size_bytes'])"
chk "回执通过" "$(python3 -c "import json;print(json.load(open('/tmp/ce2e_rec.json'))['verdict'])")" "pass"
chk "字体回退被记录" "$(python3 -c "
import json;d=json.load(open('/tmp/ce2e_rec.json'))
print(any('回退' in w for w in d.get('warnings',[])))")" "True"

echo "── 下载并校验成片 ──"
VURL=$(H "$BASE/v1/jobs/$J3" | python3 -c "import json,sys;print(json.load(sys.stdin)['video_url'])")
SZ=$(curl -s -o /tmp/ce2e_out.mp4 -w '%{size_download} %{http_code}' "$BASE$VURL")
chk "下载 200" "$(echo $SZ | awk '{print $2}')" "200"
echo "  下载 $(echo $SZ | awk '{print $1}') 字节"
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,nb_frames,r_frame_rate -of default=nw=1 /tmp/ce2e_out.mp4 | sed 's/^/  /'
chk "成片时长 15s" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/ce2e_out.mp4 | cut -d. -f1)" "15"

echo "── 幂等重放 ──"
BODY=$(python3 -c "
import json
print(json.dumps({'template_id':'hook_vertical_6s','variables':{'clip':'a1','hook':'容器验证'},
 'assets':[{'id':'a1','uri':'$URI'}],'idempotency_key':'c1-$STAMP'}, ensure_ascii=False))")
R=$(H -X POST "$BASE/v1/render" -d "$BODY")
chk "重放返回同一 job" "$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['job_id'])")" "$J1"
chk "标记 replay" "$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['idempotent_replay'])")" "True"

echo
echo "通过 $pass / 失败 $fail"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
