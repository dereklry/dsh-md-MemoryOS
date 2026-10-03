"""memoryos_kernel.paths — 路径根（唯一来源；共享包版）。

与上游内核的区别：**这里没有台账面**——工作区／hermes／openclaw／投资目录一律不存在，
所以只留"包根 + 数据根 + DSH 家目录"三件，且**默认值不含任何本机路径**：
数据根由 DSH 侧注入的 MEMORYOS_DATA 决定；未注入时退到包目录下的 data/（便于独立跑测试）。

环境变量：
  MEMORYOS_DATA         共享包数据根（DSH 侧已设）；内核库默认落 <该根>/elements
  MEMORYOS_KERNEL_DATA  直接指定内核数据根（覆盖上面那条推导）
  MD_REPO_ROOT          兼容上游叫法：显式指定包根
  DSH_HOME              DSH 主目录（skills 等）
"""

from __future__ import annotations

import os

_HERE = os.path.dirname(os.path.abspath(__file__))                  # <pkg>/python/memoryos_kernel
_PKG = os.path.dirname(os.path.dirname(_HERE))                      # <pkg>


def _env(name: str, default: str) -> str:
    """环境变量优先；空串视为未设置（便于 CLI 传空值回退默认）。"""
    v = os.environ.get(name)
    return v if v else default


# ---------- 包自身 ----------
MEMORY_DECISION = _env("MD_REPO_ROOT", _PKG)
PYTHON_DIR = os.path.join(MEMORY_DECISION, "python")
DOCS_DIR = os.path.join(MEMORY_DECISION, "docs")

# ---------- 数据根（memory.db 所在目录）----------
# 共享包数据根＝DSH 侧注入的 MEMORYOS_DATA（与 graph.json 同根），内核库再往下一层 elements/ ——
# 这样"词法图"与"元素库"两个数据根天然分开（设计档 §4.1 定的"数据根分目录"）。
_PKG_DATA = _env("MEMORYOS_DATA", os.path.join(MEMORY_DECISION, "data"))
DATA_ROOT = _env("MEMORYOS_KERNEL_DATA", os.path.join(_PKG_DATA, "elements"))
EXPORTS_DIR = os.path.join(DATA_ROOT, "exports")

# 上游用 WORKSPACE 放开关文件（jev-switch.txt）；共享包没有工作区概念，
# 统一落数据根下，避免任何本机路径成为默认值。
WORKSPACE = _env("MEMORYOS_WORKSPACE", DATA_ROOT)
DSH_HOME = _env("DSH_HOME", os.path.join(os.path.expanduser("~"), ".dsh"))
SKILLS = os.path.join(DSH_HOME, "skills")

_GIT_CACHE = None


def git_exe() -> str:
    """git 可执行文件：PATH 优先；找不到则返回 'git'（调用方据此降级）。"""
    global _GIT_CACHE
    if _GIT_CACHE is None:
        import shutil

        found = shutil.which("git")
        _GIT_CACHE = found or "git"
    return _GIT_CACHE
