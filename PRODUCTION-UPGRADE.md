# omni-mail 原实例升级

依据用户提供的 Cloudflare 配置快照准备；本会话未直接访问生产账户。当前 Worker 没有 Git 自动构建，采用 Wrangler CLI。下面的查询、备份、迁移和发布命令尚未在生产执行。

配套配置已于 2026-10-11 通过本地 Wrangler dry-run，使用已有构建产物。打包输出确认 D1 ID、两个 R2 桶和 Queue 名称与上述快照一致；这不是远程绑定、生产权限或迁移状态验证。

用户随后提供了线上迁移查询结果，已逐项与仓库比较：39 条已执行记录全部对应仓库文件，无未知记录，唯一待执行文件为 `0041_realtime_sync.sql`。编号 `0032` 在主线保留跳过，这是正常状态，无需补执行。此结论依据用户提供的查询结果，并非本会话直接查询生产。

`0041` 创建 5 张新的实时同步表和 5 个索引，不 ALTER/DROP 既有表，不改写既有邮件数据。缺失 `0018` 才触发的旧库 bootstrap 在本次提供的记录中不适用。

## 固定部署目标

- Worker：`omni-mail`
- D1 `DB`：`12aa9b65-a0fc-4488-8c5e-ba73b3b12aec`
- R2 `MAIL_BUCKET`：`omni-mail-mail-bucket`
- R2 `BACKUP_BUCKET`：`omni-mail-backups`
- Queues：`omnimail-mail`、`omnimail-notifications`，保留原死信队列配置。
- Workflows：`omni-mail-backup`、`omni-mail-cleanup`
- Cron：`*/5 * * * *`

快照未包含 Queue 消费参数和死信队列绑定；配套配置沿用仓库现有值，发布前须核对线上消费者及 `omnimail-mail-dead` / `omnimail-notifications-dead` 队列。若曾自定义，应合并现有值而不是覆盖。实际域名/Email Routing 和账户 ID 也尚未核验。

配套 `wrangler.production-upgrade.jsonc` 应放到 OmniMail 项目根目录；其相对路径按该位置编写。新增 `RealtimeUpdates` SQLite Durable Object 及 `realtime-v1` migration，`REALTIME_ENABLED=false`。保留现有变量的 `keep_vars=true`。配置不包含任何 Secret 值。

## 准备代码

当前远端 main 为 `024e15035a1b29a9b0960d1dd3343dbaf052d39f`，本次改动终点为 `bd21cb58d5ed94b677c5570b9fa069382aae8940`，5 个提交尚未推送。配套 `omnimail-realtime-upgrade.patch` 包含这 5 个提交，可在独立本地分支应用。先确认生产使用版本；Cloudflare 的 Version 8 是部署序号，并不能证明数据库迁移版本或源码版本。

```bash
git clone https://github.com/ArronHC/OmniMail.git
cd OmniMail
git switch -c realtime-upgrade
git am /secure/path/omnimail-realtime-upgrade.patch
```

如 main 已更新或有自定义改动，先处理差异，不能强制覆盖。将配套配置复制到当前项目根目录。CLI 可直接发布此分支的代码，不要求先推送 GitHub。

## 登录、读取迁移状态、备份

以下在持有生产权限的安全机器中执行。账户 ID 要取自当前 Worker 所属 Cloudflare 账户，而不是数据库 ID；不要把 Token 或 Secret 放进命令文本或 Git。

```bash
npm ci
npx wrangler login
export CLOUDFLARE_ACCOUNT_ID='填写现有Worker所属账户ID'
npx wrangler whoami
npx wrangler d1 execute DB --remote --config wrangler.production-upgrade.jsonc --command 'SELECT name FROM d1_migrations ORDER BY name' --json
```

先审查查询结果与仓库 `migrations/` 的差异。若现有数据库已完成 `0040`，本次仅缺 `0041_realtime_sync.sql`，它只新增实时同步表和索引。较旧部署可能还有其他待执行迁移，不能把它们一概视为只新增表；没有迁移记录或存在不同名称的同类迁移时，应先核对实际表结构。该查询报错时先停止，勿用初始化操作代替核对。

```bash
umask 077
mkdir -p ../omnimail-production-backup
npx wrangler d1 export DB --remote --config wrangler.production-upgrade.jsonc --output ../omnimail-production-backup/before-realtime.sql
npx wrangler versions list --config wrangler.production-upgrade.jsonc
```

确认 SQL 导出成功，安全保管；它可能包含用户信息与加密凭据。记录当前活动部署与完整版本 ID、资源绑定、域名路由及配置。R2 邮件/附件继续使用原桶；如需完整灾难恢复，另用既有备份流程备份 R2 对象，D1 导出不包含这些对象。

保留 `MAIL_CREDENTIALS_KEY`、`TOTP_ENCRYPTION_KEY`、Resend Secrets、已有服务商加密密钥和 OAuth 配置。配置不上传或重新生成这些 Secret。Secret 值无需提供给本会话。

## 构建与发布

完成上述核对及备份后执行。最后一条会写入生产 D1 并发布 Worker：

```bash
npm run build
npm run deploy -- --dry-run --config wrangler.production-upgrade.jsonc
npm run deploy -- --config wrangler.production-upgrade.jsonc
```

项目部署脚本读取实际线上 DB 绑定，与配置中固定的数据库 ID 比较；不一致时停止。然后应用缺失迁移，再发布 Web 与 Worker。迁移成功但发布失败时，先查明原因再重跑，不要删除旧数据。dry-run 只校验打包，不证明生产权限、当前绑定、数据库结构和资源状态正确。

## 升级后核对

确认 owner 登录、历史邮件及附件可读、主邮箱收发、原第三方邮箱同步、TOTP 登录（若已启用）正常；核对原域名/Email Routing 及 Queue 消费配置。实时开关保持关闭，无需先配置 VPS。已有 Android 令牌如缺少新增第三方只读权限，需要重新登录。

基础功能验证后，再按仓库 `docs/realtime/DEPLOYMENT.md` 部署 VPS、上传独立服务 Secret、注册设备，并逐邮箱授权；不能只开总开关就认为实时收信已经生效。

## 故障处理

先关闭实时功能并停监听器。保留新增 D1 表，避免删除邮件数据。记录的旧 Worker 版本可能不包含新 Durable Object，因此不能把普通旧版本回滚当作已经验证的无条件恢复方式；应保留已部署的 DO 迁移/binding 历史，准备兼容的新发布配置。完整数据库恢复会覆盖备份后的新增数据，必须另行评估，不能自动执行。
