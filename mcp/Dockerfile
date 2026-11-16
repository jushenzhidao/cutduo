# cutduo MCP · 生产镜像
#
# 为什么在服务器上构建而不是本地推：本机是 arm64，ai-prod 是 x86_64，
# 而 @napi-rs/canvas 是原生模块（.node 二进制按平台分发）。跨架构构建需要
# buildx + QEMU，本机这两样都没有；服务器原生构建反而更快、更确定。
#
# 镜像里只装渲染必需的东西：ffmpeg + canvas。playwright 在 devDependencies，
# --omit=dev 会跳过它（云端不出 .motion 模板，那是本地对照工具）。
#
# python3 + edge-tts 是侧车能力层（src/cloud/）的第一项：参数里有 captions 时
# 自动配音。edge-tts 只有 Python 实现，没有可靠的 node 等价物（协议要自己维护
# WebSocket + token 刷新），所以宁可让镜像多 100MB 也不用一份会过期的自研客户端。

FROM node:22-bookworm-slim

# 国内源：实测 core-4 容器内到 mirrors.aliyun.com 是 38ms，到 deb.debian.org 是 776–1716ms。
# 构建曾经「跑 25 分钟不出结果」，一度被误判成卡死——实际是 apt 等远程索引太慢，
# 而 apt 等网络时 CPU 占用接近 0，看起来像挂了。换源后同样步骤在一分钟内完成。
# 若将来要在 GitHub Actions 上构建，把这两处换回官方源（或改成 ARG）。
# non-free 是 QSV 驱动的唯一来源；只改域名不动 Components 的话这里装不上。
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
      /etc/apt/sources.list.d/debian.sources \
 && sed -i 's|^Components: main$|Components: main contrib non-free non-free-firmware|' \
      /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates python3 python3-pip \
      intel-media-va-driver-non-free libmfx1 vainfo \
 && rm -rf /var/lib/apt/lists/*

# bookworm 的 pip 受 PEP 668 保护，装到系统目录必须显式声明
RUN pip3 install --no-cache-dir --break-system-packages \
      -i https://mirrors.aliyun.com/pypi/simple/ edge-tts

WORKDIR /app

# 先只拷依赖清单，让 npm 层可缓存：改业务代码不必重装依赖
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    LIBVA_DRIVER_NAME=iHD \
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
