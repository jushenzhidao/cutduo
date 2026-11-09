# renderd 运行镜像
# 关键：镜像里必须预装字体。字体换了字形像素就变，跨端一致性从物理上失效。
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    RENDERD_DATA_DIR=/data \
    RENDERD_HOST=0.0.0.0 \
    RENDERD_PORT=8787

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg fonts-noto-cjk fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/healthz',timeout=3).status==200 else 1)"

CMD ["python", "-m", "renderd", "serve", "--workers", "2"]
