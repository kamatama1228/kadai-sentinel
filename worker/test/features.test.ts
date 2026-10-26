// 新機能(オンライン授業の朝通知・締切変更・お知らせ・ミュート・設定エラー)のテスト
const H = 3600, D = 86400;
const T0 = Math.floor(Date.UTC(2026, 9, 12, 0, 0) / 1000);   // 10/12(月) 09:00 JST
let clock = T0; Date.now = () => clock * 1000;
const jst = (t: number) => new Date((t + 9 * H) * 1000).toISOString().slice(5, 16).replace("T", " ");
const C: any = { 10006: "科目F", 10001: "科目A", 10003: "科目C", 10007: "科目G", 10008: "科目H", 10009: "科目I", 10002: "科目B" };
let urls: any[], att: Record<number, number[]>, discussions: Record<number, any[]>, assigns: any[], quizzes: any[];
let forumsFail = false, sent: { ch: string; at: number; text: string }[] = [], calls: Record<string, number[]> = {};
const reset = () => {
  clock = T0; sent = []; calls = {}; forumsFail = false; kv.clear();
  urls = [{ coursemodule: 500, course: 10006, name: "科目F(第2回)Zoom 遠隔講義", timemodified: T0 - 6 * D }];
  att = { 10006: [T0 - 4 * D + 4 * H, T0 + 3 * D + 4 * H, T0 + 10 * D + 4 * H], 10003: [T0 + 2 * D + 1.5 * H] };
  discussions = { 900: [{ discussion: 1, name: "授業の進め方について", message: "板書で進めます", created: T0 - 20 * D }],
                  901: [{ discussion: 2, name: "第1回の資料", message: "資料です", created: T0 - 10 * D }] };
  assigns = [{ id: 9, course: 10003, name: "科目C 演習", duedate: T0 + 5 * D, cmid: 19 }, { id: 1, course: 10002, name: "レポート1", duedate: T0 + 20 * D, cmid: 11 }];
  quizzes = [{ id: 3, course: 10001, name: "第3回 小テスト", timeopen: T0 + 3 * D + 5 * H, timeclose: T0 + 3 * D + 5 * H + 900, coursemodule: 13, timelimit: 600 }];
};
const cids = (body: URLSearchParams) => [...body.entries()].filter(([k]) => /courseids/.test(k)).map(([, v]) => +v);
const kv = new Map<string, string>();
globalThis.fetch = (async (url: string, init: any) => {
  if (url.includes("discord")) {
    const ch = url.includes("PERSONAL") ? "個人" : "共有";
    const p = JSON.parse(init.body);
    if (p.content) sent.push({ ch, at: clock, text: "(文字のみ)" + p.content });
    for (const e of p.embeds) sent.push({ ch, at: clock, text: e.author ? `${e.author.name} | ${e.fields?.[0]?.value} / ${e.title}` : `${e.title}: ${e.description ?? ""}` });
    (calls["discord:" + ch] ??= []).push(clock);
    return new Response(null, { status: 204 });
  }
  const b = new URLSearchParams(init.body); const fn = b.get("wsfunction")!;
  (calls[fn] ??= []).push(clock);
  const j = (x: any) => new Response(JSON.stringify(x));
  switch (fn) {
    case "core_course_get_enrolled_courses_by_timeline_classification": return j({ courses: Object.entries(C).map(([id, n]) => ({ id: +id, fullname: n })) });
    case "mod_quiz_get_quizzes_by_courses": return j({ quizzes });
    case "mod_assign_get_assignments": return j({ courses: cids(b).map((id) => ({ id, assignments: assigns.filter((a) => a.course === id).map((a) => ({ ...a, allowsubmissionsfromdate: 0 })) })) });
    case "core_calendar_get_calendar_events": return j({ events: cids(b).flatMap((id) => (att[id] ?? []).map((t) => ({ modulename: "attendance", courseid: id, timestart: t, name: "出欠", eventtype: "attendance" }))) });
    case "core_calendar_get_action_events_by_timesort": return j({ events: assigns.filter((a) => a.duedate > clock).map((a) => ({ modulename: "assign", instance: a.id, course: { id: a.course, fullname: C[a.course] }, timesort: a.duedate, name: a.name, url: "https://x/a" })) });
    case "mod_url_get_urls_by_courses": return j({ urls: urls.filter((u) => cids(b).includes(u.course)) });
    case "mod_forum_get_forums_by_courses":
      if (forumsFail) return new Response("err", { status: 500 });
      return j([{ id: 900, course: 10003, type: "news" }, { id: 901, course: 10006, type: "news" }, { id: 902, course: 10003, type: "general" }].filter((f) => cids(b).includes(f.course)));
    case "mod_forum_get_forum_discussions": return j({ discussions: discussions[+b.get("forumid")!] ?? [] });
    case "mod_assign_get_submission_status": return j({ lastattempt: { submission: { status: "new" } } });
    case "mod_quiz_get_user_attempts": return j({ attempts: [] });
  }
  throw new Error("unknown " + fn);
}) as any;
const env: any = { MOODLE_URL: "https://moodle.test", MOODLE_TOKEN: "t", DISCORD_WEBHOOK_URL: "https://discord/SHARED", PERSONAL_WEBHOOK_URL: "https://discord/PERSONAL",
  STATE: { get: async (k: string) => kv.has(k) ? JSON.parse(kv.get(k)!) : null, put: async (k: string, v: string) => { kv.set(k, v); } } };
const worker = (await import("../src/index.ts")).default;
const log = console.log; console.log = () => {};
const tick = async () => { try { await worker.scheduled({} as any, env); } catch { } };
const until = async (t: number) => { while (clock < t) { clock += 60; await tick(); } };
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => { if (!ok) fails++; log(`${ok ? "OK " : "NG "} ${name}${extra ? "  … " + extra : ""}`); };
const lines = (ch?: string, re?: RegExp) => sent.filter((s) => (!ch || s.ch === ch) && (!re || re.test(s.text))).map((s) => `${jst(s.at)} [${s.ch}] ${s.text}`);
const MODE = process.env.MODE ?? "main";

if (MODE === "main") {
  reset(); await tick();                                         // 初回(記録だけ)
  await until(T0 + 1 * D + 5 * H);                                // 10/13 火 14:00
  urls.push({ coursemodule: 501, course: 10006, name: "科目F(第3回)Zoom 遠隔講義", timemodified: clock },
            { coursemodule: 502, course: 10003, name: "科目C 遠隔講義(Zoom)", timemodified: clock },
            { coursemodule: 503, course: 10007, name: "＋R授業 VoD", timemodified: clock });
  assigns[0].duedate = T0 + 6 * D;                                // 共有にない授業の締切変更
  await until(T0 + 2 * D + 3 * H);                                // 10/14 水 12:00
  urls.push({ coursemodule: 504, course: 10008, name: "科目H オンライン授業", timemodified: clock });
  discussions[900].push({ discussion: 3, name: "10/16 休講のお知らせ", message: "休講します", created: clock },
                        { discussion: 4, name: "第2回の資料", message: "資料をアップしました", created: clock });
  discussions[901].push({ discussion: 5, name: "休講のお知らせ", message: "休講", created: clock });
  await until(T0 + 12 * D);
  if (process.env.VERBOSE) { for (const l of lines()) log("   " + l); log(""); }
  check("科目F(共有)のオンライン授業は、授業当日 10/15 の朝7:30に共有へ1回", JSON.stringify(lines("共有", /オンライン授業/).map((l) => l.slice(0, 11))) === JSON.stringify(["10-15 07:30"]), lines("共有", /オンライン/).join(" / "));
  check("科目C(個人)のオンライン授業は、当日 10/14 の朝に個人だけ1回", lines("個人", /今日はオンライン.*科目C/).length === 1 && lines("個人", /今日はオンライン.*科目C/)[0].startsWith("10-14 07:30") && lines("共有", /科目C/).length === 0);
  check("科目Fのオンライン授業は個人にも1回(転送)", lines("個人", /今日はオンライン.*科目F/).length === 1);
  check("VoD(録画)はオンライン授業として扱わない", lines(undefined, /科目G|VoD/).length === 0);
  check("過去のリンク(第2回)は送らない", lines(undefined, /第2回\)Zoom/).length === 0);
  check("日付の分からないリンク(科目H)は、見つけたときに個人へ1回だけ", lines("個人", /掲載されました.*科目H/).length === 1 && lines(undefined, /科目H/).length === 1);
  check("お知らせはキーワード(休講)を含む、共有にない授業のものだけ個人へ1回", lines("個人", /お知らせ/).length === 1 && lines("個人", /お知らせ.*休講/).length === 1 && lines("共有", /お知らせ/).length === 0);
  check("22時の確認でも、締切の変更・お知らせは届く(オンライン授業の時刻の判定とは関係ない)", lines("個人").filter((l) => /^10-13 22:00.*締切が変更|^10-14 22:00.*お知らせ/.test(l)).length === 2);
  check("最初からあったお知らせは送らない", lines(undefined, /進め方/).length === 0);
  check("共有にない授業の締切変更は個人へ1回", lines("個人", /締切が変更.*科目C/).length === 1 && lines("共有", /締切が変更/).length === 0);
  const byDay: Record<string, number> = {};
  for (const t of calls["discord:共有"] ?? []) { const d = jst(t).slice(0, 5); byDay[d] = (byDay[d] ?? 0) + 1; }
  check("共有チャンネルのメッセージは1日2通以下", Object.values(byDay).every((n) => n <= 2), JSON.stringify(byDay));
  const urlDays: Record<string, number> = {};
  for (const t of calls["mod_url_get_urls_by_courses"] ?? []) { const d = jst(t).slice(0, 5); urlDays[d] = (urlDays[d] ?? 0) + 1; }
  check("追加の問い合わせは1分おきの時間帯(木曜)でも1日数回だけ", Object.values(urlDays).every((n) => n <= 5), JSON.stringify(urlDays));
  log(`     参考: 12日で Moodle 問い合わせ ${Object.entries(calls).filter(([k]) => !k.startsWith("discord")).reduce((a, [, v]) => a + v.length, 0)} 回`);

  // お知らせの取得に失敗しても、ほかの通知は届く・1分おきに叩かない
  reset(); await tick(); forumsFail = true; await until(T0 + 4 * D);
  check("お知らせの取得に失敗しても、小テストの公開通知は届く", lines("共有", /公開されました/).length === 1);
  check("取得に失敗しても1分おきには問い合わせない", (calls["mod_forum_get_forums_by_courses"] ?? []).length <= 4 * 24, `${(calls["mod_forum_get_forums_by_courses"] ?? []).length} 回 / 4日`);
}

if (MODE === "main") {
  // 木曜:13時台の1分おきの確認で見つかる → 授業の開始時刻(13:00)に届く(正しい動き)
  reset(); await tick(); await until(T0 + 3 * D + 2 * H);          // 10/15 木 11:00
  urls.push({ coursemodule: 601, course: 10006, name: "科目F(第4回)Zoom 遠隔講義", timemodified: clock });
  await until(T0 + 4 * D);
  check("授業の日の昼に置かれたリンクは、見つけた時点(13:00)で1回", lines("共有", /第4回/).length === 1 && lines("共有", /第4回/)[0].startsWith("10-15 13:00"));
  // 水曜:7:30 のあとに置かれ、22:00 の確認で見つかる → 夜なので送らない
  reset(); await tick(); await until(T0 + 2 * D);                  // 10/14 水 09:00
  urls.push({ coursemodule: 602, course: 10003, name: "科目C 遠隔講義(Zoom)第5回", timemodified: clock });
  await until(T0 + 12 * D);
  check("授業の日の夜に見つかったリンクは「今日は」を送らない(翌週以降も送らない)", lines(undefined, /第5回/).length === 0, lines(undefined, /第5回/).join(" / "));
}

if (MODE === "mute") {
  reset(); await tick(); await until(T0 + 1 * D + 5 * H);
  urls.push({ coursemodule: 502, course: 10003, name: "科目C 遠隔講義(Zoom)", timemodified: clock },
            { coursemodule: 501, course: 10006, name: "科目F(第3回)Zoom 遠隔講義", timemodified: clock });
  assigns[0].duedate = T0 + 6 * D;
  await until(T0 + 5 * D);
  check("[[mute]] course=10003(個人)で、科目Cの通知が個人に来ない", lines("個人", /科目C/).length === 0, lines("個人", /科目C/).join(" / "));
  check("ミュートしていない科目Fは届く", lines("共有", /今日はオンライン.*科目F/).length === 1 && lines("個人", /今日はオンライン.*科目F/).length === 1);
}

if (MODE === "badconfig") {
  reset(); await until(T0 + 2 * D);
  check("設定の誤りは個人に1日1回だけ知らせ、ほかは送らない", sent.length === 2 && sent.every((s) => s.ch === "個人" && /notify.toml/.test(s.text)), sent.map((s) => jst(s.at) + " " + s.text.slice(0, 50)).join(" / "));
  check("設定に誤りがある間は Moodle に問い合わせない", Object.keys(calls).filter((k) => !k.startsWith("discord")).length === 0);
}
log(fails ? `\n${fails} 件 NG` : "\nすべて OK");
process.exit(fails ? 1 : 0);
