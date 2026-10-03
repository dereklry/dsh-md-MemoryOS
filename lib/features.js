/**
 * MemoryOS · 功能登记表（**唯一权威**：面板显示什么、谁去操作、缺什么、怎么才算就绪）
 *
 * 两类功能，形态完全不同（这是 2026-09-28 用户定的关键区分）：
 *   ① **一键可切**（controller:'user' / 'both'）＝开关本身有意义，面板给 Toggle。
 *   ② **配置型**（controller:'llm'）＝"打开"不是一下子的动作，而是要先做完一串步骤
 *      （例：Jev 能力 → 先有 Key → 再真发一次请求测通 → 才允许置为生效）。
 *      这类**面板不给开关，只给状态 + 待办步骤**，操作由模型执行（`memoryos_setup` / `memoryos_switch`），
 *      用户保留「强制接管」这条退路（接管＝写 lock，模型改不动，随时可解除）。
 *
 * 三条纪律：
 *   1. 不登记＝面板不显示＝等于不存在（与"资料不入库＝永不亮"同理）；
 *   2. 状态**一律现算不存盘**（存下来的状态必然与事实分叉）；
 *   3. `deps` 与 `steps` 都必须在 DEPS / STEPS 里有定义，且 lib/probes.js 有探针（闸锁同源）。
 */

/** @typedef {'user'|'llm'|'both'} Controller */

/**
 * 依赖探针 id（探针实现在 lib/probes.js；`hard`＝缺了功能不可用，否则只是降级）。
 */
export const DEPS = {
  'webserver': { label: '宿主 HTTP 面', hard: true, note: '面板取数通道；headless profile 没有它 → 面板无数据（插件其余功能照常）' },
  'memory-root': { label: '记忆根（生效并集）', hard: true, note: '＝profile 的 config.memoryRoot 基线 ∪ 面板「资料面」页添加的目录；都没给或都不存在 → 检索/建图/候选全不可用' },
  'graph-db': { label: '指针图（本包自建）', hard: false, note: '＜dataDir＞/graph.json：标题·条目号·触发行·路径指针；没建或水位过期只算降级（还能查旧的），不影响其他功能' },
  'python': { label: 'Python（元素-时间线内核用）', hard: false, note: '**非致命**：缺它只降级「元素库」这一个功能，面板与词法检索照常。内核**随包发**（python/memoryos_kernel，读面纯标准库），系统 Python 3.9+ 就够；也可用 config.pythonBin 或 env MEMORYOS_PYTHON_BIN 指定一个' },
}

/**
 * 前置步骤 id（**操作型**：没做完就是 waiting，做完才谈得上 on）。
 * by:'llm' ＝该步骤由模型执行（面板显示"待模型执行"，不给按钮）；by:'user' ＝只有用户能做（如把 Key 放进文件）。
 * 为什么 Key 保存算 user 而测通算 llm：Key 是用户的秘密，插件不替用户凭空造；
 * 但"用户在对话里把 Key 交给模型让它存"是合法指令 ⇒ memoryos_setup(action=save-key) 允许显式写入，
 * 且**永不回显明文**（只回落到哪、几位、掩码后 4 位）。
 */
export const STEPS = {
  'jev-key': { label: 'Jev Key 到位', by: 'user', how: 'env JEV_API_KEY / TYPESAFE_API_KEY，或 config.keyFile、$dataDir/jev-key.txt 任一有内容；也可用 memoryos_setup(action=save-key) 让模型代存' },
  'jev-probe': { label: 'API 测通', by: 'llm', how: '跑 memoryos_setup(action=probe)：真发一次极小 choice，成功才记一次测通（结果落 setup.jsonl，7 天内算新鲜）' },
  'graph-built': { label: '指针图已建', by: 'llm', how: '跑 memoryos_graph(action=build)：扫管理范围内的 .md 生成 <dataDir>/graph.json（秒级，只索引不抄正文）；建完 light/check/status 才有东西可算' },
  'memory-scaffolded': { label: '记忆根已建档', by: 'llm', how: '跑建档向导：扫描记忆根 → 生成四层骨架与资料表初稿' },
}

/**
 * 功能表。
 * impl: 'live' 已实现 | 'wiring' 已接线·待搬入 | 'todo' 仅登记（面板灰显，不给任何按钮）
 * cost: 面板必须显示的影响说明（钱 / 上下文预算 / 写盘），别让人靠猜。
 */
/** @type {Array<{id:string,label:string,what:string,controller:Controller,default:boolean,cost:string,deps:string[],steps:string[],impl:'live'|'wiring'|'todo',group:string}>} */
export const FEATURES = [
  {
    id: 'panel', label: '控制面板本体',
    what: '在「设置」里显示 MemoryOS 这一节（关掉＝本节从导航消失，只能回 profile 改 true 恢复）',
    controller: 'user', default: true, cost: '零成本（只多一个设置分区）', deps: ['webserver'], steps: [],
    impl: 'live', group: '界面',
  },
  {
    id: 'health', label: '状态与依赖体检',
    what: '每行功能实时显示 生效中/已关/降级/不可用/待配置/未实现，并列出缺哪个依赖、差哪一步',
    controller: 'user', default: true, cost: '零成本（本地 fs/env 探针，5 秒缓存）', deps: [], steps: [],
    impl: 'live', group: '界面',
  },
  {
    id: 'switch-ledger', label: '开关与配置账本',
    what: '所有切换与测通结果都追加一行 jsonl：谁做的、理由、时间；面板"账本"页可查，历史永不改写',
    controller: 'user', default: true, cost: '极小（每次操作 1 行 jsonl）', deps: [], steps: [],
    impl: 'live', group: '记忆面·建立',
  },
  {
    id: 'surface-admin', label: '资料面管理（管到哪些目录）',
    what: '面板「资料面」页显示当前管理范围内的目录与文件类型；可**添加资料目录**、**排除特定文件**（写 surface.jsonl，与 profile 基线求并集、不覆写 profile）',
    controller: 'user', default: true,
    cost: '面板刷新时每根扫一遍**文件名**（不读内容、深 8 层、命中 400 个即停）；不建索引',
    deps: ['memory-root'], steps: [],
    impl: 'live', group: '记忆面·建立',
  },
  {
    id: 'jev-engine', label: 'Jev 凭据与通道测通（**不含寻路**）',
    // 2026-10-02 与代码对齐（用户令："先移除共享包里关于 jev 的功能描述，与代码对齐"）：
    // 本包**只有**凭据面（存/取 Key）与"真发一次极小请求测通"这两件事——`lib/setup.js` + `lib/keystore.js`。
    // **不提供语义寻路**（find）与**每回合自动指路**（radar）：find 这条路本项目试过、评估后摘除
    // （寻路表维护量大＋每次调用产生账单），本包不含该实现，
    // 因此不登记、不给开关、不给按钮（描述了本包没有的能力＝假开）。若要重启这条路，前置见 docs/JUDGMENTS.md §5.6。
    what: '只管**通道**：把 Jev 的 Key 存好（优先宿主凭据面 `ref=JEV_API_KEY`）＋真发一次极小请求测通＋把结果记进配置账本。'
      + '**本包不含语义寻路**——"这件事该读哪份资料"在本包里只能靠词法 `light`（含零命中正文兜底）；'
      + '只有事、没有词时本包答不了（find 这条路试过、已摘除，本包不实现、不登记）',
    controller: 'llm', default: false,
    cost: '只有你主动测通时花一次（≈0.5~1.5 秒一次调用）；**不常驻、不每回合发，平时零花费**',
    deps: [], steps: ['jev-key', 'jev-probe'],
    impl: 'live', group: '引擎',
  },
  {
    id: 'graph-search', label: '指针图：建图 / 索引 / 体检',
    what: '把管理范围内的 .md 建成一张图（标题·条目号·触发行·反引号路径·「§三 AA14」式指针），然后 `light` 按词找子图（先精准后变体并披露用了哪级）、`check` 出盲区清单、`build` 重建',
    controller: 'both', default: true,
    cost: '零账（纯本地 JS，不起进程不联网）；实测几百份 .md 建图在秒级；图落 <dataDir>/graph.json，删了可重建',
    deps: ['memory-root', 'graph-db'], steps: ['graph-built'],
    impl: 'live', group: '记忆面·使用',
  },
  {
    id: 'element-db', label: '元素库（元素-时间线内核）',
    what: '把聊到/写下的元素与**带时间戳的事件**固化进本地 SQLite（元素·事件·链接·决策），按元素拉时间线、看快照、标失效、导出 Markdown 镜像；'
      + '内核**随包发**（Python，读面纯标准库），无 API Key 也能用规则层抽取（LLM 精抽只在有 Key 时用，失败自动降级）',
    controller: 'both', default: true,
    cost: '零账（纯本地 SQLite，不联网）；一次调用一次子进程（秒级）',
    deps: ['python'], steps: [],
    impl: 'live', group: '记忆面·使用',
  },
  {
    id: 'scaffold', label: '首次建档（scaffold）',
    what: '扫描记忆根 → 生成四层账本骨架 + 资料表初稿（行从真实盘上抽，不靠人想）',
    controller: 'user', default: false, cost: '一次性；只写自己认领的 marker 块，改前 dry-run', deps: ['memory-root', 'python'], steps: ['memory-scaffolded'],
    impl: 'todo', group: '记忆面·建立',
  },
  {
    id: 'mining', label: '候选生成（miner）',
    what: '从真实过程挖候选：查空的词→别名、反复读的文件→资料表行、新写的条目→索引行（只出候选，人确认才落表）',
    controller: 'llm', default: true, cost: '零账（词法为主）；产出是候选队列，不直接改用户的表', deps: ['memory-root'], steps: [],
    impl: 'todo', group: '记忆面·个性化',
  },
  {
    id: 'maintain', label: '定时维护（build + check）',
    what: '周期性重建指针图并跑体检，盲区直接进候选队列（体检→补写闭环）',
    controller: 'user', default: false, cost: '每轮约 2 秒建图；不花钱', deps: ['python', 'graph-db'], steps: ['graph-built'],
    impl: 'todo', group: '记忆面·维护',
  },
]

/** 按 id 取功能定义（找不到返回 undefined；调用方负责报错，不造默认值）。 */
export function featureOf(id) {
  return FEATURES.find((f) => f.id === id)
}

/** 面板与工具共用的分组顺序（未知组排最后，不静默丢功能）。 */
export const GROUPS = ['界面', '引擎', '记忆面·建立', '记忆面·使用', '记忆面·个性化', '记忆面·维护']

/** 自检：登记表自身合法性（闸用；返回问题数组，空＝干净）。 */
export function lintFeatures() {
  const bad = []
  const seen = new Set()
  if (!GROUPS.every((g) => FEATURES.some((f) => f.group === g))) bad.push('GROUPS 里有空组（分组漂移）')
  for (const f of FEATURES) {
    if (!f.id || !/^[a-z][a-z0-9-]*$/.test(f.id)) bad.push(`id 非法：${f.id}`)
    if (seen.has(f.id)) bad.push(`id 重复：${f.id}`)
    seen.add(f.id)
    if (!f.label || !/[一-龥]/.test(f.label)) bad.push(`${f.id} 缺中文显示名`)
    if (!f.what) bad.push(`${f.id} 缺"这功能在干什么"`)
    if (!['user', 'llm', 'both'].includes(f.controller)) bad.push(`${f.id} controller 非法：${f.controller}`)
    if (typeof f.default !== 'boolean') bad.push(`${f.id} default 必须是布尔`)
    if (!f.cost) bad.push(`${f.id} 缺成本/影响说明（面板必须显示，别让人靠猜）`)
    if (!GROUPS.includes(f.group)) bad.push(`${f.id} 分组 ${f.group} 不在 GROUPS`)
    if (!['live', 'wiring', 'todo'].includes(f.impl)) bad.push(`${f.id} impl 非法：${f.impl}`)
    for (const d of f.deps || []) if (!DEPS[d]) bad.push(`${f.id} 依赖 ${d} 没在 DEPS 声明`)
    for (const s of f.steps || []) if (!STEPS[s]) bad.push(`${f.id} 步骤 ${s} 没在 STEPS 声明`)
    // 配置型功能必须至少有一步，否则它就该是一键开关
    if (f.controller === 'llm' && !(f.steps || []).length && f.impl !== 'todo') bad.push(`${f.id} 标成"模型执行"却没有 steps（那它该是一键开关）`)
  }
  return bad
}
