# Linux 云端部署

单机 Docker Compose 形态。目标是一台云主机上跑起 `api + worker + PostgreSQL`，
需要公网时在同一个栈里加 Caddy 自动 TLS。

> 为什么推荐这个形态：状态层已经是 PG，随时可以加副本；真正拦住多机的是文件卷
> （素材/成片在本地 `/data`）。单机部署把这个问题绕开了，等业务量到了再换对象存储，
> 那是 `docs/OPS.md`「仍未解决的前提」里写明的下一步，不是配置问题。

---

## 一、机器规格

渲染瓶颈是 CPU，不是内存，也不是磁盘 IOPS。

| 场景 | 规格 | 说明 |
|---|---|---|
| 试用 / 演示 | 2C4G，系统盘 40G | 单 worker，一次一条任务 |
| 小规模生产 | 4C8G，系统盘 40G + 数据盘 100G | `WORKER_CPUS=3`，约 2-3 条 1080p/15s 并发 |
| 中等规模 | 8C16G，数据盘 200G | `WORKER_CPUS=6`，或加 worker 副本 |

磁盘算清楚再买：一条 15s 1080p 成片约 3-5MB，但中间片（mezz）与证据图会额外占
2-3 倍；素材按客户上传量增长。**数据盘务必独立**，系统盘写满会让 docker 直接罢工。

架构：`x86_64` 与 `aarch64` 都已验证（镜像基于 `python:3.12-slim`，ffmpeg 走 apt）。
GPU 编码目前没做，不要买 GPU 机器。

## 二、系统与端口

支持的发行版：Ubuntu 20.04+ / Debian 11+ / Alibaba Cloud Linux 3 / Anolis / Rocky / CentOS Stream。
`install.sh` 会自动识别并安装 docker。

安全组 / 防火墙：

| 端口 | 来源 | 用途 |
|---|---|---|
| 22 | 运维跳板机 | SSH |
| 80 | 0.0.0.0/0 | ACME 证书校验（启用 TLS 时） |
| 443 | 0.0.0.0/0 | 对外 API（启用 TLS 时） |
| 8787 | **不开放** | 默认只绑 `127.0.0.1`，由 Caddy 反代 |
| 5432 | **不开放** | PG 只在 compose 内网可达 |

> 8787 直连公网意味着明文传输令牌。`install.sh` 默认不这么做；真要直连必须自己改
> `RENDERD_BIND=0.0.0.0`，并清楚后果。

## 三、部署

### 3.1 一键（推荐）

```bash
# 拿代码（私有仓库用 deploy key）
git clone https://github.com/jushenzhidao/cutduo.git /opt/renderd
cd /opt/renderd

# 不启用 TLS：只监听 127.0.0.1，适合先在内网验证
sudo ./deploy/linux/install.sh

# 启用 TLS：域名必须先解析到本机，80/443 已放通
sudo ./deploy/linux/install.sh --domain render.example.com --email ops@example.com --tls
```

脚本做四件事：装 docker → 生成 `.env`（随机令牌与密钥）→ 构建镜像 → 起栈并等 `/readyz`。
**重复执行不会覆盖已有 `.env`**——覆盖等于轮换密钥，所有已发出的下载链接立即失效。

结束时会把租户令牌打印一次：

```
租户令牌   a1b2c3d4...:acme
```

只显示这一次，立刻存进你的密码管理器。

### 3.2 手动

```bash
cd /opt/renderd
cp deploy/linux/.env.example deploy/linux/.env
chmod 600 deploy/linux/.env
# 编辑 .env：至少填 POSTGRES_PASSWORD / RENDERD_TOKENS / RENDERD_SECRET
#   openssl rand -hex 32

docker compose -f deploy/linux/docker-compose.prod.yml build api
docker compose -f deploy/linux/docker-compose.prod.yml up -d
curl -s http://127.0.0.1:8787/readyz
```

### 3.3 数据盘

默认数据卷在 `/var/lib/docker/volumes`（系统盘）。生产建议把 docker 根目录整体挪到数据盘：

```bash
# 假设数据盘是 /dev/vdb
mkfs.ext4 /dev/vdb
mkdir -p /data-docker
mount /dev/vdb /data-docker
echo "UUID=$(blkid -s UUID -o value /dev/vdb) /data-docker ext4 defaults 0 2" >> /etc/fstab

systemctl stop docker
mkdir -p /data-docker/docker
rsync -aHAX /var/lib/docker/ /data-docker/docker/
cat > /etc/docker/daemon.json <<'JSON'
{ "data-root": "/data-docker/docker" }
JSON
systemctl start docker
```

> 已有数据时先停 docker 再搬，别在运行中 rsync。

## 四、验收

```bash
BASE=http://127.0.0.1:8787

curl -s $BASE/healthz | jq          # ok=true，含引擎与字体数
curl -s $BASE/readyz  | jq          # ok=true，checks 全绿
curl -s $BASE/metrics | head -20    # 指标可读（仅内网）

# 容器内自检：字体、ffmpeg、目录权限、时钟
docker compose -f deploy/linux/docker-compose.prod.yml exec api \
  python -m renderd --data-dir /data doctor
```

`doctor` 必须 7/7。常见不过项：字体缺失（`fonts_available=0`）、数据目录不可写。

提交第一个任务（完整字段见 `docs/API.md`）：

```bash
TOKEN=<你的租户令牌>
curl -s -X POST $BASE/v1/render \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d @sample-ir.json | jq
# 拿 job_id 轮询
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/jobs/<job_id> | jq '.status'
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/jobs/<job_id>/receipt | jq '.verdict'
```

`verdict=pass` 才算成功。`verdict=fail` 时 `failures` 里是具体断言项，不是笼统的「渲染失败」。

## 五、日常运维

```bash
cd /opt/renderd
DC="docker compose -f deploy/linux/docker-compose.prod.yml"

$DC ps                              # 状态与健康
$DC logs -f --tail 100 api          # 日志（json-file 已轮转，50MB × 5）
$DC exec api python -m renderd --data-dir /data queue    # 队列
$DC exec api python -m renderd --data-dir /data dlq      # 死信
$DC exec api python -m renderd --data-dir /data assets --tenant acme
```

**扩并发**：加 worker 副本，不是调 `RENDERD_WORKER_CONCURRENCY`（单容器多进程会让日志与
资源归因变糊）。

```bash
$DC up -d --scale worker=3
```

**升级**：

```bash
git pull
$DC build api
$DC up -d
curl -s http://127.0.0.1:8787/readyz
```

升级会让正在跑的任务继续跑完（`stop_grace_period: 300s`），但新代码的 `COMPILE_REV`
若变了，渲染缓存会整体失效一次——这是有意的，避免用户拿到与当前代码不一致的产物。

**回滚**：

```bash
RENDERD_IMAGE=renderd:0.1.0-prev $DC up -d
```

所以**每次升级前先给当前镜像打 tag**：`docker tag renderd:0.1.0 renderd:0.1.0-prev`。

## 六、备份与恢复

```bash
./deploy/linux/backup.sh                     # → /var/backups/renderd/<时间戳>/
BACKUP_DIR=/mnt/backup KEEP_DAYS=30 ./deploy/linux/backup.sh

./deploy/linux/restore.sh /var/backups/renderd/20261109-030000 --yes
```

备份是两份：PG 逻辑备份（任务状态、配额账本）+ `/data` 打包（素材、成片、证据）。
只备份其一在恢复时都会缺一半——数据库恢复回来但产物没了，回执里的哈希全部失配。

crontab：

```
0 3 * * * /opt/renderd/deploy/linux/backup.sh >> /var/log/renderd-backup.log 2>&1
```

异地容灾：把 `BACKUP_DIR` 指向挂载的 NAS，或备份完 `rclone` 到对象存储。**备份和机器
在同一块盘上等于没有备份。**

## 七、监控

`/metrics` 是 Prometheus 文本格式，只在白名单内网段可读（`RENDERD_METRICS_CIDRS`）。

关键指标：

| 指标 | 看什么 |
|---|---|
| `renderd_queue_depth` | 持续增长 = worker 不够或渲染卡住 |
| `renderd_jobs_total` / `failed_24h` | 失败率突增通常是新素材触发了断言 |
| `renderd_cache_hits_total` | 命中率骤降 = `COMPILE_REV` 变了或素材都不同 |
| `renderd_clock_skew_s` | 非零 = 宿主时钟漂移，租约判断会受影响 |
| `renderd_inflight_by_tenant` | 单租户占满 = 该限流或加容量 |

建议同时装 `node_exporter` 看 CPU 与磁盘——**磁盘剩余空间是最该报警的一项**，
`/readyz` 低于阈值只会摘流量，不会自动清理。

## 八、云厂商差异

| 项 | 说明 |
|---|---|
| 镜像加速 | 阿里云/腾讯云控制台有专属加速地址，写进 `/etc/docker/daemon.json` 的 `registry-mirrors`。`install.sh` 检测到没配会提示 |
| 安全组 | 默认拒绝入站，要手动放通 80/443；内网安全组之间默认互通，Prometheus 抓取走内网 |
| 云盘 | 阿里云 ESSD / 腾讯云 CBS，挂载后按 §3.3 迁移 docker 根目录 |
| 对象存储 | 交付侧支持客户自己的预签名 PUT URL（`delivery.py`），出口带宽可以归零；我方存储仍是本地卷 |
| 元数据服务 | `169.254.169.254` 默认被出站防线拦下，这是对的——别为了「调试方便」打开 `RENDERD_ALLOW_PRIVATE_CALLBACKS` |
| 带宽 | 上传素材与下载成片都走公网带宽。素材大的客户建议用对象存储直传，别经过本机 |

## 九、排障

| 现象 | 先查 |
|---|---|
| `/readyz` 503，`failing:["db"]` | PG 容器是否 healthy；`.env` 里 `POSTGRES_PASSWORD` 是否有 `$`、`#` 等被 shell 解释的字符 |
| `failing:["disk"]` | `df -h`；`gc --assets` 清孤儿素材；扩容数据盘 |
| `failing:["ffmpeg"]` | 镜像是否被替换成精简版；`$DC exec api which ffmpeg` |
| 上传 413 | `RENDERD_MAX_UPLOAD_MB` 与 Caddyfile 的 `request_body max_size` 两边都要够 |
| 任务一直 `accepted` 不动 | worker 是否在跑；`$DC logs worker`；`RENDERD_MAX_TENANT_INFLIGHT` 是否被占满 |
| worker 反复重启 | 多半 OOM，看 `docker inspect` 的 `OOMKilled`，调 `WORKER_MEMORY` |
| 渲染超时 | `RENDERD_JOB_TIMEOUT_S`（默认 1800s）、`RENDERD_RENDER_TIMEOUT_S`（1500s） |
| 成片能出但 `verdict=fail` | 看 `failures`，通常是响度或时长断言；不是渲染失败 |
| 字体不一致 | 宿主机与镜像字体不同会导致字形像素差异。生产只用镜像，别在宿主机直接跑 |
| **停止容器要等好几分钟** | 容器的 PID 1 不响应 SIGTERM。本仓库已在 `api.start()` 注册处理器（实测停止 0.45s）；若你改了启动方式（如 `sh -c`、supervisord），务必保证信号能传到 python 进程 |

### 关于 PID 1 与 SIGTERM（踩过一次）

Linux 内核会**忽略 PID 1 未注册 handler 的信号**。容器里 `CMD ["python", "-m", "renderd", "serve"]`
让 python 直接成为 PID 1，如果没装 handler，SIGTERM 会被静默丢弃，容器只能等
`stop_grace_period` 到期被 SIGKILL。表现是「每次重启/恢复都白等 5 分钟」，而且
进行中的请求是被硬切的。

两个正确做法（本仓库已用第一种）：

1. 进程内注册 `SIGTERM` → 子线程调 `httpd.shutdown()`（不能在 handler 里直接调，会死锁）
2. 用 `tini` / `dumb-init` 做 PID 1 转发信号

**不要用 `sh -c "python -m renderd ..."`** —— sh 不转发信号，问题原样存在。

## 十、上云前检查表

- [ ] `.env` 权限 600，且不在 git 仓库里
- [ ] `RENDERD_SECRET` 是随机 32 字节，不是 `change-me`
- [ ] `RENDERD_TOKENS` 每个租户一把，没有共用
- [ ] `.env` 里没有 `RENDERD_ALLOW_ARBITRARY_PATHS=1`
- [ ] 8787 与 5432 没有对公网开放
- [ ] 数据盘已挂载，docker 根目录已迁移
- [ ] 备份脚本已加 crontab，且**手动跑通过一次恢复**
- [ ] `/metrics` 抓取正常，磁盘余量告警已配
- [ ] 升级前打了镜像 tag（能回滚）
- [ ] 域名解析、证书签发、`https` 访问通过

---

## 附：与 dev 部署的差别

| | dev（`docker-compose.pg.yml`） | 生产（`deploy/linux/`） |
|---|---|---|
| 探针 | `/healthz` | `/readyz`（DB/磁盘/ffmpeg 任何一项坏就摘流量） |
| 端口 | `0.0.0.0:8787` | 默认 `127.0.0.1`，公网走 Caddy |
| 日志 | 无限制 | 50MB × 5 轮转 |
| 资源 | 不限 | 可配 cpu/memory 上限 |
| TLS | 手动 | Caddy 自动签发续期 |
| 备份 | 无 | 脚本 + 校验 + 保留策略 |
