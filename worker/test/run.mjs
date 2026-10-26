// テストをまとめて動かす(`npm test`)。テストは1つずつ別のプロセスで動かす(設定が違うため)
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`テストには Node.js 22.6 以上が必要です(今は ${process.versions.node})`);
  process.exit(1);
}
const flags = [...(major > 23 || (major === 23 && minor >= 6) ? [] : ["--experimental-strip-types"]), "--no-warnings",
               "--import", join(here, "register.mjs")];

/** 標準のテスト用設定をコピーして、一部だけ変えたフォルダを作る */
function fixture(name, change) {
  const d = mkdtempSync(join(tmpdir(), `ks-${name}-`));
  cpSync(join(here, "fixtures", "standard"), d, { recursive: true });
  change?.(d);
  return d;
}
const std = join(here, "fixtures", "standard");
const suites = [
  ["設定のまとめ方・検査・変換", "config.test.ts", {}],
  ["届け方の信頼性", "delivery.test.ts", { TEST_CONFIG_DIR: std }],
  ["オンライン授業・お知らせ・締切変更", "features.test.ts", { TEST_CONFIG_DIR: std, MODE: "main" }],
  ["通知を消す(mute)", "features.test.ts", { MODE: "mute", TEST_CONFIG_DIR: fixture("mute", (d) => {
    writeFileSync(join(d, "config/courses/10003.json"), JSON.stringify({ id: 10003, mute: [{ channel: "personal" }] }));
  }) }],
  ["設定の誤り(デプロイ後に見つかった場合)", "features.test.ts", { MODE: "badconfig", TEST_CONFIG_DIR: fixture("bad", (d) => {
    writeFileSync(join(d, "config/settings.json"), JSON.stringify({ mute: [{ channel: "personal" }] }));   // 条件のない mute(全部消える)は誤り
  }) }],
  ["自分用のコード(例)", "hooks.test.ts", { TEST_CONFIG_DIR: std, TEST_HOOKS: join(root, "examples", "custom", "hooks.ts") }],
  ["自分用のコードが失敗したとき", "hooks-broken.test.ts", { TEST_CONFIG_DIR: std, TEST_HOOKS: join(here, "fixtures", "broken-hooks.ts") }],
  ["自分用のコードが誤った形を返したとき", "hooks-broken.test.ts", { TEST_CONFIG_DIR: std, TEST_HOOKS: join(here, "fixtures", "wrong-hooks.ts") }],
];

const only = process.argv[2];
let failed = 0;
for (const [title, file, env] of suites) {
  if (only && !file.includes(only)) continue;
  console.log(`\n=== ${title}(${file})`);
  const r = spawnSync(process.execPath, [...flags, join(here, file)], { stdio: "inherit", env: { ...process.env, ...env }, timeout: 180_000 });
  if (r.status !== 0) { failed++; console.log(`→ 失敗(終了コード ${r.status ?? r.signal})`); }
}
console.log(failed ? `\n${failed} 個のテストが失敗しました` : "\nすべてのテストが通りました");
process.exit(failed ? 1 : 0);
