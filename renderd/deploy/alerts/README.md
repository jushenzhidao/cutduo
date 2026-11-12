# 告警接入

`renderd.rules.yml` 是 Prometheus 规则文件，本身不含抓取配置。接入分三步。

## 1. 抓取

`/metrics` 默认只对白名单来源开放（`RENDERD_METRICS_ALLOW`，见 `docs/OPS.md`）。
Prometheus 与 api 同机时，抓 `127.0.0.1:<host_port>` 最省事：

```yaml
scrape_configs:
  - job_name: renderd
    scrape_interval: 15s
    static_configs:
      - targets: ["127.0.0.1:39340"]
```

跨机抓取则要先把 Prometheus 的出口 IP 加进 `RENDERD_METRICS_ALLOW`，否则会得到 403
（`E_METRICS_FORBIDDEN`）—— 告警 `RenderdMetricsAbsent` 会因此触发，这是有意为之：
「抓不到」和「服务挂了」都该有人知道，区别在 error log 里是 403 还是连接被拒。

## 2. 挂规则

```yaml
rule_files:
  - /etc/prometheus/renderd.rules.yml
```

`promtool check rules renderd.rules.yml` 可以先验语法。

## 3. 需要 node_exporter 的一条

`RenderdDiskLow` 依赖 `node_filesystem_*`。没有 node_exporter 就先删掉这条，
或改成黑盒探针对 `/readyz` 的探测（`/readyz` 在磁盘低于 `RENDERD_MIN_FREE_GB` 时返回 503）。

## 指标语义速查（写面板/告警前先看这段）

| 指标 | 类型 | 语义 | 常见误用 |
|---|---|---|---|
| `renderd_jobs_total` | counter | 提交总数 | `rate()` 得到提交速率，不是成功率 |
| `renderd_failed_jobs_24h` | gauge | **滚动 24h** 的失败数 | 用 `delta()` 看新增；直接设阈值会把历史失败一直报 |
| `renderd_queue_depth` | gauge | 排队数（含重试退避中的） | 单 worker 下 >0 是常态，别直接报警 |
| `renderd_queue_oldest_wait_seconds` | gauge | 最老排队等了多久 | 这个才是「客户在等」的信号 |
| `renderd_jobs_running` | gauge | 正在跑的任务数 | 与 depth 组合可判断 worker 是否活着 |
| `renderd_tenant_inflight{tenant}` | gauge | 每租户在途数 | 空闲时也发 0，`absent()` 可靠 |
| `renderd_clock_skew_seconds` | gauge | 墙钟与逻辑钟漂移 | 持续 >5s 说明宿主机时间服务有问题 |
| `renderd_uptime_seconds` | gauge | 进程存活秒数 | 「指标消失」用它判，别用 UP（网关可能兜底回 200） |
