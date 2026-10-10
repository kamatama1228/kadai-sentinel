"""授業の課題・小テストを「自分の提出状況と関係なく」取得する(共有チャンネル用)。"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable

from core.moodle import MoodleClient
from core.tasks import _clean, local_tz


def fmt_time(ts: int | None, with_date: bool = True) -> str:
    if not ts:
        return "-"
    dt = datetime.fromtimestamp(ts, local_tz())
    if not with_date:
        return dt.strftime("%H:%M")
    return dt.strftime("%m/%d(") + "月火水木金土日"[dt.weekday()] + dt.strftime(") %H:%M")


@dataclass
class Activity:
    id: str               # quiz:12 / assign:34
    course_id: int
    course: str
    title: str
    kind: str             # 小テスト / 課題
    open: int | None      # 公開・受付開始(なければ None)
    due: int | None       # 締切
    url: str
    timelimit: int = 0    # 小テストの制限時間(秒)
    rule: Any = None      # 手動登録の予定など、授業のルールとは別のルールを使うとき

    def is_open(self, now: int) -> bool:
        return (not self.open or self.open <= now) and (not self.due or now < self.due)

    @property
    def window_text(self) -> str:
        if self.open and self.due:
            same_day = fmt_time(self.open)[:8] == fmt_time(self.due)[:8]
            return f"{fmt_time(self.open)}〜{fmt_time(self.due, with_date=not same_day)}"
        if self.due:
            return f"締切 {fmt_time(self.due)}"
        if self.open:
            return f"{fmt_time(self.open)} から"
        return "締切なし"


GENERIC_KINDS = {"questionnaire": "アンケート", "feedback": "アンケート", "choice": "投票",
                 "lesson": "レッスン", "workshop": "ワークショップ", "h5pactivity": "H5P"}


def fetch_generic(client: MoodleClient, course_ids: Iterable[int],
                  course_names: dict[int, str]) -> list[Activity]:
    """アンケートなど小テスト・課題以外の活動を、カレンダーの開始・終了予定から作る。"""
    import re
    ids = sorted(set(course_ids))
    if not ids:
        return []
    now = int(time.time())
    data = client.call("core_calendar_get_calendar_events",
                       events={"courseids": ids},
                       options={"userevents": 0, "siteevents": 0,
                                "timestart": now - 30 * 86400, "timeend": now + 120 * 86400})
    acts: dict[str, Activity] = {}
    for ev in data.get("events", []):
        mod = ev.get("modulename")
        if mod not in GENERIC_KINDS:
            continue
        key = f"{mod}:{ev['instance']}"
        a = acts.get(key) or Activity(
            id=key, course_id=ev["courseid"], course=course_names.get(ev["courseid"], ""),
            title=_clean(re.sub(r"\s*[(（][^()（）]*(開始|終了|期限|open|close)[^()（）]*[)）]\s*$", "",
                                ev.get("name", ""))),
            kind=GENERIC_KINDS[mod], open=None, due=None,
            url=ev.get("url") or f"{client.base_url}/course/view.php?id={ev['courseid']}")
        if ev.get("eventtype") == "open":
            a.open = ev["timestart"]
        elif ev.get("eventtype") in ("close", "due", "expectcompletionon"):
            a.due = ev["timestart"]
        acts[key] = a
    return list(acts.values())


def fetch_activities(client: MoodleClient, course_ids: Iterable[int],
                     course_names: dict[int, str]) -> list[Activity]:
    ids = sorted(set(course_ids))
    if not ids:
        return []
    out: list[Activity] = []
    base = client.base_url
    for q in client.call("mod_quiz_get_quizzes_by_courses", courseids=ids).get("quizzes", []):
        if q.get("visible") is False:
            continue
        out.append(Activity(
            id=f"quiz:{q['id']}", course_id=q["course"], course=course_names.get(q["course"], ""),
            title=_clean(q["name"]), kind="小テスト",
            open=q.get("timeopen") or None, due=q.get("timeclose") or None,
            url=f"{base}/mod/quiz/view.php?id={q['coursemodule']}",
            timelimit=int(q.get("timelimit") or 0)))
    for co in client.call("mod_assign_get_assignments", courseids=ids).get("courses", []):
        for a in co.get("assignments", []):
            if a.get("visible") is False:
                continue
            out.append(Activity(
                id=f"assign:{a['id']}", course_id=co["id"], course=course_names.get(co["id"], ""),
                title=_clean(a["name"]), kind="課題",
                open=a.get("allowsubmissionsfromdate") or None,
                due=a.get("duedate") or a.get("cutoffdate") or None,
                url=f"{base}/mod/assign/view.php?id={a['cmid']}"))
    return out
