"""memoryos_kernel.db — SQLite schema + CRUD for the memory-decision kernel.

数据模型（对应"项目+时间线多股绳"）：
  elements  节点：实体/项目（INDEX 节点表）
  events    事实：带时间戳的事件流（timelines/*.md），append-only，status 标记失效
  links     边：元素间关联（INDEX 邻接表），strength 0-1，method hard/llm/manual
  decisions 决策记录（_决策线.md）
  llm_cache LLM 评审结果本地缓存（省钱提速）

铁律：
  - events 必须带时间属性；无时间 → ts='' 且 status='pending'（待定区）
  - 不覆盖式修改历史事件（append-only，失效用标记不用删除）
  - 幂等：element 按 name 归一化；event 按 (element_id, ts, content) 去重
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS elements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  aliases    TEXT NOT NULL DEFAULT '[]',
  category   TEXT NOT NULL DEFAULT 'generic',
  tags       TEXT NOT NULL DEFAULT '[]',
  meta       TEXT NOT NULL DEFAULT '{}',
  parent_id  INTEGER REFERENCES elements(id),
  depth      INTEGER NOT NULL DEFAULT 1,
  children_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  element_id INTEGER NOT NULL REFERENCES elements(id),
  ts         TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT '',
  ref        TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active',   -- active / expired / pending
  tags       TEXT NOT NULL DEFAULT '[]',
  raw        TEXT NOT NULL DEFAULT '',          -- v0.6 原文片段（可二次复核）
  ts_source  TEXT NOT NULL DEFAULT '',          -- v0.6 时间来源: explicit/rule/llm/corrected/empty
  created_at TEXT NOT NULL,
  UNIQUE(element_id, ts, content)
);
CREATE INDEX IF NOT EXISTS idx_events_elem ON events(element_id);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    INTEGER NOT NULL REFERENCES elements(id),
  to_id      INTEGER NOT NULL REFERENCES elements(id),
  relation   TEXT NOT NULL DEFAULT 'related',
  strength   REAL NOT NULL DEFAULT 0.5,
  method     TEXT NOT NULL DEFAULT 'hard',     -- hard / llm / manual
  evidence   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_id);

CREATE TABLE IF NOT EXISTS decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL,
  query           TEXT NOT NULL,
  elements_used   TEXT NOT NULL DEFAULT '[]',
  result          TEXT NOT NULL DEFAULT '',
  confidence      REAL,
  mode            TEXT NOT NULL DEFAULT 'full',
  context_snapshot TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS llm_cache (
  key        TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  schema_ver TEXT NOT NULL DEFAULT 'v1',
  created_at TEXT NOT NULL,
  response   TEXT NOT NULL
);

-- 话题缓冲（对话中暂存，语义钩子触发 flush 后批量精抽入库）
CREATE TABLE IF NOT EXISTS buffers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic      TEXT NOT NULL,
  text       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buffers_topic ON buffers(topic);

-- 键值配置（用户可调：如 buffer.flush_rounds，默认 10）
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 别名库（v0.3）：别名独立成表，允许 N:M（一个别名可对应多个实体=歧义，由消解器处理）
-- 迁移自 v0.2 的 elements.aliases JSON 字段（该字段不再维护，唯一事实源=本表）
CREATE TABLE IF NOT EXISTS aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alias      TEXT NOT NULL,
  element_id INTEGER NOT NULL REFERENCES elements(id),
  source     TEXT NOT NULL DEFAULT 'manual',   -- llm / manual / migrate / import
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(alias, element_id)
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS idx_aliases_elem  ON aliases(element_id);

-- 产出物索引（v0.5）：记忆"何时完成了什么项目、产出过什么文件（文件名+版本号）"
-- 结论文件(kind=conclusion)重要 > 过程文档(kind=process)次要；path 可能已挪走，记忆存"产出过"不是"存在哪"
CREATE TABLE IF NOT EXISTS artifacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  element_id INTEGER NOT NULL REFERENCES elements(id),
  ts         TEXT NOT NULL,
  task       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'process',  -- conclusion / process / data
  filename   TEXT NOT NULL,
  version    TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_elem ON artifacts(element_id);

-- 使用日志（v0.7.14）：每次记忆调用打点，归档时 LLM 总结成用户习惯（调取深度）
CREATE TABLE IF NOT EXISTS usage_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  session    TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  element    TEXT NOT NULL DEFAULT '',
  query      TEXT NOT NULL DEFAULT '',
  depth_used INTEGER NOT NULL DEFAULT 0,
  elements_recalled INTEGER NOT NULL DEFAULT 0,
  snapshot_used TEXT NOT NULL DEFAULT '',
  correction TEXT NOT NULL DEFAULT '',
  related TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
CREATE INDEX IF NOT EXISTS idx_usage_elem ON usage_log(element);

-- 归宿关系（v0.5.1）：多父多子 DAG。每个元素登记自己的父（parent_id=主归属，
-- 其余父在 memberships）。父子由使用者视角定义、随对话动态演进。
CREATE TABLE IF NOT EXISTS memberships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id   INTEGER NOT NULL REFERENCES elements(id),
  parent_id  INTEGER NOT NULL REFERENCES elements(id),
  role       TEXT NOT NULL DEFAULT 'member',   -- 关系角色：班级/板块/成分股/报告期…
  period     TEXT NOT NULL DEFAULT '',          -- 时期：初中/高中/2024级…
  created_at TEXT NOT NULL,
  UNIQUE(child_id, parent_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_child  ON memberships(child_id);
CREATE INDEX IF NOT EXISTS idx_memberships_parent ON memberships(parent_id);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _j(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _u(s: str) -> Any:
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return s


class KernelDB:
    """SQLite 封装：连接、建表、增删查。所有写操作幂等。"""

    def __init__(self, path: str):
        d = os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)
        self.path = path
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self._migrate_columns()
        self._migrate_aliases()
        self.conn.commit()

    def _migrate_columns(self) -> None:
        """v0.5/v0.6 迁移：为旧库补列（幂等）。"""
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(elements)")}
        for col, ddl in (
            ("parent_id", "ALTER TABLE elements ADD COLUMN parent_id INTEGER REFERENCES elements(id)"),
            ("depth", "ALTER TABLE elements ADD COLUMN depth INTEGER NOT NULL DEFAULT 1"),
            ("children_summary", "ALTER TABLE elements ADD COLUMN children_summary TEXT NOT NULL DEFAULT ''"),
        ):
            if col not in cols:
                self.conn.execute(ddl)
        # v0.6：events 加 raw（原文片段，可二次复核）+ ts_source（时间来源）
        ecols = {r["name"] for r in self.conn.execute("PRAGMA table_info(events)")}
        for col, ddl in (
            ("raw", "ALTER TABLE events ADD COLUMN raw TEXT NOT NULL DEFAULT ''"),
            ("ts_source", "ALTER TABLE events ADD COLUMN ts_source TEXT NOT NULL DEFAULT ''"),
        ):
            if col not in ecols:
                self.conn.execute(ddl)
        # v0.7.14：usage_log 加 related 列
        try:
            ucols = {r["name"] for r in self.conn.execute("PRAGMA table_info(usage_log)")}
            if "related" not in ucols:
                self.conn.execute("ALTER TABLE usage_log ADD COLUMN related TEXT NOT NULL DEFAULT '[]'")
        except Exception:
            pass

    def _migrate_aliases(self) -> None:
        """迁移 v0.2 elements.aliases JSON → aliases 表（幂等）。"""
        for el in self.conn.execute("SELECT id, name, aliases FROM elements"):
            for a in _u(el["aliases"]):
                if a and a != el["name"]:
                    self.conn.execute(
                        "INSERT OR IGNORE INTO aliases (alias, element_id, source, note, created_at)"
                        " VALUES (?,?,?,?,?)",
                        (a, el["id"], "migrate", "migrated from elements.aliases", utcnow()),
                    )

    # ------------------------------------------------------------ elements
    def find_element(self, token: str) -> Optional[dict]:
        """按规范名或别名精确查找元素（别名查库）。"""
        row = self.conn.execute(
            "SELECT * FROM elements WHERE name = ?", (token,)
        ).fetchone()
        if row:
            return dict(row)
        row = self.conn.execute(
            "SELECT e.* FROM aliases a JOIN elements e ON e.id=a.element_id WHERE a.alias=?",
            (token,),
        ).fetchone()
        return dict(row) if row else None

    def element_by_id(self, eid: int) -> Optional[dict]:
        row = self.conn.execute("SELECT * FROM elements WHERE id = ?", (eid,)).fetchone()
        return dict(row) if row else None

    def find_elements_by_token(self, token: str) -> list[dict]:
        """候选制匹配（别名查库，带索引）：name 精确=1.0 / alias 精确=0.9 / 子串=0.5。

        返回按权重降序的候选列表（含 match 类型）。不唯一——歧义交给消解器。
        """
        out: list[dict] = []
        for el in self.all_elements():
            if el["name"] == token:
                d = dict(el)
                d["match"], d["weight"] = "exact", 1.0
                out.append(d)
                continue
            if token in self.aliases_of(el["id"]):
                d = dict(el)
                d["match"], d["weight"] = "alias", 0.9
                out.append(d)
                continue
            if token in el["name"] or any(token in a for a in self.aliases_of(el["id"])):
                d = dict(el)
                d["match"], d["weight"] = "substring", 0.5
                out.append(d)
        return sorted(out, key=lambda x: -x["weight"])

    def aliases_of(self, element_id: int) -> list[str]:
        rows = self.conn.execute(
            "SELECT alias FROM aliases WHERE element_id=? ORDER BY id", (element_id,)
        ).fetchall()
        return [r["alias"] for r in rows]

    def alias_candidates(self, alias: str) -> list[dict]:
        """一个别名对应的所有实体（歧义一览）。"""
        rows = self.conn.execute(
            "SELECT e.* FROM aliases a JOIN elements e ON e.id=a.element_id WHERE a.alias=?",
            (alias,),
        ).fetchall()
        return [dict(r) for r in rows]

    def all_aliases(self) -> list[dict]:
        """别名库全览：alias / element / source / 歧义标记。"""
        rows = self.conn.execute(
            "SELECT a.alias, a.source, a.note, e.id AS element_id, e.name AS element, e.category"
            " FROM aliases a JOIN elements e ON e.id=a.element_id ORDER BY a.alias"
        ).fetchall()
        out = [dict(r) for r in rows]
        counts: dict[str, int] = {}
        for r in out:
            counts[r["alias"]] = counts.get(r["alias"], 0) + 1
        for r in out:
            r["ambiguous"] = counts[r["alias"]] > 1
        return out

    def add_alias(
        self, element_id: int, alias: str,
        source: str = "manual", note: str = "",
    ) -> tuple[bool, str]:
        """登记别名到库（幂等）。允许歧义（同一别名可挂多个实体，消解器处理）。

        返回 (是否新增, 提示)。提示含歧义预警。
        """
        alias = alias.strip()
        if not alias:
            return False, "别名不能为空"
        el = self.element_by_id(element_id)
        if not el:
            return False, "元素不存在"
        if alias == el["name"]:
            return False, "别名与规范名相同，无需登记"
        cur = self.conn.execute(
            "SELECT 1 FROM aliases WHERE alias=? AND element_id=?",
            (alias, element_id),
        ).fetchone()
        if cur:
            return False, "已存在"
        self.conn.execute(
            "INSERT INTO aliases (alias, element_id, source, note, created_at) VALUES (?,?,?,?,?)",
            (alias, element_id, source, note, utcnow()),
        )
        self.conn.commit()
        others = [e["name"] for e in self.alias_candidates(alias) if e["id"] != element_id]
        msg = "已登记"
        if others:
            msg += f"，⚠ 歧义：' {alias} ' 还对应 {others}"
        return True, msg

    def remove_alias(self, element_id: int, alias: str) -> bool:
        cur = self.conn.execute(
            "DELETE FROM aliases WHERE alias=? AND element_id=?", (alias, element_id)
        )
        self.conn.commit()
        return cur.rowcount > 0

    def upsert_element(
        self,
        name: str,
        aliases: Optional[Iterable[str]] = None,
        category: str = "generic",
        tags: Optional[Iterable[str]] = None,
        meta: Optional[dict] = None,
    ) -> tuple[int, bool]:
        """按规范名 upsert。已存在则合并 tags/meta。返回 (id, created?)

        aliases 写入别名库（aliases 表），不写 elements.aliases JSON（该字段已废弃）。
        """
        now = utcnow()
        aliases = list(dict.fromkeys(aliases or []))
        tags = list(dict.fromkeys(tags or []))
        meta = meta or {}
        row = self.conn.execute(
            "SELECT * FROM elements WHERE name = ?", (name,)
        ).fetchone()
        if row:
            eid = row["id"]
            old_t = set(_u(row["tags"]))
            old_m = dict(_u(row["meta"]))
            new_t = old_t | set(tags)
            old_m.update(meta)
            self.conn.execute(
                "UPDATE elements SET tags=?, meta=?, category=?, updated_at=? WHERE id=?",
                (_j(sorted(new_t)), _j(old_m), category or row["category"], now, eid),
            )
            self.conn.commit()
            for a in aliases:
                self.add_alias(eid, a, source="llm", note="from upsert")
            return eid, False
        cur = self.conn.execute(
            "INSERT INTO elements (name, aliases, category, tags, meta, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (name, _j([]), category, _j(tags), _j(meta), now, now),
        )
        eid = cur.lastrowid
        self.conn.commit()
        for a in aliases:
            self.add_alias(eid, a, source="llm", note="from upsert")
        return eid, True

    def all_elements(self) -> list[dict]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM elements ORDER BY name")]

    # ------------------------------------------------------------ events
    def add_event(
        self,
        element_id: int,
        content: str,
        ts: str = "",
        source: str = "",
        ref: str = "",
        status: str = "active",
        tags: Optional[Iterable[str]] = None,
        raw: str = "",
        ts_source: str = "",
    ) -> tuple[Optional[int], bool]:
        """append-only 追加事件。无 ts → status='pending'（待定区）。返回 (id, inserted?)"""
        if not ts.strip():
            if ts_source != "knowledge":
                ts, status = "", "pending"
            # knowledge（概念）无时间但有效，不强制 pending
        ts_source = ts_source or ("explicit" if ts else "empty")
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO events (element_id, ts, content, source, ref, status, tags, raw, ts_source, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (element_id, ts.strip(), content.strip(), source, ref, status, _j(list(tags or [])), raw, ts_source, utcnow()),
        )
        self.conn.commit()
        if cur.rowcount == 0:
            return None, False
        return cur.lastrowid, True

    def events_of(
        self,
        element_id: int,
        since: str = "",
        status: str = "active",
        limit: int = 100,
        as_of: str = "",
    ) -> list[dict]:
        q = "SELECT * FROM events WHERE element_id = ?"
        args: list = [element_id]
        if status:
            q += " AND status = ?"
            args.append(status)
        if since:
            q += " AND ts >= ?"
            args.append(since)
        if as_of:
            # 历史视角：时间未知(pending)的事件不能用于历史时点
            q += " AND ts != '' AND ts <= ?"
            args.append(as_of)
        q += " ORDER BY ts LIMIT ?"
        args.append(limit)
        return [dict(r) for r in self.conn.execute(q, args)]

    def pending_events(self) -> list[dict]:
        # knowledge（概念）无时间但有效，不属于"缺时间待补"
        return [dict(r) for r in self.conn.execute(
            "SELECT e.*, el.name AS element FROM events e JOIN elements el ON el.id=e.element_id"
            " WHERE e.status='pending' AND e.ts_source != 'knowledge' ORDER BY e.created_at"
        )]

    def expire_event(self, event_id: int) -> bool:
        """失效标记（不删除）。"""
        cur = self.conn.execute("UPDATE events SET status='expired' WHERE id=?", (event_id,))
        self.conn.commit()
        return cur.rowcount > 0

    def settle_pending(self, element_id: int, ts: str, content_fragment: str = "") -> dict:
        """待定区补时间（v0.6.4）：pending → active + ts + ts_source='settled'。

        去重：同元素同 content 的多条 pending 只保留最早一条；与已 active
        同 (element,ts,content) 冲突时跳过（保留原 active）。
        返回 {settled, dropped, skipped}。
        """
        q = "SELECT * FROM events WHERE element_id=? AND status='pending'"
        args: list = [element_id]
        if content_fragment:
            q += " AND content LIKE ?"
            args.append(f"%{content_fragment}%")
        rows = [dict(r) for r in self.conn.execute(q, args)]
        settled = dropped = skipped = 0
        seen_content: set[str] = set()
        for r in sorted(rows, key=lambda x: x["id"]):
            if r["content"] in seen_content:
                self.conn.execute("DELETE FROM events WHERE id=?", (r["id"],))
                dropped += 1
                continue
            seen_content.add(r["content"])
            dup = self.conn.execute(
                "SELECT 1 FROM events WHERE element_id=? AND ts=? AND content=? AND id!=?",
                (element_id, ts, r["content"], r["id"]),
            ).fetchone()
            if dup:
                self.conn.execute("DELETE FROM events WHERE id=?", (r["id"],))
                skipped += 1
                continue
            self.conn.execute(
                "UPDATE events SET ts=?, status='active', ts_source='settled' WHERE id=?",
                (ts, r["id"]),
            )
            settled += 1
        self.conn.commit()
        return {"settled": settled, "dropped": dropped, "skipped": skipped}

    def settle_all_pending(self, ts: str = "", from_source: bool = True) -> dict:
        """批量补时间：全部 pending。ts 缺省今天；from_source 时优先从 source 提取日期。"""
        import re as _re  # noqa: PLC0415

        total = {"settled": 0, "dropped": 0, "skipped": 0}
        for p in self.pending_events():
            t = ts
            if not t and from_source:
                m = _re.search(r"(\d{4}-\d{2}-\d{2})", p["source"])
                if m:
                    t = m.group(1)
            if not t:
                t = utcnow()[:10]
            r = self.settle_pending(p["element_id"], t, content_fragment="")
            for k in total:
                total[k] += r[k]
        return total

    def snapshot(self, element_id: int) -> dict:
        """当前快照：最近一条非 pending 事件 + 事件计数。"""
        evs = self.events_of(element_id, status="active", limit=1)
        n = self.conn.execute(
            "SELECT COUNT(*) c FROM events WHERE element_id=? AND status='active'", (element_id,)
        ).fetchone()["c"]
        return {"element_id": element_id, "latest": evs[0] if evs else None, "active_count": n}

    # ------------------------------------------------------------ links
    def upsert_link(
        self,
        a_id: int,
        b_id: int,
        relation: str = "related",
        strength: float = 0.5,
        method: str = "hard",
        evidence: str = "",
    ) -> tuple[Optional[int], bool]:
        if a_id == b_id:
            return None, False
        a, b = min(a_id, b_id), max(a_id, b_id)
        now = utcnow()
        row = self.conn.execute(
            "SELECT * FROM links WHERE from_id=? AND to_id=? AND relation=?",
            (a, b, relation),
        ).fetchone()
        if row:
            new_s = max(row["strength"], float(strength))
            self.conn.execute(
                "UPDATE links SET strength=?, method=?, evidence=?, updated_at=? WHERE id=?",
                (new_s, method, evidence or row["evidence"], now, row["id"]),
            )
            self.conn.commit()
            return row["id"], False
        cur = self.conn.execute(
            "INSERT INTO links (from_id, to_id, relation, strength, method, evidence, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (a, b, relation, float(strength), method, evidence, now, now),
        )
        self.conn.commit()
        return cur.lastrowid, True

    def links_of(self, element_id: int) -> list[dict]:
        rows = self.conn.execute(
            "SELECT l.*, a.name AS a_name, b.name AS b_name FROM links l"
            " JOIN elements a ON a.id=l.from_id JOIN elements b ON b.id=l.to_id"
            " WHERE l.from_id=? OR l.to_id=? ORDER BY l.strength DESC",
            (element_id, element_id),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["other_id"] = r["to_id"] if r["from_id"] == element_id else r["from_id"]
            d["other_name"] = r["b_name"] if r["from_id"] == element_id else r["a_name"]
            out.append(d)
        return out

    def neighbors(self, element_ids: Iterable[int], max_hops: int = 3) -> dict[int, int]:
        """BFS：从元素集出发，返回 {element_id: min_hops}（1..max_hops）。"""
        ids = set(element_ids)
        out: dict[int, int] = {i: 0 for i in ids}
        frontier = ids
        for hop in range(1, max_hops + 1):
            nxt: set[int] = set()
            for fid in frontier:
                for r in self.conn.execute(
                    "SELECT from_id, to_id FROM links WHERE from_id=? OR to_id=?", (fid, fid)
                ):
                    other = r["to_id"] if r["from_id"] == fid else r["from_id"]
                    if other not in out:
                        out[other] = hop
                        nxt.add(other)
            if not nxt:
                break
            frontier = nxt
        return out

    # ------------------------------------------------------------ decisions
    def add_decision(
        self,
        query: str,
        elements_used: list,
        result: str,
        confidence: Optional[float],
        mode: str,
        context_snapshot: dict,
    ) -> int:
        cur = self.conn.execute(
            "INSERT INTO decisions (created_at, query, elements_used, result, confidence, mode, context_snapshot)"
            " VALUES (?,?,?,?,?,?,?)",
            (utcnow(), query, _j(elements_used), result, confidence, mode, _j(context_snapshot)),
        )
        self.conn.commit()
        return cur.lastrowid

    def recent_decisions(self, limit: int = 20) -> list[dict]:
        return [dict(r) for r in self.conn.execute(
            "SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?", (limit,)
        )]

    # ------------------------------------------------------------ llm cache
    def cache_get(self, key: str) -> Optional[str]:
        row = self.conn.execute(
            "SELECT response FROM llm_cache WHERE key=?", (key,)
        ).fetchone()
        return row["response"] if row else None

    def cache_set(self, key: str, model: str, schema_ver: str, response: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO llm_cache (key, model, schema_ver, created_at, response)"
            " VALUES (?,?,?,?,?)",
            (key, model, schema_ver, utcnow(), response),
        )
        self.conn.commit()

    # ------------------------------------------------------------ buffers（话题缓冲）
    def buffer_add(self, topic: str, text: str, source: str = "") -> tuple[int, int]:
        """追加一条到话题缓冲，返回 (id, 该话题当前轮数)。"""
        cur = self.conn.execute(
            "INSERT INTO buffers (topic, text, source, created_at) VALUES (?,?,?,?)",
            (topic, text, source, utcnow()),
        )
        self.conn.commit()
        n = self.conn.execute(
            "SELECT COUNT(*) c FROM buffers WHERE topic=?", (topic,)
        ).fetchone()["c"]
        return cur.lastrowid, n

    def buffer_rows(self, topic: str) -> list[dict]:
        return [dict(r) for r in self.conn.execute(
            "SELECT * FROM buffers WHERE topic=? ORDER BY id", (topic,)
        )]

    def buffer_topics(self) -> list[dict]:
        """各话题缓冲统计：轮数/来源数。"""
        return [dict(r) for r in self.conn.execute(
            "SELECT topic, COUNT(*) AS rounds, GROUP_CONCAT(DISTINCT source) AS sources"
            " FROM buffers GROUP BY topic ORDER BY rounds DESC"
        )]

    def buffer_clear(self, topic: Optional[str] = None) -> int:
        """清空缓冲（topic 为空则全部）。返回删除条数。"""
        if topic:
            cur = self.conn.execute("DELETE FROM buffers WHERE topic=?", (topic,))
        else:
            cur = self.conn.execute("DELETE FROM buffers")
        self.conn.commit()
        return cur.rowcount

    def buffer_total(self) -> int:
        return self.conn.execute("SELECT COUNT(*) c FROM buffers").fetchone()["c"]

    # ------------------------------------------------------------ kv 配置
    DEFAULT_CONFIG = {"buffer.flush_rounds": "10"}

    def kv_get(self, key: str) -> str:
        row = self.conn.execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone()
        if row:
            return row["v"]
        return self.DEFAULT_CONFIG.get(key, "")

    def kv_set(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO kv (k, v) VALUES (?,?)", (key, value)
        )
        self.conn.commit()

    def kv_all(self) -> dict:
        out = dict(self.DEFAULT_CONFIG)
        for r in self.conn.execute("SELECT k, v FROM kv"):
            out[r["k"]] = r["v"]
        return out

    # ------------------------------------------------------------ 树（v0.5）
    def set_parent(self, element_id: int, parent_id: Optional[int]) -> tuple[bool, str]:
        """挂父节点（同时维护 depth）。防止环。"""
        if parent_id is not None:
            if parent_id == element_id:
                return False, "不能挂到自己"
            # 防环：新父不能是自己的后代
            anc = self.element_ancestors(parent_id)
            if element_id in anc:
                return False, "会造成环（父是自身后代）"
        depth = 1
        if parent_id is not None:
            p = self.element_by_id(parent_id)
            depth = (p["depth"] if p else 0) + 1
        self.conn.execute(
            "UPDATE elements SET parent_id=?, depth=?, updated_at=? WHERE id=?",
            (parent_id, depth, utcnow(), element_id),
        )
        self.conn.commit()
        return True, f"depth={depth}"

    # 注：`element_children` 在下面还有一份**更全**的实现（主归属子 + memberships 挂靠子，带 via 标记）；
    # 同名重复定义时后者覆盖前者 ⇒ 只查 parent_id 的那一版曾是**死代码**，已于 2026-10-03 删除。
    # 别再往类里加第二份同名方法。

    def element_ancestors(self, element_id: int) -> list[int]:
        """祖先链（自底向上），含自身。"""
        chain = [element_id]
        cur = self.element_by_id(element_id)
        while cur and cur.get("parent_id"):
            chain.append(cur["parent_id"])
            cur = self.element_by_id(cur["parent_id"])
        return chain

    def element_tree(self, element_id: int, max_depth: int = 10) -> list[dict]:
        """子树（DFS 先序，父前子后），每节点带事件数。"""
        out: list[dict] = []
        stack = [(element_id, 1)]
        while stack:
            eid, d = stack.pop()
            if d > max_depth:
                continue
            el = self.element_by_id(eid)
            if not el:
                continue
            n_ev = self.conn.execute(
                "SELECT COUNT(*) c FROM events WHERE element_id=?", (eid,)
            ).fetchone()["c"]
            node = {"id": eid, "name": el["name"], "category": el["category"],
                    "depth": el["depth"], "events": n_ev,
                    "children_summary": el["children_summary"]}
            out.append(node)
            kids = self.element_children(eid)
            for ch in reversed(kids):  # 栈：逆序压入 → 顺序弹出
                stack.append((ch["id"], d + 1))
        return out

    def max_subtree_depth(self, element_id: int) -> int:
        """子树最大深度（相对根）。"""
        depths = [n["depth"] for n in self.element_tree(element_id, 100)]
        base = self.element_by_id(element_id)["depth"] if self.element_by_id(element_id) else 1
        return max((d - base + 1 for d in depths), default=1)

    def set_children_summary(self, element_id: int, summary: str) -> None:
        self.conn.execute(
            "UPDATE elements SET children_summary=?, updated_at=? WHERE id=?",
            (summary, utcnow(), element_id),
        )
        self.conn.commit()

    # ------------------------------------------------------------ artifacts（产出物索引）
    def add_artifact(
        self, element_id: int, task: str, filename: str,
        kind: str = "process", version: str = "", path: str = "", note: str = "", ts: str = "",
    ) -> int:
        cur = self.conn.execute(
            "INSERT INTO artifacts (element_id, ts, task, kind, filename, version, path, note, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (element_id, ts or utcnow()[:10], task, kind, filename, version, path, note, utcnow()),
        )
        self.conn.commit()
        return cur.lastrowid

    def artifacts_of(self, element_id: Optional[int] = None) -> list[dict]:
        q = ("SELECT a.*, e.name AS element FROM artifacts a JOIN elements e ON e.id=a.element_id")
        args: list = []
        if element_id:
            q += " WHERE a.element_id=?"
            args.append(element_id)
        q += " ORDER BY CASE a.kind WHEN 'conclusion' THEN 0 WHEN 'data' THEN 1 ELSE 2 END, a.ts DESC"
        return [dict(r) for r in self.conn.execute(q, args)]

    # ------------------------------------------------------------ 归宿关系 DAG（v0.5.1）
    def attach_parent(
        self, child_id: int, parent_id: int, role: str = "member", period: str = "",
    ) -> tuple[bool, str]:
        """登记父子关系（多父）。首个父自动成为主归属(parent_id)。防环。"""
        if parent_id == child_id:
            return False, "不能挂到自己"
        # 防环：child 不能成为 parent 的祖先
        if child_id in self.all_parents_of(parent_id):
            return False, "会造成环"
        child = self.element_by_id(child_id)
        if not child:
            return False, "子元素不存在"
        # 首个父 → 主归属
        if child.get("parent_id") is None:
            ok, msg = self.set_parent(child_id, parent_id)
            if not ok:
                return False, msg
        cur = self.conn.execute(
            "SELECT 1 FROM memberships WHERE child_id=? AND parent_id=?",
            (child_id, parent_id),
        ).fetchone()
        if not cur:
            self.conn.execute(
                "INSERT INTO memberships (child_id, parent_id, role, period, created_at)"
                " VALUES (?,?,?,?,?)",
                (child_id, parent_id, role, period, utcnow()),
            )
            self.conn.commit()
        return True, "已登记归宿关系"

    def detach_parent(self, child_id: int, parent_id: int) -> tuple[bool, str]:
        cur = self.conn.execute(
            "DELETE FROM memberships WHERE child_id=? AND parent_id=?", (child_id, parent_id)
        )
        self.conn.commit()
        if cur.rowcount == 0:
            return False, "无此归宿关系"
        # 若解除的是主归属，把 memberships 里最早的父提升为主归属
        child = self.element_by_id(child_id)
        if child and child.get("parent_id") == parent_id:
            nxt = self.conn.execute(
                "SELECT parent_id FROM memberships WHERE child_id=? ORDER BY id LIMIT 1",
                (child_id,),
            ).fetchone()
            if nxt:
                self.set_parent(child_id, nxt["parent_id"])
            else:
                self.set_parent(child_id, None)
        return True, "已解除"

    def parents_of(self, element_id: int) -> list[dict]:
        """元素的全部父（主归属第一，其余按登记序），带角色/时期。"""
        el = self.element_by_id(element_id)
        out = []
        if el and el.get("parent_id"):
            p = self.element_by_id(el["parent_id"])
            if p:
                out.append({"id": p["id"], "name": p["name"], "role": "primary", "period": ""})
        for r in self.conn.execute(
            "SELECT parent_id, role, period FROM memberships WHERE child_id=? ORDER BY id",
            (element_id,),
        ):
            p = self.element_by_id(r["parent_id"])
            if p and p["id"] not in [o["id"] for o in out]:
                out.append({"id": p["id"], "name": p["name"], "role": r["role"], "period": r["period"]})
        return out

    def all_parents_of(self, element_id: int) -> list[int]:
        """全部祖先 id（沿 parent_id + memberships 递归），含自身。防环用。"""
        seen: set[int] = set()
        frontier = [element_id]
        while frontier:
            eid = frontier.pop()
            if eid in seen:
                continue
            seen.add(eid)
            el = self.element_by_id(eid)
            if el and el.get("parent_id"):
                frontier.append(el["parent_id"])
            for r in self.conn.execute("SELECT parent_id FROM memberships WHERE child_id=?", (eid,)):
                frontier.append(r["parent_id"])
        return list(seen)

    def element_children(self, element_id: int) -> list[dict]:
        """直接子：主归属子 + memberships 挂靠子（去重）。"""
        ids: dict[int, dict] = {}
        for r in self.conn.execute("SELECT * FROM elements WHERE parent_id=?", (element_id,)):
            d = dict(r)
            d["via"] = "primary"
            ids[d["id"]] = d
        for r in self.conn.execute(
            "SELECT e.* FROM memberships m JOIN elements e ON e.id=m.child_id WHERE m.parent_id=?",
            (element_id,),
        ):
            d = dict(r)
            d["via"] = "attach"
            ids.setdefault(d["id"], d)
        return sorted(ids.values(), key=lambda x: x["name"])

    # ------------------------------------------------------------ 元素合并（v0.6.1）
    def merge_elements(self, from_id: int, to_id: int, keep_alias: bool = True) -> dict:
        """把碎片元素(from)合并进规范元素(to)：事件重挂/别名归并/链接归并/产出物/子元素/父。

        append-only 兼容：事件不删除，重挂到 to（(ts,content) 冲突保留 to 的）。
        返回统计。
        """
        stats = {"events": 0, "aliases": 0, "links": 0, "artifacts": 0, "children": 0, "parents": 0}
        if from_id == to_id:
            return stats
        # 事件重挂（冲突忽略）
        rows = self.conn.execute("SELECT * FROM events WHERE element_id=?", (from_id,)).fetchall()
        for r in rows:
            self.conn.execute(
                "INSERT OR IGNORE INTO events (element_id, ts, content, source, ref, status, tags, raw, ts_source, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (to_id, r["ts"], r["content"], r["source"], r["ref"], r["status"], r["tags"], r["raw"], r["ts_source"], r["created_at"]),
            )
            stats["events"] += 1
        self.conn.execute("DELETE FROM events WHERE element_id=?", (from_id,))
        # 别名归并
        for a in self.aliases_of(from_id):
            self.conn.execute(
                "INSERT OR IGNORE INTO aliases (alias, element_id, source, note, created_at) VALUES (?,?,?,?,?)",
                (a, to_id, "merge", f"merged from {from_id}", utcnow()),
            )
            stats["aliases"] += 1
        # keep_alias：被合并元素的名字也作为别名（如 光伏ETF515790 → 光伏ETF 的别名）
        fname = self.element_by_id(from_id)["name"]
        if keep_alias and fname != self.element_by_id(to_id)["name"]:
            self.conn.execute(
                "INSERT OR IGNORE INTO aliases (alias, element_id, source, note, created_at) VALUES (?,?,?,?,?)",
                (fname, to_id, "merge", "merged element name", utcnow()),
            )
            stats["aliases"] += 1
        self.conn.execute("DELETE FROM aliases WHERE element_id=?", (from_id,))
        # 链接重挂（去重，strength 取 max）
        for r in self.conn.execute("SELECT * FROM links WHERE from_id=? OR to_id=?", (from_id, from_id)):
            a, b = r["from_id"], r["to_id"]
            a, b = (to_id, b) if a == from_id else (a, to_id)
            if a == b:
                continue
            x, y = min(a, b), max(a, b)
            exist = self.conn.execute(
                "SELECT strength FROM links WHERE from_id=? AND to_id=? AND relation=?",
                (x, y, r["relation"]),
            ).fetchone()
            if exist:
                self.conn.execute(
                    "UPDATE links SET strength=? WHERE from_id=? AND to_id=? AND relation=?",
                    (max(exist["strength"], r["strength"]), x, y, r["relation"]),
                )
            else:
                self.conn.execute(
                    "INSERT INTO links (from_id, to_id, relation, strength, method, evidence, created_at, updated_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (x, y, r["relation"], r["strength"], r["method"], r["evidence"], r["created_at"], utcnow()),
                )
            stats["links"] += 1
        self.conn.execute("DELETE FROM links WHERE from_id=? OR to_id=?", (from_id, from_id))
        # 产出物重挂
        cur = self.conn.execute(
            "UPDATE artifacts SET element_id=? WHERE element_id=?", (to_id, from_id)
        )
        stats["artifacts"] = cur.rowcount
        # 子元素重挂 + 父归属重挂
        cur = self.conn.execute(
            "UPDATE elements SET parent_id=? WHERE parent_id=?", (to_id, from_id)
        )
        stats["children"] = cur.rowcount
        cur = self.conn.execute(
            "UPDATE memberships SET parent_id=? WHERE parent_id=?", (to_id, from_id)
        )
        stats["parents"] = cur.rowcount
        cur = self.conn.execute(
            "UPDATE memberships SET child_id=? WHERE child_id=?", (to_id, from_id)
        )
        stats["parents"] += cur.rowcount
        # 删除空壳
        self.conn.execute("DELETE FROM elements WHERE id=?", (from_id,))
        self.conn.commit()
        return stats
    # ------------------------------------------------------------ 使用日志（v0.7.14）
    def log_usage(self, action: str, element: str = "", query: str = "", depth_used: int = 0,
                  elements_recalled: int = 0, snapshot_used: str = "", correction: str = "",
                  related: list = None) -> int:
        cur = self.conn.execute(
            "INSERT INTO usage_log (ts, session, action, element, query, depth_used, elements_recalled, snapshot_used, correction, related, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (utcnow()[:10], "", action, element, query[:100], depth_used, elements_recalled,
             snapshot_used, correction, json.dumps(related or [], ensure_ascii=False), utcnow()),
        )
        self.conn.commit()
        return cur.lastrowid

    def usage_since(self, since_date: str = "", element: str = "") -> list[dict]:
        q = "SELECT * FROM usage_log"
        args: list = []
        conds = []
        if since_date:
            conds.append("ts >= ?")
            args.append(since_date)
        if element:
            conds.append("element = ?")
            args.append(element)
        if conds:
            q += " WHERE " + " AND ".join(conds)
        q += " ORDER BY id"
        return [dict(r) for r in self.conn.execute(q, args)]

    def usage_stats(self, since_date: str = "") -> dict:
        """区间使用统计（按元素+action 聚合）。"""
        rows = self.usage_since(since_date)
        out: dict = {"total": len(rows), "by_element": {}, "by_action": {}, "corrections": 0}
        pairs: dict = {}
        for r in rows:
            el = r["element"] or "(无)"
            ac = r["action"]
            # 共现统计（组合习惯）
            try:
                rel = json.loads(r["related"]) if r["related"] else []
            except (ValueError, TypeError):
                rel = []
            for other in rel:
                if other and other != el:
                    k = tuple(sorted([el, other]))
                    pairs[k] = pairs.get(k, 0) + 1
            d = out["by_element"].setdefault(el, {"calls": 0, "depths": [], "recalled": []})
            d["calls"] += 1
            d["depths"].append(r["depth_used"])
            d["recalled"].append(r["elements_recalled"])
            a = out["by_action"].setdefault(ac, {"calls": 0, "depths": [], "recalled": []})
            a["calls"] += 1
            a["depths"].append(r["depth_used"])
            a["recalled"].append(r["elements_recalled"])
            if r["correction"]:
                out["corrections"] += 1
        for el in out["by_element"]:
            d = out["by_element"][el]
            d["avg_depth"] = round(sum(d["depths"]) / len(d["depths"]), 2) if d["depths"] else 0
            d["avg_recalled"] = round(sum(d["recalled"]) / len(d["recalled"]), 1) if d["recalled"] else 0
        for ac in out["by_action"]:
            a = out["by_action"][ac]
            a["avg_depth"] = round(sum(a["depths"]) / len(a["depths"]), 2) if a["depths"] else 0
            a["avg_recalled"] = round(sum(a["recalled"]) / len(a["recalled"]), 1) if a["recalled"] else 0
        out["pairs"] = {"|".join(k): v for k, v in sorted(pairs.items(), key=lambda x: -x[1])}
        return out

    def stats(self) -> dict:
        def n(t: str) -> int:
            return self.conn.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()["c"]

        return {
            "elements": n("elements"),
            "events": n("events"),
            "active_events": self.conn.execute(
                "SELECT COUNT(*) c FROM events WHERE status='active'"
            ).fetchone()["c"],
            "pending_events": n("events") and self.conn.execute(
                "SELECT COUNT(*) c FROM events WHERE status='pending'"
            ).fetchone()["c"],
            "links": n("links"),
            "decisions": n("decisions"),
            "llm_cache": n("llm_cache"),
        }

    def close(self) -> None:
        self.conn.commit()
        self.conn.close()
