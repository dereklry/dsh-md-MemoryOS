/**
 * MemoryOS · Key 存放（凭据面优先 + 仓内守卫）
 *
 * 结论（2026-09-28 定）：**Key 的正家 = 宿主凭据面 `ctx.credentials`，ref 名 `JEV_API_KEY`**。
 * 为什么是它，三条都是可查的事实：
 *   ① 物理位置 `~/.dsh/.credentials.yaml` —— **不在任何 git 工作树里**，所以"手一抖 add -A 就推上 GitHub"这条路从根上不存在
 *      （现实里常见的是反过来：明文 Key 就躺在某个会推的仓里，全靠 `.gitignore` 一行挡着）；
 *   ② 提供方 `@deepseek-ai/dsh-credentials-local` 以 **mode 0600 原子重建**该文件，且有文件锁；
 *   ③ 它在用户目录，**不随 app 升级被替换**（升级动的是 `resources\app` 与 profile 组合，DEEPSEEK_API_KEY 等 ref 一直活着）。
 *
 * 读序（先宿主、再环境、再显式文件；每步都说清"从哪来的"）：
 *   credentials.describe/resolve('JEV_API_KEY') → env JEV_API_KEY / TYPESAFE_API_KEY
 *   → config.keyFile → 仓内遗留位（**读到就在面板上标警**，提醒搬家）
 * 写序：能走 credentials 就走 credentials；写文件必须先过 **insideRepo 守卫**
 *   （落在某个 .git 工作树里 → 拒，除非 profile 显式 allowKeyInRepo=true）。
 *
 * 明文纪律：明文**只在本机内存里过一下**——不进快照、不进账本、不进日志、不进返回值；
 * 对外只出现 `masked()`（长度 + 头尾各几位）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, parse, dirname } from 'node:path'
import { maskKey } from './setup.js'

export const KEY_REF = 'JEV_API_KEY'

/** 目录里有没有 .git（含 worktree 的 .git 文件）——向上走到盘根为止。 */
export function insideRepo(p) {
  try {
    let cur = dirname(p)
    for (let i = 0; i < 12 && cur && cur !== parse(cur).root; i++) {
      if (existsSync(join(cur, '.git'))) return cur
      cur = dirname(cur)
    }
  } catch { /* 判不了当"不在仓里"，但写入路径仍会另行提示 */ }
  return ''
}

/**
 * @param {{cfg:object, getCredentials?:()=>any, log?:Function}} deps
 *   getCredentials 每次现取（宿主 Service 可能晚到；取不到就退回 env/文件，功能不炸）。
 */
export function makeKeystore(deps) {
  const cfg = deps.cfg
  const getCredentials = deps.getCredentials || (() => undefined)

  async function fromCredentials() {
    const creds = getCredentials()
    if (!creds || typeof creds.describe !== 'function') return null
    try {
      const d = await creds.describe(KEY_REF)
      if (!d || !d.configured) return null
      let value = ''
      if (typeof creds.resolve === 'function') {
        const r = await creds.resolve(KEY_REF)
        value = (r && (r.value || r.secret)) || ''
      }
      return { from: `宿主凭据面（${KEY_REF}${d.source ? ' · ' + d.source : ''}）`, value, writable: d.writable !== false, via: 'credentials' }
    } catch { return null } // 凭据面坏了不能连累插件
  }

  function fromEnv() {
    const v = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || ''
    return v && v.trim() ? { from: '环境变量 JEV_API_KEY/TYPESAFE_API_KEY', value: v.trim(), writable: false, via: 'env' } : null
  }

  function fromFile() {
    const cands = [
      cfg.keyFile ? { path: cfg.keyFile, from: 'config.keyFile' } : null,
      { path: join(cfg.dataDir, 'jev-key.txt'), from: '插件数据目录' },
      { path: join(cfg.home || '', 'memoryos.key'), from: '~/.dsh/memoryos.key' },
      // 兼容读：别人/旧部署可能把 Key 放在仓里 —— 读到就用，但一定要在面板上标警（本机现状就是这种）
      ...(cfg.legacyKeyFiles || []).map((p) => ({ path: p, from: '遗留位（建议搬家）' })),
    ].filter(Boolean)
    for (const c of cands) {
      try {
        if (c.path && existsSync(c.path)) {
          const v = readFileSync(c.path, 'utf8').trim()
          if (v) return { ...c, value: v, writable: true, via: 'file' }
        }
      } catch { /* 换下一候选 */ }
    }
    return null
  }

  /** 只报"有没有、从哪来、能不能写、要不要搬家"——**不含明文**。 */
  async function locate() {
    const found = (await fromCredentials()) || fromEnv() || fromFile()
    if (!found) {
      return {
        present: false, ref: KEY_REF,
        hint: `还没有 Key。首选：设置面板里存进宿主凭据面（ref=${KEY_REF}）；或让模型代存：memoryos_setup action=save-key`,
        warnings: [],
      }
    }
    const warnings = []
    const asString = String(found.value || '')
    if (found.via === 'file') {
      const repo = insideRepo(found.path)
      if (repo) warnings.push(`⚠ Key 文件在 git 工作树内（${repo}）——一旦忘了 ignore 就会被推走。请搬进凭据面或 ~/.dsh/ 下，并到该仓确认它已被忽略`)
      else warnings.push(`Key 走的是文件回退（${found.path}）。建议改存宿主凭据面 ref=${KEY_REF}（0600、不随升级动、不进任何仓）`)
    }
    return { present: true, ref: KEY_REF, from: found.from, via: found.via, path: found.path || '', writable: found.writable !== false, masked: maskKey(asString), warnings }
  }

  /** 取明文（只给本进程内的一次请求用；调用方**不得**把它写进任何返回值/日志/账本）。 */
  async function secret() {
    const found = (await fromCredentials()) || fromEnv() || fromFile()
    return found ? String(found.value || '') : ''
  }

  /** 存 Key。能走凭据面就走；走文件必先过 insideRepo 守卫。 */
  async function save(key, opts = {}) {
    const k = String(key || '').trim()
    if (!k) return { ok: false, message: '没给 Key（空）' }
    if (/\s/.test(k)) return { ok: false, message: 'Key 里有空白字符，像是粘贴不完整（多行或带空格）' }
    const creds = getCredentials()
    if (!opts.preferFile && creds && typeof creds.set === 'function') {
      try {
        await creds.set(KEY_REF, k)
        return { ok: true, to: `宿主凭据面 ref=${KEY_REF}`, masked: maskKey(k), via: 'credentials' }
      } catch (e) {
        if (!opts.allowFileFallback) return { ok: false, message: `凭据面写入失败：${String((e && e.message) || e)}（要落文件请给 allowFileFallback，且目标不能在 git 仓里）` }
      }
    }
    const target = opts.path || join(cfg.dataDir, 'jev-key.txt')
    const repo = insideRepo(target)
    if (repo && !opts.allowInRepo && !cfg.allowKeyInRepo) {
      return { ok: false, message: `拒写：目标在 git 工作树内（${repo}）——一旦忘了 ignore 就会被推走。要么用宿主凭据面 ref=${KEY_REF}，要么把路径挪到 ~/.dsh 下；确实要放仓里请传 allowInRepo（或 profile 里 allowKeyInRepo=true，不推荐）` }
    }
    try {
      const dir = dirname(target)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(target, k + '\n', { encoding: 'utf8', mode: 0o600 })
      return { ok: true, to: target, masked: maskKey(k), via: 'file', inRepo: !!repo }
    } catch (e) {
      return { ok: false, message: `写入失败：${String((e && e.message) || e)}` }
    }
  }

  async function forget() {
    const creds = getCredentials()
    if (creds && typeof creds.unset === 'function') {
      try { await creds.unset(KEY_REF) } catch { /* 继续清文件 */ }
    }
    for (const p of [cfg.keyFile, join(cfg.dataDir, 'jev-key.txt')]) {
      try { if (p && existsSync(p)) writeFileSync(p, '', { encoding: 'utf8' }) } catch { /* 尽力 */ }
    }
    return { ok: true, message: '已尝试清除凭据面 ref 与文件回退位（明文不留副本）' }
  }

  return { locate, secret, save, forget, ref: KEY_REF }
}
