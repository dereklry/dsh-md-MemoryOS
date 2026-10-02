/**
 * dsh-md-MemoryOS · 离线闸（零网络、零宿主依赖）
 *
 * 跑法（本机没有 node 在 PATH 时，用 app 当 node；有 node 就直接 `node test/load.js`）：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "<DSH Desktop 的可执行文件>" test\load.js   ← Electron 套壳自带 node，用 ELECTRON_RUN_AS_NODE 当 node 用
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
const V = await import(pathToFileURL(path.join(PKG, 'lib', 'surface.js')).href)
const GR = await import(pathToFileURL(path.join(PKG, 'lib', 'graph.js')).href)
const AR = await import(pathToFileURL(path.join(PKG, 'lib', 'archive.js')).href)
const A = await import(pathToFileURL(path.join(PKG, 'lib', 'api.js')).href)
const H = await import(pathToFileURL(path.join(PKG, 'index.js')).href)

const tmp = mkdtempSync(path.join(tmpdir(), 'memoryos-gate-'))
// Windows 上 git 仓里的对象文件是只读的，rm 可能 EPERM：**清理失败不该判闸失败**（系统临时目录会自己回收）
const clean = () => { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) } catch { /* 见上 */ } }

/** 测试语料：一份手册 + 一份事项（含触发行、条目号互指、一个指向不存在文件的引用、一个没人指的条目） */
const L = (...a) => a.join('\n')
function makeCorpus(dir) {
  mkdirSync(path.join(dir, 'notes'), { recursive: true })
  writeFileSync(path.join(dir, 'manual.md'), L(
    '# 手册', '', '## 一、事件流水', '', '### AA1 装插件要按七步走', '- **触发**：装插件；上线七步；回滚锚',
    '正文里见 AA2，还指了一个不存在的 `notes/gone.md`。', ''), 'utf8')
  writeFileSync(path.join(dir, 'notes', 'alpha.md'), L(
    '# Alpha 事项', '', '### AA2 Alpha 的做法', '- **触发**：alpha 怎么写', '这里回指 [AA1 装插件要按七步走](../manual.md)。', '',
    '### AA3 没人指的条目', '（故意不留触发行，也没人引用）', ''), 'utf8')
  return dir
}

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
  // A8 ★ radar 降级为默认不开启（2026-10-02 用户拍板）——默认值 + 说明 + 文档三处钉住
  const rd = F.featureOf('radar')
  ok(rd && rd.default === false, 'A8 ★ radar 出厂默认＝false（降级为默认不开启：装上也零花费，要试须显式 opt-in）')
  ok(rd.impl === 'todo' && /降级/.test(rd.what) && /JUDGMENTS/.test(rd.what), 'A8b radar 仍是 todo（降级≠已实现），且登记说明自述"已降级"并指向 JUDGMENTS（面板/工具读到的话不误导）')
  ok(/默认关|零花费/.test(rd.cost), 'A8c radar 的成本行写明"默认关＝零花费"（用户看成本那一栏就懂）')
  // A9 语义能力的新形态（2026-10-02 用户口径：**只提供 jev 工具，可调用、但不是主力**）
  const je = F.featureOf('jev-engine'), fd = F.featureOf('find')
  ok(je && /按需/.test(je.what) && /不是每回合主力/.test(je.what), 'A9 jev-engine 定位＝"按需可调用的工具"，明写不是每回合主力')
  ok(fd && fd.default === false && fd.impl === 'todo' && fd.controller === 'llm' && (fd.steps || []).length === 2,
    'A9b 新增 `find`（按需语义寻路）＝未实现 / 默认关 / 模型执行 + 两步前置（Key→测通）')
  ok(fd && /主力形态/.test(fd.what) && /不调不花/.test(fd.cost), 'A9c find 的说明写明"这才是语义能力的主力形态"，成本写明"不调不花"')
  ok(/按需/.test(rd.what) && /旧形态/.test(rd.what), 'A9d radar 的说明写明它是"旧形态"、语义能力改走"按需工具"（三处口径一致）')
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
  ok(regs.length === 5 && regs.map((t) => t.name).join(',') === 'memoryos_status,memoryos_switch,memoryos_setup,memoryos_surface,memoryos_graph', 'E2 五工具：状态／切开关／配置动作／资料面／指针图')
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
  // 资料面页：函数在、分支在、用的字段必须是快照真给的（点了空白＝最难查的静默失败）
  const sv = (/function Surface\(props\) \{([\s\S]*?)\n\t\t\}/.exec(src) || ['', ''])[1]
  ok(sv.length > 500, 'G14b 资料面页组件成形')
  ok(/else if \(tab === "surface"\) body = Surface\(/.test(src), 'G14c 页签分支接得上（有组件没分支＝点了没反应）')
  const surfaceKeys = ['exts', 'prune', 'roots', 'excludes', 'totals', 'ledger', 'hint']
  const svUnused = surfaceKeys.filter((k) => !new RegExp(`s\\.${k}`).test(sv))
  ok(svUnused.length === 0, `G14d 资料面页把快照给的字段都用上了（没用：${svUnused.join(' ')}）`)
  const realOpsAnywhere = new Set([...readFileSync(path.join(PKG, 'index.js'), 'utf8').matchAll(/op === '([a-z-]+)'/g)].map((m) => m[1]))
  const svOps = new Set([...sv.matchAll(/op:\s*"([a-z-]+)"/g)].map((m) => m[1]))
  const svBadOps = [...svOps].filter((o) => !realOpsAnywhere.has(o))
  ok(svOps.has('add-root') && svBadOps.length === 0, `G14e 面板发的每个 op 代码都认（不认：${svBadOps.join(' ')}）`)
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

// ————————————————————————————————— L 资料面：管到哪些目录、排掉哪些子目录与文件
{
  const nrm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const surf = path.join(tmp, 'surf')
  const root = path.join(surf, 'notes')
  const base = path.join(surf, 'baseline')
  for (const d of [root, base, path.join(root, 'drafts'), path.join(root, 'drafts-old'), path.join(root, 'archive', 'y2024'), path.join(root, 'node_modules', 'pkg')]) mkdirSync(d, { recursive: true })
  writeFileSync(path.join(root, 'a.md'), '# a', 'utf8')
  writeFileSync(path.join(root, 'todo.md'), '# t', 'utf8')
  writeFileSync(path.join(root, 'x.txt'), 'txt 不在管理类型内', 'utf8')
  writeFileSync(path.join(root, 'drafts', 'd1.md'), '# d1', 'utf8')
  writeFileSync(path.join(root, 'drafts', 'd2.draft.md'), '# d2', 'utf8')
  writeFileSync(path.join(root, 'drafts-old', 'keep.md'), '# keep', 'utf8')
  writeFileSync(path.join(root, 'archive', 'y2024', 'old.md'), '# old', 'utf8')
  writeFileSync(path.join(root, 'node_modules', 'pkg', 'readme.md'), '# noise', 'utf8')
  const cfgS = { dataDir: path.join(surf, 'state'), memoryRoots: [base], legacyKeyFiles: [] }

  // —— 排除语义（用户点名要的能力：具体子目录 + 具体文件）
  ok(V.matchExclude('drafts/d1.md', 'x/drafts/d1.md', 'drafts/'), 'L1 「drafts/」挡住根下那个子树')
  ok(!V.matchExclude('drafts-old/keep.md', 'x/drafts-old/keep.md', 'drafts/'), 'L2 「drafts/」不误伤 drafts-old/（前缀边界）')
  ok(V.matchExclude('deep/inner/todo.md', 'x/deep/inner/todo.md', 'todo.md'), 'L3 「todo.md」挡住任意层级的同名文件')
  ok(V.matchExclude('drafts/d2.draft.md', 'x/drafts/d2.draft.md', '*.draft.md'), 'L4 「*.draft.md」按命名模式挡')
  ok(V.matchExclude('archive/y2024/old.md', 'x/archive/y2024/old.md', 'archive/**'), 'L5 「archive/**」挡住整棵子树（跨层）')
  ok(V.matchExclude('a.md', nrm(root) + '/a.md', nrm(root)), 'L6 给绝对路径也挡得住（同一入口两种口径）')
  ok(!V.matchExclude('a.md', nrm(root) + '/a.md', 'b.md'), 'L7 不相干的规则不乱挡')
  ok(V.badPattern('*') !== '' && V.badPattern('**') !== '' && V.badPattern('a') !== '', 'L8 一把梭／过短规则直接拒（否则等于悄悄关掉资料面）')
  ok(V.badPattern('notes/drafts/') === '' && V.badPattern('*.draft.md') === '', 'L9 正常写法放行')

  // —— 目录校验与并集来源
  const f0 = V.foldSurface(cfgS.dataDir)
  ok(V.badRoot('nope-dir-xyz', cfgS, f0).includes('不存在'), 'L10 不存在的目录不给纳入')
  ok(V.badRoot(path.join(root, 'a.md'), cfgS, f0).includes('不是目录'), 'L11 指到文件上不给纳入（提示怎么办）')
  ok(V.badRoot(base, cfgS, f0).includes('profile 基线'), 'L12 与 profile 基线重复 ⇒ 拒')
  const er0 = V.effectiveRoots(cfgS, f0)
  ok(er0.length === 1 && er0[0].source === 'profile' && er0[0].removable === false, 'L13 profile 基线＝只读一行（面板不删宿主配置）')
  V.appendSurface(cfgS.dataDir, { op: 'add-root', path: nrm(root), by: 'user' })
  const er1 = V.effectiveRoots(cfgS, V.foldSurface(cfgS.dataDir))
  ok(er1.length === 2 && er1[1].source === 'ledger' && er1[1].removable === true, 'L14 面板加的根＝并集增量，来源可辨、可移除')
  V.appendSurface(cfgS.dataDir, { op: 'add-root', path: nrm(root), by: 'llm' })
  ok(V.effectiveRoots(cfgS, V.foldSurface(cfgS.dataDir)).length === 2, 'L15 重复添加同一目录不产生第二个根')

  // —— 扫描与视图（只数文件名，不读内容）
  const sc0 = V.scanRoot(root, { excludes: [], cap: 400 })
  ok(sc0.matched === 6 && !sc0.samples.some((p) => p.includes('node_modules')), `L16 只数 .md 且跳过 node_modules（实测 ${sc0.matched} 个）`)
  const sc1 = V.scanRoot(root, { excludes: [{ pattern: 'drafts/' }], cap: 400 })
  ok(sc1.matched === 4 && sc1.excluded === 2 && sc1.byRule['drafts/'] === 2, 'L17 排除子目录后：纳管数下降、归因到具体规则')
  ok(sc1.samples.every((p) => !p.startsWith('drafts/')), 'L18 样本里不再出现被挡路径（面板不许拿被排除的文件充数）')
  const view = V.surfaceView(cfgS, V.foldSurface(cfgS.dataDir), { cap: 400 })
  ok(view.exts.join(',') === '.md' && /固定/.test(view.hint), 'L19 文件类型固定 .md，并带"要管别的类型怎么办"的提示语')
  ok(view.roots.length === 2 && view.totals.dirsMissing === 0 && view.roots[1].path === nrm(root), 'L20 视图列出每根（含来源与计数）')
  const pv = V.preview(cfgS, V.foldSurface(cfgS.dataDir), 'archive/**', { cap: 400 })
  ok(pv.ok && pv.total === 1 && /会挡住 1 个/.test(pv.message), 'L21 试算＝先看清会挡什么，再决定落账')
  const pv0 = V.preview(cfgS, V.foldSurface(cfgS.dataDir), 'nope/**', { cap: 400 })
  ok(pv0.ok && pv0.total === 0 && /一个 .md 都挡不到/.test(pv0.message), 'L22 试算挡不到 ⇒ 明说"多半路径写错"，不加了才知道')

  // —— 探针必须用「生效根并集」（否则面板加了根还说没根）
  const b1 = P.makeProbes({ ...cfgS, rootsOf: () => V.effectiveRoots(cfgS, V.foldSurface(cfgS.dataDir)).map((r) => r.path) }, { webserver: true })
  ok(P.probeAll(b1)['memory-root'] === true, 'L23 只有面板加的根也算数（依赖探针走并集）')
  const b2 = P.makeProbes({ ...cfgS, rootsOf: () => [] }, { webserver: true })
  ok(/profile|资料面/.test(P.probeAll(b2)['memory-root']), 'L24 一个根都没有时探针直接指路（改 profile 或用面板）')

  // —— HTTP 与工具层（面板/模型同一个 writeSurface）
  const regs2 = [], routes2 = []
  const sub2 = {
    get: (x) => (x === 'webServer' ? { register: (r) => { routes2.push(r); return () => {} } } : undefined),
    logger: { info() {}, warn() {} }, tools: { register: (t) => { regs2.push(t); return () => {} } },
  }
  const dirS = path.join(surf, 'hoststate')
  const disposerS = H.apply({ logger: sub2.logger, tools: sub2.tools, get: sub2.get, inject: (_d, cb) => cb(sub2) },
    { dataDir: dirS, memoryRoot: base, transport: async () => ({ status: 200, text: '{"answers":{"probe":{"choice":"big","confidence":0.9}}}' }) })
  const post2 = (p, body) => new Promise((res) => {
    const route = routes2.find((r) => r.path === A.PREFIX + p)
    const req = { on: (ev, fn) => { if (ev === 'data') fn(JSON.stringify(body || {})); if (ev === 'end') fn() }, destroy() {} }
    const rr = { writeHead: (c) => { rr.code = c }, end: (s) => res({ code: rr.code, body: JSON.parse(s) }) }
    route.handler(req, rr)
  })
  const surfOf = (r) => r.body.snapshot.surface
  ok(surfOf(await post2('/snapshot')).roots.length === 1, 'L25 起步：只有 profile 基线一个根')
  const add1 = await post2('/surface', { op: 'add-root', path: nrm(root) })
  ok(add1.code === 200 && surfOf(add1).roots.length === 2 && surfOf(add1).totals.managed > 0, 'L26 面板加目录 ⇒ 立刻进快照并数到文件（不用重启）')
  const star = await post2('/surface', { op: 'add-exclude', pattern: '*' })
  ok(star.code === 400 && /整个资料面/.test(star.body.message), 'L27 面板想"排除一切"被拒（这条会静默清空资料面）')
  const typo = await post2('/surface', { op: 'add-exclude', pattern: 'nope/**' })
  ok(typo.code === 400 && /挡不到/.test(typo.body.message), 'L28 写错的排除规则加不上（试算挡不到＝拒绝，不留下"以为排除了"的错觉）')
  const before = surfOf(await post2('/surface', { op: 'preview', pattern: 'drafts/' })).totals.managed
  const ex1 = await post2('/surface', { op: 'add-exclude', pattern: 'drafts/', reason: '草稿不算资料' })
  ok(ex1.code === 200 && surfOf(ex1).totals.managed === before - 2 && surfOf(ex1).excludes[0].hits === 2, 'L29 排除子目录生效且有归因计数（hits＝这条挡了几个）')
  ok(surfOf(await post2('/snapshot')).roots.find((r) => r.path === nrm(base)).removable === false, 'L30 基线根在面板上是只读行（不可移除）')
  const dropBase = await post2('/surface', { op: 'drop-root', path: nrm(base) })
  ok(dropBase.code === 400 && /profile/.test(dropBase.body.message), 'L31 试图从面板删 profile 基线 ⇒ 拒并告知改哪')
  const unex = await post2('/surface', { op: 'drop-exclude', pattern: 'drafts/' })
  ok(unex.code === 200 && surfOf(unex).totals.managed === before && surfOf(unex).excludes.length === 0, 'L32 解除排除 ⇒ 文件回到管理范围（计数复原，历史仍在账上）')
  const surfTool = regs2.find((t) => t.name === 'memoryos_surface')
  const noWhy = await surfTool.execute({ action: 'add-exclude', pattern: 'todo.md' })
  ok(/reason|理由/.test(noWhy.text), 'L33 模型改资料面不写理由 ⇒ 拒（与切开关同纪律）')
  const ls = await surfTool.execute({ action: 'list' })
  ok(/纳管/.test(ls.text) && /排除规则/.test(ls.text) && /\.md/.test(ls.text), 'L34 模型能读到资料面现状（含类型固定的提示）')
  const badDrop = await surfTool.execute({ action: 'drop-root', path: nrm(base), reason: '我以为是垃圾' })
  ok(/✗ 拒绝/.test(badDrop.text), 'L35 模型也删不掉 profile 基线（宿主配置不由插件代写）')
  const ledgerS = readFileSync(path.join(dirS, 'surface.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  ok(ledgerS.map((r) => r.op).join(',') === 'add-root,add-exclude,drop-exclude',
    `L36 账本精确等于"真发生过"的三次操作（被拒的 4 次一行都没落）：${ledgerS.map((r) => r.op).join(',')}`)
  ok(ledgerS.every((r) => r.op && r.ts && r.by === 'user' && (!r.pattern || r.pattern === 'drafts/')), 'L37 每行都有 op/by/ts，且没有一条是垃圾规则')
  ok(ledgerS.find((r) => r.pattern === 'drafts/').reason === '草稿不算资料' && ledgerS.filter((r) => /未填理由/.test(r.reason)).length === 2,
    'L38 填过的理由存原文，没填的存占位（事后分得清"这句是谁说的"，不含糊）')
  disposerS()
}

// ————————————————————————————————— M 指针图：建图 / 索引 / 体检
{
  const corpus = makeCorpus(path.join(tmp, 'corpus'))
  const notesDir = path.join(corpus, 'notes')
  const alpha = path.join(notesDir, 'alpha.md')
  const cfgG = { dataDir: path.join(tmp, 'gstate'), memoryRoots: [corpus], legacyKeyFiles: [], graphStaleHours: 24, graphMaxFiles: 500 }
  const foldG = () => V.foldSurface(cfgG.dataDir)

  const lf = GR.listFiles(cfgG, foldG())
  ok(lf.files.length === 2 && lf.files.every((f) => f.path.endsWith('.md')), `M1 扫管理范围拿到 .md 清单（实测 ${lf.files.length} 份）`)
  V.appendSurface(cfgG.dataDir, { op: 'add-exclude', pattern: 'notes/', by: 'user' })
  ok(GR.listFiles(cfgG, foldG()).files.length === 1, 'M2 建图遵守资料面的排除（排掉的目录真不进图，图与面板同一个范围）')
  V.appendSurface(cfgG.dataDir, { op: 'drop-exclude', pattern: 'notes/', by: 'user' })

  const built = GR.build(cfgG, foldG(), { maxFiles: 500 })
  const g = built.graph
  ok(built.warnings.length === 0, `M3 建图零警告（实测：${built.warnings.join(' / ') || '无'}）`)
  ok(g.stats.files === 2 && g.stats.nodes >= 5 && g.stats.edges >= 4, `M4 节点与边都建出来了（nodes=${g.stats.nodes} edges=${g.stats.edges}）`)
  ok(g.stats.unresolved === 1, `M5 指向不存在资料的引用被算成"未解析"（实测 ${g.stats.unresolved}，就是那句 gone.md）`)
  ok(existsSync(GR.graphFile(cfgG.dataDir)), 'M6 图落盘到 <dataDir>/graph.json（派生缓存，删了可重建）')
  const g2 = GR.load(cfgG)
  ok(g2 && g2.version === GR.GRAPH_VERSION && g2.nodes.length === g.nodes.length, 'M7 读回来的图与建出来的一致（load 认版本号，旧图不误用）')
  ok(GR.load({ ...cfgG, dataDir: path.join(tmp, 'no-such-dir') }) === null, 'M8 图不存在时 load 返回 null（不是抛异常）')

  const r1 = GR.resolveStarts(g2, 'AA1')
  ok(r1.starts.length >= 1 && r1.level === '精准' && /条目号/.test(r1.starts[0].how), `M9 条目号精准命中并披露依据（${r1.starts.map((x) => x.name).join('/')}）`)
  const r2 = GR.resolveStarts(g2, '上线七步')
  ok(r2.starts.length >= 1 && /触发行/.test(r2.starts[0].how), 'M10 触发行也能当起点（这就是"只索引标题+触发行"的用处）')
  const r3 = GR.resolveStarts(g2, 'AlphaX 的做法')
  ok(r3.starts.length >= 1 && /变体/.test(r3.level) && /变体/.test(r3.starts[0].how), `M11 手滑多打一个字仍找到，但**级别标成变体并写出用了哪一步**（${r3.level}｜${r3.starts[0].how}）`)
  const r3b = GR.resolveStarts(g2, 'AA2 AlphaX 的做法')
  ok(r3b.level === '精准' && /条目号 AA2/.test(r3b.starts[0].how), 'M11b 查询里带了条目号 ⇒ 直接按精准走（编号优先于模糊，别把确定的事做成猜的）')
  const r4 = GR.resolveStarts(g2, 'ZZZ 完全无关的词')
  ok(r4.starts.length === 0 && Array.isArray(r4.candidates), 'M12 真查不到就老实空手＋给候选，不硬凑一个最像的')

  const sub1 = GR.subgraph(g2, r1.starts, { depth: 1 })
  const sub2 = GR.subgraph(g2, r1.starts, { depth: 2 })
  ok(sub1.nodes.length >= 2 && sub2.nodes.length >= sub1.nodes.length, `M13 深度越大子图越大（1 层 ${sub1.nodes.length}／2 层 ${sub2.nodes.length}）`)
  ok(sub2.edges.every((e0) => !!e0.reason), 'M14 每条边都带 reason（"为什么要读它"必须能解释，这是图相对于全文检索的价值）')
  const mdEdge = g2.edges.find((e0) => e0.type === 'path' && /\(\.\.\/manual\.md\)/.test(String(e0.reason)))
  ok(!!mdEdge && String(mdEdge.from).startsWith('file:'), 'M14b 标准 Markdown 链接入图且挂在**文件节点**上（索引表天生这么写；"这份新档有没有人引用过"就靠这条边）')
  ok(!/wikilink/.test(JSON.stringify(g2)), 'M14c 不再有 wikilink 边（那是搬代码时夹带的语法、内核不认，已按拍板删除）')
  const stFresh = GR.status(cfgG, foldG(), { maxAgeHours: 24, maxFiles: 500 })
  ok(stFresh.exists && stFresh.stale === false && stFresh.changed === 0, 'M15 刚建完＝水位新、无未入图改动')
  const outText = GR.render(g2, 'AA1', r1, sub2, stFresh, { depth: 2, expand: true })
  ok(/亮起子图/.test(outText) && /起点解析＝\*\*精准/.test(outText) && /建议读/.test(outText) && /地图不是内容/.test(outText),
    'M16 expand:true 才渲染邻域地图那页（水位＋解析级别＋边＋建议读＋"地图不是内容"的提醒）')
  ok(/没找到起点/.test(GR.render(g2, 'ZZZ 完全无关的词', r4, GR.subgraph(g2, r4.starts, {}), stFresh, {})), 'M17 查不到时的输出教用户补触发行，而不是劝人改标题')

  const stamp = Date.now()
  // utimesSync 的 Date 单位是毫秒（早先误除 1000 把文件时间改到 1970 年，反而"没改动"——测试自己的 bug）
  utimesSync(alpha, new Date(stamp), new Date(stamp + 60000))
  const stDirty = GR.status(cfgG, foldG(), { maxAgeHours: 24, maxFiles: 500 })
  ok(stDirty.changed >= 1 && stDirty.stale === true, `M18 文件被改过就报"该重建"（changed=${stDirty.changed}）——图不会悄悄落后`)
  const gj = JSON.parse(readFileSync(GR.graphFile(cfgG.dataDir), 'utf8'))
  gj.builtAt = new Date(stamp - 40 * 3600000).toISOString()
  writeFileSync(GR.graphFile(cfgG.dataDir), JSON.stringify(gj), 'utf8')
  const stOld = GR.status(cfgG, foldG(), { maxAgeHours: 24, maxFiles: 500 })
  ok(stOld.tooOld === true && stOld.ageHours > 39, `M19 超过阈值也报该重建（水位 ${stOld.ageHours}h）`)
  const rebuilt = GR.build(cfgG, foldG(), { maxFiles: 500 })
  ok(GR.status(cfgG, foldG(), { maxAgeHours: 24, maxFiles: 500 }).stale === false && rebuilt.graph.stats.files === 2, 'M20 重建后水位归零（幂等：同一批文件必然得到同一张图）')

  const chk = GR.check(cfgG, foldG(), rebuilt.graph, { maxAgeHours: 24, maxFiles: 500 })
  ok(chk.ok && chk.counts.noTrigger >= 1 && chk.entriesWithoutTrigger.some((x) => /AA3/.test(x.name)), 'M21 体检点出"条目缺触发行"（索引唯一认的东西，缺了就匹配不上）')
  ok(chk.orphanEntries.some((x) => /AA3/.test(x.name)) && !chk.orphanEntries.some((x) => /AA2/.test(x.name)),
    'M22 体检点出"没人引用的条目"，且**按引用边算不是按度数**（每条条目都有 contains 边，用度数会永远是 0——本轮实踩）')
  ok(/体检：/.test(GR.checkText(chk)) && chk.verdict.includes('盲区'), 'M23 体检能出一段人可读的清单（不是只给计数）')
  const chkNo = GR.check({ ...cfgG, dataDir: path.join(tmp, 'empty-state') }, V.foldSurface(path.join(tmp, 'empty-state')))
  ok(chkNo.ok === false && /图不存在/.test(chkNo.message) && /memoryos_graph\(action=build\)/.test(chkNo.message), 'M24 没图时体检直接指路怎么建（不抛异常、不返回空表糊弄）')

  // 探针与登记表同源：建图前后，DEPS/STEPS 的口径要跟着真实图走（用两个不同 dataDir，别拿刚建过的验"没建"）
  const bPre = P.makeProbes({ ...cfgG, dataDir: path.join(tmp, 'gnone'), rootsOf: () => [corpus] }, { webserver: true })
  const preStep = P.stepAll(bPre)
  ok(typeof P.probeAll(bPre)['graph-db'] === 'string' && preStep['graph-built'].done === false && /memoryos_graph/.test(preStep['graph-built'].why),
    `M25 探针：图不在 ⇒ 依赖给人话、步骤未满足且**指路怎么建**（${String(preStep['graph-built'].why).slice(0, 30)}…）`)
  const bPost = P.makeProbes({ ...cfgG, rootsOf: () => [corpus] }, { webserver: true })
  ok(P.probeAll(bPost)['graph-db'] === true && P.stepAll(bPost)['graph-built'].done === true, 'M26 探针：图建好 ⇒ 依赖与步骤同时转绿（面板不用另写一套判断）')
}

// ————————————————————————————————— N 指针图端到端（面板建图 ⇒ 功能从「待配置」转「生效中」）
{
  const regsN = [], routesN = []
  const subN = { get: (x) => (x === 'webServer' ? { register: (r) => { routesN.push(r); return () => {} } } : undefined), logger: { info() {}, warn() {} }, tools: { register: (t) => { regsN.push(t); return () => {} } } }
  const dirN = path.join(tmp, 'hgn')
  const disposerN = H.apply({ logger: subN.logger, tools: subN.tools, get: subN.get, inject: (_d, cb) => cb(subN) },
    { dataDir: dirN, memoryRoot: makeCorpus(path.join(tmp, 'corpusN')), graphStaleHours: 24 })
  const postN = (p, body) => new Promise((res) => {
    const route = routesN.find((r) => r.path === A.PREFIX + p)
    const req = { on: (ev, fn) => { if (ev === 'data') fn(JSON.stringify(body || {})); if (ev === 'end') fn() }, destroy() {} }
    const rr = { writeHead: (c) => { rr.code = c }, end: (s) => res({ code: rr.code, body: JSON.parse(s) }) }
    route.handler(req, rr)
  })
  const fOf = (r, id) => r.body.snapshot.features.find((x) => x.id === id)
  const snap0 = await postN('/snapshot', {})
  const f0 = fOf(snap0, 'graph-search')
  ok(f0.state === 'waiting' && f0.pending.length === 1 && f0.pending[0].by === 'llm',
    `N1 全新实例：图检索＝${f0.state}（默认开着但没建图，面板写清"待模型执行"，不算生效）`)
  const built1 = await postN('/graph', { action: 'build' })
  ok(built1.code === 200 && built1.body.snapshot.graph.exists && built1.body.snapshot.graph.nodes > 0,
    `N2 面板点「建立指针图」⇒ 200 且回快照直接带图（${built1.body.snapshot.graph.nodes} 节点）`)
  const f1 = fOf(built1, 'graph-search')
  ok(f1.state === 'on' && f1.pending.length === 0, `N3 建完图同一功能自动转成「生效中」（没有任何手工标记）`)
  ok(/graph\.json/.test(built1.body.snapshot.graph.file) && built1.body.snapshot.graph.file.startsWith(dirN),
    'N4 图落在本包 dataDir 下（不污染用户的资料目录）')
  const setupN = readFileSync(path.join(dirN, 'setup.jsonl'), 'utf8')
  ok(/"step":"graph-built"/.test(setupN) && /"by":"user"/.test(setupN) && /节点/.test(setupN),
    'N5 建图这一步进了配置账（谁建的、规模多大，事后可查）')
  const gTool = regsN.find((t) => t.name === 'memoryos_graph')
  ok(!!gTool, 'N6 第五个工具 memoryos_graph 已注册（工具表判据）')
  const ls = await gTool.execute({ action: 'status' })
  ok(/指针图/.test(ls.text) && /节点/.test(ls.text), `N7 status 动作给人话（${ls.text.slice(0, 40)}…）`)
  const li = await gTool.execute({ action: 'light', query: 'AA1' })
  ok(/落点/.test(li.text) && /〔条目体·AA1〕/.test(li.text) && /manual\.md/.test(li.text) && li.text.split('\n').length <= 6,
    'N8 ★ light 默认＝落点清单（跳过目录直达条目+文件：文件＋条目号＋行号，≤6 行）')
  ok(!/亮起子图|建议读/.test(li.text), 'N8b ★ 默认不给邻域地图（要地图＝expand:true）')
  const liExp = await gTool.execute({ action: 'light', query: 'AA1', expand: true })
  ok(/亮起子图/.test(liExp.text) && /建议读/.test(liExp.text), 'N8c expand:true 才给邻域地图（旧契约保留）')
  const ck = await gTool.execute({ action: 'check' })
  ok(/体检：/.test(ck.text) && /AA3/.test(ck.text), 'N9 check 动作把盲区端出来（AA3 那条缺触发行＋没人指）')
  const bad = await gTool.execute({ action: 'nope' })
  ok(/✗/.test(bad.text) && /status \| build \| light \| check \| archive-check/.test(bad.text), 'N10 未知动作被拒并列出可用动作（含 archive-check）')
  const ac = await gTool.execute({ action: 'archive-check' })
  ok(/归档闸/.test(ac.text) && /没找到任何 git 仓/.test(ac.text) && /本次未提交的新增/.test(ac.text),
    'N13 archive-check 端到端可用：记忆根不在 git 仓里时**如实说"按空集处理不硬猜"**，不假装查过')
  // 零命中兜底的工具层端到端（2026-10-02 移植）：corpusN 里 'gone' 只出现在 manual.md 的正文（反引号路径里）
  const ftLight = await gTool.execute({ action: 'light', query: 'gone' })
  ok(/字面出现过/.test(ftLight.text) && /manual\.md/.test(ftLight.text), 'N14 零命中时兜底自动跑：工具层直接报出"哪份文件哪一行字面出现过"')
  const hitLight = await gTool.execute({ action: 'light', query: 'AA1' })
  ok(!/字面出现过|零命中/.test(hitLight.text), 'N15 有起点时不跑兜底（白读一遍盘＝无谓成本，只在零命中付一次）')
  // 过泛查询端到端（2026-10-02 用户口径）：> MAX_STARTS 起点 ⇒ 只回一个数，且**不跑兜底**
  const corpusN3 = makeCorpus(path.join(tmp, 'corpusN3'))
  for (let i = 1; i <= 10; i++) writeFileSync(path.join(corpusN3, `过泛夹具${i}.md`), L(`# 过泛夹具${i}`, '', '正文一点内容。'), 'utf8')
  const regsN3 = []
  const subN3 = { get: () => undefined, logger: { info() {}, warn() {} }, tools: { register: (t) => { regsN3.push(t); return () => {} } } }
  const dN3 = H.apply({ logger: subN3.logger, tools: subN3.tools, get: subN3.get, inject: (_d, cb) => cb(subN3) },
    { dataDir: path.join(tmp, 'hgn3'), memoryRoot: corpusN3, graphStaleHours: 24 })
  const gTool3 = regsN3.find((t) => t.name === 'memoryos_graph')
  await gTool3.execute({ action: 'build' })
  const obLight = await gTool3.execute({ action: 'light', query: '过泛夹具' })
  ok(/过泛/.test(obLight.text) && /个起点/.test(obLight.text) && obLight.text.split('\n').length <= 3
    && !/字面出现过|亮起子图|线索/.test(obLight.text),
    'N16 ★ 过泛查询端到端：工具只回一个数（不展开图、也不跑兜底＝省掉一次全库读盘）')
  dN3()
  disposerN()
  ok(existsSync(path.join(dirN, 'graph.json')), 'N11 图文件真在盘上（不是只在内存里算过）')

  const regsN2 = []
  const subN2 = { get: () => undefined, logger: { info() {}, warn() {} }, tools: { register: (t) => { regsN2.push(t); return () => {} } } }
  const disposerN2 = H.apply({ logger: subN2.logger, tools: subN2.tools, get: subN2.get, inject: (_d, cb) => cb(subN2) },
    { dataDir: path.join(tmp, 'hgno'), memoryRoot: '' })
  const g2 = regsN2.find((t) => t.name === 'memoryos_graph')
  const noRoot = await g2.execute({ action: 'build', reason: '想建图' })
  ok(/✗/.test(noRoot.text) && /记忆根/.test(noRoot.text), 'N12 没划范围就想建图 ⇒ 拒并指路去资料面（不在空目录上建个空图糊弄人）')
  disposerN2()
}

// ————————————————————————————————— P 归档闸：提交前检查"本次新增有没有人登记"
{
  // —— 纯函数（不碰 git、不碰文件系统，红了立刻知道是哪条判据坏了）
  ok(AR.unquotePath('"docs/\\345\\275\\222\\346\\241\\243.md"') === 'docs/归档.md',
    'P1 git 的非 ASCII 路径转义被解开（不解＝"新增 1 份、待查 0"的静默空转）')
  const stP = AR.parseStatus('?? docs/新档.md\n M a.md\nR  old.md -> new.md\nA  added.md\n')
  ok(stP.length === 4 && stP[0].code === '??' && stP[0].path === 'docs/新档.md' && stP[2].path === 'new.md',
    'P2 git status 解析：未跟踪／改动／重命名取新名（改名前的旧名不算"本次新增"）')
  ok(AR.isNew('??') && AR.isNew('A ') && AR.isNew('R ') && !AR.isNew(' M') && !AR.isNew(' D'),
    'P3 新增判定只认 ??/A/R（改动与删除不是"新增"）')
  ok(AR.exemptReason(['> 归档：免索引（临时探针）']) === '免索引（临时探针）' && AR.exemptReason(['# 正常档']) === '',
    'P4 豁免行只认文件头那句，且理由原文带出来（豁免必须可见）')
  const role1 = AR.docRoleOf(['> 档位：中枢 ｜ 指针条目=AA1'])
  ok(role1.role === 'hub' && AR.docRoleOf(['> **档位**: leaf']).role === 'leaf' && AR.docRoleOf(['# 没写']).role === 'leaf',
    'P5 文件头档位：中枢／叶子白名单，未声明＝叶子（漏了只是少跳一层，不会变坏）')
  ok(AR.docRoleOf(['> 档位：看不懂的值']).raw === '看不懂的值',
    'P5b 档位值不认识 ⇒ 回叶子但**把原值带出去**（让体检能报，而不是静默当没写）')
  ok(AR.danglingRefs(['> 档位：叶子 ｜ 指针条目=AA1'], ['AA1']).length === 0
    && AR.danglingRefs(['指针条目=WN99'], ['AA1'])[0] === 'WN99',
    'P6 回指条目号悬空检测（写错号原先完全静默，谁也看不见）')
  ok(AR.collect([path.join(tmp, 'no-such-repo')]).gitOk === false,
    'P6b 仓不存在／没 git ⇒ gitOk=false（**fail-open**：闸坏掉不许挡归档）')

  // —— 真 git 仓端到端（建临时仓 → 造未提交新增 → 闸的三种结论）
  const repoP = path.join(tmp, 'repoP')
  const gitP = (...a) => execFileSync('git', ['-C', repoP, ...a], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
  let gitOk = true
  try {
    mkdirSync(repoP, { recursive: true })
    gitP('init')
    gitP('config', 'user.email', 'gate@example.invalid')
    gitP('config', 'user.name', 'gate')
    writeFileSync(path.join(repoP, 'index.md'), L('> 档位：中枢', '', '# 索引', '', '- 还没有条目', ''), 'utf8')
    writeFileSync(path.join(repoP, 'base.md'), L('# 基础档', '', '### AA1 已有条目', '- **触发**：已有的东西', ''), 'utf8')
    gitP('add', '-A')
    gitP('commit', '-m', 'base')
  } catch { gitOk = false }
  if (!gitOk) {
    ok(true, 'P7–P10 跳过真 git 端到端（本机没 git 或建仓失败）——纯函数与 fail-open 已由 P1–P6b 钉住')
  } else {
    const cfgP = { dataDir: path.join(tmp, 'gstateP'), memoryRoots: [repoP], archiveRepos: [repoP], legacyKeyFiles: [], graphStaleHours: 24, graphMaxFiles: 200 }
    // 每一步用**独立的 dataDir**：闸在没有图时会自己建一次（这正是闸的正常路径），
    // 也避免"同一秒内改文件"落进图水位的 1 秒防抖窗口（那是给正常编辑留的宽限，不是这次要测的东西）。
    let seqP = 0
    const gate = (extra = {}) => {
      const dir = path.join(tmp, 'gstateP' + (++seqP))
      return AR.run({ ...cfgP, dataDir: dir }, V.foldSurface(dir), extra)
    }

    writeFileSync(path.join(repoP, 'orphan.md'), L('# 没人引用的一份', '', '> 档位：叶子 ｜ 指针条目=WN99', '', '正文', ''), 'utf8')
    const r7 = gate()
    ok(r7.warns === 2 && /没有任何 \.md 引用它/.test(r7.markdown) && /悬空/.test(r7.markdown),
      `P7 未登记 + 回指悬空 ⇒ 2 条 warn（实测 ${r7.warns}；闸只说事实，不挡提交）`)

    writeFileSync(path.join(repoP, 'orphan.md'), L('# 没人引用的一份', '', '> 档位：叶子 ｜ 指针条目=AA1', '',
      '> 归档：免索引（一次性探针）', '', '正文', ''), 'utf8')
    const r8 = gate()
    ok(r8.warns === 0 && r8.counts.exempt === 1 && /豁免清单/.test(r8.markdown) && /一次性探针/.test(r8.markdown),
      'P8 写了豁免 ⇒ 跳过判定**且列进豁免清单**（豁免可见，不静默跳过）')

    writeFileSync(path.join(repoP, 'orphan.md'), L('# 有人引用的一份', '', '> 档位：叶子 ｜ 指针条目=AA1', '', '正文', ''), 'utf8')
    writeFileSync(path.join(repoP, 'index.md'), L('> 档位：中枢', '', '# 索引', '', '- [有人引用的一份](orphan.md)', ''), 'utf8')
    const r9 = gate()
    ok(r9.warns === 0 && r9.counts.checked === 1 && r9.counts.info === 0,
      'P9 索引里加一行**标准 Markdown 链接** ⇒ 闸不再报"没人引用"（被中枢档登记过＝这件事做完了）')

    writeFileSync(path.join(repoP, 'base.md'), L('# 基础档', '', '### AA1 已有条目', '- **触发**：已有的东西', '',
      '### AA2 新写的条目', '- **触发**：新的东西', ''), 'utf8')
    const r10 = gate()
    ok(r10.counts.info >= 1 && /新条目\*\*没有任何文件引用/.test(r10.markdown),
      'P10 本轮新增的条目没人回指 ⇒ info（提示在专档首行写"指针条目="回指它）')

    const r11 = gate({ files: [path.join(repoP, 'orphan.md')] })
    ok(r11.counts.checked === 1 && r11.counts.newFiles === 1, 'P11 file= 调试口：只查指定的一份（不把整仓改动倒进来）')

    // "新条目压根没进图"这条分支：这里用"图只扫 1 份文件"模拟"这份没被扫到"（格式对但不在图里）
    writeFileSync(path.join(repoP, 'later.md'), L('# 后加的档', '', '### AA3 更晚的新条目', '- **触发**：更晚的事', ''), 'utf8')
    gitP('add', 'later.md')   // 未跟踪文件的 diff 是空的；新条目判定看的是 working tree ＋ 暂存区
    const dirP12 = path.join(tmp, 'gstateP' + (++seqP))
    const r12 = AR.run({ ...cfgP, dataDir: dirP12, graphMaxFiles: 1 }, V.foldSurface(dirP12), {})
    ok(/没进图/.test(r12.markdown) && r12.counts.warn >= 1,
      'P12 新条目**压根没进图**（不在扫描范围/被上限截掉）⇒ warn 指路"检查标题格式"（不是静默当已登记）')
  }
}

// ————————————————————————————————— Q 零命中兜底：域内正文全文扫描（2026-10-02 与内核同口径移植）
{
  const qdir = path.join(tmp, 'qcorpus')
  mkdirSync(path.join(qdir, 'notes', 'drafts'), { recursive: true })
  writeFileSync(path.join(qdir, 'notes', 'entry.md'), L('### AA9 记一笔', '- **触发**：随口一问', '',
    '正文里提到 Qwen3-8B 这个模型名，但它不在任何标题或触发行里。', ''), 'utf8')
  writeFileSync(path.join(qdir, 'notes', 'plain.md'), L('# 散记', '', '这里也提了一次 Qwen3-8B（普通正文，不属于任何条目体）。', ''), 'utf8')
  writeFileSync(path.join(qdir, 'notes', 'drafts', 'hidden.md'), L('# 草稿', '', '这里也写着 Qwen3-8B，但整个目录被资料面排除。', ''), 'utf8')
  writeFileSync(path.join(qdir, 'notes', 'big.md'), '# 大档\n\n' + 'x'.repeat(6000) + ' BigOnlyWord\n', 'utf8')
  writeFileSync(path.join(qdir, 'notes', 'flood.md'), L('# 泛词', '', ...Array.from({ length: 50 }, () => '这一行里反复出现结构词结构词'), ''), 'utf8')
  const cfgQ = { dataDir: path.join(tmp, 'qstate'), memoryRoots: [qdir], legacyKeyFiles: [], graphStaleHours: 24, graphMaxFiles: 200, graphMaxBytes: 4000 }
  V.appendSurface(cfgQ.dataDir, { op: 'add-exclude', pattern: 'notes/drafts/', by: 'user' })
  const foldQ = () => V.foldSurface(cfgQ.dataDir)
  const gQ = GR.build(cfgQ, foldQ(), { maxFiles: 200, maxBytes: 4000 }).graph
  const ft = (q) => GR.fulltextFallback(cfgQ, foldQ(), gQ, q, { maxBytes: 4000, maxFiles: 200 })

  const f1 = ft('Qwen3-8B')
  ok(/字面出现过/.test(f1) && /entry\.md/.test(f1) && /〔条目体·AA9〕/.test(f1),
    'Q1 零命中兜底：报"哪份文件哪一行字面出现过"，命中落在已登记条目体内还标出编号（可接着 light AA9）')
  ok(/L\d+ .*Qwen3-8B/.test(f1), 'Q2 每条命中带行号＋原文片段（文件内容仍要自己 read，不替人下结论）')
  ok(/〔正文〕/.test(f1), 'Q3 不在条目体里的命中标〔正文〕（两种标记并存，不混为一谈）')
  ok(!/hidden\.md/.test(f1), 'Q4 被资料面排除的目录不进扫描面（扫描面与起点域同源，不留第二份范围真相）')
  ok(!/big\.md/.test(f1), 'Q4b 超大小门的文件不进命中（不拖慢兜底）')
  const fn = ft('qwen38b')
  ok(/〔归一匹配〕/.test(fn) && /entry\.md/.test(fn), 'Q5 大小写/连字符手滑由第二轮"归一"兜，并披露用了哪轮（与起点解析同一风格）')
  const fz = ft('一个从来没出现过的词')
  ok(/已扫 \*\*\d+\*\* 份/.test(fz) && /零命中/.test(fz), 'Q6 零命中**如实报数**（"空手"必须可判读：扫了几份）')
  ok(/被排除的目录/.test(fz) && /跨行断词/.test(fz), 'Q6b 零命中给三种可能（把"没这份资料"与"被排除/被挡"分开，不糊成一句"查不到"）')
  const fbig = ft('BigOnlyWord')
  ok(/不在扫描面/.test(fbig) && /big\.md/.test(fbig), 'Q7 只在超门文件里出现的词 ⇒ 零命中但仍**点名**那份被挡的档（旧口径这里静默消失）')
  const ff = ft('结构词')
  ok(/命中过多/.test(ff) && /疑似结构词/.test(ff) && !/字面出现过/.test(ff) && !/命中最多/.test(ff),
    'Q8 泛词闸：超 40 行只报一个数（连"命中最多的是哪几个文件"也隐去——2026-10-02 用户口径）')
  ok(/不代表这就是答案/.test(f1), 'Q9 免责句在场：只报"字面出现过" ≠ 这就是答案（同词不同题是常态）')
  const rq = GR.resolveStarts(gQ, 'Qwen3-8B')
  const rtxt = GR.render(gQ, 'Qwen3-8B', rq, GR.subgraph(gQ, rq.starts, {}), GR.status(cfgQ, foldQ(), { maxAgeHours: 24, maxFiles: 200 }), { fulltext: f1 })
  ok(rq.starts.length === 0 && rtxt.indexOf('字面出现过') > 0 && rtxt.indexOf('字面出现过') < rtxt.indexOf('线索'),
    'Q10 零命中页里**事实排在线索之前**（"在哪儿出现过"可验证，"像哪个"是猜的）')
  // Q11 过泛查询闸（2026-10-02 与内核同口径）：命中 > MAX_STARTS ⇒ 只回一个数、细节全隐
  for (let i = 1; i <= 10; i++) writeFileSync(path.join(qdir, 'notes', `过泛夹具${i}.md`), L(`# 过泛夹具${i}`, '', '正文一点内容。', ''), 'utf8')
  const gQ2 = GR.build(cfgQ, foldQ(), { maxFiles: 200, maxBytes: 4000 }).graph
  const rob = GR.resolveStarts(gQ2, '过泛夹具')
  ok(rob.starts.length === 0 && !!rob.overbroad && rob.overbroad.n > GR.MAX_STARTS,
    `Q11 ★ 起点数闸：任一档命中 > MAX_STARTS(${GR.MAX_STARTS}) ⇒ 判过泛查询、不当起点、如实记数（实测 ${rob.overbroad && rob.overbroad.n} 个）`)
  const rtxt2 = GR.render(gQ2, '过泛夹具', rob, GR.subgraph(gQ2, [], {}), GR.status(cfgQ, foldQ(), { maxAgeHours: 24, maxFiles: 200 }), {})
  ok(new RegExp(`${rob.overbroad.n} 个起点`).test(rtxt2) && rtxt2.split('\n').length <= 3,
    'Q11b ★ 过泛查询只回一个数（≤3 行）：不展开图、不给候选、不接兜底段')
  ok(!/亮起子图|字面出现过|线索/.test(rtxt2), 'Q11c ★ 过泛时其余细节全部隐去（用户口径：只报一个数）')
  // Q12 落点契约（2026-10-02 用户定）：文件起点默认只给一行落点，不展开邻域
  const rf = GR.resolveStarts(gQ2, 'flood')
  const rftxt = GR.render(gQ2, 'flood', rf, GR.subgraph(gQ2, rf.starts, {}), GR.status(cfgQ, foldQ(), { maxAgeHours: 24, maxFiles: 200 }), {})
  ok(/〔文件〕/.test(rftxt) && rftxt.split('\n').length <= 5 && !/亮起子图/.test(rftxt),
    'Q12 ★ 文件起点默认＝一行落点（不展开邻域；要地图＝expand:true）')
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

  // K1 共享项目不得夹带维护者本机私货——**按"形状"查，不按"我自己的仓名"查**：
  // 把维护者的仓名/账本名写进闸本身，也是一种夹带（旧版就是这样），所以判据只认三类形状：
  //   ① 盘符绝对路径里的真实目录（Users／DSH-／Program／工作／mnt）；② 私有条目号体系 `W[ABC]\d`；③ 私有表键前缀 `proj_`。
  const LEAK = /[A-Za-z]:[\\/](?:Users|DSH-|Program|工作|mnt)|\/mnt\/data|\bW[ABC]\d{1,2}\b|\bproj_[a-z_]+/g
  const leak = all.match(LEAK) || []
  ok(leak.length === 0, `K1 文档不夹带维护者本机私货（命中 ${leak.length}：${[...new Set(leak)].join(' ')}）`)

  // K1b 代码与面板同一把尺子（K1 原先只扫文档 ⇒ 私货正是从代码里漏出去过：本机路径 + 私有条目号当示例）
  const codeFiles = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml',
    ...readdirSync(path.join(PKG, 'lib')).filter((f) => f.endsWith('.js')).map((f) => join('lib', f))]
  const codeLeak = []
  for (const f of codeFiles) {
    const hits = readFileSync(path.join(PKG, f), 'utf8').match(LEAK) || []
    if (hits.length) codeLeak.push(`${f}=${[...new Set(hits)].join('/')}`)
  }
  ok(codeLeak.length === 0, `K1b 代码/面板也不夹带（命中：${codeLeak.join(' ') || '无'}）`)

  // K2 文档里出现的工具名必须是真注册的
  // 真实工具名从代码里抽（手抄清单自己就会漂移——本轮 K2 当场抓到这件事）
  const realTools = new Set([...idx.matchAll(/name: '(memoryos_[a-z]+)'/g)].map((m) => m[1]))
  const named = new Set((all.match(/memoryos_[a-z-]+/g) || []).map((s) => s.replace(/-+$/, '')))
  const ghost = [...named].filter((x) => !realTools.has(x))
  ok(realTools.size === 5 && [...realTools].sort().join(',') === 'memoryos_graph,memoryos_setup,memoryos_status,memoryos_surface,memoryos_switch',
    `K2a 代码注册的工具正好五个（抽到 ${realTools.size}：${[...realTools].sort().join(' ')}）——加第六个工具没同步文档就拦在这里`)
  ok(ghost.length === 0, `K2b 文档提到的工具都真实存在（幽灵：${ghost.join(' ')}）`)

  // K3 setup 的 action 名与代码分支同源
  // action/op 名也从代码分支里抽（同样是"手抄清单会漂移"的教训）
  const realActions = new Set([
    ...[...idx.matchAll(/action === '([a-z-]+)'/g)].map((m) => m[1]),
    ...[...idx.matchAll(/op === '([a-z-]+)'/g)].map((m) => m[1]),
  ])
  ok(realActions.has('probe') && realActions.has('save-key') && realActions.has('add-exclude') && realActions.has('preview'),
    `K3c 代码分支抽出的动作齐全（${[...realActions].join(' ')}）`)
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
  // K5 概览计数与登记表一致（新增功能忘了同步文档 ⇒ 当场红）
  const todoN = F.FEATURES.filter((f) => f.impl === 'todo').length
  const onN = F.FEATURES.filter((f) => f.impl !== 'todo' && f.default).length
  ok(new RegExp(`生效中 ${onN}`).test(docs['docs/WORKFLOW.md']) && new RegExp(`未实现 ${todoN}`).test(docs['docs/WORKFLOW.md']),
    `K5 文档概览计数与登记表一致（应为 生效中 ${onN}／未实现 ${todoN}）`)
  // K5b/K5c：回路图三要素（2026-09-28 用户点名补的细节，钉成断言，防重写文档时丢掉）
  const wf = docs['docs/WORKFLOW.md']
  const loop = (/## 1\. 一条消息的完整回路([\s\S]*?)### 1\.5/.exec(wf) || ['', ''])[1]
  ok(loop.length > 400 && /②/.test(loop) && /Jev/.test(loop) && /System One/.test(loop),
    'K5b② 回路第②格写明判定模型＝Jev（System One 一类），不是笼统一句"模型调用"')
  const missingTools = [...realTools].filter((t) => !loop.includes(t))
  ok(missingTools.length === 0 && (loop.match(/memoryos_[a-z]+/g) || []).length >= 4,
    `K5b③ 回路第③格列全 LLM 可调用的工具名（缺：${missingTools.join(' ') || '无'}）`)
  const s5 = (/├─⑤[\s\S]*?(?=└─⑥)/.exec(loop) || [''])[0]
  const s6 = (/└─⑥([\s\S]*)$/.exec(loop) || ['', ''])[1]
  ok(s5.length > 150 && /判路问句文档/.test(s5) && /静默失灵/.test(s5),
    'K5b⑤ 归档格写明"及时更新 Jev 判路问句文档"，并点出漏更新的后果是静默失灵')
  ok(s6.length > 100 && /判路问句文档/.test(s6) && /分叉/.test(s6),
    'K5b⑥ 维护格把"判路文档与资料是否分叉"列为体检目标（与指针图并列）')
  ok(['漏亮', '错亮', '假工作'].every((w) => wf.includes(w)),
    'K5c 三种分叉症状都在文档里——不报错的故障必须写下来才有人去查')
  ok(['on', 'off', 'waiting', 'degraded', 'unavailable', 'planned'].every((s) => new RegExp(`\`?${s}\`?`).test(docs['docs/DESIGN.md'])),
    'K6 六档状态在设计文档里都有定义（新增档必须写进来，否则面板中文无处可查）')

  // K8 ★ radar 降级（2026-10-02）：四处（JUDGMENTS 理由 / WORKFLOW 回路 / AGENT-GUIDE 模型纪律 / patch 默认值）必须同口径
  const jm = docs['docs/JUDGMENTS.md']
  ok(/## 5\.5[^\n]*radar[^\n]*降级/.test(jm), 'K8a JUDGMENTS 有专节「为什么把 radar 降级为默认不开启」')
  for (const [pat, msg] of [
    [/固定计费点/, 'K8a① 降级依据一＝它是每回合固定计费点'],
    [/暂停维护/, 'K8a② 降级依据二＝它的输入（判路问句文档）已暂停维护'],
    [/零命中/, 'K8a③ 降级依据三＝零命中→正文兜底已覆盖大多数场景'],
    [/字面完全不同/, 'K8a④ 写明它剩下的唯一价值＝"说法与用词字面完全不同"'],
    [/opt-in|显式开/, 'K8a⑤ 写明开发者可显式 opt-in（降级≠删除）'],
    [/重标定/, 'K8a⑥ 优化清单第一条＝阈值必须重标定'],
    [/为什么不为它新增/, 'K8a⑦ 交代"为什么不为它加一个已弃用状态档"（防日后有人补一个多余档）'],
  ]) ok(pat.test(jm), msg)
  ok(/默认不开启|默认关/.test(docs['docs/WORKFLOW.md']) && /JUDGMENTS/.test(docs['docs/WORKFLOW.md']), 'K8b WORKFLOW 回路 ② 写明 radar 默认关并指向理由')
  ok(/默认不开启|默认关/.test(docs['docs/AGENT-GUIDE.md']) && /别主动建议|别向用户/.test(docs['docs/AGENT-GUIDE.md']), 'K8c AGENT-GUIDE 明写"别主动劝用户开 radar"（模型侧纪律）')
  ok(/radar/.test(docs['docs/DESIGN.md']) && /5\.5/.test(docs['docs/DESIGN.md']) && /默认关/.test(docs['docs/DESIGN.md']), 'K8d DESIGN 的 radar 行与术语注都指向 §5.5')
  ok(/radar:\s*false/.test(readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')), 'K8e profile patch 的出厂默认同为 false（登记表与 patch 不能一个开一个关）')
  ok(/radar/.test(docs['README.md']) && /JUDGMENTS/.test(docs['README.md']), 'K8f README 状态行/使用行同步降级并给理由入口')
  // K9 语义能力的"新形态"四处同口径（2026-10-02 用户口径：只提供 jev 工具，可调用、但不是主力）
  ok(/按需/.test(jm) && /不是每回合自动跑/.test(jm), 'K9a JUDGMENTS §5.5 写明新形态＝按需调用（不是每回合自动跑）')
  ok(/否决/.test(jm) && /删掉/.test(jm), 'K9b §5.5 记了两条否决：每回合自动档不做默认、也不把语义能力删掉')
  ok(/`find`/.test(docs['docs/DESIGN.md']) && /按需语义寻路/.test(docs['docs/DESIGN.md']), 'K9c DESIGN 的登记表列出 `find`（按需语义寻路）')
  ok(/find:\s*false/.test(readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')), 'K9d profile patch 也登记了 find 的出厂默认（关）')
  ok(/按需/.test(docs['docs/AGENT-GUIDE.md']) && /不是每回合主力/.test(docs['docs/AGENT-GUIDE.md']), 'K9e AGENT-GUIDE 告诉模型：语义能力按需调用、不是每回合主力')
  ok(/按需可调用的工具/.test(docs['README.md']), 'K9f README 状态行写明"语义能力保留为按需可调用的工具"')
  ok(/未实现 5/.test(docs['docs/WORKFLOW.md']), 'K9g WORKFLOW 概览计数跟上（新增 find ⇒ 未实现 5）')
  // K10 过泛处置口径（2026-10-02 用户定：只报一个数、其他细节直接隐去）——四处同口径
  ok(/MAX_STARTS/.test(docs['docs/DESIGN.md']) && /只回一个数/.test(docs['docs/DESIGN.md']), 'K10a DESIGN 写过泛闸（起点闸 8 / 正文闸 40）与"只回一个数"')
  ok(/过泛/.test(docs['docs/AGENT-GUIDE.md']) && /别追问/.test(docs['docs/AGENT-GUIDE.md']), 'K10b AGENT-GUIDE 告诉模型：过泛时照实转述、别替它展开')
  ok(/过泛/.test(docs['docs/JUDGMENTS.md']) && /半张图/.test(docs['docs/JUDGMENTS.md']), 'K10c JUDGMENTS 用实测数字交代了"过泛为什么不给细节"')
  ok(/过泛/.test(docs['README.md']) && /过泛/.test(docs['docs/WORKFLOW.md']), 'K10d README 与 WORKFLOW 同步过泛口径')
  // K11 落点契约（2026-10-02 用户定：工具只负责跳过目录直达条目+文件，默认输出必须小）
  ok(/LIGHT_MAX_POINTS/.test(docs['docs/DESIGN.md']) && /expand:true/.test(docs['docs/DESIGN.md']), 'K11a DESIGN 写落点默认＋expand 才给地图＋上限')
  ok(/落点清单/.test(docs['docs/AGENT-GUIDE.md']) && /expand:true/.test(docs['docs/AGENT-GUIDE.md']), 'K11b AGENT-GUIDE 教模型：默认只有落点，要地图才 expand')
  ok(/落点/.test(docs['README.md']) && /自带索引/.test(docs['docs/JUDGMENTS.md']), 'K11c README 与 JUDGMENTS 同步（判决＝工具不重做目录）')

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