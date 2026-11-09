# renderd 运行镜像
# 关键：镜像里必须预装字体。字体换了字形像素就变，跨端一致性从物理上失效。

# ── ffmpeg：官方静态构建，版本与校验值一起钉死 ──────────────────
# 为什么不用 apt 的 ffmpeg（Debian 13 给的是 7.1.5）：
#   1. Debian 打包版**不带 libvmaf**（`--enable-libvmaf` 计数为 0），于是 L2
#      感知层在容器里根本跑不了 —— 只要客户传了 reference 就会撞
#      "No such filter: libvmaf"，而不是一个可解释的能力缺失。
#   2. 版本随发行版漂移，且与开发机不同 →「同输入同字节」跨环境不成立。
# 静态构建是自包含二进制：钉住版本 + 双架构 sha256 后，容器与开发机可以是同一个文件。
# 实测 7.1.5 → 9.0.2：画面逐像素相同（PSNR=inf / SSIM=1.000），渲染快 12.6%，
# 只有容器头里的 ffmpeg 版本标识长度差了 14 字节。
#
# ⚠️ 上游只把各版本资产挂在 `latest` 标签下，该标签内容会轮换。sha256 钉死是
#    有意的 fail-closed：上游一变，构建**失败**，迫使升级成为一次显式决策。
#
# 两个架构分开钉：arm64 用 linuxarm64 包，校验值不同。用错包会在 sha256 校验处
# 直接失败，而不是产出一个「构建成功但跑不起来」的镜像。
ARG FFMPEG_VER=9.0
ARG FFMPEG_URL_BASE=https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest
ARG FFMPEG_SHA_AMD64=b7820a4980320a67a4c7d9340d4fcdc0fb14043d5bc5fa44720e5b1259fd59cc
ARG FFMPEG_SHA_ARM64=5c06041cbc27c3c79920a73131bd88ec4c89ba771cdc568222605c611d61dda0

# ── 阶段一：取包并解包 ─────────────────────────────────────────
# 单独成阶段的原因：离线包（145 MB）只应存在于中间层。直接 COPY 进最终镜像
# 会永久占住一层 —— 层是只读的，后面再 `rm` 也删不掉（实测体积差约 1 GB）。
FROM python:3.12-slim AS ffmpeg
ARG TARGETARCH
ARG FFMPEG_VER
ARG FFMPEG_URL_BASE
ARG FFMPEG_SHA_AMD64
ARG FFMPEG_SHA_ARM64

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl xz-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY .vendor/ /vendor/

# 优先用构建上下文里的缓存包（离线通道：容器内访问 GitHub 会静默挂死），
# 没有才下载。sha256 始终校验。
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) SUFFIX=linux64;    SHA="${FFMPEG_SHA_AMD64}" ;; \
        arm64) SUFFIX=linuxarm64; SHA="${FFMPEG_SHA_ARM64}" ;; \
        *) echo "不支持的架构: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    URL="${FFMPEG_URL_BASE}/ffmpeg-n${FFMPEG_VER}-latest-${SUFFIX}-gpl-${FFMPEG_VER}.tar.xz"; \
    if [ -s /vendor/ffmpeg.tar.xz ]; then \
        cp /vendor/ffmpeg.tar.xz /tmp/ffmpeg.tar.xz; \
    else \
        curl -fsSL --retry 5 --retry-delay 3 --max-time 900 -o /tmp/ffmpeg.tar.xz "${URL}"; \
    fi; \
    echo "${SHA}  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/ffmpeg; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1; \
    rm -rf /tmp/ffmpeg.tar.xz /vendor; \
    rm -f /opt/ffmpeg/bin/ffplay; \
    rm -rf /opt/ffmpeg/doc /opt/ffmpeg/man /opt/ffmpeg/presets; \
    /opt/ffmpeg/bin/ffmpeg -version | head -1; \
    /opt/ffmpeg/bin/ffmpeg -hide_banner -filters | grep -q libvmaf

# ── 阶段二：运行镜像 ──────────────────────────────────────────
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    RENDERD_DATA_DIR=/data \
    RENDERD_HOST=0.0.0.0 \
    RENDERD_PORT=8787 \
    RENDERD_FFMPEG=/opt/ffmpeg/bin/ffmpeg

# Debian 源可替换：实测 deb.debian.org 对某些机房/容器会在大包上卡死（字体 56 MB），
# 换成地理上更近的镜像即可。默认保持官方源，构建时用 --build-arg 覆盖。
ARG APT_MIRROR=deb.debian.org

RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\n' \
        > /etc/apt/apt.conf.d/99net && \
    sed -i "s|//deb.debian.org|//${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    sed -i "s|//deb.debian.org|//${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    apt-get update && apt-get install -y --no-install-recommends \
        fonts-noto-cjk fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 静态二进制自包含，不依赖运行镜像的系统库；从阶段一只取解包结果
COPY --from=ffmpeg /opt/ffmpeg /opt/ffmpeg
RUN ln -sf /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg \
 && ln -sf /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe \
 && /opt/ffmpeg/bin/ffmpeg -version | head -1

# 版本号由 CI 按 git tag 注入；本地 docker build 未注入时为 dev
ARG RENDERD_VERSION=dev
ENV RENDERD_VERSION=${RENDERD_VERSION}

WORKDIR /app
COPY requirements.txt requirements-pg.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-pg.txt
COPY renderd ./renderd

# 非 root 运行
RUN useradd -m -u 10001 render && mkdir -p /data && chown -R render:render /data /app
USER render
STOPSIGNAL SIGTERM
VOLUME ["/data"]
EXPOSE 8787

# 探针按角色分流：api 打 /healthz，worker 只判进程存活。
# 若统一打 HTTP，worker（不监听端口）会被永久判成 unhealthy —— 见 renderd/healthcheck.py。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-m", "renderd.healthcheck"]

CMD ["python", "-m", "renderd", "serve", "--workers", "2"]
