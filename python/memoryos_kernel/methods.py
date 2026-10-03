"""memoryos_kernel.methods — 方法 skill（索引触发、场景召回）。

把"可复用方法/概念"沉淀成 memory-decision 的【方法元素】：
- 方法 = 元素（category=method），tags=场景触发词，meta 存 {scene/detail/condition} 全文
- 方法组 = 方法元素作父（如"交易策略"），下挂具体方法（如"交易9字段"），用元素树 + links 表达
  个股 link relation=使用 → 方法组；方法组下元素树 ⇨ 具体方法，按场景下钻
- 用法：
    * 归档时抽方法  → extract_and_save(db, text, client, model)   （cmd_archive 调用）
    * 场景召回      → recall_method(db, scene_text, client, model)（cmd method recall）
    * 列出方法      → list_methods(db)                            （cmd method list）

核心：方法不写死常驻（记不下），而是存成元素 + 触发词；用到时【场景识别 → 召回对应方法
全文 → 注入 LLM 让它固守】，而不是靠 LLM 记住 / 靠某 agent 的 SOUL 带着它。
"""

from __future__ import annotations

import json
import re
from datetime import date
from typing import Any, Optional


SYSTEM_METHOD_EXTRACT = """你是方法论提炼师。给定一段"归档内容"（描述某段时间做的工作/分析/研究），
判断这期间是否沉淀出了"可复用的方法 / 概念 / 分析框架"。如果有，把它抽出来。

只输出 JSON，不要输出其他内容：
{"methods":[{"name":"方法名","scene":"这个方法在什么场景下用","triggers":["触发词1","触发词2"],"detail":"方法细节（具体怎么做，能照着复用）","condition":"适用条件/隐性前提"}]}

如果没有可复用的方法（只是一次性的事实/结论/闲聊），输出 {"methods":[]}。

规则：
- 只抽"可复用、下次能照着做的方法/概念/框架"，不抽一次性的事实、结论、数据
- triggers 是"场景触发词"（如"交易/回测/持仓"），用于召回时匹配当前场景——至少 2 个
- detail 要具体到"怎么做的步骤/步骤顺序"，让下一次能真正复用（不是 "分析了基本面" 这种空话）
- scene 说明"什么时候该用这个方法"（触发条件）
- condition 说明"这个方法的适用边界 / 隐性前提 / 踩过的坑"
- 宁缺毋滥：没把握的不抽；一个方法就列一个，多个就列多个"""


def extract_methods(text: str, client: Any, model: str = "deepseek-v4-flash") -> list[dict]:
    """LLM 从归档文字里抽方法。失败/无 key/没抽到 → []。"""
    if not client or not text:
        return []
    try:
        resp = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_METHOD_EXTRACT},
                {"role": "user", "content": f"当前日期：{date.today().isoformat()}\n\n归档内容：\n{text[:6000]}"},
            ],
        )
        content = (resp.get("message") or {}).get("content") or ""
        content = content.strip()
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
        if m:
            content = m.group(1)
        data = json.loads(content)
        if not isinstance(data, dict):
            return []
        methods = data.get("methods") or []
        if not isinstance(methods, list):
            return []
        # 归一化 + 过滤空名
        out = []
        for mt in methods:
            if not isinstance(mt, dict):
                continue
            name = (mt.get("name") or "").strip()
            if not name:
                continue
            out.append({
                "name": name,
                "scene": (mt.get("scene") or "").strip(),
                "triggers": [str(t).strip() for t in (mt.get("triggers") or []) if str(t).strip()],
                "detail": (mt.get("detail") or "").strip(),
                "condition": (mt.get("condition") or "").strip(),
            })
        return out
    except Exception:
        return []


def _el_meta(el: dict) -> dict:
    try:
        m = el.get("meta")
        return json.loads(m) if isinstance(m, str) else (m or {})
    except Exception:
        return {}


def _el_tags(el: dict) -> list:
    try:
        t = el.get("tags")
        return json.loads(t) if isinstance(t, str) else (t or [])
    except Exception:
        return []


def list_methods(db: Any) -> list[dict]:
    """列出已抽取的方法元素（category=method），供 method list。"""
    out = []
    for e in db.all_elements():
        if e.get("category") != "method":
            continue
        out.append({"name": e["name"], "scene": _el_meta(e).get("scene", ""), "triggers": _el_tags(e)})
    return out


def extract_and_save(db: Any, text: str, client: Any, model: str) -> list[dict]:
    """一步：从归档文字抽方法 → 存为"方法元素"（category=method，供场景召回）→ 返回记录。"""
    found = extract_methods(text, client, model)
    saved = []
    for mt in found:
        eid, _ = db.upsert_element(
            mt["name"], category="method",
            tags=list(mt.get("triggers") or []),
            meta={"scene": mt.get("scene", ""), "detail": mt.get("detail", ""),
                  "condition": mt.get("condition", "")})
        saved.append({"id": eid, "name": mt["name"], "triggers": mt.get("triggers") or []})
    return saved


# ============================================================================
# 场景召回（索引触发、场景召回）：当前场景 → 召回对应"方法"元素全文 → 供注入 LLM
# ============================================================================

SYSTEM_METHOD_PICK = """你是方法路由助手。给定一个"场景描述"（用户当前正在做的事，如"记这笔交易"），
和一批候选"方法"（每个方法有名字、适用场景、触发词），判断当前场景【最该用哪个方法】。
若提供了"历史优先候选"，请【优先考虑】它们——该情境以往用过，大概率这次也用得上。

只输出 JSON：
{"picked":["方法名1","方法名2"]}

规则：
- 按相关性从高到低，最多选 2 个；有"历史优先候选"时优先挑它们
- 选"当前场景真正用得上"的方法，不是名字相似就选
- 宁可少选（1个）也不乱选；没有相关的方法 → {"picked":[]}"""


def _method_pick_text(el: dict) -> str:
    m = _el_meta(el)
    return f"- {el['name']}（场景：{str(m.get('scene',''))[:36]}；触发词：{','.join(_el_tags(el))[:32]}）"


def _llm_pick(client: Any, scene_text: str, methods: list[dict],
              model: str, top_n: int, history: Optional[list] = None) -> list[dict]:
    cand_text = "\n".join(_method_pick_text(el) for el in methods)
    hist_section = (f"\n历史优先候选（该情境以往用过，请优先考虑）：{', '.join(history)}\n"
                    if history else "")
    resp = client.chat(model=model, messages=[
        {"role": "system", "content": SYSTEM_METHOD_PICK},
        {"role": "user", "content": f"场景：{scene_text}{hist_section}\n\n候选方法：\n{cand_text[:6000]}"},
    ])
    content = (resp.get("message") or {}).get("content") or ""
    content = content.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
    if m:
        content = m.group(1)
    data = json.loads(content)
    names = (data.get("picked") or [])[:top_n]
    by_name = {e["name"]: e for e in methods}
    return [by_name[n] for n in names if n in by_name]


def _keyword_pick(scene_text: str, methods: list[dict], top_n: int,
                  history: Optional[list] = None) -> list[dict]:
    """降级：触发词/历史优先在场景文本里出现 → 命中。"""
    hist_set = set(history or [])
    scored = []
    for el in methods:
        tags = _el_tags(el)
        score = sum(1 for t in tags if t and t in scene_text)
        if el["name"] in scene_text:
            score += 2
        if el["name"] in hist_set:
            score += 3  # 历史优先加权
        if score:
            scored.append((score, el))
    scored.sort(key=lambda x: -x[0])
    return [e for _, e in scored[:top_n]]


def _history_partners(db: Any, scene_text: str, top_n: int = 3) -> list:
    """B：查"当前场景/对象"历史用过的方法（usage_log method_use 共现），返回高频方法名。

    直接查库（不用 LLM 现判全部候选），把"以往用过"的方法作为优先候选注入 A。
    """
    import re as _re  # noqa: PLC0415
    try:
        rows = db.conn.execute(
            "SELECT element, query, related FROM usage_log "
            "WHERE action='method_use' ORDER BY ts DESC LIMIT 300"
        ).fetchall()
    except Exception:
        return []
    sc_words = {w for w in _re.findall(r"[\u4e00-\u9fff]{2,4}", scene_text)}
    objs = [e["name"] for e in db.all_elements() if e["name"] and e["name"] in scene_text]
    counts: dict = {}
    for r in rows:
        hay = (r["element"] or "") + " " + (r["query"] or "")
        if any(w in hay for w in sc_words) or any(o in hay for o in objs):
            try:
                rel = json.loads(r["related"]) if r["related"] else []
            except Exception:
                rel = []
            for m in rel:
                if m:
                    counts[m] = counts.get(m, 0) + 1
    return [m for m, _ in sorted(counts.items(), key=lambda x: -x[1])[:top_n]]


def recall_method(db: Any, scene_text: str, client: Any,
                  model: str = "deepseek-v4-flash", top_n: int = 2) -> list[dict]:
    """场景召回（A）+ 共现搭档（B 注入）：当前场景 → 召回对应方法全文 → 供注入 LLM。

    B 先查库（当前对象/情境历史用过的方法）→ 作为"历史优先候选"注入 A（LLM 优先考虑）。
    召回后打点（记录"哪个元素用了哪些方法"），供下次 B 用。返回 [{name, scene, detail,
    condition, is_group, children}]——detail 即方法全文，可注入 LLM 让它固守。
    """
    methods = [e for e in db.all_elements() if e.get("category") == "method"]
    if not methods or not scene_text:
        return []
    # B：历史优先候选（对象/场景以往用过的方法）——直接查库，不用 LLM 现判全部
    history = _history_partners(db, scene_text, top_n=3)
    picked: list[dict] = []
    if client:
        try:
            picked = _llm_pick(client, scene_text, methods, model, top_n, history or None)
        except Exception:
            picked = []
    if not picked:
        picked = _keyword_pick(scene_text, methods, top_n, history or None)
    out = []
    for el in picked:
        m = _el_meta(el)
        kids = db.element_children(el["id"])
        rec = {
            "name": el["name"],
            "scene": m.get("scene", ""),
            "detail": m.get("detail", ""),
            "condition": m.get("condition", ""),
            "is_group": bool(kids),
        }
        if kids:
            rec["children"] = [c["name"] for c in kids]
        out.append(rec)
    # 打点：记录"当前场景/对象 × 召回方法"共现（供下次 B 复用，越用越准）
    try:
        obj = next((e["name"] for e in db.all_elements() if e["name"] and e["name"] in scene_text), "")
        db.log_usage("method_use", element=obj, query=scene_text[:200],
                     related=[r["name"] for r in out])
    except Exception:
        pass
    return out
