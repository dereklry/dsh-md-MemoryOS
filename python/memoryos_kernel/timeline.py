"""memoryos_kernel.timeline — 时间线（多股绳）查询、快照、失效标记、Markdown 导出。

与 investments/timelines/*.md 语义一致：
  - append-only：事件只追加，失效用 status='expired' 标记，不删除
  - 快照 = 每个元素当前最新状态
  - 导出 markdown 镜像，便于人类阅读与 git 留痕
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from .db import KernelDB

FORMAT_EVENT = "{ts} {content} [{status}] {ref}"


def timeline(db: KernelDB, element: str, since: str = "", status: str = "active", limit: int = 200) -> dict:
    """拉取单个元素的时间线。element 支持规范名或别名。"""
    el = db.find_element(element)
    if not el:
        return {"element": element, "found": False, "events": [], "links": []}
    evs = db.events_of(el["id"], since=since, status=status, limit=limit)
    return {
        "element": el["name"],
        "id": el["id"],
        "category": el["category"],
        "aliases": db.aliases_of(el["id"]),
        "tags": el["tags"],
        "found": True,
        "events": evs,
        "links": db.links_of(el["id"]),
    }


def all_timelines(db: KernelDB, since: str = "", status: str = "active") -> list[dict]:
    out = []
    for el in db.all_elements():
        evs = db.events_of(el["id"], since=since, status=status, limit=500)
        if evs:
            out.append({"element": el["name"], "id": el["id"], "category": el["category"], "events": evs})
    return out


def snapshot(db: KernelDB, element: str) -> dict:
    """当前快照：元素元信息 + 最新事件 + 关联边。"""
    el = db.find_element(element)
    if not el:
        return {"element": element, "found": False}
    snap = db.snapshot(el["id"])
    snap.update(
        {
            "element": el["name"],
            "category": el["category"],
            "aliases": db.aliases_of(el["id"]),
            "tags": el["tags"],
            "links": db.links_of(el["id"]),
        }
    )
    return snap


def expire(db: KernelDB, element: str, content_fragment: str) -> dict:
    """按内容片段标记事件失效（保留留痕）。"""
    el = db.find_element(element)
    if not el:
        return {"matched": 0}
    rows = db.conn.execute(
        "SELECT * FROM events WHERE element_id=? AND status='active' AND content LIKE ?",
        (el["id"], f"%{content_fragment}%"),
    ).fetchall()
    n = 0
    for r in rows:
        if db.expire_event(r["id"]):
            n += 1
    return {"matched": n}


def export_md(db: KernelDB, path: str, since: str = "") -> str:
    """导出全量快照 Markdown（v0.6.6）：事件时间线 + 树结构 + 别名 + 产出物 + 语义关联。"""
    lines = [f"# memory-decision 时间线快照", "", f"> 导出时间：{datetime.now().isoformat(timespec='seconds')}", ""]
    # 1) 时间线（事件流）
    lines.append("## 一、事件时间线")
    for tl in all_timelines(db, since=since):
        lines.append(f"### {tl['element']}（{tl['category']}）")
        for ev in tl["events"]:
            tag = f"[{ev['status']}]" if ev["status"] != "active" else ""
            src = f" ⏱{ev.get('ts_source','')}" if ev.get("ts_source") and ev["ts_source"] != "explicit" else ""
            lines.append(f"- {ev['ts']} {ev['content']} {tag}{src} `{ev['source']}`")
        lines.append("")
    # 2) 元素树（父子归宿）
    lines.append("## 二、元素树与归宿")
    for el in db.all_elements():
        parents = db.parents_of(el["id"])
        p_txt = " / ".join(f"{p['name']}[{p['role']}{('·'+p['period']) if p['period'] else ''}]" for p in parents) or "(无父)"
        aliases = db.aliases_of(el["id"])
        summ = f" | 折叠: {el['children_summary']}" if el["children_summary"] else ""
        lines.append(f"- {el['name']}（{el['category']}）父: {p_txt}{summ}")
        if aliases:
            lines.append(f"    别名: {', '.join(aliases)}")
    # 3) 产出物
    arts = db.artifacts_of()
    if arts:
        lines.append("")
        lines.append("## 三、产出物索引")
        for a in arts:
            lines.append(f"- [{a['kind']}] {a['task']} → {a['filename']} v{a['version']}（{a['ts']}）")
    # 4) 语义关联（带理由）
    sem = db.conn.execute(
        "SELECT a.name x, l.relation, b.name y, l.strength, l.evidence FROM links l"
        " JOIN elements a ON a.id=l.from_id JOIN elements b ON b.id=l.to_id ORDER BY l.relation"
    ).fetchall()
    if sem:
        lines.append("")
        lines.append("## 四、语义关联（含理由）")
        for r in sem:
            lines.append(f"- {r['x']} --{r['relation']}--> {r['y']} (s={r['strength']}) 理由: {r['evidence'][:60]}")
    text = "\n".join(lines)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


# ------------------------------------------------------------- 存量 Markdown 导入
def _parse_md_timeline(text: str) -> list[dict]:
    """解析 investments/timelines/*.md 风格事件行：- YYYY-MM-DD 动作（数量/价格）[状态] → 引用"""
    import re

    events = []
    pat = re.compile(r"^[-*]\s*(\d{4}-\d{2}-\d{2})[\s:：]*(.*)$")
    for line in text.splitlines():
        m = pat.match(line.strip())
        if not m:
            continue
        content = m.group(2).strip()
        status = "expired" if "[已失效]" in content else "active"
        content = content.replace("[已失效]", "").strip()
        ref = ""
        if "→" in content:
            content, ref = [p.strip() for p in content.split("→", 1)]
        events.append({"ts": m.group(1), "content": content, "status": status, "ref": ref})
    return events


def import_md_file(db: KernelDB, element: str, md_path: str, source: str = "") -> dict:
    """从 Markdown 时间线文件导入事件（幂等，重复导入自动去重）。"""
    with open(md_path, encoding="utf-8") as fh:
        text = fh.read()
    evs = _parse_md_timeline(text)
    el = db.find_element(element)
    if not el:
        el_id, _ = db.upsert_element(name=element, category="stock", tags=["imported"])
        el = db.find_element(element)
    else:
        el_id = el["id"]
    new = 0
    for ev in evs:
        _, inserted = db.add_event(
            element_id=el_id,
            content=ev["content"],
            ts=ev["ts"],
            source=source or f"import:{md_path}",
            ref=ev["ref"],
            status=ev["status"],
        )
        if inserted:
            new += 1
    return {"element": element, "parsed": len(evs), "new": new}
