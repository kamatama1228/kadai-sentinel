"""`uv run moodle whatsnew` 更新(git pull)で何が変わったか・更新したらやることを表示する。

CHANGELOG.md の「## 1.2.0 — 2026-11-01」のような見出しごとに区切り、
前に見たバージョン(state/seen_version)より新しいものだけを表示する。
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEEN = ROOT / "state" / "seen_version"
HEADING = re.compile(r"^## (\d+)\.(\d+)\.(\d+)\b.*$", re.M)


def version() -> str:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]


def _key(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def entries(text: str) -> list[tuple[str, str]]:
    """[(バージョン, 本文)] を新しい順に"""
    text = re.sub(r"<!--.*?-->\n?", "", text, flags=re.S)
    marks = list(HEADING.finditer(text))
    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        out.append((".".join(m.groups()), text[m.start():end].strip()))
    return out


def show(all_versions: bool = False) -> int:
    path = ROOT / "CHANGELOG.md"
    if not path.exists():
        print("CHANGELOG.md がありません。")
        return 1
    items = entries(path.read_text(encoding="utf-8"))
    seen = SEEN.read_text(encoding="utf-8").strip() if SEEN.exists() else ""
    if all_versions:
        new = items
    elif seen:
        new = [(v, b) for v, b in items if _key(v) > _key(seen)]
    else:
        new = items[:1]
    print(f"今のバージョン: {version()}" + (f"(前に見たのは {seen})" if seen else ""))
    if not new:
        print("前に見たときから、新しい変更はありません。")
    for _, body in new:
        print("\n" + body)
    if new and any("更新したらやること" in b for _, b in new):
        print("\n※「更新したらやること」がある版があります。上から順に済ませてください。")
    SEEN.parent.mkdir(exist_ok=True)
    SEEN.write_text(version() + "\n", encoding="utf-8")
    return 0
