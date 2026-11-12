# 云端 MCP 部署（cut-mcp.1task.cn）

> 这份文档是给**执行部署的人**看的。服务本体在 `mcp/server.mjs`，契约在 `docs/API.md`。
> 本次没有自动部署：本机没有 ai-prod 的 SSH 密钥，且本机 Docker 的镜像代理不可达。

## 为什么在服务器上构建

| 事实 | 后果 |
|---|---|
| 本机 arm64，ai-prod x86_64 | `@napi-rs/canvas` 是原生模块，跨架构必须 buildx + QEMU |
| 本机 `docker buildx` 不存在，`docker.m.daocloud.io` 代理拒绝连接 | 本地连基础镜像都拉不下来 |

所以：**把源码送到服务器，`docker compose build`**。服务器原生 x86_64，不需要模拟。

## 一、前置检查

```bash
ssh root@210.121.44.245
docker --version && docker compose version
ss -lntp | grep 8787 || echo "8787 空闲"
df -h /opt | tail -1        # 镜像约 600MB，数据卷按需
```

## 二、送代码

只需要这些目录（其余在 `.dockerignore` 里排除）：

```bash
# 本地
tar czf /tmp/cutduo-mcp.tgz \
  --exclude='node_modules' --exclude='refs' --exclude='out' --exclude='data' \
  api mcp src kits content assets package.json package-lock.json .dockerignore
scp /tmp/cutduo-mcp.tgz root@210.121.44.245:/opt/cutduo/src.tgz

# 服务器
mkdir -p /opt/cutduo/{src,data} && cd /opt/cutduo/src && tar xzf ../src.tgz
chown -R 1000:1000 /opt/cutduo/data
```

## 三、构建与启动

```bash
cd /opt/cutduo/src

# token 只生成一次，落盘保存；丢了只能改了重发
export CUTDUO_TOKEN=$(openssl rand -hex 24)
echo "CUTDUO_TOKEN=$CUTDUO_TOKEN" > /opt/cutduo/.env
chmod 600 /opt/cutduo/.env

cp deploy/docker-compose.yml .
docker compose --env-file /opt/cutduo/.env build
docker compose --env-file /opt/cutduo/.env up -d
docker compose logs -f --tail 20
```

启动日志应包含：

```
cutduo mcp 2.0.0  http://0.0.0.0:8787
  repo   /app
  data   /data
  public https://cut-mcp.1task.cn
  auth   Bearer token 已启用
  limits 3 并发 / 单次等待 90s / 上传上限 64MB
```

## 四、nginx 与证书

```bash
cp deploy/nginx-cut-mcp.conf /www/server/panel/vhost/nginx/cut-mcp.1task.cn.conf
mkdir -p /www/wwwroot/cut-mcp
acme.sh --issue -d cut-mcp.1task.cn --webroot /www/wwwroot/cut-mcp
acme.sh --install-cert -d cut-mcp.1task.cn \
  --fullchain-file /www/server/panel/vhost/cert/cut-mcp.1task.cn/fullchain.pem \
  --key-file       /www/server/panel/vhost/cert/cut-mcp.1task.cn/privkey.pem \
  --reloadcmd      "/www/server/nginx/sbin/nginx -s reload"
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

DNS 要先有 A 记录指向 `210.121.44.245`，否则签发会失败。

## 五、验证清单

按顺序跑，每步都要过：

```bash
TOKEN=$(grep -o '[a-f0-9]\{48\}' /opt/cutduo/.env)

# 1. 健康检查（不需要 token）
curl -s https://cut-mcp.1task.cn/health

# 2. 未授权应 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://cut-mcp.1task.cn/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'

# 3. 握手
curl -s -X POST https://cut-mcp.1task.cn/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

# 4. 工具清单应为 7 个
curl -s -X POST https://cut-mcp.1task.cn/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"cutduo_[a-z_]*"' | sort -u

# 5. 上传 + 出片（端到端）
curl -s -X POST "https://cut-mcp.1task.cn/assets?name=a.m4a" \
  -H "Authorization: Bearer $TOKEN" --data-binary @assets/audio/audio-v8t.m4a
# 把返回的 assetId 填进下面
curl -s -X POST https://cut-mcp.1task.cn/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"cutduo_render","arguments":{"kit":"paper","preset":"v8t","audio":"a-xxx"}}}'
# 回执里的 downloadUrl 应能直接下到 mp4
```

## 六、客户端注册

WorkBuddy 的 `~/.workbuddy/mcp.json`：

```json
{
  "mcpServers": {
    "cutduo": {
      "url": "https://cut-mcp.1task.cn/mcp",
      "headers": { "Authorization": "Bearer <你的 CUTDUO_TOKEN>" }
    }
  }
}
```

注册后需要在连接器管理页面点一次「信任」。若客户端不支持自定义 header，
把 token 走 nginx 的 `map` 注入（不推荐，token 会进配置文件）。

## 七、运维

| 事项 | 做法 |
|---|---|
| 日志 | `docker compose logs -f`；容器内已限 20MB × 3 |
| 磁盘 | `/opt/cutduo/data` 下 assets 与 out 按 `CUTDUO_ASSET_TTL_DAYS`（7 天）自动清理 |
| 并发 | 默认 3（每个 job 8 worker）。64 核可试 `CUTDUO_MAX_JOBS=6`，但要复测单任务延迟 |
| 升级 | 重传 src.tgz → `docker compose build && up -d`（数据卷不变） |
| 排障 | 先看 `/health`，再看 `docker compose logs`；MCP 层错误都带 `code`/`fix` |

## 八、部署完成记录（2026-11-13 05:08）

**已上线**：`https://cut-mcp.1task.cn/mcp`，容器 `cutduo-mcp` 在 ai-prod 上运行。

| 项 | 结果 |
|---|---|
| DNS | `cut-mcp.1task.cn` → 210.121.44.245（阿里云 API 添加，RecordId 2120986037102210048） |
| 证书 | Let's Encrypt ECC，有效期至 2027-01-10，acme.sh 自动续期 |
| nginx | 80 跳 443 + ACME 通道；443 反代 `127.0.0.1:8787`，`proxy_read_timeout 900s` |
| 公网 health | HTTP 200，TLS 验证通过 |
| 公网鉴权 | 无 token → 401 |
| **公网出片** | paper + 上传音轨 → 2573 帧 / 42.886s / 1.94MB / 带音轨，**21.3s** |
| 五支渲染 | paper 74K / science 1.1M / desk 1.5M / editorial 37K / mg 379K，与本地量级一致 |

### 三个踩到的坑（按杀伤力排序）

1. **ffmpeg 路径写死成 macOS 的 `/opt/homebrew/bin/ffmpeg`**。
   本地一切正常，容器里 `spawn ENOENT`。散落在 5 个运行时文件（contract / pipeline / timing /
   gate / editorial）。已收敛到 `src/bins.mjs`：环境变量 → Homebrew 路径 → 交给 PATH。
   **这个错误本地冒烟永远发现不了**，只有真在容器里出片才暴露。
2. **打包漏了仓库根的 `render.mjs`**。症状同样是「容器能起、health 正常、只有出片才报错」。
   已用 `deploy/package.sh` 固化，带 10 个关键文件自检。
3. **证书目录不存在导致 `install-cert` 失败**。`acme.sh --install-cert` 不会自己建目录，
   要先 `mkdir -p /www/server/panel/vhost/cert/<host>`。

### 两个使用上的注意

- **下载产物要带 token**：`GET /files/<name>` 走同一套 Bearer 鉴权，不带会拿到 88 字节的
  `UNAUTHORIZED` JSON 而不是 mp4。回执里的 `downloadUrl` 只是地址，不含凭证。
- **公网出片比本地慢约 3.5 倍**（21.3s vs 6s）：ai-prod 的 load average 是 67（64 核），
  30+ 个服务在抢核。短 probe 不受影响（0.28s），长片建议错峰。

### 客户端注册

```json
{
  "mcpServers": {
    "cutduo": {
      "url": "https://cut-mcp.1task.cn/mcp",
      "headers": { "Authorization": "Bearer <CUTDUO_TOKEN>" }
    }
  }
}
```

token 在服务器 `/opt/cutduo/.env`（`chmod 600`）。注册后需在连接器管理页点一次「信任」。

## 九、已知限制

1. **无 SSE 流**：只支持 `POST /mcp` 单次请求-响应。MCP 协议允许，但客户端若强制要求
   `GET /mcp` 开流会失败。WorkBuddy 与主流客户端用 POST 即可。
2. **无多租户**：一个 token 一个配额池，任务队列全局共享。
3. **产物不持久**：`/data` 是本地卷，重装容器不丢，但没做对象存储备份。
4. **无鉴权分级**：token 泄露等于可以无限出片，建议定期轮换。
5. **宿主机器已超载**：部署时 ai-prod 的 load average 是 **67（64 核）**，上面还跑着 30+ 个服务
   （含 renderd 的 api/worker/pg）。渲染是 CPU 密集，调用时会和现有服务抢核。
   `MAX_JOBS=3` 意味着 24 个渲染线程；建议首次压测后再决定是否放宽，长片尽量错峰。
6. **`mcp.cutduo.com` 仍指向旧的 renderd**：那是另一个服务（容器 `renderd-api-1`，端口 39340），
   与本服务无关，也未下线。两个 MCP 并存时注意客户端配置别指错。
