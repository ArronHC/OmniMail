# 实时同步审计与实施计划（阶段 A）

审计基线：本任务 `/workspace/OmniMail`，HEAD `024e150`；保留 ArronHC/OmniMail 的现有 checkout，不自动替换为文档中的上游仓库。生产资源未访问或更改。

## 现有完整链路与约束

| 来源 | 服务商 → Worker → D1 → 客户端 |
| --- | --- |
| Gmail | `index.scheduled → cleanup → enqueueDueGmailSyncs → MAIL_QUEUE → consumeGmailSyncJob → syncGmailAccount`；应用密码登录，EXAMINE INBOX，UIDVALIDITY 检查、UID 增量发现与最近 20 条状态刷新，最多 500 条元数据索引；Web GmailWorkspace 初始/手动加载，手动同步后短期等待并读取列表 |
| Microsoft | 相同调度链，`microsoftAccessToken` 独立 60 秒刷新租约，XOAUTH2 登录；列出文件夹并搜索 INBOX UID，再刷新最近索引；现有路径不是严格 UID 增量，需避免事件触发时重复下载全部元数据；Web MicrosoftWorkspace 从 D1 获取列表，单账号手动刷新可直接访问服务商 |
| QQ | 相同调度链，授权码登录、UIDVALIDITY/UID 增量发现与已有索引更新；附带同步审计；Web QqMailWorkspace 初始/手动列表加载与同步完成等待 |
| NAVER / Yandex | 各自独立凭据、IMAP 客户端和增量同步函数，独立 Queue job，不能推断支持 IDLE，运行时 CAPABILITY 检测 |
| 自建邮箱 | Email Routing → receiveEmail → R2 原文 + D1 → Queue 解析/索引，保持原实现 |

Cron 为 `*/5 * * * *`；各服务商 `next_sync_at` 通常为当前时间 +300 秒，调度每次最多 50 个账号；同步持有 360 秒账号租约。Queue `max_batch_timeout=2`，不保证固定投递延迟，失败指数退避。Gmail 手动入口另有手动冷却时间；事件不能通过修改 300 秒常量来实现。

现有原子 UPDATE 租约和 upsert 唯一键可复用。事件可跳过 `next_sync_at` 但必须保留同步租约、credential/permission error 检查、用户有效性和单账号事件限流。账号凭据修改当前会清空同步租约，可能与运行中任务发生竞争；应避免事件侧主动清空租约。异步任务需在执行前重新核对账号授权，不信任事件携带的 userId。延迟事件、删除账号、UIDVALIDITY 改变和租约过期都需要测试。

Web 主邮箱 `useAutoRefresh` 使用 Web Locks 选主、隐藏页暂停和最多 120 秒退避；第三方 Workspace 没有持续新邮件事件订阅。仅让 D1 提前同步不能让列表自动显示。Android `MailSyncWorker` 用 WorkManager 每 15 分钟运行，当前通知路径只查主邮箱；App 没有可依赖的后台秒级推送。第一期明确实现前台索引通知，后台保留原规则，不声称具备 FCM。

## 凭据威胁模型与方案

Cloudflare 主凭据密钥不离开 Worker。管理员注册可信监听设备（公钥、启用状态），服务间 HMAC 密钥通过 Secret 配置；用户逐账号明确授权给该设备。设备获取最小账号清单，逐账号请求短期有效 RSA-OAEP/AES-GCM 加密封装。VPS 使用本机受权限保护的私钥解密，邮箱登录材料只驻留内存，不缓存正文或附件，不记录邮箱密码/令牌。Microsoft 只分发访问令牌及过期时间，由 Worker 复用原 token refresh lease 刷新，refresh token 不离开 Cloudflare。

可信 VPS 被攻陷后，攻击者仍可盗取当前获授权 Gmail/QQ 长期登录材料；传输加密不能消除该风险。关闭设备、撤销逐账号授权、更换服务 HMAC key 并在服务商撤销应用密码，是必要的撤销边界。现有 IMAP 连接必须在清单撤销/凭据版本变更后及时关闭；最长撤销窗口由清单刷新间隔决定，不能宣称即时撤销已泄露的服务商密码。

服务调用使用签名原始请求体、方法、路径、时间戳、nonce、key id；验签先于数据库业务查询，D1 唯一 nonce 防重放，旧 key 可有限时间轮换。默认关闭；只有有效用户、有效账号、已授权设备可触发事件或领取凭据。

## 实施模块

1. 新增 `features/realtime`、D1 迁移：设备、用户授权、nonce、事件合并任务和延迟记录；独立服务路由与普通用户/管理员路由分离。
2. 为事件建立持久任务和 Queue 兜底；HTTP 快速路径与 Queue 共享任务租约，服务商同步继续使用原账号互斥；Cron 恢复未完成事件，已有定时补偿保持工作。
3. 新增 `realtime-listener/` Node + TypeScript + ImapFlow：CAPABILITY/IDLE 检测、只读 INBOX、连接上限、debounce、有限指数退避、鉴权失败冷却、OAuth 更新、撤销、健康检查、Docker 交付。
4. 用每用户 Durable Object WebSocket hibernation 发布索引变化，无邮件时避免周期 D1 查询；Web 可见标签选主并广播变化，静默读取当前过滤列表；Android 只在前台订阅，后台推送列为独立 FCM 部署前提。
5. 新增最小授权/管理界面、延迟测量工具、安全/成本/部署/回滚文档与自动化覆盖。每阶段提交，不修改生产资源。

官方替代方案：Gmail watch + Pub/Sub、Microsoft Graph change notifications 能减少 VPS 长期密码暴露，但要求 Gmail/Graph API OAuth consent、订阅续期和新索引协议，无法直接覆盖当前应用密码账号及 QQ。作为后续可选适配器，第一期保留当前账号兼容性并采用 IMAP IDLE。10 秒是待实测目标，IMAP 服务商延迟、Queue 负载、网络、浏览器后台和 Android 后台策略都可能使其不可达。
