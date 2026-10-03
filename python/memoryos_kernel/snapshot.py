"""memoryos_kernel.snapshot — 多点快照：拍快照落盘、写时间线点、取最新快照。

**这套东西为什么存在**（本包 `docs/JUDGMENTS.md` §5.9.7）：时间线有两种读法——
① 逐条事件（`- YYYY-MM-DD …`）；② **多点快照**：每归档/commit 一次就往时间线流一个快照，
提及时**取最后一次快照＝当前运行逻辑**。只有事件，召回时要"重放"才能还原当时状态；
只有快照，又看不出中间怎么变的。两者互补。

上游（`md_kernel/cli.py`）把这套写在命令层里（`snapshot --save` / `_snapshot_to_file` /
`_rebuild_snapshot_index` / `context`）；共享包把它固化成内核模块，命令层只做参数解析。

**与上游的两处有意分叉**（都在文档里写明，别当成漏搬）：

1. 上游 `context` 走三级回退（外部 INDEX（hermes）→ skill 快照 → **现场生成**），
   取不到还会**偷偷写盘**。本包**只认自己的 `<数据根>/exports`**，且**取不到不现场生成**：
   只读动作不该产生文件，"要不要拍"交回调用方（`save`）。
2. 上游 `snapshot --save` 之外还有 archive 命令顺带拍；本包只保留 `save` 一个生产者，
   谁想拍谁显式调。

文件名与上游同构：`<元素>_snap_<YYYYMMDD-HHMM>.md`（**带时分**，所以同一天多次拍是**多份**，
这正是"多点"的本意；只有同一分钟内连拍才会覆盖同名档）。
"""

from __future__ import annotations

import glob
import os
import re
import json
from datetime import datetime

from . import paths

# ---------------------------------------------------------------- 小工具


def _stamp() -> str:
    """快照文件名用的时间戳（与上游同格式）。"""
    return datetime.now().strftime("%Y%m%d-%H%M")


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _safe(name: str) -> str:
    """文件名安全化：路径分隔符与 Windows 保留字符换成下划线。"""
    return re.sub(r'[\\/:*?"<>|\s]+', "_", str(name)).strip("_") or "element"


def exports_dir() -> str:
    return paths.EXPORTS_DIR


def snapshot_path(element: str, stamp: str = "") -> str:
    return os.path.join(exports_dir(), f"{_safe(element)}_snap_{stamp or _stamp()}.md")


def _parse_snap_name(filename: str) -> dict | None:
    """从 `<元素>_snap_<stamp>.md` 反解元素名与时间戳。"""
    m = re.match(r"^(?P<el>.+)_snap_(?P<stamp>\d{8}-\d{4})\.md$", filename)
    if not m:
        return None
    return {"element": m.group("el"), "stamp": m.group("stamp"), "file": filename}


def list_snapshots(element: str = "") -> list[dict]:
    """列出快照（可按元素过滤），新的在前。"""
    out: list[dict] = []
    for p in glob.glob(os.path.join(exports_dir(), "*.md")):
        base = os.path.basename(p)
        if base == "INDEX.md":
            continue
        info = _parse_snap_name(base)
        if not info:
            continue
        if element and _safe(element) != info["element"]:
            continue
        try:
            st = os.stat(p)
            size, mtime = st.st_size, datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
        except OSError:
            size, mtime = 0, ""
        info.update({"path": p, "size": size, "mtime": mtime})
        out.append(info)
    return sorted(out, key=lambda x: x["stamp"], reverse=True)


def latest_snapshot(element: str) -> dict | None:
    """某元素最新的一份快照（按文件名时间戳排序，不靠 mtime）。"""
    items = list_snapshots(element)
    return items[0] if items else None


# ---------------------------------------------------------------- 拍快照


def _render(db, el: dict, note: str = "") -> str:
    """渲染一份"轻量快照"：够看当前状态，不追求全量（全量走 export）。"""
    meta = {}
    try:
        meta = json.loads(el.get("meta") or "{}")
    except (ValueError, TypeError):
        meta = {}

    evs_all = db.events_of(el["id"], status="", limit=500)
    active = [e for e in evs_all if e.get("status") == "active" and e.get("ts")]
    pending = [e for e in evs_all if not e.get("ts")]
    ts_list = sorted(e["ts"] for e in active)
    span = f"{ts_list[0]}~{ts_list[-1]}" if len(ts_list) >= 2 else (ts_list[0] if ts_list else "（还没有带时间的事件）")
    aliases = db.aliases_of(el["id"])
    kids = db.element_children(el["id"])
    arts = db.artifacts_of(el["id"])

    lines = [
        f"# {el['name']} 快照（{datetime.now().strftime('%Y-%m-%d %H:%M')}）",
        "",
        f"- 类别：{el['category']}｜跨度：{span}｜事件：active {len(active)}／待定 {len(pending)}",
        f"- 别名：{('、'.join(aliases)) if aliases else '（无）'}",
    ]
    if meta.get("status") or meta.get("intro"):
        lines.append(f"- 状态：{meta.get('status', '')}｜简介：{str(meta.get('intro', ''))[:150]}")
    if note:
        lines.append(f"- 备注：{note}")
    lines.append(f"- 归属：子元素 {len(kids)} 个")

    lines += ["", f"## 时间线（最新 {min(len(active), 10)} 条，" + ("倒序" if active else "空") + "）"]
    for e in sorted(active, key=lambda x: x["ts"], reverse=True)[:10]:
        body = e["content"]
        if body.startswith(e["ts"]):            # 事件原文常自带日期前缀，这里不再重复输出
            body = body[len(e["ts"]):].lstrip(" 　:：-")
        lines.append(f"- {e['ts']} {body} `{e.get('source', '')}`")

    if pending:
        lines += ["", f"## 待定区（无时间属性，共 {len(pending)}）"]
        for e in pending[:10]:
            lines.append(f"- {e['content']}")

    if arts:
        lines += ["", "## 产出物"]
        for a in arts[:8]:
            lines.append(f"- [{a['kind']}] {a['filename']} v{str(a['version']).lstrip('vV')}（{a['ts']}）")

    links = db.links_of(el["id"])
    if links:
        lines += ["", "## 关联边"]
        for l in links[:10]:
            lines.append(f"- {el['name']} --{l.get('relation', '')}--> {l.get('to_name') or l.get('to_id')} (s={l.get('strength', '')})")

    return "\n".join(lines) + "\n"


def save_snapshot(db, element: str, note: str = "") -> dict:
    """拍一份快照：落 `<数据根>/exports/<元素>_snap_<stamp>.md`，**并往时间线写一个点**。

    写的那个点：`ts=今天`、`source="snapshot"`、`ts_source="explicit"`、`ref=快照文件`——
    这正是"每 commit 一次，时间线上多一个快照点"的实现；`add_event` 的
    `(element_id, ts, content)` 唯一约束负责去重（同一分钟内连拍两次只记一个点）。
    """
    el = db.find_element(element)
    if not el:
        return {"ok": False, "note": f"元素库里没有「{element}」——先 ingest 或 import 把它建出来，再拍快照"}
    os.makedirs(exports_dir(), exist_ok=True)
    stamp = _stamp()
    path = snapshot_path(el["name"], stamp)
    text = _render(db, el, note)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)

    n_active = len(db.events_of(el["id"], status="active", limit=1000))
    n_pending = len([e for e in db.events_of(el["id"], status="", limit=1000) if not e.get("ts")])
    content = f"快照 {stamp}：active {n_active} 条／待定 {n_pending} 条"
    ev_id, inserted = db.add_event(
        element_id=el["id"], content=content, ts=_today(),
        source="snapshot", ref=os.path.relpath(path, paths.DATA_ROOT), status="active", ts_source="explicit",
    )
    idx = rebuild_index()
    return {
        "ok": True, "element": el["name"], "path": path, "file": os.path.basename(path),
        "stamp": stamp, "bytes": len(text.encode("utf-8")),
        "active": n_active, "pending": n_pending,
        "timeline_point": {"event_id": ev_id, "inserted": bool(inserted), "ts": _today(), "content": content},
        "index": idx["path"],
    }


# ---------------------------------------------------------------- 索引


def rebuild_index() -> dict:
    """重建 `<数据根>/exports/INDEX.md`：一份快照 -> 一行（按元素分组、新的在前）。"""
    os.makedirs(exports_dir(), exist_ok=True)
    items = list_snapshots()
    by: dict[str, list[dict]] = {}
    for it in items:
        by.setdefault(it["element"], []).append(it)
    lines = [
        "# 快照索引（memoryos_kernel）",
        "",
        f"> 重建于 {datetime.now().strftime('%Y-%m-%d %H:%M')}｜快照 {len(items)} 份／元素 {len(by)} 个｜目录 `{exports_dir()}`",
        "",
        "| 元素 | 最新快照 | 份数 | 最近拍于 |",
        "|---|---|---|---|",
    ]
    for name in sorted(by):
        group = by[name]                    # list_snapshots 已按 stamp 倒序
        top = group[0]
        lines.append(f"| {name} | `{top['file']}` | {len(group)} | {top['mtime']} |")
    if not items:
        lines.append("| （还没有快照） | — | 0 | — |")
    text = "\n".join(lines) + "\n"
    path = os.path.join(exports_dir(), "INDEX.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return {"path": path, "files": len(items), "elements": len(by)}


# ---------------------------------------------------------------- 取用（"提及时取最后一次快照"）


def context(db, element: str, head_chars: int = 3000) -> dict:
    """**取最新快照**（＝当前运行逻辑）＋"自快照以来新增了什么"。

    取不到快照时**不现场生成**（只读动作不写盘），只如实说"还没拍过"并给出可看的事件，
    由调用方决定要不要 `save`。
    """
    el = db.find_element(element)
    if not el:
        return {"found": False, "element": element, "note": f"元素库里没有「{element}」"}
    snap = latest_snapshot(el["name"])
    out: dict = {"found": True, "element": el["name"], "snapshot": None, "content": "", "truncated": False}
    if snap:
        try:
            with open(snap["path"], encoding="utf-8") as fh:
                text = fh.read()
        except OSError as e:
            text = f"（快照读不到：{e}）"
        out["snapshot"] = {"file": snap["file"], "path": snap["path"], "stamp": snap["stamp"], "mtime": snap["mtime"], "bytes": snap["size"]}
        out["content"] = text[:head_chars]
        out["truncated"] = len(text) > head_chars
        snap_date = f"{snap['stamp'][:4]}-{snap['stamp'][4:6]}-{snap['stamp'][6:8]}"
        newer = [e for e in db.events_of(el["id"], since=snap_date, status="", limit=100)
                 if e.get("ts") and e["ts"] > snap_date]
        out["new_since_snapshot"] = {
            "since": snap_date, "count": len(newer),
            "events": [{"ts": e["ts"], "content": e["content"], "source": e.get("source", "")} for e in newer[:20]],
        }
    else:
        recent = db.events_of(el["id"], status="", limit=10)
        out["note"] = "这个元素还没有快照——要「当前运行逻辑」就用 save 拍一份；下面是最近的事件"
        out["recent_events"] = [{"ts": e.get("ts", ""), "content": e["content"], "status": e.get("status", "")} for e in recent]
        out["new_since_snapshot"] = {"since": "", "count": 0, "events": []}
    return out
