/**
 * MemoryOS · 控制面板的宿主数据面（HTTP）
 *
 * 三条从 dsh-selfevolve 抄来的硬规矩（都是踩过才写进注释的）：
 *  1. **webServer 是"晚到 Service"**：本插件 apply 跑在它之前，`ctx.get('webServer')` 恒 undefined；
 *     把它写进顶层 `inject` 又会让 headless profile 里**整个插件永远 waiting**。
 *     正解＝`ctx.inject(['webServer'], …)`——只让这一块器官等它出现，不出现就没有面板数据，其余照常。
 *  2. **prefix 兜底必须回 JSON 404**，否则未知子路径掉进宿主 SPA 回落会返回 HTML（面板 fetch 解析炸）。
 *  3. **写侧统一入口**：POST 成功即回**最新快照**（面板不必再拉一次，也保证"点了就看到变化"）。
 *
 * 鉴权：不在本模块——GUI 只绑 127.0.0.1 且 token→cookie 由宿主承担，面板 fetch 不带任何认证头。
 */

export const PREFIX = '/api/dsh-md-MemoryOS'
/** 闸用来对账：client.js 里出现的每个请求路径，这里必须真的注册。 */
export const API_PATHS = ['/snapshot', '/switch', '/takeover', '/release', '/surface']

function sendJson(res, status, payload) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  } catch { /* 响应已发出/连接已断：本模块永不抛（旁路不变量） */ }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    let tooBig = false
    req.on('data', (c) => {
      if (tooBig) return
      body += c
      if (body.length > 1_000_000) { tooBig = true; body = ''; req.destroy() } // 面板载荷远小于此
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })
}

function parseJson(text) {
  try {
    const v = JSON.parse(text || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/** @returns {(() => void) | undefined} 走 ctx.inject 路径时返回 undefined（生命周期交给子 fiber） */
export function createApi(ctx, deps) {
  const late = ctx && typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : null
  if (late) {
    late(['webServer'], (sub) => mount(sub, deps))
    return undefined
  }
  return mount(ctx, deps) // 老运行时没有 inject：拿不到就是这块器官不存在
}

function mount(ctx, deps) {
  const web = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (!web || typeof web.register !== 'function') {
    if (deps.runtime) deps.runtime.webserver = false
    return undefined
  }
  const disposers = []
  const register = (route) => {
    try {
      disposers.push(web.register(route))
    } catch (err) {
      if (deps.warn) deps.warn(`面板路由注册失败（面板降级为无数据）：${String((err && err.message) || err)}`)
    }
  }

  // ① prefix 兜底（必须注册在任何 exact 之后无所谓，宿主按 specificity 走；这里防 HTML 回落）
  register({ kind: 'prefix', path: PREFIX, handler(_req, res) { sendJson(res, 404, { ok: false, error: 'not-found' }) } })

  // ② 读面（快照构建含异步凭据查询，所以 handler 走 async）
  register({
    kind: 'exact',
    path: `${PREFIX}/snapshot`,
    async handler(_req, res) {
      try {
        sendJson(res, 200, { ok: true, snapshot: await deps.snapshot() })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: `snapshot-failed: ${String((err && err.message) || err)}` })
      }
    },
  })

  // ③ 写面（唯一入口 writeSwitch 在 index.js；这里只做 HTTP 形状与回快照）
  const writeRoute = (path, pick, run) => {
    register({
      kind: 'exact',
      path: `${PREFIX}${path}`,
      async handler(req, res) {
        try {
          const body = pick(parseJson(await readBody(req)))
          const r = await (run || deps.write)(body)
          if (!r || !r.ok) {
            sendJson(res, 400, { ok: false, message: (r && r.message) || '写入被拒', rows: 0 })
            return
          }
          sendJson(res, 200, { ok: true, message: r.message, rows: 1, snapshot: await deps.snapshot() })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    })
  }
  writeRoute('/switch', (b) => ({ feature: b.feature ?? b.key, value: b.value, reason: b.reason, by: 'user' }))
  // 资料面：一个端点收四种写操作 + 试算（op 在 body 里；与模型工具走同一个 writeSurface）
  writeRoute('/surface', (b) => ({ op: b.op ?? b.action, path: b.path, pattern: b.pattern, reason: b.reason, by: 'user' }), (b) => deps.surface(b))
  writeRoute('/takeover', (b) => ({ feature: b.feature, value: b.value === undefined ? true : b.value, lock: true, by: 'user', reason: b.reason }))
  writeRoute('/release', (b) => ({ feature: b.feature, value: b.value === undefined ? true : b.value, lock: false, by: 'user', reason: b.reason }))

  if (deps.runtime) deps.runtime.webserver = true
  if (deps.log) deps.log(`面板数据面已挂：${PREFIX}{${API_PATHS.join(', ')}}`)

  return function disposeApi() {
    if (deps.runtime) deps.runtime.webserver = false
    for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* 卸载绝不抛 */ } }
  }
}
