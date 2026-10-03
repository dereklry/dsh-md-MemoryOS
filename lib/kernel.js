/**
 * MemoryOS · 元素-时间线内核（Python）的 JS 壳。
 *
 * 只做三件事：**找 python → spawn `-m memoryos_kernel <args>` → 解析它的 JSON**。
 * 内核源码随包发（`python/memoryos_kernel`，已剥离台账面），因此：
 *   - 数据根走 `MEMORYOS_DATA`（与 graph.json 同根，内核库再往下一层 `elements/`）；
 *   - 读面纯标准库，不需要额外装依赖；
 *   - python 本身找不到时**只降级"元素库"这一个功能**，不拖垮面板其它部分（DEPS.python 非致命）。
 *
 * 纪律（照本机 mdledger 的三条实测结论）：
 *   - 钉 `cwd`（内核相对路径依赖它）＋ 注入 `PYTHONUTF8`/`PYTHONIOENCODING`（否则 Windows 控制台 cp936 乱码）；
 *   - `windowsHide: true`（别弹黑窗）；
 *   - 失败**不 throw**，归一成模型/用户可读的一句话。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')
export const PYTHON_DIR = join(PKG_ROOT, 'python')                 // PYTHONPATH 的根
export const KERNEL_PKG = 'memoryos_kernel'
export const KERNEL_DIR = join(PYTHON_DIR, KERNEL_PKG)

/** python 发现链：config > env > 包内 venv > PATH（都不在就让 spawn 报错，原样转述给用户）。 */
export function resolvePython(cfg = {}) {
  const cands = [
    cfg.pythonBin,
    process.env.MEMORYOS_PYTHON_BIN,
    process.env.MD_PYTHON_BIN,
    join(PYTHON_DIR, '.venv', 'Scripts', 'python.exe'),
    join(PYTHON_DIR, '.venv', 'bin', 'python'),
  ].filter(Boolean)
  for (const c of cands) {
    try { if (existsSync(c)) return c } catch { /* 换下一个 */ }
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** 内核要的环境：PYTHONPATH 指到包内 python/，数据根与宿主同源。 */
export function kernelEnv(cfg = {}, extra = {}) {
  const dataDir = cfg.dataDir || process.env.MEMORYOS_DATA || ''
  const pp = [PYTHON_DIR, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
  return {
    ...process.env,
    PYTHONPATH: pp,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    ...(dataDir ? { MEMORYOS_DATA: dataDir } : {}),
    ...(cfg.kernelData ? { MEMORYOS_KERNEL_DATA: cfg.kernelData } : {}),
    ...extra,
  }
}

/** 内核库文件（memory.db）的落点：默认 <dataDir>/elements/memory.db —— 与词法图分开两个数据根。 */
export function kernelDbFile(cfg = {}) {
  const root = cfg.kernelData || join(cfg.dataDir || process.env.MEMORYOS_DATA || '.', 'elements')
  return join(root, 'memory.db')
}

/**
 * 跑一次内核子命令并解析 stdout 的 JSON。
 * @returns {Promise<{ok:boolean,data?:any,raw?:string,message?:string,code?:number}>}
 */
export function runKernel(cfg, args, opts = {}) {
  const py = opts.python || resolvePython(cfg)
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000
  return new Promise((resolvePromise) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolvePromise(v) } }
    let child
    try {
      child = spawn(py, ['-m', KERNEL_PKG, ...args], {
        cwd: opts.cwd || PKG_ROOT,
        env: kernelEnv(cfg, opts.env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return finish({ ok: false, message: `起不了 Python（${py}）：${String((e && e.message) || e)}` })
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 可能已经退了 */ }
      finish({ ok: false, message: `内核超时（${timeoutMs}ms）：memoryos_kernel ${args.join(' ')}` })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({
        ok: false,
        message: `内核起不来：${String((e && e.message) || e)}（pythonBin=${py}；给 config.pythonBin 或 env MEMORYOS_PYTHON_BIN 指一个可用的 python）`,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = String(out).trim()
      if (code !== 0) {
        const tail = (err || text).trim().split('\n').filter(Boolean).slice(-3).join(' / ')
        return finish({ ok: false, code, message: `内核退出码 ${code}：${tail.slice(0, 300)}` })
      }
      if (!text) return finish({ ok: true, data: null })
      try { return finish({ ok: true, data: JSON.parse(text) }) } catch { return finish({ ok: true, raw: text }) }
    })
  })
}
