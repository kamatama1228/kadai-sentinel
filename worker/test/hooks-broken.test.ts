// 自分用のコードが壊れていても、元の通知が届くこと
import { beforeSend } from "../src/hooks.ts";
let fails = 0;
const check = (name: string, ok: boolean) => { if (!ok) fails++; console.log(`${ok ? "OK " : "NG "} ${name}`); };
const msgs: string[] = []; const log0 = console.log; console.log = (m: string) => { msgs.push(String(m)); };
const notices = [{ heading: "⏰ 締切", courseId: 1, course: "科目A", title: "レポート", url: "", fields: [] as [string, string][], urgent: false }];
const out = await beforeSend(notices, { channel: "personal", now: 0 });
console.log = log0;
check(`custom/hooks.ts が失敗・誤った形を返しても、元の通知を送る(${process.env.TEST_HOOKS?.split(/[\\/]/).pop()})`, out.length === 1 && out[0].heading === "⏰ 締切");
check("失敗したことをログに残す", msgs.some((m) => m.includes("custom/hooks.ts")));
console.log(fails ? `\n${fails} 件 NG` : "\nすべて OK");
process.exit(fails ? 1 : 0);
