// 自分用のコード(custom/hooks.ts)を呼ぶところ。書き方は docs/EXTEND.md
// 自分用のコードが失敗しても、通知は止めずに元の内容で送る(壊れても通知が届かなくならないように)
import type { Notice } from "./discord.ts";
import { local } from "./time.ts";
import { hooks } from "../.generated/custom.ts";

/** この版の拡張口の形。形を変えるときは数字を上げ、docs/EXTEND.md に書く */
export const HOOKS_API = 1;

export interface HookContext {
  /** 送り先。shared=共有チャンネル / personal=個人チャンネル */
  channel: "shared" | "personal";
  /** 今の時刻(UNIX 秒) */
  now: number;
  /** 今の日時(設定のタイムゾーン)。dow は月曜=0 */
  local: { y: number; mo: number; d: number; h: number; mi: number; dow: number };
}

type BeforeSend = (notices: Notice[], ctx: HookContext) => Notice[] | Promise<Notice[]>;

const isNotice = (n: unknown): n is Notice =>
  !!n && typeof n === "object" && typeof (n as Notice).heading === "string" && typeof (n as Notice).title === "string"
  && Array.isArray((n as Notice).fields);

/** 送る直前の通知を、自分用のコードに渡して差し替える。失敗したら元のまま */
export async function beforeSend(notices: Notice[], ctx: Omit<HookContext, "local">): Promise<Notice[]> {
  const fn = hooks.beforeSend as BeforeSend | undefined;
  if (typeof fn !== "function" || !notices.length) return notices;
  try {
    const copy = notices.map((n) => ({ ...n, fields: n.fields.map(([k, v]) => [k, v] as [string, string]) }));
    const out = await fn(copy, { ...ctx, local: local(ctx.now) });
    if (!Array.isArray(out) || !out.every(isNotice)) throw new Error("beforeSend は通知の配列を返してください");
    return out.map((n) => ({ ...n, courseId: Number(n.courseId ?? 0), course: String(n.course ?? ""), url: String(n.url ?? ""),
                             urgent: Boolean(n.urgent) }));
  } catch (e) {
    console.log(`custom/hooks.ts の beforeSend が失敗したので、元の通知を送ります: ${e}`);
    return notices;
  }
}
