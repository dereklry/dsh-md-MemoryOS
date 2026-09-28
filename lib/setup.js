/**
 * MemoryOS · 配置账本（setup.jsonl）与"测通"动作
 *
 * 为什么要有这一本：**"开启"有时不是一个布尔，是一串动作做完了没有**。
 * 例：Jev 能力＝Key 到位 → 真发一次请求测通 → 才有资格说"已生效"。
 * 光把配置改成 true 是**假开**（功能其实不通，每回合还白烧账），所以：
 *   · 测通结果落账（成功/失败/延迟/错误摘要），有时效（默认 7 天，过期回退成"待重测"）；
 *   · 功能状态因此多一档 `waiting`（该开，但前置步骤没做完；面板显示"还差哪一步、该谁做"）；
 *   · 明文 Key **永不进账本、永不进日志**，只记掩码与落点。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { expandHome } from './switches.js'

export function setupFile(dataDir) {
  return join(expandHome(dataDir), 'setup.jsonl')
}

/** 追加一条配置事实（测通结果、代存 Key 等）。一次动作＝一行账，历史不改写。 */
export function recordSetup(dataDir, row) {
  const dir = expandHome(dataDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const r = {
    step: String(row.step || ''),
    ok: !!row.ok,
    ts: row.ts || new Date().toISOString(),
    by: row.by || 'llm',
    ...(row.note ? { note: String(row.note).slice(0, 300) } : {}),
    ...(typeof row.latencyMs === 'number' ? { latencyMs: row.latencyMs } : {}),
    ...(row.reason ? { reason: String(row.reason).slice(0, 300) } : {}),
    ...(row.masked ? { masked: String(row.masked) } : {}),
  }
  appendFileSync(setupFile(dataDir), JSON.stringify(r) + '\n', 'utf8')
  return r
}

/** fold：每个 step 取最新一行（与开关账本同口径；坏行只计数不炸）。 */
export function foldSetup(dataDir) {
  const file = setupFile(dataDir)
  const rows = new Map()
  let corrupt = 0
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t)
        if (o && typeof o.step === 'string') rows.set(o.step, o)
        else corrupt++
      } catch { corrupt++ }
    }
  } catch { /* 没有账本＝什么都没配过，属正常 */ }
  return { rows, corrupt, file }
}

/** 某步骤"最近 maxAgeDays 天内是否成功过"。返回 {done, why|ts}，供状态派生与面板显示。 */
export function stepSatisfied(rows, step, maxAgeDays) {
  const r = rows.get(step)
  if (!r) return { done: false, why: '从没做过' }
  if (!r.ok) return { done: false, why: `上次失败：${r.note || '无说明'}（${String(r.ts || '').slice(0, 19)}）` }
  let age = 0
  try { age = (Date.now() - Date.parse(r.ts)) / 86400000 } catch { return { done: false, why: '账目时间戳读不懂' } }
  if (maxAgeDays > 0 && age > maxAgeDays) return { done: false, why: `上次成功是 ${age.toFixed(1)} 天前（> ${maxAgeDays} 天）→ 该重测了` }
  return { done: true, ts: r.ts, ageDays: age }
}

/** 掩码：只回"多长 + 头尾几位"，明文永不外流。 */
export function maskKey(k) {
  const s = String(k || '')
  if (!s) return ''
  return s.length <= 8 ? `（${s.length} 位，太短？）` : `${s.slice(0, 3)}…${s.slice(-4)}（${s.length} 位）`
}

/**
 * 把 Key 写进文件（仅当用户明确让模型代存）。返回值**不含明文**。
 * mode 0600 尽力而为（Windows 上权限语义有限，失败不算错）。
 */
export function saveKey(file, key) {
  const k = String(key || '').trim()
  if (!k) return { ok: false, message: '没给 Key（空）' }
  if (/\s/.test(k)) return { ok: false, message: 'Key 含空白字符，疑似粘贴不完整（多行或带空格）' }
  const path = expandHome(file)
  try {
    const dir = path.replace(/[\\/][^\\/]*$/, '')
    if (dir && dir !== path && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, k + '\n', { encoding: 'utf8', mode: 0o600 })
    return { ok: true, path, masked: maskKey(k), bytes: k.length }
  } catch (e) {
    return { ok: false, message: `写入失败：${String((e && e.message) || e)}`, path }
  }
}

/**
 * 真发一次极小 Jev 请求测通。
 * 注意：**不用 fetch**——本机实测 Electron-as-node 里 `fetch`/`AbortSignal.timeout` 会静默失败，
 * 走 node:https 才可靠。transport 可注入 ⇒ 闸与 CI 不联网也能跑完整链路。
 */
export async function probeJev(opts = {}) {
  const key = String(opts.key || '').trim()
  if (!key) return { ok: false, note: '没有 Key，测通无从谈起（先设 env JEV_API_KEY，或 memoryos_setup(action=save-key)）' }
  const baseUrl = String(opts.baseUrl || 'https://api.typesafe.ai').replace(/\/+$/, '')
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 6000
  const body = JSON.stringify({
    model: opts.model || 'jev-latest',
    state: 'MemoryOS connectivity probe. Answer the single question.',
    questions: { probe: { type: 'choice', instructions: 'Which option is the larger integer?', criteria: { big: 'the larger one', small: 'the smaller one' } } },
  })
  const send = opts.transport || defaultTransport
  const t0 = Date.now()
  try {
    const r = await send(`${baseUrl}/v1/systemone`, body, { key, timeoutMs })
    const latencyMs = Date.now() - t0
    if (r.status !== 200) return { ok: false, latencyMs, note: `HTTP ${r.status}：${String(r.text || '').slice(0, 160)}` }
    let data = null
    try { data = JSON.parse(r.text || '{}') } catch { return { ok: false, latencyMs, note: '返回不是 JSON（上游或代理异常）' } }
    const ans = data && data.answers && data.answers.probe
    if (!ans) return { ok: false, latencyMs, note: '返回里没有 answers.probe（协议变了？）' }
    return { ok: true, latencyMs, note: `choice=${ans.choice || '?'} conf=${typeof ans.confidence === 'number' ? ans.confidence.toFixed(2) : '?'}` }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, note: `请求失败：${String((e && e.message) || e).slice(0, 180)}` }
  }
}

/** 默认传输：node:https / node:http。 */
function defaultTransport(url, body, auth) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'http:' ? httpRequest : httpsRequest
    const req = lib(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.key}`, 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode || 0, text }))
    })
    req.setTimeout(auth.timeoutMs, () => req.destroy(new Error(`超时 ${auth.timeoutMs}ms`)))
    req.on('error', reject)
    req.end(body)
  })
}
