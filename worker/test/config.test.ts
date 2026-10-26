// 設定(config/ と notify.toml)のまとめ方・検査・変換のテスト
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { loadConfig, validate } from "../scripts/config-lib.mjs";
import { migrateData, rulesKey } from "../scripts/config-cli.mjs";
import { parseRules } from "../src/rules.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => { if (!ok) fails++; console.log(`${ok ? "OK " : "NG "} ${name}${extra ? "  … " + extra : ""}`); };
const tmp = () => mkdtempSync(join(tmpdir(), "ks-"));
const put = (dir: string, path: string, v: unknown) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), typeof v === "string" ? v : JSON.stringify(v));
};
const tomlOf = (dir: string) => () => parse(readFileSync(join(dir, "notify.toml"), "utf8"));
const schema = (n: string) => JSON.parse(readFileSync(join(ROOT, "schema", `${n}.schema.json`), "utf8"));

// ---- 例とテスト用の設定は、そのまま通る
{
  const r = loadConfig(join(ROOT, "examples"), () => ({}));
  check("examples/config は誤りなく読める", r.errors.length === 0 && r.sources.length >= 4, r.errors.join(" / "));
  let ok = true; try { parseRules(r.data); } catch { ok = false; }
  check("examples/config はルールとして解釈できる", ok);
  const s = loadConfig(join(ROOT, "worker/test/fixtures/standard"), () => ({}));
  check("テスト用の設定は誤りなく読める", s.errors.length === 0, s.errors.join(" / "));
  const d = tmp(); writeFileSync(join(d, "notify.toml"), readFileSync(join(ROOT, "notify.example.toml"), "utf8"));
  const t = loadConfig(d, tomlOf(d));
  let ok2 = true; try { parseRules(t.data); } catch { ok2 = false; }
  check("notify.example.toml(昔の書き方)も読める", t.errors.length === 0 && ok2);
}

// ---- 書き間違いを見つけて、直し方を言う
{
  const e = validate(schema("course"), { id: 1, shard: {}, personal: { remind: ["1x"] }, days: ["fri", "xyz"] });
  check("知らない項目には近い名前を提案する", e.some((m: string) => m.includes('"shared" のまちがい')), e.join(" / "));
  check("時間の書き方の誤りを見つける", e.some((m: string) => m.includes("personal.remind[0]")));
  check("曜日の誤りを見つける", e.some((m: string) => m.includes("days[1]") && m.includes("mon")));
  check("_ で始まる項目はメモとして無視する", validate(schema("course"), { id: 1, _メモ: "x" }).length === 0);
  check("id がない授業ファイルはエラー", validate(schema("course"), { name: "x" }).some((m: string) => m.includes('"id"')));
  check("settings.json に授業(course)を書くと、知らない項目になる", validate(schema("settings"), { course: {} }).length === 1);
  check("確認の時刻は1日12回まで", validate(schema("settings"), { watch: { schedule: Array(13).fill("10:00") } }).some((m: string) => m.includes("12 個まで")));

  const d = tmp();
  put(d, "config/courses/123.json", { id: 124 });
  put(d, "config/courses/200.json", { id: 200 });
  put(d, "config/courses/x.json", { id: 200 });
  put(d, "config/settings.json", '{ "watch": { "schedule": ["10:00"], } }');
  const r = loadConfig(d, () => ({}));
  check("ファイル名と id が違うとエラー", r.errors.some((m: string) => m.includes("123.json") && m.includes("124")));
  check("同じ授業のファイルが2つあるとエラー", r.errors.some((m: string) => m.includes("1授業1ファイル")));
  check("JSON の書き方の誤り(最後のカンマなど)を見つける", r.errors.some((m: string) => m.includes("settings.json") && m.includes("JSON")));
}

// ---- 重ね方(notify.toml → settings.json → 授業ファイル → events)
{
  const d = tmp();
  put(d, "notify.toml", `
[personal]
remind = ["1d"]
exclude = [300, 301]
[course.300]
enabled = true
events = ["new"]
remind = ["7d"]
[[mute]]
title = "古いミュート"
`);
  put(d, "config/settings.json", { personal: { remind: ["2d"] }, mute: [{ heading: "お知らせ" }] });
  put(d, "config/courses/300.json", { id: 300, shared: { remind: ["3d"] }, personal: { notify: true }, mute: [{ channel: "personal", title: "x" }] });
  put(d, "config/courses/301.json", { id: 301, personal: { notify: true, remind: ["@16:30"] }, days: ["tue"] });
  put(d, "config/events/a.json", { events: [{ title: "締切", due: "2026-11-06 10:30" }] });
  const r = loadConfig(d, tomlOf(d));
  const R = parseRules(r.data);
  check("あとの設定が勝つ(settings.json の remind)", JSON.stringify(R.personalRemind) === '["2d"]');
  check("授業ファイルは notify.toml の授業の設定に重なる(events は残り、remind は置き換わる)",
        R.courses.get(300)!.events.has("new") && JSON.stringify(R.courses.get(300)!.remind) === '["3d"]');
  check("personal.notify = true で notify.toml の exclude から外れる", !R.personalExclude.has(300) && !R.personalExclude.has(301));
  check("mute は足し合わせ、授業ファイルの mute にはその授業が付く",
        R.mute.length === 3 && R.mute.some((m) => m.course === 300 && m.title === "x"));
  check("授業の曜日・個人のリマインド", R.courseDays.get(301)?.has(1) === true && JSON.stringify(R.personalCourses.get(301)) === '["@16:30"]');
  check("events は Moodle に載る前の締切として登録される", R.manual.length === 1 && R.manual[0].title === "締切");
}

// ---- 授業の曜日だけを書いた授業は、個人のリマインドが消えない(1.0.0 の前からあった不具合)
{
  const d = tmp();
  put(d, "config/settings.json", { personal: { remind: ["1d", "3h"] } });
  put(d, "config/courses/400.json", { id: 400, days: ["thu"] });
  const R = parseRules(loadConfig(d, () => ({})).data);
  check("曜日だけ書いた授業も、個人のリマインドは既定(1日前・3時間前)のまま", !R.personalCourses.has(400) && R.courseDays.get(400)?.has(3) === true);
  const t = parseRules(parse(`[personal]\nremind = ["1d"]\n[personal.course.401]\ndays = ["mon"]\n`));
  check("notify.toml で [personal.course.ID] に曜日だけ書いた場合も同じ", !t.personalCourses.has(401));
}

// ---- notify.toml → config/ の変換で、通知のルールがまったく変わらない
{
  const src = parse(readFileSync(join(ROOT, "notify.example.toml"), "utf8")
    + `\n[course.10005]\nname = "曜日つき"\nenabled = true\ndays = ["thu"]\n[personal.course.10006]\nremind = ["@16:30"]\ndays = ["mon"]\n`
    + `[[mute]]\nchannel = "personal"\ncourse = 10006\n[[mute]]\nheading = "お知らせ"\n`);
  const data = JSON.parse(JSON.stringify(src));
  data.personal.exclude = [10007];
  const out = migrateData(data);
  const d = tmp();
  put(d, "config/settings.json", out.settings);
  for (const [id, c] of Object.entries(out.courses)) put(d, `config/courses/${id}.json`, c);
  if (out.events.length) put(d, "config/events/e.json", { events: out.events });
  const r = loadConfig(d, () => ({}));
  check("変換した config/ は誤りなく読める", r.errors.length === 0, r.errors.join(" / "));
  check("変換の前後で通知のルールがまったく同じ", rulesKey(parseRules(r.data)) === rulesKey(parseRules(data)));
}

// ---- コマンド(check / show / migrate)を、本物と同じように動かす
{
  const d = tmp();
  writeFileSync(join(d, "notify.toml"), readFileSync(join(ROOT, "notify.example.toml"), "utf8"));
  mkdirSync(join(d, "state"));
  const run = (...a: string[]) => {
    try { return { code: 0, out: execFileSync(process.execPath, [...process.execArgv, join(ROOT, "worker/scripts/config-cli.mjs"), ...a], { env: { ...process.env, KS_ROOT: d }, encoding: "utf8" }) }; }
    catch (e: any) { return { code: e.status as number, out: String(e.stdout) + String(e.stderr) }; }
  };
  const c1 = run("check");
  check("config check:正しい設定は 0 で終わる", c1.code === 0 && c1.out.includes("問題ありません"), c1.out.slice(0, 200));
  const s1 = run("show", "10001");
  check("config show:授業ごとの通知を日本語で表示する", s1.code === 0 && s1.out.includes("共有チャンネル: 流す") && s1.out.includes("〇〇概論"), s1.out.slice(0, 200));
  const m1 = run("migrate");
  check("config migrate:config/ に変換し、notify.toml を state/ に移す",
        m1.code === 0 && !existsSync(join(d, "notify.toml")) && readdirSync(join(d, "state")).some((f) => f.startsWith("notify.toml.migrated")), m1.out.slice(0, 200));
  check("config migrate:作業用の一時フォルダを残さない", !readdirSync(join(d, "state")).some((f) => f.startsWith("config-migrate")));
  const m2 = run("migrate");
  check("config migrate:2回目は何もしない", m2.code === 0);
  const c2 = run("check");
  check("変換後も config check が通る", c2.code === 0, c2.out.slice(0, 200));
  writeFileSync(join(d, "config/courses/10001.json"), JSON.stringify({ id: 10001, shard: {} }));
  const c3 = run("check");
  check("config check:誤りがあれば 1 で終わり、場所と直し方を言う", c3.code === 1 && c3.out.includes("10001.json") && c3.out.includes("shared"), c3.out.slice(0, 300));
}

// ---- バージョンの書き忘れを防ぐ(pyproject.toml・package.json・CHANGELOG.md の先頭をそろえる)
{
  const py = (parse(readFileSync(join(ROOT, "pyproject.toml"), "utf8")) as any).project.version;
  const pkg = JSON.parse(readFileSync(join(ROOT, "worker/package.json"), "utf8")).version;
  const top = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").match(/^## (\d+\.\d+\.\d+)/m)?.[1];
  check("バージョンが3か所でそろっている", py === pkg && pkg === top, `pyproject ${py} / package.json ${pkg} / CHANGELOG ${top}`);
}

console.log(fails ? `\n${fails} 件 NG` : "\nすべて OK");
process.exit(fails ? 1 : 0);
