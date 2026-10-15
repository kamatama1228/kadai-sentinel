// 何をいつ通知するかを決める(PC 版 notifier/run.py と同じ判定)
import { isOpen, windowText, type Activity, type NewsItem, type Task, type UrlItem } from "./moodle.ts";
import { courseRule, inWindow, isOnlineName, personalFor, personalSkips, sharedIds, wants, type CourseRule, type Rules } from "./rules.ts";
import { dateKey, fmtTime, fromLocal, hm, human, local, parseDuration, remaining } from "./time.ts";
import type { Notice } from "./discord.ts";

const FORGET_AFTER = 30 * 86400;

export interface State {
  shared: Record<string, { open: number | null; due: number | null; sent: string[]; last_seen: number }>;
  personal: Record<string, { due: number | null; sent: string[]; last_seen: number }>;
  morning_date?: string;
  next_at?: number;
  last_error_day?: string;        // (旧)使っていない
  last_alert_at?: number;         // 最後に「確認できていません」を送った時刻
  last_ok?: number;               // 最後に Moodle の確認が成功した時刻
  fail_since?: number;            // Moodle の確認の失敗が続いている場合、その始まり
  pending?: { shared?: Pending[]; personal?: Pending[] };   // Discord に送れなかった通知(送り直す)
  retry_at?: number;              // 次に送り直す時刻
  extras_at?: number;             // オンライン授業・お知らせを最後に取った時刻(数時間に1回だけ取る)
  online?: Record<string, OnlineItem>;   // 見つけたオンライン授業のリンク
  news?: Record<string, number>;  // 見たお知らせ(投稿 ID → 投稿時刻)
  last_config_alert?: number;     // 設定の誤りを最後に知らせた時刻
}

export interface Pending { at: number; notice: Notice }

export interface OnlineItem {
  courseId: number; course: string; title: string; url: string; channel: "shared" | "personal";
  day: string | null;   // オンライン授業の日(YYYY-MM-DD)。分からなければ null
  seen: number; sent: boolean;
}

const union = (a: string[], b: Iterable<string>) => [...new Set([...a, ...b])].sort();

export function reminderPoints(due: number, specs: string[]): [string, number, string][] {
  const out: [string, number, string][] = [];
  for (const spec of specs) {
    if (spec.startsWith("@")) {
      const l = local(due);
      const [h, m] = hm(spec.slice(1));
      const ts = fromLocal(l.y, l.mo, l.d, h, m);
      if (ts < due) out.push([`r@${spec.slice(1)}`, ts, `⏰ 今日 ${fmtTime(due, false)} 締切`]);
    } else {
      const off = parseDuration(spec);
      out.push([`r${off}`, due - off, `⏰ 締切まで${human(off)}を切りました`]);
    }
  }
  return out.sort((a, b) => a[1] - b[1]);
}

export function reminderDue(due: number | null, now: number, specs: string[], sent: string[]): [string, string[]] | null {
  if (!due || due <= now || !specs.length) return null;
  const past = reminderPoints(due, specs).filter((p) => p[1] <= now);
  if (!past.length || sent.includes(past[past.length - 1][0])) return null;
  return [past[past.length - 1][2], past.map((p) => p[0])];
}

const ruleOf = (rules: Rules, a: Activity): CourseRule => a.rule ?? courseRule(rules, a.courseId);

function forget(seen: Record<string, { last_seen: number }>, now: number) {
  for (const [k, v] of Object.entries(seen)) if (now - (v.last_seen ?? now) > FORGET_AFTER) delete seen[k];
}

export function planShared(acts: Activity[], state: State, rules: Rules, now: number, first: boolean): Notice[] {
  const seen = (state.shared ??= {});
  const out: Notice[] = [];
  for (const a of acts) {
    const rule = ruleOf(rules, a);
    if (!wants(rule, a.kind, a.title)) continue;
    const ev = rule.events;
    let rec = seen[a.id];
    const isNew = !rec;
    if (!rec) rec = { open: a.open, due: a.due, sent: [], last_seen: now };
    let sent = rec.sent;
    const notice = (heading: string, fields: [string, string][], urgent = false): Notice =>
      ({ heading, courseId: a.courseId, course: a.course, title: a.title, url: a.url, fields, urgent, id: a.id, until: a.due });

    if (!isNew) {
      if (rec.due !== a.due && a.due) {
        if (ev.has("due_changed") && !first) {
          out.push(notice(`🔁 締切が変更されました(${a.kind})`, [["締切", `${fmtTime(rec.due)} → ${fmtTime(a.due)}`]]));
        }
        sent = sent.filter((s) => !s.startsWith("r"));
      }
      if (rec.open !== a.open && a.open && a.open > now) sent = sent.filter((s) => s !== "open" && s !== "scheduled");
    }

    const closed = Boolean(a.due && a.due <= now);
    if (first) {
      sent = union(sent, ["new", "scheduled", ...(isOpen(a, now) || closed ? ["open"] : [])]);
    } else if (closed) {
      // 締切が過去の日付のまま新しく出された(教授の日付の設定ミスなど)。黙って捨てずに一度だけ知らせる
      if (isNew && ev.has("new")) {
        out.push({ ...notice(`🆕 新しい${a.kind}(締切が過去の日付になっています)`, [["締切", fmtTime(a.due)]]), until: null });
      }
      sent = union(sent, ["new", "scheduled", "open"]);
    } else {
      if (ev.has("open") && !sent.includes("open") && isOpen(a, now)) {
        const fields: [string, string][] = [["受付", windowText(a)], ["残り", a.due ? `あと ${remaining(a.due - now)}` : "締切なし"]];
        if (a.timelimit) fields.push(["制限時間", `${Math.floor(a.timelimit / 60)} 分`]);
        const urgent = a.kind === "小テスト" || Boolean(a.due && a.due - now <= 3 * 3600);
        out.push(notice(`🚨 ${a.kind}が公開されました`, fields, urgent));
        sent = union(sent, ["open", "new", "scheduled"]);
      } else if (a.open && a.open > now && ev.has("scheduled") && !sent.includes("scheduled")) {
        out.push(notice(a.kind === "予定" ? "📅 予定を登録しました" : `📅 ${a.kind}の公開予定`, [["期間", windowText(a)]]));
        sent = union(sent, ["scheduled", "new"]);
      } else if (ev.has("new") && !sent.includes("new")) {
        out.push(notice(`🆕 新しい${a.kind}`, [["締切", a.due ? fmtTime(a.due) : "なし"]]));
        sent = union(sent, ["new"]);
      }
      const r = reminderDue(a.due, now, rule.remind, sent);
      if (r) {
        out.push(notice(r[0], [["締切", fmtTime(a.due)], ["種類", a.kind]], (a.due as number) - now <= 3 * 3600));
        sent = union(sent, r[1]);
      }
    }
    seen[a.id] = { open: a.open, due: a.due, sent, last_seen: now };
  }
  forget(seen, now);
  return out;
}

export function planMorning(acts: Activity[], state: State, rules: Rules, now: number): Notice[] {
  const l = local(now);
  const today = dateKey(now);
  if (l.h * 60 + l.mi < rules.morningAt[0] * 60 + rules.morningAt[1] || state.morning_date === today) return [];
  state.morning_date = today;
  const out: Notice[] = [];
  for (const a of [...acts].sort((x, y) => (x.open ?? x.due ?? 0) - (y.open ?? y.due ?? 0))) {
    const rule = ruleOf(rules, a);
    if (!(wants(rule, a.kind, a.title) && rule.morning)) continue;
    const ts = a.open ?? a.due;
    if (!ts || ts <= now) continue;
    if (dateKey(ts) === today) {
      out.push({ heading: `☀️ 今日の${a.kind}`, courseId: a.courseId, course: a.course, title: a.title,
                 url: a.url, fields: [["受付", windowText(a)]], urgent: false, id: a.id, until: ts });
    }
  }
  return out;
}

export function planPersonal(tasks: Task[], state: State, rules: Rules, now: number, first: boolean): Notice[] {
  const seen = (state.personal ??= {});
  const out: Notice[] = [];
  for (const t of tasks) {
    if (personalSkips(rules, t)) continue;
    const known = seen[t.id];
    const rec = known ?? { due: t.due, sent: [], last_seen: now };
    // 共有チャンネルにない授業の締切が変わったら知らせる(共有の授業は共有チャンネルが知らせる)
    if (known && rules.personalChanges && !first && rec.due && t.due && rec.due !== t.due) {
      out.push({ heading: "🔁 締切が変更されました", courseId: t.courseId, course: t.course, title: t.title, url: t.url,
                 fields: [["締切", `${fmtTime(rec.due)} → ${fmtTime(t.due)}`], ["種類", t.type]],
                 urgent: false, id: t.id, until: t.due });
    }
    let sent = rec.due === t.due ? rec.sent : [];
    const r = reminderDue(t.due, now, personalFor(rules, t.courseId), sent);
    if (r) {
      const left = (t.due as number) - now;
      if (!first || left <= 3 * 3600) {
        out.push({ heading: r[0].replace("⏰ ", "⏰ 未提出:"), courseId: t.courseId, course: t.course,
                   title: t.title, url: t.url, fields: [["締切", fmtTime(t.due)], ["種類", t.type]],
                   urgent: left <= 3 * 3600, id: t.id, until: t.due });
      }
      sent = union(sent, r[1]);
    }
    seen[t.id] = { due: t.due, sent, last_seen: now };
  }
  forget(seen, now);
  return out;
}

/** 転送する締切リマインドのうち、提出済みかを Moodle に確かめる必要があるもの(やること一覧に無いもの) */
export function needsSubmitCheck(shared: Notice[], tasks: Task[], rules: Rules): string[] {
  if (!rules.personalMirror || !rules.mirrorSkipSubmitted) return [];
  const todo = new Set(tasks.map((t) => t.id));
  return [...new Set(shared.filter((n) => n.heading.startsWith("⏰") && n.id && !n.id.startsWith("manual:") && !todo.has(n.id))
                           .map((n) => n.id as string))];
}

/**
 * 共有チャンネルに送る通知を、個人チャンネル用に写す。
 * 締切リマインド(⏰)は、Moodle で「提出済み」と確かめられたものだけ除く(分からないときは送る)。
 */
export function mirrorShared(shared: Notice[], submitted: Set<string>, rules: Rules): Notice[] {
  if (!rules.personalMirror) return [];
  return shared.filter((n) => !(rules.mirrorSkipSubmitted && n.heading.startsWith("⏰") && n.id && submitted.has(n.id)));
}

/** notify.toml の [[event]]。Moodle に名前の合うものが出ていれば使わない */
export function manualActivities(rules: Rules, fetched: Activity[]): Activity[] {
  const ids = sharedIds(rules);
  return rules.manual.filter((e) => {
    const keys = e.match.length ? e.match : [e.title];
    return !fetched.some((a) => keys.some((k) => a.title.includes(k)) && [e.courseId, ...ids].includes(a.courseId));
  }).map((e) => ({
    id: `manual:${e.title}`, courseId: e.courseId, course: e.course, kind: "予定",
    title: `${e.title}(Moodle 未掲載・手動登録)`, open: e.open, due: e.due, url: "", timelimit: 0,
    rule: { enabled: true, events: new Set(["scheduled"]), remind: e.remind, morning: false, match: [], kinds: ["予定"] },
  }));
}

/** 次に Moodle を確認する時刻 */
export function nextRunAt(rules: Rules, acts: Activity[], tasks: Task[], now: number): number {
  const l = local(now);
  let fast = rules.windows.some((w) => inWindow(w, l));
  for (const a of acts) {
    if (wants(ruleOf(rules, a), a.kind, a.title) && a.kind !== "予定" && a.open && now - a.open >= -60 && now - a.open <= 900) fast = true;
  }
  if (fast) return now + rules.fast;

  const c: number[] = [];
  for (let day = 0; day < 8; day++) {
    const d = local(now + day * 86400);
    if (day < 2) for (const [h, m] of [...rules.schedule, rules.morningAt]) c.push(fromLocal(d.y, d.mo, d.d, h, m));
    for (const w of rules.windows) if (w.days.has(d.dow)) c.push(fromLocal(d.y, d.mo, d.d, w.start[0], w.start[1]));
  }
  for (const a of acts) {
    const rule = ruleOf(rules, a);
    if (!wants(rule, a.kind, a.title)) continue;
    if (a.open && a.kind !== "予定") c.push(a.open - 60);
    if (a.due) for (const [, ts] of reminderPoints(a.due, rule.remind)) c.push(ts + 30);
  }
  for (const t of tasks) {
    if (t.due && !personalSkips(rules, t)) {
      for (const [, ts] of reminderPoints(t.due, personalFor(rules, t.courseId))) c.push(ts + 30);
    }
  }
  const future = c.filter((x) => x > now + 20);
  return future.length ? Math.min(...future) : now + 3600;
}

// ---------------------------------------------------------------- オンライン授業(当日の朝に知らせる)

const DAY = 86400;
const morningReached = (rules: Rules, now: number) => {
  const l = local(now);
  return l.h * 60 + l.mi >= rules.morningAt[0] * 60 + rules.morningAt[1];
};

/** リンクが置かれた授業の「次の授業の日」。出欠の予定 → 曜日の設定 の順に探す。分からなければ null */
function classDay(rules: Rules, u: UrlItem, attendance: number[] | undefined, now: number): string | null {
  const base = u.tm || now;
  const t = (attendance ?? []).find((x) => x >= base - 3600 && x <= base + 8 * DAY);
  if (t) return dateKey(t);
  const days = rules.courseDays.get(u.courseId);
  if (days) {
    for (let i = 0; i < 8; i++) {
      const ts = base + i * DAY;
      if (days.has(local(ts).dow)) return dateKey(ts);
    }
  }
  return null;
}

/**
 * Moodle から取ったリンクの一覧で、オンライン授業の記録を更新する(数時間に1回)。
 * 日付が分からないリンクは、見つけたときに一度だけ「リンクが掲載されました」と知らせる。
 */
export function refreshOnline(rules: Rules, urls: UrlItem[], attendance: Map<number, number[]>,
                              names: Map<number, string>, state: State, now: number, base: string): Notice[] {
  if (!rules.online.enabled) return [];
  const firstTime = state.online === undefined;
  const seen = (state.online ??= {});
  const out: Notice[] = [];
  for (const u of urls) {
    if (!isOnlineName(rules, u.name) || rules.personalExclude.has(u.courseId)) continue;
    const key = `url:${u.cmid}`;
    const rule = rules.courses.get(u.courseId);
    const channel = rules.online.shared && rule?.enabled && !rule.match.length ? "shared" : "personal";
    const day = classDay(rules, u, attendance.get(u.courseId), now);
    const old = seen[key];
    if (old) {
      if (old.day === null && day && !old.sent) old.day = day;   // あとから出欠の予定が出た
      continue;
    }
    const item: OnlineItem = { courseId: u.courseId, course: names.get(u.courseId) ?? "", title: u.name,
                               url: `${base}/mod/url/view.php?id=${u.cmid}`, channel, day, seen: now,
                               sent: day !== null && day < dateKey(now) };
    // 日付が分からない新しいリンクは、見つけたときに知らせる(最初に記録するときと、古いリンクは除く)
    if (day === null) {
      item.sent = true;
      if (!firstTime && (!u.tm || now - u.tm <= 3 * DAY)) {
        out.push({ heading: "🖥 オンライン授業のリンクが掲載されました", courseId: u.courseId, course: item.course,
                   title: u.name, url: item.url, fields: [["授業の日", "Moodle で確認してください"]],
                   urgent: false, id: key, until: null, channel });
      }
    }
    seen[key] = item;
  }
  for (const [k, v] of Object.entries(seen)) {
    if ((v.day && v.day < dateKey(now - 7 * DAY)) || now - v.seen > 30 * DAY) delete seen[k];
  }
  return out;
}

/** 今日がオンライン授業の日なら、朝の時刻を過ぎたところで一度だけ知らせる(毎回の確認で呼ぶ。Moodle は使わない) */
export function planOnlineToday(rules: Rules, state: State, now: number): Notice[] {
  if (!rules.online.enabled || !state.online || !morningReached(rules, now)) return [];
  const today = dateKey(now);
  const out: Notice[] = [];
  for (const [key, v] of Object.entries(state.online)) {
    if (v.sent || v.day !== today) continue;
    v.sent = true;
    out.push({ heading: "🖥 今日はオンライン授業です", courseId: v.courseId, course: v.course, title: v.title, url: v.url,
               fields: [["日付", today.slice(5).replace("-", "/")]], urgent: false, id: key,
               until: now + 18 * 3600, channel: v.channel });
  }
  return out;
}

// ---------------------------------------------------------------- お知らせ(共有チャンネルにない授業)

export function planNews(rules: Rules, items: NewsItem[], names: Map<number, string>, state: State, now: number, base: string): Notice[] {
  const firstTime = state.news === undefined;
  const seen = (state.news ??= {});
  const out: Notice[] = [];
  for (const n of items) {
    const key = String(n.id);
    if (key in seen) continue;
    seen[key] = n.created || now;
    if (firstTime || rules.news.mode === "off" || now - n.created > 7 * DAY) continue;   // 最初は記録だけ。古い投稿は送らない
    const hay = `${n.name} ${n.text}`;
    if (rules.news.mode === "keywords" && !rules.news.keywords.some((k) => hay.includes(k))) continue;
    out.push({ heading: "📢 先生からのお知らせ", courseId: n.courseId, course: names.get(n.courseId) ?? "", title: n.name,
               url: `${base}/mod/forum/discuss.php?d=${n.id}`, fields: [["投稿", fmtTime(n.created)]],
               urgent: false, id: `news:${key}`, until: null });
  }
  for (const [k, t] of Object.entries(seen)) if (now - t > 60 * DAY) delete seen[k];
  return out;
}
