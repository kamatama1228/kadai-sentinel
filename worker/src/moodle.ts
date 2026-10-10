// Moodle Web Services(REST)との通信と、Task / Activity への整形
import { fmtTime } from "./time.ts";

export class MoodleError extends Error {
  errorcode?: string;
  constructor(message: string, errorcode?: string) { super(message); this.errorcode = errorcode; }
}

function flatten(params: Record<string, unknown>, prefix = "", out: [string, string][] = []) {
  for (const [k, v] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "object") flatten(v as Record<string, unknown>, name, out);
    else out.push([name, typeof v === "boolean" ? (v ? "1" : "0") : String(v)]);
  }
  return out;
}

export class Moodle {
  base: string;
  token: string;
  constructor(base: string, token: string) { this.base = base.replace(/\/$/, ""); this.token = token; }

  async call(fn: string, params: Record<string, unknown> = {}): Promise<any> {
    const body = new URLSearchParams([
      ["wstoken", this.token], ["wsfunction", fn], ["moodlewsrestformat", "json"], ...flatten(params),
    ]);
    const res = await fetch(this.base + "/webservice/rest/server.php", {
      method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!res.ok) throw new MoodleError(`HTTP ${res.status}`, `http${res.status}`);
    const data: any = await res.json();
    if (data && typeof data === "object" && "exception" in data) {
      throw new MoodleError(data.message ?? data.exception, data.errorcode);
    }
    return data;
  }
}

export const clean = (s: string | undefined | null) => (s ?? "").normalize("NFKC").trim();

const TYPE_LABELS: Record<string, string> = {
  assign: "課題", quiz: "小テスト", forum: "お知らせ", questionnaire: "アンケート",
  feedback: "アンケート", choice: "投票", lesson: "レッスン", workshop: "ワークショップ",
};

// ---------------------------------------------------------------- 自分のやること一覧(個人通知用)

export interface Task {
  id: string; courseId: number; course: string; title: string; type: string;
  due: number | null; url: string; status: string;
}

export function eventToTask(ev: any, now: number): Task {
  const module = ev.modulename || String(ev.component ?? "").replace(/^mod_/, "") || "other";
  const due = ev.timesort || ev.timestart || null;
  const overdue = ev.overdue ?? Boolean(due && due < now);
  return {
    id: `${module}:${ev.instance || ev.id}`,
    courseId: Number(ev.course?.id ?? ev.courseid ?? 0),
    course: clean(ev.course?.fullname || ev.course?.shortname || "(授業なし)"),
    title: clean(ev.activityname || ev.name),
    type: TYPE_LABELS[module] ?? module,
    due: due ? Number(due) : null,
    url: ev.url || ev.action?.url || "",
    status: overdue ? "期限切れ" : "未対応",
  };
}

export async function fetchTodo(m: Moodle, now: number, daysAhead = 30): Promise<Task[]> {
  const params: Record<string, unknown> = { timesortfrom: now, timesortto: now + daysAhead * 86400, limitnum: 50 };
  const tasks = new Map<string, Task>();
  for (let page = 0; page < 10; page++) {
    const data = await m.call("core_calendar_get_action_events_by_timesort", params);
    const events: any[] = data.events ?? [];
    for (const ev of events) {
      const t = eventToTask(ev, now);
      const prev = tasks.get(t.id);
      if (!prev || (t.due ?? 0) > (prev.due ?? 0)) tasks.set(t.id, t);
    }
    if (events.length < 50) break;
    params.aftereventid = data.lastid ?? events[events.length - 1].id;
  }
  return [...tasks.values()];
}

// ---------------------------------------------------------------- 授業の課題・小テスト(共有通知用)

export interface Activity {
  id: string; courseId: number; course: string; title: string; kind: string;
  open: number | null; due: number | null; url: string; timelimit: number; rule?: any;
}

export const isOpen = (a: Activity, now: number) =>
  (!a.open || a.open <= now) && (!a.due || now < a.due);

export function windowText(a: Activity): string {
  if (a.open && a.due) {
    const same = fmtTime(a.open).slice(0, 8) === fmtTime(a.due).slice(0, 8);
    return `${fmtTime(a.open)}〜${fmtTime(a.due, !same)}`;
  }
  if (a.due) return `締切 ${fmtTime(a.due)}`;
  if (a.open) return `${fmtTime(a.open)} から`;
  return "締切なし";
}

export async function listCourses(m: Moodle): Promise<Map<number, string>> {
  const data = await m.call("core_course_get_enrolled_courses_by_timeline_classification",
                            { classification: "inprogress", limit: 0 });
  return new Map((data.courses ?? []).map((c: any) => [c.id, clean(c.fullname)]));
}

export async function fetchActivities(m: Moodle, ids: number[], names: Map<number, string>): Promise<Activity[]> {
  if (!ids.length) return [];
  const out: Activity[] = [];
  const q = await m.call("mod_quiz_get_quizzes_by_courses", { courseids: ids });
  for (const x of q.quizzes ?? []) {
    if (x.visible === false) continue;
    out.push({ id: `quiz:${x.id}`, courseId: x.course, course: names.get(x.course) ?? "",
               title: clean(x.name), kind: "小テスト", open: x.timeopen || null, due: x.timeclose || null,
               url: `${m.base}/mod/quiz/view.php?id=${x.coursemodule}`, timelimit: Number(x.timelimit || 0) });
  }
  const a = await m.call("mod_assign_get_assignments", { courseids: ids });
  for (const co of a.courses ?? []) {
    for (const x of co.assignments ?? []) {
      if (x.visible === false) continue;
      out.push({ id: `assign:${x.id}`, courseId: co.id, course: names.get(co.id) ?? "",
                 title: clean(x.name), kind: "課題", open: x.allowsubmissionsfromdate || null,
                 due: x.duedate || x.cutoffdate || null,
                 url: `${m.base}/mod/assign/view.php?id=${x.cmid}`, timelimit: 0 });
    }
  }
  return out;
}

const GENERIC: Record<string, string> = {
  questionnaire: "アンケート", feedback: "アンケート", choice: "投票",
  lesson: "レッスン", workshop: "ワークショップ", h5pactivity: "H5P",
};

/** アンケートなどを、カレンダーの開始・終了予定から作る */
export async function fetchGeneric(m: Moodle, ids: number[], names: Map<number, string>, now: number): Promise<Activity[]> {
  if (!ids.length) return [];
  const data = await m.call("core_calendar_get_calendar_events", {
    events: { courseids: ids },
    options: { userevents: 0, siteevents: 0, timestart: now - 30 * 86400, timeend: now + 120 * 86400 },
  });
  const acts = new Map<string, Activity>();
  for (const ev of data.events ?? []) {
    const kind = GENERIC[ev.modulename];
    if (!kind) continue;
    const key = `${ev.modulename}:${ev.instance}`;
    const a = acts.get(key) ?? {
      id: key, courseId: ev.courseid, course: names.get(ev.courseid) ?? "",
      title: clean(String(ev.name ?? "").replace(/\s*[(（][^()（）]*(開始|終了|期限|open|close)[^()（）]*[)）]\s*$/, "")),
      kind, open: null, due: null, timelimit: 0,
      url: ev.url || `${m.base}/course/view.php?id=${ev.courseid}`,
    };
    if (ev.eventtype === "open") a.open = ev.timestart;
    else if (["close", "due", "expectcompletionon"].includes(ev.eventtype)) a.due = ev.timestart;
    acts.set(key, a);
  }
  return [...acts.values()];
}
