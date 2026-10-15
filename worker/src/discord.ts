// Discord Webhook への投稿
const PALETTE = [0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245, 0x3ba55c,
                 0xfaa61a, 0x9b59b6, 0x1abc9c, 0xe67e22, 0x3498db, 0x95a5a6];

function crc32(s: string): number {
  let c = ~0;
  for (const b of new TextEncoder().encode(s)) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

export interface Notice {
  heading: string; courseId: number; course: string; title: string; url: string;
  fields: [string, string][]; urgent: boolean;
  id?: string;                 // 元の活動(quiz:123 など)。個人への転送で提出済みかを見るのに使う。表示には使わない
  until?: number | null;       // この時刻を過ぎたら送る意味がない(締切・公開時刻)。送り直しの打ち切りに使う。表示には使わない
  channel?: "shared" | "personal";   // オンライン授業など、送り先が授業によって変わるもの
}

export function embed(n: Notice) {
  const e: any = {
    author: { name: n.heading },
    title: (n.title || "(無題)").slice(0, 256),
    color: n.urgent ? 0xed4245 : PALETTE[crc32(String(n.courseId)) % PALETTE.length],
    fields: [{ name: "授業", value: n.course.slice(0, 1024) || "-", inline: false },
             ...n.fields.map(([k, v]) => ({ name: k, value: v.slice(0, 1024), inline: true }))],
  };
  if (n.url.startsWith("http")) e.url = n.url;
  return e;
}

function line(n: Notice): string {
  const title = n.url.startsWith("http") ? `[${n.title.slice(0, 60)}](${n.url})` : n.title.slice(0, 60);
  return `${n.heading} **${n.course.slice(0, 30)}**\n　${title || "(無題)"}(${n.fields.map(([, v]) => v).join("・")})`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Discord が受け付けなかった。permanent は送り直しても届かないもの(Webhook の削除・内容の誤りなど) */
export class DiscordError extends Error {
  permanent: boolean;
  constructor(message: string, permanent: boolean) { super(message); this.permanent = permanent; }
}

export async function post(url: string, embeds: any[], content?: string): Promise<void> {
  for (let i = 0; i < Math.max(embeds.length, 1); i += 10) {
    const payload: any = { embeds: embeds.slice(i, i + 10), allowed_mentions: { parse: [] } };
    if (content && i === 0) payload.content = content;
    let done = false;
    for (let tries = 0; tries < 5 && !done; tries++) {
      const r = await fetch(url, { method: "POST", body: JSON.stringify(payload),
                                   headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (r.status === 429) {
        const j: any = await r.json().catch(() => ({}));
        await sleep((Number(j.retry_after ?? 1) + 0.5) * 1000);
        continue;
      }
      if (!r.ok) throw new DiscordError(`Discord HTTP ${r.status}`, r.status >= 400 && r.status < 500);
      done = true;
    }
    if (!done) throw new DiscordError("Discord HTTP 429(混雑のため送れませんでした)", false);
  }
}

function digest(notices: Notice[], title: string, color: number) {
  const lines: string[] = [];
  let len = 0;
  for (const [i, n] of notices.entries()) {
    const l = line(n);
    if (len + l.length > 3900) { lines.push(`…ほか ${notices.length - i} 件(Moodle で確認してください)`); break; }
    lines.push(l); len += l.length + 1;
  }
  return { title, description: lines.join("\n"), color };
}

/** 急ぎのものは単独で(4件以上なら1つにまとめて)、それ以外は3件までは個別・4件以上は1つにまとめて送る。
 *  授業のコピーなどで一度に大量に出ても、メッセージは数件に収まる */
export async function send(url: string, notices: Notice[]): Promise<void> {
  const urgent = notices.filter((n) => n.urgent);
  if (urgent.length <= 3) for (const n of urgent) await post(url, [embed(n)]);
  else await post(url, [digest(urgent, `🚨 急ぎ ${urgent.length} 件`, 0xed4245)]);
  const normal = notices.filter((n) => !n.urgent);
  if (!normal.length) return;
  if (normal.length <= 3) await post(url, normal.map(embed));
  else await post(url, [digest(normal, `Moodle 更新 ${normal.length} 件`, 0x5865f2)]);
}

/** 埋め込みを使わない最低限の形(Discord が内容を受け付けなかったときの予備) */
export async function sendPlain(url: string, n: Notice): Promise<void> {
  const text = `${n.heading}\n${n.course} / ${n.title || "(無題)"}\n${n.fields.map(([k, v]) => `${k}: ${v}`).join(" ")}\n${n.url}`;
  await post(url, [], text.slice(0, 1900));
}
