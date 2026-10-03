"""memoryos_kernel.jev — Jev（TypeSafe System One）快判通道：决策链前置的"第一系"。

定位（2026-09-22 win 线，用户拍板"把 Jev 用起来"）：
  记忆-决策引擎里三处**小封闭集判断**（消歧 choice / 关联度 noul 预筛 / triage
  full-summary-skip）先过 Jev：并行、秒级、$0.042/M 输入、输出免费、带校准概率。
  低置信或不可用 → 回落原慢 LLM 层（deepseek-harness）→ 再回落硬信号。
  **本模块任何失败都静默降级（返回 None），绝不阻断决策链。**

纪律照上游的 Jev 插件：
  - Key 优先级：env JEV_API_KEY / TYPESAFE_API_KEY > JEV_KEY_FILE > <workspace>/jev-key.txt
  - Key 不进代码、不进仓；
  - criteria/instructions 尽量英文措辞（官方：中文准确率较低）；
  - 本 build 之外的平台（Linux 无 key 文件）→ available()=False，行为与接入前逐字节一致。

总闸（D60，2026-09-22 用户要求"不可用/不好用能一键退回原模式"）三级优先，高→低：
  1. 进程 env `JEV_DISABLE`（临时覆盖：1/off/on 等；`0`/`false`/空=强制开，跳过开关文件）
  2. 开关文件 `jev-switch.txt`（落盘持久，md_* 插件每次调用现读——**改完立即生效，免重启**）：
     首行 `off`=关 / `on`=开；路径 = env `JEV_SWITCH_FILE` > <workspace>/dsh-jev/jev-switch.txt
     > <workspace>/jev-switch.txt（旧位只读回退）> <repo>/jev-switch.txt（首个存在者；都没有=默认开，写入落 dsh-jev 新位）
  3. 默认开（有 Key 即走）
分项开关（D61，"某一档不好用就单关那一档"）：
  - 文件首行之后可加 `resolve=off` / `relevance=off` / `triage=off`（代号=FEATURES 注册表，新增接入点先登记）
  - env 临时覆盖：`JEV_DISABLE_RESOLVE` / `JEV_DISABLE_RELEVANCE` / `JEV_DISABLE_TRIAGE`
    （truthy=关该档，`0`/`false`=强制开）；优先级 env > 文件行 > 默认开；总闸 off 一票全灭
  - 业务接入点只问 `feature_available(代号)`：分项允许 + 总闸开 + 有 Key + 不在熔断
`cli.py jev on|off [feature]|status|test` 是这套开关的唯一操作入口（status 显示生效链）。

环境变量（全部可选）：
  JEV_BASE_URL     默认 https://api.typesafe.ai
  JEV_MODEL        默认 jev-latest
  JEV_KEY_FILE     默认 <workspace>/dsh-jev/jev-key.txt（旧 <workspace>/jev-key.txt 兼容回退）
  JEV_SWITCH_FILE  默认 <workspace>/dsh-jev/jev-switch.txt（旧 <workspace>/jev-switch.txt 兼容回退）
  JEV_TIMEOUT_MS   默认 20000
  JEV_CONF_MIN     默认 0.75（消歧/triage 直判的最低置信）
  JEV_REL_KEEP     默认 0.55（关联度：p_yes≥此值且慢 LLM 可用时，喂 LLM 精评）
  JEV_DISABLE      临时总闸覆盖（优先于开关文件；0/false=强制开）
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from . import paths

DEFAULTS = {
    "base_url": "https://api.typesafe.ai",
    "model": "jev-latest",
    "timeout_s": 20.0,
    "conf_min": 0.75,
    "rel_keep": 0.55,
    "state_max": 12000,      # state 字符上限（32K token 之内的安全值）
    "chunk_questions": 12,   # 单请求问题数上限
    "breaker_s": 60,         # 网络失败后熔断窗口（秒），窗口内不再尝试
}

# 进程级熔断：(until_ts, last_error)。避免上游挂了还每节点空等 20s。
_BREAKER = {"until": 0.0, "err": ""}

_KEY_MEMO: Optional[str] = None
_KEY_SOURCE = ""


def _parse_env_file(p: str) -> dict[str, str]:
    """解析 `export KEY="val"` 风格环境文件（与 cli._platform_env 同式，避免反向依赖）。"""
    out: dict[str, str] = {}
    if not os.path.exists(p):
        return out
    try:
        with open(p, encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):]
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def _merged_env() -> dict[str, str]:
    merged = dict(os.environ)
    for p in (
        os.path.join(paths.DSH_HOME, "dsh.env"),
        os.path.expanduser("~/.dsh/dsh.env"),
    ):
        merged.update(_parse_env_file(p))
    return merged


def _f(env: dict[str, str], name: str, default: float) -> float:
    try:
        return float(env.get(name) or default)
    except ValueError:
        return default


def switch_path(env: Optional[dict[str, str]] = None) -> str:
    """开关文件路径：首个存在者优先；都不存在时返回默认写入位（dsh-jev 下）。

    2026-09-22 归拢：正式位 <workspace>/dsh-jev/jev-switch.txt，旧 <workspace>/jev-switch.txt
    仅作读取回退（不再作为写入目标，避免双副本漂移）。
    """
    e = env if env is not None else _merged_env()
    p = (e.get("JEV_SWITCH_FILE") or "").strip()
    if p:
        return p
    new = os.path.join(paths.WORKSPACE, "dsh-jev", "jev-switch.txt")
    legacy = os.path.join(paths.WORKSPACE, "jev-switch.txt")
    repo = os.path.join(paths.MEMORY_DECISION, "jev-switch.txt")
    for cand in (new, legacy, repo):
        if os.path.isfile(cand):
            return cand
    return new


# 用 Jev 的子功能注册表（D61）：新增接入点先在这里登记代号，开关/env 命名自动跟上。
# 注意：route 档属 dsh-route-jev 插件侧（原 dsh-route；JS 读同一开关文件），不在本注册表——内核只认总闸一票全灭。
# light_semantic（D64，2026-09-24 实装 / **2026-09-27 摘除**）：ledger light miss 时的 noul 语义重排档。
# 摘除理由（D66）：每次 miss 烧 Jev 账（~2.5K token state × 30 问），而候选只看"标题+触发行"；
# 用户判"查不到不该调 Jev"⇒ 改用**零模型零账单**的第 5 级起点解析（触发行检索，见 lighter.resolve_start）。
# 代号留在注册表**仅为开关文件兼容**（`light_semantic=off` 行仍可读、status 可显），内核已无消费点。
# find（2026-09-29 实装）：ledger_graph/route.py 的两级语义寻路（任务句→文件→节，Jev choice）。
FEATURES = ("resolve", "relevance", "triage", "light_semantic", "find")
# 外部档（别的进程消费、内核仅负责在重写开关文件时保留其行；不走 feature_available 判定）
ENV_ONLY_FEATURES = ("route",)

_ON_WORDS = ("on", "enable", "enabled")
_OFF_WORDS = ("off", "disable", "disabled")


def _norm_switch_value(v: str) -> Optional[str]:
    if v in _OFF_WORDS:
        return "off"
    if v in _ON_WORDS:
        return "on"
    return None


def switch_file(env: Optional[dict[str, str]] = None) -> dict:
    """解析开关文件。格式：首行=总闸 on/off；其余行 `feature=on|off`（一行一项）。

    返回 {master: on|off|dirty|None, features: {name: on|off}, unknown: [原文行], path}。
    脏值不生效、不报错，由 status 显式列出（只认 cli 写得出的规范形）。
    注册表外的已知外部档（如 dsh-route-jev 的 route，JS 侧读同一文件）按分项接管——
    否则 write_switch 重写时会把它的行剥掉（2026-09-24 实机踩坑：`jev off light_semantic`
    一圈回来 route=off 消失）。未知项仍进 unknown 留痕。
    """
    p = switch_path(env)
    out: dict[str, Any] = {"master": None, "features": {}, "unknown": [], "path": p}
    if not os.path.isfile(p):
        return out
    try:
        with open(p, encoding="utf-8") as fh:
            lines = [ln.strip().lower() for ln in fh if ln.strip() and not ln.strip().startswith("#")]
    except OSError:
        return out
    external = set(ENV_ONLY_FEATURES)
    for i, ln in enumerate(lines):
        if i == 0 and "=" not in ln:
            out["master"] = _norm_switch_value(ln) or "dirty"
        elif "=" in ln:
            k, _, v = ln.partition("=")
            fv = _norm_switch_value(v.strip())
            if (k.strip() in FEATURES or k.strip() in external) and fv:
                out["features"][k.strip()] = fv
            else:
                out["unknown"].append(ln)
        else:
            out["unknown"].append(ln)
    return out


def switch_state(env: Optional[dict[str, str]] = None) -> tuple[Optional[str], str]:
    """总闸状态（兼容 D60 调用面）。返回 (state|None, path)。分项见 switch_file()。"""
    sf = switch_file(env)
    return sf["master"], sf["path"]


def feature_status(name: str, env: Optional[dict[str, str]] = None) -> dict:
    """某子功能自身开关状态（不含总闸/熔断）。env > 文件行 > 默认开。

    外部档（ENV_ONLY_FEATURES，如 route）恒返回关——内核业务点不得据此行动；
    其文件行仍被 switch_file 解析、被 write_switch 保留（那是 JS 侧的领地）。
    """
    if name in ENV_ONLY_FEATURES:
        return {"enabled": False, "by": "外部档（JS 侧消费，内核不判）"}
    e = env if env is not None else _merged_env()
    ekey = "JEV_DISABLE_" + name.upper()
    ev = (e.get(ekey) or "").strip()
    if ev and ev not in ("0", "false"):
        return {"enabled": False, "by": f"env {ekey}"}
    if ev in ("0", "false"):
        return {"enabled": True, "by": f"env {ekey} 强制开"}
    fv = switch_file(e)["features"].get(name)
    if fv == "off":
        return {"enabled": False, "by": f"开关文件 {name}=off"}
    if fv == "on":
        return {"enabled": True, "by": f"开关文件 {name}=on"}
    return {"enabled": True, "by": "默认开"}


def feature_available(name: str) -> bool:
    """业务接入点唯一该问的函数：分项开关允许 且 总闸/Key/熔断都活着。"""
    if not feature_status(name)["enabled"]:
        return False
    return available()


def write_switch(master: Optional[str] = None, feature: Optional[str] = None,
                 state: Optional[str] = None) -> str:
    """落盘开关文件（保留既有总闸/其他分项行）。master/state ∈ "on"/"off"。返回路径。

    未知项（cur["unknown"]）原样回写——外部档行（如 route=off）若曾以脏值入 unknown，
    重写时也不许丢（2026-09-24 坑：`jev off light_semantic` 一圈把 route=off 剥掉）。
    """
    path = switch_path()
    cur = switch_file()
    m = cur["master"] if cur["master"] in ("on", "off") else "on"
    feats = dict(cur["features"])
    if master is not None:
        m = _norm_switch_value(master) or master
    if feature is not None:
        feats[feature] = _norm_switch_value(state or "on") or "on"
    lines = [m] + [f"{k}={v}" for k, v in sorted(feats.items())] + cur["unknown"]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def _num_ok(v: Optional[str]) -> bool:
    try:
        return v is not None and v != "" and float(v) > 0
    except ValueError:
        return False


def config() -> dict[str, Any]:
    env = _merged_env()
    env_flag = (env.get("JEV_DISABLE") or "").strip()
    sf = switch_file(env)
    fs, fpath = sf["master"], sf["path"]
    if env_flag and env_flag not in ("0", "false"):
        disabled, disabled_by = True, "env JEV_DISABLE"
    elif env_flag in ("0", "false"):
        disabled, disabled_by = False, "env JEV_DISABLE 强制开"
    elif fs == "off":
        disabled, disabled_by = True, f"开关文件 {fpath}"
    elif fs == "dirty":
        disabled, disabled_by = False, f"开关文件内容不可识别（按开处理）{fpath}"
    elif fs == "on":
        disabled, disabled_by = False, f"开关文件 {fpath}"
    else:
        disabled, disabled_by = False, "默认（无开关文件）"
    return {
        "base_url": (env.get("JEV_BASE_URL") or DEFAULTS["base_url"]).rstrip("/"),
        "model": env.get("JEV_MODEL") or DEFAULTS["model"],
        "timeout_s": (float(env["JEV_TIMEOUT_MS"]) / 1000 if _num_ok(env.get("JEV_TIMEOUT_MS")) else DEFAULTS["timeout_s"]),
        "conf_min": _f(env, "JEV_CONF_MIN", DEFAULTS["conf_min"]),
        "rel_keep": _f(env, "JEV_REL_KEEP", DEFAULTS["rel_keep"]),
        "disabled": disabled,
        "disabled_by": disabled_by,
        "switch_file": fpath,
        "switch_state": fs,
        "switch_unknown": sf["unknown"],
        "features": {name: feature_status(name, env) for name in FEATURES},
        "env": env,
    }


def api_key() -> str:
    """env JEV_API_KEY/TYPESAFE_API_KEY > JEV_KEY_FILE > <workspace>/jev-key.txt（口径=dsh-jev 插件）。"""
    global _KEY_MEMO, _KEY_SOURCE
    if _KEY_MEMO is not None:
        return _KEY_MEMO
    env = _merged_env()
    key = (env.get("JEV_API_KEY") or env.get("TYPESAFE_API_KEY") or "").strip()
    src = "env"
    if not key:
        candidates = [
            env.get("JEV_KEY_FILE") or "",
            os.path.join(paths.WORKSPACE, "dsh-jev", "jev-key.txt"),   # 2026-09-22 归拢后的正式位
            os.path.join(paths.WORKSPACE, "jev-key.txt"),                # 旧根目录位（兼容回退）
            os.path.join(paths.MEMORY_DECISION, "jev-key.txt"),
        ]
        for p in candidates:
            if p and os.path.isfile(p):
                try:
                    with open(p, encoding="utf-8") as fh:
                        v = fh.read().strip()
                    if v:
                        key, src = v, p
                        break
                except OSError:
                    continue
    _KEY_MEMO = key
    _KEY_SOURCE = src if key else ""
    return key


def reset_memo() -> None:
    """清 Key 缓存与熔断（测试/换 Key 用）。"""
    global _KEY_MEMO, _KEY_SOURCE
    _KEY_MEMO = None
    _KEY_SOURCE = ""
    _BREAKER["until"] = 0.0
    _BREAKER["err"] = ""


def available() -> bool:
    """通道是否可用（有 Key、未禁用、不在熔断窗口）。不发起网络。"""
    cfg = config()
    if cfg["disabled"] or not api_key():
        return False
    return time.time() >= _BREAKER["until"]


def last_error() -> str:
    return _BREAKER["err"]


# ---------------------------------------------------------------- 底层调用

def ask(
    state: str,
    questions: dict[str, dict],
    transport: Optional[Callable[[str, bytes, float], tuple[int, str]]] = None,
    force: bool = False,
) -> Optional[dict[str, dict]]:
    """一次请求、并行多问。成功返回 answers dict（{qid: {...}}）；任何失败返回 None。

    transport(url, body_bytes, timeout) → (status, text)：注入用（测试 stub 网络）。
    force=True：无视总闸与熔断直连（仅供 `cli.py jev test` 探上游用，业务链路禁用）。
    """
    cfg = config()
    if (cfg["disabled"] and not force) or not questions:
        return None
    key = api_key()
    if not key:
        return None
    if not force and time.time() < _BREAKER["until"]:
        return None

    names = list(questions.keys())[: 255]
    body = json.dumps(
        {
            "state": state[: cfg_state_max()],
            "model": cfg["model"],
            "questions": {n: questions[n] for n in names},
        },
        ensure_ascii=False,
    ).encode("utf-8")
    url = f"{cfg['base_url']}/v1/systemone"
    try:
        if transport is not None:
            status, text = transport(url, body, cfg["timeout_s"])
        else:
            req = urllib.request.Request(
                url,
                data=body,
                headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=cfg["timeout_s"]) as resp:
                    status, text = resp.status, resp.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                status, text = e.code, e.read().decode("utf-8", "replace")
        parsed = json.loads(text)
        if status < 200 or status >= 300:
            _trip(f"HTTP {status}")
            return None
        answers = parsed.get("answers")
        return answers if isinstance(answers, dict) else None
    except Exception as e:  # 网络/超时/JSON 解析——全静默，不阻断决策链
        _trip(f"{type(e).__name__}: {e}")
        return None


def cfg_state_max() -> int:
    return DEFAULTS["state_max"]


def _trip(err: str) -> None:
    _BREAKER["until"] = time.time() + DEFAULTS["breaker_s"]
    _BREAKER["err"] = err


def _chunked(state: str, questions: dict[str, dict]) -> Optional[dict[str, dict]]:
    """问题数超上限时分片调用；任一片失败即整体 None（回落上层慢通道）。"""
    names = list(questions.keys())
    size = DEFAULTS["chunk_questions"]
    if len(names) <= size:
        return ask(state, questions)
    out: dict[str, dict] = {}
    for i in range(0, len(names), size):
        part = {n: questions[n] for n in names[i : i + size]}
        r = ask(state, part)
        if r is None:
            return None
        out.update(r)
    return out


# ---------------------------------------------------------------- 高层封装

def judge_choice(
    state: str,
    instructions: str,
    options: dict[str, str],
) -> Optional[dict]:
    """单 choice 快判。返回 {choice, confidence, probabilities}；不可信不猜——失败/异常返回 None。"""
    if len(options) < 2:
        return None
    answers = _chunked(state, {"q": {"type": "choice", "instructions": instructions, "criteria": options}})
    if not answers:
        return None
    a = answers.get("q") or {}
    if not isinstance(a.get("choice"), str) or a["choice"] not in options:
        return None
    return {
        "choice": a["choice"],
        "confidence": float(a.get("confidence") or 0.0),
        "probabilities": a.get("probabilities") or {},
    }


def judge_choices(
    state: str,
    items: list[tuple[str, str, dict[str, str]]],
) -> Optional[dict[str, dict]]:
    """批量 choice（一问一对象，同一次请求并行）。items=[(qid, instructions, options)]。
    返回 {qid: {choice, confidence}}；qid 不在键中 = 该问不可判。整体失败 None。"""
    if not items:
        return {}
    questions = {qid: {"type": "choice", "instructions": ins, "criteria": opts} for qid, ins, opts in items}
    answers = _chunked(state, questions)
    if answers is None:
        return None
    out: dict[str, dict] = {}
    valid = {qid: set(opts) for qid, _, opts in items}
    for qid, a in answers.items():
        if qid in valid and isinstance(a.get("choice"), str) and a["choice"] in valid[qid]:
            out[qid] = {
                "choice": a["choice"],
                "confidence": float(a.get("confidence") or 0.0),
                "probabilities": a.get("probabilities") or {},
            }
    return out


def judge_relevance(
    state: str,
    items: list[tuple[str, str]],
) -> Optional[dict[str, float]]:
    """批量 noul 关联度快判。items=[(qid, instructions)]。
    返回 {qid: p_yes}（0~1，即关联概率）；整体失败 None。"""
    if not items:
        return {}
    questions = {qid: {"type": "noul", "instructions": ins} for qid, ins in items}
    answers = _chunked(state, questions)
    if answers is None:
        return None
    out: dict[str, float] = {}
    for qid, a in answers.items():
        if isinstance(a.get("noul"), (int, float)):
            out[qid] = max(0.0, min(1.0, float(a["noul"])))
    return out
