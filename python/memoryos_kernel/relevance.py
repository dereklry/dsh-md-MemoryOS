"""memoryos_kernel.relevance — 关联度三级漏斗。

设计原则（用户要求）：模糊关联度**不做硬算法**，硬信号只做全库初筛与排序，
语义判断交给 LLM（deepseek-harness）；无 key / LLM 失败自动降级为纯硬信号。

三级漏斗：
  ① hard_scores — 全库可算的硬信号（零依赖）：
       - text_sim: query 与元素名/别名/最近事件的中文 bigram Jaccard
       - link_hops: 链接图 BFS 跳数衰减（1跳×1.0, 2跳×0.5, 3跳×0.25）
       - co_occur: 与 query 元素事件的时间窗共现（±7 天）
       - cat_tag: 类别相同 + 标签 Jaccard
     hard = 0.40·text + 0.30·link + 0.20·co + 0.10·cat_tag
  ② 初筛 top-K → 候选集
  ③ 语义层两级（full 模式）：Jev 快判预筛（System One，并行 noul，2026-09-22 win 线接入）
     → 高分候选喂 llm_review 精评（System Two）；低分直接取 Jev p_yes；任一层缺席自动降下一级
     final = w_hard·hard + w_llm·llm   （full 模式 w=0.5/0.5；quick 模式只用 hard）
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta
from typing import Any, Optional

from . import jev
from .db import KernelDB

W_HARD, W_LLM = 0.5, 0.5
CO_WINDOW_DAYS = 7
SCHEMA_VER = "rel-v1"

_BIGRAM_RE = re.compile(r"[\u4e00-\u9fff]|[A-Za-z0-9]+")


def _bigrams(text: str) -> set[str]:
    """中文按字 + 英文/数字按 token，构建 bigram 集合。"""
    text = text.lower()
    tokens = _BIGRAM_RE.findall(text)
    flat = list(text.replace(" ", ""))
    out: set[str] = set()
    for i in range(len(flat) - 1):
        out.add(flat[i] + flat[i + 1])
    for t in tokens:
        if len(t) > 1:
            for i in range(len(t) - 1):
                out.add(t[i:i + 2])
    return out


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


def text_sim_score(query_text: str, profile: str) -> float:
    """query 视角命中率：|query bigram ∩ profile bigram| / |query bigram|。

    v0.6.3：聚合子树后 profile 变长，Jaccard 会稀释分数（分母随 profile 增长）；
    改用 precision——衡量"query 的内容在元素素材里覆盖了多少"，聚合只增不减。
    简称命中：'净利'⊂'净利润' 的前缀 bigram 可命中；'营收' vs '营业收入' 需别名登记，
    语义层（--full LLM 评审）兜底。
    """
    q = _bigrams(query_text)
    if not q:
        return 0.0
    p = _bigrams(profile)
    return len(q & p) / len(q)


def _aggregated_events(db: KernelDB, el: dict, per_child: int = 3, max_total: int = 60) -> list[dict]:
    """聚合事件：元素自身 + 子树事件（下层内容反应到上层，v0.6.3）。

    树化后数值事实挂在科目子元素上，父元素 profile 会变空——聚合子树
    事件让"中国平安"的召回素材包含"营收/净利"等科目内容。
    去重：同一 content 只保留一次（LLM/规则层可能同时挂父和子）。
    """
    evs = db.events_of(el["id"], status="", limit=per_child)
    seen = {e["content"] for e in evs}
    for n in db.element_tree(el["id"], max_depth=100):
        if n["id"] == el["id"]:
            continue
        for e in db.events_of(n["id"], status="", limit=per_child):
            if e["content"] not in seen:
                evs.append(e)
                seen.add(e["content"])
                if len(evs) >= max_total:
                    return evs
    return evs


def _element_profile(db: KernelDB, el: dict, recent: int = 3) -> str:
    # status="" 同时纳入 active 与 pending（pending=缺时间戳的现状描述，仍有语义价值）
    evs = _aggregated_events(db, el, per_child=recent)
    parts = [el["name"]] + db.aliases_of(el["id"])
    parts += [ev["content"] for ev in evs]
    return " ".join(parts)


def _ts_days(ts: str) -> Optional[int]:
    """YYYY-MM-DD → 距今天数（负=过去）。"""
    try:
        d = datetime.strptime(ts[:10], "%Y-%m-%d")
        return (d - datetime.now()).days
    except (ValueError, TypeError):
        return None


def hard_scores(db: KernelDB, query_text: str, query_element_ids: list[int], top_n: int = 30) -> list[dict]:
    """全库硬信号打分，返回按 hard 分降序的候选（含分解分）。"""
    q_bg = _bigrams(query_text)
    hops = db.neighbors(query_element_ids, max_hops=3) if query_element_ids else {}
    by_id = {el["id"]: el for el in db.all_elements()}

    # query 元素的时间集（用于共现，含子树）
    q_times: set[str] = set()
    for eid in query_element_ids:
        q_el = by_id.get(eid)
        if q_el:
            for ev in _aggregated_events(db, q_el, per_child=5, max_total=200):
                if ev["ts"]:
                    q_times.add(ev["ts"])

    rows = []
    for el in db.all_elements():
        if el["id"] in query_element_ids:
            continue
        # text_sim（含子树聚合）
        prof = _element_profile(db, el)
        text_sim = text_sim_score(query_text, prof)
        # link_hops
        hop = hops.get(el["id"])
        link_s = {1: 1.0, 2: 0.5, 3: 0.25}.get(hop, 0.0)
        # co_occur（含子树聚合）
        co = 0.0
        if q_times:
            hits = 0
            for ev in _aggregated_events(db, el, per_child=5, max_total=200):
                if ev["ts"] and ev["ts"] in q_times:
                    hits += 1
            co = min(1.0, hits / 3.0)
        # cat_tag：与任一 query 元素的类别/标签重合
        tags = set(json.loads(el["tags"]) if el["tags"] else [])
        same_cat = 0.0
        t_sim = 0.0
        for qid in query_element_ids:
            q_el = by_id.get(qid)
            if not q_el:
                continue
            if q_el["category"] == el["category"] and el["category"] not in ("generic",):
                same_cat = 1.0
            q_tags = set(json.loads(q_el["tags"]) if q_el["tags"] else [])
            t_sim = max(t_sim, jaccard(tags, q_tags))
        cat_tag = 0.3 * same_cat + 0.7 * t_sim

        hard = 0.40 * text_sim + 0.30 * link_s + 0.20 * co + 0.10 * cat_tag
        rows.append(
            {
                "id": el["id"],
                "name": el["name"],
                "category": el["category"],
                "hard": round(hard, 4),
                "components": {
                    "text_sim": round(text_sim, 4),
                    "link_hops": hop,
                    "link_s": link_s,
                    "co_occur": round(co, 4),
                    "cat_tag": round(cat_tag, 4),
                },
            }
        )
    rows.sort(key=lambda r: r["hard"], reverse=True)
    return rows[:top_n]


# ------------------------------------------------------------- LLM 语义评审
SYSTEM_REVIEW = """你是关联度评审员。给定一个决策问题与候选元素清单，判断每个候选与问题的**语义关联度**（模糊关联，不是字面匹配）。

只输出 JSON，格式：
{"candidates":[{"index":1,"relation":"关联关系一句话","direction":"A影响B|B影响A|双向|无","strength":0.0到1.0,"reason":"判断依据"}]}

规则：
- strength 表示该元素对回答此问题的相关程度：0=无关, 0.5=弱相关, 0.8=强相关, 1.0=直接相关
- direction 指问题主体与元素之间的影响方向
- 不要臆造候选清单之外的元素，index 必须对应输入的编号"""


def llm_review(
    db: KernelDB,
    client: Any,
    query_text: str,
    candidates: list[dict],
    model: str = "deepseek-v4-flash",
    use_cache: bool = True,
) -> dict[int, dict]:
    """LLM 语义评审候选集。返回 {元素id: {strength, relation, direction, reason}}。失败→空。"""
    if not candidates:
        return {}
    lines = []
    for i, c in enumerate(candidates, 1):
        el = db.element_by_id(c["id"])
        prof = _element_profile(db, el, recent=3) if el else c["name"]
        lines.append(f"{i}. {c['name']}（{c['category']}）: {prof[:300]}")
    prompt = f"决策问题：{query_text}\n\n候选元素：\n" + "\n".join(lines)
    key = hashlib.sha256((SCHEMA_VER + "|" + model + "|" + prompt).encode()).hexdigest()

    if use_cache:
        cached = db.cache_get(key)
        if cached:
            try:
                data = json.loads(cached)
                return _parse_review(data, candidates)
            except (ValueError, TypeError):
                pass

    try:
        resp = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_REVIEW},
                {"role": "user", "content": prompt[:8000]},
            ],
        )
        content = (resp["message"].get("content") or "").strip()
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
        if m:
            content = m.group(1)
        data = json.loads(content)
        parsed = _parse_review(data, candidates)
        if parsed and use_cache:
            db.cache_set(key, model, SCHEMA_VER, json.dumps(data, ensure_ascii=False))
        return parsed
    except Exception:
        return {}


def _parse_review(data: dict, candidates: list[dict]) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for item in data.get("candidates", []):
        idx = int(item.get("index", 0))
        if not (1 <= idx <= len(candidates)):
            continue
        cid = candidates[idx - 1]["id"]
        strength = float(item.get("strength") or 0.0)
        out[cid] = {
            "strength": max(0.0, min(1.0, strength)),
            "relation": str(item.get("relation") or ""),
            "direction": str(item.get("direction") or ""),
            "reason": str(item.get("reason") or ""),
            "via": "llm",
        }
    return out


# ------------------------------------------------------------- Jev 快判预筛
def jev_relevance(db: KernelDB, query_text: str, candidates: list[dict]) -> dict[int, dict]:
    """Jev（System One）批量关联度快判：一问一候选、单次请求并行 noul。

    返回 {元素id: {strength=p_yes, ...}}（形状对齐 llm_review 输出，via="jev"）；
    分项闸关/不可用/失败 → {}（上层按原路径走慢 LLM 或纯硬信号，行为与接入前一致）。
    p_yes 即"该候选与决策问题有语义关联"的校准概率——低分候选由此挡在慢 LLM 之外。
    """
    if not candidates or not jev.feature_available("relevance"):
        return {}
    lines = []
    for i, c in enumerate(candidates, 1):
        el = db.element_by_id(c["id"])
        prof = _element_profile(db, el, recent=3) if el else c["name"]
        lines.append(f"{i}. {c['name']} ({c['category']}): {prof[:200]}")
    state = (
        f"Decision question: {query_text}\n"
        "Candidate elements (index. name (category): material summary):\n" + "\n".join(lines)
    )
    items = [
        (
            str(i),
            f"Does candidate {i} (\"{c['name']}\") have a genuine semantic relation to the decision "
            "question — could its material plausibly help answer it? Answer no only if clearly unrelated.",
        )
        for i, c in enumerate(candidates, 1)
    ]
    probs = jev.judge_relevance(state, items)
    if probs is None:
        return {}
    out: dict[int, dict] = {}
    for i, c in enumerate(candidates, 1):
        p = probs.get(str(i))
        if p is None:
            continue
        out[c["id"]] = {
            "strength": p,
            "relation": "Jev 快判（System One）",
            "direction": "",
            "reason": f"p_yes={p:.2f}",
            "via": "jev",
        }
    return out


# ------------------------------------------------------------- 综合排序
def rank(
    db: KernelDB,
    query_text: str,
    query_element_ids: list[int],
    client: Any = None,
    mode: str = "quick",
    top_n: int = 10,
    model: str = "deepseek-v4-flash",
) -> dict:
    """三级漏斗综合排序。mode: quick(纯硬信号) / full(硬信号→Jev 快判→慢 LLM 精评)。

    full 模式语义层分层（2026-09-22 win 线，Jev 接入）：
      - Jev 可用：全候选并行 noul 预筛；p_yes≥JEV_REL_KEEP 的喂慢 LLM 精评（省 token），
        低分候选直接取 strength=p_yes；LLM 缺席/漏评的候选用 Jev 分补位。
      - Jev 不可用：与接入前一致（有 client 全量喂 LLM；没有就纯硬信号）。
    """
    cands = hard_scores(db, query_text, query_element_ids, top_n=top_n * 3)
    review_pool = cands[: top_n * 2]
    llm_map: dict[int, dict] = {}
    jev_used = False
    if mode == "full":
        jev_map = jev_relevance(db, query_text, review_pool)
        jev_used = bool(jev_map)
        keep = jev.config()["rel_keep"] if jev_map else 0.0
        if client is not None:
            pool = [c for c in review_pool if jev_map.get(c["id"], {}).get("strength", 1.0) >= keep]
            llm_map = llm_review(db, client, query_text, pool, model=model)
        if jev_map:
            for c in review_pool:
                if c["id"] not in llm_map:
                    llm_map[c["id"]] = jev_map[c["id"]]

    results = []
    for c in cands[:top_n]:
        cid = c["id"]
        llm = llm_map.get(cid)
        if llm is not None:
            final = W_HARD * c["hard"] + W_LLM * llm["strength"]
        else:
            final = c["hard"]
        results.append(
            {
                "id": cid,
                "name": c["name"],
                "category": c["category"],
                "score": round(final, 4),
                "hard": c["hard"],
                "llm": llm,
                "components": c["components"],
            }
        )
    results.sort(key=lambda r: r["score"], reverse=True)
    return {
        "query": query_text,
        "mode": mode,
        "llm_used": any(v.get("via") == "llm" for v in llm_map.values()),
        "jev_used": jev_used,
        "results": results,
    }
