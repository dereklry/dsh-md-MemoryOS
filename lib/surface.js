/**
 * MemoryOS · 资料面（管理范围）登记表
 *
 * 干什么：**记住"哪些目录归 OS 管、哪些文件/子目录被排除"**，并让它可见、可改、可预演。
 * 面板「资料面」页读的就是这里；模型用 `memoryos_surface` 也走同一入口。
 *
 * 四条设计判断：
 *  1. **profile 的 `memoryRoot` 是只读基线**：面板不删它、更不覆写 profile 文件（那是宿主配置，改了要重启）。
 *     面板加的是"增量根"，与基线**求并集**，来源标清楚（用户会问"这目录哪来的"）。
 *  2. **改的是账，不是配置文件**：`surface.jsonl` 一次操作＝一行（add-root / drop-root / add-exclude / drop-exclude），
 *     读侧 fold 出当前集合。与开关账本同理：能回答"谁在什么时候把哪个目录纳入了管理"，删错了查得回来。
 *  3. **排除要能精确到子目录与单个文件**（2026-09-28 用户点名）：规则**既按"相对某个记忆根的路径"匹配，也按绝对路径匹配**，
 *     所以 `notes/drafts/` 只挡某个根下那个子树、`todo.md` 挡任意层级的同名文件、
 *     `notes/archive/**` 挡一棵子树、`*.draft.md` 挡某种命名模式。
 *  4. **文件类型本版本固定 `.md`**：面板给提示而不是输入框——加后缀容易，让检索真的管它是另一回事。
 *
 * 另有 `preview()`：**试算**一条规则会挡住多少个文件、挡哪些，先看清再落账（配合 `badPattern` 拒 `*` 一把梭）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { expandHome } from './switches.js'

/** 本版本固定管理的文件类型（面板只读显示 + 提示语）。 */
export const MANAGED_EXTS = ['.md']

/** 一律不进扫描的目录名（第三方副本与产物，进图就是噪声） */
export const PRUNE_DIRS = ['node_modules', '.venv', 'venv', '__pycache__', '.git', 'dist', 'build', '.next', '.idea']

export function surfaceFile(dataDir) {
  return join(expandHome(dataDir), 'surface.jsonl')
}

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
const key = (p) => norm(p).toLowerCase()

/** 追加一行操作（唯一写通道）。 */
export function appendSurface(dataDir, row) {
  const dir = expandHome(dataDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const r = {
    op: row.op,
    ts: row.ts || new Date().toISOString(),
    by: row.by || 'user',
    ...(row.path ? { path: norm(row.path) } : {}),
    ...(row.pattern ? { pattern: String(row.pattern).trim() } : {}),
    ...(row.reason ? { reason: String(row.reason).slice(0, 300) } : {}),
  }
  appendFileSync(surfaceFile(dataDir), JSON.stringify(r) + '\n', 'utf8')
  return r
}

/** fold：账本 → 当前集合（roots 保留加入者与时间，面板要显示来源）。 */
export function foldSurface(dataDir) {
  const file = surfaceFile(dataDir)
  const roots = new Map()
  const excludes = new Map()
  let corrupt = 0
  let lines = 0
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      lines++
      let o
      try { o = JSON.parse(t) } catch { corrupt++; continue }
      if (!o || typeof o.op !== 'string') { corrupt++; continue }
      if (o.op === 'add-root' && o.path) roots.set(key(o.path), { path: norm(o.path), by: o.by || 'user', ts: o.ts || '', reason: o.reason || '' })
      else if (o.op === 'drop-root' && o.path) roots.delete(key(o.path))
      else if (o.op === 'add-exclude' && o.pattern) excludes.set(String(o.pattern).trim(), { by: o.by || 'user', ts: o.ts || '', reason: o.reason || '' })
      else if (o.op === 'drop-exclude' && o.pattern) excludes.delete(String(o.pattern).trim())
      else corrupt++
    }
  } catch { /* 还没有账本＝只跟 profile 基线，属正常 */ }
  return { roots: [...roots.values()], excludes: [...excludes.entries()].map(([pattern, m]) => ({ pattern, ...m })), corrupt, lines, file }
}

/** 生效目录＝profile 基线（不可在此删）＋账本增量，去重保序。 */
export function effectiveRoots(cfg, folded) {
  const base = (cfg.memoryRoots || []).map((p) => ({ path: norm(p), source: 'profile', removable: false }))
  const extra = (folded.roots || []).map((r) => ({ path: norm(r.path), source: 'ledger', removable: true, by: r.by, ts: r.ts, reason: r.reason }))
  const seen = new Set()
  return [...base, ...extra].filter((r) => r.path && !seen.has(key(r.path)) && seen.add(key(r.path)))
}

const globToRe = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '§§').replace(/\*\*/g, '§G§').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  .replace(/§§/g, '.*').replace(/§G§/g, '[^]*') + '$', 'i')

/**
 * 一条规则是否命中某个文件。双口径匹配：
 *   · rel ＝ 相对所属记忆根的路径（所以 `notes/drafts/`、`todo.md`、`*.draft.md` 都自然可读）
 *   · abs ＝ 绝对路径（所以 `/srv/secrets/`、机器上的具体位置也能排）
 * 规则形态：
 *   以 `/` 结尾      → 目录前缀（连子树一起挡，rel 与 abs 都试）
 *   含 `*` 或 `?`     → glob（`**` 跨目录，`*`/`?` 不跨）；无斜杠时也按**文件名**比一次
 *   其它             → 路径子串（不分大小写），且额外按"末段同名"精确匹配一次
 */
export function matchExclude(relIn, absIn, pattern) {
  const rel = norm(relIn).toLowerCase()
  const abs = norm(absIn).toLowerCase()
  const p = String(pattern || '').trim().toLowerCase().replace(/\\/g, '/')
  if (!p) return false
  if (p.endsWith('/')) {
    const pre = p.replace(/\/+$/, '')
    return rel === pre || rel.startsWith(pre + '/') || rel.includes('/' + pre + '/')
      || abs === pre || abs.startsWith(pre + '/') || abs.includes('/' + pre + '/')
  }
  const relHit = (target) => (p.includes('*') || p.includes('?')
    ? (globToRe(p).test(target) || (!p.includes('/') && globToRe(p).test(target.split('/').pop())))
    : (target.includes(p) || target.split('/').pop() === p))
  return relHit(rel) || relHit(abs)
}

/** 命中即返回规则名（没命中返回 ''）。patterns 可为字符串数组或 {pattern}[]。 */
export function excluded(relIn, absIn, patterns) {
  for (const raw of patterns || []) {
    const pat = String(raw && raw.pattern ? raw.pattern : raw)
    if (matchExclude(relIn, absIn, pat)) return pat
  }
  return ''
}

/** 排除规则合法性：拒"一把梭"与过短，那等于悄悄关掉整个资料面。 */
export function badPattern(pat) {
  const p = String(pat || '').trim()
  if (!p) return '排除规则不能为空'
  if (p === '*' || p === '**' || p === '**/*' || p === '*/*') return `「${p}」会排除一切 ⇒ 等于关掉整个资料面。要挡子目录写 ` + '`名字/`' + '，要挡某类文件写 `*.draft.md`'
  if (p.replace(/[*?/\\]/g, '').length < 3) return `「${p}」去掉通配符后不足 3 个字符，会误伤一大片路径`
  return ''
}

/** 目录路径校验（面板与模型共用）。 */
export function badRoot(path, cfg, folded) {
  const p = String(path || '').trim()
  if (!p) return '目录不能为空'
  const abs = expandHome(p)
  let st = null
  try { st = statSync(abs) } catch { return `目录不存在：${norm(abs)}` }
  if (!st.isDirectory()) return `这是文件不是目录：${norm(abs)}（资料面按目录纳管；只想管一个文件就把它的父目录纳入再加排除）`
  const k = key(abs)
  if ((cfg.memoryRoots || []).some((r) => key(r) === k)) return '该目录已在 profile 基线（config.memoryRoot）里，不用重复添加'
  if ((folded.roots || []).some((r) => key(r.path) === k)) return '该目录已经在管理范围里了'
  return ''
}

/** 列出一个根下的候选文件（只走目录树、不读内容；命中 cap 即停）。 */
function walkFiles(root, cap) {
  const out = []
  const walk = (dir, depth) => {
    if (out.length >= cap || depth > 12) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (out.length >= cap) return
      const full = join(dir, ent.name)
      if (ent.isDirectory()) { if (!PRUNE_DIRS.includes(ent.name)) walk(full, depth + 1); continue }
      out.push({ abs: full, rel: norm(full).slice(norm(root).length + 1) })
    }
  }
  walk(root, 0)
  return out
}

/**
 * 扫一个根：管到多少文件、被哪条规则挡住多少、样本几条。
 * 便宜纪律：**只数不读内容**，命中 cap 就停（面板是给人看的，索引另有器官）。
 */
export function scanRoot(path, opts = {}) {
  const exts = (opts.exts || MANAGED_EXTS).map((e) => e.toLowerCase())
  const patterns = opts.excludes || []
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : 400
  const root = expandHome(path)
  const out = { exists: false, matched: 0, excluded: 0, scanned: 0, capped: false, samples: [], byRule: {}, why: '' }
  let st = null
  try { st = statSync(root) } catch { out.why = '目录不存在'; return out }
  if (!st.isDirectory()) { out.why = '不是目录'; return out }
  out.exists = true
  const files = walkFiles(root, cap * 6)
  out.capped = files.length >= cap * 6
  for (const f of files) {
    const hit = excluded(f.rel, f.abs, patterns)
    if (hit) { out.excluded++; out.byRule[hit] = (out.byRule[hit] || 0) + 1; continue }
    if (!exts.includes((f.rel.split('/').pop() || '').replace(/^.*\./, '.').toLowerCase())) continue
    out.matched++
    if (out.samples.length < 8) out.samples.push(f.rel)
  }
  out.scanned = files.length
  return out
}

/** 试算：这条规则会挡住什么（先看清再落账；面板"试算"按钮与工具 preview 共用）。 */
export function preview(cfg, folded, pattern, opts = {}) {
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : 400
  const bad = badPattern(pattern)
  if (bad) return { ok: false, message: bad }
  const roots = effectiveRoots(cfg, folded)
  const hits = []
  let total = 0
  for (const r of roots) {
    const s = scanRoot(r.path, { exts: MANAGED_EXTS, excludes: [pattern], cap })
    if (!s.exists) continue
    const files = walkFiles(expandHome(r.path), cap * 6).filter((f) => matchExclude(f.rel, f.abs, pattern))
    const wouldHide = files.filter((f) => MANAGED_EXTS.includes(('.' + (f.rel.split('/').pop() || '').split('.').pop() || '').toLowerCase()))
    total += wouldHide.length
    hits.push({ root: r.path, hides: wouldHide.length, sample: wouldHide.slice(0, 8).map((f) => f.rel) })
  }
  return {
    ok: true, pattern, total, roots: hits,
    message: total === 0
      ? `「${pattern}」在当前管理范围内**一个 .md 都挡不到**——多半是路径写错了（相对根的路径如 notes/drafts/ ，或整个仓库的绝对路径）`
      : `「${pattern}」会挡住 ${total} 个 .md 文件${hits.length > 1 ? `（跨 ${hits.length} 个根）` : ''}；示例：${(hits.find((h) => h.sample.length) || { sample: [] }).sample.slice(0, 5).join(' , ')}`,
  }
}

/** 资料面视图（快照与工具共用一份口径）。 */
export function surfaceView(cfg, folded, opts = {}) {
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : 400
  const roots = effectiveRoots(cfg, folded).map((r) => {
    const s = scanRoot(r.path, { excludes: folded.excludes, exts: MANAGED_EXTS, cap })
    return { ...r, ...s, abs: expandHome(r.path) }
  })
  const live = roots.filter((r) => r.exists)
  const byRule = {}
  for (const r of live) for (const [p, c] of Object.entries(r.byRule)) byRule[p] = (byRule[p] || 0) + c
  return {
    exts: MANAGED_EXTS,
    prune: PRUNE_DIRS,
    roots,
    excludes: (folded.excludes || []).map((e) => ({ ...e, hits: byRule[e.pattern] || 0 })),
    totals: {
      roots: roots.length, dirsMissing: roots.filter((r) => !r.exists).length,
      managed: live.reduce((n, r) => n + r.matched, 0), hidden: live.reduce((n, r) => n + r.excluded, 0),
      capped: roots.some((r) => r.capped),
    },
    ledger: { file: folded.file, lines: folded.lines, corrupt: folded.corrupt },
    hint: '要管其他文件类型（.txt / .org / 代码文件…）不是加个后缀就成立：扫描、索引结构、"查得到"的判据都要跟着改。'
      + '本版本固定 .md —— 需要的话让 LLM 按 docs/DESIGN.md 的扩展点改，或等后续版本。',
  }
}
