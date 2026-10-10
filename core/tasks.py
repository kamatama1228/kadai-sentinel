"""Moodle のデータを共通の「Task」形式にそろえる。CLI・MCP・通知はこの形式だけを扱う。"""

from __future__ import annotations

import time
import unicodedata
from dataclasses import asdict, dataclass
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from core.moodle import MoodleClient

TYPE_LABELS = {"assign": "課題", "quiz": "小テスト", "forum": "お知らせ",
               "questionnaire": "アンケート", "feedback": "アンケート", "choice": "投票",
               "lesson": "レッスン", "workshop": "ワークショップ"}
PAGE_SIZE = 50  # core_calendar_get_action_events_by_timesort の上限


def local_tz():
    """表示用のタイムゾーン。MOODLE_TIMEZONE(例 Asia/Tokyo)があればそれ、なければ PC の設定。"""
    name = os.environ.get("MOODLE_TIMEZONE")
    if not name:
        from core.config import load_env      # .env に書いた MOODLE_TIMEZONE も使う
        name = load_env().get("MOODLE_TIMEZONE")
    if name:
        try:
            from zoneinfo import ZoneInfo
            return ZoneInfo(name)
        except Exception:  # Windows で tzdata がない場合など
            pass
    return datetime.now().astimezone().tzinfo or timezone.utc


@dataclass
class Task:
    id: str                 # 種類+ID(例: assign:123)
    course_id: int
    course: str             # 授業名
    title: str              # 課題名
    type: str               # 課題 / 小テスト / お知らせ / その他
    due: int | None         # 締切(UNIX 秒)。なければ None
    url: str                # Moodle 上のリンク
    status: str             # 未対応 / 期限切れ など(個人情報。共有には出さない)

    @property
    def due_text(self) -> str:
        if not self.due:
            return "-"
        dt = datetime.fromtimestamp(self.due, local_tz())
        return dt.strftime("%m/%d(%a) %H:%M").replace(
            dt.strftime("%a"), "月火水木金土日"[dt.weekday()])

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["due_text"] = self.due_text
        return d


def _clean(text: str) -> str:
    """「⽊」などの互換文字(康熙部首)を普通の漢字にそろえる。"""
    return unicodedata.normalize("NFKC", text or "").strip()


def event_to_task(ev: dict[str, Any], now: int | None = None) -> Task:
    now = now or int(time.time())
    module = ev.get("modulename") or ev.get("component", "").removeprefix("mod_") or "other"
    instance = ev.get("instance") or ev.get("id")
    course = ev.get("course") or {}
    due = ev.get("timesort") or ev.get("timestart") or None
    overdue = ev.get("overdue")
    if overdue is None:
        overdue = bool(due and due < now)
    return Task(
        id=f"{module}:{instance}",
        course_id=int(course.get("id") or ev.get("courseid") or 0),
        course=_clean(course.get("fullname") or course.get("shortname") or "(授業なし)"),
        title=_clean(ev.get("activityname") or ev.get("name", "")),
        type=TYPE_LABELS.get(module, module),
        due=int(due) if due else None,
        url=ev.get("url") or (ev.get("action") or {}).get("url", ""),
        status="期限切れ" if overdue else "未対応",
    )


def fetch_todo(client: MoodleClient, days_ahead: int = 30, days_back: int = 7) -> list[Task]:
    """やること一覧(Moodle のタイムライン)を取得する。提出済みのものは Moodle 側で除かれる。"""
    now = int(time.time())
    params: dict[str, Any] = {
        "timesortfrom": now - days_back * 86400,
        "timesortto": now + days_ahead * 86400,
        "limitnum": PAGE_SIZE,
    }
    tasks: dict[str, Task] = {}
    for _ in range(20):  # 念のためページ数に上限
        data = client.call("core_calendar_get_action_events_by_timesort", **params)
        events = data.get("events", [])
        for ev in events:
            t = event_to_task(ev, now)
            # 同じ活動に複数の予定(開始・締切など)があれば遅いほう=締切を残す
            if t.id not in tasks or (t.due or 0) > (tasks[t.id].due or 0):
                tasks[t.id] = t
        if len(events) < PAGE_SIZE:
            break
        params["aftereventid"] = data.get("lastid") or events[-1]["id"]
    return sorted(tasks.values(), key=lambda t: (t.due or 2**62, t.course))
