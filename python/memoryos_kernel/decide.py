"""memoryos_kernel.decide — 决策引擎。

流水线：
  query → 元素识别 → 三级漏斗召回打分 → 组装"干净切面"（带时间戳+来源）
        → 决策输出 → 记录 decisions + 关联回写（学习）

双路径设计：
  - full + 有 key：LLM 直接产出决策 JSON（deepseek-harness）
  - full + 无 DEEPSEEK key + 有 Jev key：语义层（消歧/关联/triage）由 Jev 快判承担，
    决策主体仍交调用方 Agent（决策包路径）
  - quick / 无 key / LLM 失败：输出**决策包**（相关元素+分数+证据+时间线摘要），
    由上层 Agent（本身就是 LLM）完成最终决策 —— 知识库负责"相关性+事实"，
    推理层负责"判断"，两层解耦。
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from . import jev
from .db import KernelDB
from .relevance import rank

SYSTEM_DECIDE = """你是投资/事务决策助手。基于给定的"干净切面"（带时间戳的事实与关联），对用户问题给出决策建议。

只输出 JSON：
{"conclusion":"明确结论","reasoning":"推理过程（引用带日期的事实）","confidence":0.0到1.0,"basis":["依据1","依据2"],"risks":["风险1"]}

规则：
- 只依据提供的事实，不臆造；事实不足时 conclusion 给出"待补充信息"并列出缺什么
- confidence 表达对结论的确信度"""


def _identify_elements(
    db: KernelDB, query_text: str, context_text: str = "", client: Any = None
) -> tuple[list[int], list[dict]]:
    """从 query 中识别元素（走消解链：候选制 + 语境 + LLM）。

    返回 (元素id列表, 歧义清单)。歧义不静默选错，交给上层（Agent/LLM 决策时）定夺。
    """
    from .resolve import resolve  # noqa: PLC0415

    ids: list[int] = []
    ambiguous: list[dict] = []
    # 从 query 提取候选 token：所有元素的 name/别名 在 query 中出现的
    tokens: list[str] = []
    for el in db.all_elements():
        names = [el["name"]] + db.aliases_of(el["id"])
        for nm in names:
            if nm and nm in query_text and nm not in tokens:
                tokens.append(nm)
    for t in tokens:
        r = resolve(db, t, context_text, client)
        if r.get("decided") and r["element"]:
            if r["element"]["id"] not in ids:
                ids.append(r["element"]["id"])
        elif r.get("reason") == "ambiguous_no_llm" or (not r.get("decided") and r.get("candidates")):
            ambiguous.append(
                {
                    "token": t,
                    "candidates": [c["name"] for c in r["candidates"]],
                    "suggestion": r.get("suggestion", ""),
                }
            )
    return ids, ambiguous


def _buffer_context(db: KernelDB, max_chars: int = 2000) -> str:
    """当前话题缓冲文本（对话语境），用于简称消解。"""
    parts = []
    for t in db.buffer_topics():
        for r in db.buffer_rows(t["topic"]):
            parts.append(r["text"])
    return "\n".join(parts)[:max_chars]


def llm_decide(client: Any, query_text: str, context: dict, model: str = "deepseek-v4-flash") -> Optional[dict]:
    """LLM 最终决策。失败返回 None。"""
    try:
        ctx_json = json.dumps(context, ensure_ascii=False, indent=1)[:8000]
        resp = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_DECIDE},
                {"role": "user", "content": f"问题：{query_text}\n\n干净切面：\n{ctx_json}"},
            ],
        )
        content = (resp["message"].get("content") or "").strip()
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
        if m:
            content = m.group(1)
        data = json.loads(content)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def decide(
    db: KernelDB,
    query_text: str,
    client: Any = None,
    mode: str = "quick",
    top_n: int = 8,
    model: str = "deepseek-v4-flash",
    max_events: int = 5,
    as_of: str = "",
    show_profile: bool = False,
) -> dict:
    """完整决策流水线（v0.4 两级召回）。

    full：轮廓 → LLM triage(full/summary/skip) → 按级引细节 → LLM 决策
    quick：轮廓包交调用方 Agent 筛选与推理
    as_of：历史视角（可选），只召回该时点之前的信息
    """
    from . import profile as kprofile  # noqa: PLC0415

    # 语境 = 当前话题缓冲文本（对话上下文），辅助简称消解
    ctx_text = _buffer_context(db)
    q_ids, ambiguous = _identify_elements(db, query_text, ctx_text, client)
    ranked = rank(db, query_text, q_ids, client=client, mode=mode, top_n=top_n, model=model)

    # 决策主体（subject）+ 相关元素 → 轮廓
    subject_els = [db.element_by_id(i) for i in q_ids if db.element_by_id(i)]
    related_els = [db.element_by_id(r["id"]) for r in ranked["results"] if db.element_by_id(r["id"])]
    profile_els = subject_els + [e for e in related_els if e and e["id"] not in q_ids]
    profiles = kprofile.generate_profile(db, profile_els, as_of=as_of)

    triage = None
    decision = None
    if mode == "full" and (client is not None or jev.feature_available("triage")):
        # Jev 可用时 client 可为 None：triage 由 Jev 快判承担（llm_triage 内部两路合并）
        triage = kprofile.llm_triage(client, query_text, profiles, model=model, as_of=as_of)
        # 衔接修复：决策主体(subject)强制 full——triage 可能误降级主体，
        # 决策对象必须引入全细节（v0.6.6）
        if triage:
            for el in subject_els:
                triage[el["name"]] = {"level": "full", "reason": "subject(决策主体)强制full"}
        context = kprofile.build_context(db, profiles, triage, as_of=as_of, max_full=100)
        decision = llm_decide(client, query_text, context, model=model) if client is not None else None

    elements_used = [{"name": p["name"], "level": (triage or {}).get(p["name"], {}).get("level", "full")} for p in profiles]
    did = db.add_decision(
        query=query_text,
        elements_used=elements_used,
        result=json.dumps(decision, ensure_ascii=False) if decision else "",
        confidence=(decision or {}).get("confidence"),
        mode=mode,
        context_snapshot={"as_of": as_of, "triage": triage, "profiles": profiles[:5]},
    )

    # 不再回写"决策相关"边（v0.6.5，D29）：决策时的召回相关是"统计共现"，
    # 不是"语义关联"——无理由的边污染 links 图谱与 BFS 跳数。
    # 决策经验已由 decisions 表（elements_used）保存，查询即可，无需冗余成边。

    return {
        "decision_id": did,
        "query": query_text,
        "mode": mode,
        "as_of": as_of,
        "llm_decision": decision,
        "ambiguous": ambiguous,
        "triage": triage,
        "profile": render_profiles_short(profiles) if show_profile else None,
        "decision_package": None if decision else kprofile.render_package(query_text, profiles, as_of, triage),
        "elements_used": elements_used,
    }


def render_profiles_short(profiles: list[dict]) -> str:
    """triage 依据展示（--show-profile）。"""
    from . import profile as kprofile  # noqa: PLC0415

    return kprofile.render_profiles(profiles)
