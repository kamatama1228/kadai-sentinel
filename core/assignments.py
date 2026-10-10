"""課題の設定と、自分の提出状況の読み取り(読み取り専用。Moodle には何も送らない)。"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from typing import Any

from core.materials import list_courses
from core.moodle import MoodleClient
from core.tasks import _clean

STATUS_LABELS = {"new": "未提出", "draft": "下書き", "submitted": "提出済み", "reopened": "再提出待ち"}


@dataclass
class Assignment:
    id: int
    cmid: int
    course_id: int
    course: str
    title: str
    due: int | None
    cutoff: int | None
    drafts: bool                 # True なら「下書き → 提出」の2段階がある
    statement: bool              # 提出時の宣言への同意が必要
    file_enabled: bool
    max_files: int
    max_bytes: int
    filetypes: str
    text_enabled: bool
    url: str
    raw: dict[str, Any] = field(repr=False, default_factory=dict)


def _configs(a: dict[str, Any]) -> dict[tuple[str, str], str]:
    return {(c["plugin"], c["name"]): c["value"] for c in a.get("configs", [])
            if c.get("subtype") == "assignsubmission"}


def list_assignments(client: MoodleClient) -> list[Assignment]:
    names = {c["id"]: _clean(c["fullname"]) for c in list_courses(client)}
    data = client.call("mod_assign_get_assignments", courseids=list(names))
    out = []
    for co in data.get("courses", []):
        for a in co.get("assignments", []):
            cfg = _configs(a)
            out.append(Assignment(
                id=a["id"], cmid=a["cmid"], course_id=co["id"], course=names.get(co["id"], ""),
                title=_clean(a["name"]), due=a.get("duedate") or None, cutoff=a.get("cutoffdate") or None,
                drafts=bool(a.get("submissiondrafts")), statement=bool(a.get("requiresubmissionstatement")),
                file_enabled=cfg.get(("file", "enabled")) == "1",
                max_files=int(cfg.get(("file", "maxfilesubmissions")) or 0),
                max_bytes=int(cfg.get(("file", "maxsubmissionsizebytes")) or 0),
                filetypes=cfg.get(("file", "filetypeslist")) or "",
                text_enabled=cfg.get(("onlinetext", "enabled")) == "1",
                url=f"{client.base_url}/mod/assign/view.php?id={a['cmid']}", raw=a))
    return out


def find_assignment(client: MoodleClient, query: str) -> list[Assignment]:
    """課題ID・cmid・名前(授業名を含めてもよい)で探す。"""
    q = unicodedata.normalize("NFKC", query).lower().strip()
    found = []
    for a in list_assignments(client):
        hay = f"{a.course} {a.title}".lower()
        if q in (str(a.id), str(a.cmid)) or all(w in hay for w in q.split()):
            found.append(a)
    return found


def submission_status(client: MoodleClient, a: Assignment) -> dict[str, Any]:
    s = client.call("mod_assign_get_submission_status", assignid=a.id)
    la = s.get("lastattempt") or {}
    sub = la.get("submission") or {}
    files, text = [], ""
    for p in sub.get("plugins", []):
        for fa in p.get("fileareas", []) or []:
            for f in fa.get("files", []) or []:
                files.append((f.get("filename"), int(f.get("filesize") or 0)))
        for ef in p.get("editorfields", []) or []:
            text = ef.get("text") or text
    return {"status": sub.get("status", "new"), "files": files, "text": text,
            "canedit": la.get("canedit", False), "cansubmit": la.get("cansubmit", False),
            "locked": la.get("locked", False), "graded": la.get("graded", False),
            "extension": la.get("extensionduedate")}
