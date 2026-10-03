"""memoryos_kernel 冒烟自测（"Python 组闸"）：建库 → ingest → timeline → snapshot → expire → status。

跑法（零依赖，不需要装任何东西；数据根用 tempfile，**不碰任何真实库**）：

    python <pkg>/python/tests/test_kernel_smoke.py

退出码 0＝全过；非 0 且列出每条失败原因（形状照本包闸的纪律：失败要能自己说清哪一条）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.dirname(HERE)                      # <pkg>/python


def run(args, data_root):
    env = dict(os.environ)
    env["PYTHONPATH"] = PKG_ROOT
    env["MEMORYOS_DATA"] = data_root
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    p = subprocess.run(
        [sys.executable, "-m", "memoryos_kernel", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=PKG_ROOT,
    )
    try:
        data = json.loads(p.stdout) if p.stdout.strip() else None
    except ValueError:
        data = None
    return p, data


def main() -> int:
    fails: list[str] = []
    with tempfile.TemporaryDirectory(prefix="mos-kernel-") as tmp:
        p, d = run(["status"], tmp)
        if p.returncode != 0 or not isinstance(d, dict) or d.get("ok") is not False:
            fails.append(f"status(空库) 应如实说库不存在：rc={p.returncode} out={p.stdout[:120]} err={p.stderr[:160]}")

        p, d = run(["ingest", "--text", "2026-10-01 买入 510300 3000 元", "--source", "selftest"], tmp)
        if p.returncode != 0 or not d or d.get("events_new") != 1:
            fails.append(f"ingest 应落 1 条事件：out={p.stdout[:160]} err={p.stderr[:160]}")

        p, d = run(["timeline", "510300"], tmp)
        evs = (d or {}).get("events") or []
        if not (d or {}).get("found") or len(evs) != 1 or evs[0].get("ts") != "2026-10-01":
            fails.append(f"timeline 应命中 1 条带 ts 的事件：out={p.stdout[:200]}")

        p, d = run(["snapshot", "510300"], tmp)
        if not d or d.get("active_count") != 1 or not (d.get("latest") or {}).get("content"):
            fails.append(f"snapshot 形状应为 {{element_id,latest,active_count}}：out={p.stdout[:200]}")

        p, d = run(["expire", "510300", "买入"], tmp)
        if not d or d.get("matched") != 1:
            fails.append(f"expire 应按片段标失效 1 条：out={p.stdout[:160]}")

        # import：一份 md 按元素导入（幂等；[已失效]→expired；`→ 引用` 进 ref；category 可传不再写死 stock）
        md = os.path.join(tmp, "某交易逻辑.md")
        with open(md, "w", encoding="utf-8") as fh:
            fh.write("- 2026-10-01 建仓 1000 元 → 交易记录.md\n- 2026-10-02 减仓 500 元 [已失效]\n")
        p, d = run(["import", "--element", "某交易逻辑", "--path", md, "--category", "topic"], tmp)
        if p.returncode != 0 or not d or d.get("parsed") != 2 or d.get("new") != 2:
            fails.append(f"import 应解析 2 行、新增 2 条：out={p.stdout[:200]} err={p.stderr[:160]}")
        p, d = run(["import", "--element", "某交易逻辑", "--path", md, "--category", "topic"], tmp)
        if not d or d.get("new") != 0:
            fails.append(f"import 第二次应幂等（new=0）：out={p.stdout[:160]}")
        p, d = run(["timeline", "某交易逻辑", "--status", "all"], tmp)
        evs2 = (d or {}).get("events") or []
        if len(evs2) != 2 or (d or {}).get("category") != "topic":
            fails.append(f"import 后 timeline 应有 2 条且 category=topic：out={p.stdout[:200]}")
        if any("交易记录.md" in (e.get("content") or "") for e in evs2):
            fails.append("import 应把 `→ 引用` 放进事件的 ref 字段，而不是留在 content 里")
        if not any(e.get("status") == "expired" for e in evs2):
            fails.append("import 应把 [已失效] 标成 expired")

        # 历史视角（时间切面）：as_of ⇒ 只看该日期及之前
        p, d = run(["timeline", "某交易逻辑", "--status", "all", "--as-of", "2026-10-01"], tmp)
        evs3 = (d or {}).get("events") or []
        if len(evs3) != 1 or evs3[0].get("ts") != "2026-10-01":
            fails.append(f"as_of 历史视角应只看到 2026-10-01 那一条：out={p.stdout[:200]}")

        p, d = run(["status"], tmp)
        if not d or ((d.get("counts") or {}).get("events") != 3):
            fails.append(f"status 应报 events=3（ingest 1 + import 2）：out={p.stdout[:200]}")

    if fails:
        print("FAIL")
        for f in fails:
            print(" -", f)
        return 1
    print("ALL PASS (kernel smoke: 12 checks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
