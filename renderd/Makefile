PY ?= python3
DATA ?= var

.PHONY: help install doctor test test-pg unit integ hardening ingest-corpus queue dlq assets api-doc smoke attack multi \
        docker-build docker-build-mlt test-mlt docker-run docker-pg test-container test-compose test-gateway tls bootstrap \
        multi-replica soak soak500 docker clean fmt \
        prod-install prod-up prod-down prod-ps prod-logs prod-ready prod-backup prod-restore

BASE ?= http://127.0.0.1:8787
TOKEN ?= devtoken
OTHER_TOKEN ?=
BURST_TOKEN ?=
STORAGE_TOKEN ?=
SECRET ?= change-me
PG_DSN ?= $(RENDERD_DB_DSN)

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install:  ## 安装依赖
	$(PY) -m pip install -r requirements.txt

doctor:   ## 环境自检
	$(PY) -m renderd --data-dir $(DATA) doctor

test:     ## 跑全部 157 个用例（宿主机跳过 6 项：5 项 MLT 真渲染 + 1 项 PG 契约）
	cd tests && $(PY) -m unittest discover -s . -p "test_*.py"

test-pg:  ## 同一套用例切到 PG 后端（需 RENDERD_DB_DSN 或 PG_DSN）
	@test -n "$(PG_DSN)" || { echo "请先 export RENDERD_DB_DSN=postgresql://..."; exit 1; }
	cd tests && RENDERD_DB_DSN="$(PG_DSN)" $(PY) -m unittest discover -s . -p "test_*.py"

unit:     ## 单元测试（毫秒级）
	cd tests && $(PY) -m unittest test_units

integ:    ## 集成测试（真渲染，约 20s）
	cd tests && $(PY) -m unittest test_integration

hardening: ## webhook / 直传 / DNS rebinding / 配额 / 白名单（约 40s）
	cd tests && $(PY) -m unittest test_hardening

ingest-corpus: ## 21 条脏素材归一化回归 + 4 条端到端
	$(PY) tests/ingest_corpus.py

queue:    ## 打印队列统计（深度/等待/在途）
	$(PY) -m renderd --data-dir $(DATA) queue

dlq:      ## 列出死信任务
	$(PY) -m renderd --data-dir $(DATA) dlq --limit 50

api-doc:  ## 生成单页接口文档（deliverables/接口文档.html）
	$(PY) make_api_doc.py

assets:   ## 列出租户素材引用与占用（make assets TENANT=acme）
	$(PY) -m renderd --data-dir $(DATA) assets --tenant $(or $(TENANT),acme)

smoke:    ## 接口冒烟（REST + MCP stdio + MCP over HTTP）
	./tests/api_smoke.sh
	$(PY) tests/mcp_smoke.py
	./tests/mcp_http_smoke.sh

test-mcp-http: ## MCP over Streamable HTTP 冒烟（16 项，无需 Pillow）
	./tests/mcp_http_smoke.sh

attack:   ## 对抗测试 61 项（需先起服务，见 docs/SECURITY.md）
	$(PY) tests/attack.py --base $(BASE) --token $(TOKEN) \
	  --other-token $(OTHER_TOKEN) --burst-token $(BURST_TOKEN) \
	  --storage-token $(STORAGE_TOKEN) --secret $(SECRET) \
	  --json $(or $(OUT),/tmp/attack_latest.json)

multi:    ## 多 worker 并发不双领
	$(PY) tests/multiclient.py

# ── 容器 ──
docker-build: ## 构建镜像（含 PG 驱动）
	docker build -t renderd:0.1.0 .

docker-build-mlt: ## 可选：带 melt 的镜像（+450MB，仅 MLT 后端需要）
	docker build -t renderd:0.1.0 .
	docker build -f Dockerfile.mlt -t renderd:0.1.0-mlt .

test-mlt: ## MLT 后端：结构断言 + 真渲染（在带 melt 的镜像里跑）
	docker build -q -t renderd:0.1.0 .
	docker build -q -f Dockerfile.mlt -t renderd:0.1.0-mlt .
	docker run --rm -v "$(PWD)":/app renderd:0.1.0-mlt \
	  python -m unittest discover -s tests -p "test_mlt_backend.py" -v

docker-pg: ## 起 PG + api + worker 分离部署
	docker compose -f docker-compose.pg.yml up -d --build

docker-run:   ## 起单容器（端口 8788）
	docker rm -f renderd-test >/dev/null 2>&1 || true
	docker run -d --name renderd-test -p 8788:8787 \
	  -e RENDERD_TOKENS="$${RENDERD_TOKENS:-tokA-00000001:acme}" \
	  -e RENDERD_SECRET="$${RENDERD_SECRET:-attack-secret}" renderd:0.1.0

test-container: ## 容器内端到端（需 docker-run）
	./tests/container_e2e.sh

wb-serve: ## 起服务供 WorkBuddy / 其他 MCP 客户端连（127.0.0.1:8799）
	@echo "token: $(or $(WB_TOKEN),wb-token-00000001)  tenant: acme  endpoint: http://127.0.0.1:8799/mcp"
	@echo "含文字模板需要 Pillow：make wb-serve PY=\"uv run --with pillow --python 3.13 python\""
	RENDERD_TOKENS="$(or $(WB_TOKEN),wb-token-00000001):acme" RENDERD_SECRET="wb-test-secret" \
	  $(PY) -m renderd --data-dir var/wbtest serve --port 8799 --workers 1 --host 127.0.0.1

test-compose: ## Compose 端到端 + 崩溃恢复（约 90s）
	./tests/compose_e2e.sh

test-gateway: ## Caddy TLS 网关端到端（约 30s）
	./tests/gateway_e2e.sh

multi-replica: ## 3 个 API 容器共享一个 PG：限流/配额不被副本放大（约 60s）
	./tests/multi_replica.sh

tls:      ## 内置 TLS + /metrics 白名单冒烟
	./tests/tls_smoke.sh

bootstrap: ## 固化 Colima VM 的 DNS / registry mirror 修复
	./deploy/colima-bootstrap.sh

soak:     ## 长稳（默认 15 条）
	./tests/soak.sh $${BASE:-http://127.0.0.1:8788} $${TOKEN:-tokA} $${N:-15}

soak500:  ## 500 条长稳，观察内存收敛（约 10 分钟）
	./tests/soak.sh http://127.0.0.1:8788 tokA-00000001 500 renderd-test

serve:    ## 起服务（带 2 个内联 worker）
	$(PY) -m renderd --data-dir $(DATA) serve --port 8787 --workers 2

worker:   ## 只跑 worker
	$(PY) -m renderd --data-dir $(DATA) worker --tenant default --name w1

demo:     ## 三个模板各渲一条，看速度
	$(PY) -m renderd --data-dir $(DATA) bench

bench: demo

docker:   ## 构建并起容器
	docker compose up --build -d

# ── 生产部署（Linux 单机，见 docs/DEPLOY-LINUX.md）──
PROD_COMPOSE ?= deploy/linux/docker-compose.prod.yml
PROD_ENV ?= deploy/linux/.env

prod-install: ## 一键装（需 root；自动装 docker、生成 .env、起栈）
	sudo ./deploy/linux/install.sh

prod-up:  ## 起生产栈（需先有 $(PROD_ENV)）
	@test -f $(PROD_ENV) || { echo "缺 $(PROD_ENV)，先跑 make prod-install 或复制 .env.example"; exit 1; }
	docker compose -f $(PROD_COMPOSE) --env-file $(PROD_ENV) up -d

prod-down: ## 停生产栈（保留卷）
	docker compose -f $(PROD_COMPOSE) --env-file $(PROD_ENV) down

prod-ps:  ## 生产栈状态
	docker compose -f $(PROD_COMPOSE) --env-file $(PROD_ENV) ps

prod-logs: ## 跟生产栈日志
	docker compose -f $(PROD_COMPOSE) --env-file $(PROD_ENV) logs -f --tail 100 api worker

prod-ready: ## 查就绪状态（含各项检查结果）
	@curl -s http://127.0.0.1:$${RENDERD_PORT:-8787}/readyz | $(PY) -m json.tool || \
	  echo "readyz 不通（503 或未启动）"

prod-backup: ## 备份（PG + 数据卷）
	./deploy/linux/backup.sh

prod-restore: ## 恢复（需 SRC=备份目录，会覆盖现有数据）
	@test -n "$(SRC)" || { echo "用法: make prod-restore SRC=/var/backups/renderd/<stamp>"; exit 1; }
	./deploy/linux/restore.sh $(SRC) --yes

clean:    ## 清理本地数据（不可逆）
	rm -rf $(DATA)

fmt:
	$(PY) -m compileall -q renderd
