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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FEATURES, DEPS, STEPS, GROUPS, featureOf, lintFeatures } from './lib/features.js'
import { foldLedger, appendSwitch, effectiveValue, deriveState, mayWrite, switchFile, expandHome } from './lib/switches.js'
import { makeProbes, probeAll, stepAll, envOf } from './lib/probes.js'
import { foldSetup, recordSetup, probeJev } from './lib/setup.js'
import { makeKeystore, KEY_REF } from './lib/keystore.js'
import { foldSurface, appendSurface, surfaceView, effectiveRoots, badRoot, badPattern, preview, MANAGED_EXTS } from './lib/surface.js'
import { build as buildGraph, load as loadGraph, status as graphStatus, check as graphCheck, checkText, resolveStarts, subgraph, render as renderLight, graphFile, fulltextFallback } from './lib/graph.js'
import { run as runArchiveGate } from './lib/archive.js'
import { runKernel, resolvePython, kernelDbFile, KERNEL_DIR } from './lib/kernel.js'

/** 路径归一（账本与提示都用正斜杠、去尾斜杠；只用于比较与显示，不改写用户传入的原样值） */
const normPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
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
    // 归档闸看哪些 git 仓：默认=生效记忆根各自所属的仓（同事不会记得配这一项），这里可显式追加
    archiveRepos: (Array.isArray(c.archiveRepos) ? c.archiveRepos : String(c.archiveRepos || envOf('MEMORYOS_ARCHIVE_REPOS') || '').split(/[;,]/)).map((s) => String(s).trim()).filter(Boolean),
    pythonBin: c.pythonBin || envOf('MD_PYTHON_BIN') || '',
    kernelRepo: c.kernelRepo || envOf('MD_REPO_ROOT') || '',
    // 元素库内核（随包发）的数据根：默认 <dataDir>/elements（与 graph.json 分开两个根）；
    // 留空＝走默认推导，env MEMORYOS_KERNEL_DATA 同义。
    kernelData: expandHome(c.kernelData || envOf('MEMORYOS_KERNEL_DATA') || ''),
    // 指针图（本包自建，纯 JS，落 <dataDir>/graph.json）：多久算过期、最多扫多少文件
    graphStaleHours: Number(c.graphStaleHours) > 0 ? Number(c.graphStaleHours) : 24,
    graphMaxFiles: Number(c.graphMaxFiles) > 0 ? Number(c.graphMaxFiles) : 2000,
    graphMaxBytes: Number(c.graphMaxBytes) > 0 ? Number(c.graphMaxBytes) : 8_000_000,
    keyFile: c.keyFile || envOf('JEV_KEY_FILE') || join(dataDir, 'jev-key.txt'),
    baseUrl: String(c.baseUrl || envOf('JEV_BASE_URL') || 'https://api.typesafe.ai').replace(/\/+$/, ''),
    model: c.model || envOf('JEV_MODEL') || 'jev-latest',
    probeTimeoutMs: Number(c.probeTimeoutMs) > 0 ? Number(c.probeTimeoutMs) : 6000,
    setupFreshDays: Number(c.setupFreshDays) > 0 ? Number(c.setupFreshDays) : 7,
    ledgerTail: Number(c.ledgerTail) > 0 ? Number(c.ledgerTail) : 40,
    // 资料面扫描上限：只数文件名，命中即停（面板刷新要便宜，索引是另一件事）
    scanCap: Number(c.scanCap) > 0 ? Number(c.scanCap) : 400,
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
    // 注入用的内核调用点（闸/测试塞合成返回，不 spawn 也能测渲染层）
    kernelCall: typeof c.kernelCall === 'function' ? c.kernelCall : undefined,
  }
}

export function apply(ctx, config) {
  const cfg = readCfg(config)
  const disposers = []
  const runtime = { webserver: false }
  const log = (m) => { try { ctx.logger ? ctx.logger.info(m) : console.info(m) } catch { /* 日志绝不外抛 */ } }
  const warn = (m) => { try { if (ctx.logger) ctx.logger.warn(m); else console.warn(m) } catch { /* 同上 */ } }
  // 生效记忆根＝profile 基线 ∪ 资料面账本增量（探针与扫描都走这一个口径，别留两份真相）
  cfg.rootsOf = () => effectiveRoots(cfg, foldSurface(cfg.dataDir)).map((r) => r.path)
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
      // 资料面＝管理范围内的目录与文件类型（面板「资料面」页与 memoryos_surface 共用这一份）
      surface: surfaceView(cfg, foldSurface(cfg.dataDir), { cap: cfg.scanCap }),
      // 指针图（本包自建）：状态与水位，面板与工具同一口径
      graph: graphStatus(cfg, foldSurface(cfg.dataDir), { maxAgeHours: cfg.graphStaleHours, maxFiles: cfg.graphMaxFiles, exts: MANAGED_EXTS }),
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

  // ---------------------------------------------------------------- 资料面写入口（面板与模型同一个函数）
  function writeSurface(input) {
    const body = input || {}
    const by = body.by === 'llm' ? 'llm' : 'user'
    const op = String(body.op || body.action || '').trim().toLowerCase()
    const raw = String(body.reason || '').trim()
    if (by === 'llm' && !raw) return { ok: false, message: '模型改资料面必须写 reason（面板要显示是谁、为什么纳入了这个目录）' }
    const reason = raw || '（用户未填理由）'
    const folded = foldSurface(cfg.dataDir)
    if (op === 'add-root') {
      const why = badRoot(body.path, cfg, folded)
      if (why) return { ok: false, message: `不能纳入：${why}` }
      appendSurface(cfg.dataDir, { op: 'add-root', path: expandHome(String(body.path).trim()), by, reason })
      bundle.invalidate()
      return { ok: true, message: `已纳入管理范围：${normPath(body.path)}（只数 ${MANAGED_EXTS.join('/')} 文件名，被排除规则挡住的不在内）` }
    }
    if (op === 'drop-root') {
      const k = normPath(body.path).toLowerCase()
      if ((cfg.memoryRoots || []).some((r) => normPath(r).toLowerCase() === k)) {
        return { ok: false, message: '这是 profile 基线的记忆根，面板与工具都不删它——要改请改 profile 的 config.memoryRoot（改了要重启）' }
      }
      if (!folded.roots.some((r) => normPath(r.path).toLowerCase() === k)) return { ok: false, message: `管理范围里没有这个目录：${body.path}` }
      appendSurface(cfg.dataDir, { op: 'drop-root', path: normPath(body.path), by, reason })
      bundle.invalidate()
      return { ok: true, message: `已移出管理范围：${normPath(body.path)}（账本留一行历史，谁加的什么时候加的都能查）` }
    }
    if (op === 'add-exclude') {
      const why = badPattern(body.pattern)
      if (why) return { ok: false, message: why }
      const pv = preview(cfg, folded, body.pattern, { cap: cfg.scanCap })
      if (!pv.ok) return { ok: false, message: pv.message }
      if (pv.total === 0) return { ok: false, message: pv.message + '｜确认要加也行，但请先核对路径写法（相对根：notes/drafts/ 、todo.md 、*.draft.md）' }
      appendSurface(cfg.dataDir, { op: 'add-exclude', pattern: String(body.pattern).trim(), by, reason })
      bundle.invalidate()
      return { ok: true, message: `已加排除规则：${pv.message}` }
    }
    if (op === 'drop-exclude') {
      const p = String(body.pattern || '').trim()
      if (!folded.excludes.some((e) => e.pattern === p)) return { ok: false, message: `没有这条排除规则：${p}` }
      appendSurface(cfg.dataDir, { op: 'drop-exclude', pattern: p, by, reason })
      bundle.invalidate()
      return { ok: true, message: `已解除排除：${p}（这些文件重新回到管理范围）` }
    }
    if (op === 'preview') {
      const pv = preview(cfg, folded, body.pattern, { cap: cfg.scanCap })
      return pv.ok ? { ok: true, message: pv.message } : { ok: false, message: pv.message }
    }
    return { ok: false, message: `未知操作：${op}（可用 add-root / drop-root / add-exclude / drop-exclude / preview；看现状用 memoryos_surface action=list）` }
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
    parameters: { feature: { type: 'string', description: '只看某个功能（如 jev-engine / graph-search / mining）；省略＝全量摘要' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
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
        return { text: `MemoryOS ${s.meta.version}｜账本 ${s.meta.dataDir}｜Key=${s.meta.key.present ? '在位：' + s.meta.key.from + ' ' + s.meta.key.masked : '未配置'}｜模型可改开关=${s.meta.llmCanSwitch}｜资料面=${s.surface.totals.roots} 根 / 纳管 ${s.surface.totals.managed} 文件 / 排除 ${s.surface.totals.hidden}`
          + (s.meta.key.warnings && s.meta.key.warnings.length ? '\n' + s.meta.key.warnings.map((w) => `⚠ ${w}`).join('\n') : '') + '\n'
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
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
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
      + '典型顺序：save-key（或用户自己存好）→ probe → 成功后那行状态才记成"通道已就绪"。'
      + '**注意：本包不含语义寻路**——这里只验证"通道通不通"，它不会给"这件事该读哪份资料"的答案；'
      + '要查资料一律用 memoryos_graph（`light` 落点／零命中正文兜底）。'
      + 'probe 失败就把失败原因转告用户；明文 Key 永不进账本、日志或返回值。',
    parameters: {
      action: { type: 'string', required: true, description: 'probe | save-key | where-key | list' },
      reason: { type: 'string', required: true, description: '这次动作为什么做（会落账、面板显示）' },
      feature: { type: 'string', description: '为哪个功能做（默认 jev-engine）' },
      key: { type: 'string', description: '仅 save-key：用户明确交给你代存的 Key' },
      path: { type: 'string', description: '仅 save-key：实在要落文件时给路径（放 ~/.dsh 下，别放仓里）' },
      allow_in_repo: { type: 'string', description: '仅 save-key：把 "true" 传进来才允许落在 git 工作树内（默认拒；用完请搬家）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      try {
        const r = await runSetup(args || {})
        return { text: r.message }
      } catch (e) {
        return { text: `配置动作失败：${String((e && e.message) || e)}` }
      }
    },
  }))

  reg(defineTool({
    name: 'memoryos_surface',
    description:
      '查看/调整 MemoryOS 的**资料面**（哪些目录归 OS 管、哪些子目录与文件被排除）。'
      + 'action=list 看现状（每根纳管多少 .md、被哪条规则挡住多少、样本路径）；add-root/drop-root 增删目录；'
      + 'add-exclude/drop-exclude 增删排除；preview 先试算一条规则会挡住哪些文件（**加排除规则前建议先 preview**）。'
      + '排除写法：`notes/drafts/`＝某根下的子树；`todo.md`＝任意层级同名文件；`*.draft.md`＝命名模式；`archive/**`＝跨层子树。'
      + '两条边界：profile 的 config.memoryRoot 是**只读基线**（这里删不掉，要改就改 profile 并重启）；'
      + '文件类型本版本固定 .md——**不要**向用户承诺能管别的类型（那要改扫描与索引，见 docs/DESIGN.md）。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | add-root | drop-root | add-exclude | drop-exclude | preview' },
      path: { type: 'string', description: '目录（add-root/drop-root 必填；绝对路径或 ~ 开头）' },
      pattern: { type: 'string', description: '排除规则（add-exclude/drop-exclude/preview 必填）' },
      reason: { type: 'string', description: '为什么改（写操作必带，面板会显示"是谁、为什么"）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      try {
        const a = String((args && args.action) || 'list').trim().toLowerCase()
        if (a === 'list') {
          const s = await buildSnapshot(6)
          const v = s.surface
          const lines = v.roots.map((r) => ` - ${r.path}［${r.source === 'profile' ? 'profile 基线·此处不可删' : (r.by === 'llm' ? '模型加' : '面板加')}${r.removable ? '·可移除' : ''}］`
            + (r.exists ? ` 纳管 ${r.matched}${r.capped ? '+' : ''} 个 .md｜被挡 ${r.excluded}${Object.keys(r.byRule).length ? '｜' + Object.entries(r.byRule).map(([p, c]) => `${p}→${c}`).join(' ') : ''}｜样本 ${(r.samples[0] || '（无命中）')}${r.samples.length > 1 ? ' …' : ''}` : ` ✗ ${r.why || '目录不存在'}`))
          return { text: `资料面｜类型＝${v.exts.join(' ')}（本版本固定）｜${v.totals.roots} 个根（${v.totals.dirsMissing} 个不存在）｜纳管 ${v.totals.managed} 文件｜被挡 ${v.totals.hidden} 文件${v.totals.capped ? '（有根命中上限，数字带 +）' : ''}\n`
            + (lines.join('\n') || ' （还没有记忆根：请让用户在 profile 填 config.memoryRoot，或在面板「资料面」页添加目录）')
            + `\n排除规则：${v.excludes.length ? v.excludes.map((e) => `${e.pattern}（挡 ${e.hits}）`).join(' , ') : '（无）'}`
            + `\n账本：${v.ledger.file}（${v.ledger.lines} 行）｜${v.hint}` }
        }
        const r = writeSurface({ ...args, op: a, by: 'llm' })
        return { text: r.ok ? `✓ ${r.message}` : `✗ 拒绝：${r.message}` }
      } catch (e) {
        return { text: `资料面操作失败：${String((e && e.message) || e)}` }
      }
    },
  }))

  // ---------------------------------------------------------------- 指针图：建图 / 索引 / 体检
  function runGraph(input) {
    const body = input || {}
    const by = body.by === 'llm' ? 'llm' : 'user'
    const action = String(body.action || body.op || 'status').trim().toLowerCase()
    const folded = foldSurface(cfg.dataDir)
    const opts = { maxFiles: cfg.graphMaxFiles, maxBytes: cfg.graphMaxBytes }
    if (action === 'build') {
      if (!cfg.rootsOf().length) return { ok: false, message: '还没有记忆根，建不了图：先在面板「资料面」页纳入目录（或 profile 填 config.memoryRoot）' }
      const t0 = Date.now()
      const { graph, warnings } = buildGraph(cfg, folded, opts)
      bundle.invalidate()
      recordSetup(cfg.dataDir, { step: 'graph-built', ok: true, by, note: `节点 ${graph.stats.nodes}／边 ${graph.stats.edges}／文件 ${graph.stats.files}`, latencyMs: Date.now() - t0, reason: String(body.reason || '').slice(0, 300) })
      return {
        ok: true,
        message: `指针图已重建：${graph.stats.files} 份 .md → ${graph.stats.nodes} 节点／${graph.stats.edges} 边（${((Date.now() - t0) / 1000).toFixed(1)}s）`
          + `｜未解析引用 ${graph.stats.unresolved}｜被资料面排除跳过 ${graph.stats.skippedExcluded}${graph.stats.capped ? '｜**命中文件上限，图不完整**（调大 config.graphMaxFiles）' : ''}`
          + (warnings.length ? `｜提示 ${warnings.length} 条：${warnings.slice(0, 3).join(' ｜ ')}` : '')
          + `｜落 ${graphFile(cfg.dataDir)}`,
      }
    }
    // 归档闸（提交前检查）自己会按需刷新图，所以**放在 loadGraph 之前**——否则"还没建图"会先被挡掉
    if (action === 'archive-check') {
      const one = String(body.file || '').trim()
      const r = runArchiveGate(cfg, folded, {
        files: one ? [one] : undefined,
        noRefresh: body.no_refresh === true || body.noRefresh === true || String(body.no_refresh || '').toLowerCase() === 'true',
      })
      return { ok: r.ok, message: r.markdown, warns: r.warns, counts: r.counts }
    }
    const g = loadGraph(cfg)
    if (!g) return { ok: false, message: `图还不存在（${graphFile(cfg.dataDir)}）：先跑 memoryos_graph(action='build')` }
    if (action === 'light' || action === 'lookup') {
      const q = String(body.query || '').trim()
      if (!q) return { ok: false, message: 'light 需要 query（要查的词/条目号/文件名）' }
      const depth = Number(body.depth) > 0 ? Math.min(3, Number(body.depth)) : 2
      // 默认＝**落点清单**（md 自带索引 ⇒ 工具只负责"跳过目录、直达搜索词所在的条目+文件"）；
      // 只有 expand:true 才展开邻域地图——顺带省掉一次 BFS（默认路径不再付这份成本）。
      const expand = body.expand === true || String(body.expand).toLowerCase() === 'true'
      const res = resolveStarts(g, q, { maxStarts: 6 })
      const sub = (expand && res.starts.length)
        ? subgraph(g, res.starts, { depth, maxNodes: Number(body.max_nodes) > 0 ? Number(body.max_nodes) : 45 })
        : { nodes: [], edges: [], capped: false }
      const st = graphStatus(cfg, folded, { ...opts, maxAgeHours: cfg.graphStaleHours })
      // 零命中才跑"域内正文兜底"（现扫现查、零账）；**过泛查询不跑**——它的答案只有一句"问得太泛"，
      // 扫一遍库再列细节等于把上下文烧在噪声上（用户 2026-10-02 口径：过泛只报一个数）。
      const ft = (res.starts.length || res.overbroad) ? '' : fulltextFallback(cfg, folded, g, q, { maxBytes: cfg.graphMaxBytes, maxFiles: cfg.graphMaxFiles })
      return {
        ok: true,
        message: renderLight(g, q, res, sub, st, { depth, expand, fulltext: ft }),
        matched: res.starts.length, level: res.level, nodes: sub.nodes.length, edges: sub.edges.length, stale: st.stale,
        fulltext: ft ? ft.split('\n')[0] : '',
      }
    }
    if (action === 'check') {
      const out = graphCheck(cfg, folded, g, { ...opts, maxAgeHours: cfg.graphStaleHours })
      return { ok: true, message: checkText(out), counts: out.counts }
    }
    if (action === 'status') {
      const st = graphStatus(cfg, folded, { ...opts, maxAgeHours: cfg.graphStaleHours })
      return { ok: true, message: st.exists
        ? `指针图：${st.files} 份文件 → ${st.nodes} 节点／${st.edges} 边｜建于 ${st.builtAt}（${st.ageHours}h 前，阈值 ${st.maxAgeHours}h）｜${st.stale ? `**该重建**：${st.changed} 个文件建图后又改了` : '较新'}｜未解析引用 ${st.unresolved}｜落 ${st.file}`
        : `指针图还没建（${st.file} 不存在）：跑 memoryos_graph(action='build')` }
    }
    return { ok: false, message: `未知动作：${action}（可用 status | build | light | check | archive-check）` }
  }

  reg(defineTool({
    name: 'memoryos_graph',
    description:
      'MemoryOS 的**指针图**（本包自建、纯本地、零账）：`build` 扫管理范围内的 .md 建图；`light` 按词**给落点**（默认，见下）；`check` 出盲区清单；`status` 看水位；'
      + '**`light` 默认＝落点清单**（2026-10-02 起）：md 文档自带索引（人/模型本就能逐级读），工具的职责是**跳过目录、直达"搜索词所在的条目+文件"**——所以默认每行＝`文件` 〔条目体·编号／文件／名字〕 L行号 · 短标题，上限 12 条、超出如实报"另 N 处"；**正文不在这里给**，要内容 `read` 那个文件（带 offset）。'
      + '**要邻域地图**（谁指谁＋reason＋建议读，可能很大）＝加 `expand:true`；默认路径连 BFS 都不跑（省上下文）。'
      + '`archive-check` ＝**提交前归档闸**：只看"本次未提交的新增"——新档没人引用（忘了登记）⇒ warn、文件头 `指针条目=AAx` 悬空 ⇒ warn、本轮新条目没人回指 ⇒ info；'
      + '**只报事实、不改文件、不挡提交**，拿到 warn 自己判断；确属一次性别档就在文件头写 `> 归档：免索引（理由）`（会列进"豁免清单"）。全库结构体检走 `check`，别混用。'
      + '只索引**标题/条目号/触发行/标准 Markdown 链接/反引号路径/「§三 AA14」式指针**，正文不进图 ⇒ 查回来的是**落点或地图，不是内容**：要读文件仍得自己 read，引入前仍要过筛。'
      + '**零命中的兜底**：`light` 会现扫一遍管理范围内的 `.md` 正文，报"字面出现在哪个文件的哪一行"（两轮：先原样、再归一键；只报字面、**不代表这就是答案**）；一句都没有时也会如实报"已扫 N 份、零命中"，并点出"另有 N 份不在扫描面（超大小门/建图后被截）"——**别把"空手"讲成"没有这份资料"**。'
      + '起点解析分两级并披露：先精准（原样/条目号/归一/子串/触发行），全空才进变体（归一子串/删一字/词相似度），输出会写明用了哪一级——**别把变体命中当精准命中汇报**。'
      + '**过泛＝只报一个数**（起点 >8 个／正文 >40 行时不给细节）——那不是"没这份资料"，换个更具体的词。'
      + '`check` 报的三类问题都不报错、只能靠体检发现：有资料没触发行（索引匹配不上）、条目孤立（写了没人指）、引用未解析（指向改名或不存在的资料）。'
      + '图是派生缓存：删了可重建；改了资料就 build 一次（面板「资料面」页也有重建按钮）。',
    parameters: {
      action: { type: 'string', required: true, description: 'status | build | light | check | archive-check' },
      query: { type: 'string', description: '仅 light：要查的词、条目号（如 AA14）或文件名' },
      expand: { type: 'boolean', description: '仅 light：要邻域地图（谁指谁＋reason）＝true；默认 false 只给落点清单（小而直达）' },
      depth: { type: 'number', description: '仅 light+expand:true：子图深度 1~3（默认 2；越大越费上下文）' },
      max_nodes: { type: 'number', description: '仅 light：子图最多多少节点（默认 45）' },
      reason: { type: 'string', description: '仅 build：为什么重建（面板与账本会显示；建图本身零账）' },
      file: { type: 'string', description: '仅 archive-check·调试：只查这一份（默认按 git 未提交新增自动收集）' },
      no_refresh: { type: 'boolean', description: '仅 archive-check·调试：跳过查前重建（正常要重建，否则新文件没入图、边查不到）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      try {
        const r = runGraph({ ...args, by: 'llm' })
        return { text: r.ok ? r.message : `✗ ${r.message}` }
      } catch (e) {
        return { text: `图操作失败：${String((e && e.message) || e)}` }
      }
    },
  }))

  // ---------------------------------------------------------------- 元素-时间线内核（Python 侧）
  // 一次调用＝一个子进程（lib/kernel.js）；这里只负责把 argv 拼对、把 JSON 渲染成人话。
  const kernelCfg = { dataDir: cfg.dataDir, pythonBin: cfg.pythonBin, kernelData: cfg.kernelData }
  // 内核调用点：默认 spawn Python 子进程；闸（离线）可注入 cfg.kernelCall 提供合成返回，
  // 这样"JSON → 人话"的渲染层也能被闸覆盖（本轮实测：渲染层猜错过内核返回结构）。
  const callKernel = (argv, timeoutMs) =>
    (typeof cfg.kernelCall === 'function' ? cfg.kernelCall : (a, t) => runKernel(kernelCfg, a, { timeoutMs: t }))(argv, timeoutMs || 30000)

  const runElements = async (args) => {
    const action = String(args.action || 'status')
    const numArg = (v, d) => (Number(v) > 0 ? String(Number(v)) : String(d))
    if (action === 'status') {
      const r = await callKernel(['status'])
      if (!r.ok) return { ok: false, message: r.message }
      const d = r.data || {}
      if (d.ok === false) return { ok: true, message: `元素库还没建（${d.db}）：跑一次 ingest 就会自动建｜内核 ${resolvePython(kernelCfg)}` }
      const cnt = d.counts || {}
      return { ok: true, message: `元素库：${cnt.elements ?? 0} 个元素｜${cnt.events ?? 0} 条事件（待定区 ${d.pending ?? 0}）｜${cnt.links ?? 0} 条链接｜${cnt.decisions ?? 0} 条决策\n库 ${d.db}（${(Number(d.bytes || 0) / 1024).toFixed(0)} KB）｜数据根 ${d.data_root}｜内核 ${resolvePython(kernelCfg)}` }
    }
    if (action === 'ingest') {
      const text = String(args.text || '').trim()
      if (!text) return { ok: false, message: 'ingest 要给 text（要固化进元素库的那段话）' }
      const argv = ['ingest', '--text', text]
      if (args.source) argv.push('--source', String(args.source))
      if (args.elements) argv.push('--elements', String(args.elements))
      const r = await callKernel(argv, 60000)
      if (!r.ok) return { ok: false, message: r.message }
      const d = r.data || {}
      const def = Array.isArray(d.elements_deferred) && d.elements_deferred.length
        ? `\n待确认候选（**没落库**，你确认后才建）：${d.elements_deferred.join(' / ')}` : ''
      return { ok: true, message: `入库完成：新增元素 ${d.elements_new ?? 0}｜事件 ${d.events_new ?? 0}｜链接 ${d.links_new ?? 0}（抽取＝${d.llm ? 'LLM' : '规则层'}）${def}` }
    }
    if (action === 'timeline' || action === 'snapshot') {
      const el = String(args.element || '').trim()
      if (!el) return { ok: false, message: `${action} 要给 element（元素名或代码）` }
      const argv = [action, el]
      if (action === 'timeline') {
        if (args.since) argv.push('--since', String(args.since))
        if (args.status) argv.push('--status', String(args.status))
        if (args.as_of) argv.push('--as-of', String(args.as_of))
        argv.push('--limit', numArg(args.limit, 200))
      }
      const r = await callKernel(argv)
      if (!r.ok) return { ok: false, message: r.message }
      const d = r.data || {}
      // 内核两种形状：timeline() 带 found；snapshot() 不带（找到才有 element 字段）—— 这里统一判定。
      const found = d.found === undefined ? !!d.element : d.found
      if (!found) {
        return { ok: true, message: `元素库里没有「${el}」。先用 memoryos_elements(action='ingest') 把带它的话固化进来，或 action='all' 看库里都有谁。` }
      }
      const aliases = Array.isArray(d.aliases) && d.aliases.length ? `，别名 ${d.aliases.join(' / ')}` : ''
      const head = `元素「${d.element}」（id ${d.id ?? d.element_id}${d.category && d.category !== 'generic' ? `，${d.category}` : ''}${aliases}）`
      const evs = Array.isArray(d.events) ? d.events : []
      const line = (e) => `- ${e.ts || '（无时间·待定区）'}｜${e.status === 'expired' ? '已失效｜' : ''}${e.content}${e.source ? `（${e.source}）` : ''}`
      if (action === 'snapshot') {
        // db.snapshot() 的真实形状：{element_id, latest, active_count}（不是 events 数组）
        const latest = d.latest || null
        const cnt = d.active_count ?? 0
        return { ok: true, message: `${head}\n活跃事件 ${cnt} 条${latest ? `｜最近一条：\n${line(latest)}` : '（还没有活跃事件）'}` }
      }
      const links = Array.isArray(d.links) && d.links.length
        ? `\n关联边：${d.links.map((l) => `${l.relation || 'related'}→${l.to_name || l.to || l.to_id}（${l.method || ''}）`).join(' / ')}` : ''
      return { ok: true, message: `${head}｜${evs.length} 条事件${args.since ? `（since ${args.since}）` : ''}\n${evs.map(line).join('\n') || '（这段时间内没有事件）'}${links}` }
    }
    if (action === 'all') {
      const argv = ['all']
      if (args.since) argv.push('--since', String(args.since))
      const r = await callKernel(argv)
      if (!r.ok) return { ok: false, message: r.message }
      const list = Array.isArray(r.data) ? r.data : []
      if (!list.length) return { ok: true, message: "元素库还是空的：用 action='ingest' 把带元素线索（6 位代码，或 --elements 显式给已知元素）的话固化进来。" }
      const rows = list.slice(0, 40).map((x) => {
        const nm = x.element || x.name || '?'
        const evs = Array.isArray(x.events) ? x.events : []
        const last = evs.map((e) => e.ts).filter(Boolean).sort().pop() || ''
        return `- ${nm}（${evs.length} 条事件${last ? `，最近 ${last}` : ''}）`
      })
      return { ok: true, message: `元素库共 ${list.length} 个元素${list.length > 40 ? '（只列前 40）' : ''}：\n${rows.join('\n')}` }
    }
    if (action === 'expire') {
      const el = String(args.element || '').trim()
      const frag = String(args.fragment || '').trim()
      if (!el || !frag) return { ok: false, message: 'expire 要同时给 element 与 fragment（按内容片段标失效，不删历史）' }
      const r = await callKernel(['expire', el, frag])
      if (!r.ok) return { ok: false, message: r.message }
      return { ok: true, message: `已按片段标失效：${JSON.stringify(r.data)}` }
    }
    if (action === 'export') {
      const p = String(args.path || '').trim()
      const target = p || join(cfg.kernelData || join(cfg.dataDir, 'elements'), 'timeline-export.md')
      const r = await callKernel(['export', target], 60000)
      if (!r.ok) return { ok: false, message: r.message }
      return { ok: true, message: `已导出 Markdown 镜像：${(r.data && r.data.path) || target}` }
    }
    if (action === 'import') {
      const el = String(args.element || '').trim()
      const p = String(args.path || '').trim()
      if (!el || !p) return { ok: false, message: 'import 要同时给 element（该档归属的元素名）与 path（要导入的 .md 路径）' }
      const argv = ['import', '--element', el, '--path', p]
      if (args.source) argv.push('--source', String(args.source))
      argv.push('--category', String(args.category || 'generic'))
      const r = await callKernel(argv, 60000)
      if (!r.ok) return { ok: false, message: r.message }
      const d = r.data || {}
      if (d.ok === false) return { ok: false, message: d.note || '导入失败' }
      return { ok: true, message: `已按元素「${d.element}」导入：解析 ${d.parsed ?? 0} 行 → 新增事件 ${d.new ?? 0}（重复行自动去重；元素不存在则新建，category=${args.category || 'generic'}）\n注意：只**读**源 md，原件没动。` }
    }
    if (action === 'save') {
      const el = String(args.element || '').trim()
      if (!el) return { ok: false, message: 'save 要给 element（拍哪个元素的快照）' }
      const argv = ['snapshot', el, '--save']
      if (args.note) argv.push('--note', String(args.note))
      const r = await callKernel(argv, 60000)
      if (!r.ok) return { ok: false, message: r.message }
      const d = r.data || {}
      if (d.ok === false) return { ok: false, message: d.note || '拍快照失败' }
      const pt = d.timeline_point || {}
      return { ok: true, message: `已拍快照：${d.file}（${d.bytes} 字节，active ${d.active}／待定 ${d.pending}）\n时间线上写了${pt.inserted ? '' : '（内容重复，未重复写）'}一个点：${pt.ts}｜${pt.content}\n快照索引已重建：${d.index}` }
    }
    if (action === 'context') {
      const el = String(args.element || '').trim()
      if (!el) return { ok: false, message: 'context 要给 element（取哪个元素的"当前逻辑"）' }
      const r = await callKernel(['context', el], 60000)
      if (!r.ok) return { ok: false, message: r.message }
      const d = r.data || {}
      if (!d.found) return { ok: true, message: `元素库里没有「${el}」。先用 ingest／import 把它建出来。` }
      const ns = d.new_since_snapshot || {}
      const tail = ns.count
        ? `\n\n自快照以来新增 ${ns.count} 条：\n${(ns.events || []).map((e) => `- ${e.ts}｜${e.content}`).join('\n')}`
        : `\n\n自快照（${ns.since || '—'}）以来没有新增事件。`
      if (!d.snapshot) {
        const rec = (d.recent_events || []).map((e) => `- ${e.ts || '（无时间·待定区）'}｜${e.content}`).join('\n')
        return { ok: true, message: `${d.note || '还没有快照'}\n最近事件：\n${rec || '（还没有事件）'}` }
      }
      return { ok: true, message: `最新快照＝当前运行逻辑（${d.snapshot.file}，拍于 ${d.snapshot.stamp}）：\n\n${d.content}${d.truncated ? `\n（快照较长已截断，全文：${d.snapshot.path}）` : ''}${tail}` }
    }
    return { ok: false, message: `未知动作：${action}（可用 status | ingest | import | save | context | timeline | snapshot | all | expire | export）` }
  }

  reg(defineTool({
    name: 'memoryos_elements',
    description:
      'MemoryOS 的**元素库**（元素-时间线内核，随包发的本地 SQLite）：把聊到/写下的**元素 + 带时间戳的事件 + 关联边**固化下来，之后能按元素拉时间线、看快照、标失效、导出 Markdown 镜像。'
      + '动作：`status`（库规模与落点）｜`ingest`（要 text；把一段话抽成元素+事件入库）｜`import`（要 element+path；把一份 **Markdown 时间线档**按元素导入）｜`timeline`（要 element；某元素按时间的多股绳）｜`snapshot`（要 element；最近状态）｜`all`（库里都有谁）｜`expire`（element+fragment；按内容片段标失效，不删历史）｜`export`（导出 md 镜像）。'
      + '**`import` 认的档长这样**：`- YYYY-MM-DD 内容 [已失效] → 引用`（`→` 后面进事件的 `ref`，`[已失效]` 标 expired）；**幂等**——重复导入自动去重；元素不存在则新建（`category` 默认 `generic`，别指望它自动判成"股票"）。上游 `import-timelines` 的惯例是**文件名去掉 `.md` 就当元素名**，本工具要你显式给 `element`。'
      + '**"md 与库两处都有"的正确口径（别搞成双写）**：**md 是人的输入**、**库是查询/决策端**——`import` 是单向幂等搬运（**读源档、不改原件**），`export` 出来的 md 是**派生镜像**（别手改：要改就改库，或改源 md 后重新导入）。两边同时手改＝双写，迟早对不上、且没有仲裁者。'
      + '**`save` ＝ 多点快照的生产者**：把该元素当前状态拍成 `<数据根>/exports/<元素>_snap_<时间戳>.md`，**并往时间线写一个点**（`source=snapshot`、`ref=` 快照档），同时重建 `exports/INDEX.md`。**`context` ＝取最新快照（＝当前运行逻辑）**，并附"自快照以来新增了什么"。这就是"**每归档/commit 一次流一个快照，提及时取最后一次**"那条用法（时间线两种读法：逐条事件 vs 多点快照）。'
      + '`context` **取不到快照时不会现场生成**（只读动作不写盘）——它只如实说"还没拍过"并给出最近事件，要不要拍由你调 `save` 决定。'
      + '**抽取有元素线索才落库**：文本里带 6 位代码，或用 `elements` 显式给已知元素——这是上游内核的保守模式，宁可少建也不制造碎片元素；真正的未知新元素会作为**待确认候选**返回（`elements_deferred`），你确认后才建。'
      + '**无 API Key 也能用**：规则层解析时间（ISO/中日韩日期/今天昨天/相对天数）与元素线索；有 Key 时才走 LLM 精抽，失败自动降级（结果里会写"抽取＝规则层"）。'
      + '**事件铁律**：没有时间属性的事件落 `ts=""` 进**待定区**（status=pending），不伪造时间；历史只追加、失效用标记不删除。'
      + '库落 `<数据根>/elements/memory.db`（与指针图分开两个数据根）；python 找不到时**只这一个工具不可用**，面板与词法检索照常。'
      + '它管的是**结构化事实**（谁在什么时候做了什么）；"这件事该读哪份 md"仍走 memoryos_graph 的词法落点——两者不是一回事，别互相替代。',
    parameters: {
      action: { type: 'string', required: true, description: 'status | ingest | import | save | context | timeline | snapshot | all | expire | export' },
      text: { type: 'string', description: '仅 ingest：要固化进元素库的那段话' },
      source: { type: 'string', description: '仅 ingest：来源标注（如对话/文件名，便于回溯）' },
      elements: { type: 'string', description: '仅 ingest：已知元素，逗号分隔（给了它就走保守模式：不新建元素，未知名挂到主元素）' },
      element: { type: 'string', description: '仅 timeline/snapshot/expire/import：元素名或代码（import 时＝该档归属的元素名）' },
      since: { type: 'string', description: '仅 timeline/all：只看该日期（YYYY-MM-DD）之后' },
      as_of: { type: 'string', description: '仅 timeline：**历史视角**——只看该日期及之前（＝"某个时间切面上它是什么状态"；时间未定的 pending 不计入）' },
      status: { type: 'string', description: '仅 timeline：active（默认）| expired | pending | all＝不过滤' },
      limit: { type: 'number', description: '仅 timeline：最多几条（默认 200）' },
      fragment: { type: 'string', description: '仅 expire：要标失效的内容片段' },
      note: { type: 'string', description: '仅 save：写进快照的备注（如「第一版逻辑」）' },
      path: { type: 'string', description: 'export：导出文件路径（默认 <数据根>/elements/timeline-export.md）｜import：要导入的 .md 路径' },
      category: { type: 'string', description: '仅 import：元素不存在时新建的类别（默认 generic；上游原为写死 stock）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      try {
        const r = await runElements(args)
        return { text: r.ok ? r.message : `✗ ${r.message}` }
      } catch (e) {
        return { text: `元素库操作失败：${String((e && e.message) || e)}` }
      }
    },
  }))

  // ---------------------------------------------------------------- 面板「元素库」页签的数据面
  // **懒加载**：用户切到那一页才请求。它要起一次内核进程，**不能塞进 /snapshot**
  //（挂载、刷新、以及每次写后都会重建快照，塞进去会让面板变慢）。带 10 秒 TTL 缓存，
  // 免得用户连着点刷新时反复 spawn。python 不在 ⇒ 如实说不可用，本函数不抛。
  const exportsDir = join(cfg.kernelData || join(cfg.dataDir, 'elements'), 'exports')
  let elementsCache = { at: 0, data: null }
  const elementsInfo = async () => {
    const now = Date.now()
    if (elementsCache.data && now - elementsCache.at < 10_000) return elementsCache.data
    const out = {
      available: false,
      note: '',
      db: kernelDbFile(cfg),
      dataRoot: cfg.kernelData || join(cfg.dataDir, 'elements'),
      exportsDir,
      counts: null,
      pending: 0,
      bytes: 0,
      list: [],
      snapshots: { files: 0, elements: 0, index: '', recent: [] },
    }
    // ① 快照索引（纯 fs，先给上；目录不存在＝"还没有快照"，不算错）
    try {
      const files = readdirSync(exportsDir).filter((f) => f.endsWith('.md'))
      const snaps = files.filter((f) => f !== 'INDEX.md')
      const byEl = {}
      for (const f of snaps) {
        const m = /^(.+)_snap_(\d{8}-\d{4})\.md$/.exec(f)
        if (!m) continue
        ;(byEl[m[1]] = byEl[m[1]] || []).push(m[2])
      }
      out.snapshots.files = snaps.length
      out.snapshots.elements = Object.keys(byEl).length
      out.snapshots.index = files.includes('INDEX.md') ? join(exportsDir, 'INDEX.md') : ''
      out.snapshots.recent = Object.keys(byEl).sort().slice(0, 20).map((el) => ({
        element: el, count: byEl[el].length, latest: byEl[el].sort().slice(-1)[0] || '',
      }))
    } catch { /* 还没有 exports 目录 */ }
    // ② 内核 status（一次 spawn）
    const st = await callKernel(['status'])
    if (!st.ok) {
      out.note = st.message || '内核不可用'
      elementsCache = { at: now, data: out }
      return out
    }
    const d = st.data || {}
    if (d.ok === false) {
      out.note = '库还没建（跑一次 ingest／import 就会自动建）'
      elementsCache = { at: now, data: out }
      return out
    }
    out.available = true
    out.counts = d.counts || {}
    out.pending = d.pending ?? 0
    out.bytes = d.bytes || 0
    // ③ 元素清单（再一次 spawn；给面板一张"已管理谁"的表）
    const al = await callKernel(['all'])
    const list = Array.isArray(al.data) ? al.data : []
    out.list = list.map((x) => {
      const evs = Array.isArray(x.events) ? x.events : []
      const last = evs.map((e) => e.ts).filter(Boolean).sort().pop() || ''
      return { name: x.element || x.name || '?', category: x.category || '', events: evs.length, last }
    }).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    elementsCache = { at: now, data: out }
    return out
  }

  // ---------------------------------------------------------------- 面板数据面
  disposers.push(createApi(ctx, {
    snapshot: () => buildSnapshot(),
    write: (body) => writeSwitch({ ...body, by: body && body.by === 'llm' ? 'llm' : 'user' }),
    surface: (body) => writeSurface({ ...body, by: body && body.by === 'llm' ? 'llm' : 'user' }),
    graph: (body) => runGraph({ ...body, by: body && body.by === 'llm' ? 'llm' : 'user' }),
    elements: () => elementsInfo(),
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
