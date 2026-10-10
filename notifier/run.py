"""通知の本体。

共有チャンネル(DISCORD_WEBHOOK_URL)  : notify.toml で有効にした授業の課題・小テスト
                                         (自分の提出状況とは関係なく、授業の情報として流す)
個人チャンネル(PERSONAL_WEBHOOK_URL) : 自分の未提出課題のリマインド
状態は state/notify.json に保存する(公開リポジトリには入れない)。
"""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from core.activities import Activity, fetch_activities, fetch_generic, fmt_time
from core.moodle import MoodleClient, MoodleError
from core.tasks import Task, _clean, fetch_todo, local_tz
from notifier.discord import Notice, send
from notifier.rules import Rules, load_rules, now_local

STATE_FILE = Path("state/notify.json")
FORGET_AFTER = 30 * 86400


def load_state() -> dict[str, Any] | None:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATE_FILE)


def remaining(seconds: int) -> str:
    m = max(1, seconds // 60)
    if m < 120:
        return f"{m} 分"
    h, m = divmod(m, 60)
    if h < 48:
        return f"{h} 時間" + (f" {m} 分" if m else "")
    d, h = divmod(h, 24)
    return f"{d} 日" + (f" {h} 時間" if h else "")


def human(seconds: int) -> str:
    if seconds % 86400 == 0:
        return f"{seconds // 86400}日"
    if seconds % 3600 == 0:
        return f"{seconds // 3600}時間"
    return f"{seconds // 60}分"


def reminder_points(due: int, specs: list[str]) -> list[tuple[str, int, str]]:
    """リマインドを送る時刻の一覧 [(キー, 時刻, 見出し)]。

    "3h" などは締切のその時間前、"@16:30" は締切日のその時刻。
    """
    from datetime import datetime
    from notifier.rules import _hm, parse_duration
    out = []
    for spec in specs:
        if spec.startswith("@"):
            d = datetime.fromtimestamp(due, local_tz()).date()
            ts = int(datetime.combine(d, _hm(spec[1:]), local_tz()).timestamp())
            if ts < due:
                out.append((f"r@{spec[1:]}", ts, f"⏰ 今日 {fmt_time(due, with_date=False)} 締切"))
        else:
            off = parse_duration(spec)
            out.append((f"r{off}", due - off, f"⏰ 締切まで{human(off)}を切りました"))
    return sorted(out, key=lambda p: p[1])


def _reminder_due(due: int | None, now: int, specs: list[str],
                  sent: list[str]) -> tuple[str, list[str]] | None:
    """今送るべきリマインドの (見出し, 送信済みにするキー) を返す。過ぎたものは最新の1つだけ送る。"""
    if not due or due <= now or not specs:
        return None
    past = [p for p in reminder_points(due, specs) if p[1] <= now]
    if not past or past[-1][0] in sent:
        return None
    return past[-1][2], [p[0] for p in past]


# ---------------------------------------------------------------- 共有チャンネル

def plan_shared(acts: list[Activity], state: dict[str, Any], rules: Rules, now: int,
                first: bool) -> list[Notice]:
    seen: dict[str, Any] = state.setdefault("shared", {})
    out: list[Notice] = []
    for a in acts:
        rule = a.rule or rules.course(a.course_id)
        if not rule.wants(a.kind, a.title):
            continue
        ev = rule.events
        rec = seen.get(a.id)
        is_new = rec is None
        if is_new:
            rec = {"open": a.open, "due": a.due, "sent": []}
        sent: list[str] = rec["sent"]

        def notice(heading: str, fields: list[tuple[str, str]], urgent: bool = False) -> Notice:
            return Notice(heading, a.course_id, a.course, a.title, a.url, fields, urgent)

        if not is_new:
            if rec.get("due") != a.due and a.due:
                if "due_changed" in ev and not first:
                    out.append(notice(f"🔁 締切が変更されました({a.kind})",
                                      [("締切", f"{fmt_time(rec.get('due'))} → {fmt_time(a.due)}")]))
                sent = [s for s in sent if not s.startswith("r")]
            if rec.get("open") != a.open and a.open and a.open > now:
                sent = [s for s in sent if s not in ("open", "scheduled")]

        closed = bool(a.due and a.due <= now)
        if first:
            # 初回は今の状態を記録するだけ。これから公開されるものは、公開時に通知される
            sent = sorted(set(sent) | {"new", "scheduled"} | ({"open"} if a.is_open(now) or closed else set()))
        elif closed:
            sent = sorted(set(sent) | {"new", "scheduled", "open"})
        else:
            if "open" in ev and "open" not in sent and a.is_open(now):
                left = f"あと {remaining(a.due - now)}" if a.due else "締切なし"
                fields = [("受付", a.window_text), ("残り", left)]
                if a.timelimit:
                    fields.append(("制限時間", f"{a.timelimit // 60} 分"))
                urgent = a.kind == "小テスト" or bool(a.due and a.due - now <= 3 * 3600)
                out.append(notice(f"🚨 {a.kind}が公開されました", fields, urgent))
                sent = sorted(set(sent) | {"open", "new", "scheduled"})
            elif a.open and a.open > now and "scheduled" in ev and "scheduled" not in sent:
                heading = "📅 予定を登録しました" if a.kind == "予定" else f"📅 {a.kind}の公開予定"
                out.append(notice(heading, [("期間", a.window_text)]))
                sent = sorted(set(sent) | {"scheduled", "new"})
            elif "new" in ev and "new" not in sent:
                out.append(notice(f"🆕 新しい{a.kind}", [("締切", fmt_time(a.due) if a.due else "なし")]))
                sent = sorted(set(sent) | {"new"})
            r = _reminder_due(a.due, now, rule.remind, sent)
            if r:
                out.append(notice(r[0], [("締切", fmt_time(a.due)), ("種類", a.kind)],
                                  urgent=a.due - now <= 3 * 3600))
                sent = sorted(set(sent) | set(r[1]))

        seen[a.id] = {"open": a.open, "due": a.due, "sent": sent, "last_seen": now}
    for k in [k for k, v in seen.items() if now - v.get("last_seen", now) > FORGET_AFTER]:
        del seen[k]
    return out


def plan_morning(acts: list[Activity], state: dict[str, Any], rules: Rules,
                 local: datetime) -> list[Notice]:
    today = local.strftime("%Y-%m-%d")
    if local.time() < rules.morning_at or state.get("morning_date") == today:
        return []
    state["morning_date"] = today
    out = []
    for a in sorted(acts, key=lambda a: a.open or a.due or 0):
        rule = a.rule or rules.course(a.course_id)
        if not (rule.wants(a.kind, a.title) and rule.morning):
            continue
        ts = a.open or a.due
        if ts and ts <= local.timestamp():          # もう始まっている(公開通知で知らせ済み)
            continue
        if ts and fmt_time(ts)[:5] == local.strftime("%m/%d"):
            out.append(Notice(f"☀️ 今日の{a.kind}", a.course_id, a.course, a.title, a.url,
                              [("受付", a.window_text)]))
    return out


# ---------------------------------------------------------------- 個人チャンネル

def plan_personal(tasks: list[Task], state: dict[str, Any], rules: Rules, now: int,
                  first: bool) -> list[Notice]:
    seen: dict[str, Any] = state.setdefault("personal", {})
    out = []
    for t in tasks:
        if t.course_id in rules.personal_exclude:
            continue
        rec = seen.get(t.id) or {"due": t.due, "sent": []}
        sent = rec["sent"] if rec.get("due") == t.due else []
        r = _reminder_due(t.due, now, rules.personal_for(t.course_id), sent)
        if r:
            if not first or (t.due - now) <= 3 * 3600:
                out.append(Notice(r[0].replace("⏰ ", "⏰ 未提出:"), t.course_id, t.course, t.title,
                                  t.url, [("締切", t.due_text), ("種類", t.type)],
                                  urgent=(t.due - now) <= 3 * 3600))
            sent = sorted(set(sent) | set(r[1]))
        seen[t.id] = {"due": t.due, "sent": sent, "last_seen": now}
    for k in [k for k, v in seen.items() if now - v.get("last_seen", now) > FORGET_AFTER]:
        del seen[k]
    return out


# ---------------------------------------------------------------- 実行

def manual_activities(rules: Rules, fetched: list[Activity]) -> list[Activity]:
    """notify.toml の [[event]]。Moodle に同じものが出ていれば、そちらを優先して使わない。"""
    from notifier.rules import CourseRule
    out = []
    for i, e in enumerate(rules.manual):
        keys = e.match or [e.title]
        if any(any(k in a.title for k in keys) and a.course_id in (e.course_id, *rules.shared_course_ids)
               for a in fetched):
            continue
        out.append(Activity(
            id=f"manual:{e.title}", course_id=e.course_id, course=e.course, kind="予定",
            title=f"{e.title}(Moodle 未掲載・手動登録)", open=e.open, due=e.due, url="",
            rule=CourseRule(enabled=True, events={"scheduled"}, remind=e.remind, kinds=["予定"])))
    return out



def run_once(env: dict[str, str], rules: Rules | None = None, dry_run: bool = False,
             init: bool = False, log: Callable[[str], None] = print) -> dict[str, Any]:
    rules = rules or load_rules()
    client = MoodleClient(env["MOODLE_URL"], env["MOODLE_TOKEN"])
    now = int(time.time())
    local = now_local()

    state = load_state()
    first = state is None or init
    state = state or {}

    names = {}
    if rules.shared_course_ids:
        from core.materials import list_courses
        names = {c["id"]: _clean(c["fullname"]) for c in list_courses(client)}
    acts = fetch_activities(client, rules.shared_course_ids, names)
    generic_ids = [cid for cid in rules.shared_course_ids
                   if set(rules.course(cid).kinds) - {"小テスト", "課題"}]
    acts += fetch_generic(client, generic_ids, names)
    acts += manual_activities(rules, acts)
    tasks = fetch_todo(client, days_ahead=30, days_back=0)

    shared = plan_shared(acts, state, rules, now, first)
    shared += plan_morning(acts, state, rules, local) if not first else []
    personal = plan_personal(tasks, state, rules, now, first)
    if first:
        log(f"初回のため現在の状態を記録しました(共有 {len(acts)} 件 / 個人 {len(tasks)} 件)。")

    for label, items, key in (("共有", shared, "DISCORD_WEBHOOK_URL"),
                              ("個人", personal, "PERSONAL_WEBHOOK_URL")):
        for n in items:
            log(f"[{label}] {n.heading} | {n.course} / {n.title} | " + " ".join(v for _, v in n.fields))
        if items and not dry_run:
            if env.get(key):
                send(env[key], items)
            else:
                log(f"  → {key} が未設定のため送信しません")
    if not dry_run:
        save_state(state)
    state["_acts"] = acts
    state["_tasks"] = tasks
    return state


def next_run_at(rules: Rules, acts: list[Activity], tasks: list[Task], now: int) -> int:
    """次に Moodle を確認する時刻(UNIX 秒)。

    - 決まった時刻(schedule、既定 10:00 と 22:00)
    - 1分おきの時間帯(fast_windows)と、小テスト公開の1分前〜15分後
    - リマインドを送るべき時刻(締切 - 3時間 など)と、公開予定時刻のちょうど
    のうち、いちばん早いもの。
    """
    from datetime import datetime, timedelta
    tz = local_tz()
    local = datetime.fromtimestamp(now, tz)
    candidates: list[int] = []

    # 1分おきにするとき
    fast = any(w.contains(local) for w in rules.fast_windows)
    for a in acts:
        rule = a.rule or rules.course(a.course_id)
        if rule.wants(a.kind, a.title) and a.kind != "予定" and a.open and -60 <= now - a.open <= 900:
            fast = True
    if fast:
        return now + rules.fast_interval

    # 決まった時刻(今日と明日)
    for day in (0, 1):
        d = (local + timedelta(days=day)).date()
        for t in rules.schedule:
            candidates.append(int(datetime.combine(d, t, tz).timestamp()))
    # 1分おきの時間帯の始まり(今後7日)
    for day in range(8):
        d = (local + timedelta(days=day)).date()
        for w in rules.fast_windows:
            if d.weekday() in w.days:
                candidates.append(int(datetime.combine(d, w.start, tz).timestamp()))
    # 共有チャンネル:公開予定の1分前、リマインドの時刻
    for a in acts:
        rule = a.rule or rules.course(a.course_id)
        if not rule.wants(a.kind, a.title):
            continue
        if a.open and a.kind != "予定":
            candidates.append(a.open - 60)
        if a.due:
            candidates += [ts + 30 for _, ts, _ in reminder_points(a.due, rule.remind)]
    # 個人チャンネル:リマインドの時刻
    for t in tasks:
        if t.due and t.course_id not in rules.personal_exclude:
            candidates += [ts + 30 for _, ts, _ in reminder_points(t.due, rules.personal_for(t.course_id))]
    future = [c for c in candidates if c > now + 20]
    return min(future) if future else now + 3600


def _single_instance():
    """二重起動を防ぐ。ロックを取れなければ None(別の監視が動いている)。"""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    fh = open(STATE_FILE.parent / "watch.lock", "a+")
    try:
        if sys.platform == "win32":
            import msvcrt
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return None
    return fh                                     # プロセスが終わるまで開いたままにする


def watch(env: dict[str, str], log: Callable[[str], None] = print) -> None:
    """常駐して確認を続ける(タスクスケジューラから起動する想定)。

    次に確認する時刻まで眠り、PC がスリープしていて時刻を過ぎていたら起きてすぐ確認する。
    """
    lock = _single_instance()
    if lock is None:
        log("すでに監視が動いているため、この起動は終了します。")
        return
    rules = load_rules()
    log(f"監視を開始しました(共有対象 {len(rules.shared_course_ids)} 授業)")
    last_error_day = ""
    acts: list[Activity] = []
    tasks: list[Task] = []
    next_at = 0                                   # 起動直後に1回確認する
    while True:
        now = int(time.time())
        if now < next_at:
            time.sleep(min(60, next_at - now))    # 細かく眠って、スリープ復帰や時計のずれに強くする
            continue
        try:
            rules = load_rules()                  # 設定の変更をすぐ反映
            st = run_once(env, rules, log=log)
            acts, tasks = st.get("_acts", []), st.get("_tasks", [])
        except MoodleError as e:
            log(f"Moodle エラー: {e} ({e.errorcode})")
            day = now_local().strftime("%Y-%m-%d")
            if e.errorcode in ("invalidtoken", "accessexception") and day != last_error_day and env.get("PERSONAL_WEBHOOK_URL"):
                last_error_day = day
                try:
                    send(env["PERSONAL_WEBHOOK_URL"], [Notice(
                        "⚠️ Moodle に接続できません", 0, "kadai-sentinel", "トークンが無効になった可能性があります",
                        fields=[("対処", "uv run moodle login --sso でログインし直してください")], urgent=True)])
                except Exception:
                    pass
        except Exception as e:                    # 通信エラーなどは5分後に再試行
            log(f"エラー: {type(e).__name__}: {e}")
            next_at = int(time.time()) + 300
            continue
        next_at = next_run_at(rules, acts, tasks, int(time.time()))
        log(f"次の確認: {fmt_time(next_at)}")
