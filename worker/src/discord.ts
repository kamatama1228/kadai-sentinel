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
}

export function embed(n: Notice) {
  const e: any = {
    author: { name: n.heading },
    title: n.title.slice(0, 256),
    color: n.urgent ? 0xed4245 : PALETTE[crc32(String(n.courseId)) % PALETTE.length],
    fields: [{ name: "授業", value: n.course.slice(0, 1024) || "-", inline: false },
             ...n.fields.map(([k, v]) => ({ name: k, value: v.slice(0, 1024), inline: true }))],
  };
  if (n.url.startsWith("http")) e.url = n.url;
  return e;
}

function line(n: Notice): string {
  const title = n.url.startsWith("http") ? `[${n.title.slice(0, 60)}](${n.url})` : n.title.slice(0, 60);
  return `${n.heading} **${n.course.slice(0, 30)}**\n　${title}(${n.fields.map(([, v]) => v).join("・")})`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function post(url: string, embeds: any[], content?: string): Promise<void> {
  for (let i = 0; i < Math.max(embeds.length, 1); i += 10) {
    const payload: any = { embeds: embeds.slice(i, i + 10), allowed_mentions: { parse: [] } };
    if (content && i === 0) payload.content = content;
    for (let tries = 0; tries < 5; tries++) {
      const r = await fetch(url, { method: "POST", body: JSON.stringify(payload),
                                   headers: { "Content-Type": "application/json" } });
      if (r.status === 429) {
        const j: any = await r.json().catch(() => ({}));
        await sleep((Number(j.retry_after ?? 1) + 0.5) * 1000);
        continue;
      }
      if (!r.ok) throw new Error(`Discord HTTP ${r.status}`);
      break;
    }
  }
}

/** 急ぎのものは単独で、それ以外は3件までは個別・4件以上は1つにまとめて送る */
export async function send(url: string, notices: Notice[]): Promise<void> {
  for (const n of notices.filter((n) => n.urgent)) await post(url, [embed(n)]);
  const normal = notices.filter((n) => !n.urgent);
  if (!normal.length) return;
  if (normal.length <= 3) await post(url, normal.map(embed));
  else await post(url, [{ title: `Moodle 更新 ${normal.length} 件`,
                          description: normal.map(line).join("\n").slice(0, 4000), color: 0x5865f2 }]);
}
