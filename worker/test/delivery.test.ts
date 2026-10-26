// 届け方の信頼性のテスト(二重送信しない・送り直す・無限に送らない・止まらない)。架空の授業で動かす
const H = 3600, D = 86400;
const T0 = Math.floor(Date.UTC(2026, 9, 12, 0, 0) / 1000);   // 10/12(月) 09:00 JST
let clock = T0;
Date.now = () => clock * 1000;
const jst = (t: number) => new Date((t + 9 * H) * 1000).toISOString().slice(5, 16).replace("T", " ");
// ---------- 偽の Moodle / Discord / KV
const C: any = { 10002: "科目B", 10001: "科目A", 10003: "科目C", 10004: "科目D" };
let assigns: any[], quizzes: any[], submitted: Set<number>;
let moodle: "ok" | "down" | "token" | "hang" | "slow" = "ok";
let moodleCalls = 0, discordReq = 0;
let discordFail: (ch: string, embeds: any[]) => number | null = () => null;
let offline = new Set<number>(), extraTodo: any[] = [], calFail = 0, kvBroken = false;   // 返り値: HTTP ステータス(失敗させるとき)
let sent: { ch: string; at: number; text: string }[] = [];
const reset = () => {
  offline = new Set(); extraTodo = []; calFail = 0; kvBroken = false;
  clock = T0; moodle = "ok"; moodleCalls = 0; discordReq = 0; sent = []; discordFail = () => null; kv.clear();
  submitted = new Set([2]);
  assigns = [
    { id: 1, course: 10002, name: "レポート1", duedate: T0 + 10 * D, cmid: 11 },
    { id: 2, course: 10002, name: "レポート2(提出済み)", duedate: T0 + 10 * D, cmid: 12 },
    { id: 9, course: 10003, name: "科目C 演習", duedate: T0 + 2 * D, cmid: 19 },
  ];
  quizzes = [{ id: 3, course: 10001, name: "第3回 小テスト", timeopen: T0 + 2 * D + 5 * H, timeclose: T0 + 2 * D + 5 * H + 900, coursemodule: 13, timelimit: 600 }];
};
const todo = () => [
  ...extraTodo,
  ...assigns.filter((a) => !submitted.has(a.id) && !offline.has(a.id)).map((a) => ({ modulename: "assign", instance: a.id, course: { id: a.course, fullname: C[a.course] }, timesort: a.duedate, name: a.name, url: "https://x/a" })),
  ...quizzes.map((q) => ({ modulename: "quiz", instance: q.id, course: { id: q.course, fullname: C[q.course] }, timesort: q.timeclose, name: q.name, url: "https://x/q" })),
].filter((e) => e.timesort > clock);
globalThis.fetch = (async (url: string, init: any) => {
  if (url.includes("discord")) {
    discordReq++;
    const ch = url.includes("PERSONAL") ? "個人" : "共有";
    const p = JSON.parse(init.body);
    const st = discordFail(ch, p.embeds);
    if (st) return new Response(JSON.stringify({ retry_after: 0.01 }), { status: st });
    if (p.content) sent.push({ ch, at: clock, text: "(文字のみ)" + p.content.replace(/\n/g, " ") });
    for (const e of p.embeds) sent.push({ ch, at: clock, text: e.author ? `${e.author.name} | ${e.title}` : `${e.title}` });
    return new Response(null, { status: 204 });
  }
  moodleCalls++;
  if (moodle === "down") throw new Error("connect timeout");
  if (moodle === "hang") return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(new Error("timeout"))));
  if (moodle === "slow") await new Promise((r) => setTimeout(r, 300));
  const j = (x: any) => new Response(JSON.stringify(x));
  if (moodle === "token") return j({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token" });
  const fn = new URLSearchParams(init.body).get("wsfunction");
  switch (fn) {
    case "core_course_get_enrolled_courses_by_timeline_classification": return j({ courses: Object.entries(C).map(([id, n]) => ({ id: +id, fullname: n })) });
    case "mod_quiz_get_quizzes_by_courses": return j({ quizzes });
    case "mod_assign_get_assignments": return j({ courses: Object.keys(C).map((id) => ({ id: +id, assignments: assigns.filter((a) => a.course === +id).map((a) => ({ ...a, allowsubmissionsfromdate: 0 })) })) });
    case "core_calendar_get_calendar_events": {
      const b = new URLSearchParams(init.body); const cids = [...b.entries()].filter(([k]) => k.startsWith("events[courseids]")).map(([, v]) => +v);
      if (calFail && cids.includes(calFail)) return j({ exception: "x", errorcode: "accessexception", message: "no access" });
      return j({ events: [] });
    }
    case "mod_assign_get_submission_status": {
      const id = +new URLSearchParams(init.body).get("assignid")!;
      return j({ lastattempt: { submission: { status: submitted.has(id) ? "submitted" : "new" } } });
    }
    case "mod_quiz_get_user_attempts": return j({ attempts: [] });
    case "core_calendar_get_action_events_by_timesort": return j({ events: todo() });
  }
  throw new Error("unknown " + fn);
}) as any;
const kv = new Map<string, string>();
const env: any = { MOODLE_URL: "https://moodle.test", MOODLE_TOKEN: "t", DISCORD_WEBHOOK_URL: "https://discord/SHARED", PERSONAL_WEBHOOK_URL: "https://discord/PERSONAL",
  STATE: { get: async (k: string) => kv.has(k) ? JSON.parse(kv.get(k)!) : null, put: async (k: string, v: string) => { if (kvBroken) throw new Error("KV write limit"); kv.set(k, v); } } };
const worker = (await import("../src/index.ts")).default;
const log = console.log; console.log = () => {};
let kvWrites = 0; const put0 = env.STATE.put; env.STATE.put = async (k: string, v: string) => { kvWrites++; return put0(k, v); };
const tick = async () => { try { await worker.scheduled({} as any, env); } catch { } };
const until = async (t: number) => { while (clock < t) { clock += 60; await tick(); } };
const st = () => JSON.parse(kv.get("state")!);
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => { if (!ok) fails++; log(`${ok ? "OK " : "NG "} ${name}${extra ? "  … " + extra : ""}`); };
const lines = (ch?: string) => sent.filter((s) => !ch || s.ch === ch).map((s) => `${jst(s.at)} [${s.ch}] ${s.text}`);
const count = (re: RegExp, ch?: string) => sent.filter((s) => (!ch || s.ch === ch) && re.test(s.text)).length;
const begin = async () => { reset(); await tick(); kvWrites = 0; moodleCalls = 0; };

// ===== 1. ふだん(1日2回確認)の12日間:警告は1回も出ない
await begin(); await until(T0 + 12 * D);
check("ふだんの12日間で警告ゼロ(確認しない時間は失敗に数えない)", count(/確認できていません/) === 0);
check("提出済みのレポート2は個人に来ない", count(/レポート2/, "個人") === 0 && count(/レポート2/, "共有") === 2);
check("グループの通知は個人にも全部届く(提出済みのリマインド以外)", count(/./, "共有") - 2 === count(/./, "個人") - count(/科目C/, "個人"));
check("送り直し待ちは残っていない", !st().pending?.shared?.length && !st().pending?.personal?.length);
log(`     参考: 12日で Moodle 問い合わせ ${moodleCalls} 回 / 状態の保存 ${kvWrites} 回(1日あたり ${Math.round(kvWrites / 12)})`);
const normalLines = lines();

// ===== 2. グループの Webhook が 13:55〜14:05 に落ちる(14:00 小テスト公開)
await begin(); await until(T0 + 2 * D + 4 * H + 55 * 60);
discordFail = (ch) => ch === "共有" ? 503 : null;
await until(T0 + 2 * D + 5 * H + 5 * 60);
const before = moodleCalls; discordFail = () => null; await until(T0 + 2 * D + 5 * H + 10 * 60);
check("グループの小テスト公開通知が、復旧後に1回だけ届く", count(/公開されました/, "共有") === 1, lines("共有").filter((l) => /公開/.test(l)).join(" / "));
check("個人には遅れず1回だけ届く", count(/公開されました/, "個人") === 1);
await until(T0 + 12 * D);
check("その後の通知は正常時と同じ", JSON.stringify(lines().filter((l) => !/公開されました/.test(l))) === JSON.stringify(normalLines.filter((l) => !/公開されました/.test(l))));

// ===== 3. 個人の Webhook が丸1日落ちる(締切1日前のリマインドが入る)
await begin(); await until(T0 + 12 * H);
const mc0 = moodleCalls; await until(T0 + 36 * H); const normalCalls = moodleCalls - mc0;   // Discord が正常なときの回数(比較用)
await begin(); await until(T0 + 12 * H);
discordFail = (ch) => ch === "個人" ? 500 : null;
const mc = moodleCalls; await until(T0 + 36 * H);
check("送り直し中に Moodle へ余計に問い合わせない", moodleCalls - mc === normalCalls, `${moodleCalls - mc} 回(正常時 ${normalCalls} 回)`);
discordFail = () => null; await until(T0 + 12 * D);
check("12時間を過ぎた通知は捨てる(古い知らせを後から送らない)", count(/1日を切りました.*科目C/, "個人") === 0);
check("復旧後の 3時間前リマインドは届く", count(/3時間を切りました/, "個人") === 1);
check("グループは影響を受けない", JSON.stringify(lines("共有")) === JSON.stringify(normalLines.filter((l) => l.includes("[共有]"))));

// ===== 4. 一部だけ失敗(急ぎは届き、まとめ送信が失敗)→ 二重送信しない
await begin(); await until(T0 + 2 * D + 4 * H);
let n = 0; discordFail = (ch, e) => (ch === "個人" && !e[0]?.author?.name?.includes("🚨") && n++ < 1) ? 500 : null;
await until(T0 + 12 * D);
const dup = new Set<string>(); let dupN = 0; for (const l of lines()) { if (dup.has(l)) dupN++; dup.add(l); }
check("一部失敗しても同じ通知が二重に届かない", dupN === 0);

// ===== 5. Discord が 429 を返し続ける → 黙って消さずに送り直す
await begin(); await until(T0 + 3 * D - 10 * 60);
discordFail = (ch) => ch === "共有" ? 429 : null; await until(T0 + 3 * D + 5 * 60);
discordFail = () => null; await until(T0 + 3 * D + 30 * 60);
check("429 が続いても通知が消えない", count(/7日を切りました/, "共有") === 2, lines("共有").slice(-3).join(" / "));

// ===== 6. Moodle が 3時間止まる → 警告なし / 8時間止まる → 6時間たった時点で1回だけ
await begin(); await until(T0 + 1 * D);
moodle = "down"; await until(T0 + 1 * D + 3 * H); moodle = "ok"; await until(T0 + 2 * D - 2 * H);
check("3時間の停止では警告しない", count(/確認できていません/) === 0);
await until(T0 + 3 * D + 1 * H);                    // 10/15 10:00 の確認から失敗させる
moodle = "down"; const down = clock; await until(T0 + 3 * D + 10 * H);
const al = sent.filter((s) => /確認できていません/.test(s.text));
check("8時間の停止では、失敗が6時間続いた時点で1回だけ警告", al.length === 1, al.map((a) => `${jst(a.at)} ${a.text}`).join(""));
moodle = "ok"; await until(T0 + 4 * D);
check("復旧すると失敗の記録は消える", st().fail_since === undefined);

// ===== 7. 警告の送信そのものが失敗 → 次の確認で送り直す
await begin(); await until(T0 + 3 * D + 1 * H);
moodle = "down"; discordFail = (ch) => ch === "個人" ? 500 : null; await until(T0 + 3 * D + 10 * H + 30 * 60);
check("(前提)失敗中は警告が届いていない", count(/確認できていません/) === 0);
discordFail = () => null; await until(T0 + 3 * D + 10 * H + 45 * 60);
check("警告の送信に失敗しても、あとで届く", count(/確認できていません/) === 1);

// ===== 8. トークン切れ → すぐ1回だけ警告、確認は1時間おき
await begin(); await until(T0 + 1 * D + 2 * H);
moodle = "token"; const c0 = moodleCalls; await until(T0 + 2 * D + 12 * H);
check("トークン切れは最初の確認ですぐ警告、日付が変わっても24時間は繰り返さない", count(/トークン/) === 1, sent.filter((s) => /トークン/.test(s.text)).map((s) => jst(s.at)).join(","));
check("トークン切れ中は1時間おき(大学のサーバーを叩き続けない)", moodleCalls - c0 <= 24, `${moodleCalls - c0} 回の問い合わせ`);
await until(T0 + 3 * D + 1 * H);
check("24時間たっても直っていなければもう一度知らせる", count(/トークン/) === 2);

// ===== 9. 今デプロイされている状態(旧形式)からの切り替え
await begin(); const old = st(); delete old.pending; delete old.retry_at; delete old.last_ok; kv.set("state", JSON.stringify(old));
await until(T0 + 12 * D);
check("旧形式の状態からそのまま動く", JSON.stringify(lines()) === JSON.stringify(normalLines));

// ===== 10. Moodle が遅く、2つの起動が重なる → 二重送信しない
await begin(); await until(T0 + 2 * D + 5 * H - 60);
moodle = "slow"; clock += 60; const a = tick();                  // 1回目の確認(Moodle が遅く、1分以上かかる)
await new Promise((r) => setTimeout(r, 100)); clock += 60; const b = tick();   // その途中で次の起動
await new Promise((r) => setTimeout(r, 100)); clock += 60; const c = tick();   // さらに次の起動
await Promise.all([a, b, c]); moodle = "ok"; await until(T0 + 2 * D + 6 * H);
check("起動が重なっても小テスト公開は1回だけ", count(/公開されました/, "共有") === 1 && count(/公開されました/, "個人") === 1,
      `共有 ${count(/公開されました/, "共有")} / 個人 ${count(/公開されました/, "個人")}`);

// ===== 11. Webhook が削除された(404)→ 送り直し続けない
await begin(); discordFail = (ch) => ch === "個人" ? 404 : null; await until(T0 + 2 * D + 5 * H + 30);
const r0 = discordReq; await until(T0 + 2 * D + 7 * H);
check("届かない失敗(404)は送り直さない", discordReq - r0 <= 2, `${discordReq - r0} 回の送信`);
check("そのときもグループは正常", count(/公開されました/, "共有") === 1);

// ===== 12. Discord が12時間止まる(締切なしの急ぎ通知)→ 保存回数が無料枠に収まる
await begin(); quizzes[0].timeclose = 0; await until(T0 + 2 * D + 5 * H - 60);
discordFail = () => 503; const w0 = kvWrites; await until(T0 + 2 * D + 17 * H); discordFail = () => null;
check("Discord が12時間止まっても状態の保存は1日1000回の無料枠に収まる", kvWrites - w0 < 400, `${kvWrites - w0} 回`);

// ===== 13. 題名が空の課題
await begin(); assigns.push({ id: 7, course: 10002, name: "", duedate: T0 + 20 * D, cmid: 17 }); await until(T0 + 1 * D);
check("題名が空でも送れる", sent.some((s) => s.text.includes("(無題)")));

// ===== 14. Moodle が応答しないまま止まる → 30秒で打ち切って失敗扱い
await begin(); await until(T0 + 13 * H - 60); moodle = "hang"; const keep = setInterval(() => {}, 1000); const t0 = performance.now(); clock += 60; await tick(); clearInterval(keep);
check("応答しない Moodle は30秒で打ち切る", st().fail_since !== undefined && performance.now() - t0 < 40000, `${Math.round((performance.now() - t0) / 1000)} 秒`);

// ===== 15. オフライン提出など、やること一覧に出ない未提出の課題 → 個人にもリマインドが届く
await begin(); offline.add(1); await until(T0 + 10 * D);
check("やること一覧に出ない課題も、提出済みと確かめられなければ個人に届く", count(/7日を切りました.*レポート1/, "個人") === 1 && count(/1日を切りました.*レポート1/, "個人") === 1);
check("提出済みと確かめられたものは個人に来ない", count(/レポート2/, "個人") === 0);

// ===== 16. 教授が去年の授業をコピー(日付なしの小テスト20件が一度に公開)
await begin(); await until(T0 + 3 * H);
for (let i = 0; i < 20; i++) quizzes.push({ id: 100 + i, course: 10001, name: `コピーされた小テスト${i}`, timeopen: 0, timeclose: 0, coursemodule: 200 + i, timelimit: 0 });
const s0 = sent.length; await until(T0 + 1 * D);
const msgs = sent.slice(s0);
check("大量に出ても、メッセージは各チャンネル数件に収まる", msgs.filter((m) => m.ch === "共有").length <= 2 && msgs.filter((m) => m.ch === "個人").length <= 2, msgs.map((m) => `[${m.ch}] ${m.text}`).join(" / "));
await until(T0 + 5 * D);
check("その後くり返し届かない", sent.slice(s0).filter((m) => /急ぎ|コピー/.test(m.text)).length === msgs.length);

// ===== 17. 締切が過去の日付のまま出された課題
await begin(); assigns.push({ id: 6, course: 10002, name: "日付ミスの課題", duedate: T0 - 300 * D, cmid: 16 }); await until(T0 + 5 * D);
check("締切が過去の日付でも、新着として一度だけ知らせる", count(/過去の日付.*日付ミス/, "共有") === 1 && count(/過去の日付.*日付ミス/, "個人") === 1);
assigns[assigns.length - 1].duedate = T0 + 9 * D; await until(T0 + 7 * D);
check("教授が日付を直したら、締切変更として知らせる", count(/締切が変更.*日付ミス/, "共有") === 1 && count(/締切が変更.*日付ミス/, "個人") === 1);

// ===== 18. 共有の授業で、共有が扱わない種類(ワークショップ)のレポート/配属以外のゼミのアンケート
await begin();
extraTodo = [{ modulename: "workshop", instance: 70, course: { id: 10002, fullname: C[10002] }, timesort: T0 + 3 * D, name: "ワークショップのレポート", url: "https://x/w" },
             { modulename: "questionnaire", instance: 71, course: { id: 10004, fullname: C[10004] }, timesort: T0 + 3 * D, name: "9_某ゼミ", url: "https://x/q" }];
await until(T0 + 4 * D);
check("共有が扱わない種類のレポートは、個人に 1日前・3時間前が届く", count(/1日を切りました.*ワークショップ/, "個人") === 1 && count(/3時間を切りました.*ワークショップ/, "個人") === 1);
check("配属以外のゼミのアンケートは届かない(設計どおり)", count(/某ゼミ/) === 0);

// ===== 19. 状態を保存できなくなる(無料枠の上限など)→ 同じ通知を送り続けない
await begin(); await until(T0 + 2 * D + 5 * H - 120);
kvBroken = true; const k0 = sent.length; await until(T0 + 2 * D + 8 * H);
check("保存できない間は何も送らない(同じ通知の連発が起きない)", sent.length === k0, `${sent.length - k0} 件送信`);
kvBroken = false; await until(T0 + 3 * D);
check("保存できるようになったら、取りこぼさず1回だけ届く(締切前のもの)", count(/公開されました/) === 0 || count(/公開されました/, "共有") === 1);
const d19 = new Set<string>(); let dup19 = 0; for (const l of lines()) { if (d19.has(l)) dup19++; d19.add(l); } check("二重送信なし", dup19 === 0);

// ===== 20. Discord が内容を受け付けない(400)→ 文字だけの形で届く
await begin(); discordFail = (ch, e) => e.length && e.some((x: any) => /レポート3/.test(JSON.stringify(x))) ? 400 : null;
assigns.push({ id: 4, course: 10002, name: "レポート3", duedate: T0 + 20 * D, cmid: 14 }); const q0 = discordReq; await until(T0 + 1 * D);
check("埋め込みを拒否されても、文字だけの形で1回ずつ届く", count(/\(文字のみ\).*レポート3/, "共有") === 1 && count(/\(文字のみ\).*レポート3/, "個人") === 1, lines().filter((l) => /レポート3/.test(l)).join(" / "));
await until(T0 + 2 * D); check("拒否されたものを送り直し続けない", discordReq - q0 <= 8, `${discordReq - q0} 回の送信`);

// ===== 21. 履修が外れた授業がある(その授業だけカレンダーが取れない)
await begin(); calFail = 10005; await until(T0 + 3 * D);
check("1つの授業のせいで全部止まらない(警告も出ない)", count(/公開されました/, "共有") === 1 && count(/確認できていません/) === 0);

// ===== 22. 教授が締切を何度も行ったり来たり
await begin(); await until(T0 + 7 * H);
for (const [i, d] of [[1, 11], [2, 10], [3, 11], [4, 10]] as [number, number][]) { assigns[0].duedate = T0 + d * D; await until(T0 + 7 * H + i * 12 * H); }
await until(T0 + 12 * D);
check("締切変更の通知は、変更の回数だけ(無限にならない)", count(/締切が変更.*レポート1/, "共有") === 4, `${count(/締切が変更.*レポート1/, "共有")} 回`);

// ===== 23. まとめ通知が長すぎる
await begin(); for (let i = 0; i < 100; i++) assigns.push({ id: 300 + i, course: 10002, name: `大量の課題${i}`.repeat(3), duedate: T0 + 30 * D, cmid: 400 + i });
await until(T0 + 1 * D);
check("長すぎるまとめは「ほか N 件」で切る", sent.some((m) => m.ch === "共有" && /Moodle 更新 10[0-9] 件/.test(m.text)), lines().slice(0, 4).join(" / "));

log(fails ? `\n${fails} 件 NG` : "\nすべて OK");
process.exit(fails ? 1 : 0);
