// notify.toml(授業ごとの通知ルール)の解釈。PC 版(Python)と同じファイルを使う。
import { fromLocal, hm, parseDuration, setUtcOffset, type Local } from "./time.ts";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MAX_FAST_WINDOW_MINUTES = 4 * 60;   // 1分おきに確認する時間帯は1つあたり4時間まで
const MAX_SCHEDULE = 12;                  // ふだんの確認は1日12回まで

export interface CourseRule {
  enabled: boolean; events: Set<string>; remind: string[]; morning: boolean;
  match: string[]; kinds: string[];
}

export const wants = (r: CourseRule, kind: string, title: string) =>
  r.enabled && r.kinds.includes(kind) && (!r.match.length || r.match.some((k) => title.includes(k)));

export interface ManualEvent {
  title: string; courseId: number; course: string; open: number | null; due: number;
  remind: string[]; match: string[];
}

export interface Window { days: Set<number>; start: [number, number]; end: [number, number] }

export const inWindow = (w: Window, l: Local) => {
  const t = l.h * 60 + l.mi;
  return w.days.has(l.dow) && w.start[0] * 60 + w.start[1] <= t && t < w.end[0] * 60 + w.end[1];
};

export interface Rules {
  default: CourseRule; courses: Map<number, CourseRule>;
  personalRemind: string[]; personalExclude: Set<number>; personalCourses: Map<number, string[]>;
  manual: ManualEvent[]; schedule: [number, number][]; fast: number; morningAt: [number, number];
  windows: Window[];
}

export const courseRule = (r: Rules, id: number) => r.courses.get(id) ?? r.default;
export const personalFor = (r: Rules, id: number) => r.personalCourses.get(id) ?? r.personalRemind;
export const sharedIds = (r: Rules) => [...r.courses].filter(([, c]) => c.enabled).map(([id]) => id);

function checkRemind(specs: unknown[]): string[] {
  return specs.map((x) => {
    const s = String(x);
    if (s.startsWith("@")) hm(s.slice(1)); else parseDuration(s);
    return s;
  });
}

function rule(d: any, base?: CourseRule): CourseRule {
  const b = base ?? { enabled: false, events: new Set<string>(), remind: [], morning: false, match: [], kinds: ["小テスト", "課題"] };
  return {
    enabled: d.enabled ?? b.enabled,
    events: d.events ? new Set<string>(d.events) : new Set(b.events),
    remind: d.remind ? checkRemind(d.remind) : [...b.remind],
    morning: d.morning ?? b.morning,
    match: d.match ? [...d.match] : [...b.match],
    kinds: d.kinds ? [...d.kinds] : [...b.kinds],
  };
}

function ts(text: unknown): number | null {
  if (!text) return null;
  const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) throw new Error(`日時の書き方が正しくありません: ${text}(例: 2026-11-06 10:30)`);
  return fromLocal(+m[1], +m[2], +m[3], +m[4], +m[5]);
}

export function parseRules(data: any): Rules {
  const def = rule(data.default ?? {});
  const courses = new Map<number, CourseRule>(
    Object.entries(data.course ?? {}).map(([k, v]) => [Number(k), rule(v, def)]));
  const personal = data.personal ?? {};
  const watch = data.watch ?? {};
  setUtcOffset(Number(watch.utc_offset ?? 9));       // 日時の解釈より先に設定する
  // 大学のサーバーに負荷をかけないための上限
  const fast = parseDuration(watch.fast ?? "1m");
  if (fast < 60) throw new Error("fast は 1m 以上にしてください");
  if ((watch.schedule ?? []).length > MAX_SCHEDULE) throw new Error(`schedule は1日 ${MAX_SCHEDULE} 回までにしてください`);
  for (const w of watch.fast_windows ?? []) {
    const [sh, sm] = hm(w.start ?? "00:00"), [eh, em] = hm(w.end ?? "23:59");
    if ((eh * 60 + em) - (sh * 60 + sm) > MAX_FAST_WINDOW_MINUTES) {
      throw new Error(`fast_windows の1つの時間帯は ${MAX_FAST_WINDOW_MINUTES / 60} 時間までにしてください`);
    }
  }
  return {
    default: def, courses,
    personalRemind: checkRemind(personal.remind ?? ["1d", "3h"]),
    personalExclude: new Set((personal.exclude ?? []).map(Number)),
    personalCourses: new Map(Object.entries(personal.course ?? {})
      .map(([k, v]: [string, any]) => [Number(k), checkRemind(v.remind ?? [])])),
    manual: (data.event ?? []).map((e: any) => ({
      title: e.title, courseId: Number(e.course_id ?? 0), course: e.course ?? "",
      open: ts(e.open), due: ts(e.due) ?? 0, remind: checkRemind(e.remind ?? ["1d", "3h"]), match: e.match ?? [],
    })),
    schedule: (watch.schedule ?? ["10:00", "22:00"]).map(hm).sort((a: number[], b: number[]) => a[0] * 60 + a[1] - b[0] * 60 - b[1]),
    fast,
    morningAt: hm(watch.morning_at ?? "08:00"),
    windows: (watch.fast_windows ?? []).map((w: any) => ({
      days: new Set((w.days ?? DAYS).map((d: string) => DAYS.indexOf(d.toLowerCase().slice(0, 3)))),
      start: hm(w.start ?? "00:00"), end: hm(w.end ?? "23:59"),
    })),
  };
}
