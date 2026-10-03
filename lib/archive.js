/**
 * MemoryOS · 归档闸（提交前的"我是不是忘了登记"检查）
 *
 * 一句话：**准备 git commit 前跑一次**——只看"本次未提交的新增"里，新档有没有人引用、文件头回指的条目号
 * 是不是悬空、本轮新条目有没有人回指。**只报事实（warn/info）、绝不改任何文件、不挡提交**：
 * 补不补指针由模型/人判断（这是设计目标，不是错误处理细节）。
 *
 * 为什么要有这一闸：归档纪律里"写完要登记进索引""专档要回指条目号"这些**只能靠人记**的事，
 * 漏了**不报错**——新档照样在盘上，图里却没有任何边指向它，`light` 永远查不到它。
 * 静默失灵比报错难查，所以把它变成提交前一次可见的检查。
 *
 * 三条判据（与内核 `ledger archive-check` 同口径）：
 *   R1 新增档**没有任何别的 .md 引用它**（＝没登记进任何索引）→ warn；有引用但来源不是中枢档 → info。
 *   R2 文件头 `指针条目=AAx` **悬空**（图里没有这个条目号）→ warn（写错号原先完全静默）。
 *   R3 本轮新条目（从 `git diff` 新增行认 `+### AAx`）**没人引用/回指** → info；压根没进图 → warn（标题格式不对）。
 *
 * 不管（并如实计数，不静默跳过）：域外文件、被资料面排除的文件、mirror 快照（`snapshot-`/`_snap_`）、
 * **自己声明了中枢**的新档（`> 档位：中枢`——它本身就是索引，不需要别人登记它）、已提交的东西（那不是"本次"）。
 *
 * 豁免（留给模型/人的逃生口）：文件头写 `> 归档：免索引（理由）` ⇒ 跳过判定，
 * 但**在输出末尾列进「豁免清单」**——豁免必须可见，不许静默跳过。
 *
 * 全库结构体检（悬空指针/孤儿/副本/图水位）不在这里，走 `memoryos_graph(action='check')`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { effectiveRoots, excluded } from './surface.js'
import { build as buildGraph, load as loadGraph, status as graphStatus, docRoleFromText, HEAD_SCAN_LINES as GRAPH_HEAD_SCAN_LINES } from './graph.js'

/** 文件头契约只看前几行：档位/回指/豁免都在开头，往下扫会误伤正文（实测散文里也出现"档位"字样）。 */
export const HEAD_SCAN_LINES = GRAPH_HEAD_SCAN_LINES   // 与 lib/graph.js 同源（一处改、两处生效）
const MIRROR_PATTERN = /(^snapshot-|_snap_|\/snapshots\/)/
const ARCHIVE_EXEMPT_LINE = /^\s*>\s*\**\s*归档\**\s*[:：]\s*(.+)$/
const ARCHIVE_PTR_LINE = /指针条目\s*[=＝]\s*([A-Za-z]{0,3}\d{1,3})/g
/** 本轮新增条目的标题形状：`+### AA9 <标题>`（编号后必须有一个空格，半角或全角）。
 *  编号形状与建图侧的 `codeOf` **同源**（1~4 个大写字母＋1~4 位数字：AA17／BB4／C23）——
 *  两处不一致的后果是"闸说没进图、图里其实有"（或反之），比不查更误导。 */
const ENTRY_NEW_LINE = /^\+\s*#{2,4}\s+([A-Z]{1,4}\d{1,4})[ 　]/

const norm = (p) => String(p || '').replace(/\\/g, '/')
const keyOf = (p) => norm(p).replace(/\/+$/, '').toLowerCase()

/* ─────────────────────────────────────────── git（纯解析，闸直测） */

export function gitBin() {
  return process.env.MEMORYOS_GIT || 'git'
}

/** 跑一次 git（失败回空串＝**fail-open**：闸坏掉不许挡归档）。 */
function runGit(repo, args, timeoutMs = 25000) {
  try {
    return execFileSync(gitBin(), ['-C', repo, ...args], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
      maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }) || ''
  } catch (e) {
    return e && e.stdout != null ? String(e.stdout) : ''
  }
}

/**
 * git 的路径字段 → 真路径。**踩过的坑**：git 默认把非 ASCII 路径转义成 `\345\275\222` 式并用引号包住
 * ⇒ 直接拿去查文件系统永远 False（症状＝"本次新增 1 份、待查 0"的静默空转）。
 * 两道保险：调用方加 `-c core.quotepath=false`；这里再解一次转义（老库/被配置强制时兜底）。
 */
export function unquotePath(raw) {
  let s = String(raw || '').trim()
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  if (!s.includes('\\')) return norm(s)
  const out = []
  let bytes = []
  const flush = () => { if (bytes.length) { out.push(Buffer.from(bytes).toString('utf8')); bytes = [] } }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== '\\') { flush(); out.push(ch); continue }
    const nxt = s[i + 1]
    if (nxt >= '0' && nxt <= '7') { bytes.push(parseInt(s.substr(i + 1, 3), 8)); i += 3; continue }
    flush()
    if (nxt === 'n') { out.push('\n'); i++ } else if (nxt === 't') { out.push('\t'); i++ } else if (nxt === '"' || nxt === '\\') { out.push(nxt); i++ } else out.push(ch)
  }
  flush()
  return norm(out.join(''))
}

/** `git status --porcelain` → `[{code, path}]`（重命名取**新名**）。 */
export function parseStatus(text) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (raw.length < 4) continue
    const code = raw.slice(0, 2)
    let rest = raw.slice(3).trim()
    if (rest.includes(' -> ')) rest = rest.split(' -> ').pop().trim()
    out.push({ code, path: unquotePath(rest) })
  }
  return out
}

/** 新增判定：未跟踪 `??`／已暂存新增 `A`／重命名 `R`（`M`/`D` 不算"新增"）。 */
export function isNew(code) {
  const c = String(code || '')
  return c.includes('?') || c.includes('A') || c.includes('R')
}

/** 目录所属的 git 工作树根（含 worktree 的 `.git` 文件情形）；不在仓里回空串。 */
export function repoRootOf(dir) {
  let cur = resolve(dir)
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(cur, '.git'))) return cur
    const up = dirname(cur)
    if (up === cur) return ''
    cur = up
  }
  return ''
}

/**
 * 要查哪些仓：`config.archiveRepos`（显式）＋**生效记忆根各自所属的仓**（自动）。
 * 共享包的默认必须自动——同事不会记得去配一个"归档闸看哪个仓"的键。
 */
export function collectRepos(cfg, roots) {
  const out = []
  const push = (p) => { if (p && !out.some((x) => keyOf(x) === keyOf(p))) out.push(norm(p)) }
  for (const r of cfg.archiveRepos || []) push(repoRootOf(r) || r)
  for (const r of roots || []) push(repoRootOf(r))
  return out
}

/** 收集"本次"＝各仓未提交改动：`new`（新增文件绝对路径）／`changed`（全部改动）／`gitOk`。 */
export function collect(repos) {
  const newFiles = []
  const changed = []
  let gitOk = false
  for (const repo of repos || []) {
    const st = runGit(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain'])
    if (!st.trim() && !runGit(repo, ['rev-parse', '--is-inside-work-tree']).trim()) continue
    gitOk = true
    for (const row of parseStatus(st)) {
      const abs = resolve(repo, row.path)
      changed.push(abs)
      if (isNew(row.code)) newFiles.push(abs)
    }
  }
  const uniq = (a) => [...new Set(a.map((p) => norm(resolve(p))))]
  return { new: uniq(newFiles), changed: uniq(changed), gitOk, repos: [...(repos || [])] }
}

/** 本轮新增的条目号：看未提交 diff 的**新增行**里 `+### AAx …`（工作区＋暂存区）。返回 Map(id → 文件)。 */
export function newEntries(changed, repos) {
  const out = new Map()
  for (const repo of repos || []) {
    const rp = keyOf(resolve(repo))
    const mine = (changed || []).filter((p) => keyOf(resolve(p)).startsWith(rp + '/'))
    if (!mine.length) continue
    for (const p of mine) {
      const rel = relative(repo, p).replace(/\\/g, '/')
      for (const args of [['diff', '--unified=0', '--', rel], ['diff', '--cached', '--unified=0', '--', rel]]) {
        for (const ln of runGit(repo, args).split(/\r?\n/)) {
          const m = ENTRY_NEW_LINE.exec(ln)
          if (m && !out.has(m[1])) out.set(m[1], p)
        }
      }
    }
  }
  return out
}

/* ─────────────────────────────────────────── 文件头契约（纯函数，闸直测） */

export function headLines(path, n = HEAD_SCAN_LINES) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).slice(0, n)
  } catch { return [] }
}

const headText = (head) => (Array.isArray(head) ? head.join('\n') : String(head || ''))

/**
 * 文件开头的档位声明 → `{role, raw}`。认行首引用块（避免误伤散文）：
 *   `> 档位：叶子 ｜ 指针条目=AA4` → leaf；`> **档位**: hub` → hub。
 * 未声明 ⇒ `leaf`（默认，漏了只是少跳一层）；**值不认识 ⇒ 回 leaf 并把原值带出去**（让体检能报，而不是静默当没写）。
 */
export function docRoleOf(head) {
  return docRoleFromText(headText(head))   // 判据在 lib/graph.js（与建图同源）；这里只负责"head 可能是路径或行数组"
}

/** 文件头 `> 归档：免索引（理由）` → 理由原文；没写回空串。必须可见——豁免要列出来，不许静默跳过。 */
export function exemptReason(head) {
  for (const ln of headText(head).split('\n')) {
    const m = ARCHIVE_EXEMPT_LINE.exec(ln)
    if (!m) continue
    const val = m[1].trim()
    if (/免索引|免登记|exempt/i.test(val)) return val
  }
  return ''
}

/** 文件头 `指针条目=AAx` 里，图里**不存在**的那些（纯函数）。 */
export function danglingRefs(head, entryIds) {
  const ids = entryIds instanceof Set ? entryIds : new Set(entryIds || [])
  const upper = new Set([...ids].map((x) => String(x).toUpperCase()))
  const out = []
  const text = headText(head)
  ARCHIVE_PTR_LINE.lastIndex = 0
  let m
  while ((m = ARCHIVE_PTR_LINE.exec(text))) {
    const tok = m[1].trim()
    if (tok && !upper.has(tok.toUpperCase()) && !out.includes(tok)) out.push(tok)
  }
  return out
}

/* ─────────────────────────────────────────── 闸本体 */

const finding = (severity, subject, detail, hint) => ({ rule: 'archive_gate', severity, subject, detail, hint })

function underRoot(p, roots) {
  const k = keyOf(p)
  return roots.some((r) => { const rk = keyOf(r); return k === rk || k.startsWith(rk + '/') })
}

/**
 * 跑三条判据。`graph`＝刷新后的图；`files`＝待查的**新增**文件（绝对路径）；
 * `entriesNew`＝本轮新条目 Map；`roots`＝生效记忆根（域外跳过）；`folded`＝资料面（排除跳过）。
 */
export function check(g, files, entriesNew, opts = {}) {
  const roots = (opts.roots || []).map((r) => norm(resolve(r)))
  const folds = (opts.folded && opts.folded.excludes) || []
  const nodes = (g && Array.isArray(g.nodes) && g.nodes) || []
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const entryByCode = new Map()
  for (const n of nodes) if (n.kind === 'entry' && n.code) entryByCode.set(String(n.code).toUpperCase(), n)
  const entryCodes = new Set([...entryByCode.keys()])

  // 入边按"来源属于哪份文件"归并——契约口径是"被任何别的 .md 引用过"，不是"必须是 file→file 边"
  // （引用可能挂在条目标题上，也可能挂在文件上；对"有没有人登记它"这件事，两者等价）。
  const inbound = new Map()
  for (const e of (g && g.edges) || []) {
    if (e.kind === 'structural') continue          // 结构边（contains/titled）不是"有人引用它"
    const to = byKey.get(e.to)
    if (!to || to.kind !== 'file') continue
    const from = byKey.get(e.from)
    const src = (from && from.path) || ''
    if (!src || keyOf(src) === keyOf(to.path)) continue
    if (!inbound.has(e.to)) inbound.set(e.to, new Map())
    const m = inbound.get(e.to)
    m.set(src, (m.get(src) || 0) + 1)
  }

  const roleCache = new Map()
  const roleOf = (p) => {
    const k = keyOf(p)
    if (!roleCache.has(k)) roleCache.set(k, docRoleOf(headLines(p)).role)
    return roleCache.get(k)
  }
  const repos = (opts.repos || []).map((r) => resolve(r))
  const relName = (p) => {
    const k = keyOf(p)
    for (const r of repos) { const rk = keyOf(r); if (k.startsWith(rk + '/')) return norm(relative(r, p)) }
    return basename(p)
  }

  const res = { findings: [], exempt: [], skippedDomain: [], skippedMirror: [], skippedExcluded: [], hubNew: [], checked: [] }
  for (const raw of files || []) {
    const p = resolve(raw)
    if (!/\.md$/i.test(p) || !existsSync(p)) continue
    if (roots.length && !underRoot(p, roots)) { res.skippedDomain.push(p); continue }
    const root = roots.find((r) => underRoot(p, [r]))
    if (root && folds.length) {
      const rel = norm(relative(root, p))
      let hit = false
      try { hit = !!excluded(rel, norm(p), folds) } catch { hit = false }
      if (hit) { res.skippedExcluded.push(p); continue }
    }
    if (MIRROR_PATTERN.test(basename(p))) { res.skippedMirror.push(p); continue }
    const head = headLines(p)
    const why = exemptReason(head)
    if (why) { res.exempt.push({ path: p, why }); continue }
    res.checked.push(p)
    const fileKey = 'file:' + norm(p)
    if (docRoleOf(head).role === 'hub') res.hubNew.push(p)   // 新中枢：它本身就是索引，不要求被人登记
    else {
      const m = inbound.get(fileKey)
      if (!m || !m.size) {
        res.findings.push(finding('warn', relName(p),
          '新增档**没有任何 .md 引用它**（＝没登记进任何索引）',
          '在人读索引里加一行（标准 Markdown 链接即可），或文件头写 `> 归档：免索引（理由）`'))
      } else if (![...m.keys()].some((s) => roleOf(s) === 'hub')) {
        res.findings.push(finding('info', relName(p),
          `已登记，但引用来**不是中枢档文件**（${m.size} 处）`,
          '若是专档，建议由某条条目/索引文件（文件头 `> 档位：中枢`）回指它'))
      }
    }
    for (const tok of danglingRefs(head, entryCodes)) {
      res.findings.push(finding('warn', relName(p) + ':头',
        `回指 \`指针条目=${tok}\` **悬空**：图里没有这个条目`,
        '补建条目，或改正条目号（写错号原先完全静默，谁也看不见）'))
    }
  }
  for (const [eid, src] of entriesNew || []) {
    const n = entryByCode.get(String(eid).toUpperCase())
    if (!n) {
      res.findings.push(finding('warn', `条目 ${eid}`,
        `本轮新增的条目标题（\`${basename(src)}\`）**没进图**：检查标题格式 \`### ${eid} 标题\``,
        '标题必须独占一行、编号后有一个空格（半角或全角）'))
      continue
    }
    // 只看**引用边**：条目自带"文件包含它"的结构边（contains），拿它当"有人引用"会永远判成已登记
    if (!((g && g.edges) || []).some((e) => e.to === n.key && e.kind !== 'structural')) {
      res.findings.push(finding('info', `条目 ${eid}`,
        '新条目**没有任何文件引用/回指它**',
        `若某专档是它的细节，在专档首行写 \`> 档位：叶子 ｜ 指针条目=${eid}\``))
    }
  }
  return res
}

/* ─────────────────────────────────────────── 输出 */

export function render(res, note = '', newFiles = []) {
  const f = res.findings || []
  const warn = f.filter((x) => x.severity === 'warn')
  const nw = (res.checked || []).length + (res.exempt || []).length
  const L = [
    `# 归档闸 · 提交前检查（${new Date().toISOString().replace('T', ' ').slice(0, 19)}）`,
    '',
    `- 本次未提交的新增 .md：**${(newFiles || []).length}** 份（域内待查 ${nw}：合格 ${(res.checked || []).length}`
    + `／豁免 ${(res.exempt || []).length}）｜新中枢 ${(res.hubNew || []).length}`
    + `｜域外跳过 ${(res.skippedDomain || []).length}｜被排除跳过 ${(res.skippedExcluded || []).length}`
    + `｜快照跳过 ${(res.skippedMirror || []).length}`,
    `- 结论：${!f.length ? '✓ **没发现缺口**（新增档都有引用、回指都能落地）' : `⚠️ **${warn.length} 条 warn / ${f.length - warn.length} 条 info 待判断**`}`,
  ]
  if (f.length) {
    L.push('', '| 级别 | 对象 | 详情 | 建议 |', '|---|---|---|---|')
    const order = { error: 0, warn: 1, info: 2 }
    for (const x of [...f].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.subject.localeCompare(b.subject))) {
      L.push(`| ${x.severity} | \`${x.subject}\` | ${x.detail} | ${x.hint} |`)
    }
  }
  if ((res.exempt || []).length) {
    L.push('', '- **豁免清单**（可见，不静默）：' + res.exempt.map((x) => `\`${x.path}\`（${x.why}）`).join('、'))
  }
  L.push('')
  L.push('> 只报事实、**不改文件**：补不补指针由你判断；补完再 `git commit`。'
    + '全库结构体检（悬空指针/孤儿/副本/图水位）仍走 `memoryos_graph(action=\'check\')`。')
  return (note || '') + L.join('\n') + '\n'
}

/**
 * 跑一次归档闸。返回 `{ok, markdown, warns, counts, result}`。
 * - `opts.files`：调试用，只查这几份（默认从 git 自动收集"本次新增"）。
 * - `opts.noRefresh`：调试用，跳过查前重建（正常要刷新，否则新文件没入图、边查不到）。
 * - `opts.now`：测试用，注入时间无关（当前未用，保留给未来）。
 */
export function run(cfg, folded, opts = {}) {
  const roots = effectiveRoots(cfg, folded).map((r) => r.path)
  const repos = ((opts.repos && opts.repos.length) ? opts.repos : collectRepos(cfg, roots)).map((p) => resolve(p))
  let note = ''
  let files = []
  let changed = []
  let gitOk = false
  if (opts.files && opts.files.length) {
    files = opts.files.map((p) => resolve(p))
  } else if (!repos.length) {
    note = '> ⚠️ 没找到任何 git 仓（记忆根不在仓里，也没配 `archiveRepos`）⇒ 本次按**空集**处理，不硬猜。\n\n'
  } else {
    const got = collect(repos)
    gitOk = got.gitOk
    changed = got.changed
    files = got.new.filter((p) => /\.md$/i.test(p))
    if (!gitOk) note = '> ⚠️ 读不到 git 状态（没 git／不在仓里）⇒ 本次按**空集**处理，不硬猜。\n\n'
  }
  const entriesNew = opts.entriesNew || (changed.length ? newEntries(changed, repos) : new Map())

  let graph = loadGraph(cfg)
  const warnings = []
  if (!opts.noRefresh && roots.length) {
    const st = graph ? graphStatus(cfg, folded, { maxAgeHours: cfg.graphStaleHours || 24, maxFiles: cfg.graphMaxFiles }) : null
    if (!graph || (st && st.stale)) {
      const built = buildGraph(cfg, folded, { maxFiles: cfg.graphMaxFiles, maxBytes: cfg.graphMaxBytes })
      graph = built.graph
      for (const w of built.warnings || []) warnings.push(w)
    }
  }
  if (!graph) {
    const empty = emptyResult()
    return { ok: false, markdown: (note || '') + '⚠️ 图还不存在，归档闸判不了"有没有人引用"：先 `memoryos_graph(action=\'build\')`（或去掉 no_refresh）。\n', warns: 0, counts: empty.counts, result: empty }
  }
  const res = check(graph, files, entriesNew, { roots, folded, repos })
  const warns = note.startsWith('> ⚠️') ? 0 : res.findings.filter((x) => x.severity === 'warn').length
  const counts = {
    newFiles: files.length, checked: res.checked.length, exempt: res.exempt.length, hubNew: res.hubNew.length,
    skippedDomain: res.skippedDomain.length, skippedExcluded: res.skippedExcluded.length, skippedMirror: res.skippedMirror.length,
    warn: warns, info: res.findings.length - warns, graphWarnings: warnings.length,
  }
  return { ok: true, markdown: render(res, note, files), warns, counts, result: res }
}

function emptyResult() {
  return { findings: [], exempt: [], skippedDomain: [], skippedMirror: [], skippedExcluded: [], hubNew: [], checked: [], counts: {} }
}
