"""memoryos_kernel.__main__ — 共享包内的精简 CLI（只覆盖元素-时间线主线）。

与上游内核的 cli.py（2472 行、混编台账命令）刻意分开：这里只做**薄封装**，
命令集＝ init / ingest / import / timeline / snapshot / save / index / context / all / expire / export /
          tree / merge / recall / decide / status。
JS 侧（lib/kernel.js）就是 spawn 这个入口，一命令一次调用。

用法：
  set PYTHONPATH=<包>\\python
  python -m memoryos_kernel init
  python -m memoryos_kernel ingest --text "2026-09-20 买入沪深300ETF 5000 元"
  python -m memoryos_kernel timeline 沪深300ETF
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

from . import extract as kx
from . import paths
from . import snapshot as ksn
from . import timeline as ktl
from .db import KernelDB


def db_path() -> str:
    return os.path.join(paths.DATA_ROOT, "memory.db")


def open_db() -> KernelDB:
    os.makedirs(paths.DATA_ROOT, exist_ok=True)
    return KernelDB(db_path())


def _out(obj) -> None:
    print(obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=2))


def cmd_status() -> int:
    p = db_path()
    if not os.path.isfile(p):
        _out({"ok": False, "db": p, "note": "库还不存在：先跑 init 或 ingest"})
        return 0
    con = sqlite3.connect(p)
    try:
        names = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        counts = {}
        for t in ("elements", "events", "links", "decisions", "llm_cache", "kv", "kv_store"):
            if t in names:
                counts[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        pending = (
            con.execute("SELECT COUNT(*) FROM events WHERE status='pending'").fetchone()[0]
            if "events" in names
            else 0
        )
    finally:
        con.close()
    _out({"ok": True, "db": p, "bytes": os.path.getsize(p), "counts": counts, "pending": pending,
          "data_root": paths.DATA_ROOT})
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="memoryos_kernel", description="元素-时间线内核（精简 CLI）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="建库并打印库路径")
    pi = sub.add_parser("ingest", help="文本 → 元素 + 事件（无 key 走规则层）")
    pi.add_argument("--text", required=True)
    pi.add_argument("--source", default="")
    pi.add_argument("--elements", default="", help="已知元素，逗号分隔（保守模式：不新建元素）")
    pt = sub.add_parser("timeline", help="某元素时间线")
    pt.add_argument("element")
    pt.add_argument("--since", default="")
    pt.add_argument("--limit", type=int, default=200)
    pt.add_argument("--status", default="active", help="active（默认）| expired | pending | all＝不过滤")
    pt.add_argument("--as-of", default="", help="历史视角：只看该日期（YYYY-MM-DD）及之前（时间未知的 pending 不计入）")
    ps = sub.add_parser("snapshot", help="元素当前快照（--save 拍一份落盘，并往时间线写一个点）")
    ps.add_argument("element")
    ps.add_argument("--save", action="store_true", help="拍快照：落 <数据根>/exports/<元素>_snap_<stamp>.md 并写时间线点")
    ps.add_argument("--note", default="", help="仅 --save：写进快照的备注")
    pc = sub.add_parser("context", help="取最新快照（＝当前运行逻辑）＋自快照以来新增的事件")
    pc.add_argument("element")
    sub.add_parser("index", help="重建 <数据根>/exports/INDEX.md 快照索引")
    pa = sub.add_parser("all", help="全部时间线（元素清单）")
    pa.add_argument("--since", default="")
    pe = sub.add_parser("expire", help="按内容片段标失效")
    pe.add_argument("element")
    pe.add_argument("fragment")
    pm = sub.add_parser("export", help="导出 Markdown 镜像")
    pm.add_argument("path")
    pim = sub.add_parser("import", help="把一份 Markdown 时间线档按元素导入（幂等；文件名去 .md 即元素名是上游惯例）")
    pim.add_argument("--element", required=True, help="该档归属的元素名（上游惯例＝文件名去 .md）")
    pim.add_argument("--path", required=True, help="要导入的 .md 路径")
    pim.add_argument("--source", default="")
    pim.add_argument("--category", default="generic", help="元素不存在时新建的类别（默认 generic；上游原为写死 stock）")
    ptr = sub.add_parser("tree", help="元素树与归宿（多父多子 DAG；不带 element＝全库概览）")
    ptr.add_argument("element", nargs="?", default="")
    ptr.add_argument("--depth", type=int, default=3)
    pmg = sub.add_parser("merge", help="碎片元素合并（事件重挂/别名归并/链接归并/产出物/子树；不给 --confirm 只预演）")
    pmg.add_argument("--from", dest="src", required=True, help="要被并入的碎片元素")
    pmg.add_argument("--to", dest="dst", required=True, help="规范元素（保留者）")
    pmg.add_argument("--no-alias", action="store_true", help="不把 from 的名字留作 to 的别名（默认保留）")
    pmg.add_argument("--confirm", action="store_true", help="真写；不给则只做预演")
    prc = sub.add_parser("recall", help="按关联度召回（纯硬信号，无 LLM/无 Key 可用）")
    prc.add_argument("query")
    prc.add_argument("--top", type=int, default=10)
    pdc = sub.add_parser("decide", help="决策流水线：quick＝轮廓包（材料）；full＝有 LLM/Jev 时加精评")
    pdc.add_argument("query")
    pdc.add_argument("--mode", default="quick", choices=["quick", "full"])
    pdc.add_argument("--top", type=int, default=8)
    pdc.add_argument("--as-of", default="")
    pdc.add_argument("--show-profile", action="store_true")
    sub.add_parser("status", help="库统计（元素/事件/链接/决策）")

    a = ap.parse_args(argv)

    if a.cmd == "init":
        open_db()
        _out({"ok": True, "db": db_path(), "data_root": paths.DATA_ROOT})
        return 0
    if a.cmd == "status":
        return cmd_status()

    db = open_db()
    if a.cmd == "ingest":
        elems = [x.strip() for x in (a.elements or "").split(",") if x.strip()]
        _out(kx.ingest(db, a.text, source=a.source, manual_elements=elems or None))
        return 0
    if a.cmd == "timeline":
        st = "" if str(a.status).lower() == "all" else a.status
        _out(ktl.timeline(db, a.element, since=a.since, status=st, limit=a.limit, as_of=a.as_of))
        return 0
    if a.cmd == "snapshot":
        if a.save:
            _out(ksn.save_snapshot(db, a.element, note=a.note))
        else:
            _out(ktl.snapshot(db, a.element))
        return 0
    if a.cmd == "context":
        _out(ksn.context(db, a.element))
        return 0
    if a.cmd == "index":
        _out(ksn.rebuild_index())
        return 0
    if a.cmd == "all":
        _out(ktl.all_timelines(db, since=a.since))
        return 0
    if a.cmd == "expire":
        _out(ktl.expire(db, a.element, a.fragment))
        return 0
    if a.cmd == "tree":
        if a.element:
            el = db.find_element(a.element)
            if not el:
                _out({"found": False, "element": a.element, "note": "元素库里没有它"})
                return 0
            _out({"found": True, "element": el["name"], "depth": el["depth"],
                  "parents": db.parents_of(el["id"]), "tree": db.element_tree(el["id"], max_depth=a.depth)})
        else:
            rows = []
            for el in db.all_elements():
                rows.append({"name": el["name"], "category": el["category"], "depth": el["depth"],
                             "parents": [p["name"] for p in db.parents_of(el["id"])],
                             "children": [k["name"] for k in db.element_children(el["id"])]})
            _out(rows)
        return 0
    if a.cmd == "merge":
        src, dst = db.find_element(a.src), db.find_element(a.dst)
        if not src or not dst:
            _out({"ok": False, "note": f"元素不存在：{'--from' if not src else '--to'}"})
            return 0
        if src["id"] == dst["id"]:
            _out({"ok": False, "note": "--from 与 --to 是同一个元素"})
            return 0
        if not a.confirm:
            _out({"ok": False, "dry_run": True,
                  "note": f"预演：把「{src['name']}」并入「{dst['name']}」（事件重挂／别名归并／链接归并／产出物／子树）；"
                          f"要真写请加 --confirm（append-only：事件不删，只重挂）"})
            return 0
        _out(db.merge_elements(src["id"], dst["id"], keep_alias=not a.no_alias))
        return 0
    if a.cmd == "recall":
        from . import relevance as krel                       # 延迟 import：避开与 decide 的循环依赖
        from .decide import _identify_elements
        ids, amb = _identify_elements(db, a.query, "", None)  # 无 client：词法消解，歧义如实返回
        res = krel.rank(db, a.query, ids, client=None, mode="quick", top_n=a.top)
        res["ambiguous"] = amb
        _out(res)
        return 0
    if a.cmd == "decide":
        from . import decide as kdec
        _out(kdec.decide(db, a.query, client=None, mode=a.mode, top_n=a.top, as_of=a.as_of, show_profile=a.show_profile))
        return 0
    if a.cmd == "export":
        _out({"ok": True, "path": ktl.export_md(db, a.path)})
        return 0
    if a.cmd == "import":
        if not os.path.isfile(a.path):
            _out({"ok": False, "note": f"文件不存在：{a.path}"})
            return 0
        _out(ktl.import_md_file(db, a.element, a.path, source=a.source, category=a.category))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
