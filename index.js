/**
 * dsh-md-MemoryOS · Host 半
 *
 * 只做接线，口径全在 lib/：
 *   buildSnapshot()  面板与工具**共用**的唯一状态视图（状态现算不存盘）
 *   writeSwitch()    唯一写入口（权限在落盘前判；面板与模型同一个函数）
 *   runSetup()       配置型功能的动作（测通 Jev、代存 Key）——只有模型能调，面板只显示状态
 *   createApi()      面板 HTTP 面（ctx.inject(['webServer']) 延迟挂载）
 *
 * 三个工具：memoryos_status（读）／memoryos_switch（切，模型必带 reason）／memoryos_setup（做配置动作）
 *
 * 纪律（本机三家插件 + dsh-selfevolve 的实测结论）：
 *   失败不 throw（归一成模型可读文本）；不写死本机路径（config > env > 发现链）；
 *   明文 Key 永不进账本、永不进日志；插件不能自己重启（重启归用户）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FEATURES, DEPS, STEPS, GROUPS, featureOf, lintFeatures } from './lib/features.js'
import { foldLedger, appendSwitch, effectiveValue, deriveState, mayWrite, switchFile, expandHome } from './lib/switches.js'
import { makeProbes, probeAll, stepAll, envOf } from './lib/probes.js'
import { foldSetup, recordSetup, probeJev } from './lib/setup.js'
import { makeKeystore, KEY_REF } from './lib/keystore.js'
import { createApi } from './lib/api.js'

export const name = 'dsh-md-MemoryOS'
export const inject = ['tools']

export function readCfg(config) {
  const c = config || {}
  const rootsRaw = c.memoryRoot || envOf('MD_MEMORY_ROOTS') || ''
  const roots = String(rootsRaw).split(/[;,]/).map((s) => s.trim()).filter(Boolean)
  const dataDir = expandHome(c.dataDir || envOf('MEMORYOS_DATA') || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'memoryos'))
  return {
    dataDir,
    memoryRoots: roots,
    graphDb: c.graphDb || envOf('MEMORYOS_GRAPH') || '',
    pythonBin: c.pythonBin || envOf('MD_PYTHON_BIN') || '',
    kernelRepo: c.kernelRepo || envOf('MD_REPO_ROOT') || '',
    keyFile: c.keyFile || envOf('JEV_KEY_FILE') || join(dataDir, 'jev-key.txt'),
    baseUrl: String(c.baseUrl || envOf('JEV_BASE_URL') || 'https://api.typesafe.ai').replace(/\/+$/, ''),
    model: c.model || envOf('JEV_MODEL') || 'jev-latest',
    probeTimeoutMs: Number(c.probeTimeoutMs) > 0 ? Number(c.probeTimeoutMs) : 6000,
    setupFreshDays: Number(c.setupFreshDays) > 0 ? Number(c.setupFreshDays) : 7,
    staleDays: Number(c.graphStaleDays) > 0 ? Number(c.graphStaleDays) : 7,
    ledgerTail: Number(c.ledgerTail) > 0 ? Number(c.ledgerTail) : 40,
    cfgDefaults: c.defaults && typeof c.defaults === 'object' ? c.defaults : {},
    llmCanSwitch: c.llmCanSwitch !== false,
    modelCanSaveKey: c.modelCanSaveKey !== false,
    // 明文 Key 的落点策略：凭据面优先；allowKeyInRepo 是"我清楚风险，就是要放仓里"的显式逃生阀
    allowKeyInRepo: c.allowKeyInRepo === true,
    // 旧部署可能把 Key 落在仓里；列在这里＝允许读到并**在面板上标警**（默认空：共享包不猜别人机器路径）
    legacyKeyFiles: Array.isArray(c.legacyKeyFiles) ? c.legacyKeyFiles.filter(Boolean) : [],
    home: envOf('DSH_HOME') || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'),
    // 注入用的 transport（闸/测试可以塞假传输，不联网也跑全链路）
    transport: typeof c.transport === 'function' ? c.transport : undefined,
  }
}

export function apply(ctx, config) {
  const cfg = readCfg(config)
  const disposers = []
  const runtime = { webserver: false }
  const log = (m) => { try { ctx.logger ? ctx.logger.info(m) : console.info(m) } catch { /* 日志绝不外抛 */ } }
  const warn = (m) => { try { if (ctx.logger) ctx.logger.warn(m); else console.warn(m) } catch { /* 同上 */ } }
  const bundle = makeProbes(cfg, runtime, { setupFreshDays: cfg.setupFreshDays })
  const keys = makeKeystore({ cfg, warn })
  const JEY_STEP = 'jev-key' // STEPS 里的 id（凭据面结果覆盖它）

  /** 步骤就绪表：先跑本地步骤探针，再用**凭据面**结果覆盖 jev-key 那一格（凭据 API 是异步的）。 */
  async function stepReadiness() {
    const s = stepAll(bundle)
    const info = await keys.locate()
    s[JEY_STEP] = info.present ? { done: true } : { done: false, why: info.hint }
    return { s, info }
  }

  let ver = ''
  function pkgVersion() {
    if (ver) return ver
    try { ver = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '?' } catch { ver = '?' }
    return ver
  }

  // ---------------------------------------------------------------- 快照（唯一状态视图；含异步凭据查询）
  async function buildSnapshot(limit) {
    const led = foldLedger(cfg.dataDir)
    const setup = foldSetup(cfg.dataDir)
    const deps = probeAll(bundle)
    const ready = await stepReadiness()
    const steps = ready.s
    const features = FEATURES.map((f) => {
      const row = led.rows.get(f.id) || null
      const eff = effectiveValue(f, cfg.cfgDefaults, row)
      const d = deriveState(f, eff, deps, DEPS, steps, STEPS)
      return {
        id: f.id, label: f.label, what: f.what, group: f.group, cost: f.cost,
        controller: f.controller, impl: f.impl, default: f.default,
        deps: (f.deps || []).map((id) => ({ id, ...DEPS[id] })),
        steps: (f.steps || []).map((id) => ({ id, ...STEPS[id], ok: !!(steps[id] && steps[id].done), why: (steps[id] && steps[id].why) || '' })),
        ...d,
      }
    })
    const byGroup = {}
    for (const g of GROUPS) byGroup[g] = []
    for (const x of features) {
      if (!byGroup[x.group]) byGroup[x.group] = []
      byGroup[x.group].push(x)
    }
    for (const g of Object.keys(byGroup)) byGroup[g].sort((a, b) => a.id.localeCompare(b.id))
    let lines = 0
    try { if (existsSync(led.file)) lines = readFileSync(led.file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length } catch { lines = 0 }
    return {
      features,
      byGroup,
      ledger: [...led.rows.values()].slice(-Math.max(1, limit || cfg.ledgerTail)).reverse(),
      ledgerMeta: { file: switchFile(cfg.dataDir), exists: existsSync(switchFile(cfg.dataDir)), corrupt: led.corrupt, lines },
      setup: [...setup.rows.values()].reverse().slice(0, Math.max(1, limit || cfg.ledgerTail)),
      setupMeta: { file: setup.file, exists: existsSync(setup.file), corrupt: setup.corrupt, freshDays: cfg.setupFreshDays },
      deps: Object.keys(DEPS).map((id) => ({ id, ...DEPS[id], result: deps[id] })),
      meta: {
        pkg: name, version: pkgVersion(), dataDir: cfg.dataDir,
        llmCanSwitch: cfg.llmCanSwitch, modelCanSaveKey: cfg.modelCanSaveKey,
        // Key 只报"有没有、从哪来、要不要搬家、掩码"——明文永不进快照
        key: {
          present: !!ready.info.present, ref: ready.info.ref || '', from: ready.info.from || '', via: ready.info.via || '',
          masked: ready.info.masked || '', path: ready.info.path || '', writable: !!ready.info.writable,
          warnings: ready.info.warnings || [], hint: ready.info.hint || '',
        },
        configHints: { memoryRoot: cfg.memoryRoots, pythonBin: cfg.pythonBin, graphDb: cfg.graphDb, kernelRepo: cfg.kernelRepo, keyFile: cfg.keyFile, baseUrl: cfg.baseUrl, allowKeyInRepo: !!cfg.allowKeyInRepo },
      },
    }
  }

  // ---------------------------------------------------------------- 唯一写入口
  async function writeSwitch(input) {
    const body = input || {}
    const by = body.by === 'llm' ? 'llm' : 'user'
    const key = String(body.feature || body.key || '').trim()
    const f = featureOf(key)
    if (!f) return { ok: false, message: `没这个功能：${key || '（空）'}。可选：${FEATURES.map((x) => x.id).join(' / ')}` }
    if (by === 'llm' && !cfg.llmCanSwitch) return { ok: false, message: '本部署已禁掉「模型改开关」（profile config.llmCanSwitch=false）。请让用户在面板上切' }
    const prev = foldLedger(cfg.dataDir).rows.get(f.id) || null
    const permit = mayWrite(f, by, prev)
    if (!permit.ok) return { ok: false, message: permit.why }
    const lock = body.lock === true || body.lock === false ? body.lock : undefined
    let reason = String(body.reason || '').trim()
    if (by === 'llm' && !reason) return { ok: false, message: '模型改开关必须写 reason（面板与账本都要显示"是谁、为什么切的"）' }
    if (!reason) reason = lock === true ? '用户接管（锁定，模型不再可改）' : lock === false ? '用户解除接管' : '（用户未填理由）'
    const value = typeof body.value === 'boolean' ? body.value : String(body.value || '').toLowerCase() === 'on'
    // 配置型功能没做完前置步骤时，"打开"会被算成 waiting——这里**不禁止**用户开（他可能就是先占个位），
    // 但模型开的时候提醒它：没测通就开＝假开。
    if (lock === undefined && prev && prev.value === value) {
      return { ok: false, message: `「${f.label}」当前已是${value ? '开' : '关'}（${prev.ts || '未知时间'}），无需重复写` }
    }
    const row = appendSwitch(cfg.dataDir, { key: f.id, value, by, reason, lock })
    bundle.invalidate()
    let extra = ''
    if (value && f.steps && f.steps.length) {
      const ready = await stepReadiness()
      const left = f.steps.filter((s) => !(ready.s[s] && ready.s[s].done))
      if (left.length) extra = `｜仍差 ${left.length} 步（${left.map((s) => STEPS[s].label).join('、')}），面板显示「待配置」，不算生效`
    }
    return { ok: true, message: `已记一行：${f.id}=${row.value ? 'on' : 'off'}（${by === 'llm' ? '模型决定' : '用户'}${row.lock === true ? ' · 已接管锁定' : row.lock === false ? ' · 已解除接管' : ''}）${extra}`, row }
  }

  // ---------------------------------------------------------------- 配置动作（只有模型走这条路）
  async function runSetup(input) {
    const body = input || {}
    const action = String(body.action || '').trim().toLowerCase()
    const reason = String(body.reason || '').trim()
    if (!reason) return { ok: false, message: '配置动作必须写 reason（这一步会落账，面板要显示是谁、为什么做的）' }
    const feature = String(body.feature || 'jev-engine').trim()
    if (action === 'probe') {
      const info = await keys.locate()
      if (!info.present) return { ok: false, message: `没有 Key，测通无从谈起。${info.hint || ''}` }
      const secret = await keys.secret()
      const r = await probeJev({ key: secret, baseUrl: cfg.baseUrl, model: cfg.model, timeoutMs: cfg.probeTimeoutMs, transport: cfg.transport })
      recordSetup(cfg.dataDir, { step: 'jev-probe', ok: r.ok, by: 'llm', note: r.note, latencyMs: r.latencyMs, reason })
      bundle.invalidate()
      return {
        ok: r.ok,
        message: r.ok
          ? `✓ Jev 测通成功（${r.latencyMs}ms，${r.note}；Key 来自 ${info.from} ${info.masked}）。现在可以 memoryos_switch 开 ${feature}`
          : `✗ Jev 没测通：${r.note}（Key 来自 ${info.from}）。**别去开 ${feature}**——开了就是假开、每回合白烧账`,
      }
    }
    if (action === 'save-key') {
      if (!cfg.modelCanSaveKey) return { ok: false, message: `本部署禁掉模型代存 Key（config.modelCanSaveKey=false）。请用户自己在设置里存 ref=${KEY_REF}，或写 env JEV_API_KEY` }
      if (!body.key) return { ok: false, message: '没给 key 参数' }
      const r = await keys.save(body.key, { path: body.path, allowInRepo: String(body.allow_in_repo).toLowerCase() === 'true', allowFileFallback: body.allow_file_fallback === true })
      if (!r.ok) { recordSetup(cfg.dataDir, { step: 'jev-key', ok: false, by: 'llm', note: r.message, reason }); bundle.invalidate(); return { ok: false, message: `存 Key 失败：${r.message}` } }
      recordSetup(cfg.dataDir, { step: 'jev-key', ok: true, by: 'llm', note: `存入 ${r.to}${r.inRepo ? '（注意：在 git 工作树内）' : ''}`, masked: r.masked, reason })
      bundle.invalidate()
      return { ok: true, message: `✓ Key 已存进 ${r.to}（${r.masked}；明文不复述、不入账本、不进日志）。下一步：action=probe 测通` }
    }
    if (action === 'where-key') {
      const info = await keys.locate()
      return { ok: true, message: info.present ? `Key 现在在：${info.from}${info.path ? '（' + info.path + '）' : ''} ${info.masked}。${(info.warnings || []).join(' ') || '位置合规'}` : `没有 Key。${info.hint}` }
    }
    if (action === 'list') {
      const s = await buildSnapshot(12)
      return { ok: true, message: `配置账本 ${s.setupMeta.file}（存在=${s.setupMeta.exists}，坏行=${s.setupMeta.corrupt}）；当前待办步骤：` + s.features.filter((f) => f.pending && f.pending.length).map((f) => `${f.id}[${f.pending.map((p) => p.label).join('+')}]`).join(' ') }
    }
    return { ok: false, message: `未知 action：${action}（可用 probe / save-key / where-key / list）` }
  }

  // ---------------------------------------------------------------- 工具注册
  const reg = (t) => { try { disposers.push(ctx.tools.register(t)) } catch (e) { warn(`工具注册失败：${String((e && e.message) || e)}`) } }

  reg(defineTool({
    name: 'memoryos_status',
    description:
      '读 MemoryOS 功能面板的真实状态：每个功能是 生效中/已关/待配置/降级/不可用/未实现，是谁定的（用户还是模型）、理由与时间，'
      + '缺哪个依赖、还差哪一步（以及那一步该谁做）。判断"某功能为什么没生效"、"该不该建议用户开它"先读这个，别猜。',
    parameters: { feature: { type: 'string', required: false, description: '只看某个功能（如 jev-engine / radar / mining）；省略＝全量摘要' } },
    output: { schema: 'text' },
    async execute({ feature }) {
      try {
        const s = await buildSnapshot(6)
        const rows = feature ? s.features.filter((f) => f.id === String(feature).trim()) : s.features
        if (feature && !rows.length) return { text: `没这个功能：${feature}。可选：${s.features.map((f) => f.id).join(' / ')}` }
        const ZH = { on: '生效中', off: '已关', waiting: '待配置', degraded: '降级运行', unavailable: '不可用', planned: '未实现' }
        const lines = rows.map((f) => {
          const who = f.source === 'ledger' ? `账本（${f.by === 'llm' ? '模型' : '用户'}）${f.reason ? `：${f.reason}` : ''}` : f.source === 'config' ? 'profile config' : '出厂默认'
          const pend = (f.pending || []).length ? `｜待办：${f.pending.map((p) => `${p.label}（${p.by === 'llm' ? '模型执行' : '需用户提供'}）`).join(' ')}` : ''
          const miss = (f.missing || []).length ? `｜缺：${f.missing.map((m) => `${m.label}${m.why ? `（${m.why}）` : ''}`).join(' ')}` : ''
          return `- ${f.id}「${f.label}」＝${ZH[f.state] || f.state}｜${f.controller === 'llm' ? '模型执行' : f.controller === 'user' ? '仅用户可切' : '双方可切'}${f.locked ? '·用户已接管' : ''}｜${who}${pend}${miss}｜成本：${f.cost}`
        })
        return { text: `MemoryOS ${s.meta.version}｜账本 ${s.meta.dataDir}｜Key=${s.meta.keyPresent ? '在（' + s.meta.keyFrom + '）' : '无'}｜模型可改开关=${s.meta.llmCanSwitch}\n`
          + lines.join('\n')
          + `\n配置账本：${s.setupMeta.file}（${s.setupMeta.exists ? '有' : '还没有'}）；切换账本 ${s.ledgerMeta.lines} 行、坏行 ${s.ledgerMeta.corrupt}`
          + (feature ? '' : '\n口径：状态一律现算不缓存；"待配置"＝该功能开着但前置动作没做完（不算生效）；模型只能动 controller=llm/both 且未被接管的项。') }
      } catch (e) {
        return { text: `读状态失败：${String((e && e.message) || e)}` }
      }
    },
  }))

  reg(defineTool({
    name: 'memoryos_switch',
    description:
      '切换 MemoryOS 功能开关（只能切登记为"模型可切/双方可切"的项，**必须写 reason**）。写进 append-only 账本并在面板显示"由模型决定"，热生效不重启。'
      + '注意：配置型功能（如 jev-engine）没做完前置步骤就开＝**假开**（状态会显示"待配置"、白烧账），请先用 memoryos_setup 测通。'
      + '被拒时理由原样回给你（仅用户可切／已被接管／未实现）——照实转告用户，别绕路。',
    parameters: {
      feature: { type: 'string', required: true, description: '功能 id（memoryos_status 可看清单）' },
      value: { type: 'string', required: true, description: 'on 或 off' },
      reason: { type: 'string', required: true, description: '为什么切（面板与账本都会显示；不写＝拒绝）' },
    },
    output: { schema: 'text' },
    async execute({ feature, value, reason }) {
      try {
        const v = String(value || '').trim().toLowerCase()
        if (v !== 'on' && v !== 'off') return { text: `value 只能是 on 或 off，收到「${value}」` }
        const r = await writeSwitch({ feature, value: v === 'on', by: 'llm', reason })
        return { text: r.ok ? `✓ ${r.message}` : `✗ 拒绝：${r.message}` }
      } catch (e) {
        return { text: `切换失败：${String((e && e.message) || e)}` }
      }
    },
  }))

  reg(defineTool({
    name: 'memoryos_setup',
    description:
      '执行 MemoryOS「配置型功能」的准备动作（这类功能的"开启"是一串动作，不是面板上一下）：'
      + 'action=probe 真发一次极小 Jev 请求测通并记入配置账本（默认 7 天内算新鲜）；action=save-key 代用户把 Key 存好'
      + '（**优先存宿主凭据面 ref=JEV_API_KEY**——它在 ~/.dsh/.credentials.yaml：不在任何 git 仓里、升级不会覆盖、0600；'
      + '若只能落文件，落在 git 工作树内会被直接拒）；action=where-key 看 Key 现在在哪（只回掩码）；action=list 看配置账本与待办。'
      + '典型顺序：save-key（或用户自己存好）→ probe → 成功后才 memoryos_switch(feature=jev-engine,value=on)。'
      + 'probe 失败就**别去开**，把失败原因转告用户；明文 Key 永不进账本、日志或返回值。',
    parameters: {
      action: { type: 'string', required: true, description: 'probe | save-key | where-key | list' },
      reason: { type: 'string', required: true, description: '这次动作为什么做（会落账、面板显示）' },
      feature: { type: 'string', required: false, description: '为哪个功能做（默认 jev-engine）' },
      key: { type: 'string', required: false, description: '仅 save-key：用户明确交给你代存的 Key' },
      path: { type: 'string', required: false, description: '仅 save-key：实在要落文件时给路径（放 ~/.dsh 下，别放仓里）' },
      allow_in_repo: { type: 'string', required: false, description: '仅 save-key：把 "true" 传进来才允许落在 git 工作树内（默认拒；用完请搬家）' },
    },
    output: { schema: 'text' },
    async execute(args) {
      try {
        const r = await runSetup(args || {})
        return { text: r.message }
      } catch (e) {
        return { text: `配置动作失败：${String((e && e.message) || e)}` }
      }
    },
  }))

  // ---------------------------------------------------------------- 面板数据面
  disposers.push(createApi(ctx, {
    snapshot: () => buildSnapshot(),
    write: (body) => writeSwitch({ ...body, by: body && body.by === 'llm' ? 'llm' : 'user' }),
    runtime,
    log,
    warn,
  }) || (() => {}))

  // ---------------------------------------------------------------- 自检（同源三查）
  const lint = lintFeatures()
  const unprobed = Object.keys(DEPS).filter((d) => typeof bundle.probes[d] !== 'function')
  const unstepped = Object.keys(STEPS).filter((s) => typeof bundle.stepProbes[s] !== 'function')
  if (unprobed.length) warn(`${name}: DEPS 有 ${unprobed.join(', ')} 没探针 → 面板会永远显示"探针未实现"`)
  if (unstepped.length) warn(`${name}: STEPS 有 ${unstepped.join(', ')} 没步骤探针 → 待办永远清不掉`)
  if (lint.length) warn(`${name}: 功能登记表有问题：${lint.join('; ')}`)

  log(`${name} v${pkgVersion()} 就位｜工具 memoryos_status｜memoryos_switch｜memoryos_setup｜账本 ${cfg.dataDir}｜功能 ${FEATURES.length} 项（已实现 ${FEATURES.filter((f) => f.impl === 'live').length}）`)

  return function disposeMemoryOS() {
    for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* 卸载绝不抛 */ } }
    runtime.webserver = false
  }
}
