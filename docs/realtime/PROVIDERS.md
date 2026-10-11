# 服务商适配与验证边界

| 服务商 | 监听认证和主机 | 服务商差异与回退 |
|---|---|---|
| Gmail / Workspace | `imap.gmail.com:993`，原有应用密码 | 管理员/安全策略可能禁用应用密码或 IMAP；官方建议控制单账号并发连接（常见上限 15），本服务只占一个监听连接，但须计入其他客户端和 Worker 短连接。Workspace 管理策略优先。 |
| Outlook / Hotmail / M365 | `outlook.office365.com:993`，XOAUTH2 | Worker 复用 token refresh lease；VPS 仅获 access token，过期前 90 秒断开并重新获取。租户须允许 IMAP 和相应委托 OAuth scope；不使用已弃用的 basic auth。具体连接/限流由租户策略决定。 |
| QQ | `imap.qq.com:993`，独立授权码 | 用户先启用 IMAP；不能使用普通登录密码。以连接实际 CAPABILITY 为准，不承诺所有 QQ 账号均支持可靠 IDLE。 |
| NAVER | `imap.naver.com:993`，项目现有登录材料 | 用户启用 IMAP，双重验证可能需要应用密码；逐连接检测 IDLE。 |
| Yandex | `imap.yandex.com:993`，项目现有应用密码 | 账号允许 IMAP/应用密码后连接；逐连接检测 IDLE。 |

所有连接强制 TLS 验证、只读 INBOX；只有运行时 CAPABILITY 包含 IDLE 才进入 IDLE。无 IDLE 时按默认 300 秒发补偿事件，不宣称 10 秒。监听只观察 INBOX 新邮件；移动到其他文件夹、历史已读状态等由原有补偿路径校验，不将 EXISTS 等同于准确的新邮件数量。

Microsoft 事件入口使用现有文件夹 UID 索引，只下载新 UID 和最近 20 条状态；仍有 UID 搜索和文件夹枚举，因此大邮箱索引查询成本不是常数。其他四个服务商沿用各自 UIDVALIDITY、增量游标及唯一索引，未把固定冷却改成高频轮询。历史缺口/UIDVALIDITY 重置可能超过一次有界扫描量，依赖后续补偿，首次导入不属于正常 10 秒目标。

单设备默认 20 条连接，可配置最多 100；Worker 默认最多 50 条授权（最多 100）。超过监听容量的授权不获 IDLE 健康状态，继续 Cron。不同设备不得用同一个账号重复授权，数据库 `UNIQUE(provider,account_id)` 限制；用户已有外部邮件客户端占用的连接不受本服务控制。

错误登录至少约 12–18 分钟后重试，网络重试从约 4–6 秒增长至约 4–6 分钟。每个账号独立定时器，异常不阻塞其他账号。清单每 60 秒刷新，两次失败后关闭现有连接；重启先取得新清单再恢复，重连提交补偿事件。

已运行：真实 TLS Mock IMAP + ImapFlow IDLE 事件、断线重连、授权/凭据变更、错误认证退避、无 IDLE 回退；Worker 中真实 D1 Gmail 增量写入和 Microsoft OAuth 更新测试。尚未运行：上述五家生产 IMAP 的 CAPABILITY/限流/多轮真实收件，以及 Android 实机后台通知。部署者必须逐账号验收，不依据这份表推断已实测能力。

官方参考（部署时重新核对）：

- [Google IMAP 文档](https://developers.google.com/gmail/imap/imap-smtp) 与 [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push)：watch + Pub/Sub 避免 VPS 持有应用密码，但须迁移现有账号的 OAuth 权限并续期 watch。
- [Microsoft IMAP OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth) 与 [Graph change notifications](https://learn.microsoft.com/en-us/graph/change-notifications-overview)：Graph 可作为后续事件适配器，但需要新增 Graph 权限、订阅续期和索引协议。
- [QQ 帮助](https://service.mail.qq.com/)、[NAVER 帮助](https://help.naver.com/service/5632)、[Yandex IMAP](https://yandex.com/support/yandex-360/customers/mail/en/mail-clients/others)。未硬编码未经验证的这些服务商连接数量上限。
