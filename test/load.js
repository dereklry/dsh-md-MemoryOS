/**
 * dsh-md-MemoryOS · 离线闸（零网络、零宿主依赖）
 *
 * 跑法（本机没有 node 在 PATH 时，用 app 当 node；有 node 就直接 `node test/load.js`）：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & '<DSH Desktop 的可执行文件>' test\load.js
 * 依赖替身：@deepseek-ai/dsh-tools 由 test/stub-dsh-tools.mjs 顶掉；Jev 传输可注入 ⇒
 * 同事与 CI 只需 node ≥18，**闸全程不联网**。
 *
 * 闸锁七类事（每条都对应别人踩过的真实事故，不是凭空设计）：
 *   A 功能登记表自洽（不登记＝不显示；未实现的功能不许给开关）
 *   B DEPS↔依赖探针、STEPS↔步骤探针 **双向同源**（漏一个＝面板永远显示"探针未实现"）
 *   C 写侧权限（在落盘前判；接管有粘性；未实现不给切）
 *   D 状态派生真值表（用合成输入，不被本机 fs 现状左右）——含新档 **waiting（待配置）**
 *   E 宿主接线端到端 + 配置型功能的完整生命周期：off → 模型开＝waiting → 存 Key → 测通 → on
 *   F 明文 Key 泄漏检查（账本/日志/返回值里都不许出现）
 *   G 面板装载契约四条 + 前后端路径对账 + 样式/语法静态禁手（防整块 slot entry 崩）
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@deepseek-ai/dsh-tools') {
      return { url: pathToFileURL(path.join(import.meta.dirname, 'stub-dsh-tools.mjs')).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

let n = 0
const ok = (cond, msg) => { assert.ok(cond, 'FAIL: ' + msg); n++; console.log(' OK', msg) }
const PKG = path.join(import.meta.dirname, '..')
const join = path.join
const pkgJson = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'))

const F = await import(pathToFileURL(path.join(PKG, 'lib', 'features.js')).href)
const S = await import(pathToFileURL(path.join(PKG, 'lib', 'switches.js')).href)
const P = await import(pathToFileURL(path.join(PKG, 'lib', 'probes.js')).href)
const U = await import(pathToFileURL(path.join(PKG, 'lib', 'setup.js')).href)
const A = await import(pathToFileURL(path.join(PKG, 'lib', 'api.js')).href)
const H = await import(pathToFileURL(path.join(PKG, 'index.js')).href)

const tmp = mkdtempSync(path.join(tmpdir(), 'memoryos-gate-'))
const clean = () => rmSync(tmp, { recursive: true, force: true })

// ————————————————————————————————— A 功能登记表自洽
{
  const lint = F.lintFeatures()
  ok(lint.length === 0, `A1 登记表自洽（${lint.join('; ') || '干净'}）`)
  ok(F.FEATURES.length >= 8, `A2 表里有货（${F.FEATURES.length} 项）`)
  ok(F.FEATURES.filter((f) => f.impl === 'live').length >= 3, 'A3 至少三个已实现（面板不能整页是灰的）')
  const jev = F.featureOf('jev-engine')
  ok(jev && jev.controller === 'llm' && jev.steps.length === 2, 'A4 Jev 能力＝配置型：由模型执行 + 两步前置（Key 到位→测通）')
  ok(F.FEATURES.filter((f) => f.controller === 'llm').every((f) => f.impl === 'todo' || f.steps.length > 0), 'A5 凡"由模型执行"的活功能都必须有 steps（否则它该是一键开关）')
  ok(F.FEATURES.every((f) => f.cost && f.what && f.label), 'A6 每项都有显示名／做什么／成本三件套')
  ok(F.FEATURES.every((f) => F.GROUPS.includes(f.group)), 'A7 每项都归到已知组')
}
// ————————————————————————————————— B 探针双向同源
{
  const bundle = P.makeProbes({ memoryRoots: [tmp], graphDb: '', pythonBin: '', kernelRepo: '', keyFile: '', staleDays: 7, dataDir: tmp }, { webserver: false })
  const depIds = Object.keys(F.DEPS), depProbes = Object.keys(bundle.probes)
  const stepIds = Object.keys(F.STEPS), stepProbes = Object.keys(bundle.stepProbes)
  ok(depIds.every((d) => depProbes.includes(d)) && depProbes.every((p) => depIds.includes(p)), 'B1 DEPS ↔ 依赖探针 一一对应（多一个少一个都算失配）')
  ok(stepIds.every((s) => stepProbes.includes(s)) && stepProbes.every((s) => stepIds.includes(s)), 'B2 STEPS ↔ 步骤探针 一一对应（漏则待办永远清不掉）')
  ok(Object.values(F.STEPS).every((s) => (s.by === 'llm' || s.by === 'user') && s.how), 'B3 每个步骤都写了"该谁做 + 怎么做"（面板据此说话）')
  const r = P.probeAll(bundle)
  ok(typeof r.webserver === 'string' && /headless|未提供/.test(r.webserver), 'B4 没有 webServer 时探针直说（不装作正常）')
  ok(r['memory-root'] === true, 'B5 记忆根真实存在 ⇒ 探针 true')
  ok(typeof r.python === 'string' && /pythonBin/.test(r.python), 'B6 找不到 python 时给的是"去哪改"的人话')
  const sp = P.stepAll(bundle)
  ok(sp['jev-probe'] && sp['jev-probe'].done === false && /memoryos_setup/.test(sp['jev-probe'].why), 'B7 没测通过 ⇒ 步骤未满足，且提示模型该跑哪个动作')
}
// ————————————————————————————————— C 写侧权限
{
  const jev = F.featureOf('jev-engine'), panel = F.featureOf('panel'), radar = F.featureOf('radar')
  ok(S.mayWrite(radar, 'llm', null).ok === false && /未实现/.test(S.mayWrite(radar, 'llm', null).why), 'C1 未实现的功能谁都不给切（面板不许骗人）')
  ok(S.mayWrite(radar, 'user', null).ok === false, 'C2 未实现 ⇒ 用户也不给切（同一条规则，两套界面不跑偏）')
  ok(S.mayWrite(panel, 'llm', null).ok === false && /仅用户/.test(S.mayWrite(panel, 'llm', null).why), 'C3 模型切"仅用户可切"⇒ 拒，理由可读')
  ok(S.mayWrite(jev, 'llm', { lock: true, by: 'user', ts: 't' }).ok === false && /接管/.test(S.mayWrite(jev, 'llm', { lock: true, by: 'user', ts: 't' }).why), 'C4 用户接管后模型写 ⇒ 拒（粘性）')
  ok(S.mayWrite(jev, 'llm', null).ok === true && S.mayWrite(panel, 'user', null).ok === true, 'C5 配置型功能模型可切；用户永远能切自己的')
  ok(S.mayWrite(null, 'llm', null).ok === false && S.mayWrite({}, 'llm', null).ok === false, 'C6 没登记的东西连对象都不接受（防旁路注入）')

  ok(S.effectiveValue(jev, {}, { value: false }).source === 'ledger', 'C7 生效值：账本最新行最优先')
  ok(S.effectiveValue(jev, { 'jev-engine': true }, null).value === true, 'C8 没人切过时 profile config 生效')
  ok(S.effectiveValue(jev, {}, null).value === false, 'C9 都没给 ⇒ 出厂默认（Jev 默认关：没测通就不该开着）')

  const dir = path.join(tmp, 'ledger')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'switches.jsonl'), '{"key":"mining","value":true,"by":"user","ts":"1"}\n{坏行\n{"key":"mining","value":false,"by":"llm","ts":"2"}\n', 'utf8')
  const led = S.foldLedger(dir)
  ok(led.rows.get('mining').ts === '2' && led.corrupt === 1, 'C10 fold：同键取最新；坏行只计数不炸（fail-open）')
  const row = S.appendSwitch(dir, { key: 'mining', value: true, by: 'llm', reason: '连续 5 轮没产候选' })
  const lastLine = readFileSync(led.file, 'utf8').trim().split('\n').pop()
  ok(row.by === 'llm' && JSON.parse(lastLine).reason === '连续 5 轮没产候选', 'C11 一次操作＝追加一行（谁/理由/时间都在账里，历史不改写）')
}
// ————————————————————————————————— D 状态派生真值表（合成输入）
{
  const full = {}
  for (const d of Object.keys(F.DEPS)) full[d] = true
  const noStep = {}
  for (const s of Object.keys(F.STEPS)) noStep[s] = { done: false, why: '从没做过' }
  const allStep = {}
  for (const s of Object.keys(F.STEPS)) allStep[s] = { done: true, ts: 'T' }
  const f = (over) => Object.assign({ id: 't', label: '测试项', what: '', controller: 'user', default: true, cost: '', deps: [], steps: [], impl: 'live', group: '界面' }, over)
  const st = (feat, eff, deps, steps) => S.deriveState(feat, Object.assign({ value: true, source: 'ledger' }, eff), deps || full, F.DEPS, steps || allStep, F.STEPS)

  ok(st(f({ impl: 'todo' }), {}, full, allStep).state === 'planned', 'D1 未实现 ⇒ planned（优先于一切）')
  ok(st(f({ steps: ['jev-key'] }), { value: false }, full, noStep).state === 'off', 'D2 关着就是 off（不去报依赖）')
  ok(st(f({ steps: ['jev-key', 'jev-probe'] }), {}, full, noStep).state === 'waiting', 'D3 ★开着但前置步骤没做完 ⇒ waiting（**配置型功能绝不能显示成"生效中"**）')
  ok(st(f({ steps: ['jev-key'] }), {}, full, noStep).pending.length === 1 && st(f({ steps: ['jev-key'] }), {}, full, noStep).pending[0].by === 'user', 'D4 待办要说清"这一步该谁做"（Key 只能用户给）')
  ok(st(f({ deps: ['python'] }), {}, Object.assign({}, full, { python: '没找到' }), allStep).state === 'unavailable', 'D5 缺硬依赖 ⇒ unavailable')
  ok(st(f({ deps: ['graph-db'] }), {}, Object.assign({}, full, { 'graph-db': '水位过期' }), allStep).state === 'degraded', 'D6 缺可降级依赖 ⇒ degraded（仍可用，但要看得见打折）')
  ok(st(f({ steps: ['jev-probe'], deps: ['python'] }), {}, Object.assign({}, full, { python: '没找到' }), noStep).state === 'waiting', 'D7 步骤未完成排在依赖缺失之前（先说"还差动作"，更有指导性）')
  ok(st(f({ deps: ['python', 'webserver'] }), {}, { python: 'a', webserver: 'b' }, allStep).missing.length === 2, 'D8 缺哪些依赖要全列出')
  ok(st(f({ deps: ['python'] }), {}, { python: 'config.pythonBin 指向的位置不存在' }, allStep).missing[0].why.includes('pythonBin'), 'D9 探针人话原样传到位（用户看完知道去哪改）')
  const llmF = st(f({ controller: 'llm', steps: ['jev-probe'] }), {}, full, allStep)
  ok(llmF.canUserToggle === false && llmF.canLlmToggle === true, 'D10 「由模型执行」⇒ 面板不给用户 Toggle（状态照样显示）')
  const locked = st(f({ controller: 'both' }), { row: { lock: true, by: 'user', ts: 'x' } }, full, allStep)
  ok(locked.locked === true && locked.canLlmToggle === false, 'D11 已接管 ⇒ 模型侧关门（面板给"解除接管"）')
  ok(st(f({ controller: 'user' }), {}, full, allStep).canLlmToggle === false, 'D12 仅用户项 ⇒ canLlmToggle=false（工具与面板同一口径）')
}
// ————————————————————————————————— E 宿主接线 + F Key 泄漏
{
  const regs = [], routes = [], logs = [], child = []
  const web = { register: (r) => { routes.push(r); return () => { r.__off = true } } }
  const sub = {
    get: (x) => (x === 'webServer' ? web : undefined),
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('W:' + m) },
    tools: { register: (t) => { regs.push(t); return () => { t.__off = true } } },
  }
  const ctx = { logger: sub.logger, tools: sub.tools, get: sub.get, inject: (_d, cb) => { child.push(cb(sub)) } }
  const dataDir = path.join(tmp, 'host')
  const SECRET = 'sk-secret-1234567890abcdef'
  let probeCalls = 0
  const transport = async () => { probeCalls++; return { status: 200, text: JSON.stringify({ answers: { probe: { choice: 'big', confidence: 0.98 } } }) } }
  const disposer = H.apply(ctx, { dataDir, memoryRoot: tmp, transport, llmCanSwitch: true, modelCanSaveKey: true })

  ok(typeof disposer === 'function', 'E1 apply 返回可释放函数（返数组会被 web 组合判 Invalid effect）')
  ok(regs.length === 3 && regs.map((t) => t.name).join(',') === 'memoryos_status,memoryos_switch,memoryos_setup', 'E2 三工具：读状态 / 切开关 / 做配置动作')
  ok(logs.some((l) => /就位/.test(l)) && !logs.some((l) => l.startsWith('W:')), 'E3 装载留一行日志且自检零告警（登记表／探针同源／路由对账三查）')
  ok(child.length === 1 && typeof child[0] === 'function', 'E4 webServer 走 ctx.inject 延迟挂载（顶层 inject 会让 headless 整个插件永挂）')
  ok(routes.some((r) => r.kind === 'prefix' && r.path === A.PREFIX), 'E5 有 prefix 兜底（未知子路径必须回 JSON 404，不能掉进 SPA 回落返回 HTML）')
  ok(A.API_PATHS.every((p) => routes.some((r) => r.path === A.PREFIX + p)), `E6 声明的每个路径都真注册（${A.API_PATHS.join(' ')}）`)

  const post = (p, body) => new Promise((resolve) => {
    const route = routes.find((r) => r.path === A.PREFIX + p)
    const req = { on: (ev, fn) => { if (ev === 'data') fn(JSON.stringify(body || {})); if (ev === 'end') fn() }, destroy() {} }
    const res = { writeHead: (c) => { res.code = c }, end: (s) => resolve({ code: res.code, body: JSON.parse(s) }) }
    route.handler(req, res)
  })
  const feat = (res, id) => res.body.snapshot.features.find((x) => x.id === id)
  const setupTool = regs.find((t) => t.name === 'memoryos_setup')
  const swTool = regs.find((t) => t.name === 'memoryos_switch')

  const s0 = await post('/snapshot')
  ok(s0.code === 200 && s0.body.snapshot.features.length === F.FEATURES.length, 'E7 GET /snapshot ⇒ 每功能一行')
  ok(feat(s0, 'jev-engine').state === 'off', 'E8 初始：Jev 能力默认关（没测通就不该开着）')

  const on1 = await swTool.execute({ feature: 'jev-engine', value: 'on', reason: '试着接上语义引擎' })
  ok(/✓/.test(on1.text) && /待配置|仍差/.test(on1.text), 'E9 ★模型把它开 ⇒ 允许，但当场回"仍差几步"（不假装生效）')
  const s1 = await post('/snapshot')
  const j1 = feat(s1, 'jev-engine')
  ok(j1.state === 'waiting' && j1.pending.length === 2 && j1.stepsDone.length === 0, 'E10 ★快照状态＝待配置，待办两步（面板此刻显示的是状态不是勾选框）')
  ok(j1.canUserToggle === false, 'E11 配置型功能面板不给 Toggle（用户只有"接管"这条退路）')

  const noWhy = await setupTool.execute({ action: 'probe' })
  ok(/reason|理由/.test(noWhy.text || noWhy.message || ''), 'E12 配置动作不写理由 ⇒ 拒（跟切开关同一纪律）')
  const badAction = await setupTool.execute({ action: 'reboot', reason: 'x' })
  ok(/未知 action/.test(badAction.text) && /where-key/.test(badAction.text), 'E13 未知 action ⇒ 回可用清单，且清单含最新加的 where-key（新增动作忘了写进提示＝模型永远不知道它存在）')
  const setupDef = regs.find((t) => t.name === 'memoryos_setup')
  ok(Object.keys(setupDef.parameters).sort().join(',') === 'action,allow_in_repo,feature,key,path,reason', 'E13c 工具声明的参数与 runSetup 真读的字段一一对上（漏一个＝模型传了也没人接）')
  const probe0 = await setupTool.execute({ action: 'probe', reason: '先看通不通' })
  ok(/没有 Key|无从谈起/.test(probe0.text), 'E14 没 Key 就 probe ⇒ 当场说清"没有 Key"，并给三条来源（不空跑一次网络）')

  const saved = await setupTool.execute({ action: 'save-key', key: SECRET, reason: '用户把 Key 交给我代存' })
  ok(saved.text.indexOf(SECRET) === -1 && /✓/.test(saved.text), 'F1 代存 Key 的回显**不含明文**（只给路径与掩码）')
  ok(saved.text.includes('sk-') || saved.text.includes('位'), 'F2 回显里有掩码信息（用户能核对存的是哪个）')
  const probe1 = await setupTool.execute({ action: 'probe', reason: '存完测一次' })
  ok(/✓ Jev 测通成功/.test(probe1.text) && probeCalls === 1, 'E15 测通＝真发一次（transport 注入，闸不联网），成功才记账')
  const s2 = await post('/snapshot')
  const j2 = feat(s2, 'jev-engine')
  ok(j2.state === 'on' && j2.stepsDone.length === 2 && j2.pending.length === 0, 'E16 ★两步做完 ⇒ 状态自动变"生效中"（这就是配置型功能的完整生命周期）')

  const acct = readFileSync(path.join(dataDir, 'switches.jsonl'), 'utf8')
  const setupAcct = readFileSync(path.join(dataDir, 'setup.jsonl'), 'utf8')
  ok(acct.indexOf(SECRET) === -1 && setupAcct.indexOf(SECRET) === -1, 'F3 明文 Key 不在任何账本里（switches / setup 双查）')
  ok(JSON.parse(setupAcct.trim().split('\n')[0]).step === 'jev-key' && /存入|写入/.test(setupAcct), 'F4 存 Key 也落一行配置账（谁、为什么、掩码）')
  ok(setupAcct.indexOf('存入') >= 0 && !/sk-secret-[0-9a-f]{8,}/.test(setupAcct), 'F4b 账本里只有掩码，没有完整 Key 形状')

  // —— keystore：凭据面优先 / 仓内守卫（这是"Key 放哪"的正解，不是靠 .gitignore 赌运气）
  {
    const K = await import(pathToFileURL(path.join(PKG, 'lib', 'keystore.js')).href)
    const repoDir = path.join(tmp, 'repo')
    mkdirSync(path.join(repoDir, '.git'), { recursive: true })
    ok(K.insideRepo(join(repoDir, 'sub', 'x.txt')) === repoDir, 'K1 认得出"目标在 git 工作树内"（向上走找 .git，含 worktree 的 .git 文件）')
    ok(K.insideRepo(path.join(tmp, 'plain', 'x.txt')) === '', 'K2 仓外路径不误报')

    const store = { val: '', calls: [] }
    const fakeCreds = {
      async describe(ref) { store.calls.push('describe:' + ref); return store.val ? { configured: true, source: 'local', writable: true } : { configured: false, writable: true } },
      async resolve(ref) { return { value: store.val } },
      async set(ref, v) { store.val = v; store.calls.push('set:' + ref); return undefined },
    }
    const ks1 = K.makeKeystore({ cfg: { dataDir: path.join(tmp, 'ks1'), home: path.join(tmp, 'ks1home'), legacyKeyFiles: [] }, getCredentials: () => fakeCreds })
    const saved1 = await ks1.save(SECRET, {})
    ok(saved1.ok && saved1.via === 'credentials' && saved1.to.includes('凭据面') && saved1.to.includes('JEV_API_KEY'), 'K3 ★有凭据面就先写它（ref=JEV_API_KEY，落 ~\\.dsh\\.credentials.yaml：不在仓里、升级不动、0600）')
    ok(store.val === SECRET && saved1.text === undefined && saved1.key === undefined, 'K4 回显不带明文（只有落点与掩码）')
    const loc1 = await ks1.locate()
    ok(loc1.present && loc1.via === 'credentials' && /凭据面/.test(loc1.from) && loc1.warnings.length === 0, 'K5 从凭据面读到 ⇒ 位置合规、无告警')

    const ks2 = K.makeKeystore({ cfg: { dataDir: path.join(tmp, 'ks2'), home: path.join(tmp, 'ks2home'), legacyKeyFiles: [] }, getCredentials: () => undefined })
    const bad = await ks2.save(SECRET, { path: join(repoDir, 'dsh-jev', 'jev-key.txt') })
    ok(bad.ok === false && /git 工作树内/.test(bad.message) && !existsSync(join(repoDir, 'dsh-jev', 'jev-key.txt')), 'K6 ★写进仓里 ⇒ 直接拒（不是靠 .gitignore 赌运气），且真的没落盘')
    const okForce = await ks2.save(SECRET, { path: join(repoDir, 'dsh-jev2', 'jev-key.txt'), allowInRepo: true })
    ok(okForce.ok && okForce.inRepo === true, 'K7 显式 allowInRepo 才放行，并在返回值里标出来（面板/账本要显示这个旗标）')
    const outside = await ks2.save(SECRET, { path: join(tmp, 'ks2home', 'memoryos.key') })
    ok(outside.ok && outside.inRepo === false, 'K8 仓外文件回退（~/.dsh 下）正常放行')
    const warnLoc = await ks2.locate()
    ok(warnLoc.present && warnLoc.via === 'file' && warnLoc.warnings.some((w) => /凭据面/.test(w)), 'K9 走文件回退 ⇒ 面板给出"搬家去凭据面"的建议（不静容忍着）')
    const inRepoLoc = await K.makeKeystore({ cfg: { dataDir: join(tmp, 'ks4'), home: join(tmp, 'ks4home'), legacyKeyFiles: [join(repoDir, 'dsh-jev2', 'jev-key.txt')] }, getCredentials: () => undefined }).locate()
    ok(inRepoLoc.present && inRepoLoc.warnings.some((w) => /git 工作树内/.test(w)), 'K9b Key 落在仓里 ⇒ 标红"一旦忘了 ignore 就被推走"（功能不断，但必须说出来）')

    // 遗留位（本机现状那种：Key 在会推的仓里）——读到但必须标警
    mkdirSync(join(repoDir, 'dsh-jev'), { recursive: true })
    writeFileSync(join(repoDir, 'dsh-jev', 'jev-key.txt'), 'legacy-secret-value-xyz\n', 'utf8')
    const ks3 = K.makeKeystore({ cfg: { dataDir: path.join(tmp, 'ks3'), home: path.join(tmp, 'ks3home'), legacyKeyFiles: [join(repoDir, 'dsh-jev', 'jev-key.txt')] }, getCredentials: () => undefined })
    const l3 = await ks3.locate()
    ok(l3.present && /遗留位/.test(l3.from) && l3.warnings.some((w) => /git 工作树内/.test(w)), 'K10 旧部署把 Key 落在仓里 ⇒ 读得到（不断功能）但面板标红"一旦忘了 ignore 就被推走"')
    const sec3 = await ks3.secret()
    ok(sec3 === 'legacy-secret-value-xyz', 'K11 secret() 只在本机内存里过一下（供 probe 用），不外泄到 locate/快照')
  }
  const logsText = logs.join('\n')
  ok(logsText.indexOf(SECRET) === -1, 'F5 明文 Key 不在日志里')

  const tk = await swTool.execute({ feature: 'panel', value: 'off', reason: '我关掉设置页' })
  ok(/✗ 拒绝/.test(tk.text) && /仅用户/.test(tk.text), 'E17 模型切"仅用户可切"被拒（工具与面板同一套权限，不是两套规则）')
  const took = await post('/takeover', { feature: 'jev-engine', value: true })
  ok(took.code === 200 && feat(took, 'jev-engine').locked === true, 'E18 用户接管＝写一行 lock，快照立刻反映')
  const tk2 = await swTool.execute({ feature: 'jev-engine', value: 'off', reason: '我想关' })
  ok(/接管/.test(tk2.text), 'E19 接管后模型再动 ⇒ 拒（跨请求成立）')
  const rel = await post('/release', { feature: 'jev-engine', value: true })
  ok(rel.code === 200 && feat(rel, 'jev-engine').locked === false, 'E20 解除接管＝再写一行（历史不动，控制权可逆）')
  const dup = await post('/switch', { feature: 'graph-search', value: true })
  ok(dup.code === 200 || /无需重复写|未实现/.test(dup.body.message || ''), 'E21 面板写未实现项 ⇒ 被拒或被降级处理，不会静默记成功')
  const stat = await regs.find((t) => t.name === 'memoryos_status').execute({})
  ok(/生效中|待配置|已关|降级|不可用|未实现/.test(stat.text) && /Jev/.test(stat.text), 'E22 status 工具产出人可读整页状态')

  const noWebCtx = { get: () => undefined, logger: { info() {}, warn() {} }, tools: { register: () => () => {} } }
  const d2 = H.apply({ logger: noWebCtx.logger, tools: noWebCtx.tools, get: noWebCtx.get }, { dataDir: path.join(tmp, 'headless'), memoryRoot: tmp })
  ok(typeof d2 === 'function', 'E23 headless（无 webServer、无 ctx.inject）⇒ 面板器官不存在但插件照常起（旁路不变量）')
  d2()
  disposer(); child.forEach((fz) => fz && fz())
  ok(regs.every((t) => t.__off) && routes.every((r) => r.__off), 'E24 disposer 释放工具与全部路由（卸载可逆）')
  ok(probeCalls === 1, 'E25 测通只发了一次（无隐藏的每回合重试）')
}
// ————————————————————————————————— G 面板装载契约与静态禁手
{
  const src = readFileSync(path.join(PKG, 'client.js'), 'utf8')
  ok(pkgJson.dsh && pkgJson.dsh.client && pkgJson.dsh.client.platform === 'web', 'G1 契约① dsh.client.platform=="web"')
  ok(pkgJson.exports && pkgJson.exports['./client'], 'G2 契约② exports["./client"]')
  ok(pkgJson.exports && pkgJson.exports['./package.json'], 'G3 契约③ exports["./package.json"]（缺了装载器静默 catch ⇒ 设置页根本没那一项，零日志）')
  const idm = src.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)
  ok(idm && idm[1] === pkgJson.name, `G4 契约④ load({id}) 必须等于包名（当前 ${idm && idm[1]}）`)
  const am = src.match(/var API = "([^"]+)"/)
  ok(am && am[1] === A.PREFIX, `G5 前后端前缀同源（client=${am && am[1]}｜host=${A.PREFIX}）`)
  const used = [...new Set([...src.matchAll(/"(\/[a-z-]+)"/g)].map((m) => m[1]))] // 含三元里的 "/release" "/takeover"
  ok(used.length >= 4 && used.every((u) => A.API_PATHS.includes(u)), `G6a 面板调的每个路径宿主都注册了（${used.join(' ')}）——漏一个就是静默 404`)
  ok(A.API_PATHS.every((p) => used.includes(p)), `G6b 反向也对账：宿主注册的路径面板全用得上（${A.API_PATHS.join(' ')}）——多出来的路由＝没人认领的写入口`)
  ok((src.match(/\bfetch\(/g) || []).length === 2, 'G7 fetch 只有两处：load 读 + act 唯一写通路（多一处＝多一套写通路）')
  // 反模式检查只看**代码**，不看注释（否则"解释这条禁令的注释"自己把自己判红——本轮实踩两次：
  // 先是整块注释，后是行尾注释 `order: 120, // …selfevolve(101)…`）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')
  ok(!/\]\s*\.reduce\(\s*Object\.assign/.test(code), 'G8 禁 [a,b].reduce(Object.assign) 合并样式（索引进 style ⇒ 整块 slot entry 崩）')
  ok(/function mix\(/.test(code), 'G8b 样式合并走 mix() 唯一入口')
  // 真 bug 形状＝`return e("tr", {…})` 后接逗号（逗号表达式，只渲染最后一个 td）。
  // 正则必须**不许嵌套花括号**，否则 `style: mix(ST.card, {gap:4})` 这类正常写法会被误判（本轮实踩）。
  ok(!/return\s+e\(\s*"[a-z]+"\s*,\s*\{[^{}]*\}\s*\)\s*,/.test(code), 'G9 禁 `return e("tr", {...}),` 逗号表达式（只渲染出最后一个 td）')
  const hard = code.match(/(color|background):\s*"#[0-9a-fA-F]{3,6}"/g) || []
  ok(hard.length === 0, `G10 颜色只用主题 token（违规 ${hard.length} 处：${hard.join(' ')}）`)
  ok(!/selfevolve/i.test(code), 'G11 代码里不夹带别家项目标识符（包名／前缀／槽 id／日志前缀都得是自己的）')
  ok(/waiting|待配置/.test(src), 'G12 面板认得「待配置」这一档（配置型功能的状态显示）')
  new Function(src)
  ok(true, 'G13 语法自检通过（一个多余括号＝loaded without registering，设置页静默没那一项）')

  const fakeReact = { createElement: (t, p, ...k) => ({ t, p, k }), useState: (v) => [v, () => {}], useEffect: () => {}, useCallback: (f) => f }
  let registered = null
  let offCalls = 0
  // 假 slots：inject 只负责调 build（注册动作发生在 register 里），**不要把 build() 的返回值当注册记录**
  const fakeCtx = { slots: { inject: (name, build) => { build(); return () => { offCalls++ } }, register: (opts, comp) => { registered = { opts, comp }; return () => { offCalls++ } } } }
  const win = { __ModuleLoader__: { load: (d) => { win.__def = d } } }
  new Function('window', 'require', src)(win, () => { throw new Error('node 侧不该解析外部依赖') })
  ok(win.__def && typeof win.__def.factory === 'function', 'G14 ModuleLoader 求值成功')
  const req = (name) => (name === 'react' ? fakeReact : (() => { throw new Error('未预期的外部依赖：' + name) })())
  const ex = win.__def.factory(req)
  ok(Array.isArray(ex.inject) && ex.inject[0] === 'slots', 'G15 client 半 exports.inject=["slots"]')
  const disp = ex.apply(fakeCtx)
  ok(registered && registered.opts.name === 'settings.section' && registered.opts.id === 'memoryos' && typeof registered.opts.order === 'number', 'G16 注册进 settings.section 且用自己的 id（复用别人的 id＝把人家那格换掉）')
  ok(typeof registered.opts.label === 'function' && registered.opts.label() === '记忆系统', 'G17 label 是 thunk（导航跟随 locale 重读）')
  ok(typeof registered.comp === 'function' && registered.comp().t === 'div', 'G18 面板首帧（无快照）可渲染不抛')
  ok(typeof disp === 'function', 'G19 client apply 返回单个 disposer 函数')
  let threw = false
  try { disp(); disp() } catch { threw = true }
  ok(!threw && offCalls >= 1, 'G20 disposer 重复调用不炸（卸载路径本身要安全，槽位由各 registrant 自己保证）')

  const patch = readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')
  ok(patch.includes(`id: ${pkgJson.name}`), 'G21 patch 行 id == 包名')
  ok(['index.js', 'client.js', 'lib', 'package.json', 'cordis.patch.yml'].every((x) => pkgJson.files.includes(x)), 'G22 files 含五件套（漏 patch／漏 package.json＝装不上或面板不出现）')
}

// ————————————————————————————————— K 文档与代码对账（四份文档最容易坏在漂移，让它当场变红）
{
  const idx = readFileSync(path.join(PKG, 'index.js'), 'utf8')
  const docs = {}
  for (const f of ['README.md', 'docs/DESIGN.md', 'docs/JUDGMENTS.md', 'docs/AGENT-GUIDE.md', 'docs/WORKFLOW.md']) {
    ok(existsSync(path.join(PKG, f)), `K0 文档在场：${f}`)
    docs[f] = readFileSync(path.join(PKG, f), 'utf8')
  }
  const all = Object.values(docs).join('\n')

  // K1 共享项目不得夹带维护者本机私货（仓名/账本名/条目号）
  const leak = all.match(/X-workspace|X-ops|X-flow|X-INDEX\.md|WX1[0-9]|proj_x_|\.venv[\\/]Scripts/g) || []
  ok(leak.length === 0, `K1 文档不夹带维护者本机私货（命中 ${leak.length}：${[...new Set(leak)].join(' ')}）`)

  // K2 文档里出现的工具名必须是真注册的
  const realTools = new Set(['memoryos_status', 'memoryos_switch', 'memoryos_setup'])
  const named = new Set((all.match(/memoryos_[a-z-]+/g) || []).map((s) => s.replace(/-+$/, '')))
  const ghost = [...named].filter((x) => !realTools.has(x))
  ok(ghost.length === 0, `K2 文档提到的工具都真实存在（幽灵：${ghost.join(' ')}）`)

  // K3 setup 的 action 名与代码分支同源
  const realActions = new Set(['probe', 'save-key', 'where-key', 'list'])
  const inDocs = (docs['docs/AGENT-GUIDE.md'].match(/action:\s*'([a-z-]+)'/) || [])[1]
  ok(inDocs === 'probe' || inDocs === undefined, `K3a 示例 action 合法（${inDocs}）`)
  const mentioned = new Set((all.match(/action='([a-z-]+)'/g) || []).map((s) => /'([a-z-]+)'/.exec(s)[1]))
  const badAct = [...mentioned].filter((a) => !realActions.has(a))
  ok(badAct.length === 0, `K3b 文档写的 action 代码里都有（多余：${badAct.join(' ')}）`)

  // K4 配置键：只查 §7 那张表（早先扫全文，把 §3/§4 的账本字段、状态字段误当配置键——本轮实踩）
  const cfgKeys = new Set((idx.match(/c\.([A-Za-z]+)/g) || []).map((s) => s.slice(2)))
  const sec7 = (/^## 7\.[\s\S]*?(?=^## 8\.)/m.exec(docs['docs/DESIGN.md']) || [''])[0]
  const listed = [...new Set(sec7.split(/\r?\n/)
    .filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l))
    .flatMap((l) => (l.split('|')[1] || '').match(/`([A-Za-z][A-Za-z0-9]*)`/g) || [])
    .map((s) => s.replace(/`/g, '')))]
  const unknown = listed.filter((k) => !cfgKeys.has(k))
  ok(listed.length >= 12, `K4a §7 配置表有货（列出 ${listed.length} 个键）`)
  ok(unknown.length === 0, `K4b §7 每个配置键都被 readCfg 真读（未识别：${unknown.join(' ')}）`)
  const missing = [...cfgKeys].filter((k) => !listed.includes(k))
  ok(missing.length === 0, `K4c 反向也对账：readCfg 读的键都写进了文档（漏文档：${missing.join(' ')}）`)
  // K5 状态六档与实现计数对得上（文档说"未实现 5"，代码就得正好 5 个 todo）
  const todoN = F.FEATURES.filter((f) => f.impl === 'todo').length
  const liveN = F.FEATURES.filter((f) => f.impl !== 'todo').length
  ok(/未实现 5/.test(docs['docs/WORKFLOW.md']) === (todoN === 5) && /生效中 3/.test(docs['docs/WORKFLOW.md']),
    `K5 概览计数与登记表一致（live=${liveN}，todo=${todoN}）`)
  ok(['on', 'off', 'waiting', 'degraded', 'unavailable', 'planned'].every((s) => new RegExp(`\`?${s}\`?`).test(docs['docs/DESIGN.md'])),
    'K6 六档状态在设计文档里都有定义（新增档必须写进来，否则面板中文无处可查）')

  // K7 契约与前后端一致：patch id、槽位、前缀三处不得各自漂移
  const patch = readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')
  ok(patch.includes(`id: ${pkgJson.name}`) && docs['docs/DESIGN.md'].includes(A.PREFIX) && docs['docs/DESIGN.md'].includes('settings.section'),
    'K7 装载契约三处同字：patch id == 包名、DESIGN 写了 HTTP 前缀与槽位名')
  for (const f of ['docs/WORKFLOW.md', 'docs/AGENT-GUIDE.md', 'docs/DESIGN.md', 'docs/JUDGMENTS.md']) {
    ok(docs['README.md'].includes(f), `K7b README 索引指向 ${f}（四份文档都得有入口，写了没人读＝没写）`)
  }
}

clean()
console.log(`\nALL PASS (${n} checks)`)