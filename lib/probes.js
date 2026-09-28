/**
 * MemoryOS · 探针（纯本地：fs/env，零网络、不起进程）
 *
 * 两类探针，别混：
 *   `probes`     ＝**依赖**是否在场（环境事实，如"有没有 python"）→ 决定 unavailable / degraded
 *   `stepProbes` ＝**配置型功能的动作**做过没有（如 Jev 是否测通过）→ 决定 waiting
 *
 * 返回口径（deriveState 依赖它，别乱改）：
 *   true            正常／已满足
 *   false           缺失（无细节）
 *   非空字符串      缺什么、去哪改、谁来做 —— 面板与工具直接显示这句人话
 *
 * 同源纪律：DEPS 每个键都要有探针、STEPS 每个键都要有步骤探针，**闸锁双向**
 * （漏一个的后果是面板永远显示"探针未实现"，比报错更难查）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { foldSetup, stepSatisfied } from './setup.js'

export function envOf(k) {
  const v = process.env[k]
  return typeof v === 'string' && v.trim() ? v.trim() : ''
}

/** Key 发现链（与 dsh-jev / md_kernel 同口径：env 优先，其次显式文件，最后数据目录）。 */
export function findKeyFile(cfg) {
  const cands = [
    envOf('JEV_KEY_FILE') ? { path: envOf('JEV_KEY_FILE'), from: 'env JEV_KEY_FILE' } : null,
    cfg.keyFile ? { path: cfg.keyFile, from: 'config.keyFile' } : null,
    { path: join(cfg.dataDir, 'jev-key.txt'), from: '数据目录默认位' },
  ].filter(Boolean)
  for (const c of cands) {
    try {
      if (c.path && existsSync(c.path) && readFileSync(c.path, 'utf8').trim()) return { ...c, value: readFileSync(c.path, 'utf8').trim() }
    } catch { /* 换下一候选 */ }
  }
  const envKey = envOf('JEV_API_KEY') || envOf('TYPESAFE_API_KEY')
  if (envKey) return { path: '', from: 'env JEV_API_KEY/TYPESAFE_API_KEY', value: envKey }
  return null
}

export function makeProbes(cfg, runtime, opts = {}) {
  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : 5000
  const freshDays = Number(opts.setupFreshDays) > 0 ? Number(opts.setupFreshDays) : 7
  const cache = new Map()
  // 记忆根＝profile 基线 ∪ 资料面账本增量（面板加的目录也算数，否则"加了根还说没根"）
  const rootsOf = () => (typeof cfg.rootsOf === 'function' ? cfg.rootsOf() : cfg.memoryRoots) || []
  const cached = (key, fn) => {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.v
    let v
    try { v = fn() } catch (e) { v = `探测异常：${String((e && e.message) || e).slice(0, 140)}` }
    cache.set(key, { at: Date.now(), v })
    return v
  }
  const isDir = (p) => { try { return !!p && statSync(p).isDirectory() } catch { return false } }

  const graphCandidates = () => (cfg.graphDb ? [cfg.graphDb] : rootsOf().map((r) => join(r, 'ledger_graph.db'))).filter(Boolean)
  const findGraph = () => cached('graph', () => graphCandidates().find((p) => { try { return existsSync(p) } catch { return false } }) || '')

  return {
    invalidate: () => cache.clear(),

    // ---------------- 依赖探针（DEPS 同源）
    probes: {
      'webserver': () => (runtime && runtime.webserver === true ? true : '宿主未提供 webServer（headless profile 或它还没起来）→ 面板取不到数；插件其余功能照常'),
      'memory-root': () => cached('roots', () => {
        const roots = rootsOf().filter(Boolean)
        if (!roots.length) return '未设置记忆根：profile 的 config.memoryRoot 给一个目录（env MD_MEMORY_ROOTS 亦可），或在面板「资料面」页添加目录'
        const ok = roots.filter(isDir)
        if (!ok.length) return `记忆根都不存在：${roots.join('  |  ')}`
        if (ok.length < roots.length) return `部分记忆根不存在，已跳过：${roots.filter((r) => !ok.includes(r)).join('  |  ')}`
        return true
      }),
      'graph-db': () => cached('graphdb', () => {
        const f = findGraph()
        if (!f) return `没找到指针图库（试过：${graphCandidates().join('  |  ') || '无可试路径'}）→ 跑一次 build`
        let days = 0
        try { days = (Date.now() - Math.floor(statSync(f).mtimeMs)) / 86400000 } catch { return '图库存在但读不到时间' }
        if (days > cfg.staleDays) return `图水位 ${days.toFixed(1)} 天前（阈值 ${cfg.staleDays} 天）→ 结果可能过期，建议 rebuild`
        return true
      }),
      'python': () => cached('py', () => {
        if (cfg.pythonBin) return existsSync(cfg.pythonBin) ? true : `config.pythonBin 指向的位置不存在：${cfg.pythonBin}`
        const repo = cfg.kernelRepo || ''
        const guesses = repo ? [join(repo, 'python', '.venv', 'Scripts', 'python.exe'), join(repo, 'python', '.venv', 'bin', 'python')] : []
        if (guesses.some((p) => existsSync(p))) return true
        return '没找到可用 Python：给 config.pythonBin（或 env MD_PYTHON_BIN）。实测内核读面纯标准库，系统 Python 3.9+ 就够，不必建 venv'
      }),
    },

    // ---------------- 步骤探针（STEPS 同源；配置型功能的"动作做过没有"）
    stepProbes: {
      'jev-key': () => {
        const k = findKeyFile(cfg)
        return k ? true : `没有 Jev Key。三选一：env JEV_API_KEY ／ config.keyFile ／ ${join(cfg.dataDir, 'jev-key.txt')}（也可让模型代存：memoryos_setup action=save-key）`
      },
      'jev-probe': () => cached('jevprobe', () => {
        const s = foldSetup(cfg.dataDir)
        const r = stepSatisfied(s.rows, 'jev-probe', freshDays)
        return r.done ? true : `${r.why}｜跑 memoryos_setup action=probe 真发一次请求测通（结果落 ${s.file}）`
      }),
      'graph-built': () => cached('graphbuilt', () => {
        const f = findGraph()
        if (!f) return `指针图还没建：跑一次 build（候选位置 ${graphCandidates().join('  |  ') || '记忆根未设置'}）`
        return true
      }),
      'memory-scaffolded': () => cached('scaffolded', () => {
        const names = ['MEMORY.md', 'MEMORY-INDEX.md', 'MEMORY-ENTRIES.md', 'MEMORY-MAP.md']
        for (const r of rootsOf()) {
          if (!isDir(r)) continue
          for (const nm of names) { try { if (existsSync(join(r, nm))) return true } catch { /* 换下一个 */ } }
        }
        return '记忆根里还没有四层骨架（MEMORY.md / -INDEX / -ENTRIES / -MAP）→ 跑建档向导'
      }),
    },
  }
}

export function probeAll(bundle) {
  const out = {}
  for (const [id, fn] of Object.entries(bundle.probes)) out[id] = fn()
  return out
}

export function stepAll(bundle) {
  const out = {}
  for (const [id, fn] of Object.entries(bundle.stepProbes)) {
    let v
    try { v = fn() } catch (e) { v = String((e && e.message) || e) }
    out[id] = v === true ? { done: true } : { done: false, why: typeof v === 'string' ? v : '' }
  }
  return out
}
