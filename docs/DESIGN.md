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
| `jev-engine` | llm | **live** | 配置型样板：Key 到位 → 测通 → 才置生效 |
| `surface-admin` | user | **live** | 资料面管理：看/改管理范围（只数文件名，不读内容） |
| `radar` | both | todo | 资料亮起（每回合匹配资料并亮给模型） |
| `graph-search` | both | todo | 指针图检索（词→文件/行，本地零账） |
| `scaffold` | user | todo | 首次建档（四层骨架 + 资料表初稿） |
| `mining` | llm | todo | 候选生成（查空的词→别名、反复读的→资料行） |
| `maintain` | user | todo | 定时维护（build + check → 候选队列） |

`impl: 'todo'` 的功能**在面板上灰显且不给任何按钮**（`mayWrite()` 直接拒绝）：面板不许骗人。搬入一个器官＝把 `impl` 改成 `live`，同时它的开关与状态自动生效，无需改面板。

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
lib/api.js            面板 HTTP 面（延迟挂载 + prefix JSON 404 兜底 + 写后回快照）
test/load.js          离线闸（零网络；条数看输出末行）
test/stub-dsh-tools.mjs  宿主 dsh-tools 的恒等替身（让闸不依赖 DSH 安装）
```

**依赖方向是单向的**：`index.js → lib/*`；`lib/*` 之间只有 `switches.expandHome` 与 `setup.maskKey` 两处被复用，`features.js` 是叶子（谁都能依赖它，它不依赖任何人）。这条约束的意义：登记表可以独立被闸和工具读取，不会出现"读表要先起宿主"。

---

## 3. 数据模型（盘上只有三本账，都是 append-only JSONL）

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
| `POST /surface` | `{op,path\|pattern,reason?}` | 资料面：`add-root`/`drop-root`/`add-exclude`/`drop-exclude`/`preview`（与模型工具同一个 `writeSurface`） |
| 前缀下其它路径 | — | **JSON 404**（不能掉进宿主 SPA 回落返回 HTML） |

写成功返回 `{ok,message,snapshot}`（省一次往返，也保证"点了就看到变化"）；业务拒绝返回 **HTTP 400 + message**，面板原样显示不粉饰。

鉴权：本模块零鉴权代码——GUI 只绑 127.0.0.1、token→cookie 由宿主承担，面板 `fetch` 不带认证头。**别把这台机器的写接口暴露到远程 profile。**

### 6.2 快照形状（面板与工具共用）

```
{ features[], byGroup{组:feature[]}, ledger[], ledgerMeta{file,exists,corrupt,lines},
  setup[], setupMeta{file,exists,corrupt,freshDays},
  deps[{id,label,hard,note,result}],                       ← result:true 或"缺什么"的人话
  surface{exts[],prune[],roots[{path,source,removable,by,ts,exists,matched,capped,excluded,byRule{},samples[]}],
          excludes[{pattern,by,ts,hits}],totals{roots,dirsMissing,managed,hidden,capped},ledger{file,lines,corrupt},hint},
  meta{pkg,version,dataDir,llmCanSwitch,modelCanSaveKey,
       key{present,ref,from,via,path,writable,masked,warnings[],hint},
       configHints{memoryRoot[],pythonBin,graphDb,kernelRepo,keyFile,baseUrl,allowKeyInRepo}} }
```

### 6.3 模型工具（四个）

| 工具 | 参数 | 返回 |
|---|---|---|
| `memoryos_status` | `feature?` | 每个功能一行：状态／控制器／谁定的＋理由＋时间／缺依赖／待办／成本；含账本路径、Key 位置（掩码）与资料面计数 |
| `memoryos_switch` | `feature`,`value:'on'|'off'`,`reason`（必填） | `✓ 已记一行…` / `✗ 拒绝：<原因>`；开了配置型功能会附"仍差 N 步，面板显示待配置" |
| `memoryos_setup` | `action:'probe'|'save-key'|'where-key'|'list'`,`reason`（必填）,`feature?`,`key?`,`path?`,`allow_in_repo?` | 测通结果（含延迟与上游摘要）／代存落点与掩码／当前 Key 在哪／配置账本与待办 |
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
| `pythonBin` | `MD_PYTHON_BIN` | 内核解释器（读面纯标准库，系统 Python 即可） |
| `kernelRepo` | `MD_REPO_ROOT` | `pythonBin` 的发现基准 |
| `graphDb` | `MEMORYOS_GRAPH` | 指针图库路径（默认在记忆根下找 `ledger_graph.db`） |
| `graphStaleDays` | — | 图水位超过几天算降级 |
| `ledgerTail` | — | 面板账本页显示多少行 |
| `scanCap` | — | 资料面每根**最多数到多少个文件**就停（默认 400；面板要秒开，建索引是另一件事） |
| `keyFile` | `JEV_KEY_FILE` | Key 文件位（凭据面之后、数据目录之前） |
| `legacyKeyFiles` | — | 旧位置只读兼容（读到即标警） |
| `baseUrl` / `model` / `probeTimeoutMs` | `JEV_BASE_URL` / `JEV_MODEL` | 测通用的上游与超时 |
| `setupFreshDays` | — | 测通新鲜度（过期→`waiting`） |
| `llmCanSwitch` | — | 总闸：模型能否改开关（默认 true） |
| `modelCanSaveKey` | — | 模型能否代存 Key（默认 true） |
| `allowKeyInRepo` | — | 允许把 Key 写进 git 工作树（默认 **false**，见 §8） |
| `defaults` | — | 各功能出厂默认（`{ "radar": true, … }`），低于账本 |
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
