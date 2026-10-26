// 設定のコマンド(`uv run moodle config ...` から呼ばれる。worker フォルダで `npm run config -- check` でも同じ)
//
//   check            設定を検査する(書き間違い・知らない項目・値の誤り・custom/hooks.ts の有無)
//   show [授業]       授業ごとに、今どう通知されるかを日本語で表示する
//   migrate [--dry-run]  notify.toml を config/ の JSON に変換する(通知のルールが変わらないことを確かめてから入れ替える)
//
// 設定の解釈は Cloudflare 版と同じコード(worker/src/rules.ts)を使う。解釈の実装はこの1か所だけ。
// TypeScript をそのまま読むため、Node.js 22.6 以上で --experimental-strip-types を付けて動かす。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.KS_ROOT ?? join(here, "..", "..");
const { parseRules } = await import("../src/rules.ts");

const tomlParser = async (root) => existsSync(join(root, "notify.toml")) ? (await import("smol-toml")).parse : () => ({});

const DAYS_JA = ["月", "火", "水", "木", "金", "土", "日"];
const EVENTS_JA = { new: "新しく出た", scheduled: "公開予定", open: "受付開始", due_changed: "締切の変更" };

/** 設定をまとめて、ルールとして解釈する。誤りがあれば errors に入れる */
export async function loadRules(root = ROOT) {
  const res = loadConfig(root, await tomlParser(root));
  if (res.errors.length) return { ...res, rules: null };
  try { return { ...res, rules: parseRules(res.data) }; }
  catch (e) { return { ...res, errors: [`設定の値の誤り: ${e.message ?? e}`], rules: null }; }
}

/** 並び順の違いを無視して比べるための形にする */
export const canon = (v) => v instanceof Map ? [...v].map(([k, x]) => [String(k), canon(x)]).sort((a, b) => a[0].localeCompare(b[0]))
  : v instanceof Set ? [...v].map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;

/** 2つの設定が同じ通知の動きになるかを比べるための形(mute の並び順は動きに関係ないので並べ替える) */
export const rulesKey = (rules) => JSON.stringify(canon({ ...rules, mute: [...rules.mute].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }));

const remindJa = (specs) => specs.length
  ? specs.map((s) => s.startsWith("@") ? `締切日の ${s.slice(1)}` : s.replace("d", "日前").replace("h", "時間前").replace("m", "分前")).join("・")
  : "なし";

async function check(root) {
  const r = await loadRules(root);
  console.log("読んだ設定: " + (r.sources.length ? r.sources.join(", ") : "(なし。既定の設定で動きます)"));
  if (existsSync(join(root, "notify.toml")) && r.sources.some((s) => s.startsWith("config/"))) {
    console.log("注意: notify.toml と config/ の両方があります。同じ項目は config/ が勝ち、mute と events は両方の分が足されます。\n"
      + "      どちらか一方にまとめるには uv run moodle config migrate");
  }
  const errors = [...r.errors];
  const hooks = join(root, "custom", "hooks.ts");
  if (existsSync(hooks)) {
    console.log("自分用のコード: custom/hooks.ts");
    try {
      const mod = await import(pathToFileURL(hooks).href);
      if (typeof mod.beforeSend !== "function") errors.push("custom/hooks.ts: beforeSend(notices, ctx) がありません");
    } catch (e) { errors.push(`custom/hooks.ts: 読み込めません: ${e.message ?? e}`); }
  }
  if (errors.length) {
    console.log("\n誤りがあります:");
    for (const e of errors) console.log("  - " + e);
    console.log("\n直したら、もう一度 uv run moodle config check");
    return 1;
  }
  console.log("\n問題ありません。Cloudflare 版は worker フォルダで npm run deploy をすると反映されます。");
  return 0;
}

async function show(root, query) {
  const r = await loadRules(root);
  if (!r.rules) { console.error("設定に誤りがあるため表示できません。uv run moodle config check で確認してください。"); return 1; }
  const { rules, data } = r;
  const names = new Map(Object.entries(data.course ?? {}).filter(([, c]) => c.name).map(([id, c]) => [Number(id), c.name]));
  const fromFile = new Set(r.sources.filter((s) => /^config\/courses\/\d+\.json$/.test(s)).map((s) => Number(s.match(/(\d+)\.json$/)[1])));
  let ids = [...new Set([...rules.courses.keys(), ...rules.personalCourses.keys(), ...rules.personalExclude, ...rules.courseDays.keys(),
                         ...rules.mute.filter((m) => m.course !== undefined).map((m) => m.course)])].sort((a, b) => a - b);
  const q = (query ?? "").trim();
  if (q) {
    ids = ids.filter((i) => q === String(i) || (names.get(i) ?? "").includes(q));
    if (!ids.length) console.log(`「${q}」に当てはまる授業の設定はありません(書いていない授業は「その他の授業」と同じ扱いです)。`);
  }
  for (const id of ids) {
    const c = rules.courses.get(id) ?? rules.default;
    console.log(`■ ${id}  ${names.get(id) ?? "(名前なし)"}    [${fromFile.has(id) ? `config/courses/${id}.json` : "notify.toml / settings.json"}]`);
    if (c.enabled) {
      const ev = [...c.events].map((e) => EVENTS_JA[e] ?? e).join("・") || "なし";
      console.log(`  共有チャンネル: 流す(${c.kinds.join("・")}${c.match.length ? ` / 名前に ${c.match.join("・")} を含むもの` : ""})`);
      console.log(`    知らせること: ${ev} / リマインド: ${remindJa(c.remind)}${c.morning ? " / 朝の予告あり" : ""}`);
    } else console.log("  共有チャンネル: 流さない");
    if (rules.personalExclude.has(id)) console.log("  個人チャンネル: 送らない");
    else if (c.enabled && rules.personalMirror) console.log("  個人チャンネル: 共有チャンネルと同じ通知が届く(転送)");
    else console.log(`  個人チャンネル: 未提出のリマインド ${remindJa(rules.personalCourses.get(id) ?? rules.personalRemind)}`);
    const days = rules.courseDays.get(id);
    if (days) console.log(`  授業の曜日: ${[...days].sort().map((d) => DAYS_JA[d]).join("・")}`);
    for (const m of rules.mute.filter((m) => m.course === id)) {
      console.log(`  消す通知: ${Object.entries(m).filter(([k]) => k !== "course").map(([k, v]) => `${k}=${v}`).join(" / ")}`);
    }
  }
  if (!q) {
    console.log("■ その他の授業(書いていない授業)");
    console.log(`  共有チャンネル: ${rules.default.enabled ? "流す" : "流さない"} / 個人チャンネル: 未提出のリマインド ${remindJa(rules.personalRemind)}`);
    const global = rules.mute.filter((m) => m.course === undefined);
    for (const m of global) console.log(`  消す通知(全体): ${Object.entries(m).map(([k, v]) => `${k}=${v}`).join(" / ")}`);
  }
  return 0;
}

/** notify.toml の中身を { settings, courses: {授業ID: 授業ファイル}, events } に分ける */
export function migrateData(src) {
  const data = JSON.parse(JSON.stringify(src));
  const courses = {};
  const course = (id) => (courses[Number(id)] ??= { $schema: "../../schema/course.schema.json", id: Number(id) });
  for (const [id, c0] of Object.entries(data.course ?? {})) {
    const { name, days, ...c } = c0;
    const e = course(id);
    if (name !== undefined) e.name = name;
    if (days !== undefined) e.days = days;
    if (Object.keys(c).length) e.shared = c;
  }
  delete data.course;
  const personal = data.personal ?? {};
  for (const [id, pc] of Object.entries(personal.course ?? {})) {
    const e = course(id);
    if (pc.remind?.length) (e.personal ??= {}).remind = pc.remind;
    if (pc.days && e.days === undefined) e.days = pc.days;              // 授業の設定([course.ID] の days)が勝つ
  }
  delete personal.course;
  for (const id of personal.exclude ?? []) (course(id).personal ??= {}).notify = false;
  delete personal.exclude;
  if ("personal" in data && !Object.keys(personal).length) delete data.personal;
  const rest = [];
  for (const m of data.mute ?? []) {
    if (m.course !== undefined) { const { course: id, ...mm } = m; (course(id).mute ??= []).push(mm); }
    else rest.push(m);
  }
  delete data.mute;
  if (rest.length) data.mute = rest;
  const events = data.event ?? [];
  delete data.event;
  return { settings: { $schema: "../schema/settings.schema.json", ...data }, courses, events };
}

function writeConfig(dir, { settings, courses, events }) {
  mkdirSync(join(dir, "config", "courses"), { recursive: true });
  const w = (p, v) => writeFileSync(join(dir, "config", p), JSON.stringify(v, null, 2) + "\n");
  w("settings.json", settings);
  for (const [id, c] of Object.entries(courses)) w(`courses/${id}.json`, c);
  if (events.length) { mkdirSync(join(dir, "config", "events"), { recursive: true }); w("events/notify-toml.json", { $schema: "../../schema/event.schema.json", events }); }
}

async function migrate(root, dryRun) {
  const toml = join(root, "notify.toml");
  if (!existsSync(toml)) { console.log("notify.toml がありません。変換するものはありません。"); return 0; }
  if (existsSync(join(root, "config")) && loadConfig(root, () => ({})).sources.some((s) => s.startsWith("config/"))) {
    console.error("config/ にもう設定があります。上書きしないため、変換しません。"); return 1;
  }
  const { parse } = await import("smol-toml");
  const src = JSON.parse(JSON.stringify(parse(readFileSync(toml, "utf8"))));
  const out = migrateData(src);
  if (dryRun) { console.log(JSON.stringify(out, null, 2)); return 0; }
  // 一時フォルダに書いて、通知のルールがまったく同じになるかを確かめてから入れ替える
  const tmp = join(root, "state", `config-migrate-${Date.now()}`);
  writeConfig(tmp, out);
  const after = loadConfig(tmp, () => ({}));
  let same = false;
  try { same = !after.errors.length && rulesKey(parseRules(after.data)) === rulesKey(parseRules(src)); } catch { same = false; }
  if (!same) {
    console.error("変換した結果が元と同じになりませんでした。何も変えていません。");
    for (const e of after.errors) console.error("  - " + e);
    rmSync(tmp, { recursive: true, force: true });
    return 1;
  }
  cpSync(join(tmp, "config"), join(root, "config"), { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = join(root, "state", `notify.toml.migrated-${stamp}`);
  renameSync(toml, backup);
  console.log(`config/ に変換しました(授業 ${Object.keys(out.courses).length} 件)。元の notify.toml は state/${backup.split(/[\\/]/).pop()} に移しました。`);
  console.log("通知のルールは変換前とまったく同じです。Cloudflare 版は worker フォルダで npm run deploy をすると切り替わります。");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const code = cmd === "check" ? await check(ROOT)
    : cmd === "show" ? await show(ROOT, rest.find((a) => !a.startsWith("-")))
    : cmd === "migrate" ? await migrate(ROOT, rest.includes("--dry-run"))
    : (console.error("使い方: config-cli.mjs check | show [授業] | migrate [--dry-run]"), 2);
  process.exit(code);
}
