/**
 * MemoryOS · 首次建档（scaffold）—— **安装的一部分，不是功能**（2026-10-03 用户定）。
 *
 * 两段式，**永远先 dry-run**：
 *   ① `scaffoldPlan(cfg, folded, graph, checkOut)` → `{ report, summary, files[] }`
 *      报告＝"扫了什么／抽到什么／盲区／建议先补的三条／中枢该指谁／下一步"；
 *      files ＝四份骨架草稿（`MEMORY.md / -INDEX / -ENTRIES / -MAP`）的**完整文本**（含 marker 块）。
 *   ② `scaffoldApply(cfg, plan)` → 落盘：**只写自己认领的 marker 块**
 *       · 文件不存在 ⇒ 新建（带头部说明）；
 *       · 有 marker ⇒ 只替换块内内容（幂等，重复跑安全）；
 *       · **存在但没有 marker ⇒ 拒绝该文件**（那是用户自己的文档，绝不覆盖）并如实报出来。
 *
 * 纪律：不联网、不调 LLM、不起进程；一次最多 4 份文件；四份骨架**不是**资料本身，只是"指路 + 清单"。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const SKELETON_NAMES = ['MEMORY.md', 'MEMORY-INDEX.md', 'MEMORY-ENTRIES.md', 'MEMORY-MAP.md']
const CAP_LIST = 40            // 每份骨架里最多列多少条（超出只报计数，不灌爆）
const TAG = 'MEMORYOS'

const markBegin = (sec) => `<!-- ${TAG}:BEGIN ${sec} -->`
const markEnd = (sec) => `<!-- ${TAG}:END ${sec} -->`

/** 取/替换 marker 块。返回 `{ action: 'create'|'merge'|'refuse', text, why? }`。 */
export function mergeBlock(existing, sec, body) {
  const begin = markBegin(sec)
  const end = markEnd(sec)
  if (existing == null) return { action: 'create', text: body.trimEnd() + '\n' }
  const i = existing.indexOf(begin)
  const j = existing.indexOf(end)
  if (i < 0 || j < 0 || j < i) {
    return { action: 'refuse', text: existing, why: '这份文件里没有本工具认领的 marker 块（它可能是你自己写的正文），跳过不覆盖' }
  }
  const text = existing.slice(0, i + begin.length) + '\n' + body.trimEnd() + '\n' + existing.slice(j)
  return { action: 'merge', text }
}

const line1 = (text) => {
  const m = /^\s*#\s+(.+)$/m.exec(String(text || ''))
  return m ? m[1].trim().slice(0, 60) : ''
}

/** 按目录把文件分组（给 INDEX 用）。 */
function groupByDir(files) {
  const m = new Map()
  for (const f of files) {
    const rel = String(f.rel || f.name || '')
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.'
    if (!m.has(dir)) m.set(dir, [])
    m.get(dir).push(f)
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

/**
 * 生成建档计划。`graph` 可空（内部不建图，由调用方保证"要报告就得有图"）。
 * `checkOut` ＝ `graphCheck()` 的返回（盲区来源）。
 */
export function scaffoldPlan(cfg, folded, graph, checkOut) {
  const nodes = (graph && graph.nodes) || []
  const edges = (graph && graph.edges) || []
  const files = nodes.filter((n) => n.kind === 'file')
  const entries = nodes.filter((n) => n.kind === 'entry')
  const hubs = files.filter((n) => n.docRole === 'hub')
  const withTrigger = entries.filter((n) => (n.triggers || []).length)
  const refEdges = edges.filter((e) => e.kind === 'reference')
  const counts = (checkOut && checkOut.counts) || {}

  // 读每份文件的正文头一行（标题）——只为 INDEX 里能写一句"这是什么"；有界（≤ CAP_LIST 份）
  const titles = new Map()
  for (const f of files.slice(0, CAP_LIST * 2)) {
    try {
      const head = readFileSync(f.path, 'utf8').slice(0, 4096)
      titles.set(f.key, line1(head))
    } catch { /* 读不到就不写标题 */ }
  }
  // 条目按"没触发行"排序：缺触发行的先列（它们正是最该补的）
  // **只认三级及以下标题**（与 `check` 的"缺触发行"同判据）：H1/H2 是文件标题与分节，不该逼人写触发行。
  const realEntries = entries.filter((n) => (n.level || 0) >= 3)
  const entriesSorted = [...realEntries].sort((a, b) => ((a.triggers || []).length - (b.triggers || []).length) || String(a.path).localeCompare(String(b.path)))
  // 建议先补的三条：优先"没触发行"的条目；没有就取孤儿；再没有就取被引用最多的文件
  const refCount = new Map()
  for (const e of refEdges) refCount.set(e.to, (refCount.get(e.to) || 0) + 1)
  const suggestions = []
  for (const n of entriesSorted.filter((x) => !(x.triggers || []).length).slice(0, 3)) {
    suggestions.push({ kind: 'trigger', label: `给 \`${basename(String(n.path))}\` 的条目「${String(n.name).slice(0, 30)}」补一行触发行`, path: n.path, line: n.line })
  }
  for (const o of ((checkOut && checkOut.orphanEntries) || []).filter((x) => (x.level || 0) >= 3).slice(0, 3 - suggestions.length)) {
    suggestions.push({ kind: 'orphan', label: `条目「${String(o.name).slice(0, 30)}」写了没人指（加一条回指或挂进中枢）`, path: o.path, line: o.line })
  }
  if (!suggestions.length) {
    for (const [k, c] of [...refCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      const n = nodes.find((x) => x.key === k)
      if (n) suggestions.push({ kind: 'hub', label: `\`${basename(String(n.path || n.name))}\` 被引用 ${c} 次 ⇒ 值得挂进中枢档`, path: n.path })
    }
  }
  const hubCandidates = files
    .map((f) => ({ f, c: refCount.get(f.key) || 0 }))
    .sort((a, b) => b.c - a.c).slice(0, 5)
    .map(({ f, c }) => ({ name: f.name, path: f.path, refs: c }))

  const summary = {
    managed: files.length, entries: entries.length, triggers: withTrigger.length,
    hubs: hubs.length, refEdges: refEdges.length,
    realEntries: realEntries.length, realEntriesNoTrigger: realEntries.filter((n) => !(n.triggers || []).length).length,
    noTrigger: counts.noTrigger || 0, orphan: counts.orphan || 0,
    unresolved: counts.unresolved || ((graph && graph.unresolved) || []).length || 0,
    suggestions,
  }

  // ---------------- 报告（对话里直接念；也进 dry-run 输出） ----------------
  const L = []
  L.push(`## 建档扫描（${files.length} 份 .md｜${entries.length} 个条目｜${refEdges.length} 条指针）`)
  L.push('')
  L.push(`- **扫了什么**：纳管 ${files.length} 份 .md；其中 ${hubs.length} 份自己声明了中枢${hubs.length ? `（${hubs.slice(0, 3).map((h) => basename(String(h.path))).join('、')}）` : '（**一份都没有** → 建议先立一份）'}`)
  L.push(`- **抽到什么**：${entries.length} 个标题节点，其中**真条目**（三级及以下标题）${realEntries.length} 个：${realEntries.length - summary.realEntriesNoTrigger} 个有触发行、**${summary.realEntriesNoTrigger} 个没有**；指针 ${refEdges.length} 条`)
  L.push(`- **盲区**：缺触发行 ${counts.noTrigger || 0}｜孤儿条目 ${counts.orphan || 0}｜重复条目号 ${counts.dupCode || 0}｜未解析引用 ${summary.unresolved}｜图过期 ${counts.changed || 0}`)
  if (suggestions.length) {
    L.push(`- **建议先补的三条**：`)
    for (const s of suggestions) L.push(`  ${suggestions.indexOf(s) + 1}. ${s.label}${s.path ? `（\`${s.path}\`${s.line ? ':' + s.line : ''}）` : ''}`)
  } else {
    L.push('- **建议先补的三条**：（这次没有明显盲区，可以先用起来）')
  }
  if (hubCandidates.length) {
    L.push(`- **中枢该指谁**：${hubCandidates.map((h) => `\`${basename(String(h.path))}\`×${h.refs}`).join('、')}`)
  }
  L.push('- **下一步**：① 查词走 `memoryos_graph(action=light, query=…)`；② 写完资料重建一次图（`build`）；③ 提交前跑 `archive-check`')
  const report = L.join('\n')

  // ---------------- 四份骨架草稿 ----------------
  const idxLines = []
  const rootPath = String((typeof cfg.rootsOf === 'function' ? cfg.rootsOf() : cfg.memoryRoots || [])[0] || '').replace(/\\/g, '/')
  const relOf = (p) => {
    const s = String(p || '').replace(/\\/g, '/')
    return rootPath && s.toLowerCase().startsWith(rootPath.toLowerCase() + '/') ? s.slice(rootPath.length + 1) : s
  }
  for (const [dir, fs] of groupByDir(files.map((f) => ({ rel: relOf(f.path), path: f.path, key: f.key })))) {
    idxLines.push(`### ${dir}`)
    for (const f of fs.slice(0, CAP_LIST)) {
      const t = titles.get(f.key)
      idxLines.push(`- [${basename(String(f.path))}](${f.rel})${t ? ` — ${t}` : ''}`)
    }
    if (fs.length > CAP_LIST) idxLines.push(`- …另 ${fs.length - CAP_LIST} 份（共 ${fs.length}）`)
    idxLines.push('')
  }
  const entLines = entriesSorted.slice(0, CAP_LIST * 2).map((n) => `- \`${n.code || '—'}\` ${String(n.name).slice(0, 50)} — \`${relOf(n.path)}\`${n.line ? ':' + n.line : ''}`)
  if (realEntries.length > entLines.length) entLines.push(`- …另 ${realEntries.length - entLines.length} 个条目`)
  const mapLines = []
  for (const f of files.slice(0, CAP_LIST)) {
    const outs = edges.filter((e) => e.from === f.key && e.kind === 'reference').map((e) => {
      const t = nodes.find((x) => x.key === e.to)
      return t ? `${relOf(t.path || t.name)}` : '?'
    })
    if (outs.length) mapLines.push(`- \`${relOf(f.path)}\` → ${[...new Set(outs)].slice(0, 8).join('、')}`)
  }
  if (files.length > CAP_LIST) mapLines.push(`- …另 ${files.length - CAP_LIST} 份文件未列`)

  const filesOut = [
    {
      name: SKELETON_NAMES[0], sec: 'summary',
      header: `# MEMORY\n\n> 档位：中枢 ｜ 本档由 MemoryOS 建档向导生成（${new Date().toISOString().slice(0, 10)}）\n> 它是**目录档**：先读这里，再按下面的指针去读正文。正文仍以各 .md 为准。\n`,
      body: [`## 这是什么`, `这里是本机 md 记忆库的入口。共纳管 ${files.length} 份 .md、${entries.length} 个条目。`, '',
        `- 主题索引：[MEMORY-INDEX.md](MEMORY-INDEX.md)`, `- 条目清单：[MEMORY-ENTRIES.md](MEMORY-ENTRIES.md)`,
        `- 指针关系：[MEMORY-MAP.md](MEMORY-MAP.md)`, '', report].join('\n'),
    },
    {
      name: SKELETON_NAMES[1], sec: 'index',
      header: `# MEMORY-INDEX — 主题索引\n\n> 档位：中枢 ｜ 由建档向导生成；按目录列出纳管资料。\n`,
      body: idxLines.join('\n') || '（纳管范围内还没有 .md）',
    },
    {
      name: SKELETON_NAMES[2], sec: 'entries',
      header: `# MEMORY-ENTRIES — 条目清单\n\n> 档位：中枢 ｜ 由建档向导生成；缺触发行**排在前面**（它们最该补）。\n`,
      body: entLines.join('\n') || '（还没抽到条目：条目＝三级及以下标题，标题里带编号更佳）',
    },
    {
      name: SKELETON_NAMES[3], sec: 'map',
      header: `# MEMORY-MAP — 指针关系（文字版）\n\n> 档位：中枢 ｜ 由建档向导生成；「谁指谁」的粗粒度清单。权威版本在指针图里。\n`,
      body: mapLines.join('\n') || '（还没有跨文件的指针）',
    },
  ].map((f) => {
    const full = `${f.header}\n${markBegin(f.sec)}\n${f.body.trimEnd()}\n${markEnd(f.sec)}\n`
    return { name: f.name, sec: f.sec, header: f.header, body: f.body, full }
  })

  return { report, summary, files: filesOut }
}

/** 落盘：每份文件先看它有没有 marker（决定 create/merge/refuse）。返回明细供报告。 */
export function scaffoldApply(cfg, plan) {
  const root = (typeof cfg.rootsOf === 'function' ? cfg.rootsOf() : cfg.memoryRoots || [])[0]
  if (!root) return { ok: false, message: '还没有记忆根：先在面板「资料面」纳入一个目录', written: [], skipped: [] }
  const written = []
  const skipped = []
  for (const f of plan.files) {
    const target = join(root, f.name)
    let existing = null
    try { if (existsSync(target)) existing = readFileSync(target, 'utf8') } catch { existing = null }
    const merged = mergeBlock(existing, f.sec, f.body)
    if (merged.action === 'refuse') { skipped.push({ name: f.name, why: merged.why }); continue }
    try {
      writeFileSync(target, merged.action === 'create' ? f.full : merged.text, 'utf8')
      written.push({ name: f.name, action: merged.action })
    } catch (e) {
      skipped.push({ name: f.name, why: `写失败：${String((e && e.message) || e).slice(0, 80)}` })
    }
  }
  return { ok: written.length > 0, root, written, skipped }
}
