// 自分用のコード(custom/hooks.ts)の拡張口のテスト。TEST_HOOKS に examples/custom/hooks.ts を渡して動かす
import { beforeSend } from "../src/hooks.ts";
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => { if (!ok) fails++; console.log(`${ok ? "OK " : "NG "} ${name}${extra ? "  … " + extra : ""}`); };
const n = (heading: string, urgent = false) => ({ heading, courseId: 1, course: "科目A", title: "レポート", url: "", fields: [["締切", "10/20"]] as [string, string][], urgent });
const night = Date.UTC(2026, 9, 26, 18, 0) / 1000;    // 日本時間 3:00
const noon = Date.UTC(2026, 9, 26, 3, 0) / 1000;      // 日本時間 12:00

const a = await beforeSend([n("📣 お知らせ"), n("⏰ 締切"), n("📣 お知らせ", true)], { channel: "personal", now: night });
check("例のフック:夜中のお知らせ(急ぎ以外)は送らない", a.length === 2 && !a.some((x) => x.heading.includes("お知らせ") && !x.urgent));
check("例のフック:個人の見出しに印がつく", a.every((x) => x.heading.startsWith("📌")));
const b = await beforeSend([n("📣 お知らせ")], { channel: "shared", now: noon });
check("例のフック:共有・昼はそのまま", b.length === 1 && b[0].heading === "📣 お知らせ");
const orig = [n("⏰ 締切")];
await beforeSend(orig, { channel: "personal", now: noon });
check("渡した通知そのものは書き換えない(コピーを渡す)", orig[0].heading === "⏰ 締切");
console.log(fails ? `\n${fails} 件 NG` : "\nすべて OK");
process.exit(fails ? 1 : 0);
