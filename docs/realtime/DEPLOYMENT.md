# 可选实时同步部署与回滚

此功能默认关闭。先读 [审计与威胁模型](AUDIT.md)、[服务商限制](PROVIDERS.md)、[成本模型](COST.md) 和 [验收说明](VALIDATION.md)。以下生产命令由实例所有者执行；本次开发未使用生产凭据、部署令牌或修改远端数据库。

## Cloudflare

1. 保存现有数据库备份与 Worker 版本；确认当前实例本身可收发邮件。
2. 使用仓库现有迁移命令 `npm run db:migrate` 应用迁移至 `0041_realtime_sync.sql`（该命令写入远端，先核对 wrangler 环境/数据库目标）。已有邮箱默认不授权，所有新增表独立，不重建旧索引。
3. 保留已有 D1、R2、Queue、Email Routing 和所有凭据 Secret；新增的 `REALTIME_UPDATES` Durable Object 和 `realtime-v1` SQLite class migration 已写入 `wrangler.jsonc`，按现有流程构建/部署。不要替换已有 Queue。
4. 将非敏感变量 `REALTIME_ENABLED="true"` 加入部署环境（未设置时为关闭）。Secret `REALTIME_SERVICE_KEYS` 是 JSON key-id → `{deviceId,secret,notAfter?}`；secret 至少 32 UTF-8 字节，notAfter 为 UTC 毫秒。通过 Wrangler Secret 输入/文件重定向上传，不能提交到配置文件。
5. 管理员账户设置中注册设备公钥，再启用全局开关；用户逐邮箱勾选明确凭据授权。仅启用全局开关不会自动授权任何邮箱。

本功能继续使用现有 `MAIL_CREDENTIALS_KEY` 或原服务商凭据密钥。不得将这些主密钥放到 VPS。Microsoft OAuth 刷新只在 Worker，原有 OAuth authority/client_id/scope/refresh lease 保持生效。

| Worker 变量 | 默认值 | 可配置范围 / 用途 |
|---|---:|---|
| REALTIME_ENABLED | false | 部署层总开关，须再启用管理员设置 |
| REALTIME_MAX_SUBSCRIPTIONS | 50 | 1–100，原子限制全实例授权数 |
| REALTIME_DEVICE_REQUESTS_PER_MINUTE | 120 | 10–1000，每设备验签后限额 |
| REALTIME_DEVICE_REQUESTS_PER_DAY | 10000 | 100–200000，每设备 UTC 日请求限额 |
| REALTIME_ACCOUNT_MIN_INTERVAL_MS | 3000 | 1000–60000，账号事件合并和任务执行间隔 |
| REALTIME_ACCOUNT_SYNCS_PER_DAY | 1000 | 10–10000，账号每日事件任务尝试预算，不替代实际账单额度 |
| REALTIME_COMPENSATION_SECONDS | 1800 | 300–86400，仅健康 IDLE 账号延长补偿 |

超过事件预算会保留脏任务并回退到独立 Cron；不会禁用原有手动/定时同步。D1 原有额度保护仍保留，Paid 的额外账单须在 Cloudflare 设置用量告警，代码预算不能硬性封顶所有业务成本。

## Linux VPS Docker

```bash
cd realtime-listener
cp .env.example .env
npm ci
npm run device:init -- ./secrets vps-primary
```

生成 `device-private.pem`（加密 PKCS8）、`device-passphrase`、`service-key`、`worker-service-keys.json` 和 `device-public.json`，目录 0700、文件 0600，不覆盖已存在文件。私钥和解密口令在同一主机，保护主要依赖主机权限、磁盘加密和宿主机安全；传输加密无法防止已攻陷 VPS 读取获授权邮箱密码。使用独立密钥给每台设备，不备份到不可信文件服务。

编辑 `.env` 的 Worker HTTPS origin/key id；将 public JSON 在管理页注册（device ID 必须与 key 配置的 deviceId 一致）。在持有生产 Wrangler 权限的安全机器中上传 key 文件：

```bash
npx wrangler secret put REALTIME_SERVICE_KEYS < /secure/path/worker-service-keys.json
```

该文件包含**全部**有效服务 key；已有设备时安全合并，不能用新文件覆盖并丢失旧设备。public JSON 无私钥，可以传输；其他文件只保留在安全设备。

镜像以 uid/gid 1000 的 node 用户运行。若生成文件的宿主机 uid 不为 1000，调整 secrets 目录/文件所有者到 1000:1000，保留目录 0700 / 文件 0600；不要为解决容器权限改成 0644。用户自行执行适当的 `chown`。

```bash
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:9090/health
docker compose logs --tail 100 listener
```

Dockerfile 基于 Node 24 Debian slim，x86_64/ARM64 使用对应基础镜像；本环境仅验证可用的构建架构，不宣称 ARM64 实测。部署时 pin 已审核的镜像 digest。Compose 只读 rootfs、无 capabilities、无新增权限、0.5 CPU/256 MB、日志 10 MB ×3、`unless-stopped`、localhost 健康端口。勿将健康端口或私钥目录暴露到公网。

VPS 需 DNS、NTP、出站 TCP 993 和 HTTPS 443；不需要公网入站 IMAP/HTTP。保持系统 CA/TLS 验证。不要设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。HTTP origin 禁止重定向、带用户密码、路径或 query；若使用自签名测试证书仅添加可信 CA，不禁用验证。

监听连接默认 20，管理员 50 邮箱时相应提高 `MAX_CONNECTIONS`，实测内存/连接/服务商限制后再扩容。清单 60 秒、心跳 300 秒（IMAP NOOP 在 VPS 本地，非 Worker 轮询）、IDLE 最长 25 分钟重入；网络退避有 jitter，认证失败冷却 15 分钟。每账号状态独立。

## Web / Android

Web 使用每用户 hibernating WebSocket、可见页面 Web Locks 选主和 BroadcastChannel；隐藏页断开。旧浏览器缺少相关能力时每个可见页最多一个 socket，不以高频 D1 轮询替代。断线/回到前台时静默读取当前过滤列表；更新未读账号统计和已加载分页，单次最多刷新 10 页，超过部分保留至用户刷新/继续分页。

管理入口位于账户设置：实例 owner 可全局开启/注册/停用设备、查看全实例状态；普通用户只授权/撤销自己的邮箱。立即同步/重连有 30 秒冷却。监控 P50/P95/P99 明确标记为“事件至索引”的批次指标，不能当作邮件到客户端的真实延迟。

Android 新增“第三方邮箱”阅读入口，支持五个服务商的索引列表与正文；本期不增加第三方邮件发送/附件下载 UI。前台 STARTED 期间订阅索引通知，STOPPED 取消连接；后台保留原 WorkManager 15 分钟主邮箱检查。**没有 FCM/后台第三方秒级通知栏推送**，后续需单独配置 FCM 项目、设备注册、权限和发送凭据。旧 API config 缺少 realtimeEnabled 时保持关闭。已有 Android token 若缺少新增只读 scopes，重新登录获取；不赋予凭据授权或管理写权限。

## 监控、失败与回滚

- VPS `/health` 提供连接尝试/成功、断线、认证错误、事件、发送/合并、失败计数，重启归零；清单新鲜度决定健康状态，不把“进程活着”当作所有邮箱正常。
- 结构化日志只记录随机账号标识、provider、状态、退避时间；ImapFlow 协议日志关闭，不输出邮箱正文/密码/令牌。
- Worker `realtime_request`、`realtime_enqueued`、`realtime_job`、`realtime_indexed` 日志提供请求状态、Queue 写入和执行中 D1 metadata 的实际扫描/写入行数。任务计数覆盖该任务执行，不包含所有业务请求；总请求/CPU/Queue 读删重试/DO/D1 总量以 Cloudflare Analytics 为准。
- D1 保存事件至索引批次时间，保留 7 天，管理页最多最近 1000 条。完整真实延迟用 `scripts/realtime-probe.mjs` 和 `scripts/realtime-latency.mjs`。

| 症状 | 检查 / 恢复 |
|---|---|
| 401/403 | key id/deviceId、签名原始 body/path、设备 enabled、UTC 时间差 <60s、请求限额、授权 generation；不打印原始认证请求 |
| 无监听 | 全局/部署开关、账号授权、设备信任、listener 容量、有效用户、IMAP 权限/应用密码；更新凭据后等待清单刷新 |
| Outlook 认证错误 | 原有 Worker OAuth scope/租户 IMAP 权限/refresh token；VPS 不人工保存 refresh token |
| fallback | CAPABILITY 不含 IDLE，使用定时补偿；不能通过减到 10 秒伪造实时能力 |
| VPS 失联 | 设备超过 120 秒未见后下次 5 分钟 Cron 恢复原调度；不是 120 秒内一定完成同步 |
| Queue 暂时失败 | D1 脏任务保留，下次 Cron 重投；检查共享账号 lease、队列 DLQ、额度和索引错误 |
| 任务/账号 lease 过期 | 租约独立恢复，重复任务用 UID 唯一索引避免重复插入；大型首次导入需多轮补偿 |

事件入口先保存 D1 脏任务，再投递现有 Queue（batch timeout=2 秒），返回 202。最终实现不在 HTTP waitUntil 执行 IMAP 同步：HTTP 响应后任务只有有限生存期，较慢同步可能被取消并遗留长租约；Queue 消费具有更长执行窗口。原型的快速路径在验收时移除。正常 Queue 投递 + 增量同步 + 前台显示仍以 10 秒为目标；生产 Queue 实际延迟尚未实测，不能承诺 SLA。队列/补偿持有独立任务租约并复用账号租约，三种入口保持互斥。

企业代理环境构建时可传 Docker 的 HTTPS_PROXY build arg；代理自有 CA 用 BuildKit `--secret id=build-ca,src=/secure/proxy-ca.crt` 暂时信任。CA 不进入最终镜像，始终验证 TLS，不改变部署时原生 CA。正常 VPS 不需要这些参数。

撤销用户授权通常 60 秒内关闭对应连接；关闭设备同样生效。若 VPS 泄露须在服务商撤销应用密码，不能仅撤销 OmniMail 授权。HMAC 轮换：追加新 key-id、同步更新 VPS key 文件/id 并重启，确认健康后删除旧 key 或设 UTC 毫秒 notAfter；公钥轮换同时重新注册和替换对应加密私钥；公钥变化会撤销该设备现有邮箱授权，用户须重新明确授权，不能悄悄沿用旧授权。保留最短过渡期。

回滚优先关闭管理员全局开关（或 REALTIME_ENABLED=false）、停 listener，然后恢复已知 Worker/Web/Android 版本。Cron 会恢复补偿；无需删除新表或邮箱数据。保留迁移与 DO class 历史，后续 Wrangler 配置须保留已部署的 DO migration/binding 历史（可以用本版本关闭功能），不要直接用未包含 class 历史的旧 wrangler 配置部署。新增表和 Secret 仅在确认完全弃用后按备份/变更流程清理。
