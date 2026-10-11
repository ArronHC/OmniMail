// Renew immediately before index writes: a late IMAP response must not write after
// another execution has acquired the expired shared account lease.
const tables = new Set(['gmail_imap_accounts','microsoft_imap_accounts','qq_mail_accounts','naver_mail_accounts','yandex_mail_accounts'])
export async function renewAccountSyncLease(db: D1Database, table: string, accountId: string, leaseId: string) {
  if (!tables.has(table)) throw Error('Invalid sync lease table')
  const now = Math.floor(Date.now()/1000)
  const renewed = await db.prepare(`UPDATE ${table} SET sync_lease_until=?
    WHERE id=? AND sync_lease_id=? AND sync_lease_until>?`).bind(now+360,accountId,leaseId,now).run()
  if (!renewed.meta.changes) throw Error('sync_lease_lost')
}
