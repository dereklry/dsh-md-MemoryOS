"""memoryos_kernel.resolve — 实体消解器（中文简称/别名歧义处理）。

设计（用户确认的原则）：**代码无法做到的语境判断，交给 LLM/Agent**。
代码只做候选制匹配与硬信号预筛，最终"简称指谁"由语境决定：
  1. find_elements_by_token → 候选列表（name 精确/alias 精确/子串）
  2. 唯一候选 → 直接返回
  3. 多候选 → 硬信号预筛：当前语境（话题缓冲/query）已提及的元素优先
  4. 仍有歧义 → Jev 快判（System One choice，2026-09-22 win 线）：置信不足/不可用则 ↓
  5. 慢 LLM 消解：候选(类别+最近事件) + 语境原文 → 选一个 + confidence
  6. 无 key / LLM 失败 / 平局 → 返回歧义列表，由 Agent 按对话上下文定夺（绝不静默选错）
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from . import jev
from .db import KernelDB

SYSTEM_RESOLVE = """你是实体消解器。用户在对话里用了简称/别名，需要从候选中选出真正指代的对象。

规则：
- 只根据**语境**和候选元素的信息判断，不臆造候选之外的元素
- 输出 JSON：{"element":"候选名","confidence":0.0到1.0,"reason":"判断依据（引用语境里的线索）"}
- 语境线索不足、无法判断时：{"element":null,"confidence":0,"reason":"语境不足"}
- element 必须严格等于候选清单中的某个 name"""


def _element_card(db: KernelDB, el: dict, max_events: int = 2) -> str:
    evs = db.events_of(el["id"], status="", limit=max_events)
    parts = [el["name"], f"类别:{el['category']}"]
    try:
        tags = json.loads(el["tags"])
        if tags:
            parts.append(f"标签:{','.join(tags)}")
    except (TypeError, ValueError):
        pass
    for e in evs:
        parts.append(f"[{e['ts'] or '待定'}] {e['content'][:60]}")
    return " ".join(parts)


def hard_resolve(db: KernelDB, token: str, context_text: str = "") -> dict:
    """硬信号预筛：语境提及优先 → 唯一候选。返回 {element, candidates, decided}。"""
    cands = db.find_elements_by_token(token)
    if not cands:
        return {"element": None, "candidates": [], "decided": False, "reason": "no_match"}
    if len(cands) == 1:
        return {"element": cands[0], "candidates": cands, "decided": True, "reason": "unique"}

    # 精确命中优先（v0.6）：name 精确(1.0) 唯一 → 无条件直判；alias 精确(0.9) 唯一 → 直判。
    # 只有同层精确多候选才是真歧义，才进语境/LLM。修复：光伏ETF 被 alias 碎片抢走的问题。
    name_exacts = [c for c in cands if c["match"] == "exact"]
    if len(name_exacts) == 1:
        return {"element": name_exacts[0], "candidates": cands, "decided": True, "reason": "name_exact"}
    if len(name_exacts) > 1:
        cands = name_exacts
    else:
        alias_exacts = [c for c in cands if c["match"] == "alias"]
        if len(alias_exacts) == 1:
            return {"element": alias_exacts[0], "candidates": cands, "decided": True, "reason": "alias_exact"}
        if len(alias_exacts) > 1:
            cands = alias_exacts  # 多个 alias 精确（真歧义）→ 语境/LLM

    # 权重显著差距（精确 vs 子串误伤）：直接取最高，无需 LLM
    if cands[0]["weight"] - cands[1]["weight"] >= 0.3:
        return {"element": cands[0], "candidates": cands, "decided": True, "reason": "weight_gap"}

    # 语境提及优先：候选的 name/别名 出现在语境文本中的
    if context_text:
        ctx_hits = []
        for c in cands:
            names = [c["name"]] + db.aliases_of(c["id"])
            if any(nm and nm in context_text for nm in names):
                ctx_hits.append(c)
        if len(ctx_hits) == 1:
            return {"element": ctx_hits[0], "candidates": cands, "decided": True, "reason": "context_hit"}
        if len(ctx_hits) > 1:
            cands = ctx_hits  # 语境里都出现过，缩小范围继续

    # 活跃度兜底：候选都无语境线索时，按事件数/最新事件排序给最可能
    def act(c):
        evs = db.events_of(c["id"], status="", limit=1)
        return (len(db.events_of(c["id"], status="", limit=100)), evs[0]["ts"] if evs else "")
    cands = sorted(cands, key=act, reverse=True)
    return {"element": None, "candidates": cands, "decided": False, "reason": "ambiguous"}


def llm_resolve(
    db: KernelDB,
    client: Any,
    token: str,
    context_text: str,
    candidates: list[dict],
    model: str = "deepseek-v4-flash",
) -> Optional[dict]:
    """LLM 语境消解。失败返回 None。"""
    lines = [f"{i}. {_element_card(db, c)}" for i, c in enumerate(candidates, 1)]
    prompt = f"简称：{token}\n语境：{context_text or '（无额外语境）'}\n候选：\n" + "\n".join(lines)
    try:
        resp = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_RESOLVE},
                {"role": "user", "content": prompt[:6000]},
            ],
        )
        content = (resp["message"].get("content") or "").strip()
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
        if m:
            content = m.group(1)
        data = json.loads(content)
        name = data.get("element")
        if not name:
            return None
        for c in candidates:
            if c["name"] == name:
                return {
                    "element": c,
                    "confidence": float(data.get("confidence") or 0.0),
                    "reason": str(data.get("reason") or ""),
                }
        return None
    except Exception:
        return None


def jev_resolve(
    db: KernelDB,
    token: str,
    context_text: str,
    candidates: list[dict],
) -> Optional[dict]:
    """Jev（System One）快判消歧：一次 choice，多一个"都不对"选项防硬选。

    返回 {element, confidence, reason} 或 None（分项闸关/不可用/选"都不对"/置信不足）。
    措辞英文为主（官方：中文准确率较低），候选卡仍用库内原文。
    """
    if not jev.feature_available("resolve") or len(candidates) < 2:
        return None
    lines = [f"{i}. {_element_card(db, c)}" for i, c in enumerate(candidates, 1)]
    state = (
        f"Abbreviation/alias to resolve: {token}\n"
        f"Conversation context:\n{(context_text or '(none)')[:2000]}\n"
        "Candidate entities (each line: name category:tags recent events):\n" + "\n".join(lines)
    )
    options = {str(i): "Candidate index " + str(i) + " above" for i in range(1, len(candidates) + 1)}
    options["none"] = "Context is insufficient to tell which candidate is meant"
    r = jev.judge_choice(
        state,
        "Which candidate entity does the abbreviation most likely refer to, strictly based on the "
        "given conversation context? If the context gives no real clue, choose the none option.",
        options,
    )
    if r is None or r["choice"] == "none":
        return None
    if r["confidence"] < jev.config()["conf_min"]:
        return None
    idx = int(r["choice"]) - 1
    return {
        "element": candidates[idx],
        "confidence": r["confidence"],
        "reason": f"jev choice conf={r['confidence']:.2f}",
    }


def resolve(
    db: KernelDB,
    token: str,
    context_text: str = "",
    client: Any = None,
    model: str = "deepseek-v4-flash",
) -> dict:
    """完整消解链：唯一 → 语境预筛 → Jev 快判 → 慢 LLM → 歧义（交 Agent）。"""
    hard = hard_resolve(db, token, context_text)
    if hard["decided"]:
        hard["method"] = "hard"
        return hard
    if not hard["candidates"]:
        return hard

    # Jev 快判（System One）：置信达标即直判，否则落慢 LLM
    j = jev_resolve(db, token, context_text, hard["candidates"])
    if j is not None:
        return {
            "element": j["element"],
            "candidates": hard["candidates"],
            "decided": True,
            "method": "jev",
            "confidence": j["confidence"],
            "reason": j["reason"],
        }

    # LLM 消解
    if client is not None:
        llm = llm_resolve(db, client, token, context_text, hard["candidates"], model=model)
        if llm is not None:
            return {
                "element": llm["element"],
                "candidates": hard["candidates"],
                "decided": True,
                "method": "llm",
                "confidence": llm["confidence"],
                "reason": llm["reason"],
            }

    # 降级：歧义交 Agent 定夺（不静默选错）
    return {
        "element": None,
        "candidates": hard["candidates"],
        "decided": False,
        "method": "none",
        "reason": "ambiguous_no_llm",
        "suggestion": "歧义未消解，由 Agent 按对话上下文定夺",
    }
