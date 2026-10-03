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
  'memory-scaffolded': { label: '记忆根已建档', by: 'llm', how: '跑 memoryos_setup(action=scaffold)：扫管理范围 → 先给汇报与骨架草稿（dry-run），确认后才落 `MEMORY*.md`（只写自己认领的 marker 块）' },
  // ---- 首次运行向导链（BOOTSTRAP）的格子（2026-10-03）：一次性安装任务，不是功能 ----------------
  'workspace-rooted': { label: '已划范围（纳管了目录）', by: 'user', how: '面板「资料面」一键加入当前工作区；或说一句"把工作区纳入管理"（memoryos_surface(action=add-root, path=…)）；也可以自己挑目录、或只纳某个子目录' },
  'hub-declared': { label: '有中枢档（目录档）', by: 'llm', how: '文件头写 `> 档位：中枢` 的 `HANDBOOK.md`（模型 dry-run 先给内容）；也可以用已有的 README/INDEX，只要补那一行' },
  'leaves-managed': { label: '纳了叶子（≥3 份 .md）', by: 'user', how: '确认纳管范围内真有资料；顺手试一次排除规则（`drafts/`、`*.draft.md`）' },
  'checked-once': { label: '跑过一次体检', by: 'llm', how: '跑 memoryos_graph(action=check)：把"缺触发行/孤儿条目/未解析引用"讲给用户听，并落一行账（最好的一次教学）' },
}

/**
 * **首次运行向导链**（2026-10-03 用户定）：**安装是一次性任务，不是功能**——
 * 这里没有开关（不像 `FEATURES` 能常开常关），只有"做没做过"（`STEPS` 探针）＋"默认怎么做／还有什么选择"。
 * 用户口径："**尽量先选一个默认，然后给几个可能的选项让用户选着**。"
 *
 * 每格：`id`（必须也在 `STEPS` 里，闸锁同源）／`label`／`by`／`why`／
 * `def`（**默认路径**＝直接照做那条）／`options`（2~3 个备选 `{id,label,hint}`）／`skippable`。
 * 面板＝概览页「首次安装向导」卡；对话＝模型逐格推进；**两者读同一份数据**（不各写一套）。
 */
export const BOOTSTRAP = [
  {
    id: 'workspace-rooted', label: '划范围', by: 'user', skippable: true,
    why: 'OS 只管你纳进来的 .md —— 默认就是当前 DSH 工作区（含各级子目录）。',
    def: '把当前工作区整个纳入管理',
    options: [
      { id: 'pick', label: '自己挑一个目录', hint: '面板「资料面」→ 加目录；或直接说"把 D:\\xxx 纳入管理"' },
      { id: 'subdir', label: '只要工作区里的某个子目录', hint: '先整根纳入、再用排除规则收窄（排除比"少加"好改：计数与归因都看得见）' },
      { id: 'skip', label: '先不纳', hint: '没有范围 ⇒ 检索/建图/建档全空转（跳了它，后面几步都没意义）' },
    ],
  },
  {
    id: 'hub-declared', label: '立中枢档', by: 'llm', skippable: true,
    why: 'md 自带索引：得有一份"目录档"（中枢）告诉人/模型先读哪儿。',
    def: '起草 `HANDBOOK.md`：文件头 `> 档位：中枢` ＋ 按主题列指针（dry-run 给你过目再落盘）',
    options: [
      { id: 'existing', label: '用已有的一份', hint: 'README/INDEX/已有手册都行——只要在文件头补 `> 档位：中枢`' },
      { id: 'rename', label: '换个你习惯的名字', hint: '判据只看文件头那一行，不看文件名' },
      { id: 'skip', label: '先不建', hint: '叶子照样能查（靠词命中），只是少了"指路"那一层' },
    ],
  },
  {
    id: 'leaves-managed', label: '确认有叶子', by: 'user', skippable: true,
    why: '有真资料才有得查；顺手教一次"排除"。',
    def: '保持默认（工作区全纳已含叶子），并随手抽查一次检索',
    options: [
      { id: 'narrow', label: '收窄成几份重点资料', hint: '用排除规则挡掉草稿目录（`drafts/`、`*.draft.md`）' },
      { id: 'readonly', label: '把别的仓当只读参照一起纳', hint: '命中会标〔只读参照〕，别当现行账' },
    ],
  },
  {
    id: 'graph-built', label: '建指针图', by: 'llm', skippable: true,
    why: '检索、体检、归档闸都从这张图算（纯本地、零账、秒级）。',
    def: '跑 `memoryos_graph(action=build)`',
    options: [{ id: 'later', label: '等资料更多再建', hint: '图随时可重建；建档那一步也会先替你建一次' }],
  },
  {
    id: 'checked-once', label: '体检一次', by: 'llm', skippable: true,
    why: '把"真盲区"讲给你听（缺触发行/孤儿条目/未解析引用）——最好的一次教学。',
    def: '跑 `memoryos_graph(action=check)`，然后照实念前三条盲区与下一步',
    options: [{ id: 'skip', label: '先跳过', hint: '盲区不会自己消失，只是晚点知道' }],
  },
  {
    id: 'memory-scaffolded', label: '建档＋汇报', by: 'llm', skippable: true,
    why: '把"盘上真有什么"变成骨架草稿与待补清单（扫了多少、抽到多少、建议先补哪三条）。',
    def: '跑 `memoryos_setup(action=scaffold)`：**默认 dry-run**，先给汇报与骨架草稿，你点头才落盘',
    options: [
      { id: 'write', label: '直接落盘', hint: '写 `MEMORY*.md` 四份；只写自己认领的 marker 块，绝不覆盖你的正文' },
      { id: 'skip', label: '只看汇报不落文件', hint: '汇报仍给（含建议先补的 3 条）' },
    ],
  },
]

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
    // 2026-10-03 用户定：**首次建档不是功能**（它是安装的一部分＝一次性任务，由 LLM 执行的状态机）——
    // 已从 FEATURES 删除，落成 `STEPS['memory-scaffolded']` ＋ `BOOTSTRAP` 里的最后一格 ＋
    // `memoryos_setup(action='scaffold')`。判据：一次性安装任务不进功能表（功能＝常驻、有默认值、可开关）。
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
