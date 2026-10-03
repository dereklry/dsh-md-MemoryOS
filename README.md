# dsh-md-MemoryOS

> 作者一句话：调用agent完成工作后，就需要归档=写md文件记本次完成了啥，所以本机agent手写md文件=记忆。如何管理记忆，自然是建立层级索引，使记录的内容能被LLM找到。OS只是加快、跳过逐级查询，并在归档契约中增加检查点，促进LLM形成可持续迭代的记忆内容。而元素timeline，是用于投资场景，对元素（比如：中国平安/别名：601318、CPI/M1/M2）目标按清单制管理，强时间特性的事件流记录，父子关系管理（某时间切面下的财报指标、K线、交易过程等），带元素间指针（比如提及个股交易<-->个人交易逻辑.md<-->交易记录.md）。
> 把「以 md 文档为核心、以元素索引为线」的个人记忆系统装进 DSH：建立 → 维护 → 使用，全部可在**设置 → 记忆系统**里看见和掌控。
> **两个切面别读混**：**md 文档＋指针图**回答"这件事该读哪份资料"（词法落点，零账、可逐级钻取）；**元素库**回答"这件事本身的来龙去脉"（元素 × 带时间戳事件，本地 SQLite，内核随包发）——各答一个问题、分成两个数据根，理由＝[`docs/JUDGMENTS.md`](docs/JUDGMENTS.md) §5.9。
> 状态：v0.9.0-win.0（控制面板 + 功能开关账本 + 资料面管理 + **指针图**〔`build`/`light`/`check`，`light` **默认只给"落点清单"**——md 自带索引，工具只负责"跳过目录、直达搜索词所在的条目+文件"，**命中的条目后紧跟它的"专档"行**（回指本条目＋文件名由载体文件派生，摘要＝回指行原文）；一级精准搜索+二变体搜索均零命中时，自动扫域内正文；**过泛查询只回一个数**〕+ **提交前归档闸**；**本包检索能力＝纯词法**——**Jev 语义寻路（find）这条路本项目试过：寻路表维护量大、每次调用还产生账单，评估后从模块摘除，只留管线与前置条件待有更优思路再迭代**（2026-10-02 与代码对齐，理由＝`docs/JUDGMENTS.md` §5.6）；与 Jev 相关的只有 `jev-engine` ＝凭据＋通道测通；**元素库（元素-时间线内核：随包发的 Python 纯标准库，落本地 SQLite）已落地**——工具 `memoryos_elements` 九个动作（入库／导入 md／拍快照／取最新快照／时间线／快照／清单／标失效／导出）＋面板第六个页签「元素库」（已管理多少元素／事件／快照＋元素清单）；其中**建档＝`init`**（`ingest`／`import` 也会自动建库）、**候选＝未落库的"待确认候选"**（`elements_deferred`，宁可少建也不制造碎片元素）**都已可用**；**没有"定时"维护**——本包零后台任务，INDEX 重建随 `save`、全量镜像走 `export`、标失效走 `expire`，都按需触发。**仍未搬入的是两组，别混**：① **元素库侧**（内核里已有、只差开出口）＝关联度召回与决策 `relevance`／`decide`／`profile`、元素树与合并 `tree`／`merge`、一键归档 `archive`；② **md 记忆面**（与元素库无关的另一条线）＝登记表里 `scaffold` 首次建档／`mining` 候选生成／`maintain` 定时维护三项仍是 `todo`。
> 本OS开发环境（win11+DSH0.1.5~0.2.0rc2，DSH Desktop v2.x，qwen3.8-flash/deepseek-v4.1flash），如用户环境不同，请调用LLM进行适配性改造。本插件100%代码及说明，均再DSH平台调度LLM输出，描述、排版、功能模块未尽善的，见谅。

## 先读哪份（四份文档各管一件事）

| 你是谁 | 读哪份 | 里面有什么 |
|---|---|---|
| **用户**（要装、要日常用） | [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | 首次启动十分钟清单、配置只有 profile 一处、日常三种动作各在哪做、配置型功能为什么没有开关、Key 放哪、故障排查表、升级回滚 |
| **你机器上的模型**（要用这套系统干活） | [`docs/AGENT-GUIDE.md`](docs/AGENT-GUIDE.md) | 六个工具各何时调、六档状态分别该做什么、配置型功能的正确顺序（`where-key → save-key → probe → switch on`）、权限与"被拒就照实说"、明文 Key 纪律、可粘贴进 AGENTS.md 的最小指令块 |
| **要改代码的人** | [`docs/DESIGN.md`](docs/DESIGN.md) | 模块职责、三本账＋图缓存＋元素库的字段、状态机与优先级、权限矩阵、HTTP 面与快照形状、配置面（全部键与 env 别名）、Key 处理、装载契约四条、加一个功能五步 |
| **要看资料归谁管的人** | [`docs/WORKFLOW.md`](docs/WORKFLOW.md) §4 | 资料面：加目录、排除子目录与具体文件（`notes/drafts/`、`todo.md`、`*.draft.md`、`archive/**`）、试算后再落账、类型固定 `.md` 的原因 |
| **要判断该不该这么做的人** | [`docs/JUDGMENTS.md`](docs/JUDGMENTS.md) | 三层拆分（什么能打包）、两类功能、状态现算、成本按字数、静默必须留痕、秘密只待一个地方、被否决的路线表 |

> 文档与代码的对账是机检的（`test/load.js` 的 K 段）：文档里出现的工具名/配置键/状态档/action 都必须真实存在，反向也要都在；文档不得夹带维护者本机路径。**新增功能或改配置项而忘了改文档，闸会红。**
## 它解决什么问题

多数人不是"没有笔记"，而是**笔记查不回自己身上**：写过的决定、踩过的坑、聊过的口径，散在一堆 md 里，下次遇到同类问题时一个都亮不出来。

MemoryOS 的做法不是再给你一个数据库，而是三件事咬合：

| 环节 | 干什么 | 面板上叫什么 |
|---|---|---|
| **建立** | 扫描记忆根 → 生成四层账本骨架（约束／索引／条目正文／系统总图），并把"为检索而设计"的格式契约写进模板 | 记忆面·建立 |
| **使用** | 每回合把与当前这句话匹配的资料亮给模型——**2026-10-02 起摘除**（它是每回合固定计费点、输入要人维护，而词法检索＋零命中正文兜底已覆盖大多数场景；理由与优化清单＝`docs/JUDGMENTS.md` §5.5）；**「词→文件/行」的本地指针图已上线**：`memoryos_graph` 建图／light／check，零计费；**提交前归档闸**（`action='archive-check'`）检查"本次新增有没有人引用、回指条目号悬不悬空" | 记忆面·使用 |
| **维护** | 周期性重建图 + 跑体检，盲区（悬空指针、查不到的词）自动变成**候选**，等人确认才落表 | 记忆面·维护 + 个性化 |

设计全文（三层拆分：机制层可打包／内容层禁打包／自举层要自己长）见 `docs/`。

> **除了"资料在哪"，还有"事情本身"**：上表三件事管的是 **md 记忆**（人写的、可逐级钻取）。另一类需求 md 答不了——"这个标的过去发生过什么、我是什么时候改的主意"——那是 **元素 × 带时间戳事件** 的结构化事实，由**元素库**承担（`memoryos_elements`：入库／导入 md／拍快照／取最新快照／时间线／快照／清单／标失效／导出 md；内核随包发，**无 API Key 也能用规则层**）。**为什么不让一个机制全包**＝[`docs/JUDGMENTS.md`](docs/JUDGMENTS.md) §5.9。

> **钱与隐私**：元素库**当前零 LLM 调用、零 Key 需求**（抽取走规则层：时间解析＋元素线索；`ingest` 返回里的 `llm:false` 就是证据）。设计上另有一条 Jev 快判通道与一条 LLM 通道（各自的 Key、各自可关），要接 LLM 抽取请看 [`docs/JUDGMENTS.md`](docs/JUDGMENTS.md) §5.9.5（建议做成**默认关的显式开关**）。

## 两类功能，两种控制形态（本项目的主要设计判断）

不是所有功能都适合"一个开关"：

- **一键可切**（面板标 `仅用户可切` / `双方可切`）→ 给开关，点一下就写一行账，**热生效不重启**。
- **配置型**（面板标 `由模型执行`）→ "打开"其实是一串动作。例：Jev 语义引擎 = ① Key 到位 → ② 真发一次请求测通 → ③ 才允许置为生效。
  这类**面板不给开关，只给状态**（`待配置 / 降级 / 不可用 / 生效中`）+ 待办步骤清单（还差哪一步、这一步该谁做），操作由模型执行；你随时可以点「接管」把它锁成自己说了算（模型再动会被当场拒绝，拒绝理由原样回给模型）。

> 为什么这么设计：把没测通的功能显示成"生效中"是**骗人**——它会每回合白烧账却什么也没干。所以状态一律**现算**（账本最新行 > profile 默认 > 出厂默认，再叠依赖探针与前置步骤），面板不落缓存。

## 秘密（API Key）放哪

**首选宿主凭据面**：`~/.dsh/.credentials.yaml`，ref 名 `JEV_API_KEY`。它满足三条硬要求：

1. **不在任何 git 工作树里** —— 不存在"忘了 ignore 就推上 GitHub"这条路；
2. **不随 app 升级被覆盖** —— 升级替换的是安装目录与 profile 组合，这里是用户数据；
3. 宿主提供方以 **0600 + 原子替换 + 文件锁** 写它，且有 `describe()` 可以只问"配了没有、从哪来、能不能写"而**不必读出明文**。

读序：凭据面 → `env JEV_API_KEY/TYPESAFE_API_KEY` → `config.keyFile` → 插件数据目录 → （可选）`legacyKeyFiles` 兼容旧位置。
写序：能走凭据面就走；退到文件时，**目标若落在某个 `.git` 工作树内会被直接拒绝**（除非 profile 里显式 `allowKeyInRepo: true`）。明文 Key 永不进快照、账本、日志或工具返回值——那些地方只出现掩码。

## 安装（DSH Desktop / dsh CLI）

```bash
# 方式一：插件管理器（推荐，会跑装载预检）
#   DSH 里执行 plugin_manager install_bundle，target 指向本仓绝对路径

# 方式二：手工挂进 profile
cd ~/.dsh/profiles/<你的 profile>      # Windows: %USERPROFILE%\.dsh\profiles\desktop
pnpm add link:<本仓路径>
# 然后把包名加进 package.json 的 "dsh.profile.bundles" 数组
```

改 `profile` 的 `cordis.patch.yml` 那层配置（`dataDir` / `memoryRoot` / `llmCanSwitch` / `defaults.*` 等），**然后重启 DSH**——插件不能自己重启自己。

装载判据只有一条：宿主工具表里出现 `memoryos_status` / `memoryos_switch` / `memoryos_setup`（日志说装载了不算）。

## 加一个功能＝改一处

`lib/features.js` 的 `FEATURES` 里加一行：

```js
{
  id: 'mine', label: '候选生成', what: '从真实过程挖候选资料表行',
  controller: 'llm',          // 'user' | 'llm' | 'both'
  default: true, cost: '零账（词法为主）；产出只是候选',
  deps: ['memory-root'],      // 环境事实：缺了会 unavailable / degraded
  steps: ['graph-built'],     // 动作型前置：没做完就是 waiting（待配置）
  impl: 'live',               // 'todo' ⇒ 面板灰显、不给任何按钮
  group: '记忆面·个性化',
}
```

`DEPS` 的每一项必须在 `lib/probes.js` 有探针、`STEPS` 的每一项必须有步骤探针——**闸会双向对账**（漏一处的症状是"面板永远显示探针未实现"，比报错难查）。

## 跑闸（零依赖、零联网）

```bash
node test/load.js          # JS 组（或：ELECTRON_RUN_AS_NODE=1 <DSH 二进制> test/load.js）
python python/tests/test_kernel_smoke.py   # Python 组：元素库内核冒烟（init/ingest/import/timeline/snapshot/save/context/expire/status）
```

断言条数看输出末行（只增不减，写死在文档里就成了漂移源）。覆盖：登记表自洽 / 探针同源 / 写侧权限矩阵 / 状态派生真值表 / 宿主接线端到端（含配置动作全生命周期）/ 明文 Key 不外泄 / 资料面与指针图 / **归档闸（文件头契约、非 ASCII 路径解转义、真 git 仓端到端）** / 面板装载契约四条 + 前后端路由对账 + 文档与代码对账 + 样式与语法静态禁手。

## 目录

```
index.js          宿主半：快照、唯一写入口、配置动作、六个工具、面板数据面挂载
client.js         浏览器半：设置 → 记忆系统 控制面板（手写 ModuleLoader，零构建链）
lib/features.js   功能登记表（唯一权威：显示什么、谁能操作、缺什么算不算生效）
lib/switches.js   开关账本（append-only）+ 写侧权限 + 状态派生
lib/surface.js    资料面：目录并集、排除匹配（子目录／单文件／glob）、扫描计数、试算
lib/graph.js      指针图：build（扫 .md → graph.json）／light（两级解析＋BFS＋**零命中域内正文兜底**）／check（盲区清单）
lib/archive.js    归档闸：提交前检查本次未提交的新增（没人引用／回指悬空／新条目没人回指），只报事实不改文件
lib/setup.js      配置账本 + Jev 测通（node:https，可注入 transport 以便离线测试）
lib/probes.js     依赖探针 / 步骤探针（纯本地 fs/env，5 秒缓存）
lib/keystore.js   Key 落点：凭据面优先 + git 工作树守卫 + 掩码
lib/api.js        面板 HTTP 面（ctx.inject(['webServer']) 延迟挂载 + JSON 404 兜底）
lib/kernel.js     元素库内核的 JS 壳（找 python → spawn `-m memoryos_kernel` → JSON；可注入 kernelCall）
test/load.js      上面那个闸（JS 组）
python/memoryos_kernel/  元素-时间线内核（随包发；纯标准库；剥离台账面）
python/tests/test_kernel_smoke.py  Python 组闸（内核冒烟 16 条）
```

## 许可

MIT。
