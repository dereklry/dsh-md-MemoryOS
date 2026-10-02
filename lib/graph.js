/**
 * MemoryOS · 指针图（建图 / 索引 / 体检）
 *
 * 一句话：**把"这堆 .md 之间谁指谁"算成一张图**，之后所有"这句该先读哪几份资料"都在这张图上走。
 *
 * 为什么是图而不是全文索引：全文检索解决"含这个词的文件"，解决不了"这个**事项**牵动哪些文件、
 * 哪一条是它的正文、哪一条只是提到过"。记忆场景要的是后者——顺着边能解释"为什么要读它"（带 reason）。
 * 只索引**名字与触发行**（标题、条目号、`[文字](路径.md)` 与反引号路径、"见 §三 AA14"式指针），
 * 正文不进图：图小、建得快（秒级）、不抄全文 ⇒ 也不会把敏感正文另存一份。
 *
 * 三条实现纪律：
 *  1. **确定性**：同一批文件必然得到同一张图（不靠模型、不靠随机），因此可 diff、可复算、可体检。
 *  2. **起点解析分两级并披露**：先精准（原样命中），全空才进变体（归一/子串/删字/词相似度），
 *     用了哪一级、哪个变体词**必须写进输出**——否则用户以为"查不到"，其实是查歪了。
 *  3. **落盘是一个 JSON 文件**（`<dataDir>/graph.json`）：派生缓存，删了可重建；不引 sqlite/原生依赖。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { expandHome } from './switches.js'
import { MANAGED_EXTS, PRUNE_DIRS, effectiveRoots, foldSurface, excluded } from './surface.js'

export const GRAPH_FILE = 'graph.json'
export const GRAPH_VERSION = 1
const TIER_STRUCT = 'structural'
const TIER_REF = 'reference'

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const keyOf = (p) => norm(p).replace(/\\/g, '/').toLowerCase()
/** 归一化：NFKC + 小写 + 只留字母数字汉字（治大小写/全半角/连字符手滑） */
const squash = (s) => norm(s).normalize('NFKC').toLowerCase().replace(/[^0-9a-z一-鿿]+/g, '')
const tokens = (s) => norm(s).normalize('NFKC').toLowerCase().split(/[^0-9a-z一-鿿]+/).filter(Boolean)
const codeOf = (s) => (norm(s).match(/\b([A-Z]{1,4}\d{1,4})\b/) || [])[1] || ''

/** 标准 Markdown 链接 `[文字](目标)`；负向先行断言挡掉图片 `![alt](x)`（图不是指针）。 */
const MD_LINK = /(?<!!)\[([^\]\n]{0,120})\]\(\s*([^)\s]{1,300})\s*\)/g

/**
 * 链接目标 → 可解析的路径 token；**非本地 / 非 md 目标回空串**（纯函数，闸直测）。
 *
 * 收：`note.md`、`sub/deep.md`、`../x.md`、`D:\a\b.md`；去 `<壳>` 与 `#锚点`。
 * 不收：`http(s):`／`mailto:`／`data:` 等带 scheme 的（**Windows 盘符除外**——`D:\a\b.md` 也长得像 scheme，
 * 切掉它会把绝对路径全废）、纯 `#锚点`、含空格/花括号/竖线的串（那是模板或说明文字，不是指针）、非 `.md` 目标。
 * 为什么要这条口径：本系统只纳管 `.md`，宁可少认不可乱认——认错了会在图里长出一条假边。
 */
export function linkTarget(raw) {
  let t = String(raw || '').trim().replace(/^</, '').replace(/>$/, '').trim()
  if (!t || t.startsWith('#')) return ''
  t = t.split('#')[0].trim()
  if (!t) return ''
  if (/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(t) && !/^[A-Za-z]:[\\/]/.test(t)) return ''
  if (/[<>{}\s|]/.test(t)) return ''
  if (!/\.(md|markdown)$/i.test(t)) return ''
  return t
}

export function graphFile(dataDir) {
  return join(expandHome(dataDir), GRAPH_FILE)
}

/** 列出管理范围内的文件（遵守资料面的排除与剪枝）。 */
export function listFiles(cfg, folded, opts = {}) {
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : 2000
  const exts = (opts.exts || MANAGED_EXTS).map((e) => String(e).toLowerCase())
  const out = []
  let skippedExcluded = 0
  for (const r of effectiveRoots(cfg, folded)) {
    const root = resolve(expandHome(r.path))
    let st
    try { st = statSync(root) } catch { continue }
    if (!st.isDirectory()) continue
    const walk = (dir, depth) => {
      if (out.length >= maxFiles || depth > 10) return
      let ents = []
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of ents) {
        if (out.length >= maxFiles) return
        const full = join(dir, ent.name)
        if (ent.isDirectory()) { if (!PRUNE_DIRS.includes(ent.name)) walk(full, depth + 1); continue }
        const relPath = relative(root, full).replace(/\\/g, '/')
        const ext = ('.' + (ent.name.split('.').pop() || '')).toLowerCase()
        if (!exts.includes(ext)) continue
        if (excluded(relPath, full, folded.excludes || [])) { skippedExcluded++; continue }
        let mtime = 0, size = 0
        try { const s2 = statSync(full); mtime = Math.floor(s2.mtimeMs); size = s2.size } catch { continue }
        out.push({ root: root.replace(/\\/g, '/'), path: full.replace(/\\/g, '/'), rel: relPath, mtime, size })
      }
    }
    walk(root, 0)
  }
    return { files: out.sort((a, b) => a.path.localeCompare(b.path)), skippedExcluded, capped: out.length >= maxFiles }
}

/**
 * 解析一份 md：产出节点与边。
 * 节点 kinds：file（文件）/ entry（标题条目，带 id 与触发行）/ name（被提到的实体名）
 * 边 kinds：contains（文件→条目，结构）/ points（条目或文件→条目/文件，引用）/ named（条目→名字，结构）
 */
export function extractFile(f) {
  const nodes = []
  const edges = []
  const fileKey = 'file:' + f.path
  nodes.push({ key: fileKey, kind: 'file', name: f.rel, path: f.path, root: f.root, mtime: f.mtime, size: f.size })
  let text = ''
  try { text = readFileSync(f.path, 'utf8') } catch { return { nodes, edges, error: '读不到文件' } }
  const lines = text.split(/\r?\n/)
  const stack = []
  let lastEntry = fileKey
  const entryByKey = new Map()
  const codes = []
  const titleByCode = new Map()
  const HEADING = /^(#{1,6})\s+(.+)$/
  const TRIGGER = /^\s*[-*]\s*(?:\*\*)?触发(?:\*\*)?[:：]\s*(.+)$/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const h = HEADING.exec(line)
    if (h) {
      const level = h[1].length
      const title = norm(h[2])
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      const code = codeOf(title)
      const key = 'entry:' + f.path + ':' + (code || 'L' + (i + 1))
      const node = {
        key, kind: 'entry', name: title, code, path: f.path, file: fileKey,
        line: i + 1, level, triggers: [], anchor: title,
      }
      stack.push({ level, key })
      nodes.push(node)
      entryByKey.set(key, node)
      edges.push({ from: lastEntry, to: key, kind: TIER_STRUCT, type: 'contains', reason: `${basename(f.path)} 第 ${i + 1} 行标题「${title.slice(0, 40)}」` })
      lastEntry = key
      if (code) { codes.push(code); titleByCode.set(code, key) }
      continue
    }
    const tg = TRIGGER.exec(line)
    if (tg && lastEntry !== fileKey) {
      const e0 = entryByKey.get(lastEntry)
      if (e0) { const t0 = norm(tg[1]).replace(/\*\*/g, ''); if (t0) e0.triggers = (e0.triggers || []).concat([t0]) }
      continue
    }
    // 正文里的引用（只认这几类硬形状，避免噪声）
    if (/^\s*[-*|]|`|\[|§|见|指针条目/.test(line)) {
      const addRef = (to, type, reason, from = lastEntry, soft = false) => { if (to && to !== from) edges.push({ from, to, kind: TIER_REF, type, soft, reason: `${basename(f.path)}:${i + 1} ${reason}` }) }
      // 标准 Markdown 链接 `[文字](路径.md)`：**挂在文件节点上**（与内核 `md_links` 同源）——
      // 索引文件天生用相对链接写，而"这份新档有没有人登记过"正是按 file→file 边判的。
      for (const m of line.matchAll(MD_LINK)) {
        const tok = linkTarget(m[2])
        if (!tok) continue
        addRef({ pathLike: tok }, 'path', `[${norm(m[1]).slice(0, 30)}](${m[2]})`, fileKey, true)
      }
      for (const m of line.matchAll(/`([^`\n]{2,160}(?:\.md|\.markdown))(?:#[A-Za-z0-9_\-.:]+)?`/g)) addRef({ pathLike: m[1] }, 'path', '`' + m[1] + '`')
      for (const m of line.matchAll(/(?:§|见|参见|指针条目\s*=|条目\s=)\s*([A-Za-z]{1,4}\d{1,4})/g)) addRef({ code: m[1] }, 'code', `指向 ${m[1]}`)
      const bare = line.match(/(?:\|\s*|^[\s>*-]*)([A-Z]{1,4}\d{1,4})(?=$|[\s，。；、）)｜|])/g) || []
      for (const b of bare) { const code = (b.match(/[A-Z]{1,4}\d{1,4}/) || [])[0]; if (code) addRef({ code }, 'code', `提到条目号 ${code}`) }
    }
  }
  const head = text.match(/^\s*#\s+(.+)$/m)
  if (head) {
    const nm = norm(head[1])
    if (nm) {
      const nkey = 'name:' + nm.slice(0, 120)
      nodes.push({ key: nkey, kind: 'name', name: nm })
      edges.push({ from: fileKey, to: nkey, kind: TIER_STRUCT, type: 'titled', reason: `H1「${nm.slice(0, 40)}」` })
    }
  }
  return { nodes, edges, codes, file: f, error: '' }
}

/** 建图。返回 { graph, warnings }。 */
export function build(cfg, folded, opts = {}) {
  const t0 = Date.now()
  const { files, skippedExcluded, capped } = listFiles(cfg, folded, opts)
  const nodes = new Map()
  const rawEdges = []
  const codeOwners = new Map()
  const warnings = []
  for (const f of files) {
    if (f.size > (opts.maxBytes || 1_500_000)) { warnings.push(`跳过超大文件（${(f.size / 1048576).toFixed(1)}MB）：${f.rel}`); continue }
    const r = extractFile(f)
    if (r.error) warnings.push(`${r.error}：${f.rel}`)
    for (const n of r.nodes) {
      const prev = nodes.get(n.key)
      if (prev && prev.kind === 'entry' && n.kind === 'entry') n.key = n.key + '#' + nodes.size // 同文件重复条目号防撞
      if (!nodes.has(n.key)) nodes.set(n.key, n)
      if (n.kind === 'entry' && n.code && !codeOwners.has(n.code.toUpperCase())) codeOwners.set(n.code.toUpperCase(), n.key)
    }
    for (const e0 of r.edges) rawEdges.push(e0)
  }
  // 引用边解析：title / path / code 三种猜测 → 真实节点
  const byTitle = new Map()
  for (const n of nodes.values()) {
    if (n.kind !== 'entry') continue
    const k = squash(n.name) || squash(n.code)
    if (k && !byTitle.has(k)) byTitle.set(k, n.key)
    if (n.code) { const k2 = squash(n.code); if (!byTitle.has(k2)) byTitle.set(k2, n.key) }
  }
  const pathIndex = new Map()
  for (const n of nodes.values()) if (n.kind === 'file') { pathIndex.set(keyOf(n.path), n.key); pathIndex.set(keyOf(n.name), n.key) }
  const edges = []
  let unresolved = 0
  const seenEdge = new Set()
  for (const e0 of rawEdges) {
    let to = ''
    if (e0.to && typeof e0.to === 'object') {
      const g = e0.to
      if (g.code) to = codeOwners.get(String(g.code).toUpperCase()) || byTitle.get(squash(g.code)) || ''
      else if (g.pathLike) {
        const clean = String(g.pathLike).replace(/^["'`<]+|["'`>]+$/g, '')
        const abs = resolve(dirname(nodes.get(e0.from)?.path || cfg.dataDir), clean)
        to = pathIndex.get(keyOf(abs)) || pathIndex.get(keyOf(clean)) || pathIndex.get(keyOf(basename(clean))) || ''
      } else if (g.guess) to = byTitle.get(squash(g.guess)) || ''
    } else to = String(e0.to || '')
    // `soft` 引用（标准 Markdown 链接）：解析不到就不建边、**也不计未解析**——相对链接里的 `../`
    // 与说明性链接太多，倒进"未解析"清单会把真正该修的那些淹掉（与内核 `ex_md_links` 同口径）。
    if (!to || !nodes.has(to)) { if (!e0.soft) unresolved++; continue }
    if (to === e0.from) continue
    const sig = e0.from + '>' + to + '>' + e0.type
    if (seenEdge.has(sig)) continue
    seenEdge.add(sig)
    edges.push({ from: e0.from, to, kind: e0.kind, type: e0.type, reason: e0.reason })
  }
  const degree = new Map()
  for (const e0 of edges) { degree.set(e0.from, (degree.get(e0.from) || 0) + 1); degree.set(e0.to, (degree.get(e0.to) || 0) + 1) }
  const graph = {
    version: GRAPH_VERSION,
    builtAt: new Date().toISOString(),
    tookMs: Date.now() - t0,
    roots: effectiveRoots(cfg, folded).map((r) => r.path),
    stats: {
      files: files.length, nodes: nodes.size, edges: edges.length, unresolved, skippedExcluded, capped,
      degreeMax: Math.max(0, ...degree.values()),
    },
    nodes: [...nodes.values()].map((n) => ({ key: n.key, kind: n.kind, name: n.name, code: n.code || '', path: n.path || '', rel: n.kind === 'file' ? n.name : (relative(cfg.dataDir, n.path || '') || '').replace(/\\/g, '/'), line: n.line || 0, triggers: n.triggers || [], size: n.size || 0, mtime: n.mtime || 0, level: n.level || 0 })),
    edges,
  }
  try {
    const dir = expandHome(cfg.dataDir)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(graphFile(cfg.dataDir), JSON.stringify(graph), { encoding: 'utf8' })
  } catch (e0) { warnings.push(`图落盘失败：${String((e0 && e0.message) || e0)}`) }
  return { graph, warnings }
}

export function load(cfg) {
  try {
    const g = JSON.parse(readFileSync(graphFile(cfg.dataDir), 'utf8'))
    if (!g || g.version !== GRAPH_VERSION || !Array.isArray(g.nodes)) return null
    return g
  } catch { return null }
}

/** 图状态（面板与探针共用）。stale 有两层含义：文件比图新，或图太老。 */
export function status(cfg, folded, opts = {}) {
  const file = graphFile(cfg.dataDir)
  const g = load(cfg)
  if (!g) return { exists: false, file, builtAt: '', ageHours: -1, stale: true, nodes: 0, edges: 0, files: 0, changed: 0, missingRoots: [] }
  const ageHours = (Date.now() - Date.parse(g.builtAt)) / 3600000
  const maxAge = Number(opts.maxAgeHours) > 0 ? Number(opts.maxAgeHours) : 24
  let changed = 0
  const known = new Map(g.nodes.filter((n) => n.kind === 'file').map((n) => [keyOf(n.path), n.mtime || 0]))
  const { files } = listFiles(cfg, folded, opts)
  for (const f of files) { const m = known.get(keyOf(f.path)); if (m === undefined || f.mtime > m + 1000) changed++ }
  const missing = files.length - known.size
  return {
    exists: true, file, builtAt: g.builtAt, tookMs: g.tookMs || 0,
    ageHours: Number(ageHours.toFixed(2)), stale: ageHours > maxAge || changed > 0, tooOld: ageHours > maxAge, changed, missing,
    nodes: g.stats.nodes, edges: g.stats.edges, files: g.stats.files, unresolved: g.stats.unresolved, skippedExcluded: g.stats.skippedExcluded,
    roots: g.roots || [], maxAgeHours: maxAge,
  }
}

/* ───────────────────────────── 起点解析（两级，且披露用了哪一级） */

/** 池子里的字段名 → 给人看的说法（一条查询的解释必须全程同一个口径，别一半中文一半英文） */
const FIELD_ZH = { title: '标题', file: '文件名', trigger: '触发行', code: '条目号' }
const fieldZh = (f) => FIELD_ZH[f] || f

function namePool(g) {
  const pool = []
  for (const n of g.nodes) {
    if (n.kind === 'file') { pool.push({ node: n, text: String(n.name).replace(/\.[a-z0-9]+$/i, ''), field: 'file' }); continue }
    pool.push({ node: n, text: n.name, field: 'title' })
    if (n.code) pool.push({ node: n, text: n.code, field: 'code' })
    for (const t of n.triggers || []) for (const seg of String(t).split(/[；;、|]/)) if (norm(seg).length >= 2) pool.push({ node: n, text: seg, field: 'trigger' })
  }
  return pool
}
const sim = (a, b) => { const A = tokens(a), B = new Set(tokens(b)); if (!A.length || !B.size) return 0; let hit = 0; for (const t of A) if (B.has(t)) hit++; return hit / Math.max(A.length, Math.min(6, B.size)) }
function deletions(s) { const out = new Set(); for (let i = 0; i < s.length && i < 24; i++) out.add(s.slice(0, i) + s.slice(i + 1)); return [...out] }

/**
 * 解析查询词到起点节点。返回 { starts, level, variant, candidates }
 *  level1 精准（原样）：精确名 / 条目号 / 归一相等 / 原子串 / 触发行原样子串
 *  level2 变体（改了查询形态，必须披露）：归一子串 / 删一字 / 词相似度≥0.8
 */
export function resolveStarts(g, query, opts = {}) {
  const q = norm(query)
  if (!q) return { starts: [], level: '', variant: '', candidates: [] }
  const pool = namePool(g)
  const nq = squash(q), code = codeOf(q)
  const hitKeys = new Set(), starts = []
  const push = (node, how) => { if (!hitKeys.has(node.key)) { hitKeys.add(node.key); starts.push({ key: node.key, name: node.name || node.text, how }) } }
  let level = '精准'
  // ① 条目号先判：`AA1` 是标题 `AA1 装插件要按七步走` 的子串，若让子串规则先跑，
  //    精准命中会被降级成"原样子串"，披露出来的依据就是假的（闸 M9 抓到过）
  if (code) {
    for (const n of g.nodes) {
      if (n.kind === 'entry' && n.code && n.code.toUpperCase() === code.toUpperCase()) push(n, `条目号 ${n.code}`)
    }
  }
  // ② 原样精确 → 归一相等 → 触发行子串 → 标题子串（越靠前越可信）
  for (const p of pool) {
    const np = squash(p.text)
    if (p.text === q) push(p.node, `${fieldZh(p.field)} 精确同名`)
    else if (nq && np === nq) push(p.node, `${fieldZh(p.field)} 归一相等`)
    else if (p.field === 'trigger' && norm(p.text).toLowerCase().includes(q.toLowerCase())) push(p.node, '触发行原样子串')
    else if (np && np.includes(nq) && nq.length >= 3) push(p.node, `${fieldZh(p.field)} 原样子串`)
  }
  if (!starts.length) {
    level = '变体'
    const variants = new Set([nq, ...deletions(nq)])
    for (const p of pool) {
      const np = squash(p.text)
      if (!np) continue
      for (const v of variants) {
        if (!v || v.length < 2) continue
        if (np === v) { push(p.node, `变体「${v === nq ? '归一' : '删一字'}」→ ${fieldZh(p.field)}`); break }
        if (np.includes(v) && v.length >= 4) { push(p.node, `变体归一子串 → ${fieldZh(p.field)}`); break }
      }
    }
    if (!starts.length) {
      const scored = pool.map((p) => ({ p, s: sim(q, p.text) })).filter((x) => x.s >= (opts.minSim || 0.8)).sort((a, b) => b.s - a.s).slice(0, 6)
      for (const x of scored) push(x.p.node, `词相似度 ${(x.s * 100).toFixed(0)}% → ${fieldZh(x.p.field)}`)
      if (scored.length) level = '变体（词相似度）'
    }
  }
  const names = [...new Set(pool.map((p) => p.node.name).filter(Boolean))]
  const candidates = names.filter((n) => { const s2 = squash(n); return s2 && (nq.includes(s2) || s2.includes(nq)) }).slice(0, 8)
  return { starts: starts.slice(0, opts.maxStarts || 6), level, variant: starts.map((s) => s.how), candidates }
}

/** 从起点做 BFS（默认 depth 2），带边与 reason。 */
export function subgraph(g, starts, opts = {}) {
  const depth = Number(opts.depth) > 0 ? Number(opts.depth) : 2
  const cap = Number(opts.maxNodes) > 0 ? Number(opts.maxNodes) : 45
  const byKey = new Map(g.nodes.map((n) => [n.key, n]))
  const adj = new Map()
  for (const e0 of g.edges) {
    if (!adj.has(e0.from)) adj.set(e0.from, [])
    if (!adj.has(e0.to)) adj.set(e0.to, [])
    adj.get(e0.from).push({ other: e0.to, edge: e0, dir: 'out' })
    adj.get(e0.to).push({ other: e0.from, edge: e0, dir: 'in' })
  }
  const keep = new Map()
  let frontier = starts.map((s) => s.key).filter((k) => byKey.has(k))
  for (const k of frontier) keep.set(k, 0)
  for (let d = 1; d <= depth; d++) {
    const next = []
    for (const k of frontier) {
      for (const a of adj.get(k) || []) {
        if (keep.has(a.other)) continue
        if (a.edge.kind !== TIER_STRUCT && a.dir === 'in' && d === depth) continue
        keep.set(a.other, d)
        next.push(a.other)
        if (keep.size >= cap) break
      }
      if (keep.size >= cap) break
    }
    frontier = next
    if (keep.size >= cap || !next.length) break
  }
  const nodes = [...keep.entries()].map(([k, d]) => ({ ...(byKey.get(k) || {}), depth: d }))
  const edges = g.edges.filter((e0) => keep.has(e0.from) && keep.has(e0.to))
  return { nodes, edges, capped: keep.size >= cap }
}

/** 渲染给模型/面板看的亮起结果（Markdown 文本；工具与面板共用一份口径）。 */
export function render(g, query, resolved, sub, st, opts = {}) {
  const byKey = new Map(g.nodes.map((n) => [n.key, n]))
  const L = []
  L.push(`# 亮起子图：\`${norm(query).slice(0, 60)}\``)
  L.push(`- 图水位：${st.builtAt || '?'}（${st.exists ? `${st.ageHours} 小时前建，${st.stale ? '**已过期，建议重建**' : '较新'}` : '**图不存在**'}）｜节点 ${st.nodes}／边 ${st.edges}／文件 ${st.files}`)
  if (resolved.level) L.push(`- 起点解析＝**${resolved.level}**：` + resolved.starts.map((s) => `\`${s.name}\`（${s.how}）`).join('、'))
  L.push(`- 亮起 ${sub.nodes.length} 节点／${sub.edges.length} 边（depth≤${opts.depth || 2}${sub.capped ? '，**已截断**' : ''}）`)
  if (!resolved.starts.length) {
    L.push('', '## 没找到起点（图里确实没有这个名字/条目号/触发行）')
    L.push('- 建议读法：把候选词补进对应条目的 **触发行**（或建图后重查），**别**为了命中去改标题——标题是给人看的，触发行才是给索引用的。')
    if (resolved.candidates.length) L.push('- 形近的现有节点：' + resolved.candidates.map((c) => `\`${c}\``).join('、'))
    const codes = [...new Set(g.nodes.filter((n) => n.code).map((n) => n.code))].slice(0, 20)
    L.push('- 图里的条目号样本：' + (codes.join(' ') || '（无）'))
    return L.join('\n')
  }
  L.push('', '## 边（谁引用谁，带 reason 与出处）')
  const groups = new Map()
  for (const e0 of sub.edges.slice(0, opts.maxEdges || 40)) {
    const a = byKey.get(e0.from) || {}, b = byKey.get(e0.to) || {}
    const k = `${a.path || ''}#${a.line || ''}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push({ e0, a, b })
  }
  for (const [loc, list] of groups) {
    L.push(`- 📄 \`${(list[0].a.path || list[0].a.rel || '').split('/').slice(-2).join('/')}\`${loc.split('#')[1] ? ':' + loc.split('#')[1] : ''}`)
    for (const { e0, a, b } of list.slice(0, 8)) {
      const arrow = e0.type === 'contains' ? '▸含' : e0.type === 'titled' ? '▸题名' : '▸指'
      L.push(`   - \`${(a.name || a.rel || '?').slice(0, 28)}\` ${arrow} \`${(b.name || b.rel || '?').slice(0, 28)}\` _(${e0.reason})_`)
    }
  }
  const files = [...new Set(sub.nodes.filter((n) => n.kind === 'file' || n.path).map((n) => n.path))].slice(0, opts.maxFiles || 12)
  L.push('', '## 建议读（地图不是内容，引入仍需过筛）')
  for (const p of files) L.push(`- \`${p}\``)
  const changed = st.changed ? `｜注意：自上次建图后 ${st.changed} 个文件已改动（结果可能不含最新内容）` : ''
  L.push('', `> 只索引标题／条目号／触发行／反引号路径与「§三 AA14」式指针，**正文不进图**；查不到的词请补触发行，别改标题。${changed}`)
  return L.join('\n')
}

/** 体检：产出"盲区清单"（不报错的问题只能靠这里暴露）。 */
export function check(cfg, folded, g, opts = {}) {
  const graph = g || load(cfg)
  if (!graph) return { ok: false, message: '图不存在：先 memoryos_graph(action=build)' }
  const keys = new Set(graph.nodes.map((n) => n.key))
  // "孤儿"按**有没有人引用它**算，不按度数：每条条目都自带"文件包含它"的结构边，用度数会永远是 0（本轮实踩）
  const inboundRef = new Map()
  for (const e0 of graph.edges) if (e0.kind === TIER_REF) inboundRef.set(e0.to, (inboundRef.get(e0.to) || 0) + 1)
  const orphans = graph.nodes.filter((n) => n.kind === 'entry' && !inboundRef.get(n.key)).slice(0, 15)
  const st = status(cfg, folded, opts)
  const noTrigger = graph.nodes.filter((n) => n.kind === 'entry' && !(n.triggers || []).length && n.level >= 3).slice(0, 15)
  const dupCode = (() => {
    const m = new Map()
    for (const n of graph.nodes) if (n.code) m.set(n.code.toUpperCase(), (m.get(n.code.toUpperCase()) || 0) + 1)
    return [...m.entries()].filter(([, c]) => c > 1).map(([c, n]) => `${c}×${n}`).slice(0, 15)
  })()
  const lines = graph.nodes.filter((n) => n.kind === 'file' && n.size > (opts.bigFile || 300000)).map((n) => `${n.name} ${(n.size / 1048576).toFixed(1)}MB`).slice(0, 10)
  const out = {
    ok: true,
    watermark: { builtAt: graph.builtAt, ageHours: st.ageHours, stale: st.stale, changedFiles: st.changed, unresolvedRefs: graph.stats.unresolved, skippedExcluded: graph.stats.skippedExcluded },
    orphanEntries: orphans.map((n) => ({ name: n.name, path: n.path, line: n.line })),
    entriesWithoutTrigger: noTrigger.map((n) => ({ name: n.name, path: n.path, line: n.line })),
    duplicatedCodes: dupCode,
    bigFiles: lines,
  }
  out.counts = { orphan: out.orphanEntries.length, noTrigger: out.entriesWithoutTrigger.length, dupCode: out.duplicatedCodes.length, big: out.bigFiles.length, changed: st.changed, unresolved: graph.stats.unresolved }
  out.verdict = (out.counts.orphan + out.counts.noTrigger + out.counts.dupCode + out.counts.changed + out.counts.unresolved) === 0
    ? '干净：没有需要补的盲区'
    : `有 ${Object.values(out.counts).reduce((a, b) => a + b, 0)} 处盲区（其中"没触发行"最常见——它是索引唯一认的东西）`
  return out
}

export function checkText(out) {
  if (!out.ok) return out.message
  const L = [`体检：${out.verdict}`, `水位：${out.watermark.builtAt}｜${out.watermark.ageHours}h｜stale=${out.watermark.stale}｜改动未入图 ${out.watermark.changedFiles}｜未解析引用 ${out.watermark.unresolvedRefs}`]
  const sect = (t, arr, fmt) => { if (arr.length) { L.push(t); for (const x of arr.slice(0, 8)) { L.push(' - ' + fmt(x)) } if (arr.length > 8) { L.push(' - …另 ' + (arr.length - 8) + ' 条') } } }
  sect('没有任何边指向的条目（写了但索引找不到）:', out.orphanEntries, (x) => `${x.name} ← ${String(x.path).split('/').slice(-2).join('/')}:${x.line}`)
  sect('条目缺「触发行」（只有标题，模型说同类话时匹配不上）:', out.entriesWithoutTrigger, (x) => `${x.name} ← ${String(x.path).split('/').slice(-2).join('/')}:${x.line}`)
  if (out.duplicatedCodes.length) L.push('重复条目号（后出现的键会被加防撞后缀）：' + out.duplicatedCodes.join(' '))
  if (out.bigFiles.length) L.push('偏大的文件（建议拆）：' + out.bigFiles.join(' '))
  return L.join('\n')
}
