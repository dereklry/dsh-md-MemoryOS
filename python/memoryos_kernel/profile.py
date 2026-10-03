"""memoryos_kernel.profile — 两级召回：轮廓 → Agent 筛选 → 细节（v0.4）。

设计（用户确认）：决策时先亮起相关线条的【轮廓】（不是细节），由 Agent 语义判断
每根线 full/summary/skip，最后才引入需要的细节。重要性判断是 Agent 的职责，
代码只做轮廓聚合与检索——"在 Python 中引入 Agent 能力"。

- generate_profile：每根相关线的紧凑轮廓（事件数/时间跨度/最近摘要/关键节点/关联概要）
- llm_triage：LLM 看轮廓定级别（full/summary/skip）
- build_context：按级别组装细节（full=全量, summary=关键节点, skip=不引）
- render_profile_package：quick/降级模式 → 轮廓包交调用方 Agent 筛选
- as_of 支持：历史视角——只亮 as_of 之前的信息（可选参数）
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from . import jev
from .db import KernelDB

PROFILE_MAX_PER_LINE = 200      # 单线轮廓字数上限
PROFILE_MAX_TOTAL = 1500        # 整体轮廓字数上限


# ------------------------------------------------------------- 轮廓生成
def _span(db: KernelDB, el_id: int, as_of: str = "") -> tuple[str, str]:
    """时间跨度：最早/最新 ts（as_of 过滤）。"""
    evs = db.events_of(el_id, status="", limit=100000, as_of=as_of)
    ts = sorted(e["ts"] for e in evs if e["ts"])
    if not ts:
        return "", ""
    return ts[0], ts[-1]


def generate_profile(
    db: KernelDB,
    elements: list[dict],
    as_of: str = "",
    max_events_recent: int = 3,
) -> list[dict]:
    """生成相关线条的轮廓列表（紧凑、单线 ≤200 字）。v0.5 含子树/产出物信息。"""
    out = []
    for el in elements:
        evs = db.events_of(el["id"], status="", limit=100000, as_of=as_of)
        active = [e for e in evs if e["status"] == "active"]
        expired = [e for e in evs if e["status"] == "expired"]
        pending = [e for e in evs if e["status"] == "pending"]
        recent = sorted(active, key=lambda e: e["ts"], reverse=True)[:max_events_recent]
        # 关键节点：最早/最新/异常
        nodes = []
        if expired:
            nodes.append(f"{len(expired)}条已失效")
        if pending:
            nodes.append(f"{len(pending)}条待定")
        if active:
            nodes.append(f"最新:{active[-1]['ts'] or '?'}")
        links = db.links_of(el["id"])[:3]
        # v0.5：子树信息（子元素数/最深深度/折叠摘要）
        tree = db.element_tree(el["id"], max_depth=100)
        n_kids = len(tree) - 1
        m_depth = max((n["depth"] for n in tree), default=el["depth"]) - el["depth"] + 1
        # v0.5：产出物引用
        arts = db.artifacts_of(el["id"])
        meta = json.loads(el["meta"]) if el.get("meta") else {}
        profile = {
            "name": el["name"],
            "category": el["category"],
            "intro": (meta.get("intro") or "")[:120],
            "status": meta.get("status") or "",
            "event_count": len(evs),
            "span": _span(db, el["id"], as_of),
            "recent": [f"{e['ts'] or '?'} {e['content'][:50]}" for e in recent],
            "nodes": nodes,
            "links": [f"{l['a_name']}--{l['relation']}-->{l['b_name']}({l['strength']})" for l in links],
            "subtree": {"children": n_kids, "max_depth": m_depth} if n_kids else None,
            "children_summary": el.get("children_summary") or "",
            "artifacts": [f"{a['filename']} v{a['version'].lstrip('vV')}" for a in arts[:2]],
        }
        out.append(profile)
    return out


def render_profiles(profiles: list[dict]) -> str:
    """轮廓渲染为紧凑文本（喂给 triage LLM / 展示给 Agent）。"""
    lines = []
    for i, p in enumerate(profiles, 1):
        parts = [f"{i}. {p['name']}（{p['category']}）: {p['event_count']}条事件"]
        if p.get("status"):
            parts.append(f"状态:{p['status'][:30]}")
        if p.get("intro"):
            parts.append(f"简介:{p['intro'][:60]}")
        if p["span"] and p["span"][0]:
            parts.append(f"跨度 {p['span'][0]}~{p['span'][1]}")
        if p["nodes"]:
            parts.append("，".join(p["nodes"]))
        if p.get("subtree"):
            parts.append(f"子树:{p['subtree']['children']}子颗粒/深D{p['subtree']['max_depth']}")
        if p.get("children_summary"):
            parts.append(f"折叠:{p['children_summary'][:40]}")
        if p.get("artifacts"):
            parts.append("产出物:" + ";".join(p["artifacts"]))
        lines.append(" | ".join(parts))
        for r in p["recent"]:
            lines.append(f"   · {r}")
        if p["links"]:
            lines.append(f"   关联: {'; '.join(p['links'][:2])}")
    return "\n".join(lines)


# ------------------------------------------------------------- LLM triage
SYSTEM_TRIAGE = """你是信息筛选员。给定一个决策问题与相关线条的【轮廓】，判断每根线对回答该问题的重要性级别。

级别：
- full：直接影响决策的事实载体（决策对象本身的历史过程、账本类固化事实、核心依据）→ 引入全细节（含子树科目数据）
- summary：间接相关（背景、佐证、可能相关）→ 只引摘要/浓缩
- skip：与当前决策无关 → 不引入

判断要点：
- 决策对象（问题主角）一般 full；账本/交易记录/固化事实 full
- **注意轮廓里的"折叠:"浓缩描述**——它说明该线子树有什么数据（哪些科目/年份）、颗粒到第几层；
  若浓缩显示"某科目有数据"且该科目对决策有用 → full（下钻子树拉科目数据）；
  若浓缩显示"无数据/仅结构" → 不必为它 full
- 过期观点、远期背景可 summary；完全无关 skip
- 时间特性：近因 vs 历史，由该线对决策的实际作用决定，不机械按新旧

只输出 JSON：{"triage":[{"element":"名称","level":"full|summary|skip","reason":"一句话理由"}]}"""

TRIAGE_LEVELS = {
    "full": "carries decisive facts for this question (the decision subject itself, ledger/trade records, hard evidence) - load all details",
    "summary": "indirectly relevant background or supporting material - a condensed summary is enough",
    "skip": "not relevant to answering this question at all",
}


def jev_triage(query_text: str, profiles: list[dict], as_of: str = "") -> dict:
    """Jev（System One）批量定级：一轮廓一问，单次请求并行 choice(full/summary/skip)。

    返回 {元素名: {level, reason}}（只收 conf≥JEV_CONF_MIN 的）；分项闸关/不可用/失败 → {}。
    措辞英文（官方：中文准确率较低）；轮廓卡用库内原文。
    """
    if not profiles or not jev.feature_available("triage"):
        return {}
    lines = []
    for i, p in enumerate(profiles, 1):
        brief = f"{p['name']} ({p['category']}): {p['event_count']} events"
        if p.get("intro"):
            brief += f"; intro: {p['intro'][:80]}"
        if p.get("children_summary"):
            brief += f"; folded subtree: {p['children_summary'][:60]}"
        lines.append(f"{i}. {brief}")
    state = (
        f"Decision question: {query_text}\n"
        + (f"As-of viewpoint: {as_of}\n" if as_of else "")
        + "Element profiles:\n" + "\n".join(lines)
    )
    items = []
    for i, p in enumerate(profiles, 1):
        ins = (
            f"For element {i} (\"{p['name']}\"), which detail level should be loaded "
            "to best support answering the decision question?"
        )
        items.append((str(i), ins, dict(TRIAGE_LEVELS)))
    answers = jev.judge_choices(state, items)
    if answers is None:
        return {}
    conf_min = jev.config()["conf_min"]
    out: dict[str, dict] = {}
    for i, p in enumerate(profiles, 1):
        a = answers.get(str(i))
        if a and a["confidence"] >= conf_min:
            out[p["name"]] = {"level": a["choice"], "reason": f"jev conf={a['confidence']:.2f}"}
    return out


def llm_triage(
    client: Any,
    query_text: str,
    profiles: list[dict],
    model: str = "deepseek-v4-flash",
    as_of: str = "",
) -> Optional[dict]:
    """轮廓定级（两级）：Jev 快判先行，未决的喂慢 LLM 补，Jev 结果优先。

    返回 {元素名: {level, reason}}；两路全失败返回 None（上层按"不筛选=全 full"处理）。
    """
    if not profiles:
        return {}
    out: dict = jev_triage(query_text, profiles, as_of=as_of)
    todo = [p for p in profiles if p["name"] not in out]
    if not todo:
        return out
    if client is None:
        return out or None
    # 慢 LLM 只评 Jev 未决部分（省 token），原 SYSTEM_TRIAGE 逻辑不变
    text = render_profiles(todo)
    prompt = f"决策问题：{query_text}"
    if as_of:
        prompt += f"\n视角时间点（as-of）：{as_of}——只使用该时点之前的信息，之后的信息不可见"
    prompt += f"\n\n线条轮廓：\n{text[:PROFILE_MAX_TOTAL]}"
    try:
        resp = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_TRIAGE},
                {"role": "user", "content": prompt},
            ],
        )
        content = (resp["message"].get("content") or "").strip()
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
        if m:
            content = m.group(1)
        data = json.loads(content)
        for t in data.get("triage", []):
            lv = str(t.get("level") or "summary").lower()
            if lv not in ("full", "summary", "skip"):
                lv = "summary"
            name = t.get("element")
            if name and name not in out:  # Jev 已决的优先
                out[name] = {"level": lv, "reason": str(t.get("reason") or "")}
        return out or None
    except Exception:
        return out or None


# ------------------------------------------------------------- 按级组装
def build_context(
    db: KernelDB,
    profiles: list[dict],
    triage: Optional[dict],
    as_of: str = "",
    max_full: int = 100,
    max_summary: int = 5,
    drill_depth: int = 3,
) -> dict:
    """按 triage 级别组装细节上下文（v0.6.2 支持下钻子树）。

    full → 元素自身 + 子树事件（到 drill_depth，标注层级）；summary → 关键节点；
    skip → 不引。triage 缺失 → 全部按 full。
    """
    ctx = {"subject": [], "elements": []}
    if not triage:
        triage = {p["name"]: {"level": "full", "reason": "no-triage-fallback"} for p in profiles}
    for p in profiles:
        el = db.find_element(p["name"])
        if not el:
            continue
        lv = triage.get(p["name"], {}).get("level", "full")
        if lv == "skip":
            continue
        events = []
        if lv == "full":
            # 下钻子树：元素自身 + 子元素事件（到 drill_depth），带层级标注
            for n in db.element_tree(el["id"], max_depth=drill_depth):
                evs = db.events_of(n["id"], status="", limit=max_full, as_of=as_of)
                for e in evs:
                    d = dict(e)
                    d["_element"] = n["name"]
                    d["_depth"] = n["depth"] - el["depth"] + 1
                    events.append(d)
                if len(events) >= max_full:
                    break
        else:  # summary：关键节点
            all_evs = db.events_of(el["id"], status="", limit=100000, as_of=as_of)
            events = []
            for e in all_evs:
                if e["status"] == "expired" or e == all_evs[0] or e == all_evs[-1]:
                    events.append(e)
            events = events[:max_summary]
        item = {
            "name": el["name"],
            "category": el["category"],
            "level": lv,
            "reason": triage.get(p["name"], {}).get("reason", ""),
            "events": [
                {
                    "ts": e["ts"], "content": e["content"], "source": e["source"],
                    "status": e["status"], "element": e.get("_element", el["name"]),
                    "depth": e.get("_depth", 1),
                }
                for e in events
            ],
        }
        ctx["elements"].append(item)
    return ctx


def render_package(query_text: str, profiles: list[dict], as_of: str = "", triage: Optional[dict] = None) -> str:
    """quick/降级模式：轮廓包交调用方 Agent 筛选与决策。"""
    lines = [
        f"## 决策包（两级召回：以下为相关线条【轮廓】，由 Agent 筛选后引细节）",
        "",
        f"**问题**：{query_text}" + (f"（视角 as-of: {as_of}）" if as_of else ""),
        "",
        "### 线条轮廓",
        render_profiles(profiles),
    ]
    if triage:
        lines += ["", "### 建议 triage（LLM 预筛，Agent 可改）"]
        for name, t in triage.items():
            lines.append(f"- {name}: **{t['level']}** — {t['reason']}")
    lines += ["", "### Agent 动作", "- 定每根线级别后拉细节（timeline --element X），再完成最终决策；", "- 决策后调用 `decide` 记录回写。"]
    return "\n".join(lines)
