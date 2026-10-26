// 現地時刻の表示と計算。Workers の時計は UTC なので、設定の watch.utc_offset(既定 9 = 日本)だけずらして扱う。
// サマータイムのある地域には対応していない。
export let TZ_OFFSET = 9 * 3600;
export function setUtcOffset(hours: number) { TZ_OFFSET = hours * 3600; }
const WEEK = "日月火水木金土";

export interface Local { y: number; mo: number; d: number; h: number; mi: number; dow: number }

/** dow は月曜=0〜日曜=6(Python の weekday() と同じ) */
export function local(ts: number): Local {
  const t = new Date((ts + TZ_OFFSET) * 1000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(),
           h: t.getUTCHours(), mi: t.getUTCMinutes(), dow: (t.getUTCDay() + 6) % 7 };
}

/** 現地時刻の y/mo/d h:mi を UNIX 秒にする */
export function fromLocal(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi) / 1000 - TZ_OFFSET;
}

const p2 = (n: number) => String(n).padStart(2, "0");

export function fmtTime(ts: number | null | undefined, withDate = true): string {
  if (!ts) return "-";
  const l = local(ts);
  const hm = `${p2(l.h)}:${p2(l.mi)}`;
  if (!withDate) return hm;
  const t = new Date((ts + TZ_OFFSET) * 1000);
  return `${p2(l.mo)}/${p2(l.d)}(${WEEK[t.getUTCDay()]}) ${hm}`;
}

export function dateKey(ts: number): string {
  const l = local(ts);
  return `${l.y}-${p2(l.mo)}-${p2(l.d)}`;
}

/** "HH:MM" → [h, m] */
export function hm(text: string): [number, number] {
  const [h, m] = String(text).split(":").map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error(`時刻の書き方が正しくありません: ${text}`);
  return [h, m];
}

/** "7d" "3h" "30m" → 秒 */
export function parseDuration(text: string): number {
  const m = String(text).trim().match(/^(\d+)\s*([dhm])$/);
  if (!m) throw new Error(`時間の書き方が正しくありません: ${text}(例: 7d, 3h, 30m)`);
  return Number(m[1]) * ({ d: 86400, h: 3600, m: 60 } as Record<string, number>)[m[2]];
}

export function human(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}日`;
  if (sec % 3600 === 0) return `${sec / 3600}時間`;
  return `${Math.floor(sec / 60)}分`;
}

export function remaining(sec: number): string {
  let m = Math.max(1, Math.floor(sec / 60));
  if (m < 120) return `${m} 分`;
  let h = Math.floor(m / 60); m %= 60;
  if (h < 48) return `${h} 時間` + (m ? ` ${m} 分` : "");
  const d = Math.floor(h / 24); h %= 24;
  return `${d} 日` + (h ? ` ${h} 時間` : "");
}
