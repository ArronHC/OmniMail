import { chromium } from '@playwright/test'
import { readFileSync, appendFileSync, statSync, existsSync } from 'node:fs'

// Observe the actual Web UI and its existing socket; adds no polling API requests.
const [url, stateFile, arrivalsFile, outputFile] = process.argv.slice(2)
if (!outputFile) throw Error('Usage: node scripts/realtime-probe.mjs HTTPS_WORKSPACE_URL STORAGE_STATE ARRIVALS_JSONL OUTPUT_JSONL')
if (new URL(url).protocol !== 'https:') throw Error('Production probe requires HTTPS')
if (statSync(stateFile).mode & 0o077) throw Error('Storage state must have mode 0600')
const targets = readFileSync(arrivalsFile,'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s))
if (!targets.length || new Set(targets.map((t) => t.id)).size!==targets.length) throw Error('Unique sample ids required')
for (const target of targets) if (typeof target.subject!=='string' || !target.subject || !target.accountId || !target.provider) throw Error('Subject, provider and accountId required')
const browser = await chromium.launch({ headless: process.env.PROBE_HEADED!=='true', ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}) })
try {
  const context = await browser.newContext({ storageState: stateFile })
  const page = await context.newPage()
  const events = []
  page.on('websocket',(socket) => socket.on('framereceived',({payload}) => {
    try { const event = JSON.parse(String(payload)); if(event.type==='indexed' && event.measurementId) events.push({...event,clientDiscoveredAt:Date.now()}) } catch { /* Ignore heartbeat/non-JSON frames. */ }
  }))
  await page.goto(url)
  const completed = new Set(existsSync(outputFile) ? readFileSync(outputFile,'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s).id) : [])
  const deadline = Date.now()+Number(process.env.PROBE_TIMEOUT_MS || 600000)
  while (Date.now()<deadline && targets.some((target) => !completed.has(target.id))) {
    for(const target of targets) {
      if(completed.has(target.id)) continue
      const frames = events.filter((e) => e.provider===target.provider && e.accountId===target.accountId)
      const event = frames.at(-1)
      if(!event) continue
      if(await page.getByText(target.subject,{exact:true}).first().isVisible()) {
        // Use independently confirmed provider delivery time; message Date is not arrival time.
        const arrivals = readFileSync(arrivalsFile,'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s))
        const current = arrivals.find((r) => r.id===target.id)
        if(!Number.isSafeInteger(current?.arrivedAt)) continue
        const record = {id:target.id,source:'real',provider:target.provider,accountId:target.accountId,arrivedAt:current.arrivedAt,
          detectedAt:event.detectedAt,receivedAt:event.receivedAt,indexedAt:event.indexedAt,clientDiscoveredAt:event.clientDiscoveredAt,visibleAt:Date.now(),measurementId:event.measurementId,correlation:'account_batch'}
        appendFileSync(outputFile,JSON.stringify(record)+'\n',{mode:0o600})
        completed.add(target.id)
        console.log(JSON.stringify({event:'probe_visible',id:target.id,measurementId:event.measurementId}))
      }
    }
    await page.waitForTimeout(100) // DOM observation only; no HTTP polling.
  }
  if(targets.some((t) => !completed.has(t.id))) throw Error('Probe timed out; unfinished samples are not successes')
} finally { await browser.close() }
