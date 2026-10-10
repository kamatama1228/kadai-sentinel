"""notify.toml(授業ごとの通知ルール)の読み込み。"""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass, field
from datetime import datetime, time as dtime
from pathlib import Path
from typing import Any

from core.tasks import local_tz

CONFIG_FILE = Path("notify.toml")
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
MAX_FAST_WINDOW_MINUTES = 4 * 60   # 1分おきに確認する時間帯は1つあたり4時間まで
MAX_SCHEDULE = 12                  # ふだんの確認は1日12回まで


def parse_duration(text: str) -> int:
    """"7d" "1d" "3h" "30m" を秒にする。"""
    m = re.fullmatch(r"\s*(\d+)\s*([dhm])\s*", str(text))
    if not m:
        raise ValueError(f"時間の書き方が正しくありません: {text!r}(例: 7d, 3h, 30m)")
    return int(m.group(1)) * {"d": 86400, "h": 3600, "m": 60}[m.group(2)]


def check_remind(specs: list[str]) -> list[str]:
    """"7d" "3h" "30m"(締切の何前)と "@16:30"(締切日のその時刻)を受け付ける。"""
    for x in specs:
        if str(x).startswith("@"):
            _hm(str(x)[1:])
        else:
            parse_duration(x)
    return [str(x) for x in specs]


@dataclass
class CourseRule:
    enabled: bool = False
    events: set[str] = field(default_factory=set)
    remind: list[str] = field(default_factory=list)
    morning: bool = False
    match: list[str] = field(default_factory=list)    # 空でなければ、名前にこれを含むものだけ
    kinds: list[str] = field(default_factory=lambda: ["小テスト", "課題"])

    def wants(self, kind: str, title: str) -> bool:
        return (self.enabled and kind in self.kinds
                and (not self.match or any(k in title for k in self.match)))


@dataclass
class ManualEvent:
    """Moodle に出る前から分かっている締切を手で登録する(Moodle に出たらそちらを優先)。"""
    title: str
    course_id: int
    course: str
    open: int | None
    due: int
    remind: list[str]
    match: list[str]


@dataclass
class Window:
    days: set[int]
    start: dtime
    end: dtime

    def contains(self, dt: datetime) -> bool:
        return dt.weekday() in self.days and self.start <= dt.time() < self.end


@dataclass
class Rules:
    default: CourseRule
    courses: dict[int, CourseRule]
    personal_remind: list[str]
    personal_exclude: set[int]
    personal_courses: dict[int, list[str]]
    manual: list[ManualEvent]
    schedule: list[dtime]
    fast_interval: int
    morning_at: dtime
    fast_windows: list[Window]

    def course(self, course_id: int) -> CourseRule:
        return self.courses.get(course_id, self.default)

    def personal_for(self, course_id: int) -> list[str]:
        return self.personal_courses.get(course_id, self.personal_remind)

    @property
    def shared_course_ids(self) -> list[int]:
        return [cid for cid, r in self.courses.items() if r.enabled]


def _rule(d: dict[str, Any], base: CourseRule | None = None) -> CourseRule:
    base = base or CourseRule()
    return CourseRule(
        enabled=d.get("enabled", base.enabled),
        events=set(d.get("events", base.events)),
        remind=check_remind(d["remind"]) if "remind" in d else list(base.remind),
        morning=d.get("morning", base.morning),
        match=list(d.get("match", base.match)),
        kinds=list(d.get("kinds", base.kinds)),
    )


def _hm(text: str) -> dtime:
    h, m = str(text).split(":")
    return dtime(int(h), int(m))


def load_rules(path: Path = CONFIG_FILE) -> Rules:
    data = tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    default = _rule(data.get("default", {}))
    courses = {int(k): _rule(v, default) for k, v in data.get("course", {}).items()}
    personal = data.get("personal", {})
    watch = data.get("watch", {})
    def ts(text: str | None) -> int | None:
        if not text:
            return None
        return int(datetime.strptime(str(text), "%Y-%m-%d %H:%M").replace(tzinfo=local_tz()).timestamp())

    manual = [ManualEvent(title=e["title"], course_id=int(e.get("course_id", 0)), course=e.get("course", ""),
                          open=ts(e.get("open")), due=ts(e["due"]) or 0,
                          remind=check_remind(e.get("remind", ["1d", "3h"])), match=list(e.get("match", [])))
              for e in data.get("event", [])]
    windows = [Window({DAYS.index(d.lower()[:3]) for d in w.get("days", DAYS)},
                      _hm(w.get("start", "00:00")), _hm(w.get("end", "23:59")))
               for w in watch.get("fast_windows", [])]
    # 大学のサーバーに負荷をかけないための上限
    fast = parse_duration(watch.get("fast", "1m"))
    if fast < 60:
        raise ValueError("fast は 1m 以上にしてください")
    for w in windows:
        minutes = (w.end.hour * 60 + w.end.minute) - (w.start.hour * 60 + w.start.minute)
        if minutes > MAX_FAST_WINDOW_MINUTES:
            raise ValueError(f"fast_windows の1つの時間帯は {MAX_FAST_WINDOW_MINUTES // 60} 時間までにしてください")
    if len(watch.get("schedule", [])) > MAX_SCHEDULE:
        raise ValueError(f"schedule は1日 {MAX_SCHEDULE} 回までにしてください")
    return Rules(
        default=default, courses=courses,
        personal_remind=check_remind(personal.get("remind", ["1d", "3h"])),
        personal_exclude={int(x) for x in personal.get("exclude", [])},
        personal_courses={int(k): check_remind(v.get("remind", []))
                          for k, v in personal.get("course", {}).items()},
        manual=manual,
        schedule=sorted(_hm(x) for x in watch.get("schedule", ["10:00", "22:00"])),
        fast_interval=fast,
        morning_at=_hm(watch.get("morning_at", "08:00")),
        fast_windows=windows,
    )


def now_local() -> datetime:
    return datetime.now(local_tz())
