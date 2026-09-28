/**
 * MemoryOS · 开关账本（append-only jsonl）＋ 写侧权限 ＋ 状态派生
 *
 * 抄 dsh-selfevolve 的三点（血换来的）：
 *   ① 一次操作＝**追加一行**，且**唯一写通道**（"界面改了盘上没改"的病根就是写侧没有单一入口）；
 *   ② 读侧 fold 取最新、坏行跳过、读不到＝没有 override（fail-open：账本坏不拖垮功能）；
 *   ③ 每次判定现读 ⇒ 热生效不重启。
 * 加强三点（本机实证的缺口）：
 *   ① **写侧权限**（谁能切）在落盘前判，不在界面上装样子；
 *   ② **接管/锁定**：用户一旦接管，模型写侧被拒（可解除，历史不动）；
 *   ③ **状态派生六档**：planned / off / waiting（缺前置步骤）/ unavailable（缺硬依赖）/ degraded（缺可降级依赖）/ on。
 *      其中 `waiting` 是为"配置型功能"造的：开启＝一串动作，没做完就不能显示成"已生效"。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const LEDGER = 'switches.jsonl'

export function expandHome(p) {
  if (!p) return p
  if (!p.startsWith('~')) return p
  return join(process.env.HOME || process.env.USERPROFILE || '', p.slice(1))
}

export function switchFile(dataDir) {
  return join(expandHome(dataDir), LEDGER)
}

function readLines(f) {
  try { return readFileSync(f, 'utf8').split(/\r?\n/) } catch { return [] }
}

/** fold：同 key 取最新一行。返回 {rows, corrupt, file, mtime}。 */
export function foldLedger(dataDir) {
  const file = switchFile(dataDir)
  const rows = new Map()
  let corrupt = 0
  let mtime = 0
  try { mtime = existsSync(file) ? Math.floor(statSync(file).mtimeMs) : 0 } catch { /* 取不到当 0 */ }
  for (const line of readLines(file)) {
    const t = line.trim()
    if (!t) continue
    let o
    try { o = JSON.parse(t) } catch { corrupt++; continue }
    if (!o || typeof o !== 'object' || typeof o.key !== 'string') { corrupt++; continue }
    rows.set(o.key, o)
  }
  return { rows, corrupt, file, mtime }
}

/** 追加一行（唯一写通道）。返回真正落盘的那行。 */
export function appendSwitch(dataDir, row) {
  const dir = expandHome(dataDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const r = {
    key: row.key,
    value: !!row.value,
    by: row.by || 'user',
    reason: String(row.reason || '').slice(0, 400),
    ts: row.ts || new Date().toISOString(),
  }
  if (row.lock === true || row.lock === false) r.lock = row.lock
  appendFileSync(switchFile(dataDir), JSON.stringify(r) + '\n', 'utf8')
  return r
}

/**
 * 写侧权限（**落盘前**判；面板与模型走同一入口，谁都不能绕）。
 * @param {object} feature 登记表里那一条
 * @param {'user'|'llm'} by 写者
 * @param {object|null} prev 该 key 当前账行
 */
export function mayWrite(feature, by, prev) {
  if (!feature || !feature.id) return { ok: false, why: '没在登记表里——不登记＝不可切（见 lib/features.js）' }
  if (feature.impl === 'todo') return { ok: false, why: `「${feature.label}」代码尚未实现（impl=todo），不给切——面板开关不许骗人` }
  if (by !== 'llm') return { ok: true } // 用户永远能切自己机器上的东西（含接管/解除）
  if (feature.controller === 'user') return { ok: false, why: `「${feature.label}」登记为仅用户可切；模型不得改（要模型可控，改 features.js 的 controller）` }
  if (prev && prev.lock === true) return { ok: false, why: `「${feature.label}」已被用户接管（${prev.ts || ''}），模型改不动；要接手请在面板「解除接管」` }
  return { ok: true }
}

/** 生效值三级：账本最新行 > profile config > 登记表出厂默认。 */
export function effectiveValue(feature, cfgDefaults, ledgerRow) {
  if (ledgerRow && typeof ledgerRow.value === 'boolean') return { value: ledgerRow.value, source: 'ledger', row: ledgerRow }
  if (cfgDefaults && typeof cfgDefaults[feature.id] === 'boolean') return { value: cfgDefaults[feature.id], source: 'config' }
  return { value: !!feature.default, source: 'registry' }
}

/**
 * 状态派生（面板与工具的唯一口径）。**只派生不存储**。
 * @param {object} feature
 * @param {{value:boolean, source:string, row?:object}} eff
 * @param {Record<string,true|string>} depResult 依赖探针结果
 * @param {object} depMeta DEPS
 * @param {Record<string,{done:boolean,why?:string,ts?:string}>} stepResult 步骤就绪结果（配置型功能）
 * @param {object} stepMeta STEPS
 */
export function deriveState(feature, eff, depResult, depMeta, stepResult, stepMeta) {
  const missing = (feature.deps || []).map((d) => {
    const r = depResult[d]
    if (r === true) return null
    const meta = depMeta[d] || {}
    return { id: d, label: meta.label || d, note: meta.note || '', hard: !!meta.hard, why: typeof r === 'string' ? r : '' }
  }).filter(Boolean)
  const pending = (feature.steps || []).map((s) => {
    const r = (stepResult || {})[s] || { done: false, why: '探针未实现（STEPS 与 stepProbes 不同源）' }
    if (r.done) return null
    const meta = stepMeta[s] || {}
    return { id: s, label: meta.label || s, by: meta.by || 'llm', how: meta.how || '' }
  }).filter(Boolean)
  const done = (feature.steps || []).map((s) => {
    const r = (stepResult || {})[s]
    return r && r.done ? { id: s, ts: r.ts, ageDays: Number(r.ageDays || 0).toFixed(1) } : null
  }).filter(Boolean)

  const hardMissing = missing.filter((m) => m.hard)
  let state
  if (feature.impl === 'todo') state = 'planned'
  else if (!eff.value) state = 'off'
  else if (pending.length) state = 'waiting' // 该开，但前置动作没做完 ⇒ 绝不显示成"生效中"
  else if (hardMissing.length) state = 'unavailable'
  else if (missing.length) state = 'degraded'
  else state = 'on'

  const locked = !!(eff.row && eff.row.lock === true)
  return {
    state,
    value: eff.value,
    source: eff.source,
    by: eff.row ? (eff.row.by || 'user') : null,
    reason: eff.row ? eff.row.reason || '' : '',
    ts: eff.row ? eff.row.ts || '' : '',
    locked,
    missing,
    pending, // 面板据此显示"还差哪一步、该谁做、怎么做"
    stepsDone: done,
    operator: feature.controller, // 'user' | 'llm' | 'both'
    canUserToggle: feature.controller !== 'llm' && feature.impl !== 'todo',
    canLlmToggle: feature.controller !== 'user' && feature.impl !== 'todo' && !locked,
  }
}
