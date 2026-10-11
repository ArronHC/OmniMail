// Planning assumptions, not billed usage. See docs/realtime/COST.md.
export function estimateCost(mailboxes, mailsPerDay) {
  const arrivals = mailboxes * mailsPerDay * 30
  const compensation = mailboxes * 48 * 30
  const connections = mailboxes * 2880
  const jobs = arrivals + compensation + mailboxes * (30+720/3)
  const service = 43200 + arrivals + mailboxes * (2*720/3 + 60)
  const requests = service + jobs + jobs*3 + connections*4 + 8640
  const queueOps = jobs*3
  const reads = 43200*(4*mailboxes+5) + jobs*200 + arrivals*30 + connections*100
  const writes = 43200*5 + jobs*100 + arrivals*10 + mailboxes*(2*720/3+60)*5
  const cpuMs = requests*2 + jobs*10
  const doRequests = jobs*2 + connections
  const extra = Math.max(0,requests-10e6)*.30/1e6 + Math.max(0,cpuMs-30e6)*.02/1e6
    + Math.max(0,queueOps-1e6)*.40/1e6 + Math.max(0,reads-25e9)*.001/1e6
    + Math.max(0,writes-50e6)/1e6 + Math.ceil(Math.max(0,doRequests-1e6)/1e6)*.15
  return { mailboxes, mailsPerDay, arrivals, requests, cpuMs, queueOps, reads, writes, doRequests, extra: +extra.toFixed(2), workersMinimum: 5, total: +(5+extra).toFixed(2) }
}
if (process.argv[1]?.endsWith('realtime-cost.mjs')) {
  for (const n of [5,10,20,50]) for (const mails of [5,50,500]) console.log(JSON.stringify(estimateCost(n,mails)))
}
