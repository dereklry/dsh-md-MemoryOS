"""memoryos_kernel — 记忆-决策内核（memory-decision skill）。

能力：
  extract     对话/文本 → 元素 + 带时间戳事件 + 关联边（幂等入库）
  timeline    时间线（多股绳）查询 / 快照 / 失效标记 / Markdown 导出
  relevance   关联度三级漏斗：硬信号初筛 → LLM 语义评审（deepseek-harness）
  decide      决策流水线：召回 → 组装干净切面 → LLM 决策 / 降级决策包

Windows 适配（2026-09-19）：包导入时统一把 stdout/stderr 置为 UTF-8。
Windows 控制台默认码页 cp936/gbk，编不出 ✓ ⚠️ ℹ 等字符，任何 print 都会
UnicodeEncodeError 直接崩；放在包入口，cli 与 tests 一并受益（Linux 幂等无副作用）。
"""

__version__ = "0.1.0"

import sys as _sys

for _s in (_sys.stdout, _sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

from .db import KernelDB  # noqa: E402

__all__ = ["KernelDB", "__version__"]
