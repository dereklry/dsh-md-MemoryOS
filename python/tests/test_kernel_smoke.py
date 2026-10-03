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

        p, d = run(["status"], tmp)
        if not d or ((d.get("counts") or {}).get("events") != 1):
            fails.append(f"status 应报 events=1：out={p.stdout[:200]}")

    if fails:
        print("FAIL")
        for f in fails:
            print(" -", f)
        return 1
    print("ALL PASS (kernel smoke: 6 checks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
