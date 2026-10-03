"""memoryos_kernel.extract — 对话/文本 → 元素 + 带时间戳事件 + 关联边。

两级抽取：
  1. 规则层（零依赖，无 key 也能跑）：
     - 时间解析：ISO / YYYY-MM-DD / YYYY年M月D日 / M月D日(当年) / 今天/昨天/前天/N天前
     - 候选元素：已知元素名/别名命中 + 6 位数字（A股代码）+ 中英文 token
     - 事件候选：含时间的句子，归属句中出现的元素
  2. LLM 层（有 DEEPSEEK_API_KEY 时，deepseek-harness）：
     - 让模型输出结构化 JSON：{elements, events, links}，语义抽取更准
     - 失败/无 key 自动降级到规则层（绝不因 LLM 失败而中断入库）

铁律：无时间属性的事件 → ts='' 且 status='pending'（待定区），不伪造时间。

v0.7.19（2026-09-01，用户规则）：**已知话题保守模式**——若话题只涉及 1-2 个【已有元素】
（manual_elements 全部命中已有元素且 ≤2），则不新建元素、未知名/子概念一律挂到主元素、
links 只在已知元素间建；真正的新元素不落库、只作为待确认候选返回（elements_deferred），
由调用方（Agent）向用户确认后再建。避免"已知话题被概念碎片污染"。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Any, Optional

from .db import KernelDB

# ------------------------------------------------------------- 时间解析
_YMD = re.compile(r"(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)")
_YMD_CN = re.compile(r"(?<!\d)(\d{4})年(\d{1,2})月(\d{1,2})日?")
_MD_CN = re.compile(r"(?<!\d)(\d{1,2})月(\d{1,2})日")
_REL = re.compile(r"(今天|昨天|前天|(\d+)天前|(\d+)周前)")
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")

_KNOWN_DATE_WORDS = ("今天", "昨天", "前天", "日", "月", "年", "天前", "周前")


def parse_time(text: str, now: Optional[datetime] = None) -> Optional[str]:
    """从文本中提取最早出现的日期，归一化为 YYYY-MM-DD。找不到返回 None。"""
    now = now or datetime.now()
    m = _ISO.search(text)
    if m:
        return m.group(0)[:10]
    m = _YMD.search(text)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = _YMD_CN.search(text)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = _MD_CN.search(text)
    if m:
        return f"{now.year}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    m = _REL.search(text)
    if not m:
        return None
    if m.group(1) == "今天":
        return now.date().isoformat()
    if m.group(1) == "昨天":
        return (now.date() - timedelta(days=1)).isoformat()
    if m.group(1) == "前天":
        return (now.date() - timedelta(days=2)).isoformat()
    if m.group(2):
        return (now.date() - timedelta(days=int(m.group(2)))).isoformat()
    if m.group(3):
        return (now.date() - timedelta(weeks=int(m.group(3)))).isoformat()
    return None


def has_time_marker(text: str) -> bool:
    return any(w in text for w in _KNOWN_DATE_WORDS) or bool(_ISO.search(text))


# ------------------------------------------------------------- 句子切分
def split_sentences(text: str) -> list[str]:
    parts = re.split(r"[。！？；!?;\n]+", text)
    return [p.strip() for p in parts if p.strip()]


# ------------------------------------------------------------- 元素候选
def _known_hits(db: KernelDB, text: str) -> list[dict]:
    hits = []
    for el in db.all_elements():
        names = [el["name"]] + db.aliases_of(el["id"])
        for nm in names:
            if nm and nm in text:
                hits.append(el)
                break
    return hits


def candidate_elements(text: str, db: Optional[KernelDB] = None) -> list[str]:
    """规则层候选元素：已知元素命中 + A股代码 + 英文/数字 token。"""
    cands: list[str] = []
    if db:
        cands += [el["name"] for el in _known_hits(db, text)]
    # A股代码（6 位数字）
    cands += re.findall(r"(?<!\d)\d{6}(?!\d)", text)
    # 英文 token（≥3 字母）
    cands += [w for w in re.findall(r"[A-Za-z][A-Za-z0-9._-]{2,}", text)]
    return list(dict.fromkeys(cands))


# ------------------------------------------------------------- 规则层抽取
def rule_extract(db: KernelDB, text: str, source: str = "", manual_elements: Optional[list[str]] = None) -> dict:
    """规则层：时间句子 → (元素, 事件)。返回 {elements, events, links}。

    manual_elements：调用方（Agent）显式指出的实体名——Agent 本身是 LLM，
    能识别中文实体，把名字传进来即可挂事件；6 位 A股代码自动识别建档。
    """
    out: dict[str, list] = {"elements": [], "events": [], "links": []}
    manual = [m.strip() for m in (manual_elements or []) if m.strip()]
    known = {el["name"]: el for el in _known_hits(db, text)}
    for name in manual:
        el = db.find_element(name)
        known[name if not el else el["name"]] = el or {"name": name}
    for sent in split_sentences(text):
        ts = parse_time(sent)
        els: list[dict] = []
        seen: set[str] = set()
        for name, el in known.items():
            if name and name in sent:
                els.append(el)
                seen.add(name)
        for code in re.findall(r"(?<!\d)\d{6}(?!\d)", sent):
            if code not in seen:
                els.append({"name": code})
                seen.add(code)
        if not els:
            continue
        for el in els:
            out["events"].append(
                {
                    "element": el["name"],
                    "ts": ts or "",
                    "content": sent,
                    "raw": sent,
                    "ts_source": "explicit" if ts else "empty",
                    "status": "active" if ts else "pending",
                }
            )
    return out


# ------------------------------------------------------------- LLM 增强层
SYSTEM_EXTRACT = """你是信息抽取引擎。从对话文本中抽取结构化事实，只输出 JSON，不要输出其他内容。

规则：
1. elements：出现的重要实体（人/公司/标的/主题/指标/策略/项目等），name 用规范名，aliases 给别名（中文简称/别称），category 取 {stock, company, person, topic, metric, strategy, project, report, statement, event, generic, **viewpoint**}，tags 给 2-5 个标签。**只建名词性实体**：版本号（v0.7）、命令/参数（--data-root）、路径、统计量（37段/80个/91条）都不是实体，绝不建元素——它们只作为事件内容存在。
2. **观点/想法类**（v0.7.5）：用户表达**观点、判断、想法、认知**（如"网格适合震荡市""我修正了看法""想通了某件事"）→ 建 **viewpoint 类元素**（概念=决策条件，与事实同等管理）。观点元素的事件流承载**演化**：
   - 新观点/首次表达 → 事件 status=active；
   - **修正/推翻旧观点** → 旧事件标 status=expired（保留留痕），新事件 status=active，content 注明"修正"；
   - **方向相反的新认知**（观点差异大）→ 可另建 viewpoint 元素，并与旧观点元素 links 连接 relation="对立"/"修正"（带 reason）；
   - 判断"是否修正/对立"是语义判断，由你根据对话上下文决定（AI 引擎的作用点：理解用户想法是否变迁）。
   - **叙事演化组织**（v0.7.5）：若 manual_elements 传入了叙事主体（如"我的交易方法"），**时间演化事件挂到该主体元素**（其时间线=完整演化史：信息范围→方法→验证→当前认知）；出现的子概念（具体方法/工具如 股息率/PB-ROE/网格）建为独立元素但**不重复挂同一演化事件**，用 links（"包含"/"验证"）关联即可。
   - **共享概念/公式作为独立可关联节点**（v0.7.18）：**跨元素复用的概念/公式/数学口径**（如成本计算、MIRR、某个口径定义，被多个标的/账户共用）——**作为独立元素/节点（category 用 "topic" 或 "strategy"）**，而非只挂单个宿主元素的 knowledge 事件；多个使用它的元素用 links relation="使用"/"引用" 关联到该节点。它是"基础数学/通用口径"（heuristic：任何账户/标的算同一指标都从这一处取公式），不重复写进每个元素。仅对真正跨元素复用的这么做；单元素专属理解仍挂宿主 knowledge 事件。
2. **父子/归宿关系**（v0.5.1）：如果实体间存在明确的"归属/组成"关系（公司→报告期→科目、学生→班级、股票→板块），元素上加 parents 字段（数组，每项 {"name","role"}，第一个为主归属）。只给关系明确的，不要臆造。
3. events：每个带时间属性的关键事实一条。
   - **ts 只接受两种**：(a) 文本中明确写出的日期（归一化 YYYY-MM-DD）；(b) 由当前日期换算的相对时间（今天/昨天/本周/今年等）。
   - **禁止猜测无依据的年份**：文本只说"8月16日"没给年份 → 按当前日期所在年份处理；时间完全无法确定 → ts 留空字符串，status="pending"。
   - **raw**：该事实对应的**原文片段**（原文中哪句话），必须原样引用，不加工——用于事后复核。
   - content：一句话事实（可精炼改写），数值事实尽量挂到最具体的子元素（如"营收706亿"挂"营业收入"而非公司）。
4. links：实体间的**语义关联**（跨结构的，如 影响/针对/受益/交易标的/发布/报告指标）。**每条必须带 reason（关联理由）**——为什么相关（如"光伏ETF成分股含硅料厂商，硅料价格传导至ETF净值"）；给不出理由的不要建（归属/组成关系走 parents，不建 link）。
   - **共享概念/公式被多元素复用**（v0.7.18）：当某个**可复用的概念/公式/计算逻辑/数学口径**（如"成本用券商公式 C=(B-S)/s"、"1签=500股=0.5万市值"、MIRR/估值公式）被**多个元素引用**时，把该概念作为一个**独立可关联节点**（category 复用 "topic"/"strategy" 类），**不要重复写进每个元素**——各使用它的元素用 **links relation="使用"（或"引用"/"依据"）** 关联到该概念节点（每条带 reason：为什么用这个公式/口径）。它本质上是一处定义、多处引用的共享数学基础，不是某个元素专属。只对**真正跨元素复用**的概念这么做；单元素专属的理解仍按知识事件挂宿主。
5. status 只允许: active（有时间）/ pending（无时间）；不要输出其他值。
6. 只输出 JSON：{"elements":[{"name","aliases","category","tags","parents":[{"name","role"}]}],"events":[{"element","ts","content","raw","status"}],"links":[{"from","to","relation","strength","reason"}]}"""


def _repair_json(content: str) -> Optional[dict]:
    """LLM 输出容错解析（2026-09-18 semantica ①吸收，参考其 providers.py:120-180）。

    依次尝试：直接 loads → 截取首尾 {...} → 去 trailing comma → 组合；
    全救不回返回 None（由调用方降级规则层）。纯文本处理，无副作用。
    """
    import re as _re
    for cand in (content, None):  # None 标记"截取大括号体"
        s = content if cand is not None else ""
        if cand is None:
            i, j = content.find("{"), content.rfind("}")
            if i < 0 or j <= i:
                continue
            s = content[i:j + 1]
        for variant in (s, _re.sub(r",\s*([}\]])", r"\1", s)):  # 修 trailing comma
            try:
                data = json.loads(variant)
                if isinstance(data, dict):
                    return data
            except ValueError:
                continue
    return None


def llm_extract(client: Any, text: str, source: str = "", model: str = "deepseek-v4-flash") -> Optional[dict]:
    """用 deepseek-harness 抽取。失败返回 None（由调用方降级）。"""
    today = datetime.now().strftime("%Y-%m-%d")
    try:
        resp = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_EXTRACT},
                {"role": "user", "content": f"当前日期：{today}\nsource: {source}\n\n{text[:8000]}"},
            ],
        )
        content = resp["message"].get("content") or ""
        content = content.strip()
        # 去掉可能的 ```json 围栏
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
        if m:
            content = m.group(1)
        data = json.loads(content)
        if not isinstance(data, dict):
            return None
        return data
    except Exception:
        # v0.7.20：loads 失败先走容错修复，救回则免整批降级规则层
        try:
            return _repair_json(content)
        except Exception:
            return None


# ------------------------------------------------------------- 入库（幂等）
def _parse_strength(v: Any, default: float = 0.5) -> float:
    """LLM 输出容错：strength 可能是数字('0.8')或文字('high'/'强')。"""
    try:
        s = float(v)
        return max(0.0, min(1.0, s))
    except (TypeError, ValueError):
        if isinstance(v, str):
            m = {"high": 0.9, "strong": 0.9, "强": 0.9, "medium": 0.6,
                 "中": 0.6, "weak": 0.3, "low": 0.3, "弱": 0.3}
            return m.get(v.strip().lower(), default)
        return default


# 概念名启发式（v0.7.1）：LLM 可能把统计/版本/命令/修饰短语当实体 → 建档前过滤
_CONCEPT_PATTERNS = [
    # v0.7.4（用户修正）：只拦"纯统计噪音"——版本号/统计量/命令参数。
    # 领域概念（理解）不在此列：决策条件=事实+理解，概念（如"双库分离""网格适合震荡市"）
    # 是决策依据，必须能建元素（曾误拦"测试|生产|双库|分离"等概念短语，已删除该规则）。
    re.compile(r"^[vV]\d+(\.\d+)*$"),              # v0.7 / V5.4 / v1.2.3（版本号必须带 v 前缀）
    re.compile(r"^\d+\.\d+(\.\d+)*$"),             # 0.7 / 1.2.3（带小数点）
    re.compile(r"^[vV]\d+(\.\d+)*(版本|版|阶段|代)?$"),  # v0.7版本 / V5.4代
    re.compile(r"^\d+\.\d+(\.\d+)*(版本|版|阶段|代)?$"),
    re.compile(r"^\d+[段个条份次项元%]"),           # 37段 / 80个 / 91条
    re.compile(r"^\d+(项目|元素|事件|产出物|链接)"),  # 23项目 / 24元素
    re.compile(r"^[a-z-]+data-root$", re.I),     # data-root 参数
    re.compile(r"^--?[a-z-]+$"),                 # --xxx 命令行参数
]
_CONCEPT_SUBSTR = ["版本号"]


def _is_concept_name(name: str, extra_patterns=None) -> bool:
    """判断名字是否为纯概念（非实体），是则不应建元素。

    v0.7.2：**股票代码保护**——6 位纯数字（A股/ETF 代码，如 601318/515790）放行，
    绝不拦截；版本号必须带 v 前缀或小数点（避免与代码混淆）。
    v0.7.3：支持用户追加规则（extra_patterns: list[str]），存于 SQLite kv，filter 命令管理。
    """
    name = (name or "").strip()
    if not name or len(name) > 24:
        return False
    # 股票代码保护：6 位纯数字 = A股/ETF 代码 → 放行
    if re.match(r"^\d{6}$", name):
        return False
    for pat in _CONCEPT_PATTERNS:
        if pat.match(name):
            return True
    for pat in (extra_patterns or []):
        try:
            if re.compile(pat).match(name):
                return True
        except re.error:
            continue
    for sub in _CONCEPT_SUBSTR:
        if sub in name and len(name) <= 12:
            return True
    return False


def load_extra_patterns(db) -> list[str]:
    """从 kv 读用户追加的拦截规则（JSON 数组）。"""
    import json as _j

    raw = db.kv_get("filter.extra_patterns")
    try:
        v = _j.loads(raw) if raw else []
        return [str(x) for x in v] if isinstance(v, list) else []
    except (ValueError, TypeError):
        return []


def ingest(
    db: KernelDB, text: str, source: str = "", client: Any = None,
    model: str = "deepseek-v4-flash", manual_elements: Optional[list[str]] = None,
) -> dict:
    """抽取并入库，返回统计。LLM 可用则优先，失败自动降级规则层。"""
    stats = {"elements_new": 0, "events_new": 0, "links_new": 0, "llm": False}
    # manual_elements 可能是逗号分隔字符串（CLI）或 list（库调用），统一为 list
    if isinstance(manual_elements, str):
        manual_elements = [m.strip() for m in manual_elements.split(",") if m.strip()]
    data = llm_extract(client, text, source, model) if client else None
    if data is not None:
        stats["llm"] = True
    else:
        # v0.7.20 降级计数（观测先行）：每次整批落到规则层记一笔，月度可查真实降级率
        try:
            n = int(db.kv_get("stats.extract_fallback") or "0") + 1
            db.kv_set("stats.extract_fallback", str(n))
            stats["fallback_count_total"] = n
        except Exception:
            pass
        data = rule_extract(db, text, source, manual_elements)

    extra = load_extra_patterns(db)  # v0.7.3 用户追加拦截规则

    # ---- 用户规则（2026-09-01，v0.7.19）：已知话题不碎片化 ----
    # 若话题只涉及 1-2 个【已有元素】，则只按已知元素归类：不新建元素；
    # 未知名/子概念（采购/LIFO/买入区/归母净利润/年化22.4% 等）一律挂到主元素
    # （primary = manual_elements 第一个，Agent 显式传入的可信已知实体），不独立建档。
    # 真正的新元素（名称不在已知集）不落库、只标记为待确认候选（elements_deferred），
    # 由调用方（Agent）向用户确认后再建——避免"已知话题被概念碎片污染"。
    manual = [m.strip() for m in (manual_elements or []) if m.strip()]
    known: dict[str, dict] = {}
    for _el in db.all_elements():
        known[_el["name"]] = _el
        for _a in db.aliases_of(_el["id"]):
            known.setdefault(_a, _el)
    known_scoped = bool(manual) and len(manual) <= 2 and all(known.get(m) for m in manual)
    stats["elements_deferred"] = []
    primary_el = known.get(manual[0]) if (known_scoped and manual) else None

    for el in data.get("elements", []):
        # v0.7.1：概念名不建元素（LLM 可能把统计/版本/命令/修饰短语当实体）
        if _is_concept_name(el["name"], extra):
            continue
        if known_scoped and el["name"] not in known:
            # 已知话题：不新建元素，仅标记为待确认候选（交由用户确认）
            stats["elements_deferred"].append(el["name"])
            continue
        eid, created = db.upsert_element(
            name=el["name"],
            aliases=el.get("aliases") or [],
            category=el.get("category") or "generic",
            tags=el.get("tags") or [],
        )
        if created:
            stats["elements_new"] += 1
        # 父子/归宿关系（v0.5.1）：parents 数组 → 主归属 + memberships 多父
        parents = el.get("parents") or []
        for i, pr in enumerate(parents):
            pname = pr.get("name") if isinstance(pr, dict) else pr
            if not pname:
                continue
            p = db.find_element(pname)
            if not p:
                _, _ = db.upsert_element(name=pname, category="generic",
                                         meta={"note": "auto-created as parent"})
                p = db.find_element(pname)
            if p["id"] == eid:
                continue
            role = pr.get("role", "member") if isinstance(pr, dict) else "member"
            if i == 0:
                db.set_parent(eid, p["id"])
            else:
                db.attach_parent(eid, p["id"], role=role)

    # 规则层的事件里 element 是名字，先映射
    by_name = {el["name"]: el for el in db.all_elements()}
    now = datetime.now()
    for ev in data.get("events", []):
        el = by_name.get(ev["element"])
        if not el:
            if known_scoped:
                # 已知话题：未知名（含子概念）一律挂到主元素，不新建
                el = primary_el
                if not el:
                    continue
            elif _is_concept_name(ev["element"], extra):
                # v0.7.1：概念名事件不建档（内容仍有价值，挂到"待归类"或跳过建档）
                # 挂到父级：primary（manual_elements 第一个，Agent 显式传的可信实体）；
                # primary 不存在则自动建档（保证内容不丢）
                primary = manual_elements[0] if manual_elements else ""
                el = by_name.get(primary) or (db.find_element(primary) if primary else None)
                if not el and primary:
                    eid, _ = db.upsert_element(name=primary, category="generic",
                                               meta={"note": "primary of concept events"})
                    el = db.find_element(primary)
                    by_name[primary] = el
                if not el:
                    continue
            else:
                # 未知元素自动建档（generic）
                eid, _ = db.upsert_element(name=ev["element"], category="generic")
                el = db.find_element(ev["element"])
                by_name[el["name"]] = el
        # v0.6 时间可信度：LLM 推断年份不可信 → 规则层二次校验
        ts = ev.get("ts") or ""
        raw = ev.get("raw") or ev.get("content") or ""
        ts_source = ev.get("ts_source") or ""
        if ts and ts_source != "explicit":
            rule_ts = parse_time(raw, now)
            if rule_ts:
                # 规则层解析出更可信的时间（含当前年份换算）→ 以规则层为准
                ts, ts_source = rule_ts, "rule"
            else:
                # LLM 推断但规则层无法复核 → 标注 llm 推断，供复核
                ts_source = "llm"
        # status 白名单：LLM 可能输出非法值（如 confirmed）→ 按 ts 有无重设
        status = ev.get("status") or ""
        if status not in ("active", "expired", "pending"):
            status = "active" if ts else "pending"
        _, inserted = db.add_event(
            element_id=el["id"],
            content=ev["content"],
            ts=ts,
            source=source,
            raw=raw,
            ts_source=ts_source,
            status=status,
        )
        if inserted:
            stats["events_new"] += 1

    for lk in data.get("links", []):
        # v0.6.5：关联必须带理由（reason），无理由不建（避免无据边污染图谱）
        reason = (lk.get("reason") or "").strip()
        if not reason:
            continue
        if known_scoped and (lk["from"] not in known or lk["to"] not in known):
            # 已知话题：links 只在已知元素间建（不引向未建立的新节点，避免碎片点）
            continue
        a = by_name.get(lk["from"]) or known.get(lk["from"]) or db.find_element(lk["from"])
        b = by_name.get(lk["to"]) or known.get(lk["to"]) or db.find_element(lk["to"])
        if not a:
            _, _ = db.upsert_element(name=lk["from"], category="generic")
            a = db.find_element(lk["from"])
            by_name[a["name"]] = a
        if not b:
            _, _ = db.upsert_element(name=lk["to"], category="generic")
            b = db.find_element(lk["to"])
            by_name[b["name"]] = b
        _, created = db.upsert_link(
            a["id"], b["id"],
            relation=lk.get("relation") or "related",
            strength=_parse_strength(lk.get("strength")),
            method="llm" if stats["llm"] else "hard",
            evidence=f"{reason}（来源:{source}）",
        )
        if created:
            stats["links_new"] += 1

    return stats
