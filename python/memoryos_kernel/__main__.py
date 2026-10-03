"""memoryos_kernel.__main__ — 共享包内的精简 CLI（只覆盖元素-时间线主线）。

与上游内核的 cli.py（2472 行、混编台账命令）刻意分开：这里只做**薄封装**，
命令集＝ init / ingest / timeline / snapshot / all / expire / export / status。
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
    ps = sub.add_parser("snapshot", help="元素当前快照")
    ps.add_argument("element")
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
        _out(ktl.snapshot(db, a.element))
        return 0
    if a.cmd == "all":
        _out(ktl.all_timelines(db, since=a.since))
        return 0
    if a.cmd == "expire":
        _out(ktl.expire(db, a.element, a.fragment))
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
