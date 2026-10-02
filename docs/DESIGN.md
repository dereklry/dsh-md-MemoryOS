# 插件设计说明（Architecture & Contract）

> 面向要读代码、改代码、扩展功能的人。**为什么这么设计（判断与踩坑）**在 `JUDGMENTS.md`，**模型该怎么用**在 `AGENT-GUIDE.md`，**一天怎么转**在 `WORKFLOW.md`。
> 本文只写"系统实际长什么样"，与代码逐字对齐；不一致视为缺陷（闸会抓几处，其余靠人）。

---

## 1. 一句话与当前实现边界

以 md 文档为核心、以元素索引为线的个人记忆系统的**宿主插件层**：把"哪些功能在场、谁能操作、缺什么、做过什么"做成可见、可控、可追责的一面板 + 两本账 + 一组模型工具。

**当前实现状态（与 `lib/features.js` 同源，写文档前先跑一次实况）**：

| 功能 id | 控制器 | 实现 | 说明 |
|---|---|---|---|
| `panel` | user | **live** | 设置里的这一节本身 |
| `health` | user | **live** | 状态与依赖体检（每行现算） |
| `switch-ledger` | user | **live** | append-only 开关账本 |
| `jev-engine` | llm | **live** | **只管凭据与通道测通**：存/取 Key（优先宿主凭据面）+ 真发一次极小请求测通 + 记进配置账本。**不含寻路**（2026-10-02 与代码对齐） |
| `surface-admin` | user | **live** | 资料面管理：看/改管理范围（只数文件名，不读内容） |
| `graph-search` | both | **live** | 指针图：建图／`light` 落点（含零命中正文兜底）／`check` 体检（纯本地零账，秒级） |
| `scaffold` | user | todo | 首次建档（四层骨架 + 资料表初稿） |
| `mining` | llm | todo | 候选生成（查空的词→别名、反复读的→资料行） |
| `maintain` | user | todo | 定时维护（build + check → 候选队列） |

`impl: 'todo'` 的功能**在面板上灰显且不给任何按钮**（`mayWrite()` 直接拒绝）：面板不许骗人。搬入一个器官＝把 `impl` 改成 `live`，同时它的开关与状态自动生效，无需改面板。

> **2026-10-02 与代码对齐（用户令："先移除共享包里关于 jev 的功能描述，与代码对齐"）**：`find`（按需语义寻路）与 `radar`（每回合自动指路）**已从登记表删除**——它们在本包里从未实现，登记它们＝面板上写着一条不存在的能力（"假开"）。本包的检索能力**只有词法**：`light`（落点/专档/零命中正文兜底）+ `check`；**"只有事、没有词"在本包答不了**。理由与将来要接 find 的前置条件＝`JUDGMENTS.md` §5.6。

> **一个术语先约定**（`WORKFLOW.md` 的回路图 ②⑤⑥ 反复用到）：**Jev 判路问句文档** ＝ 给判定模型看的候选表，每行 `id ＋ criteria ＋ hint`（`criteria` 用"用户会说的话"写，含口语别名；`hint` 一句"什么情形做什么、去哪看正文"，禁绝对行号）。判定模型＝**Jev（TypeSafe System One 一类快速结构化判定）**，设计上可插拔为 `jev`｜宿主模型｜本地词法。**⚠ 本包不实现这个器官**（`radar`/`find` 均已从登记表删除，见上）；本包与 Jev 相关的**只有** `jev-engine` 那件事＝凭据 + 通道测通。别在文档或代码注释里假装语义寻路已经在工作。

---

## 2. 目录与职责

```
package.json          装载契约的载体（exports./client + exports./package.json + dsh.client + dsh.bundle.patch）
cordis.patch.yml      profile 层的配置样例（全部留空/示例值；改这里＝改这台机器的出厂默认）
index.js              Host 半：读 config → 建探针 → buildSnapshot() → writeSwitch() → runSetup() → 注册三工具 → 挂面板数据面
client.js             浏览器半：手写 ModuleLoader 工厂，注册 settings.section 整页面板（零构建链）
lib/features.js       功能登记表（唯一权威：面板显示什么、谁能操作、缺什么算不算生效）
lib/switches.js       开关账本 + 写侧权限 mayWrite() + 生效值三层 + 状态派生 deriveState()
lib/setup.js          配置账本 + Jev 测通（node:https，transport 可注入）+ 掩码
lib/probes.js         依赖探针 / 步骤探针（纯本地 fs/env，5 秒 TTL，绝不起进程）
lib/keystore.js       Key 落点：宿主凭据面优先 + git 工作树守卫 + 掩码；明文只在本机内存过一下
lib/surface.js         资料面登记（目录并集、排除匹配、扫描计数、试算）
lib/graph.js           指针图（扫 .md → 节点/边 → graph.json；light 两级解析＋BFS；check 盲区）
lib/archive.js         归档闸（提交前检查：未提交新增档有没有人引用／回指条目号悬不悬空／新条目有没有人回指）
lib/api.js            面板 HTTP 面（延迟挂载 + prefix JSON 404 兜底 + 写后回快照）
test/load.js          离线闸（零网络；条数看输出末行）
test/stub-dsh-tools.mjs  宿主 dsh-tools 的恒等替身（让闸不依赖 DSH 安装）
```

**依赖方向是单向的**：`index.js → lib/*`；`lib/*` 之间只有 `switches.expandHome` 与 `setup.maskKey` 两处被复用，`features.js` 是叶子（谁都能依赖它，它不依赖任何人）。这条约束的意义：登记表可以独立被闸和工具读取，不会出现"读表要先起宿主"。

---

## 3. 数据模型（三本账 + 一个派生缓存）

> 三本账都是 append-only JSONL；另有一个**派生缓存** `<dataDir>/graph.json`（§3.4）——它不是账，删了可重建、不参与备份迁移。

三本都是 **append-only JSONL**：一次操作＝一行，历史永不改写；读侧 fold 取每键最新行，坏行跳过并计数（fail-open：账本坏不拖垮功能）。

### 3.1 `<dataDir>/switches.jsonl` —— 谁切的

```json
{"key":"radar","value":false,"by":"user","reason":"这轮不想花钱","ts":"2026-09-28T01:26:06.752Z"}
{"key":"jev-engine","value":true,"by":"llm","reason":"用户要求接上语义引擎，已测通","ts":"…","lock":true}
```

| 字段 | 含义 |
|---|---|
| `key` | 功能 id（必须存在于登记表） |
| `value` | 期望值（true/false） |
| `by` | **`user` 或 `llm`** —— 这是本项目与"只有一个 source 字符串"的做法的关键差别：事后能分清谁关的 |
| `reason` | 人话理由。`by:'llm'` 时**必填**（没有理由就不许动） |
| `lock` | 出现即设定接管状态：`true`＝用户接管（模型写侧被拒）、`false`＝解除 |

### 3.2 `<dataDir>/setup.jsonl` —— 做过哪些准备动作

```json
{"step":"jev-key","ok":true,"by":"llm","ts":"…","note":"存入 宿主凭据面 ref=JEV_API_KEY","masked":"sk-1…cdef（32 位）","reason":"用户让我代存"}
{"step":"jev-probe","ok":true,"by":"llm","ts":"…","note":"choice=big conf=0.98","latencyMs":812,"reason":"先看通不通"}
```

`step` 的取值＝登记表 `STEPS` 的键。测通类步骤有**时效**（`setupFreshDays`，默认 7 天）：过期即视为未满足，功能状态自动回退成「待配置」。

**明文 Key 不进任何一本账**，只进 `masked`（长度 + 头尾几位）。

### 3.4 `<dataDir>/graph.json` —— 指针图（派生缓存，不是账）

`{version, builtAt, tookMs, roots[], stats{files,nodes,edges,unresolved,skippedExcluded,capped}, nodes[{key,kind,name,code,path,line,triggers[]}], edges[{from,to,kind,type,reason}]}`

- 节点 `kind`＝`file`／`entry`（标题条目，带 `triggers[]`）／`name`（H1 题名）；边分 `structural`（contains/titled）与 `reference`（points：path/code——`path` 收**反引号路径**与**标准 Markdown 链接** `[文字](路径.md)`，后者挂在文件节点上，与内核同源）。
- **只索引不抄正文**：标题·条目号·触发行·反引号路径·标准 Markdown 链接·「§三 AA12」式指针 ⇒ 图小、建得快、确定性（同输入同图），且不把敏感正文复制一份。
- `unresolved`＝指向不存在资料的引用条数（体检的头号目标）；**标准 Markdown 链接解析不到不建边、也不计未解析**（相对链接里的 `../` 与说明性链接太多，倒进来会把真该修的淹掉）；超 `graphMaxBytes` 的文件跳过并出提示；命中 `graphMaxFiles` ⇒ 标"图不完整"。
- 解析优先级写死：**条目号 > 精确同名 > 归一相等 > 触发行子串 > 标题子串**（曾让子串先跑，把精准命中降级成"原样子串"，披露的依据就变成假的）。

**零命中兜底：域内正文全文扫描**（2026-10-02 移植自内核 `lighter.fulltext_fallback`，`lib/graph.js`）。

图只索引**名字层**，未登记的正文不进图 ⇒ "词只在正文里"是 `light` 唯一的结构性盲区；这条腿把它补上，**不建索引、现扫现查**（几百份 `.md`，读盘＋字面匹配在几十毫秒级，零账零网络）。三条纪律照抄内核：

1. **只报"字面出现过"，绝不升级成"这就是答案"**——同词不同题是常态；措辞一升级人就被带到错文件（输出末尾自带这句免责）。
2. **泛词限量并如实报数**，不静默中截：命中 > `FULLTEXT_MAX_LISTED`（40 行）时**只回一个数**（"命中过多（N 行 / M 个文件）＝疑似结构词"），连"命中最多的 8 个文件"也不列；否则最多列 `12` 个文件、每文件最多 `8` 个行号、每条附 80 字原文片段。
3. **扫描面与起点域同源**：都走图里的 `file` 节点（同一批记忆根 ∪ 同一排除口径），不留第二份范围真相。

**两轮匹配并披露用了哪轮**：先 `原样`（原样、忽略大小写，精确可信）→ 全空才 `归一`（NFKC＋小写＋只留字母数字汉字，治全半角/大小写/连字符手滑；归一键短于 3 字不做第二轮，防洪泛）。**任一模式都不做正则**——用户输入一律当字面量。命中落在**已登记条目体**内的文件排前，并标 `〔条目体·编号〕`（可直接 `light <编号>` 接着看图邻域）；否则标 `〔正文〕`。

**默认输出＝落点清单**（2026-10-02 用户定："md 文档是自带索引，有没有工具也能逐级阅读；工具就是为了让 LLM **跳过目录、直达记录（搜索词）所在的条目+文件**。所以，从代码设计上，就应该避免输出过多内容。"）。每行＝`文件` 〔条目体·编号／文件／名字〕 L行号 · 短标题，上限 `LIGHT_MAX_POINTS = 12`，超出**如实报"另 N 处"**（截断不静默）；正文不在这里给（要内容 `read` 那个文件）。**邻域地图（谁指谁＋reason＋建议读）改由 `expand:true` 显式索取**，默认路径连 BFS 都不跑（省一次遍历与一大截上下文）。

**条目后紧跟它的「专档」行**（2026-10-02 用户举真实用例定的第二行）：条目在目录档里只留"口径＋指针"，全文另立一份专档（惯例：`<主档词干>-<主题>.md`，如 `notes.md` → `notes-engine.md`）。落点清单于是给**两行**：

```
- `…/notes.md` 〔条目体·AA14〕 L140 · AA14 那个引擎的测试结论…（目录里只留结论）
- `…/notes-engine.md` 〔专档·回指 AA14〕 L4 · 指针条目=AA14；本档是它的证据全文…
- （另有 **9** 个文件回指本条目：要看全＝`expand:true`）
```

判据＝**回指本条目**（`引用条目`／`code` 边）**且文件名由本条目的载体文件派生**（`<stem>-*`）；摘要＝**回指行原文**（零读盘，与内核同口径）。**其余回指本条目的文件只报计数**（实测某条目有 10 个回指者：目录、决策、分析、笔记…全列＝又把索引摊开）。注意：提取器把"指向 AA14"挂在**文件节点**或**文件内的条目**上，两种实现都存在 ⇒ 取回指方的 `.path`，**不认 kind**（认了会漏一边）。

**为什么要改**：实测维护者语料 `light <某中枢档文件>` ＝281 节点／1031 边＝**63,274 字**，下游 6000 字保头保尾中截 ⇒ 交付是"头 3K＋中略 5.7 万字＋尾 3K"＝**中间被撕掉的地图**；而"这份文件有哪些条目／这个词落在哪一行"只需十几行。改后同一查询＝**215 字 / 6 行**（条目号起点 `light AA14`＝246 字，实体起点＝最多 12 处落点约 1.2K 字）。⇒ 结论：**索引自描述（md 本身）＋工具直达落点**，两者分工，不该让工具重做目录。

**过泛闸（2026-10-02，用户口径＝"过泛词直接只报出现在多少个条目，其他细节直接隐去"）**——两道，都**只回一个数**：

| 触发 | 输出 | 隐去什么 |
|---|---|---|
| **起点过泛**：任一档命中 > `MAX_STARTS`（8，`resolveStarts`） | `过泛：\`X\` 命中 **N 个起点**（闸＝8，来自<档>档）＝这个词太泛，不展开图。` ＋ 一行指引 | 整张图（节点/边/建议读）、形近候选、兜底段 |
| **正文过泛**：兜底扫描命中 > `FULLTEXT_MAX_LISTED`（40 行） | `## 命中过多（N 行 / M 个文件）＝疑似结构词，不逐条列` ＋ 一行指引 | 逐行位置、**连"命中最多的 8 个文件"也隐去** |

为什么不是"给前几个"：实测维护者语料上 `light DSH` ＝ **31 起点／320 节点／1210 边＝74.7K 字**，下游 6000 字保头保尾中截 ⇒ 模型只拿到**半张图**、白烧 ~25K token。**过泛不是"错的查询"，是"问得太泛"**——给细节等于把上下文烧在噪声上；换个更具体的词才是出路（`depth` 只能减少一层，治不了起点太多）。

**一句都没有时不静默**：如实输出 `## 域内正文兜底：已扫 N 份 .md，零命中`，并点出「另有 N 份域内 .md 不在扫描面（超大小门／建图后被上限截／建图后新增）」＋三种可能（落在被排除目录 / 内容不在 `.md` 里 / 跨行断词）。**"空手"必须是可判读的信息**——否则人分不清"没这份资料"（信息）与"文件被挡在语料外"（事故）。

调用位置：只在 `light` **零命中**时跑（有起点就不付这份读盘成本），且结果排**在形近候选之前**——**事实先于线索**（内核实测两者会互相打架且都不可省）。

### 3.3 `<dataDir>/surface.jsonl` —— 资料面（管到哪儿）

```json
{"op":"add-root","path":"D:/notes","by":"user","ts":"…"}
{"op":"add-exclude","pattern":"notes/drafts/","by":"user","reason":"草稿不算资料","ts":"…"}
{"op":"drop-exclude","pattern":"todo.md","by":"llm","reason":"用户改主意","ts":"…"}
```

| `op` | 参数字段 | 语义 |
|---|---|---|
| `add-root` / `drop-root` | `path` | 增删**增量根**。生效根＝`config.memoryRoot` 基线 ∪ 这里的增量；**基线不可被删**（那是宿主配置，改了要重启） |
| `add-exclude` / `drop-exclude` | `pattern` | 增删排除规则。匹配**双口径**：相对根的路径 ＋ 绝对路径 |

排除写法（覆盖到"具体子目录 + 具体文件"）：

| 写法 | 挡什么 |
|---|---|
| `notes/drafts/` | 某根下那个子树（且**不误伤** `notes/drafts-old/`——前缀按路径段边界比较） |
| `todo.md` | 任意层级的同名文件 |
| `*.draft.md` | 命名模式（`*` 不跨 `/`） |
| `archive/**` | 跨层子树 |
| `/abs/path/x.md` | 绝对路径（同一入口两种口径都试） |

三条实现纪律：**`*`／`**`／少于 3 个实字符的规则一律拒**（那等于悄悄清空资料面）；**加排除前先试算**（`preview`，挡不到一个文件就拒绝落账，避免"以为排除了"）；**profile 基线只读**（插件不代写宿主配置）。

### 3.5 归档契约与归档闸（提交前检查）

**契约的形状是给人写的，不是给工具写的**。第一要求是**没有任何工具时人能逐级钻取**：

```
入口约束（每轮注入的 md）
  → 索引文件的一行速查（"有哪几类、去哪看"）
    → 条目标题（`### AA17 <情形>：<动作/结论>`）
      → 「触发」行（"这就是我遇到的事"）
        → 条目体（做法／坑／补充＝结论全文）
          → 专档 xxx.md（文件开头 `指针条目=AA17` 回指）
```

`light`（词→文件／行）与归档闸只是**同一着陆点的加速器与检查器**：工具顺着这份形状读，**不要求人按工具的口味写**。

条目形状（一份形状，四方共用）：

```markdown
### AA17 <情形>：<动作/结论>            ← 一句人话，别写抽象名词
- **触发**：用户会怎么说这件事（症状词·口语·简称·错字常见写法·工具名/报错名）
- **做法**：可复用的步骤 / 判据 / 命令（结论全文写这里）
- **坑**：踩过的、别重犯的（含"我上次误判成 X"）
- **补充：<日期>**：翻案或追加的新事实＝记忆的前沿
- **登记**：<日期> | 决策 Dxx | 相关索引 §x | 专档 xxx.md
```

| 字段 | 给人（钻取） | 给 `light`（零账） | 给归档闸 |
|---|---|---|---|
| 条目标题 | 索引一眼判断 | 原子串＝起点词 | 判"这轮新条目进没进图" |
| 触发行 | "这就是我遇到的事" | **变体档唯一窄面**（错字／简称靠它） | —（不改判定） |
| 条目体 | 复用正文 | 锚面（写哪儿都可查） | — |
| 专档回指 | 从条目跳到细节 | 补"文件是叶子"跳不通那一腿 | 判"回指的条目号存不存在" |
| commit | 留痕 | 时间面取自 git | **闸的范围＝未提交改动** |

**文件头三行契约**（专档自带，必须落在文件开头前 12 行内；写超了等于没写）：

| 写法 | 作用 |
|---|---|
| `> 档位：叶子 ｜ 指针条目=AA4` | 声明档位并回指条目：**叶子**（默认，不写就是它）／**中枢**（＝指路文件，逐跳展开；**新中枢不要求别人登记它**——它本身就是索引） |
| `> 归档：免索引（理由）` | 归档闸的豁免：跳过判定，但**在输出末尾列进「豁免清单」**（豁免必须可见，不静默） |

**指针的真实形态**（都在归档里出现过，闸与图都认）：裸条目号 `AA14`、`（条目 AA14）`、`§三 AA14`、反引号路径 `` `docs\x.md` ``、**标准 Markdown 链接** `[x](x.md)`（第三种最自然——目录索引表天生就这么写）、文件头回指 `指针条目=AAx`。**别写绝对行号**（一编辑就漂移）。

**归档闸**（`memoryos_graph(action='archive-check')`，实现＝`lib/archive.js`）：

- **范围＝"本次"**：各仓 `git status` 的未提交改动（`??`／已暂存 `A`／重命名 `R` 新名）＋从 `git diff` 新增行里认出的 `+### AAx`。**不记 sha、不看历史**；已提交的东西不管（那不是"本次"）。
- **三条判据**：① 新增档**没有任何别的 .md 引用它** ⇒ warn（＝忘了登记进索引）；有引用但来源不是中枢档 ⇒ info。② 文件头 `指针条目=AAx` **悬空**（图里没这个条目）⇒ warn。③ 本轮新条目**没人引用／回指** ⇒ info；压根没进图 ⇒ warn（标题格式不对）。
- **豁免**：文件头 `> 归档：免索引（理由）` ⇒ 跳过，但列进豁免清单。
- **不管**（如实计数）：域外文件、被资料面排除的文件、mirror 快照（`snapshot-`／`_snap_`）、自声明中枢的新档。
- **纪律**：只 warn／info、**退出码零、绝不改任何文件**——补不补指针由模型／人判断。**全库**结构体检（悬空指针／孤儿／副本／图水位）不在这里，走 `memoryos_graph(action='check')`。
- **看哪个仓**：默认＝每个生效记忆根各自所属的 git 工作树（自动向上找 `.git`）；记忆根不在仓里时用 `config.archiveRepos` 显式给。

三条实踩的坑（照抄别再踩）：

1. **非 ASCII 路径会被 git 转义**成 `\345\275\222` 并加引号 ⇒ 直接拿去查文件永远 False，症状是"本次新增 1 份、待查 0"的**静默空转**。修法＝调用带 `-c core.quotepath=false` ＋ 解析侧再解一次转义。
2. **判定要用刷新后的图**：新文件得先入图才有边可查，所以闸默认先按需重建一次图。
3. **闸只管"本次新增"**，整体漏洞另跑 `check`——把两件事混在一起，闸就会开始报一堆与本次无关的旧账。

---

## 4. 状态机（派生，不存储）

```
生效值 value  = 账本最新行 > profile config.defaults[id] > 登记表 default      ← effectiveValue()
状态   state = 下面这条流水线的第一次命中                                      ← deriveState()

  ① impl === 'todo'                      → planned      未实现
  ② value === false                      → off          已关
  ③ 有前置步骤未完成 pending[]            → waiting      待配置      ★
  ④ 有硬依赖缺失 missing[hard=true]       → unavailable  不可用
  ⑤ 有可降级依赖缺失                       → degraded     降级运行
  ⑥ 其余                                  → on           生效中
```

`waiting` 排在依赖检查之前：功能"该开但动作没做完"时，先告诉用户**还差什么动作**比告诉他"缺 python"更有指导性。

功能对象还带四个**权限/展示位字段**（由 `deriveState()` 算出，面板与工具读同一份）：

| 字段 | 含义 |
|---|---|
| `operator` | = `controller`：`user` / `llm` / `both` |
| `canUserToggle` | 面板是否画开关（`controller!=='llm' && impl!=='todo'`） |
| `canLlmToggle` | 模型是否能切（`controller!=='user' && impl!=='todo' && !locked`） |
| `locked` | 用户是否已接管（最新账行 `lock===true`） |

外加 `missing[]`（缺哪些依赖，每项带 `hard` 与探针原话 `why`）、`pending[]`（还差哪步、`by` 是谁）、`stepsDone[]`（做过的步骤与时间）、`source`（`ledger`/`config`/`registry`）、`by`/`reason`/`ts`。

---

## 5. 权限模型（判在落盘前，不判在界面上）

面板与模型调**同一个** `writeSwitch()`；`mayWrite(feature, by, prev)` 是唯一闸门：

| 情形 | `by:'user'` | `by:'llm'` |
|---|---|---|
| 功能不在登记表 | 拒（列出可选 id） | 同 |
| `impl==='todo'` | 拒："代码尚未实现，不给切" | 同 |
| `controller==='user'` | ✅ | 拒："登记为仅用户可切" |
| 用户已接管（`lock:true`） | ✅（含解除） | 拒："已被用户接管（时间），请在面板解除接管" |
| `controller==='llm'` / `'both'` | ✅（接管/解除用） | ✅，但**必须带 reason**；同值不重记 |

两条总闸在 profile 层：`llmCanSwitch=false` ⇒ 模型完全不能改开关；`modelCanSaveKey=false` ⇒ 模型不能代存 Key。

**拒绝必须是可读的**：工具返回 `✗ 拒绝：<原因>`，模型能把原因转告用户，也就不会绕路。这是设计目标，不是错误处理细节。

---

## 6. 接口面

### 6.1 宿主 HTTP 面（面板专用，前缀 `/api/dsh-md-MemoryOS`）

| 方法＋路径 | body | 语义 |
|---|---|---|
| `GET /snapshot` | — | `{ok:true, snapshot}`（现算） |
| `POST /switch` | `{feature,value,reason?}` | 用户切开关（不填理由也放行——面板是主人） |
| `POST /takeover` | `{feature,value}` | 写 `lock:true`（接管，模型出局） |
| `POST /release` | `{feature,value}` | 写 `lock:false`（解除接管） |
| `POST /graph` | `{action:"build",reason?}` | 重建指针图（面板按钮走这里；`light`/`check` 归模型工具） |
| `POST /surface` | `{op,path\|pattern,reason?}` | 资料面：`add-root`/`drop-root`/`add-exclude`/`drop-exclude`/`preview`（与模型工具同一个 `writeSurface`） |
| 前缀下其它路径 | — | **JSON 404**（不能掉进宿主 SPA 回落返回 HTML） |

写成功返回 `{ok,message,snapshot}`（省一次往返，也保证"点了就看到变化"）；业务拒绝返回 **HTTP 400 + message**，面板原样显示不粉饰。

鉴权：本模块零鉴权代码——GUI 只绑 127.0.0.1、token→cookie 由宿主承担，面板 `fetch` 不带认证头。**别把这台机器的写接口暴露到远程 profile。**

### 6.2 快照形状（面板与工具共用）

```
{ features[], byGroup{组:feature[]}, ledger[], ledgerMeta{file,exists,corrupt,lines},
  setup[], setupMeta{file,exists,corrupt,freshDays},
  deps[{id,label,hard,note,result}],                       ← result:true 或"缺什么"的人话
  graph{exists,file,builtAt,ageHours,stale,tooOld,changed,nodes,edges,files,unresolved,roots[],maxAgeHours},
  surface{exts[],prune[],roots[{path,source,removable,by,ts,exists,matched,capped,excluded,byRule{},samples[]}],
          excludes[{pattern,by,ts,hits}],totals{roots,dirsMissing,managed,hidden,capped},ledger{file,lines,corrupt},hint},
  meta{pkg,version,dataDir,llmCanSwitch,modelCanSaveKey,
       key{present,ref,from,via,path,writable,masked,warnings[],hint},
       configHints{memoryRoot[],pythonBin,graphDb,kernelRepo,keyFile,baseUrl,allowKeyInRepo}} }
```

### 6.3 模型工具（五个）

| 工具 | 参数 | 返回 |
|---|---|---|
| `memoryos_status` | `feature?` | 每个功能一行：状态／控制器／谁定的＋理由＋时间／缺依赖／待办／成本；含账本路径、Key 位置（掩码）与资料面计数 |
| `memoryos_switch` | `feature`,`value:'on'|'off'`,`reason`（必填） | `✓ 已记一行…` / `✗ 拒绝：<原因>`；开了配置型功能会附"仍差 N 步，面板显示待配置" |
| `memoryos_setup` | `action:'probe'|'save-key'|'where-key'|'list'`,`reason`（必填）,`feature?`,`key?`,`path?`,`allow_in_repo?` | 测通结果（含延迟与上游摘要）／代存落点与掩码／当前 Key 在哪／配置账本与待办 |
| `memoryos_graph` | `action:'status'|'build'|'light'|'check'|'archive-check'`,`query?`,`depth?`,`max_nodes?`,`reason?`,`file?`,`no_refresh?` | 图水位／重建结果（节点·边·未解析数）／`light` 亮起子图（带 reason 与解析级别，落空给候选）／`check` 盲区清单／**`archive-check` 提交前归档闸**（三条判据的 warn/info 表＋豁免清单；`file?`、`no_refresh?` 只给调试） |
| `memoryos_surface` | `action:'list'|'add-root'|'drop-root'|'add-exclude'|'drop-exclude'|'preview'`,`path?`,`pattern?`,`reason`（写操作必填） | 资料面现状（每根纳管多少 `.md`、被哪条规则挡多少、样本路径）／增删目录与排除／试算。删 `profile` 基线会被拒；`.md` 之外的类型不放开 |

### 6.4 面板（`settings.section`，`id:'memoryos'`，`order:120`，label「记忆系统」）

五个页签：**功能开关**（按组分块，每行＝状态徽章＋谁能操作＋谁定的＋成本＋待办步骤＋缺依赖＋操作）、**资料面**（当前管理范围的目录清单＋排除规则与"这条挡了几个"＋固定的文件类型与提示语）、**概览**（统计与两种控制权解释）、**依赖与路径**（探针表＋config 落点）、**账本**（开关账／配置账两张表）。

取数节奏：挂载读一次 ＋ 右上「刷新」＋ 写后吃返回快照；**不轮询、不缓存**。

---

## 7. 配置面（profile 层，全部可缺省）

`readCfg()` 读这些键（`config` > `env` > 发现链）：

| 键 | env 别名 | 作用 |
|---|---|---|
| `dataDir` | `MEMORYOS_DATA` | 两本账落点（默认 `~/.dsh/memoryos`） |
| `memoryRoot` | `MD_MEMORY_ROOTS` | 记忆根，`;` 或 `,` 分隔多个 |
| `archiveRepos` | `MEMORYOS_ARCHIVE_REPOS` | 归档闸看哪些 git 仓（默认＝生效记忆根各自所属的仓，自动向上找 `.git`；记忆根不在仓里时在这里显式给） |
| `pythonBin` | `MD_PYTHON_BIN` | 内核解释器（读面纯标准库，系统 Python 即可） |
| `kernelRepo` | `MD_REPO_ROOT` | `pythonBin` 的发现基准 |
| `graphMaxFiles` | — | 建图最多扫多少份文件（默认 2000；命中会标"图不完整"） |
| `graphMaxBytes` | — | 单份文件超过多少字节就跳过（**默认 8MB**，与内核 `MD_MAX_FILE_BYTES` 同口径；防一份巨型日志拖垮建图，被跳过的会在零命中兜底里如实点名） |
| `graphStaleHours` | — | 图水位超过几小时算"该重建"（默认 24；另有 changed 文件数也会判过期） |
| `ledgerTail` | — | 面板账本页显示多少行 |
| `scanCap` | — | 资料面每根**最多数到多少个文件**就停（默认 400；面板要秒开，建索引是另一件事） |
| `keyFile` | `JEV_KEY_FILE` | Key 文件位（凭据面之后、数据目录之前） |
| `legacyKeyFiles` | — | 旧位置只读兼容（读到即标警） |
| `baseUrl` / `model` / `probeTimeoutMs` | `JEV_BASE_URL` / `JEV_MODEL` | 测通用的上游与超时 |
| `setupFreshDays` | — | 测通新鲜度（过期→`waiting`） |
| `llmCanSwitch` | — | 总闸：模型能否改开关（默认 true） |
| `modelCanSaveKey` | — | 模型能否代存 Key（默认 true） |
| `allowKeyInRepo` | — | 允许把 Key 写进 git 工作树（默认 **false**，见 §8） |
| `defaults` | — | 各功能出厂默认（例：`{ "graph-search": true, "jev-engine": false, … }`——键名＝登记表里存在的功能；**登记表外的键在这里写了也不算数**），低于账本 |
| `transport` | — | 测试注入点：替换测通的 HTTP 传输（闸因此全程不联网） |

---

## 8. 秘密（Key）的处理

**首选宿主凭据面**：`ctx.credentials`，ref 名 `JEV_API_KEY`。物理文件 `~/.dsh/.credentials.yaml`，由 `@deepseek-ai/dsh-credentials-local` 以 **0600 + 原子替换 + 文件锁** 维护。选它同时满足三条：不在任何 git 工作树内（不可能被顺手推走）、在用户目录（不随 app 升级覆盖）、有 `describe(ref)`（面板问"配了没有／从哪来／可否写"而无需读明文）。

- **读序**：凭据面 → `env JEV_API_KEY/TYPESAFE_API_KEY` → `config.keyFile` → `<dataDir>/jev-key.txt` → `~/.dsh/memoryos.key` → `legacyKeyFiles`（只读兼容，命中即 `warnings` 标警）。
- **写序**：能走凭据面就走；落文件前做 **`insideRepo()` 守卫**——自目标向上找 `.git`，命中即**拒写**（除非 `allowKeyInRepo`／`allow_in_repo`），并在成功返回里带 `inRepo:true` 让面板标红。
- **明文纪律**：明文只在本机内存里过一下（供测通用），**不进快照、不进两本账、不进日志、不进工具返回值**；对外只出现掩码。闸有 `F1/F3/F5` 三条断言专门守这条。

为什么写成代码而不是文档：靠 `.gitignore` 挡密钥＝把安全交给"某人记得加那一行"；守卫写死之后，忘记 ignore 这件事没有后果。

---

## 9. 装载契约与宿主扩展点（漏一条就"静默不出现"）

1. `package.json` → `dsh.client.platform = "web"`；
2. `exports["./client"]` 指向浏览器文件；
3. `exports["./package.json"]` 必须存在——装载器用 `require.resolve('<pkg>/package.json')` 扫声明，**解析失败被静默 catch**（表现：`/plugins/<id>/client.js` 404，设置页根本没那一项，零日志）；
4. `window.__ModuleLoader__.load({ id })` 的 `id` 必须等于 `name`；
5. `dsh.bundle.patch` 指向 `cordis.patch.yml`，patch 行 `id` == 包名。

用到的宿主扩展点（均为公开契约，不碰内部实现）：

| 扩展点 | 用来做什么 | 为什么不是别的 |
|---|---|---|
| `ctx.slots.inject('settings.section')` + `register({id,order,label:()=>…,inject:()=>({})}, Panel)` | 设置里整页 | `settings.general.item` 只是一行偏好，整页必须用 section；`id` 必须是自己的新 id（复用已发布 id＝换掉人家那一格）；组件是**叶子**——宿主只给它 `close`，数据必须自取 |
| `ctx.inject(['webServer'], cb)` | 延迟挂载 HTTP 面 | `ctx.get('webServer')` 在本插件 apply 期恒 undefined（晚到 Service）；写进顶层 `inject` 会让 headless profile **整个插件永挂** |
| `ctx.tools.register(defineTool(...))` | 三个模型工具 | 失败不 throw：错误归一成模型可读文本 |
| `ctx.credentials`（`describe`/`resolve`/`set`/`unset`） | Key 的家 | 见 §8 |
| `web.register({kind:'exact'|'prefix', path, handler})` | 路由 | `prefix` 兜底必须回 JSON 404 |

面板里**没有** `reduce(Object.assign)` 合并样式（会把数组长进 `style` → 整个 slot entry 崩）、颜色只用 `var(--dsw-alias-*)`（token 改名只降级外观不崩渲染，且必须 light/dark 都成立）、`fetch` 只有两处（`load` 读、`act` 唯一写通路）、每行带稳定选择器 `data-sev="mos:…"` 供自动化验证——这四条都有对应闸断言。

---

## 10. 怎么加一个功能（照抄即对）

1. `lib/features.js` 的 `FEATURES` 加一行：`id / label / what / cost / controller / default / deps / steps / impl / group`。
   - 标 `controller:'llm'` 就必须给 `steps`（lint 会拒绝"模型可切却没步骤"的活功能）；
   - 新器官先写 `impl:'todo'` 也能进表——面板会灰显、不给按钮，等代码搬进来改 `live`。
2. 用了新依赖 → 在 `DEPS` 加一项（`label/hard/note`）**并**在 `lib/probes.js` 加探针；新前置动作 → 在 `STEPS` 加一项（`label/by/how`）**并**加步骤探针。`DEPS↔探针`、`STEPS↔步骤探针` 双向同源，闸会红。
3. 器官自己在热路径上调 `effectiveValue()/deriveState()`（或直接读快照的布尔），**不要**自己造一份开关判断逻辑——两套规则必然分叉。
4. 跑 `node test/load.js`（条数看末行）＋ `node --check client.js`（若动了面板）。
5. 装到本机的动作按宿主侧上线流程走（预检 → 装载面 → 判生效只认 `Tool.listTools` → 重启归用户）。

---

## 11. 明确不做的

- **不自动改用户的资料**（只出候选，确认权在人手里）；
- **不自动决定功能存废**（模型只能动 `llm/both` 且未被接管的项）；
- **不存快照式状态**（一切现算）；
- **不把秘密写进 git 工作树**（守卫拒写）；
- **不在面板上给未实现功能放按钮**；
- **不引构建链**：面板是手写浏览器文件，`transport`/`defineTool` 两个注入点保证闸零依赖零网络。
