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

## 八、实际部署记录（2026-11-13 05:00）

**容器已在 ai-prod 跑起来**，内网 `127.0.0.1:8787` 可访问，状态 healthy。
**未完成：DNS、证书、443 站点**——这三步都卡在 DNS 上。

### 已完成的验证

| 项 | 结果 |
|---|---|
| 镜像构建 | `cutduo-mcp:2.0.0`，409MB，约 4 分钟（ffmpeg 层 169s） |
| 容器 | `Up (healthy)`，`127.0.0.1:8787->8787` |
| 鉴权 | 无 token → 401，有 token → 200 |
| 握手 | `protocolVersion 2025-03-26`，serverInfo cutduo 2.0.0 |
| 工具 | 7 个全部注册 |
| **容器内渲染** | paper probe **0.311s**，产物 75036B（本地 75140B，差 0.14%） |
| 画面 | 中文标题/强调下划线/章节卡/字幕条全部正常，无方框字 |

0.14% 的体积差来自不同平台的 freetype 渲染，不是字体回退 —— 若回退到系统字体，
字形会完全不同，差异会是一个数量级以上。

### 三个实际踩到的坑

1. **打包漏了 `render.mjs`**。它是仓库根的 CLI，paper/science 的 adapter 指向它。
   症状极具迷惑性：容器能起、health 正常、协议能握手，**只有真出片时才报「入口不存在」**。
   已用 `deploy/package.sh` 固化，自带 10 个关键文件的自检。
2. **`docker compose ps/logs` 也要 `--env-file`**。`up` 带了不代表后续命令带；
   否则插值 `${CUTDUO_TOKEN:?}` 直接报错。已建 `deploy/.env` 软链到 `/opt/cutduo/.env`。
3. **macOS 的 `._*` 资源叉文件被打进镜像**（每个 163 字节）。
   不影响功能但污染层，打包时 `--exclude='._*'`。

### 剩余步骤（按顺序）

```bash
# 1. 阿里云 DNS 控制台加记录（1task.cn 的 NS 是 dns13.hichina.com）
#    类型 A  主机记录 cut-mcp  记录值 210.121.44.245  TTL 600

# 2. 确认解析生效
dig +short cut-mcp.1task.cn    # 应返回 210.121.44.245

# 3. 配 80 端口（ACME 通道）并签发
cp deploy/nginx-cut-mcp.conf /www/server/panel/vhost/nginx/cut-mcp.1task.cn.conf
# 注意：参考同机的 mcp.1task.cn.conf，ACME 的 location 必须排在 catch-all 之前
acme.sh --issue -d cut-mcp.1task.cn --webroot /www/wwwroot/cut-mcp
acme.sh --install-cert -d cut-mcp.1task.cn \
  --fullchain-file /www/server/panel/vhost/cert/cut-mcp.1task.cn/fullchain.pem \
  --key-file       /www/server/panel/vhost/cert/cut-mcp.1task.cn/privkey.pem \
  --reloadcmd      "/www/server/nginx/sbin/nginx -s reload"
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

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
