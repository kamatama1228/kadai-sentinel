"""授業の配布資料を materials/ にダウンロードする(更新されたものだけ)。

materials/ は .gitignore で除外している。公開リポジトリには絶対に入れないこと。
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from core.moodle import MoodleClient

MATERIALS_DIR = Path("materials")
INDEX_FILE = MATERIALS_DIR / ".index.json"
MAX_BYTES = 200 * 1024 * 1024  # 1ファイル200MBまで(動画などの巨大ファイル対策)
# Moodleが自動で付ける説明用ファイルなど、資料ではないもの
SKIP_MODULES = {"url", "label", "forum", "assign", "quiz", "questionnaire", "feedback", "choice"}


def safe_name(text: str, limit: int = 80) -> str:
    """Windows でも使えるファイル・フォルダ名にする。"""
    text = unicodedata.normalize("NFKC", text or "").strip()
    text = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", text)
    text = text.rstrip(". ")
    return (text[:limit] or "_").rstrip(". ")


@dataclass
class Material:
    course_id: int
    course: str
    section: str
    module: str
    filename: str
    fileurl: str
    filesize: int
    timemodified: int
    filepath: str = "/"

    @property
    def key(self) -> str:
        return self.fileurl.split("?")[0]

    @property
    def local_path(self) -> Path:
        sub = [p for p in self.filepath.strip("/").split("/") if p]
        return (MATERIALS_DIR / safe_name(self.course) / safe_name(self.section)
                / Path(*[safe_name(p) for p in sub]) / safe_name(self.filename, 150))


def list_courses(client: MoodleClient) -> list[dict[str, Any]]:
    data = client.call("core_course_get_enrolled_courses_by_timeline_classification",
                       classification="inprogress", limit=0)
    return data.get("courses", [])


def match_courses(courses: list[dict[str, Any]], query: str | None) -> list[dict[str, Any]]:
    if not query:
        return courses
    q = unicodedata.normalize("NFKC", query).lower()
    return [c for c in courses
            if q == str(c["id"]) or q in unicodedata.normalize("NFKC", c["fullname"]).lower()]


def iter_materials(client: MoodleClient, course: dict[str, Any]) -> Iterator[Material]:
    sections = client.call("core_course_get_contents", courseid=course["id"])
    for i, sec in enumerate(sections):
        sec_name = f"{i:02d}_{sec.get('name') or 'セクション'}"
        for mod in sec.get("modules", []):
            if mod.get("modname") in SKIP_MODULES:
                continue
            for f in mod.get("contents") or []:
                if f.get("type") != "file" or not f.get("fileurl"):
                    continue
                yield Material(
                    course_id=course["id"], course=course["fullname"], section=sec_name,
                    module=mod.get("name", ""), filename=f["filename"], fileurl=f["fileurl"],
                    filesize=int(f.get("filesize") or 0), timemodified=int(f.get("timemodified") or 0),
                    filepath=f.get("filepath") or "/",
                )


def _load_index() -> dict[str, Any]:
    try:
        return json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_index(index: dict[str, Any]) -> None:
    MATERIALS_DIR.mkdir(parents=True, exist_ok=True)
    INDEX_FILE.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")


def download(client: MoodleClient, m: Material) -> Path:
    path = m.local_path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    with client.session.get(m.fileurl, params={"token": client.token}, stream=True, timeout=120) as r:
        r.raise_for_status()
        chunks = r.iter_content(1 << 16)
        first = next(chunks, b"")
        # トークン切れなどのとき Moodle は JSON のエラーを返す(.ipynb など本物の JSON と区別する)
        if "application/json" in r.headers.get("Content-Type", "") and b'"errorcode"' in first[:1000]:
            raise RuntimeError(f"ダウンロードできませんでした: {first[:200].decode('utf-8', 'replace')}")
        with open(tmp, "wb") as fh:
            fh.write(first)
            for chunk in chunks:
                fh.write(chunk)
    tmp.replace(path)
    return path


def sync(client: MoodleClient, course_query: str | None = None, dry_run: bool = False,
         log=print) -> dict[str, list[Path]]:
    """新しい・更新された資料だけを取得する。戻り値は {"new": [...], "updated": [...], "skipped": [...]}"""
    index = _load_index()
    result: dict[str, list[Path]] = {"new": [], "updated": [], "skipped": []}
    for course in match_courses(list_courses(client), course_query):
        for m in iter_materials(client, course):
            prev = index.get(m.key)
            if prev and prev.get("timemodified") == m.timemodified and Path(prev["path"]).exists():
                continue
            if m.filesize > MAX_BYTES:
                log(f"  スキップ(大きすぎ {m.filesize // 2**20}MB): {m.filename}")
                result["skipped"].append(m.local_path)
                continue
            kind = "updated" if prev else "new"
            if dry_run:
                result[kind].append(m.local_path)
                continue
            try:
                path = download(client, m)
            except Exception as e:  # 1ファイルの失敗で全体を止めない
                log(f"  失敗: {m.filename} ({e})")
                result["skipped"].append(m.local_path)
                continue
            index[m.key] = {"path": str(path), "timemodified": m.timemodified,
                            "course_id": m.course_id}
            result[kind].append(path)
            log(f"  {'新着' if kind == 'new' else '更新'}: {path}")
            _save_index(index)  # 途中で止まっても続きから再開できるように
    return result
