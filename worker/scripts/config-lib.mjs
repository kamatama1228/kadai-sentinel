// 設定の読み込み。デプロイ(build-config.mjs)・設定のコマンド(config-cli.mjs)・テストが、このファイルだけを使う。
//
//   1. notify.toml(あれば。昔からの書き方)
//   2. config/settings.json(全体の設定)
//   3. config/courses/*.json(授業ごとの設定。1授業1ファイル)
//   4. config/events/*.json(Moodle に載る前の締切)
// の順に重ねる。あとのものが勝つ。オブジェクトは中身ごとに重ね、配列や値はまるごと置き換える。
// mute と events は足し合わせる。キーが "_" で始まるものはメモとして無視する。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA_DIR = new URL("../../schema/", import.meta.url);
const schema = (name) => JSON.parse(readFileSync(new URL(`${name}.schema.json`, SCHEMA_DIR), "utf8"));

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const typeOf = (v) => Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v;
const TYPE_JA = { object: "{ }", array: "[ ]", string: "文字列", integer: "整数", number: "数", boolean: "true / false" };

/** JSON Schema の一部(type / enum / pattern / properties / additionalProperties / required / items / maxItems)で検査する */
export function validate(s, v, where = "") {
  const errs = [];
  const t = typeOf(v);
  if (s.type && !(t === s.type || (s.type === "number" && t === "integer"))) {
    return [`${where || "(ファイル全体)"}: ${TYPE_JA[s.type] ?? s.type} で書いてください(今は ${JSON.stringify(v)})`];
  }
  if (s.enum && !s.enum.includes(v)) errs.push(`${where}: ${JSON.stringify(v)} は使えません。使えるのは ${s.enum.join(" / ")}`);
  if (s.pattern && typeof v === "string" && !new RegExp(s.pattern).test(v)) errs.push(`${where}: ${JSON.stringify(v)} の書き方が違います${s.description ? `(${s.description})` : ""}`);
  if (t === "array") {
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${where}: ${s.maxItems} 個までにしてください`);
    if (s.items) v.forEach((x, i) => errs.push(...validate(s.items, x, `${where}[${i}]`)));
  }
  if (t === "object") {
    for (const r of s.required ?? []) if (!(r in v)) errs.push(`${where || "(ファイル全体)"}: "${r}" が必要です`);
    const props = s.properties ?? {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith("_")) continue;
      const path = where ? `${where}.${k}` : k;
      if (props[k]) errs.push(...validate(props[k], x, path));
      else if (s.additionalProperties === false) {
        const near = Object.keys(props).filter((p) => !p.startsWith("$")).sort((a, b) => distance(k, a) - distance(k, b))[0];
        errs.push(`${path}: 知らない項目です${near && distance(k, near) <= 3 ? `。"${near}" のまちがいではありませんか` : ""}`);
      }
    }
  }
  return errs;
}

const strip = (v) => Array.isArray(v) ? v.map(strip)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("_") && !k.startsWith("$")).map(([k, x]) => [k, strip(x)]))
  : v;

export function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
      ? deepMerge(out[k], v) : v;
  }
  return out;
}

const jsonFiles = (dir) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f)) : [];

/** 授業ファイル1つを、notify.toml と同じ形に直して重ねる */
export function applyCourse(data, c) {
  const id = String(c.id);
  if (c.name !== undefined || c.shared) {
    data.course ??= {};
    data.course[id] = deepMerge(data.course[id] ?? {}, { ...(c.name !== undefined ? { name: c.name } : {}), ...(c.shared ?? {}) });
  }
  if (c.personal?.remind || c.days) {
    data.personal ??= {}; data.personal.course ??= {};
    data.personal.course[id] = { ...(data.personal.course[id] ?? {}), ...(c.personal?.remind ? { remind: c.personal.remind } : {}),
                                 ...(c.days ? { days: c.days } : {}) };
  }
  if (c.personal?.notify !== undefined) {
    data.personal ??= {};
    const ex = new Set((data.personal.exclude ?? []).map(Number));
    if (c.personal.notify === false) ex.add(c.id); else ex.delete(c.id);
    data.personal.exclude = [...ex];
  }
  for (const m of c.mute ?? []) (data.mute ??= []).push({ ...m, course: c.id });
  return data;
}

/**
 * root(リポジトリのフォルダ)の設定をまとめる。
 * 返り値 { data, errors, sources }。errors があるときは data を使わない
 */
export function loadConfig(root, parseToml) {
  const errors = [], sources = [];
  let data = {};
  const toml = join(root, "notify.toml");
  if (existsSync(toml)) {
    try { data = JSON.parse(JSON.stringify(parseToml(readFileSync(toml, "utf8")))); sources.push("notify.toml"); }
    catch (e) { errors.push(`notify.toml: 書き方の誤り: ${e.message ?? e}`); }
  }
  const read = (path, kind) => {
    const rel = path.slice(root.length + 1).replaceAll("\\", "/");
    let v;
    try { v = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")); }
    catch (e) { errors.push(`${rel}: JSON の書き方の誤り: ${e.message}`); return null; }
    const errs = validate(schema(kind), v).map((m) => `${rel}: ${m}`);
    errors.push(...errs);
    if (errs.length) return null;
    sources.push(rel);
    return strip(v);
  };
  const cfg = join(root, "config");
  const settings = join(cfg, "settings.json");
  if (existsSync(settings)) {
    const s = read(settings, "settings");
    if (s) {
      const { mute, ...rest } = s;
      data = deepMerge(data, rest);
      if (mute) data.mute = [...(data.mute ?? []), ...mute];
    }
  }
  const seen = new Map();
  for (const f of jsonFiles(join(cfg, "courses"))) {
    const c = read(f, "course");
    if (!c) continue;
    const name = f.split(/[\\/]/).pop();
    if (/^\d+\.json$/.test(name) && Number(name.slice(0, -5)) !== c.id) {
      errors.push(`config/courses/${name}: ファイル名(${name.slice(0, -5)})と id(${c.id})が違います`); continue;
    }
    if (seen.has(c.id)) { errors.push(`config/courses/${name}: 授業 ${c.id} は ${seen.get(c.id)} にもあります(1授業1ファイル)`); continue; }
    seen.set(c.id, name);
    applyCourse(data, c);
  }
  for (const f of jsonFiles(join(cfg, "events"))) {
    const e = read(f, "event");
    if (e) data.event = [...(data.event ?? []), ...e.events];
  }
  return { data, errors, sources };
}
