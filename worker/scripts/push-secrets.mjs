// ../.env から MOODLE_URL と MOODLE_TOKEN(と Webhook)を読み、Cloudflare の Secrets に登録する。
// 値は画面に表示しない。
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const secrets = {
  MOODLE_URL: env.MOODLE_URL,
  MOODLE_TOKEN: env.MOODLE_TOKEN,
  DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL,
  PERSONAL_WEBHOOK_URL: env.PERSONAL_WEBHOOK_URL,
};
for (const [name, value] of Object.entries(secrets)) {
  if (!value) { console.log(`- ${name}: .env に無いのでスキップ`); continue; }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const r = spawnSync(`${npx} wrangler secret put ${name}`, {
    input: value, stdio: ["pipe", "ignore", "inherit"], shell: true,
  });
  console.log(`${r.status === 0 ? "✔" : "✖"} ${name}`);
}
console.log("\n登録しました。値は表示していません。");
