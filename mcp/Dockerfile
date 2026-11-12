# cutduo MCP · 生产镜像
#
# 为什么在服务器上构建而不是本地推：本机是 arm64，ai-prod 是 x86_64，
# 而 @napi-rs/canvas 是原生模块（.node 二进制按平台分发）。跨架构构建需要
# buildx + QEMU，本机这两样都没有；服务器原生构建反而更快、更确定。
#
# 镜像里只装渲染必需的东西：ffmpeg + canvas。playwright 在 devDependencies，
# --omit=dev 会跳过它（云端不出 .motion 模板，那是本地对照工具）。

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷依赖清单，让 npm 层可缓存：改业务代码不必重装依赖
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    CUTDUO_ROOT=/app \
    CUTDUO_OUT=/data/out \
    CUTDUO_DATA=/data \
    PORT=8787

# 数据卷归 node 用户所有，否则非 root 运行时写不进产物与 job 状态
RUN mkdir -p /data/out /data/assets && chown -R node:node /data

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "mcp/server.mjs"]
